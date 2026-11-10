/* global process */
// Lab (Node + Dawn, owned process): census of natural closed depressions in
// mountain terrain of the original world at 32 m, outside the coarse graph's
// lakes. Do small mountain lakes exist in the terrain as it is?
//
//   LAB_TERRAIN_JSON='...regionalTerrain disabled...' node tools/perf/lakeRecovery/labMountainPockets.mjs OUT_DIR [reliefM=300] [spacing=32]
//
// Mountain blocks: 32 x 32 graph cells (~13 km) holding a cell whose 5 x 5
// cell relief exceeds reliefM. Each block is sampled with a 1.5 km margin,
// priority-flooded from its border; a depression (connected cells holding
// water at their own spill level) is counted in the block holding its
// deepest point, if it does not reach the patch border.
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/labsetup.mjs';

const [outArg, reliefArg = '300', spacingArg = '32'] = process.argv.slice(2);
const out = path.resolve(outArg);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`evidence directory not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(out, 'run.log'), s + '\n'); };

const lab = await setupLab(root);
const { device, gen, imp } = lab;
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { buildWaterGraph, makeNeighbors, faceUVToDir, dirToCell, MinHeap } = await imp('core/world/hydrology/waterGraph.js');
const { tangentBasis, dirToPlane, planeToDir } = await imp('core/world/hydrology/lakeRefine.js');
if (gen.regionalTerrainActive) throw new Error('regional terrain active: not the original world');

const R = lab.planetConfig.radius, N = 512, NN = N * N, BLOCK = 32, MARGIN = 1500;
const RELIEF = Number(reliefArg), SPACING = Number(spacingArg);
const MIN_DEPTH = 3, MIN_AREA_KM2 = 0.02;   // candidate lake: deeper than 3 m, larger than 2 ha
const sampler = await createHydrologySampler({ device, terrainGenerator: gen, eagerCarved: false });
const grid = await sampler.sampleGrid(N);
const g = buildWaterGraph({ N, heights: grid.heights, seaLevelM: grid.seaLevelM, precip: grid.precip });
const nb = makeNeighbors(N);
const relief = new Float32Array(6 * NN), relief2 = new Float32Array(6 * NN);
for (let id = 0; id < 6 * NN; id++) {
    let lo = grid.heights[id], hi = lo;
    const { list, count } = nb(id);
    for (let k = 0; k < count; k++) { const v = grid.heights[list[k]]; if (v < lo) lo = v; if (v > hi) hi = v; }
    relief[id] = hi - lo;
}
for (let id = 0; id < 6 * NN; id++) {
    let m = relief[id];
    const { list, count } = nb(id);
    for (let k = 0; k < count; k++) m = Math.max(m, relief[list[k]]);
    relief2[id] = m;
}
const blocks = [];
for (let f = 0; f < 6; f++) for (let bj = 0; bj < N / BLOCK; bj++) for (let bi = 0; bi < N / BLOCK; bi++) {
    let mountain = 0, land = 0;
    for (let j = bj * BLOCK; j < (bj + 1) * BLOCK; j++) for (let i = bi * BLOCK; i < (bi + 1) * BLOCK; i++) {
        const id = f * NN + j * N + i;
        if (grid.heights[id] > grid.seaLevelM) land++;
        if (grid.heights[id] > grid.seaLevelM && relief2[id] > RELIEF) mountain++;
    }
    if (mountain) blocks.push({ f, bi, bj, mountain, land });
}
log(JSON.stringify({ R, spacing: SPACING, reliefM: RELIEF, blocks: blocks.length, mountainCells: blocks.reduce((a, b) => a + b.mountain, 0), lakes: g.lakes.length }));

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const pockets = [];
let gpuMs = 0, cpuMs = 0, cells = 0;
for (const b of blocks) {
    const c = faceUVToDir(b.f, (b.bi * BLOCK + BLOCK / 2) / N, (b.bj * BLOCK + BLOCK / 2) / N);
    const frame0 = { c, ...tangentBasis(c) };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]]) {
        const [x, y] = dirToPlane(faceUVToDir(b.f, (b.bi + u) * BLOCK / N, (b.bj + v) * BLOCK / N), frame0, R);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const frame = { ...frame0, spacing: SPACING, x0: xMin - MARGIN, y0: yMin - MARGIN,
        nx: Math.ceil((xMax - xMin + 2 * MARGIN) / SPACING), ny: Math.ceil((yMax - yMin + 2 * MARGIN) / SPACING) };
    const ta = performance.now();
    const h = await sampler.samplePatch(frame, R);
    const tb = performance.now();
    const { nx, ny } = frame, n = nx * ny;
    cells += n;
    // Priority flood from the border: fill = spill level of every cell.
    const fill = new Float64Array(n), closed = new Uint8Array(n), heap = new MinHeap(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (i && j && i < nx - 1 && j < ny - 1) continue;
        const k = j * nx + i; closed[k] = 1; fill[k] = h[k]; heap.push(h[k], k);
    }
    while (heap.size) {
        const k = heap.pop(), i = k % nx, j = (k - i) / nx;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const q = jj * nx + ii;
            if (closed[q]) continue;
            closed[q] = 1; fill[q] = Math.max(h[q], fill[k]); heap.push(fill[q], q);
        }
    }
    // Depressions: connected cells with water (fill - h > 0.5 m), one level each.
    const seen = new Uint8Array(n), stack = [];
    for (let k0 = 0; k0 < n; k0++) {
        if (seen[k0] || !(fill[k0] - h[k0] > 0.5)) continue;
        let area = 0, deepest = k0, border = false;
        seen[k0] = 1; stack.push(k0);
        while (stack.length) {
            const k = stack.pop(), i = k % nx, j = (k - i) / nx;
            area++;
            if (fill[k] - h[k] > fill[deepest] - h[deepest]) deepest = k;
            if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) border = true;
            for (const [di, dj] of NB8) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                const q = jj * nx + ii;
                if (seen[q] || !(fill[q] - h[q] > 0.5)) continue;
                seen[q] = 1; stack.push(q);
            }
        }
        const depth = fill[deepest] - h[deepest], areaKm2 = area * SPACING * SPACING / 1e6;
        if (border || depth < MIN_DEPTH || areaKm2 < MIN_AREA_KM2) continue;
        const dir = planeToDir(frame.x0 + (deepest % nx + 0.5) * SPACING, frame.y0 + (Math.floor(deepest / nx) + 0.5) * SPACING, frame, R);
        const cell = dirToCell(dir, N), cf = Math.floor(cell / NN), ck = cell % NN;
        if (cf !== b.f || Math.floor((ck % N) / BLOCK) !== b.bi || Math.floor(Math.floor(ck / N) / BLOCK) !== b.bj) continue;   // another block owns it
        pockets.push({ dir, level: fill[deepest], depth, areaKm2, bed: h[deepest], inGraphLake: g.lakeOf[cell] !== -1,
            relief: relief2[cell], face: b.f });
    }
    cpuMs += performance.now() - tb; gpuMs += tb - ta;
}
const fresh = pockets.filter(p => !p.inGraphLake);
// River gradient: for each new pocket, the nearest other pocket (new or a
// graph lake) with a lower level within 8 km, and the drop to it.
const lakeDirs = g.lakes.map(l => ({ dir: (() => { const k = l.deepestCell; const f = Math.floor(k / NN), r = k % NN; return faceUVToDir(f, ((r % N) + 0.5) / N, (Math.floor(r / N) + 0.5) / N); })(), level: l.level }));
const targets = [...fresh.map(p => ({ dir: p.dir, level: p.level })), ...lakeDirs];
for (const p of fresh) {
    let best = null;
    for (const t of targets) {
        if (t === p || !(t.level < p.level - 1)) continue;
        const dot = p.dir[0] * t.dir[0] + p.dir[1] * t.dir[1] + p.dir[2] * t.dir[2];
        if (dot < Math.cos(8000 / R)) continue;
        const dist = Math.acos(Math.min(1, dot)) * R;
        if (!best || dist < best.dist) best = { dist, drop: p.level - t.level };
    }
    p.below = best;
}
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))] : null; };
const areaBins = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, Infinity], depthBins = [3, 5, 10, 20, 50, Infinity];
const hist = (vals, bins) => bins.slice(0, -1).map((lo, i) => ({ from: lo, to: bins[i + 1], n: vals.filter(v => v >= lo && v < bins[i + 1]).length }));
const mountainKm2 = blocks.reduce((a, b) => a + b.mountain, 0) * (4 * Math.PI * R * R / (6 * NN)) / 1e6;
const withBelow = fresh.filter(p => p.below);
const summary = {
    reliefM: RELIEF, spacingM: SPACING, blocks: blocks.length, sampledCells: cells, gpuMs, cpuMs,
    mountainKm2, pockets: pockets.length, inGraphLakes: pockets.length - fresh.length, newPockets: fresh.length,
    perThousandKm2: fresh.length / mountainKm2 * 1000,
    areaKm2: { p50: q(fresh.map(p => p.areaKm2), 0.5), p90: q(fresh.map(p => p.areaKm2), 0.9), max: q(fresh.map(p => p.areaKm2), 1) },
    depthM: { p50: q(fresh.map(p => p.depth), 0.5), p90: q(fresh.map(p => p.depth), 0.9), max: q(fresh.map(p => p.depth), 1) },
    levelM: { p10: q(fresh.map(p => p.level), 0.1), p50: q(fresh.map(p => p.level), 0.5), p90: q(fresh.map(p => p.level), 0.9) },
    areaHist: hist(fresh.map(p => p.areaKm2), areaBins), depthHist: hist(fresh.map(p => p.depth), depthBins),
    lowerNeighbourWithin8km: withBelow.length,
    lowerNeighbour: { distM: { p50: q(withBelow.map(p => p.below.dist), 0.5) }, dropM: { p50: q(withBelow.map(p => p.below.drop), 0.5), p90: q(withBelow.map(p => p.below.drop), 0.9) },
        gradient: { p50: q(withBelow.map(p => p.below.drop / p.below.dist), 0.5), p90: q(withBelow.map(p => p.below.drop / p.below.dist), 0.9) } },
};
fs.writeFileSync(path.join(out, 'pockets.json'), JSON.stringify(fresh.map(p => ({ ...p, dir: p.dir.map(v => +v.toFixed(7)) }))));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
log(JSON.stringify(summary, null, 1));
sampler.destroy();
process.exit(0);
