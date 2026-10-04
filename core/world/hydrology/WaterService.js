// core/world/hydrology/WaterService.js
//
// Background water system (IMPLEMENTATION_PLAN 6.3): builds the water graph
// after the terrain is up and refines lakes near the camera, without ever
// blocking terrain.
// - GPU sampling (HydrologyGrid.js) on the main thread, in small dispatches
//   with a yield between them;
// - graph build and lake solves in a module worker (waterWorkerCore.js);
//   in-process where Worker is missing (Node lab);
// - IndexedDB cache (waterCache.js): the sampled grid and each solved lake.
//
// Lakes are refined nearest-first within refine.radiusM of the camera, one
// at a time. A refined lake has its true level, a 16 m mask of where water
// may show (lakeRefine.lakeMask) and a downstream route; lakes that turn
// out to be one basin are merged.

import { Logger } from '../../../shared/Logger.js';
import { createHydrologySampler } from './HydrologyGrid.js';
import { WaterCache, hashParts } from './waterCache.js';
import { createWaterWorkerCore } from './waterWorkerCore.js';
import { growPatchFrame, limitPatchCells } from './lakeRefine.js';

// Bump on any change to the graph, the lake solve or the sampling.
export const WATER_ALGO_VERSION = 'water-v2';

export const WATER_SERVICE_DEFAULTS = Object.freeze({
    gridN: 512,
    params: {},            // WATER_GRAPH_DEFAULTS overrides
    cache: true,
    refine: {
        enabled: true,
        spacingM: 16,      // lab: 16 m and 4 m solves agree within 0.2 m
        radiusM: 40000,    // refine lakes whose patch comes this close
        bandM: 6,          // shore band of the render mask (metres above the level)
        maxCells: 4e6,     // larger patches get a coarser spacing
        maxGrows: 3,       // patch growths (x1.6) when a lake reaches the patch border
    },
});

function mergeConfig(cfg = {}) {
    return { ...WATER_SERVICE_DEFAULTS, ...cfg, refine: { ...WATER_SERVICE_DEFAULTS.refine, ...(cfg.refine ?? {}) } };
}

class WorkerClient {
    constructor(useWorker) {
        this._pending = new Map();
        this._nextId = 1;
        this._worker = null;
        this._core = null;
        if (useWorker && typeof Worker !== 'undefined') {
            try {
                this._worker = new Worker(new URL('./waterWorker.js', import.meta.url), { type: 'module' });
                this._worker.onmessage = (e) => {
                    const { id, reply, error } = e.data;
                    const p = this._pending.get(id);
                    if (!p) return;
                    this._pending.delete(id);
                    if (error) p.reject(new Error(error)); else p.resolve(reply);
                };
                this._worker.onerror = (e) => Logger.warn(`[Water] worker error: ${e.message}`);
            } catch (err) {
                Logger.warn(`[Water] no module worker (${err?.message || err}); running in-process`);
                this._worker = null;
            }
        }
        if (!this._worker) this._core = createWaterWorkerCore();
    }

    get inWorker() { return !!this._worker; }

    call(msg, transfer = []) {
        if (this._core) {
            return Promise.resolve().then(() => this._core.handle(msg).reply);
        }
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._worker.postMessage({ id, msg }, transfer);
        });
    }

    terminate() { this._worker?.terminate(); this._worker = null; }
}

export class WaterService {
    /**
     * @param {object} p
     * @param {GPUDevice} p.device
     * @param {object} p.terrainGenerator   WebGPUTerrainGenerator
     * @param {object} p.planetConfig       radius, terrainGeneration.waterGraph
     * @param {object} [p.config]           overrides (see WATER_SERVICE_DEFAULTS)
     * @param {boolean} [p.useWorker=true]
     * @param {Function} [p.yieldBetween]   awaited between GPU dispatches
     */
    constructor({ device, terrainGenerator, planetConfig, config = null, useWorker = true, yieldBetween = null }) {
        this.device = device;
        this.terrainGenerator = terrainGenerator;
        this.planetConfig = planetConfig;
        this.config = mergeConfig(config ?? planetConfig?.terrainGeneration?.waterGraph ?? {});
        this.radius = planetConfig.radius;
        this._useWorker = useWorker;
        this._yieldBetween = yieldBetween;

        this.state = 'idle';     // idle | sampling | building | ready | failed
        this.lakes = [];         // graph lakes (worker summaries)
        this.rivers = [];
        this.stats = null;
        this.lakeOf = null;      // Int32Array, 6 * N * N
        this.riverOf = null;
        this.lakeCells = null;   // lake k's grid cells: lakeCells[lakeCellStart[k] .. lakeCellStart[k + 1])
        this.lakeCellStart = null;
        this.refined = new Map();    // lakeId -> solve record
        this.mergedInto = new Map(); // lakeId -> representative lake id
        this.version = 0;            // bumps whenever lake data changes
        this.timings = {};

        this._cache = new WaterCache();
        this._client = null;
        this._sampler = null;
        this._key = null;
        this._busy = false;
        this._failed = new Set();
        this._lastPick = 0;
    }

