/* global process */
// The terrain pass (core/renderer/terrain/draw/TerrainPass.js) against the materials it replaces: GPU time of whole
// frames and the same view drawn by both, with the arms interleaved in one session.
// node tools/perf/terrainDetail/terrainPassBench.mjs OUT_DIR [--detail high|medium|both] [--parts] [--poses a,b] [--rounds 4] [--no-shots]
// --parts: also each change left out on its own, to see what it is worth.
// --no-clouds: without them, whose state differs from session to session by 0.3 ms: for comparing sessions.
// --root DIR: another checkout, measured as it is (it need not have the pass).
// --biome: the landscapes of tools/perf/biomeLandscape/poses.json (dunes, tundra, glacier...) instead of these poses.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!out || out.startsWith('--')) throw new Error('Usage: terrainPassBench.mjs OUT_DIR [--detail high|medium|both] [--parts] [--poses a,b] [--rounds 4] [--no-shots]');
await mkdir(out, { recursive: true });
const root = arg('root', null) ?? fileURLToPath(new URL('../../../', import.meta.url)), plain = !!arg('root', null);
const PORT = Number(process.env.PORT ?? 8237);
const detail = arg('detail', 'both'), rounds = Number(arg('rounds', 4)), parts = process.argv.includes('--parts'), shots = !process.argv.includes('--no-shots');

// What each arm sets; 'after' is the game.
const ARMS = {
    plain: {},
    before: { pass: false, seaLimited: false },
    after: {},
    'with occlusion': { occlusion: true },
    'without culling': { cull: false },
    'without dry tiles': { allWet: true },
    'without half floats': { half: false },
    'without the air table': { exactAir: true },
    'without the sea limit': { seaLimited: false },
};
const around = (name, up, height, pitch, heading = 0) => ({ name, up, height, pitch, heading });
const POSES = [
    { name: 'ground', pos: [-122700.50, -18459.63, 44221.32], look: [-122691.53, -18377.12, 44218.02] },
    { name: 'slope', pos: [-122561.86, -18446.60, 46057.79], look: [-122619.88, -18406.43, 46079.44] },
    { name: 'mountains', pos: [-124479.36, -18817.94, 46778.63], look: [-124156.22, -17286.03, 46652.55] },
    { name: 'eye', pos: [-122698.33, -18459.30, 44220.54], look: [-122686.31, -18372.79, 44269.22] },
    around('high', [-0.927519, -0.124556, 0.352413], 3000, -22),
    { name: 'shore', pos: [-71313.2, -13048.7, -112234.3], look: [-71316.7, -13049.9, -112228.3] },
    { name: 'sea', pos: [-71313.2, -13048.7, -112234.3], look: [-71316.7, -13049.9, -112228.3], turn: -70, pitch: -12 },
    { name: 'valley', pos: [20819.291, -37734.965, -130120.57], look: [35073.858, -25052.756, -125263.78] },
];
const wanted = arg('poses', null)?.split(',');
const landscapes = process.argv.includes('--biome')
    ? JSON.parse(await readFile(new URL('../biomeLandscape/poses.json', import.meta.url), 'utf8')).map(p => ({ ...p, landscape: true })) : POSES;
