/* global process */
// River cross-section: the WGSL against the JavaScript (riverSection.js),
// on the GPU through Dawn (the terrain lab's `webgpu` package):
//
//   node tools/perf/riverMetrics/sectionParity.mjs [cases]
//
// Random rivers, offsets and ground; per case the bank types of both sides,
// the section's height (scalar and dual WGSL) and the dual's derivatives
// with respect to n and h0 against central differences of the JavaScript.
// Prints the largest differences (f32 on the GPU).
import { createRequire } from 'node:module';
import { createTerrainCommon } from '../../../templates/terrain-shaders/terrainCommon.wgsl.js';
import { createRiverNoiseWgsl } from '../../../core/world/water/riverShapeNoise.js';
import { createRiverSectionWgsl, riverBankParams, riverBankType, riverSectionHeight } from '../../../core/world/water/riverSection.js';

const req = createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const { create, globals } = await import(req.resolve('webgpu'));
Object.assign(globalThis, globals);
globalThis.__gpu = create([]);   // keep the instance reachable (Dawn crashes if it is collected mid-work)
const device = await (await globalThis.__gpu.requestAdapter()).requestDevice();

const cases = Number(process.argv[2] ?? 20000);
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const IN = 10, input = new Float32Array(cases * IN);
for (let i = 0; i < cases; i++) {
    const hw = 3 + 77 * rnd(), depth = 0.8 + 3.2 * rnd();
    input.set([Math.floor(50 * rnd()), 20000 * rnd(), (rnd() * 2 - 1) / 100, (rnd() * 2 - 1) * (hw + 120), hw, 100, depth, (rnd() * 2 - 1) * 0.35,
        100 + depth + (rnd() * 43 - 3), 0], i * IN);
}
const helpers = createTerrainCommon().match(/fn dConst[\s\S]*?(?=\nfn fbmAuto_d)/)[0];
const code = helpers + createRiverNoiseWgsl() + createRiverSectionWgsl({ scalar: true, dual: true }) + /* wgsl */`
@group(0) @binding(0) var<storage, read> cin: array<f32>;
@group(0) @binding(1) var<storage, read_write> cout: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= arrayLength(&cin) / ${IN}u) { return; }
    let o = i * ${IN}u;
    let river = cin[o]; let s = cin[o + 1u]; let kappa = cin[o + 2u]; let n = cin[o + 3u];
    let hw = cin[o + 4u]; let bed = cin[o + 5u]; let depth = cin[o + 6u]; let skew = cin[o + 7u]; let h0 = cin[o + 8u];
    let tl = riverBankType(s, river, true, kappa);
    let tr = riverBankType(s, river, false, kappa);
    let L = riverBankParams(tl, river);
    let R = riverBankParams(tr, river);
    let h = riverSection(n, hw, bed, depth, skew, h0, L, R);
    let hd = riverSection_d(vec4<f32>(n, 1.0, 0.0, 0.0), dConst(hw), dConst(bed), dConst(depth), skew, vec4<f32>(h0, 0.0, 1.0, 0.0), L, R);
    let r = i * 6u;
    cout[r] = tl; cout[r + 1u] = tr; cout[r + 2u] = h; cout[r + 3u] = hd.x; cout[r + 4u] = hd.y; cout[r + 5u] = hd.z;
}`;
const module = device.createShaderModule({ code });
const info = await module.getCompilationInfo();
for (const m of info.messages) if (m.type === 'error') { console.log(m.message, m.lineNum); process.exit(1); }
const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
const outBuf = device.createBuffer({ size: cases * 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const readBuf = device.createBuffer({ size: cases * 24, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
device.queue.writeBuffer(inBuf, 0, input);
const enc = device.createCommandEncoder();
const pass = enc.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }));
pass.dispatchWorkgroups(Math.ceil(cases / 64));
pass.end();
enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, cases * 24);
device.queue.submit([enc.finish()]);
await readBuf.mapAsync(GPUMapMode.READ);
const out = new Float32Array(readBuf.getMappedRange().slice(0));

const worst = { tau: 0, scalar: 0, dual: 0, dn: 0, dh0: 0 }, at = {};
const note = (k, e, i) => { if (e > worst[k]) { worst[k] = e; at[k] = i; } };
for (let i = 0; i < cases; i++) {
    const [river, s, kappa, n, hw, bed, depth, skew, h0] = input.subarray(i * IN, i * IN + 9);
    const tl = riverBankType(s, river, true, kappa), tr = riverBankType(s, river, false, kappa);
    const left = riverBankParams(tl, river), right = riverBankParams(tr, river);
    const H = (nn, hh) => riverSectionHeight({ n: nn, hw, bed, depth, skew, h0: hh, left, right });
    const h = H(n, h0), e = 1e-3;
    const g = out.subarray(i * 6, i * 6 + 6);
    note('tau', Math.max(Math.abs(g[0] - tl), Math.abs(g[1] - tr)), i);
    note('scalar', Math.abs(g[2] - h), i);
    note('dual', Math.abs(g[3] - h), i);
    note('dn', Math.abs(g[4] - (H(n + e, h0) - H(n - e, h0)) / (2 * e)), i);
    note('dh0', Math.abs(g[5] - (H(n, h0 + e) - H(n, h0 - e)) / (2 * e)), i);
}
console.log(JSON.stringify({ cases, worst, at }));
readBuf.unmap();
process.exit(0);
