// core/world/hydrology/HydrologyGrid.js
//
// Topology grid for the water graph (IMPLEMENTATION_PLAN 6.1): terrain
// height (metres) and precipitation on 6 x N x N cube-sphere cells, sampled
// on the GPU with the production terrain shader and read back.
//
// Cell layout matches waterGraph.js: id = face * N * N + j * N + i, cell
// centre at face UV ((i + 0.5) / N, (j + 0.5) / N). Heights are the mean of
// 2 x 2 samples inside the cell (less aliasing of sub-cell detail).

import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';

function hydrologyGridEntryPoint({ paramsBinding, outBinding }) {
    return `
struct HydroGridParams {
    n: u32,
    faceOffset: u32,
    faceCount: u32,
    maxH: f32,
}
@group(0) @binding(${paramsBinding}) var<uniform> hydroGrid: HydroGridParams;
@group(0) @binding(${outBinding}) var<storage, read_write> hydroGridOut: array<vec2<f32>>;

@compute @workgroup_size(8, 8)
fn hydroGridMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = hydroGrid.n;
    let face = hydroGrid.faceOffset + gid.z;
    if (gid.x >= n || gid.y >= n || gid.z >= hydroGrid.faceCount) { return; }
    var hSum = 0.0;
    for (var s = 0u; s < 4u; s++) {
        let o = vec2<f32>(f32(s & 1u), f32(s >> 1u)) * 0.5 + 0.25;
        let uv = (vec2<f32>(gid.xy) + o) / f32(n);
        let dir = getSpherePoint(i32(face), uv.x, uv.y);
        hSum += calculateTerrainHeight(dir.x, dir.z, uniforms.seed, dir);
    }
    let h = hSum * 0.25;
    let uvC = (vec2<f32>(gid.xy) + 0.5) / f32(n);
    let dirC = getSpherePoint(i32(face), uvC.x, uvC.y);
    let climate = getClimate(dirC.x, dirC.z, dirC, h, uniforms.seed);
    hydroGridOut[(face - hydroGrid.faceOffset) * n * n + gid.y * n + gid.x] = vec2<f32>(h * hydroGrid.maxH, climate.precipitation);
}
`;
}

/**
 * Samples the topology grid. Returns { N, heights (Float32Array, metres),
 * precip (Float32Array), seaLevelM }. One face per dispatch so a frame is
 * never blocked by the whole planet at once.
 */
export async function sampleHydrologyGrid({ device, terrainGenerator, N = 512 }) {
    const baseSource = createAdvancedTerrainComputeShader(terrainGenerator._getAdvancedTerrainShaderOptions());
    const used = new Set();
    for (const m of baseSource.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)) used.add(Number(m[1]));
    let paramsBinding = 0; while (used.has(paramsBinding)) paramsBinding++;
    let outBinding = paramsBinding + 1; while (used.has(outBinding)) outBinding++;

    const module = device.createShaderModule({
        label: 'HydrologyGrid',
        code: baseSource + hydrologyGridEntryPoint({ paramsBinding, outBinding }),
    });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'hydroGridMain' },
    });

    // face 0: any face >= 0 selects the sphere terrain path; the entry point
    // passes its own directions.
    terrainGenerator._fillTerrainUniformScratch(0, 0, 128, 1, 0);
    const uniformBytes = terrainGenerator._terrainUniformScratch.slice(0);
    const uniformBuffer = device.createBuffer({ label: 'HydroGrid-Uniforms', size: uniformBytes.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniformBuffer, 0, uniformBytes);
    // Same values the shader uses: maxTerrainHeightM() = _pad2.z (offset 184),
    // ocean level = waterParams.y (offset 116, normalized height).
    const uv = new DataView(uniformBytes);
    const maxH = Math.max(uv.getFloat32(184, true), 1.0);
    const seaLevelNorm = uv.getFloat32(116, true);

    const faceBytes = N * N * 8;
    const heights = new Float32Array(6 * N * N);
    const precip = new Float32Array(6 * N * N);
    const out = device.createBuffer({ label: 'HydroGrid-Out', size: faceBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = device.createBuffer({ label: 'HydroGrid-Params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: paramsBinding, resource: { buffer: params } },
            { binding: outBinding, resource: { buffer: out } },
        ],
    });
    let biomeBindGroupSet = false;
    for (let face = 0; face < 6; face++) {
        const p = new ArrayBuffer(16);
        const pv = new DataView(p);
        pv.setUint32(0, N, true); pv.setUint32(4, face, true); pv.setUint32(8, 1, true); pv.setFloat32(12, maxH, true);
        device.queue.writeBuffer(params, 0, p);
        const readback = device.createBuffer({ size: faceBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder({ label: `HydroGrid-face${face}` });
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        try { terrainGenerator._setTerrainBiomeBindGroup(pass); biomeBindGroupSet = true; } catch { /* entry point may not use group 1 */ }
        pass.dispatchWorkgroups(Math.ceil(N / 8), Math.ceil(N / 8), 1);
        pass.end();
        enc.copyBufferToBuffer(out, 0, readback, 0, faceBytes);
        device.queue.submit([enc.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(readback.getMappedRange());
        for (let k = 0; k < N * N; k++) {
            heights[face * N * N + k] = data[k * 2];
            precip[face * N * N + k] = data[k * 2 + 1];
        }
        readback.unmap();
        readback.destroy();
    }
    out.destroy(); params.destroy(); uniformBuffer.destroy();
    return { N, heights, precip, seaLevelM: seaLevelNorm * maxH, biomeBindGroupSet };
}
