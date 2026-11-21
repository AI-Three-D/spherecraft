// General terrain review capture: one page load per run, any terrainRework
// selection, any number of camera poses, optional hillshaded height maps
// sampled from the hydrology sampler (natural terrain, no render settle).
//
//   node tools/perf/terrainRework/shoot.mjs <spec.json> <outDir>
//
// spec = {
//   base: 'http://127.0.0.1:8790',            // preview_server.py --compare
//   selection: 'mountains,foothills,canyon',  // terrainRework (omit: none)
//   query: { extra: 'params' },
//   terrain: { ...terrain.json overrides }, features: { switch: bool },
//   sun: 0.75,                                // sun elevation (dot with up)
//   poses: [
//     { name, position:[x,y,z], target:[x,y,z], up?, fov? },
//     { name, dir:[x,y,z], alt: 1500,         // metres above natural ground
//       look: { dir:[x,y,z], alt: 0 } | { heading:[x,y,z], pitch: -20 } }
//   ],
//   maps: [ { name, dir:[x,y,z], sizeM: 40000, px: 256, rotate?: deg } ],
//   probe: 'js expression evaluated after ready; result printed'
// }
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';

const [specFile, out] = process.argv.slice(2);
if (!specFile || !out) throw new Error('usage: shoot.mjs <spec.json> <outDir>');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function writePng(file, w, h, rgb) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    defaultViewport: { width: spec.width ?? 1440, height: spec.height ?? 900, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
});
const errors = [];
try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.evaluateOnNewDocument(({ features, terrain }) => {
        const merge = (a, b) => {
            const o = { ...a };
            for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v;
            return o;
        };
        const nativeFetch = window.fetch;
        window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            const url = typeof args[0] === 'string' ? args[0] : args[0].url;
            if (!new URL(url, location.href).pathname.endsWith('/terrain.json') || !response.ok) return response;
            const config = merge(await response.json(), merge(terrain, { features }));
            return new Response(JSON.stringify(config), { status: response.status, headers: response.headers });
        };
    }, { features: spec.features ?? {}, terrain: spec.terrain ?? {} });
    const query = new URLSearchParams({ lakeCells: '1', labNoClouds: '1', ...(spec.query ?? {}) });
    if (spec.selection !== undefined) query.set('terrainRework', spec.selection);
    const t0 = Date.now();
    await page.goto(`${spec.base ?? 'http://127.0.0.1:8790'}/wizard_game/standalone.html?${query}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.qtDiag?.regional && window.gameEngine?.waterService?._sampler
        && window.gameEngine?.renderer?.quadtreeTileManager, { timeout: 300000, polling: 1000 });
    console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const info = await page.evaluate(() => {
        const g = window.gameEngine, o = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
        return { radius: g.planetConfig.radius, origin: [o.x, o.y, o.z], maxH: g.planetConfig.maxTerrainHeight };
    });
    console.log(JSON.stringify(info));
    if (spec.probe) console.log('probe:', JSON.stringify(await page.evaluate(spec.probe)));

    const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
    const sample = async dirs => page.evaluate(async flat => {
        const r = await window.gameEngine.waterService._sampler.sampleDirsNatural(new Float32Array(flat));
        return Array.from(r);
    }, dirs.flatMap(d => [...d, 0]));

    // Height maps: tangent plane grid around dir, hillshade + hypsometric tint.
    for (const m of spec.maps ?? []) {
        const n = norm(m.dir), px = m.px ?? 256, size = m.sizeM ?? 40000;
        const ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        let e1 = norm([n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]);
        let e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
        if (m.rotate) {
            const a = m.rotate * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            [e1, e2] = [e1.map((v, i) => c * v + s * e2[i]), e2.map((v, i) => c * v - s * e1[i])];
        }
        const dirs = [];
        for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
            const x = (i / (px - 1) - 0.5) * size, y = (0.5 - j / (px - 1)) * size;
            dirs.push(norm(n.map((v, k) => v * info.radius + e1[k] * x + e2[k] * y)));
        }
        const heights = [];
        for (let k = 0; k < dirs.length; k += 16384) heights.push(...await sample(dirs.slice(k, k + 16384)));
        const cell = size / (px - 1), rgb = new Uint8Array(px * px * 3);
        let lo = Infinity, hi = -Infinity, maxSlope = 0, steep = 0;
        for (const h of heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
        const sea = m.sea ?? 0;
        for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
            const H = (a, b) => heights[Math.min(px - 1, Math.max(0, b)) * px + Math.min(px - 1, Math.max(0, a))];
            const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * cell), dy = (H(i, j - 1) - H(i, j + 1)) / (2 * cell);
            const slope = Math.hypot(dx, dy); maxSlope = Math.max(maxSlope, slope); if (slope > 1) steep++;
            const nl = norm([-dx, -dy, 1]), L = norm([-1, 1, 1.4]);
            const shade = Math.max(0, nl[0] * L[0] + nl[1] * L[1] + nl[2] * L[2]);
            const h = H(i, j), t = (h - lo) / Math.max(1, hi - lo);
            let col = h < sea ? [60, 100, 170] : [90 + 150 * t, 140 + 70 * t, 80 + 120 * t];
            const o = (j * px + i) * 3;
            for (let c = 0; c < 3; c++) rgb[o + c] = Math.max(0, Math.min(255, col[c] * (0.35 + 0.8 * shade)));
        }
        writePng(path.join(out, `${m.name}.png`), px, px, rgb);
        console.log(JSON.stringify({ map: m.name, min: Math.round(lo), max: Math.round(hi), cellM: +cell.toFixed(1),
            maxSlope: +maxSlope.toFixed(2), steepFrac: +(steep / (px * px)).toFixed(4) }));
        if (m.dump) fs.writeFileSync(path.join(out, `${m.name}.json`), JSON.stringify({ px, size, n, e1, e2,
            radius: info.radius, origin: info.origin, heights: heights.map(h => Math.round(h)) }));
    }

    // Whole-planet equirectangular hillshade + raw heights (Int16 metres),
    // for planet-wide distribution checks and on/off diffs (globeDiff.mjs).
    if (spec.globe) {
        const W = spec.globe.w ?? 720, Hh = spec.globe.h ?? 360;
        const dirs = [];
        for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
            const lat = Math.PI / 2 - (j + 0.5) / Hh * Math.PI, lon = (i + 0.5) / W * 2 * Math.PI - Math.PI;
            dirs.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
        }
        const heights = [];
        for (let k = 0; k < dirs.length; k += 16384) heights.push(...await sample(dirs.slice(k, k + 16384)));
        const raw = Buffer.alloc(heights.length * 2);
        heights.forEach((h, k) => raw.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(h))), k * 2));
        fs.writeFileSync(path.join(out, `${spec.globe.name ?? 'globe'}.i16`), raw);
        const rgb = new Uint8Array(W * Hh * 3), cell = 2 * Math.PI * info.radius / W;
        for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
            const H = (a, b) => heights[Math.min(Hh - 1, Math.max(0, b)) * W + ((a + W) % W)];
            const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * cell), dy = (H(i, j - 1) - H(i, j + 1)) / (2 * cell);
            const nl = norm([-dx * 3, -dy * 3, 1]), L = norm([-1, 1, 1.4]);
            const shade = Math.max(0, nl[0] * L[0] + nl[1] * L[1] + nl[2] * L[2]);
            const h = H(i, j), t = Math.min(1, Math.max(0, h / 2500));
            const col = h < 0 ? [50, 90, 160] : [90 + 150 * t, 140 + 60 * t, 80 + 110 * t];
            const o = (j * W + i) * 3;
            for (let c = 0; c < 3; c++) rgb[o + c] = Math.max(0, Math.min(255, col[c] * (0.35 + 0.8 * shade)));
        }
        writePng(path.join(out, `${spec.globe.name ?? 'globe'}.png`), W, Hh, rgb);
        console.log(JSON.stringify({ globe: spec.globe.name ?? 'globe', w: W, h: Hh }));
    }

    if (spec.poses?.length) {
        await page.addStyleTag({ content: 'body * {visibility:hidden!important} #gameCanvas {visibility:visible!important}' });
        if (spec.hideSea) await page.evaluate(() => { window.gameEngine.renderer.terrainModule.ocean.enabled = false; });
    }
    for (const pose of spec.poses ?? []) {
        let position = pose.position, target = pose.target, up = pose.up;
        if (pose.dir) {
            const n = norm(pose.dir);
            const [h] = await sample([n]);
            position = n.map((v, i) => info.origin[i] + v * (info.radius + h + (pose.alt ?? 1500)));
            if (pose.look?.dir) {
                const ln = norm(pose.look.dir);
                const [lh] = await sample([ln]);
                target = ln.map((v, i) => info.origin[i] + v * (info.radius + lh + (pose.look.alt ?? 0)));
            } else {
                const hd = pose.look?.heading ?? [0, 1, 0];
                const d = hd.reduce((s, v, i) => s + v * n[i], 0);
                const t = norm(hd.map((v, i) => v - d * n[i]));
                const p = (pose.look?.pitch ?? -20) * Math.PI / 180;
                target = position.map((v, i) => v + 1000 * (t[i] * Math.cos(p) + n[i] * Math.sin(p)));
            }
            if (!up) up = n;
            pose.resolved = { position: position.map(v => +v.toFixed(1)), target: target.map(v => +v.toFixed(1)), groundM: Math.round(h) };
        }
        await page.evaluate(({ position, sunElevation }) => {
            const g = window.gameEngine, s = g.starSystem, body = s?.currentBody;
            const o = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
            const rel = [position[0] - o.x, position[1] - o.y, position[2] - o.z], len = Math.hypot(...rel);
            if (!body) return;
            s.paused = true; s.useGameTimeRotation = false;
            let best = Infinity, rotation = 0;
            for (let i = 0; i < 720; i++) {
                body.currentRotation = i * Math.PI * 2 / 720;
                const d = body.getStarDirection(s.primaryStar).direction;
                const score = Math.abs((d.x * rel[0] + d.y * rel[1] + d.z * rel[2]) / len - sunElevation);
                if (score < best) { best = score; rotation = body.currentRotation; }
            }
            body.currentRotation = rotation;
        }, { position, sunElevation: pose.sun ?? spec.sun ?? 0.75 });
        await page.evaluate(v => {
            clearInterval(window.__shootHold);
            const xyz = a => ({ x: a[0], y: a[1], z: a[2] });
            const cam = { position: xyz(v.position), target: xyz(v.target), up: xyz(v.up ?? [0, 1, 0]), fov: v.fov ?? 75 };
            const apply = () => window.qtDiag.regional.useCamera(cam);
            apply(); window.__shootHold = setInterval(apply, 250);
        }, { position, target, up, fov: pose.fov });
        await sleep(2500);
        let stable = 0, state;
        for (let k = 0; k < 150; k++) {
            state = await page.evaluate(() => {
                const g = window.gameEngine, s = g.renderer.quadtreeTileManager.getInitialLoadStatus();
                return { visible: s.visibleTiles, exact: s.exactVisibleRatio, pending: s.pendingGenerations,
                    active: s.activeGenerations, copies: s.pendingCopies, water: g.waterService?._lakeCells?.planning };
            });
            const done = state.visible > 0 && state.exact >= 0.999 && !state.pending && !state.active && !state.copies && !state.water;
            stable = done ? stable + 1 : 0;
            if (stable >= 2) break;
            await sleep(1000);
        }
        await sleep(800);
        await page.screenshot({ path: path.join(out, `${pose.name}.png`) });
        console.log(JSON.stringify({ shot: pose.name, settled: stable >= 2, ...(pose.resolved ?? {}) }));
    }
} finally {
    if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 8)));
    await browser.close();
}
