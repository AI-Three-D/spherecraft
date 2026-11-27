/* global process */
// Grass (core/renderer/grass/GrassPass.js) priced part by part: whole GPU frames with the arms interleaved in one
// session, on the method of tools/perf/terrainDetail/terrainPassBench.mjs (a steady load right before each frame, as the
// GPU lowers its clock between short frames; a frame counts from where the load ends to its last pass).
// node tools/perf/grass/grassBench.mjs OUT_DIR [--detail high|medium|both] [--rounds 4] [--views a,b] [--no-clouds] [--no-shots]
//
// Arms:
//   none          the terrain as before grass: no grass terms in its shader, no blades
//   ground        the ground's grass look (hue, canopy past the blades, grain), no blades
//   scatter       that, and the blades made each frame but not drawn
//   full          the game
//   full-nograin  the game without the grass grain on the ground
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!out || out.startsWith('--')) throw new Error('Usage: grassBench.mjs OUT_DIR [--detail high|medium|both] [--rounds 4] [--views a,b] [--no-clouds] [--no-shots]');
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = Number(process.env.PORT ?? 8239);
const detail = arg('detail', 'both'), rounds = Number(arg('rounds', 4)), shots = !process.argv.includes('--no-shots');

const ARMS = {
    none: { look: false, grain: false, blades: false, draw: false },
    ground: { look: true, grain: true, blades: false, draw: false },
    scatter: { look: true, grain: true, blades: true, draw: false },
    full: { look: true, grain: true, blades: true, draw: true },
    'full-nograin': { look: true, grain: false, blades: true, draw: true },
};
// [name, biome pose of tools/perf/biomeLandscape/poses.json, metres ahead, eye height (m), pitch, turn from the sun, walk]
const VIEWS = [
    ['meadow root', 'grassland', 150, 0.45, -3, 120],
    ['meadow standing', 'grassland', 150, 1.8, -10, 120],
    ['meadow standing, toward sun', 'grassland', 150, 1.8, -6, 15],
    ['meadow from 8 m', 'grassland', 150, 8, -12, 120],
    ['meadow from 15 m', 'grassland', 150, 15, -16, 120],
    ['meadow walking', 'grassland', 150, 1.8, -10, 120, true],
    ['forest floor', 'forest-floor', 0, 1.7, -8, 90],
    ['tundra', 'tundra', 0, 1.7, -8, 90],
    ['marsh', 'marsh', 0, 1.7, -8, 90],
    ['dry grass', 'dunes-west', 2000, 1.7, -8, 120],
];
const wanted = arg('views', null)?.split(',');
const views = VIEWS.filter(v => !wanted || wanted.some(w => v[0].includes(w)));

