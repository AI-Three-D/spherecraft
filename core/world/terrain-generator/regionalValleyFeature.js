import {faceUVToDir} from '../hydrology/waterGraph.js';
import {tangentBasis} from '../hydrology/lakeRefine.js';
import {createAdvancedTerrainComputeShader} from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import {createRegionalValleyAnchorWgsl} from './regionalValleyFeature.wgsl.js';

// A canonical terrain feature address, not a discovered lake position. This
// first recipe creates one feature in a configured regional cell. Later
// density/type selection can enumerate seeded features using the same contract.
export function regionalValleySeed({seed,cells,options}) {
    let state=(seed^Math.imul(options.face+1,0x9e3779b1)^Math.imul(options.x+1,73856093)^Math.imul(options.y+1,19349663))>>>0;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const centre=faceUVToDir(options.face,(options.x+.38+.24*random())/cells,(options.y+.38+.24*random())/cells);
    const frame=tangentBasis(centre),angle=random()*Math.PI*2;
    const axis=frame.e1.map((v,k)=>v*Math.cos(angle)+frame.e2[k]*Math.sin(angle));
    const radialControls=Array.from({length:16},()=>[.25+.25*random(),.72+.24*random()]);
    const hills=[options.hillHeightM*(.8+.4*random()),options.hillHeightM*(.8+.4*random()),-.2+.4*random(),-.2+.4*random()];
    return {centre,axis,radialControls,hills,cell:options.face*cells*cells+options.y*cells+options.x};
}

export function regionalValleyContract({anchorM,options,basinOptions,globalMicroM,existingLowerM,maxHeightM}) {
    const detail=options.detailLimitM,micro=options.microLimitM;
    const levelM=anchorM-detail-micro-basinOptions.rimM-1;
    const depressionM=anchorM-levelM+basinOptions.depthM+detail+micro+.2;
    const lowerM=anchorM-detail-micro-1;
    const featureLowerM=anchorM-depressionM-detail-globalMicroM-1;
    const floorUpperM=anchorM-depressionM+detail+micro+6*(basinOptions.radiusM*.12/options.halfLengthM)**2;
    if(featureLowerM<existingLowerM) throw new Error('Valley feature would invalidate existing regional lower bounds');
    if(levelM<basinOptions.minLevelM||anchorM+options.hillHeightM*3.4+detail+globalMicroM+6>1.55*maxHeightM
        ||featureLowerM<-.85*maxHeightM) throw new Error('Valley feature outside the linear height/level contract');
    if(floorUpperM>levelM-basinOptions.depthM) throw new Error('Valley feature wet-core contract invalid');
    return {levelM,depressionM,lowerM,featureLowerM,floorUpperM,waterIntervalM:[floorUpperM+basinOptions.depthM,lowerM-basinOptions.rimM]};
}

export async function createRegionalValleyFeature({device,gen,data,uniformBytes,options,basinOptions}) {
    const started=performance.now(),seed=regionalValleySeed({seed:gen.seed,cells:data.cells,options});
    const code=createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({regionalTerrain:true,
        regionalValleyFeature:false,waterCarve:false,riverValley:false}))+createRegionalValleyAnchorWgsl();
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'regionalValleyAnchorMain'}});
    const compileMs=performance.now()-started;
    const ub=device.createBuffer({size:uniformBytes.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const ib=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const ob=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const rb=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    let values,sampleMs;
    try {
        device.queue.writeBuffer(ub,0,uniformBytes);
        device.queue.writeBuffer(ib,0,new Float32Array([...seed.centre,Math.max(options.halfLengthM,options.halfWidthM)]));
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass({label:'Regional valley anchor/climate'});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:ub}},{binding:6,resource:{buffer:ib}},{binding:7,resource:{buffer:ob}},
            {binding:8,resource:data.lowerBounds.createView({dimension:'2d-array'})}]}));
        pass.setBindGroup(1,device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}));
        pass.setBindGroup(2,device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:data.bindGroupEntries.filter(e=>e.binding<3)}));
        pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(ob,0,rb,0,16);
        const sampled=performance.now();device.queue.submit([encoder.finish()]);await rb.mapAsync(GPUMapMode.READ);
        values=new Float32Array(rb.getMappedRange()).slice();rb.unmap();sampleMs=performance.now()-sampled;
    } finally {if(rb.mapState==='mapped') rb.unmap();for(const b of [ub,ib,ob,rb]) b.destroy();}
    const [anchorM,precipitation,mask,existingLowerM]=values;
    if(mask<.45) throw new Error('Valley feature crosses ocean or an unsupported face seam');
    const maxHeightM=new DataView(uniformBytes).getFloat32(184,true);
    const contract=regionalValleyContract({anchorM,options,basinOptions,globalMicroM:data.budgets.microM,existingLowerM,maxHeightM});
    const wet=precipitation>=options.minPrecipitation;
    const basin={id:0,centre:seed.centre,radiusM:basinOptions.radiusM,axis:seed.axis,radialControls:seed.radialControls,
        shape:'terrain-feature-valley-v1',coreRadiusM:basinOptions.radiusM*.12,bankReachM:basinOptions.bankReachM,
        levelM:contract.levelM,depthM:basinOptions.depthM,rimM:basinOptions.rimM,lowerM:contract.lowerM,
        cell:seed.cell,centreCutM:0};
    const parameters=new Float32Array([...seed.centre,options.halfLengthM,...seed.axis,options.halfWidthM,
        anchorM,contract.depressionM,options.detailLimitM,options.microLimitM,...seed.hills,
        basin.radiusM,basin.levelM,contract.lowerM,contract.featureLowerM,precipitation,wet?1:0,0,0]);
    // These are terrain recipe hints, not a routed river or a claim that the
    // exterior already drains downhill. Connections can cut a canyon and
    // retain an elevation profile for the later shallow-water representation.
    const drainage={sourceLevelM:basin.levelM,preferredExitDirection:seed.axis.map(v=>-v),
        higherGround:[{alongM:seed.hills[2]*options.halfLengthM,acrossM:.6*options.halfWidthM,addedReliefM:seed.hills[0]},
            {alongM:seed.hills[3]*options.halfLengthM,acrossM:-.6*options.halfWidthM,addedReliefM:seed.hills[1]},
            {alongM:.62*options.halfLengthM,acrossM:.05*options.halfWidthM,addedReliefM:.4*(seed.hills[0]+seed.hills[1])}],
        allowsCanyonCut:true};
    return {basin,parameters,wet,anchorM,precipitation,existingLowerM,contract,seed,drainage,
        representation:'bounded-valley-recipe-v1',
        timings:{totalMs:performance.now()-started,compileMs,sampleMs,featureSites:1,terrainSearchSamples:0,
            uploadBytes:uniformBytes.byteLength+16+parameters.byteLength,readbackBytes:16}};
}
