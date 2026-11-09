// The lake table (LAKE_CELLS_PLAN.md): what it costs and whether it agrees
// with the direct evaluation. GPU in Node (terrain-lab), no browser.
//
//   node tools/perf/lakeCells/lakeTableLab.mjs        (from spherecraft/)
//
// 1. Equivalence: a 6 km patch around a lake, heights from the table against
//    the direct evaluation (every lake assessed where needed).
// 2. Table build per area: keys (candidate cells) and time of the three passes.
// 3. Tile cost: 128 x 128 height samples over 0.5, 4 and 32 km at the spawn
//    and at a lake, GPU time with the table against earthLike.
import fs from 'node:fs';
import path from 'node:path';
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

const root = process.cwd();
const lab = await setupLab(root);
const { device, gen, imp, bundle, profiler, collectProfile } = lab;
const { createAdvancedTerrainComputeShader } = await imp('core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js');
const { TERRAIN_FEATURES } = await imp('core/world/terrain-generator/terrainFeatureToggles.js');
const { createLakeLandConstants, createLakeLandBase } = await imp('templates/terrain-shaders/base/lakeLandBase.wgsl.js');
const { LAKE_CELL_TIERS, LAKE_RECORD_VEC4, lakeTableHash } = await imp('templates/terrain-shaders/features/featureLakeCells.wgsl.js');
bundle.baseGenerators.lakeLand = { constants: createLakeLandConstants, base: createLakeLandBase };
const R = gen.worldScale;
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));

const probeH = `
@group(2) @binding(0) var<storage, read> probeDirs: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> probeOut: array<f32>;
@compute @workgroup_size(64)
fn probeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&probeDirs)) { return; }
    probeOut[i] = calculateTerrainHeightD(uniforms.seed, normalize(probeDirs[i].xyz)).x * maxTerrainHeightM();
}`;
const buildSrc = `
@group(2) @binding(0) var<uniform> passInfo: vec4<u32>;
@compute @workgroup_size(64) fn buildBase(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x + passInfo.x; if (i >= arrayLength(&lakeKeys)) { return; } lakeBuildBase(i, uniforms.seed); }
@compute @workgroup_size(64) fn buildNested(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x + passInfo.x; if (i >= arrayLength(&lakeKeys)) { return; } lakeBuildNested(i, uniforms.seed); }
@compute @workgroup_size(64) fn buildActive(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x + passInfo.x; if (i >= arrayLength(&lakeKeys)) { return; } lakeBuildActive(i, uniforms.seed); }`;

const S = GPUShaderStage.COMPUTE;
const g0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S, buffer: { type: 'uniform' } }] });
const gProbe = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: S, buffer: { type: 'storage' } }] });
const gPass = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S, buffer: { type: 'uniform' } }] });
const gRead = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } }] });
const gBuild = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: S, buffer: { type: 'storage' } },
    { binding: 2, visibility: S, buffer: { type: 'read-only-storage' } }] });
const gEmpty = device.createBindGroupLayout({ entries: [] });

async function pipeline(baseGenerator, lakeTable, src, entryPoint, layouts) {
    const opts = { ...gen._getAdvancedTerrainShaderOptions({ outputFormat: 'rgba32float' }), baseGenerator, lakeTable };
    const module = device.createShaderModule({ code: createAdvancedTerrainComputeShader(opts) + src });
    const errs = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (errs.length) throw new Error(errs.slice(0, 5).map(e => `${e.lineNum}: ${e.message}`).join('\n'));
    return device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module, entryPoint } });
}
const plainPipe = await pipeline('earthLike', null, probeH, 'probeMain', [g0, gen.biomeBindGroupLayout, gProbe]);
const directPipe = await pipeline('lakeLand', null, probeH, 'probeMain', [g0, gen.biomeBindGroupLayout, gProbe]);
const readPipe = await pipeline('lakeLand', 'read', probeH, 'probeMain', [g0, gen.biomeBindGroupLayout, gProbe, gRead]);
const buildLayouts = [g0, gen.biomeBindGroupLayout, gPass, gBuild];
const buildPipes = {};
for (const e of ['buildBase', 'buildNested', 'buildActive']) buildPipes[e] = await pipeline('lakeLand', 'build', buildSrc, e, buildLayouts);
console.log('[table] pipelines ready');

