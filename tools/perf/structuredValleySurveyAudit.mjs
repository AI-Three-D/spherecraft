/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const started=performance.now(),{device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const {createRegionalBasinCertifier,regionalRimCapRadius}=await imp('core/world/terrain-generator/regionalBasins.js');
const {faceUVToDir,dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const {tangentBasis,planeToDir}=await imp('core/world/hydrology/lakeRefine.js');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const output='tools/perf/structured-terrain-results/basin-valleys';fs.mkdirSync(output,{recursive:true});
const regional=await gen.prepareRegionalTerrain({cells:256,seamCells:4});
gen._fillTerrainUniformScratch(0,0,128,1,0);const uniformBytes=gen._terrainUniformScratch.slice(0);
const certify=await createRegionalBasinCertifier({device,gen,data:regional,uniformBytes,withHeights:true,withPlacement:true,slopeAware:!process.argv.includes('--original-bounds')});
const n=64,R=planetConfig.radius,sites=[];
for(let face=0;face<6;face++) for(let y=0;y<n;y++) for(let x=0;x<n;x++) sites.push({face,x,y,centre:faceUVToDir(face,(x+.5)/n,(y+.5)/n),radiusM:0});
const survey=await certify(sites,'placement'),seeds=[];
for(let k=0;k<sites.length;k++) {
 const s=sites[k],h=survey.output[k*4],relief=survey.output[k*4+1],slope=survey.output[k*4+2];
 if(h<900||h>2000||s.x<2||s.y<2||s.x>=n-2||s.y>=n-2) continue;
 const ring=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]].map(([x,y])=>survey.output[(k+y*n+x)*4]-h);
 const opposing=Math.max(...ring.slice(0,4).map((v,i)=>Math.min(v,ring[i+4])));
 const rises=ring.filter(v=>v>75).length;
 if(opposing<50||rises<3) continue;
 seeds.push({...s,h,relief,slope,opposing,rises,score:opposing/(1+relief/15+slope*4)});
}
seeds.sort((a,b)=>b.score-a.score||a.h-b.h);
const selected=[];
for(const s of seeds) {if(selected.some(t=>R*Math.hypot(...s.centre.map((v,i)=>v-t.centre[i]))<2500)) continue;selected.push(s);if(selected.length===24) break;}
const m=17,spacing=150,contexts=[];
selected.forEach(s=>{const frame={c:s.centre,...tangentBasis(s.centre)};for(let y=0;y<m;y++) for(let x=0;x<m;x++) contexts.push({centre:planeToDir((x-8)*spacing,(y-8)*spacing,frame,R),radiusM:0});});
const context=await certify(contexts,'placement'),proposals=[];
selected.forEach((s,k)=>{
 for(let y=4;y<m-4;y++) for(let x=4;x<m-4;x++) {
  const idx=k*m*m+y*m+x,h=context.output[idx*4];if(h<900||h>2000) continue;
  const ring=[[4,0],[4,4],[0,4],[-4,4],[-4,0],[-4,-4],[0,-4],[4,-4]].map(([dx,dy])=>context.output[(k*m*m+(y+dy)*m+x+dx)*4]-h);
  const opposing=Math.max(...ring.slice(0,4).map((v,i)=>Math.min(v,ring[i+4]))),rises=ring.filter(v=>v>50).length;
  if(opposing<50||rises<3) continue;
  const relief=context.output[idx*4+1],slope=context.output[idx*4+2];
  proposals.push({parent:k,centre:contexts[idx].centre,naturalCentreM:h,reliefM:relief,slope,opposingRiseM:opposing,rises,ringRiseM:ring,score:opposing/(1+relief/8+slope*8)});
 }
});
proposals.sort((a,b)=>b.score-a.score||a.naturalCentreM-b.naturalCentreM);
const final=[];for(const p of proposals) {
 if(final.filter(s=>s.parent===p.parent).length>=4) continue;
 if(final.some(s=>R*Math.hypot(...s.centre.map((v,i)=>v-p.centre[i]))<100)) continue;
 final.push(p);if(final.length===64) break;
}
const cases=[];
for(const radiusM of [60,45,30]) {
 const capRadiusM=regionalRimCapRadius(radiusM,64,true),caps=[];
 for(const s of final) {
  const frame={c:s.centre,...tangentBasis(s.centre)};
  for(let a=0;a<64;a++) caps.push({centre:planeToDir(Math.cos(a*Math.PI/32)*radiusM,Math.sin(a*Math.PI/32)*radiusM,frame,R),radiusM:capRadiusM});
 }
 const certificates=await certify(caps);
 cases.push({radiusM,capRadiusM,certificateMs:certificates.wallMs,sites:final.map((s,k)=>{
  const lowerM=Math.min(...Array.from({length:64},(_,j)=>certificates.output[(k*64+j)*4]));
  const levelM=lowerM-1.5,cutM=s.naturalCentreM-(levelM-3);
  const {face,u,v}=dirToFaceUV(s.centre);return {...s,face,cell:face*256*256+Math.floor(v*256)*256+Math.floor(u*256),lowerM,levelM,cutM,eligible:levelM>=900&&cutM<=16};
 })});
}
const report={completeAuditMs:performance.now()-started,roots:regional.timings,compileMs:certify.compileMs,surveyMs:survey.wallMs,surveySamples:sites.length,
 contextMs:context.wallMs,contextSamples:contexts.length,seeds:seeds.length,selected,proposals:proposals.length,cases,gpuErrors:errors};
fs.writeFileSync(`${output}/${process.argv.includes('--original-bounds')?'survey-original-bounds':'survey-tight-caps'}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({completeAuditMs:report.completeAuditMs,compileMs:report.compileMs,surveyMs:report.surveyMs,contextMs:report.contextMs,seeds:seeds.length,proposals:proposals.length,
 cases:cases.map(c=>({radiusM:c.radiusM,eligible:c.sites.filter(s=>s.eligible),best:c.sites.toSorted((a,b)=>a.cutM-b.cutM).slice(0,3)})),gpuErrors:errors},null,2));
process.exit(errors.length?1:0);
