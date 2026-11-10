// core/world/terrain-generator/lakeTable.js
//
// The lake table of the 'lakeLand' base generator (LAKE_CELLS_PLAN.md, "The
// lake table"): records of the lake candidates near the tiles being
// generated, filled on the GPU before those tiles by three passes (base
// assessment; nested assessment reading larger lakes' records; the active
// flag) and read by every terrain pass that evaluates heights (group 3).
//
// Keys are (tier, lattice cell). For a tile, the cells within one cell of its
// footprint are its core keys (the heights look them up); the cells two more
// out are their dependencies (the nested and active passes read them). A
// record is complete once its dependencies were present when its nested and
// active passes ran; a record a tile needs is (re)completed before the tile.
// Bounded: a fixed number of records, the least recently used reused.

import { LAKE_CELL_TIERS, LAKE_LOD_TEXELS, LAKE_RECORD_VEC4, LAKE_TABLE_GROUP, lakeTableHash } from '../../../templates/terrain-shaders/features/featureLakeCells.wgsl.js';
import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { faceUVToDir } from '../hydrology/waterGraph.js';

const PROBE_SRC = `
@group(2) @binding(0) var<storage, read> probeDirs: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> probeOut: array<f32>;
@compute @workgroup_size(64) fn lakeProbeHeights(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= arrayLength(&probeDirs)) { return; }
    probeOut[gid.x] = calculateTerrainHeightD(uniforms.seed, normalize(probeDirs[gid.x].xyz)).x * maxTerrainHeightM();
}
// Height, and the level and tier of the lake whose containment area holds
// the point (-1e9 and -1 where none): water lies there below the level.
@compute @workgroup_size(64) fn lakeProbeWater(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= arrayLength(&probeDirs)) { return; }
    let d = normalize(probeDirs[gid.x].xyz);
    let q = lakeCellQuery(uniforms.seed, d);
    probeOut[gid.x * 3u] = calculateTerrainHeightD(uniforms.seed, d).x * maxTerrainHeightM();
    probeOut[gid.x * 3u + 1u] = q.y;
    probeOut[gid.x * 3u + 2u] = q.w;
}`;

const BUILD_SRC = `
@group(2) @binding(0) var<uniform> lakePass: vec4<u32>;
@group(2) @binding(1) var<storage, read> lakeWork: array<u32>;
@compute @workgroup_size(64) fn lakeBuildBasePass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= lakePass.x) { return; } lakeBuildBase(lakeWork[gid.x], uniforms.seed); }
@compute @workgroup_size(64) fn lakeBuildNestedPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= lakePass.x) { return; } lakeBuildNested(lakeWork[gid.x], uniforms.seed); }
@compute @workgroup_size(64) fn lakeBuildActivePass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= lakePass.x) { return; } lakeBuildActive(lakeWork[gid.x], uniforms.seed); }`;


// Ensure calls whose records eviction keeps (tiles in flight).
const EVICT_KEEP_CALLS = 512;

