/* global process */
// What the grass costs part by part (core/renderer/grass/): shader variants with one part left out each
// (grassWgsl.js skip), the scatter's steps timed apart, and the range and density, interleaved in one session.
// node tools/perf/grass/scatterParts.mjs OUT_DIR [--rounds 3] [--view standing|root|high|tundra] [--only game,no atomics]
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = Number(process.env.PORT ?? 8241);
const rounds = Number(arg('rounds', 3));
const VIEWS = { standing: ['grassland', 150, 1.8, -10, 120], root: ['grassland', 150, 0.45, -3, 120], high: ['grassland', 150, 8, -12, 120], tundra: ['tundra', 0, 1.7, -8, 90] };
const [pose, ahead, eye, pitch, turn] = VIEWS[arg('view', 'standing')];

// name: [skip, config changes, drawn, build options]
const VARIANTS = {
    game: [{}, {}, true],
    'not drawn': [{}, {}, false],
    'flat shading': [{ shade: true }, {}, true],
    'far: 1 segment': [{}, {}, true, { segments: [7, 4, 1] }],
    'far bands lit per vertex': [{}, {}, true, { perVertexFar: true }],
    'one blade per tuft': [{ oneBlade: true }, {}, false],
    'no tufts (rank test only)': [{ tuft: true }, {}, false],
    'finest heights': [{ height: true }, {}, false],
    'fixed growth': [{ growth: true }, {}, false],
    'no noise': [{ noise: true }, {}, false],
    'no clumps': [{ clump: true }, {}, false],
    'no append': [{ append: true, write: true }, {}, false],
    'no atomics (scattered writes)': [{ atomic: true }, {}, false],
    'no writes': [{ write: true }, {}, false],
    'patches on loaded tiles': [{ drawn: true }, {}, false],
    'range 160 m': [{}, { distance: 160 }, true],
    'range 120 m': [{}, { distance: 120 }, true],
    'density x0.6': [{}, { density: 900 }, true],
};

const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 700));
    browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 1800000,
        args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=BatterySaverModeOn'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1728, height: 900, deviceScaleFactor: 1 });
    for (const file of ['../lakeRecovery/pageInstrument.js', '../terrainDetail/gpuTimer.js']) await page.evaluateOnNewDocument(await readFile(new URL(file, import.meta.url), 'utf8'));
    await page.goto(`http://127.0.0.1:${PORT}/wizard_game/standalone.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 240000, polling: 250 });
    await page.evaluate(async (pose, ahead, eye, pitch, turn) => {
        const R = window.R = await import('/tools/perf/grass/grassRig.js');
        await R.boot();
        window.windMps = 6;
        const g = window.gameEngine, r = g.renderer, device = r.backend.device, T = window.__gpuTimer;
        Object.assign(g.adaptiveQuality.rendering.adaptive, { stationaryPixelRatio: 1.5, motionPixelRatio: 1.5, fastMotionPixelRatio: 1.5 });
        Object.assign(r.volumetricClouds.settings, { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 });
        const grass = r.quadtreeTerrainRenderer.grass;
        grass.splitPasses = true;
        const base = { ...grass.config };
        window.__variant = async ([skip, config, drawn, build = {}]) => {
            const key = JSON.stringify([skip, build]);
            if (grass.__key !== key) { await grass.rebuild(skip, build); grass.__key = key; }
            Object.assign(grass.config, base, config);
            grass.drawBlades = drawn;
        };
        const poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
        const p = poses.find(x => x.name === pose);
        R.sunAt(p.dir, p.sun ?? 0.55);
        await R.frames(4);
        await R.eyeAt(p.dir, { eye, pitch, bearing: R.sunBearing(p.dir) + turn, aheadM: ahead });
        await R.settle(60000);
        const heat = device.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
            @group(0) @binding(0) var<storage, read_write> b: array<f32>;
            @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                var x = f32(id.x) * 0.001; for (var i = 0; i < 700; i++) { x = sin(x) * 1.01 + 0.3; } b[id.x % 65536u] = x; }` }) } });
        const hb = device.createBuffer({ size: 65536 * 4, usage: GPUBufferUsage.STORAGE });
        const hg = device.createBindGroup({ layout: heat.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: hb } }] });
        let runs = 2;
        const load = () => { const e = device.createCommandEncoder(), q = e.beginComputePass({ label: 'load' }); q.setPipeline(heat); q.setBindGroup(0, hg); for (let i = 0; i < runs; i++) q.dispatchWorkgroups(1024); q.end(); device.queue.submit([e.finish()]); };
        window.__measure = async (frames, warm) => {
            const go = g.render, res = { span: [], patches: [], blades: [] };
            g.render = async () => {};
            const ms = x => x / 1e6;
            try {
                while (g._renderInFlight) await new Promise(r2 => setTimeout(r2, 3));
                for (let i = 0; i < warm + frames; i++) {
                    T.passes = []; T.enabled = true; load();
                    await go.call(g, 1 / 60);
                    await device.queue.onSubmittedWorkDone();
                    T.enabled = false; await T.drain();
                    const own = T.passes.filter(x => x.label === 'load'), rest = T.passes.filter(x => x.label !== 'load');
                    const end = Math.max(...own.map(x => x.end));
                    if (i < 6) runs = Math.max(1, Math.min(400, Math.round(runs * 9 / Math.max(ms(end - Math.min(...own.map(x => x.begin))), 0.2))));
                    if (i < warm) continue;
                    res.span.push(ms(Math.max(...rest.map(x => x.end)) - Math.max(end, Math.min(...rest.map(x => x.begin)))));
                    for (const [k, label] of [['patches', 'Grass patches'], ['blades', 'Grass blades']]) {
                        const x = rest.find(y => y.label === label);
                        res[k].push(x ? ms(x.end - x.begin) : 0);
                    }
                }
            } finally { T.enabled = false; g.render = go; }
            return res;
        };
    }, pose, ahead, eye, pitch, turn);
    const med = a => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
    const result = {};
    const only = arg('only', null)?.split(',');
    const names = Object.keys(VARIANTS).filter(n => !only || only.some(o => n.startsWith(o)));
    for (const n of names) result[n] = { span: [], patches: [], blades: [] };
    for (let round = 0; round < rounds; round++) {
        for (const n of round % 2 ? [...names].reverse() : names) {
            await page.evaluate(async v => { await window.__variant(v); await new Promise(r => setTimeout(r, 700)); }, VARIANTS[n]);
            const t = await page.evaluate(() => window.__measure(20, 10));
            for (const k of ['span', 'patches', 'blades']) result[n][k].push(...t[k]);
        }
    }
    const lines = names.map(n => `${n.padEnd(28)} frame ${med(result[n].span).toFixed(2)}  patches ${med(result[n].patches).toFixed(2)}  blades ${med(result[n].blades).toFixed(2)}`);
    console.log(lines.join('\n'));
    await writeFile(path.join(out, `parts-${arg('view', 'standing')}.json`), JSON.stringify(result));
    const errors = await page.evaluate(() => window.__lr?.gpuErrors ?? []);
    if (errors.length) console.log('gpu errors', errors.slice(0, 3));
} finally {
    await browser?.close();
    server.kill();
}
