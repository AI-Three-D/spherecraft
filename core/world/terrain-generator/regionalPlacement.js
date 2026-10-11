import {faceUVToDir,dirToFaceUV} from '../hydrology/waterGraph.js';
import {tangentBasis,planeToDir} from '../hydrology/lakeRefine.js';

// Optional generation-owned placement survey on the same six coarse roots.
// Height/relief/slope samples rank morphology only; candidates still pass the
// continuous natural-final rim certificate. No generated height is replaced.
export async function createRegionalPlacementData({gen,data,options,basinOptions,certifier}) {
    const started=performance.now();
    const n=options.cells,R=gen.planetConfig.radius,sites=[];
    for(let face=0;face<6;face++) for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
        sites.push({face,x,y,centre:faceUVToDir(face,(x+.5)/n,(y+.5)/n),radiusM:0});
    }
    // Four floats per root sample: natural base height, positive relief
    // entering erosion, input landform slope, foundation height. Preserve the GPU
    // field for this generation; the CPU copy supports bounded selection.
    const survey=await certifier(sites,'placement',{retainOutput:true}),seeds=[];
    try {
        const selectionStarted=performance.now();
        for(let k=0;k<sites.length;k++) {
            const s=sites[k],h=survey.output[k*4],relief=survey.output[k*4+1],slope=survey.output[k*4+2];
            if(h<basinOptions.minLevelM||h>options.maxNaturalHeightM||s.x<2||s.y<2||s.x>=n-2||s.y>=n-2) continue;
            const ring=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]].map(([x,y])=>survey.output[(k+y*n+x)*4]-h);
            const opposing=Math.max(...ring.slice(0,4).map((v,i)=>Math.min(v,ring[i+4])));
            const rises=ring.filter(v=>v>75).length;
            if(opposing<options.minimumRiseM||rises<3) continue;
            seeds.push({...s,h,relief,slope,opposing,rises,score:opposing/(1+relief/15+slope*4)});
        }
        seeds.sort((a,b)=>b.score-a.score||a.h-b.h);
        const selected=[];
        for(const s of seeds) {
            if(selected.some(t=>R*Math.hypot(...s.centre.map((v,i)=>v-t.centre[i]))<2500)) continue;
            selected.push(s);
            if(selected.length===options.regions) break;
        }
        const coarseSelectionMs=performance.now()-selectionStarted;
        const m=options.patchCells,spacing=options.spacingM,half=(m-1)/2,contexts=[];
        selected.forEach(s=>{
            const frame={c:s.centre,...tangentBasis(s.centre)};
            for(let y=0;y<m;y++) for(let x=0;x<m;x++) {
                contexts.push({centre:planeToDir((x-half)*spacing,(y-half)*spacing,frame,R),radiusM:0});
            }
        });
        const context=contexts.length?await certifier(contexts,'placement'):{output:new Float32Array(),wallMs:0,uploadBytes:0},proposals=[];
        const proposalStarted=performance.now();
        selected.forEach((s,k)=>{
            for(let y=4;y<m-4;y++) for(let x=4;x<m-4;x++) {
                const idx=k*m*m+y*m+x,h=context.output[idx*4];
                if(h<basinOptions.minLevelM||h>options.maxNaturalHeightM) continue;
                const ring=[[4,0],[4,4],[0,4],[-4,4],[-4,0],[-4,-4],[0,-4],[4,-4]].map(([dx,dy])=>context.output[(k*m*m+(y+dy)*m+x+dx)*4]-h);
                const opposing=Math.max(...ring.slice(0,4).map((v,i)=>Math.min(v,ring[i+4]))),rises=ring.filter(v=>v>50).length;
                if(opposing<options.minimumRiseM||rises<3) continue;
                const relief=context.output[idx*4+1],slope=context.output[idx*4+2];
                proposals.push({parent:k,centre:contexts[idx].centre,naturalCentreM:h,reliefM:relief,slope,opposingRiseM:opposing,rises,ringRiseM:ring,score:opposing/(1+relief/8+slope*8)});
            }
        });
        proposals.sort((a,b)=>b.score-a.score||a.naturalCentreM-b.naturalCentreM);
        const final=[];
        for(const p of proposals) {
            if(final.filter(s=>s.parent===p.parent).length>=4) continue;
            if(final.some(s=>R*Math.hypot(...s.centre.map((v,i)=>v-p.centre[i]))<100)) continue;
            final.push(p);
            if(final.length===options.candidates) break;
        }
        const candidates=final.map(s=>{
            const {face,u,v}=dirToFaceUV(s.centre),cells=data.cells;
            return {...s,face,x:Math.floor(u*cells),y:Math.floor(v*cells),cell:face*cells*cells+Math.floor(v*cells)*cells+Math.floor(u*cells)};
        });
        return {cells:n,values:survey.output,buffer:survey.buffer,candidates,seeds:selected,proposals:proposals.length,
            byteLength:survey.output.byteLength,
            timings:{totalMs:performance.now()-started,surveyMs:survey.wallMs,coarseSelectionMs,contextMs:context.wallMs,
                proposalSelectionMs:performance.now()-proposalStarted,surveySamples:sites.length,contextSamples:contexts.length,
                uploadBytes:survey.uploadBytes+context.uploadBytes,readbackBytes:survey.output.byteLength+context.output.byteLength}};
    } catch(error) { survey.buffer.destroy();throw error; }
}
