import { Logger } from '../../../shared/Logger.js';
import { GROUND_PROP_BAKE_CONFIG } from './streamerConfig.js';
import { ASSET_BAKE_REPRESENTATION } from './baking/AssetBakePolicy.js';

const ACTIVE_PROP_FLAG = 1;
const LAYER_META_U32_STRIDE = 8;

function clampInt(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, Math.floor(value)));
}

export class GroundPropCache {
    constructor(device, opts = {}) {
        this.device = device;
        this._logTag = '[GroundPropCache]';
        this._assetRegistry = opts.assetRegistry || null;
        this._tilePoolSize = Math.max(1, opts.tilePoolSize | 0);
        this._fieldArchetypeIndices = new Set(opts.fieldArchetypeIndices || []);

        const cfg = { ...GROUND_PROP_BAKE_CONFIG, ...(opts.propConfig || {}) };
        this._cfg = {
            enabled: cfg.enabled !== false,
            perLayerCapacity: clampInt(cfg.perLayerCapacity ?? 1024, 32, 16384),
            maxBakesPerFrame: clampInt(cfg.maxBakesPerFrame ?? 8, 1, 64),
            maxScatterTileWorldSize: clampInt(cfg.maxScatterTileWorldSize ?? 32, 8, 256),
            scatterCellOversample: clampInt(cfg.scatterCellOversample ?? 1, 1, 8),
            logDispatches: cfg.logDispatches !== false,
        };

        this._queue = [];
        this._queuedLayers = new Set();
        this._records = new Array(this._tilePoolSize).fill(null);
        this._activeLayersCPU = new Uint32Array(this._tilePoolSize);
        this._activeLayerCount = 0;
        this._layerMetaCPU = new Uint32Array(this._tilePoolSize * LAYER_META_U32_STRIDE);
        this._instanceCounterZeros = new Uint32Array(this._tilePoolSize);

        this._instanceBuffer = null;
        this._counterBuffer = null;
        this._layerMetaBuffer = null;
        this._activeLayerBuffer = null;
        this._initialized = false;
    }

    get enabled() { return this._cfg.enabled; }
    get perLayerCapacity() { return this._cfg.perLayerCapacity; }
    get maxBakesPerFrame() { return this._cfg.maxBakesPerFrame; }
    get pendingBakes() { return this._queue.length; }
    get activeLayerCount() { return this._activeLayerCount; }
    get instanceBuffer() { return this._instanceBuffer; }
    get counterBuffer() { return this._counterBuffer; }
    get layerMetaBuffer() { return this._layerMetaBuffer; }
    get activeLayerBuffer() { return this._activeLayerBuffer; }
    get maxScatterTileWorldSize() { return this._cfg.maxScatterTileWorldSize; }
    get scatterCellOversample() { return this._cfg.scatterCellOversample; }

