import { Logger } from '../../../shared/Logger.js';
import { clampInt } from '../../../shared/math/index.js';
import { ASSET_BAKE_REPRESENTATION } from './baking/AssetBakePolicy.js';

const ACTIVE_FAR_TREE_FLAG = 1;
const LAYER_META_U32_STRIDE = 8;
const FAR_TREE_INSTANCE_STRIDE = 64; // same coarse stride as cluster instances

// ═══════════════════════════════════════════════════════════════════════════
// FAR TREE DBG — set FAR_TREE_DBG_ENABLED = true to activate all logging
// ═══════════════════════════════════════════════════════════════════════════
const FAR_TREE_DBG_ENABLED = false;
const FAR_DBG = {
    FRAME_INTERVAL: 120,
    ENTRY_DUMP_LIMIT: 8,
    REFRESH_TABLE_INTERVAL: 60,
    warn(msg)  { if (FAR_TREE_DBG_ENABLED) Logger.warn(`[TreeFarSystem] ${msg}`);  },
    info(msg)  { if (FAR_TREE_DBG_ENABLED) Logger.info(`[TreeFarSystem] ${msg}`);  },
};

export class FarTreeSourceCache {
    constructor(device, opts = {}) {
        this.device = device;
        this._logTag = '[FarTreeSourceCache]';
        this._assetRegistry = opts.assetRegistry || null;
        this._tilePoolSize = Math.max(1, opts.tilePoolSize | 0);

        const cfg = { ...(opts.farTreeConfig || {}) };
        this._cfg = {
            enabled: cfg.enabled !== false,
            perLayerCapacity: clampInt(cfg.perLayerCapacity ?? 80, 4, 512),
            maxBakesPerFrame: clampInt(cfg.maxBakesPerFrame ?? 8, 1, 64),
            selectionHoldFrames: clampInt(cfg.selectionHoldFrames ?? 12, 0, 120),
            logDispatches: cfg.logDispatches === true,
        };

        // ── DBG: constructor ────────────────────────────────────────────────
        FAR_DBG.warn(
            `FarTreeSourceCache CONSTRUCTED — enabled=${this._cfg.enabled} ` +
            `tilePoolSize=${this._tilePoolSize} perLayerCapacity=${this._cfg.perLayerCapacity} ` +
            `maxBakesPerFrame=${this._cfg.maxBakesPerFrame} selectionHoldFrames=${this._cfg.selectionHoldFrames} ` +
            `assetRegistry=${!!opts.assetRegistry} ` +
            `rawFarTreeConfig=${JSON.stringify(opts.farTreeConfig ?? null)}`
        );
        // ───────────────────────────────────────────────────────────────────

        this._queue = [];
        this._queuedLayers = new Set();
        this._records = new Array(this._tilePoolSize).fill(null);

        // All resident active coarse layers
        this._allActiveLayersCPU = new Uint32Array(this._tilePoolSize);
        this._allActiveLayerCount = 0;

        // Selected layers currently exposed to renderer/gather stage
        this._activeLayersCPU = new Uint32Array(this._tilePoolSize);
        this._activeLayerCount = 0;

        this._layerMetaCPU = new Uint32Array(this._tilePoolSize * LAYER_META_U32_STRIDE);

        // Ready/version lifecycle copied from TreeSourceCache pattern
        this._layerVersions = new Uint32Array(this._tilePoolSize);
        this._layerReadyVersions = new Uint32Array(this._tilePoolSize);
        this._layerRetainUntil = new Uint32Array(this._tilePoolSize);

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
        // ── DBG: initialize entry ───────────────────────────────────────────
        FAR_DBG.warn(
            `FarTreeSourceCache.initialize called — already=${this._initialized} ` +
            `enabled=${this._cfg.enabled} tileCacheProvided=${!!tileCache} ` +
            `tileCacheEntryCount=${tileCache?.getEntries?.()?.length ?? 'N/A'}`
        );
        // ───────────────────────────────────────────────────────────────────
        if (this._initialized || !this._cfg.enabled) return;
        if (!this._assetRegistry) {
            Logger.warn(`${this._logTag} missing assetRegistry; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._instanceBuffer = this.device.createBuffer({
            label: 'FarTreeSourceCache-Instances',
            size: Math.max(256, this._tilePoolSize * this._cfg.perLayerCapacity * FAR_TREE_INSTANCE_STRIDE),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._counterBuffer = this.device.createBuffer({
            label: 'FarTreeSourceCache-Counts',
            size: Math.max(256, this._tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._layerMetaBuffer = this.device.createBuffer({
            label: 'FarTreeSourceCache-LayerMeta',
            size: Math.max(256, this._layerMetaCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._activeLayerBuffer = this.device.createBuffer({
            label: 'FarTreeSourceCache-ActiveLayers',
            size: Math.max(256, this._activeLayersCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(this._counterBuffer, 0, this._instanceCounterZeros);
        this.device.queue.writeBuffer(this._layerMetaBuffer, 0, this._layerMetaCPU);
        this.device.queue.writeBuffer(this._activeLayerBuffer, 0, this._activeLayersCPU);

        this._initialized = true;
        this.syncFromTileCache(tileCache, true);

        const memMB =
            (this._tilePoolSize * this._cfg.perLayerCapacity * FAR_TREE_INSTANCE_STRIDE) / (1024 * 1024);

        // ── DBG: initialize result ──────────────────────────────────────────
        FAR_DBG.warn(
            `FarTreeSourceCache.initialize COMPLETE — ` +
            `instanceBuffer=${!!this._instanceBuffer} (${(this._instanceBuffer?.size ?? 0) / 1024}kB) ` +
            `counterBuffer=${!!this._counterBuffer} layerMetaBuffer=${!!this._layerMetaBuffer} ` +
            `activeLayerBuffer=${!!this._activeLayerBuffer} ` +
            `totalMem=${memMB.toFixed(2)}MB ` +
            `afterSync_allActiveLayers=${this._allActiveLayerCount} ` +
            `afterSync_selectedLayers=${this._activeLayerCount} ` +
            `afterSync_pendingBakes=${this._queue.length}`
        );
        // ───────────────────────────────────────────────────────────────────

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
        // ── DBG ─────────────────────────────────────────────────────────────
        if (!this._initialized) {
            FAR_DBG.warn(`syncFromTileCache called but NOT initialized — skipping`);
            return;
        }
        FAR_DBG.warn(
            `syncFromTileCache called — enqueueAll=${enqueueAll} ` +
            `tileCacheEntries=${tileCache?.getEntries?.()?.length ?? 'N/A'}`
        );
        // ───────────────────────────────────────────────────────────────────
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
        // ── DBG ─────────────────────────────────────────────────────────────
        FAR_DBG.warn(
            `popBakeBatch — popped=${batch.length} limit=${limit} ` +
            `remainingQueue=${this._queue.length} ` +
            `layers=[${batch.map(b => b.layer).join(',')}]`
        );
        // ───────────────────────────────────────────────────────────────────
        return batch;
    }

    markBakeBatchSubmitted(batch) {
        if (!Array.isArray(batch) || batch.length === 0) return;
        // ── DBG ─────────────────────────────────────────────────────────────
        const results = [];
        // ───────────────────────────────────────────────────────────────────
        for (const item of batch) {
            if (!item) continue;
            const layer = item.layer >>> 0;
            if (layer >= this._tilePoolSize) continue;

            if ((item.flags & ACTIVE_FAR_TREE_FLAG) === 0) {
                if (!this._records[layer]?.active) {
                    this._layerReadyVersions[layer] = 0;
                }
                // ── DBG ─────────────────────────────────────────────────────
                results.push(`layer=${layer}:INACTIVE_FLAG`);
                // ───────────────────────────────────────────────────────────
                continue;
            }

            const version = item.version >>> 0;
            const record = this._records[layer];
            if (record?.active && (record.version >>> 0) === version) {
                this._layerReadyVersions[layer] = version;
                // ── DBG ─────────────────────────────────────────────────────
                results.push(`layer=${layer}:READY(v${version})`);
                // ───────────────────────────────────────────────────────────
            } else {
                // ── DBG ─────────────────────────────────────────────────────
                results.push(`layer=${layer}:VERSION_MISMATCH(submitted=${version} record=${record?.version ?? 'null'} active=${record?.active})`);
                // ───────────────────────────────────────────────────────────
            }
        }
        // ── DBG ─────────────────────────────────────────────────────────────
        FAR_DBG.warn(`markBakeBatchSubmitted — ${results.join(' | ')}`);
        // ───────────────────────────────────────────────────────────────────
    }

    refreshVisibleOwnerLayers(_tileStreamer) {
        if (!this._initialized) return;
        this._selectionFrame++;

        let selectedCount = 0;
        let retainedOwners = 0;
        let residentReadyFill = 0;
        // ── DBG: per-layer readiness breakdown ──────────────────────────────
        const dbgRefresh = (this._visibleOwnerRefreshCount % FAR_DBG.REFRESH_TABLE_INTERVAL) === 0;
        if (dbgRefresh) {
            const layerDetails = [];
            for (let li = 0; li < this._allActiveLayerCount; li++) {
                const l = this._allActiveLayersCPU[li];
                const rec = this._records[l];
                const ready = this._isLayerReady(l);
                const layerVer = this._layerVersions[l];
                const readyVer = this._layerReadyVersions[l];
                const retainUntil = this._layerRetainUntil[l];
                layerDetails.push(
                    `L${l}(active=${rec?.active} ready=${ready} ` +
                    `ver=${layerVer} readyVer=${readyVer} ` +
                    `retainUntil=${retainUntil} selFrame=${this._selectionFrame} ` +
                    `depth=${rec?.depth ?? '?'} tile=${rec?.tileX ?? '?'},${rec?.tileY ?? '?'})`
                );
            }
            FAR_DBG.warn(
                `refreshVisibleOwnerLayers #${this._visibleOwnerRefreshCount} — ` +
                `allActiveLayers=${this._allActiveLayerCount} pendingBakes=${this._queue.length}\n  ` +
                (layerDetails.length > 0 ? layerDetails.join('\n  ') : '(no resident layers)')
            );
        }
        // ───────────────────────────────────────────────────────────────────

        const nextLayers = new Uint32Array(this._tilePoolSize);
        const seenLayers = new Set();
        // ── DBG: tryPush rejection tracking ─────────────────────────────────
        const dbgRejections = dbgRefresh ? [] : null;
        // ───────────────────────────────────────────────────────────────────

        const tryPush = (layer, extendRetention = true) => {
            if (!Number.isFinite(layer) || layer < 0 || layer >= this._tilePoolSize) {
                dbgRejections?.push(`L${layer}:INVALID`);
                return false;
            }
            const record = this._records[layer] ?? null;
            if (!record?.active) { dbgRejections?.push(`L${layer}:NOT_ACTIVE`); return false; }
            if (!this._isLayerReady(layer)) { dbgRejections?.push(`L${layer}:NOT_READY(ver=${this._layerVersions[layer]} readyVer=${this._layerReadyVersions[layer]})`); return false; }
            if (seenLayers.has(layer)) { dbgRejections?.push(`L${layer}:DUPLICATE`); return false; }

            seenLayers.add(layer);
            nextLayers[selectedCount++] = layer >>> 0;

            if (extendRetention && this._cfg.selectionHoldFrames > 0) {
                this._layerRetainUntil[layer] = this._selectionFrame + this._cfg.selectionHoldFrames;
            }

            return true;
        };

        // Carry forward previously selected layers that are still within their hold window.
        if (this._cfg.selectionHoldFrames > 0 && this._activeLayerCount > 0) {
            const previousLayers = this._activeLayersCPU.subarray(0, this._activeLayerCount);
            for (let i = 0; i < previousLayers.length && selectedCount < this._tilePoolSize; i++) {
                const layer = previousLayers[i] >>> 0;
                if (this._layerRetainUntil[layer] < this._selectionFrame) continue;
                if (tryPush(layer, false)) retainedOwners++;
            }
        }

        // Fill remaining slots from all ready resident layers (distance-stable).
        const selectedBeforeResidentFill = selectedCount;
        selectedCount = this._appendReadyResidentLayers(nextLayers, selectedCount, seenLayers);
        residentReadyFill = selectedCount - selectedBeforeResidentFill;

        if (selectedCount > 1) {
            const sortedLayers = Array.from(nextLayers.subarray(0, selectedCount));
            sortedLayers.sort((a, b) => this._compareSelectedLayers(a, b));
            nextLayers.set(sortedLayers, 0);
        }

        const changed =
            selectedCount !== this._activeLayerCount ||
            this._activeLayersCPU.subarray(0, selectedCount).some((layer, idx) => layer !== nextLayers[idx]);

        if (changed) {
            this._activeLayersCPU.fill(0);
            this._activeLayersCPU.set(nextLayers.subarray(0, selectedCount), 0);
            this._activeLayerCount = selectedCount;
            this.device.queue.writeBuffer(this._activeLayerBuffer, 0, this._activeLayersCPU);
        }

        // ── DBG: result ──────────────────────────────────────────────────────
        if (dbgRefresh) {
            FAR_DBG.warn(
                `refreshVisibleOwnerLayers result — selected=${selectedCount} ` +
                `retained=${retainedOwners} residentFill=${residentReadyFill} changed=${changed} ` +
                `rejections=[${dbgRejections.join(' | ')}]`
            );
        }
        // ───────────────────────────────────────────────────────────────────

        this._visibleOwnerRefreshCount++;
        const logLine =
            `distResident selected=${selectedCount}/${this._allActiveLayerCount} ` +
            `retained=${retainedOwners} residentFill=${residentReadyFill} ` +
            `pendingBakes=${this.pendingBakes}`;

        if (changed || this._visibleOwnerRefreshCount % 240 === 1) {
            if (logLine !== this._lastSelectionLog || this._visibleOwnerRefreshCount % 240 === 1) {
                Logger.info(`${this._logTag} ${logLine}`);
                this._lastSelectionLog = logLine;
            }
        }
    }

