// Optional WebGPU light/shadow regression and harness integration check.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const arg = (name,fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i+1]; };
const modulePath = arg('puppeteer','puppeteer-core');
const puppeteer = (await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath)).default;
const browser = await puppeteer.launch({
    executablePath:arg('chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,
    args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-sandbox'],
});
try {
    const page = await browser.newPage(), errors = [];
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    page.on('pageerror',error => errors.push(String(error)));
    page.on('console',message => { if(message.type() === 'error') errors.push(message.text()); });
    await page.goto(arg('url','http://127.0.0.1:8026/dev_harness/voxel.html'));
    await page.waitForFunction(() => window.harnessFrameCount > 15 || window.harnessError,{timeout:60000});
    assert.equal(await page.evaluate(() => window.harnessError),undefined);
    const capture = arg('capture-prefix',null);
    if(capture) await page.screenshot({path:`${capture}-carried.png`});
    const screenshot = Buffer.from(await page.screenshot()).toString('base64');
    const flamePixels = await page.evaluate(async png => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const h = window.harness, p = h.lighting.carried.position;
        const at = h.camera.planeToScreen(h.plane.project(p[0],p[2]).s,p[1]);
        const canvas = document.createElement('canvas'); canvas.width=8; canvas.height=12;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image,at.x-4,at.y-6,8,12,0,0,8,12); image.close();
        const pixels = ctx.getImageData(0,0,8,12).data;
        let count = 0;
        for(let i=0;i<pixels.length;i+=4)
            if(pixels[i]>200 && pixels[i+1]>100 && pixels[i]>pixels[i+1]+5 && pixels[i+2]<pixels[i]*0.7) count++;
        return count;
    },screenshot);
    assert.ok(flamePixels >= 5,`visible carried torch flame: ${flamePixels} pixels`);
    const gpu = await page.evaluate(async () => {
        const h = window.harness;
        h.frameLoop.stop();
        const {verifyLightingGPU} = await import('./verifyLightingGPU.js');
        return verifyLightingGPU(h);
    });
    await page.evaluate(() => window.harness.frameLoop.start());
    await page.click('#day-cycle');
    await page.$eval('#time-of-day',input => { input.value='0'; input.dispatchEvent(new Event('input',{bubbles:true})); });
    await page.click('#install-light');
    const initial = await page.evaluate(() => ({ installed: [...window.harness.lighting.lights.values()][0].position,
        carried: [...window.harness.lighting.carried.position] }));
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(x => window.harness.character.position.x > x+0.5,{timeout:15000},54);
    await page.keyboard.up('ArrowRight');
    await page.waitForFunction(() => window.harness.lighting.carried.position[0] > 54.5);
    assert.deepEqual(await page.evaluate(() => [...window.harness.lighting.lights.values()][0].position),initial.installed);
    await page.click('#carried-torch');
    await page.waitForFunction(() => !window.harness.lighting.carried.enabled);
    await page.select('#light-kind','lantern'); await page.click('#install-light');
    await page.waitForFunction(() => window.harness.lighting.data[11] === 2);
    assert.equal(await page.evaluate(() => [...window.harness.lighting.lights.values()][1].flicker),0);
    if(capture) await page.screenshot({path:`${capture}-night.png`});
    await page.click('#remove-light'); await page.click('#remove-light');
    await page.waitForFunction(() => window.harness.lighting.data[11] === 0);
    // Both render paths must compile the same dynamic lighting and shadow code.
    await page.evaluate(() => { window.harness.view.useCompute=false; });
    const frames = await page.evaluate(() => window.harnessFrameCount);
    await page.waitForFunction(frames => window.harnessFrameCount > frames+3,{timeout:15000},frames);
    assert.equal(await page.evaluate(() => window.harnessError),undefined);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,flamePixels,gpu,checks:['visible carried torch','voxel shadow rays','sun shaft','day/night','cutaway isolation',
        'soft body shadow','source/body overlap','smooth voxel normals','normal cache invalidation',
        'edit invalidation','carried torch movement','installed light persistence','steady lantern','removal','fragment fallback']},null,2));
} finally { await browser.close(); }