    initialize(tileCache) {
        if (this._initialized || !this._cfg.enabled) return;
        if (!this._assetRegistry) {
            Logger.warn(`${this._logTag} missing assetRegistry; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._instanceBuffer = this.device.createBuffer({
            label: 'GroundPropCache-Instances',
            size: Math.max(256, this._tilePoolSize * this._cfg.perLayerCapacity * 64),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._counterBuffer = this.device.createBuffer({
            label: 'GroundPropCache-Counts',
            size: Math.max(256, this._tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this._layerMetaBuffer = this.device.createBuffer({
            label: 'GroundPropCache-LayerMeta',
            size: Math.max(256, this._layerMetaCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._activeLayerBuffer = this.device.createBuffer({
            label: 'GroundPropCache-ActiveLayers',
            size: Math.max(256, this._activeLayersCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(this._counterBuffer, 0, this._instanceCounterZeros);
        this.device.queue.writeBuffer(this._layerMetaBuffer, 0, this._layerMetaCPU);
        this.device.queue.writeBuffer(this._activeLayerBuffer, 0, this._activeLayersCPU);

        this._initialized = true;
        this.syncFromTileCache(tileCache, true);

        const memMB = (this._tilePoolSize * this._cfg.perLayerCapacity * 64) / (1024 * 1024);
        Logger.info(
            `${this._logTag} ready — cap=${this._cfg.perLayerCapacity}/layer ` +
            `layers=${this._tilePoolSize} mem=${memMB.toFixed(2)}MB`
        );
    }

    dispose() {
        this._instanceBuffer?.destroy();
        this._counterBuffer?.destroy();
        this._layerMetaBuffer?.destroy();
        this._activeLayerBuffer?.destroy();
        this._instanceBuffer = null;
        this._counterBuffer = null;
        this._layerMetaBuffer = null;
        this._activeLayerBuffer = null;
        this._initialized = false;
    }

    syncFromTileCache(tileCache, enqueueAll = false) {
        if (!this._initialized) return;
        this._rebuildState(tileCache, enqueueAll);
    }

    applyCommitBatch(tileCache) {
        if (!this._initialized) return;
        this._rebuildState(tileCache, false);
    }

    popBakeBatch(limit = this._cfg.maxBakesPerFrame) {
        if (!this._initialized || this._queue.length === 0) return [];
        const count = Math.max(1, Math.min(limit | 0, this._queue.length));
        const batch = this._queue.splice(0, count);
        for (const item of batch) {
            this._queuedLayers.delete(item.layer);
        }
        return batch;
    }

    _rebuildState(tileCache, enqueueAll) {
        const nextMeta = new Uint32Array(this._tilePoolSize * LAYER_META_U32_STRIDE);
        const nextActiveLayers = new Uint32Array(this._tilePoolSize);
        const nextRecords = new Array(this._tilePoolSize).fill(null);
        const entries = tileCache?.getEntries?.() ?? [];
        const layersToClear = [];
        let activeCount = 0;

        for (const entry of entries) {
            if (!entry) continue;
            const layer = entry.layer >>> 0;
            if (layer >= this._tilePoolSize) continue;

            const record = this._buildRecord(entry);
            nextRecords[layer] = record;

            if (record?.active) {
                const base = layer * LAYER_META_U32_STRIDE;
                nextMeta[base + 0] = record.face >>> 0;
                nextMeta[base + 1] = record.depth >>> 0;
                nextMeta[base + 2] = record.tileX >>> 0;
                nextMeta[base + 3] = record.tileY >>> 0;
                nextMeta[base + 4] = record.flags >>> 0;
                nextActiveLayers[activeCount++] = layer;
            }
        }

        for (let layer = 0; layer < this._tilePoolSize; layer++) {
            const prev = this._records[layer];
            const next = nextRecords[layer];
            if (enqueueAll) {
                if (next?.active) {
                    this._enqueue(next);
                } else if (prev?.active) {
                    layersToClear.push(layer);
                    this._enqueue({ face: 0, depth: 0, tileX: 0, tileY: 0, layer, flags: 0 });
                }
                continue;
            }

            if (!this._recordsEqual(prev, next)) {
                if (next?.active) {
                    this._enqueue(next);
                } else if (prev?.active) {
                    layersToClear.push(layer);
                    this._enqueue({ face: 0, depth: 0, tileX: 0, tileY: 0, layer, flags: 0 });
                }
            }
        }

        this._records = nextRecords;
        this._layerMetaCPU = nextMeta;
        this._activeLayersCPU = nextActiveLayers;
        this._activeLayerCount = activeCount;

        this.device.queue.writeBuffer(this._layerMetaBuffer, 0, this._layerMetaCPU);
        this.device.queue.writeBuffer(this._activeLayerBuffer, 0, this._activeLayersCPU);
        if (layersToClear.length > 0) {
            const zero = new Uint32Array([0]);
            for (const layer of layersToClear) {
                this.device.queue.writeBuffer(
                    this._counterBuffer,
                    layer * Uint32Array.BYTES_PER_ELEMENT,
                    zero
                );
            }
        }
    }

    _buildRecord(entry) {
        if (!entry) return null;
        if (!this._entryHasBakeableProps(entry)) {
            return null;
        }
        return {
            face: entry.face >>> 0,
            depth: entry.depth >>> 0,
            tileX: entry.x >>> 0,
            tileY: entry.y >>> 0,
            layer: entry.layer >>> 0,
            flags: ACTIVE_PROP_FLAG,
            active: true,
        };
    }

    _entryHasBakeableProps(entry) {
        const reps = entry.archetypeRepresentations || [];
        for (let archetypeIndex = 0; archetypeIndex < reps.length; archetypeIndex++) {
            if (archetypeIndex === 0) continue;
            if (
                reps[archetypeIndex] !== ASSET_BAKE_REPRESENTATION.INSTANCES &&
                reps[archetypeIndex] !== ASSET_BAKE_REPRESENTATION.FIELD &&
                reps[archetypeIndex] !== ASSET_BAKE_REPRESENTATION.CLUSTER
            ) {
                continue;
            }
            const archetype = this._assetRegistry.getArchetypeByIndex?.(archetypeIndex);
            if (!archetype?.isActive) continue;
            return true;
        }
        return false;
    }

    _recordsEqual(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        return (
            a.face === b.face &&
            a.depth === b.depth &&
            a.tileX === b.tileX &&
            a.tileY === b.tileY &&
            a.layer === b.layer &&
            a.flags === b.flags
        );
    }

    _enqueue(item) {
        if (!item) return;
        const layer = item.layer >>> 0;
        if (layer >= this._tilePoolSize) return;
        if (this._queuedLayers.has(layer)) {
            for (let i = this._queue.length - 1; i >= 0; i--) {
                if ((this._queue[i].layer >>> 0) === layer) {
                    this._queue.splice(i, 1);
                    break;
                }
            }
        }
        this._queue.push({
            face: item.face >>> 0,
            depth: item.depth >>> 0,
            tileX: item.tileX >>> 0,
            tileY: item.tileY >>> 0,
            layer,
            flags: item.flags >>> 0,
        });
        this._queuedLayers.add(layer);
    }
}
