// CPU counterpart of the authoritative C2 regional shape. Bounds use the
// tensor-product Bezier control hull of EACH spline cell, not sample extrema.
const weights=t=>{const a=1-t;return [a*a*a/6,(3*t*t*t-6*t*t+4)/6,(-3*t*t*t+3*t*t+3*t+1)/6,t*t*t/6];};
const halfWeights=weights(.5);

export function sampleRegionalShape(controls,cells,x,y) {
    const i=Math.floor(x),j=Math.floor(y),u=weights(x-i),v=weights(y-j),stride=cells+3;
    if(i<0||j<0||i>=cells||j>=cells) throw new Error('Shape sample outside regional cell domain');
    let h=0;
    for(let b=0;b<4;b++) for(let a=0;a<4;a++) h+=controls[(j+b)*stride+i+a]*u[a]*v[b];
    return h;
}

export function regionalShapeBounds(controls,cells) {
    const stride=cells+3,n=cells*cells,lower=new Float64Array(n),upper=new Float64Array(n),centre=new Float64Array(n);
    if(controls.length!==stride*stride||!controls.every(Number.isFinite)) throw new Error('Invalid regional shape controls');
    const rows=new Float64Array(16);
    for(let y=0;y<cells;y++) for(let x=0;x<cells;x++) {
        for(let j=0;j<4;j++) {
            const k=(y+j)*stride+x;
            const a=controls[k],b=controls[k+1],c=controls[k+2],d=controls[k+3],z=j*4;
            rows[z]=(a+4*b+c)/6;rows[z+1]=(2*b+c)/3;rows[z+2]=(b+2*c)/3;rows[z+3]=(b+4*c+d)/6;
        }
        let lo=Infinity,hi=-Infinity;
        for(let i=0;i<4;i++) {
            const a=rows[i],b=rows[4+i],c=rows[8+i],d=rows[12+i];
            const p=(a+4*b+c)/6,q=(2*b+c)/3,r=(b+2*c)/3,s=(b+4*c+d)/6;
            lo=Math.min(lo,p,q,r,s);hi=Math.max(hi,p,q,r,s);
        }
        const k=y*cells+x;lower[k]=lo;upper[k]=hi;
        let h=0;
        for(let j=0;j<4;j++) for(let i=0;i<4;i++) h+=controls[(y+j)*stride+x+i]*halfWeights[i]*halfWeights[j];
        centre[k]=h;
    }
    return {lower,upper,centre};
}

// Flood only cells that MIGHT be below the retaining boundary threshold.
// Overconnecting diagonal/ambiguous cells is conservative. A closed component
// has an entire dry cell ring, including spline interiors and saddle points.
export function shapeThresholdRegion(lower,cells,seed,level,guardCells=8,workspace=null,maxCells=Infinity) {
    const mask=workspace?.mask??new Uint8Array(cells*cells),queue=workspace?.queue??new Int32Array(cells*cells);
    mask.fill(0);
    let head=0,tail=0,touchesGuard=false;
    if(lower[seed]>level) return {mask,queue,cells:0,touchesGuard:false};
    queue[tail++]=seed;mask[seed]=1;
    while(head<tail) {
        const k=queue[head++],x=k%cells,y=Math.floor(k/cells);
        if(x<guardCells||y<guardCells||x>=cells-guardCells||y>=cells-guardCells) return {mask,queue,cells:tail,touchesGuard:true};
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
            if(dx===0&&dy===0) continue;
            const i=x+dx,j=y+dy;if(i<0||j<0||i>=cells||j>=cells) continue;
            const p=j*cells+i;if(mask[p]||lower[p]>level) continue;
            if(tail>=maxCells) return {mask,queue,cells:tail,touchesGuard,exceededBudget:true};
            mask[p]=1;queue[tail++]=p;
        }
    }
    return {mask,queue,cells:tail,touchesGuard};
}

