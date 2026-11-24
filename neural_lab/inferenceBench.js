// GPU cost of network inference vs the game's analytic terms and its density function.
// Each invocation stands for one cloud ray doing K lighting evaluations.
import { CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_DENSITY_WGSL } from '../core/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js';
import { mlpWgsl } from './mlpWgsl.js';

const KERNEL = (body, header = '', prelude = '') => /* wgsl */`${prelude}
${header}
struct BenchParams { info: vec4u, origin: vec4f, axis: vec4f, extra: vec4f }
@group(0) @binding(${header ? 5 : 0}) var<uniform> B: BenchParams;
@group(0) @binding(${header ? 6 : 1}) var<storage, read_write> sink: array<f32>;
${body.decls ?? ''}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let n = B.info.x;
    if (id.x >= n) { return; }
    let fi = f32(id.x);
    var acc = 0.0;
    for (var k = 0u; k < B.info.y; k++) {
        let fk = f32(k);
        // Cheap per-sample inputs that vary by ray and sample, as a march would.
        let v = fract(vec4f(fi * 0.000731 + fk * 0.0917, fi * 0.00137 + fk * 0.213, fi * 0.0091 + fk * 0.37, fk * 0.031 + fi * 0.00051));
        ${body.inner}
    }
    sink[id.x] = acc;
}
`;

function featureList(n) {
    return `array<f32, ${n}>(${Array.from({ length: n }, (_, i) => `v[${i % 4}] * ${(0.3 + 0.07 * i).toFixed(3)} + ${(0.01 * i).toFixed(3)}`).join(', ')})`;
}

const HG_WGSL = /* wgsl */`
const PI: f32 = 3.14159265358979;
fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1.0e-4);
    return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}
`;

export function benchKernels(models) {
    const kernels = {
        'empty loop': { code: KERNEL({ inner: 'acc += v.x * v.y;' }) },
        'game octaves (4 HG + 4 exp)': { code: KERNEL({ inner: /* wgsl */`
        let cosT = v.x * 2.0 - 1.0;
        let od = v.y * 20.0;
        var a = 1.0; var b = 1.0; var c = 1.0;
        for (var q = 0; q < 4; q++) {
            acc += b * mix(henyeyGreenstein(cosT, 0.8 * c), henyeyGreenstein(cosT, -0.36 * c), 0.4) * exp(-od * a);
            a *= 0.22; b *= 0.43; c *= 0.5;
        }` }, '', HG_WGSL) },
    };
    for (const [name, model] of Object.entries(models)) {
        const n = model.sizes[0];
        kernels[`mlp ${name} f32`] = { code: KERNEL({ decls: mlpWgsl('net', model), inner: `acc += net(${featureList(n)});` }) };
        kernels[`mlp ${name} f16`] = { f16: true, code: KERNEL({ decls: mlpWgsl('net', model, { precision: 'f16' }), inner: `acc += net(${featureList(n)});` }, '', 'enable f16;') };
    }
    return kernels;
}

// Density yardstick: K full cloudDensity() calls at nearby positions along a pseudo-ray inside the layer.
export const DENSITY_KERNEL = KERNEL({ inner: /* wgsl */`
        // A 512-wide screen of rays across a ~60 x 40 degree view from origin.
        let sx = f32(id.x % 512u) / 512.0 - 0.5;
        let sy = f32(id.x / 512u) / 360.0 - 0.5;
        let upv = normalize(B.origin.xyz);
        let right = normalize(cross(B.axis.xyz, upv));
        let dir = normalize(B.axis.xyz + right * sx * 1.15 + cross(right, B.axis.xyz) * sy * 0.73);
        let p = B.origin.xyz + dir * ((fk + 0.5 * v.w) * B.extra.x);
        acc += cloudDensity(p, 0.03, true);` },
`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
${CLOUD_DENSITY_WGSL}`);

async function timeKernel(device, code, entries, rays, k, reps, label) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(`${label}: ${errors.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n')}`);
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const query = device.createQuerySet({ type: 'timestamp', count: 2 * reps });
    const resolve = device.createBuffer({ size: 16 * reps, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16 * reps, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries.map((resource, binding) => ({ binding, resource })) });
    const encoder = device.createCommandEncoder();
    for (let r = 0; r < reps; r++) {
        const pass = encoder.beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: 2 * r, endOfPassWriteIndex: 2 * r + 1 } });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(rays / 64));
        pass.end();
    }
    encoder.resolveQuerySet(query, 0, 2 * reps, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, 16 * reps);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(read.getMappedRange().slice(0));
    read.unmap();
    const ms = [];
    for (let r = 1; r < reps; r++) ms.push(Number(t[2 * r + 1] - t[2 * r]) / 1e6);
    ms.sort((a, b) => a - b);
    query.destroy(); resolve.destroy(); read.destroy();
    return { medianMs: ms[ms.length >> 1], minMs: ms[0], rays, k, evaluations: rays * k };
}

function params(device, rays, k, origin = [0, 0, 0], axis = [1, 0, 0], step = 0.05) {
    const data = new ArrayBuffer(64);
    new Uint32Array(data, 0, 4).set([rays, k, 0, 0]);
    new Float32Array(data, 16, 12).set([...origin, 0, ...axis, 0, step, 0, 0, 0]);
    const buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
}

/** models: {name: modelJson}. clouds: a VolumetricCloudsModule for the density yardstick (optional). */
export async function runInferenceBench(models, { rays = 184320, k = 16, reps = 12, clouds = null, origin, axis } = {}) {
    const adapter = await navigator.gpu.requestAdapter();
    const features = ['timestamp-query', 'shader-f16'].filter(f => adapter.features.has(f));
    const device = await adapter.requestDevice({ requiredFeatures: features });
    const sink = device.createBuffer({ size: rays * 4, usage: GPUBufferUsage.STORAGE });
    const out = { adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}` : '', features, results: {} };
    for (const [name, kernel] of Object.entries(benchKernels(models))) {
        if (kernel.f16 && !features.includes('shader-f16')) continue;
        const p = params(device, rays, k);
        out.results[name] = await timeKernel(device, kernel.code, [{ buffer: p }, { buffer: sink }], rays, k, reps, name);
        p.destroy();
    }
    if (clouds) {
        const d = clouds.device;
        const sink2 = d.createBuffer({ size: rays * 4, usage: GPUBufferUsage.STORAGE });
        const ubo = d.createBuffer({ size: clouds._uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(ubo, 0, clouds._uniformData);
        const p = params(d, rays, k, origin, axis, 0.05);
        out.results['cloudDensity (game, with detail)'] = await timeKernel(d, DENSITY_KERNEL,
            [{ buffer: ubo }, ...clouds._noiseResources.slice(1, 5), { buffer: p }, { buffer: sink2 }], rays, k, reps, 'density');
        p.destroy(); ubo.destroy(); sink2.destroy();
    }
    for (const r of Object.values(out.results)) r.nsPerEval = r.medianMs * 1e6 / r.evaluations;
    sink.destroy();
    device.destroy();
    return out;
}
