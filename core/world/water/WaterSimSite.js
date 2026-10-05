// core/world/water/WaterSimSite.js
//
// Near-field water simulation (IMPLEMENTATION_PLAN 8.2-8.4): one square
// ShallowWaterSim around a point near the camera, the way Whitewater only
// simulates a window around the boat (its rows from 60 m behind to 220 m
// ahead; beyond, a static profile). Here the static water is the lakes and
// rivers already drawn by the terrain shader.
// - Frame: gnomonic tangent plane at the centre (lakeRefine.js frames);
//   cell (i, j) centre at x = (i + 0.5 - n/2) dx, y = (j + 0.5 - n/2) dx.
// - Bed: the terrain height function at the cell centres, with the river
//   channels carved (HydrologyGrid samplePatch carved; no per-tile micro
//   detail: H_simBed of the plan).
// - Start: the static water at every cell, from the same lookup the terrain
//   shader uses (waterWgsl.js): lake level, or river level and flow.
// - Boundaries: open edges, and a border band relaxed toward the static
//   water, so rivers flow in and out at their static level and speed and
//   lakes keep their level.
// - Warm-up: extra substeps over the first frames, then the site fades in
//   (the terrain shader fades its static water out under it).

import { ShallowWaterSim } from './ShallowWaterSim.js';
import { SWE_OPEN_BOTTOM, SWE_OPEN_LEFT, SWE_OPEN_RIGHT, SWE_OPEN_TOP } from './shallowWaterSim.wgsl.js';
import { createWaterWgsl } from './waterWgsl.js';
import { tangentBasis } from '../hydrology/lakeRefine.js';

export const WATER_SIM_SITE_DEFAULTS = Object.freeze({
    cells: 256,            // per side
    dx: 1.0,               // m
    substepsPerFrame: 2,   // of SWE dt (1/120 s): real time at 60 fps
    borderCells: 12,       // relaxation band width
    borderRate: 6,         // 1/s at the outer edge
    warmupSubsteps: 360,   // 3 s of simulated time before showing
    warmupPerFrame: 12,    // ~2.4 ms GPU per frame at 256^2: no hitch when a site is placed
    fadeSeconds: 1.0,
    sim: {},               // SWE_DEFAULTS overrides (ShallowWaterSim.js)
});

const INIT_WGSL = (water) => water + /* wgsl */`
@group(0) @binding(8) var linearSampler: sampler;
struct SiteInit {
    c: vec3<f32>, dx: f32,
    e1: vec3<f32>, border: f32,
    e2: vec3<f32>, rate: f32,
    n: u32, _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> site: SiteInit;
@group(0) @binding(1) var<storage, read> siteBed: array<f32>;
@group(0) @binding(2) var<storage, read_write> siteState: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> siteRelax: array<vec4<f32>>;

@compute @workgroup_size(8, 8)
fn initMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = site.n;
    if (gid.x >= n || gid.y >= n) { return; }
    let k = gid.y * n + gid.x;
    let x = (f32(gid.x) + 0.5 - 0.5 * f32(n)) * site.dx;
    let y = (f32(gid.y) + 0.5 - 0.5 * f32(n)) * site.dx;
    let dir = normalize(site.c + (x * site.e1 + y * site.e2) / waterParams.planetRadius);
    let b = siteBed[k];
    var eta = b;
    var u = 0.0;
    var v = 0.0;
    let lvl = waterLakeLevelAt(dir, b, linearSampler);
    if (lvl > WATER_NO_LAKE) {
        eta = lvl;
    } else {
        let r = waterRiverAt(dir, b);
        if (r.found) {
            eta = b + r.depthM;
            u = dot(r.flow, site.e1) * r.speed;
            v = dot(r.flow, site.e2) * r.speed;
        }
    }
    siteState[k] = vec4<f32>(max(0.0, eta - b), u, v, 0.0);
    let d = f32(min(min(gid.x, n - 1u - gid.x), min(gid.y, n - 1u - gid.y)));
    let w = clamp(1.0 - d / site.border, 0.0, 1.0);
    siteRelax[k] = vec4<f32>(eta, u, v, site.rate * w * w);
}
`;

