// Flat-tier lab: renders the game headless in the system Chrome at a fixed
// camera pose, per terrain-fix prototype (wizard_game/terrainFixPrototypes.js),
// and measures what the eye judged so far:
// - which LOD draws each pixel (terrain debug 90) and each tile's extent
//   (debug 107, a colour per tile), for the tile-edge mask;
// - seams: the colour step across tile edges minus the local texture step
//   (metrics.seamScore), in the final image (0), the base colour (45), the
//   flat colour (105) and the lighting alone (91, N.L);
// - LOD dependence ("shuffle"): the same pose rendered again with every tile
//   one LOD finer (lodErrorThreshold / 2, the detail-to-flat blend zone
//   pinned where it was); the difference is what changes on screen when
//   tiles split or merge while flying (metrics.lodChangeDiff).
// Needs this checkout served over HTTP (python3 server.py on :8000, or --url
// for another port). Uses the GPU of this machine.
//
//   node tools/perf/flatTierLab/flatTierLab.mjs OUT_DIR [--pose alt8k|alt10k|alt2k|"px,py,pz:tx,ty,tz"]
//        [--fix 0,1,2] [--modes 0,90,107,105,45,91] [--no-lod-test] [--url http://localhost:8000]
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { lodMap, lodHistogram, tileEdges, seamScore, lodChangeDiff } from './metrics.mjs';

const R = 131072;
const POSES = {
    // The owner's screenshots (2026-11-10).
    alt8k: { position: [-139078.1, 9033.5, 4062.0], target: [-139073.3, 9037.7, 4065.1] },
    alt10k: { position: [-141491.9, 7681.8, 5188.8], target: [-141485.1, 7683.5, 5189.9] },
};
// alt8k's view from 2 km altitude (LOD4 detail tiles and the blend zone on screen).
{
    const p = POSES.alt8k.position, t = POSES.alt8k.target;
    const n = Math.hypot(...p), s = (R + 2000) / n;
    const pos = p.map(v => v * s);
    POSES.alt2k = { position: pos, target: pos.map((v, i) => v + (t[i] - p[i])) };
}

const argv = process.argv.slice(2);
const outDir = argv[0];
if (!outDir || outDir.startsWith('--')) {
    console.error('usage: node tools/perf/flatTierLab/flatTierLab.mjs OUT_DIR [--pose ..] [--fix 0,2] [--modes ..] [--no-lod-test]');
    process.exit(2);
}
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const poseArg = opt('pose', 'alt8k');
const pose = POSES[poseArg] ?? (() => {
    const [a, b] = poseArg.split(':').map(s => s.split(',').map(Number));
    return { position: a, target: b };
})();
const fixes = opt('fix', '0,2').split(',').map(Number);
const modes = opt('modes', '0,90,107,105,45,91').split(',').map(Number);
const lodTest = !argv.includes('--no-lod-test');
const baseUrl = opt('url', 'http://localhost:8000');
// --override '{"solidColorTierEdgeBlendEnabled":false}': terrainShader settings
// applied on top of each prototype (materials rebuilt, tiles regenerated).
const override = JSON.parse(opt('override', 'null'));
const label = opt('label', '');
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[lab]', ...a);

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', e => log('page error', e.message));
page.on('console', m => { if (m.type() === 'error') log('console error', m.text().slice(0, 300)); });

