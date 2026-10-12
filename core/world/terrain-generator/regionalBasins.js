import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { faceUVToDir } from '../hydrology/waterGraph.js';
import { tangentBasis } from '../hydrology/lakeRefine.js';
import { createRegionalBasinCertificateWgsl, createRegionalRouteHeightWgsl, createRegionalPlacementSurveyWgsl } from './regionalBasins.wgsl.js';
import {regionalComputePipelines} from './regionalPipelines.js';
import {readRegionalField} from './regionalFieldReadback.js';

// Every annulus point is at most pi/n from its nearest contour node. The
// outer radius is the worst case. Normalizing the gnomonic plane is 1/R
// Lipschitz, so this planar distance also encloses the spherical chord.
export function regionalRimCapRadius(radiusM, segments, tight = false) {
    const angular=Math.sin(Math.PI/(2*segments));
    return tight?Math.ceil(Math.sqrt(36+4*radiusM*(radiusM+6)*angular*angular)*1.001)
        :Math.ceil(2*(radiusM+6)*angular*1.001+6);
}

export async function createRegionalBasinCertifier({device,gen,data,uniformBytes,withHeights=false,slopeAware=false,withPlacement=false,routeHeightSource='natural'}) {
    const compileStarted = performance.now();
    const shape=!!data.shapeData;
    const code = createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({regionalTerrain:true,regionalShape:shape,waterCarve:false,riverValley:false}))
        + createRegionalBasinCertificateWgsl(gen.erosionFilter,data.budgets,{slopeAware}) + (withHeights ? createRegionalRouteHeightWgsl({source:routeHeightSource,shape}) : '')+(withPlacement?createRegionalPlacementSurveyWgsl():'');
    const entries=['basinCertificateMain',...(withHeights?['regionalRouteHeightMain']:[]),...(withPlacement?['regionalPlacementSurveyMain']:[])];
    const {pipelines,cacheHit}=await regionalComputePipelines(device,code,entries,{reuse:gen._regionalCertificateReuse!==false});
    const pipeline=pipelines[0],heightPipeline=withHeights?pipelines[1]:null;
    const placementPipeline=withPlacement?pipelines[withHeights?2:1]:null;
    const compileMs = performance.now()-compileStarted;
    const certify = async (sites, heightsOnly = false, {retainOutput=false} = {}) => {
    const activePipeline = heightsOnly==='placement'?placementPipeline:heightsOnly?heightPipeline:pipeline;
    const inputs = new Float32Array(sites.length*4);
    sites.forEach((c,i)=>inputs.set([...c.centre,c.radiusM],i*4));
    const ub = device.createBuffer({size:uniformBytes.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const ib = device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    const ob = device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const rb = device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    let completed=false;
    try {
    device.queue.writeBuffer(ub,0,uniformBytes); device.queue.writeBuffer(ib,0,inputs);
    const dispatchStarted = performance.now(), encoder = device.createCommandEncoder({label:'Regional basin certificates'});
    const pass=encoder.beginComputePass({label:heightsOnly==='placement'?'Regional placement survey':heightsOnly?'Regional route heights':'Basin certificates'});
    pass.setPipeline(activePipeline);
    pass.setBindGroup(0,device.createBindGroup({layout:activePipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:ub}},{binding:6,resource:{buffer:ib}},{binding:7,resource:{buffer:ob}},
    ]}));
    pass.setBindGroup(1,device.createBindGroup({layout:activePipeline.getBindGroupLayout(1),entries:[]}));
    pass.setBindGroup(2,device.createBindGroup({layout:activePipeline.getBindGroupLayout(2),entries:data.bindGroupEntries.filter(e=>e.binding<3||(shape&&e.binding>=4))}));
    pass.dispatchWorkgroups(heightsOnly?Math.ceil(sites.length/64):sites.length); pass.end();
    encoder.copyBufferToBuffer(ob,0,rb,0,inputs.byteLength); device.queue.submit([encoder.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const output = new Float32Array(rb.getMappedRange()).slice(); rb.unmap();
    const wallMs = performance.now()-dispatchStarted;
    completed=true;
    return {output,wallMs,uploadBytes:uniformBytes.byteLength+inputs.byteLength,...(retainOutput?{buffer:ob}:{})};
    } finally {
        if(rb.mapState==='mapped') rb.unmap();
        for(const buffer of [ub,ib,...(retainOutput&&completed?[]:[ob]),rb]) buffer.destroy();
    }
    };
    certify.compileMs=compileMs;
    certify.cacheHit=cacheHit;
    return certify;
}

