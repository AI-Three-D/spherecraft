import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9226',defaultViewport:{width:1440,height:900,deviceScaleFactor:1},protocolTimeout:900000});
try {
    const page=(await browser.pages()).find(p=>p.url().includes('standalone.html'));
    if(!page)throw new Error('No diagnostic scene');
    const source=fs.readFileSync(process.argv[2],'utf8');
    const result=await page.evaluate(source);
    if(process.argv[3]){
        const out=process.argv[3];fs.mkdirSync(path.dirname(out),{recursive:true});
        fs.writeFileSync(out+'.json',JSON.stringify(result,null,2));
        await page.screenshot({path:out+'.png'});
        console.log(out);
    } else console.log(JSON.stringify(result));
} finally {await browser.disconnect();}
