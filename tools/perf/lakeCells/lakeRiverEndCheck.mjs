// A lake-cell river's ends against its lakes, in Node on the GPU
// (terrain-lab): along the course and on past both ends, the ground, the
// record's in-lake flag and water level, the lake water there, and what the
// baked river field holds (water level W, carve delta, edge distance sdf).
//   node tools/perf/lakeCells/lakeRiverEndCheck.mjs [river index]   (from spherecraft/)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { WaterService } = await imp('core/world/hydrology/WaterService.js');
const { WaterGpuData } = await imp('core/world/water/WaterGpuData.js');
const { RiverFieldService } = await imp('core/world/water/RiverFieldService.js');
const { sampleRiverField } = await imp('core/world/water/riverField.js');
const R = lab.planetConfig.radius, spawn = { x: -R - 2000, y: 0, z: 0 };
await gen.lakeTable.ensureArea([-1, 0, 0], 40000);
const water = new WaterService({ device, terrainGenerator: gen, planetConfig: lab.planetConfig, useWorker: false });
await water.start();
const L = water._lakeCells;
for (let k = 0; k < 3000 && (!water.lakes?.length || L.reading || L.planning || L.plannedKnown !== L.known.size); k++) { water.update(spawn); await new Promise(r => setTimeout(r, 100)); }
const recs = [...water.riverRecs.values()];
const pick = process.argv[2] === 'rapid' ? recs.findIndex(r => r.rapid) : +(process.argv[2] ?? recs.findIndex(r => r.dest?.kind === 'lake'));
const rec = recs[pick], P = rec.points, st = rec.stride, n = P.length / st;
const gpu = new WaterGpuData(device, { gridN: water.config.gridN, planetRadius: R, carve: water.config.carve, maxLakes: 4096, maskLayerSize: 64, maskTilesPerAxis: 8, maxMaskLayers: 4096 });
const camAt0 = k => ({ x: P[k * st] * (R + 300), y: P[k * st + 1] * (R + 300), z: P[k * st + 2] * (R + 300) });
const rk = (() => { if (!rec.rapid) return 0; let s0 = 0, k = 0; for (; k + 1 < n; k++) { s0 += Math.hypot(P[(k+1)*st]-P[k*st],P[(k+1)*st+1]-P[k*st+1],P[(k+1)*st+2]-P[k*st+2]) * R; if (s0 > rec.rapid.startM) break; } return k; })();
const camAt = () => camAt0(rk);
gpu.update(water, camAt(0), 0);
const field = new RiverFieldService({ water: gpu, service: water, terrainGenerator: gen, config: water.config.riverField ?? {} });
for (let k = 0; k < 600 && !(field.stats && !field.busy); k++) { field.update(camAt(0)); await new Promise(r => setTimeout(r, 50)); }
// Stations: back from the start along its tangent, the course, on past the end.
const pt = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const along = (a, b, m) => norm(a.map((v, i) => v + (a[i] - b[i]) / Math.hypot(...a.map((x, j) => x - b[j])) * m / R));
const rows = [];
for (const m of [300, 200, 120, 60, 20]) rows.push({ s: -m, d: along(pt(0), pt(1), m), k: -1 });
let s = 0;
for (let k = 0; k < n; k++) {
    if (k) s += Math.hypot(...pt(k).map((v, i) => v - pt(k - 1)[i])) * R;
    rows.push({ s, d: pt(k), k });
}
for (const m of [20, 60, 120, 200, 300]) rows.push({ s: s + m, d: along(pt(n - 1), pt(n - 2), m), k: -2 });
const d4 = new Float32Array(rows.length * 4);
rows.forEach((r, i) => d4.set([...r.d, 0], i * 4));
const wat = await gen.lakeTable.sampleWater(d4);
const show = rows.filter((r, i) => i < 5 || i >= rows.length - 5 || r.k % Math.max(1, Math.floor(n / 40)) === 0 || r.k < 12 || r.k > n - 13);
console.log(`river ${pick} of ${recs.length}: dest ${JSON.stringify(rec.dest)}, ${n} points, ${(s / 1000).toFixed(2)} km, field ${field.rivers.size} rivers, ${field.wetPages?.length ?? 0} wet pages`);
if (rec.rapid) console.log(`rapid from ${rec.rapid.startM.toFixed(0)} m, ${rec.rapid.lengthM.toFixed(0)} m long, ${rec.rapid.dropM.toFixed(1)} m drop`);
console.log('    s m   ground  lakeLvl | inLake recLevel width | field: W      delta   sdf  carved-W');
for (const r of show) {
    const i = rows.indexOf(r), f = sampleRiverField(field.pages, field.layout, r.d);
    const h = wat[i * 3], lv = wat[i * 3 + 1];
    const rl = r.k >= 0 ? `${String(P[r.k * st + 9]).padStart(6)} ${P[r.k * st + 3].toFixed(1).padStart(8)} ${P[r.k * st + 4].toFixed(1).padStart(5)}` : '     -        -     -';
    console.log(`${r.s.toFixed(0).padStart(7)} ${h.toFixed(1).padStart(8)} ${(lv > -1e8 ? lv.toFixed(1) : '-').padStart(8)} | ${rl} | ${f.found ? `${f.W.toFixed(1).padStart(7)} ${f.delta.toFixed(1).padStart(7)} ${f.sdf.toFixed(1).padStart(6)} ${(h + f.delta - f.W).toFixed(1).padStart(7)}` : 'no page'}`);
}
// Across the river at given arcs (LAKE_END_ACROSS="382,2420"): sdf and carved - W every 2 m.
if (process.env.LAKE_END_ACROSS) for (const at of process.env.LAKE_END_ACROSS.split(',').map(Number)) {
    const r0 = rows.reduce((a, b) => (Math.abs(b.s - at) < Math.abs(a.s - at) ? b : a)), k = r0.k;
    const t = norm(pt(Math.min(n - 1, k + 1)).map((v, i) => v - pt(Math.max(0, k - 1))[i])), up = pt(k);
    const side = norm([up[1] * t[2] - up[2] * t[1], up[2] * t[0] - up[0] * t[2], up[0] * t[1] - up[1] * t[0]]);
    const ds = [], dd = new Float32Array(31 * 4);
    for (let j = -15; j <= 15; j++) { const d = norm(up.map((v, i) => v + side[i] * j * 2 / R)); ds.push(d); dd.set([...d, 0], (j + 15) * 4); }
    const hh = await gen.lakeTable.sampleHeights(dd);
    console.log(`across at ${r0.s.toFixed(0)} m (record hw ${P[k * st + 4].toFixed(1)}): ` + ds.map((d, j) => { const f = sampleRiverField(field.pages, field.layout, d); return `${(j - 15) * 2}:${f.sdf.toFixed(0)}/${(hh[j] + f.delta - f.W).toFixed(1)}`; }).join(' '));
}
// The field's natural ground (the water service's hydrology sampler) against the lake table's probe.
if (process.env.LAKE_END_DEBUG) {
    const d = new Float32Array(10 * 4);
    rows.slice(0, 10).forEach((r, i) => d.set([...r.d, 0], i * 4));
    const nat = await water._sampler.sampleDirsNatural(d);
    rows.slice(0, 10).forEach((r, i) => console.log(`s ${r.s.toFixed(0)}: probe ${wat[rows.indexOf(r) * 3].toFixed(1)}, sampler ${(nat.heights ?? nat)[i]?.toFixed?.(1) ?? JSON.stringify(nat).slice(0, 80)}`));
}
// The lake lookup the field's bake uses (WaterGpuData.lakeEdgeAt) inside the source lake.
if (process.env.LAKE_END_DEBUG) for (const r of rows.slice(0, 5)) {
    const e = gpu.lakeEdgeAt(r.d), a = gpu.lakeAt(r.d), { dirToCell } = await imp('core/world/hydrology/waterGraph.js'), cell = dirToCell(r.d, gpu.N);
    console.log(`s ${r.s}: lakeEdgeAt ${JSON.stringify(e)}, lakeAt ${JSON.stringify(a)}, cell slots ${JSON.stringify(gpu._lakeSlots(cell))}, layers ${JSON.stringify(gpu._lakeSlots(cell).map(sl => gpu._layerOf.get(sl - 1)))}, applied ${JSON.stringify(gpu._lakeSlots(cell).map(sl => !!gpu._applied.get(sl - 1)))}`);
}
field.dispose?.();
process.exit(0);
