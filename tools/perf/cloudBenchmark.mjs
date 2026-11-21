import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';

// Serve the two revisions with separate HTTP servers. Only one tab renders at a time.
const [before, after, output] = process.argv.slice(2);
if (!before || !after || !output) {
    throw new Error('Usage: node tools/perf/cloudBenchmark.mjs BEFORE_URL AFTER_URL OUTPUT_DIRECTORY');
}
const game = process.env.CLOUD_BENCH_GAME === '1';
const width = Number(process.env.CLOUD_BENCH_WIDTH ?? 1024);
const height = Number(process.env.CLOUD_BENCH_HEIGHT ?? 640);
const tier = process.env.CLOUD_BENCH_TIER ?? 'ultra';
const tierScale = { ultra: 1, high: 0.67, medium: 0.33 };
const scale = Number(process.env.CLOUD_BENCH_SCALE ?? tierScale[tier]);
const afterScale = Number(process.env.CLOUD_BENCH_AFTER_SCALE ?? scale);
const checker = process.env.CLOUD_BENCH_CHECKER;
const warmFrames = Number(process.env.CLOUD_BENCH_WARM ?? 12);
const sampleFrames = Number(process.env.CLOUD_BENCH_FRAMES ?? 24);
const rounds = Number(process.env.CLOUD_BENCH_ROUNDS ?? 2);
const filter = new RegExp(process.env.CLOUD_BENCH_CASES ?? '.*');
const capture = process.env.CLOUD_BENCH_CAPTURE !== '0';
const flightFrames = Number(process.env.CLOUD_BENCH_FLIGHT_FRAMES ?? 0);
const motionFrames = Number(process.env.CLOUD_BENCH_MOTION_FRAMES ?? 0);

const ultra = {
    cloudBottomKm: 4, cloudTopKm: 12, systemTileKm: 500, largeWeatherTileKm: 260, weatherTileKm: 90,
    twilightSoftness: 0.1, temporal: false, maxSteps: 256, layerStepFit: 0.5, coverage: 0.2,
    groundProxyBelowKm: 0, farProxy: false, systemOffset: 2, cloudShape: 'domes', domeHeight: 1.5,
    shapeTileKm: 8, giantShare: 0.6, giantHeight: 3, giantScale: 5, popcornTopKm: 1.6,
    domeEdgeSharpness: 1.5, domeHeads: 1, ambient: 0.4, msScattering: 0.35, msExtinction: 0.12,
    extinction: 50, detailErosion: 0.75, aoSide: 1, inScatter: 0, sunsetDepth: 10,
    sunsetAltitudeScale: 0.35, duskSkyBoost: 1, stepFootprint: 1, spatialFilter: 1, stepStratify: true,
    stepAnchorKm: 2, detailPixelFootprint: 2, lightReuseSteps: 4, lightSteps: 6,
};
const ground = { altitudeKm: 1, headingDeg: 40, pitchDeg: 14 };
const horizon = { altitudeKm: 3, headingDeg: 55, pitchDeg: 2 };
const inside = { altitudeKm: 6, headingDeg: 55, pitchDeg: 2 };
const above = { altitudeKm: 10, headingDeg: 55, pitchDeg: -35 };
const stratus = { cloudShape: 'cut', cloudType: 0, typeVariance: 0, giantShare: 0, coverage: 0.55, inScatter: 0.7 };
const stratocumulus = { ...stratus, cloudType: 0.45, coverage: 0.65 };
const nimbostratus = { ...stratus, cloudType: 0.18, coverage: 0.86, extinction: 70, albedo: 0.8 };
const storm = { coverage: 0.68, cloudType: 0.9, giantShare: 0.9, extinction: 78, albedo: 0.85 };
const medium = { aoSide: 0, giantShare: 0, lightSteps: 4, layerStepFit: 0.25 };
const tierLook = { ultra, high: { ...ultra, aoSide: 0, lightSteps: 5 }, medium: { ...ultra, ...medium } };
if (!tierLook[tier]) throw new Error(`Unknown cloud benchmark tier ${tier}`);
const orbit = { ...above, altitudeKm: 125, pitchDeg: -56 };
const entry = (name, view, elevation, extra = {}, azimuth = 235, moon = false) =>
    ({ name, view, elevation, azimuth, moon, extra });
