/* global process */
// Read-only architecture experiment on captured generation inputs. No terrain
// mutation, extra GPU probes, lake search expansion or production route changes.
import fs from 'node:fs';
import {regionalShapeBounds} from '../../core/world/terrain-generator/regionalShapeModel.js';
import {MinHeap,faceUVToDir} from '../../core/world/hydrology/waterGraph.js';
const input=process.env.SHAPE_INPUT??'tools/perf/structured-terrain-results/natural-context/threshold-30';
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/natural-outlets';
fs.mkdirSync(output,{recursive:true});
const cases=[],wholeStarted=performance.now(),R=131072,step=2,guard=10,minimumDropM=20;
for(const name of ['0-102-114','2-10-9','4-88-97','3-108-69']) {
    const caseStarted=performance.now(),saved=JSON.parse(fs.readFileSync(`${input}/${name}.json`)),o=saved.options,plan=saved.plan;
    const bytes=fs.readFileSync(`${input}/${name}.f32`),controls=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
    const boundsStarted=performance.now(),bounds=regionalShapeBounds(controls,o.cells),boundsMs=performance.now()-boundsStarted;
    const n=Math.floor((o.cells-guard*2)/step),count=n*n,grid=2**o.depth;
    if(count>4096)throw new Error('Outlet audit exceeds the fixed 4096-node budget');
    const height=new Float64Array(count),upper=new Float64Array(count),lower=new Float64Array(count),directions=new Float64Array(count*3);
    for(let j=0;j<n;j++)for(let i=0;i<n;i++) {
        const x=guard+i*step,y=guard+j*step,k=j*n+i;
        const ids=[y*o.cells+x,y*o.cells+x+1,(y+1)*o.cells+x,(y+1)*o.cells+x+1];
        height[k]=ids.reduce((s,k)=>s+bounds.centre[k],0)/4;
        upper[k]=Math.max(...ids.map(k=>bounds.upper[k]));
        lower[k]=Math.min(...ids.map(k=>bounds.lower[k]));
        directions.set(faceUVToDir(o.face,(o.x+(x+1)/o.cells)/grid,(o.y+(y+1)/o.cells)/grid),k*3);
    }
    const source=Math.floor((Math.floor(plan.core/o.cells)-guard)/step)*n+Math.floor((plan.core%o.cells-guard)/step);
    const route=(support=upper)=>{
        let targets=0;
        for(let k=0;k<count;k++)if((k%n===0||k%n===n-1||k<n||k>=count-n)&&support[k]<plan.levelM-minimumDropM)targets++;
        if(!targets)return {path:[],visited:0,crestM:null,lengthM:null,scratchBytes:0,rejected:'no-lower-boundary'};
        const crest=new Float64Array(count).fill(Infinity),distance=new Float64Array(count).fill(Infinity),parents=new Int32Array(count).fill(-1),closed=new Uint8Array(count);
        const heap=new MinHeap(count*8);let visited=0,end=-1;
        crest[source]=support[source];distance[source]=0;heap.push(crest[source],source);
        while(heap.size) {
            const k=heap.pop();if(closed[k])continue;closed[k]=1;visited++;
            const x=k%n,y=Math.floor(k/n);
            if((x===0||y===0||x===n-1||y===n-1)&&support[k]<plan.levelM-minimumDropM) {end=k;break;}
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
                if(!dx&&!dy)continue;const i=x+dx,j=y+dy;if(i<0||j<0||i>=n||j>=n)continue;
                const next=j*n+i;if(closed[next])continue;
                const c=Math.max(crest[k],support[next]);
                const length=R*Math.hypot(...[0,1,2].map(a=>directions[k*3+a]-directions[next*3+a]));
                const d=distance[k]+length;
                if(c<crest[next]||(c===crest[next]&&d<distance[next])) {
                    crest[next]=c;distance[next]=d;parents[next]=k;heap.push(c,next);
                }
            }
        }
        const path=[];for(let k=end;k>=0;k=parents[k]){path.push(k);if(k===source)break;}path.reverse();
        return {path,visited,crestM:end>=0?crest[end]:null,lengthM:end>=0?distance[end]:null,
            scratchBytes:crest.byteLength+distance.byteLength+parents.byteLength+closed.byteLength+heap.keys.byteLength+heap.ids.byteLength};
    };
    const times=[],upperTimes=[],routeStarted=performance.now();let result,upperResult;
    for(let j=0;j<10;j++){const t=performance.now();upperResult=route();upperTimes.push(performance.now()-t);}
    for(let j=0;j<10;j++){const t=performance.now();result=route(lower);times.push(performance.now()-t);}
    const routeTenMs=performance.now()-routeStarted;
    let refinement=null;
    if(result.path.length) {
        const ids=new Set();
        for(const k of result.path) {
            const x=guard+(k%n)*step,y=guard+Math.floor(k/n)*step;
            for(let dy=-3;dy<=4;dy++)for(let dx=-3;dx<=4;dx++) {
                const i=x+dx,j=y+dy;if(i>=guard&&j>=guard&&i<o.cells-guard&&j<o.cells-guard)ids.add(j*o.cells+i);
            }
        }
        if(ids.size>4096)refinement={rejected:'corridor-node-budget',nodes:ids.size};
        else {
            const started=performance.now(),cells=[...ids].sort((a,b)=>a-b),index=new Int32Array(o.cells*o.cells).fill(-1),pos=new Float64Array(cells.length*3);
            cells.forEach((k,i)=>{
                index[k]=i;pos.set(faceUVToDir(o.face,(o.x+(k%o.cells+.5)/o.cells)/grid,
                    (o.y+(Math.floor(k/o.cells)+.5)/o.cells)/grid),i*3);
            });
            const refine=()=>{
                const crest=new Float64Array(cells.length).fill(Infinity),distance=new Float64Array(cells.length).fill(Infinity),parents=new Int32Array(cells.length).fill(-1),closed=new Uint8Array(cells.length);
                const heap=new MinHeap(cells.length*8),first=index[plan.core];let end=-1,visited=0;
                crest[first]=bounds.upper[plan.core];distance[first]=0;heap.push(crest[first],first);
                while(heap.size) {
                    const i=heap.pop();if(closed[i])continue;closed[i]=1;visited++;
                    const k=cells[i],x=k%o.cells,y=Math.floor(k/o.cells);
                    if((x===guard||y===guard||x===o.cells-guard-1||y===o.cells-guard-1)&&bounds.upper[k]<plan.levelM-minimumDropM){end=i;break;}
                    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
                        if(!dx&&!dy)continue;const q=(y+dy)*o.cells+x+dx,j=index[q];if(j<0||closed[j])continue;
                        const c=Math.max(crest[i],bounds.upper[q]),d=distance[i]+R*Math.hypot(...[0,1,2].map(a=>pos[i*3+a]-pos[j*3+a]));
                        if(c<crest[j]||(c===crest[j]&&d<distance[j])) {crest[j]=c;distance[j]=d;parents[j]=i;heap.push(c,j);}
                    }
                }
                const path=[];for(let j=end;j>=0;j=parents[j]){path.push(cells[j]);if(j===first)break;}path.reverse();
                return {path,visited,crestM:end>=0?crest[end]:null,lengthM:end>=0?distance[end]:null,
                    scratchBytes:crest.byteLength+distance.byteLength+parents.byteLength+closed.byteLength+heap.keys.byteLength+heap.ids.byteLength};
            };
            const samples=[];let fine;
            for(let i=0;i<10;i++){const t=performance.now();fine=refine();samples.push(performance.now()-t);}
            let eta=plan.levelM,previous=null,maxCut=0,maxGrade=0;
            const profile=fine.path.map(k=>{
                const old=eta;if(!plan.region[k])eta=Math.min(eta,bounds.centre[k]-.5);
                const i=index[k],j=previous===null?null:index[previous],d=j===null?0:R*Math.hypot(...[0,1,2].map(a=>pos[i*3+a]-pos[j*3+a]));
                maxCut=Math.max(maxCut,bounds.upper[k]+o.numericalM-(eta-1.5));if(d>0)maxGrade=Math.max(maxGrade,(old-eta)/d);
                previous=k;return {cell:k,x:k%o.cells,y:Math.floor(k/o.cells),heightM:bounds.centre[k],upperM:bounds.upper[k],levelM:eta};
            });
            refinement={nodes:cells.length,...fine,completeCpuRefinementMs:performance.now()-started,routeMs:samples,
                initialCrestAboveLakeM:fine.crestM===null?null:fine.crestM-plan.levelM,provisionalDescentM:plan.levelM-eta,
                maxProfileCutM:maxCut,maxSlope:maxGrade,profile,declaredScratchBytes:index.byteLength+pos.byteLength+fine.scratchBytes};
        }
    }
    let level=plan.levelM,maxProfileCutM=0,maxSlope=0,previous=null;
    const profile=result.path.map(k=>{
        const x=guard+(k%n)*step,y=guard+Math.floor(k/n)*step;
        const lake=plan.region[y*o.cells+x]||plan.region[y*o.cells+x+1]||plan.region[(y+1)*o.cells+x]||plan.region[(y+1)*o.cells+x+1];
        const old=level;if(!lake)level=Math.min(level,height[k]-.5);
        const distance=previous===null?0:R*Math.hypot(...[0,1,2].map(a=>directions[k*3+a]-directions[previous*3+a]));
        maxProfileCutM=Math.max(maxProfileCutM,upper[k]+o.numericalM-(level-1.5));
        if(distance>0)maxSlope=Math.max(maxSlope,(old-level)/distance);
        previous=k;return {cell:k,x,y,heightM:height[k],upperM:upper[k],levelM:level};
    });
    cases.push({name,control:name==='3-108-69',nodes:count,sourceLevelM:plan.levelM,radiusM:plan.radiusM,
        completeCpuAuditMs:performance.now()-caseStarted,boundsMs,routeTenMs,routeMs:times,
        ...result,upperResult,upperRouteMs:upperTimes,refinement,initialCrestAboveLakeM:result.crestM===null?null:result.crestM-plan.levelM,
        provisionalDescentM:profile.length?plan.levelM-profile.at(-1).levelM:null,maxProfileCutM,maxSlope,profile,
        declaredScratchBytes:bounds.lower.byteLength+bounds.upper.byteLength+bounds.centre.byteLength+height.byteLength+upper.byteLength+lower.byteLength+directions.byteLength+Math.max(result.scratchBytes,upperResult.scratchBytes)});
}
const report={wholeCpuAuditMs:performance.now()-wholeStarted,minimumDropM,step,guard,cases,notes:[
    'Diagnostic only, captured production eroded controls and previously accepted lake plans. Three independent positive cases plus the earlier control; no yield estimate.',
    'Coarse 2x2 cell lower/upper hulls guide minimum-crest paths within the full-weight interior; no seam crossing or global receiver search. The 2916-node budget is hard.',
    'Coarse upper maxima overestimate a narrow outlet and do not prove a global minimum. Lower hulls give an optimistic escape path; refine only its eight-cell-wide corridor with <=4096 original-cell nodes. Missing LOWER targets can reject the current domain; missing upper targets alone cannot. No expanded domain or extra height probes.',
    'Provisional descending profile follows a running minimum of natural block-average heights minus .5m outside the lake, with 1.5m bed depth. It is a deliberately simple cost diagnostic, not an accepted river solver.',
    'These values are not a continuous corridor or bank certificate: lateral river extent, diagonal corridor support, width variation, smoothing and water surface fit need validation before carving.',
    'CPU audit includes file IO, one hull build and TEN upper/TEN lower routes per case, plus TEN refinements where available. Recorded route timings do not include GPU shape generation, shared roots, failed lake candidates, terrain output, water publication or regeneration. Use the complete costs in the handoff; do not present this as per-river generation cost.',
    'Declared scratch covers typed arrays, excludes JS objects, JSON/profile output, allocator and process peak. No runtime terrain or placement behavior changes.',
]};
fs.writeFileSync(`${output}/audit.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({wholeCpuAuditMs:report.wholeCpuAuditMs,cases:cases.map(({name,nodes,visited,lengthM,initialCrestAboveLakeM,provisionalDescentM,maxProfileCutM,maxSlope,completeCpuAuditMs,boundsMs,routeMs,declaredScratchBytes})=>({name,nodes,visited,lengthM,initialCrestAboveLakeM,provisionalDescentM,maxProfileCutM,maxSlope,completeCpuAuditMs,boundsMs,routeMs,declaredScratchBytes}))},null,2));
