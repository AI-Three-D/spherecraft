// Lake cells in the terrain function (LAKE_CELLS_PLAN.md): measurements and
// images on the GPU in Node (terrain-lab), no browser.
//
//   node tools/perf/lakeCells/lakeCellsLab.mjs <outDir>      (from spherecraft/)
//
// 1. Band refactor check: earthLike and lakeLand with lakes off agree.
// 2. Coverage at the 48 sites of the old system's census
//    (oldLakeSites-2026-11-07.json: 5 km disks, 150 m spacing): wet share of
//    land, lakes by equivalent radius.
// 3. Per lake (centre in a disk): wet area, containment (720 points on the
//    ring, lowest ground minus level), raise and cut against lakes off.
// 4. GPU time per million samples: earthLike, lakeLand lakes off / on.
// 5. Images: lakes off | lakes on with water and rings | change (+-30 m),
//    at the owner's poses and the flattest, middle and roughest sites.
// 6. Perspective views (lab proxies for the game, not screenshots): oblique
//    aerial views, lakes off above, on below, flat water at each lake's level.
// LAKE_QUICK=1: metrics only (no timing, images or views; coarser lake grids).
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';
import { writePNG, hillshade, diverging, montage } from '../../../../terrain-lab/png.mjs';

const root = process.cwd();
const outDir = path.resolve(process.argv[2] ?? 'tools/perf/lakeCells/out');
fs.mkdirSync(outDir, { recursive: true });
const lab = await setupLab(root);
const { device, gen, imp, bundle, profiler, collectProfile } = lab;
const { createAdvancedTerrainComputeShader } = await imp('core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js');
const { TERRAIN_FEATURES } = await imp('core/world/terrain-generator/terrainFeatureToggles.js');
const { createLakeLandConstants, createLakeLandBase } = await imp('templates/terrain-shaders/base/lakeLandBase.wgsl.js');
const { LAKE_CELL_TIERS } = await imp('templates/terrain-shaders/features/featureLakeCells.wgsl.js');
bundle.baseGenerators.lakeLand = { constants: createLakeLandConstants, base: createLakeLandBase };
const R = gen.worldScale;
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));

const PROBE_LAKES = `
@group(2) @binding(0) var<storage, read> probeDirs: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> probeOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn probeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&probeDirs)) { return; }
    let dir = normalize(probeDirs[i].xyz);
    let seed = uniforms.seed;
    let H = maxTerrainHeightM();
    let h = calculateTerrainHeightD(seed, dir).x * H;
    let B = landBands_d(seed, dir);
    var hit: LakeHit;
    if (terrainFeatureOn(TF_LAKE_BASINS) && B.landBlend.x > 0.0) { hit = lakeCellFind(seed, dir, B); }
    var rel = 9.0;
    if (hit.found) { rel = hit.rel; }
    let off = softClampHeight_d(B.b0 + B.b1 + B.b2 + B.b3, -1.1, 1.8, 0.25).x * H;
    probeOut[i * 3u] = vec4<f32>(h, B.landBlend.x, select(0.0, 1.0, hit.found), hit.level);
    probeOut[i * 3u + 1u] = vec4<f32>(rel, f32(hit.tier), hit.rb, off);
    probeOut[i * 3u + 2u] = vec4<f32>(hit.centre, f32(hit.reason));
}
@compute @workgroup_size(64)
fn probeRing(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&probeDirs)) { return; }
    probeOut[i * 3u] = vec4<f32>(lakeContainmentAt(uniforms.seed, normalize(probeDirs[i].xyz), i32(probeDirs[i].w), 120), 0.0, 0.0, 0.0);
}`;
const PROBE_PLAIN = `
@group(2) @binding(0) var<storage, read> probeDirs: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> probeOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn probeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&probeDirs)) { return; }
    let h = calculateTerrainHeightD(uniforms.seed, normalize(probeDirs[i].xyz)).x * maxTerrainHeightM();
    probeOut[i * 3u] = vec4<f32>(h, 0.0, 0.0, 0.0);
    probeOut[i * 3u + 1u] = vec4<f32>(9.0, -1.0, 0.0, h);
    probeOut[i * 3u + 2u] = vec4<f32>(0.0);
}`;

