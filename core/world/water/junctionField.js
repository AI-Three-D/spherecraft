// A junction is a spatial boundary-value problem, independent of traced
// segment ownership. Heights stay relative to a local datum during the solve.
export const JUNCTION_FIELD_DEFAULTS = Object.freeze({
    iterations: 1200,
    toleranceM: 0.0001,
    // Inverse square metres; refinement must not change the solved shape.
    levelScreening: 0.000125,
    bedScreening: 0.00125,
    bankCollarM: 0,
});

// Positive inside either water domain. The smooth union rounds the corner
// where a narrow reach opens into a basin, without adding an endpoint cap.
export function junctionWetUnion(river, lake, radiusM) {
    if (!(radiusM > 0)) return Math.max(river, lake);
    const h = Math.max(radiusM - Math.abs(river - lake), 0) / radiusM;
    return Math.max(river, lake) + radiusM * h * h * 0.25;
}

// The render mask is only a seed identifying the basin. Its rectangle and
// clipped SDF must never become a junction boundary. Flood the natural basin,
// then rebuild a signed distance over the whole patch, including dry land.
export function connectedBasinDistance({width,height,spacingM,natural,levelM,seeds,allowed=null}) {
    const n=width*height,wet=new Uint8Array(n),queue=new Uint32Array(n);
    let head=0,tail=0;
    for(let i=0;i<n;i++)if(seeds[i]&&natural[i]<levelM&&(!allowed||allowed[i])){wet[i]=1;queue[tail++]=i;}
    if(!tail)throw new Error('Junction patch has no connected lake seed');
    while(head<tail) {
        const i=queue[head++],x=i%width,y=Math.floor(i/width);
        for(const j of [x>0?i-1:-1,x+1<width?i+1:-1,y>0?i-width:-1,y+1<height?i+width:-1]) {
            if(j<0||wet[j]||natural[j]>=levelM||(allowed&&!allowed[j]))continue;
            wet[j]=1;queue[tail++]=j;
        }
    }
    const toWet=squaredDistanceTo(wet,width,height,1),toDry=squaredDistanceTo(wet,width,height,0);
    const distance=new Float64Array(n);
    for(let i=0;i<n;i++)distance[i]=spacingM*(wet[i]?Math.sqrt(toDry[i])-.5:.5-Math.sqrt(toWet[i]));
    return {wet,distance};
}

// Separable exact Euclidean distance transform: lower envelope of parabolas.
function squaredDistanceTo(mask,width,height,target) {
    const infinity=(width*width+height*height)*4;
    const result=new Float64Array(width*height),v=new Int32Array(Math.max(width,height));
    const z=new Float64Array(v.length+1),f=new Float64Array(v.length),d=new Float64Array(v.length);
    const transform=n=>{
        let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity;
        for(let q=1;q<n;q++) {
            let s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]));
            while(s<=z[k]){k--;s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]));}
            k++;v[k]=q;z[k]=s;z[k+1]=Infinity;
        }
        k=0;for(let q=0;q<n;q++){while(z[k+1]<q)k++;d[q]=(q-v[k])**2+f[v[k]];}
    };
    for(let y=0;y<height;y++) {
        for(let x=0;x<width;x++)f[x]=mask[y*width+x]===target?0:infinity;
        transform(width);for(let x=0;x<width;x++)result[y*width+x]=d[x];
    }
    for(let x=0;x<width;x++) {
        for(let y=0;y<height;y++)f[y]=result[y*width+x];
        transform(height);for(let y=0;y<height;y++)result[y*width+x]=d[y];
    }
    return result;
}

// Raster triangles straddle the shoreline. Their dry support vertices need a
// smooth extension of the solved water level, not an unrelated dry guide.
// Wet values stay prescribed; this extension never changes the water solve.
function extendSurface(level,width,height,wetDistance,supportM) {
    const n=width*height,visited=new Uint8Array(n),queue=new Uint32Array(n);
    let head=0,tail=0;
    for(let i=0;i<n;i++)if(wetDistance[i]>0){visited[i]=1;queue[tail++]=i;}
    while(head<tail) {
        const i=queue[head++],x=i%width,y=Math.floor(i/width);
        for(const j of [x>0?i-1:-1,x+1<width?i+1:-1,y>0?i-width:-1,y+1<height?i+width:-1]) {
            if(j<0||visited[j]||wetDistance[j]<-supportM)continue;
            visited[j]=1;level[j]=level[i];queue[tail++]=j;
        }
    }
    for(let iteration=0;iteration<256;iteration++) {
        let change=0;
        for(let color=0;color<2;color++)for(let y=1;y+1<height;y++)for(let x=1+((y+color)&1);x+1<width;x+=2) {
            const i=y*width+x;if(!visited[i]||wetDistance[i]>0)continue;
            let sum=0,count=0;
            for(const j of [i-1,i+1,i-width,i+width])if(visited[j]){sum+=level[j];count++;}
            const value=sum/Math.max(count,1);change=Math.max(change,Math.abs(value-level[i]));level[i]=value;
        }
        if(change<.0001)break;
    }
}

