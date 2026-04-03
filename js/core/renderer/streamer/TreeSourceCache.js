import { Logger } from '../../../shared/Logger.js';
import { TREE_SOURCE_BAKE_CONFIG } from './streamerConfig.js';
import { ASSET_BAKE_REPRESENTATION } from './baking/AssetBakePolicy.js';

const ACTIVE_TREE_FLAG = 1;
const LAYER_META_U32_STRIDE = 8;

function clampInt(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, Math.floor(value)));
}

export class TreeSourceCache {
    constructor(device, opts = {}) {
        this.device = device;
        this._logTag = '[TreeSourceCache]';
        this._assetRegistry = opts.assetRegistry || null;
        this._tilePoolSize = Math.max(1, opts.tilePoolSize | 0);

        const cfg = { ...TREE_SOURCE_BAKE_CONFIG, ...(opts.treeConfig || {}) };
        this._cfg = {
            enabled: cfg.enabled !== false,
            perLayerCapacity: clampInt(cfg.perLayerCapacity ?? 1024, 32, 8192),
            maxBakesPerFrame: clampInt(cfg.maxBakesPerFrame ?? 8, 1, 64),
            selectionHoldFrames: clampInt(cfg.selectionHoldFrames ?? 12, 0, 120),
            logDispatches: cfg.logDispatches !== false,
        };

        this._queue = [];
        this._queuedLayers = new Set();
        this._records = new Array(this._tilePoolSize).fill(null);
        this._allActiveLayersCPU = new Uint32Array(this._tilePoolSize);
        this._allActiveLayerCount = 0;
        this._activeLayersCPU = new Uint32Array(this._tilePoolSize);
        this._activeLayerCount = 0;
        this._layerMetaCPU = new Uint32Array(this._tilePoolSize * LAYER_META_U32_STRIDE);
        this._layerVersions = new Uint32Array(this._tilePoolSize);
        this._layerReadyVersions = new Uint32Array(this._tilePoolSize);
        this._layerRetainUntil = new Uint32Array(this._tilePoolSize);
        this._layerBakePriority = new Int8Array(this._tilePoolSize);
        this._layerBakePriorityFrame = new Uint32Array(this._tilePoolSize);
        this._instanceCounterZeros = new Uint32Array(this._tilePoolSize);
        this._visibleOwnerRefreshCount = 0;
        this._selectionFrame = 0;
        this._lastSelectionLog = '';

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
    get totalActiveLayerCount() { return this._allActiveLayerCount; }
    get instanceBuffer() { return this._instanceBuffer; }
    get counterBuffer() { return this._counterBuffer; }
    get layerMetaBuffer() { return this._layerMetaBuffer; }
    get activeLayerBuffer() { return this._activeLayerBuffer; }

    initialize(tileCache) {
        if (this._initialized || !this._cfg.enabled) return;
        if (!this._assetRegistry) {
            Logger.warn(`${this._logTag} missing assetRegistry; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._instanceBuffer = this.device.createBuffer({
            label: 'TreeSourceCache-Instances',
            size: Math.max(256, this._tilePoolSize * this._cfg.perLayerCapacity * 64),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._counterBuffer = this.device.createBuffer({
            label: 'TreeSourceCache-Counts',
            size: Math.max(256, this._tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this._layerMetaBuffer = this.device.createBuffer({
            label: 'TreeSourceCache-LayerMeta',
            size: Math.max(256, this._layerMetaCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._activeLayerBuffer = this.device.createBuffer({
            label: 'TreeSourceCache-ActiveLayers',
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
        const ranked = this._queue.map((item, index) => ({
            item,
            index,
            priority: this._getQueuedBakePriority(item),
        }));
        ranked.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            if ((a.item.depth >>> 0) !== (b.item.depth >>> 0)) {
                return (b.item.depth >>> 0) - (a.item.depth >>> 0);
            }
            return a.index - b.index;
        });

        const batch = ranked.slice(0, count).map(entry => entry.item);
        const selectedLayers = new Set(batch.map(item => item.layer >>> 0));
        this._queue = this._queue.filter(item => !selectedLayers.has(item.layer >>> 0));
        for (const item of batch) {
            this._queuedLayers.delete(item.layer);
        }
        return batch;
    }

    markBakeBatchSubmitted(batch) {
        if (!Array.isArray(batch) || batch.length === 0) return;
        for (const item of batch) {
            if (!item) continue;
            const layer = item.layer >>> 0;
            if (layer >= this._tilePoolSize) continue;
            if ((item.flags & ACTIVE_TREE_FLAG) === 0) {
                if (!this._records[layer]?.active) {
                    this._layerReadyVersions[layer] = 0;
                }
                continue;
            }

            const version = item.version >>> 0;
            const record = this._records[layer];
            if (record?.active && (record.version >>> 0) === version) {
                this._layerReadyVersions[layer] = version;
            }
        }
    }

    refreshVisibleOwnerLayers(tileStreamer) {
        if (!this._initialized) return;
        this._selectionFrame++;

        const visibleTiles = tileStreamer?.getLastVisibleTiles?.()
            ?? tileStreamer?._lastVisibleTilesList
            ?? null;

        let selectedCount = 0;
        let exactReadyOwners = 0;
        let exactPendingOwners = 0;
        let fallbackReadyOwners = 0;
        let fallbackPendingOwners = 0;
        let retainedOwners = 0;
        let residentReadyFill = 0;
        let usedVisibleOwners = false;
        const nextLayers = new Uint32Array(this._tilePoolSize);
        const seenLayers = new Set();

        const tryPush = (layer, mode, extendRetention = true) => {
            if (!Number.isFinite(layer) || layer < 0 || layer >= this._tilePoolSize) return false;
            const record = this._records[layer] ?? null;
            if (!record?.active || !this._isLayerReady(layer) || seenLayers.has(layer)) return false;
            seenLayers.add(layer);
            nextLayers[selectedCount++] = layer >>> 0;
            if (extendRetention && this._cfg.selectionHoldFrames > 0) {
                this._layerRetainUntil[layer] = this._selectionFrame + this._cfg.selectionHoldFrames;
            }
            if (mode === 'exact') exactReadyOwners++;
            else if (mode === 'fallback') fallbackReadyOwners++;
            else if (mode === 'retained') retainedOwners++;
            return true;
        };

        if (Array.isArray(visibleTiles) && visibleTiles.length > 0 && typeof tileStreamer?.getLoadedLayer === 'function') {
            usedVisibleOwners = true;

            for (const tile of visibleTiles) {
                if (!tile) continue;

                const exactLayer = tileStreamer.getLoadedLayer(tile.face, tile.depth, tile.x, tile.y);
                if (this._isLayerActive(exactLayer)) {
                    if (tryPush(exactLayer, 'exact')) continue;
                    this._markLayerBakePriority(exactLayer, 3);
                    exactPendingOwners++;
                }

                let depth = tile.depth;
                let x = tile.x;
                let y = tile.y;
                while (depth > 0) {
                    depth--;
                    x >>= 1;
                    y >>= 1;
                    const fallbackLayer = tileStreamer.getLoadedLayer(tile.face, depth, x, y);
                    if (!this._isLayerActive(fallbackLayer)) continue;
                    if (tryPush(fallbackLayer, 'fallback')) break;
                    this._markLayerBakePriority(fallbackLayer, 2);
                    fallbackPendingOwners++;
                }
            }
        }

        if (selectedCount === 0) {
            usedVisibleOwners = false;
            selectedCount = this._appendReadyResidentLayers(nextLayers, selectedCount, seenLayers);
        }

        if (this._cfg.selectionHoldFrames > 0 && this._activeLayerCount > 0 && selectedCount < this._tilePoolSize) {
            const previousLayers = this._activeLayersCPU.subarray(0, this._activeLayerCount);
            for (let i = 0; i < previousLayers.length && selectedCount < this._tilePoolSize; i++) {
                const layer = previousLayers[i] >>> 0;
                if (this._layerRetainUntil[layer] < this._selectionFrame) continue;
                tryPush(layer, 'retained', false);
            }
        }

        const selectedBeforeResidentFill = selectedCount;
        selectedCount = this._appendReadyResidentLayers(nextLayers, selectedCount, seenLayers);
        residentReadyFill = selectedCount - selectedBeforeResidentFill;

        if (selectedCount > 1) {
            const sortedLayers = Array.from(nextLayers.subarray(0, selectedCount));
            sortedLayers.sort((a, b) => this._compareSelectedLayers(a, b));
            nextLayers.set(sortedLayers, 0);
        }

        const changed = (
            selectedCount !== this._activeLayerCount ||
            this._activeLayersCPU.subarray(0, selectedCount).some((layer, idx) => layer !== nextLayers[idx])
        );

        if (changed) {
            this._activeLayersCPU.fill(0);
            this._activeLayersCPU.set(nextLayers.subarray(0, selectedCount), 0);
            this._activeLayerCount = selectedCount;
            this.device.queue.writeBuffer(this._activeLayerBuffer, 0, this._activeLayersCPU);
        }

        this._visibleOwnerRefreshCount++;
        const mode = usedVisibleOwners ? 'stableResidentFromVisible' : 'stableResident';
        const logLine =
            `${mode} selected=${selectedCount}/${this._allActiveLayerCount} ` +
            `exactReady=${exactReadyOwners} exactPending=${exactPendingOwners} ` +
            `fallbackReady=${fallbackReadyOwners} fallbackPending=${fallbackPendingOwners} ` +
            `retained=${retainedOwners} residentFill=${residentReadyFill} ` +
            `pendingBakes=${this.pendingBakes}`;
        if (changed || this._visibleOwnerRefreshCount % 240 === 1) {
            if (logLine !== this._lastSelectionLog || this._visibleOwnerRefreshCount % 240 === 1) {
                Logger.info(`${this._logTag} ${logLine}`);
                this._lastSelectionLog = logLine;
            }
        }
    }

    _compareSelectedLayers(a, b) {
        const ra = this._records[a] || null;
        const rb = this._records[b] || null;

        if (!ra || !rb) return (a >>> 0) - (b >>> 0);
        if (ra.depth !== rb.depth) return (rb.depth >>> 0) - (ra.depth >>> 0);
        if (ra.face !== rb.face) return (ra.face >>> 0) - (rb.face >>> 0);
        if (ra.tileY !== rb.tileY) return (ra.tileY >>> 0) - (rb.tileY >>> 0);
        if (ra.tileX !== rb.tileX) return (ra.tileX >>> 0) - (rb.tileX >>> 0);
        return (a >>> 0) - (b >>> 0);
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
                    const version = this._nextLayerVersion(layer);
                    next.version = version;
                    this._layerVersions[layer] = version;
                    this._enqueue(next);
                } else if (prev?.active) {
                    layersToClear.push(layer);
                    this._layerRetainUntil[layer] = 0;
                    this._layerReadyVersions[layer] = 0;
                    this._dequeueLayer(layer);
                }
                continue;
            }

            if (next?.active && this._recordsEqual(prev, next) && Number.isFinite(prev?.version)) {
                const version = prev.version >>> 0;
                next.version = version;
                this._layerVersions[layer] = version;
                continue;
            }

            if (next?.active) {
                const version = this._nextLayerVersion(layer);
                next.version = version;
                this._layerVersions[layer] = version;
                this._enqueue(next);
                continue;
            }

            if (!this._recordsEqual(prev, next) && prev?.active) {
                this._layerRetainUntil[layer] = 0;
                this._layerReadyVersions[layer] = 0;
                layersToClear.push(layer);
                this._dequeueLayer(layer);
            }
        }

        this._records = nextRecords;
        this._layerMetaCPU = nextMeta;
        this._allActiveLayersCPU = nextActiveLayers;
        this._allActiveLayerCount = activeCount;

        const preservedActiveLayers = new Uint32Array(this._tilePoolSize);
        let preservedActiveCount = 0;
        const seenActiveLayers = new Set();
        for (let i = 0; i < this._activeLayerCount && preservedActiveCount < this._tilePoolSize; i++) {
            const layer = this._activeLayersCPU[i] >>> 0;
            if (!nextRecords[layer]?.active || seenActiveLayers.has(layer)) continue;
            seenActiveLayers.add(layer);
            preservedActiveLayers[preservedActiveCount++] = layer;
        }
        if (preservedActiveCount === 0 && this._visibleOwnerRefreshCount === 0) {
            preservedActiveLayers.set(nextActiveLayers.subarray(0, activeCount), 0);
            preservedActiveCount = activeCount;
        }

        this._activeLayersCPU.fill(0);
        this._activeLayersCPU.set(preservedActiveLayers.subarray(0, preservedActiveCount), 0);
        this._activeLayerCount = preservedActiveCount;

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
        if (!this._entryHasBakeableTrees(entry)) {
            return null;
        }
        return {
            face: entry.face >>> 0,
            depth: entry.depth >>> 0,
            tileX: entry.x >>> 0,
            tileY: entry.y >>> 0,
            layer: entry.layer >>> 0,
            flags: ACTIVE_TREE_FLAG,
            active: true,
        };
    }

    _entryHasBakeableTrees(entry) {
        if (!entry) return false;
        if (entry.treeRepresentation !== ASSET_BAKE_REPRESENTATION.RUNTIME_TREE) {
            return false;
        }
        const treeArchetype = this._assetRegistry.getArchetypeByIndex?.(0);
        return !!treeArchetype?.isActive;
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

    _isLayerActive(layer) {
        if (!Number.isFinite(layer) || layer < 0 || layer >= this._tilePoolSize) return false;
        return !!this._records[layer]?.active;
    }

    _isLayerReady(layer) {
        if (!this._isLayerActive(layer)) return false;
        const record = this._records[layer];
        const version = record?.version >>> 0;
        return version !== 0 && this._layerReadyVersions[layer] === version;
    }

    _appendReadyResidentLayers(target, startIndex, seenLayers) {
        let count = startIndex;
        for (let i = 0; i < this._allActiveLayerCount && count < this._tilePoolSize; i++) {
            const layer = this._allActiveLayersCPU[i] >>> 0;
            if (!this._isLayerReady(layer) || seenLayers.has(layer)) continue;
            seenLayers.add(layer);
            target[count++] = layer;
        }
        return count;
    }

    _nextLayerVersion(layer) {
        const next = ((this._layerVersions[layer] >>> 0) + 1) >>> 0;
        return next === 0 ? 1 : next;
    }

    _markLayerBakePriority(layer, priority) {
        if (!Number.isFinite(layer) || layer < 0 || layer >= this._tilePoolSize) return;
        const clamped = Math.max(0, Math.min(7, priority | 0));
        if (clamped === 0) return;
        this._layerBakePriority[layer] = Math.max(this._layerBakePriority[layer], clamped);
        this._layerBakePriorityFrame[layer] = this._selectionFrame;
    }

    _getQueuedBakePriority(item) {
        if (!item) return 0;
        const layer = item.layer >>> 0;
        if (layer >= this._tilePoolSize) return 0;
        if ((item.flags & ACTIVE_TREE_FLAG) === 0) return -1;
        if (this._layerBakePriorityFrame[layer] !== this._selectionFrame) return 0;
        return this._layerBakePriority[layer] | 0;
    }

    _enqueue(item) {
        if (!item) return;
        const layer = item.layer >>> 0;
        if (layer >= this._tilePoolSize) return;
        this._dequeueLayer(layer);
        this._queue.push({
            face: item.face >>> 0,
            depth: item.depth >>> 0,
            tileX: item.tileX >>> 0,
            tileY: item.tileY >>> 0,
            layer,
            flags: item.flags >>> 0,
            version: item.version >>> 0,
        });
        this._queuedLayers.add(layer);
    }

    _dequeueLayer(layer) {
        if (!Number.isFinite(layer) || layer < 0 || layer >= this._tilePoolSize) return;
        if (!this._queuedLayers.has(layer)) return;
        for (let i = this._queue.length - 1; i >= 0; i--) {
            if ((this._queue[i].layer >>> 0) === (layer >>> 0)) {
                this._queue.splice(i, 1);
                break;
            }
        }
        this._queuedLayers.delete(layer);
        this._layerBakePriority[layer] = 0;
        this._layerBakePriorityFrame[layer] = 0;
    }
}