const g0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }] });
const g2 = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
] });
async function makeProbe(baseGenerator, probeSrc, entryPoint = 'probeMain') {
    const opts = { ...gen._getAdvancedTerrainShaderOptions({ outputFormat: 'rgba32float' }), baseGenerator };
    const code = createAdvancedTerrainComputeShader(opts) + probeSrc;
    const module = device.createShaderModule({ code, label: `probe-${baseGenerator}` });
    const errs = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (errs.length) throw new Error(errs.slice(0, 5).map(e => `${e.lineNum}: ${e.message}`).join('\n'));
    const t0 = performance.now();
    const pipe = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [g0, gen.biomeBindGroupLayout, g2] }),
        compute: { module, entryPoint },
    });
    console.log(`[lab] ${baseGenerator} probe compiled in ${Math.round(performance.now() - t0)} ms`);
    return pipe;
}
const uBuf = device.createBuffer({ size: 4096, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const allOn = Object.fromEntries(TERRAIN_FEATURES.map(f => [f.key, true]));

// dirs: Float32Array(n * 4). Returns Float32Array(n * 12).
async function run(pipe, dirs, { lakes = true, label = 'probe', chunk = 64 * 256 } = {}) {
    gen.setTerrainFeatures({ ...allOn, lakeBasins: lakes });
    const view = gen._fillTerrainUniformScratch(0, 0, 128, 1, 0);
    device.queue.writeBuffer(uBuf, 0, view.buffer, view.byteOffset, view.byteLength);
    const n = dirs.length / 4, out = new Float32Array(n * 12), CH = chunk;
    for (let s = 0; s < n; s += CH) {
        const m = Math.min(CH, n - s);
        const inBuf = device.createBuffer({ size: m * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(inBuf, 0, dirs.buffer, dirs.byteOffset + s * 16, m * 16);
        const outBuf = device.createBuffer({ size: m * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const rb = device.createBuffer({ size: m * 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder({ label });
        const pass = enc.beginComputePass({ label });
        pass.setPipeline(pipe);
        pass.setBindGroup(0, device.createBindGroup({ layout: g0, entries: [{ binding: 0, resource: { buffer: uBuf } }] }));
        gen._setTerrainBiomeBindGroup(pass);
        pass.setBindGroup(2, device.createBindGroup({ layout: g2, entries: [
            { binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }));
        pass.dispatchWorkgroups(Math.ceil(m / 64));
        pass.end();
        enc.copyBufferToBuffer(outBuf, 0, rb, 0, m * 48);
        device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        out.set(new Float32Array(rb.getMappedRange().slice(0)), s * 12);
        rb.unmap();
        inBuf.destroy(); outBuf.destroy(); rb.destroy();
    }
    return out;
}

const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function frame(c) {
    const up = Math.abs(c[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm(cross(up, c)), e2 = cross(c, e1);
    return { e1, e2 };
}
// Square patch of side sizeM centred on c (S x S samples).
function patchDirs(c, sizeM, S) {
    const { e1, e2 } = frame(c), d = new Float32Array(S * S * 4);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const x = (i / (S - 1) - 0.5) * sizeM, y = (0.5 - j / (S - 1)) * sizeM;
        const p = norm([0, 1, 2].map(k => c[k] + (x * e1[k] + y * e2[k]) / R));
        d.set([...p, 0], (j * S + i) * 4);
    }
    return d;
}
// Disk of radius rM at spacing sM (Codex's census: 5000 m, 150 m).
function diskDirs(c, rM, sM) {
    const { e1, e2 } = frame(c), pts = [];
    const n = Math.floor(rM / sM);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
        if (Math.hypot(i, j) * sM > rM) continue;
        pts.push(...norm([0, 1, 2].map(k => c[k] + (i * sM * e1[k] + j * sM * e2[k]) / R)), 0);
    }
    return new Float32Array(pts);
}
const at = (o, i) => ({ h: o[i * 12], land: o[i * 12 + 1], found: o[i * 12 + 2] > 0.5, level: o[i * 12 + 3], rel: o[i * 12 + 4],
    tier: o[i * 12 + 5], rho: o[i * 12 + 6], off: o[i * 12 + 7], centre: [o[i * 12 + 8], o[i * 12 + 9], o[i * 12 + 10]], reason: o[i * 12 + 11] });
const wet = s => s.found && s.rel < 1 && s.h < s.level;
const key = c => c.map(v => v.toFixed(6)).join(',');

const lakePipe = await makeProbe('lakeLand', PROBE_LAKES);
const plainPipe = await makeProbe('earthLike', PROBE_PLAIN);
const lakeHeightPipe = await makeProbe('lakeLand', PROBE_PLAIN);
const ringPipe = await makeProbe('lakeLand', PROBE_LAKES, 'probeRing');
const ref = JSON.parse(fs.readFileSync(path.join(root, 'tools/perf/lakeCells/oldLakeSites-2026-11-07.json'), 'utf8'));
const results = { radiusM: R, seed: lab.engineConfig.seed, tiers: LAKE_CELL_TIERS };

// 1. Band refactor check (earthLike with its 25 m hollows off).
{
    const d = patchDirs(norm([-1, 0, 0]), 20000, 256);
    gen.setTerrainFeatures({ ...allOn, lakeBasins: false });
    const a = await run(plainPipe, d, { lakes: false });
    const b = await run(lakePipe, d, { lakes: false });
    let maxD = 0;
    for (let i = 0; i < d.length / 4; i++) maxD = Math.max(maxD, Math.abs(a[i * 12] - b[i * 12]));
    results.refactorMaxDiffM = maxD;
    console.log(`[lab] refactor check: earthLike vs lakeLand (lakes off) max |dh| = ${maxD.toFixed(4)} m`);
}

// 2. Coverage at the 48 sites.
const lakes = new Map(), rejected = new Map();
let landN = 0, wetN = 0;
const siteStats = [];
for (const site of ref.sites) {
    const c = norm(site.direction), d = diskDirs(c, ref.observationRadiusM, ref.sampleSpacingM);
    const o = await run(lakePipe, d);
    let land = 0, w = 0, offSum = 0, offSq = 0;
    for (let i = 0; i < d.length / 4; i++) {
        const s = at(o, i);
        if (s.land < 0.999) continue;
        land++; offSum += s.off; offSq += s.off * s.off;
        if (wet(s)) w++;
        if ((s.found || s.reason > 0) && !lakes.has(key(s.centre)) && !rejected.has(key(s.centre))) {
            const dist = Math.acos(Math.min(1, s.centre[0] * c[0] + s.centre[1] * c[1] + s.centre[2] * c[2])) * R;
            if (dist <= ref.observationRadiusM) {
                if (s.found) lakes.set(key(s.centre), { centre: s.centre, rho: s.rho, level: s.level, tier: s.tier });
                else rejected.set(key(s.centre), { tier: s.tier, reason: s.reason });
            }
        }
    }
    landN += land; wetN += w;
    const mean = land ? offSum / land : 0;
    siteStats.push({ direction: c, land, wet: w, oldWet: site.oldWetSamples, oldLand: site.landSamples,
        reliefStdM: land ? Math.sqrt(Math.max(0, offSq / land - mean * mean)) : 0 });
}
results.coverage = { landSamples: landN, wetSamples: wetN, wetShareOfLand: wetN / landN,
    old: { landSamples: ref.landSamples, wetSamples: ref.oldWetSamples, wetShareOfLand: ref.oldWetSamples / ref.landSamples } };
const REASONS = ['', 'centre ocean', 'rim ocean', 'too rough', 'level at sea', 'headwall', 'shore slope', 'blocked', 'relief inside'];
results.rejected = LAKE_CELL_TIERS.map((t, i) => ({ tier: t.name, accepted: [...lakes.values()].filter(l => l.tier === i).length,
    ...Object.fromEntries(REASONS.slice(1).map((r, k) => [r, [...rejected.values()].filter(x => x.tier === i && x.reason === k + 1).length])) }));
console.log(`[lab] candidates by tier: ${JSON.stringify(results.rejected)}`);
console.log(`[lab] coverage: ${wetN}/${landN} land samples wet (${(100 * wetN / landN).toFixed(1)} %), old ${(100 * ref.oldWetSamples / ref.landSamples).toFixed(1)} %`);

// 3. Per lake: area, raise and cut over the full support; containment on
// the lake's own curve on final heights (lakeContainmentAt).
const QUICK = process.env.LAKE_QUICK === '1';
const list = [...lakes.values()], G = QUICK ? 48 : 96;
const lakeDirs = new Float32Array(list.length * G * G * 4);
list.forEach((L, k) => {
    const { e1, e2 } = frame(L.centre), base = k * G * G;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const x = (i / (G - 1) * 2 - 1) * L.rho, y = (j / (G - 1) * 2 - 1) * L.rho;
        lakeDirs.set([...norm([0, 1, 2].map(q => L.centre[q] + (x * e1[q] + y * e2[q]) / R)), 0], (base + j * G + i) * 4);
    }
});
console.log(`[lab] per-lake grids: ${list.length} lakes`);
const lo = list.length ? await run(lakePipe, lakeDirs, { chunk: 64 * 64 }) : new Float32Array(0);
console.log('[lab] containment check');
// One thread per point of each lake's containment curve (120 per lake).
const ring = list.length ? await run(ringPipe, new Float32Array(list.flatMap(L => Array.from({ length: 120 }, (_, k) => [...L.centre, k]).flat())), { chunk: 64 * 16 }) : new Float32Array(0);
const ringMin = k => { let m = Infinity; for (let j = 0; j < 120; j++) m = Math.min(m, ring[(k * 120 + j) * 12]); return m; };
const bins = [0, 100, 250, 500, 1000, 2500, 5000];
const binOf = r => bins.reduce((b, lo2, i) => (r >= lo2 ? i : b), 0);
const perLake = list.map((L, k) => {
    const base = k * G * G, cell = (2 * L.rho / (G - 1)) ** 2;
    let wetCells = 0, raise = 0, cut = 0;
    for (let i = 0; i < G * G; i++) {
        const s = at(lo, base + i);
        if (s.land < 0.999) continue;
        const own = s.found && key(s.centre) === key(L.centre);
        if (own && wet(s)) { wetCells++; continue; }
        raise = Math.max(raise, s.h - s.off);
        cut = Math.max(cut, s.off - s.h);
    }
    const eqR = Math.sqrt(wetCells * cell / Math.PI);
    return { tier: L.tier, supportM: L.rho, level: L.level, centre: L.centre, eqR, ringMinM: ringMin(k), raiseM: raise, cutM: cut };
});
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
results.lakes = {
    count: perLake.length,
    byTier: LAKE_CELL_TIERS.map((t, i) => perLake.filter(l => l.tier === i).length),
    sizeBinsM: bins,
    sizeBins: bins.map((_, i) => perLake.filter(l => binOf(l.eqR) === i).length),
    oldSizeBins: ref.oldLakeCounts,
    dryLakes: perLake.filter(l => l.eqR === 0).length,
    containmentViolations: perLake.filter(l => l.ringMinM < 0).length,
    ringMinM: { min: pct(perLake.map(l => l.ringMinM), 0), p50: pct(perLake.map(l => l.ringMinM), 0.5) },
    raiseM: { p50: pct(perLake.map(l => l.raiseM), 0.5), p90: pct(perLake.map(l => l.raiseM), 0.9), max: pct(perLake.map(l => l.raiseM), 1) },
    cutM: { p50: pct(perLake.map(l => l.cutM), 0.5), p90: pct(perLake.map(l => l.cutM), 0.9), max: pct(perLake.map(l => l.cutM), 1) },
    perLake,
};
console.log(`[lab] lakes with centres in the disks: ${perLake.length} (old ${ref.oldLakeCounts.reduce((a, b) => a + b, 0)}), by tier ${results.lakes.byTier.join('/')}`);
console.log(`[lab] size bins ${JSON.stringify(results.lakes.sizeBins)} (old ${JSON.stringify(ref.oldLakeCounts)}), dry ${results.lakes.dryLakes}`);
console.log(`[lab] containment violations ${results.lakes.containmentViolations}, ring min ${JSON.stringify(results.lakes.ringMinM)}`);
console.log(`[lab] raise ${JSON.stringify(results.lakes.raiseM)} cut ${JSON.stringify(results.lakes.cutM)}`);

// 4. GPU time (warm, 512 x 512 patch at the spawn).
if (!QUICK) {
    const d = patchDirs(norm([-1, 0, 0]), 20000, 512), n = d.length / 4;
    const time = async (pipe, lakesOn) => {
        await run(pipe, d, { lakes: lakesOn });
        profiler.enabled = true; await collectProfile();
        await run(pipe, d, { lakes: lakesOn, label: 'timed' });
        const t = await collectProfile(); profiler.enabled = false;
        const e = t.get('timed');
        return e ? e.ns / 1e6 / (n / 1e6) : null;
    };
    results.msPerMillionSamples = { earthLike: await time(plainPipe, false), lakeLandOff: await time(lakeHeightPipe, false), lakeLandOn: await time(lakeHeightPipe, true) };
    console.log(`[lab] ms per million samples ${JSON.stringify(results.msPerMillionSamples)}`);
}

// 5. Images.
const sorted = siteStats.filter(s => s.land > 1000).sort((a, b) => a.reliefStdM - b.reliefStdM);
const views = [
    { name: 'spawn', c: norm([-1, 0, 0]) },
    { name: 'owner-camera-11-06', c: norm([-134393.9, -2970.5, -21720.4]) },
    { name: 'owner-hillside-11-07', c: norm([-103095.5, -4252.8, -84421.5]) },
    { name: 'flat-site', c: sorted[0]?.direction },
    { name: 'middle-site', c: sorted[Math.floor(sorted.length / 2)]?.direction },
    { name: 'rough-site', c: sorted[sorted.length - 1]?.direction },
].filter(v => v.c);
for (const [n, L] of [...perLake].sort((a, b) => b.eqR - a.eqR).slice(0, 2).entries())
    views.push({ name: `largest-${n + 1}`, c: L.centre, sizes: [Math.min(60000, Math.round(2.2 * L.supportM / 1000) * 1000)] });
const S = 512;
if (!QUICK && process.env.LAKE_IMAGES !== "0") for (const v of views) for (const sizeM of v.sizes ?? [24000, 6000]) {
    const d = patchDirs(v.c, sizeM, S), o = await run(lakePipe, d, { chunk: 64 * 64 }), sp = sizeM / (S - 1);
    const hOn = new Float32Array(S * S), hOff = new Float32Array(S * S), diff = new Float32Array(S * S);
    let lo2 = Infinity, hi = -Infinity;
    for (let i = 0; i < S * S; i++) {
        const s = at(o, i);
        hOn[i] = s.h; hOff[i] = s.off; diff[i] = (s.h - s.off) / 30;
        lo2 = Math.min(lo2, s.off); hi = Math.max(hi, s.off);
    }
    const tint = h => i => { const t = Math.min(1, Math.max(0, (h[i] - lo2) / Math.max(hi - lo2, 1))); return h[i] <= 0 ? [0.35, 0.45, 0.6] : [0.5 + 0.5 * t, 0.58 + 0.38 * t, 0.42 + 0.45 * t]; };
    const a = hillshade(hOff, S, S, sp, { tint: tint(hOff) });
    const b = hillshade(hOn, S, S, sp, { tint: tint(hOn) });
    for (let i = 0; i < S * S; i++) {
        const s = at(o, i);
        if (s.found && Math.abs(s.rel - 1) < 0.004 * 24000 / sizeM) { b.set([230, 200, 60], i * 3); continue; }
        if (!wet(s)) continue;
        const depth = Math.min(1, (s.level - s.h) / 15);
        b.set([30 + 40 * (1 - depth), 80 + 50 * (1 - depth), 150 + 40 * (1 - depth)], i * 3);
    }
    const m = montage([a, b, diverging(diff, S, S)], S, S);
    const file = path.join(outDir, `${v.name}-${sizeM / 1000}km.png`);
    writePNG(file, m.w, m.h, m.rgb);
    console.log(`[lab] ${file}`);
}

// 6. Perspective views.
const seaM = (lab.planetConfig.terrainGeneration?.water?.oceanLevel ?? lab.planetConfig.oceanLevel ?? -0.01) * 5000;
function perspective(h, surface, wetDepth, S, px, { camAbove = 1200, pitch = 0.1, W = 960, Hs = 440 } = {}) {
    const shade = hillshade(h, S, S, px, { light: [-0.6, -1, 0.5] });
    const color = new Float32Array(S * S * 3);
    for (let i = 0; i < S * S; i++) {
        const t = Math.max(0, Math.min(1, (h[i] - seaM) / 2000));
        const base = t < 0.35 ? [0.42 + 0.3 * t, 0.58 + 0.2 * t, 0.34] : t < 0.7 ? [0.55 + 0.25 * (t - 0.35), 0.62 - 0.3 * (t - 0.35), 0.36 - 0.1 * (t - 0.35)] : [0.64 + 0.3 * (t - 0.7), 0.52 + 0.4 * (t - 0.7), 0.33 + 0.5 * (t - 0.7)];
        const sh = shade[i * 3] / 255;
        let c = base.map(b => b * (0.35 + 0.85 * sh) * 255);
        if (wetDepth[i] > 0) { const d = Math.min(1, wetDepth[i] / 12); c = [70 - 35 * d, 130 - 50 * d, 185 - 25 * d]; }
        else if (surface[i] <= seaM) c = [40, 70, 120];
        color.set(c, i * 3);
    }
    const hv = (x, y) => { const x0 = Math.max(0, Math.min(S - 2, Math.floor(x))), y0 = Math.max(0, Math.min(S - 2, Math.floor(y))); const fx = x - x0, fy = y - y0, i = y0 * S + x0; const f = k => Math.max(surface[k], seaM); return (f(i) * (1 - fx) + f(i + 1) * fx) * (1 - fy) + (f(i + S) * (1 - fx) + f(i + S + 1) * fx) * fy; };
    const cx = 0.03 * S, cy = 0.5 * S, camZ = hv(cx, cy) + camAbove;
    const img = new Uint8Array(W * Hs * 3);
    for (let r = 0; r < Hs; r++) for (let col = 0; col < W; col++) img.set([170 - r * 0.08, 195 - r * 0.08, 220], (r * W + col) * 3);
    const ybuf = new Int32Array(W).fill(Hs);
    const focal = W * 0.8, horizon = Hs * (0.5 - pitch), maxZ = S * 1.45;
    for (let z = 2; z < maxZ; z += Math.max(0.3, z * 0.003)) {
        const haze = Math.min(0.85, (z * px) / (S * px * 1.6));
        for (let col = 0; col < W; col++) {
            const lat = (col - W / 2) / focal * z, x = cx + z, y = cy + lat;
            if (x < 0 || y < 0 || x >= S - 1 || y >= S - 1) continue;
            const sy = Math.floor(horizon + (camZ - hv(x, y)) / (z * px) * focal);
            if (sy >= ybuf[col]) continue;
            const i = Math.floor(y) * S + Math.floor(x);
            const c = [0, 1, 2].map(k => color[i * 3 + k] * (1 - haze) + [175, 198, 220][k] * haze);
            for (let r = Math.max(0, sy); r < ybuf[col]; r++) img.set(c, (r * W + col) * 3);
            ybuf[col] = Math.max(0, sy);
        }
    }
    return img;
}
if (!QUICK && process.env.LAKE_VIEWS !== '0') {
    const ranked = [...perLake].sort((a, b) => b.eqR - a.eqR);
    const mid = ranked.find(l => l.eqR > 250 && l.eqR < 900);
    const pviews = [
        ...ranked.slice(0, 2).map((L, n) => ({ name: `view-largest-${n + 1}`, c: L.centre, sizeM: Math.min(40000, 3 * L.supportM), above: 1500 })),
        ...(mid ? [{ name: 'view-medium', c: mid.centre, sizeM: Math.max(6000, 3 * mid.supportM), above: 600 }] : []),
        { name: 'view-owner-camera-11-06', c: norm([-134393.9, -2970.5, -21720.4]), sizeM: 24000, above: 1490 },
    ];
    const PS = 768;
    for (const v of pviews) {
        // Shift the patch so the camera (at 3 % of its width) looks at the
        // lake in the middle.
        const d = patchDirs(v.c, v.sizeM, PS), o = await run(lakePipe, d, { chunk: 64 * 64 }), px = v.sizeM / (PS - 1);
        const hOn = new Float32Array(PS * PS), hOff = new Float32Array(PS * PS), surf = new Float32Array(PS * PS), depth = new Float32Array(PS * PS);
        for (let i = 0; i < PS * PS; i++) {
            const q = at(o, i);
            hOn[i] = q.h; hOff[i] = q.off;
            depth[i] = wet(q) ? q.level - q.h : 0;
            surf[i] = depth[i] > 0 ? q.level : q.h;
        }
        const W = 960, Hs = 440, opt = { camAbove: v.above, W, Hs };
        const a = perspective(hOff, hOff, new Float32Array(PS * PS), PS, px, opt);
        const b = perspective(hOn, surf, depth, PS, px, opt);
        const all = new Uint8Array(W * (2 * Hs + 4) * 3).fill(30);
        all.set(a, 0); all.set(b, (Hs + 4) * W * 3);
        const file = path.join(outDir, `${v.name}.png`);
        writePNG(file, W, 2 * Hs + 4, all);
        console.log(`[lab] ${file}`);
    }
}

results.siteStats = siteStats;
results.gpuErrors = errors;
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
console.log(`[lab] ${path.join(outDir, 'results.json')}${errors.length ? `, GPU errors: ${errors.length}` : ''}`);
process.exit(0);
