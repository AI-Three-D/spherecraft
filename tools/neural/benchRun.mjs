/* global cloudLab */
// GPU cost of trained networks vs the analytic terms and the game's density function.
//   node tools/neural/benchRun.mjs models/a.json models/b.json ... [--rays N] [--k N]
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};
const files = args.filter((a, i) => a.endsWith('.json') && !args[i - 1]?.startsWith('--'));
const models = {};
for (const f of files) {
    const m = JSON.parse(await fs.readFile(path.resolve('tools/neural', f), 'utf8'));
    models[`${path.basename(f, '.json')} [${m.sizes.join('-')}]`] = m;
}
const rays = Number(flag('--rays', 184320));
const k = Number(flag('--k', 16));
const url = process.env.LAB_URL ?? 'http://127.0.0.1:8000';
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, protocolTimeout: 0,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--enable-dawn-features=allow_unsafe_apis'],
});
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
    page.on('console', m => { if (m.type() === 'error') console.log(m.text()); });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { polling: 250 });
    const result = await page.evaluate(async (models, rays, k) => {
        const c = cloudLab.clouds;
        const { DEFAULT_CLOUD_SETTINGS } = await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js');
        const { createEngineConfig } = await import('/wizard_game/runtimeConfigs.js');
        const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
        const { runInferenceBench } = await import('/neural_lab/inferenceBench.js');
        const preset = WEATHER_CONFIG.effects.overcast;
        Object.assign(c.settings, DEFAULT_CLOUD_SETTINGS, createEngineConfig().rendering.volumetricClouds.settings, {
            windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0, coverage: 0.08 + 0.2 * preset.cloudCoverage, farProxy: false,
        });
        c.weather = preset.clouds;
        cloudLab.camera.setView({ altitudeKm: 5, headingDeg: 55, pitchDeg: 2 });
        const end = cloudLab.renderer.frameCount + 4;
        while (cloudLab.renderer.frameCount < end) await new Promise(r => requestAnimationFrame(r));
        const u = c._uniformData;
        const origin = [u[0], u[1], u[2]];
        const back = [u[12], u[13], u[14]];
        c.enabled = false;
        await new Promise(r => setTimeout(r, 200));
        return runInferenceBench(models, { rays, k, clouds: c, origin, axis: back.map(x => -x) });
    }, models, rays, k);
    const out = path.resolve('tools/neural/results/inference-bench.json');
    await fs.writeFile(out, JSON.stringify({ chrome: await browser.version(), ...result }, null, 1));
    const base = result.results['empty loop'].medianMs;
    const density = result.results['cloudDensity (game, with detail)']?.nsPerEval;
    console.log(`${result.adapter} features=${result.features}`);
    for (const [name, r] of Object.entries(result.results)) {
        const net = r.medianMs - base;
        console.log(`${name.padEnd(48)} ${r.medianMs.toFixed(3)} ms  (${r.nsPerEval.toFixed(3)} ns/eval${density ? `, ${(net * 1e6 / r.evaluations / density).toFixed(2)} density-evals` : ''})`);
    }
} finally {
    await browser.close();
}
