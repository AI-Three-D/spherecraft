// @ts-nocheck
// The obstacle table (ECOLOGY_FOUNDATION_PLAN.md F5; obstacles.wgsl.js): discs the next layer keeps clear of, in world
// cells about the camera on a fixed lattice level (cellSpacingM, about 128 m), resident within radiusM whatever level of
// detail the terrain shows, made in layer order when a cell comes in: geology, then trees, then deadfall (writers by
// priority). The finalize pass sorts each cell's records into one order, keeps `capacity` (the rest counted as overflow,
// the cell marked incomplete) and bins them. Cells are deterministic functions of their place, so their contents do not
// depend on the order they are made in.
//
// A writer: addWriter({ name, priority, encode(encoder, ctx) }), its shader using buildObstacleAppendWGSL; ctx holds the
// cells to make ({ slot, face, ix, iy }), the level, and the buffers to bind. The foundation's only writer is the debug
// geology (debugDiscs: boulders at hashed places), for tests.

import { ECOLOGY_LATTICE_WGSL } from './ecologyLattice.wgsl.js';
import { ECO_LAYERS, cellsWithin, directionToFace, faceDirection, latticeFor } from './ecologyLattice.js';
import { GroundFrame } from './GroundFrame.js';
import { buildDrawnGroundWGSL } from './drawnGround.wgsl.js';
import {
    OBSTACLE_HEADER, OBSTACLE_HEADER_WORDS, OBSTACLE_KINDS, OBSTACLE_PRIORITY, OBSTACLE_TABLE_CAP,
    buildObstacleAppendWGSL, buildObstacleFinalizeWGSL, buildObstacleReadWGSL, obstacleHash, obstacleKey,
} from './obstacles.wgsl.js';

export const OBSTACLE_DEFAULTS = Object.freeze({
    cellSpacingM: 128,
    radiusM: 400,
    /** Records kept a cell, and staged (a power of two) before the sort. */
    capacity: 1024,
    staging: 2048,
    /** Resident cells at most (slots). */
    maxCells: 96,
    /** Boulders at hashed places, for tests. */
    debugDiscs: false,
    debugDiscsPerCell: 40,
});

// A cell's state in its header (as the ecology field's layers: 1, pending, is not used: a cell is made in the frame it comes in).
const STATE_MISSING = 0, STATE_READY = 2;

export class ObstacleCells {
    /** o: device, tileManager, planetConfig, config. */
    constructor(o) {
        Object.assign(this, o);
        this.config = { ...OBSTACLE_DEFAULTS, ...(o.config ?? {}) };
        this.ready = false;
        this.writers = [];
        this._slots = new Map();   // key string -> slot
        this._cellOf = [];          // slot -> { face, ix, iy, key }
        this._free = [];
        this._versions = new Uint32Array(this.config.maxCells);
        this._cameraCell = null;
    }

