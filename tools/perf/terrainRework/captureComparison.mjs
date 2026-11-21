// Capture matched views of a terrain trial off/on, holding camera and sun
// fixed. Run against preview_server.py --compare.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const [out, poseFile, base = 'http://127.0.0.1:8775', featureList = '', toggle = 'valleys'] = process.argv.slice(2);
if (!out || !poseFile) throw new Error('Supply an output directory and JSON pose array');
const poses = JSON.parse(fs.readFileSync(poseFile, 'utf8'));
const features = featureList.split(',').filter(Boolean);
const sunElevation = Number(process.env.TERRAIN_REWORK_SUN_ELEVATION ?? 0.75);
if (!Number.isFinite(sunElevation) || sunElevation < 0 || sunElevation > 1) throw new Error('Sun elevation must be between 0 and 1');
const terrainFeatures = JSON.parse(process.env.TERRAIN_REWORK_FEATURES ?? '{}');
if (!terrainFeatures || Array.isArray(terrainFeatures) || typeof terrainFeatures !== 'object') throw new Error('Terrain features must be an object');
if (Object.values(terrainFeatures).some(value => typeof value !== 'boolean')) throw new Error('Terrain feature values must be booleans');
if (!['valleys', 'rolling', 'coast', 'coves', 'canyon', 'dunes', 'calderas'].includes(toggle) || features.includes(toggle)) throw new Error('Choose valleys, rolling, coast, coves, canyon, dunes or calderas as the toggle');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
try {
    for (const enabled of [false, true]) {
        const selected = [...features, ...(enabled && toggle !== 'calderas' ? [toggle] : [])];
        const page = await browser.newPage(), errors = [];
        await page.evaluateOnNewDocument(features => {
            const nativeFetch = window.fetch;
            window.fetch = async (...args) => {
                const response = await nativeFetch(...args);
                const url = typeof args[0] === 'string' ? args[0] : args[0].url;
                if (!new URL(url, location.href).pathname.endsWith('/terrain.json') || !response.ok) return response;
                const config = await response.json();
                config.features = { ...config.features, ...features };
                return new Response(JSON.stringify(config), { status: response.status, headers: response.headers });
            };
        }, terrainFeatures);
        page.on('pageerror', error => errors.push(error.message));
        const calderaQuery = toggle === 'calderas' ? `&calderas=${enabled ? '1' : '0'}` : '';
        await page.goto(`${base}/wizard_game/standalone.html?lakeCells=1&labNoClouds=1&terrainRework=${selected.join(',')}${calderaQuery}`,
            { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.qtDiag?.regional && window.gameEngine?.waterService?.state === 'ready',
            { timeout: 180000 });
        const effectiveFeatures = await page.evaluate(() => window.gameEngine.terrainGenerator.terrainFeatures);
        for (const [key, value] of Object.entries(terrainFeatures)) {
            if (effectiveFeatures[key] !== value) throw new Error(`Terrain feature ${key} did not apply`);
        }
        if (process.env.TERRAIN_REWORK_HIDE_SEA) await page.evaluate(() => { window.gameEngine.renderer.terrainModule.ocean.enabled = false; });
        await page.addStyleTag({ content: 'body * {visibility:hidden!important} #gameCanvas {visibility:visible!important}' });
        for (const pose of poses) {
            await page.evaluate(({ reference, sunElevation }) => {
                const g = window.gameEngine, s = g.starSystem, body = s?.currentBody;
                const up = reference, n = Math.hypot(...up);
                if (!body) return;
                s.paused = true; s.useGameTimeRotation = false;
                let best = Infinity, rotation = 0;
                for (let i = 0; i < 720; i++) {
                    body.currentRotation = i * Math.PI * 2 / 720;
                    const d = body.getStarDirection(s.primaryStar).direction;
                    const score = Math.abs((d.x * up[0] + d.y * up[1] + d.z * up[2]) / n - sunElevation);
                    if (score < best) { best = score; rotation = body.currentRotation; }
                }
                body.currentRotation = rotation;
            }, { reference: pose.target, sunElevation });
            await page.evaluate(value => {
                clearInterval(window.__terrainComparisonHold);
                const xyz = a => ({ x: a[0], y: a[1], z: a[2] });
                const camera = { position: xyz(value.position), target: xyz(value.target),
                    up: xyz(value.up ?? [0, 1, 0]), fov: value.fov ?? 75 };
                const apply = () => window.qtDiag.regional.useCamera(camera);
                apply(); window.__terrainComparisonHold = setInterval(apply, 250);
            }, pose);
            await sleep(3000);
            let stable = 0, state;
            for (let elapsed = 0; elapsed < 120; elapsed++) {
                state = await page.evaluate(() => {
                    const g = window.gameEngine, s = g.renderer.quadtreeTileManager.getInitialLoadStatus();
                    return { visible: s.visibleTiles, exact: s.exactVisibleRatio, pending: s.pendingGenerations,
                        active: s.activeGenerations, copies: s.pendingCopies, waterPlanning: g.waterService?._lakeCells?.planning };
                });
                const done = state.visible > 0 && state.exact >= 0.999 && !state.pending && !state.active && !state.copies && !state.waterPlanning;
                stable = done ? stable + 1 : 0;
                if (stable >= 2) break;
                await sleep(1000);
            }
            if (stable < 2) throw new Error(`Terrain did not settle: ${JSON.stringify({ selected, pose, state })}`);
            await sleep(1000);
            const filename = `${pose.name}-${toggle}-${enabled ? 'on' : 'off'}.png`;
            await page.screenshot({ path: path.join(out, filename) });
            console.log(JSON.stringify({ filename, selected, pose, state }));
        }
        await page.close();
        if (errors.length) throw new Error(JSON.stringify(errors));
    }
} finally {
    await browser.close();
}
