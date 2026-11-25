/* global cloudBench, cloudLab, gameEngine */
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { measureNeuralReference } from './cloudNeuralReference.mjs';
import { prepareCloudImageReference, readReferenceSkyMask } from './cloudImageReference.mjs';

// Serve the two revisions with separate HTTP servers. Only one tab renders at a time.
const [before, after, output] = process.argv.slice(2);
if (!before || !after || !output) {
    throw new Error('Usage: node tools/perf/cloudBenchmark.mjs BEFORE_URL AFTER_URL OUTPUT_DIRECTORY');
}
const game = process.env.CLOUD_BENCH_GAME === '1';
const width = Number(process.env.CLOUD_BENCH_WIDTH ?? 1024);
const height = Number(process.env.CLOUD_BENCH_HEIGHT ?? 640);
const beforeSettings = JSON.parse(process.env.CLOUD_BENCH_BEFORE_SETTINGS ?? '{}');
const afterSettings = JSON.parse(process.env.CLOUD_BENCH_AFTER_SETTINGS ?? '{}');
const warmFrames = Number(process.env.CLOUD_BENCH_WARM ?? 12);
const sampleFrames = Number(process.env.CLOUD_BENCH_FRAMES ?? 24);
const rounds = Number(process.env.CLOUD_BENCH_ROUNDS ?? 2);
const filter = new RegExp(process.env.CLOUD_BENCH_CASES ?? '.*');
const capture = process.env.CLOUD_BENCH_CAPTURE !== '0';
const flightFrames = Number(process.env.CLOUD_BENCH_FLIGHT_FRAMES ?? 0);
const motionFrames = Number(process.env.CLOUD_BENCH_MOTION_FRAMES ?? 0);
const motionWarmFrames = Number(process.env.CLOUD_BENCH_MOTION_WARM ?? 0);
const cloudBufferCapture = process.env.CLOUD_BENCH_CLOUD_BUFFER === '1';
const isolatedStackFrames = Number(process.env.CLOUD_BENCH_ISOLATED_STACK_FRAMES ?? 0);
const isolatedStackMode = process.env.CLOUD_BENCH_ISOLATED_MODE ?? null;
const stallReplayFrames = Number(process.env.CLOUD_BENCH_STALL_FRAMES ?? 0);
const stallReplayModes = (process.env.CLOUD_BENCH_STALL_MODES ?? 'timed,wall,volume,attachment').split(',');
const neuralReferencePaths = Number(process.env.CLOUD_BENCH_NEURAL_REFERENCE_PATHS ?? 0);
const imageReferenceSpp = Number(process.env.CLOUD_BENCH_IMAGE_REFERENCE_SPP ?? 0);
const [referenceWidth, referenceHeight] = (process.env.CLOUD_BENCH_IMAGE_REFERENCE_SIZE ?? '96x60').split('x').map(Number);
if (imageReferenceSpp > 0 && (!game || !capture || ![imageReferenceSpp, referenceWidth, referenceHeight].every(n => Number.isInteger(n) && n > 0))) {
    throw new Error('The image reference needs game screenshots and positive integer resolution and sample counts');
}
const lookVariants = Object.entries(JSON.parse(process.env.CLOUD_BENCH_LOOK_VARIANTS ?? '{}'));
const ground = { altitudeKm: 1, headingDeg: 40, pitchDeg: 14 };
const horizon = { altitudeKm: 3, headingDeg: 55, pitchDeg: 2 };
const inside = { altitudeKm: 6, headingDeg: 55, pitchDeg: 2 };
const above = { altitudeKm: 10, headingDeg: 55, pitchDeg: -35 };
const grazing = { altitudeKm: 6.54, latDeg: -6.81, lonDeg: 19.64, headingDeg: 4.07, pitchDeg: -3.61 };
// Free-camera HUD poses from the day and twilight streak reports.
const reportedClimb = { altitudeKm: 4.95, latDeg: -9.2119, lonDeg: 19.5367, headingDeg: 16.3647, pitchDeg: -10.0762 };
const reportedLow = { ...reportedClimb, headingDeg: -0.771, pitchDeg: -9.4809 };
const orbit = { ...above, altitudeKm: 125, pitchDeg: -56 };
const entry = (name, view, elevation, extra = {}, azimuth = 235, moon = false) =>
    ({ name, view, elevation, azimuth, moon, extra });
const motion = (test, headingPerFrame, climbPerFrame = 0, longitudePerFrame = 0, latitudePerFrame = 0) =>
    ({ ...test, motion: { headingPerFrame, climbPerFrame, longitudePerFrame, latitudePerFrame } });
const weatherCases = [
    entry('ground-overcast', ground, 35, { weatherPreset: 'overcast' }),
    entry('ground-rain', ground, 35, { weatherPreset: 'rain' }),
    entry('crossfade-overcast', { ...ground, altitudeKm: 1.95 }, 35, { weatherPreset: 'overcast' }),
    entry('horizon-overcast', horizon, 35, { weatherPreset: 'overcast' }),
    entry('inside-rain', inside, 35, { weatherPreset: 'rain' }),
    entry('above-storm', above, 35, { weatherPreset: 'storm' }),
];
const weatherMotion = [
    motion(entry('motion-overcast-crossfade', { ...ground, altitudeKm: 1.55 }, 35, { weatherPreset: 'overcast' }),
        0.22, 0.05, 0.005),
    motion(entry('motion-inside-rain', inside, 35, { weatherPreset: 'rain' }), 0.27),
];

