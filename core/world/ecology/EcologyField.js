// @ts-nocheck
// The ecology field (ECOLOGY_FOUNDATION_PLAN.md F3, F4): per terrain pool layer, habitat and realized forest at a few
// metres a texel, behind one accessor (ecologyField.wgsl.js). Storage, provisional: rgba8unorm (suitability, cover,
// crownLAI / 8, top / 64 m) and r32uint (stand | standHint << 16), resolution^2 per layer, no mips (2048 layers at 32^2:
// 16 MiB).
//
// Readiness. A layer's record names the tile it was made for (its key), a state (missing, pending, ready) and a version.
// Its field is made again whenever the pool's count of what is in the layer changes (TileArrayPool.layerVersions: a new
// tile, a refinement arriving, a regeneration), when its material (river and lake beds) completes, and when the realized
// source changes (the mock forest turned on or off; a forest producer). A layer that changes owner is missing at once,
// so a reader never takes another tile's field, or "not made", as this tile's empty forest.
//
// Producers. The habitat writer runs here. A forest producer (Codex) writes realized values into the same textures
// after it, for the layers it has made (setRealizedProducer), and raises version() so consumers rebuild.

import { Logger } from '../../../shared/Logger.js';
import { buildEcologyWriterWGSL } from './ecologyWriter.wgsl.js';
import { ECO_MISSING, ECO_PENDING, ECO_READY } from './ecologyField.wgsl.js';
import { ECO_TABLE_VEC4S, compileEcologyRegistry } from './ecologyRegistry.js';

export const ECOLOGY_DEFAULTS = Object.freeze({
    /** Texels per tile edge. */
    resolution: 32,
    /** Realized forest made from habitat and noise, for labs and tests; never on in the game by default. */
    mockForest: false,
    /** With the mock forest: one stand ("ecosystem/stand") wherever the landscape is vegetated, whatever the climate (labs). */
    mockStand: null,
    /** Layers made at most a frame. */
    maxJobsPerFrame: 96,
});

export class EcologyField {
    /** o: device, tileManager, planetConfig, biome (landscape rules), registry (the game's ecology.json), config. */
    constructor(o) {
        Object.assign(this, o);
        this.config = { ...ECOLOGY_DEFAULTS, ...(o.config ?? {}) };
        this.ready = false;
        this._epoch = 1;
        this._version = 0;
    }

