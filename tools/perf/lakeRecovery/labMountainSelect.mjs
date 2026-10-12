/* global process */
// Lab: small mountain lakes. (1) Discovery cost and recall: natural pockets
// found by a flood at 64 m vs 32 m on tight blocks around high-relief cells.
// (2) Selection: which pockets become lakes, at several spacings, with maps.
//
//   LAB_TERRAIN_JSON='...regionalTerrain disabled...' node tools/perf/lakeRecovery/labMountainSelect.mjs OUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/labsetup.mjs';
import { writePNG, hillshade } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/png.mjs';

const out = path.resolve(process.argv[2]);
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

const R = lab.planetConfig.radius, N = 512, NN = N * N, RELIEF = 300, BLOCK = 8, MARGIN = 1000;
const MIN_DEPTH = 3, MIN_AREA_KM2 = 0.02;
const sampler = await createHydrologySampler({ device, terrainGenerator: gen, eagerCarved: false });
const grid = await sampler.sampleGrid(N);
const sea = grid.seaLevelM;
const g = buildWaterGraph({ N, heights: grid.heights, seaLevelM: sea, precip: grid.precip });
const nb = makeNeighbors(N);
const relief = new Float32Array(6 * NN), relief2 = new Float32Array(6 * NN);
for (let id = 0; id < 6 * NN; id++) {
    let lo = grid.heights[id], hi = lo; const { list, count } = nb(id);
    for (let k = 0; k < count; k++) { const v = grid.heights[list[k]]; if (v < lo) lo = v; if (v > hi) hi = v; }
    relief[id] = hi - lo;
}
for (let id = 0; id < 6 * NN; id++) { let m = relief[id]; const { list, count } = nb(id); for (let k = 0; k < count; k++) m = Math.max(m, relief[list[k]]); relief2[id] = m; }
const mountain = (id) => grid.heights[id] > sea && relief2[id] > RELIEF;

function blockFrame(f, bi, bj, size, spacing) {
    const c = faceUVToDir(f, (bi * size + size / 2) / N, (bj * size + size / 2) / N), frame0 = { c, ...tangentBasis(c) };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]]) {
        const [x, y] = dirToPlane(faceUVToDir(f, (bi + u) * size / N, (bj + v) * size / N), frame0, R);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    return { ...frame0, spacing, x0: xMin - MARGIN, y0: yMin - MARGIN,
        nx: Math.ceil((xMax - xMin + 2 * MARGIN) / spacing), ny: Math.ceil((yMax - yMin + 2 * MARGIN) / spacing) };
}
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
// Flood a patch from its border; pockets owned by block (f, bi, bj) of the given size.
function pocketsOf(h, frame, own) {
    const { nx, ny, spacing } = frame, n = nx * ny;
    const fill = new Float64Array(n), closed = new Uint8Array(n), heap = new MinHeap(n), parent = new Int32Array(n).fill(-1);
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
            closed[q] = 1; fill[q] = Math.max(h[q], fill[k]); parent[q] = k; heap.push(fill[q], q);
        }
    }
    const seen = new Uint8Array(n), stack = [], found = [], inComp = new Int32Array(n).fill(-1);
    let compId = 0;
    for (let k0 = 0; k0 < n; k0++) {
        if (seen[k0] || !(fill[k0] - h[k0] > 0.5)) continue;
        let area = 0, deepest = k0, border = false;
        const comp = [], cid = compId++;
        seen[k0] = 1; stack.push(k0);
        while (stack.length) {
            const k = stack.pop(), i = k % nx, j = (k - i) / nx;
            area++; comp.push(k); inComp[k] = cid;
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
        const depth = fill[deepest] - h[deepest], areaKm2 = area * spacing * spacing / 1e6;
        if (border || depth < MIN_DEPTH || areaKm2 < MIN_AREA_KM2 || fill[deepest] <= sea + 5) continue;
        const dir = planeToDir(frame.x0 + (deepest % nx + 0.5) * spacing, frame.y0 + (Math.floor(deepest / nx) + 0.5) * spacing, frame, R);
        const cell = dirToCell(dir, N);
        if (!own(cell) || g.lakeOf[cell] !== -1) continue;
        // Setting: how far the ground rises around the shore (median over a
        // ring 1-6 cells out). Outflow: drop along the drainage from the sill
        // within 1.5 km (or until lower water is reached).
        const level = fill[deepest], ring = [];
        const dil = new Map(comp.map(k => [k, 0]));
        let front = comp;
        for (let step = 1; step <= Math.round(400 / spacing) && front.length; step++) {
            const next = [];
            for (const k of front) { const i = k % nx, j = (k - i) / nx;
                for (const [di, dj] of NB8) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                    const q = jj * nx + ii; if (dil.has(q)) continue; dil.set(q, step); next.push(q); if (step >= 1) ring.push(h[q] - level); } }
            front = next;
        }
        ring.sort((a, b) => a - b);
        const enclosureM = ring.length ? ring[Math.floor(ring.length / 2)] : 0;
        let c = deepest;
        while (parent[c] !== -1 && inComp[parent[c]] === cid) c = parent[c];
        let lowest = level, steps = 0, reachedWater = false;
        for (let q = parent[c]; q !== -1 && steps * spacing < 1500; q = parent[q], steps++) {
            lowest = Math.min(lowest, h[q]);
            if (fill[q] - h[q] > 0.5 && fill[q] < level - 1) { lowest = Math.min(lowest, fill[q]); reachedWater = true; break; }
        }
        found.push({ dir, level, depth, areaKm2, relief: relief2[cell], cell, enclosureM, outflowDropM: level - lowest, reachedWater });
    }
    return { found, fill };
}

