/* global process */
// Real production startup diagnostics, with caller-owned outputs disposed
// before asynchronous readback. Also checks river-bed sentinel uploads.
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';

const cells = Number(process.argv[3] ?? 256);
const { device, gen, imp } = await setupLab(process.argv[2] ?? '.');
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const { RiverBedBake } = await imp('core/renderer/rivers/riverBedBake.js');
const errors = [], diagnostics = [], diagnosticFailures = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
if (cells) await gen.prepareRegionalTerrain({ cells, seamCells: 4 });

// Force the real consumer lifetime: tiles can be copied to the atlas and
// disposed while startup's optional diagnostic callback is still pending.
let release;
const readbackGate = new Promise(resolve => { release = resolve; });
const analyze = gen._debugAnalyzeQuadtreeSplatPass.bind(gen);
gen._debugAnalyzeQuadtreeSplatPass = (...args) => {
    const pending = readbackGate.then(() => analyze(...args));
    diagnostics.push(pending.catch(error => diagnosticFailures.push(String(error))));
    return pending;
};
const tileGen = new TileGenerator(gen, { textureSize: 128,
    requiredTypes: ['height', 'normal', 'tile', 'macro', 'splatData', 'splatIndex',
        'splatValid', 'resolvedColor', 'scatter', 'climate', 'coarseColor'],
    textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm' },
    quadtreeMaxDepth: 11, maxGeomLOD: 6, enableSplat: true });
const started = performance.now();
for (let i = 0; i < 3; i++) {
    const outputs = await tileGen.generateTile(new TileAddress(0, 8, 128 + i, 128));
    for (const texture of new Set(Object.values(outputs).map(t => t?._gpuTexture?.texture).filter(Boolean))) texture.destroy();
}
await device.queue.onSubmittedWorkDone();
await new Promise(resolve => setTimeout(resolve, 0));
release();
await Promise.all(diagnostics);
if (diagnostics.length !== 3) throw new Error(`Expected three startup diagnostics; got ${diagnostics.length}`);

const bake = new RiverBedBake(device, { gridW: 8, gridL: 8 });
bake.initialize();
await device.queue.onSubmittedWorkDone();
await new Promise(resolve => setTimeout(resolve, 0));
bake.dispose();
const report = { cells, wallMs: performance.now() - started, diagnostics: diagnostics.length,
    diagnosticFailures, gpuErrors: errors, outputsDisposedBeforeReadback: true };
fs.writeFileSync(`/tmp/spherecraft-gpu-health-${cells}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(errors.length || diagnosticFailures.length ? 1 : 0);
