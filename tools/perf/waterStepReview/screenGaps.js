// Diagnostic raster runs, not a world connectivity or true contour-width test.
// Follow the grid normal of each flagged edge until the rejected sheet is
// hidden by ground, covered by another surface, or the probe becomes unknown.
export function screenGapRuns({positions,probe,owners,edges,width,height,cssWidth,cssHeight,limit=32}) {
    const distance=(a,i)=>Math.hypot(a[4*i],a[4*i+1],a[4*i+2]);
    const rows=[];
    for(const e of edges) {
        if(e.kind!=='lake'||e.status!=='hanging'||probe[4*e.neighbourIndex+3]>=0)continue;
        const x=e.waterIndex%width,y=Math.floor(e.waterIndex/width);
        const dx=e.neighbourIndex%width-x,dy=Math.floor(e.neighbourIndex/width)-y;
        let count=0,shaded=0,stop='limit';
        for(let step=1;step<=limit;step++) {
            const xx=x+dx*step,yy=y+dy*step,i=yy*width+xx;
            if(xx<0||yy<0||xx>=width||yy>=height){stop='viewport';break;}
            if(positions[4*i+3]!==1){stop='other-surface';break;}
            if(probe[4*i+3]>=0){stop='coverage-or-unknown';break;}
            if(distance(positions,i)<=distance(probe,i)+.02){stop='ground-contact';break;}
            count++;if(owners[4*i+2]>.5)shaded++;
        }
        let nearest=Infinity;
        const edgeX=x+.5+dx/2,edgeY=y+.5+dy/2;
        for(let yy=Math.max(0,y-limit);yy<=Math.min(height-1,y+limit);yy++)for(let xx=Math.max(0,x-limit);xx<=Math.min(width-1,x+limit);xx++) {
            const i=yy*width+xx,delta=Math.hypot(xx+.5-edgeX,yy+.5-edgeY);
            if(delta>limit||delta>=nearest||positions[4*i+3]!==1||distance(probe,i)===0)continue;
            if(distance(positions,i)<=distance(probe,i)+.02)nearest=delta;
        }
        rows.push({waterIndex:e.waterIndex,neighbourIndex:e.neighbourIndex,x:e.x,y:e.y,
            nearestGroundContactRenderPx:Number.isFinite(nearest)?nearest:null,
            nearestGroundContactCssPx:Number.isFinite(nearest)?nearest*cssWidth/width:null,
            renderPixels:count,cssPixels:count*(dx?cssWidth/width:cssHeight/height),
            lakeShadedPixels:shaded,allLakeShaded:count>0&&shaded===count,stop,
            distanceM:distance(probe,e.neighbourIndex)});
    }
    const widths=rows.map(r=>r.cssPixels).sort((a,b)=>a-b);
    return {method:'Outward cardinal raster runs from mask-rejected hanging edges; oblique shores can overestimate perpendicular width; 2 cm ray-distance uncertainty excluded.',
        cssWidth,cssHeight,limit,rows,p50CssPx:widths[Math.floor(widths.length*.5)]??0,
        p95CssPx:widths[Math.floor(widths.length*.95)]??0,maxCssPx:widths.at(-1)??0,
        truncated:rows.filter(r=>r.stop==='limit').length,fullyLakeShaded:rows.filter(r=>r.allLakeShaded).length};
}
