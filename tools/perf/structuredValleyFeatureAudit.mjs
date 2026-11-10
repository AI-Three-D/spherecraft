/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
import {VALLEY_FEATURE_CASE} from './structuredBasinCases.mjs';

const {device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const opts={cells:256,seamCells:4,basins:{enabled:true,...VALLEY_FEATURE_CASE},valley:{enabled:true}};
const roots=await gen.prepareRegionalTerrain(opts),feature=roots.valleyFeature;
const c=feature.seed.centre,e1=feature.seed.axis;
const e2=[c[1]*e1[2]-c[2]*e1[1],c[2]*e1[0]-c[0]*e1[2],c[0]*e1[1]-c[1]*e1[0]];
const R=planetConfig.radius,frame={c,e1,e2,x0:-805,y0:-805,spacing:10,nx:161,ny:161};
const sampler=await createHydrologySampler({device,terrainGenerator:gen});
const params=roots.bindGroupEntries.find(e=>e.binding===2).resource.buffer;
device.queue.writeBuffer(params,0,new Float32Array([256,4,0,0]));
const original=await sampler.samplePatch(frame,R);
device.queue.writeBuffer(params,0,new Float32Array([256,4,0,1]));
const dry=await sampler.samplePatch(frame,R);
device.queue.writeBuffer(params,0,new Float32Array([256,4,1,1]));
const wet=await sampler.samplePatch(frame,R);
// Copy one root's bound field for validation only. Production feature creation
// reads 16 bytes; this audit readback is excluded from generation costs.
const face=dirToFaceUV(c).face,row=256*4;
const rb=device.createBuffer({size:row*256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const encoder=device.createCommandEncoder();
encoder.copyTextureToBuffer({texture:roots.lowerBounds,origin:[0,0,face]},{buffer:rb,bytesPerRow:row},[256,256]);
device.queue.submit([encoder.finish()]);await rb.mapAsync(GPUMapMode.READ);
const bounds=new Float32Array(rb.getMappedRange()).slice();rb.unmap();rb.destroy();
let outsideSamples=0,outsideUnequal=0,outsideMaxDifferenceM=0,boundFailures=0,minimumBoundClearanceM=Infinity;
let minimumFeatureHeightM=Infinity,maximumFeatureHeightM=-Infinity,maximumLoweringM=0,maximumLiftingM=0,dryWetBaseUnequal=0;
for(let j=0;j<161;j++) for(let i=0;i<161;i++) {
    const k=j*161+i,x=frame.x0+(i+.5)*10,y=frame.y0+(j+.5)*10;
    const q2=(x/roots.valleyConfig.halfLengthM)**2+(y/roots.valleyConfig.halfWidthM)**2;
    if(q2>=1) {
        outsideSamples++;if(original[k]!==dry[k]) outsideUnequal++;
        outsideMaxDifferenceM=Math.max(outsideMaxDifferenceM,Math.abs(dry[k]-original[k]));
    } else {
        minimumFeatureHeightM=Math.min(minimumFeatureHeightM,dry[k]);maximumFeatureHeightM=Math.max(maximumFeatureHeightM,dry[k]);
        maximumLoweringM=Math.max(maximumLoweringM,original[k]-dry[k]);maximumLiftingM=Math.max(maximumLiftingM,dry[k]-original[k]);
    }
    const p=c.map((v,a)=>v+e1[a]*x/R+e2[a]*y/R),length=Math.hypot(...p),d=p.map(v=>v/length);
    const uv=dirToFaceUV(d),lower=bounds[Math.floor(uv.v*256)*256+Math.floor(uv.u*256)];
    // Root certificate includes the global material-micro budget. Sampling is
    // base-only, so subtract that budget for this conservative cross-check.
    const clearance=dry[k]-roots.budgets.microM-lower;
    minimumBoundClearanceM=Math.min(minimumBoundClearanceM,clearance);if(clearance<0) boundFailures++;
    if(dry[k]!==wet[k]) dryWetBaseUnequal++;
}
// A dry climate changes water activation, not the seeded terrain recipe.
const dryClimate=await gen.prepareRegionalTerrain({...opts,valley:{enabled:true,minPrecipitation:1}},{regenerate:true});
sampler.destroy();
const climateSampler=await createHydrologySampler({device,terrainGenerator:gen});
const climateDry=await climateSampler.samplePatch(frame,R);
let climateGeometryUnequal=0;for(let k=0;k<dry.length;k++) if(climateDry[k]!==dry[k]) climateGeometryUnequal++;
const report={samples:dry.length,outsideSamples,outsideUnequal,outsideMaxDifferenceM,boundFailures,minimumBoundClearanceM,
    minimumFeatureHeightM,maximumFeatureHeightM,maximumLoweringM,maximumLiftingM,dryWetBaseUnequal,
    climate:{precipitation:dryClimate.valleyFeature.precipitation,wet:dryClimate.valleyFeature.wet,
        publishedBasins:dryClimate.basins.length,geometryUnequal:climateGeometryUnequal},drainage:feature.drainage,gpuErrors:errors,
    notes:['Base-height audit includes the original erosion/detail result. Final micro is checked by the complete production-tile benchmark.',
        'One root bound readback is diagnostic only; production feature creation reads back 16 bytes.',
        'Raised hills are intentional within the new optional feature support. Exterior equality uses exactly the same regional controls.',
        'Exit and higher-ground records are hints; no alpine river or waterfall is generated yet.']};
fs.writeFileSync('tools/perf/structured-terrain-results/valley-feature/feature-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));climateSampler.destroy();
process.exit(outsideUnequal||boundFailures||dryWetBaseUnequal||climateGeometryUnequal||dryClimate.basins.length||errors.length?1:0);
