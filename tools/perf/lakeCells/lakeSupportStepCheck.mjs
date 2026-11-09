// Steps where a lake's lowering is cut off: its support circle (radius rb, the
// assessment's, capped by the candidate's). Around each lake near a place, the
// heights just inside and outside rb, less the land's own slope there: a step
// is a circle on the land around the lake (owner's "crop circles" 2026-11-09).
//   node tools/perf/lakeCells/lakeSupportStepCheck.mjs      (from spherecraft/)
//   LAKE_AT="x,y,z" world position (default the owner's crop-circle view)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, device } = lab;
const R = lab.planetConfig.radius, T = gen.lakeTable;
const at = (process.env.LAKE_AT ?? '-129901.2,17978.4,15102.6').split(',').map(Number), l0 = Math.hypot(...at), c = at.map(v => v / l0);
await T.ensureArea(c, 20000);
await device.queue.onSubmittedWorkDone();
let top = -1;
for (const e of T.index.values()) top = Math.max(top, e.rec);
const staging = device.createBuffer({ size: (top + 1) * 32 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = device.createCommandEncoder();
enc.copyBufferToBuffer(T.recordBuffer, 0, staging, 0, (top + 1) * 32 * 16);
device.queue.submit([enc.finish()]);
await staging.mapAsync(GPUMapMode.READ);
const f = new Float32Array(staging.getMappedRange().slice(0));
const lakes = [];
for (const e of T.index.values()) {
    if (!e.complete) continue;
    const b = e.rec * 128, flags = f[b + 6];
    if (!((flags & 8) && (flags & 4))) continue;
    const a = b + 17 * 4, v = k => f.subarray(a + k * 4, a + k * 4 + 4);
    const centre = [f[b], f[b + 1], f[b + 2]], d = Math.acos(Math.min(1, centre[0] * c[0] + centre[1] * c[1] + centre[2] * c[2])) * R;
    if (d > 12000) continue;
    const uC = v(1)[3], fade = v(2)[0], rb = v(2)[1], extent = v(5)[3], stretch = v(6)[2];
    lakes.push({ tier: e.cell[3], d, centre, rb, candRb: f[b + 4], natural: 1.05 * extent + (uC + fade * 1.6) * stretch, stretch, extent, len: f[b + 3] });
}
console.log(`${lakes.length} lakes within 12 km`);
const n = 720, rings = [-15, -5, 5, 15];
for (const L of lakes.sort((a, b) => a.d - b.d)) {
    const e1 = (() => { const ref = Math.abs(L.centre[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; const x = [ref[1] * L.centre[2] - ref[2] * L.centre[1], ref[2] * L.centre[0] - ref[0] * L.centre[2], ref[0] * L.centre[1] - ref[1] * L.centre[0]]; const m = Math.hypot(...x); return x.map(q => q / m); })();
    const e2 = [L.centre[1] * e1[2] - L.centre[2] * e1[1], L.centre[2] * e1[0] - L.centre[0] * e1[2], L.centre[0] * e1[1] - L.centre[1] * e1[0]];
    const dirs = new Float32Array(n * rings.length * 4);
    for (let r = 0; r < rings.length; r++) for (let i = 0; i < n; i++) {
        const th = 2 * Math.PI * i / n, rad = L.rb + rings[r], x = rad * Math.cos(th), y = rad * Math.sin(th);
        const p = L.centre.map((q, j) => q + (x * e1[j] + y * e2[j]) / R), m = Math.hypot(...p);
        dirs.set([...p.map(q => q / m), 0], (r * n + i) * 4);
    }
    const h = await T.sampleHeights(dirs);
    let worst = 0, over = 0;
    for (let i = 0; i < n; i++) {
        const [a, b, cc, d] = rings.map((_, r) => h[r * n + i]);
        const step = (cc - b) - 0.5 * ((b - a) + (d - cc));
        if (Math.abs(step) > Math.abs(worst)) worst = step;
        if (Math.abs(step) > 0.2) over++;
    }
    console.log(`  tier ${L.tier} ${(L.d / 1000).toFixed(1)} km: rb ${L.rb.toFixed(0)} m (candidate cap ${L.candRb.toFixed(0)}, uncapped ${L.natural.toFixed(0)}), ` +
        `stretch ${L.stretch.toFixed(2)}, extent ${L.extent.toFixed(0)} m vs 1.05 len ${(1.05 * L.len).toFixed(0)}; step across rb up to ${worst.toFixed(2)} m, over 0.2 m at ${over} of ${n} points`);
}
process.exit(0);
