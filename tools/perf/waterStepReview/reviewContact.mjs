// Compact validation of the lake-inclusive contact captures.
import fs from 'node:fs';
import path from 'node:path';
import { readPng } from '../riverMetrics/png.js';
import { compareImages } from './analyze.mjs';
const dir=process.argv[2],report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
const read=name=>readPng(fs.readFileSync(path.join(dir,name)));
const results=report.views.map(view=>{
    const contact=JSON.parse(fs.readFileSync(path.join(dir,`${view.name}-contact.json`)));
    const replay=compareImages(read(`${view.name}-before.png`),read(`${view.name}-replay.png`));
    const checks={complete:view.complete===true,traces:view.traceComplete===true,
        sources:JSON.stringify(view.beforeState)===JSON.stringify(view.afterState),
        replay:replay.maxChannelDifference<=1 && replay.exact.share<=1e-5,
        terrainCrossCheck:contact.terrainCrossCheck.samples>=100 && contact.terrainCrossCheck.maxM<=.05 && contact.terrainCrossCheck.missing===0,
        waterPixelCrossCheck:contact.waterPixelCrossCheck.samples>=100 && contact.waterPixelCrossCheck.maxM<=.005,
        errors:!report.failure&&!report.errors.length&&!report.gpuErrors.length};
    if(view.beforeContact) {
        const t=view.beforeContact.terrainCrossCheck,w=view.beforeContact.waterPixelCrossCheck;
        checks.baselineTerrainCrossCheck=t.samples>=100&&t.maxM<=.05&&t.missing===0;
        checks.baselineWaterPixelCrossCheck=w.samples>=100&&w.maxM<=.005;
    }
    const {edges,...summary}=contact;
    const thresholdSensitivity=[.05,.1,.25,1].map(minDropM=>({minDropM,
        lake:edges.filter(e=>e.status==='hanging'&&e.kind==='lake'&&e.minDropM>minDropM).length,
        river:edges.filter(e=>e.status==='hanging'&&e.kind==='river'&&e.minDropM>minDropM).length}));
    return {name:view.name,valid:Object.values(checks).every(Boolean),checks,replay,thresholdSensitivity, ...summary};
});
fs.writeFileSync(path.join(dir,'validation.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({name,valid,checks,summary,counts,terrainCrossCheck,elapsedMs})=>({name,valid,checks,summary,counts,terrainCrossCheck,elapsedMs})),null,2));
process.exitCode=results.every(x=>x.valid)?0:1;
