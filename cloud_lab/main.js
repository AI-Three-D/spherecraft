import { Renderer } from 'engine/renderer/index.js';
import { WebGPUBackend } from 'engine/renderer/backend/webgpuBackend.js';
import { GpuTimerModule } from 'engine/renderer/profiling/gpuPassTimer.js';
import { VolumetricCloudsModule, DEFAULT_CLOUD_SETTINGS } from 'engine/renderer/volumetricClouds/VolumetricCloudsModule.js';
import { LabCompositeModule } from './labComposite.js';
import { FlyCamera, localFrame } from './flyCamera.js';
import { buildPanel } from './labPanel.js';
import { PerfOverlay } from './perfOverlay.js';

const params = new URLSearchParams(location.search);
const planetRadiusKm = Number(params.get('radius')) || 6360;

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const hud = document.querySelector('#hud');
const panelRoot = document.querySelector('#panel');

const backend = new WebGPUBackend(canvas, { optionalFeatures: ['timestamp-query'] });
const renderer = new Renderer({ canvas, backend, ownsBackend: true, clearColor: [0, 0, 0, 1] });
const timerModule = new GpuTimerModule();
const camera = new FlyCamera(canvas, { planetRadiusKm });
const clouds = new VolumetricCloudsModule({ planet: { radiusKm: planetRadiusKm } });
const composite = new LabCompositeModule(clouds);

// Sun angles are in the start site's frame (+Y up, north -Z, east +X).
const sun = { elevationDeg: 18, azimuthDeg: 235, cycle: false, cycleSpeed: 1.5 };
const site = localFrame([0, 1, 0]);
clouds.windDirection = site.east;

function applySun() {
    const e = sun.elevationDeg * Math.PI / 180, a = sun.azimuthDeg * Math.PI / 180;
    clouds.sunDirection = [0, 1, 2].map(i =>
        site.north[i] * Math.cos(e) * Math.cos(a) + site.east[i] * Math.cos(e) * Math.sin(a) + site.up[i] * Math.sin(e));
}

const PRESETS = [
    { key: '1', name: 'Ground', view: { altitudeKm: 0.15, headingDeg: 200, pitchDeg: 14 } },
    { key: '2', name: 'Under the base', view: { altitudeKm: 1.2, headingDeg: 150, pitchDeg: 5 } },
    { key: '3', name: 'Inside', view: { altitudeKm: 3.0, headingDeg: 110, pitchDeg: 2 } },
    { key: '4', name: 'Above the tops', view: { altitudeKm: 7.5, headingDeg: 200, pitchDeg: -8 } },
    { key: '5', name: 'Stratosphere', view: { altitudeKm: 35, headingDeg: 220, pitchDeg: -18 } },
    { key: '6', name: 'Low orbit', view: { latDeg: -22, altitudeKm: 1800, headingDeg: 0, pitchDeg: -52 } },
    { key: '7', name: 'Planet', view: { altitudeKm: planetRadiusKm * 2.4, headingDeg: 0, pitchDeg: -89.5 } },
];

function goTo(preset) {
    camera.setView(preset.view);
    clouds.resetHistory();
    status.textContent = `${preset.name}`;
}

const presetBar = document.querySelector('#presets');
for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.textContent = `${preset.key} ${preset.name}`;
    button.addEventListener('click', () => goTo(preset));
    presetBar.append(button);
}

const s = clouds.settings;
// Canvas pixels per CSS pixel. Clouds and sky are soft, so 1× is the default; Retina 2× costs ~4×.
const view = { pixelRatio: Number(params.get('dpr')) || 1 };
const bind = (object, key) => ({ get: () => object[key], set: (v) => { object[key] = v; } });
const setting = (label, key, min, max, extra = {}) => ({ label, min, max, ...bind(s, key), ...extra });