    /** Builds the graph in the background. Resolves when it is ready (or failed). */
    async start() {
        if (this.state !== 'idle') return;
        const t0 = performance.now();
        try {
            this.state = 'sampling';
            this._client = new WorkerClient(this._useWorker);
            this._sampler = await createHydrologySampler({
                device: this.device, terrainGenerator: this.terrainGenerator, yieldBetween: this._yieldBetween,
            });
            const N = this.config.gridN;
            this._key = hashParts([
                WATER_ALGO_VERSION, N, this.radius, this.config.params,
                this._sampler.terrainKey, this.planetConfig?.worldAuthoring?.biomes ?? [],
            ]);
            // Entries of other terrain versions are never read again.
            if (this.config.cache) {
                Promise.resolve().then(() => this._cache.pruneExcept(this._key))
                    .catch(err => Logger.warn(`[Water] cache prune failed: ${err?.message || err}`));
            }
            let grid = this.config.cache ? await this._cache.get(`grid:${this._key}`) : null;
            const fromCache = !!grid;
            if (!grid) {
                grid = await this._sampler.sampleGrid(N);
                if (this.config.cache) this._cache.put(`grid:${this._key}`, { N, heights: grid.heights, precip: grid.precip, seaLevelM: grid.seaLevelM });
            }
            this.timings.gridMs = performance.now() - t0;

            this.state = 'building';
            const t1 = performance.now();
            const built = await this._client.call({
                type: 'build', N, heights: grid.heights, precip: grid.precip, seaLevelM: grid.seaLevelM,
                radius: this.radius, params: this.config.params, spacing: this.config.refine.spacingM,
            });
            this.timings.buildMs = performance.now() - t1;
            this.N = built.N;
            this.lakes = built.lakes;
            this.rivers = built.rivers;
            this.stats = built.stats;
            this.lakeOf = built.lakeOf;
            this.riverOf = built.riverOf;
            this.lakeCells = built.lakeCells;
            this.lakeCellStart = built.lakeCellStart;
            this.state = 'ready';
            this.version++;
            Logger.info(
                `[Water] graph ready: ${this.lakes.length} lakes, ${this.rivers.length} rivers ` +
                `(grid ${fromCache ? 'from cache' : 'sampled'} ${this.timings.gridMs.toFixed(0)} ms, ` +
                `build ${this.timings.buildMs.toFixed(0)} ms ${this._client.inWorker ? 'in worker' : 'in-process'}, key ${this._key})`
            );
        } catch (err) {
            this.state = 'failed';
            Logger.warn(`[Water] graph build failed: ${err?.stack || err}`);
        }
    }

    /** Representative of a lake (lakes merged into another resolve to it). */
    rep(id) { while (this.mergedInto.has(id)) id = this.mergedInto.get(id); return id; }

    /** Surface distance (m) from a world position to a lake's patch, roughly. */
    _lakeDistance(lake, camDir) {
        const c = lake.frame.c;
        const cosA = Math.max(-1, Math.min(1, camDir[0] * c[0] + camDir[1] * c[1] + camDir[2] * c[2]));
        const half = 0.5 * Math.hypot(lake.frame.nx, lake.frame.ny) * lake.frame.spacing;
        return Math.max(0, Math.acos(cosA) * this.radius - half);
    }

