/* global process */
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';
import { HIGHLAND_BASIN_CASE } from './structuredBasinCases.mjs';

const start = performance.now();
const { device, gen, imp, engineConfig, planetConfig, profiler, collectProfile } = await setupLab(process.argv[2] ?? '.');
const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
const { QuadtreeGPU } = await imp('core/world/quadtree/QuadtreeGPU.js');
const { dirToFaceUV } = await imp('core/world/hydrology/waterGraph.js');
const output = 'tools/perf/structured-terrain-results/basin-highland';
const poses = JSON.parse(fs.readFileSync(`${output}/browser.json`)).views.filter(v => v.mode === 'prototype');
const opts = { cells: 256, seamCells: 4, basins: { enabled: true, ...HIGHLAND_BASIN_CASE } };
const roots = await gen.prepareRegionalTerrain(opts);
const qt = new QuadtreeGPU(device, { ...engineConfig.gpuQuadtree,
    planetRadius: planetConfig.radius, planetOrigin: planetConfig.origin,
    minTileSize: engineConfig.gpuQuadtree.minTileSizeMeters,
    loadedTableCapacity: engineConfig.gpuQuadtree.tileHashCapacity,
    maxFeedback: engineConfig.gpuQuadtree.feedbackCapacity,
    screenHeight: 900, fovDegrees: 75, maxGeomLOD: 6, regionalTerrain: roots,
    // Isolate selection from camera matrices; both alternatives see the full
    // sphere. The browser diagnostic verifies actual culling and streaming.
    enableFrustumCulling: false, enableHorizonCulling: false });
const initStart = performance.now(); await qt.initialize();
const quadtreeSetupMs = performance.now() - initStart;
const setupThroughRootsAndQuadtreeMs = performance.now() - start;
async function run(regional, pose) {
    qt.setRegionalTerrain(regional);
    qt._frameCount = 1; // avoid the periodic, unrelated console readback
    qt.updateUniforms(pose);
    qt.traverse(); await device.queue.onSubmittedWorkDone();
    profiler.enabled = true; const t = performance.now(), rounds = 16;
    for (let i = 0; i < rounds; i++) { qt.traverse(); await device.queue.onSubmittedWorkDone(); }
    const averageSubmitFenceMs = (performance.now() - t) / rounds;
    profiler.enabled = false;
    const gpu = await collectProfile();
    const results = await qt.readResults(), counters = await qt.debugReadTraversalDebugCounters();
    const c = roots.basins[0].centre, uv = dirToFaceUV(c);
    const containing = results.tiles.find(tile => tile.face === uv.face &&
        tile.x === Math.floor(uv.u * (1 << tile.depth)) && tile.y === Math.floor(uv.v * (1 << tile.depth)));
    if (counters.queueOverflow || counters.visibleOverflow || !containing) throw new Error('Selection overflow or missing basin tile');
    return { averageSubmitFenceMs, averageGpuMs: gpu.get('QuadtreeTraversal').ns / 1e6 / rounds,
        visibleCount: results.count, depthHistogram: results.depthHistogram, counters, containing };
}
const cases = [];
for (const { label, pose } of poses) {
    cases.push({ label, seaLevel: await run(null, pose), regional: await run(roots, pose) });
}
const regenerationStart = performance.now();
const replacement = await gen.prepareRegionalTerrain(opts, { regenerate: true });
const regenerated = await run(replacement, poses[0].pose);
const regenerationAndSelectionMs = performance.now() - regenerationStart;
qt.dispose(); await device.queue.onSubmittedWorkDone();
const report = { notes: ['Full-sphere selection diagnostic, no frustum/horizon culling or tile generation. Same poses/content. Complete terrain/water generation is reported separately in benchmark.json.',
    'Shares the existing regional textures. No new GPU buffer or texture; two views/bindings and an optional pipeline. Pipeline/driver overhead is not declared payload memory.'],
    setupThroughRootsAndQuadtreeMs, quadtreeSetupMs, rootTimings: roots.timings,
    regionalBytes: roots.byteLength, quadtreeBufferBytes: qt._stats.gpuMemoryBytes, lodFoundation: roots.lodFoundation,
    cases, regenerationAndSelectionMs, replacementTimings: replacement.timings, regenerated, gpuErrors: errors };
fs.writeFileSync(`${output}/lod-benchmark.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(errors.length ? 1 : 0);