    async initialize() {
        const { device } = this;
        const B = GPUBufferUsage, C = GPUShaderStage.COMPUTE;
        const cfg = this.config;
        if ((cfg.staging & (cfg.staging - 1)) !== 0) throw new Error('ObstacleCells: staging must be a power of two');
        this.level = latticeFor(cfg.cellSpacingM, this.planetConfig.radius);
        for (let s = cfg.maxCells - 1; s >= 0; s--) this._free.push(s);
        const buffer = (label, size, usage) => device.createBuffer({ label: `Obstacles ${label}`, size, usage });
        this.frame = buffer('frame', 32, B.UNIFORM | B.COPY_DST);
        this.table = buffer('table', OBSTACLE_TABLE_CAP * 16, B.STORAGE | B.COPY_DST);
        this.headers = buffer('headers', cfg.maxCells * OBSTACLE_HEADER_WORDS * 4, B.STORAGE | B.COPY_DST | B.COPY_SRC);
        this.staging = buffer('staging', cfg.maxCells * cfg.staging * 16, B.STORAGE);
        this.records = buffer('records', cfg.maxCells * cfg.capacity * 16, B.STORAGE | B.COPY_SRC);
        this.jobs = buffer('jobs', cfg.maxCells * 16, B.STORAGE | B.COPY_DST);
        this._tableData = new Uint32Array(OBSTACLE_TABLE_CAP * 4);
        this._headerData = new Uint32Array(cfg.maxCells * OBSTACLE_HEADER_WORDS);
        const frame = new Uint32Array(8);
        new Float32Array(frame.buffer).set([this.planetConfig.radius], 4);
        frame.set([this.level, cfg.capacity, cfg.staging, 0], 0);
        this._frameData = frame;
        device.queue.writeBuffer(this.frame, 0, frame);
        device.queue.writeBuffer(this.table, 0, this._tableData);
        device.queue.writeBuffer(this.headers, 0, this._headerData);

        const at = (binding, type) => ({ binding, visibility: C, buffer: { type } });
        this._finalizeLayout = device.createBindGroupLayout({ entries: [at(0, 'uniform'), at(1, 'read-only-storage'), at(2, 'storage'), at(3, 'storage'), at(4, 'storage')] });
        this._finalize = await device.createComputePipelineAsync({
            label: 'Obstacles finalize', layout: device.createPipelineLayout({ bindGroupLayouts: [this._finalizeLayout] }),
            compute: { module: device.createShaderModule({ label: 'Obstacles finalize', code: buildObstacleFinalizeWGSL() }), entryPoint: 'main' },
        });
        this._finalizeGroup = device.createBindGroup({ layout: this._finalizeLayout, entries: [this.frame, this.jobs, this.headers, this.staging, this.records]
            .map((b, binding) => ({ binding, resource: { buffer: b } })) });
        // Writers append with these (buildObstacleAppendWGSL's order: frame, headers, staging).
        this.appendLayout = device.createBindGroupLayout({ entries: [at(0, 'uniform'), at(1, 'storage'), at(2, 'storage'), at(3, 'read-only-storage')] });
        this.appendGroup = device.createBindGroup({ layout: this.appendLayout, entries: [this.frame, this.headers, this.staging, this.jobs]
            .map((b, binding) => ({ binding, resource: { buffer: b } })) });
        this.addWriter(await this._debugGeologyWriter());
        this.ready = true;
    }

    /** Readers' resources, in buildObstacleReadWGSL's order: frame, table, headers, records. */
    get resources() { return [this.frame, this.table, this.headers, this.records].map(buffer => ({ buffer })); }

    /** A writer: { name, priority, encode(encoder, ctx) }; run in priority order, geology first. */
    addWriter(writer) {
        this.writers.push(writer);
        this.writers.sort((a, b) => b.priority - a.priority);
        this.invalidate();
    }

    /** Every resident cell made again (a writer changed what it writes). */
    invalidate() { this._invalid = true; }

    _keyOf(face, ix, iy) { return `${face}/${ix}/${iy}`; }

    _rebuildTable() {
        const t = this._tableData;
        t.fill(0);
        for (const [, slot] of this._slots) {
            const c = this._cellOf[slot];
            const [lo, hi] = obstacleKey(c.face, this.level, c.ix, c.iy);
            let i = obstacleHash(lo, hi);
            while (t[i * 4 + 2] !== 0) i = (i + 1) & (OBSTACLE_TABLE_CAP - 1);
            t.set([lo, hi, slot + 1, 0], i * 4);
        }
        this.device.queue.writeBuffer(this.table, 0, t);
    }