const labCases = [
    entry('ground-day', ground, 35),
    entry('ground-dawn', ground, 3, {}, 55),
    entry('ground-dusk', ground, 5),
    entry('ground-night', ground, -35, {}, 235, true),
    entry('ground-moonless', ground, -35),
    entry('horizon-day', horizon, 35),
    entry('inside-day', inside, 35),
    entry('inside-night', inside, -35, {}, 235, true),
    entry('above-day', above, 35),
    entry('above-dawn', above, 3, {}, 55),
    entry('above-dusk', above, 5),
    entry('above-night', above, -35, {}, 235, true),
    entry('orbit', orbit, 35, { farProxy: true }),
    { ...entry('flight-dusk', { altitudeKm: 5.8, headingDeg: 54, pitchDeg: -4 }, 5), flight: true },
    entry('clear-day', above, 35, { coverage: 0, weatherContrast: 0 }),
    motion(entry('motion-slow-dawn', ground, 3, {}, 55), 0.07),
    motion(entry('motion-fast-day', above, 35), 1.5),
    motion(entry('motion-flight-dusk', inside, 5), 0.65, 0.055, 0.032),
    motion(entry('motion-fast-night', above, -35, {}, 235, true), 1.5),
];
const gameCases = [
    entry('game-ground-day', ground, 35),
    entry('game-ground-dawn', ground, 3, {}, 55),
    entry('game-ground-dusk', ground, 5),
    entry('game-ground-night', ground, -35, {}, 235, true),
    entry('game-above-day', above, 35),
    entry('game-horizon-day', horizon, 35),
    entry('game-inside-day', inside, 35),
    entry('game-grazing-day', grazing, 35),
    motion(entry('game-grazing-climb', { ...grazing, altitudeKm: 6.18 }, 35), 0.12, 0.04),
    motion(entry('game-overcast-artifact-climb', { ...grazing, altitudeKm: 3.6 }, 35, { weatherPreset: 'overcast' }),
        0.05, 0.17),
    motion(entry('game-overcast-artifact-ridge', { ...grazing, pitchDeg: -10 }, 35, { weatherPreset: 'overcast' }),
        0.25),
    motion(entry('game-reported-deck-climb', reportedClimb, 35, { weatherPreset: 'overcast' }), 0, 0.14),
    motion(entry('game-reported-twilight-climb', reportedClimb, 7, { weatherPreset: 'cloudy' }), 0, 0.14),
    motion(entry('game-reported-twilight-descent', { ...reportedClimb, altitudeKm: 7.61 }, 7, { weatherPreset: 'cloudy' }),
        0, -0.14),
    motion(entry('game-reported-night-low', reportedLow, 7, { weatherPreset: 'cloudy' }), 0.25, 0.012),
    motion(entry('game-reported-day', { ...reportedClimb, altitudeKm: 6.8835 }, 35, { weatherPreset: 'cloudy' }), 0, 0.028),
    motion(entry('game-reported-still', { ...reportedClimb, altitudeKm: 6.4424 }, 7, { weatherPreset: 'cloudy' }), 0),
    motion(entry('game-reported-axis-turn', { ...reportedClimb, altitudeKm: 6.4424, headingDeg: 34 }, 7,
        { weatherPreset: 'cloudy' }), 1.3),
    motion(entry('game-deck-ground-pan', { altitudeKm: 1.45, latDeg: -6.81, lonDeg: 19.64, headingDeg: 11, pitchDeg: 14 }, 35), 0.20),
    motion(entry('game-deck-grazing-pan', grazing, 35), 0.20),
    entry('game-ground-cirrus-only', ground, 35, { cumulusOff: true }),
    entry('game-crossfade-day', { ...ground, altitudeKm: 1.95 }, 35),
    entry('game-above-dusk', above, 5),
    entry('game-above-night', above, -35, {}, 235, true),
    motion(entry('game-motion-slow-dawn', ground, 3, {}, 55), 0.075),
    { ...motion(entry('game-history-slow-pan', horizon, 35), 0.012, 0, 0.00003), cloudDeltaSeconds: 1 / 30 },
    { ...motion(entry('game-history-wind', horizon, 35, { weatherPreset: 'overcast' }), 0), cloudDeltaSeconds: 1 / 30 },
    { ...motion(entry('game-history-turn', grazing, 35, { weatherPreset: 'rain' }), 0.8, 0.015, 0.001), cloudDeltaSeconds: 1 / 30 },
    { ...motion(entry('game-history-rain-10hz', inside, 35, { weatherPreset: 'rain' }), 0), cloudDeltaSeconds: 0.1 },
    { ...motion(entry('game-weather-overcast-turn', grazing, 35, { weatherPreset: 'overcast' }), 0.8, 0.015, 0.001), cloudDeltaSeconds: 1 / 30 },
    { ...motion(entry('game-weather-overcast-fixed', inside, 35, { weatherPreset: 'overcast' }), 0), cloudDeltaSeconds: 0.1 },
    motion(entry('game-weather-overcast-static', inside, 35, { weatherPreset: 'overcast' }), 0),
    motion(entry('game-weather-fair-static', horizon, 35, { weatherPreset: 'partly_cloudy' }), 0),
    entry('game-weather-clear-ground', ground, 35, { weatherPreset: 'clear' }),
    motion(entry('game-weather-cloudy-flight', horizon, 35, { weatherPreset: 'cloudy' }), 0.35, 0.03, 0.005),
    motion(entry('game-weather-storm-grazing', grazing, 5, { weatherPreset: 'storm' }), 0.8, 0.03, 0.005),
    entry('game-weather-storm-dawn-reference', { ...above, altitudeKm: 7.4, latDeg: -17, lonDeg: 21, headingDeg: 148 },
        8, { weatherPreset: 'storm' }, 55),
    motion(entry('game-weather-foggy-ground', ground, -6, { weatherPreset: 'foggy' }, 235, true), 0.3),
    motion(entry('game-weather-overcast-orbit', orbit, 35, { weatherPreset: 'overcast' }), 0.25),
    entry('game-weather-orbital-blend', { ...orbit, altitudeKm: 72 }, 35, { weatherPreset: 'overcast' }),
    entry('game-weather-orbital-blend-start', { ...orbit, altitudeKm: 55 }, 35, { weatherPreset: 'overcast' }),
    entry('game-weather-orbital-blend-end', { ...orbit, altitudeKm: 87 }, 35, { weatherPreset: 'overcast' }),
    motion(entry('game-weather-orbital-climb', { ...orbit, altitudeKm: 54 }, 35, { weatherPreset: 'overcast' }), 0.15, 2.2),
    entry('game-weather-overcast-dusk', above, 10, { weatherPreset: 'overcast' }),
    // Decks seen from below, where path-traced references show the largest lighting error.
    entry('game-weather-overcast-ground', ground, 35, { weatherPreset: 'overcast' }),
    entry('game-weather-rain-ground', ground, 35, { weatherPreset: 'rain' }),
    entry('game-weather-storm-ground-dusk', ground, 8, { weatherPreset: 'storm' }),
    motion(entry('game-weather-storm-ground-pan', ground, 8, { weatherPreset: 'storm' }), 0.41, 0, 0.002),
    motion(entry('game-weather-rain-ground-pan', ground, 35, { weatherPreset: 'rain' }), 0.41, 0, 0.002),
    entry('game-orbit-clouds', orbit, 35),
    motion(entry('game-orbit-cloud-pan', orbit, 35), 0.25),
    motion(entry('game-orbit-cloud-climb', { ...orbit, altitudeKm: 65 }, 35), 0.10, 2.5),
    { ...motion(entry('game-cache-weather-handoff', { ...horizon, lonDeg: 2.3 }, 35), 0.12, 0, 0.10), cloudDeltaSeconds: 1 / 30 },
    { ...motion(entry('game-cloud-cache-face-crossing', { ...horizon, lonDeg: 44.7 }, 35), 0.12, 0, 0.10), cloudDeltaSeconds: 1 / 30 },
    entry('game-above-cirrus', { ...above, altitudeKm: 16, pitchDeg: -28 }, 35),
    motion(entry('game-motion-flight-dusk', { ...inside, pitchDeg: -7 }, 5), 0.8, 0.06, 0.032),
    motion(entry('game-motion-reference', {
        altitudeKm: 3.03, headingDeg: 1.6, pitchDeg: -4.5, latDeg: 1.09, lonDeg: 0.153,
    }, 5, { systemOffset: 1.3 }), 0.07),
    entry('cirrus-shell-day', ground, 35, { cumulusOff: true }),
    entry('cirrus-shell-dawn', ground, 3, { cumulusOff: true }, 55),
    entry('cirrus-shell-dusk', ground, 5, { cumulusOff: true }),
    entry('cirrus-shell-night', ground, -35, { cumulusOff: true }, 235, true),
    entry('cirrus-below-dawn', { ...above, pitchDeg: 12 }, 3, { cumulusOff: true }, 55),
    entry('cirrus-volume-day', { ...above, altitudeKm: 16, pitchDeg: -12 }, 35, { cumulusOff: true }),
    entry('cirrus-volume-low', { ...above, altitudeKm: 16, pitchDeg: -12 }, 35, { cumulusOff: true, cirrusQuality: 'low' }),
    entry('cirrus-volume-medium', { ...above, altitudeKm: 16, pitchDeg: -12 }, 35, { cumulusOff: true, cirrusQuality: 'medium' }),
    entry('cirrus-volume-ultra', { ...above, altitudeKm: 16, pitchDeg: -12 }, 35, { cumulusOff: true, cirrusQuality: 'ultra' }),
    entry('cirrus-volume-dusk', { ...above, altitudeKm: 16, pitchDeg: -12 }, 5, { cumulusOff: true }),
    entry('cirrus-volume-night', { ...above, altitudeKm: 16, pitchDeg: -12 }, -35, { cumulusOff: true }, 235, true),
    entry('cirrus-volume-off', { ...above, altitudeKm: 16, pitchDeg: -12 }, 35, { cumulusOff: true, cirrusOff: true }),
    entry('cirrus-above-day', { ...above, altitudeKm: 24, pitchDeg: -25 }, 35, { cumulusOff: true }),
    entry('cirrus-orbit-day', orbit, 35, { cumulusOff: true }),
    entry('cirrus-cirrocumulus-day', { ...above, altitudeKm: 16, pitchDeg: -18 }, 35,
        { cumulusOff: true, cirrusType: 'CIRROCUMULUS' }),
    entry('cirrus-cirrostratus-dusk', { ...above, altitudeKm: 16, pitchDeg: -18 }, 5,
        { cumulusOff: true, cirrusType: 'CIRROSTRATUS' }),
    ...weatherCases.flatMap(test => [
        { ...test, name: `game-${test.name}` },
        { ...test, name: `game-${test.name}-cirrus-only`, extra: { ...test.extra, cumulusOff: true } },
    ]),
    ...weatherMotion.map(test => ({ ...test, name: `game-${test.name}` })),
];
const selectedCases = (game ? gameCases : [...labCases, ...weatherCases, ...weatherMotion]).filter(test => filter.test(test.name));
const variants = lookVariants;
const cases = variants.length ? selectedCases.flatMap(test => variants.map(([variant, settings]) =>
    ({ ...test, name: `${test.name}-${variant}`, after: settings }))) : selectedCases;
