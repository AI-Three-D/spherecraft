/* global process */
// Offline (CPU) analysis of an originalLakeRun.mjs evidence directory:
// rebuilds the water graph from the dumped grid with the production code,
// checks it reproduces the browser's lakes, and measures size and shape.
//
//   node tools/perf/lakeRecovery/analyzeOriginal.mjs RUN_DIR
// Writes RUN_DIR/analysis.json.
import fs from 'node:fs';
import path from 'node:path';
import { buildWaterGraph, cellDir } from '../../../core/world/hydrology/waterGraph.js';

const dir = path.resolve(process.argv[2]);
const inv = JSON.parse(fs.readFileSync(path.join(dir, 'inventory.json'), 'utf8'));
const rd = (f, T) => { const b = fs.readFileSync(path.join(dir, f)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
const heights = rd('grid-heights.f32', Float32Array);
const precip = fs.existsSync(path.join(dir, 'grid-precip.f32')) ? rd('grid-precip.f32', Float32Array) : null;
const N = inv.N, R = inv.radius, NN = N * N;

const t0 = performance.now();
const g = buildWaterGraph({ N, heights, seaLevelM: inv.seaLevelM, precip, params: inv.config?.params ?? {} });
const buildMs = performance.now() - t0;

// Reproduction check against the browser's inventory.
const lakeCells = rd('lake-cells.i32', Int32Array), lakeCellStart = rd('lake-cell-start.i32', Int32Array);
let mismatches = 0;
for (const l of g.lakes) {
    const b = lakeCells.subarray(lakeCellStart[l.id], lakeCellStart[l.id + 1]);
    if (b.length !== l.cells.length || l.cells.some((c, i) => c !== b[i]) || Math.abs(inv.lakes[l.id].level - l.level) > 1e-3) mismatches++;
}

const cellArea = (id) => { const k = id % NN, x = (((k % N) + 0.5) / N) * 2 - 1, y = ((Math.floor(k / N) + 0.5) / N) * 2 - 1; return (2 / N) ** 2 * Math.pow(1 + x * x + y * y, -1.5) * R * R; };
const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
let landArea = 0, oceanArea = 0;
for (let id = 0; id < 6 * NN; id++) { if (heights[id] <= inv.seaLevelM) oceanArea += cellArea(id); else landArea += cellArea(id); }
const lakes = g.lakes.map(l => {
    let area = 0;
    for (const c of l.cells) area += cellArea(c);
    const c0 = cellDir(l.deepestCell, N);
    let ext = 0;
    for (const c of l.cells) { const d = cellDir(c, N); ext = Math.max(ext, Math.acos(Math.min(1, d[0] * c0[0] + d[1] * c0[1] + d[2] * c0[2])) * R); }
    return { id: l.id, cells: l.cells.length, coarseAreaKm2: area / 1e6, extentKm: ext / 1000, level: l.level, maxDepth: l.maxDepth, coreCells: l.coreCells, river: l.river };
});
const areas = lakes.map(l => l.coarseAreaKm2);
const bins = [0, 1, 2.5, 5, 10, 25, 50, 100, 250, 1000, Infinity];
const histogram = bins.slice(0, -1).map((lo, i) => ({ fromKm2: lo, toKm2: bins[i + 1], count: areas.filter(a => a >= lo && a < bins[i + 1]).length }));

// Refined 16 m masks: wet area, islands (dry components enclosed by water), shoreline development.
function maskShape(mask, nx, ny, spacing) {
    let wet = 0, edges = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (mask[k] !== 2) continue;
        wet++;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || mask[jj * nx + ii] !== 2) edges++;
        }
    }
    // Dry components not touching the patch border are islands (4-connected dry vs 8-connected water).
    const seen = new Uint8Array(nx * ny), islands = [];
    const stack = [];
    for (let k0 = 0; k0 < nx * ny; k0++) {
        if (mask[k0] === 2 || seen[k0]) continue;
        let size = 0, border = false;
        seen[k0] = 1; stack.push(k0);
        while (stack.length) {
            const k = stack.pop(), i = k % nx, j = (k - i) / nx;
            size++;
            if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) border = true;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                const nb = jj * nx + ii;
                if (seen[nb] || mask[nb] === 2) continue;
                seen[nb] = 1; stack.push(nb);
            }
        }
        if (!border) islands.push(size);
    }
    const areaM2 = wet * spacing * spacing, perimM = edges * spacing;
    // 4-neighbour edge counts overstate a smooth boundary by ~4/pi; report both.
    return { wetCells: wet, areaKm2: areaM2 / 1e6, perimeterKm: perimM / 1000, perimeterKmSmoothed: perimM * Math.PI / 4 / 1000,
        shorelineDevelopment: (perimM * Math.PI / 4) / (2 * Math.sqrt(Math.PI * areaM2)),
        islands: islands.length, islandsOver4Cells: islands.filter(s => s > 4).length, islandAreaKm2: islands.reduce((a, b) => a + b, 0) * spacing * spacing / 1e6 };
}
const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
const refined = (report.refined ?? []).map(r => {
    const f = path.join(dir, `refined/lake-${r.id}.u8`);
    if (!fs.existsSync(f)) return { id: r.id, missing: true };
    const mask = fs.readFileSync(f);
    return { id: r.id, level: r.level, graphLevel: r.graphLevel, levelChangeM: r.level - r.graphLevel, reportedAreaKm2: r.areaM2 / 1e6,
        coarseAreaKm2: lakes[r.id].coarseAreaKm2, frame: { nx: r.frame.nx, ny: r.frame.ny, spacing: r.frame.spacing }, merged: r.merged, ms: r.ms,
        ...maskShape(mask, r.frame.nx, r.frame.ny, r.frame.spacing) };
});

const out = {
    buildMs, reproduced: { lakes: g.lakes.length, browserLakes: inv.lakes.length, rivers: g.rivers.length, browserRivers: inv.rivers.length, mismatches },
    landAreaKm2: landArea / 1e6, oceanAreaKm2: oceanArea / 1e6,
    lakeAreaTotalKm2: areas.reduce((a, b) => a + b, 0),
    coarseArea: { min: Math.min(...areas), p10: q(areas, 0.1), median: q(areas, 0.5), p90: q(areas, 0.9), max: Math.max(...areas) },
    histogram,
    largest: lakes.slice().sort((a, b) => b.coarseAreaKm2 - a.coarseAreaKm2).slice(0, 30),
    refined,
};
fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, largest: out.largest.slice(0, 8), refined: out.refined.slice(0, 12) }, null, 1));
