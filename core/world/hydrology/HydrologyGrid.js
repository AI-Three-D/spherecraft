// core/world/hydrology/HydrologyGrid.js
//
// Terrain sampling for the water system, on the GPU with the production
// terrain shader, read back to the CPU:
// - the topology grid for the water graph (IMPLEMENTATION_PLAN 6.1): height
//   (metres) and precipitation on 6 x N x N cube-sphere cells;
// - local patches for the fine lake solve (lakeRefine.js): height on a
//   gnomonic tangent-plane grid around a centre direction.
//
// Grid cell layout matches waterGraph.js: id = face * N * N + j * N + i, cell
// centre at face UV ((i + 0.5) / N, (j + 0.5) / N). Grid heights are the mean
// of 2 x 2 samples inside the cell (less aliasing of sub-cell detail). Patch
// cell (i, j) sits at tangent-plane point x0 + (i + 0.5) * spacing,
// y0 + (j + 0.5) * spacing (see lakeRefine.js), one sample each.
// The water system finds lakes and rivers on the terrain without the river
// carve (riverCarve.wgsl.js). Patches can also be sampled carved (the water
// simulation's bed), once setWaterCarveResources gave the river data.

import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { hashParts } from './waterCache.js';
import { RIVER_CARVE_BINDINGS } from '../water/riverCarve.wgsl.js';
import { RIVER_VALLEY_BINDINGS } from '../water/riverValley.wgsl.js';

function hydrologyEntryPoints({ gridParams, gridOut, patchParams, patchOut, dirsParams, dirsIn, dirsOut }) {
    return `
struct HydroGridParams {
    n: u32,
    face: u32,
    rowOffset: u32,
    maxH: f32,
}
@group(0) @binding(${gridParams}) var<uniform> hydroGrid: HydroGridParams;
@group(0) @binding(${gridOut}) var<storage, read_write> hydroGridOut: array<vec2<f32>>;

@compute @workgroup_size(8, 8)
fn hydroGridMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = hydroGrid.n;
    let face = hydroGrid.face;
    let cell = vec2<u32>(gid.x, hydroGrid.rowOffset + gid.y);
    if (cell.x >= n || cell.y >= n) { return; }
    var hSum = 0.0;
    for (var s = 0u; s < 4u; s++) {
        let o = vec2<f32>(f32(s & 1u), f32(s >> 1u)) * 0.5 + 0.25;
        let uv = (vec2<f32>(cell) + o) / f32(n);
        let dir = getSpherePoint(i32(face), uv.x, uv.y);
        hSum += calculateTerrainHeight(dir.x, dir.z, uniforms.seed, dir);
    }
    let h = hSum * 0.25;
    let uvC = (vec2<f32>(cell) + 0.5) / f32(n);
    let dirC = getSpherePoint(i32(face), uvC.x, uvC.y);
    let climate = getClimate(dirC.x, dirC.z, dirC, h, uniforms.seed);
    hydroGridOut[gid.y * n + gid.x] = vec2<f32>(h * hydroGrid.maxH, climate.precipitation);
}

struct HydroPatchParams {
    c: vec3<f32>, spacing: f32,
    e1: vec3<f32>, x0: f32,
    e2: vec3<f32>, y0: f32,
    nx: u32, ny: u32, maxH: f32, invR: f32,
}
@group(0) @binding(${patchParams}) var<uniform> hydroPatch: HydroPatchParams;
@group(0) @binding(${patchOut}) var<storage, read_write> hydroPatchOut: array<f32>;

@compute @workgroup_size(8, 8)
fn hydroPatchMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= hydroPatch.nx || gid.y >= hydroPatch.ny) { return; }
    let x = hydroPatch.x0 + (f32(gid.x) + 0.5) * hydroPatch.spacing;
    let y = hydroPatch.y0 + (f32(gid.y) + 0.5) * hydroPatch.spacing;
    let dir = normalize(hydroPatch.c + (x * hydroPatch.e1 + y * hydroPatch.e2) * hydroPatch.invR);
    hydroPatchOut[gid.y * hydroPatch.nx + gid.x] = calculateTerrainHeight(dir.x, dir.z, uniforms.seed, dir) * hydroPatch.maxH;
}

struct HydroDirsParams { count: u32, maxH: f32, _p0: u32, _p1: u32, }
@group(0) @binding(${dirsParams}) var<uniform> hydroDirs: HydroDirsParams;
@group(0) @binding(${dirsIn}) var<storage, read> hydroDirsIn: array<vec4<f32>>;
@group(0) @binding(${dirsOut}) var<storage, read_write> hydroDirsOut: array<f32>;

@compute @workgroup_size(64)
fn hydroDirsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= hydroDirs.count) { return; }
    let dir = normalize(hydroDirsIn[gid.x].xyz);
    hydroDirsOut[gid.x] = calculateTerrainHeight(dir.x, dir.z, uniforms.seed, dir) * hydroDirs.maxH;
}
`;
}