if (!cases.length) throw new Error('No matching cloud benchmark cases');

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.CLOUD_BENCH_HEADFUL !== '1',
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--disable-features=BatterySaverModeOn'],
});

async function open(url) {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error(url, error.message));
    page.on('console', message => {
        const line = message.text();
        if ((message.type() === 'error' && !line.includes('404')) || line.includes('Volumetric clouds init failed')) {
            console.error(url, line.slice(0, 700));
        }
    });
    await page.setViewport({ width, height, deviceScaleFactor: 1.5 });
    await page.evaluateOnNewDocument((isGame, captureRaw) => {
        if (captureRaw) {
            const create = GPUDevice.prototype.createTexture;
            GPUDevice.prototype.createTexture = function (descriptor) {
                const cloudOutput = /^(clouds history [AB]|clouds raymarch (color|depth) k1)$/.test(descriptor.label);
                return create.call(this, cloudOutput ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
            };
        }
        if (isGame) {
            const requestDevice = GPUAdapter.prototype.requestDevice;
            GPUAdapter.prototype.requestDevice = function (descriptor = {}) {
                const requiredFeatures = [...(descriptor.requiredFeatures ?? [])];
                if (this.features.has('timestamp-query') && !requiredFeatures.includes('timestamp-query')) {
                    requiredFeatures.push('timestamp-query');
                }
                return requestDevice.call(this, { ...descriptor, requiredFeatures });
            };
        }
        const raf = window.requestAnimationFrame.bind(window);
        let paused = false;
        const waiting = new Map();
        let count = 0;
        let nextId = 0;
        const request = (fn) => {
            const id = ++nextId;
            const schedule = () => raf(time => {
                if (!waiting.has(id)) return;
                if (paused) { waiting.set(id, schedule); return; }
                waiting.delete(id);
                fn(time);
            });
            waiting.set(id, schedule);
            if (!paused) schedule();
            return id;
        };
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = id => waiting.delete(id);
        window.cloudBench = {
            start() {
                if (!paused) return;
                paused = false;
                for (const schedule of waiting.values()) schedule();
            },
            pause() { paused = true; },
            async run(frames, measure) {
                const timer = isGame ? window.cloudBench.timer : cloudLab.timer;
                const backend = isGame ? gameEngine.renderer.backend : cloudLab.renderer.backend;
                await backend.device.queue.onSubmittedWorkDone();
                timer?.reset();
                const start = performance.now();
                this.start();
                await new Promise(resolve => {
                    const end = count + frames;
                    const tick = () => {
                        count++;
                        if (count < end) {
                            if (!isGame) request(tick);
                        } else {
                            this.onFrame = null;
                            this.pause();
                            resolve();
                        }
                    };
                    if (isGame) this.onFrame = tick;
                    else request(tick);
                });
                await backend.device.queue.onSubmittedWorkDone();
                const elapsed = performance.now() - start;
                if (!measure) return;
                return { fps: frames / (elapsed / 1000), passes: timer?.stats() ?? [], samples: timer?.frames ?? 0 };
            },
        };
    }, game, cloudBufferCapture);
    const target = game ? '/wizard_game/standalone.html' : '/cloud_lab/?radius=131&dpr=1.5';
    await page.goto(new URL(target, url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(isGame => isGame
        ? window.gameEngine?.camera && window.volumetricClouds
        : window.cloudLabFrameCount > 0 || window.cloudLabError, { timeout: 120000, polling: 200 }, game);
    if (game) await setupGame(page);
    else {
        await page.evaluate(() => {
            if (window.cloudLabError) throw new Error(window.cloudLabError);
            for (const child of document.body.children) {
                if (child.tagName !== 'CANVAS' && child.tagName !== 'SCRIPT') child.style.display = 'none';
            }
            const c = cloudLab.clouds;
            c.planet.atmosphereHeightKm = 26.2;
            Object.assign(c.planet.atmosphere, {
                rayleighPerKm: [6.27e-3, 14.8e-3, 25.5e-3], rayleighScaleHeightKm: 2.62,
                miePerKm: 0.024, mieExtinctionPerKm: 0.024, mieScaleHeightKm: 0.393, mieG: 0.76,
                ozonePerKm: [6.5e-4, 1.881e-3, 8.5e-5], groundAlbedo: 0.3,
            });
            cloudLab.composite.exposure = 10;
            const update = cloudLab.camera.update;
            cloudLab.camera.update = function (...args) {
                cloudBench.move?.();
                return update.apply(this, args);
            };
        });
    }
    await page.evaluate(() => cloudBench.pause());
    return page;
}

async function setupGame(page) {
    await page.evaluate(async () => {
        const ge = window.gameEngine;
        const { GpuPassTimer } = await import('/core/renderer/profiling/gpuPassTimer.js');
        const { rendererCore, backend, cloudRenderer, cloudComposite } = ge.renderer;
        const timer = cloudBench.timer = new GpuPassTimer(backend.device);
        window.volumetricClouds.gpuTimer = timer;
        cloudComposite.gpuTimer = timer;
        const begin = rendererCore.beginFrame;
        rendererCore.beginFrame = function (...args) {
            const frame = begin.apply(this, args);
            if (frame) {
                timer.beginFrame();
                backend.endRenderPassForCompute();
                timer.mark(backend.getCommandEncoder(), '__start');
            }
            return frame;
        };
        const end = rendererCore.endFrame;
        rendererCore.endFrame = function (frame) {
            backend.endRenderPassForCompute();
            const encoder = backend.getCommandEncoder();
            timer.mark(encoder, '__end');
            timer.resolve(encoder);
            end.call(this, frame);
            timer.collect();
            cloudBench.onFrame?.();
        };
        // WebGPU timestamps are pass boundaries. Isolate the cirrus draws in the benchmark.
        const timeRenderPass = (encoder, label, fn) => {
            const beginPass = encoder.beginRenderPass;
            encoder.beginRenderPass = function (descriptor) {
                return beginPass.call(this, { ...descriptor, timestampWrites: timer.timestampWrites(label) });
            };
            try { return fn(); }
            finally { delete encoder.beginRenderPass; }
        };
        const drawCirrus = cloudRenderer.renderCirrus;
        cloudRenderer.renderCirrus = function (camera, environment, uniforms, part, forceShell) {
            backend.endRenderPassForCompute();
            const value = timeRenderPass(backend.getCommandEncoder(), `cirrus ${part}`,
                () => {
                    backend.resumeRenderPass();
                    return drawCirrus.call(this, camera, environment, uniforms, part, forceShell);
                });
            backend.endRenderPassForCompute();
            backend.resumeRenderPass();
            return value;
        };
        let compositeInputs;
        const composite = cloudComposite.render;
        cloudComposite.render = function (encoder, target, atmosphere) {
            compositeInputs = [target, atmosphere];
            return composite.call(this, encoder, target, atmosphere);
        };
        cloudBench.measureCirrus = async (frames, includeVolume = false, diagnostic = null) => {
            await backend.device.queue.onSubmittedWorkDone();
            let background;
            if (diagnostic === 'observe-drained') {
                const active = () => {
                    const water = ge.waterService;
                    return Boolean(water?._busy || water?._lakeCells?.planning || water?._lakeCells?.reading || ge.riverFieldService?.busy);
                };
                const start = performance.now();
                const initiallyActive = active();
                // A paused frame loop still has outstanding lake and river jobs.
                while (active() && performance.now() - start < 45000) await new Promise(resolve => setTimeout(resolve, 25));
                await backend.device.queue.onSubmittedWorkDone();
                background = { initiallyActive, stillActive: active(), drainMs: performance.now() - start };
            }
            timer.reset();
            const clouds = window.volumetricClouds;
            const forceShell = true;
            const priorDefault = backend._defaultRenderTarget;
            const priorTarget = backend._currentRenderTarget;
            const target = ge.renderer.postProcessing._fakeRenderTarget();
            backend._defaultRenderTarget = target;
            const nearCirrus = ge.renderer._cameraAboveCirrus();
            const rows = [];
            const byPasses = new WeakMap();
            const ingest = timer._ingest;
            const timed = timer.enabled;
            const observe = diagnostic?.startsWith('observe');
            const compositeOnly = diagnostic === 'observe-composite';
            const volumeOnly = diagnostic === 'volume' || diagnostic === 'observe-volume';
            if (diagnostic === 'wall' || observe) timer.enabled = false;
            const queue = backend.device.queue;
            const queueOverrides = new Map();
            let waitingRow;
            let submittingReplay = false;
            let heartbeat;
            if (observe) {
                for (const name of ['submit', 'writeBuffer', 'writeTexture', 'copyExternalImageToTexture']) {
                    const method = queue[name];
                    queueOverrides.set(name, Object.getOwnPropertyDescriptor(queue, name));
                    queue[name] = function (...args) {
                        if (waitingRow && !submittingReplay && waitingRow.queueOps.length < 8) {
                            waitingRow.queueOps.push({ name, caller: new Error().stack.split('\n').slice(2, 5) });
                        }
                        return method.apply(this, args);
                    };
                }
                heartbeat = setInterval(() => {
                    if (!waitingRow) return;
                    const now = performance.now();
                    waitingRow.maxEventGapMs = Math.max(waitingRow.maxEventGapMs, now - waitingRow.lastBeat);
                    waitingRow.lastBeat = now;
                    waitingRow.heartbeats++;
                }, 2);
            }
            if (diagnostic === 'bracket') {
                const timestampWrites = timer.timestampWrites;
                timer.timestampWrites = function (name) {
                    return name.startsWith('__') ? timestampWrites.call(this, name) : undefined;
                };
            }
            if (diagnostic) timer._ingest = function (passes, stamps) {
                const row = byPasses.get(passes);
                if (row) {
                    const start = stamps[passes[0].end];
                    row.gpu = passes.map(pass => [pass.name, Number(stamps[pass.begin] - start) / 1e6,
                        Number(stamps[pass.end] - start) / 1e6]);
                    row.readbackMs = performance.now() - row.wallStart;
                }
                ingest.call(this, passes, stamps);
            };
            let elapsed = 0;
            const warm = includeVolume ? 6 : 0;
            try {
                for (let i = 0; i < frames + warm; i++) {
                    if (i === warm) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        timer.reset();
                        if (includeVolume) clouds._neuralLighting.reset();
                    }
                    const t0 = performance.now();
                    timer.beginFrame();
                    backend.setRenderTarget(target);
                    const encoder = backend.getCommandEncoder();
                    timer.mark(encoder, '__start');
                    const draw = part => {
                        timeRenderPass(encoder, `cirrus ${part}`, () => {
                            backend.resumeRenderPass();
                            drawCirrus.call(cloudRenderer, ge.renderer.camera, ge.environmentState, ge.renderer.uniformManager, part, forceShell);
                            backend.endRenderPassForCompute();
                        });
                    };
                    if (diagnostic === 'attachment') {
                        const [scene] = compositeInputs;
                        const pass = encoder.beginRenderPass({ label: 'attachment-only replay',
                            colorAttachments: [{ view: scene.colorView, loadOp: 'load', storeOp: 'store' }],
                            timestampWrites: timer.timestampWrites('attachment-only replay'),
                        });
                        pass.end();
                    } else if (!volumeOnly && !compositeOnly) draw('far');
                    if (includeVolume && diagnostic !== 'attachment' && !compositeOnly) {
                        // Replay the last game pose and force refreshes to include the
                        // per-frame lookup and shadow costs of a moving, animated scene.
                        clouds._lastShadowInputs = null;
                        cloudComposite._hazeKey = null;
                        clouds.compute(null, encoder);
                    }
                    if (includeVolume && diagnostic !== 'attachment' && !volumeOnly) {
                        composite.call(cloudComposite, encoder, ...compositeInputs);
                    }
                    if (nearCirrus && diagnostic !== 'attachment' && !volumeOnly && !compositeOnly) draw('near');
                    timer.mark(encoder, '__end');
                    if (diagnostic === 'resolve-only') {
                        encoder.resolveQuerySet(timer.querySet, 0, timer._cursor, timer.resolveBuffer, 0);
                    } else {
                        timer.resolve(encoder);
                    }
                    const row = diagnostic && i >= warm ? { wallStart: t0, encodeMs: performance.now() - t0 } : null;
                    if (row) byPasses.set(timer._passes, row);
                    submittingReplay = true;
                    backend.submitCommands();
                    submittingReplay = false;
                    if (row) row.submitMs = performance.now() - t0 - row.encodeMs;
                    if (observe && row) {
                        waitingRow = row;
                        Object.assign(row, { lastBeat: performance.now(), heartbeats: 0, maxEventGapMs: 0, queueOps: [] });
                    }
                    timer.collect();
                    await backend.device.queue.onSubmittedWorkDone();
                    if (i >= warm) elapsed += performance.now() - t0;
                    if (row) {
                        row.wallMs = performance.now() - t0;
                        if (observe) {
                            row.maxEventGapMs = Math.max(row.maxEventGapMs, performance.now() - row.lastBeat);
                            delete row.lastBeat;
                            waitingRow = null;
                        }
                        rows.push(row);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 30));
                const passes = [...timer.samples].map(([name, values]) => {
                    const samples = [...values].sort((a, b) => a - b);
                    return { name, count: samples.length, avg: values.reduce((sum, ms) => sum + ms, 0) / values.length,
                        p50: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * 0.95)],
                        max: samples.at(-1), last: values.at(-1) };
                });
                for (const row of rows) delete row.wallStart;
                const wall = rows.map(row => row.wallMs).sort((a, b) => a - b);
                return { passes, samples: timer.frames, meanWallMs: elapsed / frames,
                    ...(background ? { background } : {}),
                    ...(diagnostic ? { rows, wall: { p50: wall[Math.floor(wall.length / 2)], p95: wall[Math.floor(wall.length * 0.95)],
                        max: wall.at(-1) } } : {}) };
            } finally {
                if (observe) {
                    clearInterval(heartbeat);
                    for (const [name, descriptor] of queueOverrides) {
                        if (descriptor) Object.defineProperty(queue, name, descriptor);
                        else delete queue[name];
                    }
                }
                if (diagnostic) {
                    timer.enabled = timed;
                    delete timer._ingest;
                    if (diagnostic === 'bracket') delete timer.timestampWrites;
                }
                backend._defaultRenderTarget = priorDefault;
                backend.setRenderTarget(priorTarget);
            }
        };
        if (ge.cameraMode !== 'manual') ge.toggleCameraMode();
        ge.engineConfig.rendering.maxFps = 0;
        ge.engineConfig.rendering.adaptive.enabled = false;
        const canvas = document.querySelector('canvas');
        for (const el of document.body.children) {
            if (!el.contains(canvas) && el.tagName !== 'SCRIPT') el.style.display = 'none';
        }
        for (const el of canvas.parentElement.children) {
            if (el !== canvas) el.style.display = 'none';
        }
        ge.gameTime.setFrozen(true);
        ge.starSystem.paused = true;
        const write = cloudRenderer._writeLayerParams;
        cloudRenderer._writeLayerParams = function (layer, part, params = this._cirrusParamData) {
            write.call(this, layer, part, params);
            params[8] = 60;
            params[12] = 1;
            params[13] = 0;
        };
        const sync = cloudRenderer._syncCloudLayers;
        cloudRenderer._syncCloudLayers = function (layers) { return sync.call(this, cloudBench.cirrusLayers ?? layers, 1); };
        ge.environmentState.forceCirrusOnly = true;
        window.cloudBench.initialSettings = { ...window.volumetricClouds.settings };
        cloudBench.coverageFromWeather = { ...ge.renderer._cloudConfig.coverageFromWeather };
        const render = ge.renderer.render;
        ge.renderer.render = function (...args) {
            cloudBench.setCamera?.(args[0]);
            return render.apply(this, args);
        };
    });
}