    /** Lakes sorted by distance from a world position: [{ lake, distanceM }]. */
    lakesNear(worldPos, count = 10) {
        const origin = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const v = [worldPos.x - origin.x, worldPos.y - origin.y, worldPos.z - origin.z];
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        const dir = [v[0] / l, v[1] / l, v[2] / l];
        return this.lakes
            .filter(lake => this.rep(lake.id) === lake.id)
            .map(lake => ({ lake, distanceM: this._lakeDistance(lake, dir) }))
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, count);
    }

    /** Per-frame: start refining the nearest unrefined lake in range. */
    update(cameraPosition) {
        if (this.state !== 'ready' || this._busy || !this.config.refine.enabled || !cameraPosition) return;
        const now = performance.now();
        if (now - this._lastPick < 250) return;
        this._lastPick = now;
        const next = this.lakesNear(cameraPosition, 64)
            .find(({ lake, distanceM }) => distanceM <= this.config.refine.radiusM
                && !this.refined.has(lake.id) && !this._failed.has(lake.id));
        if (next) this.refineLake(next.lake.id);
    }

    /** Solves one lake (cache first). Resolves to its record, or null. */
    async refineLake(lakeId) {
        if (this.state !== 'ready' || this._busy) return null;
        const id = this.rep(lakeId);
        if (this.refined.has(id)) return this.refined.get(id);
        this._busy = true;
        const t0 = performance.now();
        const R = this.config.refine;
        const lakeKey = `lake:${this._key}:${R.spacingM}:${R.bandM}:${id}`;
        try {
            let rec = this.config.cache ? await this._cache.get(lakeKey) : null;
            const fromCache = !!rec;
            if (rec) {
                const restored = await this._client.call({ type: 'restoreLake', lakeId: id, level: rec.level, exitDir: rec.exitDir, merged: rec.merged });
                rec.downstream = restored.downstream;
            } else {
                let frame = limitPatchCells(this.lakes[id].frame, R.maxCells);
                for (let grows = 0; ; grows++) {
                    const heights = await this._sampler.samplePatch(frame, this.radius);
                    rec = await this._client.call({ type: 'solveLake', lakeId: id, frame, heights, bandM: R.bandM }, [heights.buffer]);
                    if (rec.status !== 'grow' || grows >= R.maxGrows) break;
                    frame = limitPatchCells(growPatchFrame(frame, 1.6), R.maxCells);
                }
            }
            rec.ms = performance.now() - t0;
            if (rec.status === 'merged') {
                this.mergedInto.set(id, rec.into);
                return null;
            }
            if (rec.status !== 'ok') {
                this._failed.add(id);
                Logger.info(`[Water] lake ${id}: ${rec.status} (${rec.ms.toFixed(0)} ms)`);
                return null;
            }
            this._apply(id, rec);
            if (!fromCache && this.config.cache) {
                const { downstream: _downstream, ms: _ms, ...stored } = rec;
                this._cache.put(lakeKey, stored);
            }
            Logger.debug(`[Water] lake ${id}: level ${rec.level.toFixed(1)} m (graph ${this.lakes[id].level.toFixed(1)}), ` +
                `${(rec.areaM2 / 1e6).toFixed(2)} km2, ${fromCache ? 'cache' : 'solved'} ${rec.ms.toFixed(0)} ms`);
            return rec;
        } catch (err) {
            this._failed.add(id);
            Logger.warn(`[Water] lake ${id} refine failed: ${err?.message || err}`);
            return null;
        } finally {
            this._busy = false;
        }
    }

    _apply(id, rec) {
        for (const m of rec.merged ?? []) {
            this.mergedInto.set(m, id);
            this.refined.delete(m);
        }
        this.refined.set(id, rec);
        for (const [lid, down] of Object.entries(rec.downstream ?? {})) {
            const r = this.refined.get(Number(lid));
            if (r) r.downstream = down;
        }
        this.version++;
    }

    summary() {
        const levels = [...this.refined.entries()].map(([id, r]) => r.level - this.lakes[id].level);
        return {
            state: this.state, key: this._key, inWorker: this._client?.inWorker ?? false,
            lakes: this.lakes.length, rivers: this.rivers.length, stats: this.stats,
            refined: this.refined.size, merged: this.mergedInto.size, failed: this._failed.size,
            meanAbsLevelChangeM: levels.length ? levels.reduce((s, d) => s + Math.abs(d), 0) / levels.length : 0,
            timings: this.timings,
        };
    }

    async clearCache() { return this._cache.clear(); }

    dispose() {
        this._client?.terminate();
        this._sampler?.destroy();
        this.state = 'idle';
    }
}
