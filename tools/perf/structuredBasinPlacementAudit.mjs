/* global process */
// Read-only placement audit using the production regional inputs and current
// rim certificates. No basin records are installed into terrain or water.
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
import {HIGHLAND_BASIN_CASE} from './structuredBasinCases.mjs';

const started=performance.now(),{device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const {planRegionalBasins}=await imp('core/world/terrain-generator/regionalBasins.js');
const {regionalTerrainOptions}=await imp('core/world/terrain-generator/regionalTerrain.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {tangentBasis}=await imp('core/world/hydrology/lakeRefine.js');
const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js');
const {TileAddress}=await imp('core/world/quadtree/tileAddress.js');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const output=process.env.BASIN_OUTPUT??'tools/perf/structured-terrain-results/basin-highland';fs.mkdirSync(output,{recursive:true});
const setupWallMs=performance.now()-started,setupMemory=process.memoryUsage();
const rootStarted=performance.now(),regional=await gen.prepareRegionalTerrain({cells:256,seamCells:4});
const sharedRootsWallMs=performance.now()-rootStarted;
gen._fillTerrainUniformScratch(0,0,128,1,0);
const uniformBytes=gen._terrainUniformScratch.slice(0);
const plans=[];
for(const settings of [
    HIGHLAND_BASIN_CASE,
    {radiusM:40,minLevelM:900,maxRoughness:1},
]) {
    const options=regionalTerrainOptions({basins:{enabled:true,...settings}}).basins;
    const plan=await planRegionalBasins({device,gen,data:regional,uniformBytes,options});
    plans.push({options,...plan});
}
const samplerStarted=performance.now(),sampler=await createHydrologySampler({device,terrainGenerator:gen});
const samplerCompileWallMs=performance.now()-samplerStarted,contextStarted=performance.now(),contexts=[];
for(const plan of plans) for(const basin of plan.basins) {
    const frame={c:basin.centre,...tangentBasis(basin.centre),x0:-8250,y0:-8250,spacing:500,nx:33,ny:33};
    const heights=await sampler.samplePatch(frame,planetConfig.radius);
    const peak=Math.max(...heights),peakIndex=heights.indexOf(peak);
    contexts.push({radiusM:basin.radiusM,cell:basin.cell,levelM:basin.levelM,
        nearbyMinimumM:Math.min(...heights),nearbyMaximumM:peak,
        nearbyReliefAboveWaterM:peak-basin.levelM,contextSamples:heights.length,
        maximumOffsetM:[frame.x0+(peakIndex%frame.nx+.5)*frame.spacing,
            frame.y0+(Math.floor(peakIndex/frame.nx)+.5)*frame.spacing]});
}
sampler.destroy();
const contextWallMs=performance.now()-contextStarted;
const prior=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/benchmark-256.json'));
gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:prior.tiles.types,
    textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
const fineStarted=performance.now();
for(const address of prior.tiles.addresses) {
    const textures=await tileGen.generateTile(TileAddress.fromString(address));
    for(const t of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
}
await device.queue.onSubmittedWorkDone();
const fineWallMs=performance.now()-fineStarted;
const report={setupWallMs,completeAuditThroughSevenFineMs:performance.now()-started,sharedRootsWallMs,
    rootTimings:regional.timings,plans,samplerCompileWallMs,contextWallMs,contexts,fineWallMs,
    rootPayloadBytes:regional.byteLength,processMemory:{setup:setupMemory,final:process.memoryUsage()},gpuErrors:errors,
    notes:['Read-only: basin records are not published; the seven full-output terrain tiles remain uncarved.',
        'Candidate height/roughness filters control discovery only. Final water level still uses the continuous rim certificate.',
        'No water allocation or river generation is included; complete constructed-basin costs require a separate benchmark.',
        'Driver caches are uncontrolled. Mountain context samples classify the scene, never replace certificate minima.']};
fs.writeFileSync(`${output}/placement-audit.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({completeAuditThroughSevenFineMs:report.completeAuditThroughSevenFineMs,sharedRootsWallMs,
    plans:plans.map(p=>({options:p.options,basins:p.basins,candidates:p.candidates?.length,rimCandidates:p.rimCandidates,
        timings:p.timings})),contexts,gpuErrors:errors},null,2));
process.exit(errors.length?1:0);
