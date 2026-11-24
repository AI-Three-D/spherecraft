/* global cloudLab */
// Density-closure data from the cloud lab: node tools/neural/closureRun.mjs [scene-regex]
// Writes tools/neural/data_closure/<scene>.{closure,rays}.f32 and .json. One WebGPU client at a time.
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const pattern = new RegExp(process.argv[2] ?? '.');
const closureModel = process.env.CLOSURE_MODEL ? JSON.parse(await fs.readFile(process.env.CLOSURE_MODEL, 'utf8')) : null;
const url = process.env.LAB_URL ?? 'http://127.0.0.1:8000';
const outDir = path.resolve(process.env.CLOSURE_OUT ?? 'tools/neural/data_closure');
const views = {
    ground: { altitudeKm: 1, headingDeg: 40, pitchDeg: 14 }, horizon: { altitudeKm: 3, headingDeg: 55, pitchDeg: 4 },
    inside: { altitudeKm: 5.5, headingDeg: 55, pitchDeg: 2 }, above: { altitudeKm: 9.5, headingDeg: 55, pitchDeg: -18 },
};
const scenes = [];
for (const [place, split] of [[{ latDeg: 0, lonDeg: 0 }, 'train'], [{ latDeg: -24, lonDeg: 33 }, 'train'], [{ latDeg: 14, lonDeg: -51 }, 'test']]) {
    for (const preset of ['partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm']) {
        for (const [view, v] of Object.entries(views)) {
            scenes.push({ name: `${split}-${place.lonDeg}-${preset}-${view}`, preset, split, view: { ...v, ...place, headingDeg: v.headingDeg + place.lonDeg * 3 } });
        }
    }
}
await fs.mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, protocolTimeout: 0, args: ['--enable-unsafe-webgpu', '--disable-gpu-watchdog'],
});
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 1024, height: 640, deviceScaleFactor: 1 });
    page.on('console', m => { if (m.type() === 'error') console.log(m.text()); });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { timeout: 180000, polling: 250 });
    for (const scene of scenes.filter(s => pattern.test(s.name))) {
        const started = Date.now();
        const result = await page.evaluate(async (scene, model) => {
            const c = cloudLab.clouds;
            const { DEFAULT_CLOUD_SETTINGS } = await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js');
            const { createEngineConfig } = await import('/wizard_game/runtimeConfigs.js');
            const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
            const { TeacherGpu } = await import('/neural_lab/teacherGpu.js');
            const { closureWgsl, CLOSURE_FLOATS, CLOSURE_FIELDS } = await import('/neural_lab/closure.wgsl.js');
            const runtime = createEngineConfig().rendering.volumetricClouds.settings;
            for (const key of Object.keys(c.settings)) if (!Object.hasOwn(DEFAULT_CLOUD_SETTINGS, key)) delete c.settings[key];
            const preset = WEATHER_CONFIG.effects[scene.preset];
            Object.assign(c.settings, DEFAULT_CLOUD_SETTINGS, runtime, {
                windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0, timeScale: 0, cloudBudgetMode: 'conventional',
                coverage: 0.08 + 0.2 * preset.cloudCoverage, farProxy: false, groundProxyBelowKm: 0,
            });
            c.weather = preset.clouds; c.enabled = true;
            c._evolve = 0; c._boil = 0; c._windShape = [0, 0, 0]; c._windDetail = [0, 0, 0];
            cloudLab.camera.setView(scene.view);
            cloudLab.sun.elevationDeg = 40; cloudLab.sun.azimuthDeg = 235; c.moonIlluminance = 0;
            c.resetHistory();
            const end = cloudLab.renderer.frameCount + 5;
            while (cloudLab.renderer.frameCount < end) await new Promise(r => requestAnimationFrame(r));
            const teacher = new TeacherGpu(c);
            const snap = teacher.snapshot();
            const weather = c._ensureConventionalWeather();
            c.enabled = false;
            const pipeline = await teacher.pipeline(closureWgsl(model), 'closure data');
            const [w, h, cap] = [144, 90, 60000];
            const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
            const make = size => c.device.createBuffer({ size, usage: storage });
            const [counter, records, rays] = [make(16), make(cap * CLOSURE_FLOATS * 4), make(w * h * 16)];
            const uniforms = teacher.uniformBuffer(snap.uniforms);
            let rows = 8;
            for (let y = 0; y < h;) {
                const count = Math.min(rows, h - y);
                const raw = teacher.params(5, 1, y, w, h);
                new Float32Array(raw, 16, 12)[11] = 0.14;
                const params = teacher.uniformBuffer(raw);
                const ms = await teacher.run(pipeline, [{ buffer: uniforms }, ...snap.noise, { buffer: params }, c._linearSampler,
                    ...weather.views, { buffer: counter }, { buffer: records }, { buffer: rays }], [Math.ceil(w / 8), Math.ceil(count / 8)]);
                params.destroy();
                y += count;
                rows = Math.max(8, Math.min(h, 8 * Math.floor(rows * 40 / Math.max(ms, 1) / 8)));
            }
            const used = Math.min(cap, new Uint32Array((await teacher.read(counter, 16)).buffer)[0]);
            const encode = values => {
                const bytes = new Uint8Array(values.buffer, 0, values.byteLength);
                let s = '';
                for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                return btoa(s);
            };
            const out = { used, fields: CLOSURE_FIELDS, extinction: c.settings.extinction, pixelAngle: snap.uniforms[c.constructor.length ? 0 : 0],
                records: used ? encode((await teacher.read(records, used * CLOSURE_FLOATS * 4))) : '', rays: encode(await teacher.read(rays, w * h * 16)) };
            for (const b of [counter, records, rays, uniforms]) b.destroy();
            c.enabled = true;
            return out;
        }, scene, closureModel);
        const { records, rays, ...meta } = result;
        await fs.writeFile(path.join(outDir, `${scene.name}.closure.f32`), Buffer.from(records, 'base64'));
        await fs.writeFile(path.join(outDir, `${scene.name}.rays.f32`), Buffer.from(rays, 'base64'));
        await fs.writeFile(path.join(outDir, `${scene.name}.json`), JSON.stringify({ ...scene, ...meta }));
        console.log(`${scene.name}: ${meta.used} intervals, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
} finally {
    await browser.close();
}
