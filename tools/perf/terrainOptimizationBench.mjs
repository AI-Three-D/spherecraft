// Optional native GPU dependency, resolved from argv[2] when supplied:
// node tools/perf/terrainOptimizationBench.mjs ../terrain-lab/node_modules/webgpu/index.js
// Benchmarks against the pre-change git revision (argv[3], default HEAD).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { AsyncGenerationQueue } from '../../core/world/asyncGenerationQueue.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const revision = process.argv[3] ?? 'HEAD';
const before = file => execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' });
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const report = {};
report.baseline_revision = execFileSync('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' }).trim();
const BeforeQueue = (await import(`data:text/javascript;base64,${Buffer.from(before('core/world/asyncGenerationQueue.js')).toString('base64')}`)).AsyncGenerationQueue;
for (const [label, Queue] of [['before', BeforeQueue], ['after', AsyncGenerationQueue]]) {
    const samples = [];
    for (let run = 0; run < 35; run++) {
        const q = new Queue({ maxQueueSize: 2048, maxPerFrame: 0, timeBudgetMs: 10000 });
        const start = performance.now();
        for (let i = 0; i < 1024; i++) q.request(String(i), (i * 7919) % 1024, () => true);
        q.tick();
        if (run >= 5) samples.push(performance.now() - start);
        q.clearPending();
    }
    report[`queue_${label}_ms`] = median(samples);
}
// Real streamer admission at capacity: replace 1024 distant predictive
// requests with a nearer 1024-tile feedback burst, without running GPU jobs.
const { TileStreamer } = await import('../../core/world/quadtree/tileStreamer.js');
const { TileAddress: Address } = await import('../../core/world/quadtree/tileAddress.js');
const burstTimes = [];
for (let run = 0; run < 15; run++) {
    const streamer = new TileStreamer({ limits: { maxTextureArrayLayers: 2048 } }, null, { maxDepth: 11 }, {
        tileTextureSize: 128, tilePoolSize: 64, queueConfig: { maxQueueSize: 1024 }, requiredTypes: ['height', 'normal', 'tile'] });
    streamer.setCameraContext({ position: { x: 0, y: 0, z: 131200 },
        planetConfig: { radius: 131072, origin: { x: 0, y: 0, z: 0 } } });
    for (let i = 0; i < 1024; i++) streamer._queueTile(new Address(4, 11, 900 + i % 32, 900 + Math.floor(i / 32)), { reason: 'PREDICTIVE' });
    const start = performance.now();
    for (let i = 0; i < 1024; i++) streamer._queueTile(new Address(4, 11, 1000 + i % 32, 1000 + Math.floor(i / 32)), { reason: 'FEEDBACK' });
    if (run >= 5) burstTimes.push(performance.now() - start);
    if (streamer._generationQueue.replacedCount !== 1024) throw new Error('Current demand was rejected during the saturation benchmark');
    streamer._generationQueue.clearPending();
}
report.saturated_feedback_burst_ms = median(burstTimes);
if (process.env.QUEUE_ONLY) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

const { create, globals } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : 'webgpu');
Object.assign(globalThis, globals);
// Dawn callbacks require the instance to stay reachable until all work ends.
const gpu = create([]);
globalThis.benchGPU = gpu;
const adapter = await gpu.requestAdapter();
if (!adapter?.features.has('timestamp-query')) throw new Error('GPU timestamp queries are required');
const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'],
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
report.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
    device: adapter.info.device, description: adapter.info.description };

async function readRGBA(texture, width, height) {
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
    device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    return pixels;
}

