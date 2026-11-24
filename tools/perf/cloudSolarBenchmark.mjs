/* global cloudLab, cloudLabError */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const [url = 'http://127.0.0.1:8000', output] = process.argv.slice(2);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling'],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 520, deviceScaleFactor: 1 });
    page.on('pageerror', error => console.error(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { timeout: 120000, polling: 200 });
    const run = await page.evaluate(async () => {
        if (window.cloudLabError) throw new Error(cloudLabError);
        const { clouds, goTo, presets, solar, timer, renderer } = cloudLab;
        const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
        const { SOLAR_FEATURES, SOLAR_ROW, evaluateSolarModel, solarMetrics } =
            await import('/core/renderer/volumetricClouds/neural/solarModel.js');
        Object.assign(clouds.settings, {
            cloudShape: 'domes', coverage: 0.46, cloudBottomKm: 4, cloudTopKm: 12,
            timeScale: 0, temporal: false, resolutionScale: 0.34, maxSteps: 128, farProxy: false,
            lightSteps: 6, lightStepKm: 0.05, lightReuseInterpolate: false,
        });
        clouds.weather = WEATHER_CONFIG.effects.overcast.clouds;
        goTo({ ...presets[2], view: { ...presets[2].view, altitudeKm: 5.7 } });
        const waitFrames = async count => {
            const end = renderer.frameCount + count;
            while (renderer.frameCount < end) {
                if (window.cloudLabError) throw new Error(cloudLabError);
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        };
        await waitFrames(4);
        const { count, referenceSteps, randomSeed, epochs } = { count: 8192, referenceSteps: 128, randomSeed: 17, epochs: 60 };
        let start = performance.now();
        const dataset = await solar.generate({ count, referenceSteps, randomSeed });
        const labelsMs = performance.now() - start;
        start = performance.now();
        const model = await solar.train({ count: epochs, randomSeed });
        const trainMs = performance.now() - start;
        const test = await solar.evaluate();
        const detailed = await solar.generate({ count, referenceSteps: referenceSteps * 2, randomSeed });
        let labelError = 0;
        for (let i = SOLAR_FEATURES; i < dataset.test.length; i += SOLAR_ROW) {
            const extinction = dataset.extinction;
            labelError += (Math.exp(-extinction * dataset.test[i]) - Math.exp(-extinction * detailed.test[i])) ** 2;
        }
        const convergenceRmse = Math.sqrt(labelError / test.count);
        const finerReference = solarMetrics(detailed.test, evaluateSolarModel(model, detailed.test), detailed.extinction);
        clouds.settings.solarReferenceSteps = referenceSteps;
        const raymarch = {};
        const passName = 'clouds raymarch';
        if (!timer.supported) throw new Error('GPU timestamp queries unavailable');
        for (const mode of ['off', 'neural-solar', 'solar-reference']) {
            await solar.setMode(mode);
            await waitFrames(6);
            await clouds.device.queue.onSubmittedWorkDone();
            timer.reset();
            const deadline = performance.now() + 30000;
            while ((timer.samples.get(passName)?.length ?? 0) < 20) {
                if (performance.now() > deadline) throw new Error('Timed out collecting raymarch samples');
                await waitFrames(1);
            }
            const pass = timer.stats().find(stat => stat.name === passName);
            raymarch[mode] = { ...pass, samples: timer.samples.get(passName).length, active: clouds._activeCacheMode };
        }
        return {
            count, referenceSteps, randomSeed, epochs, canvas: [innerWidth, innerHeight],
            cloudSize: clouds.getOutputs().size, labelsMs, trainMs, weights: model.weights.length,
            test, finerReference, convergenceRmse, raymarch,
        };
    });
    assert.ok(run.test.parity < 0.00002, 'CPU and GPU network forward passes disagree');
    for (const [mode, timing] of Object.entries(run.raymarch)) {
        assert.equal(timing.active, mode, `Preview did not activate for ${mode}`);
        assert.ok(Number.isFinite(timing.avg), `GPU timestamps unavailable for ${mode}`);
    }
    const result = JSON.stringify({ chrome: await browser.version(), ...run }, null, 2) + '\n';
    if (output) await fs.writeFile(output, result);
    process.stdout.write(result);
} finally {
    await browser.close();
}
