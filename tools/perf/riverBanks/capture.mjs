// tools/perf/riverBanks/capture.mjs
//
// One arm of a river-bank change: per pose a screenshot, the bank audit
// (bankAudit.js) and fenced frame timing (terrainDetail/scene.js), on the
// owner's configuration URL. Poses: the owner's failure views
// (waterStepReview/userFailures.json) and fixed mountain streams near the
// spawn: 453 (16 % mean slope, from an alpine lake) and 2562 (flat, from
// the highest lake within 40 km; terrainDetail/abDetail.mjs discovery).
// With --compare BASELINE_DIR, writes <pose>-before-after.png (baseline left).
// --poses FILE adds poses ({ name, pos, look } or { name, river, fraction });
// --url-extra appends to the URL (e.g. '&water=off&lodHeight=ground');
// --eval runs a page expression after loading (e.g.
// 'qtDiag.setTerrainFeatures({ waterCarve: false })'), awaited, then settles.
//
//   node tools/perf/riverBanks/capture.mjs OUT_DIR [--profile DIR] [--compare DIR] [--only a,b] [--poses FILE] [--url-extra S]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from '../riverMetrics/png.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || (fs.existsSync(out) && fs.readdirSync(out).length)) throw new Error('Usage: capture.mjs EMPTY_OUT_DIR [--profile DIR] [--compare DIR] [--only a,b]');
fs.mkdirSync(out, { recursive: true });
const only = arg('--only')?.split(','), compare = arg('--compare') && path.resolve(arg('--compare'));
const PORT = 8232;
const URL_PATH = '/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1' + (arg('--url-extra') ?? '');
const poses = [
    ...(arg('--poses') ? JSON.parse(fs.readFileSync(path.resolve(arg('--poses')), 'utf8')) : []),
    ...JSON.parse(fs.readFileSync(path.join(root, 'tools/perf/waterStepReview/userFailures.json'), 'utf8')),
    { name: 'steep-453-outlet', river: 453, fraction: 0.1, height: 35, back: -60 },
    { name: 'steep-453-middle', river: 453, fraction: 0.5 },
    { name: 'steep-453-mouth', river: 453, fraction: 0.96 },
    { name: 'plateau-2562-outlet', river: 2562, fraction: 0.04 },
    { name: 'plateau-2562-middle', river: 2562, fraction: 0.5 },
].filter(v => !only || only.includes(v.name));