// (1) Discovery on tight 8 x 8-cell blocks (~3.2 km) around mountain cells.
const blocks = [];
for (let f = 0; f < 6; f++) for (let bj = 0; bj < N / BLOCK; bj++) for (let bi = 0; bi < N / BLOCK; bi++) {
    let m = 0;
    for (let j = bj * BLOCK; j < (bj + 1) * BLOCK; j++) for (let i = bi * BLOCK; i < (bi + 1) * BLOCK; i++) if (mountain(f * NN + j * N + i)) m++;
    if (m) blocks.push({ f, bi, bj });
}
const ownerOf = (b) => (cell) => {
    const f = Math.floor(cell / NN), k = cell % NN;
    return f === b.f && Math.floor((k % N) / BLOCK) === b.bi && Math.floor(Math.floor(k / N) / BLOCK) === b.bj;
};
const result = { blocks: blocks.length };
const pockets = {};
for (const spacing of process.argv.includes('--recall') ? [64, 32] : [64]) {
    let samples = 0, gpuMs = 0, cpuMs = 0;
    const list = [];
    // 32 m only on every 8th block (recall check); 64 m on all.
    const subset = spacing === 32 ? blocks.filter((_, k) => k % 8 === 0) : blocks;
    for (const b of subset) {
        const frame = blockFrame(b.f, b.bi, b.bj, BLOCK, spacing);
        const t0 = performance.now();
        const h = await sampler.samplePatch(frame, R);
        const t1 = performance.now();
        const { found } = pocketsOf(h, frame, ownerOf(b));
        for (const p of found) list.push({ ...p, block: `${b.f}:${b.bi}:${b.bj}` });
        gpuMs += t1 - t0; cpuMs += performance.now() - t1; samples += frame.nx * frame.ny;
    }
    pockets[spacing] = list;
    result[`d${spacing}`] = { blocks: subset.length, samples, gpuMs: Math.round(gpuMs), cpuMs: Math.round(cpuMs), pockets: list.length };
    log(JSON.stringify(result[`d${spacing}`]));
}
// Recall of 64 m discovery against 32 m on the shared blocks, by area.
const sub = new Set(blocks.filter((_, k) => k % 8 === 0).map(b => `${b.f}:${b.bi}:${b.bj}`));
const p64 = pockets[64].filter(p => sub.has(p.block)), p32 = pockets[32] ?? [];
const ang = (a, b) => Math.acos(Math.min(1, a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2])) * R;
const near = (a, b, m) => ang(a, b) < m;
const nearest = (p, list) => list.reduce((best, q) => (!best || ang(p, q) < ang(p, best) ? q : best), null);
result.recall = [0.02, 0.05, 0.1, 0.25, 0.5].map(minA => {
    const ref = p32.filter(p => p.areaKm2 >= minA);
    const hit = ref.filter(p => p64.some(q => near(p, q, Math.max(150, 0.6 * Math.sqrt(p.areaKm2 * 1e6)))));
    const lv = hit.map(p => nearest(p, p64).level - p.level).sort((a, b) => a - b);
    return { minAreaKm2: minA, ref: ref.length, found: hit.length, recall: ref.length ? +(hit.length / ref.length).toFixed(3) : null,
        levelDiffP50: lv.length ? +lv[Math.floor(lv.length / 2)].toFixed(2) : null };
});
log(JSON.stringify(result.recall));