async function setCase(page, test, overrides) {
    await page.bringToFront();
    await page.evaluate(async (test, isGame, overrides) => {
        const c = isGame ? window.volumetricClouds : cloudLab.clouds;
        const motion = { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 };
        // Reset to the revision's defaults so every scenario is independent.
        const defaults = isGame ? cloudBench.initialSettings : (await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js')).DEFAULT_CLOUD_SETTINGS;
        for (const key of Object.keys(c.settings)) {
            if (!Object.hasOwn(defaults, key)) delete c.settings[key];
        }
        const runtimeSettings = !isGame
            ? (await import('/wizard_game/runtimeConfigs.js')).createEngineConfig().rendering.volumetricClouds.settings
            : {};
        const settings = { ...runtimeSettings, coverage: 0.20 };
        const { weatherPreset, ...extra } = test.extra;
        Object.assign(c.settings, defaults, settings, motion, extra, overrides);
        if (weatherPreset) {
            const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
            const preset = WEATHER_CONFIG.effects[weatherPreset];
            const { min, max } = isGame ? cloudBench.coverageFromWeather : { min: 0.08, max: 0.28 };
            c.settings.coverage = overrides.coverage ?? (min + (max - min) * preset.cloudCoverage);
            if (!isGame) c.weather = preset.clouds;
        } else if (!isGame) c.weather = null;
        c._evolve = 0;
        c._boil = 0;
        c._windShape = [0, 0, 0];
        c._windDetail = [0, 0, 0];
        c._shadowFrame = null;
        c._neuralLighting?.reset();
        c.resetHistory();
        c._frame = 0;
        if (!isGame) {
            cloudLab.camera.setView(test.view);
            let frame = 0;
            cloudBench.move = test.motion ? () => {
                const i = frame++;
                const yaw = test.motion.headingPerFrame * Math.min(i, 32);
                cloudLab.camera.setView({ ...test.view, headingDeg: test.view.headingDeg + yaw,
                    altitudeKm: test.view.altitudeKm + i * test.motion.climbPerFrame,
                    lonDeg: i * test.motion.longitudePerFrame });
            } : test.flight ? () => {
                cloudLab.camera.setView({ ...test.view, altitudeKm: test.view.altitudeKm + frame * 0.016,
                    headingDeg: test.view.headingDeg + frame * 0.13, lonDeg: frame * 0.018 });
                c._windShape = [-frame * 0.004, 0, 0];
                c._windDetail = [-frame * 0.0064, 0, 0];
                c._evolve = frame * 0.002;
                c._boil = frame * 0.0004;
                frame++;
            } : null;
            cloudLab.sun.elevationDeg = test.elevation;
            cloudLab.sun.azimuthDeg = test.azimuth;
            c.moonDirection = [0.5, Math.SQRT1_2, -0.5];
            c.moonIlluminance = test.moon ? 0.15 : 0;
            return;
        }
        const ge = window.gameEngine;
        const weather = ge.renderer.weatherController;
        weather.config.windChangeChancePerSecond = 0;
        weather._windAngle = 0;
        weather._targetWindAngle = 0;
        const preset = weatherPreset ?? 'partly_cloudy';
        // The usual form of each weather, so that runs match.
        weather._random = () => 0;
        weather.config.variantChangeChancePerSecond = 0;
        weather.setWeatherPreview?.(preset);
        if (!weather.setWeather(preset, true)) throw new Error(`Weather preset unavailable: ${preset}`);
        const gt = ge.gameTime;
        const hour = test.azimuth === 55 ? 18 + test.elevation / 15 : (90 - test.elevation) / 15;
        gt.dayStartTime = gt._frozenAt - ((gt.currentDay - gt.startDay) + hour / 24) * gt.dayDurationMs;
        const { altitudeKm, headingDeg, pitchDeg } = test.view;
        const pitch = pitchDeg * Math.PI / 180;
        const center = ge.planetConfig.origin;
        let frame = 0;
        cloudBench.setCamera = gameState => {
            if (ge.cameraMode !== 'manual') ge.toggleCameraMode();
            const i = frame++;
            if (test.cloudDeltaSeconds) {
                const dt = i * test.cloudDeltaSeconds;
                c._windShape = c.windDirection.map(x => -x * defaults.windSpeedKmS * dt);
                c._windDetail = c._windShape.map(x => x * 1.6);
                c._evolve = dt * defaults.weatherEvolveKmS;
                c._boil = dt * defaults.boilKmS;
            }
            const path = test.motion;
            const heading = (headingDeg + (path?.headingPerFrame ?? 0) * Math.min(i, 32)) * Math.PI / 180;
            const longitude = ((test.view.lonDeg ?? 0) + i * (path?.longitudePerFrame ?? 0)) * Math.PI / 180;
            const latitude = ((test.view.latDeg ?? 0) + i * (path?.latitudePerFrame ?? 0)) * Math.PI / 180;
            const radius = ge.planetConfig.radius + (altitudeKm + i * (path?.climbPerFrame ?? 0)) * 1000;
            const radial = [-Math.cos(longitude) * Math.cos(latitude), Math.sin(latitude), Math.sin(longitude) * Math.cos(latitude)];
            const east = [Math.sin(longitude), 0, Math.cos(longitude)];
            const north = [Math.cos(longitude) * Math.sin(latitude), Math.cos(latitude), -Math.sin(longitude) * Math.sin(latitude)];
            const x = center.x + radial[0] * radius;
            const y = center.y + radial[1] * radius;
            const z = center.z + radial[2] * radius;
            ge.camera.setPosition(x, y, z);
            const offset = axis => (radial[axis] * Math.sin(pitch) + (east[axis] * Math.sin(heading)
                + north[axis] * Math.cos(heading)) * Math.cos(pitch)) * 1000;
            const target = { x: x + offset(0), y: y + offset(1), z: z + offset(2) };
            ge.camera.lookAt(target.x, target.y, target.z);
            gameState.camera = { ...gameState.camera, position: { x, y, z }, target };
        };
        ge.renderer._cloudConfig.coverageFromWeather = { min: c.settings.coverage, max: c.settings.coverage };
        c.enabled = !test.extra.cumulusOff;
        ge.renderer.cloudRenderer.enabled = !test.extra.cirrusOff;
        ge.renderer.cloudRenderer.setCirrusQuality(test.extra.cirrusQuality ?? 'high');
        cloudBench.cirrusLayers = null;
        if (test.extra.cirrusType) {
            const { CloudTypes } = await import('/templates/clouds/cloudTypeDefinitions.js');
            const type = CloudTypes[test.extra.cirrusType];
            const atmo = ge.planetConfig.atmosphereHeight;
            cloudBench.cirrusLayers = [{ ...type, name: 'high', altMin: 0.38 * atmo, altMax: 0.72 * atmo, coverage: 0.45 }];
        }
    }, test, game, overrides);
}

async function imageDifference(name) {
    const imgs = await Promise.all(['before', 'after'].map(side => fs.readFile(path.join(output, `${name}-${side}.png`))));
    const [a, b] = imgs.map(image => PNG.sync.read(image));
    if (a.width !== b.width || a.height !== b.height) throw new Error(`Frame size mismatch for ${name}`);
    const bins = new Uint32Array(256);
    let sum = 0;
    let over5 = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        const diff = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]));
        bins[diff]++;
        sum += diff;
        if (diff > 5) over5++;
    }
    const pixels = a.width * a.height;
    function percentile(fraction) {
        let count = 0;
        return bins.findIndex(bin => (count += bin) >= fraction * pixels);
    }
    return { meanMaxRgb: sum / pixels, p95: percentile(0.95), p99: percentile(0.99), p999: percentile(0.999),
        max: bins.findLastIndex(bin => bin > 0), fractionOver5: over5 / pixels };
}

