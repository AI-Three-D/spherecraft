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
import { dirToPlane, growPatchFrame, limitPatchCells, planeToDir, tangentBasis } from './lakeRefine.js';
import { cellDir, dirToCell } from './waterGraph.js';
import { RIVER_SUB } from '../water/waterWgsl.js';
import { RIVER_CARVE_DEFAULTS, riverShapeMaxScale } from '../water/riverShapeNoise.js';
import { RIVER_SECTION } from '../water/riverSection.js';
import { RIVER_LEVEL_DEFAULTS, RIVER_SOLVE_VERSION } from './riverRefine.js';
import { regionalWaterModel,regionalWaterGridN,lakeMaskCells } from './regionalWater.js';
import { lakeCellMask } from '../terrain-generator/lakeCellShape.js';
import { LakeCellRivers } from './lakeCellRivers.js';
import { MOUNTAIN_LAKE_DEFAULTS, MOUNTAIN_LAKE_VERSION, chooseMountainLakes, drainFrame, mountainBlockFrame, mountainBlocks, pocketSolveFrame } from './mountainLakes.js';
import { settledMountainPrefix } from './mountainStreaming.js';
import { pondOverlapGroups, sharedPondFrame } from './pondOverlapGroups.js';
import { patchRectsMayOverlap } from './patchOverlap.js';

// Bump on any change to the graph, the lake solve or the sampling.
export const WATER_ALGO_VERSION = 'water-v20';   // v20: preserve fine lake seeds and merge only the actual basin

export const WATER_SERVICE_DEFAULTS = Object.freeze({
    gridN: 512,
    params: {},            // WATER_GRAPH_DEFAULTS overrides
    cache: true,
    gpu: {structuredCapacity:true,structuredLakeGridN:64,structuredRiverSurface:true},
    rivers: {
        enabled: true,
        spacingM: 16,
        corridorM: 1000,   // the trace stays within this of the graph's route
        retryCorridorScale: 2.5,  // wider corridor when the start sits above the source lake
        startToleranceM: 1.0,
        shape: {},         // RIVER_SHAPE_DEFAULTS overrides (riverRefine.js)
        levels: {},        // RIVER_LEVEL_DEFAULTS overrides (riverRefine.js): water level and valley
        stepM: 20,         // traced line resampled every stepM...
        smoothPasses: 8,   // ...and smoothed by this many [1 2 1] passes (curves, not corners)
        confluences: true, // a river reaching another river's path ends in it
    },
    // River corridor shaped into the terrain (riverCarve.wgsl.js), after
    // Whitewater's cross-section: channel, banks rising beyond its edge,
    // blend into the natural terrain. x = metres beyond the channel's edge.
    carve: RIVER_CARVE_DEFAULTS,
    refine: {
        enabled: true,
        spacingM: 16,      // lab: 16 m and 4 m solves agree within 0.2 m
        radiusM: 40000,    // refine lakes whose patch comes this close
        bandM: 6,          // shore band of the render mask (metres above the level)
        lookAheadS: 3,     // work is ranked by distance from where the camera will be this far ahead
        maxCells: 4e6,     // larger patches get a coarser spacing
        maxGrows: 3,       // patch growths (x1.6) when a lake reaches the patch border
        // Every lake solved right after the graph, nearest first; a lake is
        // drawn only once solved (no grid-cell outlines, no level pops). Use
        // with spacingM 32: lab 2026-10-11 (lake-recovery-2026-10-11/lab2),
        // 614 lakes, 32 m vs 16 m levels p5..p95 -0.23..+0.14 m, visible
        // water IoU 0.994 by area, 3.3x less flood work.
        precompute: false,
        // Small mountain lakes (mountainLakes.js), found and solved after the
        // graph's lakes in a precompute; MOUNTAIN_LAKE_DEFAULTS overrides.
        mountain: {},
    },
});

// Precompute sampling: larger dispatches, a frame yield only after this much
// main-thread time (instead of one dispatch per frame).
const PRECOMPUTE_SAMPLES_PER_DISPATCH = 262144;
const PRECOMPUTE_SLICE_MS = 12;

