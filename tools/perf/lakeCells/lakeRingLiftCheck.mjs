// Where the containment curves hold the ground up: for the lakes near a
// place, the curve sampled densely (every ~5 m), the ground there against the
// level + margin the lift keeps (featureLakeCells.wgsl.js lakeCellsApply_d,
// ringW). Lifted stretches are a raised band along the curve.
//   node tools/perf/lakeCells/lakeRingLiftCheck.mjs           (from spherecraft/)
//   LAKE_AT="x,y,z;x,y,z" world positions (default the owner's two seam views, 2026-11-09)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { lakeShapeU } = await imp('core/world/terrain-generator/lakeCellShape.js');
const R = lab.planetConfig.radius;
const places = (process.env.LAKE_AT ?? '-130193.5,8491.8,16130.7;-130112.5,3006.5,20065.2').split(';').map(p => p.split(',').map(Number));
for (const at of places) {
    const l = Math.hypot(...at), c = at.map(v => v / l);
    await gen.lakeTable.ensureArea(c, 15000);
    await device.queue.onSubmittedWorkDone();
    const lakes = (await gen.lakeTable.readLakes()).map(k => ({ k, d: Math.acos(Math.min(1, k.centre[0] * c[0] + k.centre[1] * c[1] + k.centre[2] * c[2])) * R }))
        .filter(x => x.d < 8000).sort((a, b) => a.d - b.d);
    console.log(`place ${at.map(v => v.toFixed(0)).join(',')}: ${lakes.length} lakes within 8 km`);
    for (const { k: lake, d } of lakes.slice(0, 8)) {
        // The curve: shape distance (no noise) = uC, by bisection along rays.
        const n = Math.min(20000, Math.max(256, Math.ceil(2 * Math.PI * (lake.shape.extent + lake.uC * 1.5) / 5)));
        const dirs = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const th = 2 * Math.PI * i / n, cx = Math.cos(th), cy = Math.sin(th);
            let lo = 0, hi = lake.shape.extent * 1.05 + lake.uC * lake.shape.stretch + 1;
            for (let b = 0; b < 24; b++) { const m = 0.5 * (lo + hi); if (lakeShapeU(lake.shape, cx * m, cy * m) < lake.uC) lo = m; else hi = m; }
            const x = cx * hi, y = cy * hi, v = lake.centre.map((cc, j) => cc + (x * lake.a1[j] + y * lake.a2[j]) / R), vl = Math.hypot(...v);
            dirs.set([...v.map(q => q / vl), 0], i * 4);
        }
        const h = await gen.lakeTable.sampleHeights(dirs);
        let held = 0, minAbove = Infinity, runs = 0, prev = false;
        for (let i = 0; i < n; i++) {
            const above = h[i] - lake.level;
            minAbove = Math.min(minAbove, above);
            const isHeld = above < 0.75;   // at the lift's floor (level + 0.5, smooth max)
            if (isHeld) held++;
            if (isHeld && !prev) runs++;
            prev = isHeld;
        }
        const len = 2 * Math.PI * (lake.shape.extent + lake.uC);
        console.log(`  lake tier ${lake.tier} ${(d / 1000).toFixed(1)} km away, half-length ${lake.shape.extent.toFixed(0)} m: curve ~${(len / 1000).toFixed(1)} km, ` +
            `held at the floor ${(100 * held / n).toFixed(1)} % of it in ${runs} stretches; lowest ${minAbove.toFixed(2)} m above the level`);
    }
}
process.exit(0);