async function timed(encode) {
    const qs = device.createQuerySet({ type: 'timestamp', count: 2 });
    const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    encode(enc, { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    enc.resolveQuerySet(qs, 0, 2, resolve, 0);
    enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(read.getMappedRange());
    const ms = Number(t[1] - t[0]) / 1e6;
    read.unmap();
    read.destroy();
    resolve.destroy();
    qs.destroy();
    return ms;
}

// Exercise the actual terrain shadow sampling functions at 1080p. The three
// cascades have distinct depth patterns; each covers a third of the image.
const fragmentFile = 'core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
const shadowFns = source => source.slice(source.indexOf('fn sampleShadowMap('), source.indexOf('fn computeShadow('));
const W = 1920, H = 1080;
const vertexCode = `@vertex fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = array<vec2<f32>, 3>(vec2<f32>(-1, -1), vec2<f32>(3, -1), vec2<f32>(-1, 3));
    return vec4<f32>(p[i], 0, 1);
}`;
const depths = [0, 1, 2].map(() => device.createTexture({ size: [1024, 1024], format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
for (let i = 0; i < 3; i++) {
    const shader = device.createShaderModule({ code: `@fragment fn main(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
        return fract(p.x * 0.003 + p.y * 0.007 + ${i}.0 * 0.23);
    }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: device.createShaderModule({ code: vertexCode }), entryPoint: 'main' },
        fragment: { module: shader, entryPoint: 'main', targets: [] }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: depths[i].createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
}
const shadowSampler = device.createSampler({ compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
const renderTarget = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const renderers = {};
for (const [label, source] of [['before', before(fragmentFile)], ['after', fs.readFileSync(path.join(root, fragmentFile), 'utf8')]]) {
    const code = `const SHADOW_MODE: i32 = 3;
        @group(0) @binding(0) var shadowCascade0: texture_depth_2d;
        @group(0) @binding(1) var shadowCascade1: texture_depth_2d;
        @group(0) @binding(2) var shadowCascade2: texture_depth_2d;
        @group(0) @binding(3) var shadowSampler: sampler_comparison;
        ${shadowFns(source)}
        @fragment fn main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
            let uv = p.xy / vec2<f32>(${W}.0, ${H}.0);
            let cascade = min(i32(uv.x * 3.0), 2);
            let s = sampleCascadePCF(cascade, uv, 0.5, 1.0 / 1024.0);
            return vec4<f32>(s, s, s, 1);
        }`;
    const module = device.createShaderModule({ code });
    const compilation = await module.getCompilationInfo();
    if (compilation.messages.some(m => m.type === 'error')) throw new Error(JSON.stringify(compilation.messages));
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: device.createShaderModule({ code: vertexCode }), entryPoint: 'main' },
        fragment: { module, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        ...depths.map((t, binding) => ({ binding, resource: t.createView() })), { binding: 3, resource: shadowSampler }] });
    renderers[label] = (enc, timestampWrites) => {
        const pass = enc.beginRenderPass({ timestampWrites, colorAttachments: [{ view: renderTarget.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
    };
    await timed(renderers[label]);
}
const shadowTimes = { before: [], after: [] };
const shadowPixels = {};
for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        const ms = await timed(renderers[label]);
        if (round >= 2) shadowTimes[label].push(ms);
        if (round === 11) shadowPixels[label] = await readRGBA(renderTarget, W, H);
    }
}
report.shadow1080p_before_ms = median(shadowTimes.before);
report.shadow1080p_after_ms = median(shadowTimes.after);
report.shadow_pixel_bytes_different = shadowPixels.before.reduce((n, b, i) => n + (b !== shadowPixels.after[i]), 0);
console.log('Shadow comparison:', JSON.stringify(report));

// Real generator setup using the shipped planet/biome configuration.
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const { Logger } = await imp('shared/Logger.js');
Logger.setLevel(2);
const { WorldConfigLoader } = await imp('wizard_game/WorldConfigLoader.js');
class DiskLoader extends WorldConfigLoader {
    async _fetchJSON(name) { return JSON.parse(fs.readFileSync(path.join(root, 'wizard_game/world', name), 'utf8')); }
}
const { engineConfig, gameDataConfig } = await new DiskLoader('./world').load();
const { PlanetConfig } = await imp('templates/configs/planetConfig.js');
const planet = gameDataConfig.planets.find(p => p.enabled);
const planetConfig = new PlanetConfig({ ...gameDataConfig.buildPlanetOptions({ surfaceChunkSize: engineConfig.chunkSizeMeters }, planet.id), engineConfig });
const modules = await Promise.all(['terrainCommon', 'surfaceCommon', 'features/featureContinents', 'features/featurePlains',
    'features/featureHills', 'features/featureMountains', 'features/featureCanyons', 'features/featureLoneHills',
    'features/featureMicro', 'features/featureMesoDetail', 'features/featureRivers', 'features/featureErosionSeeds',
    'features/featureErosionFilter', 'base/earthLikeBase'].map(p => imp(`templates/terrain-shaders/${p}.wgsl.js`)));
const bundle = Object.assign({}, ...modules.slice(0, -1));
const base = modules.at(-1);
bundle.baseGenerators = { earthLike: { constants: base.createEarthlikeConstants, base: base.createEarthlikeBase } };
const tileTypes = await imp('templates/configs/tileTypes.js');
const { createTerrainThemeForPlanet } = await imp('wizard_game/TerrainThemeFactory.js');
const theme = createTerrainThemeForPlanet({ ...tileTypes, terrainShaderBundle: bundle }, planetConfig);
const { TextureCache } = await imp('core/texture/textureCache.js');
const { WebGPUTerrainGenerator } = await imp('core/world/webgpuTerrainGenerator.js');
const gen = new WebGPUTerrainGenerator(device, engineConfig.seed, engineConfig.chunkSizeMeters,
    engineConfig.macroConfig, engineConfig.splatConfig, new TextureCache(), { planetConfig, terrainTheme: theme });
await gen.initialize();
// Suppress startup readbacks and probe passes during this controlled benchmark.
gen._quadtreeSplatPrimeCount = 3;
gen._quadtreeSplatProbePassCount = 3;
gen._quadtreeSplatDiagCount = 3;
// Use the original shader factory for the separate-pass reference, including
// output comparisons. Resolve its relative imports before loading from data.
const computeFile = 'core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js';
const referenceCode = before(computeFile).replace(/from\s+(['"])(\.[^'"]+)\1/g,
    (_match, _quote, spec) => `from '${new URL(spec, pathToFileURL(path.join(root, computeFile))).href}'`);
const referenceFactory = (await import(`data:text/javascript;base64,${Buffer.from(referenceCode).toString('base64')}`)).createAdvancedTerrainComputeShader;
const currentHeightPipeline = gen._getHeightInputPipelineForFormat.bind(gen);
const referencePipelines = new Map();
gen._getHeightInputPipelineForFormat = (format, heightFormat, options = {}) => {
    const current = currentHeightPipeline(format, heightFormat, options);
    if (options.withSmoothSplatIds) return current;
    const key = `${format}|${heightFormat}|${options.withBaseHeight ?? false}`;
    if (!referencePipelines.has(key)) {
        const code = referenceFactory(gen._getAdvancedTerrainShaderOptions({ outputFormat: format,
            hasHeightBindings: true, hasBaseHeightBinding: options.withBaseHeight === true }));
        referencePipelines.set(key, { bindGroupLayout: current.bindGroupLayout,
            pipeline: device.createComputePipeline({
                layout: device.createPipelineLayout({ bindGroupLayouts: [current.bindGroupLayout, gen.biomeBindGroupLayout] }),
                compute: { module: device.createShaderModule({ code }), entryPoint: 'main' }
            }) });
    }
    return referencePipelines.get(key);
};
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const size = engineConfig.gpuQuadtree.tileTextureSize;
const tileGen = new TileGenerator(gen, { textureSize: size, requiredTypes: ['splatData', 'splatIndex', 'splatValid'],
    enableSplat: true, textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm' } });
// Run on all cube faces, retaining entire output images for equality checks.
const addrs = Array.from({ length: 6 }, (_, face) => new TileAddress(face, 11, 900 + face * 20, 800 + face * 30));
const samples = { separate: [], fused: [] };
let diff = 0;
for (const addr of addrs) {
    const pixels = {};
    for (const fused of [false, true]) {
        gen.terrainConfig.fuseSmoothSplatSource = fused;
        const textures = await tileGen._generateTileInternal(addr, { trackStats: false });
        const label = fused ? 'fused' : 'separate';
        pixels[label] = {};
        for (const type of ['splatData', 'splatIndex', 'splatValid']) {
            pixels[label][type] = await readRGBA(textures[type]._gpuTexture.texture, size, size);
        }
        for (const texture of Object.values(textures)) texture._gpuTexture.texture.destroy();
    }
    for (const type of Object.keys(pixels.separate)) {
        diff += pixels.separate[type].reduce((n, b, i) => n + (b !== pixels.fused[type][i]), 0);
    }
}
// Timestamp the actual source passes, with identical cached height samples.
const height = device.createTexture({ size: [size, size], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
const heightData = new Float32Array(size * size * 4);
for (let i = 0; i < size * size; i++) { heightData[i * 4] = 0.35 + (i % size) / size * 0.3; heightData[i * 4 + 1] = Math.floor(i / size) / size; }
device.queue.writeTexture({ texture: height }, heightData, { bytesPerRow: size * 16 }, [size, size]);
const weights = gen.createGPUTexture(size, size, 'rgba8unorm'), ids = gen.createGPUTexture(size, size, 'rgba8unorm');
const dispatches = {};
for (const fused of [false, true]) {
    const resources = [];
    for (const type of fused ? [7] : [7, 8]) {
        const view = gen._fillTerrainUniformScratch(900, 800, size, 2048, 4);
        view.setInt32(48, type, true);
        const uniform = device.createBuffer({ size: gen._terrainUniformScratch.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 0, gen._terrainUniformScratch);
        const { pipeline, bindGroupLayout } = gen._getHeightInputPipelineForFormat('rgba8unorm', 'rgba32float', { withSmoothSplatIds: fused });
        const group = device.createBindGroup({ layout: bindGroupLayout, entries: [
            { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: (type === 7 ? weights : ids).createView() },
            { binding: 2, resource: height.createView() }, ...(fused ? [{ binding: 5, resource: ids.createView() }] : [])] });
        resources.push({ pipeline, group });
    }
    dispatches[fused ? 'fused' : 'separate'] = (enc, timestampWrites) => {
        const pass = enc.beginComputePass({ timestampWrites });
        for (const { pipeline, group } of resources) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            gen._setTerrainBiomeBindGroup(pass);
            pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
        }
        pass.end();
    };
    await timed(dispatches[fused ? 'fused' : 'separate']);
}
for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ['fused', 'separate'] : ['separate', 'fused']) {
        const ms = await timed(dispatches[label]);
        if (round >= 2) samples[label].push(ms);
    }
}
report.tile_size = size;
report.smooth_source_separate_ms = median(samples.separate);
report.smooth_source_fused_ms = median(samples.fused);
report.splat_output_bytes_different = diff;
report.gpu_errors = errors;
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(root, 'tools/perf/terrainOptimizationResults.json'), JSON.stringify(report, null, 2) + '\n');
device.destroy();
process.exit(errors.length || diff || report.shadow_pixel_bytes_different ? 1 : 0);
