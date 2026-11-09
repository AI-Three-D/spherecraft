// Top-down map of the lake-cell rivers around a place, in Node on the GPU
// (terrain-lab): the lake terrain shaded, lake water blue, the sea dark, and
// the planned rivers (LakeCellRivers) by where they end: cyan a lake, yellow
// the sea, magenta another river; red dots: lakes whose water has no way out
// (enclosed), orange: river planning failed.
//   node tools/perf/lakeCells/lakeRiverMap.mjs [out.png]     (from spherecraft/)
//   LAKE_AT="x,y,z" (world position; default the spawn), LAKE_MAP_KM (default 70)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';
import { writePNG } from '../../../../terrain-lab/png.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { LakeCellRivers } = await imp('core/world/hydrology/lakeCellRivers.js');
const { tangentBasis, planeToDir, dirToPlane } = await imp('core/world/hydrology/lakeRefine.js');

const R = lab.planetConfig.radius, out = process.argv[2] ?? 'tools/perf/lakeCells/out/river-map.png';
const at = (process.env.LAKE_AT ?? `${-R},0,0`).split(',').map(Number), l = Math.hypot(...at), c = at.map(v => v / l);
const sizeM = +(process.env.LAKE_MAP_KM ?? 70) * 1000, W = 560, sp = sizeM / W;
await gen.lakeTable.ensureArea(c, 0.75 * sizeM);
await device.queue.onSubmittedWorkDone();
const lakes = await gen.lakeTable.readLakes();
const rivers = new LakeCellRivers({ device, gen });
while (await rivers.plan(lakes, 50, c));
const frame = { c, ...tangentBasis(c) };
const dirs = new Float32Array(W * W * 4);
for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) dirs.set(planeToDir((i + 0.5) * sp - sizeM / 2, sizeM / 2 - (j + 0.5) * sp, frame, R), (j * W + i) * 4);
// The table changed while planning (river tiles far out): cover the map again.
await gen.lakeTable.ensureArea(c, 0.75 * sizeM);
const w = await gen.lakeTable.sampleWater(dirs);
const h = new Float32Array(W * W);
for (let k = 0; k < W * W; k++) h[k] = w[k * 3];
const rgb = new Uint8Array(W * W * 3), sea = rivers.seaLevelM;
const px = (k, r, g, b) => { rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = b; };
for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, at2 = (x, y) => h[Math.min(W - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    const dx = (at2(i + 1, j) - at2(i - 1, j)) / (2 * sp) * 3, dy = (at2(i, j + 1) - at2(i, j - 1)) / (2 * sp) * 3;
    const shade = Math.max(0.15, (dx * 0.5 - dy * 0.5 + 1) / Math.hypot(dx, dy, 1) / 1.25);
    const t = Math.min(1, Math.max(0, (h[k] - sea) / 900));
    const base = [90 + 110 * t, 130 + 50 * t, 70 + 60 * t];
    if (w[k * 3 + 1] > h[k]) px(k, 40, 90, 200);
    else if (h[k] <= sea) px(k, 20, 40, 90);
    else px(k, ...base.map(v => Math.min(255, v * shade)));
}
const toPx = d => { const p = dirToPlane(d, frame, R); return [(p[0] + sizeM / 2) / sp, (sizeM / 2 - p[1]) / sp]; };
const dot = (x, y, r, col) => { for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) { const X = Math.round(x + a), Y = Math.round(y + b); if (X >= 0 && Y >= 0 && X < W && Y < W && a * a + b * b <= r * r) px(Y * W + X, ...col); } };
const colours = { lake: [0, 230, 255], sea: [255, 230, 0], river: [255, 0, 220] };
const counts = { lake: 0, sea: 0, river: 0, enclosed: 0, failed: 0 };
const byKey = new Map(lakes.map(x => [x.key, x]));
for (const [key, v] of rivers.byKey) {
    const lake = byKey.get(key);
    if (v.river) {
        counts[v.dest.kind]++;
        const P = v.river.points, st = v.river.stride, col = colours[v.dest.kind];
        for (let k = 0; k + 1 < P.length / st; k++) {
            const [x0, y0] = toPx([P[k * st], P[k * st + 1], P[k * st + 2]]), [x1, y1] = toPx([P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]]);
            const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
            for (let s = 0; s <= n; s++) dot(x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n, 1, col);
        }
        const [sx, sy] = toPx([P[0], P[1], P[2]]);
        dot(sx, sy, 2, [255, 255, 255]);
    } else if (lake && (v.none === 'enclosed' || v.failed)) {
        counts[v.failed ? 'failed' : 'enclosed']++;
        const [x, y] = toPx(lake.centre);
        dot(x, y, 3, v.failed ? [255, 140, 0] : [255, 30, 30]);
    }
}
writePNG(out, W, W, rgb);
console.log(JSON.stringify({ out, sizeKm: sizeM / 1000, metresPerPixel: sp, lakes: lakes.length, ...counts, stats: { none: rivers.stats.none, lastError: rivers.stats.lastError } }));
process.exit(0);
