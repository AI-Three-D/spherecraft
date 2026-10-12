/* global process */
// Lab (Node + Dawn, owned process): original lakes solved at several patch
// spacings on the exact production terrain, against the production 16 m
// solve. Also scores the unrefined coarse footprints.
//
//   LAB_TERRAIN_JSON='{"regionalTerrain":{"enabled":false,"cells":128,"seamCells":4,"world":{"enabled":false},"basins":{"enabled":false}},"waterGraph":{"enabled":true,"carve":{"bankDetail":0}}}' \
//   node tools/perf/lakeRecovery/labLakeResolution.mjs OUT_DIR REF_RUN_DIR [ids=all|1,2,3] [spacings=64,32]
//
// Per lake and spacing s: grow loop as WaterService (x1.6, 3 grows, 4e6 cell cap),
// level, wet area, GPU sample ms, CPU seed+solve ms. "Visible" agreement is
// measured on the production 16 m patch: water shows where h16 < level_s inside
// the solve's render mask (region + 3-cell shore band, lakeRefine.lakeMask), as
// the terrain shader does per pixel. Reference: the 16 m production solve.
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/labsetup.mjs';

const [outArg, refArg, idsArg = 'all', spacingsArg = '64,32'] = process.argv.slice(2);
const out = path.resolve(outArg);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`evidence directory not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(out, 'run.log'), s + '\n'); };

const lab = await setupLab(root);
const { device, gen, imp } = lab;
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { buildWaterGraph, dirToCell, makeNeighbors } = await imp('core/world/hydrology/waterGraph.js');
const { lakePatchFrame, growPatchFrame, limitPatchCells, lakeSeed, solveLakePatch, planeToDir, lakeMask } = await imp('core/world/hydrology/lakeRefine.js');
log('[lab] regionalTerrainActive', gen.regionalTerrainActive === true, 'waterCarve', gen.waterCarve, 'riverValley', gen.riverValley);
if (gen.regionalTerrainActive) throw new Error('regional terrain active: not the original world');

const R = lab.planetConfig.radius, N = 512, MAX_CELLS = 4e6, BAND_M = 6;
const tc0 = performance.now();
const sampler = await createHydrologySampler({ device, terrainGenerator: gen });
const compileMs = performance.now() - tc0;
const tg0 = performance.now();
const grid = await sampler.sampleGrid(N);
const gridMs = performance.now() - tg0;

// The browser's grid (same terrain?) and graph.
const ref = path.resolve(refArg);
const rb = fs.readFileSync(path.join(ref, 'grid-heights.f32'));
const refH = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
let maxDiff = 0, nDiff = 0;
for (let i = 0; i < refH.length; i++) { const d = Math.abs(refH[i] - grid.heights[i]); maxDiff = Math.max(maxDiff, d); if (d > 0.01) nDiff++; }
const tb0 = performance.now();
const g = buildWaterGraph({ N, heights: grid.heights, seaLevelM: grid.seaLevelM, precip: grid.precip });
const buildMs = performance.now() - tb0;
const summary = { R, compileMs, gridMs, buildMs, gridVsBrowser: { maxAbsDiffM: maxDiff, cellsOver1cm: nDiff }, lakes: g.lakes.length, rivers: g.rivers.length, seaLevelM: grid.seaLevelM };
log(JSON.stringify(summary));

const spacings = spacingsArg.split(',').map(Number);
const ids = idsArg === 'all' ? g.lakes.map(l => l.id) : idsArg.split(',').map(Number);
const neighbors = makeNeighbors(N);

// Grid-cell footprints of an unrefined lake: the production one (its graph
// cells) and a ring-1 variant (graph cells plus neighbours that are not lower
// than level - 0.5 m, so outlet valleys and other basins stay out).
function footprints(lake) {
    const body = new Set(lake.cells), ring = new Set(body);
    for (const c of lake.cells) {
        const { list, count } = neighbors(c);
        for (let k = 0; k < count; k++) {
            const nb = list[k];
            if (body.has(nb) || grid.heights[nb] <= grid.seaLevelM) continue;
            if (g.lakeOf[nb] !== -1 && g.lakeOf[nb] !== lake.id) continue;
            if (grid.heights[nb] < lake.level - 0.5) continue;
            ring.add(nb);
        }
    }
    return { body, ring };
}

async function solveAt(lake, spacing) {
    let frame = limitPatchCells(lakePatchFrame(lake, N, { R, spacing }), MAX_CELLS);
    let gpuMs = 0, cpuMs = 0, grows = 0, s = null, h = null, status = 'ok';
    for (;;) {
        const ta = performance.now();
        h = await sampler.samplePatch(frame, R);
        const tb = performance.now();
        const seed = lakeSeed(h, frame, lake, g.lakeOf, N, R);
        s = seed < 0 ? null : solveLakePatch({ heights: h, nx: frame.nx, ny: frame.ny, seed });
        gpuMs += tb - ta; cpuMs += performance.now() - tb;
        if (seed < 0) { status = 'noSeed'; break; }
        if (!s) { status = 'dry'; break; }
        if (!s.touchesBorder || grows >= 3) { if (s.touchesBorder) status = 'grow'; break; }
        frame = limitPatchCells(growPatchFrame(frame, 1.6), MAX_CELLS); grows++;
    }
    const tm = performance.now();
    const mask = s ? lakeMask(h, frame.nx, frame.ny, s.region, s.level, BAND_M) : null;
    cpuMs += performance.now() - tm;
    return { frame, s, h, mask, status, grows, gpuMs, cpuMs };
}

// Sample a solve's render mask at plane point (x, y): mask value or 0.
const maskAt = (r, x, y) => {
    const f = r.frame, i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
    return i >= 0 && j >= 0 && i < f.nx && j < f.ny ? r.mask[j * f.nx + i] : 0;
};

const rows = [];
const totals = {};
const tAll = performance.now();
for (const id of ids) {
    const lake = g.lakes[id];
    const row = { id, coarseCells: lake.cells.length, graphLevel: lake.level, river: lake.river };
    const refSolve = await solveAt(lake, 16);
    const add = (key, r) => { totals[key] ??= { gpuMs: 0, cpuMs: 0, cells: 0, n: 0 }; totals[key].gpuMs += r.gpuMs; totals[key].cpuMs += r.cpuMs; totals[key].cells += r.frame.nx * r.frame.ny; totals[key].n++; };
    add('16', refSolve);
    row.s16 = { status: refSolve.status, grows: refSolve.grows, spacing: refSolve.frame.spacing, cells: refSolve.frame.nx * refSolve.frame.ny,
        level: refSolve.s?.level ?? null, areaKm2: refSolve.s ? refSolve.s.cells * refSolve.frame.spacing ** 2 / 1e6 : 0, gpuMs: refSolve.gpuMs, cpuMs: refSolve.cpuMs };
    if (refSolve.s) {
        const f = refSolve.frame, n = f.nx * f.ny, A = refSolve.s.region, h = refSolve.h;
        const px = (k) => f.x0 + ((k % f.nx) + 0.5) * f.spacing, py = (k) => f.y0 + (Math.floor(k / f.nx) + 0.5) * f.spacing;
        const iou = (wetAt) => {
            let inter = 0, uni = 0, extra = 0, missing = 0;
            for (let k = 0; k < n; k++) {
                const a = A[k] === 1, b = wetAt(k);
                if (a && b) inter++; if (a || b) uni++; if (b && !a) extra++; if (a && !b) missing++;
            }
            return { iou: uni ? inter / uni : 1, extraKm2: extra * f.spacing ** 2 / 1e6, missingKm2: missing * f.spacing ** 2 / 1e6 };
        };
        // Unrefined production footprint and the ring-1 variant, at the graph level.
        const fp = footprints(lake);
        const cellOf = new Int32Array(n);
        for (let k = 0; k < n; k++) cellOf[k] = dirToCell(planeToDir(px(k), py(k), f, R), N);
        row.unrefinedGraphCells = iou(k => h[k] < lake.level && fp.body.has(cellOf[k]));
        row.unrefinedRing1 = iou(k => h[k] < lake.level && fp.ring.has(cellOf[k]));
        // Ring-1 footprint at the refined level (what a precomputed level alone gives).
        row.ring1AtFineLevel = iou(k => h[k] < refSolve.s.level && fp.ring.has(cellOf[k]));
        for (const sp of spacings) {
            const r = await solveAt(lake, sp);
            add(String(sp), r);
            const e = { status: r.status, grows: r.grows, spacing: r.frame.spacing, cells: r.frame.nx * r.frame.ny, level: r.s?.level ?? null,
                dLevelM: r.s ? r.s.level - refSolve.s.level : null, areaKm2: r.s ? r.s.cells * r.frame.spacing ** 2 / 1e6 : 0, gpuMs: r.gpuMs, cpuMs: r.cpuMs };
            if (r.s) Object.assign(e, iou(k => h[k] < r.s.level && maskAt(r, px(k), py(k)) >= 1));
            row[`s${sp}`] = e;
        }
    }
    rows.push(row);
    fs.appendFileSync(path.join(out, 'lakes.jsonl'), JSON.stringify(row) + '\n');
    if (rows.length % 25 === 0 || ids.length < 30) log(`[lab] ${rows.length}/${ids.length} lake ${id} ${(performance.now() - tAll) / 1000 | 0}s`, JSON.stringify(row.s16), JSON.stringify(row[`s${spacings[0]}`] ?? null));
}
summary.totals = totals;
summary.totalMs = performance.now() - tAll;
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
log(JSON.stringify(summary.totals));
sampler.destroy();
process.exit(0);
