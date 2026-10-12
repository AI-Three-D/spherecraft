/* global process */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {regionalDepression} from '../../core/world/terrain-generator/regionalDepression.js';
import {planRegionalShapeLake,sampleRegionalShape} from '../../core/world/terrain-generator/regionalShapeModel.js';
import {faceUVToDir,dirToFaceUV} from '../../core/world/hydrology/waterGraph.js';
import {tangentBasis,planeToDir} from '../../core/world/hydrology/lakeRefine.js';
import {writePNG} from '../../../terrain-lab/png.mjs';
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/organic-lake/potential-audit';
fs.mkdirSync(output,{recursive:true});
const input='tools/perf/structured-terrain-results/large-lakes/plain-region/shape-controls.f32';
const bytes=fs.readFileSync(input),original=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
const cells=256,face=1,depth=6,grid=2**depth,tileX=40,tileY=20,R=131072;
const frameDir=(x,y)=>faceUVToDir(face,(tileX+x/cells)/grid,(tileY+y/cells)/grid);
const radiusOfCells=(ids,core)=>{
    const c=frameDir(core%cells+.5,Math.floor(core/cells)+.5);let radius=0;
    for(const k of ids)for(const dx of [0,1])for(const dy of [0,1]){
        const d=frameDir(k%cells+dx,Math.floor(k/cells)+dy),dot=d.reduce((s,v,i)=>s+v*c[i],0);
        radius=Math.max(radius,R*Math.hypot(...d.map((v,i)=>v-c[i]*dot))/dot);
    }
    return radius+4;
};
const report={input,inputSha256:createHash('sha256').update(bytes).digest('hex'),cases:[],notes:[
    'CPU diagnostic on saved production natural controls. Timings include bounded proposal/proof work, exclude GPU bake, roots, fine outputs, water publication and rendering.',
    'Images show actual interpolated height/water intersection; they are diagnostics, not game visual acceptance.',
]};
for(const profile of ['lobes','organic']){
    const controls=original.slice(),start=performance.now();
    const feature=regionalDepression({controls,cells,frameDir,tangentBasis,planeToDir,dirToFaceUV,
        face,grid,tileX,tileY,planetRadius:R,radiusM:450,maxCutM:8,depthM:2.5,seed:17,profile});
    const plan=planRegionalShapeLake({controls,cells,guardCells:10,minLevelM:100,maxRadiusM:1000,
        maxCandidates:4,maxPotentialCells:8192,minWetCells:256,radiusOfCells,
        candidateSeeds:feature.rejected?[]:[feature.seedCell],levelsM:feature.rejected?[]:[feature.levelM]});
    const wallMs=performance.now()-start;
    fs.writeFileSync(`${output}/${profile}-controls.f32`,new Uint8Array(controls.buffer));
    fs.writeFileSync(`${output}/${profile}-plan.json`,JSON.stringify({feature,plan},null,2));
    const W=768,rgb=new Uint8Array(W*W*3),c=feature.centre??frameDir(cells*.3,cells*.3),frame={c,...tangentBasis(c)};
    let wet=0,edges=0;const mask=new Uint8Array(W*W),span=1600;
    for(let j=0;j<W;j++)for(let i=0;i<W;i++){
        const p=dirToFaceUV(planeToDir((i+.5)/W*span-span/2,(j+.5)/W*span-span/2,frame,R));
        const x=(p.u*grid-tileX)*cells,y=(p.v*grid-tileY)*cells,k=j*W+i;
        const owned=plan.region?.[Math.floor(y)*cells+Math.floor(x)]??0;
        const h=sampleRegionalShape(controls,cells,x,y),isWet=owned&&h<plan.levelM;
        if(isWet){wet++;mask[k]=1;rgb.set([47,131,139],k*3);}else{
            const shade=Math.max(30,Math.min(180,80+(h-(plan.levelM??580))*6));rgb.set([shade*.7,shade,shade*.55],k*3);
        }
    }
    for(let j=1;j<W-1;j++)for(let i=1;i<W-1;i++){
        const k=j*W+i;if(mask[k]!==mask[k+1])edges++;if(mask[k]!==mask[k+W])edges++;
    }
    writePNG(`${output}/${profile}.png`,W,W,rgb);
    report.cases.push({profile,feature,proof:plan.proof,rejected:plan.rejected,attempts:plan.attempts,wallMs,
        sampledAreaM2:wet*(span/W)**2,gridPerimeterM:edges*span/W,minimumControlM:Math.min(...controls),
        controlsSha256:createHash('sha256').update(controls).digest('hex')});
}
fs.writeFileSync(`${output}/audit.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report.cases.map(({profile,feature,proof,rejected,wallMs,sampledAreaM2,gridPerimeterM})=>
    ({profile,feature,proof,rejected,wallMs,sampledAreaM2,gridPerimeterM})),null,2));