const sections = [
    { title: 'Sun & exposure', open: true, controls: [
        { label: 'Sun elevation', min: -12, max: 90, digits: 1, ...bind(sun, 'elevationDeg') },
        { label: 'Sun azimuth', min: 0, max: 360, digits: 0, ...bind(sun, 'azimuthDeg') },
        { label: 'Animate sun', type: 'toggle', ...bind(sun, 'cycle') },
        { label: 'Exposure', min: 1, max: 40, digits: 1, ...bind(composite, 'exposure') },
    ] },
    { title: 'Coverage & shape', open: true, controls: [
        setting('Coverage', 'coverage', 0, 1),
        setting('Weather contrast', 'weatherContrast', 0, 5),
        setting('Cloud type', 'cloudType', 0, 1),
        setting('Type variance', 'typeVariance', 0, 3),
        setting('Weather systems', 'systemStrength', 0, 3),
        setting('System size (km)', 'systemTileKm', 500, 8000, { digits: 0 }),
        setting('System swirl', 'systemWarp', 0, 2),
        setting('Density (1/km)', 'extinction', 2, 120, { digits: 1 }),
        setting('Detail erosion', 'detailErosion', 0, 0.8),
        setting('Detail warp', 'detailWarp', 0, 2),
        setting('Cloud base (km)', 'cloudBottomKm', 0.2, 6),
        setting('Cloud top (km)', 'cloudTopKm', 1, 14),
        setting('Shape tile (km)', 'shapeTileKm', 3, 60, { digits: 1 }),
        setting('Detail tile (km)', 'detailTileKm', 0.3, 6),
        setting('Weather tile (km)', 'weatherTileKm', 20, 400, { digits: 0 }),
    ] },
    { title: 'Lighting', controls: [
        setting('Forward g', 'phaseForward', 0, 0.95),
        setting('Back g', 'phaseBack', -0.9, 0),
        setting('Back lobe weight', 'backLobeWeight', 0, 1),
        setting('Powder', 'powder', 0, 1),
        setting('Ambient', 'ambient', 0, 3),
        setting('Daylight sun gain', 'daylightSunGain', 1, 2),
        setting('Daylight sky fill', 'daylightSkyFill', 0, 0.15, { digits: 3 }),
        setting('MS extinction', 'msExtinction', 0.05, 1),
        setting('MS scattering', 'msScattering', 0, 1),
        setting('MS phase', 'msPhase', 0, 1),
        setting('Albedo', 'albedo', 0.5, 1, { digits: 3 }),
        { label: 'Ground shadows', min: 0, max: 1.5, ...bind(composite, 'shadowStrength') },
        setting('Shadow fade from (km)', 'shadowFadeStartKm', 0, 20),
        setting('Shadow gone at (km)', 'shadowFadeEndKm', 0.5, 40),
    ] },
    { title: 'Wind', controls: [
        setting('Wind (km/s)', 'windSpeedKmS', 0, 0.2, { digits: 3 }),
        setting('Time scale', 'timeScale', 0, 60, { digits: 1 }),
        setting('Top skew (km)', 'windSkewKm', 0, 4),
    ] },
    { title: 'Quality & debug', controls: [
        { label: 'Pixel ratio', type: 'select', options: [[1, '1× (CSS px)'], [1.5, '1.5×'], [2, '2× (Retina)']], ...bind(view, 'pixelRatio') },
        setting('Resolution scale', 'resolutionScale', 0.25, 1),
        { label: 'Interleave', type: 'select', options: [[2, '2×2 (¼ rays/frame)'], [1, 'off']], ...bind(s, 'interleave') },
        setting('Light steps', 'lightSteps', 2, 10, { step: 1, digits: 0 }),
        { label: 'Far layer proxy', type: 'toggle', ...bind(s, 'farProxy') },
        setting('Proxy from (km)', 'proxyStartKm', 2, 200, { digits: 0 }),
        setting('Proxy full (km)', 'proxyEndKm', 5, 400, { digits: 0 }),
        setting('Max steps', 'maxSteps', 32, 512, { step: 1, digits: 0 }),
        setting('Min step (km)', 'minStepKm', 0.01, 0.2, { digits: 3 }),
        setting('Step growth', 'stepGrowth', 0.002, 0.05, { digits: 3 }),
        setting('Max step (km)', 'maxStepKm', 0.1, 3),
        setting('Light step (km)', 'lightStepKm', 0.01, 0.3, { digits: 3 }),
        setting('Temporal blend', 'temporalBlend', 0.02, 1),
        { label: 'Clouds', type: 'toggle', ...bind(clouds, 'enabled') },
        { label: 'Step heatmap', type: 'toggle', ...bind(s, 'debugSteps') },
        { label: 'View', type: 'select', options: [[0, 'Final'], [1, 'Clouds only'], [2, 'Cloud opacity'], [3, 'Ground shadow']], ...bind(composite, 'viewMode') },
    ] },
];
const panel = buildPanel(panelRoot, sections);
document.querySelector('#reset').addEventListener('click', () => {
    Object.assign(s, DEFAULT_CLOUD_SETTINGS);
    panel.refresh();
});

let stopped = false;
let animation;
let perf;

function fail(error) {
    stopped = true;
    status.textContent = `Rendering failed: ${error.message ?? error}`;
    status.classList.add('error');
    console.error(error);
    window.cloudLabError = String(error.message ?? error);
}

