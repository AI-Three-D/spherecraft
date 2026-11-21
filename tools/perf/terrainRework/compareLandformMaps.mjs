// Compare natural height maps from landformLab.mjs at the same grid points.
// node compareLandformMaps.mjs beforeDir afterDir [report.json]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [before, after, reportFile] = process.argv.slice(2);
if (!before || !after) throw new Error('Supply the before and after map directories');
const reports = [];
for (const name of fs.readdirSync(after).filter(n => n.endsWith('.json')).sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(before,name),'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(after,name),'utf8'));
    if (a.px!==b.px || a.size!==b.size || ['n','e1','e2','origin'].some(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])) || a.radius!==b.radius) {
        throw new Error(`Map frames differ: ${name}`);
    }
    const px = a.px, cell = a.size/(px-1);
    if (a.heights.length!==px*px || b.heights.length!==px*px || [...a.heights,...b.heights].some(v=>!Number.isFinite(v))) {
        throw new Error(`Invalid height data: ${name}`);
    }
    const slope = (h,k) => {
        const i=k%px,j=Math.floor(k/px);
        const H=(x,y)=>h[Math.min(px-1,Math.max(0,y))*px+Math.min(px-1,Math.max(0,x))];
        return Math.hypot((H(i+1,j)-H(i-1,j))/(2*cell),(H(i,j+1)-H(i,j-1))/(2*cell));
    };
    let affectedSamples=0, loweredSamples=0, maxAffectedSlope=0, newAboveOne=0, maxGainM=0;
    for(let k=0;k<px*px;k++) {
        const d=b.heights[k]-a.heights[k];
        maxGainM=Math.max(maxGainM,d);
        if(d < -1)loweredSamples++;
        const oldSlope=slope(a.heights,k),newSlope=slope(b.heights,k);
        if(newSlope>1 && oldSlope<=1)newAboveOne++;
        if(Math.abs(d)<=1)continue;
        affectedSamples++;
        maxAffectedSlope=Math.max(maxAffectedSlope,newSlope);
    }
    reports.push({map:name,points:px*px,cellM:cell,affectedSamples,loweredSamples,maxGainM,maxAffectedSlope,newAboveOne});
}
const result={scope:'Natural land before lakes, rivers and render micro detail; central differences at the stated grid spacing, not a global bound',
    maps:reports,totals:reports.reduce((sum,r)=>({points:sum.points+r.points,affectedSamples:sum.affectedSamples+r.affectedSamples,
        loweredSamples:sum.loweredSamples+r.loweredSamples,newAboveOne:sum.newAboveOne+r.newAboveOne}),{points:0,affectedSamples:0,loweredSamples:0,newAboveOne:0})};
console.log(JSON.stringify(result,null,2));
if(reportFile)fs.writeFileSync(reportFile,JSON.stringify(result,null,2));