async function referenceImageError(name, opacity, skyMasks) {
    const shots = await Promise.all(['teacher', 'before', 'after'].map(async side =>
        PNG.sync.read(await fs.readFile(path.join(output, `${name}-${side}.png`)))));
    const width = referenceWidth;
    const height = referenceHeight;
    const sample = (image, x, y) => {
        const sum = [0, 0, 0];
        const left = Math.floor(x * image.width / width);
        const top = Math.floor(y * image.height / height);
        const right = Math.floor((x + 1) * image.width / width);
        const bottom = Math.floor((y + 1) * image.height / height);
        for (let j = top; j < bottom; j++) for (let i = left; i < right; i++) {
            const p = 4 * (j * image.width + i);
            for (let c = 0; c < 3; c++) sum[c] += image.data[p + c];
        }
        return sum.map(v => v / ((right - left) * (bottom - top)));
    };
    const score = (image, minimumOpacity, skyOnly) => {
        const errors = [];
        let targetLum = 0;
        let imageLum = 0;
        const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            if (opacity[pixel] < minimumOpacity || (skyOnly && skyMasks.some(mask => mask[pixel] !== 1))) continue;
            const a = sample(shots[0], x, y);
            const b = sample(image, x, y);
            errors.push(Math.max(...a.map((v, i) => Math.abs(v - b[i]))));
            targetLum += luma(a);
            imageLum += luma(b);
        }
        if (!errors.length) return { pixels: 0 };
        errors.sort((a, b) => a - b);
        return { pixels: errors.length, mae: errors.reduce((sum, v) => sum + v, 0) / errors.length,
            p95: errors[Math.floor(errors.length * 0.95)], p999: errors[Math.floor(errors.length * 0.999)],
            max: errors.at(-1), luminanceRatio: imageLum / targetLum };
    };
    return { size: [width, height], spp: imageReferenceSpp,
        all: { before: score(shots[1], 0, false), after: score(shots[2], 0, false) },
        cloudySky: { before: score(shots[1], 0.2, true), after: score(shots[2], 0.2, true) } };
}

