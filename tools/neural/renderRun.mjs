/* global cloudLab */
// Renders the analytic/refit/neural comparison images for teacher scenes (see neural_lab/render.wgsl.js).
//   node tools/neural/renderRun.mjs <scene-regex> --sun models/sun-....json --sky models/sky-....json [--img WxH] [--passes N]
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};
const pattern = new RegExp(args[0] ?? '^test-');
const url = process.env.LAB_URL ?? 'http://127.0.0.1:8000';
const dataDir = path.resolve('tools/neural/data');
const [iw, ih] = flag('--img', '160x100').split('x').map(Number);
const passes = Number(flag('--passes', 8));
const sunModel = JSON.parse(await fs.readFile(path.resolve('tools/neural', flag('--sun')), 'utf8'));
const skyModel = JSON.parse(await fs.readFile(path.resolve('tools/neural', flag('--sky')), 'utf8'));
const directModel = flag('--direct') ? JSON.parse(await fs.readFile(path.resolve('tools/neural', flag('--direct')), 'utf8')) : null;
const readJson = async f => JSON.parse(await fs.readFile(path.resolve('tools/neural/results', f), 'utf8'));
const sunResults = await readJson('sun.json');
const skyResults = await readJson('sky.json');
const sunMaps = await readJson('sun-r3.json').catch(() => readJson('sun-maps.json')).catch(() => null);
const skyMaps = await readJson('sky-r3.json').catch(() => readJson('sky-maps.json')).catch(() => null);
// Conventional columns: the strongest refit available (with the shadow / column maps when fitted).
const sunFit = sunMaps?.baselines['octaves refit x shadow map']?.params ?? sunResults.baselines['octaves refit to teacher'].params;
const useShadow = Boolean(sunMaps?.baselines['octaves refit x shadow map']);
const skyAffine = (skyMaps?.baselines['game skyVis + best affine'] ?? skyResults.baselines['game skyVis + best affine']).params;
const skyFit = skyMaps?.baselines['sky probes + column map refit']?.params ?? [...skyResults.baselines['sky probes refit to teacher'].params, 0];
const fitParams = [sunFit.a, sunFit.b, sunFit.c, Math.exp(sunFit.logGain),
    sunFit.powder, skyAffine.scale, skyAffine.offset, useShadow ? 1 : 0,
    skyFit[0], skyFit[1], skyFit[2], skyFit[3], skyFit[4], skyFit[5], skyFit[6], skyFit[7]];
console.log(`conventional columns: sun refit${useShadow ? ' x shadow map' : ''}, sky refit${skyFit[7] ? ' + column map' : ''}`);

const scenes = [];
for (const file of await fs.readdir(dataDir)) {
    if (!file.endsWith('.json')) continue;
    const meta = JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
    if (pattern.test(meta.name)) scenes.push(meta);
}
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, protocolTimeout: 0,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling'],
});
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
    page.on('console', m => { if (m.type() === 'error') console.log(m.text()); });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { polling: 250 });
    for (const scene of scenes) {
        const b64 = await page.evaluate(async (scene, sunModel, skyModel, directModel, fitParams, iw, ih, passes) => {
            const c = cloudLab.clouds;
            const { DEFAULT_CLOUD_SETTINGS } = await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js');
            const { createEngineConfig } = await import('/wizard_game/runtimeConfigs.js');
            const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
            const { TeacherGpu } = await import('/neural_lab/teacherGpu.js');
            const { renderShader } = await import('/neural_lab/render.wgsl.js');
            const runtime = createEngineConfig().rendering.volumetricClouds.settings;
            for (const key of Object.keys(c.settings)) if (!Object.hasOwn(DEFAULT_CLOUD_SETTINGS, key)) delete c.settings[key];
            const preset = WEATHER_CONFIG.effects[scene.preset];
            Object.assign(c.settings, DEFAULT_CLOUD_SETTINGS, runtime, {
                windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0, timeScale: 0,
                coverage: 0.08 + 0.2 * preset.cloudCoverage, farProxy: false,
            });
            c.weather = preset.clouds;
            c.enabled = true;
            c._evolve = 0; c._boil = 0; c._windShape = [0, 0, 0]; c._windDetail = [0, 0, 0];
            cloudLab.camera.setView(scene.view);
            cloudLab.sun.elevationDeg = scene.elevation;
            cloudLab.sun.azimuthDeg = scene.azimuth;
            c.moonIlluminance = 0;
            c.resetHistory();
            const end = cloudLab.renderer.frameCount + 4;
            while (cloudLab.renderer.frameCount < end) await new Promise(r => requestAnimationFrame(r));
            const teacher = new TeacherGpu(c);
            const snap = teacher.snapshot();
            c.enabled = false;
            const device = c.device;
            const pipeline = await teacher.pipeline(renderShader(sunModel, skyModel, directModel), `render ${sunModel.sizes}`);
            const size = iw * ih * 64;
            const out = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
            const uniforms = teacher.uniformBuffer(snap.uniforms);
            const fit = teacher.uniformBuffer(new Float32Array(fitParams));
            let rows = 8;
            for (let pass = 0; pass < passes; pass++) {
                for (let row = 0; row < ih;) {
                    const count = Math.min(rows, ih - row);
                    const params = teacher.uniformBuffer(teacher.params(991 + pass * 7717 + row, 1, row, iw, ih));
                    const ms = await teacher.run(pipeline, [{ buffer: uniforms }, ...snap.noise, { buffer: params },
                        { buffer: fit }, { buffer: out }], [Math.ceil(iw / 8), Math.ceil(count / 8)]);
                    params.destroy();
                    row += count;
                    rows = Math.max(8, Math.min(ih, 8 * Math.floor((0.5 * rows + 0.5 * count * 60 / Math.max(ms, 1)) / 8)));
                }
            }
            const values = await teacher.read(out, size);
            out.destroy(); uniforms.destroy(); fit.destroy();
            c.enabled = true;
            const bytes = new Uint8Array(values.buffer);
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return btoa(s);
        }, scene, sunModel, skyModel, directModel, fitParams, iw, ih, passes);
        await fs.writeFile(path.join(dataDir, `${scene.name}.render.f32`), Buffer.from(b64, 'base64'));
        console.log(`${scene.name}: rendered ${iw}x${ih}`);
    }
} finally {
    await browser.close();
}
