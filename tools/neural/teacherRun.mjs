/* global cloudLab */
// Generates path-traced teacher data from the cloud lab (headless Chrome, WebGPU).
//   node tools/neural/teacherRun.mjs [scene-regex] [--images] [--paths N] [--spp N] [--q WxH]
// Writes tools/neural/data/<scene>.records.f32 (+ .image.f32) and <scene>.json.
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
const pattern = new RegExp(args.find(a => !a.startsWith('--') && !/^\d/.test(a) && !/^\d+x\d+$/.test(a)) ?? '.');
const url = process.env.LAB_URL ?? 'http://127.0.0.1:8000';
const outDir = path.resolve(process.env.TEACHER_OUT ?? 'tools/neural/data');
const paths = Number(flag('--paths', 64));
const spp = Number(flag('--spp', 256));
const [qw, qh] = flag('--q', '160x100').split('x').map(Number);
const [iw, ih] = flag('--img', '256x160').split('x').map(Number);
const wantImages = args.includes('--images');
const wantQueries = !args.includes('--no-queries');

// Camera views mirror tools/perf/cloudBenchmark.mjs. Sun elevation/azimuth in degrees.
const ground = { altitudeKm: 1, headingDeg: 40, pitchDeg: 14 };
const horizon = { altitudeKm: 3, headingDeg: 55, pitchDeg: 2 };
const inside = { altitudeKm: 6, headingDeg: 55, pitchDeg: 2 };
const above = { altitudeKm: 10, headingDeg: 55, pitchDeg: -35 };
const grazing = { altitudeKm: 6.54, latDeg: -6.81, lonDeg: 19.64, headingDeg: 4.07, pitchDeg: -3.61 };
const sceneList = [];
const add = (name, preset, view, elevation, azimuth = 235, split = 'train') => sceneList.push({ name, preset, view, elevation, azimuth, split });
// Training scenes: several weather presets, views and sun angles.
for (const [preset, tag] of [['partly_cloudy', 'fair'], ['cloudy', 'cloudy'], ['overcast', 'overcast'], ['rain', 'rain']]) {
    add(`${tag}-ground-e35`, preset, ground, 35);
    add(`${tag}-above-e20`, preset, above, 20, 150);
    add(`${tag}-inside-e50`, preset, inside, 50, 300);
    add(`${tag}-grazing-e12`, preset, grazing, 12, 80);
    add(`${tag}-horizon-e65`, preset, horizon, 65, 20);
}
// Low-sun / dusk training scenes (cloud tops lit through tens of km of layer, sunset undersides).
for (const [preset, tag] of [['partly_cloudy', 'fair'], ['cloudy', 'cloudy'], ['overcast', 'overcast'], ['rain', 'rain']]) {
    add(`dusk-${tag}-above-e4`, preset, { ...above, lonDeg: -9, headingDeg: 300 }, 4, 250);
    add(`dusk-${tag}-inside-e7`, preset, { ...inside, latDeg: -14, headingDeg: 140 }, 7, 160);
}
add('dusk-fair-ground-e3', 'partly_cloudy', { ...ground, lonDeg: 9, headingDeg: 230 }, 3, 230);
// Sun on the local horizon over cloud tops (as in the held-out above views), elsewhere on the planet.
for (const [preset, tag] of [['partly_cloudy', 'fair'], ['cloudy', 'cloudy'], ['overcast', 'overcast'], ['rain', 'rain']]) {
    add(`dusk2-${tag}-above`, preset, { ...above, lonDeg: Number(process.env.D2_LON ?? 52), latDeg: Number(process.env.D2_LAT ?? -10), headingDeg: 20 },
        Number(process.env.D2_E ?? 28), Number(process.env.D2_AZ ?? 200));
}
add('dusk-overcast-ground-e5', 'overcast', { ...ground, lonDeg: 9, headingDeg: 230 }, 5, 230);
// Round 5: storm decks, and dense decks under a low sun seen from the ground or along the layer.
add('storm-ground-e35', 'storm', ground, 35);
add('storm-above-e20', 'storm', above, 20, 150);
add('storm-inside-e50', 'storm', inside, 50, 300);
add('storm-grazing-e12', 'storm', grazing, 12, 80);
add('storm-horizon-e65', 'storm', horizon, 65, 20);
add('storm-ground-e8', 'storm', ground, 8);
add('storm-grazing-e5', 'storm', grazing, 5, 80);
add('dusk-storm-above-e4', 'storm', { ...above, lonDeg: -9, headingDeg: 300 }, 4, 250);
add('dusk-storm-inside-e7', 'storm', { ...inside, latDeg: -14, headingDeg: 140 }, 7, 160);
add('lowsun-overcast-ground-e8', 'overcast', { ...ground, lonDeg: -20, headingDeg: 100 }, 8, 95);
add('lowsun-rain-ground-e10', 'rain', { ...ground, lonDeg: -20, headingDeg: 100 }, 10, 95);
add('lowsun-cloudy-ground-e12', 'cloudy', { ...ground, lonDeg: -20, headingDeg: 100 }, 12, 95);
add('lowsun-overcast-grazing-e6', 'overcast', grazing, 6, 80);
add('foggy-ground-e35', 'foggy', ground, 35);
add('foggy-above-e20', 'foggy', above, 20, 150);
// Round 5 diversity: other places and sun azimuths, mostly the ground views players see.
const places = [{ lonDeg: -35, latDeg: 20 }, { lonDeg: 25, latDeg: -18 }, { lonDeg: 70, latDeg: 32 }];
for (const [preset, tag] of [['cloudy', 'cloudy'], ['overcast', 'overcast'], ['rain', 'rain'], ['storm', 'storm']]) {
    places.forEach((place, i) => {
        const elevation = [22, 48, 31][(i + tag.length) % 3];
        add(`div-${tag}-ground-${i}`, preset, { ...ground, ...place, headingDeg: 60 + 110 * i }, elevation, 40 + 120 * i);
    });
    const place = places[tag.length % 3];
    add(`div-${tag}-horizon`, preset, { ...horizon, ...place, headingDeg: 170 }, 26, 300);
    add(`div-${tag}-above`, preset, { ...above, ...place, headingDeg: 20 }, 40, 130);
}
// Held-out scenes: different longitude (other clouds) and sun angles not in training.
add('test-storm-above-e28', 'storm', { ...above, lonDeg: 47, latDeg: 11, headingDeg: 210 }, 28, 200, 'test');
add('test-storm-ground-e42', 'storm', { ...ground, lonDeg: 47, latDeg: 11, headingDeg: 300 }, 42, 110, 'test');
add('test-storm-ground-e9', 'storm', { ...ground, lonDeg: 47, latDeg: 11, headingDeg: 300 }, 9, 110, 'test');
add('test-overcast-ground-e9', 'overcast', { ...ground, lonDeg: 47, latDeg: 11, headingDeg: 300 }, 9, 110, 'test');
for (const [preset, tag] of [['partly_cloudy', 'fair'], ['cloudy', 'cloudy'], ['overcast', 'overcast'], ['rain', 'rain']]) {
    add(`test-${tag}-above-e28`, preset, { ...above, lonDeg: 47, latDeg: 11, headingDeg: 210 }, 28, 200, 'test');
    add(`test-${tag}-ground-e42`, preset, { ...ground, lonDeg: 47, latDeg: 11, headingDeg: 300 }, 42, 110, 'test');
}
// Round 6: the lab's sun is fixed to the start site, so scenes elsewhere had a wrong local sun (most
// views from above saw it on the horizon). These set the sun in the camera's own frame.
const r6Views = {
    ground, horizon: { ...horizon, pitchDeg: 5 }, inside: { ...inside, altitudeKm: 5.4 },
    top10: above, top9: { ...above, altitudeKm: 9.2, pitchDeg: -14 }, top8: { ...above, altitudeKm: 8.2, pitchDeg: -8 },
};
let r6Seed = 1;
const r6 = () => { r6Seed = (r6Seed * 16807) % 2147483647; return r6Seed / 2147483647; };
for (const preset of ['partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm']) {
    for (const [tag, view] of Object.entries(r6Views)) {
        for (let k = 0; k < 2; k++) {
            const place = { latDeg: -35 + 70 * r6(), lonDeg: -180 + 360 * r6(), headingDeg: 360 * r6() };
            const localSun = { elevation: k ? 4 + 30 * r6() : 34 + 44 * r6(), azimuth: 360 * r6() };
            sceneList.push({ name: `r6-${preset}-${tag}-${k}`, preset, view: { ...view, ...place }, elevation: 40, azimuth: 235, split: 'train', localSun });
        }
    }
    for (const tag of ['ground', 'inside', 'top9']) {
        const place = { latDeg: -33 + 60 * r6(), lonDeg: -180 + 360 * r6(), headingDeg: 360 * r6() };
        sceneList.push({ name: `test-r6-${preset}-${tag}`, preset, view: { ...r6Views[tag], ...place }, elevation: 40, azimuth: 235,
            split: 'test', localSun: { elevation: 12 + 55 * r6(), azimuth: 360 * r6() } });
    }
}
// Round 7: the same views at other places, half of them under a high sun (thin in round 6).
for (const preset of ['partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm']) {
    for (const [tag, view] of Object.entries(r6Views)) {
        for (let k = 0; k < 2; k++) {
            const place = { latDeg: -40 + 80 * r6(), lonDeg: -180 + 360 * r6(), headingDeg: 360 * r6() };
            const sine = k ? 0.1 + 0.8 * r6() : 0.72 + 0.28 * r6();
            sceneList.push({ name: `r7-${preset}-${tag}-${k}`, preset, view: { ...view, ...place, pitchDeg: view.pitchDeg + 10 * (r6() - 0.5) },
                elevation: 40, azimuth: 235, split: 'train', localSun: { elevation: Math.asin(sine) * 180 / Math.PI, azimuth: 360 * r6() } });
        }
    }
}
// Round 8: inside and just above or below the layer, at varied depths.
for (const preset of ['partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm']) {
    for (let k = 0; k < 8; k++) {
        const place = { latDeg: -40 + 80 * r6(), lonDeg: -180 + 360 * r6(), headingDeg: 360 * r6() };
        sceneList.push({ name: `r8-${preset}-in-${k}`, preset, view: { altitudeKm: 3.9 + 3.6 * r6(), pitchDeg: -12 + 30 * r6(), ...place },
            elevation: 40, azimuth: 235, split: 'train', localSun: { elevation: Math.asin(0.08 + 0.92 * r6()) * 180 / Math.PI, azimuth: 360 * r6() } });
    }
}
const scenes = sceneList.filter(s => pattern.test(s.name));
if (!scenes.length) throw new Error(`No scene matches ${pattern}`);

