// node surge.mjs CONFIG.json: what the water does on arriving at a place. Forgets every
// block at each pose, then steps exact frames on a virtual clock (as flicker.mjs),
// recording wwSurge and a frame at each of config.times (s), once per arm.
// config: { root, out, views, arms: [{ name, config }], stepMs, times, urlExtra, settleMs }
// arms' config goes over whitewater.config. Summary per view and arm: the worst after
// shownAfterS (blocks have faded in by then).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), root = config.root;
const req = createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), '8232', root], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let browser;
try {
    await sleep(600);
    browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900000,
        userDataDir: '/private/tmp/spherecraft-river-20261029', args: ['--enable-unsafe-webgpu', '--enable-gpu', '--enable-webgpu-developer-features', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const page = await browser.newPage();
    for (const f of ['lakeRecovery/pageInstrument.js', 'terrainDetail/gpuTimer.js']) await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf', f), 'utf8'));
    await page.goto('http://127.0.0.1:8232/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&waterPrecompute=1&lodHeight=ground' + (config.urlExtra ?? ''), { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true && window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 600000, polling: 500 });
    await page.evaluate(() => { const g = window.gameEngine, w = g.renderer.weatherController; w._pickNewWeatherTarget = () => {}; w.setWeather('clear', true); window.__lr.daylightAt([-1, 0, 0], .75);
        const st = document.createElement('style'); st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}'; document.head.appendChild(st);
        g.engineConfig.rendering.adaptive.enabled = false; g.engineConfig.rendering.pixelRatio = 1.5; g.engineConfig.rendering.maxFps = 0; g.adaptiveQuality.pixelRatio = 1.5; g.adaptiveQuality.reset(); g.handleResize(); });
    // The clock: real until hold(), then stepped; release() goes on from where it got to,
    // since tiles only stream with frames running.
    await page.evaluate(() => {
        const real = performance.now.bind(performance), raf = window.requestAnimationFrame.bind(window);
        let offset = 0, virt = null, pending = null;
        performance.now = () => virt ?? real() + offset;
        const g = window.gameEngine, queue = g.renderer.backend.device.queue;
        window.__ff = {
            hold: async () => { virt = real() + offset; window.requestAnimationFrame = (cb) => { pending = cb; return 1; }; while (!pending) await new Promise(r => setTimeout(r, 5)); },
            release: () => { offset = virt - real(); virt = null; window.requestAnimationFrame = raf; const cb = pending; pending = null; if (cb) raf(cb); },
            step: async (ms) => { virt += ms; const cb = pending; pending = null; cb(virt); while (!pending || g._renderInFlight) await new Promise(r => setTimeout(r, 1)); await queue.onSubmittedWorkDone(); },
        };
    });
    const step = config.stepMs ?? 33.33, shownAfter = config.shownAfterS ?? 2.5, summary = [];
    fs.mkdirSync(config.out, { recursive: true });
    for (const view of config.views) {
        await page.evaluate(async (v, settleMs) => { const q = await import('/tools/perf/waterStepReview/qualityScene.js'); if (v.river != null) await q.riverView(v.river, v.fraction, { height: v.height ?? 30, back: v.back ?? 45, side: v.side ?? 0 }); else await q.poseView(v); await new Promise(r => setTimeout(r, settleMs)); }, view, config.settleMs ?? 3000);
        for (const arm of config.arms ?? [{ name: 'as-is', config: {} }]) {
            await page.evaluate(async (c) => { await window.__ff.hold(); const w = window.gameEngine.whitewater; Object.assign(w.config, c); w._reset(); }, arm.config);
            const rows = [];
            let done = 0;
            for (const t of config.times) {
                const frames = Math.round((t * 1000 - done) / step);
                const r = await page.evaluate(async (n, ms, along) => { for (let i = 0; i < n; i++) await window.__ff.step(ms); const m = await import('/tools/perf/whitewater/wwProbe.js'); const out = await m.wwSurge({}); if (along) out.along = await m.wwAlong(along); return out; }, frames, step, config.along ?? null);
                done += frames * step;
                if ((config.shotAt ?? []).includes(t)) await page.screenshot({ path: path.join(config.out, `${view.name}-${arm.name}-t${t}.png`) });
                rows.push({ t, ...r });
            }
            if (config.rises) console.log('RISES ' + JSON.stringify(await page.evaluate(async () => (await import('/tools/perf/whitewater/wwProbe.js')).wwRiseCells({}))));
            await page.evaluate(() => window.__ff.release());
            const late = rows.filter(r => r.t >= shownAfter && r.still?.n > 50), worst = (f) => late.length ? +Math.max(...late.map(f)).toFixed(3) : null;
            const line = { view: view.name, arm: arm.name, blocks: rows.at(-1).active, stillCells: rows.at(-1).still?.n ?? 0, rise: worst(r => r.still.p99), drop: worst(r => -r.still.p1), steep: worst(r => r.still.slope99), moved: worst(r => r.still.moved99), riverMoved: worst(r => r.river?.moved99 ?? 0), riverSpeed: rows.at(-1).river?.speed };
            summary.push(line); console.log(JSON.stringify(line));
            if (config.rows) console.log(JSON.stringify(rows.map(r => ({ t: r.t, front: r.front, river: r.river?.moved99, still: r.still?.moved99, speed: r.river?.speed, baked: r.river?.baked, rms: r.river?.rms, mean: r.river?.mean, along: r.along }))));
        }
    }
    fs.writeFileSync(path.join(config.out, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log('gpuErrors', (await page.evaluate(() => window.__lr.gpuErrors.slice(0, 3))).length);
} finally { await browser?.close(); server.kill(); }
