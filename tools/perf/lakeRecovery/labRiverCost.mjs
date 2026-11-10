/* global process */
// Lab (Node + Dawn, owned process): the cost of tracing every graph river of
// the original world after all lakes are solved at 32 m (precompute mode), as
// WaterService._refineRiver does it, stage by stage.
//
//   LAB_TERRAIN_JSON='...regionalTerrain disabled...' node tools/perf/lakeRecovery/labRiverCost.mjs OUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/labsetup.mjs';

const out = path.resolve(process.argv[2]);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`evidence directory not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(out, 'run.log'), s + '\n'); };

const lab = await setupLab(root);
const { device, gen, imp } = lab;
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { createWaterWorkerCore } = await imp('core/world/hydrology/waterWorkerCore.js');
const { WATER_SERVICE_DEFAULTS } = await imp('core/world/hydrology/WaterService.js');
const { limitPatchCells, growPatchFrame } = await imp('core/world/hydrology/lakeRefine.js');
const { cellDir } = await imp('core/world/hydrology/waterGraph.js');
const { RIVER_SUB } = await imp('core/world/water/waterWgsl.js');
const { RIVER_CARVE_DEFAULTS, riverShapeMaxScale } = await imp('core/world/water/riverShapeNoise.js');
const { RIVER_VALLEY_DEFAULTS } = await imp('core/world/water/riverValley.js');
const { RIVER_LANDSCAPE_DEFAULTS } = await imp('core/world/hydrology/riverLandscape.js');
if (gen.regionalTerrainActive) throw new Error('regional terrain active: not the original world');

const R = lab.planetConfig.radius, N = 512, SPACING = 32, BAND = 6, MAX_CELLS = 4e6;
const RC = WATER_SERVICE_DEFAULTS.rivers;
const CV = { ...RIVER_CARVE_DEFAULTS, bankDetail: 0 };   // ?regionalBanks=legacy
const landscape = { ...RIVER_LANDSCAPE_DEFAULTS, enabled: gen.riverValley === true };
const sampler = await createHydrologySampler({ device, terrainGenerator: gen, eagerCarved: false });
const grid = await sampler.sampleGrid(N);
const core = createWaterWorkerCore();
const tb = performance.now();
const built = core.handle({ type: 'build', N, heights: grid.heights, precip: grid.precip, seaLevelM: grid.seaLevelM, radius: R, spacing: SPACING }).reply;
const summary = { buildMs: performance.now() - tb, lakes: built.lakes.length, rivers: built.rivers.length, gen: { waterCarve: gen.waterCarve, riverValley: gen.riverValley } };

// All lakes at 32 m (sequential precompute order by id; merges as in the service).
const merged = new Map();
const rep = (id) => { while (merged.has(id)) id = merged.get(id); return id; };
let lakeGpu = 0, lakeCpu = 0;
for (const lake of built.lakes) {
    if (rep(lake.id) !== lake.id) continue;
    let frame = limitPatchCells(lake.frame, MAX_CELLS);
    for (let grows = 0; ; grows++) {
        const t0 = performance.now();
        const heights = await sampler.samplePatch(frame, R);
        const t1 = performance.now();
        const r = core.handle({ type: 'solveLake', lakeId: lake.id, frame, heights, bandM: BAND, crop: true, skipDownstream: true }).reply;
        lakeGpu += t1 - t0; lakeCpu += performance.now() - t1;
        if (r.status === 'ok') { for (const m of r.merged) merged.set(m, lake.id); break; }
        if (r.status !== 'grow' || grows >= 3) break;
        frame = limitPatchCells(growPatchFrame(frame, 1.6), MAX_CELLS);
    }
}
summary.lakes32 = { gpuMs: lakeGpu, cpuMs: lakeCpu, merged: merged.size };
log(JSON.stringify(summary));

// Rivers in id order: a confluence's trunk has a lower id (larger outflow claims first).
const recs = new Map(), rows = [];
const sum = { planMs: 0, sampleMs: 0, solveMs: 0, landscapeMs: 0, valleyMs: 0, corridorCells: 0, ok: 0 };
for (const river of built.rivers) {
    const row = { id: river.id, fromLake: river.fromLake };
    const t0 = performance.now();
    if (rep(river.fromLake) !== river.fromLake) { row.status = 'merged'; rows.push(row); continue; }
    let plan = core.handle({ type: 'planRiver', riverId: river.id, spacing: RC.spacingM, corridorM: RC.corridorM, shape: RC.shape, join: RC.confluences }).reply;
    let trunk = null;
    if (plan.status === 'ok' && plan.dest.type === 'river') {
        const t = recs.get(plan.dest.id);
        if (t) {
            const P = t.points, st = t.stride, n = P.length / st, d = cellDir(plan.dest.cell, N);
            let best = 0, bc = -2;
            for (let k = 0; k < n; k++) { const c = P[k * st] * d[0] + P[k * st + 1] * d[1] + P[k * st + 2] * d[2]; if (c > bc) { bc = c; best = k; } }
            const dirs = new Float32Array(n * 3), hw = new Float32Array(n);
            for (let k = 0; k < n; k++) { dirs.set([P[k * st], P[k * st + 1], P[k * st + 2]], 3 * k); hw[k] = P[k * st + 4]; }
            trunk = { dirs, hw, eta: P[best * st + 3] };
        } else {
            plan = core.handle({ type: 'planRiver', riverId: river.id, spacing: RC.spacingM, corridorM: RC.corridorM, shape: RC.shape, join: false }).reply;
        }
    }
    row.planMs = performance.now() - t0;
    if (plan.status !== 'ok') { row.status = `plan:${plan.status}`; rows.push(row); continue; }
    let rec = null;
    for (const corridorM of [RC.corridorM, RC.corridorM * RC.retryCorridorScale]) {
        if (corridorM !== RC.corridorM) {
            plan = core.handle({ type: 'planRiver', riverId: river.id, spacing: RC.spacingM, corridorM, shape: RC.shape, join: !!trunk }).reply;
            if (plan.status !== 'ok') break;
        }
        const frame = limitPatchCells(plan.frame, MAX_CELLS);
        const ts = performance.now();
        const heights = await sampler.samplePatch(frame, R);
        const tsol = performance.now();
        const r = core.handle({ type: 'solveRiver', riverId: river.id, frame, heights, shape: RC.shape,
            levels: { ...RC.levels, waterFrac: CV.waterFrac, bankH: CV.bankH }, landscape, shapeNoise: CV,
            reachM: CV.enabled ? CV.bankW + CV.blendW + 8 : 0, reachScale: riverShapeMaxScale(CV),
            stepM: RC.stepM, smoothPasses: RC.smoothPasses, sub: RIVER_SUB, trunk }).reply;
        row.sampleMs = (row.sampleMs ?? 0) + (tsol - ts);
        row.solveMs = (row.solveMs ?? 0) + (performance.now() - tsol);
        row.landscapeMs = (row.landscapeMs ?? 0) + (r.landscapeMs ?? 0);
        row.corridorCells = (row.corridorCells ?? 0) + frame.nx * frame.ny;
        row.attempts = (row.attempts ?? 0) + 1;
        if (r.status === 'ok' && (!rec || rec.status !== 'ok' || r.startLevel < rec.startLevel)) rec = r; else if (!rec) rec = r;
        if (rec.status === 'ok') break;
    }
    row.status = rec?.status ?? 'none';
    if (rec?.status === 'ok') {
        recs.set(river.id, rec);
        row.lengthKm = rec.lengthM / 1000; row.points = rec.points.length / rec.stride; row.segCells = rec.segCells.length;
        row.dest = rec.dest.type;
        const tv = performance.now();
        const v = core.handle({ type: 'bakeValley', riverIds: [river.id], opts: RIVER_VALLEY_DEFAULTS }).reply;
        row.valleyMs = performance.now() - tv; row.valleyPages = v.pageIds.length;
        sum.ok++;
    }
    for (const k of ['planMs', 'sampleMs', 'solveMs', 'landscapeMs', 'valleyMs', 'corridorCells']) sum[k] += row[k] ?? 0;
    rows.push(row);
    fs.appendFileSync(path.join(out, 'rivers.jsonl'), JSON.stringify(row) + '\n');
    if (river.id % 10 === 0) log(`[lab] river ${river.id}`, JSON.stringify(row));
}
summary.rivers = sum;
summary.statuses = rows.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
log(JSON.stringify(summary));
sampler.destroy();
process.exit(0);
