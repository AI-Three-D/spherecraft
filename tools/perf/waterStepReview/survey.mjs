import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9226',defaultViewport:{width:1440,height:900,deviceScaleFactor:1},protocolTimeout:900000});
try{
 const page=(await browser.pages()).find(p=>p.url().includes('standalone.html'));
 const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});
 const shots=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
 for(const shot of shots){
  const result=await page.evaluate(async shot=>{const q=await import('/tools/perf/waterStepReview/qualityScene.js');return shot.pos?q.poseView(shot):q.riverView(shot.river,shot.at,shot);},shot);
  fs.writeFileSync(path.join(out,shot.name+'.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:path.join(out,shot.name+'.png')});
  console.log(JSON.stringify({name:shot.name,level:result.level,width:result.width,near:result.near,gpuErrors:result.gpuErrors.length}));
 }
}finally{await browser.disconnect();}