const motion = (test, headingPerFrame, climbPerFrame = 0, longitudePerFrame = 0) =>
    ({ ...test, motion: { headingPerFrame, climbPerFrame, longitudePerFrame } });

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
    entry('popcorn-day', ground, 35, medium),
    entry('popcorn-dawn', ground, 3, medium, 55),
    entry('popcorn-dusk', above, 5, medium),
    entry('popcorn-night', ground, -35, medium, 235, true),
    entry('stratus-day', ground, 35, stratus),
    entry('stratus-dawn', ground, 3, stratus, 55),
    entry('stratus-dusk', ground, 5, stratus),
    entry('stratus-night', ground, -35, stratus, 235, true),
    entry('stratocumulus-day', above, 35, stratocumulus),
    entry('stratocumulus-dawn', above, 3, stratocumulus, 55),
    entry('stratocumulus-dusk', horizon, 5, stratocumulus),
    entry('stratocumulus-night', horizon, -35, stratocumulus, 235, true),
    entry('nimbostratus-day', ground, 35, nimbostratus),
    entry('nimbostratus-dawn', ground, 3, nimbostratus, 55),
    entry('nimbostratus-dusk', ground, 5, nimbostratus),
    entry('nimbostratus-night', ground, -35, nimbostratus, 235, true),
    entry('storm-day', above, 35, storm),
    entry('storm-dawn', above, 3, storm, 55),
    entry('storm-dusk', above, 5, storm),
    entry('storm-night', above, -35, storm, 235, true),
    entry('ground-proxy', ground, 35, { groundProxyBelowKm: 2.3 }),
    entry('orbit-proxy', orbit, 35, { farProxy: true }),
    entry('temporal-day', ground, 35, { temporal: true, interleave: 2 }),
    { ...entry('flight-dusk', { altitudeKm: 5.8, headingDeg: 54, pitchDeg: -4 }, 5), flight: true },
    entry('clear-day', above, 35, { coverage: 0, weatherContrast: 0 }),
    motion(entry('motion-slow-dawn', ground, 3, {}, 55), 0.07),
    motion(entry('motion-fast-day', above, 35), 1.5),
    motion(entry('motion-flight-dusk', inside, 5), 0.65, 0.055, 0.032),
    motion(entry('motion-fast-night', above, -35, {}, 235, true), 1.5),
    motion(entry('motion-proxy-day', ground, 35, { groundProxyBelowKm: 2 }), 0.85, 0.042),
];
const gameCases = [
    entry('game-ground-day', ground, 35),
    entry('game-ground-dawn', ground, 3, {}, 55),
    entry('game-ground-dusk', ground, 5),
    entry('game-ground-night', ground, -35, {}, 235, true),
    entry('game-above-day', above, 35),
    entry('game-above-dusk', above, 5),
    entry('game-above-night', above, -35, {}, 235, true),
    motion(entry('game-motion-slow-dawn', ground, 3, {}, 55), 0.075),
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
];
const cases = (game ? gameCases : labCases).filter(test => filter.test(test.name));
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
        if (message.type() === 'error' && !message.text().includes('404')) console.error(url, message.text().slice(0, 700));
    });
    await page.setViewport({ width, height, deviceScaleFactor: 1.5 });
    await page.evaluateOnNewDocument((isGame) => {
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
    }, game);
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
        cloudRenderer.renderCirrus = function (camera, environment, uniforms, part) {
            backend.endRenderPassForCompute();
            const value = timeRenderPass(backend.getCommandEncoder(), `cirrus ${part}`,
                () => {
                    backend.resumeRenderPass();
                    return drawCirrus.call(this, camera, environment, uniforms, part);
                });
            backend.endRenderPassForCompute();
            backend.resumeRenderPass();
            return value;
        };
        cloudBench.measureCirrus = async frames => {
            await backend.device.queue.onSubmittedWorkDone();
            timer.reset();
            const priorDefault = backend._defaultRenderTarget;
            const priorTarget = backend._currentRenderTarget;
            const target = ge.renderer.postProcessing._fakeRenderTarget();
            backend._defaultRenderTarget = target;
            let elapsed = 0;
            try {
                for (let i = 0; i < frames; i++) {
                    const t0 = performance.now();
                    timer.beginFrame();
                    backend.setRenderTarget(target);
                    const encoder = backend.getCommandEncoder();
                    timer.mark(encoder, '__start');
                    for (const part of ['far', 'near']) {
                        if (part === 'near' && !ge.renderer._cameraAboveCirrus()) continue;
                        timeRenderPass(encoder, `cirrus ${part}`, () => {
                            backend.resumeRenderPass();
                            drawCirrus.call(cloudRenderer, ge.renderer.camera, ge.environmentState, ge.renderer.uniformManager, part);
                            backend.endRenderPassForCompute();
                        });
                    }
                    timer.mark(encoder, '__end');
                    timer.resolve(encoder);
                    backend.submitCommands();
                    timer.collect();
                    await backend.device.queue.onSubmittedWorkDone();
                    elapsed += performance.now() - t0;
                }
                return { passes: timer.stats(), samples: timer.frames, meanWallMs: elapsed / frames };
            } finally {
                backend._defaultRenderTarget = priorDefault;
                backend.setRenderTarget(priorTarget);
            }
        };
        const composite = cloudComposite.render;
        cloudComposite.render = function (encoder, ...args) {
            return timeRenderPass(encoder, 'clouds composite', () => composite.call(this, encoder, ...args));
        };
        if (ge.cameraMode !== 'manual') ge.toggleCameraMode();
        ge.engineConfig.rendering.maxFps = 0;
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
        const render = ge.renderer.render;
        ge.renderer.render = function (...args) {
            cloudBench.setCamera?.(args[0]);
            return render.apply(this, args);
        };
    });
}

