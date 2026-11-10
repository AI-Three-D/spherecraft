// How full the lake cells are, in Node on the GPU (terrain-lab): for every
// lake within LAKE_CENSUS_KM of a place, the share of its core (shape distance
// under -coreFrac x its narrowest axis, inside the outline noise) where the final
// ground lies under its level. Per tier: lakes, mean wet share, how many are
// under half and under 80 % wet; the driest lakes; and the rivers that leave
// lakes under half wet (LakeCellRivers).
//   node tools/perf/lakeCells/lakeWetCensus.mjs   (from spherecraft/)
//   LAKE_AT="x,y,z" (default the spawn), LAKE_CENSUS_KM (default 12), LAKE_CENSUS_RIVERS=0 (skip rivers)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { tangentBasis, planeToDir, dirToPlane } = await imp('core/world/hydrology/lakeRefine.js');
const { lakeShapeU } = await imp('core/world/terrain-generator/lakeCellShape.js');
const { LAKE_CELL_TIERS } = await imp('templates/terrain-shaders/features/featureLakeCells.wgsl.js');

const R = lab.planetConfig.radius;
const at = (process.env.LAKE_AT ?? `${-R},0,0`).split(',').map(Number), l = Math.hypot(...at), c = at.map(v => v / l);
const radiusM = +(process.env.LAKE_CENSUS_KM ?? 12) * 1000, frame = { c, ...tangentBasis(c) };
const coreFrac = 0.15, N = 24;
const t0 = performance.now();
await gen.lakeTable.ensureArea(c, radiusM + 3000);
await device.queue.onSubmittedWorkDone();
const all = await gen.lakeTable.readLakes();
const lakes = all.filter(x => Math.hypot(...dirToPlane(x.centre, frame, R)) < radiusM);
// Core points per lake (the lake's own frame), sampled in one batch.
const pts = [], owner = [];
for (let li = 0; li < lakes.length; li++) {
    const L = lakes[li], fr = { c: L.centre, e1: L.a1, e2: L.a2 }, ext = 1.05 * L.shape.extent, lim = -coreFrac * L.shape.minAxis;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = -ext + (i + 0.5) * 2 * ext / N, y = -ext + (j + 0.5) * 2 * ext / N;
        if (lakeShapeU(L.shape, x, y) < lim) { pts.push(planeToDir(x, y, fr, R)); owner.push(li); }
    }
}
const wet = new Float64Array(lakes.length), cnt = new Float64Array(lakes.length), highest = new Float64Array(lakes.length).fill(-Infinity);
const B = 1 << 18;
for (let s = 0; s < pts.length; s += B) {
    const n = Math.min(B, pts.length - s), dirs = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) dirs.set(pts[s + k], k * 4);
    const w = await gen.lakeTable.sampleWater(dirs);
    for (let k = 0; k < n; k++) {
        const li = owner[s + k], g = w[k * 3], L = lakes[li];
        cnt[li]++; if (g < L.level) wet[li]++;
        highest[li] = Math.max(highest[li], g - L.level);
    }
}
const rows = lakes.map((L, i) => ({ key: L.key, tier: L.tier, extent: Math.round(L.shape.extent), depth: +L.depth?.toFixed(1), wet: cnt[i] ? wet[i] / cnt[i] : NaN, highestM: +highest[i].toFixed(1), points: cnt[i] }));
const byTier = {};
for (const r of rows) {
    if (!(r.points > 0)) continue;
    const t = (byTier[LAKE_CELL_TIERS[r.tier]?.name ?? r.tier] ??= { lakes: 0, wetMean: 0, under50: 0, under80: 0 });
    t.lakes++; t.wetMean += r.wet; if (r.wet < 0.5) t.under50++; if (r.wet < 0.8) t.under80++;
}
for (const t of Object.values(byTier)) t.wetMean = +(t.wetMean / t.lakes).toFixed(3);
const sampled = rows.filter(r => r.points > 0);
const total = { lakes: sampled.length, wetMean: +(sampled.reduce((a, r) => a + r.wet, 0) / sampled.length).toFixed(3),
    under50: sampled.filter(r => r.wet < 0.5).length, under80: sampled.filter(r => r.wet < 0.8).length };
console.log(JSON.stringify({ radiusKm: radiusM / 1000, total, byTier, ms: Math.round(performance.now() - t0) }));
console.log('driest', JSON.stringify(sampled.sort((a, b) => a.wet - b.wet).slice(0, 12)));
if (process.env.LAKE_CENSUS_RIVERS !== '0') {
    const { LakeCellRivers } = await imp('core/world/hydrology/lakeCellRivers.js');
    const rivers = new LakeCellRivers({ device, gen });
    while (await rivers.plan(all, 50, c));
    const wetBy = new Map(rows.map(r => [r.key, r]));
    const dry = [];
    let planned = 0;
    for (const [key, v] of rivers.byKey) {
        if (!v.river) continue;
        const r = wetBy.get(key); if (!r) continue;
        planned++;
        if (r.wet < 0.5) dry.push({ key, wet: +r.wet.toFixed(2), extent: r.extent, hw: +(v.river.points?.[4] ?? 0).toFixed(1) });
    }
    console.log('rivers', JSON.stringify({ planned, fromLakesUnderHalfWet: dry.length, dry: dry.slice(0, 12) }));
}
process.exit(0);
