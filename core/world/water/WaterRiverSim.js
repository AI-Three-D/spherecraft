// core/world/water/WaterRiverSim.js
//
// Near-field water simulation along a river (IMPLEMENTATION_PLAN_WATER.md
// W2), replacing the camera-centred square (WaterSimSite, which flooded the
// land inside it and restarted every 64 m of camera travel). Like
// Whitewater, which only simulates its river (a window of rows around the
// boat), the grid follows the river:
// - columns across the river (channel and banks), rows downstream: row j
//   sits at arc length s_j on the river, cell (i, j) at its centre moved
//   across by (i + 0.5 - W / 2) dx (riverStrip.js); the solver runs on the
//   straightened strip (ShallowWaterSim, no curvature terms);
// - the bed is the terrain height function with the river carved
//   (HydrologyGrid sampleDirsCarved), the same the terrain tiles show;
// - banks are closed edges; upstream rows are relaxed toward the river's
//   level and flow (inflow), the downstream end is open with a gentle pull
//   toward the river's level;
// - the window scrolls with the camera along the river in steps of shiftM:
//   rows form a ring (ShallowWaterSim rowBase); only rows entering the
//   window are sampled and set to the river's steady flow, so the water
//   keeps running (no restart, no warm-up);
// - coverage tells the terrain shading (waterWgsl.js) which river stretch
//   the simulated surface draws, so its static water fades out there.

import { ShallowWaterSim } from './ShallowWaterSim.js';
import { SWE_OPEN_BOTTOM, SWE_OPEN_TOP } from './shallowWaterSim.wgsl.js';
import { createRiverStrip } from './riverStrip.js';

export const WATER_RIVER_SIM_DEFAULTS = Object.freeze({
    dx: 1.0,               // cell size (m); larger for rivers wider than maxCols
    lengthM: 768,          // window along the river
    marginM: 10,           // strip reaches this far beyond the channel's edge (banks)
    maxCols: 128,
    shiftM: 64,            // the window moves along the river in steps of this
    substepsPerFrame: 2,   // of SWE dt (1/120 s): real time at 60 fps
    inflowRows: 16, inflowRate: 6,     // 1/s at the upstream end
    outflowRows: 16, outflowRate: 1,   // 1/s at the downstream end (level only pulls gently)
    fadeSeconds: 0.6,
    endFadeM: 48,          // the simulated surface fades into the static water at the window's ends
    sideFadeM: 4,
    sim: {},               // SWE_DEFAULTS overrides (ShallowWaterSim.js)
});

// Per physical row: centre (xyz) + level, left normal (xyz) + speed,
// half-width, thalweg, arc length, unused. 3 x vec4.
const ROW_FLOATS = 12;

const INIT_WGSL = /* wgsl */`
struct StripInit {
  W: u32, L: u32, rowBase: u32, jFrom: u32,
  jCount: u32, inflowRows: u32, outflowRows: u32, _p0: u32,
  inflowRate: f32, outflowRate: f32, _p1: f32, _p2: f32,
};
struct RowInfo { c: vec4f, left: vec4f, extra: vec4f };
@group(0) @binding(0) var<uniform> U: StripInit;
@group(0) @binding(1) var<storage, read> ROWS: array<RowInfo>;
@group(0) @binding(2) var<storage, read> BED: array<f32>;
@group(0) @binding(3) var<storage, read_write> STATE: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> KT: array<f32>;
@group(0) @binding(5) var<storage, read_write> RELAX: array<vec4f>;

fn phys(j: u32) -> u32 { let r = j + U.rowBase; return select(r, r - U.L, r >= U.L); }

// The river's steady flow at a cell: its level, flowing downstream (+v)
// faster where deeper (Whitewater's inflow: velocity ~ h^(2/3)).
fn steady(i: u32, j: u32) -> vec4f {
  let pr = phys(j);
  let row = ROWS[pr];
  let b = BED[pr * U.W + i];
  let eta = row.c.w;
  let h = max(0.0, eta - b);
  let hMean = max(0.6 * (eta - row.extra.y), 0.05);
  let v = row.left.w * clamp(pow(h / hMean, 0.6667), 0.0, 1.3);
  return vec4f(h, 0.0, v, 0.0);
}

@compute @workgroup_size(8, 8)
fn initMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; let j = U.jFrom + gid.y;
  if (i >= U.W || gid.y >= U.jCount) { return; }
  let id = phys(j) * U.W + i;
  STATE[id] = steady(i, j);
  KT[id] = 0.0;
}

@compute @workgroup_size(8, 8)
fn relaxMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; let j = gid.y;
  if (i >= U.W || j >= U.L) { return; }
  var rate = 0.0;
  if (j < U.inflowRows) {
    let w = 1.0 - f32(j) / f32(U.inflowRows);
    rate = U.inflowRate * w * w;
  } else if (j + U.outflowRows >= U.L) {
    let w = 1.0 - f32(U.L - 1u - j) / f32(U.outflowRows);
    rate = U.outflowRate * w * w;
  }
  let pr = phys(j);
  let st = steady(i, j);
  RELAX[pr * U.W + i] = vec4f(ROWS[pr].c.w, 0.0, st.z, rate);
}
`;