async function setCase(page, test, resolutionScale) {
    await page.bringToFront();
    await page.evaluate(async (test, look, isGame, resolutionScale, checker) => {
        const c = isGame ? window.volumetricClouds : cloudLab.clouds;
        const motion = { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 };
        // Reset to the revision's defaults so every scenario is independent.
        const defaults = isGame ? cloudBench.initialSettings : (await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js')).DEFAULT_CLOUD_SETTINGS;
        Object.assign(c.settings, defaults, look, motion, { resolutionScale }, test.extra);
        if (checker !== undefined) {
            c.settings.spatialSampling = checker === '1';
            if (checker === '1') c.settings.spatialMaxRayAngle = 0;
        }
        c._evolve = 0;
        c._boil = 0;
        c._windShape = [0, 0, 0];
        c._windDetail = [0, 0, 0];
        c._shadowFrame = null;
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
            const path = test.motion;
            const heading = (headingDeg + (path?.headingPerFrame ?? 0) * Math.min(i, 32)) * Math.PI / 180;
            const longitude = ((test.view.lonDeg ?? 0) + i * (path?.longitudePerFrame ?? 0)) * Math.PI / 180;
            const latitude = (test.view.latDeg ?? 0) * Math.PI / 180;
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
    }, test, tierLook[tier], game, resolutionScale, checker);
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
    return { meanMaxRgb: sum / pixels, p95: percentile(0.95), p99: percentile(0.99), fractionOver5: over5 / pixels };
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
        return {
            sunElevation: Math.asin(Math.min(1, Math.max(-1, sunCos))) * 180 / Math.PI,
            moonIlluminance: c.enabled ? c.moonIlluminance : null,
            cloudSize: c.enabled ? c.getOutputs().size : null,
            spatialStride: c.enabled ? c._spatialStride ?? 0 : null,
            interleave: c.enabled ? c._activeK : null,
            proxyWeight: c.enabled ? c.proxyWeight : null,
        };
    }, game);
}

async function captureMotion(page, test, side, resolutionScale) {
    await setCase(page, test, resolutionScale);
    const folder = path.join(output, test.name, side);
    await fs.mkdir(folder, { recursive: true });
    const poses = [];
    for (let frame = 0; frame < motionFrames; frame++) {
        await page.evaluate(() => cloudBench.run(1, false));
        const pose = await page.evaluate(isGame => {
            const camera = isGame ? gameEngine.renderer.camera : cloudLab.camera;
            return { view: Array.from(camera.matrixWorldInverse.elements),
                projection: Array.from(camera.projectionMatrix.elements) };
        }, game);
        poses.push(pose);
        await page.screenshot({ path: path.join(folder, `${String(frame).padStart(3, '0')}.png`) });
    }
    await fs.writeFile(path.join(folder, 'poses.json'), JSON.stringify(poses));
}

try {
    await fs.mkdir(output, { recursive: true });
    const pages = [await open(before), await open(after)];
    const result = { before, after, chrome: await browser.version(), width, height, dpr: 1.5,
        tier, scale, afterScale, checker, game, sampleFrames, warmFrames, rounds, cases: {} };
    for (const test of cases) {
        const runs = { before: [], after: [] };
        for (let round = 0; round < rounds; round++) {
            for (const index of (round % 2 ? [1, 0] : [0, 1])) {
                const page = pages[index];
                const label = index ? 'after' : 'before';
                await setCase(page, test, index ? afterScale : scale);
                await page.evaluate(frames => cloudBench.run(frames, false), warmFrames);
                const metrics = await page.evaluate(frames => cloudBench.run(frames, true), sampleFrames);
                metrics.conditions = await conditions(page);
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
                if (test.motion && motionFrames > 0 && round === 0) {
                    await captureMotion(page, test, label, index ? afterScale : scale);
                }
                if (game && test.name.startsWith('cirrus-') && !test.extra.cirrusOff) {
                    metrics.isolatedCirrus = await page.evaluate(frames => cloudBench.measureCirrus(frames), sampleFrames);
                }
            }
        }
        result.cases[test.name] = { ...test, ...runs, image: capture ? await imageDifference(test.name) : undefined };
        await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify(result, null, 2) + '\n');
        const time = side => runs[side].map(run => run.passes.find(pass => pass.name === 'total')?.avg.toFixed(2) ?? run.fps.toFixed(2)).join(', ');
        console.log(`${test.name.padEnd(23)} ${time('before')} -> ${time('after')}`);
    }
} finally {
    await browser.close();
}