/**
 * Terrain evaluations per dispatch (one grid cell is 5: 4 heights + climate).
 * Keeps each dispatch to a few ms of GPU, so background sampling never
 * stalls a frame for long.
 */
const DEFAULT_SAMPLES_PER_DISPATCH = 131072;

/**
 * Compiles the sampling pipelines once. Returns
 * { sampleGrid(N), samplePatch(frame, R), maxH, seaLevelM, terrainKey, destroy() }.
 * Work is split into dispatches of at most samplesPerDispatch terrain
 * evaluations; yieldBetween (e.g. one animation frame) runs between them.
 */
export async function createHydrologySampler({ device, terrainGenerator, samplesPerDispatch = DEFAULT_SAMPLES_PER_DISPATCH, yieldBetween = null }) {
    // The natural terrain: no river carve, no river valleys (the water graph,
    // lakes and river traces are found on it).
    const baseSource = createAdvancedTerrainComputeShader(terrainGenerator._getAdvancedTerrainShaderOptions({ waterCarve: false, riverValley: false }));
    const used = new Set();
    for (const m of baseSource.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)) used.add(Number(m[1]));
    const free = [];
    for (let b = 0; free.length < 7; b++) if (!used.has(b)) free.push(b);
    const [gridParams, gridOut, patchParams, patchOut, dirsParams, dirsIn, dirsOut] = free;
    const entryPoints = hydrologyEntryPoints({ gridParams, gridOut, patchParams, patchOut, dirsParams, dirsIn, dirsOut });

    const module = device.createShaderModule({ label: 'HydrologySampler', code: baseSource + entryPoints });
    const [gridPipeline, patchPipeline] = await Promise.all([
        device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'hydroGridMain' } }),
        device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'hydroPatchMain' } }),
    ]);
    // Carved patches (same group 0 bindings; the carve's data in group 1),
    // compiled on first use.
    let carvedPipeline = null, carvedDirsPipeline = null;
    let carvedPromise = null;
    let carveGroup = null, carveDirsGroup = null;
    const carvedReady = () => {
        if (terrainGenerator.waterCarve !== true) return Promise.resolve(null);
        carvedPromise ??= (async () => {
            const src = createAdvancedTerrainComputeShader(terrainGenerator._getAdvancedTerrainShaderOptions({ waterCarve: true }));
            const m = device.createShaderModule({ label: 'HydrologySampler-carved', code: src + entryPoints });
            [carvedPipeline, carvedDirsPipeline] = await Promise.all([
                device.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'hydroPatchMain' } }),
                device.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'hydroDirsMain' } }),
            ]);
            return carvedPipeline;
        })();
        return carvedPromise;
    };

    // face 0: any face >= 0 selects the sphere terrain path; the entry
    // points pass their own directions.
    terrainGenerator._fillTerrainUniformScratch(0, 0, 128, 1, 0);
    const uniformBytes = terrainGenerator._terrainUniformScratch.slice(0);
    const uniformBuffer = device.createBuffer({ label: 'Hydro-Uniforms', size: uniformBytes.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniformBuffer, 0, uniformBytes);
    // Same values the shader uses: maxTerrainHeightM() = _pad2.z (offset 184),
    // ocean level = waterParams.y (offset 116, normalized height).
    const uv = new DataView(uniformBytes);
    const maxH = Math.max(uv.getFloat32(184, true), 1.0);
    const seaLevelM = uv.getFloat32(116, true) * maxH;

    const setBiome = (pass) => {
        try { terrainGenerator._setTerrainBiomeBindGroup(pass); return true; } catch { return false; /* entry point may not use group 1 */ }
    };

    async function sampleGrid(N) {
        const heights = new Float32Array(6 * N * N);
        const precip = new Float32Array(6 * N * N);
        // Rows per dispatch: a multiple of 8 (the workgroup height).
        const rowsPer = Math.max(8, Math.floor(samplesPerDispatch / (5 * N) / 8) * 8);
        const chunkBytes = N * rowsPer * 8;
        const out = device.createBuffer({ label: 'HydroGrid-Out', size: chunkBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const params = device.createBuffer({ label: 'HydroGrid-Params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bindGroup = device.createBindGroup({
            layout: gridPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: gridParams, resource: { buffer: params } },
                { binding: gridOut, resource: { buffer: out } },
            ],
        });
        let biomeBindGroupSet = false;
        for (let face = 0; face < 6; face++) {
            for (let j0 = 0; j0 < N; j0 += rowsPer) {
                const rows = Math.min(rowsPer, N - j0);
                const p = new ArrayBuffer(16);
                const pv = new DataView(p);
                pv.setUint32(0, N, true); pv.setUint32(4, face, true); pv.setUint32(8, j0, true); pv.setFloat32(12, maxH, true);
                device.queue.writeBuffer(params, 0, p);
                const bytes = N * rows * 8;
                const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const enc = device.createCommandEncoder({ label: `HydroGrid-face${face}` });
                const pass = enc.beginComputePass();
                pass.setPipeline(gridPipeline);
                pass.setBindGroup(0, bindGroup);
                biomeBindGroupSet = setBiome(pass) || biomeBindGroupSet;
                pass.dispatchWorkgroups(Math.ceil(N / 8), Math.ceil(rows / 8), 1);
                pass.end();
                enc.copyBufferToBuffer(out, 0, readback, 0, bytes);
                device.queue.submit([enc.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                const data = new Float32Array(readback.getMappedRange());
                const base = face * N * N + j0 * N;
                for (let k = 0; k < N * rows; k++) {
                    heights[base + k] = data[k * 2];
                    precip[base + k] = data[k * 2 + 1];
                }
                readback.unmap();
                readback.destroy();
                if (yieldBetween) await yieldBetween();
            }
        }
        out.destroy(); params.destroy();
        return { N, heights, precip, seaLevelM, biomeBindGroupSet };
    }

    /**
     * Heights (metres) on a tangent-plane patch, frame from lakeRefine.js:
     * { c, e1, e2, x0, y0, spacing, nx, ny }. Row-major Float32Array.
     */
    async function samplePatch(frame, R, { carved = false } = {}) {
        const { nx, ny } = frame;
        if (carved) await carvedReady();
        const carve = carved && carvedPipeline && carveGroup;
        const pipeline = carve ? carvedPipeline : patchPipeline;
        const heights = new Float32Array(nx * ny);
        const rowsPer = Math.max(8, Math.min(Math.ceil(ny / 8) * 8, Math.floor(samplesPerDispatch / nx / 8) * 8));
        const bytes = nx * rowsPer * 4;
        const out = device.createBuffer({ label: 'HydroPatch-Out', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const params = device.createBuffer({ label: 'HydroPatch-Params', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: patchParams, resource: { buffer: params } },
                { binding: patchOut, resource: { buffer: out } },
            ],
        });
        for (let j0 = 0; j0 < ny; j0 += rowsPer) {
            const rows = Math.min(rowsPer, ny - j0);
            const p = new ArrayBuffer(64);
            const f = new Float32Array(p), u = new Uint32Array(p);
            f.set([frame.c[0], frame.c[1], frame.c[2], frame.spacing], 0);
            f.set([frame.e1[0], frame.e1[1], frame.e1[2], frame.x0], 4);
            f.set([frame.e2[0], frame.e2[1], frame.e2[2], frame.y0 + j0 * frame.spacing], 8);
            u[12] = nx; u[13] = rows; f[14] = maxH; f[15] = 1 / R;
            device.queue.writeBuffer(params, 0, p);
            const readback = device.createBuffer({ size: nx * rows * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = device.createCommandEncoder({ label: 'HydroPatch' });
            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            if (carve) pass.setBindGroup(1, carveGroup);
            else setBiome(pass);
            pass.dispatchWorkgroups(Math.ceil(nx / 8), Math.ceil(rows / 8), 1);
            pass.end();
            enc.copyBufferToBuffer(out, 0, readback, 0, nx * rows * 4);
            device.queue.submit([enc.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            heights.set(new Float32Array(readback.getMappedRange()), j0 * nx);
            readback.unmap();
            readback.destroy();
            if (yieldBetween) await yieldBetween();
        }
        out.destroy(); params.destroy();
        return heights;
    }

    /**
     * River carve data for carved samples (WaterGpuData resources, or null),
     * and the river valleys' field (WaterGpuData valley resources; the
     * generator's placeholders until set). Carved samples are the terrain as
     * the tiles show it: valleys and channels.
     */
    let carveRes = null, valleyRes = null;
    async function rebuildCarveGroups() {
        if (!carveRes) { carveGroup = carveDirsGroup = null; return; }
        if (!(await carvedReady())) return;
        const C = RIVER_CARVE_BINDINGS, V = RIVER_VALLEY_BINDINGS;
        const entries = [
            { binding: C.index, resource: { buffer: carveRes.index } },
            { binding: C.params, resource: { buffer: carveRes.params } },
            { binding: C.rivers, resource: { buffer: carveRes.rivers } },
        ];
        if (terrainGenerator.riverValley === true) {
            const v = valleyRes ?? terrainGenerator._riverValleyPlaceholder;
            entries.push(
                { binding: V.pages, resource: { buffer: v.pages } },
                { binding: V.texels, resource: { buffer: v.texels } },
                { binding: V.params, resource: { buffer: v.params } },
            );
        }
        carveGroup = device.createBindGroup({ label: 'HydroPatch-carve', layout: carvedPipeline.getBindGroupLayout(1), entries });
        carveDirsGroup = device.createBindGroup({ label: 'HydroDirs-carve', layout: carvedDirsPipeline.getBindGroupLayout(1), entries });
    }
    async function setWaterCarveResources(res) { carveRes = res ?? null; await rebuildCarveGroups(); }
    async function setRiverValleyResources(res) { valleyRes = res ?? null; await rebuildCarveGroups(); }

    /**
     * Carved terrain heights (m) at unit directions (Float32Array, 4 floats
     * per direction: x, y, z, unused), or null when the carve is not ready.
     * One dispatch (callers keep it to tens of thousands of directions).
     */
    async function sampleDirsCarved(dirs4) {
        await carvedReady();
        if (!carvedDirsPipeline || !carveDirsGroup) return null;
        const count = dirs4.length / 4;
        const inBuf = device.createBuffer({ label: 'HydroDirs-In', size: Math.max(16, dirs4.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const out = device.createBuffer({ label: 'HydroDirs-Out', size: Math.max(16, count * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const params = device.createBuffer({ label: 'HydroDirs-Params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const readback = device.createBuffer({ size: Math.max(16, count * 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        device.queue.writeBuffer(inBuf, 0, dirs4);
        const p = new ArrayBuffer(16), pv = new DataView(p);
        pv.setUint32(0, count, true); pv.setFloat32(4, maxH, true);
        device.queue.writeBuffer(params, 0, p);
        const bindGroup = device.createBindGroup({
            layout: carvedDirsPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: dirsParams, resource: { buffer: params } },
                { binding: dirsIn, resource: { buffer: inBuf } },
                { binding: dirsOut, resource: { buffer: out } },
            ],
        });
        const enc = device.createCommandEncoder({ label: 'HydroDirs' });
        const pass = enc.beginComputePass();
        pass.setPipeline(carvedDirsPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setBindGroup(1, carveDirsGroup);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        enc.copyBufferToBuffer(out, 0, readback, 0, count * 4);
        device.queue.submit([enc.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const heights = new Float32Array(readback.getMappedRange().slice(0, count * 4));
        readback.unmap();
        for (const b of [readback, inBuf, out, params]) b.destroy();
        return heights;
    }

    return {
        sampleGrid, samplePatch, sampleDirsCarved, setWaterCarveResources, setRiverValleyResources, maxH, seaLevelM,
        // Everything the samples depend on: the terrain shader and its uniforms.
        terrainKey: hashParts([baseSource, uniformBytes]),
        destroy() { uniformBuffer.destroy(); },
    };
}

/**
 * Samples the topology grid. Returns { N, heights (Float32Array, metres),
 * precip (Float32Array), seaLevelM }.
 */
export async function sampleHydrologyGrid({ device, terrainGenerator, N = 512 }) {
    const sampler = await createHydrologySampler({ device, terrainGenerator });
    try {
        return await sampler.sampleGrid(N);
    } finally {
        sampler.destroy();
    }
}