    async initialize() {
        const { device } = this;
        const pool = this.tileManager.tileStreamer.arrayPool;
        this.capacity = pool.capacity;
        const res = this.config.resolution;
        const U = GPUTextureUsage, B = GPUBufferUsage;
        this.compiled = compileEcologyRegistry(this.registry ?? { ecosystems: [] }, { forestSpecies: this.forestSpecies ?? null });
        for (const e of this.compiled.errors) Logger.warn(`[Ecology] registry: ${e}`);
        this._texA = device.createTexture({ label: 'Ecology A', size: [res, res, this.capacity], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
        this._texB = device.createTexture({ label: 'Ecology B', size: [res, res, this.capacity], format: 'r32uint', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
        this.viewA = this._texA.createView({ dimension: '2d-array' });
        this.viewB = this._texB.createView({ dimension: '2d-array' });
        this._records = new Uint32Array(this.capacity * 4);
        this.layers = device.createBuffer({ label: 'Ecology layers', size: this._records.byteLength, usage: B.STORAGE | B.COPY_DST });
        device.queue.writeBuffer(this.layers, 0, this._records);
        this._ownerKey = new Array(this.capacity).fill(null);
        this._madeFrom = new Uint32Array(this.capacity);
        this._madeEpoch = new Uint32Array(this.capacity);
        this._madeBeds = new Uint8Array(this.capacity);
        this._owned = new Set();
        this._table = device.createBuffer({ label: 'Ecology registry', size: ECO_TABLE_VEC4S * 16, usage: B.STORAGE | B.COPY_DST });
        device.queue.writeBuffer(this._table, 0, this.compiled.table);
        this._frame = new Uint32Array(8);
        this._frameF = new Float32Array(this._frame.buffer);
        this._frameBuffer = device.createBuffer({ label: 'Ecology writer frame', size: 32, usage: B.UNIFORM | B.COPY_DST });
        this._jobs = device.createBuffer({ label: 'Ecology jobs', size: this.config.maxJobsPerFrame * 32, usage: B.STORAGE | B.COPY_DST });
        this._jobData = new Uint32Array(this.config.maxJobsPerFrame * 8);
        const module = device.createShaderModule({ label: 'Ecology writer', code: buildEcologyWriterWGSL({ biome: this.biome ?? null }) });
        const C = GPUShaderStage.COMPUTE;
        const at = (binding, rest) => ({ binding, visibility: C, ...rest });
        const array = sampleType => ({ texture: { sampleType, viewDimension: '2d-array' } });
        this._layouts = [
            device.createBindGroupLayout({ entries: [
                at(0, { buffer: { type: 'uniform' } }), at(1, { buffer: { type: 'read-only-storage' } }), at(2, { buffer: { type: 'read-only-storage' } }),
                at(3, { storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } }),
                at(4, { storageTexture: { access: 'write-only', format: 'r32uint', viewDimension: '2d-array' } }),
            ] }),
            device.createBindGroupLayout({ entries: [at(0, array('unfilterable-float')), at(1, array('float')), at(2, array('float')), at(3, array('float'))] }),
        ];
        this._pipeline = await device.createComputePipelineAsync({
            label: 'Ecology writer', layout: device.createPipelineLayout({ bindGroupLayouts: this._layouts }), compute: { module, entryPoint: 'main' },
        });
        this._group = device.createBindGroup({ layout: this._layouts[0], entries: [
            { binding: 0, resource: { buffer: this._frameBuffer } }, { binding: 1, resource: { buffer: this._jobs } },
            { binding: 2, resource: { buffer: this._table } }, { binding: 3, resource: this.viewA }, { binding: 4, resource: this.viewB },
        ] });
        this.ready = true;
    }

    /** Bind-group resources for buildEcologyReadWGSL, in its order: a, b, layers. */
    get resources() { return [this.viewA, this.viewB, { buffer: this.layers }]; }
    /** Raised whenever any layer's field changes: consumers that cache what they read of it rebuild on it. */
    version() { return this._version; }

    /** The mock forest on or off: every layer's realized values are made again. */
    set mockForest(on) {
        if (!!on === !!this.config.mockForest) return;
        this.config.mockForest = !!on;
        this._epoch++;
    }
    get mockForest() { return !!this.config.mockForest; }

    /** The mock forest's stand everywhere vegetated ("ecosystem/stand"), or null for the habitat's choice. */
    set mockStand(name) {
        if (name === this.config.mockStand) return;
        this.config.mockStand = name ?? null;
        this._epoch++;
    }
    get mockStand() { return this.config.mockStand; }
    _mockStandId() {
        if (!this.config.mockStand) return 0;
        const [eco, id] = String(this.config.mockStand).split('/');
        return this.compiled.stands.find(s => s.ecosystem === eco && s.id === id)?.numericId ?? 0;
    }

    _sourceGroup() {
        const textures = this.tileManager.getArrayTextures?.();
        const view = name => textures?.[name]?._gpuTexture?.view;
        const parts = [view('height'), view('normal'), view('climate') || view('normal'), view('splatIndex') || view('normal')];
        if (parts.some(p => !p)) return null;
        if (this._sourceOf && this._sourceOf.every((x, i) => x === parts[i])) return this._sourceBind;
        this._sourceOf = parts;
        this._sourceBind = this.device.createBindGroup({ layout: this._layouts[1], entries: parts.map((resource, binding) => ({ binding, resource })) });
        return this._sourceBind;
    }

    _setRecord(layer, keyLo, keyHi, state, madeFrom) {
        const r = this._records, o = layer * 4;
        const version = (r[o + 2] >>> 2) + 1;
        r[o] = keyLo; r[o + 1] = keyHi; r[o + 2] = ((version << 2) | state) >>> 0; r[o + 3] = madeFrom;
        this._dirty = true;
    }

    /** Once a frame, before the terrain and grass read the field: records synced, stale layers made again. */
    update(encoder) {
        if (!this.ready) return;
        const streamer = this.tileManager.tileStreamer;
        const pool = streamer?.arrayPool;
        if (!pool) return;
        // Layers that lost their tile, or went to another: missing at once.
        for (const layer of this._owned) {
            const key = streamer._layerToKey.get(layer);
            if (key === undefined || key !== this._ownerKey[layer]) {
                this._owned.delete(layer);
                this._ownerKey[layer] = null;
                this._setRecord(layer, 0, 0, ECO_MISSING, 0);
                this._version++;
            }
        }
        const pending = new Set(pool._pendingCopies?.map(e => e.layer) ?? []);
        const jobs = [];
        for (const [key, info] of streamer._tileInfo) {
            const layer = info.layer;
            const made = pool.getLayerVersion(layer);
            // Whether its material (river and lake beds) is made: the table's flag (looked up by key, as its slots move).
            const beds = streamer._preferCompleteMaterialLayers === false ? 1
                : (streamer.hashTable.getFlags(streamer.hashTable.findSlot(info.keyLo, info.keyHi)) & 1);
            const current = this._ownerKey[layer] === key && this._madeFrom[layer] === made && this._madeEpoch[layer] === this._epoch
                && this._madeBeds[layer] === beds;
            if (current) continue;
            if (this._ownerKey[layer] !== key) {
                this._ownerKey[layer] = key;
                this._owned.add(layer);
                this._setRecord(layer, info.keyLo, info.keyHi, ECO_PENDING, 0);
            }
            // Nothing copied into the layer yet, or a copy still on its way: wait.
            if (made === 0 || pending.has(layer)) continue;
            if (jobs.length < this.config.maxJobsPerFrame) jobs.push({ key, info, layer, made, beds });
        }
        const source = jobs.length ? this._sourceGroup() : null;
        if (jobs.length && source) {
            const d = this._jobData;
            jobs.forEach((j, i) => d.set([j.layer, j.info.face, j.info.depth, j.beds, j.info.x, j.info.y, 0, 0], i * 8));
            this.device.queue.writeBuffer(this._jobs, 0, d, 0, jobs.length * 8);
            this._frame.set([jobs.length, this.config.resolution, this.config.mockForest ? 1 : 0, this._mockStandId()], 0);
            this._frameF.set([this.planetConfig.radius, this.planetConfig.heightScale, 0, 0], 4);
            this.device.queue.writeBuffer(this._frameBuffer, 0, this._frame);
            const pass = encoder.beginComputePass({ label: 'Ecology habitat' });
            pass.setPipeline(this._pipeline);
            pass.setBindGroup(0, this._group);
            pass.setBindGroup(1, source);
            const groups = Math.ceil(this.config.resolution / 8);
            pass.dispatchWorkgroups(groups, groups, jobs.length);
            pass.end();
            // Ready once this frame's commands run: the readers are encoded after this pass.
            for (const j of jobs) {
                this._madeFrom[j.layer] = j.made;
                this._madeEpoch[j.layer] = this._epoch;
                this._madeBeds[j.layer] = j.beds;
                this._setRecord(j.layer, j.info.keyLo, j.info.keyHi, ECO_READY, j.made);
            }
            this._version++;
        }
        if (this._dirty) {
            this.device.queue.writeBuffer(this.layers, 0, this._records);
            this._dirty = false;
        }
    }

    /** Counts of layers by state, for diagnostics and tests. */
    stats() {
        const n = [0, 0, 0];
        for (let l = 0; l < this.capacity; l++) n[this._records[l * 4 + 2] & 3]++;
        return { missing: n[ECO_MISSING], pending: n[ECO_PENDING], ready: n[ECO_READY], version: this._version, epoch: this._epoch };
    }

    destroy() {
        for (const x of [this._texA, this._texB, this.layers, this._table, this._frameBuffer, this._jobs]) x?.destroy();
        this.ready = false;
    }
}
