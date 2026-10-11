// A bounded, cut-only macro landform input, independent of whether water is
// enabled. The ordinary regional basin proof decides whether it can hold a
// lake. A few fixed eligibility probes avoid sculpting this broad feature on
// steep land; they do not search/flood the fine terrain or raise a rim.
import {createRegionalBasinPotential} from './regionalBasinPotential.js';
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*t*(t*(t*6-15)+10);};
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);

export function regionalDepression({controls,cells,frameDir,tangentBasis,planeToDir,dirToFaceUV,
    face,grid,tileX,tileY,planetRadius,radiusM=450,maxCutM=8,depthM=3,seed=17,guardCells=8,profile='lobes',potentialVersion='current',centres=null}) {
    const started=performance.now(),angle=seed*2.399963229728653,c=Math.cos(angle),s=Math.sin(angle);
    const weight=profile==='organic'?createRegionalBasinPotential({radiusM,seed,version:potentialVersion}):(px,py)=>{
        const x=(c*px+s*py)/radiusM,y=(-s*px+c*py)/radiusM;
        const u=x+.05*Math.sin(y*4.3+seed),v=y+.06*Math.sin(x*5.1-seed);
        const ell=(a,b,rx,ry)=>Math.exp(-2*(((u-a)/rx)**2+((v-b)/ry)**2));
        const f=ell(-.32,-.08,.78,.46)+ell(.28,.15,.57,.62)+ell(.08,-.39,.31,.40);
        return smooth((f-.28)/.48)*smooth((1.5-Math.hypot(x,y))/.3);
    };
    const heightAt=(frame,px,py)=>{
        const d=planeToDir(px,py,frame,planetRadius),p=dirToFaceUV(d);
        const x=Math.round((p.u*grid-tileX)*cells)+1,y=Math.round((p.v*grid-tileY)*cells)+1;
        if(p.face!==face||x<guardCells+4||y<guardCells+4||x>=cells-guardCells||y>=cells-guardCells)return null;
        return controls[y*(cells+3)+x];
    };
    let best=null;const proposals=[];
    for(const [cx,cy] of centres??[.3,.5,.7].flatMap(y=>[.3,.5,.7].map(x=>[x,y]))) {
        const centre=frameDir(cx*cells,cy*cells),frame={c:centre,...tangentBasis(centre)};
        const ring=[],inner=[];
        for(let j=0;j<16;j++) {
            const a=Math.cos(j*Math.PI/8),b=Math.sin(j*Math.PI/8);
            let lo=0,hi=radiusM*1.5;
            if(profile==='organic') {
                // The 2D potential can have islands and multiple crossings.
                // Bracket the OUTERMOST support, rather than assuming a
                // monotone radial footprint as the old lobe fit did.
                const step=hi/32;
                for(let r=hi-step;r>=0;r-=step)if(weight(a*r,b*r)>1e-6){lo=r;hi=r+step;break;}
            }
            for(let k=0;k<12;k++) {
                const mid=(lo+hi)/2;if(weight(a*mid,b*mid)>1e-6)lo=mid;else hi=mid;
            }
            ring.push(heightAt(frame,a*(hi+radiusM*.08),b*(hi+radiusM*.08)));
        }
        for(const [x,y] of [[0,0],[-.55,0],[.55,0],[0,-.55],[0,.55]])inner.push(heightAt(frame,x*radiusM,y*radiusM));
        if([...ring,...inner].some(v=>v===null)){proposals.push({cx,cy,rejected:'regional-support'});continue;}
        // A preliminary elevation proposal, not the containment certificate.
        // Full modified-field cell hulls and its dry ring are checked later.
        const levelM=Math.min(...ring)-1.25;
        // Preserve interior high ground in the potential model. Requiring
        // every interior probe to reach the floor would erase islands and
        // reject otherwise usable basins. The common planner certifies the
        // final connected area; every control cut still has the hard cap.
        const requiredCutM=(profile==='organic'?inner[0]:Math.max(...inner))-levelM+depthM;
        if(requiredCutM>maxCutM){proposals.push({cx,cy,requiredCutM,rejected:'incision-budget'});continue;}
        const rankingCutM=Math.max(...inner)-levelM+depthM;
        proposals.push({cx,cy,levelM,requiredCutM,...(profile==='organic'?{rankingCutM}:{})});
        if(!best||rankingCutM<best.rankingCutM)best={cx,cy,frame,levelM,requiredCutM,rankingCutM};
    }
    if(!best)return {rejected:true,proposals,totalMs:performance.now()-started};
    const {frame,levelM}=best,stride=cells+3;
    const support=Array.from({length:16},(_,j)=>dirToFaceUV(planeToDir(Math.cos(j*Math.PI/8)*radiusM*1.6,
        Math.sin(j*Math.PI/8)*radiusM*1.6,frame,planetRadius)));
    const xs=support.map(p=>(p.u*grid-tileX)*cells),ys=support.map(p=>(p.v*grid-tileY)*cells);
    const x0=Math.max(0,Math.floor(Math.min(...xs))),x1=Math.min(stride-1,Math.ceil(Math.max(...xs))+2);
    const y0=Math.max(0,Math.floor(Math.min(...ys))),y1=Math.min(stride-1,Math.ceil(Math.max(...ys))+2);
    let modifiedControls=0,maximumCutM=0;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) {
        const d=frameDir(x-1,y-1),k=dot(d,frame.c),px=dot(d,frame.e1)/k*planetRadius,py=dot(d,frame.e2)/k*planetRadius;
        const w=weight(px,py);if(w<=0)continue;
        const i=y*stride+x,h=controls[i],floor=levelM-depthM+.15*((px/radiusM+.1)**2+(py/radiusM-.1)**2);
        const cut=Math.max(0,Math.min(maxCutM,(h-floor)*w));
        controls[i]=h-cut;maximumCutM=Math.max(maximumCutM,h-controls[i]);if(cut>0)modifiedControls++;
    }
    const anchor=dirToFaceUV(planeToDir(-radiusM*.1,radiusM*.1,frame,planetRadius));
    const seedCell=Math.floor((anchor.v*grid-tileY)*cells)*cells+Math.floor((anchor.u*grid-tileX)*cells);
    return {kind:profile==='organic'?'regional-basin-potential-v1':'regional-cut-depression-v1',centre:frame.c,cx:best.cx,cy:best.cy,seedCell,levelM,radiusM,maxCutM,
        maximumCutM,modifiedControls,proposals,totalMs:performance.now()-started};
}