// A deliberately small first planner. Candidates and their certificates belong
// to this generation version; fine terrain and water publish the same records.
export async function planRegionalBasins({ device, gen, data, uniformBytes, options, search = null, certifier = null, tightRimCaps = false, candidateSites = null }) {
    const started = performance.now(), { cells,size } = data;
    if(search) {
        const {x,y,extent}=search;
        if(x-extent<4||y-extent<4||x+extent>=cells-4||y+extent>=cells-4) throw new Error('Local basin search crosses the regional seam guard');
    }
    // The receiver needs its existing candidate window and the same 4x4
    // control halo. Global selection still reads all six faces. The diagnostic
    // flag reproduces the full read without changing any terrain/source keys.
    const window=search&&gen._regionalFullReadback!==true?{
        x:search.x-search.extent,y:search.y-search.extent,width:search.extent*2+1,face:search.face,
    }:null;
    const readStarted = performance.now();
    const empty={values:new Float32Array(),copyBytes:0};
    const lowerRead=candidateSites?empty:await readRegionalField(device,data.lowerBounds,window?
        {width:window.width,channels:1,layers:1,origin:[window.x,window.y,window.face]}:{width:cells,channels:1});
    const controlRead=candidateSites?empty:await readRegionalField(device,data.fields[1],window?
        {width:window.width+3,channels:4,layers:1,origin:[window.x,window.y,window.face]}:{width:size,channels:4});
    const lower=lowerRead.values,b=controlRead.values;
    const readbackCopyBytes=lowerRead.copyBytes+controlRead.copyBytes;
    const readbackMs = performance.now()-readStarted;
    const possible=[];
    const addCandidate=cell=>{
        const height=window?lower[(Math.floor(cell/cells)%cells-window.y)*window.width+cell%cells-window.x]:lower[cell];
        if(!(height>options.candidateMinM)) return;
        const face=Math.floor(cell/(cells*cells)),x=cell%cells,y=Math.floor(cell/cells)%cells;
        if(data.shapeData?.ownsDirection?.(faceUVToDir(face,(x+.5)/cells,(y+.5)/cells),options.radiusM+6))return;
        if(data.occupiedBasins) {
            const centre=faceUVToDir(face,(x+.5)/cells,(y+.5)/cells);
            if(data.occupiedBasins.some(b=>gen.planetConfig.radius*Math.hypot(...centre.map((v,k)=>v-b.centre[k]))<Math.max(1000,b.radiusM+options.radiusM+128)))return;
        }
        const stride=window?window.width+3:size,offset=window?((y-window.y)*stride+x-window.x)*4+3:(face*size*size+y*size+x)*4+3;
        for(let j=0;j<4;j++) for(let i=0;i<4;i++) if(b[offset+(j*stride+i)*4]>options.maxRoughness) return;
        possible.push({height,cell});
    };
    if(search) {
        // A local recipient search uses the same regional cells/certificates.
        // The first prototype stays on one face; reject seam-crossing windows
        // rather than silently changing ownership or wrapping addresses.
        const {face,x,y,extent}=search;
        for(let j=y-extent;j<=y+extent;j++) for(let i=x-extent;i<=x+extent;i++) {
            const cell=face*cells*cells+j*cells+i,centre=faceUVToDir(face,(i+.5)/cells,(j+.5)/cells);
            const distance=gen.planetConfig.radius*Math.hypot(...centre.map((v,k)=>v-search.centre[k]));
            if(distance>=search.minDistanceM&&distance<=search.maxDistanceM) addCandidate(cell);
        }
    } else {
        for(let cell=0;cell<lower.length;cell++) addCandidate(cell);
    }
    possible.sort((a,b)=>b.height-a.height||a.cell-b.cell);
    const candidates = candidateSites?[...candidateSites]:[];
    // Spread the finite batch across the available elevation range instead of
    // spending every certificate on the highest plateau. Fine natural heights
    // rank excavation only; they never stand in for a containment guarantee.
    for(let k=0;!candidateSites&&k<possible.length;k++) {
        const strata=Math.min(options.candidates,possible.length);
        const stratum=k%strata,offset=Math.floor(k/strata);
        const index=Math.floor((stratum+.5)*possible.length/strata)+offset;
        if(index>=possible.length) continue;
        const r=possible[index];
        const face=Math.floor(r.cell/(cells*cells)),x=r.cell%cells,y=Math.floor(r.cell/cells)%cells;
        if(candidates.some(c=>c.face===face&&Math.hypot(c.x-x,c.y-y)<(search?1:8))) continue;
        candidates.push({...r,face,x,y,centre:faceUVToDir(face,(x+.5)/cells,(y+.5)/cells)});
        if(candidates.length===options.candidates) break;
    }
    const selectionMs = performance.now()-readStarted-readbackMs;
    if(!candidates.length) return { basins:[],timings:{readbackMs,readbackCopyBytes,readbackWindow:window,readbackBytes:lower.byteLength+b.byteLength,selectionMs,totalMs:performance.now()-started},candidates:[] };
    const certify = certifier ?? await createRegionalBasinCertifier({device,gen,data,uniformBytes});
    const compileMs = certifier ? 0 : certify.compileMs;
    const broad=await certify(candidates.map(c=>({...c,radiusM:options.radiusM})));
    const inspected = candidates.map((c,i)=>({ ...c, lowerM:broad.output[i*4],naturalCentreM:broad.output[i*4+1],
        reliefErosionLowerM:broad.output[i*4+2],mesoAllowanceM:broad.output[i*4+3],
        centreCutM:broad.output[i*4+1]-(broad.output[i*4]-options.rimM-options.depthM) }));
    // Give the requested water-elevation range its own shortlist. Otherwise
    // inexpensive lowland sites consume all rim certificates in an upland
    // request. A broad-certificate deficit is only a ranking preference;
    // the final continuous rim certificate still decides eligibility.
    const levelDeficit=c=>Math.max(0,options.minLevelM+options.rimM-c.lowerM);
    const shortlist=inspected.filter(c=>c.lowerM>-1e10)
        .sort((a,b)=>levelDeficit(a)-levelDeficit(b)||a.centreCutM-b.centreCutM||a.cell-b.cell).slice(0,options.rimCandidates);
    if(!shortlist.length) return {basins:[],candidates:inspected,timings:{readbackMs,readbackCopyBytes,readbackWindow:window,selectionMs,compileMs,
        uploadBytes:broad.uploadBytes,certificatesMs:broad.wallMs,totalMs:performance.now()-started,readbackBytes:lower.byteLength+b.byteLength+broad.output.byteLength}};
    // Certify a continuous enclosing contour with overlapping caps. At every
    // angle the nearest centre is <=2*r*sin(pi/(2*n)) away. The 6m band and
    // curvature margin cover the outer annulus too. These are interval bounds
    // over caps, never sampled rim heights. Wet interiors can be below them.
    const capRadiusM=tightRimCaps?regionalRimCapRadius(options.radiusM,options.rimSegments,true)
        :Math.ceil(2*(options.radiusM+6)*Math.sin(Math.PI/(2*options.rimSegments))*1.001+6);
    const rimSites=[];
    const radius=gen.planetConfig.radius;
    for(const c of shortlist) {
        const {e1,e2}=tangentBasis(c.centre);
        for(let j=0;j<options.rimSegments;j++) {
            const angle=j*2*Math.PI/options.rimSegments;
            const p=c.centre.map((v,k)=>v+(e1[k]*Math.cos(angle)+e2[k]*Math.sin(angle))*options.radiusM/radius);
            const length=Math.hypot(...p);
            rimSites.push({centre:p.map(v=>v/length),radiusM:capRadiusM});
        }
    }
    const rim=await certify(rimSites);
    const rimInspected=shortlist.map((c,i)=>{
        const lowerM=Math.min(...Array.from({length:options.rimSegments},(_,j)=>rim.output[(i*options.rimSegments+j)*4]));
        return {...c,footprintLowerM:c.lowerM,lowerM,centreCutM:c.naturalCentreM-(lowerM-options.rimM-options.depthM)};
    });
    const selected = rimInspected.filter(c=>c.lowerM-options.rimM>=options.minLevelM&&c.centreCutM<=options.maxCentreCutM
        && (!search || c.lowerM-options.rimM<=search.maxLevelM))
        .sort((a,b)=>a.centreCutM-b.centreCutM||a.cell-b.cell).slice(0,1);
    const basins = selected.map((c,id)=>{
        const index=shortlist.findIndex(s=>s.centre===c.centre),n=options.rimSegments;
        // Fit the major direction to the lowest opposing terrain samples.
        // This guides shape only; the interval certificates determine level.
        let best=Infinity,angle=0;
        for(let j=0;j<n/2;j++) {
            const a=rim.output[(index*n+j)*4+1],b=rim.output[(index*n+j+n/2)*4+1];
            if(a+b<best) {best=a+b;angle=(j+(a>b?n/2:0))*2*Math.PI/n;}
        }
        const {e1,e2}=tangentBasis(c.centre),axis=e1.map((v,k)=>v*Math.cos(angle)+e2[k]*Math.sin(angle));
        const axisIndex=Math.round(angle*n/(2*Math.PI)),samplesPerNode=n/16;
        const heights=Array.from({length:16},(_,j)=>{
            let sum=0;
            for(let k=0;k<samplesPerNode;k++) sum+=rim.output[(index*n+(axisIndex+j*samplesPerNode+k)%n)*4+1];
            return sum/samplesPerNode;
        });
        const mean=heights.reduce((s,h)=>s+h,0)/16;
        const cosine=heights.reduce((s,h,j)=>s+(h-mean)*Math.cos(j*Math.PI/8),0)/8;
        const sine=heights.reduce((s,h,j)=>s+(h-mean)*Math.sin(j*Math.PI/8),0)/8;
        // Remove the plane trend for shoreline bends; retain it separately
        // for bank width. These samples fit geometry, never the guarantee.
        const residuals=heights.map((h,j)=>h-mean-cosine*Math.cos(j*Math.PI/8)-sine*Math.sin(j*Math.PI/8));
        const residualScale=Math.max(.05,...residuals.map(Math.abs));
        const heightScale=Math.max(.5,...heights.map(h=>Math.abs(h-mean)));
        const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
        // Stable broad bank patches belong to the basin record, independent
        // of camera, LOD and generation order. Only extend the outer reach;
        // the wet-core cap, start radii and certified contour are unchanged.
        let bankSeed=(gen.seed^Math.imul(c.cell+1,0x9e3779b1))>>>0;
        const random=()=>{
            bankSeed=(Math.imul(bankSeed,1664525)+1013904223)>>>0;
            return bankSeed/4294967296;
        };
        const phase=random()*16,halfWidth=2+random();
        const secondPhase=(phase+6+random()*4)%16,secondWidth=1.5+random(),secondGain=.45+.35*random();
        const patchWeight=(node,centre,width)=>{
            const separation=Math.abs(node-centre),distance=Math.min(separation,16-separation);
            if(distance>=width) return 0;
            return (1-distance*distance/(width*width))**3;
        };
        const radialControls=residuals.map((r,j)=>{
            const residual=r/residualScale,low=(mean-heights[j])/heightScale;
            const start=clamp(.40-.20*residual+.06*low,.20,.56);
            const extension=Math.max(patchWeight(j,phase,halfWidth),secondGain*patchWeight(j,secondPhase,secondWidth))
                *options.bankReachM/options.radiusM;
            const terrainOuter=clamp(start+Math.max(.26,.36+.16*low+.10*residual),.68,.96);
            const outer=Math.min(.96,terrainOuter+extension);
            return [start,outer];
        });
        return {id,centre:c.centre,radiusM:options.radiusM,axis,radialControls,
            ...(c.opposingRiseM!==undefined?{context:{opposingRiseM:c.opposingRiseM,rises:c.rises,ringRiseM:c.ringRiseM,reliefM:c.reliefM,slope:c.slope}}:{}),
            shape:'terrain-depression-v1',coreRadiusM:options.radiusM*0.12,bankReachM:options.bankReachM,
            levelM:c.lowerM-options.rimM,depthM:options.depthM,rimM:options.rimM,lowerM:c.lowerM,cell:c.cell,centreCutM:c.centreCutM};
    });
    return {basins,candidates:inspected,rimCandidates:rimInspected,certificate:{rimSegments:options.rimSegments,capRadiusM,
        guaranteedAnnulusM:[options.radiusM,options.radiusM+6]},
        timings:{readbackMs,readbackCopyBytes,readbackWindow:window,selectionMs,compileMs,certificatesMs:broad.wallMs+rim.wallMs,
        broadCertificatesMs:broad.wallMs,rimCertificatesMs:rim.wallMs,totalMs:performance.now()-started,
        uploadBytes:broad.uploadBytes+rim.uploadBytes,readbackBytes:lower.byteLength+b.byteLength+broad.output.byteLength+rim.output.byteLength}};
}
