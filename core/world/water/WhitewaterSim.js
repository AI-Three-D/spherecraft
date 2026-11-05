// core/world/water/WhitewaterSim.js
//
// Whitewater near the camera: the shallow-water simulation (kernels:
// whitewaterSim.wgsl.js, from the owner's Whitewater game) on the baked rivers.
//
// Window. A ring of N x N cells of dx metres on a tangent plane through the
// camera (frame), in blocks of WHITE_BLOCK cells: it scrolls by a block at a
// time and only blocks entering it are filled. Only blocks where the water
// flows, near the camera, step: cost follows the moving water in view, and lakes
// stay as they are (a lake in the window costs nothing).
//
// Warm-up. Whitewater starts from a level and speed that are not a solution
// and runs 900 hidden steps until the waves die down. Here a block starts on
// the baked flow (riverFlow.js), which is in balance by construction, so
// there is no wave to wait for: all that has to grow is the local detail behind
// rocks. That takes seconds, and during them the block is simply not shown:
// its weight eases in over warmS (the middle tier's look stays), young blocks
// step extra, and blocks are filled well beyond the drawn radius, so walking
// and running along a river never reach cold water. Flying fast, they never
// finish easing in, and the middle tier carries on: nothing pops, nothing stalls.
//
// Handover. Each block has a weight: 0 at the edge of the stepped blocks, 1
// inside, fading out by distance. Simulated values pull to the baked state
// where it is low (a sponge: inflow and outflow in one), and the drawn surface
// mixes height, foam and speed to the middle tier's, so where the mesh ends it
// already matches the mesh that takes over.

import { fieldCoords, pageKey, riverFieldTexelSdf } from './riverField.js';
import { RIVER_ROCK_FLOATS, unpackFlowTexel } from './riverFlow.js';
import { WHITE_BLOCK, WHITE_DIRS_WGSL, WHITE_INIT_WGSL, WHITE_SIM_PARAM_FLOATS, WHITE_SIM_WGSL, WHITE_SPREAD_WGSL } from './whitewaterSim.wgsl.js';
import { WHITE_FLAG_LOOK, WHITE_FLAG_NEAR, WHITE_UNIFORM_FLOATS } from '../../renderer/water/whitewaterLook.wgsl.js';
import { WHITE_SPRAY_BYTES, WHITE_SPRAY_PARTICLES, WHITE_SPRAY_WGSL } from '../../renderer/water/whitewaterProps.wgsl.js';

export const WHITEWATER_DEFAULTS = Object.freeze({
    // Cell size (m) and ring size in blocks (24 blocks of 32 cells: 384 m).
    dx: 0.5, gridBlocks: 24,
    // Blocks within this of the camera step, and the drawn surface fades out
    // between these (m). The camera farther than stepM from all water: no cost.
    stepM: 176, drawM: [96, 144],
    // Whitewater's solver settings, but steps of 1/60 s where it takes 1/120: that
    // serves its boat's physics; the water is stable (CFL 0.4 at the speed limit) and
    // costs half. Steps follow real time, at most maxSteps a frame: the game idles at
    // 30 FPS, and a step a frame ran the water at half speed under a real-time pattern.
    dt: 1 / 60, maxSteps: 3, g: 9.81, hmin: 0.02, umax: 12, macCormack: 1, turbA: 0.6, turbL: 3, turbT: 0.8,
    foamDecay: 0.35, kDecay: 0.8, kGen: 1, foamGen: 1, maxRise: 3, maxFall: 3,
    // Sponge toward the baked state (1/s at weight 0). Lake water holds its level at
    // lakeHold and loses a river's momentum at lakeDrag (1/s).
    sponge: 8, lakeHold: 3, lakeDrag: 0.8,
    // Bed roughness (m) under falling water, and the drawn chop (m at k = 1).
    roughM: 0.35, waveAmp: 0.06,
    // A block eases in over this (s) once it has stepped warmDelayS, stepping
    // youngSubsteps extra meanwhile.
    warmDelayS: 1.0, warmS: 1.5, youngSubsteps: 1,
    // New blocks per frame: a block is 1024 full terrain heights, 24 at once
    // took frames to 33 ms. Walking fills a row of a few blocks every 16 m.
    fillPerFrame: 8,
    // A block steps if the water in it moves this fast (m/s) or foams this much.
    flowSpeed: 0.2, flowFoam: 0.03,
    // A new frame when the camera is this far (m) from its centre.
    frameRangeM: 8000,
    foamGain: 1,
    // Rock meshes drawn this far (m); dead spray particles respawn at this rate per frame.
    rockDrawM: 500, sprayRate: 0.12,
});

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mod = (a, n) => ((a % n) + n) % n;
const BATCH_WORDS = 8;
const ROCK_LIST_MAX = 32768;
const ROCKS_MAX = 32768;

