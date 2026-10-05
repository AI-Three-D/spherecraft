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
import { dirToPlane, growPatchFrame, limitPatchCells } from './lakeRefine.js';

// Bump on any change to the graph, the lake solve or the sampling.
export const WATER_ALGO_VERSION = 'water-v4';

export const WATER_SERVICE_DEFAULTS = Object.freeze({
    gridN: 512,
    params: {},            // WATER_GRAPH_DEFAULTS overrides
    cache: true,
    rivers: {
        enabled: true,
        spacingM: 16,
        corridorM: 1000,   // the trace stays within this of the graph's route
        retryCorridorScale: 2.5,  // wider corridor when the start sits above the source lake
        startToleranceM: 1.0,
        shape: {},         // RIVER_SHAPE_DEFAULTS overrides (riverRefine.js)
    },
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
    return {
        ...WATER_SERVICE_DEFAULTS, ...cfg,
        refine: { ...WATER_SERVICE_DEFAULTS.refine, ...(cfg.refine ?? {}) },
        rivers: { ...WATER_SERVICE_DEFAULTS.rivers, ...(cfg.rivers ?? {}) },
    };
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
        this.riverRecs = new Map();  // riverId -> traced river (riverRefine.js)
        this._failedRivers = new Set();
        this._lakeRegrown = new Set();
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

    /**
     * Per-frame: start refining the nearest unrefined lake in range; when
     * all lakes in range are done, the nearest river whose source lake is
     * in range.
     */
    update(cameraPosition) {
        if (this.state !== 'ready' || this._busy || !this.config.refine.enabled || !cameraPosition) return;
        const now = performance.now();
        if (now - this._lastPick < 250) return;
        this._lastPick = now;
        const near = this.lakesNear(cameraPosition, 96).filter(({ distanceM }) => distanceM <= this.config.refine.radiusM);
        const lake = near.find(({ lake: l }) => !this.refined.has(l.id) && !this._failed.has(l.id));
        if (lake) { this.refineLake(lake.lake.id); return; }
        if (!this.config.rivers.enabled) return;
        for (const { lake: l } of near) {
            const rid = l.river;
            if (rid >= 0 && !this.riverRecs.has(rid) && !this._failedRivers.has(rid)) { this.refineRiver(rid); return; }
        }
    }

    /** Solves one lake (cache first). Resolves to its record, or null. */
    async refineLake(lakeId) {
        if (this.state !== 'ready' || this._busy) return null;
        this._busy = true;
        try {
            return await this._refineLake(lakeId);
        } finally {
            this._busy = false;
        }
    }

    async _refineLake(lakeId) {
        const id = this.rep(lakeId);
        if (this.refined.has(id)) return this.refined.get(id);
        const t0 = performance.now();
        const R = this.config.refine;
        const lakeKey = `lake:${this._key}:${R.spacingM}:${R.bandM}:${id}`;
        try {
            let rec = this.config.cache ? await this._cache.get(lakeKey) : null;
            const fromCache = !!rec;
            if (rec) {
                const restored = await this._client.call({
                    type: 'restoreLake', lakeId: id, level: rec.level, exitDir: rec.exitDir, merged: rec.merged,
                    frame: rec.frame, mask: rec.mask, outflowDirs: rec.outflowDirs,
                });
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
        }
    }

    /**
     * Traces one river at 16 m (riverRefine.js): from its source lake's
     * fine sill to the water it ends in. Both lakes are refined first, so
     * the river meets the water as drawn. Resolves to its record, or null.
     */
    async refineRiver(riverId) {
        if (this.state !== 'ready' || this._busy) return null;
        if (this.riverRecs.has(riverId)) return this.riverRecs.get(riverId);
        this._busy = true;
        const t0 = performance.now();
        const RC = this.config.rivers;
        try {
            const src = this.rivers[riverId].fromLake;
            if (this.rep(src) !== src) { this._failedRivers.add(riverId); return null; }
            await this._refineLake(src);
            let plan = null;
            // The destination's level decides the route: refine it, then route again.
            for (let k = 0; k < 4; k++) {
                plan = await this._client.call({ type: 'planRiver', riverId, spacing: RC.spacingM, corridorM: RC.corridorM });
                if (plan.status !== 'ok' || plan.dest.type !== 'lake' || this.refined.has(plan.dest.id)) break;
                if (!(await this._refineLake(plan.dest.id))) break;
            }
            if (plan?.status !== 'ok') { this._failedRivers.add(riverId); return null; }
            const destKey = plan.dest.type === 'lake' ? `lake${plan.dest.id}` : 'sea';
            const riverKey = `river:${this._key}:${RC.spacingM}:${RC.corridorM}:${riverId}:${destKey}`;
            let rec = this.config.cache ? await this._cache.get(riverKey) : null;
            const fromCache = !!rec;
            if (!rec) {
                // A start above the source lake's level means the corridor
                // missed the water's lower way past a sill: retry wider.
                const srcLevel = this.refined.get(src)?.level ?? this.lakes[src].level;
                for (const corridorM of [RC.corridorM, RC.corridorM * RC.retryCorridorScale]) {
                    if (corridorM !== RC.corridorM) {
                        plan = await this._client.call({ type: 'planRiver', riverId, spacing: RC.spacingM, corridorM });
                        if (plan.status !== 'ok') break;
                    }
                    const frame = limitPatchCells(plan.frame, this.config.refine.maxCells);
                    const heights = await this._sampler.samplePatch(frame, this.radius);
                    const r = await this._client.call({ type: 'solveRiver', riverId, frame, heights, shape: RC.shape }, [heights.buffer]);
                    if (r.status === 'ok' && (!rec || rec.status !== 'ok' || r.startLevel < rec.startLevel)) rec = r;
                    else if (!rec) rec = r;
                    if (rec.status === 'ok' && rec.startLevel - srcLevel <= RC.startToleranceM) break;
                }
            }
            rec.ms = performance.now() - t0;
            if (rec.status !== 'ok') {
                this._failedRivers.add(riverId);
                Logger.info(`[Water] river ${riverId}: ${rec.status}`);
                return null;
            }
            // Still above the source lake: a closed depression past its sill
            // backs up into the lake (its patch ended inside it). Solve the
            // lake again on a patch reaching past the river's high point, then
            // trace the river once more.
            const srcLevel = this.refined.get(src)?.level ?? this.lakes[src].level;
            if (!fromCache && rec.status === 'ok' && rec.startLevel - srcLevel > RC.startToleranceM && !this._lakeRegrown.has(src)) {
                this._lakeRegrown.add(src);
                const high = this._riverHighPoint(rec);
                if (high && await this._resolveLakeIncluding(src, high)) {
                    this._busy = false;
                    return this.refineRiver(riverId);
                }
            }
            if (!fromCache && this.config.cache) { const { ms: _ms, ...stored } = rec; this._cache.put(riverKey, stored); }
            this.riverRecs.set(riverId, rec);
            this.version++;
            Logger.debug(`[Water] river ${riverId}: ${(rec.lengthM / 1000).toFixed(1)} km to ${destKey}${rec.weakEnd ? ' (no destination water in the corridor)' : ''}, ` +
                `${fromCache ? 'cache' : 'traced'} ${rec.ms.toFixed(0)} ms`);
            return rec;
        } catch (err) {
            this._failedRivers.add(riverId);
            Logger.warn(`[Water] river ${riverId} refine failed: ${err?.message || err}`);
            return null;
        } finally {
            this._busy = false;
        }
    }

    /** First point along a traced river where its water level drops below the start level (just past the high sill). */
    _riverHighPoint(rec) {
        const n = rec.points.length / rec.stride, P = rec.points, st = rec.stride;
        for (let k = 0; k < n; k++) {
            const fill = P[k * st + 3] - P[k * st + 5];
            if (fill < rec.startLevel - 0.05) return [P[k * st], P[k * st + 1], P[k * st + 2]];
        }
        return null;
    }

    /** Solves a lake again on its patch grown to include dir (+ margin). */
    async _resolveLakeIncluding(id, dir) {
        const R = this.config.refine;
        const old = this.refined.get(id);
        const f = old?.frame ?? this.lakes[id].frame;
        const [x, y] = dirToPlane(dir, f, this.radius);
        const m = 1500;
        const x0 = Math.min(f.x0, x - m), y0 = Math.min(f.y0, y - m);
        const x1 = Math.max(f.x0 + f.nx * f.spacing, x + m), y1 = Math.max(f.y0 + f.ny * f.spacing, y + m);
        const spacing = R.spacingM;
        const frame = limitPatchCells({ c: f.c, e1: f.e1, e2: f.e2, x0, y0, spacing, nx: Math.ceil((x1 - x0) / spacing), ny: Math.ceil((y1 - y0) / spacing) }, R.maxCells);
        const heights = await this._sampler.samplePatch(frame, this.radius);
        const rec = await this._client.call({ type: 'solveLake', lakeId: id, frame, heights, bandM: R.bandM }, [heights.buffer]);
        if (rec.status !== 'ok') return false;
        Logger.debug(`[Water] lake ${id} re-solved past its outflow: level ${old?.level?.toFixed(1)} -> ${rec.level.toFixed(1)} m`);
        this._apply(id, rec);
        if (this.config.cache) {
            const { downstream: _downstream, ...stored } = rec;
            this._cache.put(`lake:${this._key}:${R.spacingM}:${R.bandM}:${id}`, stored);
        }
        return true;
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
            riversTraced: this.riverRecs.size, riversFailed: this._failedRivers.size,
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
