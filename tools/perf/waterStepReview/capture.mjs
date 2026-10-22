// Frozen-scene water diagnostics. No production edits.
// node tools/perf/waterStepReview/capture.mjs OUTPUT_DIR [VIEW_NAMES_CSV] [contact]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readPng } from '../riverMetrics/png.js';
import { compareImages } from './analyze.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.resolve(process.argv[2]);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('Output directory must be empty');
fs.mkdirSync(out, { recursive: true });
const requested = process.argv[3]?.split(',');
const finalLakeMode = process.argv[4] === 'final-lake';
const indexedOnly=process.env.WATER_INDEXED_LOOKUP==='1';
const sparse=process.env.WATER_SPARSE_MASK==='1';
const timingFrames=Number(process.env.WATER_TIMING_FRAMES??4);
const maskMode = process.argv[4] === 'mask';
const prototypeMode = process.argv[4] === 'connected' || maskMode || finalLakeMode;
const contactMode = process.argv[4] === 'contact' || prototypeMode;
const configuredViews = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url)));
if(finalLakeMode) {
    const star=configuredViews.find(v=>v.name==='o4-star');
    configuredViews.push({...star,name:'o4-star-lod-coarse',lodErrorThreshold:768,lakeBody:633},
        {...star,name:'o4-star-lod-fine',lodErrorThreshold:256,lakeBody:633},
        {...star,name:'o4-star-small-window',lodErrorThreshold:512,lakeBody:633,viewport:{width:960,height:600,deviceScaleFactor:2}},
        {...star,name:'o4-star-small-window-shore',lodErrorThreshold:512,lakeBody:633,shoreLod:true,viewport:{width:960,height:600,deviceScaleFactor:2}},
        {...star,name:'o4-star-small-window-shore9',lodErrorThreshold:512,lakeBody:633,shoreLod:true,shoreDepth:9,viewport:{width:960,height:600,deviceScaleFactor:2}},
        {...star,name:'o4-star-cache-rebuild',lodErrorThreshold:256,lakeBody:633,evictWaterCache:true});
}
const views = configuredViews
    .filter(v => !requested || requested.includes(v.name));
if (!views.length) throw new Error('No views selected');
const req = createRequire(path.join(root, '../terrain-lab/package.json'));
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));
const report = { startedAt: new Date().toISOString(), views: [], errors: [], gpuErrors: [],
    scope: 'Frozen scene, profile guard on/off/on. Ownership is a river-only diagnostic, not a shoreline or world-connectivity proof.' };
