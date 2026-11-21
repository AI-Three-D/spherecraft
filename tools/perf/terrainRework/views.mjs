// Reproducible altitude sweep for terrain development. Run against a locally
// served checkout: node tools/perf/terrainRework/views.mjs OUT_DIR [URL]
// [FEATURES_JSON] [POSE_JSON] [TERRAIN_OVERRIDES_JSON]. Overrides are
// applied before initialization, so hydrology sees the same terrain.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const [out, base = 'http://127.0.0.1:8765', featureJSON = '{}', poseJSON, terrainJSON = '{}'] = process.argv.slice(2);
if (!out) throw new Error('Supply an output directory');
const features = JSON.parse(featureJSON);
const terrainOverrides = JSON.parse(terrainJSON);
if (process.env.TERRAIN_REWORK_RANGE_SOURCE &&
    terrainOverrides.mountainRangeModel != null && terrainOverrides.mountainRangeModel !== 'legacy') {
    throw new Error('Range injection replaces the legacy model; do not select another model in the same run');
}
const pose = poseJSON ? JSON.parse(poseJSON) : {
    position: [-128639.7, 29828.6, -13739.9], target: [-128638.1, 29824.1, -13734.7],
};
fs.mkdirSync(out, { recursive: true });
if (process.env.TERRAIN_REWORK_RANGE_SOURCE) {
    fs.copyFileSync(process.env.TERRAIN_REWORK_RANGE_SOURCE, path.join(out, 'range-variant.wgsl'));
}
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
let rangeIntercepts = 0;
let variantHash = null;
let foothillIntercepts = 0;
let foothillHash = null;
let rollingIntercepts = 0;
let rollingHash = null;
let foothillBand = null;
const patchedModules = new Map();
// An optional local WGSL function allows geometry experiments to run through
// every production consumer, without changing the shipped shader file.
if (process.env.TERRAIN_REWORK_RANGE_SOURCE) {
    const file = new URL('../../../templates/terrain-shaders/features/featureMountains.wgsl.js', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    const variant = fs.readFileSync(process.env.TERRAIN_REWORK_RANGE_SOURCE, 'utf8');
    variantHash = createHash('sha256').update(variant).digest('hex');
    const start = source.indexOf('fn mtnRange_d('), open = source.indexOf('{', start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
        if (source[end] === '{') depth++;
        if (source[end] === '}') depth--;
        end++;
    }
    if (start < 0 || depth || variant.includes('`') || variant.includes('${')) throw new Error('Invalid range shader variant');
    patchedModules.set('/templates/terrain-shaders/features/featureMountains.wgsl.js', source.slice(0, start) + variant + source.slice(end));
}
if (process.env.TERRAIN_REWORK_FOOTHILLS_SOURCE) {
    const variant = fs.readFileSync(process.env.TERRAIN_REWORK_FOOTHILLS_SOURCE, 'utf8');
    if (variant.includes('`') || variant.includes('${')) throw new Error('Invalid foothill shader variant');
    foothillHash = createHash('sha256').update(variant).digest('hex');
    if (process.env.TERRAIN_REWORK_FOOTHILLS_BAND) {
        foothillBand = JSON.parse(process.env.TERRAIN_REWORK_FOOTHILLS_BAND);
        if (!Array.isArray(foothillBand) || foothillBand.length !== 2 ||
            !foothillBand.every(Number.isFinite) || foothillBand[0] >= foothillBand[1]) {
            throw new Error('Foothill band must be two increasing finite numbers');
        }
    }
    fs.copyFileSync(process.env.TERRAIN_REWORK_FOOTHILLS_SOURCE, path.join(out, 'foothills-variant.wgsl'));
    const wgslFloat = n => Number.isInteger(n) ? `${n}.0` : String(n);
    const band = foothillBand
        ? `dSmoothstep(${wgslFloat(foothillBand[0])}, ${wgslFloat(foothillBand[1])}, regional.terrainType)`
        : 'dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType)';
    patchedModules.set('/templates/terrain-shaders/features/featureFoothills.wgsl.js',
        `export function createFoothillWgsl() { return { band: ${JSON.stringify(band)}, calculation: \`${variant}\` }; }`);
}
if (process.env.TERRAIN_REWORK_ROLLING_SOURCE) {
    const file = new URL('../../../templates/terrain-shaders/features/featureLoneHills.wgsl.js', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    const variant = fs.readFileSync(process.env.TERRAIN_REWORK_ROLLING_SOURCE, 'utf8');
    const start = source.indexOf('fn featureRollingHillsHeight_d('), open = source.indexOf('{', start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
        if (source[end] === '{') depth++;
        if (source[end] === '}') depth--;
        end++;
    }
    if (start < 0 || depth || variant.includes('`') || variant.includes('${')) throw new Error('Invalid rolling-hill variant');
    rollingHash = createHash('sha256').update(variant).digest('hex');
    fs.copyFileSync(process.env.TERRAIN_REWORK_ROLLING_SOURCE, path.join(out, 'rolling-variant.wgsl'));
    patchedModules.set('/templates/terrain-shaders/features/featureLoneHills.wgsl.js', source.slice(0, start) + variant + source.slice(end));
}
if (patchedModules.size) {
    await page.setRequestInterception(true);
    page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        const entry = [...patchedModules].find(([suffix]) => pathname.endsWith(suffix));
        if (!entry) { request.continue(); return; }
        if (entry[0].includes('featureMountains')) rangeIntercepts++;
        else if (entry[0].includes('featureLoneHills')) rollingIntercepts++;
        else foothillIntercepts++;
        request.respond({ status: 200, contentType: 'application/javascript', body: entry[1] });
    });
}
await page.evaluateOnNewDocument(({ features, terrainOverrides }) => {
    const nativeFetch = window.fetch;
    const merge = (a, b) => {
        const out = { ...a };
        for (const [k, v] of Object.entries(b)) {
            out[k] = v && typeof v === 'object' && !Array.isArray(v)
                ? merge(a?.[k] ?? {}, v) : v;
        }
        return out;
    };
    window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (!new URL(url, location.href).pathname.endsWith('/terrain.json') || !response.ok) return response;
        const config = merge(await response.json(), merge(terrainOverrides, { features }));
        return new Response(JSON.stringify(config), { status: response.status, headers: response.headers });
    };
}, { features, terrainOverrides });
const errors = [];
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); errors.push(e.message); });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    const selection = process.env.TERRAIN_REWORK_SELECTION;
    const query = new URLSearchParams({ labNoClouds: '1', lakeCells: '1' });
    if (selection !== undefined) query.set('terrainRework', selection);
    if (selection === undefined && process.env.TERRAIN_REWORK_RANGE_SOURCE) {
        query.set('terrainRework', '');
    } else if (selection === undefined && process.env.TERRAIN_REWORK_ROLLING_SOURCE) {
        query.set('terrainRework', 'mountains,foothills,valleys,coast,coves');
    }
    await page.goto(`${base}/wizard_game/standalone.html?${query}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?._sampler && window.qtDiag?.regional && window.gameEngine?.renderer?.quadtreeTileManager,
        { timeout: 240000, polling: 1000 });
    if (process.env.TERRAIN_REWORK_RANGE_SOURCE && !rangeIntercepts) throw new Error('Range shader was not intercepted');
    if (process.env.TERRAIN_REWORK_FOOTHILLS_SOURCE && !foothillIntercepts) throw new Error('Foothill shader was not intercepted');
    if (process.env.TERRAIN_REWORK_ROLLING_SOURCE && !rollingIntercepts) throw new Error('Rolling-hill shader was not intercepted');
    console.log('Terrain and hydrology ready');
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #gameCanvas { visibility: visible !important; }' });
    const setup = await page.evaluate(async ({ pose }) => {
        const g = window.gameEngine;
        g.setDayNightFrozen?.(true);
        const p = pose.position;
        const origin = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
        const rel = p.map((v, i) => v - [origin.x, origin.y, origin.z][i]);
        const len = Math.hypot(...rel), up = rel.map(v => v / len);
        const target = pose.target;
        const look = target.map((v, i) => v - p[i]);
        const dot = look.reduce((s, v, i) => s + v * up[i], 0);
        const tangent0 = look.map((v, i) => v - dot * up[i]);
        const tl = Math.hypot(...tangent0), tangent = tangent0.map(v => v / tl);
        const height = (await g.waterService._sampler.sampleDirsNatural(new Float32Array([...up, 0])))[0];
        const s = g.starSystem, body = s?.currentBody;
        if (body) {
            s.paused = true; s.useGameTimeRotation = false;
            let best = Infinity, rotation = 0;
            for (let i = 0; i < 720; i++) {
                body.currentRotation = i * Math.PI * 2 / 720;
                const d = body.getStarDirection(s.primaryStar).direction;
                const score = Math.abs(d.x * up[0] + d.y * up[1] + d.z * up[2] - 0.75);
                if (score < best) { best = score; rotation = body.currentRotation; }
            }
            body.currentRotation = rotation;
        }
        return { up, tangent, height, radius: g.planetConfig.radius, origin: [origin.x, origin.y, origin.z],
            erosionFilter: g.planetConfig.terrainGeneration?.erosionFilter,
            features: g.planetConfig.terrainGeneration?.features,
            effectiveFeatures: g.terrainGenerator?.terrainFeatures,
            mountainRangeModel: g.terrainGenerator?.mountainRangeModel,
            foothills: g.terrainGenerator?.foothills };
    }, { pose });
    for (const [key, enabled] of Object.entries(features)) {
        if (setup.effectiveFeatures?.[key] !== enabled) {
            throw new Error(`Requested terrain feature ${key}=${enabled} was not applied`);
        }
    }
    if (terrainOverrides.mountainRangeModel !== undefined &&
        setup.mountainRangeModel !== terrainOverrides.mountainRangeModel) {
        throw new Error('Requested mountain range model was not applied');
    }
    for (const [key, value] of Object.entries(terrainOverrides.foothills ?? {})) {
        if (setup.foothills?.[key] !== value) throw new Error(`Requested foothill setting ${key} was not applied`);
    }
    console.log(`Sampled natural terrain height: ${setup.height.toFixed(1)} m`);
    // The hydrology sampler does not include every rendered displacement.
    // Probe the visible height layer looking straight down before positioning
    // the ground camera, especially on steep terrain and near water.
    await page.evaluate(({ setup }) => {
        const { up, tangent, origin, height, radius } = setup;
        const pos = up.map((v, i) => origin[i] + v * (radius + height + 3000));
        const target = up.map((v, i) => origin[i] + v * radius);
        const xyz = v => ({ x: v[0], y: v[1], z: v[2] });
        const apply = () => window.qtDiag.regional.useCamera({ position: xyz(pos), target: xyz(target),
            up: xyz(tangent), fov: window.qtDiag.regional.camera().fov });
        apply();
        window.__terrainReworkHold = setInterval(apply, 250);
    }, { setup });
    await sleep(5000);
    const probe = await page.evaluate(async () => {
        try {
            const pick = await window.qtDiag.pickTerrainAtCenter({ method: 'sphere', iterations: 8 });
            return { radius: pick.terrainRadius ?? null, error: pick.error ?? null, pickMethod: pick.pickMethod ?? null,
                tile: pick.instance?.tile ?? null };
        } catch (e) { return { radius: null, error: String(e) }; }
    });
    setup.naturalHeight = setup.height;
    setup.surfaceProbe = probe;
    if (Number.isFinite(probe.radius) && Math.abs(probe.radius - setup.radius - setup.height) < 3000) {
        setup.height = probe.radius - setup.radius;
    }
    console.log(`Rendered surface probe: ${JSON.stringify(probe)}`);
    const views = [
        { name: 'reference', exact: true },
        { name: 'ground', height: 8, down: 0.04 },
        { name: 'low', height: 300, down: 0.22 },
        { name: 'aerial', height: 1700, down: 0.55 },
        { name: 'high', height: 10000, down: 0.65 },
        { name: 'orbit', height: 46000, down: 1.2 },
    ];
    const report = { features, terrainOverrides, pose, setup,
        rangeVariant: process.env.TERRAIN_REWORK_RANGE_SOURCE ? 'range-variant.wgsl' : null,
        rangeVariantSha256: variantHash,
        foothillVariant: process.env.TERRAIN_REWORK_FOOTHILLS_SOURCE ? 'foothills-variant.wgsl' : null,
        foothillVariantSha256: foothillHash, foothillBand,
        rollingVariant: process.env.TERRAIN_REWORK_ROLLING_SOURCE ? 'rolling-variant.wgsl' : null,
        rollingVariantSha256: rollingHash, views: [], errors };
    for (const v of views) {
        await page.evaluate(({ v, setup, pose }) => {
            const { up, tangent, origin, height, radius } = setup;
            const pos = v.exact ? pose.position : up.map((x, i) => origin[i] + x * (radius + height + v.height));
            const target = v.exact ? pose.target : pos.map((x, i) => x + tangent[i] * 100 - up[i] * v.down * 100);
            const cameraUp = v.exact ? (pose.up ?? [0, 1, 0]) : up;
            const apply = () => window.qtDiag.regional.useCamera({
                position: { x: pos[0], y: pos[1], z: pos[2] },
                target: { x: target[0], y: target[1], z: target[2] },
                up: { x: cameraUp[0], y: cameraUp[1], z: cameraUp[2] },
                fov: window.qtDiag.regional.camera().fov,
            });
            clearInterval(window.__terrainReworkHold); apply();
            window.__terrainReworkHold = setInterval(apply, 250);
        }, { v, setup, pose });
        await sleep(3000);
        const started = Date.now(); let stable = 0, state;
        while (Date.now() - started < 120000) {
            state = await page.evaluate(() => {
                const tm = window.gameEngine.renderer.quadtreeTileManager;
                const s = tm.getInitialLoadStatus(), p = tm.getPerfHudSnapshot()?.pressure;
                return { visible: s.visibleTiles, exact: s.exactVisibleRatio, pending: s.pendingGenerations,
                    active: s.activeGenerations, copies: s.pendingCopies,
                    refinement: (p?.refinementQueueDepth ?? 0) + (p?.refinementQueueActive ?? 0) };
            });
            const done = state.visible > 0 && state.exact >= 0.999 && !state.pending && !state.active && !state.copies && !state.refinement;
            stable = done ? stable + 1 : 0;
            if (stable >= 3) break;
            await sleep(1000);
        }
        await sleep(2000);
        await page.screenshot({ path: path.join(out, `${v.name}.png`) });
        if (v.exact && process.env.TERRAIN_REWORK_DEBUG_MODES) {
            for (const mode of JSON.parse(process.env.TERRAIN_REWORK_DEBUG_MODES)) {
                await page.evaluate(n => window.qtDiag.setTerrainDebugMode(n), mode);
                await sleep(1000);
                await page.screenshot({ path: path.join(out, `reference-debug-${mode}.png`) });
            }
            await page.evaluate(() => window.qtDiag.setTerrainDebugMode(0));
        }
        const water = await page.evaluate(() => {
            const g = window.gameEngine, lakes = g.waterService?._lakeCells;
            return { knownLakes: lakes?.known?.size ?? null, plannedKnown: lakes?.plannedKnown ?? null,
                planning: lakes?.planning ?? null, rivers: g.waterService?.riverRecs?.size ?? 0,
                riverFieldBusy: g.riverFieldService?.busy ?? null };
        });
        report.views.push({ ...v, settled: stable >= 3, state, water });
        console.log(JSON.stringify(report.views.at(-1)));
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (report.views.some(v => !v.settled) || pageErrors.length) process.exitCode = 1;
} finally {
    await page.goto('about:blank').catch(() => {});
    await browser.close();
}