async function conditions(page) {
    return page.evaluate(isGame => {
        const c = isGame ? window.volumetricClouds : cloudLab.clouds;
        let p = c._prev?.pos;
        let sun = c.sunDirection;
        if (isGame) {
            const { renderer, planetConfig } = gameEngine;
            const center = planetConfig.origin;
            const position = renderer.camera.position;
            const direction = renderer.lightingController.getSunDirection();
            p = ['x', 'y', 'z'].map(axis => position[axis] - center[axis]);
            sun = ['x', 'y', 'z'].map(axis => direction[axis]);
        }
        const sunCos = p.reduce((sum, x, i) => sum + x * sun[i], 0) / (Math.hypot(...p) * Math.hypot(...sun));
        const rays = c.getOutputs().size;
        return {
            sunElevation: Math.asin(Math.min(1, Math.max(-1, sunCos))) * 180 / Math.PI,
            moonIlluminance: c.enabled ? c.moonIlluminance : null,
            cloudSize: c.enabled ? c.getOutputs().size : null,
            // Pixels of the ray target. Only part of them are traced (CloudRayPairs.js).
            rayTargetPixels: c.enabled ? rays[0] * rays[1] : 0,
            detail: c.settings.cloudDetail,
            orbitWeight: c.enabled ? c.farProxyWeight : null,
            coverage: c.settings.coverage,
            weather: c.weather,
            neuralCacheActive: !!c._neuralLighting?.current,
            historyActive: !!c._historyActive,
        };
    }, game);
}