export class WaterSimSite {
    /**
     * @param {object} p
     * @param {GPUDevice} p.device
     * @param {object} p.sampler      createHydrologySampler() result (bed sampling)
     * @param {object} p.waterGpu     WaterGpuData (static lakes and rivers)
     * @param {number} p.radius       planet radius (m)
     * @param {object} [p.config]     WATER_SIM_SITE_DEFAULTS overrides
     */
    constructor({ device, sampler, waterGpu, radius, config = {} }) {
        this.device = device;
        this.sampler = sampler;
        this.waterGpu = waterGpu;
        this.R = radius;
        this.config = { ...WATER_SIM_SITE_DEFAULTS, ...config };
        const n = this.config.cells;
        this.n = n;
        this.sim = new ShallowWaterSim(device, {
            W: n, L: n, dx: this.config.dx,
            openMask: SWE_OPEN_LEFT | SWE_OPEN_RIGHT | SWE_OPEN_BOTTOM | SWE_OPEN_TOP,
            ...this.config.sim,
        });
        this.state = 'idle';      // idle | placing | warming | running
        this.frame = null;        // { c, e1, e2, x0, y0, spacing, nx, ny }
        this.fade = 0;
        this._warmupLeft = 0;
        this._runSince = 0;

        const module = device.createShaderModule({ label: 'WaterSimSite-init', code: INIT_WGSL(createWaterWgsl({ group: 0 })) });
        this._initPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'initMain' } });
        this._initUniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    }

    get halfM() { return 0.5 * this.n * this.config.dx; }

    /** Plane coordinates (m) of a unit direction in the site frame. */
    toPlane(d) {
        const f = this.frame;
        const k = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
        return [(d[0] * f.e1[0] + d[1] * f.e1[1] + d[2] * f.e1[2]) / k * this.R, (d[0] * f.e2[0] + d[1] * f.e2[1] + d[2] * f.e2[2]) / k * this.R];
    }

    /** Places the site centred on unit direction c (async: samples the bed). */
    async place(c) {
        this.state = 'placing';
        this.fade = 0;
        const { cells: n, dx } = this.config;
        const { e1, e2 } = tangentBasis(c);
        const half = 0.5 * n * dx;
        const frame = { c, e1, e2, x0: -half, y0: -half, spacing: dx, nx: n, ny: n };
        const bed = await this.sampler.samplePatch(frame, this.R, { carved: true });
        this.frame = frame;
        this.bed = bed;
        this.sim.setBed(bed);
        this.sim.setTurbulence(new Float32Array(n * n));

        const u = new ArrayBuffer(64), f = new Float32Array(u), i32 = new Uint32Array(u);
        f.set([c[0], c[1], c[2], dx, e1[0], e1[1], e1[2], this.config.borderCells, e2[0], e2[1], e2[2], this.config.borderRate], 0);
        i32[12] = n;
        this.device.queue.writeBuffer(this._initUniform, 0, u);
        const res = this.waterGpu.resources;
        const bg = this.device.createBindGroup({ layout: this._initPipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this._initUniform } },
            { binding: 1, resource: { buffer: this.sim.bedBuffer } },
            { binding: 2, resource: { buffer: this.sim.stateBuffers[0] } },
            { binding: 3, resource: { buffer: this.sim.relaxBuffer } },
            { binding: 8, resource: this._linearSampler },
            { binding: 12, resource: { buffer: res.index } },
            { binding: 13, resource: { buffer: res.lakes } },
            { binding: 14, resource: res.masks },
            { binding: 15, resource: { buffer: res.params } },
            { binding: 16, resource: { buffer: res.rivers } },
        ] });
        const enc = this.device.createCommandEncoder({ label: 'WaterSimSite-init' });
        const pass = enc.beginComputePass();
        pass.setPipeline(this._initPipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8));
        pass.end();
        this.device.queue.submit([enc.finish()]);
        this.sim.time = 0;
        this._warmupLeft = this.config.warmupSubsteps;
        this.state = 'warming';
    }

    /**
     * Encodes this frame's substeps (warm-up first). nowS: real time (s),
     * drives the fade-in once warm.
     */
    encode(encoder, nowS) {
        if (this.state !== 'warming' && this.state !== 'running') return;
        if (this.state === 'warming') {
            const k = Math.min(this._warmupLeft, this.config.warmupPerFrame);
            this.sim.encode(encoder, k);
            this._warmupLeft -= k;
            if (this._warmupLeft <= 0) { this.state = 'running'; this._runSince = nowS; }
            return;
        }
        this.sim.encode(encoder, this.config.substepsPerFrame);
        this.fade = Math.min(1, (nowS - this._runSince) / Math.max(1e-3, this.config.fadeSeconds));
    }

    /** Stops simulating and drawing (the static water shows again). */
    deactivate() {
        if (this.state !== 'placing') this.state = 'idle';
        this.fade = 0;
    }

    /** Distance (m) in the site plane from the site centre to unit direction d. */
    distanceTo(d) {
        if (!this.frame) return Infinity;
        const [x, y] = this.toPlane(d);
        return Math.max(Math.abs(x), Math.abs(y));
    }

    /** For WaterGpuData.site (terrain shader hides static water under the site). */
    get coverage() {
        if (!this.frame || this.fade <= 0) return null;
        const f = this.frame;
        return { c: f.c, e1: f.e1, e2: f.e2, halfM: this.halfM, borderM: this.config.borderCells * this.config.dx, fade: this.fade };
    }

    destroy() {
        this.sim.destroy();
        this._initUniform.destroy();
        this.state = 'idle';
    }
}
