// A terrain-following surface shared by quiet and steep regional rivers.
// No fluid solve: natural heights constrain the profile, lake ends anchor it,
// and incision clears the same channel below that surface at every LOD.
export function regionalRiverProfile({x,y,s,heights,sourceLevelM,targetLevelM,sourceEndM,targetStartM,
    maxChannelCutM=24,depthM=1.8,fallExtraCutM=4,fallRunM=1.5,maxPoints=1024}) {
    const n=s.length;
    if(n<2||x.length!==n||y.length!==n||heights.length!==n*3
        ||![...x,...y,...s,...heights].every(Number.isFinite)||sourceLevelM<=targetLevelM
        ||sourceEndM>=targetStartM||sourceEndM<0||targetStartM>s[n-1]
        ||!Number.isFinite(maxChannelCutM)||maxChannelCutM<depthM||fallExtraCutM<0||fallRunM<1
        ||n>maxPoints||Array.from(s).some((v,i)=>i>0&&v<=s[i-1])) throw new Error('Invalid regional river profile inputs');
    const levels=new Float64Array(n);let ceiling=sourceLevelM;
    for(let k=0;k<n;k++) {
        const natural=heights[k*3],bank=Math.min(heights[k*3+1],heights[k*3+2]);
        if(s[k]<=sourceEndM) levels[k]=sourceLevelM;
        else if(s[k]>=targetStartM) levels[k]=targetLevelM;
        else levels[k]=Math.max(targetLevelM,Math.min(ceiling,natural+.2,bank+.2));
        ceiling=levels[k];
    }
    // A short fall replaces part of an ALREADY steep natural reach. Move
    // descent upstream by at most the explicit extra-incision budget; do
    // not hold a raised water sheet over a descending hillside. The rest
    // remains a rapid. No periodic stairs on quiet reaches.
    const grades=Float64Array.from(levels,(v,k)=>k+1<n?(v-levels[k+1])/(s[k+1]-s[k]):0);
    const rows=[],falls=[];let lastFallM=-Infinity,maxCutM=0,maxSlope=0;
    const add=(px,py,arc,level,natural)=>{
        maxCutM=Math.max(maxCutM,natural-level+depthM);
        if(rows.length) maxSlope=Math.max(maxSlope,(rows.at(-1).levelM-level)/(arc-rows.at(-1).s));
        rows.push({x:px,y:py,s:arc,levelM:level,depthM,naturalM:natural});
    };
    for(let k=0;k<n;k++) {
        add(x[k],y[k],s[k],levels[k],heights[k*3]);
        if(k+1===n) continue;
        const span=s[k+1]-s[k],drop=levels[k]-levels[k+1];
        if(s[k]<=sourceEndM||s[k+1]>=targetStartM||drop/span<.45||drop<3
            ||span<=fallRunM*2||s[k]-lastFallM<40||fallExtraCutM===0) continue;
        // A steep hillside is a rapid, not a staircase of identical falls.
        // Require a local gradient peak with weaker upstream AND downstream
        // shoulders. This sampled preference never relaxes the cut budget.
        if(k<4||k+5>=n) continue;
        const local=Array.from({length:9},(_,j)=>grades[k+j-4]);
        if(local.some((v,j)=>j!==4&&v>=grades[k])
            ||grades[k]-Math.max((grades[k-4]+grades[k-3])/2,(grades[k+3]+grades[k+4])/2)<.1) continue;
        const fallDrop=Math.min(drop,fallExtraCutM/(1-fallRunM/span));
        if(fallDrop<3) continue;
        const t=fallRunM/span,arc=s[k]+fallRunM,level=levels[k]-fallDrop;
        add(x[k]+(x[k+1]-x[k])*t,y[k]+(y[k+1]-y[k])*t,arc,level,
            heights[k*3]+(heights[(k+1)*3]-heights[k*3])*t);
        falls.push({startM:s[k],endM:arc,dropM:fallDrop,slope:fallDrop/fallRunM});lastFallM=s[k];
    }
    if(rows.length>maxPoints) throw new Error('Regional river profile point budget exceeded');
    if(maxCutM>maxChannelCutM) throw new Error(`Regional river profile exceeds incision budget: ${maxCutM.toFixed(3)}m > ${maxChannelCutM}m`);
    return {rows,falls,maxCutM,maxSlope,descentM:sourceLevelM-targetLevelM,
        kind:'terrain-following-regional-profile-v1',sampled:true};
}
