/* global process */
// Does anything seen change when tiles are left out, or with another renderer? Draws each view with the switch off, on, and
// off again, and compares the depth of every pixel. Views that changed by themselves meanwhile do not count.
// node tools/perf/terrainDetail/occlusionCheck.mjs OUT.json [occlusion|cull|pass] [--quick]
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2], quick = process.argv.includes('--quick');
if (!out) throw new Error('Usage: occlusionCheck.mjs OUT.json [--quick]');
const what = process.argv[3]?.startsWith('--') || !process.argv[3] ? 'occlusion' : process.argv[3];
const root = fileURLToPath(new URL('../../../', import.meta.url)), PORT = Number(process.env.PORT ?? 8238);
const places = [
    { name: 'ground', pos: [-122700.50, -18459.63, 44221.32] }, { name: 'slope', pos: [-122561.86, -18446.60, 46057.79] },
    { name: 'mountains', pos: [-124479.36, -18817.94, 46778.63] }, { name: 'shore', pos: [-71313.2, -13048.7, -112234.3] },
    { name: 'valley', pos: [20819.291, -37734.965, -130120.57] }, { name: 'spawn hills', pos: [-127155 * 1.0, -22183.6, 39306.1] },
];
const raises = quick ? [0, 60] : [0, 25, 120, 600], headings = quick ? 4 : 8, pitches = quick ? [-8] : [-25, -6, 8];
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 700));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 1800000, dumpio: process.argv.includes('--verbose'),
        args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 400)));
    await page.setViewport({ width: 1728, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(await readFile(new URL('../lakeRecovery/pageInstrument.js', import.meta.url), 'utf8'));
    await page.goto(`http://127.0.0.1:${PORT}/wizard_game/standalone.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 240000, polling: 250 });
    await page.evaluate(() => {
        const g = window.gameEngine, r = g.renderer, device = r.backend.device;
        g.gameTime.setFrozen(true);
        r.weatherController._pickNewWeatherTarget = () => {};
        r.weatherController.setWeather('clear', true);
        const module = device.createShaderModule({ code: `
            @group(0) @binding(0) var depth: texture_depth_2d;
            @group(0) @binding(1) var<storage, read_write> kept: array<f32>;
            @group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>, 4>;
            @compute @workgroup_size(8, 8) fn keep(@builtin(global_invocation_id) id: vec3<u32>) { let n = textureDimensions(depth); if (any(id.xy >= n)) { return; }
                kept[id.y * n.x + id.x] = textureLoad(depth, id.xy, 0); atomicAdd(&counts[3], 0u); }
            @compute @workgroup_size(8, 8) fn compare(@builtin(global_invocation_id) id: vec3<u32>) { let n = textureDimensions(depth); if (any(id.xy >= n)) { return; }
                let a = kept[id.y * n.x + id.x]; let b = textureLoad(depth, id.xy, 0);
                if (a != b) { atomicAdd(&counts[0], 1u); if (abs(b - a) > 1.0e-3 * max(1.0 - min(a, b), 1.0e-7)) { atomicAdd(&counts[1], 1u); } } atomicAdd(&counts[2], 1u); }` });
        const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 4, texture: { sampleType: 'depth' } }, { binding: 1, visibility: 4, buffer: { type: 'storage' } }, { binding: 2, visibility: 4, buffer: { type: 'storage' } }] });
        const pipeline = entryPoint => device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint } });
        const steps = { keep: pipeline('keep'), compare: pipeline('compare') };
        const kept = device.createBuffer({ size: 4096 * 2304 * 4, usage: GPUBufferUsage.STORAGE });
        const counts = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const run = async name => {
            device.queue.writeBuffer(counts, 0, new Uint32Array(4));
            const e = device.createCommandEncoder(), p = e.beginComputePass();
            p.setPipeline(steps[name]);
            p.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: r.postProcessing.depthTexture.createView() }, { binding: 1, resource: { buffer: kept } }, { binding: 2, resource: { buffer: counts } }] }));
            p.dispatchWorkgroups(Math.ceil(r.postProcessing.width / 8), Math.ceil(r.postProcessing.height / 8));
            p.end();
            const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            e.copyBufferToBuffer(counts, 0, read, 0, 16);
            device.queue.submit([e.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const v = [...new Uint32Array(read.getMappedRange())];
            read.destroy();
            return { differs: v[0], byMoreThanAThousandth: v[1], pixels: v[2] };
        };
        const pass = r.quadtreeTerrainRenderer.pass;
        const drawn = async () => {
            const read = device.createBuffer({ size: pass.draws.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const e = device.createCommandEncoder();
            e.copyBufferToBuffer(pass.draws, 0, read, 0, read.size);
            device.queue.submit([e.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const d = new Uint32Array(read.getMappedRange().slice(0));
            read.destroy();
            let tiles = 0, triangles = 0;
            for (let b = 0; b < 64; b++) { tiles += d[b * 5 + 1]; triangles += d[b * 5 + 1] * d[b * 5] / 3; }
            return { tiles, triangles };
        };
        const render = g.render;
        const frames = async n => { for (let i = 0; i < n; i++) { await render.call(g, 1 / 60); await device.queue.onSubmittedWorkDone(); } };
        window.__occ = async (what, pos, look, up) => {
            const set = on => { if (what === 'pass') pass.enabled = on; else pass.options[what] = on; };
            const v = ([x, y, z]) => ({ x, y, z });
            window.qtDiag.regional.useCamera({ position: v(pos), target: v(look), up: v(up), fov: 75 });
            const end = performance.now() + 20000;
            let idle = 0;
            do {
                await new Promise(res => setTimeout(res, 60));
                const s = window.__lr.residency();
                const quiet = s?.exactVisibleRatio === 1 && !s.pendingGenerations && !s.activeGenerations && !s.pendingCopies;
                idle = quiet ? idle || performance.now() : 0;
            } while ((!idle || performance.now() - idle < 250) && performance.now() < end);
            g.render = async () => {};
            while (g._renderInFlight) await new Promise(res => setTimeout(res, 3));
            try {
                set(false);
                await frames(3);
                const off = await drawn();
                await run('keep');
                set(true);
                await frames(3);
                const on = await drawn(), hidden = await run('compare');
                set(false);
                await frames(3);
                const again = await run('compare');
                return { off, on, hidden, again };
            } finally { g.render = render; set(what !== 'occlusion'); }
        };
    });
    const views = [];
    for (const place of places) for (const raise of raises) for (let h = 0; h < headings; h++) for (const pitch of pitches) {
        const l = Math.hypot(...place.pos), up = place.pos.map(x => x / l), pos = up.map(x => x * (l + raise));
        const raw = [up[2], 0, -up[0]], rl = Math.hypot(...raw), e = raw.map(x => x / rl), n = [up[1] * e[2] - up[2] * e[1], up[2] * e[0] - up[0] * e[2], up[0] * e[1] - up[1] * e[0]];
        const a = h / headings * 2 * Math.PI + 0.3, t = pitch * Math.PI / 180;
        const look = pos.map((x, i) => x + 1000 * ((e[i] * Math.cos(a) + n[i] * Math.sin(a)) * Math.cos(t) + up[i] * Math.sin(t)));
        const r = await page.evaluate((...x) => window.__occ(...x), what, pos, look, up);
        views.push({ place: place.name, raise, heading: h, pitch, ...r });
        if (process.argv.includes('--verbose')) console.log(place.name, raise, h, pitch, JSON.stringify(r));
    }
    const stable = views.filter(v => v.again.differs === 0), wrong = stable.filter(v => v.hidden.differs > 0);
    const share = v => 1 - v.on.triangles / Math.max(1, v.off.triangles);
    console.log(`${views.length} views, ${stable.length} held still, ${wrong.length} changed with the occlusion on`);
    for (const v of wrong.slice(0, 12)) console.log('  ', v.place, v.raise, v.heading, v.pitch, JSON.stringify(v.hidden), JSON.stringify(v.off), JSON.stringify(v.on));
    for (const p of places) for (const raise of raises) {
        const some = stable.filter(v => v.place === p.name && v.raise === raise);
        if (some.length) console.log(`   ${p.name.padEnd(12)} +${String(raise).padEnd(4)} tiles ${(some.reduce((s, v) => s + v.off.tiles, 0) / some.length).toFixed(0)} -> ${(some.reduce((s, v) => s + v.on.tiles, 0) / some.length).toFixed(0)}, triangles -${(100 * some.reduce((s, v) => s + share(v), 0) / some.length).toFixed(0)} % (most ${(100 * Math.max(...some.map(share))).toFixed(0)} %)`);
    }
    const gpuErrors = await page.evaluate(() => window.__lr.gpuErrors);
    await writeFile(out, JSON.stringify({ views, errors, gpuErrors }));
    console.log('errors', errors.length, gpuErrors.length, errors[0] ?? '', JSON.stringify(gpuErrors[0] ?? ''));
} finally {
    await browser?.close();
    server.kill();
}