async function start() {
    status.textContent = 'Starting WebGPU…';
    await renderer.initialize();
    renderer.backend.device.addEventListener('uncapturederror', event => fail(event.error));
    status.textContent = 'Generating cloud noise…';
    await renderer.addModule(timerModule);
    await renderer.addModule(clouds);
    await renderer.addModule(composite);
    await renderer.addModule(timerModule.endModule);
    clouds.gpuTimer = timerModule.timer;
    composite.gpuTimer = timerModule.timer;
    perf = new PerfOverlay(document.querySelector('#perf'), { timer: timerModule.timer });
    perf.runButton.addEventListener('click', () => runProfile().catch(fail));
    applySun();
    goTo(PRESETS[0]);
    status.textContent = 'Drag to look · WASD fly · Space/E up · Q/C down · Shift fast · Alt slow · wheel speed · 1–7 views · H hide UI';

    let previous = performance.now();
    let elapsed = 0;
    let hudTime = 0;
    function tick(now) {
        if (stopped) return;
        try {
            const cpuStart = performance.now();
            const intervalMs = now - previous;
            const deltaTime = Math.max(0, Math.min(intervalMs / 1000, 0.1));
            previous = now;
            elapsed += deltaTime;
            const ratio = Math.min(window.devicePixelRatio || 1, view.pixelRatio);
            const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
            const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
            if (canvas.width !== width || canvas.height !== height) renderer.resize(width, height);
            if (sun.cycle) {
                sun.elevationDeg += deltaTime * sun.cycleSpeed;
                if (sun.elevationDeg > 70) sun.elevationDeg = -10;
                panel.refresh();
            }
            applySun();
            camera.update(deltaTime, width / height);
            if (!renderer.renderFrame({ camera, deltaTime, time: elapsed })) throw new Error('GPU device lost');
            perf.frame(intervalMs, now, performance.now() - cpuStart);
            if (now - hudTime > 250) {
                hudTime = now;
                const [cw, ch] = clouds.getOutputs().size;
                const lod = clouds.proxyWeight > 0 ? ` · far proxy ${(clouds.proxyWeight * 100).toFixed(0)}%` : '';
                hud.textContent = `altitude ${formatKm(camera.altitudeKm)} · speed ${formatKm(camera.speedKmS)}/s · `
                    + `canvas ${canvas.width}×${canvas.height} · clouds ${cw}×${ch}${lod}`;
            }
            window.cloudLabFrameCount = renderer.frameCount;
            animation = requestAnimationFrame(tick);
        } catch (error) { fail(error); }
    }
    window.cloudLab = { renderer, clouds, composite, camera, sun, presets: PRESETS, goTo, timer: timerModule.timer, runProfile };
    animation = requestAnimationFrame(tick);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Visit every view, let it settle, then average GPU pass timings and FPS over a window. */
async function runProfile({ settleMs = 1500, sampleMs = 2500 } = {}) {
    const timer = timerModule.timer;
    perf.runButton.disabled = true;
    const rows = [];
    try {
        for (const preset of PRESETS) {
            goTo(preset);
            status.textContent = `Profiling: ${preset.name}…`;
            await wait(settleMs);
            timer.reset();
            const t0 = performance.now(), f0 = renderer.frameCount;
            await wait(sampleMs);
            const fps = (renderer.frameCount - f0) / ((performance.now() - t0) / 1000);
            const byName = Object.fromEntries(timer.stats().map(stat => [stat.name, stat]));
            rows.push({
                view: preset.name, fps,
                gpu: byName.total?.avg, gpuP95: byName.total?.p95,
                raymarch: byName['clouds raymarch']?.avg, temporal: byName['clouds temporal']?.avg,
                shadow: byName['clouds shadow']?.avg, atmosphere: byName['lab atmosphere']?.avg,
                composite: byName['lab composite']?.avg,
            });
        }
    } finally {
        perf.runButton.disabled = false;
    }
    const ms = (key) => ({ label: key, format: (row) => row[key] == null ? '–' : row[key].toFixed(2) });
    perf.showProfile(rows, [
        { label: 'fps', format: (row) => row.fps.toFixed(0) },
        { ...ms('gpu'), label: 'GPU ms' }, { ...ms('gpuP95'), label: 'p95' },
        ms('raymarch'), ms('temporal'), ms('shadow'), ms('atmosphere'), ms('composite'),
    ]);
    const [cw, ch] = clouds.getOutputs().size;
    const result = { canvas: [canvas.width, canvas.height], clouds: [cw, ch], settings: { ...s }, pixelRatio: view.pixelRatio, rows };
    console.table(rows);
    window.cloudLab.lastProfile = result;
    goTo(PRESETS[0]);
    return result;
}

function formatKm(km) {
    if (km < 1) return `${(km * 1000).toFixed(0)} m`;
    if (km < 100) return `${km.toFixed(2)} km`;
    return `${km.toFixed(0)} km`;
}

window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea')) return;
    const preset = PRESETS.find(p => p.key === event.key);
    if (preset) goTo(preset);
    if (event.code === 'KeyH') document.body.classList.toggle('hide-ui');
});
window.addEventListener('pagehide', () => {
    stopped = true;
    cancelAnimationFrame(animation);
    camera.dispose();
    renderer.dispose();
}, { once: true });
start().catch(fail);
