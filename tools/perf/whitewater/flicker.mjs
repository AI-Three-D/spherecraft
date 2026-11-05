// node flicker.mjs CONFIG.json: temporal flicker of the water at fixed poses.
// The page's clock and requestAnimationFrame are taken over, so frames are exact
// steps (config.stepsMs, e.g. 33.33 for the game's 30 FPS when still) and repeat.
// Per run, over pixels that foam at some point:
//   hf     mean |L(t-1) - 2 L(t) + L(t+1)| / 2: smooth motion is small, flicker is not
//   d1     mean |L(t) - L(t-1)|: all change, motion included
//   blinks share of pixels per frame that go off and on again (or on and off) in 2 frames
//   cover  foam coverage, its std over time, and the period (s) of its strongest beat
// config: { root, out, views: [...], stepsMs: [33.33], frames: 60, urlExtra, parts: [{ name, off }], minTop }
// minTop: brightness a pixel must reach to count (default 165: foam; 0: all water, read it by rows).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), root = config.root;
const { readPng } = await import(path.join(root, 'tools/perf/riverMetrics/png.js'));
const req = createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), '8232', root], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let browser;
const luminance = (im) => { const n = im.w * im.h, L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.2126 * im.px[i * 3] + 0.7152 * im.px[i * 3 + 1] + 0.0722 * im.px[i * 3 + 2]; return L; };
function analyse(ims, stepMs, minTop = 165) {
    const n = ims[0].w * ims[0].h, T = ims.length, Ls = ims.map(luminance), meanG = new Float32Array(n), meanB = new Float32Array(n), top = new Float32Array(n);
    ims.forEach((im, t) => { for (let i = 0; i < n; i++) { meanG[i] += im.px[i * 3 + 1] / T; meanB[i] += im.px[i * 3 + 2] / T; top[i] = Math.max(top[i], Ls[t][i]); } });
    const idx = [];
    for (let i = 0; i < n; i++) if (meanB[i] >= 0.72 * meanG[i] && top[i] > minTop) idx.push(i);
    let hf = 0, d1 = 0, blinks = 0, count = 0;
    const cover = new Float32Array(T), on = 150;
    for (let t = 0; t < T; t++) { let c = 0; for (const i of idx) if (Ls[t][i] > on) c++; cover[t] = c / Math.max(idx.length, 1); }
    for (let t = 1; t < T - 1; t++) for (const i of idx) {
        const a = Ls[t - 1][i], b = Ls[t][i], c = Ls[t + 1][i];
        hf += Math.abs(a - 2 * b + c) / 2; d1 += Math.abs(b - a); count++;
        if ((a > on) === (c > on) && (b > on) !== (a > on)) blinks++;
    }
    // Where it is: hf per pixel as a heat map, and by rows of the image (far at the top).
    const { w, h } = ims[0], map = new Float32Array(n);
    for (let t = 1; t < T - 1; t++) for (const i of idx) map[i] += Math.abs(Ls[t - 1][i] - 2 * Ls[t][i] + Ls[t + 1][i]) / 2 / (T - 2);
    const bands = [0, 0, 0, 0], counts = [0, 0, 0, 0];
    for (const i of idx) { const b = Math.min(3, Math.floor(i / w / h * 4)); bands[b] += map[i]; counts[b]++; }
    analyse.map = { w, h, map };
    const byRows = bands.map((x, k) => +(x / Math.max(counts[k], 1)).toFixed(2));
    const mean = cover.reduce((s, x) => s + x, 0) / T, std = Math.sqrt(cover.reduce((s, x) => s + (x - mean) ** 2, 0) / T);
    let best = 0, period = 0;
    for (let k = 1; k < T / 2; k++) { let re = 0, im = 0; for (let t = 0; t < T; t++) { const w = 2 * Math.PI * k * t / T; re += (cover[t] - mean) * Math.cos(w); im += (cover[t] - mean) * Math.sin(w); } const p = Math.hypot(re, im) / T; if (p > best) { best = p; period = T * stepMs / 1000 / k; } }
    return { pixels: idx.length, hf: +(hf / count).toFixed(3), d1: +(d1 / count).toFixed(3), blinksPct: +(100 * blinks / count).toFixed(3), cover: +mean.toFixed(4), coverStd: +std.toFixed(5), beat: +best.toFixed(5), beatS: +period.toFixed(3), byRows };
}
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
    const report = { runs: [] };
    for (const view of config.views) {
        await page.evaluate(async (v, settleMs) => { const q = await import('/tools/perf/waterStepReview/qualityScene.js'); if (v.river != null) await q.riverView(v.river, v.fraction, { height: v.height ?? 30, back: v.back ?? 45, side: v.side ?? 0 }); else await q.poseView(v); await new Promise(r => setTimeout(r, settleMs)); }, view, config.settleMs ?? 9000);
        // From here the page runs on the steps below.
        await page.evaluate(async () => {
            if (window.__ff) return;
            let virt = performance.now(), pending = null;
            performance.now = () => virt;
            window.requestAnimationFrame = (cb) => { pending = cb; return 1; };
            window.cancelAnimationFrame = () => { pending = null; };
            while (!pending) await new Promise(r => setTimeout(r, 5));
            const g = window.gameEngine, queue = g.renderer.backend.device.queue;
            window.__ff = { step: async (ms) => {
                virt += ms;
                const cb = pending; pending = null; cb(virt);
                while (!pending || g._renderInFlight) await new Promise(r => setTimeout(r, 1));
                await queue.onSubmittedWorkDone();
            } };
        });
        for (const stepMs of config.stepsMs ?? [33.33]) for (const part of config.parts ?? [{ name: 'all', off: {} }]) {
            await page.evaluate(off => { if (window.gameEngine.whitewater) window.gameEngine.whitewater.debugOff = off; }, part.off);
            await page.evaluate(async (ms) => { for (let i = 0; i < 20; i++) await window.__ff.step(ms); }, stepMs);
            const ims = [];
            for (let t = 0; t < (config.frames ?? 60); t++) {
                await page.evaluate(ms => window.__ff.step(ms), stepMs);
                const buf = await page.screenshot({ type: 'png' });
                ims.push(readPng(Buffer.from(buf)));
                if (t === 0 && config.out) { fs.mkdirSync(config.out, { recursive: true }); fs.writeFileSync(path.join(config.out, `${view.name}-${Math.round(1000 / stepMs)}fps-${part.name}.png`), buf); }
            }
            const r = { view: view.name, fps: Math.round(1000 / stepMs), part: part.name, ...analyse(ims, stepMs, config.minTop) };
            report.runs.push(r); console.log(JSON.stringify(r));
            if (config.out) {
                const { w, h, map } = analyse.map, px = new Uint8Array(w * h * 3), { writePng } = await import(path.join(root, 'tools/perf/riverMetrics/png.js'));
                for (let i = 0; i < w * h; i++) { const v = Math.min(255, map[i] * 16); px[i * 3] = v; px[i * 3 + 1] = v * 0.6; px[i * 3 + 2] = 30; }
                fs.writeFileSync(path.join(config.out, `${view.name}-${r.fps}fps-${part.name}-hf.png`), writePng(w, h, px));
            }
        }
    }
    report.gpuErrors = await page.evaluate(() => window.__lr.gpuErrors.slice(0, 3));
    if (config.report) fs.writeFileSync(config.report, JSON.stringify(report, null, 1));
    console.log('gpuErrors', report.gpuErrors.length);
} finally { await browser?.close(); server.kill(); }
