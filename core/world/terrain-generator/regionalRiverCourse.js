import {smoothRiverPath} from '../hydrology/riverRefine.js';
import {riverNoise} from '../water/riverShapeNoise.js';

// Refine a coarse terrain corridor before any render tiles are generated.
// The field guides bends; it is a placement proxy, not a final-height bound.
export function regionalRiverCourse({line,frame,heights,halfWidthM,sourceLevelM,targetLevelM,
    sourceRadiusM,targetRadiusM,maxChannelCutM=24,stepM=32,maxPoints=1024,seed=0}) {
    const base=smoothRiverPath(line.map(p=>p[0]),line.map(p=>p[1]),line.map(()=>sourceLevelM),
        {window:2,stepM,passes:2}),length=base.s.at(-1);
    if(base.x.length>maxPoints)throw new Error('Regional river course sampling budget exceeded');
    const grade=(sourceLevelM-targetLevelM)/length;
    const amplitude=Math.min(frame.spacing*.45,halfWidthM*4)/(1+Math.max(0,grade-.02)*16);
    const wavelength=Math.max(frame.spacing*2,halfWidthM*16),x=[],y=[];
    const sample=(px,py)=>{
        const u=(px-frame.x0)/frame.spacing,v=(py-frame.y0)/frame.spacing;
        const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j;
        if(i<0||j<0||i>=frame.nx-1||j>=frame.ny-1)return Infinity;
        const k=j*frame.nx+i;
        return heights[k]*(1-a)*(1-b)+heights[k+1]*a*(1-b)
            +heights[k+frame.nx]*(1-a)*b+heights[k+frame.nx+1]*a*b;
    };
    let maximumOffsetM=0;
    for(let k=0;k<base.x.length;k++) {
        const arc=base.s[k],a=Math.max(0,k-1),b=Math.min(base.x.length-1,k+1);
        const dx=base.x[b]-base.x[a],dy=base.y[b]-base.y[a],l=Math.hypot(dx,dy)||1;
        const taper=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
        const envelope=taper((arc-sourceRadiusM)/wavelength)*taper((length-arc-targetRadiusM)/wavelength);
        const desired=amplitude*envelope*riverNoise(arc*170/wavelength,seed,'wobble').v;
        const level=sourceLevelM+(targetLevelM-sourceLevelM)*arc/length;
        let best=Infinity,offset=0;
        for(const scale of [1,.75,.5,.25,0,-.25,-.5,-.75,-1]) {
            const off=amplitude*envelope*scale,h=sample(base.x[k]-dy/l*off,base.y[k]+dx/l*off);
            const cut=Math.max(0,h-level+1.8);
            if(cut>maxChannelCutM)continue;
            const score=((off-desired)/Math.max(1,amplitude))**2+2*(cut/maxChannelCutM)**2;
            if(score<best){best=score;offset=off;}
        }
        // Retain the coarse corridor if no sampled alternative fits. Final
        // audits/profile budgets decide eligibility; this is not a proof.
        maximumOffsetM=Math.max(maximumOffsetM,Math.abs(offset));
        x.push(base.x[k]-dy/l*offset);y.push(base.y[k]+dx/l*offset);
    }
    const course=smoothRiverPath(x,y,x.map(()=>sourceLevelM),{window:1,stepM,passes:3});
    if(course.x.length>maxPoints)throw new Error('Regional river course sampling budget exceeded');
    // Reject folded/self-crossing courses rather than opening a shortcut
    // between reaches with different water elevations.
    const cross=(ax,ay,bx,by,cx,cy)=>(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    for(let i=0;i+1<course.x.length;i++)for(let j=i+2;j+1<course.x.length;j++) {
        const ax=course.x[i],ay=course.y[i],bx=course.x[i+1],by=course.y[i+1],
            cx=course.x[j],cy=course.y[j],dx=course.x[j+1],dy=course.y[j+1];
        if(Math.max(ax,bx)<Math.min(cx,dx)||Math.max(cx,dx)<Math.min(ax,bx)
            ||Math.max(ay,by)<Math.min(cy,dy)||Math.max(cy,dy)<Math.min(ay,by))continue;
        if(cross(ax,ay,bx,by,cx,cy)*cross(ax,ay,bx,by,dx,dy)<0
            &&cross(cx,cy,dx,dy,ax,ay)*cross(cx,cy,dx,dy,bx,by)<0)throw new Error('Regional course self-intersects');
    }
    return {...course,kind:'coarse-guided-organic-course-v1',maximumOffsetM,wavelengthM:wavelength};
}