const uBuf = device.createBuffer({ size: 4096, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const allOn = Object.fromEntries(TERRAIN_FEATURES.map(f => [f.key, true]));
gen.setTerrainFeatures(allOn);
// A fine grid in the uniforms, so every lake tier shows (the shader's LOD rule).
{ const v = gen._fillTerrainUniformScratch(0, 0, 128, 1 << 20, 0); device.queue.writeBuffer(uBuf, 0, v.buffer, v.byteOffset, v.byteLength); }
const bg0 = device.createBindGroup({ layout: g0, entries: [{ binding: 0, resource: { buffer: uBuf } }] });
const storage = (data, extra = 0) => {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra });
    device.queue.writeBuffer(b, 0, data); return b;
};

// Keys: for each tier, the lattice cells within 3 of any query point's cell,
// near the sphere (lakeCellFind searches 1 cell, the build passes 2 more).
function tableKeys(dirs) {
    const keys = [];
    LAKE_CELL_TIERS.forEach((t, tier) => {
        const centres = new Set(), out = new Set();
        for (let i = 0; i < dirs.length; i += 4) {
            centres.add([0, 1, 2].map(k => Math.floor(dirs[i + k] * R / t.cellM)).join(','));
        }
        for (const c of centres) {
            const [x, y, z] = c.split(',').map(Number);
            for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
                const cx = x + dx, cy = y + dy, cz = z + dz;
                if (Math.abs(Math.hypot(cx + 0.5, cy + 0.5, cz + 0.5) * t.cellM - R) > t.cellM) continue;
                const k = `${cx},${cy},${cz}`;
                if (!out.has(k)) { out.add(k); keys.push([cx, cy, cz, tier]); }
            }
        }
    });
    return keys;
}

async function buildTable(dirs) {
    const keys = tableKeys(dirs), n = keys.length;
    let cap = 256; while (cap < 2 * n) cap *= 2;
    const entries = new Uint32Array(cap * 4), keyData = new Int32Array(n * 4);
    keys.forEach(([x, y, z, tier], j) => {
        keyData.set([x, y, z, tier], j * 4);
        let slot = lakeTableHash(tier, x, y, z, cap);
        while (entries[slot * 4 + 3] !== 0) slot = (slot + 1) & (cap - 1);
        entries.set([x >>> 0, y >>> 0, z >>> 0, ((tier + 1) | (j << 3)) >>> 0], slot * 4);
    });
    const eBuf = storage(entries), rBuf = storage(new Float32Array(n * LAKE_RECORD_VEC4 * 4)), kBuf = storage(keyData);
    const bgBuild = device.createBindGroup({ layout: gBuild, entries: [
        { binding: 0, resource: { buffer: eBuf } }, { binding: 1, resource: { buffer: rBuf } }, { binding: 2, resource: { buffer: kBuf } }] });
    const ms = {};
    for (const pass of ['buildBase', 'buildNested', 'buildActive']) {
        const t0 = performance.now();
        for (let off = 0; off < n; off += 64 * 16) {
            const info = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(info, 0, new Uint32Array([off, 0, 0, 0]));
            const enc = device.createCommandEncoder();
            const p = enc.beginComputePass();
            p.setPipeline(buildPipes[pass]);
            p.setBindGroup(0, bg0); gen._setTerrainBiomeBindGroup(p);
            p.setBindGroup(2, device.createBindGroup({ layout: gPass, entries: [{ binding: 0, resource: { buffer: info } }] }));
            p.setBindGroup(3, bgBuild);
            p.dispatchWorkgroups(Math.ceil(Math.min(64 * 16, n - off) / 64));
            p.end();
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();
        }
        ms[pass] = performance.now() - t0;
    }
    const bgRead = device.createBindGroup({ layout: gRead, entries: [{ binding: 0, resource: { buffer: eBuf } }, { binding: 1, resource: { buffer: rBuf } }] });
    return { n, cap, ms, bgRead, bytes: entries.byteLength + n * LAKE_RECORD_VEC4 * 16 };
}