// One common planner for quiet land and rugged pockets. Radius/level are
// outputs. Finite candidates and levels bound both successful and failed work.
// radiusOfCells supplies the physical metric of the canonical generation tile.
export function planRegionalShapeLake({controls,cells,radiusOfCells,guardCells=8,maxCandidates=8,
    minLevelM=100,maxRadiusM=140,risesM=[2,4,6,8,.5,.75,1],maxPotentialCells=512,
    bedCutM=1.5,bedTransitionM=.5,depthM=1.5,rimM=.5,microLimitM=.25,numericalM=.125,
    contextOfCells=null,minimumEnclosureM=0,levelsM=[],minWetCells=0,candidateSeeds=[],candidateSeedsOnly=true,
    preparedBounds=null,excludedCells=null}) {
    if(minimumEnclosureM>0&&!contextOfCells) throw new Error('Enclosure preference needs regional context');
    const t0=performance.now(),bounds=preparedBounds??regionalShapeBounds(controls,cells),boundsMs=performance.now()-t0;
    const seeds=[];
    if(!candidateSeeds.length||!candidateSeedsOnly)for(let y=guardCells+2;y<cells-guardCells-2;y++) for(let x=guardCells+2;x<cells-guardCells-2;x++) {
        const k=y*cells+x,h=bounds.centre[k];if(h<minLevelM||excludedCells?.[k]) continue;
        let minimum=true;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
            if(dx===0&&dy===0) continue;
            if(bounds.centre[(y+dy)*cells+x+dx]<h) minimum=false;
        }
        if(!minimum) continue;
        seeds.push(k);seeds.sort((a,b)=>bounds.centre[a]-bounds.centre[b]||a-b);
        if(seeds.length>maxCandidates) seeds.pop();
    }
    // Terrain-owned landforms can already identify a basin anchor. They use
    // exactly the same component, wet-area and retaining-ring proof below.
    for(const k of candidateSeeds.slice(0,maxCandidates).reverse()) {
        const x=k%cells,y=Math.floor(k/cells);
        if(!Number.isInteger(k)||x<guardCells+2||y<guardCells+2||x>=cells-guardCells-2||y>=cells-guardCells-2
            ||bounds.centre[k]<minLevelM||excludedCells?.[k])continue;
        const old=seeds.indexOf(k);if(old>=0)seeds.splice(old,1);seeds.unshift(k);
        if(seeds.length>maxCandidates)seeds.pop();
    }
    const attempts=[],workspace={mask:new Uint8Array(cells*cells),queue:new Int32Array(cells*cells)};
    for(const seed of seeds) for(const riseM of [...levelsM.map(h=>h-bounds.centre[seed]),...risesM,
        // One derived trial closes the gap between the fixed low levels and
        // the first overflowing trial. This level fully deepens the seed's
        // entire cell and meets the SAME fine depth allowance. Existing
        // successful fixed trials retain their levels and shapes.
        bounds.upper[seed]+Math.max(bedTransitionM,depthM+microLimitM+numericalM-bedCutM)-bounds.centre[seed]]) {
        const levelM=bounds.centre[seed]+riseM;
        const p=shapeThresholdRegion(bounds.lower,cells,seed,levelM+rimM+microLimitM+numericalM,guardCells,workspace,maxPotentialCells);
        const a={seed,riseM,levelM,cells:p.cells,touchesGuard:p.touchesGuard};attempts.push(a);
        if(!p.cells||p.touchesGuard||p.exceededBudget) {a.rejected=p.exceededBudget?'cell-work-budget':'open-or-region-boundary';continue;}
        if(excludedCells&&p.queue.subarray(0,p.cells).some(k=>excludedCells[k])) {a.rejected='occupied-retaining-ring';continue;}
        let core=-1,coreCutM=0;const wet=minWetCells>0?new Uint8Array(cells*cells):null;
        for(let j=0;j<p.cells;j++) {
            const k=p.queue[j];
            // h - cut(h) is monotone: evaluate the cell's upper height to
            // bound its entire carved interior, including partial deepening.
            const t=Math.max(0,Math.min(1,(levelM-bounds.upper[k])/bedTransitionM));
            const cut=bedCutM*t*t*t*(t*(t*6-15)+10);
            if(wet&&bounds.upper[k]+microLimitM+numericalM-cut<=levelM-.25)wet[k]=1;
            if(bounds.upper[k]+microLimitM+numericalM-cut<=levelM-depthM
                &&(core<0||bounds.upper[k]<bounds.upper[core])) {core=k;coreCutM=cut;}
        }
        if(core<0) {a.rejected='no-certified-wet-cell';continue;}
        let connectedWetCells=0;
        if(wet) {
            const queue=new Int32Array(p.cells);
            for(let j=0;j<p.cells;j++) {
                const start=p.queue[j];if(!wet[start])continue;
                let head=0,tail=1;queue[0]=start;wet[start]=0;
                while(head<tail) {
                    const k=queue[head++],x=k%cells,y=Math.floor(k/cells);
                    for(const q of [x>0?k-1:-1,x+1<cells?k+1:-1,y>0?k-cells:-1,y+1<cells?k+cells:-1]) {
                        if(q>=0&&wet[q]){wet[q]=0;queue[tail++]=q;}
                    }
                }
                connectedWetCells=Math.max(connectedWetCells,tail);
            }
            a.connectedWetCells=connectedWetCells;
            if(connectedWetCells<minWetCells){a.rejected='connected-wet-area';continue;}
        }
        const radiusM=radiusOfCells(p.queue.subarray(0,p.cells),core);
        a.radiusM=radiusM;
        if(radiusM>maxRadiusM) {a.rejected='footprint-budget';continue;}
        const context=minimumEnclosureM>0?contextOfCells?.(core,levelM,minimumEnclosureM):null;
        // Sampled landscape preference, separate from continuous containment.
        // Missing regional support rejects this preference; never extend the
        // generation/search domain to manufacture an enclosing setting.
        if(minimumEnclosureM>0&&!context?.rings.some(r=>r.validSamples>=6&&r.enclosingSectors>=4&&r.opposingRiseM>=minimumEnclosureM)) {
            a.rejected='insufficient-enclosure';a.context=context;continue;
        }
        // Make all 16 mask controls equal to one for both potential-water
        // cells AND their entire retaining ring. The spline then returns
        // exactly one there, bounding final material micro to microLimitM.
        const stride=cells+3,microMask=new Float32Array(stride*stride),rim=new Set();
        for(let j=0;j<p.cells;j++) {
            const k=p.queue[j],x=k%cells,y=Math.floor(k/cells);
            for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
                const i=x+dx,z=y+dy,q=z*cells+i;
                if(!p.mask[q]) rim.add(q);
                for(let b=0;b<4;b++) for(let c=0;c<4;c++) microMask[(z+b)*stride+i+c]=1;
            }
        }
        const minimumRimM=Math.min(...[...rim].map(k=>bounds.lower[k]-microLimitM-numericalM-levelM));
        const guaranteedDepthM=levelM-bounds.upper[core]-microLimitM-numericalM+coreCutM;
        return {seed,core,levelM,radiusM,bedCutM,depthM,rimM,microLimitM,numericalM,microMask,
            region:p.mask,proof:{kind:'continuous-spline-cell-hulls',coreCell:core,coreUpperM:bounds.upper[core],
                rimCells:rim.size,minimumRimM,guaranteedDepthM,potentialCells:p.cells,connectedWetCells},
            attempts,context,timings:{boundsMs,totalMs:performance.now()-t0},scratchLowerBoundBytes:
                bounds.lower.byteLength+bounds.upper.byteLength+bounds.centre.byteLength+p.mask.byteLength+p.queue.byteLength+microMask.byteLength
                    +(wet?wet.byteLength+p.cells*4:0)};
    }
    return {rejected:true,attempts,timings:{boundsMs,totalMs:performance.now()-t0}};
}
