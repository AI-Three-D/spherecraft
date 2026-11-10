// Lakes near a place, in Node on the GPU (terrain-lab): each lake's record
// (tier, centre, level, shape) and its river (LakeCellRivers), and the ground
// and water along a line (sampleWater: height, water level, third value).
//   LAKE_AT="x,y,z" LAKE_LINE="x0,y0,x1,y1" (m in the tangent plane at LAKE_AT) node tools/perf/lakeCells/lakeProbe.mjs   (from spherecraft/)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { LakeCellRivers } = await imp('core/world/hydrology/lakeCellRivers.js');
const { tangentBasis, planeToDir, dirToPlane } = await imp('core/world/hydrology/lakeRefine.js');
const R = lab.planetConfig.radius;
const at = process.env.LAKE_AT.split(',').map(Number), l = Math.hypot(...at), c = at.map(v => v / l);
const frame = { c, ...tangentBasis(c) };
await gen.lakeTable.ensureArea(c, 3000);
await device.queue.onSubmittedWorkDone();
const lakes = await gen.lakeTable.readLakes();
const rivers = new LakeCellRivers({ device, gen });
while (await rivers.plan(lakes, 50, c));
const near = lakes.map(x => ({ x, p: dirToPlane(x.centre, frame, R) })).filter(e => Math.hypot(...e.p) < 1500).sort((a, b) => Math.hypot(...a.p) - Math.hypot(...b.p));
for (const { x, p } of near) {
    const v = rivers.byKey.get(x.key) ?? {};
    const brief = {}; for (const [k, val] of Object.entries(x)) if (typeof val !== 'object' || k === 'shape') brief[k] = val;
    console.log(JSON.stringify({ at: p.map(Math.round), ...brief, ownQ: rivers._ownQ?.(x), river: v.river ? { dest: v.dest?.kind, lengthM: Math.round(v.river.lengthM ?? 0), hw: v.river.points?.[4] } : null, none: v.none ?? null }).slice(0, 600));
}
// The nearest lake's own axis (its frame a1, a2): shape distance u (0 at the
// core's edge, uC the containment curve), ground, water.
if (near.length) {
    const L = near[0].x, { lakeShapeU } = await imp('core/world/terrain-generator/lakeCellShape.js');
    const fr = { c: L.centre, e1: L.a1, e2: L.a2 }, n = 57, dirs = new Float32Array(n * 4), xs = [];
    for (let i = 0; i < n; i++) { const x = -840 + 30 * i; xs.push(x); dirs.set(planeToDir(x, 0, fr, R), i * 4); }
    const w = await gen.lakeTable.sampleWater(dirs);
    for (let i = 0; i < n; i++) console.log(`axis x ${String(xs[i]).padStart(5)}: u ${lakeShapeU(L.shape, xs[i], 0).toFixed(0).padStart(5)} (uC ${L.uC.toFixed(0)}) ground ${w[i * 3].toFixed(1)} water ${w[i * 3 + 1].toFixed(1)}`);
}
if (process.env.LAKE_LINE) {
    const [x0, y0, x1, y1] = process.env.LAKE_LINE.split(',').map(Number), n = 41, dirs = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) dirs.set(planeToDir(x0 + (x1 - x0) * i / (n - 1), y0 + (y1 - y0) * i / (n - 1), frame, R), i * 4);
    const w = await gen.lakeTable.sampleWater(dirs);
    for (let i = 0; i < n; i++) console.log(`line ${(i / (n - 1) * Math.hypot(x1 - x0, y1 - y0)).toFixed(0).padStart(5)} m: ground ${w[i * 3].toFixed(1)} water ${w[i * 3 + 1].toFixed(1)} c ${w[i * 3 + 2].toFixed(2)}`);
}
process.exit(0);
