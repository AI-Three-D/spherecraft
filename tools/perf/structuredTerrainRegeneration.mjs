/* global process */
// Complete regeneration workload; independent of the substage benchmark.
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';
const cells = Number(process.argv[3] ?? 256);
const lab = await setupLab(process.argv[2] ?? '.');
const { device, gen, imp, planetConfig, profiler, collectProfile } = lab;
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const { WaterService } = await imp('core/world/hydrology/WaterService.js');
const { WaterGpuData } = await imp('core/world/water/WaterGpuData.js');
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const output = 'tools/perf/structured-terrain-results';
const previous = JSON.parse(fs.readFileSync(`${output}/benchmark-${cells}.json`));
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
gen._quadtreeSplatDiagCount = 3;
gen._quadtreeSplatProbePassCount = 3;
gen._quadtreeSplatPrimeCount = 3;
const addresses = previous.tiles.addresses.map(s => TileAddress.fromString(s));
const tileGen = new TileGenerator(gen, { textureSize: 128, requiredTypes: previous.tiles.types,
    textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm' },
    quadtreeMaxDepth: 11, maxGeomLOD: 6, enableSplat: true });
const dispose = tx => { for (const t of Object.values(tx)) t?._gpuTexture?.texture?.destroy(); };
const tilePayloads = new Map();
const pixelBytes = { r8unorm: 1, rgba8unorm: 4, r32float: 4, rgba32float: 16, rgba16float: 8, rg32float: 8, rg16float: 4, r16float: 2, rgba8uint: 4, rgba32uint: 16, r32uint: 4 };
const tiles = async () => {
    for (const a of addresses) {
        const tx = await tileGen.generateTile(a);
        const textures = [...new Set(Object.values(tx).map(t => t?._gpuTexture?.texture).filter(Boolean))];
        tilePayloads.set(String(a), textures.reduce((s, t) => {
            if (!pixelBytes[t.format]) throw new Error(`Uncounted texture format ${t.format}`);
            return s + t.width * t.height * t.depthOrArrayLayers * pixelBytes[t.format];
        }, 0));
        dispose(tx);
    }
};
const measure = async fn => {
    profiler.enabled = true;
    const start = performance.now();
    const value = await fn();
    await device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - start;
    profiler.enabled = false;
    const passes = [...await collectProfile()].map(([label, p]) => ({ label, n: p.n, ms: p.ns / 1e6 }));
    return { wallMs, gpuMs: passes.reduce((s, p) => s + p.ms, 0), passes, value };
};
await gen.prepareRegionalTerrain({ cells, seamCells: 4 });
await tiles(); // shader and pool warm-up excluded from warm regenerations
const sampler = await createHydrologySampler({ device, terrainGenerator: gen });
const directions = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]);
const expected = await sampler.sampleDirsNatural(directions);
const rounds = [];
for (let i = 0; i < 3; i++) {
    rounds.push(await measure(async () => {
        await gen.prepareRegionalTerrain({ cells, seamCells: 4 }, { regenerate: true });
        await tiles();
    }));
    const actual = await sampler.sampleDirsNatural(directions);
    if (actual.some((h, k) => h !== expected[k])) throw new Error('Identical-input regeneration changed height');
}
// Exercise source invalidation before allocating sampling buffers.
gen._regionalTerrainDirty = true;
let staleRejected = false;
try { await sampler.sampleDirsNatural(directions); } catch { staleRejected = true; }
gen._regionalTerrainDirty = false;
if (!staleRejected) throw new Error('Stale regional sampling was accepted');
sampler.destroy();

// Full cold water reconstruction plus root and fine regeneration in ONE timer.
// The existing network is unchanged architecturally, and its expensive lake
// solves are included. This is a finite workload, not a planet-wide streaming
// benchmark or first-visible measurement.
const memoryBeforeReconstruction = process.memoryUsage();
const reconstruction = await measure(async () => {
    await gen.prepareRegionalTerrain({ cells, seamCells: 4 }, { regenerate: true });
    const service = new WaterService({ device, terrainGenerator: gen, planetConfig, useWorker: false, config: { cache: false } });
    const water = new WaterGpuData(device, { gridN: 512, planetRadius: planetConfig.radius,
        carve: service.config.carve, valley: service.config.valley });
    gen.setWaterCarveResources(water.resources);
    service.setWaterCarveResources(water.resources);
    gen.setRiverValleyResources(water.valleyResources);
    service.setRiverValleyResources(water.valleyResources);
    await service.start();
    if (service.state !== 'ready') throw new Error('Water reconstruction failed');
    const riverIds = previous.water.find(w => w.mode === 'regional').rivers.map(r => r.id);
    const riverBytes = [];
    for (const id of riverIds) {
        const r = await service.refineRiver(id);
        riverBytes.push(r.points.byteLength + r.segCells.byteLength + r.segCellStart.byteLength);
    }
    await water.update(service, { x: planetConfig.radius + 500, y: 0, z: 0 }, 0);
    await tiles();
    return { lakes: service.lakes.length, graphRivers: service.rivers.length, refinedRiverIds: riverIds,
        retainedRiverBytes: riverBytes, serviceTimings: service.timings,
        waterGpuBytes: ['indexBuffer', 'riversBuffer', 'lakesBuffer', 'paramsBuffer', 'valleyPagesBuffer', 'valleyTexelsBuffer', 'valleyParamsBuffer']
            .reduce((s, key) => s + (water[key]?.size ?? 0), 0)
            + water.masksTexture.width * water.masksTexture.height * water.masksTexture.depthOrArrayLayers };
});
const report = { cells, seed: gen.seed, rootCount: 6, fineTiles: addresses.map(String), fineOutputs: previous.tiles.types,
    coarseInputResidentBytes: gen.regionalTerrain.byteLength, coarseInputRegenerationPeakBytes: gen.regionalTerrain.byteLength * 2,
    fineTileOutputPayloadBytes: Object.fromEntries(tilePayloads),
    hostMemoryBeforeReconstruction: memoryBeforeReconstruction, hostMemoryAfterReconstruction: process.memoryUsage(),
    unchangedInputRootAndFineRegeneration: rounds, completeWaterReconstructionAndRootFineRegeneration: reconstruction,
    unchangedInputHeightsExact: true, staleSamplingRejected: staleRejected, gpuErrors: errors,
    notes: ['Warm root+fine results include replacing/destroying old roots, generating all seven tiles and a final queue fence.',
        'Reconstruction includes sampler creation, full N=512 graph, four river/lake solves, water GPU publication and seven complete fine tiles.',
        'Driver shader caches not cleared; output disposal included; native in-process worker.',
        'No browser, scene render, first-visible or entire resident-quadtree refresh is measured.'] };
fs.writeFileSync(`${output}/regeneration-${cells}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ cells, rootAndFineMs: rounds.map(r => r.wallMs), reconstructionMs: reconstruction.wallMs,
    reconstruction: reconstruction.value, staleRejected, gpuErrors: errors.length }, null, 2));
if (errors.length) throw new Error('GPU errors during regeneration');
process.exit(0);
