// node tools/perf/biomeLandscape/review.mjs OUT [survey|review|timing|full|startup|snapshot] [world,legacy] [poses.json]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [out, mode = 'review', presets = 'earth,legacy', posesFile] = process.argv.slice(2);
if (!out || !['survey', 'review', 'timing', 'full', 'startup', 'snapshot'].includes(mode)) {
    throw new Error('Pass an output directory and survey, review, timing, full, startup or snapshot');
}
const defaultPoses = new URL('./poses.json', import.meta.url);
const poses = ['survey', 'startup'].includes(mode) ? [] : JSON.parse(await readFile(posesFile ?? defaultPoses, 'utf8'));
const url = new URL('/wizard_game/standalone.html', process.env.BIOME_REVIEW_URL ?? 'http://127.0.0.1:8000');
const cold = process.env.BIOME_REVIEW_COLD_GPU === '1';
const saveSnapshot = mode === 'snapshot' || process.env.BIOME_REVIEW_SAVE_SNAPSHOT === '1';
const terrainOnly = process.env.BIOME_REVIEW_TERRAIN_ONLY === '1';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        ...(cold ? ['--disable-gpu-shader-disk-cache'] : [])],
});
try {
    for (const preset of presets.split(',')) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
        page.on('console', message => {
            if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
                if (errors.length < 6) console.error(message.text());
                errors.push(message.text());
            }
        });
        await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
        for (const file of ['../lakeRecovery/pageInstrument.js', '../terrainDetail/gpuTimer.js']) {
            await page.evaluateOnNewDocument(await readFile(new URL(file, import.meta.url), 'utf8'));
        }
        if (preset === 'world') url.searchParams.delete('biome');
        else url.searchParams.set('biome', preset);
        const start = performance.now();
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        console.log('Loading', preset);
        await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 120000, polling: 250 });
        const startupMs = performance.now() - start;
        const setup = await page.evaluate(() => {
            const g = window.gameEngine;
            if (g.getLoadingStatus().error) throw new Error(g.getLoadingStatus().error);
            const adapter = g.renderer.backend.adapter?.info;
            return { radius: g.planetConfig.radius, size: g.renderer.quadtreeTileManager.tileStreamer.tileGenerator.textureSize,
                gpu: { vendor: adapter?.vendor, architecture: adapter?.architecture }, timestamps: window.__gpuTimer.supported,
                climate: !!g.renderer.quadtreeTerrainRenderer._materials?.get(0)?.defines?.USE_BIOME_CLIMATE,
                options: g.terrainGenerator.terrainConfig.biomeLandscape };
        });
        console.log(preset, setup.gpu, 'tile size', setup.size, 'climate shading', setup.climate);
        if ((mode === 'timing' || mode === 'full') && !setup.timestamps) {
            throw new Error('Tile timing requires hardware WebGPU timestamp queries');
        }
        if (mode === 'survey' && !setup.options.enabled) throw new Error('Survey requires a landscape preset');
        const report = { preset, startupMs, cold, ...setup, cases: [], errors };
        if (mode === 'survey') {
            report.sites = await page.evaluate(async () => {
                const { survey } = await import('/tools/perf/biomeLandscape/scene.js');
                return survey();
            });
        } else if (mode === 'review' || mode === 'full') {
            await page.addStyleTag({ content: 'body > *:not(#gameCanvas){visibility:hidden !important}' });
            await page.evaluate(terrainOnly => {
                const g = window.gameEngine;
                const w = g.renderer.weatherController;
                w._pickNewWeatherTarget = () => {};
                w.setWeather('clear', true);
                g.gameTime.setFrozen(true);
                if (terrainOnly && g.renderer.volumetricClouds) g.renderer.volumetricClouds.enabled = false;
                Object.assign(g.adaptiveQuality.rendering.adaptive, {
                    stationaryPixelRatio: 1, motionPixelRatio: 1, fastMotionPixelRatio: 1,
                });
            }, terrainOnly);
            for (const pose of poses) {
                const row = await page.evaluate(async input => {
                    const { setPose } = await import('/tools/perf/biomeLandscape/scene.js');
                    return setPose(input);
                }, pose);
                await page.screenshot({ path: path.join(out, `${preset}-${pose.name}.png`) });
                if (mode === 'full') {
                    row.frames = await page.evaluate(async () => {
                        const { fencedFrames } = await import('/tools/perf/terrainDetail/scene.js');
                        return fencedFrames(26, 8);
                    });
                }
                report.cases.push({ ...pose, ...row });
                console.log(preset, pose.name, row.settled, Math.round(row.height) + ' m');
            }
        }
        if (mode === 'timing' || mode === 'full') {
            report.tileTiming = await page.evaluate(async input => {
                const { tiles } = await import('/tools/perf/biomeLandscape/scene.js');
                return tiles(input);
            }, poses);
            console.log(preset, 'tile timing', report.tileTiming.all);
            if (mode === 'timing') {
                report.geometryTiming = await page.evaluate(async input => {
                    const { tiles } = await import('/tools/perf/biomeLandscape/scene.js');
                    return tiles(input, 'geometry');
                }, poses);
                console.log(preset, 'geometry timing', report.geometryTiming.all);
                report.splitTiming = await page.evaluate(async input => {
                    const { tiles } = await import('/tools/perf/biomeLandscape/scene.js');
                    return tiles(input, 'split');
                }, poses);
                console.log(preset, 'geometry plus resident refinement timing', report.splitTiming.all);
            }
        }
        if (saveSnapshot) {
            report.snapshot = await page.evaluate(async input => {
                const { snapshot } = await import('/tools/perf/biomeLandscape/scene.js');
                return snapshot(input);
            }, poses);
        }
        const instrumentation = await page.evaluate(() => ({
            gpuErrors: window.__lr.gpuErrors,
            slowCompiles: window.__lr.compiles.toSorted((a, b) => b.ms - a.ms).slice(0, 15),
        }));
        Object.assign(report, instrumentation);
        console.log(preset, 'startup', (startupMs / 1000).toFixed(1) + ' s');

        await writeFile(path.join(out, `${preset}-${mode}.json`), JSON.stringify(report, null, 2));
        if (report.gpuErrors.length || errors.length || report.cases.some(c => !c.settled)) process.exitCode = 1;
        await page.close();
    }
} finally {
    await browser.close();
}
