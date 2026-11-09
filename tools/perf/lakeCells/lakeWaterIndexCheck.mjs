// The water lookup grid against the lake-cell masks: every grid cell that a
// lake's water texels cover must list the lake, or its water is dropped there
// (the owner's 2026-11-09 checkerboard). Lakes around one place, in Node on
// the GPU (terrain-lab).
//   node tools/perf/lakeCells/lakeWaterIndexCheck.mjs      (from spherecraft/)
//   LAKE_AT="x,y,z" (a world position; default the owner's checkerboard view)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp } = lab;
const { lakeCellMask } = await imp('core/world/terrain-generator/lakeCellShape.js');
const { regionalWaterModel } = await imp('core/world/hydrology/regionalWater.js');
const { planeToDir } = await imp('core/world/hydrology/lakeRefine.js');
const { dirToCell } = await imp('core/world/hydrology/waterGraph.js');

const R = lab.planetConfig.radius, N = 512;
const at = (process.env.LAKE_AT ?? '-42852.0,68395.4,-112323.7').split(',').map(Number);
const l = Math.hypot(...at), dir = at.map(c => c / l);
await gen.lakeTable.ensureArea(dir, 40000);
await lab.device.queue.onSubmittedWorkDone();
const lakes = await gen.lakeTable.readLakes();
const basins = lakes.map((lake, id) => {
    const m = lakeCellMask(lake);
    return { id, centre: lake.centre, levelM: lake.level, radiusM: m.radiusM, frame: m.frame, mask: m.mask, tier: lake.tier };
});
const t0 = performance.now();
const model = regionalWaterModel({ sourceKey: 'check', basins, drainageConfig: null, drainagePlan: { rivers: [] } }, R, N);
const listMs = performance.now() - t0;
// Cells under each water texel's whole footprint (where the bilinear mask
// reads >= 0.5), sampled finely, against the cells the lake is listed in.
let worst = null, totalMissing = 0, lakesMissing = 0;
for (const b of basins) {
    const { frame, mask } = b, listed = new Set(model.refined.get(b.id).maskCells), need = new Set();
    const k = 8;
    for (let j = 0; j < frame.ny; j++) for (let i = 0; i < frame.nx; i++) {
        if (!mask[j * frame.nx + i]) continue;
        for (let s = 0; s < k; s++) for (let t = 0; t < k; t++) {
            const x = frame.x0 + (i + (s + 0.5) / k) * frame.spacing, y = frame.y0 + (j + (t + 0.5) / k) * frame.spacing;
            need.add(dirToCell(planeToDir(x, y, frame, R), N));
        }
    }
    let missing = 0;
    for (const c of need) if (!listed.has(c)) missing++;
    totalMissing += missing;
    if (missing) lakesMissing++;
    const share = need.size ? missing / need.size : 0;
    if (!worst || share > worst.share) worst = { id: b.id, tier: b.tier, spacing: +frame.spacing.toFixed(1), cells: need.size, missing, share: +share.toFixed(3) };
}
// The lake nearest the given place (the owner's view looks ~7 km ahead).
const near = basins.map(b => ({ b, d: Math.acos(Math.min(1, b.centre[0] * dir[0] + b.centre[1] * dir[1] + b.centre[2] * dir[2])) * R }))
    .sort((a, b) => a.d - b.d).slice(0, 3).map(({ b, d }) => ({ id: b.id, tier: b.tier, distKm: +(d / 1000).toFixed(1), spacing: +b.frame.spacing.toFixed(1) }));
console.log(JSON.stringify({ lakes: basins.length, listMs: +listMs.toFixed(1), cellM: +(Math.PI / 2 * R / N).toFixed(0), lakesMissing, totalMissing, worst, near }, null, 1));
process.exit(0);