export class LakeTable {
    constructor(gen, { records = 32768, batch = 1024 } = {}) {
        this.gen = gen;
        this.device = gen.device;
        this.R = gen.worldScale;
        this.capacity = records;
        this.batch = batch;
        let cap = 1024; while (cap < 2 * records) cap *= 2;
        this.slots = cap;
        this.entries = new Uint32Array(cap * 4);
        this.keys = new Int32Array(records * 4);
        this.index = new Map();          // key string -> { rec, used, complete }
        this.free = Array.from({ length: records }, (_, i) => records - 1 - i);
        this.frame = 0;
        this.stats = { builds: 0, records: 0, evicted: 0, evictedRecent: 0, lastMs: 0, lastNew: 0 };
        const S = GPUShaderStage.COMPUTE, d = this.device;
        this.entryBuffer = d.createBuffer({ label: 'LakeTable-entries', size: this.entries.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.recordBuffer = d.createBuffer({ label: 'LakeTable-records', size: records * LAKE_RECORD_VEC4 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        this.keyBuffer = d.createBuffer({ label: 'LakeTable-keys', size: this.keys.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.readLayout = d.createBindGroupLayout({ label: 'LakeTable-read', entries: [
            { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } }] });
        this.readBindGroup = d.createBindGroup({ label: 'LakeTable-read', layout: this.readLayout, entries: [
            { binding: 0, resource: { buffer: this.entryBuffer } }, { binding: 1, resource: { buffer: this.recordBuffer } }] });
        this.emptyLayout = d.createBindGroupLayout({ label: 'LakeTable-empty', entries: [] });
        this.emptyBindGroup = d.createBindGroup({ layout: this.emptyLayout, entries: [] });
        d.queue.writeBuffer(this.entryBuffer, 0, this.entries);
    }

    // share: another table whose layouts and pipelines this one uses (same
    // shaders; layouts with identical entries are interchangeable), with its
    // own records. River planning keeps its own table so that it never
    // evicts records that terrain tiles are about to read.
    async initialize({ share = null } = {}) {
        const d = this.device, S = GPUShaderStage.COMPUTE;
        if (share) {
            for (const k of ['g0', 'gPass', 'gBuild', 'gProbe', 'pipelines', 'probePipeline', 'waterProbePipeline']) this[k] = share[k];
            this._ownBuffers();
            return;
        }
        this.g0 = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: S, buffer: { type: 'uniform' } }] });
        this.gPass = d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S, buffer: { type: 'uniform' } }, { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } }] });
        this.gBuild = d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: S, buffer: { type: 'storage' } },
            { binding: 2, visibility: S, buffer: { type: 'read-only-storage' } }] });
        this._ownBuffers();
        const opts = { ...this.gen._getAdvancedTerrainShaderOptions({ outputFormat: 'rgba32float', lakeTable: 'build' }), lakeTable: 'build' };
        const module = d.createShaderModule({ label: 'LakeTable-build', code: createAdvancedTerrainComputeShader(opts) + BUILD_SRC });
        const layout = d.createPipelineLayout({ bindGroupLayouts: [this.g0, this.gen.biomeBindGroupLayout, this.gPass, this.gBuild] });
        this.pipelines = {};
        for (const e of ['lakeBuildBasePass', 'lakeBuildNestedPass', 'lakeBuildActivePass']) {
            this.pipelines[e] = await d.createComputePipelineAsync({ label: e, layout, compute: { module, entryPoint: e } });
        }
        // Heights of the lake terrain at given directions (river planning).
        this.gProbe = d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: S, buffer: { type: 'storage' } }] });
        const readOpts = { ...this.gen._getAdvancedTerrainShaderOptions({ outputFormat: 'rgba32float' }), lakeTable: 'read' };
        const probeModule = d.createShaderModule({ label: 'LakeTable-probe', code: createAdvancedTerrainComputeShader(readOpts) + PROBE_SRC });
        const probeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.g0, this.gen.biomeBindGroupLayout, this.gProbe, this.readLayout] });
        this.probePipeline = await d.createComputePipelineAsync({ label: 'LakeTable-probe', layout: probeLayout,
            compute: { module: probeModule, entryPoint: 'lakeProbeHeights' } });
        this.waterProbePipeline = await d.createComputePipelineAsync({ label: 'LakeTable-probe-water', layout: probeLayout,
            compute: { module: probeModule, entryPoint: 'lakeProbeWater' } });
    }

    _ownBuffers() {
        const d = this.device;
        this.uniformBuffer = d.createBuffer({ size: 4096, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.buildBindGroup = d.createBindGroup({ layout: this.gBuild, entries: [
            { binding: 0, resource: { buffer: this.entryBuffer } }, { binding: 1, resource: { buffer: this.recordBuffer } },
            { binding: 2, resource: { buffer: this.keyBuffer } }] });
        this._groupsByPipeline = new WeakMap();
    }

    // The table's read bind group for a pipeline with an automatic layout.
    bindGroupFor(pipeline) {
        let g = this._groupsByPipeline?.get(pipeline);
        if (!g) {
            g = this.device.createBindGroup({ label: 'LakeTable-read-auto', layout: pipeline.getBindGroupLayout(LAKE_TABLE_GROUP), entries: [
                { binding: 0, resource: { buffer: this.entryBuffer } }, { binding: 1, resource: { buffer: this.recordBuffer } }] });
            this._groupsByPipeline?.set(pipeline, g);
        }
        return g;
    }

    // ensure() for an area (every tier): a circle around unit dir.
    ensureArea(dir, radiusM) {
        return this.ensure([{ dir: Array.from(dir), radiusM, texelM: 0 }]);
    }

    // Heights (m) of the lake terrain at unit directions (Float32Array, 4 per
    // direction); the table must cover them (ensureArea).
    async sampleHeights(dirs) {
        return this._probe(this.probePipeline, dirs, 1);
    }

    // Heights, and per direction the level and tier of the lake whose
    // containment area holds it (-1e9, -1: none), 3 floats each; the table
    // must cover them (ensure).
    async sampleWater(dirs) {
        return this._probe(this.waterProbePipeline, dirs, 3);
    }

    async _probe(pipeline, dirs, per) {
        const d = this.device, n = dirs.length / 4, bytes = n * per * 4;
        const v = this.gen._fillTerrainUniformScratch(0, 0, 128, 1 << 20, 0);
        d.queue.writeBuffer(this.uniformBuffer, 0, v.buffer, v.byteOffset, v.byteLength);
        const inBuf = d.createBuffer({ size: Math.max(16, dirs.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(inBuf, 0, dirs);
        const outBuf = d.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const rb = d.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = d.createCommandEncoder({ label: 'LakeTable-probe' });
        const p = enc.beginComputePass();
        p.setPipeline(pipeline);
        p.setBindGroup(0, d.createBindGroup({ layout: this.g0, entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] }));
        this.gen._setTerrainBiomeBindGroup(p, { regional: false, lakes: false });
        p.setBindGroup(2, d.createBindGroup({ layout: this.gProbe, entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }));
        p.setBindGroup(LAKE_TABLE_GROUP, this.readBindGroup);
        p.dispatchWorkgroups(Math.ceil(n / 64));
        p.end();
        enc.copyBufferToBuffer(outBuf, 0, rb, 0, Math.max(4, bytes));
        d.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(rb.getMappedRange().slice(0, bytes));
        rb.unmap(); inBuf.destroy(); outBuf.destroy(); rb.destroy();
        return out;
    }

    // Tiers a tile at depth `depth` of a face grid shows (their lakes are at
    // least LAKE_LOD_TEXELS texels long): the same rule as the shader.
    static tierVisible(tier, texelM) {
        return LAKE_CELL_TIERS[tier].lenMax >= LAKE_LOD_TEXELS * texelM;
    }

    // Lattice cells (per visible tier) a tile reads, as core keys, and their
    // dependencies. tiles: [{ dir: [x, y, z] unit centre, radiusM, texelM }].
    _keysFor(tiles) {
        const core = new Map(), deps = new Map();
        LAKE_CELL_TIERS.forEach((t, tier) => {
            const S = t.cellM;
            for (const tile of tiles) {
                if (!LakeTable.tierVisible(tier, tile.texelM)) continue;
                const c = tile.dir.map(v => v * this.R / S);
                const reach = Math.ceil(tile.radiusM / S);
                for (let dz = -reach - 3; dz <= reach + 3; dz++) for (let dy = -reach - 3; dy <= reach + 3; dy++) for (let dx = -reach - 3; dx <= reach + 3; dx++) {
                    const x = Math.floor(c[0]) + dx, y = Math.floor(c[1]) + dy, z = Math.floor(c[2]) + dz;
                    if (Math.abs(Math.hypot(x + 0.5, y + 0.5, z + 0.5) * S - this.R) > S) continue;
                    const isCore = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= reach + 1;
                    const k = `${tier}:${x},${y},${z}`;
                    if (isCore) core.set(k, [x, y, z, tier]);
                    else if (!core.has(k)) deps.set(k, [x, y, z, tier]);
                }
            }
        });
        for (const k of core.keys()) deps.delete(k);
        return { core, deps };
    }

    _insert(key, [x, y, z, tier]) {
        if (!this.free.length) this._evict();
        const rec = this.free.pop();
        this.keys.set([x, y, z, tier], rec * 4);
        const e = { rec, used: this.frame, complete: false, cell: [x, y, z, tier] };
        this.index.set(key, e);
        this._dirtyEntries = true;
        return e;
    }

    _evict() {
        // Reuse the least recently used quarter of the table, never records
        // asked for in the last EVICT_KEEP_CALLS ensure calls: tiles asked for
        // then may not be generated yet, and without their records they lose
        // their lakes (a height step along their borders). Only when nothing
        // older is left, the oldest anyway (counted: evictedRecent).
        const all = [...this.index.entries()].sort((a, b) => a[1].used - b[1].used);
        const old = all.filter(([, e]) => e.used < this.frame - EVICT_KEEP_CALLS);
        const take = (old.length ? old : all).slice(0, Math.max(1, all.length >> 2));
        if (!old.length) { this.stats.evictedRecent += take.length; console.warn(`[LakeTable] full of recent records: ${take.length} evicted that tiles may still read`); }
        for (const [k, e] of take) {
            this.index.delete(k); this.free.push(e.rec); this.stats.evicted++;
        }
        this._dirtyEntries = true;
    }

    _rebuildEntries() {
        this.entries.fill(0);
        for (const e of this.index.values()) {
            const [x, y, z, tier] = e.cell;
            let slot = lakeTableHash(tier, x, y, z, this.slots);
            while (this.entries[slot * 4 + 3] !== 0) slot = (slot + 1) & (this.slots - 1);
            this.entries.set([x >>> 0, y >>> 0, z >>> 0, ((tier + 1) | (e.rec << 3)) >>> 0], slot * 4);
        }
        this.device.queue.writeBuffer(this.entryBuffer, 0, this.entries);
        this._dirtyEntries = false;
    }

    // Makes the records the tiles read complete, before those tiles are
    // generated (submitted ahead of them on the same queue).
    ensure(tiles) {
        if (!this.pipelines) return false;
        this.frame++;
        const t0 = performance.now();
        const { core, deps } = this._keysFor(tiles);
        const fresh = [], redo = [];
        for (const [k, cell] of [...core, ...deps]) {
            let e = this.index.get(k);
            if (!e) { e = this._insert(k, cell); fresh.push(e.rec); }
            e.used = this.frame;
        }
        for (const k of core.keys()) {
            const e = this.index.get(k);
            if (!e.complete) { redo.push(e.rec); e.complete = true; }
        }
        if (!fresh.length && !redo.length) return true;
        if (this._dirtyEntries) this._rebuildEntries();
        this.device.queue.writeBuffer(this.keyBuffer, 0, this.keys);
        const v = this.gen._fillTerrainUniformScratch(0, 0, 128, 1 << 20, 0);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, v.buffer, v.byteOffset, v.byteLength);
        const bg0 = this.device.createBindGroup({ layout: this.g0, entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });
        const enc = this.device.createCommandEncoder({ label: 'LakeTable-build' });
        for (const [pass, list] of [['lakeBuildBasePass', fresh], ['lakeBuildNestedPass', redo], ['lakeBuildActivePass', redo]]) {
            for (let s = 0; s < list.length; s += this.batch) {
                const part = new Uint32Array(list.slice(s, s + this.batch));
                const work = this.device.createBuffer({ size: Math.max(16, part.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                this.device.queue.writeBuffer(work, 0, part);
                const info = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                this.device.queue.writeBuffer(info, 0, new Uint32Array([part.length, 0, 0, 0]));
                const p = enc.beginComputePass({ label: pass });
                p.setPipeline(this.pipelines[pass]);
                p.setBindGroup(0, bg0);
                this.gen._setTerrainBiomeBindGroup(p, { regional: false, lakes: false });
                p.setBindGroup(2, this.device.createBindGroup({ layout: this.gPass, entries: [
                    { binding: 0, resource: { buffer: info } }, { binding: 1, resource: { buffer: work } }] }));
                p.setBindGroup(LAKE_TABLE_GROUP, this.buildBindGroup);
                p.dispatchWorkgroups(Math.ceil(part.length / 64));
                p.end();
            }
        }
        this.device.queue.submit([enc.finish()]);
        this.stats.builds++;
        this.stats.records = this.index.size;
        this.stats.lastNew = fresh.length;
        this.stats.lastMs = performance.now() - t0;
        return true;
    }

    // ensure() for one quadtree tile (TileAddress): its centre, the angle to
    // its farthest corner, and its texel size by the shader's rule (taken a
    // little smaller, so the keys never miss a tier the shader shows).
    ensureTile(addr, texels = 128) {
        const gs = 1 << addr.depth, u = (addr.x + 0.5) / gs, v = (addr.y + 0.5) / gs;
        const dir = faceUVToDir(addr.face, u, v);
        let maxAngle = 0;
        for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const d = faceUVToDir(addr.face, (addr.x + cu) / gs, (addr.y + cv) / gs);
            maxAngle = Math.max(maxAngle, Math.acos(Math.min(1, d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2])));
        }
        const texelM = 0.75 * (Math.PI / 2) * this.R / gs / texels;
        return this.ensure([{ dir: Array.from(dir), radiusM: maxAngle * this.R, texelM }]);
    }

    // The active lakes in the table, read back (for the water renderer):
    // [{ key, tier, centre, a1, a2, level, depth, uC, shape: { n, comp, rot, ks,
    // extent } }]. Resolves null while an earlier read is pending.
    async readLakes() {
        if (this._reading) return null;
        let top = -1;
        for (const e of this.index.values()) top = Math.max(top, e.rec);
        if (top < 0) return [];
        this._reading = true;
        try {
            const bytes = (top + 1) * LAKE_RECORD_VEC4 * 16;
            const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = this.device.createCommandEncoder({ label: 'LakeTable-read' });
            enc.copyBufferToBuffer(this.recordBuffer, 0, staging, 0, bytes);
            this.device.queue.submit([enc.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const f = new Float32Array(staging.getMappedRange().slice(0));
            staging.unmap(); staging.destroy();
            const lakes = [];
            for (const [key, e] of this.index) {
                if (!e.complete) continue;
                const b = e.rec * LAKE_RECORD_VEC4 * 4, flags = f[b + 6];
                if (!((flags & 8) && (flags & 4))) continue;
                const a = b + 17 * 4, v = k => f.subarray(a + k * 4, a + k * 4 + 4);
                lakes.push({ key, tier: e.cell[3], centre: Array.from(f.subarray(b, b + 3)),
                    level: v(0)[2], depth: v(0)[3], uC: v(1)[3], a1: Array.from(v(4).subarray(0, 3)), a2: Array.from(v(5).subarray(0, 3)),
                    shape: { n: v(4)[3], extent: v(5)[3], minAxis: v(6)[0], ks: v(6)[1], stretch: v(6)[2], rot: [...v(7), v(8)[0], v(8)[1]],
                        comp: [9, 10, 11, 12, 13, 14].map(k => Array.from(v(k))) } });
            }
            return lakes;
        } finally { this._reading = false; }
    }

    destroy() {
        this.entryBuffer.destroy(); this.recordBuffer.destroy(); this.keyBuffer.destroy(); this.uniformBuffer?.destroy();
    }
}