// (2) Selection on the 64 m candidates: larger first, a minimum spacing
// between accepted lakes' centres (Poisson-disk style), deterministic.
const MIN_ENCLOSURE = Number(process.env.MIN_ENCLOSURE ?? 20), MIN_DROP = Number(process.env.MIN_DROP ?? 20);
const setting = process.env.SELECT === 'setting';
const cand = pockets[64].filter(p => p.areaKm2 >= 0.03 && (!setting || (p.enclosureM >= MIN_ENCLOSURE && p.outflowDropM >= MIN_DROP)))
    .sort((a, b) => b.areaKm2 - a.areaKm2 || a.cell - b.cell);
result.select = { mode: setting ? 'setting' : 'spacing', minEnclosureM: MIN_ENCLOSURE, minOutflowDropM: MIN_DROP, candidates: cand.length };
const qs = (a, f) => { const t = a.slice().sort((x, y) => x - y); return t[Math.floor(f * (t.length - 1))]; };
result.pocketStats = { enclosureM: { p25: qs(pockets[64].map(p => p.enclosureM), 0.25), p50: qs(pockets[64].map(p => p.enclosureM), 0.5), p75: qs(pockets[64].map(p => p.enclosureM), 0.75) },
    outflowDropM: { p25: qs(pockets[64].map(p => p.outflowDropM), 0.25), p50: qs(pockets[64].map(p => p.outflowDropM), 0.5), p75: qs(pockets[64].map(p => p.outflowDropM), 0.75) } };
log(JSON.stringify({ select: result.select, pocketStats: result.pocketStats }));
const select = (minSpacingM) => {
    // Spatial hash on the unit sphere: lattice cells of the spacing plus the largest radii.
    const rMax = Math.max(...cand.map(p => Math.sqrt(p.areaKm2 * 1e6 / Math.PI)));
    const cellM = minSpacingM + 2 * rMax, key = (d) => d.map(v => Math.floor(v * R / cellM)).join(',');
    const lattice = new Map(), keep = [];
    for (const p of cand) {
        const r = Math.sqrt(p.areaKm2 * 1e6 / Math.PI), k0 = p.dir.map(v => Math.floor(v * R / cellM));
        let ok = true;
        for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dz = -1; dz <= 1 && ok; dz++) {
            for (const q of lattice.get(`${k0[0] + dx},${k0[1] + dy},${k0[2] + dz}`) ?? []) if (near(p, q, minSpacingM + r + q.r)) { ok = false; break; }
        }
        if (!ok) continue;
        const e = { ...p, r };
        keep.push(e);
        const k = key(p.dir);
        if (!lattice.has(k)) lattice.set(k, []);
        lattice.get(k).push(e);
    }
    return keep;
};
const mountainKm2 = (() => { let n = 0; for (let id = 0; id < 6 * NN; id++) if (mountain(id)) n++; return n * 4 * Math.PI * R * R / (6 * NN) / 1e6; })();
result.mountainKm2 = mountainKm2;
result.selection = [];
const selections = {};
for (const s of [400, 800, 1600]) {
    const keep = select(s);
    selections[s] = keep;
    const areas = keep.map(p => p.areaKm2).sort((a, b) => a - b);
    result.selection.push({ minSpacingM: s, lakes: keep.length, perThousandKm2: +(keep.length / mountainKm2 * 1000).toFixed(1),
        areaKm2: { p50: areas[Math.floor(areas.length / 2)], p90: areas[Math.floor(areas.length * 0.9)], total: +areas.reduce((a, b) => a + b, 0).toFixed(1) } });
}
log(JSON.stringify(result.selection));

