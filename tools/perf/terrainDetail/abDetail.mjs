// tools/perf/terrainDetail/abDetail.mjs
//
// Terrain detail A/B: the same pose with the detail choice measured from the
// tiles' sea-level centres (A, today's default) and from their own ground
// (B, gpuQuadtree.lodHeightSource 'ground'), nothing else changed. Per pose:
// A, B, A again (the second A checks that timing did not drift), each after
// the scene settles (no pending tiles, hydrology or regeneration): a
// screenshot (A and B), visible tiles per depth and the frame time of fenced
// frames (scene.js fencedFrames: wall time and GPU span, gpuTimer.js).
//
// Poses: the owner's failure views (waterStepReview/userFailures.json), plus
// mountain streams found near the spawn: the steepest (outlet from its alpine
// lake, middle, mouth) and the flattest from the highest lake (plateau).
//
//   node tools/perf/terrainDetail/abDetail.mjs OUT_DIR [--profile DIR] [--only name,name] [--no-discover]
//
// Own no-cache server (:8231) and headless system Chrome on the owner's GPU;
// the owner's configuration URL. Runs sequentially, closes Chrome at the end.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from '../riverMetrics/png.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || (fs.existsSync(out) && fs.readdirSync(out).length)) throw new Error('Usage: abDetail.mjs EMPTY_OUT_DIR [--profile DIR] [--only a,b] [--no-discover]');
fs.mkdirSync(out, { recursive: true });
const only = arg('--only')?.split(',');
const discover = !process.argv.includes('--no-discover');
const PORT = 8231;
const URL_PATH = '/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1';

const report = { startedAt: new Date().toISOString(), url: URL_PATH, viewport: '1440x900 @1 (canvas x1.5 when still)',
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitDirty: execFileSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    arms: ['sea', 'ground', 'sea'], cases: null, poses: [], errors: [] };
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
    report.timestampQuery = await page.evaluate(() => window.__gpuTimer.supported);
    await page.evaluate(() => {
        const g = window.gameEngine, w = g.renderer.weatherController;
        w._pickNewWeatherTarget = () => {}; w.setWeather('clear', true);
        window.__lr.daylightAt([-1, 0, 0], 0.75);
        const st = document.createElement('style');
        st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}';
        document.head.appendChild(st);
    });
    console.log(JSON.stringify({ loaded: report.loadS, timestampQuery: report.timestampQuery }));

    const poses = JSON.parse(fs.readFileSync(path.join(root, 'tools/perf/waterStepReview/userFailures.json'), 'utf8'));
    if (discover) {
        report.cases = await page.evaluate(async () => (await import('/tools/perf/terrainDetail/scene.js')).riverCases({}));
        save();
        const long = report.cases.filter(c => c.lengthM > 400);
        const steep = long.reduce((a, c) => (!a || c.slope > a.slope ? c : a), null);
        const flat = long.filter(c => c !== steep && c.slope < 0.01).reduce((a, c) => (!a || c.srcLevel > a.srcLevel ? c : a), null);
        if (steep) for (const [tag, fraction] of [['outlet', 0.04], ['middle', 0.5], ['mouth', 0.96]])
            poses.push({ name: `steep-${steep.id}-${tag}`, river: steep.id, fraction });
        if (flat) for (const [tag, fraction] of [['outlet', 0.04], ['middle', 0.5]])
            poses.push({ name: `plateau-${flat.id}-${tag}`, river: flat.id, fraction });
        console.log(JSON.stringify({ cases: report.cases.length, steep: steep?.id, steepSlope: steep?.slope, plateau: flat?.id, plateauLevel: flat?.srcLevel }));
    }

    for (const view of poses.filter(v => !only || only.includes(v.name))) {
        const rec = { name: view.name, arms: [] };
        report.poses.push(rec); save();
        for (const [i, arm] of report.arms.entries()) {
            const r = await page.evaluate(async (v, arm, first) => {
                const scene = await import('/tools/perf/terrainDetail/scene.js');
                const q = await import('/tools/perf/waterStepReview/qualityScene.js');
                scene.setLodHeight(arm);
                const placed = !first ? { resident: await q.settle(240000) }
                    : v.river != null ? await q.riverView(v.river, v.fraction, { height: 30, back: 45 }) : await q.poseView(v);
                await new Promise(r => setTimeout(r, 1000));
                return { arm, lodHeightSource: window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU.lodHeightSource,
                    pose: placed.pose ?? window.__lr.pose(), resident: placed.resident, tiles: scene.visibleDepths(),
                    river: v.river != null ? { level: placed.level, width: placed.width } : undefined };
            }, view, arm, i === 0);
            if (i < 2) await page.screenshot({ path: path.join(out, `${view.name}-${arm}.png`) });
            r.timing = await page.evaluate(async () => (await import('/tools/perf/terrainDetail/scene.js')).fencedFrames(40, 5));
            r.gpuErrors = await page.evaluate(() => window.__lr.gpuErrors.length);
            rec.arms.push(r); save();
            console.log(JSON.stringify({ pose: view.name, arm, tiles: r.tiles.count, depths: r.tiles.depths,
                gpuSpanMs: r.timing.gpuSpanMs?.median?.toFixed(2), wallMs: r.timing.wallMs?.median?.toFixed(2) }));
        }
        const [a, b] = ['sea', 'ground'].map(arm => readPng(fs.readFileSync(path.join(out, `${view.name}-${arm}.png`))));
        const gap = 8, w = a.w * 2 + gap, px = new Uint8Array(w * a.h * 3).fill(255);
        for (let y = 0; y < a.h; y++) {
            px.set(a.px.subarray(y * a.w * 3, (y + 1) * a.w * 3), y * w * 3);
            px.set(b.px.subarray(y * b.w * 3, (y + 1) * b.w * 3), (y * w + a.w + gap) * 3);
        }
        fs.writeFileSync(path.join(out, `${view.name}-sea-vs-ground.png`), writePng(w, a.h, px));
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