const report = { startedAt: new Date().toISOString(), url: URL_PATH,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitDirty: execFileSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    poses: [], errors: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const req = createRequire(path.join(root, '../terrain-lab/package.json'));
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 600));
    browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900000,
        ...(arg('--profile') ? { userDataDir: path.resolve(arg('--profile')) } : {}),
        args: ['--enable-unsafe-webgpu', '--enable-gpu', '--enable-webgpu-developer-features', '--no-first-run', '--no-default-browser-check',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    const page = await browser.newPage();
    page.on('pageerror', e => report.errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text().slice(0, 600)); });
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/lakeRecovery/pageInstrument.js'), 'utf8'));
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/terrainDetail/gpuTimer.js'), 'utf8'));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}${URL_PATH}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true && window.gameEngine?.getLoadingStatus?.()?.complete,
        { timeout: 900000, polling: 500 });
    report.loadS = (Date.now() - t0) / 1000;
    await page.evaluate(() => {
        const g = window.gameEngine, w = g.renderer.weatherController;
        w._pickNewWeatherTarget = () => {}; w.setWeather('clear', true);
        window.__lr.daylightAt([-1, 0, 0], 0.75);
        const st = document.createElement('style');
        st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}';
        document.head.appendChild(st);
    });
    console.log(JSON.stringify({ loaded: report.loadS }));
    if (arg('--eval')) {
        report.eval = await page.evaluate(async (code) => {
            const r = await (0, eval)(code);
            await (await import('/tools/perf/waterStepReview/qualityScene.js')).settle(300000);
            return JSON.stringify(r ?? null).slice(0, 400);
        }, arg('--eval'));
    }

    for (const view of poses) {
        const rec = await page.evaluate(async (v) => {
            const q = await import('/tools/perf/waterStepReview/qualityScene.js');
            const placed = v.river != null
                ? await q.riverView(v.river, v.fraction, { height: v.height ?? 30, back: v.back ?? 45 }) : await q.poseView(v);
            await new Promise(r => setTimeout(r, 1000));
            return { name: v.name, pose: placed.pose ?? window.__lr.pose(), resident: placed.resident };
        }, view);
        await page.screenshot({ path: path.join(out, `${view.name}.png`) });
        // Terrain debug views (gameEngine.setTerrainDebugMode), e.g. 13 tile
        // instances, 15 own LOD vs the LOD the material is sampled from;
        // w<N>: water debug views (setWaterDebugMode), e.g. w6 who draws.
        for (const mode of (arg('--debug-modes') ?? '').split(',').filter(Boolean)) {
            await page.evaluate(m => (m.startsWith('w') ? window.gameEngine.setWaterDebugMode(Number(m.slice(1)))
                : window.gameEngine.setTerrainDebugMode(Number(m))), mode);
            await new Promise(r => setTimeout(r, 800));
            await page.screenshot({ path: path.join(out, `${view.name}-dbg${mode}.png`) });
            await page.evaluate(m => (m.startsWith('w') ? window.gameEngine.setWaterDebugMode(0) : window.gameEngine.setTerrainDebugMode(0)), mode);
        }
        if (arg('--debug-modes')) await new Promise(r => setTimeout(r, 500));
        // --regenerate: every resident tile generated again with the scene as
        // it is now; tiles made earlier (e.g. before the water data) show.
        if (process.argv.includes('--regenerate')) {
            rec.regenerated = await page.evaluate(async () => {
                const n = window.gameEngine.renderer.quadtreeTileManager.tileStreamer.regenerateTiles(() => true);
                await new Promise(r => setTimeout(r, 1000));
                await (await import('/tools/perf/waterStepReview/qualityScene.js')).settle(300000);
                return n;
            });
            await page.screenshot({ path: path.join(out, `${view.name}-regen.png`) });
        }
        rec.banks = await page.evaluate(async () => (await import('/tools/perf/riverBanks/bankAudit.js')).bankAudit({}));
        rec.lakeFlags = await page.evaluate(async () => (await import('/tools/perf/riverBanks/lakeFlags.js')).lakeFlags({}));
        rec.timing = await page.evaluate(async () => (await import('/tools/perf/terrainDetail/scene.js')).fencedFrames(30, 5));
        rec.gpuErrors = await page.evaluate(() => window.__lr.gpuErrors.length);
        report.poses.push(rec); save();
        const b = rec.banks.open, j = rec.banks.junction;
        console.log(JSON.stringify({ pose: view.name, rivers: rec.banks.rivers, openM: b?.lengthM, wetBeyondEdgeM: b?.wetBeyondEdgeM,
            exposedM: b?.exposedM, junctionM: j?.lengthM, junctionExposedM: j?.exposedM,
            belowWater: b?.belowWaterShare, deficitMax: b?.deficitMax, raisedShare: b?.raisedShare, fillMax: b?.fillMax,
            gpuSpanMs: rec.timing.gpuSpanMs?.median?.toFixed(2) }));
        if (compare && fs.existsSync(path.join(compare, `${view.name}.png`))) {
            const [a, c] = [path.join(compare, `${view.name}.png`), path.join(out, `${view.name}.png`)].map(f => readPng(fs.readFileSync(f)));
            const gap = 8, w = a.w * 2 + gap, px = new Uint8Array(w * a.h * 3).fill(255);
            for (let y = 0; y < a.h; y++) {
                px.set(a.px.subarray(y * a.w * 3, (y + 1) * a.w * 3), y * w * 3);
                px.set(c.px.subarray(y * c.w * 3, (y + 1) * c.w * 3), (y * w + a.w + gap) * 3);
            }
            fs.writeFileSync(path.join(out, `${view.name}-before-after.png`), writePng(w, a.h, px));
        }
    }
    report.finishedAt = new Date().toISOString();
    save();
    await page.goto('about:blank');
} catch (e) {
    report.errors.push(String(e?.stack ?? e));
    save();
    throw e;
} finally {
    await browser?.close();
    server.kill();
}