// Maps: the block with the most candidates and its neighbourhood (~26 km),
// one panel per spacing. Blue = selected, light = other pockets, red = graph lakes.
const counts = new Map();
for (const p of cand) { const f = Math.floor(p.cell / NN), k = p.cell % NN, key = `${f}:${Math.floor((k % N) / 64)}:${Math.floor(Math.floor(k / N) / 64)}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
const regions = process.env.REGIONS ? process.env.REGIONS.split(';').map(r => r.split(':').map(Number))
    : [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k.split(':').map(Number));
for (const [f, bi, bj] of regions) {
    const frame = blockFrame(f, bi, bj, 64, 64);
    const h = await sampler.samplePatch(frame, R);
    const { fill } = pocketsOf(h, frame, () => true);
    const { nx, ny } = frame, n = nx * ny;
    const cellDirOf = (k) => planeToDir(frame.x0 + (k % nx + 0.5) * 64, frame.y0 + (Math.floor(k / nx) + 0.5) * 64, frame, R);
    for (const s of [400, 800, 1600]) {
        const chosen = selections[s];
        const mark = new Uint8Array(n);
        // Mark each wet cell: graph lake, chosen pocket (deepest point within the component), other.
        const seen = new Uint8Array(n), stack = [];
        for (let k0 = 0; k0 < n; k0++) {
            if (seen[k0] || !(fill[k0] - h[k0] > 0.5)) continue;
            const comp = []; seen[k0] = 1; stack.push(k0); let deep = k0;
            while (stack.length) {
                const k = stack.pop(), i = k % nx, j = (k - i) / nx; comp.push(k);
                if (fill[k] - h[k] > fill[deep] - h[deep]) deep = k;
                for (const [di, dj] of NB8) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue; const q = jj * nx + ii; if (seen[q] || !(fill[q] - h[q] > 0.5)) continue; seen[q] = 1; stack.push(q); }
            }
            const d = cellDirOf(deep), cell = dirToCell(d, N);
            const kind = g.lakeOf[cell] !== -1 ? 3 : fill[deep] - h[deep] < MIN_DEPTH ? 0 : chosen.some(p => near(p, { dir: d }, 200)) ? 1 : 2;
            for (const k of comp) mark[k] = kind;
        }
        const tint = (k) => [[1, 1, 1], [0.1, 0.3, 0.95], [0.7, 0.85, 1.0], [0.9, 0.2, 0.15]][mark[k]];
        const shown = Float32Array.from(h, (v, k) => (mark[k] ? fill[k] : v));
        writePNG(path.join(out, `region-${f}-${bi}-${bj}-${result.select.mode}-spacing${s}.png`), nx, ny, hillshade(shown, nx, ny, 64, { exaggeration: 1.5, tint }));
    }
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(out, 'candidates64.json'), JSON.stringify(pockets[64].map(p => ({ ...p, dir: p.dir.map(v => +v.toFixed(7)) }))));
log('done');
sampler.destroy();
process.exit(0);