function mergeConfig(cfg = {}) {
    return {
        ...WATER_SERVICE_DEFAULTS, ...cfg,
        gpu: {...WATER_SERVICE_DEFAULTS.gpu,...(cfg.gpu??{})},
        refine: { ...WATER_SERVICE_DEFAULTS.refine, ...(cfg.refine ?? {}) },
        rivers: { ...WATER_SERVICE_DEFAULTS.rivers, ...(cfg.rivers ?? {}) },
        carve: { ...WATER_SERVICE_DEFAULTS.carve, ...(cfg.carve ?? {}) },
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
    constructor({ device, terrainGenerator, planetConfig, config = null, useWorker = true, yieldBetween = null, loading = null }) {
        this.device = device;
        this.terrainGenerator = terrainGenerator;
        this.planetConfig = planetConfig;
        this.config = mergeConfig(config ?? planetConfig?.terrainGeneration?.waterGraph ?? {});
        this.radius = planetConfig.radius;
        this._useWorker = useWorker;
        this._yieldBetween = yieldBetween;
        // () => true while the initial terrain loads: the precompute then
        // floods one lake at a time (a full pool delayed the loader by ~3.5 s,
        // lake-recovery-2026-10-11 runs 5, 8, 9).
        this._loading = loading;

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
            // Lakes of the 'lakeLand' terrain (lake table): published as they
            // arrive with the terrain, no graph (_tickLakeCells).
            if (this.terrainGenerator.lakeTable) {
                this._lakeCells = { table: this.terrainGenerator.lakeTable, builds: -1, cache: new Map(), known: new Map(), recs: new Map(),
                    rivers: this.config.rivers.enabled ? new LakeCellRivers({ device: this.device, gen: this.terrainGenerator }) : null };
                this._publishLakeCells();
                this.state = 'ready';
                Logger.info('[Water] lake-cell water: lakes arrive with the terrain');
                // The river field bakes on the lake terrain: the river planner's
                // own lake table, which its floods fill along every river.
                if (this._lakeCells.rivers) {
                    const lakeTable = await this._lakeCells.rivers.ready();
                    this._sampler = await createHydrologySampler({ device: this.device, terrainGenerator: this.terrainGenerator,
                        directionsOnly: true, eagerCarved: false, lakeTable });
                }
                return;
            }
            const regional=this.terrainGenerator.regionalTerrain;
            if(this.terrainGenerator.regionalTerrainActive && regional?.basinsConfig) {
                if(this.terrainGenerator._regionalTerrainDirty) throw new Error('Regional terrain is stale; regenerate before publishing water');
                if(this.config.gpu.structuredCapacity) {
                    this.config.gridN=regionalWaterGridN(regional,this.config.gridN,this.config.gpu.structuredLakeGridN);
                }
                Object.assign(this,regionalWaterModel(regional,this.radius,this.config.gridN));
                this._key=regional.sourceKey;
                this.timings.coarsePublicationMs=performance.now()-t0;
                this.state='ready';this.version++;
                Logger.info(`[Water] regional water ready: ${this.lakes.length} certified basins, ${this.rivers.length} coarse rivers, ${this.timings.coarsePublicationMs.toFixed(1)} ms`);
                return;
            }
            this.state = 'sampling';
            this._client = new WorkerClient(this._useWorker);
            const pre = this.config.refine.precompute === true;
            let sliceStart = performance.now();
            const sliced = async () => {
                if (performance.now() - sliceStart < PRECOMPUTE_SLICE_MS) return;
                if (this._yieldBetween) await this._yieldBetween();
                sliceStart = performance.now();
            };
            this._sampler = await createHydrologySampler({
                device: this.device, terrainGenerator: this.terrainGenerator, yieldBetween: pre ? sliced : this._yieldBetween,
                ...(pre ? { samplesPerDispatch: PRECOMPUTE_SAMPLES_PER_DISPATCH } : {}),
                // The carved variant only serves the simulation's bed.
                eagerCarved: !pre && this.config.sim?.enabled !== false,
            });
            if (this._carveResources) this._sampler.setWaterCarveResources(this._carveResources);
            if (this._fieldResources) this._sampler.setRiverFieldResources(this._fieldResources);
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
            this.gridHeights = grid.heights;

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
            if (pre) {
                // WaterGpuData is sized when the graph is ready, before the
                // mountain lakes exist.
                const MP = { ...MOUNTAIN_LAKE_DEFAULTS, ...this.config.refine.mountain };
                if (MP.enabled) {
                    this._mountainBlocks = mountainBlocks(this.gridHeights, grid.seaLevelM, N, MP).blocks;
                    // Mask slots for the mountain lakes and ponds: 0.47 and 0.68
                    // per block on the default planet (water-look v35), 1.3 reserved.
                    this.mountainReserve = Math.ceil(this._mountainBlocks.length * 1.3) + 64;
                }
                this._busy = true;   // update() waits: lakes are solved here, rivers after them
                this._precomputeLakes().catch(err => Logger.warn(`[Water] lake precompute failed: ${err?.stack || err}`));
            }
        } catch (err) {
            this.state = 'failed';
            Logger.warn(`[Water] graph build failed: ${err?.stack || err}`);
        }
    }

    /** Terrain height (m) of the water graph's grid cell under a unit direction (coarse, ~400 m). */
    groundHeightAt(dir) {
        return this.gridHeights ? this.gridHeights[dirToCell(dir, this.N)] : 0;
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
     * Per-frame: start the nearest piece of water work in range, lakes and
     * rivers alike (lab 2026-10-05: lakes first, then rivers, left the rivers
     * by the camera untraced for 49 s while 80 lakes within 40 km were
     * solved). Distances from where the camera will be ~lookAheadS ahead;
     * a river's from its nearest graph cell. The next piece starts the
     * frame after one finishes.
     */
    // Lake cells: republish the table's active lakes after its builds (each
    // lake's mask computed once).
    _tickLakeCells() {
        const L = this._lakeCells;
        if (L.reading || L.table.stats.builds === L.builds) return;
        const builds = L.table.stats.builds;
        L.reading = true;
        L.table.readLakes().then(async list => {
            if (!list) return;
            L.builds = builds;
            // A published lake keeps its id (its place in publication order)
            // and its record: new lakes come after, and a republication only
            // carries what changed (WaterGpuData re-applied every lake, 90 ms
            // for 620, when ids were places in a sorted list).
            const fresh = list.filter(l => !L.known.has(l.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
            for (const l of fresh) L.known.set(l.key, l);
            if (fresh.length) this._publishLakeCells();
        }).catch(err => Logger.warn(`[Water] lake-cell publication failed: ${err?.message || err}`))
            .finally(() => { L.reading = false; });
    }

    // Rivers for the lakes near the camera that have none yet, published as
    // they come; apart from the lakes' reads, which never wait for rivers.
    // Starts again when lakes were added or the camera moved 2 km.
    _tickLakeCellRivers() {
        const L = this._lakeCells, dir = this._camDir;
        if (!L.rivers || L.planning || !dir) return;
        const moved = !L.plannedAt || Math.acos(Math.min(1, dir[0] * L.plannedAt[0] + dir[1] * L.plannedAt[1] + dir[2] * L.plannedAt[2])) * this.radius > 2000;
        if (L.known.size === L.plannedKnown && !moved) return;
        L.planning = true;
        L.plannedKnown = L.known.size;
        L.plannedAt = dir;
        (async () => {
            for (;;) {
                const before = L.rivers.changes;
                if (!(await L.rivers.plan([...L.known.values()], 6, this._camDir))) break;
                if (L.rivers.changes !== before) this._publishLakeCells();
            }
        })().catch(err => Logger.warn(`[Water] lake-cell rivers failed: ${err?.message || err}`))
            .finally(() => { L.planning = false; });
    }

    _publishLakeCells() {
        const L = this._lakeCells, idOf = new Map(), keys = [], basins = [];
        for (const l of L.known.values()) {
            if (!L.cache.has(l.key)) {
                const m = lakeCellMask(l);
                L.cache.set(l.key, { ...m, maskCells: lakeMaskCells(m.frame, m.mask, this.radius, this.config.gridN) });
            }
            const m = L.cache.get(l.key), id = keys.length;
            idOf.set(l.key, id);
            keys.push(l.key);
            basins.push({ id, centre: l.centre, levelM: l.level, radiusM: m.radiusM, frame: m.frame, mask: m.mask, maskCells: m.maskCells });
        }
        const rivers = L.rivers?.recordsFor(idOf, [...L.known.values()]) ?? [];
        const model = regionalWaterModel({ sourceKey: 'lakeCells', basins,
            drainageConfig: rivers.length ? { carve: true } : null, drainagePlan: { rivers } }, this.radius, this.config.gridN);
        // Lakes already published keep their record objects (applied once).
        for (const [id, rec] of model.refined) {
            const old = L.recs.get(keys[id]);
            if (old && old.level === rec.level && old.maskCells === rec.maskCells) model.refined.set(id, old);
            else L.recs.set(keys[id], rec);
        }
        Object.assign(this, model);
        this.version++;
    }

    update(cameraPosition) {
        if (this._lakeCells) {
            if (cameraPosition) {
                const o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
                const v = [cameraPosition.x - o.x, cameraPosition.y - o.y, cameraPosition.z - o.z], l = Math.hypot(...v) || 1;
                this._camDir = [v[0] / l, v[1] / l, v[2] / l];
            }
            if (this.state === 'ready') { this._tickLakeCells(); this._tickLakeCellRivers(); }
            return;
        }
        if (cameraPosition) {
            const o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
            const v = [cameraPosition.x - o.x, cameraPosition.y - o.y, cameraPosition.z - o.z], l = Math.hypot(...v) || 1;
            this._camDir = [v[0] / l, v[1] / l, v[2] / l];
        }
        if (this.state !== 'ready' || this._busy || !this.config.refine.enabled || !cameraPosition) return;
        const now = performance.now();
        const origin = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const p = [cameraPosition.x - origin.x, cameraPosition.y - origin.y, cameraPosition.z - origin.z];
        // Look ahead along the camera's motion.
        let ahead = p;
        if (this._lastCam && now > this._lastCam.t) {
            const dt = Math.min(1, (now - this._lastCam.t) / 1000), k = this.config.refine.lookAheadS / Math.max(dt, 1e-3);
            ahead = [p[0] + (p[0] - this._lastCam.p[0]) * k, p[1] + (p[1] - this._lastCam.p[1]) * k, p[2] + (p[2] - this._lastCam.p[2]) * k];
        }
        if (!this._lastCam || now - this._lastCam.t > 250) this._lastCam = { p, t: now };
        const l = Math.hypot(...ahead) || 1;
        const dir = [ahead[0] / l, ahead[1] / l, ahead[2] / l];
        const radiusM = this.config.refine.radiusM;
        let best = null;
        for (const lake of this.lakes) {
            if (this.rep(lake.id) !== lake.id) continue;
            const d = this._lakeDistance(lake, dir);
            if (d > radiusM) continue;
            if (!this.refined.has(lake.id) && !this._failed.has(lake.id) && (!best || d < best.d)) best = { d, lake: lake.id };
        }
        // Rivers by their own distance (a river passing the camera can come
        // from a lake far away: ChatGPT review 2026-10-05).
        if (this.config.rivers.enabled) {
            for (const r of this.rivers) {
                const rid = r.id;
                if (this.riverRecs.has(rid) || this._failedRivers.has(rid) || this.rep(r.fromLake) !== r.fromLake) continue;
                const dr = this._riverDistance(rid, dir);
                if (dr <= radiusM && (!best || dr < best.d)) best = { d: dr, river: rid };
            }
        }
        if (!best) return;
        if (best.lake !== undefined) this.refineLake(best.lake);
        else this.refineRiver(best.river);
    }

    /** Distance (m) from a unit direction to a river's graph cells. */
    _riverDistance(rid, dir) {
        this._riverCellDirs ??= new Map();
        let dirs = this._riverCellDirs.get(rid);
        if (!dirs) {
            const N = this.config.gridN;
            dirs = Array.from(this.rivers[rid].cells ?? [], c => cellDir(c, N));   // cells: Int32Array
            this._riverCellDirs.set(rid, dirs);
        }
        let best = -1;
        for (const d of dirs) best = Math.max(best, d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]);
        return Math.acos(Math.max(-1, Math.min(1, best))) * this.radius;
    }

    /**
     * Precompute (refine.precompute): every lake solved once, nearest to the
     * camera first (re-ranked after each lake), then the downstream routes
     * once for all. Holds _busy throughout, so rivers start after it.
     */
    async _precomputeLakes() {
        const t0 = performance.now();
        const R = this.config.refine;
        let solved = 0, cached = 0;
        // Floods in a pool of workers (waterWorkerCore solvePatchLake); the
        // graph worker adopts them in dispatch order, so merges come out as
        // a one-worker precompute along the same camera path would make them.
        const poolSize = R.workers > 0 ? R.workers : Math.max(1, Math.min(6, (globalThis.navigator?.hardwareConcurrency ?? 4) - 3));
        const pool = Array.from({ length: poolSize }, () => new WorkerClient(this._useWorker));
        const free = [...pool], waiters = [];
        const takeWorker = () => (free.length ? Promise.resolve(free.pop()) : new Promise(r => waiters.push(r)));
        const releaseWorker = (w) => { const r = waiters.shift(); if (r) r(w); else free.push(w); };
        const others = new Float64Array(this.lakes.length * 4);
        this.lakes.forEach((l, k) => others.set([l.id, l.centreDir[0], l.centreDir[1], l.centreDir[2]], 4 * k));
        const lakeKey = (id) => `lake:${this._key}:${R.spacingM}:${R.bandM}:crop:${id}`;
        const pending = new Set(this.lakes.map(l => l.id));
        const results = new Map();   // dispatch seq -> { id, rec, fromCache } | { id, failed }
        let seqNext = 0, adoptNext = 0;
        const pick = () => {
            let best = -1, bestD = Infinity;
            for (const id of pending) {
                if (this.rep(id) !== id || this.refined.has(id) || this._failed.has(id)) { pending.delete(id); continue; }
                const d = this._camDir ? this._lakeDistance(this.lakes[id], this._camDir) : id;
                if (d < bestD) { bestD = d; best = id; }
            }
            return best;
        };
        const runJob = async (id, seq) => {
            try {
                const hit = this.config.cache ? await this._cache.get(lakeKey(id)) : null;
                if (hit) { results.set(seq, { id, rec: hit, fromCache: true }); return; }
                let frame = limitPatchCells(this.lakes[id].frame, R.maxCells);
                for (let grows = 0; ; grows++) {
                    const heights = await this._sampler.samplePatch(frame, this.radius);
                    const worker = await takeWorker();
                    let rec;
                    try {
                        rec = await worker.call({ type: 'solvePatchLake', lakeId: id, frame, heights, bandM: R.bandM, N: this.N, R: this.radius,
                            lakeCells: this.lakeCells.subarray(this.lakeCellStart[id], this.lakeCellStart[id + 1]), others }, [heights.buffer]);
                    } finally { releaseWorker(worker); }
                    if (rec.status === 'ok') { results.set(seq, { id, rec }); return; }
                    if (rec.status !== 'grow' || grows >= R.maxGrows) { results.set(seq, { id, failed: rec.status }); return; }
                    frame = limitPatchCells(growPatchFrame(frame, 1.6), R.maxCells);
                }
            } catch (err) {
                Logger.warn(`[Water] lake ${id} precompute failed: ${err?.message || err}`);
                results.set(seq, { id, failed: 'error' });
            }
        };
        const adoptReady = async () => {
            while (results.has(adoptNext)) {
                const { id, rec, fromCache, failed } = results.get(adoptNext);
                results.delete(adoptNext++);
                if (failed) { this._failed.add(id); continue; }
                if (this.rep(id) !== id) continue;
                if (fromCache) {
                    await this._client.call({ type: 'restoreLake', lakeId: id, level: rec.level, exitDir: rec.exitDir, merged: rec.merged,
                        frame: rec.frame, mask: rec.mask, outflowDirs: rec.outflowDirs, skipDownstream: true });
                    cached++;
                } else {
                    const a = await this._client.call({ type: 'adoptLake', lakeId: id, level: rec.level, exitDir: rec.exitDir,
                        outflowDirs: rec.outflowDirs, frame: rec.frame, mask: rec.mask, candidates: rec.candidates });
                    if (a.status !== 'ok') { this.mergedInto.set(id, a.into); continue; }
                    rec.merged = a.merged;
                    delete rec.candidates;
                    if (this.config.cache) this._cache.put(lakeKey(id), rec);
                }
                await this._apply(id, rec);
                if (++solved === 1) this.timings.firstLakeMs = performance.now() - t0;
            }
        };
        // Mountain pocket discovery and solving only depend on the original
        // graph and natural terrain. Run them alongside graph-lake refinement;
        // their drainage still waits for all graph-lake masks below.
        let graphComplete;
        const graphReady = new Promise(resolve => { graphComplete = resolve; });
        const mountainJob = this._mountainBlocks
            ? this._mountainLakes({ takeWorker, releaseWorker, poolSize, graphReady }).then(() => null, error => error)
            : null;
        try {
            const running = new Set();
            for (;;) {
                // One job beyond the pool: its patch samples while the pool floods.
                while (running.size < (this._loading?.() ? 1 : poolSize) + 1) {
                    const id = pick();
                    if (id < 0) break;
                    pending.delete(id);
                    const job = runJob(id, seqNext++).then(() => running.delete(job));
                    running.add(job);
                }
                if (!running.size) break;
                await Promise.race(running);
                await adoptReady();
            }
            await adoptReady();
            this.timings.precomputeWorkers = poolSize;
            this.timings.lakesMs = performance.now() - t0;
            graphComplete();
            const mountainError = await mountainJob;
            if (mountainError) throw mountainError;
            const { downstream } = await this._client.call({ type: 'downstream' });
            for (const [lid, down] of Object.entries(downstream)) {
                const r = this.refined.get(Number(lid));
                if (r) r.downstream = down;
            }
        } finally {
            graphComplete();
            // Do not terminate shared workers while mountain jobs use them.
            if (mountainJob) await mountainJob;
            for (const w of pool) w.terminate();
            this.timings.precomputeMs = performance.now() - t0;
            this.precomputed = true;
            this._busy = false;
            this.version++;
        }
        Logger.info(`[Water] lakes precomputed: ${solved} solved (${cached} from cache), ${this.mergedInto.size} merged, ` +
            `${this._failed.size} failed, ${this.timings.precomputeMs.toFixed(0)} ms`);
        if (this.config.sim?.enabled !== false) this._sampler.warmCarved?.().catch(() => {});
    }

    /**
     * Small mountain lakes (mountainLakes.js), inside the precompute: pockets
     * of the mountain blocks (64 m floods, nearest blocks first), chosen by
     * setting, outflow drop and spacing, solved at 32 m, then added as lakes
     * after the graph's (ids from lakes.length; no graph river of their own
     * yet). The solved lakes are cached as one record.
     */
    async _mountainLakes({ takeWorker, releaseWorker, poolSize, graphReady = Promise.resolve() }) {
        const t0 = performance.now();
        const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...this.config.refine.mountain };
        const N = this.N, Rp = this.radius, sea = this._sampler.seaLevelM, NN = N * N;
        const base = this.lakes.length;
        const key = `mlakes:${this._key}:${hashParts([MOUNTAIN_LAKE_VERSION, P, this.config.refine.bandM])}`;
        let solved = this.config.cache ? await this._cache.get(key) : null;
        const fromCache = !!solved;
        const runBounded = async (items, job) => {
            const running = new Set();
            let failure = null;
            try {
                for (const item of items) {
                    while (running.size >= (this._loading?.() ? 1 : poolSize) + 1) {
                        await Promise.race(running);
                        if (failure) throw failure;
                    }
                    const p = Promise.resolve().then(() => job(item)).catch(error => { failure ??= error; }).finally(() => running.delete(p));
                    running.add(p);
                }
                await Promise.all(running);
                if (failure) throw failure;
            } catch (error) {
                await Promise.allSettled(running);
                throw error;
            }
        };
        if (!solved) {
            // Keep one ordering for dispatch and registration even if the
            // camera moves while workers are solving the selected pockets.
            const originDir = this._camDir?.slice();
            const dist = (d) => (originDir ? Math.acos(Math.max(-1, Math.min(1, d[0] * originDir[0] + d[1] * originDir[1] + d[2] * originDir[2]))) : 0);
            const blocks = this._mountainBlocks.map(b => ({ ...b, frame: mountainBlockFrame(b, N, Rp, P.discoverySpacingM, P) }))
                .sort((a, b) => dist(a.frame.c) - dist(b.frame.c));
            const B = P.blockCells, cands = [];
            const pending = new Map(blocks.map(b => {
                const f = b.frame;
                const x = Math.max(Math.abs(f.x0), Math.abs(f.x0 + f.nx * f.spacing));
                const y = Math.max(Math.abs(f.y0), Math.abs(f.y0 + f.ny * f.spacing));
                return [b, { c: f.c, pointRadiusM: Math.hypot(x, y), maxRadiusM: Math.sqrt(f.nx * f.ny / Math.PI) * f.spacing }];
            }));
            const empty = new Float64Array(0), early = [];
            solved = [];
            let earlyChain = Promise.resolve(), earlyError = null, discovered = 0;
            const solvePocket = async p => {
                let frame = pocketSolveFrame(p, Rp, P);
                for (let grows = 0; grows <= 2; grows++) {
                    const heights = await this._sampler.samplePatch(frame, Rp);
                    const worker = await takeWorker();
                    let rec;
                    try { rec = await worker.call({ type: 'solvePatchLake', lakeId: -1, frame, heights, bandM: this.config.refine.bandM, N, R: Rp, seedDir: p.dir, others: empty }, [heights.buffer]); }
                    finally { releaseWorker(worker); }
                    if (rec.status === 'ok') return { dir: p.dir, rec, path: p.path, pathH: p.pathH, pits: p.pits };
                    if (rec.status !== 'grow') break;
                    frame = growPatchFrame(frame, 1.6);
                }
                return null;
            };
            const publishSolved = items => {
                const ready = items.filter(Boolean);
                if (!ready.length) return;
                solved.push(...ready);
                this._addLakes(ready.map(value => ({ dir: value.dir, rec: value.rec, mountain: true })));
                this.timings.firstMountainLakeMs ??= performance.now() - t0;
            };
            const startSettled = () => {
                const started = performance.now();
                const prefix = settledMountainPrefix(cands, [...pending.values()], originDir, Rp, P);
                this.timings.mountainSelectionLongestMs = Math.max(this.timings.mountainSelectionLongestMs ?? 0, performance.now() - started);
                for (let i = 0; i < early.length; i++) {
                    if (prefix[i]?.dir !== early[i].dir) throw new Error('settled mountain lake prefix changed');
                }
                for (const p of prefix.slice(early.length, 12)) {
                    early.push(p);
                    earlyChain = earlyChain.then(async () => {
                        if (!earlyError) try { publishSolved([await solvePocket(p)]); } catch (error) { earlyError = error; }
                    });
                }
            };
            const owns = (b, cell) => { const f = Math.floor(cell / NN), k = cell % NN; return f === b.f && Math.floor((k % N) / B) === b.bi && Math.floor(Math.floor(k / N) / B) === b.bj; };
            // Not in a graph lake, and clear of the graph's river cells (their
            // traces run through such pockets).
            const clear = (cell) => {
                if (this.lakeOf[cell] !== -1 || this.riverOf[cell] !== -1) return false;
                return true;
            };
            try {
                await runBounded(blocks, async (b) => {
                    const heights = await this._sampler.samplePatch(b.frame, Rp);
                    const worker = await takeWorker();
                    let r;
                    try { r = await worker.call({ type: 'findPockets', frame: b.frame, heights, R: Rp, seaLevelM: sea, params: P }, [heights.buffer]); }
                    finally { releaseWorker(worker); }
                    for (const p of r.pockets) { const cell = dirToCell(p.dir, N); if (owns(b, cell) && clear(cell)) cands.push(p); }
                    pending.delete(b);
                    discovered++;
                    // Only inspect the first local blocks: if no choice is yet
                    // provable, normal global discovery remains the fallback.
                    if (discovered <= 128 && discovered % 8 === 0 && early.length < 12) startSettled();
                });
            } catch (error) {
                await earlyChain;
                throw error;
            }
            this.timings.mountainDiscoveryMs = performance.now() - t0;
            const picks = chooseMountainLakes(cands, Rp, P).sort((a, b) => dist(a.dir) - dist(b.dir) || a.dir[0] - b.dir[0] || a.dir[1] - b.dir[1]);
            await earlyChain;
            if (earlyError) throw earlyError;
            for (let i = 0; i < early.length; i++) if (picks[i]?.dir !== early[i].dir) throw new Error('early mountain lake choice differs from full discovery');
            // Register completed lakes in dispatch order, so nearby lakes
            // can render while more distant pockets are still being solved.
            // Worker completion order must not assign lake IDs.
            const completed = new Map();
            let next = 0;
            await runBounded(picks.slice(early.length).map((p, i) => ({ p, i })), async ({ p, i }) => {
                const item = await solvePocket(p);
                completed.set(i, item);
                const ready = [];
                while (completed.has(next)) {
                    const value = completed.get(next);
                    completed.delete(next++);
                    if (value) ready.push(value);
                }
                publishSolved(ready);
            });
            this.mountainStats = { blocks: blocks.length, candidates: cands.length, picks: picks.length, solved: solved.length, early: early.length };
        }
        if (fromCache) {
            this._addLakes(solved.map(({ dir, rec }) => ({ dir, rec, mountain: true })));
            // Absorbed mountain IDs are retained for stable stream IDs, but
            // they must not be rendered or considered separate water.
            solved.forEach((it, k) => {
                const to = it.aliasLakeId ?? (it.aliasOf != null ? base + it.aliasOf : null);
                if (to != null) { this.mergedInto.set(base + k, to); this.refined.delete(base + k); }
            });
        }
        // Drainages and joins use the complete set of graph lakes.
        await graphReady;
        // Streams follow each lake's fine drainage (from its sill, 64 m) to
        // the first lower water on it; the graph worker takes them as rivers
        // (waterWorkerCore addLakes). A drainage that left its discovery
        // patch dry continues on patches ahead of its end, then the whole
        // set (lakes and drainages) is cached.
        let walk = this._mountainDrainWalk(solved, base, P);
        if (!fromCache) {
            const t1 = performance.now();
            let extended = 0;
            const stuck = new Set();
            for (let round = 0; round < P.drainRounds; round++) {
                const open = solved.map((_, k) => k).filter(k => !stuck.has(k) && walk(k).open);
                if (!open.length) break;
                await runBounded(open, async (k) => {
                    const it = solved[k], end = it.path.at(-1), prev = it.path.at(-2) ?? it.dir;
                    const frame = drainFrame(end, prev, Rp, P);
                    const heights = await this._sampler.samplePatch(frame, Rp);
                    const worker = await takeWorker();
                    let r;
                    try { r = await worker.call({ type: 'continueDrain', frame, heights, R: Rp, start: end, params: P }, [heights.buffer]); }
                    finally { releaseWorker(worker); }
                    if (!r.path.length) stuck.add(k);
                    const off = it.path.length;
                    it.pits = (it.pits ?? []).concat(r.pits.map(t => ({ ...t, entry: Math.max(0, t.entry + off), exit: t.exit + off })));
                    it.path.push(...r.path); it.pathH.push(...r.pathH);
                    extended++;
                });
            }
            // Ponds: the hollows the drainages cross before their streams end
            // fill to their spill (owner 2026-10-12: ponds, constrictions are
            // wanted); a stream ends in its pond, and the pond's own stream
            // follows the rest of the drainage. Cutting through the rims made
            // slots up to tens of metres deep (52 % of the streams crossed a
            // hollow, 411 of them by over 12 m: water-look v33).
            this.timings.mountainContinuationMs = performance.now() - t1;
            let ponds = await this._mountainPonds(solved, walk, P, { runBounded, takeWorker, releaseWorker });
            ponds = await this._mergeMountainPonds(solved, ponds, base, P, { takeWorker, releaseWorker });
            ponds = await this._finishMergedPonds(solved, ponds, base, P, { runBounded, takeWorker, releaseWorker });
            this._absorbGraphSubmergedMountains(solved, base);
            if (ponds.length) {
                solved.push(...ponds);
                this._addLakes(ponds.map(({ dir, rec }) => ({ dir, rec, mountain: true })));
                walk = this._mountainDrainWalk(solved, base, P);
            }
            this.mountainStats.ponds = ponds.length;
            // Keep each drainage only up to its stream's end (the walk
            // repeats it from the cache).
            const ends = { stream: 0, long: 0, open: 0, none: 0 };
            solved.forEach((it, k) => {
                const w = walk(k), n = w.stream?.dirs.length ?? 0;
                ends[w.stream ? 'stream' : w.long ? 'long' : w.open ? 'open' : 'none']++;
                it.path = it.path.slice(0, n); it.pathH = it.pathH.slice(0, n);
                delete it.pits;
            });
            this.mountainStats.drainEnds = ends;
            this.timings.mountainDrainMs = performance.now() - t1;
            this.mountainStats.drainPatches = extended;
            if (this.config.cache) this._cache.put(key, solved);
        }
        const streams = this._joinMountainStreams(solved, walk, P, this.rivers.length), ends = { stream: 0, long: 0, open: 0, none: 0, joined: 0 };
        solved.forEach((_, k) => { const w = walk(k); ends[w.stream ? 'stream' : w.long ? 'long' : w.open ? 'open' : 'none']++; });
        ends.joined = streams.filter(st => st.to.type === 'river' && st.to.dir).length;
        this.mountainStreamEnds = ends;
        const added = await this._client.call({ type: 'addLakes', maxRouteM: P.maxStreamM, streams, streamCorridorM: P.streamCorridorM,
            lakes: solved.map(({ dir, rec }) => ({
                level: rec.level, maxDepth: rec.maxDepth, exitDir: rec.exitDir, outflowDirs: rec.outflowDirs,
                frame: rec.frame, mask: rec.mask, maskCells: rec.maskCells, deepestDir: dir })) });
        for (const r of added.rivers) {
            if (r.id !== this.rivers.length) throw new Error(`mountain stream id ${r.id} != ${this.rivers.length}`);
            this.rivers.push({ ...r, mountain: true });
            this.lakes[r.fromLake].river = r.id;
        }
        this.mountainStreams = added.rivers.length;
        this.timings.mountainMs = performance.now() - t0;
        Logger.info(`[Water] mountain lakes: ${solved.length} ${fromCache ? 'from cache' : `solved (${JSON.stringify(this.mountainStats)})`}, ` +
            `${added.rivers.length} streams, ${this.timings.mountainMs.toFixed(0)} ms`);
    }

    /**
     * Ponds of the mountain lakes' drainages (mountainLakes.js drainPath
     * pits): hollows at least pondMinDepthM deep below the source lake that
     * a drainage crosses before its stream ends, not already lake water, one
     * per hollow (first drainage, in the cached order). Solved at the solve
     * spacing from their deepest point on the path; each takes the rest of
     * that drainage (from the hollow's exit) as its own.
     * @returns {Promise<object[]>} solved items { dir, rec, path, pathH, pits, pond }
     */
    async _mountainPonds(solved, walk, P, { runBounded, takeWorker, releaseWorker, only = null }) {
        const t0 = performance.now();
        const Rp = this.radius, picks = [], cell = (d) => d.map(x => Math.floor(x * Rp / 300)).join(',');
        const seen = new Map();
        solved.forEach((it, k) => {
            if (only && !only.has(k)) return;
            const end = walk(k).end;
            for (const t of it.pits ?? []) {
                if (t.entry >= end || t.depth < P.pondMinDepthM || !(t.level < it.rec.level - 0.5) || walk.waterAt(t.dir)) continue;
                const c = cell(t.dir), near = (seen.get(c) ?? []).some(q => Math.acos(Math.min(1, q.dir[0] * t.dir[0] + q.dir[1] * t.dir[1] + q.dir[2] * t.dir[2])) * Rp < 300 && Math.abs(q.level - t.level) < 2);
                if (near) continue;
                const pick = { ...t, path: it.path.slice(t.exit), pathH: it.pathH.slice(t.exit),
                    pits: (it.pits ?? []).filter(q => q.entry >= t.exit).map(q => ({ ...q, entry: q.entry - t.exit, exit: q.exit - t.exit })) };
                picks.push(pick);
                for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
                    const q = c.split(',').map(Number), key = [q[0] + a, q[1] + b, q[2] + e].join(',');
                    if (!seen.has(key)) seen.set(key, []);
                    seen.get(key).push(t);
                }
            }
        });
        this.timings.mountainPondSelectMs = performance.now() - t0;
        const empty = new Float64Array(0), out = [];
        await runBounded(picks, async (t) => {
            const half = Math.max(500, t.cells * P.discoverySpacingM * 0.6 + P.solveMarginM), s = P.solveSpacingM, n = Math.ceil(2 * half / s);
            let frame = { c: t.dir, ...tangentBasis(t.dir), spacing: s, x0: -n * s / 2, y0: -n * s / 2, nx: n, ny: n };
            for (let grows = 0; grows <= 2; grows++) {
                const heights = await this._sampler.samplePatch(frame, Rp);
                const worker = await takeWorker();
                let rec;
                try { rec = await worker.call({ type: 'solvePatchLake', lakeId: -1, frame, heights, bandM: this.config.refine.bandM, N: this.N, R: Rp, seedDir: t.dir, others: empty }, [heights.buffer]); }
                finally { releaseWorker(worker); }
                if (rec.status === 'ok') { out.push({ dir: t.dir, rec, path: t.path, pathH: t.pathH, pits: t.pits, pond: true }); return; }
                if (rec.status !== 'grow') return;
                frame = growPatchFrame(frame, 1.6);
            }
        });
        this.timings.mountainPondSolveMs = performance.now() - t0 - this.timings.mountainPondSelectMs;
        const dedupStart = performance.now();
        // Registration order must not depend on worker timing; a pond whose
        // seed lies in an earlier pond's water is that pond.
        out.sort((a, b) => a.dir[0] - b.dir[0] || a.dir[1] - b.dir[1] || a.dir[2] - b.dir[2]);
        const kept = [];
        for (const p of out) {
            const inside = kept.some(({ rec }) => {
                const f = rec.frame, k = p.dir[0] * f.c[0] + p.dir[1] * f.c[1] + p.dir[2] * f.c[2];
                if (k <= 0 || Math.abs(rec.level - p.rec.level) > 0.05) return false;
                const [x, y] = dirToPlane(p.dir, f, Rp), i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                return i >= 0 && j >= 0 && i < f.nx && j < f.ny && rec.mask[j * f.nx + i] === 2;
            });
            if (!inside) kept.push(p);
        }
        const visible = await this._resolvePondOverlaps(kept, P, { takeWorker, releaseWorker });
        this.timings.mountainPondDedupMs = performance.now() - dedupStart;
        this.mountainStats.mergedPonds = (this.mountainStats.mergedPonds ?? 0) + kept.length - visible.length;
        return visible;
    }

    // A re-solved pond has a new spillway. Continue that drainage just like
    // the original mountain outlets, then fill any new hollows it crosses.
    // Pond masks are visible to the walk before publication, so a drainage
    // stops at another pond without publishing a transient overlapping lake.
    async _finishMergedPonds(solved, input, base, P, workers) {
        const { runBounded, takeWorker, releaseWorker } = workers, Rp = this.radius;
        let ponds = input, extended = 0, added = 0;
        const processed = new WeakSet();
        for (let round = 0; round < 8; round++) {
            const pending = [...solved, ...ponds].filter(p => p.mergedPond && p.aliasOf == null && !processed.has(p));
            if (!pending.length) break;
            const all = [...solved, ...ponds], walk = this._mountainDrainWalk(all, base, P, ponds);
            const indexes = pending.map(p => all.indexOf(p)), stuck = new Set();
            for (let n = 0; n < P.drainRounds; n++) {
                const open = indexes.filter(k => !stuck.has(k) && walk(k).open);
                if (!open.length) break;
                await runBounded(open, async k => {
                    const it = all[k], end = it.path.at(-1), prev = it.path.at(-2) ?? it.dir;
                    const frame = drainFrame(end, prev, Rp, P), heights = await this._sampler.samplePatch(frame, Rp);
                    const worker = await takeWorker();
                    let r;
                    try { r = await worker.call({ type: 'continueDrain', frame, heights, R: Rp, start: end, params: P }, [heights.buffer]); }
                    finally { releaseWorker(worker); }
                    if (!r.path.length) stuck.add(k);
                    const off = it.path.length;
                    it.pits = (it.pits ?? []).concat(r.pits.map(t => ({ ...t, entry: Math.max(0, t.entry + off), exit: t.exit + off })));
                    it.path.push(...r.path); it.pathH.push(...r.pathH); extended++;
                });
            }
            pending.forEach(p => processed.add(p));
            const extra = await this._mountainPonds(all, walk, P, { ...workers, only: new Set(indexes) });
            if (extra.length) {
                added += extra.length;
                ponds = await this._resolvePondOverlaps([...ponds, ...extra], P, { takeWorker, releaseWorker });
                ponds = await this._mergeMountainPonds(solved, ponds, base, P, { takeWorker, releaseWorker });
            }
        }
        this.mountainStats.mergedDrainPatches = extended;
        this.mountainStats.mergedDrainPonds = added;
        this.mountainStats.pendingMergedDrains = [...solved, ...ponds].filter(p => p.mergedPond && p.aliasOf == null && !processed.has(p)).length;
        return ponds;
    }

    // Mountain lakes can have been displayed already. Keep their stable IDs
    // while replacing their masks and making absorbed IDs aliases; cache the
    // aliases so a reload has precisely the same water and stream identities.
    async _mergeMountainPonds(solved, input, base, P, workers) {
        let ponds = input, merged = 0;
        for (let pass = 0; pass < 8; pass++) {
            const mountains = solved.map((item, index) => ({ item, index })).filter(x => x.item.aliasOf == null);
            const all = [...mountains.map(x => x.item), ...ponds], n = mountains.length;
            const groups = pondOverlapGroups(all, this.radius).filter(g => g.some(i => i < n) && (g.length > 1));
            if (!groups.length) break;
            const removed = new Set(); let changed = 0;
            for (const group of groups) {
                const originals = group.filter(i => i < n).map(i => mountains[i].index);
                const result = await this._resolvePondOverlaps(group.map(i => all[i]), P, workers);
                if (result.length !== 1) continue;
                const rep = Math.min(...originals), item = { ...result[0], pond: false }, aliases = originals.filter(i => i !== rep);
                item.rec.merged = aliases.map(i => base + i);
                solved[rep] = item;
                for (const i of aliases) {
                    const old = solved[i];
                    solved[i] = { ...old, aliasOf: rep, mergedPond: false, path: [], pathH: [], pits: [],
                        rec: { ...old.rec, mask: new Uint8Array(old.rec.mask.length), maskCells: new Int32Array(0) } };
                }
                await this._apply(base + rep, item.rec);
                Object.assign(this.lakes[base + rep], { level: item.rec.level, maxDepth: item.rec.maxDepth,
                    centreDir: item.dir, frame: item.rec.patchFrame ?? item.rec.frame, cellCount: item.rec.maskCells.length });
                for (const i of group) if (i >= n) removed.add(i - n);
                changed++; merged += group.length - 1;
            }
            ponds = ponds.filter((_, i) => !removed.has(i));
            if (!changed) break;
            this._rebuildMountainCells(solved, base);
        }
        this.mountainStats.mergedMountainOverlaps = (this.mountainStats.mergedMountainOverlaps ?? 0) + merged;
        return ponds;
    }

    _rebuildMountainCells(solved, base) {
        const lists = this.lakes.map((_, id) => id >= base && id < base + solved.length
            ? solved[id - base].rec.maskCells
            : this.lakeCells.subarray(this.lakeCellStart[id], this.lakeCellStart[id + 1]));
        const start = new Int32Array(lists.length + 1);
        lists.forEach((list, i) => { start[i + 1] = start[i] + list.length; });
        const cells = new Int32Array(start.at(-1));
        lists.forEach((list, i) => cells.set(list, start[i]));
        this.lakeCells = cells; this.lakeCellStart = start; this.version++;
    }

    // A graph lake is already authoritative for its water and its graph
    // rivers. If a lower mountain pocket lies entirely within it, absorb the
    // pocket into that lake, keeping its ID as an alias. Allow only a small
    // sampled shoreline discrepancy next to the graph lake's wet cells.
    _absorbGraphSubmergedMountains(solved, base) {
        const Rp = this.radius;
        const extent = f => Math.hypot(Math.max(Math.abs(f.x0), Math.abs(f.x0 + f.nx * f.spacing)),
            Math.max(Math.abs(f.y0), Math.abs(f.y0 + f.ny * f.spacing)));
        const graphs = [...this.refined].filter(([id, r]) => id < base && this.rep(id) === id && r.frame && r.mask)
            .map(([id, rec]) => ({ id, rec, extent: extent(rec.frame) }));
        let absorbed = 0;
        for (let k = 0; k < solved.length; k++) {
            const item = solved[k];
            if (item.aliasOf != null || item.aliasLakeId != null) continue;
            const f = item.rec.frame, bound = extent(f), mask = item.rec.mask;
            for (const graph of graphs) {
                const g = graph.rec.frame;
                if (!(graph.rec.level > item.rec.level) || Math.hypot(f.c[0] - g.c[0], f.c[1] - g.c[1], f.c[2] - g.c[2]) * Rp > bound + graph.extent + 1 ||
                    !patchRectsMayOverlap(f, g, Rp)) continue;
                let wet = 0, covered = 0, boundary = 0;
                const wetAt = (a, b) => a >= 0 && b >= 0 && a < g.nx && b < g.ny && graph.rec.mask[b * g.nx + a] === 2;
                for (let q = 0; q < mask.length; q++) {
                    if (mask[q] !== 2) continue;
                    wet++;
                    const d = planeToDir(f.x0 + (q % f.nx + .5) * f.spacing, f.y0 + (Math.floor(q / f.nx) + .5) * f.spacing, f, Rp);
                    const den = d[0] * g.c[0] + d[1] * g.c[1] + d[2] * g.c[2];
                    if (den <= 0) continue;
                    const [x, y] = dirToPlane(d, g, Rp), i = Math.floor((x - g.x0) / g.spacing), j = Math.floor((y - g.y0) / g.spacing);
                    if (wetAt(i, j)) { covered++; continue; }
                    let near = false;
                    for (let y2 = -2; y2 <= 2 && !near; y2++) for (let x2 = -2; x2 <= 2; x2++) if (wetAt(i + x2, j + y2)) { near = true; break; }
                    if (near) boundary++;
                }
                if (!wet || covered < wet * 0.97 || covered + boundary !== wet) continue;
                const id = base + k;
                solved[k] = { ...item, aliasLakeId: graph.id, mergedPond: false, path: [], pathH: [], pits: [],
                    rec: { ...item.rec, mask: new Uint8Array(mask.length), maskCells: new Int32Array(0) } };
                this.mergedInto.set(id, graph.id); this.refined.delete(id); absorbed++;
                break;
            }
        }
        if (absorbed) this._rebuildMountainCells(solved, base);
        this.mountainStats.graphSubmergedMountains = absorbed;
    }

    // Re-solve genuinely overlapping ponds on a common grid, then rebuild the
    // drainage from that solution's actual spillway. Keep the originals if a
    // bounded solve cannot prove that all members share the same basin.
    async _resolvePondOverlaps(input, P, { takeWorker, releaseWorker }) {
        const Rp = this.radius, empty = new Float64Array(0), maxCells = this.config.refine.maxCells;
        let ponds = input, pass = 0, unresolved = 0;
        const solve = async members => {
            let frame = sharedPondFrame(members, Rp, P.solveSpacingM);
            const anchor = members.reduce((a, b) => a.rec.mask.length >= b.rec.mask.length ? a : b);
            for (let grow = 0; grow <= this.config.refine.maxGrows; grow++) {
                if (frame.nx * frame.ny > maxCells) return null;
                const heights = await this._sampler.samplePatch(frame, Rp);
                const worker = await takeWorker();
                let rec;
                try {
                    const h = heights.slice();
                    rec = await worker.call({ type: 'solvePatchLake', lakeId: -1, frame, heights: h,
                        bandM: this.config.refine.bandM, N: this.N, R: Rp, seedDir: anchor.dir, others: empty }, [h.buffer]);
                    if (rec.status === 'grow') { frame = growPatchFrame(frame, 1.6); continue; }
                    if (rec.status !== 'ok') return null;
                    const covers = member => {
                        const f = member.rec.frame, mask = member.rec.mask;
                        const wet = mask.reduce((n, value) => n + (value === 2 ? 1 : 0), 0);
                        if (!wet) return false;
                        // The first wet texel is usually on the shoreline and
                        // can move when the shared grid is sampled. Require
                        // most of each original basin, not that one edge cell.
                        const needed = Math.ceil(wet * 0.8);
                        let covered = 0;
                        for (let k = 0; k < mask.length; k++) {
                            if (mask[k] !== 2) continue;
                            const d = planeToDir(f.x0 + (k % f.nx + .5) * f.spacing, f.y0 + (Math.floor(k / f.nx) + .5) * f.spacing, f, Rp);
                            const den = d[0] * rec.frame.c[0] + d[1] * rec.frame.c[1] + d[2] * rec.frame.c[2];
                            if (den <= 0) continue;
                            const [x, y] = dirToPlane(d, rec.frame, Rp), i = Math.floor((x - rec.frame.x0) / rec.frame.spacing), j = Math.floor((y - rec.frame.y0) / rec.frame.spacing);
                            if (i >= 0 && j >= 0 && i < rec.frame.nx && j < rec.frame.ny && rec.mask[j * rec.frame.nx + i] === 2 && ++covered >= needed) return true;
                        }
                        return false;
                    };
                    let basins = [{ dir: anchor.dir, rec }];
                    if (!members.every(covers)) {
                        // Independent grids can make two adjacent basins
                        // overlap. Solve every seed on this same grid: truly
                        // separate basins remain separate, while identical
                        // connected solutions become one lake.
                        for (const member of members) {
                            if (member === anchor) continue;
                            const copy = heights.slice();
                            const other = await worker.call({ type: 'solvePatchLake', lakeId: -1, frame, heights: copy,
                                bandM: this.config.refine.bandM, N: this.N, R: Rp, seedDir: member.dir, others: empty }, [copy.buffer]);
                            if (other.status !== 'ok') return null;
                            const identical = basins.some(({ rec: a }) => {
                                const x = a.frame, y = other.frame;
                                return a.level === other.level && x.x0 === y.x0 && x.y0 === y.y0 && x.nx === y.nx && x.ny === y.ny &&
                                    a.mask.length === other.mask.length && a.mask.every((v, i) => v === other.mask[i]);
                            });
                            if (!identical) basins.push({ dir: member.dir, rec: other });
                        }
                        if (pondOverlapGroups(basins, Rp).length) return null;
                    }
                    const result = [];
                    for (const basin of basins) {
                        const h2 = heights.slice();
                        const drainage = await worker.call({ type: 'continueDrain', frame, heights: h2, R: Rp,
                            start: basin.rec.exitDir, params: P }, [h2.buffer]);
                        const [x, y] = dirToPlane(basin.rec.exitDir, frame, Rp), i = Math.max(0, Math.min(frame.nx - 1, Math.floor((x - frame.x0) / frame.spacing)));
                        const j = Math.max(0, Math.min(frame.ny - 1, Math.floor((y - frame.y0) / frame.spacing)));
                        result.push({ ...basin, path: [basin.rec.exitDir, ...drainage.path], pathH: [heights[j * frame.nx + i], ...drainage.pathH],
                            pits: drainage.pits.map(p => ({ ...p, entry: Math.max(0, p.entry + 1), exit: p.exit + 1 })), pond: true, mergedPond: true });
                    }
                    return result;
                } finally { releaseWorker(worker); }
            }
            return null;
        };
        while (pass++ < 8) {
            const groups = pondOverlapGroups(ponds, Rp);
            if (!groups.length) break;
            const results = [];
            // Large common patches are memory intensive: at most two at once.
            for (let i = 0; i < groups.length; i += 2) results.push(...await Promise.all(groups.slice(i, i + 2).map(g => solve(g.map(k => ponds[k])))));
            const replacement = new Map(), omitted = new Set();
            groups.forEach((g, i) => {
                if (!results[i]) { unresolved++; return; }
                replacement.set(g[0], results[i]);
                for (const k of g.slice(1)) omitted.add(k);
            });
            if (!replacement.size) break;
            ponds = ponds.flatMap((p, i) => omitted.has(i) ? [] : replacement.get(i) ?? [p]);
        }
        if (unresolved) Logger.warn(`[Water] could not prove a shared basin for ${unresolved} overlapping pond groups`);
        this.mountainStats.unresolvedPondGroups = pondOverlapGroups(ponds, Rp).length;
        return ponds;
    }

    /**
     * Walks a mountain lake's drainage (points from its sill): the first
     * point in the sea, in lower lake water (any solved lake's water mask)
     * or on a graph river's cell ends its stream. A river destination keeps
     * two more points, so the trace's corridor reaches the trunk's channel
     * inside that ~400 m cell. Longer than maxStreamM: no stream; ended dry
     * short of that: open (continued by the cold precompute). end: the path
     * point it stopped at. walk.waterAt(dir): the lake water there, if any.
     * @returns {(k: number) => { stream?: { lake, dirs, to, lengthM }, open?: boolean, long?: boolean, end: number }}
     */
    _mountainDrainWalk(solved, base, P, unpublished = []) {
        const N = this.N, Rp = this.radius, sea = this._sampler.seaLevelM, byCell = new Map();
        // Mountain masks may arrive while graph lakes are still being solved.
        // Preserve the original graph-first lookup order for overlapping masks.
        const records = [...this.refined].sort(([a], [b]) => Number(!!this.lakes[a]?.mountain) - Number(!!this.lakes[b]?.mountain));
        for (let i = 0; i < unpublished.length; i++) records.push([base + solved.length - unpublished.length + i, unpublished[i].rec]);
        const recordMap = new Map(records);
        for (const [id, rec] of records) {
            if (!rec.maskCells || !rec.mask) continue;
            for (const c of rec.maskCells) { let l = byCell.get(c); if (!l) byCell.set(c, (l = [])); l.push(id); }
        }
        const waterAt = (d, cell) => {
            for (const id of byCell.get(cell) ?? []) {
                const rec = recordMap.get(id), f = rec.frame, k = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
                if (k <= 0) continue;
                const [x, y] = dirToPlane(d, f, Rp);
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && rec.mask[j * f.nx + i] === 2) return { id, level: rec.level };
            }
            return null;
        };
        const walk = (k) => {
            const { rec, path = [], pathH = [] } = solved[k], id = base + k, dirs = [];
            if (solved[k].aliasOf != null || solved[k].aliasLakeId != null) return { end: 0 };
            let lengthM = 0;
            for (let p = 0; p < path.length; p++) {
                const d = path[p];
                if (dirs.length) { const a = dirs[dirs.length - 1]; lengthM += Math.acos(Math.min(1, a[0] * d[0] + a[1] * d[1] + a[2] * d[2])) * Rp; }
                if (lengthM > P.maxStreamM) return { long: true, end: p };
                dirs.push(d);
                if (pathH[p] <= sea) return { stream: { lake: k, dirs, to: { type: 'sea' }, lengthM }, end: p };
                const cell = dirToCell(d, N);
                const w = waterAt(d, cell);
                if (w && this.rep(w.id) !== id && w.level < rec.level - 0.5) return { stream: { lake: k, dirs, to: { type: 'lake', id: this.rep(w.id) }, lengthM }, end: p };
                if (this.riverOf[cell] !== -1) {
                    dirs.push(...path.slice(p + 1, p + 3));
                    return { stream: { lake: k, dirs, to: { type: 'river', id: this.riverOf[cell], cell }, lengthM }, end: p };
                }
            }
            return { open: path.length > 0, end: path.length };
        };
        walk.waterAt = (d) => waterAt(d, dirToCell(d, N));
        return walk;
    }

    /**
     * Streams of the mountain lakes, joined: drainages that meet run on as
     * one river. Taken in the cached order, a stream ends at its first point
     * within joinM of an earlier stream's route, as that stream's tributary
     * (two streams ran side by side down one valley, their ribbons meeting
     * in a seam: owner 2026-10-12, "a line in the middle of the river").
     * River ids follow from riverBase in this order (waterWorkerCore addLakes).
     */
    _joinMountainStreams(solved, walk, P, riverBase) {
        const N = this.N, Rp = this.radius, cellM = P.joinM;
        const cellOf = (d) => d.map(x => Math.floor(x * Rp / cellM));
        // Earlier streams' route segments (points are pathStepM apart, so
        // streams 30 m apart could stay over joinM from each other's points),
        // under the cells of both ends and the middle.
        const claimed = new Map(), streams = [];
        const claim = (q, e) => { const k = q.join(','); if (!claimed.has(k)) claimed.set(k, new Set()); claimed.get(k).add(e); };
        const near = (d) => {
            const q = cellOf(d);
            let best = null, bestM = cellM;
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
                for (const e of claimed.get(`${q[0] + a},${q[1] + b},${q[2] + c}`) ?? []) {
                    const u = e.b.map((x, i) => x - e.a[i]), w = d.map((x, i) => x - e.a[i]);
                    const t = Math.max(0, Math.min(1, (w[0] * u[0] + w[1] * u[1] + w[2] * u[2]) / ((u[0] * u[0] + u[1] * u[1] + u[2] * u[2]) || 1e-30)));
                    const p = e.a.map((x, i) => x + t * u[i]), m = Math.hypot(d[0] - p[0], d[1] - p[1], d[2] - p[2]) * Rp;
                    if (m < bestM) { bestM = m; const l = Math.hypot(...p); best = { rid: e.rid, dir: p.map(x => x / l) }; }
                }
            }
            return best;
        };
        solved.forEach((_, k) => {
            let st = walk(k).stream;
            if (!st) return;
            let lengthM = 0;
            for (let p = 0; p < st.dirs.length; p++) {
                const d = st.dirs[p];
                if (p) { const a = st.dirs[p - 1]; lengthM += Math.acos(Math.min(1, a[0] * d[0] + a[1] * d[1] + a[2] * d[2])) * Rp; }
                const e = near(d);
                if (e) { st = { lake: k, dirs: [...st.dirs.slice(0, p), e.dir], to: { type: 'river', id: e.rid, cell: dirToCell(e.dir, N), dir: e.dir }, lengthM }; break; }
            }
            const rid = riverBase + streams.length;
            streams.push(st);
            for (let p = 0; p + 1 < st.dirs.length; p++) {
                const a = st.dirs[p], b = st.dirs[p + 1], e = { rid, a, b };
                claim(cellOf(a), e); claim(cellOf(b), e); claim(cellOf(a.map((x, i) => (x + b[i]) / 2)), e);
            }
        });
        return streams;
    }

    /** Appends solved lakes that the graph does not hold (ids from lakes.length): summaries, grid cells, records. */
    _addLakes(items) {
        if (!items.length) return;
        const base = this.lakes.length, extra = items.reduce((n, it) => n + it.rec.maskCells.length, 0);
        const cells = new Int32Array(this.lakeCells.length + extra), start = new Int32Array(this.lakeCellStart.length + items.length);
        cells.set(this.lakeCells); start.set(this.lakeCellStart);
        let at = this.lakeCells.length;
        items.forEach(({ dir, rec, mountain }, k) => {
            const id = base + k;
            cells.set(rec.maskCells, at); at += rec.maskCells.length; start[id + 1] = at;
            this.lakes.push({ id, level: rec.level, maxDepth: rec.maxDepth, coreCells: 0, cellCount: rec.maskCells.length, outflowQ: 0,
                river: -1, downstream: null, centreDir: dir, frame: rec.patchFrame ?? rec.frame, mountain: !!mountain });
            rec.merged = []; rec.downstream = null; rec.status = 'ok';
            this.refined.set(id, rec);
        });
        this.lakeCells = cells; this.lakeCellStart = start;
        this.version++;
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
        const lakeKey = `lake:${this._key}:${R.spacingM}:${R.bandM}:${R.precompute ? 'crop:' : ''}${id}`;
        // Precompute: masks cropped to the water; routes once at the end.
        const pre = R.precompute ? { crop: true, skipDownstream: true } : {};
        try {
            let rec = this.config.cache ? await this._cache.get(lakeKey) : null;
            const fromCache = !!rec;
            if (rec) {
                const restored = await this._client.call({
                    type: 'restoreLake', lakeId: id, level: rec.level, exitDir: rec.exitDir, merged: rec.merged,
                    frame: rec.frame, mask: rec.mask, outflowDirs: rec.outflowDirs, ...pre,
                });
                rec.downstream = restored.downstream;
                rec.fromCache = true;
            } else {
                let frame = limitPatchCells(this.lakes[id].frame, R.maxCells);
                for (let grows = 0; ; grows++) {
                    const heights = await this._sampler.samplePatch(frame, this.radius);
                    rec = await this._client.call({ type: 'solveLake', lakeId: id, frame, heights, bandM: R.bandM, ...pre }, [heights.buffer]);
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
            await this._apply(id, rec);
            if (!fromCache && this.config.cache) {
                const { downstream: _downstream, ms: _ms, fromCache: _fc, ...stored } = rec;
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
        try {
            return await this._refineRiver(riverId, 0);
        } finally {
            this._busy = false;
        }
    }

    /** The traced point of rec nearest to unit direction d: { k, eta, hw }. */
    _riverPointNear(rec, d) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        let best = { k: 0, cos: -2 };
        for (let k = 0; k < n; k++) {
            const c = P[k * st] * d[0] + P[k * st + 1] * d[1] + P[k * st + 2] * d[2];
            if (c > best.cos) best = { k, cos: c };
        }
        return { k: best.k, eta: P[best.k * st + 3], hw: P[best.k * st + 4] };
    }

    async _refineRiver(riverId, depth) {
        if (this.riverRecs.has(riverId)) return this.riverRecs.get(riverId);
        if (this._failedRivers.has(riverId) || depth > 6) return null;
        const t0 = performance.now();
        const RC = this.config.rivers;
        // Streams of mountain lakes are narrower (mountainLakes.js streamShape).
        const shape = this.rivers[riverId].mountain
            ? { ...RC.shape, ...MOUNTAIN_LAKE_DEFAULTS.streamShape, ...this.config.refine.mountain?.streamShape } : RC.shape;
        try {
            const src = this.rivers[riverId].fromLake;
            if (this.rep(src) !== src) { this._failedRivers.add(riverId); return null; }
            await this._refineLake(src);
            const srcLevel0 = this.refined.get(src)?.level ?? this.lakes[src].level;
            let join = RC.confluences !== false;
            let plan = null, trunk = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                // The destination's level decides the route: refine it, then route again.
                for (let k = 0; k < 4; k++) {
                    plan = await this._client.call({ type: 'planRiver', riverId, spacing: RC.spacingM, corridorM: RC.corridorM, baseCorridorM: RC.corridorM, shape, join });
                    if (plan.status !== 'ok' || plan.dest.type !== 'lake' || this.refined.has(plan.dest.id)) break;
                    if (!(await this._refineLake(plan.dest.id))) break;
                }
                if (plan?.status !== 'ok' || plan.dest.type !== 'river') break;
                // A confluence: the trunk is traced first; this river ends in
                // its channel at its level there (lower than the source lake),
                // otherwise it is routed as before.
                const t = await this._refineRiver(plan.dest.id, depth + 1);
                // At the junction itself where it is known (mountain streams).
                const j = t && this._riverPointNear(t, plan.dest.dir ?? cellDir(plan.dest.cell, this.config.gridN));
                if (t && j.eta < srcLevel0 + RC.startToleranceM) {
                    const P = t.points, st = t.stride, n = P.length / st;
                    const dirs = new Float32Array(n * 3), hw = new Float32Array(n), etas = new Float32Array(n);
                    for (let k = 0; k < n; k++) { dirs.set([P[k * st], P[k * st + 1], P[k * st + 2]], 3 * k); hw[k] = P[k * st + 4]; etas[k] = P[k * st + 3]; }
                    trunk = { dirs, hw, eta: j.eta, etas, key: hashParts([P]) };
                    break;
                }
                join = false;
            }
            if (plan?.status !== 'ok') { this._failedRivers.add(riverId); return null; }
            const destKey = plan.dest.type === 'lake' ? `lake${plan.dest.id}` : plan.dest.type === 'river' ? `river${plan.dest.id}-${trunk.key}` : 'sea';
            const shapeKey = hashParts([
                RIVER_SOLVE_VERSION, shape, { ...RIVER_LEVEL_DEFAULTS, ...RC.levels },
                RC.stepM, RC.smoothPasses, this.config.carve,
            ]);
            // A lake can grow or merge after a river has been cached. IDs
            // alone do not identify its shoreline, exit or water level.
            const anchors = hashParts([this._lakeIdentity(src), plan.dest.type === 'lake' ? this._lakeIdentity(plan.dest.id) : destKey]);
            const riverKey = `river:${this._key}:${RC.spacingM}:${RC.corridorM}:${shapeKey}:${riverId}:${destKey}:${anchors}`;
            let rec = this.config.cache ? await this._cache.get(riverKey) : null;
            // Any refined basin in the solve patch can terminate this reach,
            // including one absent when the cached river was first traced.
            if (rec && rec.lakeDependencies !== this._riverLakeIdentity(rec.dependencyFrame)) rec = null;
            const fromCache = !!rec;
            if (!rec) {
                // A start above the source lake's level means the corridor
                // missed the water's lower way past a sill: retry wider.
                const srcLevel = this.refined.get(src)?.level ?? this.lakes[src].level;
                for (const corridorM of [RC.corridorM, RC.corridorM * RC.retryCorridorScale]) {
                    if (corridorM !== RC.corridorM) {
                        plan = await this._client.call({ type: 'planRiver', riverId, spacing: RC.spacingM, corridorM, baseCorridorM: RC.corridorM, shape, join: !!trunk });
                        if (plan.status !== 'ok') break;
                    }
                    const frame = limitPatchCells(plan.frame, this.config.refine.maxCells);
                    const heights = await this._sampler.samplePatch(frame, this.radius);
                    const CV = this.config.carve;
                    const r = await this._client.call({
                        type: 'solveRiver', riverId, frame, heights, shape,
                        levels: { ...RC.levels, waterFrac: CV.waterFrac },
                        // The carve's reach beyond the half-width (riverCarve.wgsl.js) + margin,
                        // the half-width as wide as the shape noise makes it.
                        reachM: CV.enabled ? RIVER_SECTION.reachM + 8 : 0,
                        reachScale: riverShapeMaxScale({ ...CV, bankDetail: 0 }),
                        stepM: RC.stepM, smoothPasses: RC.smoothPasses,
                        sub: RIVER_SUB,
                        trunk: trunk ? { dirs: trunk.dirs, hw: trunk.hw, eta: trunk.eta, etas: trunk.etas } : null,
                    }, [heights.buffer]);
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
                if (high && await this._resolveLakeIncluding(src, high)) return this._refineRiver(riverId, depth + 1);
            }
            if (!fromCache) rec.lakeDependencies = this._riverLakeIdentity(rec.dependencyFrame);
            if (!fromCache && this.config.cache) { const { ms: _ms, ...stored } = rec; this._cache.put(riverKey, stored); }
            this.riverRecs.set(riverId, rec);
            this.version++;
            Logger.debug(`[Water] river ${riverId}: ${(rec.lengthM / 1000).toFixed(1)} km to ${destKey}, ` +
                `${fromCache ? 'cache' : 'traced'} ${rec.ms.toFixed(0)} ms`);
            return this.riverRecs.get(riverId) ?? null;
        } catch (err) {
            this._failedRivers.add(riverId);
            Logger.warn(`[Water] river ${riverId} refine failed: ${err?.message || err}`);
            return null;
        }
    }

    /** First point along a traced river where its water level drops below the start level (just past the high sill). */
    _riverHighPoint(rec) {
        const n = rec.points.length / rec.stride, P = rec.points, st = rec.stride;
        for (let k = 0; k < n; k++) {
            if (P[k * st + 8] < rec.startLevel - 0.05) return [P[k * st], P[k * st + 1], P[k * st + 2]];
        }
        return null;
    }

    /** Solves a lake again on its patch grown to include dir (+ margin). */
    async _resolveLakeIncluding(id, dir) {
        const R = this.config.refine;
        const old = this.refined.get(id);
        const f = old?.patchFrame ?? old?.frame ?? this.lakes[id].frame;
        const [x, y] = dirToPlane(dir, f, this.radius);
        const m = 1500;
        const x0 = Math.min(f.x0, x - m), y0 = Math.min(f.y0, y - m);
        const x1 = Math.max(f.x0 + f.nx * f.spacing, x + m), y1 = Math.max(f.y0 + f.ny * f.spacing, y + m);
        const spacing = R.spacingM;
        const frame = limitPatchCells({ c: f.c, e1: f.e1, e2: f.e2, x0, y0, spacing, nx: Math.ceil((x1 - x0) / spacing), ny: Math.ceil((y1 - y0) / spacing) }, R.maxCells);
        const heights = await this._sampler.samplePatch(frame, this.radius);
        const rec = await this._client.call({ type: 'solveLake', lakeId: id, frame, heights, bandM: R.bandM, ...(R.precompute ? { crop: true } : {}) }, [heights.buffer]);
        if (rec.status !== 'ok') return false;
        Logger.debug(`[Water] lake ${id} re-solved past its outflow: level ${old?.level?.toFixed(1)} -> ${rec.level.toFixed(1)} m`);
        await this._apply(id, rec);
        if (this.config.cache) {
            const { downstream: _downstream, ...stored } = rec;
            this._cache.put(`lake:${this._key}:${R.spacingM}:${R.bandM}:${R.precompute ? 'crop:' : ''}${id}`, stored);
        }
        return true;
    }

    _lakeIdentity(id) {
        const representative = this.rep(id), r = this.refined.get(representative) ?? this.lakes[representative];
        return hashParts([representative, r.level, r.frame, r.exitDir ?? null, r.mask ?? null]);
    }

    _patchesOverlap(a, b, precise = false) {
        if (!a?.c || !b?.c) return false;
        const radius = f => 0.5 * Math.hypot(f.nx, f.ny) * f.spacing;
        const cos = a.c.reduce((sum, v, k) => sum + v * b.c[k], 0);
        return Math.acos(Math.max(-1, Math.min(1, cos))) * this.radius < radius(a) + radius(b)
            && (!precise || patchRectsMayOverlap(a, b, this.radius));
    }

    _riverLakeIdentity(frame) {
        if (!frame) return null;
        const ids = [...this.refined.keys()].filter(id => this.rep(id) === id &&
            this._patchesOverlap(frame, this.refined.get(id).frame)).sort((a, b) => a - b);
        return hashParts(ids.map(id => this._lakeIdentity(id)));
    }

    async _apply(id, rec) {
        const affected = new Set([id, ...(rec.merged ?? [])]);
        const invalid = new Set();
        // Precomputed water retains its established invalidation order and
        // cache behavior; refine the overlap only for on-demand discovery.
        const precise = this.config.refine?.precompute !== true;
        // Include tributaries of an invalidated trunk. A source absorbed by
        // another lake no longer has a separate outlet river at all.
        let changed = true;
        while (changed) {
            changed = false;
            for (const [rid, river] of this.riverRecs) {
                if (invalid.has(rid)) continue;
                if (affected.has(river.src) || (river.dest?.type === 'lake' && affected.has(river.dest.id)) ||
                    this._patchesOverlap(river.dependencyFrame, rec.frame, precise) ||
                    [...affected].some(lid => this._patchesOverlap(river.dependencyFrame, this.refined.get(lid)?.frame, precise)) ||
                    (river.dest?.type === 'river' && invalid.has(river.dest.id))) {
                    invalid.add(rid); changed = true;
                }
            }
        }
        for (const m of rec.merged ?? []) {
            this.mergedInto.set(m, id);
            this.refined.delete(m);
        }
        this.refined.set(id, rec);
        for (const rid of invalid) this.riverRecs.delete(rid);
        for (const river of this.rivers) {
            if (affected.has(river.fromLake) || (river.to?.type === 'lake' && affected.has(river.to.id)) || invalid.has(river.id))
                this._failedRivers.delete(river.id);
        }
        for (const [lid, down] of Object.entries(rec.downstream ?? {})) {
            const r = this.refined.get(Number(lid));
            if (r) r.downstream = down;
        }
        this.version++;
        if (invalid.size) {
            await this._client.call({type:'removeRivers', riverIds:[...invalid]});
            this.version++;
        }
    }

    /**
     * River carve data (WaterGpuData resources) for carved patch samples
     * (samplePatch(frame, R, { carved: true }): the simulation's bed).
     */
    setWaterCarveResources(res) {
        this._carveResources = res;
        this._sampler?.setWaterCarveResources(res);
    }

    /** River field (RiverFieldService resources) for carved samples. */
    setRiverFieldResources(res) {
        this._fieldResources = res;
        this._sampler?.setRiverFieldResources?.(res);
    }

    /** The sampler the near simulation's bed comes from. Structured placement
     * has none of its own: a lazy carved-direction sampler then. */
    async simulationBedSampler() {
        if(!this._sampler) {
            this._simSamplerPromise ??= createHydrologySampler({device:this.device,terrainGenerator:this.terrainGenerator,directionsOnly:true});
            this._sampler=await this._simSamplerPromise;
            await this._sampler.setWaterCarveResources(this._carveResources);
            await this._sampler.setRiverFieldResources(this._fieldResources);
        }
        return this._sampler;
    }

    /** Terrain heights (m) on a tangent-plane patch; carved: with the river channels. */
    samplePatch(frame, { carved = false } = {}) {
        return this._sampler.samplePatch(frame, this.radius, { carved });
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