    /** Once a frame, before readers: cells about the camera made resident and made, in layer order. */
    update(encoder, { camRel }) {
        if (!this.ready) return;
        this._lastCamRel = camRel;
        const R = this.planetConfig.radius;
        const n = 2 ** this.level;
        const at = directionToFace(camRel);
        const home = { face: at.face, ix: Math.min(n - 1, Math.floor(at.u * n)), iy: Math.min(n - 1, Math.floor(at.v * n)) };
        const homeKey = this._keyOf(home.face, home.ix, home.iy);
        const jobs = [];
        if (homeKey !== this._cameraCell || this._invalid) {
            this._cameraCell = homeKey;
            const wanted = cellsWithin(home.face, this.level, home.ix, home.iy, this.config.radiusM, R).slice(0, this.config.maxCells);
            const keys = new Set(wanted.map(c => this._keyOf(c.face, c.ix, c.iy)));
            let changed = false;
            for (const [key, slot] of this._slots) {
                if (keys.has(key)) continue;
                this._slots.delete(key);
                this._cellOf[slot] = null;
                this._free.push(slot);
                this._versions[slot]++;
                this._headerData.fill(0, slot * OBSTACLE_HEADER_WORDS, (slot + 1) * OBSTACLE_HEADER_WORDS);
                this._headerData[slot * OBSTACLE_HEADER_WORDS + OBSTACLE_HEADER.STATE] = (this._versions[slot] << 2) | STATE_MISSING;
                changed = true;
            }
            for (const c of wanted) {
                const key = this._keyOf(c.face, c.ix, c.iy);
                let slot = this._slots.get(key);
                if (slot === undefined) {
                    if (!this._free.length) break;
                    slot = this._free.pop();
                    this._slots.set(key, slot);
                    this._cellOf[slot] = { ...c, key };
                    changed = true;
                    jobs.push(slot);
                } else if (this._invalid) {
                    jobs.push(slot);
                }
            }
            this._invalid = false;
            if (changed) this._rebuildTable();
        }
        if (!jobs.length) return;
        // The cells to make: their headers cleared and marked ready (the commands below make them before any reader).
        for (const slot of jobs) {
            const c = this._cellOf[slot];
            const [lo, hi] = obstacleKey(c.face, this.level, c.ix, c.iy);
            this._versions[slot]++;
            const o = slot * OBSTACLE_HEADER_WORDS;
            this._headerData.fill(0, o, o + OBSTACLE_HEADER_WORDS);
            this._headerData.set([lo, hi, ((this._versions[slot] << 2) | STATE_READY) >>> 0], o);
        }
        this.device.queue.writeBuffer(this.headers, 0, this._headerData);
        this.device.queue.writeBuffer(this.jobs, 0, new Uint32Array(jobs.flatMap(s => [s, this._cellOf[s].face, this._cellOf[s].ix, this._cellOf[s].iy])));
        this._frameData[3] = jobs.length;
        this.device.queue.writeBuffer(this.frame, 0, this._frameData);
        const ctx = { cells: jobs.map(slot => ({ slot, ...this._cellOf[slot] })), level: this.level, appendGroup: this.appendGroup, appendLayout: this.appendLayout };
        for (const w of this.writers) w.encode(encoder, ctx);
        const pass = encoder.beginComputePass({ label: 'Obstacles finalize' });
        pass.setPipeline(this._finalize);
        pass.setBindGroup(0, this._finalizeGroup);
        pass.dispatchWorkgroups(jobs.length);
        pass.end();
        this.version = (this.version ?? 0) + 1;
    }

