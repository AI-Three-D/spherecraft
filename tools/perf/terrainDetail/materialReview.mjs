// Capture and time the live renderer at fixed poses.
// node tools/perf/terrainDetail/materialReview.mjs OUT_DIR [compare|ground|unlit|atlas] [both|medium|high]
// atlas: the textures of before. ground: the generated surfaces (groundMaterials.js) with the light over the land. unlit: without it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [out, arm = 'compare', detail = 'both'] = process.argv.slice(2);
const variants = {
    atlas: { groundMaterials: false, landLight: false },
    ground: { groundMaterials: true, landLight: true },
    unlit: { groundMaterials: true, landLight: false },
};
if (!out || (arm !== 'compare' && !Object.hasOwn(variants, arm)) || !['both', 'medium', 'high'].includes(detail)) {
    throw new Error('Usage: materialReview.mjs OUT_DIR [compare|ground|unlit|atlas] [both|medium|high]');
}
await mkdir(out, { recursive: true });
const url = new URL('/wizard_game/standalone.html', process.env.TERRAIN_REVIEW_URL ?? 'http://localhost:8000');
const poses = [
    { name: 'ground', pos: [-122700.50, -18459.63, 44221.32], look: [-122691.53, -18377.12, 44218.02] },
    { name: 'slope', pos: [-122561.86, -18446.60, 46057.79], look: [-122619.88, -18406.43, 46079.44] },
    { name: 'mountains', pos: [-124479.36, -18817.94, 46778.63], look: [-124156.22, -17286.03, 46652.55] },
    { name: 'eye', pos: [-122698.33, -18459.30, 44220.54], look: [-122686.31, -18372.79, 44269.22] },
];
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-features=BatterySaverModeOn'],
});
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', message => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
    });
    await page.setViewport({ width: 1728, height: 900, deviceScaleFactor: 1 });
    for (const file of ['../lakeRecovery/pageInstrument.js', './gpuTimer.js']) {
        await page.evaluateOnNewDocument(await readFile(new URL(file, import.meta.url), 'utf8'));
    }
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 180000, polling: 250 });
    const info = await page.evaluate(() => {
        const game = window.gameEngine;
        const weather = game.renderer.weatherController;
        weather._pickNewWeatherTarget = () => {};
        weather.setWeather('partly_cloudy', true);
        const clouds = game.renderer.volumetricClouds;
        Object.assign(clouds.settings, { cloudBudgetMode: 'neural', windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 });
        game.gameTime.setFrozen(true);
        const core = game.renderer.rendererCore;
        const render = core.render;
        core.render = function (frame) {
            window.__gpuTimer.passLabel = 'terrain and water';
            try { return render.call(this, frame); }
            finally { window.__gpuTimer.passLabel = undefined; }
        };
        const style = document.createElement('style');
        style.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}';
        document.head.appendChild(style);
        const adapter = game.renderer.backend.adapter?.info;
        return {
            gpu: { vendor: adapter?.vendor, architecture: adapter?.architecture, description: adapter?.description },
            timestamps: window.__gpuTimer.supported,
            ground: !!game.renderer.quadtreeTerrainRenderer._ground,
        };
    });
    console.log(JSON.stringify({ arm, detail, ...info }));
    if (!info.timestamps || !info.ground) throw new Error('Benchmark requires WebGPU timestamps and the generated ground surfaces');
    const report = { arm, detail, chrome: await browser.version(), ...info, cases: [], errors };
    const qualities = detail === 'both' ? ['high', 'medium'] : [detail];
    for (const quality of qualities) {
        await page.evaluate(quality => {
            const game = window.gameEngine;
            const ratio = quality === 'high' ? 1.5 : 1;
            Object.assign(game.adaptiveQuality.rendering.adaptive, {
                stationaryPixelRatio: ratio, motionPixelRatio: ratio, fastMotionPixelRatio: ratio,
            });
            const clouds = game.renderer.volumetricClouds;
            clouds.settings.cloudDetail = quality;
            clouds.resetHistory();
        }, quality);

        for (const pose of poses) {
            const scene = await page.evaluate(async ({ pos, look }) => {
                const vector = ([x, y, z]) => ({ x, y, z });
                const scale = Math.hypot(...pos);
                const up = pos.map(value => value / scale);
                window.qtDiag.regional.useCamera({ position: vector(pos), target: vector(look), up: vector(up), fov: 75 });
                window.__lr.daylightAt(up, 0.68);
                let idleSince = 0;
                let resident;
                const end = performance.now() + 45000;
                do {
                    await new Promise(resolve => setTimeout(resolve, 150));
                    resident = window.__lr.residency();
                    const idle = resident?.exactVisibleRatio === 1 && !resident.pendingGenerations &&
                        !resident.activeGenerations && !resident.pendingCopies &&
                        !window.gameEngine.renderer.quadtreeTileManager.tileStreamer.getRegenerationStats().pending;
                    idleSince = idle ? idleSince || performance.now() : 0;
                } while ((!idleSince || performance.now() - idleSince < 1500) && performance.now() < end);
                const game = window.gameEngine;
                return { resident, settled: !!idleSince, canvas: [game.canvas.width, game.canvas.height] };
            }, pose);

            const arms = arm === 'compare' ? ['atlas', 'ground', 'unlit', 'ground', 'atlas'] : [arm];
            const record = { quality, ...pose, ...scene, arms: [] };
            report.cases.push(record);
            for (const variant of arms) {
                await page.evaluate(async settings => {
                    const game = window.gameEngine;
                    const current = game.engineConfig.rendering.terrainShader;
                    const renderer = game.renderer.quadtreeTerrainRenderer;
                    if (renderer._landLight) renderer._landLight.enabled = settings.landLight;
                    if (current.groundMaterials !== settings.groundMaterials) {
                        current.groundMaterials = settings.groundMaterials;
                        await renderer.rebuildMaterials();
                    }
                    await new Promise(resolve => setTimeout(resolve, 800));
                }, variants[variant]);
                if (!record.arms.some(previous => previous.variant === variant)) {
                    await page.screenshot({ path: path.join(out, `${quality}-${pose.name}-${variant}.png`) });
                }
                const timing = await page.evaluate(async () => (await import('/tools/perf/terrainDetail/scene.js')).fencedFrames(40, 12));
                const gpuErrors = await page.evaluate(() => window.__lr.gpuErrors);
                record.arms.push({ variant, timing, gpuErrors });
                await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
                console.log(JSON.stringify({ pose: pose.name, variant, quality, settled: scene.settled, canvas: scene.canvas,
                    gpu: timing.gpuSpanMs, terrainAndWater: timing.passGpuMs['terrain and water'], gpuErrors: gpuErrors.length }));
            }
        }
    }
    if (report.cases.some(row => !row.settled || row.arms.some(a => a.gpuErrors.length)) || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