// Heights (m) at dirs; optionally GPU-timed.
async function heights(pipe, dirs, { table = null, chunk = 64 * 64, timed = false } = {}) {
    const n = dirs.length / 4, out = new Float32Array(n);
    if (timed) { profiler.enabled = true; await collectProfile(); }
    for (let s = 0; s < n; s += chunk) {
        const m = Math.min(chunk, n - s);
        const inBuf = storage(dirs.subarray(s * 4, (s + m) * 4));
        const outBuf = device.createBuffer({ size: m * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const rb = device.createBuffer({ size: m * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder({ label: 'heights' });
        const p = enc.beginComputePass({ label: 'heights' });
        p.setPipeline(pipe); p.setBindGroup(0, bg0); gen._setTerrainBiomeBindGroup(p);
        p.setBindGroup(2, device.createBindGroup({ layout: gProbe, entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }));
        if (table) p.setBindGroup(3, table.bgRead);
        p.dispatchWorkgroups(Math.ceil(m / 64)); p.end();
        enc.copyBufferToBuffer(outBuf, 0, rb, 0, m * 4);
        device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        out.set(new Float32Array(rb.getMappedRange().slice(0)), s);
        rb.unmap(); inBuf.destroy(); outBuf.destroy(); rb.destroy();
    }
    let gpuMs = null;
    if (timed) { const t = await collectProfile(); profiler.enabled = false; gpuMs = t.get('heights')?.ns / 1e6 ?? null; }
    return { h: out, gpuMs };
}

const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function patchDirs(c, sizeM, N) {
    const up = Math.abs(c[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], e1 = norm(cross(up, c)), e2 = cross(c, e1), d = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = (i / (N - 1) - 0.5) * sizeM, y = (0.5 - j / (N - 1)) * sizeM;
        d.set([...norm([0, 1, 2].map(k => c[k] + (x * e1[k] + y * e2[k]) / R)), 0], (j * N + i) * 4);
    }
    return d;
}

const results = { radiusM: R };
// A lake of the last lab run, if there is one (otherwise the spawn).
const prev = (() => { try { return JSON.parse(fs.readFileSync('docs/reference/lake-cells-2026-11-08/results.json', 'utf8')); } catch { return null; } })();
const lakeC = prev?.lakes?.perLake?.sort((a, b) => b.eqR - a.eqR).find(l => l.eqR > 300 && l.eqR < 1500)?.centre ?? [-1, 0, 0];

// 1. Equivalence.
{
    const d = patchDirs(norm(lakeC), 6000, 128);
    const table = await buildTable(d);
    const a = (await heights(directPipe, d, { chunk: 64 * 16 })).h, b = (await heights(readPipe, d, { table })).h;
    let maxD = 0, changed = 0;
    for (let i = 0; i < a.length; i++) { maxD = Math.max(maxD, Math.abs(a[i] - b[i])); }
    const plain = (await heights(plainPipe, d)).h;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - plain[i]) > 0.5) changed++;
    results.equivalence = { samples: a.length, maxAbsDiffM: maxD, samplesChangedByLakes: changed, keys: table.n };
    console.log(`[table] equivalence: max |table - direct| = ${maxD.toFixed(4)} m over ${a.length} samples (${changed} changed by lakes), ${table.n} keys`);
}

// 2 and 3. Build per area and tile cost.
results.tiles = [];
for (const [site, c] of [['spawn', norm([-1, 0, 0])], ['lake', norm(lakeC)]]) {
    for (const span of [500, 4000, 32000]) {
        const d = patchDirs(c, span, 128);
        const table = await buildTable(d);
        await heights(readPipe, d, { table });
        await heights(plainPipe, d);
        const on = (await heights(readPipe, d, { table, timed: true })).gpuMs;
        const off = (await heights(plainPipe, d, { timed: true })).gpuMs;
        const row = { site, spanM: span, keys: table.n, tableKB: Math.round(table.bytes / 1024), buildMs: table.ms, tileMsLakes: on, tileMsEarthLike: off };
        results.tiles.push(row);
        console.log(`[table] ${site} ${span} m: ${table.n} keys (${row.tableKB} KB), build ${Object.values(table.ms).map(v => v.toFixed(0)).join('/')} ms, tile ${on?.toFixed(2)} ms with lakes vs ${off?.toFixed(2)} ms earthLike`);
    }
}
results.gpuErrors = errors;
const outFile = path.resolve(process.argv[2] ?? 'tools/perf/lakeCells/out/table.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`[table] ${outFile}${errors.length ? ` GPU errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
process.exit(0);
