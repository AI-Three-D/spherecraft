// River widths as they reach the screen, not as the bake says: node drawnWidths.mjs CONFIG.json
// At perRiver stations on every baked river, clear of its lakes, the camera looks
// straight down from heightM over the water with the river running up the screen, and two frames
// are taken: as is, and dry (water debug 10). Water is where they differ. Its run across the
// centre rows, in metres from the view's scale. Shallows too clear to see do not count: this is
// what the eye gets. config: { root, out, views: [poses that bake the area], perRiver, skipEndM,
// heightM, maxStations, minDiff }
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
const H = config.heightM ?? 120, W = 1440, HT = 900, minDiff = config.minDiff ?? 30;
let browser;
try {
    await sleep(600);
    browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: W, height: HT, deviceScaleFactor: 1 }, protocolTimeout: 900000,
        userDataDir: '/private/tmp/spherecraft-river-20261029', args: ['--enable-unsafe-webgpu', '--enable-gpu', '--enable-webgpu-developer-features', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const page = await browser.newPage();
    for (const f of ['lakeRecovery/pageInstrument.js', 'terrainDetail/gpuTimer.js']) await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf', f), 'utf8'));
    await page.goto('http://127.0.0.1:8232/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&waterPrecompute=1&lodHeight=ground', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true && window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 900000, polling: 500 });
    await page.evaluate(() => { const g = window.gameEngine, w = g.renderer.weatherController; w._pickNewWeatherTarget = () => {}; w.setWeather('clear', true); window.__lr.daylightAt([-1, 0, 0], .75);
        const st = document.createElement('style'); st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}'; document.head.appendChild(st); });
    for (const v of config.views) await page.evaluate(async (v) => { const q = await import('/tools/perf/waterStepReview/qualityScene.js'); await q.poseView(v); }, v);
    const stations = await page.evaluate(async ({ perRiver, skipEndM }) => {
        const { sampleRiverField } = await import('/core/world/water/riverField.js');
        const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, w = g.waterGpuData, L = svc.layout, out = [];
        const unit = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
        for (const [id, rec] of s.riverRecs) {
            if (!svc.rivers.has(id)) continue;
            const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec), total = arc[n - 1];
            // Per river, not per metre: long rivers are the wide ones, and a typical river is
            // counted once. Evenly along what lies clear of its lakes.
            const clear = [];
            for (let k = 1; k < n - 1; k++) {
                if (arc[k] < skipEndM || total - arc[k] < skipEndM || P[k * st + 9] < -0.5) continue;
                const d = unit([P[k * st], P[k * st + 1], P[k * st + 2]]), f = sampleRiverField(svc.pages, L, d);
                if (!f || !(f.sdf > 0) || w.lakeEdgeAt?.(d)?.inside > -25) continue;
                clear.push({ id, s: Math.round(arc[k]), of: Math.round(total), d, t: unit([0, 1, 2].map(c => P[(k + 1) * st + c] - P[(k - 1) * st + c])), W: f.W, trace: 2 * P[k * st + 4] });
            }
            for (let i = 0; i < perRiver && clear.length; i++) out.push(clear[Math.floor((i + 0.5) / perRiver * clear.length)]);
        }
        return out;
    }, { perRiver: config.perRiver ?? 2, skipEndM: config.skipEndM ?? 40 });
        const take = config.maxStations ?? 90, list = stations.slice(0, take);
    console.log(JSON.stringify({ stations: stations.length, taking: list.length }));
    const R = await page.evaluate(() => window.gameEngine.waterGpuData.R), mPerPx = 2 * H * Math.tan(37.5 * Math.PI / 180) / HT, rows = [];
    const dirOut = path.join(config.out, 'shots'); fs.mkdirSync(dirOut, { recursive: true });
    for (const [i, q] of list.entries()) {
        const pos = q.d.map(v => v * (R + q.W + H)), look = q.d.map(v => v * (R + q.W));
        try {
            await page.evaluate(async (v) => { const m = await import('/tools/perf/waterStepReview/qualityScene.js'); const vec = a => ({ x: a[0], y: a[1], z: a[2] });
                window.qtDiag.regional.useCamera({ position: vec(v.pos), target: vec(v.look), up: vec(v.up), fov: 75 }); window.__lr.daylightAt(v.d, .75); await m.settle(25000); await new Promise(r => setTimeout(r, 2600)); }, { pos, look, up: q.t, d: q.d });
        } catch (e) { rows.push({ ...q, d: undefined, t: undefined, failed: String(e).slice(0, 80) }); continue; }
        const a = readPng(await page.screenshot({ type: 'png' }));
        await page.evaluate(async () => { window.gameEngine.setWaterDebugMode(10); await new Promise(r => setTimeout(r, 350)); });
        const b = readPng(await page.screenshot({ type: 'png' }));
        await page.evaluate(() => window.gameEngine.setWaterDebugMode(0));
        if (i % 6 === 0) fs.writeFileSync(path.join(dirOut, `s${i}-${q.id}-${q.s}.png`), await page.screenshot({ type: 'png' }));
        const widths = [];
        for (let y = HT / 2 - 90; y <= HT / 2 + 90; y += 15) {
            const wet = (x) => { const k = (y * a.w + x) * 3; return Math.abs(a.px[k] - b.px[k]) + Math.abs(a.px[k + 1] - b.px[k + 1]) + Math.abs(a.px[k + 2] - b.px[k + 2]) > minDiff; };
            // The run nearest the centre.
            let c = -1;
            for (let m = 0; m < 200 && c < 0; m++) for (const x of [W / 2 + m, W / 2 - m]) if (wet(x)) { c = x; break; }
            if (c < 0) { widths.push(0); continue; }
            let lo = c, hi = c, gap = 0;
            for (let x = c; x < W - 1; x++) { if (wet(x)) { hi = x; gap = 0; } else if (++gap > 6) break; }
            gap = 0;
            for (let x = c; x > 0; x--) { if (wet(x)) { lo = x; gap = 0; } else if (++gap > 6) break; }
            widths.push((hi - lo + 1) * mPerPx);
        }
        widths.sort((u, v) => u - v);
        rows.push({ id: q.id, s: q.s, of: q.of, trace: +q.trace.toFixed(1), drawn: +widths[widths.length >> 1].toFixed(1), min: +widths[0].toFixed(1), max: +widths.at(-1).toFixed(1) });
        fs.writeFileSync(path.join(config.out, 'widths.json'), JSON.stringify(rows, null, 0));
    }
    const ok = rows.filter(r => r.drawn !== undefined), byRiver = new Map();
    for (const r of ok) byRiver.set(r.id, [...(byRiver.get(r.id) ?? []), r.drawn]);
    const v = [...byRiver.values()].map(a => a.reduce((x, y) => x + y, 0) / a.length).sort((a, b) => a - b), q = p => v.length ? +v[Math.floor(p * (v.length - 1))].toFixed(1) : null;
    console.log(JSON.stringify({ rivers: v.length, stations: ok.length, failed: rows.length - ok.length, p10: q(.1), p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.9), max: q(1), under10: +(v.filter(x => x < 10).length / v.length).toFixed(2), under16: +(v.filter(x => x < 16).length / v.length).toFixed(2), under24: +(v.filter(x => x < 24).length / v.length).toFixed(2) }));
} finally { await browser?.close(); server.kill(); }
