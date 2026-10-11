import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { hashParts } from '../hydrology/waterCache.js';
import { TileAddress } from '../quadtree/tileAddress.js';
import { createRegionalTerrainBakeWgsl, createRegionalTerrainBoundsWgsl } from './regionalTerrain.wgsl.js';
import { terrainDisplacementBudgets } from './terrainHeightContract.js';
import { planRegionalBasins, createRegionalBasinCertifier } from './regionalBasins.js';
import { planRegionalDrainage } from './regionalDrainage.js';
import { createRegionalPlacementData } from './regionalPlacement.js';
import { createRegionalValleyFeature } from './regionalValleyFeature.js';
import {acquireRegionalTerrainFoundation} from './regionalTerrainFoundation.js';
import {regionalShapeOptions,createRegionalShapeData} from './regionalShape.js';
import {planetWaterOptions,createPlanetWaterShapes,isPlanetWaterSiteRejection} from './planetWaterPlacement.js';

export const REGIONAL_TERRAIN_VERSION = 'regional-macro-v17-scaled-water';

export function regionalTerrainOptions(options = {}) {
    const cells = options.cells ?? 128;
    const seamCells = options.seamCells ?? 4;
    if (!Number.isInteger(cells) || cells < 16 || cells > 512 || (cells & (cells - 1))) {
        throw new Error('regionalTerrain.cells must be a power of two from 16 to 512');
    }
    if (!Number.isFinite(seamCells) || seamCells < 2 || seamCells >= cells / 2) {
        throw new Error('regionalTerrain.seamCells must be at least 2 and less than cells / 2');
    }
    const basins = options.basins?.enabled === true ? { enabled:true, carve:true,candidates:128,radiusM:100,
        rimCandidates:Math.min(16,options.basins.candidates??128),rimSegments:64,
        minLevelM:100,maxCentreCutM:12,rimM:1.5,depthM:3,
        candidateMinM:Math.min(100,options.basins.minLevelM??100),maxRoughness:.2,
        bankReachM:Math.min(18,(options.basins.radiusM??100)*.18),...options.basins } : null;
    if(basins && (typeof basins.carve!=='boolean'||!Number.isInteger(basins.candidates)||basins.candidates<1||basins.candidates>128
        || !Number.isInteger(basins.rimCandidates)||basins.rimCandidates<1||basins.rimCandidates>basins.candidates
        || !Number.isInteger(basins.rimSegments)||basins.rimSegments<16||basins.rimSegments>64||basins.rimSegments%16!==0
        || ['radiusM','minLevelM','maxCentreCutM','rimM','depthM'].some(k=>!Number.isFinite(basins[k])||basins[k]<=0)
        || !Number.isFinite(basins.bankReachM)||basins.bankReachM<0||basins.bankReachM>basins.radiusM*.3
        || !Number.isFinite(basins.candidateMinM)||basins.candidateMinM<0||basins.candidateMinM>basins.minLevelM
        || !Number.isFinite(basins.maxRoughness)||basins.maxRoughness<0||basins.maxRoughness>1)) {
        throw new Error('Invalid regional basin planning options');
    }
    const world=options.world?.enabled===true?planetWaterOptions(options.world):null;
    const drainage=options.drainage?.enabled===true||world?{enabled:true,carve:true,minDistanceM:1500,maxDistanceM:6000,
        minimumDropM:2,spacingM:128,halfWidthM:15,profile:'endpoint',profileStepM:8,maxProfilePoints:1024,
        maxChannelCutM:24,fallExtraCutM:4,fallRunM:1.5,course:'coarse',heightSource:'natural',
        ...(world?{course:'organic',profile:'terrain',profileStepM:16}:{}),...options.drainage}:null;
    if(drainage && (!basins||typeof drainage.carve!=='boolean'||['minDistanceM','maxDistanceM','minimumDropM','spacingM','halfWidthM'].some(k=>!Number.isFinite(drainage[k])||drainage[k]<=0)
        || drainage.maxDistanceM<=drainage.minDistanceM||drainage.maxDistanceM>12000||drainage.spacingM<(drainage.profile==='terrain'?32:64)||drainage.spacingM>512
        || drainage.halfWidthM>30||!['endpoint','terrain'].includes(drainage.profile)
        ||!['coarse','organic'].includes(drainage.course)||!['natural','foundation'].includes(drainage.heightSource)
        ||!Number.isFinite(drainage.profileStepM)||drainage.profileStepM<4||drainage.profileStepM>32
        ||!Number.isInteger(drainage.maxProfilePoints)||drainage.maxProfilePoints<32||drainage.maxProfilePoints>2048
        ||!Number.isFinite(drainage.maxChannelCutM)||drainage.maxChannelCutM<2||drainage.maxChannelCutM>30
        ||!Number.isFinite(drainage.fallExtraCutM)||drainage.fallExtraCutM<0||drainage.fallExtraCutM>6
        ||!Number.isFinite(drainage.fallRunM)||drainage.fallRunM<1||drainage.fallRunM>4)) throw new Error('Invalid regional drainage options');
    const placement=options.placement?.enabled===true?{enabled:true,cells:64,regions:24,patchCells:17,spacingM:150,
        candidates:64,minimumRiseM:50,maxNaturalHeightM:2000,...options.placement}:null;
    if(placement&&(!basins||![32,64,128].includes(placement.cells)||!Number.isInteger(placement.regions)||placement.regions<1||placement.regions>32
        ||!Number.isInteger(placement.candidates)||placement.candidates<1||placement.candidates>64
        ||!Number.isInteger(placement.patchCells)||placement.patchCells<13||placement.patchCells>21||placement.patchCells%2!==1
        ||!Number.isFinite(placement.spacingM)||placement.spacingM<100||placement.spacingM>300
        ||!Number.isFinite(placement.minimumRiseM)||placement.minimumRiseM<20||placement.minimumRiseM>300
        ||!Number.isFinite(placement.maxNaturalHeightM)||placement.maxNaturalHeightM<=basins.minLevelM)) throw new Error('Invalid regional placement survey options');
    const valley=options.valley?.enabled===true?{enabled:true,terrain:true,face:3,x:229,y:142,halfLengthM:500,halfWidthM:350,
        hillHeightM:110,detailLimitM:1.5,microLimitM:.5,minPrecipitation:.25,...options.valley}:null;
    if(valley&&(!basins||placement||drainage||typeof valley.terrain!=='boolean'||(basins.carve&&!valley.terrain)
        ||!Number.isInteger(valley.face)||valley.face<0||valley.face>5
        ||['x','y'].some(k=>!Number.isInteger(valley[k])||valley[k]<0||valley[k]>=cells)
        ||['halfLengthM','halfWidthM','detailLimitM','microLimitM'].some(k=>!Number.isFinite(valley[k])||valley[k]<=0)
        ||Math.min(valley.halfLengthM,valley.halfWidthM)<(basins.radiusM+6)/.39
        ||Math.max(valley.halfLengthM,valley.halfWidthM)>2000
        ||!Number.isFinite(valley.hillHeightM)||valley.hillHeightM<0||valley.hillHeightM>300
        ||!Number.isFinite(valley.minPrecipitation)||valley.minPrecipitation<0||valley.minPrecipitation>1)) throw new Error('Invalid regional valley feature options');
    const shape=regionalShapeOptions(options.shape);
    if(world&&(!basins||shape||placement||valley))throw new Error('Planet placement requires basins and exclusive ownership of shape regions');
    if(shape&&(!basins||placement||valley||(drainage&&drainage.profile!=='terrain'))) throw new Error('Regional shape requires basins and a terrain-following drainage profile, without legacy survey/valley');
    return { enabled: options.enabled === true, cells, seamCells, basins, drainage, placement, valley, shape,world };
}