export class WaterRiverSim {
    /**
     * @param {object} p
     * @param {GPUDevice} p.device
     * @param {object} p.sampler   createHydrologySampler() result (sampleDirsCarved)
     * @param {number} p.radius    planet radius (m)
     * @param {object} [p.config]  WATER_RIVER_SIM_DEFAULTS overrides
     */
    constructor({ device, sampler, radius, config = {} }) {
        this.device = device;
        this.sampler = sampler;
        this.R = radius;
        this.config = { ...WATER_RIVER_SIM_DEFAULTS, ...config };
        this.state = 'idle';     // idle | placing | running
        this.sim = null;
        this.riverId = -1;
        this.strip = null;
        this.jStart = 0;         // world row index (arc length / dx) of logical row 0
        this.fade = 0;
        this._fadeTarget = 0;
        this._lastNow = null;
        this._pending = null;    // shift in progress
        this._sHint = null;
        this._generation = 0;
        const module = device.createShaderModule({ label: 'WaterRiverSim-init', code: INIT_WGSL });
        const C = GPUShaderStage.COMPUTE;
        this._initLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: C, buffer: { type: 'uniform' } },
            { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: C, buffer: { type: 'storage' } },
            { binding: 4, visibility: C, buffer: { type: 'storage' } },
            { binding: 5, visibility: C, buffer: { type: 'storage' } },
        ] });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this._initLayout] });
        this._initPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'initMain' } });
        this._relaxPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'relaxMain' } });
        this._initUniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._relaxUniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }

    get W() { return this.sim?.W ?? 0; }
    get L() { return this.sim?.L ?? 0; }
    get dx() { return this.sim?.params.dx ?? this.config.dx; }

    /** Arc length (m) of the window's start and end, and its centre. */
    get s0() { return this.jStart * this.dx; }
    get s1() { return (this.jStart + this.L) * this.dx; }

    _ensureSim(W, L, dx) {
        if (this.sim && this.sim.W === W && this.sim.L === L && this.sim.params.dx === dx) return;
        this.sim?.destroy();
        this.rowsBuffer?.destroy();
        this.sim = new ShallowWaterSim(this.device, {
            W, L, dx, openMask: SWE_OPEN_BOTTOM | SWE_OPEN_TOP, ...this.config.sim,
        });
        this.rowsBuffer = this.device.createBuffer({ label: 'WaterRiverSim-rows', size: L * ROW_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const bg = (pipeline, uniform) => this.device.createBindGroup({ layout: this._initLayout, entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: this.rowsBuffer } },
            { binding: 2, resource: { buffer: this.sim.bedBuffer } },
            { binding: 3, resource: { buffer: this.sim.stateBuffers[0] } },
            { binding: 4, resource: { buffer: this.sim.kBuffers[0] } },
            { binding: 5, resource: { buffer: this.sim.relaxBuffer } },
        ] });
        this._initGroup = bg(this._initPipeline, this._initUniform);
        this._relaxGroup = bg(this._relaxPipeline, this._relaxUniform);
    }

    /** Rows [jFrom, jFrom + count) (world row indices): frames and cell directions. */
    _buildRows(jFrom, count) {
        const { W } = this, dx = this.dx, R = this.R;
        const rows = new Float32Array(count * ROW_FLOATS), dirs = new Float32Array(count * W * 4);
        for (let r = 0; r < count; r++) {
            const s = (jFrom + r + 0.5) * dx;
            const f = this.strip.at(s);
            rows.set([f.c[0], f.c[1], f.c[2], f.eta, f.left[0], f.left[1], f.left[2], f.speed, f.hw, f.bed, s, 1], r * ROW_FLOATS);
            for (let i = 0; i < W; i++) {
                const n = (i + 0.5 - W / 2) * dx / R;
                const x = f.c[0] + f.left[0] * n, y = f.c[1] + f.left[1] * n, z = f.c[2] + f.left[2] * n, l = Math.hypot(x, y, z);
                dirs.set([x / l, y / l, z / l, 0], (r * W + i) * 4);
            }
        }
        return { rows, dirs };
    }

    /** Writes rows' data into physical rows starting at pFrom (wrapping). */
    _writeRows(pFrom, count, rows, bed) {
        const { W, L } = this;
        const first = Math.min(count, L - pFrom);
        const q = this.device.queue;
        q.writeBuffer(this.rowsBuffer, pFrom * ROW_FLOATS * 4, rows, 0, first * ROW_FLOATS);
        q.writeBuffer(this.sim.bedBuffer, pFrom * W * 4, bed, 0, first * W);
        if (first < count) {
            q.writeBuffer(this.rowsBuffer, 0, rows, first * ROW_FLOATS, (count - first) * ROW_FLOATS);
            q.writeBuffer(this.sim.bedBuffer, 0, bed, first * W, (count - first) * W);
        }
    }

    _dispatchInit(jFrom, count) {
        const c = this.config, u = new ArrayBuffer(48), u32 = new Uint32Array(u), f32 = new Float32Array(u);
        const fill = (logicalFrom, rows) => {
            u32.set([this.W, this.L, this.sim.rowBase, logicalFrom, rows, c.inflowRows, c.outflowRows, 0]);
            f32.set([c.inflowRate, c.outflowRate, 0, 0], 8);
        };
        fill(jFrom, count);
        this.device.queue.writeBuffer(this._initUniform, 0, u);
        fill(0, this.L);
        this.device.queue.writeBuffer(this._relaxUniform, 0, u);
        const enc = this.device.createCommandEncoder({ label: 'WaterRiverSim-init' });
        const pass = enc.beginComputePass();
        if (count > 0) {
            pass.setPipeline(this._initPipeline);
            pass.setBindGroup(0, this._initGroup);
            pass.dispatchWorkgroups(Math.ceil(this.W / 8), Math.ceil(count / 8));
        }
        // The inflow and outflow bands follow the window's ends.
        pass.setPipeline(this._relaxPipeline);
        pass.setBindGroup(0, this._relaxGroup);
        pass.dispatchWorkgroups(Math.ceil(this.W / 8), Math.ceil(this.L / 8));
        pass.end();
        this.device.queue.submit([enc.finish()]);
    }

    /**
     * Places the window on river riverId (traced record rec) centred on arc
     * length sCenter (m). Async: samples the bed.
     */
    async place(riverId, rec, sCenter) {
        const gen = ++this._generation;
        this.state = 'placing';
        this._pending = null;
        this.fade = 0;
        const c = this.config;
        const strip = createRiverStrip(rec, this.R);
        const halfM = strip.maxHalfWidth() + c.marginM;
        let dx = c.dx, W = Math.ceil((2 * halfM / dx) / 8) * 8;
        if (W > c.maxCols) { W = c.maxCols; dx = 2 * halfM / W; }
        const L = Math.max(64, Math.round(c.lengthM / dx / 8) * 8);
        this._ensureSim(W, L, dx);
        this.strip = strip;
        this.riverId = riverId;
        this.rec = rec;
        this.halfM = 0.5 * W * dx;
        const jStart = Math.round(sCenter / dx - L / 2);
        const { rows, dirs } = this._buildRows(jStart, L);
        const bed = await this.sampler.sampleDirsCarved(dirs);
        if (gen !== this._generation) return;            // replaced meanwhile
        if (!bed) { this.state = 'idle'; return; }
        this.jStart = jStart;
        this.sim.setRowRing(0, jStart);
        this._writeRows(0, L, rows, bed);
        this.sim.setTurbulence(new Float32Array(W * L));
        this._dispatchInit(0, L);
        this.sim.time = 0;
        this._sHint = sCenter;
        this.state = 'running';
        this._fadeTarget = 1;
    }

    /**
     * Keeps the window centred on the camera's place along the river:
     * shifts by shiftM once the camera is that far from the centre (the new
     * rows are sampled first, the window moves when they are ready).
     * @param {number[]} camDir  unit direction of the camera
     * @returns {number} distance (m) from the camera's nadir to the river
     */
    follow(camDir) {
        if (this.state !== 'running') return Infinity;
        const near = this.strip.nearest(camDir, this._sHint);
        this._sHint = near.s;
        if (this._pending) return near.dist;
        const dx = this.dx, centre = (this.jStart + this.L / 2) * dx, shift = Math.round(this.config.shiftM / dx);
        if (near.s - centre > this.config.shiftM) this._shift(shift);
        else if (centre - near.s > this.config.shiftM) this._shift(-shift);
        return near.dist;
    }

    async _shift(k) {
        const gen = this._generation;
        const { L } = this;
        const n = Math.abs(k);
        const jFrom = k > 0 ? this.jStart + L : this.jStart - n;
        const pending = this._pending = { k };
        const { rows, dirs } = this._buildRows(jFrom, n);
        const bed = await this.sampler.sampleDirsCarved(dirs);
        if (gen !== this._generation || this._pending !== pending || this.state !== 'running') return;
        this._pending = null;
        if (!bed) return;
        const sim = this.sim;
        if (k > 0) {
            // The upstream rows leave; their physical rows take the new downstream ones.
            this._writeRows(sim.rowBase, n, rows, bed);
            this.jStart += n;
            sim.setRowRing(sim.rowBase + n, this.jStart);
            this._dispatchInit(L - n, n);
        } else {
            const p = ((sim.rowBase - n) % L + L) % L;
            this._writeRows(p, n, rows, bed);
            this.jStart -= n;
            sim.setRowRing(p, this.jStart);
            this._dispatchInit(0, n);
        }
    }

    /** Encodes this frame's substeps; nowS (s) drives the fade. */
    encode(encoder, nowS) {
        const dt = this._lastNow === null ? 0 : Math.max(0, Math.min(0.25, nowS - this._lastNow));
        this._lastNow = nowS;
        const rate = 1 / Math.max(1e-3, this.config.fadeSeconds);
        this.fade = Math.max(0, Math.min(1, this.fade + Math.sign(this._fadeTarget - this.fade) * rate * dt));
        if (this.state !== 'running') return;
        if (this._fadeTarget === 0 && this.fade <= 0) { this.stop(); return; }
        this.sim.encode(encoder, this.config.substepsPerFrame);
    }

    /** Fades out, then stops (the static water shows again); keep encoding meanwhile. */
    deactivate() { this._fadeTarget = 0; }

    /** Stops at once. */
    stop() {
        this.state = 'idle';
        this.fade = 0;
        this._fadeTarget = 0;
        this._generation++;
        this._pending = null;
    }

    /** True while active or fading out. */
    get active() { return this.state === 'running' || this.state === 'placing'; }

    /** For WaterGpuData.site: the river stretch the simulated surface draws. */
    get coverage() {
        if (this.state !== 'running' || this.fade <= 0) return null;
        const c = this.config;
        return { river: this.riverId, s0: this.s0, s1: this.s1, halfM: this.halfM, endFadeM: c.endFadeM, sideFadeM: c.sideFadeM, fade: this.fade };
    }

    destroy() {
        this.sim?.destroy();
        this.rowsBuffer?.destroy();
        this._initUniform.destroy();
        this._relaxUniform.destroy();
        this.state = 'idle';
    }
}