if (contactMode) report.scope = 'Visible near-water shoreline contact against exported rendered terrain triangles; production coverage unchanged.';
if (prototypeMode) report.scope = 'Static connected triangle coverage prototype, cloned materials, same frozen geometry before/after/restored.';
if (maskMode) report.scope = 'Cached body mask and lower-surface ownership experiment; frozen mesh producer, no production integration or LOD-stability claim.';
if (finalLakeMode) report.scope = 'Fixed final-height lake shore source and cache; opt-in publication; active terrain LOD is independent of source data.';
report.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
report.productionSourceSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'core/renderer/water/nearWaterSurface.wgsl.js'))).digest('hex');
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), '8199', root], { stdio: 'ignore' });
let browser;
try {
    await sleep(600);
    browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        protocolTimeout: 900000,
        args: ['--enable-unsafe-webgpu', '--enable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    const page = await browser.newPage();
    page.on('pageerror', e => report.errors.push(String(e)));
    page.on('console', m => {
        const text = m.text();
        if (m.type() === 'error') console.log(text.slice(0, 1200));
        if (/\[Water\].*(ready|precompute|mountain)/i.test(text)) console.log(text.slice(0, 240));
    });
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/lakeRecovery/pageInstrument.js'), 'utf8'));
    report.url = 'http://127.0.0.1:8199/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1';
    await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true &&
        window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 600000 });
    await page.evaluate(() => {
        const g = window.gameEngine, w = g.renderer.weatherController;
        w._pickNewWeatherTarget = () => {}; w.setWeather('clear', true);
        window.__lr.daylightAt([-1, 0, 0], 0.75);
        const st = document.createElement('style');
        st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}';
        document.head.appendChild(st);
    });
    for (const view of views) {
        const record = { ...view };
        if(view.viewport)await page.setViewport(view.viewport);
        report.views.push(record); save();
        console.log(JSON.stringify({ view: view.name, status: 'settling' }));
        await page.evaluate(v => {
            if(v.lodErrorThreshold)window.gameEngine.engineConfig.gpuQuadtree.lodErrorThreshold=v.lodErrorThreshold;
            if(v.evictWaterCache){window.__finalLakeCache?.heights.clear();window.__finalLakeCache?.masks.clear();}
            const o = window.gameEngine.planetConfig.origin;
            const d = v.pos.map((x, i) => x - [o.x, o.y, o.z][i]), l = Math.hypot(...d);
            window.qtDiag.regional.useCamera({ position: { x: v.pos[0], y: v.pos[1], z: v.pos[2] },
                target: { x: v.look[0], y: v.look[1], z: v.look[2] },
                up: { x: d[0] / l, y: d[1] / l, z: d[2] / l }, fov: 75 });
        }, view);
        if(view.shoreLod)record.shoreLod=await page.evaluate(async depth=>{
            if(!window.__lastFinalLakeMetadata)throw new Error('Capture the unmodified small-window view first');
            return (await import('/tools/perf/waterStepReview/shoreLod.js')).installShoreLod(window.__lastFinalLakeMetadata,{depth});
        },view.shoreDepth??10);
        if(process.env.WATER_PLAY_AUDIT==='1' && report.views.length===1) {
            record.playAudit=await page.evaluate(async v=>(await import('/tools/perf/waterStepReview/playAudit.js')).auditPlay(v),view);
            save();
        }
        // Trace the same nearby candidates as the previous diagnostic harness.
        record.traced = await page.evaluate(async nearM => {
            const g = window.gameEngine, s = g.waterService, o = g.planetConfig.origin, p = g.camera.position;
            const rel = [p.x - o.x, p.y - o.y, p.z - o.z], l = Math.hypot(...rel), dir = rel.map(x => x / l);
            const near = s.rivers.map(r => ({ id: r.id, m: s._riverDistance(r.id, dir) }))
                .filter(r => r.m <= nearM).sort((a, b) => a.m - b.m).slice(0, 8);
            for (const r of near) {
                for (let i = 0; i < 1800 && !s.riverRecs.has(r.id) && !s._failedRivers.has(r.id); i++) {
                    if (i % 20 === 0 && !s._busy) s.refineRiver(r.id);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                r.traced = s.riverRecs.has(r.id);
            }
            return near;
        }, view.traceNearM ?? 2500);
        record.traceComplete = record.traced.every(r => r.traced);
        if (!record.traceComplete) {
            record.coverageWarning = 'Some requested nearby rivers did not trace. Capture the resident scene, but exclude this pose from complete regression coverage.';
            console.log(JSON.stringify({ view: view.name, status: 'incomplete-traces', ids: record.traced.filter(r => !r.traced).map(r => r.id) }));
        }
        // Require a sustained idle period, including hydrology and pending regenerations.
        await page.waitForFunction(() => {
            const r = window.__lr.residency(), g = window.gameEngine;
            const idle = r?.visibleTiles > 0 && r.exactVisibleRatio === 1 && r.pendingGenerations === 0 &&
                r.activeGenerations === 0 && r.pendingCopies === 0 && !g.waterService._busy &&
                g.waterService._client._pending.size === 0 && g.renderer.quadtreeTileManager.tileStreamer.getRegenerationStats().pending === 0;
            if (!idle) { window.__waterStepIdleAt = 0; return false; }
            window.__waterStepIdleAt ||= performance.now();
            return performance.now() - window.__waterStepIdleAt > 2000;
        }, { timeout: 240000, polling: 150 });
        record.beforeState = await page.evaluate(async () => {
            const g = window.gameEngine, f = g.renderer, tm = f.quadtreeTileManager, w = g.waterGpuData, n = f.nearWaterRenderer;
            const saved = { update: g.update, render: g.render, terrainUpdate: tm.update, feedback: tm.resolveFeedbackReadback };
            g.update = () => {}; g.render = () => {};
            while (g._renderInFlight) await new Promise(r => setTimeout(r, 10));
            await f.backend.device.queue.onSubmittedWorkDone();
            tm.update = () => {}; tm.resolveFeedbackReadback = () => {};
            // Sky/cloud shaders read wall time even when game deltaTime is 0.
            // Hold that clock too so the normal A/B/A can be pixel-identical.
            const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
            const frozenNow = performance.now();
            Object.defineProperty(performance, 'now', { configurable: true, value: () => frozenNow });
            n._ensure();
            const original = n._riverMaterial, variant = original.clone();
            const guard = 'if (hit.profileM >= hit.etaM) { discard; }';
            if (variant.fragmentShader.split(guard).length !== 2) throw new Error('Expected exactly one profile guard');
            variant.fragmentShader = variant.fragmentShader.replace(guard, '');
            const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
            const shaderHashes = { before: await hash(original.fragmentShader), after: await hash(variant.fragmentShader) };
            const state = () => {
                // Readback age advances while deliberately retaining the same
                // terrain. Compare resident data, not time since its readback.
                const { visibleReadbackAgeMs: _age, ...residency } = window.__lr.residency();
                return { version: w._appliedVersion, serviceVersion: g.waterService.version,
                    regeneration: tm.tileStreamer.getRegenerationStats(), residency,
                    quads: n._quadCount, lakes: [...n._lakes], pose: window.__lr.pose(),
                    selectedDepths:(tm._lastVisibleTiles??[]).reduce((a,t)=>(a[t.depth]=(a[t.depth]??0)+1,a),{}) };
            };
            const tint = mode => {
                w.debugMode = mode;
                new Uint32Array(w.paramsData)[2] = mode;
                f.backend.device.queue.writeBuffer(w.paramsBuffer, 0, w.paramsData);
            };
            window.__waterStep = { original, variant, state, tint,
                draw: async (frames=4) => { for (let i = 0; i < frames; i++) await saved.render.call(g, 0); await f.backend.device.queue.onSubmittedWorkDone(); },
                restore: () => {
                    n._riverMaterial = original; tint(0);
                    g.update = saved.update; g.render = saved.render;
                    tm.update = saved.terrainUpdate; tm.resolveFeedbackReadback = saved.feedback;
                    if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
                    else delete performance.now;
                    variant.dispose(); delete window.__waterStep;
                    window.__waterStepIdleAt = 0;
                },
            };
            window.__waterStep.shaderHashes = shaderHashes;
            return state();
        });
        record.shaderHashes = await page.evaluate(() => window.__waterStep.shaderHashes);
        const shot = async name => {
            await page.evaluate(() => window.__waterStep.draw());
            await page.screenshot({ path: path.join(out, `${view.name}-${name}.png`) });
        };
        const timeDraw = () => page.evaluate(async frames => {
            await window.__waterStep.draw();await window.__waterStep.draw();
            const ms=[];for(let i=0;i<12;i++){const start=Date.now();await window.__waterStep.draw(frames);ms.push((Date.now()-start)/frames);}
            return {fencedMsPerFrame:ms,medianMs:[...ms].sort((a,b)=>a-b)[6],framesPerBatch:frames,batches:12};
        },timingFrames);
        try {
            await shot('before');
            if(prototypeMode)record.beforeTiming=await timeDraw();
            const originalCanvas=maskMode?await page.evaluate(()=>document.getElementById('gameCanvas').toDataURL().split(',')[1]):null;
            if (contactMode) {
                let contact = await page.evaluate(async options => (await import('/tools/perf/waterStepReview/contactCapture.js')).captureContact(options),{retainGeometry:prototypeMode,anchorWorld:view.anchorWorld});
                if(contact.surfaceIdsPng) {
                    fs.writeFileSync(path.join(out,`${view.name}-surface-ids.png`),Buffer.from(contact.surfaceIdsPng,'base64'));delete contact.surfaceIdsPng;
                }
                if(prototypeMode) {
                    fs.writeFileSync(path.join(out, `${view.name}-before-contact.json`),JSON.stringify(contact));
                    const {edges,...baseline}=contact;record.beforeContact=baseline;
                    if(maskMode&&view.name==='o4-star') {
                        await page.evaluate(async id=>(await import('/tools/perf/waterStepReview/connectedPrototype.js')).installConnectedCoverage(id),contact.examples.lake.body);
                        const audit=await page.evaluate(async ()=>(await import('/tools/perf/waterStepReview/contactCapture.js')).captureContact({compareToRetained:true,auditCoverage:true}));
                        fs.writeFileSync(path.join(out,`${view.name}-previous-prototype-audit.json`),JSON.stringify(audit));
                        await page.evaluate(()=>window.__connectedPrototype.restore());
                    }
                    record.prototype=await page.evaluate(async ({id,maskMode,finalLakeMode})=>finalLakeMode?
                        (await import('/tools/perf/waterStepReview/finalHeightLake.js')).installFinalHeightLake(id):maskMode?
                        (await import('/tools/perf/waterStepReview/maskPrototype.js')).installMaskCoverage(id):
                        (await import('/tools/perf/waterStepReview/connectedPrototype.js')).installConnectedCoverage(id),{id:view.lakeBody??contact.examples.lake.body,maskMode,finalLakeMode});
                    if(maskMode) {
                        const probe=await page.evaluate(()=>window.__connectedPrototype.lookupOnly(async()=>{
                            await window.__waterStep.draw();await window.__waterStep.draw();const ms=[];
                            for(let i=0;i<12;i++){const start=Date.now();await window.__waterStep.draw();ms.push((Date.now()-start)/4);}
                            return {fencedMsPerFrame:ms,medianMs:[...ms].sort((a,b)=>a-b)[6],framesPerBatch:4,batches:12,
                                png:document.getElementById('gameCanvas').toDataURL().split(',')[1]};
                        }));
                        const {png,...timing}=probe;record.lookupOnlyTiming=timing;
                        record.lookupOnlyImage=compareImages(readPng(Buffer.from(originalCanvas,'base64')),readPng(Buffer.from(png,'base64')));
                    }
                    await shot('after');
                    if(finalLakeMode&&(indexedOnly||sparse)) {
                        record.unindexedTiming=await timeDraw();
                        const reference=await page.evaluate(()=>document.getElementById('gameCanvas').toDataURL().split(',')[1]);
                        await page.evaluate(()=>window.__connectedPrototype.restore());
                        record.prototype=await page.evaluate(async ({id,indexedOnly,sparse})=>(await import('/tools/perf/waterStepReview/finalHeightLake.js')).installFinalHeightLake(id,{indexedOnly,sparse}),{id:record.prototype.body,indexedOnly,sparse});
                        await shot('after');
                        const candidate=await page.evaluate(()=>document.getElementById('gameCanvas').toDataURL().split(',')[1]);
                        record.indexedImageComparison=compareImages(readPng(Buffer.from(reference,'base64')),readPng(Buffer.from(candidate,'base64')));
                    }
                    record.afterTiming=await timeDraw();
                    contact=await page.evaluate(async auditCoverage=>(await import('/tools/perf/waterStepReview/contactCapture.js')).captureContact({compareToRetained:true,auditCoverage,auditDepth:auditCoverage}),finalLakeMode);
                }
                if(view.anchorWorld) contact.anchor={water:view.anchorWorld,ground:view.anchorGround};
                fs.writeFileSync(path.join(out, `${view.name}-contact.json`), JSON.stringify(contact));
                const { edges, ...summary } = contact;
                record.contact = summary;
                await page.evaluate(data => {
                    const game = document.getElementById('gameCanvas'), rect = game.getBoundingClientRect();
                    const overlay = document.createElement('canvas'); overlay.id = 'contactOverlay';
                    overlay.width = data.width; overlay.height = data.height;
                    overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:99999;visibility:visible!important;pointer-events:none`;
                    document.body.appendChild(overlay);
                    const ctx = overlay.getContext('2d');
                    for (const edge of data.edges) {
                        if (!['hanging','unknown'].includes(edge.status)) continue;
                        ctx.fillStyle = edge.status === 'hanging' ? '#ff3158' : '#ffe15c';
                        ctx.fillRect(edge.x-1.5,edge.y-1.5,3,3);
                    }
                    const candidates = data.edges.filter(e => e.status === 'hanging' && e.kind === 'lake');
                    const marked = candidates.sort((a,b) => b.dropM-a.dropM)[0];
                    if (marked) {
                        const { x,y,dropM } = marked;
                        ctx.strokeStyle = '#ff4bff';ctx.lineWidth = 4;
                        ctx.beginPath();ctx.moveTo(x-100,y+70);ctx.lineTo(x,y);ctx.stroke();
                        ctx.beginPath();ctx.arc(x,y,12,0,2*Math.PI);ctx.stroke();
                        ctx.fillStyle = 'white';ctx.font = 'bold 24px sans-serif';
                        ctx.fillText(`A: lake drop ${dropM.toFixed(2)} m`,Math.max(8,x-310),Math.min(data.height-10,y+100));
                    }
                    if(data.anchor) {
                        const camera=window.gameEngine.renderer.camera;
                        const mul=(m,p)=>[0,1,2,3].map(r=>p.reduce((s,v,k)=>s+m.elements[k*4+r]*v,0));
                        const project=p=>{const q=mul(camera.projectionMatrix,mul(camera.matrixWorldInverse,[...p,1]));return [(q[0]/q[3]+1)*data.width/2,(1-q[1]/q[3])*data.height/2];};
                        const a=project(data.anchor.water),g=project(data.anchor.ground);
                        ctx.strokeStyle='#ffff00';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...g);ctx.stroke();
                        ctx.beginPath();ctx.arc(...a,12,0,2*Math.PI);ctx.stroke();ctx.fillStyle='white';
                        ctx.fillText('B: original point A',a[0]+18,a[1]-16);
                    }
                    ctx.fillStyle = '#111c';ctx.fillRect(12,12,750,48);ctx.fillStyle = 'white';ctx.font = '24px sans-serif';
                    ctx.fillText('Red: hanging edge   Yellow: unresolved   A: largest lake drop',24,44);
                }, contact);
                await page.screenshot({ path: path.join(out, `${view.name}-contact.png`) });
                if(view.terrainOnly) {
                    await page.evaluate(()=>{const n=window.gameEngine.renderer.nearWaterRenderer;window.__restoreNear=n.render;n.render=()=>{};});
                    await shot('terrain-only');
                    await page.evaluate(()=>{window.gameEngine.renderer.nearWaterRenderer.render=window.__restoreNear;delete window.__restoreNear;});
                }
                await page.evaluate(() => document.getElementById('contactOverlay').remove());
                if(prototypeMode)await page.evaluate(()=>window.__connectedPrototype.restore());
                await shot('replay');
                if(prototypeMode)record.replayTiming=await timeDraw();
            } else {
            await page.evaluate(() => { window.gameEngine.renderer.nearWaterRenderer._riverMaterial = window.__waterStep.variant; });
            await shot('after');
            await page.evaluate(() => { window.gameEngine.renderer.nearWaterRenderer._riverMaterial = window.__waterStep.original; });
            await shot('replay');
            await page.evaluate(() => {
                const f = window.gameEngine.renderer, saved = [], noop = () => {};
                const off = (o, k, val) => { if (!o) return; saved.push([o, k, Object.hasOwn(o, k), o[k]]); o[k] = val; };
                off(f.postProcessing, 'enabled', false); off(f.cloudRenderer, 'enabled', false);
                for (const r of [f.skyRenderer, f.starRenderer, f.moonRenderer, f.assetStreamer, f.particleSystem, f.skinnedMeshRenderer, f.genericMeshRenderer]) off(r, 'render', noop);
                off(f, '_renderAtmoBanks', noop);
                window.__waterStep.restoreOwner = () => { for (const [o, k, own, val] of saved.reverse()) { if (own) o[k] = val; else delete o[k]; } };
            });
            for (const variant of ['before', 'after']) {
                await page.evaluate(v => { const s = window.__waterStep; window.gameEngine.renderer.nearWaterRenderer._riverMaterial = v === 'before' ? s.original : s.variant; }, variant);
                for (const mode of [6, 7]) {
                    await page.evaluate(mode => window.__waterStep.tint(mode), mode);
                    await shot(`${variant}-own${mode}`);
                }
            }
            await page.evaluate(() => { window.__waterStep.restoreOwner(); window.__waterStep.tint(0); });
            }
            record.afterState = await page.evaluate(() => window.__waterStep.state());
            if (JSON.stringify(record.beforeState) !== JSON.stringify(record.afterState)) throw new Error('Frozen source state changed during A/B');
        } finally { await page.evaluate(async () => {await window.__connectedPrototype?.restore();window.__waterStep?.restore();delete window.__waterContactSource;}); }
        record.complete = true; save();
        console.log(JSON.stringify({ view: view.name, status: 'captured', version: record.beforeState.version }));
    }
    report.gpuErrors = await page.evaluate(() => window.__lr.gpuErrors);
    report.browserVersion = await browser.version();
} catch (error) {
    report.failure = String(error.stack ?? error); console.error(report.failure);
} finally {
    report.finishedAt = new Date().toISOString(); save();
    await browser?.close(); server.kill();
}
process.exitCode = report.failure || report.errors.length || report.gpuErrors.length ? 1 : 0;