/**
 * Solve one regular tangent-plane patch. All arrays have width*height cells.
 * levelGuide/bedGuide supply initial values and optional screened guidance;
 * fixedLevel/fixedBed mark prescribed upstream, basin, bank and guard cells.
 * wetDistance is positive inside the combined domain. The caller must provide
 * a finite level guide even on dry cells; no sentinel enters the relaxation.
 */
export function solveJunctionField({ width, height, spacingM=1, natural, levelGuide,
    bedGuide, wetDistance, fixedLevel, fixedBed, options = {} }) {
    const n = width * height, p = { ...JUNCTION_FIELD_DEFAULTS, ...options };
    if (!(width >= 3 && height >= 3 && spacingM > 0) || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Invalid junction grid');
    for (const a of [natural, levelGuide, bedGuide, wetDistance, fixedLevel, fixedBed]) {
        if (a?.length !== n) throw new Error('Junction field dimensions disagree');
    }
    const datum = levelGuide.find(Number.isFinite);
    if (!Number.isFinite(datum)) throw new Error('Junction needs finite level boundaries');
    const level = new Float64Array(n), bed = new Float64Array(n);
    const ground = new Float64Array(n), levelTarget = new Float64Array(n), bedTarget = new Float64Array(n);
    const requiredDepth = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (![natural[i], levelGuide[i], bedGuide[i], wetDistance[i]].every(Number.isFinite)) {
            throw new Error('Non-finite junction input');
        }
        ground[i] = natural[i] - datum;
        level[i] = levelTarget[i] = levelGuide[i] - datum;
        bedTarget[i] = Math.min(natural[i], bedGuide[i]) - datum;
        requiredDepth[i] = Math.max(0, levelGuide[i] - bedGuide[i]);
        bed[i] = wetDistance[i] > -p.bankCollarM ? bedTarget[i] : ground[i];
    }
    let residual = Infinity, iteration = 0;
    // The relaxed cells of each colour, in scan order (most of a patch is
    // fixed or outside the domain: scanning all of it every iteration was
    // most of the solve).
    const activeCells = (fixed, cutOnly) => [0, 1].map(color => {
        const cells = [];
        for (let y = 1; y + 1 < height; y++) for (let x = 1 + ((y + color) & 1); x + 1 < width; x += 2) {
            const i = y * width + x;
            const active=cutOnly?wetDistance[i]>-p.bankCollarM:wetDistance[i]>0;
            if (active && !fixed[i]) cells.push(i);
        }
        return Int32Array.from(cells);
    });
    const levelCells = activeCells(fixedLevel, false), bedCells = activeCells(fixedBed, true);
    const relax = (values, guide, lists, screening, cutOnly) => {
        let change = 0;
        for (const cells of lists) {
            for (let c = 0; c < cells.length; c++) {
                const i = cells[c];
                let sum = screening * guide[i], weight = screening;
                // No flux across a dry water-surface boundary. The bed
                // instead meets the prescribed natural bank there.
                if (cutOnly || wetDistance[i - 1] > 0) { sum += values[i - 1]; weight++; }
                if (cutOnly || wetDistance[i + 1] > 0) { sum += values[i + 1]; weight++; }
                if (cutOnly || wetDistance[i - width] > 0) { sum += values[i - width]; weight++; }
                if (cutOnly || wetDistance[i + width] > 0) { sum += values[i + width]; weight++; }
                if (weight === 0) continue;
                let value = sum / weight;
                // A smooth bed is still required to carry its prescribed
                // water. Dry-bank boundary values otherwise lift a narrow
                // channel above the surface and disconnect the junction.
                if (cutOnly) {
                    value = Math.min(value, ground[i]);
                    if(wetDistance[i]>0)value=Math.min(value,level[i]-requiredDepth[i]);
                    else value=Math.min(value,bedTarget[i]);
                }
                change = Math.max(change, Math.abs(value - values[i]));
                values[i] = value;
            }
        }
        return change;
    };
    for (; iteration < p.iterations; iteration++) {
        residual = Math.max(
            relax(level, levelTarget, levelCells, Math.max(0, p.levelScreening)*spacingM*spacingM, false),
            relax(bed, bedTarget, bedCells, Math.max(0, p.bedScreening)*spacingM*spacingM, true),
        );
        if (residual <= p.toleranceM) { iteration++; break; }
    }
    extendSurface(level,width,height,wetDistance,Math.max(8,p.bankCollarM+4*spacingM));
    const field = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        field[4*i] = level[i] + datum; field[4*i+1] = bed[i] + datum;
        field[4*i+2] = wetDistance[i]; field[4*i+3] = natural[i];
    }
    return { width, height, field, iterations: iteration, residualM: residual, converged: residual <= p.toleranceM };
}
