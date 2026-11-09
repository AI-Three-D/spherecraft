// Planet-wide census of the big lakes (tiers longer than 3 x LAKE_TEXEL_M,
// default 1000 m: giant and large), from the lake table in Node on the GPU
// (terrain-lab): count per tier and water area as equivalent radius (bins of
// the old census, lakeCellsLab.mjs). Water: mask texels inside the
// containment curve where the lake terrain lies below the level.
//   node tools/perf/lakeCells/lakeBigCensus.mjs        (from spherecraft/)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { lakeCellMask } = await imp('core/world/terrain-generator/lakeCellShape.js');
const { planeToDir } = await imp('core/world/hydrology/lakeRefine.js');
const { LAKE_CELL_TIERS } = await imp('templates/terrain-shaders/features/featureLakeCells.wgsl.js');

const R = lab.planetConfig.radius, texelM = +(process.env.LAKE_TEXEL_M ?? 1000);
const spacingM = 30000, n = Math.ceil(4 * Math.PI * R * R / (spacingM * spacingM));
const t0 = performance.now();
for (let i = 0; i < n; i += 16) {
    const tiles = [];
    for (let k = i; k < Math.min(n, i + 16); k++) {
        const y = 1 - 2 * (k + 0.5) / n, r = Math.sqrt(1 - y * y), a = k * Math.PI * (3 - Math.sqrt(5));
        tiles.push({ dir: [r * Math.cos(a), y, r * Math.sin(a)], radiusM: 0.75 * spacingM, texelM });
    }
    gen.lakeTable.ensure(tiles);
    await device.queue.onSubmittedWorkDone();
}
// Every complete candidate's fate per tier: rejection reason of its final
// assessment (featureLakeCells.wgsl.js header), blocked, or a lake.
const T = gen.lakeTable, recVec4 = 32;
let top = -1;
for (const e of T.index.values()) top = Math.max(top, e.rec);
const staging = device.createBuffer({ size: (top + 1) * recVec4 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = device.createCommandEncoder();
enc.copyBufferToBuffer(T.recordBuffer, 0, staging, 0, (top + 1) * recVec4 * 16);
device.queue.submit([enc.finish()]);
await staging.mapAsync(GPUMapMode.READ);
const rf = new Float32Array(staging.getMappedRange().slice(0));
staging.unmap();
const reasonNames = ['', 'centre ocean', 'rim ocean', 'rough', 'sea level', 'headwall', 'shore slope', 'blocked', 'relief inside'];
const fates = LAKE_CELL_TIERS.map(t => ({ tier: t.name }));
for (const e of T.index.values()) {
    const tier = e.cell[3];
    if (!e.complete || LAKE_CELL_TIERS[tier].lenMax < 3 * texelM) continue;
    const b = e.rec * recVec4 * 4, flags = rf[b + 6];
    if (!(flags & 1)) continue;
    const fin = rf[b + 17 * 4], reason = rf[b + 17 * 4 + 1];
    const fate = (flags & 8) ? 'lake' : fin ? 'blocked' : reasonNames[reason] ?? `reason ${reason}`;
    fates[tier][fate] = (fates[tier][fate] ?? 0) + 1;
}
const lakes = (await gen.lakeTable.readLakes()).filter(l => LAKE_CELL_TIERS[l.tier].lenMax >= 3 * texelM);
const buildMs = performance.now() - t0;
// Water per lake: heights at its mask texels (the table covers them).
const masks = lakes.map(l => lakeCellMask(l));
let total = 0;
for (const m of masks) for (const v of m.mask) if (v) total++;
const dirs = new Float32Array(total * 4);
let o = 0;
for (const m of masks) {
    const { frame } = m;
    for (let j = 0; j < frame.ny; j++) for (let i = 0; i < frame.nx; i++) {
        if (!m.mask[j * frame.nx + i]) continue;
        dirs.set(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, frame.y0 + (j + 0.5) * frame.spacing, frame, R), o);
        o += 4;
    }
}
const h = await gen.lakeTable.sampleHeights(dirs);
const bins = [0, 100, 250, 500, 1000, 2500, 5000], binOf = r => bins.reduce((b, lo, i) => (r >= lo ? i : b), 0);
const perTier = LAKE_CELL_TIERS.map(t => ({ tier: t.name, lakes: 0, sizeBins: bins.map(() => 0) }));
const eqRs = [];
let p = 0;
lakes.forEach((l, k) => {
    const { frame, mask } = masks[k];
    let wet = 0;
    for (const v of mask) if (v) { if (h[p] < l.level) wet++; p++; }
    const eqR = Math.sqrt(wet * frame.spacing * frame.spacing / Math.PI);
    eqRs.push(eqR);
    perTier[l.tier].lakes++;
    perTier[l.tier].sizeBins[binOf(eqR)]++;
});
const sizeBins = bins.map((_, i) => eqRs.filter(r => binOf(r) === i).length);
const waterKm2 = eqRs.reduce((s, r) => s + Math.PI * r * r, 0) / 1e6;
console.log(JSON.stringify({ texelM, lakes: lakes.length, sizeBinsM: bins, sizeBins, waterKm2: +waterKm2.toFixed(0),
    perTier: perTier.filter(t => t.lakes), fates: fates.filter(f => Object.keys(f).length > 1), buildS: +(buildMs / 1000).toFixed(1) }));
process.exit(0);