export class WhitewaterSim {
    constructor({ device, R, config = {} }) {
        this.device = device; this.R = R;
        this.config = { ...WHITEWATER_DEFAULTS, ...config };
        const c = this.config;
        this.enabled = true;
        this.G = c.gridBlocks; this.N = c.gridBlocks * WHITE_BLOCK; this.blockM = WHITE_BLOCK * c.dx;
        this.uniforms = new Float32Array(WHITE_UNIFORM_FLOATS);
        this._u32 = new Uint32Array(this.uniforms.buffer); this._i32 = new Int32Array(this.uniforms.buffer);
        this.params = new ArrayBuffer(WHITE_SIM_PARAM_FLOATS * 4);
        this._pf = new Float32Array(this.params); this._pu = new Uint32Array(this.params); this._pi = new Int32Array(this.params);
        this.frame = null;
        this.fieldVersion = -1;
        // Ring slots: the block held, or null. Blocks known so far by key.
        this.slots = new Array(this.G * this.G).fill(null);
        this.known = new Map();
        this.activeCount = 0;
        this.stats = { active: 0, fills: 0, steps: 0 };
        this._gpuReady = false;
        this._gridData = new Float32Array(this.G * this.G * 2);
        this._coverData = new Uint32Array(this.G * this.G);
        this._blockData = new Int32Array(this.G * this.G * 4);
        this._time = 0;
        this._lastNow = 0;
        this._createResources();
    }

    _createResources() {
        const d = this.device, cells = this.N * this.N, G2 = this.G * this.G, S = GPUBufferUsage.STORAGE, C = GPUBufferUsage.COPY_DST;
        const buffer = (label, size, usage) => d.createBuffer({ label: `Whitewater-${label}`, size, usage });
        this.simU = buffer('sim-params', this.params.byteLength, GPUBufferUsage.UNIFORM | C);
        this.frameU = buffer('frame', WHITE_UNIFORM_FLOATS * 4, GPUBufferUsage.UNIFORM | C);
        this.staticBuf = buffer('static', cells * 32, S | GPUBufferUsage.COPY_SRC);
        // Three states, as Whitewater: state a -> b per pass, three passes a substep,
        // ending back in the first, which is what is drawn.
        this.stateBufs = [0, 1, 2].map(k => buffer(`state${k}`, cells * 16, S | GPUBufferUsage.COPY_SRC));
        this.kBufs = [0, 1, 2].map(k => buffer(`k${k}`, cells * 4, S));
        this.blocksBuf = buffer('blocks', G2 * 16, S | C);
        this.gridBuf = buffer('grid', G2 * 8, S | C);
        this.coverBuf = buffer('cover', G2 * 4, S | C);
        this.fill = WHITE_BLOCK * WHITE_BLOCK * this.config.fillPerFrame;
        this.batchBuf = buffer('batch', (this.config.fillPerFrame * BATCH_WORDS + ROCK_LIST_MAX) * 4, S | C);
        this.dirsBuf = buffer('dirs', this.fill * 16, S);
        this.heightsBuf = buffer('heights', this.fill * 4, S | GPUBufferUsage.COPY_SRC);
        this.rocksBuf = buffer('rocks', 32 * ROCKS_MAX, S | C);
        this.rockListBuf = buffer('rock-list', 4 * ROCKS_MAX, S | C);
        this.rockDrawCount = 0;
        this.sprayBuf = buffer('spray', WHITE_SPRAY_BYTES, S);
        this.sprayU = buffer('spray-params', 32, GPUBufferUsage.UNIFORM | C);
        this.sprayData = new ArrayBuffer(32);
    }