    _rebuildState(tileCache, enqueueAll) {
        const nextMeta = new Uint32Array(this._tilePoolSize * LAYER_META_U32_STRIDE);
        const nextAllActiveLayers = new Uint32Array(this._tilePoolSize);
        const nextRecords = new Array(this._tilePoolSize).fill(null);
        const entries = tileCache?.getEntries?.() ?? [];
        const layersToClear = [];
        let activeCount = 0;

        // ── DBG: _rebuildState ───────────────────────────────────────────────
        if (!this._dbg_rebuildCount) this._dbg_rebuildCount = 0;
        this._dbg_rebuildCount++;
        const logThisRebuild = this._dbg_rebuildCount <= 5 || (this._dbg_rebuildCount % 120) === 0;
        if (logThisRebuild) {
            const repCounts = {};
            const entryDetails = [];
            let nullEntries = 0;
            let layerOutOfRange = 0;
            let entryTotal = 0;
            for (const e of entries) {
                if (!e) { nullEntries++; continue; }
                entryTotal++;
                const r = e.treeRepresentation ?? '(undef)';
                repCounts[r] = (repCounts[r] ?? 0) + 1;
                if (entryDetails.length < FAR_DBG.ENTRY_DUMP_LIMIT) {
                    entryDetails.push(
                        `{layer=${e.layer} face=${e.face} depth=${e.depth} ` +
                        `tile=${e.x},${e.y} rep=${r} ` +
                        `nomDist=${e.nominalDistance?.toFixed(0) ?? '?'} ` +
                        `tileWorldSize=${e.tileWorldSize?.toFixed(0) ?? '?'}}`
                    );
                }
                if ((e.layer >>> 0) >= this._tilePoolSize) layerOutOfRange++;
            }
            FAR_DBG.warn(
                `_rebuildState #${this._dbg_rebuildCount} enqueueAll=${enqueueAll} — ` +
                `totalEntries=${entryTotal} nullEntries=${nullEntries} layerOutOfRange=${layerOutOfRange} ` +
                `repBreakdown=${JSON.stringify(repCounts)}`
            );
            if (entryDetails.length > 0) {
                FAR_DBG.warn(`  first ${entryDetails.length} entries: ${entryDetails.join(' ')}`);
            }
            if (entryTotal === 0) {
                FAR_DBG.warn(`  ⚠ NO ENTRIES — tileCache has nothing; upstream tile pipeline may not be running`);
            }
        }
        // ───────────────────────────────────────────────────────────────────

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
                nextAllActiveLayers[activeCount++] = layer;
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
        this._allActiveLayersCPU = nextAllActiveLayers;
        this._allActiveLayerCount = activeCount;

        // ── DBG: post-rebuild summary ────────────────────────────────────────
        if (logThisRebuild) {
            FAR_DBG.warn(
                `_rebuildState #${this._dbg_rebuildCount} RESULT — ` +
                `activeCount=${activeCount} layersToClear=${layersToClear.length} ` +
                `queueLength=${this._queue.length} queuedLayerSet=${this._queuedLayers.size}`
            );
        }
        // ───────────────────────────────────────────────────────────────────

        // Preserve previous selected layers if still resident/active.
        const preservedActiveLayers = new Uint32Array(this._tilePoolSize);
        let preservedActiveCount = 0;
        const seen = new Set();

        for (let i = 0; i < this._activeLayerCount && preservedActiveCount < this._tilePoolSize; i++) {
            const layer = this._activeLayersCPU[i] >>> 0;
            if (!nextRecords[layer]?.active || seen.has(layer)) continue;
            seen.add(layer);
            preservedActiveLayers[preservedActiveCount++] = layer;
        }

        if (preservedActiveCount === 0 && this._visibleOwnerRefreshCount === 0) {
            preservedActiveLayers.set(nextAllActiveLayers.subarray(0, activeCount), 0);
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
        if (!this._entryHasBakeableTrees(entry)) return null;

        return {
            face: entry.face >>> 0,
            depth: entry.depth >>> 0,
            tileX: entry.x >>> 0,
            tileY: entry.y >>> 0,
            layer: entry.layer >>> 0,
            flags: ACTIVE_FAR_TREE_FLAG,
            active: true,
            tileWorldSize: Number.isFinite(entry.tileWorldSize) ? entry.tileWorldSize : 0,
            nominalDistance: Number.isFinite(entry.nominalDistance) ? entry.nominalDistance : 0,
        };
    }

    _entryHasBakeableTrees(entry) {
        if (!entry) return false;

        // ── DBG: track every representation we ever see ──────────────────────
        if (!this._dbg_repSeen) {
            this._dbg_repSeen = new Map();   // rep → count
            this._dbg_rejReasons = new Map(); // reason → count
            this._dbg_firstArchetypeLog = false;
        }
        const rep = entry.treeRepresentation ?? '(undefined)';
        this._dbg_repSeen.set(rep, (this._dbg_repSeen.get(rep) ?? 0) + 1);

        // On the very first call, also inspect the archetype registry fully
        if (!this._dbg_firstArchetypeLog) {
            this._dbg_firstArchetypeLog = true;
            setTimeout(() => {
                // Dump all archetypes
                const archetypes = [];
                for (let ai = 0; ai < 32; ai++) {
                    const a = this._assetRegistry.getArchetypeByIndex?.(ai);
                    if (!a) break;
                    archetypes.push(`[${ai}] id=${a.id ?? '?'} isActive=${a.isActive} category=${a.category ?? '?'}`);
                }
                FAR_DBG.warn(
                    `_entryHasBakeableTrees — archetype dump (${archetypes.length} found):\n  ` +
                    (archetypes.length ? archetypes.join('\n  ') : '(none)')
                );
                // Dump all representation counts seen so far
                const repSummary = [...this._dbg_repSeen.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
                FAR_DBG.warn(`_entryHasBakeableTrees — representation counts so far: ${repSummary}`);
                FAR_DBG.warn(
                    `_entryHasBakeableTrees — CLUSTER value="${ASSET_BAKE_REPRESENTATION.CLUSTER}" ` +
                    `RUNTIME_TREE value="${ASSET_BAKE_REPRESENTATION.RUNTIME_TREE}"`
                );
            }, 200);
        }
        // ───────────────────────────────────────────────────────────────────

        if (entry.treeRepresentation !== ASSET_BAKE_REPRESENTATION.CLUSTER) {
            const reason = `rep_mismatch:${rep}`;
            this._dbg_rejReasons.set(reason, (this._dbg_rejReasons.get(reason) ?? 0) + 1);
            return false;
        }
        const treeArchetype = this._assetRegistry.getArchetypeByIndex?.(0);
        if (!treeArchetype?.isActive) {
            this._dbg_rejReasons.set('archetype_inactive', (this._dbg_rejReasons.get('archetype_inactive') ?? 0) + 1);
            return false;
        }
        return true;
    }

    // ── DBG: call this from console to see current rejection summary
    _dbgRejectionSummary() {
        const repSummary = [...(this._dbg_repSeen?.entries() ?? [])].map(([k, v]) => `${k}:${v}`).join(', ');
        const rejSummary = [...(this._dbg_rejReasons?.entries() ?? [])].map(([k, v]) => `${k}:${v}`).join(', ');
        FAR_DBG.warn(`REJECTION SUMMARY — reps seen: {${repSummary}} | rejection reasons: {${rejSummary}}`);
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

    _nextLayerVersion(layer) {
        const next = ((this._layerVersions[layer] >>> 0) + 1) >>> 0;
        return next === 0 ? 1 : next;
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
            tileWorldSize: Number.isFinite(item.tileWorldSize) ? item.tileWorldSize : 0,
            nominalDistance: Number.isFinite(item.nominalDistance) ? item.nominalDistance : 0,
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
    }
}

export const FAR_TREE_SOURCE_FLAGS = Object.freeze({
    ACTIVE: ACTIVE_FAR_TREE_FLAG,
    LAYER_META_U32_STRIDE,
    INSTANCE_STRIDE: FAR_TREE_INSTANCE_STRIDE,
});