async function settle(label, timeoutMs = 240000) {
    const t0 = Date.now();
    let stable = 0, s = null;
    while (Date.now() - t0 < timeoutMs) {
        s = await page.evaluate(() => {
            const tm = window.gameEngine?.renderer?.quadtreeTileManager;
            const st = tm?.getInitialLoadStatus?.();
            const pr = tm?.getPerfHudSnapshot?.()?.pressure;
            return st ? {
                visible: st.visibleTiles, exact: st.exactVisibleRatio, gen: st.pendingGenerations,
                active: st.activeGenerations, copies: st.pendingCopies,
                refine: (pr?.refinementQueueDepth ?? 0) + (pr?.refinementQueueActive ?? 0),
            } : null;
        });
        const done = s && s.visible > 0 && s.exact >= 0.999 && s.gen === 0 && s.active === 0 && s.copies === 0 && s.refine === 0;
        stable = done ? stable + 1 : 0;
        if (stable >= 3) break;
        await sleep(1000);
    }
    log(`settled ${label} in ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(s));
    await sleep(2000);
    return s;
}

async function capture(tag) {
    const images = {};
    for (const m of modes) {
        await page.evaluate(mode => window.gameEngine.setTerrainDebugMode(mode), m);
        await sleep(1500);
        const file = path.join(outDir, `${tag}-m${m}.png`);
        await page.screenshot({ path: file });
        images[m] = PNG.sync.read(fs.readFileSync(file));
    }
    await page.evaluate(() => window.gameEngine.setTerrainDebugMode(0));
    return images;
}

function analyse(images) {
    if (!images[90] || !images[107]) return null;
    const lods = lodMap(images[90]);
    const edges = tileEdges(images[107], lods);
    const seams = {};
    for (const m of [0, 105, 45, 91]) if (images[m]) seams[m] = seamScore(images[m], edges, lods);
    return { lods, lodHist: lodHistogram(lods).map(v => +v.toFixed(3)), seams };
}

const results = [];
try {
    await page.goto(`${baseUrl}/wizard_game/standalone.html?labNoClouds=1&terrainFix=${fixes[0]}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.gameEngine?.camera && window.gameEngine?.renderer?.quadtreeTileManager?.tileStreamer?.tileGenerator,
        { timeout: 240000, polling: 1000 });
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #gameCanvas { visibility: visible !important; }' });
    await page.evaluate((p) => {
        const g = window.gameEngine;
        const set = () => {
            g.cameraMode = 'manual';
            g.camera.unfollow?.();
            g.camera.setPosition(...p.position);
            g.camera.lookAt(...p.target);
            g.camera.up = { x: 0, y: 1, z: 0 };
        };
        set();
        window.__labHold = setInterval(set, 250);
        g.setDayNightFrozen?.(true);
        // Sun at about 50 degrees above the pose's horizon, the same every run.
        const s = g.starSystem, body = s?.currentBody;
        if (body) {
            s.paused = true; s.useGameTimeRotation = false;
            const o = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
            const c = [p.position[0] - o.x, p.position[1] - o.y, p.position[2] - o.z], n = Math.hypot(...c);
            let best = Infinity, rotation = 0;
            for (let i = 0; i < 720; i++) {
                body.currentRotation = i * Math.PI * 2 / 720;
                const d = body.getStarDirection(s.primaryStar).direction;
                const score = Math.abs((d.x * c[0] + d.y * c[1] + d.z * c[2]) / n - 0.75);
                if (score < best) { best = score; rotation = body.currentRotation; }
            }
            body.currentRotation = rotation;
        }
    }, pose);

    for (const fix of fixes) {
        const applied = await page.evaluate(async (n) => {
            const m = await import('/wizard_game/terrainFixPrototypes.js');
            if (m.terrainFixIndexOf(window.gameEngine.engineConfig.rendering.terrainShader) === n) return 'already';
            const r = await m.applyTerrainFixLive(window.gameEngine, n);
            return `${r.proto.name} regenerated=${r.regenerated} rebuilt=${r.rebuilt}`;
        }, fix);
        log(`fix ${fix}: ${applied}`);
        if (override) {
            await page.evaluate(async (o) => {
                const g = window.gameEngine, ts = g.engineConfig.rendering.terrainShader;
                const st = g.renderer.quadtreeTileManager.tileStreamer;
                Object.assign(ts, o);
                if (o.coarseColorSource) { st.tileGenerator.coarseColorSource = o.coarseColorSource; st._coarseColorSource = o.coarseColorSource; }
                await g.renderer.quadtreeTerrainRenderer.rebuildMaterials();
                g.renderer.quadtreeTileManager.refreshTiles();
            }, override);
            log(`override ${JSON.stringify(override)}`);
        }
        await sleep(3000);
        await settle(`fix ${fix}`);
        const tag = `${poseArg.replace(/[^a-z0-9]/gi, '_')}-fix${fix}${label ? `-${label}` : ''}`;
        const base = await capture(tag);
        const a = analyse(base);
        const row = { pose: poseArg, fix: `${fix}${label ? ` ${label}` : ''}`, lodHist: a?.lodHist, seams: a?.seams };
        if (lodTest && a) {
            const thr = await page.evaluate(() => window.gameEngine.engineConfig.gpuQuadtree.lodErrorThreshold);
            // Only the tile LODs change: the detail-to-flat blend zone is
            // derived from the threshold, so it is pinned at its current
            // distances (as in flight, where the threshold stays put).
            await page.evaluate(t => {
                const r = window.gameEngine.renderer.quadtreeTerrainRenderer;
                const pinned = r._computeTierFadeDistances();
                r._labTierFadeOriginal = r._computeTierFadeDistances;
                r._computeTierFadeDistances = () => pinned;
                window.gameEngine.engineConfig.gpuQuadtree.lodErrorThreshold = t / 2;
            }, thr);
            await sleep(3000);
            await settle(`fix ${fix} finer`);
            const finer = await capture(`${tag}-finer`);
            await page.evaluate(t => {
                const r = window.gameEngine.renderer.quadtreeTerrainRenderer;
                if (r._labTierFadeOriginal) { r._computeTierFadeDistances = r._labTierFadeOriginal; delete r._labTierFadeOriginal; }
                window.gameEngine.engineConfig.gpuQuadtree.lodErrorThreshold = t;
            }, thr);
            const lodsB = lodMap(finer[90]);
            row.lodHistFiner = lodHistogram(lodsB).map(v => +v.toFixed(3));
            row.lodChange = {};
            for (const m of [0, 105, 45, 91]) if (base[m] && finer[m]) row.lodChange[m] = lodChangeDiff(base[m], finer[m], a.lods, lodsB);
            await sleep(3000);
            await settle(`fix ${fix} restored`);
        }
        results.push(row);
        log(JSON.stringify(row));
    }
} finally {
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    await page.goto('about:blank').catch(() => {});
    await browser.close();
}

// Compact table: seams (mean excess step at tile edges, 0-255) and LOD
// dependence (mean |diff| where the LOD changed), per image.
const f = v => (v === undefined ? '-' : v.toFixed(2));
console.log('\npose            fix | seam excess: final  base  flat  light | LOD change diff: final  base  flat  light');
for (const r of results) {
    const s = m => f(r.seams?.[m]?.all?.meanExcess), d = m => f(r.lodChange?.[m]?.meanDiffWhereLodChanged);
    console.log(`${r.pose.padEnd(8)} ${String(r.fix).padStart(10)} |              ${s(0)}  ${s(45)}  ${s(105)}  ${s(91)} |                  ${d(0)}  ${d(45)}  ${d(105)}  ${d(91)}`);
}