    /** The sampler (HydrologyGrid.js) the bed comes from; pipelines compile in the background. */
    async start(sampler) {
        const d = this.device;
        const carved = await sampler.carvedDirsEncoder({ dirs: this.dirsBuf, heights: this.heightsBuf, capacity: this.fill });
        if (!carved) return false;
        this.bed = carved;
        const [dirsModule, initModule, spreadModule, simModule, sprayModule] = [WHITE_DIRS_WGSL, WHITE_INIT_WGSL, WHITE_SPREAD_WGSL, WHITE_SIM_WGSL, WHITE_SPRAY_WGSL(WHITE_BLOCK)].map((code, i) =>
            d.createShaderModule({ label: `Whitewater-${['dirs', 'init', 'spread', 'sim', 'spray'][i]}`, code }));
        const C = GPUShaderStage.COMPUTE;
        const entry = (binding, type) => ({ binding, visibility: C, buffer: { type } });
        const simLayout = d.createBindGroupLayout({ label: 'Whitewater-sim', entries: [entry(0, 'uniform'), entry(1, 'read-only-storage'), entry(2, 'read-only-storage'), entry(3, 'storage'),
            entry(4, 'read-only-storage'), entry(5, 'storage'), entry(6, 'read-only-storage'), entry(7, 'read-only-storage')] });
        const layout = d.createPipelineLayout({ bindGroupLayouts: [simLayout] });
        const [advect, height, momentum, dirs, init, spread, spray] = await Promise.all([
            ...['advect', 'height', 'momentum'].map(entryPoint => d.createComputePipelineAsync({ layout, compute: { module: simModule, entryPoint } })),
            d.createComputePipelineAsync({ layout: 'auto', compute: { module: dirsModule, entryPoint: 'dirs' } }),
            d.createComputePipelineAsync({ layout: 'auto', compute: { module: initModule, entryPoint: 'init' } }),
            d.createComputePipelineAsync({ layout: 'auto', compute: { module: spreadModule, entryPoint: 'spread' } }),
            d.createComputePipelineAsync({ layout: 'auto', compute: { module: sprayModule, entryPoint: 'spray' } }),
        ]);
        this.sprayPipe = spray;
        this.sprayGroup = d.createBindGroup({ layout: spray.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this.sprayU } }, { binding: 1, resource: { buffer: this.staticBuf } },
            { binding: 2, resource: { buffer: this.stateBufs[0] } }, { binding: 3, resource: { buffer: this.blocksBuf } },
            { binding: 4, resource: { buffer: this.sprayBuf } },
        ] });
        this.simPipes = [advect, height, momentum];
        this.dirsPipe = dirs; this.initPipe = init; this.spreadPipe = spread;
        this.simGroups = [[0, 1], [1, 2], [2, 0]].map(([a, b]) => d.createBindGroup({ layout: simLayout, entries: [
            { binding: 0, resource: { buffer: this.simU } }, { binding: 1, resource: { buffer: this.staticBuf } },
            { binding: 2, resource: { buffer: this.stateBufs[a] } }, { binding: 3, resource: { buffer: this.stateBufs[b] } },
            { binding: 4, resource: { buffer: this.kBufs[a] } }, { binding: 5, resource: { buffer: this.kBufs[b] } },
            { binding: 6, resource: { buffer: this.blocksBuf } }, { binding: 7, resource: { buffer: this.gridBuf } },
        ] }));
        this.dirsGroup = d.createBindGroup({ layout: dirs.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this.simU } }, { binding: 1, resource: { buffer: this.frameU } },
            { binding: 2, resource: { buffer: this.batchBuf } }, { binding: 3, resource: { buffer: this.dirsBuf } },
        ] });
        this.initGroup = d.createBindGroup({ layout: init.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this.simU } }, { binding: 1, resource: { buffer: this.frameU } },
            { binding: 2, resource: { buffer: this.batchBuf } }, { binding: 3, resource: { buffer: this.heightsBuf } },
            { binding: 4, resource: { buffer: this.rocksBuf } }, { binding: 5, resource: { buffer: this.staticBuf } },
            { binding: 6, resource: { buffer: this.stateBufs[0] } }, { binding: 7, resource: { buffer: this.kBufs[0] } },
        ] });
        this.spreadGroup = d.createBindGroup({ layout: spread.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this.simU } }, { binding: 1, resource: { buffer: this.batchBuf } },
            { binding: 2, resource: { buffer: this.stateBufs[0] } }, { binding: 3, resource: { buffer: this.kBufs[0] } },
            { binding: 4, resource: { buffer: this.stateBufs[1] } }, { binding: 5, resource: { buffer: this.stateBufs[2] } },
            { binding: 6, resource: { buffer: this.kBufs[1] } }, { binding: 7, resource: { buffer: this.kBufs[2] } },
        ] });
        this._fieldGroupRes = null;
        this._gpuReady = true;
        return true;
    }

    _setFrame(dir) {
        const a = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], e1 = norm(cross(a, dir)), e2 = cross(dir, e1);
        this.frame = { c: dir, e1, e2 };
        this._reset();
    }

    // Everything refills: a new frame, or the field under the window changed.
    _reset() {
        this.slots.fill(null); this.known.clear(); this.activeCount = 0;
        this._rocksVersion = -1;
    }

    _frameXY(d) {
        const { c, e1, e2 } = this.frame, k = this.R / (d[0] * c[0] + d[1] * c[1] + d[2] * c[2]);
        return [(d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2]) * k, (d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]) * k];
    }

    _frameDir(x, y) {
        const { c, e1, e2 } = this.frame, R = this.R;
        return norm([c[0] + (e1[0] * x + e2[0] * y) / R, c[1] + (e1[1] * x + e2[1] * y) / R, c[2] + (e1[2] * x + e2[2] * y) / R]);
    }

    // The nearest texel's water and flow at a point of the frame, or null outside the pages.
    _texel(field, x, y) {
        const L = field.layout, q = fieldCoords(this._frameDir(x, y), L), i = Math.floor(q.x), j = Math.floor(q.y);
        const pi = Math.floor(i / L.P), pj = Math.floor(j / L.P), key = pageKey(q.face, pi, pj, L), slot = field.slots.get(key);
        if (slot === undefined) return null;
        const k = (j - pj * L.P + L.A) * L.ST + i - pi * L.P + L.A, flow = unpackFlowTexel(field.flow[slot * L.TEX + k]);
        return { sdf: riverFieldTexelSdf(field.pages.get(key), k), speed: Math.hypot(flow.a, flow.b), foam: flow.foam, key };
    }

    // Whether water moves in a block, and which field pages it lies on.
    _classify(field, bx, by) {
        const c = this.config, B = this.blockM, b = { bx, by, flowing: false, wet: false, pages: new Set(), slot: -1, filled: false, stepS: 0 };
        for (let v = 0; v <= 4; v++) for (let u = 0; u <= 4; u++) {
            const t = this._texel(field, (bx + u / 4) * B, (by + v / 4) * B);
            if (!t) continue;
            b.pages.add(t.key);
            if (t.sdf > -4) b.wet = true;
            if (t.sdf > -4 && (t.speed > c.flowSpeed || t.foam > c.flowFoam)) b.flowing = true;
        }
        return b;
    }

    _block(field, bx, by) {
        const key = bx * 65536 + by;
        let b = this.known.get(key);
        if (!b) { b = this._classify(field, bx, by); this.known.set(key, b); }
        return b;
    }

    // Rocks in the frame's coordinates, on the GPU, and by block for the fills.
    _uploadRocks(field) {
        if (this._rocksVersion === field.version) return;
        this._rocksVersion = field.version;
        const list = field.rocks, n = Math.min(list.length / RIVER_ROCK_FLOATS, ROCKS_MAX), data = new Float32Array(n * 8), byBlock = new Map(), B = this.blockM;
        const rocks = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
            const o = i * RIVER_ROCK_FLOATS, d = [list[o], list[o + 1], list[o + 2]], [x, y] = this._frameXY(d), r = list[o + 3];
            data.set([x, y, r, list[o + 4], list[o + 5], list[o + 6], list[o + 7], 0], i * 8);
            rocks.set([x, y, r, list[o + 4], list[o + 5], list[o + 6], list[o + 7], 0], i * 8);
            if (list[o + 8] < 0.5) continue;
            for (let by = Math.floor((y - r) / B); by <= Math.floor((y + r) / B); by++) for (let bx = Math.floor((x - r) / B); bx <= Math.floor((x + r) / B); bx++) {
                const key = bx * 65536 + by;
                if (!byBlock.has(key)) byBlock.set(key, []);
                byBlock.get(key).push(i);
            }
        }
        this.device.queue.writeBuffer(this.rocksBuf, 0, data);
        this.rocksByBlock = byBlock; this.rockCount = n; this.rockFrame = rocks;
        this._rockListAt = null;
    }

    // Rocks near enough to draw, listed again after the camera has moved a little.
    _listRocks(camX, camY) {
        const at = this._rockListAt, c = this.config;
        if (at && Math.hypot(at[0] - camX, at[1] - camY) < 12) return;
        this._rockListAt = [camX, camY];
        const rocks = this.rockFrame, n = this.rockCount ?? 0, list = new Uint32Array(n);
        let count = 0;
        for (let i = 0; i < n; i++) if (Math.hypot(rocks[i * 8] - camX, rocks[i * 8 + 1] - camY) < c.rockDrawM) list[count++] = i;
        this.device.queue.writeBuffer(this.rockListBuf, 0, list, 0, count);
        this.rockDrawCount = count;
    }

    _fieldGroup(res) {
        if (this._fieldGroupRes === res) return this._fieldGroupCached;
        this._fieldGroupRes = res;
        this._fieldGroupCached = this.device.createBindGroup({ layout: this.initPipe.getBindGroupLayout(1), entries: [
            { binding: 0, resource: { buffer: res.pages } }, { binding: 1, resource: { buffer: res.texels } },
            { binding: 2, resource: { buffer: res.params } }, { binding: 3, resource: { buffer: res.flow } },
        ] });
        return this._fieldGroupCached;
    }

    _writeParams(count, dt) {
        const c = this.config, f = this._pf;
        this._pi[0] = this.N; this._pi[1] = this.G; this._pu[2] = count;
        f.set([c.dx, dt, c.g, c.hmin, c.umax, this._time, c.macCormack, c.turbA, c.turbL, c.turbT, c.foamDecay, c.kDecay,
            c.kGen, c.foamGen, c.maxRise, c.maxFall, c.sponge, c.roughM, c.lakeHold, c.lakeDrag], 4);
        this.device.queue.writeBuffer(this.simU, 0, this.params);
    }

    // Blocks wanted around the camera: flowing ones within reach, and their neighbours.
    _wanted(field, camX, camY, camH) {
        const c = this.config, G = this.G, B = this.blockM, half = (G >> 1) - 1;
        const cbx = Math.floor(camX / B), cby = Math.floor(camY / B), step = new Map();
        this._origin = [cbx - (G >> 1), cby - (G >> 1)];
        this._reachMark = (this._reachMark ?? 0) + 1;
        if (camH > c.stepM) return step;
        const reach = Math.sqrt(c.stepM ** 2 - camH ** 2);
        for (let dy = -half + 2; dy < half - 1; dy++) for (let dx = -half + 2; dx < half - 1; dx++) {
            const bx = cbx + dx, by = cby + dy;
            if (Math.hypot((bx + 0.5) * B - camX, (by + 0.5) * B - camY) > reach) continue;
            const b = this._block(field, bx, by);
            if (!b.flowing) continue;
            // It steps, and the slower water beside it (a bank's shallows move too
            // little to count, but left out they would hold the river's edge still).
            // The ring around those is filled, not stepped.
            for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) {
                const key = (bx + u) * 65536 + by + v, n = this._block(field, bx + u, by + v);
                if (!step.has(key)) step.set(key, n);
                if (Math.abs(u) <= 1 && Math.abs(v) <= 1 && n.wet) n.reach = this._reachMark;
            }
        }
        return step;
    }

    // Fills up to fillPerFrame blocks, nearest first: what steps, then its neighbours.
    _fill(enc, field, need, camX, camY) {
        const c = this.config, B = this.blockM, G = this.G;
        need.sort((a, b) => Math.hypot((a.bx + 0.5) * B - camX, (a.by + 0.5) * B - camY) - Math.hypot((b.bx + 0.5) * B - camX, (b.by + 0.5) * B - camY));
        const take = need.slice(0, c.fillPerFrame);
        if (!take.length || !this.bed.ready()) return 0;
        const batch = new Int32Array(c.fillPerFrame * BATCH_WORDS + ROCK_LIST_MAX);
        let rockAt = c.fillPerFrame * BATCH_WORDS;
        take.forEach((b, i) => {
            const rx = mod(b.bx, G), ry = mod(b.by, G), rocks = this.rocksByBlock?.get(b.bx * 65536 + b.by) ?? [];
            const count = Math.min(rocks.length, batch.length - rockAt);
            batch.set([b.bx, b.by, rx, ry, rockAt, count, 0, 0], i * BATCH_WORDS);
            for (let r = 0; r < count; r++) batch[rockAt + r] = rocks[r];
            rockAt += count;
            const old = this.slots[ry * G + rx];
            if (old) { old.filled = false; old.stepS = 0; }
            this.slots[ry * G + rx] = b;
            b.filled = true; b.stepS = 0; b.slot = ry * G + rx;
        });
        this.device.queue.writeBuffer(this.batchBuf, 0, batch.buffer, 0, rockAt * 4);
        const cells = take.length * WHITE_BLOCK * WHITE_BLOCK, groups = Math.ceil(cells / 64);
        let pass = enc.beginComputePass({ label: 'Whitewater-dirs' });
        pass.setPipeline(this.dirsPipe); pass.setBindGroup(0, this.dirsGroup); pass.dispatchWorkgroups(groups); pass.end();
        if (!this.bed.encode(enc, cells)) { for (const b of take) b.filled = false; return 0; }
        pass = enc.beginComputePass({ label: 'Whitewater-init' });
        pass.setPipeline(this.initPipe); pass.setBindGroup(0, this.initGroup); pass.setBindGroup(1, this._fieldGroup(field.resources));
        pass.dispatchWorkgroups(groups); pass.end();
        pass = enc.beginComputePass({ label: 'Whitewater-spread' });
        pass.setPipeline(this.spreadPipe); pass.setBindGroup(0, this.spreadGroup); pass.dispatchWorkgroups(groups); pass.end();
        this.stats.fills += take.length;
        return take.length;
    }

    /** Per frame. rel: the camera, planet-centred. field: RiverFieldService. */
    update(rel, nowS, field) {
        const l = Math.hypot(rel.x, rel.y, rel.z) || 1, dir = [rel.x / l, rel.y / l, rel.z / l], f = this.frame, c = this.config;
        if (!f || Math.acos(Math.min(1, f.c[0] * dir[0] + f.c[1] * dir[1] + f.c[2] * dir[2])) * this.R > c.frameRangeM) this._setFrame(dir);
        const dtReal = Math.min(nowS - this._lastNow, 0.1);
        this._lastNow = nowS;
        const [camX, camY] = this._frameXY(dir);
        const { c: fc, e1, e2 } = this.frame, u = this.uniforms;
        // debugOff.pattern holds the surface pattern still (tools/perf/whitewater/flicker.mjs).
        if (!this.debugOff?.pattern) this._patternS = nowS % 3600;
        u.set([fc[0], fc[1], fc[2], this.R, e1[0], e1[1], e1[2], this._patternS, e2[0], e2[1], e2[2], c.dx], 0);
        this._u32[12] = this.N; this._u32[14] = WHITE_BLOCK; this._u32[15] = this.G;
        u[18] = c.hmin; u[19] = c.waveAmp; u[20] = camX; u[21] = camY; u[22] = c.drawM[0]; u[23] = c.drawM[1]; u[24] = c.foamGain; u[25] = c.rockDrawM; u[26] = Math.min(Math.max(dtReal, 1 / 240), 0.05);
        // On the queue before this frame's fills read it.
        this.device.queue.writeBuffer(this.frameU, 0, u);
        const nearOn = this._simulate(camX, camY, l - this.R, dtReal, field);
        this._u32[13] = (this.enabled ? WHITE_FLAG_LOOK : 0) | (nearOn ? WHITE_FLAG_NEAR : 0);
        this._i32[16] = this._origin?.[0] ?? 0; this._i32[17] = this._origin?.[1] ?? 0;
    }

    _simulate(camX, camY, camAlt, dtReal, field) {
        const c = this.config, G = this.G, B = this.blockM;
        this.activeCount = 0;
        if (!this.enabled || !this._gpuReady || !field?.resources || !field.wetPages?.length) return false;
        if (field.version !== this.fieldVersion) {
            // Only a change under the window starts it again.
            const changed = this._changedUnderWindow(field);
            this.fieldVersion = field.version;
            if (changed) this._reset();
            else for (const b of this.known.values()) if (!b.filled) this.known.delete(b.bx * 65536 + b.by);
        }
        if (this.known.size > 6000) for (const b of this.known.values()) if (!b.filled) this.known.delete(b.bx * 65536 + b.by);
        this._uploadRocks(field);
        // The camera's height over the water of the nearest moving block sets the reach:
        // above the rivers' levels by the field, taken as the camera's over the ground it knows.
        const camH = this._heightOverWater(field, camX, camY, camAlt);
        this._listRocks(camX, camY);
        const want = this._wanted(field, camX, camY, camH);
        const enc = this.device.createCommandEncoder({ label: 'Whitewater' });
        const need = [];
        for (const b of want.values()) if (!b.filled) need.push(b);
        const filled = need.length ? this._fill(enc, field, need, camX, camY) : 0;
        // Stepped: those marked, with all eight neighbours filled.
        const grid = this._gridData, blocks = this._blockData;
        grid.fill(0);
        this._coverData.fill(0);
        let count = 0, young = false;
        const stepping = new Set();
        for (const [key, b] of want) {
            if (!b.filled || b.reach !== this._reachMark) continue;
            let around = true;
            for (let v = -1; v <= 1 && around; v++) for (let u = -1; u <= 1; u++) {
                const n = this.known.get((b.bx + u) * 65536 + b.by + v);
                if (!n?.filled) { around = false; break; }
            }
            if (around) stepping.add(key);
        }
        for (const key of stepping) {
            const b = want.get(key), rx = mod(b.bx, G), ry = mod(b.by, G);
            // Held to the baked state where a flowing neighbour does not step:
            // the river goes on there. Dry neighbours are the banks.
            let inside = 1;
            for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
                const nk = (b.bx + u) * 65536 + b.by + v, n = this.known.get(nk);
                if (n?.wet && !stepping.has(nk)) inside = 0;
            }
            b.stepS += dtReal;
            const warm = smoothstep(c.warmDelayS, c.warmDelayS + c.warmS, b.stepS);
            if (warm < 1) young = true;
            const dist = Math.hypot((b.bx + 0.5) * B - camX, (b.by + 0.5) * B - camY, this._camH ?? 0);
            grid[(ry * G + rx) * 2] = inside;
            grid[(ry * G + rx) * 2 + 1] = inside * warm * (1 - smoothstep(c.drawM[0], c.drawM[1], dist));
            blocks.set([b.bx, b.by, rx, ry], count * 4);
            this._coverData[ry * G + rx] = 1;
            count++;
        }
        // Dry blocks beside them take their weight: the weights interpolate
        // between block centres, and a zero on the bank would fade the water beside it.
        for (const b of want.values()) {
            if (b.wet || !b.filled) continue;
            let w = 0, d = 0;
            for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
                const n = (mod(b.by + v, G) * G + mod(b.bx + u, G)) * 2;
                w = Math.max(w, grid[n]); d = Math.max(d, grid[n + 1]);
            }
            const o = (mod(b.by, G) * G + mod(b.bx, G)) * 2;
            grid[o] = w; grid[o + 1] = d;
        }
        this.activeCount = count;
        this.stats.active = count;
        if (count) {
            const d = this.device.queue;
            d.writeBuffer(this.blocksBuf, 0, blocks, 0, count * 4);
            d.writeBuffer(this.gridBuf, 0, grid);
            d.writeBuffer(this.coverBuf, 0, this._coverData);
            this._stepOwed = Math.min((this._stepOwed ?? 0) + dtReal, c.dt * c.maxSteps);
            const due = Math.floor(this._stepOwed / c.dt);
            this._stepOwed -= due * c.dt;
            const steps = this.debugOff?.solver ? 0 : due + (young ? c.youngSubsteps : 0);
            this._time += c.dt * steps;
            for (let s = 0; s < steps; s++) {
                const pass = enc.beginComputePass({ label: 'Whitewater-step' });
                for (let k = 0; k < 3; k++) {
                    pass.setPipeline(this.simPipes[k]);
                    pass.setBindGroup(0, this.simGroups[k]);
                    pass.dispatchWorkgroups(count * (WHITE_BLOCK / 8) ** 2);
                }
                pass.end();
            }
            this.stats.steps += steps;
            const sp = new DataView(this.sprayData);
            [this._time, dtReal, c.dx].forEach((v, i) => sp.setFloat32(i * 4, v, true));
            sp.setInt32(12, this.N, true); sp.setUint32(16, count, true); sp.setFloat32(20, c.hmin, true); sp.setFloat32(24, c.sprayRate, true);
            d.writeBuffer(this.sprayU, 0, this.sprayData);
            const pass = enc.beginComputePass({ label: 'Whitewater-spray' });
            pass.setPipeline(this.sprayPipe); pass.setBindGroup(0, this.sprayGroup); pass.dispatchWorkgroups(Math.ceil(WHITE_SPRAY_PARTICLES / 64)); pass.end();
        }
        // One write for the frame: writes reach the queue before this submit.
        this._writeParams(filled, c.dt);
        if (count || filled) this.device.queue.submit([enc.finish()]);
        return count > 0;
    }

    _changedUnderWindow(field) {
        const old = this._seenHashes, now = field.pageHashes;
        this._seenHashes = now;
        if (!old || !now) return true;
        for (const b of this.known.values()) if (b.filled) for (const key of b.pages) if (old.get(key) !== now.get(key)) return true;
        return false;
    }

    // Height (m) of the camera over the water around it.
    _heightOverWater(field, camX, camY, camAlt) {
        const L = field.layout, q = fieldCoords(this._frameDir(camX, camY), L), i = Math.floor(q.x), j = Math.floor(q.y);
        const pi = Math.floor(i / L.P), pj = Math.floor(j / L.P), data = field.pages.get(pageKey(q.face, pi, pj, L));
        const level = data ? new Float32Array(data.buffer, data.byteOffset + ((j - pj * L.P + L.A) * L.ST + i - pi * L.P + L.A) * 8, 1)[0] : NaN;
        if (Number.isFinite(level) && level > -1e3) this._level = level;
        this._camH = this._level === undefined ? Infinity : Math.max(0, camAlt - this._level);
        return this._camH;
    }

    /** Stepped blocks for drawing: how many, and the buffers (whitewaterSurface.wgsl.js). */
    get drawCount() { return this.debugOff?.surface ? 0 : this.activeCount; }

    /** Rocks and spray to draw while the switch is on. */
    get rocksToDraw() { return this.enabled && !this.debugOff?.rocks ? this.rockDrawCount : 0; }
    get sprayToDraw() { return this.enabled && this.activeCount && !this.debugOff?.spray ? WHITE_SPRAY_PARTICLES : 0; }

    summary() {
        return { enabled: this.enabled, ready: this._gpuReady, active: this.activeCount, cells: this.activeCount * WHITE_BLOCK ** 2, fills: this.stats.fills, steps: this.stats.steps, rocks: this.rockCount ?? 0, frame: !!this.frame };
    }

    dispose() {
        for (const b of [this.simU, this.frameU, this.staticBuf, ...this.stateBufs, ...this.kBufs, this.blocksBuf, this.gridBuf, this.coverBuf, this.rockListBuf, this.sprayBuf, this.sprayU, this.batchBuf, this.dirsBuf, this.heightsBuf, this.rocksBuf]) b?.destroy();
    }
}

