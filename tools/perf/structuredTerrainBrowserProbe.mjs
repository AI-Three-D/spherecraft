/* global process */
// Prepared browser reproduction; run only with the owner's authorization.
// A fresh Puppeteer profile leaves the owner's browser/profile untouched.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const labRequire = createRequire(new URL('../../../terrain-lab/package.json', import.meta.url));
const { default: puppeteer } = await import(labRequire.resolve('puppeteer-core'));
const cells = Number(process.argv[2] ?? 256);
const durationMs = Number(process.argv[3] ?? 45000);
const roam = process.argv.includes('--roam');
if (![0,128,256].includes(cells)) throw new Error('Expected 0, 128 or 256 cells');
const output = '/tmp/spherecraft-browser-probe';
fs.mkdirSync(output, { recursive: true });
const start = Date.now();
const report = { cells, url: `http://localhost:8181/wizard_game/standalone.html?regionalTerrain=${cells}`,
    started: new Date().toISOString(), roam, events: [], samples: [], errors: [] };
const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 120000,
    args: ['--enable-gpu', '--no-first-run', '--no-default-browser-check', '--enable-logging=stderr'],
});
const log = fs.createWriteStream(`${output}/chrome-${cells}.log`);
browser.process().stderr.pipe(log);
try {
    report.browserVersion = await browser.version();
    const page = await browser.newPage();
    page.on('pageerror', error => report.errors.push({ atMs: Date.now()-start, message: String(error) }));
    page.on('console', message => {
        if (['error','warn'].includes(message.type()) || message.text().startsWith('[Probe]')) {
            report.events.push({ atMs: Date.now()-start, type: message.type(), message: message.text().slice(0,2000) });
        }
    });
    await page.evaluateOnNewDocument(() => {
        const emit = (event, values={}) => console.log('[Probe]', JSON.stringify({event, atMs:performance.now(),...values}));
        window.__regionalProbe = { losses: [], pipelineEvents: [] };
        const originalDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function (...args) {
            const device = await originalDevice.apply(this,args);
            emit('device', {adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,this.info[k]])),limits:Object.fromEntries(['maxBindGroups','maxStorageBuffersPerShaderStage','maxSampledTexturesPerShaderStage'].map(k=>[k,device.limits[k]]))});
            device.lost.then(info => { const loss={reason:info.reason,message:info.message,atMs:performance.now()};window.__regionalProbe.losses.push(loss);emit('lost',loss); });
            device.addEventListener('uncapturederror', e=>emit('validation',{message:e.error.message}));
            return device;
        };
        for (const name of ['createComputePipeline','createComputePipelineAsync']) {
            const original = GPUDevice.prototype[name];
            GPUDevice.prototype[name] = function (descriptor) {
                const at=performance.now(),label=descriptor.label??descriptor.compute?.entryPoint;
                emit('pipeline-start',{name,label});
                const completed = error => {const record={name,label,wallMs:performance.now()-at,error};window.__regionalProbe.pipelineEvents.push(record);emit('pipeline-end',record);};
                try {
                    const result=original.call(this,descriptor);
                    if (name.endsWith('Async')) result.then(()=>completed(),e=>completed(String(e)));
                    else completed();
                    return result;
                } catch (error) {completed(String(error));throw error;}
            };
        }
    });
    await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const deadline=Date.now()+durationMs;
    let roamStarted;
    while (Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        const sample = await page.evaluate(()=>({
            atMs:performance.now(), loading:window.gameEngine?.getLoadingStatus?.(),
            water:window.gameEngine?.waterService?.state,
            regional:window.gameEngine?.terrainGenerator?.regionalTerrainActive,
            losses:window.__regionalProbe.losses,
        }));
        report.samples.push(sample);
        if (roam && sample.water === 'ready') {
            if (!roamStarted) {
                await page.evaluate(() => {
                    const pose = window.qtDiag.regional.camera();
                    const up = window.gameEngine.camera._getLocalUp();
                    for (const axis of ['x','y','z']) {
                        pose.position[axis] += 1200 * up[axis];
                        pose.target[axis] += 1200 * up[axis];
                    }
                    window.qtDiag.regional.useCamera(pose);
                    window.__regionalProbe.roamPose = pose;
                });
                roamStarted = Date.now();
            }
            const phase = Math.floor((Date.now() - roamStarted) / 6000);
            await page.evaluate(phase => {
                const keys = window.gameEngine.inputManager.keys;
                keys.clear();
                const code = ['KeyW','KeyD','KeyQ','KeyE'][phase];
                if (code) keys.add(code);
            }, phase);
        }
        if (report.samples.at(-1).losses.length) break;
    }
    if (roam) await page.evaluate(() => window.gameEngine?.inputManager?.keys.clear());
    report.probe=await page.evaluate(()=>window.__regionalProbe);
    await page.screenshot({path:`${output}/scene-${cells}.png`});
} catch(error) {report.errors.push({atMs:Date.now()-start,message:String(error.stack??error)});}
finally {
    report.elapsedMs=Date.now()-start;
    fs.writeFileSync(`${output}/probe-${cells}.json`,JSON.stringify(report,null,2));
    await browser.close();log.end();
}
console.log(JSON.stringify({cells,elapsedMs:report.elapsedMs,errors:report.errors,losses:report.probe?.losses,last:report.samples.at(-1)},null,2));
if (report.errors.length || report.probe?.losses.length) process.exitCode=1;
