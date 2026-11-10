import {dirToPlane} from '../hydrology/lakeRefine.js';

// Anchor a course in the actual conservative lake-depth representation.
// A bounding radius is only a fallback for older analytic basin records.
export function regionalLakePortal({course,basin,planetRadius,planeToDir,frame,fromStart=true}) {
    if(!basin.surfaceDepthMask)return {arcM:fromStart?basin.radiusM+8:course.s.at(-1)-basin.radiusM-8,
        kind:'legacy-radius-anchor'};
    const wet=(x,y)=>{
        const d=planeToDir(x,y,frame,planetRadius),p=dirToPlane(d,basin.frame,planetRadius),f=basin.frame;
        const i=Math.floor((p[0]-f.x0)/f.spacing),j=Math.floor((p[1]-f.y0)/f.spacing);
        return i>=0&&j>=0&&i<f.nx&&j<f.ny&&basin.surfaceDepthMask[j*f.nx+i]>130;
    };
    const n=course.s.length,start=fromStart?0:n-1,step=fromStart?1:-1;
    if(!wet(course.x[start],course.y[start]))throw new Error('Regional course anchor is outside certified lake depth');
    let last=start;
    for(let k=start+step;k>=0&&k<n;k+=step) {
        if(!wet(course.x[k],course.y[k]))return {arcM:course.s[last],kind:'conservative-lake-depth-portal',
            pointIndex:last,depthGridSpacingM:basin.frame.spacing};
        last=k;
    }
    throw new Error('Regional course never exits its lake');
}
