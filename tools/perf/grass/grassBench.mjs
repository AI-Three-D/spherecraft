/* global process */
// Grass (core/renderer/grass/GrassPass.js): GPU time of whole frames with the blades and without, arms interleaved in
// one session, and the blade counts of each view. Not yet run (2026-11-26: the GPU was busy with other work).
// node tools/perf/grass/grassBench.mjs OUT_DIR [--detail high|medium|both] [--rounds 4] [--no-clouds] [--no-shots]
// Method as tools/perf/terrainDetail/terrainPassBench.mjs: a steady load right before each frame (the GPU lowers its
// clock between short frames), and a frame counts from where the load ends to its last pass.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!out || out.startsWith('--')) throw new Error('Usage: grassBench.mjs OUT_DIR [--detail high|medium|both] [--rounds 4] [--no-clouds] [--no-shots]');
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = Number(process.env.PORT ?? 8239);
const detail = arg('detail', 'high'), rounds = Number(arg('rounds', 4)), shots = !process.argv.includes('--no-shots');

// Eye-level views: [biome pose of tools/perf/biomeLandscape/poses.json, metres ahead, eye height, pitch, turn from the sun].
const VIEWS = [
    ['meadow, sun behind', 'grassland', 150, 1.8, -4, 180],
    ['meadow, toward the sun', 'grassland', 150, 1.8, -4, 20],
    ['meadow, looking down', 'grassland', 150, 1.8, -30, 120],
    ['meadow, from 12 m', 'grassland', 150, 12, -14, 90],
    ['forest floor', 'forest-floor', 0, 1.7, -8, 90],
    ['tundra', 'tundra', 0, 1.7, -8, 90],
    ['marsh', 'marsh', 0, 1.7, -8, 90],
    ['dry grass', 'dunes-west', 2000, 1.7, -8, 120],
];

const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 700));
    browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 900000,
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
        window.__measure = async (frames, warm) => {
            const go = g.render, spans = [], grass = [];
            g.render = async () => {};
            const ms = x => x / 1e6;
            try {
                while (g._renderInFlight) await new Promise(res => setTimeout(res, 3));
                for (let i = 0; i < warm + frames; i++) {
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
                    const scatter = rest.filter(x => x.label === 'Grass scatter');
                    if (scatter.length) grass.push(ms(scatter[0].end - scatter[0].begin));
                }
            } finally { T.enabled = false; g.render = go; }
            const median = a => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null;
            return { span: median(spans), scatter: median(grass) };
        };
        return { timestamps: T.supported, grass: !!r.quadtreeTerrainRenderer.grass };
    });
    console.log(JSON.stringify(info));
    if (!info.timestamps || !info.grass) throw new Error('needs timestamps and the grass pass');
    const report = { info, chrome: await browser.version(), cases: [], errors };
    const save = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    for (const quality of detail === 'both' ? ['high', 'medium'] : [detail]) {
        await page.evaluate(q => {
            const g = window.gameEngine, ratio = q === 'high' ? 1.5 : 1;
            Object.assign(g.adaptiveQuality.rendering.adaptive, { stationaryPixelRatio: ratio, motionPixelRatio: ratio, fastMotionPixelRatio: ratio });
            g.renderer.volumetricClouds.settings.cloudDetail = q;
        }, quality);
        if (process.argv.includes('--no-clouds')) await page.evaluate(() => { window.gameEngine.renderer.volumetricClouds.enabled = false; });
        for (const [name, pose, ahead, eye, pitch, turn] of VIEWS) {
            const counts = await page.evaluate(async (pose, ahead, eye, pitch, turn) => {
                const R = window.R, poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
                const p = poses.find(x => x.name === pose);
                R.sunAt(p.dir, p.sun ?? 0.55);
                await R.frames(4);
                await R.eyeAt(p.dir, { eye, pitch, bearing: R.sunBearing(p.dir) + turn, aheadM: ahead });
                await R.settle(60000);
                return window.gameEngine.renderer.quadtreeTerrainRenderer.grass.counts();
            }, pose, ahead, eye, pitch, turn);
            const record = { quality, view: name, counts, arms: { without: [], with: [] }, scatter: [] };
            report.cases.push(record);
            for (let round = 0; round < rounds; round++) {
                for (const on of round % 2 ? [true, false] : [false, true]) {
                    await page.evaluate(async on => { window.gameEngine.renderer.quadtreeTerrainRenderer.grass.enabled = on; await new Promise(r => setTimeout(r, 400)); }, on);
                    if (shots && round === 0) await page.screenshot({ path: path.join(out, `${quality}-${name.replaceAll(/[ ,]+/g, '_')}-${on ? 'with' : 'without'}.png`) });
                    const t = await page.evaluate(() => window.__measure(24, 12));
                    record.arms[on ? 'with' : 'without'].push(t.span);
                    if (on) record.scatter.push(t.scatter);
                }
            }
            const med = a => [...a].filter(Number.isFinite).sort((x, y) => x - y)[Math.floor(a.length / 2)];
            const verts = counts.drawn.reduce((s, n, i) => s + n * counts.vertices[i], 0);
            console.log(`${quality} ${name}: without ${med(record.arms.without)?.toFixed(2)} with ${med(record.arms.with)?.toFixed(2)} ms (scatter ${med(record.scatter)?.toFixed(2)})  blades ${counts.drawn.join('/')} vertices ${(verts / 1e6).toFixed(2)} M`);
            await save();
        }
    }
    await save();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
    await browser?.close();
    server.kill();
}