    async _debugGeologyWriter() {
        const { device } = this;
        const code = /* wgsl */`${ECOLOGY_LATTICE_WGSL}
${buildObstacleAppendWGSL({ frame: [0, 0], headers: [0, 1], staging: [0, 2] })}
@group(0) @binding(3) var<storage, read> jobs: array<vec4<u32>>;
struct DebugFrame { counts: vec4<u32> };
@group(1) @binding(0) var<uniform> debug: DebugFrame;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
    if (wg.x >= obstacleFrame.counts.w || t >= debug.counts.x || debug.counts.y == 0u) { return; }
    let job = jobs[wg.x];
    let h = ecoCellHash(job.y, job.z, job.w, ${ECO_LAYERS.ROCKS}u, 0u);
    let a = ecoDraw(h, t * 3u);
    let b = ecoDraw(h, t * 3u + 1u);
    let c = ecoDraw(h, t * 3u + 2u);
    let id = ecoId(job.y, obstacleFrame.counts.x, job.z, job.w, t).x;
    obstacleAppend(job.x, obstacleRecord(id, vec2<f32>(u01(a), u01(b)), mix(0.3, 1.5, u01(c)), 1.0, ${OBSTACLE_KINDS.BOULDER}u, 0u, ${OBSTACLE_PRIORITY.GEOLOGY}u));
}`;
        const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }] });
        const pipeline = await device.createComputePipelineAsync({
            label: 'Obstacles debug geology', layout: device.createPipelineLayout({ bindGroupLayouts: [this.appendLayout, layout] }),
            compute: { module: device.createShaderModule({ label: 'Obstacles debug geology', code }), entryPoint: 'main' },
        });
        const params = device.createBuffer({ label: 'Obstacles debug', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: params } }] });
        this._debugParams = params;
        return {
            name: 'debug geology', priority: OBSTACLE_PRIORITY.GEOLOGY,
            encode: (encoder, ctx) => {
                device.queue.writeBuffer(params, 0, new Uint32Array([Math.min(64, this.config.debugDiscsPerCell), this.config.debugDiscs ? 1 : 0, 0, 0]));
                if (!this.config.debugDiscs) return;
                const pass = encoder.beginComputePass({ label: 'Obstacles debug geology' });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, ctx.appendGroup);
                pass.setBindGroup(1, group);
                pass.dispatchWorkgroups(ctx.cells.length);
                pass.end();
            },
        };
    }

    /** Headers and records of the resident cells, read back (for tests and diagnostics). */
    async readBack() {
        const { device } = this;
        const read = (src, size) => {
            const b = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const e = device.createCommandEncoder();
            e.copyBufferToBuffer(src, 0, b, 0, size);
            device.queue.submit([e.finish()]);
            return b.mapAsync(GPUMapMode.READ).then(() => { const a = new Uint32Array(b.getMappedRange().slice(0)); b.destroy(); return a; });
        };
        const [headers, records] = await Promise.all([read(this.headers, this.headers.size), read(this.records, this.records.size)]);
        const cells = [];
        for (const [key, slot] of this._slots) {
            const h = slot * OBSTACLE_HEADER_WORDS;
            const count = headers[h + OBSTACLE_HEADER.COUNT];
            const discs = [];
            for (let i = 0; i < count; i++) {
                const o = (slot * this.config.capacity + i) * 4;
                const xy = records[o + 1];
                discs.push({ id: records[o], u: (xy & 0xFFFF) / 65535, v: (xy >>> 16) / 65535, radius: (records[o + 2] & 0xFFFF) / 1000, kind: records[o + 3] & 0xFFFF });
            }
            cells.push({ key, slot, ...this._cellOf[slot], state: headers[h + OBSTACLE_HEADER.STATE] & 3, count, overflow: headers[h + OBSTACLE_HEADER.OVERFLOW], discs });
        }
        return cells;
    }

    /**
     * The query against a reference worked out here in doubles from the read-back discs: points on cells about the
     * camera, their clearance on the GPU (obstacleClearance) and on the CPU. Returns { points, worst, unknown }.
     */
    async selfTest({ points = 256, searchM = 12, quadtree }) {
        const { device } = this;
        const R = this.planetConfig.radius, n = 2 ** this.level;
        const cells = await this.readBack();
        const resident = new Map(cells.map(c => [c.key, c]));
        // Points on cells whose neighbours are all resident.
        const inner = cells.filter(c => [-1, 0, 1].every(dy => [-1, 0, 1].every(dx => {
            const nx = c.ix + dx, ny = c.iy + dy;
            return nx >= 0 && ny >= 0 && nx < n && ny < n && resident.has(`${c.face}/${nx}/${ny}`);
        })));
        if (!inner.length) return { points: 0, worst: NaN, unknown: 0 };
        const unit = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
        // As the ground's functions take a point: patch p of its face (whole) and f within it.
        const shift = quadtree.maxDepth + 6 - this.level, per = 2 ** shift;
        const query = [];
        for (let i = 0; i < points; i++) {
            const c = inner[i % inner.length];
            const fx = ((i * 0.6180339) % 1) * per, fy = ((i * 0.7548776) % 1) * per;
            const px = c.ix * per + Math.floor(fx), py = c.iy * per + Math.floor(fy);
            const f = [Math.fround(fx - Math.floor(fx)), Math.fround(fy - Math.floor(fy))];
            query.push({ face: c.face, p: [px, py], f, u: (px + f[0]) / (n * per), v: (py + f[1]) / (n * per) });
        }
        // f as unorm16 (what the GPU reads back from pack2x16unorm), and the reference at the same place.
        for (const q of query) q.f = q.f.map(x => Math.round(x * 65535) / 65535);
        for (const q of query) { q.u = (q.p[0] + q.f[0]) / (n * per); q.v = (q.p[1] + q.f[1]) / (n * per); }
        // The reference: tangent-plane distance at the point to every disc in the cells about it.
        const expect = query.map(q => {
            const up = unit(faceDirection(q.face, q.u, q.v));
            let best = searchM;
            for (const c of cells) for (const d of c.discs) {
                const p = unit(faceDirection(c.face, (c.ix + d.u) / n, (c.iy + d.v) / n));
                const w = p.map((x, k) => (x - up[k]) * R);
                const along = w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
                const t = w.map((x, k) => x - up[k] * along);
                best = Math.min(best, Math.hypot(...t) - d.radius);
            }
            return best;
        });
        // The GPU: a ground frame reaching the cells, the query per point.
        const groundFrame = this._testFrame ??= new GroundFrame(device, { label: 'Obstacles test ground frame' });
        groundFrame.update({ camRel: this._lastCamRel, radius: R, heightScale: this.planetConfig.heightScale, quadtree, reach: this.config.radiusM + 200 });
        const code = /* wgsl */`${ECOLOGY_LATTICE_WGSL}${buildDrawnGroundWGSL({ frame: [0, 0], loaded: [0, 1], visible: [0, 2], height: [0, 3] })}
${buildObstacleReadWGSL({ frame: [1, 0], table: [1, 1], headers: [1, 2], records: [1, 3] })}
@group(2) @binding(0) var<storage, read> points: array<vec4<u32>>;
@group(2) @binding(1) var<storage, read_write> results: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&results)) { return; }
    let p = points[id.x];
    results[id.x] = obstacleClearance(p.x, p.yz, unpack2x16unorm(p.w), ${searchM.toFixed(1)}, 0xFFFFFFFFu);
}`;
        const module = device.createShaderModule({ label: 'Obstacles self-test', code });
        const C = GPUShaderStage.COMPUTE;
        const layout = (...types) => device.createBindGroupLayout({ entries: types.map((t, binding) => ({ binding, visibility: C, ...t })) });
        const uniform = { buffer: { type: 'uniform' } }, ro = { buffer: { type: 'read-only-storage' } }, rw = { buffer: { type: 'storage' } };
        const layouts = [
            layout(uniform, ro, ro, { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } }),
            layout(uniform, ro, ro, ro),
            layout(ro, rw),
        ];
        const pipeline = await device.createComputePipelineAsync({ label: 'Obstacles self-test', layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module, entryPoint: 'main' } });
        const pts = new Uint32Array(query.flatMap(q => [q.face, q.p[0], q.p[1], (Math.round(q.f[0] * 65535) | (Math.round(q.f[1] * 65535) << 16)) >>> 0]));
        const ptsBuf = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(ptsBuf, 0, pts);
        const out = device.createBuffer({ size: query.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readOut = device.createBuffer({ size: query.length * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const textures = this.tileManager.getArrayTextures();
        const groups = [
            device.createBindGroup({ layout: layouts[0], entries: groundFrame.resources(quadtree, textures.height._gpuTexture.view).map((resource, binding) => ({ binding, resource })) }),
            device.createBindGroup({ layout: layouts[1], entries: this.resources.map((resource, binding) => ({ binding, resource })) }),
            device.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: ptsBuf } }, { binding: 1, resource: { buffer: out } }] }),
        ];
        const e = device.createCommandEncoder();
        const pass = e.beginComputePass();
        pass.setPipeline(pipeline);
        groups.forEach((g, i) => pass.setBindGroup(i, g));
        pass.dispatchWorkgroups(Math.ceil(query.length / 64));
        pass.end();
        e.copyBufferToBuffer(out, 0, readOut, 0, query.length * 4);
        device.queue.submit([e.finish()]);
        await readOut.mapAsync(GPUMapMode.READ);
        const got = new Float32Array(readOut.getMappedRange().slice(0));
        readOut.destroy(); out.destroy(); ptsBuf.destroy();
        let worst = 0, unknown = 0;
        const misses = [];
        got.forEach((g, i) => {
            if (g === -1) { unknown++; return; }
            const err = Math.abs(g - expect[i]);
            worst = Math.max(worst, err);
            if (err > 0.05 && misses.length < 8) misses.push({ i, gpu: +g.toFixed(3), cpu: +expect[i].toFixed(3), face: query[i].face, p: query[i].p });
        });
        return { points: query.length, worst, unknown, misses, discs: cells.reduce((s, c) => s + c.count, 0), cells: cells.length, overflow: cells.reduce((s, c) => s + c.overflow, 0) };
    }

    destroy() {
        for (const b of [this.frame, this.table, this.headers, this.staging, this.records, this.jobs, this._debugParams]) b?.destroy();
        this._testFrame?.destroy();
        this.ready = false;
    }
}