async function captureMotion(page, test, side, settings) {
    await setCase(page, test, settings);
    if (motionWarmFrames) await page.evaluate(frames => cloudBench.run(frames, false), motionWarmFrames);
    const folder = path.join(output, test.name, side);
    await fs.mkdir(folder, { recursive: true });
    const poses = [];
    for (let frame = 0; frame < motionFrames; frame++) {
        await page.evaluate(() => cloudBench.run(1, false));
        const pose = await page.evaluate(isGame => {
            const camera = isGame ? gameEngine.renderer.camera : cloudLab.camera;
            const c = isGame ? window.volumetricClouds : cloudLab.clouds;
            return { view: Array.from(camera.matrixWorldInverse.elements),
                projection: Array.from(camera.projectionMatrix.elements), cloudCamera: c._prev,
                neuralLighting: !!c._neuralLighting?.current,
                historyValid: c._uniformData[49 * 4 + 2] === 2 };
        }, game);
        poses.push(pose);
        await page.screenshot({ path: path.join(folder, `${String(frame).padStart(3, '0')}.png`) });
        if (cloudBufferCapture) {
            const raw = await page.evaluate(async isGame => {
                const c = isGame ? window.volumetricClouds : cloudLab.clouds;
                const color = c._historyActive ? c._history[c._outputIndex] : c._target.color;
                const { depth } = c._target;
                if (color.width !== depth.width || color.height !== depth.height) throw new Error('Expected full-size resolved cloud depth');
                const device = c.device;
                const encoder = device.createCommandEncoder();
                const copies = [color, depth].map((texture, i) => {
                    const row = texture.width * (i ? 4 : 8);
                    const bytesPerRow = Math.ceil(row / 256) * 256;
                    const buffer = device.createBuffer({ size: bytesPerRow * texture.height,
                        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texture.width, texture.height]);
                    return { buffer, row, bytesPerRow };
                });
                device.queue.submit([encoder.finish()]);
                return Promise.all(copies.map(async ({ buffer, row, bytesPerRow }) => {
                    await buffer.mapAsync(GPUMapMode.READ);
                    const padded = new Uint8Array(buffer.getMappedRange());
                    const bytes = new Uint8Array(row * color.height);
                    for (let y = 0; y < color.height; y++) {
                        bytes.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
                    }
                    buffer.destroy();
                    return bytes.toBase64();
                }));
            }, game);
            await Promise.all(raw.map((data, i) =>
                fs.writeFile(path.join(folder, `${String(frame).padStart(3, '0')}.${i ? 'r32' : 'rgba16'}`), Buffer.from(data, 'base64'))));
        }
    }
    await fs.writeFile(path.join(folder, 'poses.json'), JSON.stringify(poses));
}