const poses = landscapes.filter(p => !wanted || wanted.includes(p.name));
const armNames = plain ? ['plain'] : parts ? Object.keys(ARMS).filter(n => n !== 'plain') : ['before', 'after', 'with occlusion'];

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
    page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text().slice(0, 800)); if (/terrain pass/.test(m.text())) console.log(m.text().slice(0, 400)); });
    await page.setViewport({ width: 1728, height: 900, deviceScaleFactor: 1 });
    for (const file of ['../lakeRecovery/pageInstrument.js', './gpuTimer.js']) await page.evaluateOnNewDocument(await readFile(new URL(file, import.meta.url), 'utf8'));
    await page.goto(`http://127.0.0.1:${PORT}/wizard_game/standalone.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 240000, polling: 250 });
    const info = await page.evaluate(() => {
        const g = window.gameEngine, w = g.renderer.weatherController;
        w._pickNewWeatherTarget = () => {};
        w.setWeather('partly_cloudy', true);
        w.config.variantChangeChancePerSecond = 0;
        Object.assign(g.renderer.volumetricClouds.settings, { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 });
        g.gameTime.setFrozen(true);
        const style = document.createElement('style');
        style.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}';
        document.head.appendChild(style);
        const r = g.renderer, near = r.terrainModule.nearWater, seaView = near?.seaView;
        window.__setArm = async (o) => {
            const pass = r.quadtreeTerrainRenderer.pass;
            if (!pass) return;
            const set = { pass: true, cull: true, occlusion: false, allWet: false, half: true, exactAir: false, seaLimited: true, ...o };
            pass.enabled = set.pass;
            Object.assign(pass.options, { cull: set.cull, occlusion: set.occlusion, allWet: set.allWet, half: set.half, exactAir: set.exactAir });
            if (set.pass) await pass.prepare();
            if (near) near.seaView = set.seaLimited ? seaView : null;
        };
        // Frames with a steady load right before each: a GPU with little to do lowers its clock, and then the faster of two
        // looks slower. The load's end and the frame's passes are all timestamps; a frame counts from where the load ends.
        const device = r.backend.device, T = window.__gpuTimer;
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
            const go = g.render, spans = [], scenes = [], counts = [], loads = [];
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
                    loads.push(length);
                    spans.push(ms(Math.max(...rest.map(x => x.end)) - Math.max(end, Math.min(...rest.map(x => x.begin)))));
                    const scene = rest.filter(x => x.label === 'scene');
                    if (scene.length) scenes.push(ms(Math.max(...scene.map(x => x.end)) - Math.min(...scene.map(x => x.begin))));
                    counts.push(rest.length);
                }
            } finally { T.enabled = false; g.render = go; }
            const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
            return { span: median(spans), scene: median(scenes), passes: median(counts), load: median(loads) };
        };
        const core = r.rendererCore, render = core.render;
        core.render = function (frame) {
            window.__gpuTimer.passLabel = 'scene';
            try { return render.call(this, frame); } finally { window.__gpuTimer.passLabel = undefined; }
        };
        return { pass: !!r.quadtreeTerrainRenderer.pass, timestamps: window.__gpuTimer.supported, f16: r.backend.device.features.has('shader-f16'), gpu: r.backend.adapter?.info?.architecture };
    });
    console.log(JSON.stringify(info));
    if ((!info.pass && !plain) || !info.timestamps) throw new Error('needs the terrain pass and timestamps');
    const report = { info, chrome: await browser.version(), arms: ARMS, cases: [], errors };
    const save = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    for (const quality of detail === 'both' ? ['high', 'medium'] : [detail]) {
        await page.evaluate(q => {
            const g = window.gameEngine, ratio = q === 'high' ? 1.5 : 1;
            Object.assign(g.adaptiveQuality.rendering.adaptive, { stationaryPixelRatio: ratio, motionPixelRatio: ratio, fastMotionPixelRatio: ratio });
            g.renderer.volumetricClouds.settings.cloudDetail = q;
            g.renderer.volumetricClouds.resetHistory();
        }, quality);
        if (process.argv.includes('--no-clouds')) await page.evaluate(() => { window.gameEngine.renderer.volumetricClouds.enabled = false; });
        for (const pose of poses) {
            const scene = await page.evaluate(async p => {
                let { pos, look } = p;
                const R = window.gameEngine.planetConfig.radius;
                if (p.landscape) {
                    // As tools/perf/biomeLandscape/scene.js setPose: so high over the ground, looking down so far, on a bearing.
                    const l = Math.hypot(...p.dir), up = p.dir.map(x => x / l);
                    const [ground] = await window.gameEngine.waterService._sampler.sampleDirsNatural(new Float32Array([...up, 0]));
                    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                    const eastRaw = cross([0, 1, 0], up), el = Math.hypot(...eastRaw), east = eastRaw.map(x => x / el), north = cross(up, east);
                    const b = p.bearing * Math.PI / 180, tangent = east.map((x, i) => x * Math.sin(b) + north[i] * Math.cos(b));
                    pos = up.map(x => x * (R + ground + p.eye));
                    look = pos.map((x, i) => x + 100 * (tangent[i] - up[i] * p.down));
                }
                if (p.up) {
                    const l = Math.hypot(...p.up), up = p.up.map(x => x / l);
                    pos = up.map(x => x * (R + p.height));
                    const side = [up[2], 0, -up[0]], sl = Math.hypot(...side), e = side.map(x => x / sl);
                    const a = p.pitch * Math.PI / 180;
                    look = pos.map((x, i) => x + 1000 * (e[i] * Math.cos(a) + up[i] * Math.sin(a)));
                }
                if (p.turn !== undefined) {
                    // The same place, looking another way.
                    const l = Math.hypot(...pos), up = pos.map(x => x / l), a = p.turn * Math.PI / 180, t = p.pitch * Math.PI / 180;
                    let f = look.map((x, i) => x - pos[i]);
                    const d = f.reduce((s, x, i) => s + x * up[i], 0);
                    f = f.map((x, i) => x - d * up[i]);
                    const fl = Math.hypot(...f);
                    f = f.map(x => x / fl);
                    const side = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
                    look = pos.map((x, i) => x + 1000 * ((f[i] * Math.cos(a) + side[i] * Math.sin(a)) * Math.cos(t) + up[i] * Math.sin(t)));
                }
                const vector = ([x, y, z]) => ({ x, y, z });
                const scale = Math.hypot(...pos), up = pos.map(x => x / scale);
                window.qtDiag.regional.useCamera({ position: vector(pos), target: vector(look), up: vector(up), fov: p.landscape ? 68 : 75 });
                window.__lr.daylightAt(up, p.sun ?? 0.68);
                await window.__setArm({});
                let idle = 0;
                const end = performance.now() + 60000;
                do {
                    await new Promise(r => setTimeout(r, 150));
                    const v = window.__lr.residency();
                    const quiet = v?.exactVisibleRatio === 1 && !v.pendingGenerations && !v.activeGenerations && !v.pendingCopies
                        && !window.gameEngine.renderer.quadtreeTileManager.tileStreamer.getRegenerationStats().pending;
                    idle = quiet ? idle || performance.now() : 0;
                } while ((!idle || performance.now() - idle < 1500) && performance.now() < end);
                const g = window.gameEngine;
                return { settled: !!idle, canvas: [g.canvas.width, g.canvas.height] };
            }, pose);
            const record = { quality, pose: pose.name, ...scene, arms: Object.fromEntries(armNames.map(a => [a, { span: [], load: [], scene: [], passes: [] }])) };
            report.cases.push(record);
            for (let round = 0; round < rounds; round++) {
                const order = round % 2 ? [...armNames].reverse() : armNames;
                for (const name of order) {
                    await page.evaluate(async o => { await window.__setArm(o); await new Promise(r => setTimeout(r, 450)); }, ARMS[name]);
                    if (shots && round === 0) await page.screenshot({ path: path.join(out, `${quality}-${pose.name}-${name.replaceAll(' ', '_')}.png`) });
                    const t = await page.evaluate(() => window.__measure(24, 12));
                    const a = record.arms[name];
                    a.span.push(t.span);
                    a.scene.push(t.scene);
                    a.passes.push(t.passes);
                    a.load.push(t.load);
                }
            }
            // The first arm once more: what changed by itself meanwhile.
            if (shots) {
                await page.evaluate(async o => { await window.__setArm(o); await new Promise(r => setTimeout(r, 450)); }, ARMS[armNames[0]]);
                await page.screenshot({ path: path.join(out, `${quality}-${pose.name}-${armNames[0]}_again.png`) });
            }
            // The draw list's own numbers, for the arm 'after'.
            record.draws = await page.evaluate(async () => {
                if (!window.gameEngine.renderer.quadtreeTerrainRenderer.pass) return null;
                await window.__setArm({});
                await new Promise(r => setTimeout(r, 300));
                const pass = window.gameEngine.renderer.quadtreeTerrainRenderer.pass, device = pass.device;
                const read = device.createBuffer({ size: pass.draws.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const e = device.createCommandEncoder();
                e.copyBufferToBuffer(pass.draws, 0, read, 0, read.size);
                device.queue.submit([e.finish()]);
                await read.mapAsync(GPUMapMode.READ);
                const d = new Uint32Array(read.getMappedRange().slice(0));
                read.destroy();
                const kinds = {};
                let tiles = 0, triangles = 0;
                for (let b = 0; b < 64; b++) {
                    const count = d[b * 5 + 1];
                    if (!count) continue;
                    tiles += count;
                    triangles += count * d[b * 5] / 3;
                    const k = `${['near', 'mid', 'far', 'all'][b >> 4]}${(b >> 3) & 1 ? ' wet' : ''}`;
                    kinds[k] = (kinds[k] ?? 0) + count;
                }
                const all = await window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU.debugReadMetaBuffer();
                return { tiles, triangles, kinds, listed: all.lodInstanceCounts, seaAbout: pass.seaAbout };
            });
            record.gpuErrors = await page.evaluate(() => window.__lr.gpuErrors);
            const med = a => [...a].filter(Number.isFinite).sort((x, y) => x - y)[Math.floor(a.length / 2)];
            console.log(`${quality} ${pose.name} ${scene.canvas.join('x')}${scene.settled ? '' : ' NOT SETTLED'} errors ${record.gpuErrors.length}  ${JSON.stringify(record.draws)}`);
            for (const name of armNames) {
                const a = record.arms[name];
                console.log(`   ${name.padEnd(24)} gpu ${med(a.span)?.toFixed(2)} (${a.span.map(x => x?.toFixed(2)).join(' ')})  scene pass ${med(a.scene)?.toFixed(2)}  load ${med(a.load)?.toFixed(1)}`);
            }
            await save();
        }
    }
    await save();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
    await browser?.close();
    server.kill();
}