await fs.mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    protocolTimeout: 0,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-gpu-watchdog',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
    page.on('pageerror', error => console.error('pageerror', error.message));
    page.on('console', message => {
        const text = message.text();
        if (message.type() === 'error' || text.startsWith('[teacher]')) console.log(text);
    });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { timeout: 180000, polling: 250 });
    for (const scene of scenes) {
        const started = Date.now();
        const result = await page.evaluate(async (scene, options) => {
            if (window.cloudLabError) throw new Error(window.cloudLabError);
            const c = cloudLab.clouds;
            const { DEFAULT_CLOUD_SETTINGS } = await import('/core/renderer/volumetricClouds/VolumetricCloudsModule.js');
            const { createEngineConfig } = await import('/wizard_game/runtimeConfigs.js');
            const { WEATHER_CONFIG } = await import('/templates/configs/weatherConfig.js');
            const { TeacherGpu } = await import('/neural_lab/teacherGpu.js');
            const { RECORD_FIELDS } = await import('/neural_lab/teacher.wgsl.js');
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
            const frames = async n => {
                const end = cloudLab.renderer.frameCount + n;
                while (cloudLab.renderer.frameCount < end) await new Promise(r => requestAnimationFrame(r));
            };
            await frames(4);
            const teacher = new TeacherGpu(c, options.teacher);
            const snap = teacher.snapshot();
            if (scene.localSun) {
                const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
                const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                const up = unit([...snap.uniforms.subarray(0, 3)]);
                const east = unit(cross(Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], up));
                const north = cross(up, east);
                const [e, az] = [scene.localSun.elevation, scene.localSun.azimuth].map(d => d * Math.PI / 180);
                const sun = up.map((x, i) => x * Math.sin(e) + (east[i] * Math.sin(az) + north[i] * Math.cos(az)) * Math.cos(e));
                if (Math.abs(Math.hypot(...snap.uniforms.subarray(36, 39)) - 1) > 1e-3) throw new Error('Sun uniform not at 36');
                snap.uniforms.set(sun, 36);
            }
            // The lab keeps rendering; pause the clouds so the teacher has the GPU.
            c.enabled = false;
            const log = msg => console.log(`[teacher] ${scene.name}: ${msg}`);
            const encode = values => {
                const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
                let s = '';
                for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                return btoa(s);
            };
            const out = { uniforms: Array.from(snap.uniforms), fields: RECORD_FIELDS, settings: { ...c.settings }, weather: preset.clouds };
            if (options.wantQueries) {
                const queries = await teacher.queries(snap, options.qw, options.qh, 11 + scene.name.length);
                const labels = await teacher.label(snap, queries, options.paths, 1234 + scene.name.length * 31, { log, budgetMs: options.budgetMs });
                queries.buffer.destroy();
                out.records = encode(labels.values);
                out.labelMs = labels.gpuMs;
                out.queryCount = queries.count;
            }
            if (options.wantImages) {
                const image = await teacher.image(snap, options.iw, options.ih, options.spp, 77 + scene.name.length, { log, budgetMs: options.budgetMs });
                out.image = encode(image.values);
                out.imageMs = image.gpuMs;
            }
            c.enabled = true;
            return out;
        }, scene, { wantQueries, wantImages, paths, spp, qw, qh, iw, ih, teacher: JSON.parse(process.env.TEACHER_OPTIONS ?? '{}'), budgetMs: Number(process.env.TEACHER_BUDGET_MS ?? 200) });
        const meta = { ...scene, uniforms: result.uniforms, fields: result.fields, settings: result.settings,
            weather: result.weather, paths, queries: [qw, qh], labelMs: result.labelMs, queryCount: result.queryCount };
        if (result.records) await fs.writeFile(path.join(outDir, `${scene.name}.records.f32`), Buffer.from(result.records, 'base64'));
        if (result.image) {
            await fs.writeFile(path.join(outDir, `${scene.name}.image.f32`), Buffer.from(result.image, 'base64'));
            Object.assign(meta, { image: [iw, ih], spp, imageMs: result.imageMs });
        }
        const metaPath = path.join(outDir, `${scene.name}.json`);
        let previous = {};
        try { previous = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { /* new */ }
        await fs.writeFile(metaPath, JSON.stringify({ ...previous, ...meta }, null, 1));
        console.log(`${scene.name}: done in ${((Date.now() - started) / 1000).toFixed(1)} s` +
            (result.labelMs ? `, labels ${(result.labelMs / 1000).toFixed(1)} s GPU` : '') +
            (result.imageMs ? `, image ${(result.imageMs / 1000).toFixed(1)} s GPU` : ''));
    }
} finally {
    await browser.close();
}