try {
    await fs.mkdir(output, { recursive: true });
    const firstPage = await open(before);
    const pages = [firstPage, before === after ? firstPage : await open(after)];
    const result = { before, after, chrome: await browser.version(), width, height, dpr: 1.5,
        game, beforeSettings, afterSettings, sampleFrames, warmFrames, rounds, cases: {} };
    for (const test of cases) {
        let teacherOpacity;
        const skyMasks = [];
        const runs = { before: [], after: [] };
        for (let round = 0; round < rounds; round++) {
            for (const index of (round % 2 ? [1, 0] : [0, 1])) {
                const page = pages[index];
                const label = index ? 'after' : 'before';
                const settings = index ? { ...test.after, ...afterSettings } : beforeSettings;
                await setCase(page, test, settings);
                if (warmFrames > 0) await page.evaluate(frames => cloudBench.run(frames, false), warmFrames);
                const metrics = await page.evaluate(frames => cloudBench.run(frames, true), sampleFrames);
                metrics.conditions = await conditions(page);
                const rayPass = metrics.conditions.orbitWeight >= 0.999 ? 'clouds orbit' : 'clouds raymarch';
                if (!metrics.samples || (metrics.conditions.cloudSize && !metrics.passes.some(pass => pass.name === rayPass))) {
                    throw new Error(`Missing WebGPU timestamps for ${test.name} (${label})`);
                }
                runs[label].push(metrics);
                if (capture && round === 0) {
                    await page.screenshot({ path: path.join(output, `${test.name}-${label}.png`) });
                    if (test.flight) {
                        for (let frame = 1; frame <= flightFrames; frame++) {
                            await page.evaluate(() => cloudBench.run(3, false));
                            await page.screenshot({ path: path.join(output, `${test.name}-${label}-${frame}.png`) });
                        }
                    }
                }
                if (imageReferenceSpp > 0 && round === 0 && !test.motion && metrics.conditions.cloudSize) {
                    const dimensions = { width: referenceWidth, height: referenceHeight };
                    skyMasks.push(await page.evaluate(readReferenceSkyMask, dimensions));
                    if (index === 1) {
                        teacherOpacity = await page.evaluate(prepareCloudImageReference, { ...dimensions, spp: imageReferenceSpp });
                        try {
                            await page.evaluate(() => cloudBench.run(1, false));
                            await page.screenshot({ path: path.join(output, `${test.name}-teacher.png`) });
                            skyMasks.push(await page.evaluate(readReferenceSkyMask, dimensions));
                        } finally {
                            await page.evaluate(() => cloudBench.releaseImageReference());
                        }
                    }
                }
                if (game && isolatedStackFrames > 0 && metrics.conditions.cloudSize) {
                    metrics.isolatedCloudStack = await page.evaluate((frames, mode) => cloudBench.measureCirrus(frames, true, mode),
                        isolatedStackFrames, isolatedStackMode);
                }
                if (game && stallReplayFrames > 0 && index === 1 && round === 0 && metrics.conditions.cloudSize) {
                    metrics.stallReplays = await page.evaluate(async (frames, modes) => {
                        const results = {};
                        for (const mode of modes) {
                            const key = Object.hasOwn(results, mode) ? `${mode}-repeat` : mode;
                            results[key] = await cloudBench.measureCirrus(frames, true, mode);
                        }
                        return results;
                    }, stallReplayFrames, stallReplayModes);
                }
                if (game && neuralReferencePaths > 0 && round === 0 && metrics.conditions.neuralCacheActive) {
                    metrics.neuralReference = await page.evaluate(measureNeuralReference, neuralReferencePaths);
                }
                if (test.motion && motionFrames > 0 && round === 0) {
                    await captureMotion(page, test, label, settings);
                }
                if (game && test.name.startsWith('cirrus-') && !test.extra.cirrusOff) {
                    metrics.isolatedCirrus = await page.evaluate(frames => cloudBench.measureCirrus(frames), sampleFrames);
                }
            }
        }
        result.cases[test.name] = { ...test, ...runs, image: capture ? await imageDifference(test.name) : undefined,
            imageReference: teacherOpacity ? await referenceImageError(test.name, teacherOpacity, skyMasks) : undefined };
        await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify(result, null, 2) + '\n');
        const time = side => runs[side].map(run => run.passes.find(pass => pass.name === 'total')?.avg.toFixed(2) ?? run.fps.toFixed(2)).join(', ');
        console.log(`${test.name.padEnd(23)} ${time('before')} -> ${time('after')}`);
    }
} finally {
    await browser.close();
}