const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 700));
    browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 1800000,
        args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=BatterySaverModeOn'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 800)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text().slice(0, 800)); });
    await page.setViewport({ width: 1728, height: 900, deviceScaleFactor: 1 });
    for (const file of ['../lakeRecovery/pageInstrument.js', '../terrainDetail/gpuTimer.js']) await page.evaluateOnNewDocument(await readFile(new URL(file, import.meta.url), 'utf8'));
    await page.goto(`http://127.0.0.1:${PORT}/wizard_game/standalone.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 240000, polling: 250 });
    const info = await page.evaluate(async () => {
        const R = window.R = await import('/tools/perf/grass/grassRig.js');
        await R.boot();
        window.windMps = 6;
        const g = window.gameEngine, r = g.renderer, device = r.backend.device, T = window.__gpuTimer;
        Object.assign(r.volumetricClouds.settings, { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 });
        const qtr = r.quadtreeTerrainRenderer;
        window.__setArm = async (a) => {
            const pass = qtr.pass, grass = qtr.grass;
            pass.options.grass = a.look;
            pass.options.grain = a.grain;
            await pass.prepare();
            grass.enabled = a.blades;
            grass.drawBlades = a.draw;
        };
        const heat = device.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
            @group(0) @binding(0) var<storage, read_write> b: array<f32>;
            @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                var x = f32(id.x) * 0.001; for (var i = 0; i < 700; i++) { x = sin(x) * 1.01 + 0.3; } b[id.x % 65536u] = x; }` }) } });
        const heatBuffer = device.createBuffer({ size: 65536 * 4, usage: GPUBufferUsage.STORAGE });
        const heatGroup = device.createBindGroup({ layout: heat.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: heatBuffer } }] });
        let heatRuns = 2;
        const load = () => {
            const e = device.createCommandEncoder(), p = e.beginComputePass({ label: 'load' });
            p.setPipeline(heat);
            p.setBindGroup(0, heatGroup);
            for (let i = 0; i < heatRuns; i++) p.dispatchWorkgroups(1024);
            p.end();
            device.queue.submit([e.finish()]);
        };
        const core = r.rendererCore, render = core.render;
        core.render = function (frame) {
            T.passLabel = 'scene';
            try { return render.call(this, frame); } finally { T.passLabel = undefined; }
        };
        // move(i): before frame i (walking).
        window.__measure = async (frames, warm, move = null) => {
            const go = g.render, spans = [], scenes = [], scatter = [];
            g.render = async () => {};
            const ms = x => x / 1e6;
            try {
                while (g._renderInFlight) await new Promise(res => setTimeout(res, 3));
                for (let i = 0; i < warm + frames; i++) {
                    if (move) await move(i);
                    T.passes = [];
                    T.enabled = true;
                    load();
                    await go.call(g, 1 / 60);
                    await device.queue.onSubmittedWorkDone();
                    T.enabled = false;
                    await T.drain();
                    const own = T.passes.filter(x => x.label === 'load'), rest = T.passes.filter(x => x.label !== 'load');
                    const end = Math.max(...own.map(x => x.end));
                    const length = ms(end - Math.min(...own.map(x => x.begin)));
                    if (i < 6) { heatRuns = Math.max(1, Math.min(400, Math.round(heatRuns * 9 / Math.max(length, 0.2)))); }
                    if (i < warm) continue;
                    spans.push(ms(Math.max(...rest.map(x => x.end)) - Math.max(end, Math.min(...rest.map(x => x.begin)))));
                    const scene = rest.filter(x => x.label === 'scene');
                    if (scene.length) scenes.push(ms(Math.max(...scene.map(x => x.end)) - Math.min(...scene.map(x => x.begin))));
                    const s = rest.filter(x => x.label === 'Grass scatter');
                    scatter.push(s.length ? ms(s[0].end - s[0].begin) : 0);
                }
            } finally { T.enabled = false; g.render = go; }
            return { spans, scenes, scatter };
        };
        return { timestamps: T.supported, grass: !!qtr.grass, gpu: r.backend.adapter?.info ? { ...r.backend.adapter.info } : null, f16: device.features.has('shader-f16') };
    });
    console.log(JSON.stringify(info));
    if (!info.timestamps || !info.grass) throw new Error('needs timestamps and the grass pass');
    const report = { info, chrome: await browser.version(), arms: ARMS, cases: [], errors };
    const save = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const pct = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
    for (const quality of detail === 'both' ? ['high', 'medium'] : [detail]) {
        const canvas = await page.evaluate(q => {
            const g = window.gameEngine, ratio = q === 'high' ? 1.5 : 1;
            Object.assign(g.adaptiveQuality.rendering.adaptive, { stationaryPixelRatio: ratio, motionPixelRatio: ratio, fastMotionPixelRatio: ratio });
            g.renderer.volumetricClouds.settings.cloudDetail = q;
            g.renderer.volumetricClouds.resetHistory?.();
            return new Promise(res => setTimeout(() => res([g.canvas.width, g.canvas.height]), 1500));
        }, quality);
        if (process.argv.includes('--no-clouds')) await page.evaluate(() => { window.gameEngine.renderer.volumetricClouds.enabled = false; });
        for (const [name, pose, ahead, eye, pitch, turn, walk] of views) {
            const counts = await page.evaluate(async (pose, ahead, eye, pitch, turn) => {
                const R = window.R, poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
                const p = poses.find(x => x.name === pose);
                R.sunAt(p.dir, p.sun ?? 0.55);
                await R.frames(4);
                window.__view = { dir: p.dir, eye, pitch, bearing: R.sunBearing(p.dir) + turn, aheadM: ahead };
                await window.__setArm({ look: true, grain: true, blades: true, draw: true });
                await R.eyeAt(p.dir, window.__view);
                await R.settle(60000);
                await R.wait(500);
                return window.gameEngine.renderer.quadtreeTerrainRenderer.grass.counts();
            }, pose, ahead, eye, pitch, turn);
            const record = { quality, view: name, canvas, counts, arms: {} };
            report.cases.push(record);
            const names = Object.keys(ARMS);
            for (const n of names) record.arms[n] = { spans: [], scenes: [], scatter: [] };
            for (let round = 0; round < rounds; round++) {
                for (const n of round % 2 ? [...names].reverse() : names) {
                    await page.evaluate(async a => { await window.__setArm(a); await window.R.eyeAt(window.__view.dir, window.__view); await new Promise(r => setTimeout(r, 450)); }, ARMS[n]);
                    if (shots && round === 0) await page.screenshot({ path: path.join(out, `${quality}-${name.replaceAll(/[ ,]+/g, '_')}-${n}.png`) });
                    const t = await page.evaluate(async (walk) => {
                        // Walking: 5 cm a frame along the view (3 m/s at 60 fps), the eye held over the ground.
                        const move = walk ? async i => { await window.R.eyeAt(window.__view.dir, { ...window.__view, aheadM: window.__view.aheadM + 0.05 * i }); } : null;
                        return window.__measure(24, 12, move);
                    }, !!walk);
                    const a = record.arms[n];
                    a.spans.push(...t.spans);
                    a.scenes.push(...t.scenes);
                    a.scatter.push(...t.scatter);
                }
            }
            const line = names.map(n => {
                const a = record.arms[n];
                return `${n} ${med(a.spans)?.toFixed(2)} (p90 ${pct(a.spans, 0.9)?.toFixed(2)})`;
            }).join(' | ');
            const caps = [131072, 262144, 524288];
            const full = counts.drawn.map((x, i) => x >= caps[i] ? 'FULL' : `${Math.round(100 * x / caps[i])}%`).join('/');
            console.log(`${quality} ${canvas.join('x')} ${name}: ${line} | scatter ${med(record.arms.full.scatter)?.toFixed(2)} | blades ${counts.drawn.join('/')} (${full}) patches ${counts.patches}`);
            await save();
        }
    }
    report.gpuErrors = await page.evaluate(() => window.__lr?.gpuErrors ?? []);
    await save();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
    await browser?.close();
    server.kill();
}