/**
 * Always-resident depth-0 generation inputs, NOT render heights/mipmaps.
 * All descendants and hydrology read these same controls regardless of LOD.
 * Two RGBA32F fields; no erosion or short-scale relief is baked into them.
 * Complete GPU generation precedes publication. Inputs survive every fine
 * submission until destroy()'s queue fence. No render-pool layers are borrowed.
 */
export async function createRegionalTerrainData({ device, terrainGenerator: gen, options, version = 1, previousFoundation = null }) {
    const t0 = performance.now();
    const { cells, seamCells, basins:basinsConfig, drainage:drainageConfig, placement:placementConfig, valley:valleyConfig,shape:shapeConfig,world:worldConfig } = regionalTerrainOptions(options);
    if(basinsConfig && Math.abs(gen.noiseReferenceRadiusM-gen.planetConfig.radius)>1e-3) {
        throw new Error('Basin preview currently requires noise reference radius equal to planet radius');
    }
    if(basinsConfig && (basinsConfig.radiusM+6)>gen.planetConfig.radius*0.01) {
        throw new Error('Basin local rim certificate requires footprint plus rim band <= 1% of planet radius');
    }
    const size = cells + 3;
    gen._fillTerrainUniformScratch(0, 0, 128, 1, 0);
    const uniformBytes = gen._terrainUniformScratch.slice(0);
    const uniformView = new DataView(uniformBytes);
    const maxHeightM = uniformView.getFloat32(184, true);
    const disableMask = uniformView.getUint32(60, true);
    // A selection proxy, not a final height or conservative bound. Derive
    // it from the same feature switches/profile as these immutable controls.
    const lodFoundation = { cells,
        shelfM: (disableMask & 1) ? 0 : .14 * Math.min(5, Math.max(0, uniformView.getFloat32(192, true))) * maxHeightM,
        regionM: (disableMask & 2) ? 0 : maxHeightM };
    const budgets = terrainDisplacementBudgets({ erosionFilter: gen.erosionFilter,
        microGain: new DataView(uniformBytes).getFloat32(220, true), features: gen.terrainFeatures });
    const source = createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({
        regionalTerrain: false, regionalShape:false,regionalValleyFeature:false, waterCarve: false, riverValley: false,
    })) + createRegionalTerrainBakeWgsl() + createRegionalTerrainBoundsWgsl(budgets, seamCells);
    const sourceSetupMs=performance.now()-t0;
    const acquired=await acquireRegionalTerrainFoundation({device,source,uniformBytes,cells,seamCells,budgets,
        previous:previousFoundation,version,reusePipelines:gen._regionalPipelineReuse!==false});
    const {foundation,timings:foundationTimings}=acquired;
    const {fields,lowerBounds}=foundation;
    // Feature versions depend on the immutable terrain phase, but do not own
    // duplicate copies of it. Changed source/contracts get a new foundation.
    let sourceKey=hashParts([REGIONAL_TERRAIN_VERSION,foundation.key,basinsConfig,drainageConfig,placementConfig,valleyConfig,shapeConfig,worldConfig]);
    let inputParams,basinBuffer,valleyBuffer,shapeData=null,placementData=null;
    try {
        inputParams = device.createBuffer({ label: 'Regional macro input params', size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const basinBytes=176*(worldConfig?worldConfig.maxLakes+worldConfig.maxRivers:drainageConfig?2:1);
        basinBuffer = device.createBuffer({label:'Regional basin records',size:basinBytes,
            usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        valleyBuffer=valleyConfig?device.createBuffer({label:'Regional terrain valley feature',size:96,
            usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}):null;
        device.queue.writeBuffer(inputParams, 0, new Float32Array([cells, seamCells, 0, 0]));
        const baseEntries=[...fields.map((texture,binding)=>({binding,resource:texture.createView({dimension:'2d-array'})})),
            {binding:2,resource:{buffer:inputParams}},{binding:3,resource:{buffer:basinBuffer}}];
        if(worldConfig)shapeData=await createPlanetWaterShapes({device,gen,uniformBytes,options:worldConfig,waterEnabled:basinsConfig.carve,
            data:{cells,size,fields,lowerBounds,budgets,bindGroupEntries:baseEntries}});
        if(shapeConfig) shapeData=await createRegionalShapeData({device,gen,uniformBytes,options:shapeConfig,waterEnabled:basinsConfig.carve,
            data:{cells,size,fields,lowerBounds,budgets,bindGroupEntries:baseEntries}});
        const bindGroupLayout = device.createBindGroupLayout({ entries: [
            ...[0, 1].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } })),
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: {type:'read-only-storage'} },
            ...(valleyBuffer?[{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}}]:[]),
            ...(shapeData?[{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
                {binding:5,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float',viewDimension:'2d'}}]:[]),
        ] });
        const bindGroupEntries = [
            ...fields.map((texture, binding) => ({ binding, resource: texture.createView({ dimension: '2d-array' }) })),
            { binding: 2, resource: { buffer: inputParams } },
            { binding: 3, resource: { buffer: basinBuffer } },
            ...(valleyBuffer?[{binding:4,resource:{buffer:valleyBuffer}}]:[]),
            ...(shapeData?[{binding:4,resource:{buffer:shapeData.params}},{binding:5,resource:shapeData.texture.createView()}]:[]),
        ];
        const bindGroup = device.createBindGroup({ label: `Regional macro inputs v${version}`, layout: bindGroupLayout, entries: bindGroupEntries });
        let basinPlan = {basins:[],candidates:[],timings:{totalMs:0}};
        let drainagePlan=null,valleyFeature=null,sharedCertificateCompileMs=0;
        if(basinsConfig) {
            const planningData={cells,size,fields,lowerBounds,budgets,bindGroupEntries,shapeData};
            const certifier=drainageConfig||placementConfig?await createRegionalBasinCertifier({device,gen,data:planningData,uniformBytes,withHeights:!!drainageConfig,withPlacement:!!placementConfig,slopeAware:!!placementConfig,
                routeHeightSource:drainageConfig?.heightSource??'natural'}):null;
            sharedCertificateCompileMs=certifier?.compileMs??0;
            if(placementConfig) placementData=await createRegionalPlacementData({gen,data:planningData,options:placementConfig,basinOptions:basinsConfig,certifier});
            if(worldConfig) {
                basinPlan={basins:[...shapeData.basins],candidates:[],certificate:{kind:'planet-continuous-spline-regions'},timings:{totalMs:0}};
            } else if(shapeData) {
                basinPlan={basins:shapeData.basin?[shapeData.basin]:[],candidates:[],certificate:shapeData.basin?.shapeProof??null,
                    timings:{totalMs:0},shapePlan:shapeData.lakePlan};
            } else if(valleyConfig) {
                valleyFeature=await createRegionalValleyFeature({device,gen,data:planningData,uniformBytes,options:valleyConfig,basinOptions:basinsConfig});
                device.queue.writeBuffer(valleyBuffer,0,valleyFeature.parameters);
                basinPlan={basins:[valleyFeature.basin],candidates:[],certificate:{kind:'bounded-terrain-feature',
                    guaranteedAnnulusM:[basinsConfig.radiusM,basinsConfig.radiusM+6]},timings:{totalMs:0}};
            } else {
                basinPlan = await planRegionalBasins({device,gen,data:planningData,uniformBytes,options:basinsConfig,certifier,
                    candidateSites:placementData?.candidates??null,tightRimCaps:!!placementConfig});
            }
            if(!worldConfig&&!basinPlan.basins.length&&(!shapeData||drainageConfig)) throw new Error('No regional basin candidate meets the certified excavation budget');
            if(worldConfig) {
                const started=performance.now(),rivers=[],attempts=[];let cpuBytes=0,uploadBytes=0,readbackBytes=0;
                planningData.occupiedBasins=basinPlan.basins;
                const incoming=new Map(),radius=gen.planetConfig.radius;
                for(const source of basinPlan.basins) {
                    if(rivers.length>=worldConfig.maxRivers)break;
                    const candidates=basinPlan.basins.filter(b=>b.id!==source.id&&b.levelM<=source.levelM-drainageConfig.minimumDropM
                        &&(incoming.get(b.id)??0)<3).map(receiver=>({receiver,distanceM:radius*Math.hypot(...receiver.centre.map((v,k)=>v-source.centre[k]))}))
                        .filter(p=>p.distanceM>source.radiusM+p.receiver.radiusM+150&&p.distanceM<6000)
                        .sort((a,b)=>a.distanceM-b.distanceM||a.receiver.id-b.receiver.id).slice(0,3);
                    for(const {receiver,distanceM} of candidates)try {
                        const plan=await planRegionalDrainage({device,gen,data:planningData,uniformBytes,basinOptions:basinsConfig,source,receiver,certifier,
                            options:{...drainageConfig,profileStepM:worldConfig.riverProfileStepM,
                                halfWidthM:Math.max(4,Math.min(12,Math.min(source.radiusM,receiver.radiusM)*.06)),riverId:rivers.length}});
                        rivers.push(...plan.rivers);cpuBytes+=plan.cpuBytes;
                        incoming.set(receiver.id,(incoming.get(receiver.id)??0)+1);
                        uploadBytes+=plan.timings.uploadBytes;readbackBytes+=plan.timings.readbackBytes;
                        attempts.push({sourceId:source.id,receiverId:receiver.id,distanceM,accepted:true,timings:plan.timings});break;
                    }catch(error){
                        if(!isPlanetWaterSiteRejection(error))throw error;
                        attempts.push({sourceId:source.id,receiverId:receiver.id,distanceM,accepted:false,reason:error.message});
                    }
                }
                drainagePlan={rivers,cpuBytes,timings:{totalMs:performance.now()-started,uploadBytes,readbackBytes,attempts}};
            } else if(drainageConfig) {
                drainagePlan=await planRegionalDrainage({device,gen,data:planningData,uniformBytes,basinOptions:basinsConfig,
                    source:basinPlan.basins[0],options:drainageConfig,certifier});
                basinPlan.basins.push(drainagePlan.receiver);
            }
            const maxH = new DataView(uniformBytes).getFloat32(184,true);
            if(basinPlan.basins.some(b=>b.levelM>1.55*maxH || b.levelM-b.depthM<-.85*maxH)) {
                throw new Error('Basin level outside the current linear height-clamp contract');
            }
            // The shape field owns its source basin. Only the other records
            // enter the existing radial height-field feature evaluator.
            const analyticBasins=shapeData?basinPlan.basins.filter(b=>!b.shapeProof):basinPlan.basins;
            if(worldConfig)shapeData.timings.uploadBytes+=shapeData.publishBasinIndex(analyticBasins);
            if(analyticBasins.length) device.queue.writeBuffer(basinBuffer,0,new Float32Array(analyticBasins.flatMap(b=>[...b.centre,b.radiusM,b.levelM,b.depthM,b.rimM,b.lowerM,
                ...b.axis,b.centreCutM,...b.radialControls.flat()])));
            device.queue.writeBuffer(inputParams,0,new Float32Array([cells,seamCells,basinsConfig.carve&&valleyFeature?.wet!==false?analyticBasins.length:0,valleyConfig?.terrain?1:0]));
            // Hash typed payloads as bytes. JSON stringification of thousands
            // of lake masks was taking several seconds and inflating peak RAM.
            const keyStarted=performance.now();
            sourceKey = hashParts([sourceKey,...basinPlan.basins.flatMap(b=>{
                const {mask,surfaceDepthMask,...description}=b;return [description,mask,surfaceDepthMask];
            }),...drainagePlan?.rivers.map(r=>r.points)??[],valleyFeature?.parameters??null]);
            basinPlan.timings.keyMs=performance.now()-keyStarted;
            await device.queue.onSubmittedWorkDone();
        }
        let destroying=null;
        return {
            sourceKey, version, cells, seamCells, size, fields, lowerBounds, foundation, budgets, bindGroupLayout, bindGroup, bindGroupEntries, lodFoundation,
            basinsConfig,basins:basinsConfig?.carve===false||valleyFeature?.wet===false?[]:basinPlan.basins,basinPlan,drainageConfig,drainagePlan,placementConfig,placementData,valleyConfig,valleyFeature,shapeConfig,shapeData,worldConfig,
            boundStage: 'natural-final-with-micro-before-intentional-water-excavation',
            regions: Array.from({ length: 6 }, (_, face) => new TileAddress(face, 0, 0, 0)),
            byteLength: foundation.byteLength + 16 + basinBytes + (placementData?.byteLength??0)+(valleyBuffer?96:0)+(shapeData?.byteLength??0),
            cpuPlanningBytes:foundation.cpuBytes+(drainagePlan?.cpuBytes??0)+(placementData?.values.byteLength??0)+(valleyFeature?.parameters.byteLength??0)+(shapeData?.cpuBytes??0),
            timings: { sourceSetupMs, foundation:foundationTimings,compileMs:foundationTimings.compileMs,
                pipelineCacheHit:foundationTimings.pipelineCacheHit,encodeMs:foundationTimings.encodeMs,
                completionWallMs:foundationTimings.completionWallMs,totalMs:performance.now()-t0,
                dispatches:foundationTimings.dispatches,controlCount:6*size*size,boundCount:6*cells*cells,
                uploadBytes:foundationTimings.uploadBytes+16+(basinsConfig?16+176*basinPlan.basins.length:0)
                    +(basinPlan.timings.uploadBytes??0)+(drainagePlan?.timings.uploadBytes??0)+(placementData?.timings.uploadBytes??0)+(valleyFeature?.timings.uploadBytes??0)+(shapeData?.timings.uploadBytes??0),
                readbackBytes: (basinPlan.timings.readbackBytes??0) + (drainagePlan?.timings.readbackBytes??0) + (placementData?.timings.readbackBytes??0)+(valleyFeature?.timings.readbackBytes??0)+(shapeData?.timings.readbackBytes??0),
                basinPlanning:basinPlan.timings,sharedCertificateCompileMs,drainagePlanning:drainagePlan?.timings??null,placementSurvey:placementData?.timings??null,valleyFeature:valleyFeature?.timings??null,shape:shapeData?.timings??null },
            destroy() {
                if(!destroying)destroying=(async()=>{
                    try {await device.queue.onSubmittedWorkDone();}
                    finally {
                        inputParams.destroy();basinBuffer.destroy();placementData?.buffer.destroy();
                        valleyBuffer?.destroy();shapeData?.destroy();await foundation.release();
                    }
                })();
                return destroying;
            },
        };
    } catch(error) {
        try {await device.queue.onSubmittedWorkDone();}
        finally {
            inputParams?.destroy();basinBuffer?.destroy();placementData?.buffer.destroy();
            valleyBuffer?.destroy();shapeData?.destroy();await foundation.release();
        }
        throw error;
    }
}
