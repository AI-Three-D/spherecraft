/* global process */
// Lab: hillshade views of mountain blocks with their natural pockets filled
// at their own spill levels (labMountainPockets.mjs census), to judge whether
// they read as lakes or pits. Blocks: the K with the most pockets over
// minAreaKm2 above minLevelM. Blue = pocket kept (area >= minAreaKm2),
// light blue = smaller pockets, red = coarse graph lakes' water.
//
//   LAB_TERRAIN_JSON='...' node tools/perf/lakeRecovery/labMountainPocketView.mjs CENSUS_DIR OUT_DIR [K=2] [minAreaKm2=0.1] [minLevelM=800] [minReliefM=0]
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/labsetup.mjs';
import { writePNG, hillshade } from '/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/png.mjs';

const [censusArg, outArg, kArg = '2', minAreaArg = '0.1', minLevelArg = '800', minReliefArg = '0'] = process.argv.slice(2);
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const lab = await setupLab(root);
const { device, gen, imp } = lab;
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { faceUVToDir, dirToCell, MinHeap, buildWaterGraph } = await imp('core/world/hydrology/waterGraph.js');
const { tangentBasis, dirToPlane, planeToDir } = await imp('core/world/hydrology/lakeRefine.js');
const R = lab.planetConfig.radius, N = 512, NN = N * N, BLOCK = 32, SPACING = 32, MARGIN = 1500;
const minArea = Number(minAreaArg), minLevel = Number(minLevelArg);
const pockets = JSON.parse(fs.readFileSync(path.join(path.resolve(censusArg), 'pockets.json'), 'utf8'));
const byBlock = new Map();
for (const p of pockets) {
    if (p.areaKm2 < minArea || p.level < minLevel || p.relief < Number(minReliefArg)) continue;
    const cell = dirToCell(p.dir, N), f = Math.floor(cell / NN), k = cell % NN;
    const key = `${f}:${Math.floor((k % N) / BLOCK)}:${Math.floor(Math.floor(k / N) / BLOCK)}`;
    byBlock.set(key, (byBlock.get(key) ?? 0) + 1);
}
const top = [...byBlock.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(kArg));
const sampler = await createHydrologySampler({ device, terrainGenerator: gen, eagerCarved: false });
const grid = await sampler.sampleGrid(N);
const g = buildWaterGraph({ N, heights: grid.heights, seaLevelM: grid.seaLevelM, precip: grid.precip });
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const views = [];
for (const [key, count] of top) {
    const [f, bi, bj] = key.split(':').map(Number);
    const c = faceUVToDir(f, (bi * BLOCK + BLOCK / 2) / N, (bj * BLOCK + BLOCK / 2) / N), frame0 = { c, ...tangentBasis(c) };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [x, y] = dirToPlane(faceUVToDir(f, (bi + u) * BLOCK / N, (bj + v) * BLOCK / N), frame0, R);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const frame = { ...frame0, spacing: SPACING, x0: xMin - MARGIN, y0: yMin - MARGIN,
        nx: Math.ceil((xMax - xMin + 2 * MARGIN) / SPACING), ny: Math.ceil((yMax - yMin + 2 * MARGIN) / SPACING) };
    const h = await sampler.samplePatch(frame, R);
    const { nx, ny } = frame, n = nx * ny;
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
    // Classify each wet component by area; graph-lake water in red.
    const cls = new Uint8Array(n), seen = new Uint8Array(n), stack = [], comp = [];
    for (let k0 = 0; k0 < n; k0++) {
        if (seen[k0] || !(fill[k0] - h[k0] > 0.5)) continue;
        comp.length = 0; seen[k0] = 1; stack.push(k0);
        let deep = k0;
        while (stack.length) {
            const k = stack.pop(), i = k % nx, j = (k - i) / nx;
            comp.push(k);
            if (fill[k] - h[k] > fill[deep] - h[deep]) deep = k;
            for (const [di, dj] of NB8) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                const q = jj * nx + ii;
                if (seen[q] || !(fill[q] - h[q] > 0.5)) continue;
                seen[q] = 1; stack.push(q);
            }
        }
        const areaKm2 = comp.length * SPACING * SPACING / 1e6, depth = fill[deep] - h[deep];
        const dir = planeToDir(frame.x0 + (deep % nx + 0.5) * SPACING, frame.y0 + (Math.floor(deep / nx) + 0.5) * SPACING, frame, R);
        const kind = g.lakeOf[dirToCell(dir, N)] !== -1 ? 3 : depth < 3 ? 0 : areaKm2 >= minArea ? 1 : 2;
        for (const k of comp) cls[k] = kind;
    }
    const tint = (k) => [[1, 1, 1], [0.15, 0.35, 0.95], [0.55, 0.8, 1.0], [0.9, 0.2, 0.15]][cls[k]];
    // Water shades as its flat surface; dry land as terrain.
    const shown = Float32Array.from(h, (v, k) => (cls[k] ? fill[k] : v));
    const rgb = hillshade(shown, nx, ny, SPACING, { exaggeration: 1.5, tint });
    const file = `block-${f}-${bi}-${bj}.png`;
    writePNG(path.join(out, file), nx, ny, rgb);
    let hMin = Infinity, hMax = -Infinity; for (const v of h) { if (v < hMin) hMin = v; if (v > hMax) hMax = v; }
    views.push({ file, face: f, bi, bj, pocketsOverMinArea: count, sizeKm: [nx * SPACING / 1000, ny * SPACING / 1000], heightRangeM: [hMin, hMax] });
}
fs.writeFileSync(path.join(out, 'views.json'), JSON.stringify(views, null, 1));
console.log(JSON.stringify(views, null, 1));
sampler.destroy();
process.exit(0);
