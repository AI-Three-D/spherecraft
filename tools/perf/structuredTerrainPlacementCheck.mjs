/* global process */
// Placement feasibility on the accepted regional terrain, without changing
// any height/feature/erosion equation or carving terrain to conceal a weak bound.
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';

const cells = Number(process.argv[3] ?? 256);
const started = performance.now();
const { device, gen, imp, planetConfig } = await setupLab(process.argv[2] ?? '.');
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { faceUVToDir } = await imp('core/world/hydrology/waterGraph.js');
const { tangentBasis } = await imp('core/world/hydrology/lakeRefine.js');
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const output = 'tools/perf/structured-terrain-results';
const prior = JSON.parse(fs.readFileSync(`${output}/benchmark-${cells}.json`));
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
const prepareStarted = performance.now();
const regional = await gen.prepareRegionalTerrain({ cells, seamCells: 4 });
const sharedRootWallMs = performance.now() - prepareStarted;
const planningStarted = performance.now();
const readStarted = performance.now();
async function readFloatTexture(texture, width, height, channels) {
const row = Math.ceil(width * channels * 4 / 256) * 256;
const rb = device.createBuffer({ size: row * height * 6, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer({ texture }, { buffer: rb, bytesPerRow: row, rowsPerImage: height }, [width, height, 6]);
device.queue.submit([encoder.finish()]);
await rb.mapAsync(GPUMapMode.READ);
const mapped = new Float32Array(rb.getMappedRange()), values = new Float32Array(width * height * channels * 6);
for (let y = 0; y < height * 6; y++) values.set(mapped.subarray(y * row / 4, y * row / 4 + width * channels), y * width * channels);
rb.unmap(); rb.destroy();
return values;
}
const lower = await readFloatTexture(regional.lowerBounds, cells, cells, 1);
const macroB = await readFloatTexture(regional.fields[1], regional.size, regional.size, 4);
const boundReadbackWallMs = performance.now() - readStarted;

// Deterministic highland candidates from authoritative regional minima.
// Keep them separated rather than taking 16 adjacent cells of one patch.
const possible = Array.from(lower, (height, cell) => ({ height, cell })).filter(r => r.height > 100)
    .filter(r => {
        if (!process.argv.includes('--low-relief')) return true;
        const face = Math.floor(r.cell / (cells*cells)), x = r.cell % cells, y = Math.floor(r.cell/cells) % cells;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
            const k = (face*regional.size*regional.size + (y+j)*regional.size + x+i)*4;
            if (macroB[k+3] > .2) return false;
        }
        return true;
    })
    .sort((a, b) => b.height - a.height || a.cell - b.cell);
const candidates = [];
const candidateSearchStarted = readStarted + boundReadbackWallMs;
for (const item of possible) {
    const face = Math.floor(item.cell / (cells * cells));
    const x = item.cell % cells, y = Math.floor(item.cell / cells) % cells;
    if (candidates.some(c => c.face === face && Math.hypot(c.x - x, c.y - y) < 8)) continue;
    candidates.push({ ...item, face, x, y });
    if (candidates.length === 16) break;
}
const candidateSearchWallMs = performance.now() - candidateSearchStarted;
const compileStarted = performance.now();
const sampler = await createHydrologySampler({ device, terrainGenerator: gen });
const samplerCompileWallMs = performance.now() - compileStarted;
const placementStarted = performance.now();
const sites = [];
for (const candidate of candidates) {
    const c = faceUVToDir(candidate.face, (candidate.x + .5) / cells, (candidate.y + .5) / cells);
    // This small inspection patch stays inside its owning coarse cell; use
    // a conservative physical half-width for the gnomonic face map.
    const radiusM = planetConfig.radius / cells * .2;
    const basis = tangentBasis(c), size = 33, spacing = 2 * radiusM / (size - 1);
    const frame = { c, ...basis, x0: -radiusM - .5 * spacing, y0: -radiusM - .5 * spacing,
        nx: size, ny: size, spacing };
    const heights = await sampler.samplePatch(frame, planetConfig.radius);
    const rimClearanceM = 8, intendedDepthM = 8;
    const levelM = candidate.height - rimClearanceM;
    const centreHeightM = heights[(size * size - 1) / 2];
    const requiredCentreCutM = centreHeightM - (levelM - intendedDepthM - regional.budgets.microM);
    sites.push({ ...candidate, centreDir: c, radiusM, levelM, intendedDepthM, rimClearanceM,
        minimumSampledNaturalHeightM: Math.min(...heights), centreHeightM, requiredCentreCutM,
        sampledContractDeficits: heights.filter(h => h < candidate.height).length,
        withinInitialCutBudget: requiredCentreCutM <= 100 });
}
const placementWallMs = performance.now() - placementStarted;
const completePlanningWallMs = performance.now() - planningStarted;
sampler.destroy();

// Include seven complete terrain outputs and a final queue fence in the
// generation total. These heights and materials remain unmodified.
gen._quadtreeSplatDiagCount = 3; gen._quadtreeSplatProbePassCount = 3; gen._quadtreeSplatPrimeCount = 3;
const tileGen = new TileGenerator(gen, { textureSize: 128, requiredTypes: prior.tiles.types,
    textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm' },
    quadtreeMaxDepth: 11, maxGeomLOD: 6, enableSplat: true });
const fineStarted = performance.now();
for (const address of prior.tiles.addresses) {
    const textures = await tileGen.generateTile(TileAddress.fromString(address));
    for (const t of new Set(Object.values(textures).map(t => t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
}
await device.queue.onSubmittedWorkDone();
const fineWallMs = performance.now() - fineStarted;
const report = { cells, seed: gen.seed, completeGenerationWallMs: performance.now() - started,
    sharedRootWallMs, boundReadbackWallMs, candidateSearchWallMs, samplerCompileWallMs,
    placementWallMs, completePlanningWallMs, fineWallMs,
    rootPayloadBytes: regional.byteLength, boundReadbackPayloadBytes: lower.byteLength+macroB.byteLength,
    boundsBytes:lower.byteLength,macroControlReadbackBytes:macroB.byteLength,
    inspectionSamples: sites.length * 33 * 33, sites, gpuErrors: errors,
    initialMaxCentreCutM: 100, withinInitialCutBudget: sites.filter(s => s.withinInitialCutBudget).length,
    notes: ['The 100 m cut ceiling is an inspection rejection criterion, not a new terrain parameter.',
        'This checks highland candidate feasibility; it does not claim to exhaust all possible lake sites.',
        'Sampled natural height is used to measure excavation, never substituted for the conservative bound.',
        'No production terrain, basin, water-level or feature equation was changed by this check.',
        'Cold driver cache is uncontrolled. Full root/water/fine regeneration costs remain in the original evidence.'] };
const suffix = process.argv.includes('--low-relief') ? '-low-relief' : '-local-contract';
fs.writeFileSync(`${output}/placement-check-${cells}${suffix}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ completeGenerationWallMs: report.completeGenerationWallMs,
    placementWallMs, sites: sites.length, acceptedByCutBudget: report.withinInitialCutBudget,
    centreCutRangeM: [Math.min(...sites.map(s => s.requiredCentreCutM)), Math.max(...sites.map(s => s.requiredCentreCutM))], gpuErrors: errors.length }, null, 2));
process.exit(errors.length || sites.some(s => s.sampledContractDeficits) ? 1 : 0);
