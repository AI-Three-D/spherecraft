/* global process, Buffer */
// Captures listed camera views of the water (owned server + headless Chrome,
// warm profile), each settled, with water tints and terrain debug modes.
//
//   node tools/perf/lakeRecovery/waterViews.mjs --out=DIR --views=FILE.json
//        [--port=8193] [--profile=DIR] [--query=...]
//
// Views: [{ name, dir: [x, y, z] (ground point), groundM, altM, back: [x, y, z]
// (tangent the camera steps back along, km in backKm; omitted: straight
// down), upHint, tints: [0, 3], terrain: [10], eval: "js returning JSON",
// owner: true (who draws the water, ownerCaptures), traceNearM: trace the rivers
// passing that close first, metrics: { river: id }
// or { near: view name, mountain: true } (cross-section metrics, riverMetrics),
// census: { waitS } (the planet's rivers, waterCensus) }].
// Writes DIR/report.json and DIR/<name>[-tintN|-dbgN].png. Never reuses a
// non-empty DIR.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readPng, writePng } from '../riverMetrics/png.js';
import { classifyOwners, ribbonContainment } from '../riverMetrics/ownership.js';
import { buildStations, clipExtents, lod0Spacing } from '../riverMetrics/riverSections.js';
import { sectionMetrics, summarizeRiver } from '../riverMetrics/sectionMetrics.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const req = createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : '1']; }));
if (!args.out || !args.views) throw new Error('--out=DIR and --views=FILE required');
const out = path.resolve(args.out);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`evidence directory not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });
const views = JSON.parse(fs.readFileSync(path.resolve(args.views), 'utf8'));
const port = Number(args.port ?? 8193);
const query = args.query ?? 'regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1';
const url = `http://127.0.0.1:${port}/wizard_game/standalone.html?${query}`;
const report = { url, startedAt: new Date().toISOString(), args, views, captures: [], errors: [], console: [] };
process.on('unhandledRejection', (e) => { report.unhandled = String(e?.stack || e).slice(0, 300); });
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));

const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(port), root], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1000));
const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    protocolTimeout: 900000,
    ...(args.profile ? { userDataDir: path.resolve(args.profile) } : {}),
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await browser.newPage();
page.on('pageerror', e => report.errors.push(String(e)));
page.on('console', m => { const t = m.text(); if (/^\[(Water|GameEngine)\]|rror|WARN/.test(t)) report.console.push(t.slice(0, 400)); });
await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/lakeRecovery/pageInstrument.js'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function settle(capMs = 90000) {
    const t0 = Date.now();
    let streak = 0, last = null;
    while (Date.now() - t0 < capMs) {
        last = await page.evaluate(() => ({ ...window.__lr.residency(),
            regenPending: window.gameEngine?.renderer?.quadtreeTileManager?.tileStreamer?.getRegenerationStats?.()?.pending ?? 0 }));
        const idle = last && last.pendingGenerations === 0 && last.activeGenerations === 0 && last.pendingCopies === 0 && last.exactVisibleRatio >= 0.999 && last.visibleTiles > 0 && last.regenPending === 0;
        streak = idle ? streak + 1 : 0;
        if (streak >= 8) return { settled: true, ms: Date.now() - t0 };
        await sleep(150);
    }
    return { settled: false, ms: Date.now() - t0, residency: last };
}
async function shot(name) {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    report.captures.push({ name, pose: await page.evaluate(() => window.__lr.pose()) });
    save();
}
async function captureView(v) {
    // traceNearM: trace the rivers passing that close to the camera's ground point first (nearest first, up to 8).
    if (v.traceNearM) report[`traced_${v.name}`] = await page.evaluate(async ({ nearM, o }) => {
        const s = window.gameEngine.waterService, c = window.gameEngine.camera.position;
        const p = [c.x - o[0], c.y - o[1], c.z - o[2]], l = Math.hypot(...p), d = p.map(x => x / l);
        const near = s.rivers.map(r => ({ rid: r.id, m: s._riverDistance(r.id, d) })).filter(r => r.m <= nearM).sort((a, b) => a.m - b.m).slice(0, 8);
        const t0 = performance.now(), out = [];
        for (const { rid, m } of near) {
            for (let i = 0; i < 1800 && !s.riverRecs.has(rid) && !s._failedRivers.has(rid); i++) {
                if (i % 20 === 0 && !s._busy) s.refineRiver(rid);
                await new Promise(r => setTimeout(r, 100));
            }
            out.push({ rid, m: Math.round(m), traced: s.riverRecs.has(rid) });
        }
        return { ms: Math.round(performance.now() - t0), rivers: out };
    }, { nearM: v.traceNearM, o: report.origin }).catch(e => String(e));
    const st = await settle();
    report[`settle_${v.name}`] = st;
    if (v.eval) report[`eval_${v.name}`] = await page.evaluate(v.eval).catch(e => String(e));
    // Traced rivers with a point within 600 m of the camera's ground point:
    // id, mountain stream or not, destination, half-width range, nearest m.
    if (v.pos) report[`rivers_${v.name}`] = await page.evaluate((pos) => {
        const s = window.gameEngine.waterService, R = s.radius, l = Math.hypot(...pos), d = pos.map(x => x / l), out = [];
        for (const [rid, rec] of s.riverRecs) {
            const P = rec.points, st = rec.stride, n = P.length / st;
            let best = Infinity, hwMin = Infinity, hwMax = 0;
            for (let k = 0; k < n; k++) {
                const c = d[0] * P[k * st] + d[1] * P[k * st + 1] + d[2] * P[k * st + 2];
                best = Math.min(best, Math.acos(Math.min(1, c)) * R);
                hwMin = Math.min(hwMin, P[k * st + 4]); hwMax = Math.max(hwMax, P[k * st + 4]);
            }
            if (best < 600) out.push({ rid, mountain: !!s.rivers[rid]?.mountain, to: s.rivers[rid]?.to ?? rec.dest, nearestM: Math.round(best), hw: [+hwMin.toFixed(1), +hwMax.toFixed(1)], n });
        }
        return out.sort((a, b) => a.nearestM - b.nearestM);
    }, v.pos).catch(e => String(e));
    // The view ray (camera through look) against every solved lake's level:
    // where it meets a lake's level within 5 km, that lake's mask value there
    // (0 none, 1 shore band, 2 water) and its atlas slot vs mask size.
    if (v.look) report[`probe_${v.name}`] = await page.evaluate(({ pos, look }) => {
        const s = window.gameEngine.waterService, g = window.gameEngine.waterGpuData, R = s.radius;
        const dl = Math.hypot(...look.map((x, i) => x - pos[i])), dv = look.map((x, i) => (x - pos[i]) / dl);
        const b = pos[0] * dv[0] + pos[1] * dv[1] + pos[2] * dv[2], pp = pos[0] ** 2 + pos[1] ** 2 + pos[2] ** 2, out = [];
        for (const [id, rec] of s.refined) {
            const r = R + rec.level, disc = b * b - (pp - r * r);
            if (disc < 0) continue;
            const t = [-b - Math.sqrt(disc), -b + Math.sqrt(disc)].find(t => t > 0);
            if (!(t < 5000)) continue;
            const p = pos.map((x, i) => x + t * dv[i]), l = Math.hypot(...p), d = p.map(x => x / l), f = rec.frame;
            const k = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
            if (k <= 0.99) continue;
            const x = (d[0] * f.e1[0] + d[1] * f.e1[1] + d[2] * f.e1[2]) / k * R, y = (d[0] * f.e2[0] + d[1] * f.e2[1] + d[2] * f.e2[2]) / k * R;
            const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
            if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) continue;
            const layer = g?._layerOf?.get(id);
            out.push({ id, mountain: !!s.lakes[id]?.mountain, level: rec.level, t: Math.round(t), mask: rec.mask[j * f.nx + i], i, j, nx: f.nx, ny: f.ny,
                spacing: f.spacing, slot: layer != null && g._slots ? g._slots[layer]?.size : null, river: s.lakes[id]?.river });
        }
        return { cameraHeightM: Math.sqrt(pp) - R, lakes: out.sort((a, b) => a.t - b.t) };
    }, { pos: v.pos, look: v.look }).catch(e => String(e));
    // ui: one capture with the HUD shown (its CAMERA card gives the pose).
    if (v.ui) {
        await page.evaluate(() => { document.getElementById('__hideUi').disabled = true; });
        await sleep(1200);
        await shot(`${v.name}-ui`);
        await page.evaluate(() => { document.getElementById('__hideUi').disabled = false; });
    }
    for (const tint of v.tints ?? [0]) {
        await page.evaluate((t) => window.qtDiag.water.tint(t), tint);
        await shot(tint ? `${v.name}-tint${tint}` : v.name);
    }
    await page.evaluate(() => window.qtDiag.water.tint(0));
    for (const mode of v.terrain ?? []) {
        await page.evaluate((m) => window.qtDiag.setTerrainDebugMode(m), mode);
        await shot(`${v.name}-dbg${mode}`);
    }
    if ((v.terrain ?? []).length) await page.evaluate(() => window.qtDiag.setTerrainDebugMode(0));
    // variants: [{ name, set: "js", reset: "js", settle }] captured after
    // the tints; settle: wait for the terrain to regenerate (feature toggles).
    for (const x of v.variants ?? []) {
        await page.evaluate(x.set);
        if (x.settle) { await sleep(500); report[`settle_${v.name}-${x.name}`] = await settle(); } else await sleep(300);
        await shot(`${v.name}-${x.name}`);
        await page.evaluate(x.reset);
        if (x.settle) { await sleep(500); await settle(); }
    }
    if (v.owner) await ownerCaptures(v);
}

// owner: who draws the water (river redesign R1(a); tools/perf/riverMetrics
// ownership.js). Water views 6 and 7 with post effects, sky, clouds,
// particles, vegetation and meshes hidden, so only the terrain and the
// water passes write: classes to <name>-owners.png and report.owners_<name>.
// With a 'noribbons' variant also the check against that earlier method.
async function ownerCaptures(v) {
    await page.evaluate(() => {
        const f = window.gameEngine.renderer, saved = [], noop = () => {};
        const off = (o, k, val) => { if (!o) return; saved.push([o, k, Object.prototype.hasOwnProperty.call(o, k), o[k]]); o[k] = val; };
        off(f.postProcessing, 'enabled', false);
        off(f.cloudRenderer, 'enabled', false);
        for (const r of [f.skyRenderer, f.starRenderer, f.moonRenderer, f.assetStreamer, f.particleSystem, f.skinnedMeshRenderer, f.genericMeshRenderer]) off(r, 'render', noop);
        off(f, '_renderAtmoBanks', noop);
        window.__ownerRestore = () => { for (const [o, k, own, val] of saved.reverse()) { if (own) o[k] = val; else delete o[k]; } };
    });
    try {
        for (const mode of [6, 7]) {
            await page.evaluate((m) => window.qtDiag.water.tint(m), mode);
            await shot(`${v.name}-own${mode}`);
        }
    } finally {
        await page.evaluate(() => { window.qtDiag.water.tint(0); window.__ownerRestore(); });
    }
    const png = (s) => readPng(fs.readFileSync(path.join(out, `${s}.png`)));
    const a = png(`${v.name}-own6`), b = png(`${v.name}-own7`), base = fs.existsSync(path.join(out, `${v.name}.png`)) ? png(v.name) : null;
    const r = classifyOwners(a, b, base);
    fs.writeFileSync(path.join(out, `${v.name}-owners.png`), writePng(r.w, r.h, r.image));
    report[`owners_${v.name}`] = { counts: r.counts, shares: r.shares, isolated: r.isolated };
    if (base && fs.existsSync(path.join(out, `${v.name}-noribbons.png`))) report[`ribbonCheck_${v.name}`] = ribbonContainment(base, png(`${v.name}-noribbons`), a);
    save();
}

// metrics: { river: id } | { near: view, mountain } | { pos: [x, y, z], mountain }:
// cross-section metrics of one traced river (river redesign R1(b);
// tools/perf/riverMetrics): stations every METRIC_STEP_M along the traced
// line, sections out to its widest half-width + METRIC_MARGIN_M at
// METRIC_DN, sampled from the tiles' height function by the hydrology
// sampler, as drawn (valleys and carve) and natural. Narrow streams are
// carved only while listed for the GPU (within NARROW_RIVER_DRAW_M of the
// camera), so this runs with the camera over the river. Writes
// <name>-river<id>-stations.json, -sections.f32.gz (as drawn, then natural)
// and -metrics.json; the summary to report.metrics_<name>.
const METRIC_STEP_M = 4, METRIC_DN = 0.25, METRIC_MARGIN_M = 100;
async function riverMetrics(v, rid) {
    const t0 = Date.now();
    const src = await page.evaluate(async (rid) => {
        const s = window.gameEngine.waterService, g = window.gameEngine.waterGpuData, rec = s.riverRecs.get(rid);
        if (!rec) return null;
        for (let i = 0; i < 50 && !g._inGpu?.has(rid); i++) await new Promise(r => setTimeout(r, 100));
        const { riverWaterLevels } = await import('/core/world/water/riverRibbon.js');
        const arc = g._arcLengths(rec), levels = riverWaterLevels(rec, arc, (d) => g.lakeAt(d));
        const b64 = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t); };
        const qt = window.gameEngine.renderer?.quadtreeTileManager;
        return { stride: rec.stride, points: b64(Float32Array.from(rec.points)), arc: b64(Float64Array.from(arc)), levels: b64(Float64Array.from(levels)),
            listed: g._inGpu?.has(rid) ?? null, mountain: !!s.rivers[rid]?.mountain, R: s.radius,
            maxDepth: qt?.quadtreeGPU?.maxDepth ?? null, segments: qt?.engineConfig?.chunkSegments ?? null };
    }, rid);
    if (!src) { report[`metrics_${v.name}`] = { rid, error: 'not traced' }; save(); return; }
    const dec = (b, T) => new T(Uint8Array.from(Buffer.from(b, 'base64')).buffer);
    const points = dec(src.points, Float32Array), arc = dec(src.arc, Float64Array), levels = dec(src.levels, Float64Array), R = src.R;
    const st = buildStations({ points, stride: src.stride, arc, levels, stepM: METRIC_STEP_M });
    let hwMax = 0, hwMin = Infinity;
    for (let o = 4; o < points.length; o += src.stride) { hwMax = Math.max(hwMax, points[o]); hwMin = Math.min(hwMin, points[o]); }
    const half = Math.ceil(hwMax + METRIC_MARGIN_M), N = Math.round(half / METRIC_DN), count = 2 * N + 1;
    const ext = clipExtents(st, R, half);
    // Sampled per chunk of stations, directions built in the page.
    const H = new Float32Array(st.count * count), H0 = new Float32Array(st.count * count);
    const K = Math.max(1, Math.floor(65536 / count));
    for (let q0 = 0; q0 < st.count; q0 += K) {
        const q1 = Math.min(st.count, q0 + K);
        const res = await page.evaluate(async ({ dir, left, N, dn, R }) => {
            const s = window.gameEngine.waterService, m = dir.length / 3, count = 2 * N + 1, dirs = new Float32Array(4 * m * count);
            for (let q = 0; q < m; q++) for (let i = 0; i < count; i++) {
                const k = (i - N) * dn / R, o = 4 * (q * count + i);
                const x = dir[3 * q] + left[3 * q] * k, y = dir[3 * q + 1] + left[3 * q + 1] * k, z = dir[3 * q + 2] + left[3 * q + 2] * k, l = Math.hypot(x, y, z);
                dirs[o] = x / l; dirs[o + 1] = y / l; dirs[o + 2] = z / l;
            }
            const drawn = await s._sampler.sampleDirsCarved(dirs), natural = await s._sampler.sampleDirsNatural(dirs);
            if (!drawn || !natural) return null;
            const b64 = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t); };
            return { drawn: b64(drawn), natural: b64(natural) };
        }, { dir: Array.from(st.dir.subarray(3 * q0, 3 * q1)), left: Array.from(st.left.subarray(3 * q0, 3 * q1)), N, dn: METRIC_DN, R });
        if (!res) { report[`metrics_${v.name}`] = { rid, error: 'carved sampler not ready' }; save(); return; }
        H.set(dec(res.drawn, Float32Array), q0 * count);
        H0.set(dec(res.natural, Float32Array), q0 * count);
    }
    const sampleMs = Date.now() - t0;
    const maxDepth = src.maxDepth ?? Math.ceil(Math.log2(2 * R / 128)), segments = src.segments ?? 128;
    const rows = [];
    for (let q = 0; q < st.count; q++) {
        const spacing = lod0Spacing(st.dir.subarray(3 * q, 3 * q + 3), R, maxDepth, segments);
        const m = sectionMetrics({ h: H.subarray(q * count, (q + 1) * count), h0: H0.subarray(q * count, (q + 1) * count),
            dn: METRIC_DN, wl: st.wl[q], extentL: ext.left[q], extentR: ext.right[q], spacing });
        rows.push({ ...m, s: st.s[q], inLake: st.pool[q] < 0, spacing });
    }
    const summary = summarizeRiver(rows, { stepM: METRIC_STEP_M });
    const base = path.join(out, `${v.name}-river${rid}`), r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
    fs.writeFileSync(`${base}-sections.f32.gz`, zlib.gzipSync(Buffer.concat([Buffer.from(H.buffer), Buffer.from(H0.buffer)])));
    // The traced record itself (RIVER_POINT_STRIDE floats a point, riverRefine.js), for offline sections.
    fs.writeFileSync(`${base}-record.f32.gz`, zlib.gzipSync(Buffer.from(points.buffer)));
    fs.writeFileSync(`${base}-stations.json`, JSON.stringify({ rid, R, dn: METRIC_DN, N, count, stepM: METRIC_STEP_M, maxDepth, segments,
        layout: 'sections.f32.gz: stations x count float32 as drawn, then the same natural; sample i at (i - N) dn, + left; record.f32.gz: the traced points, recordStride floats each', recordStride: src.stride,
        s: [...st.s], wl: [...st.wl].map(r3), hw: [...st.hw].map(r3), pool: [...st.pool].map(r3), extentL: [...ext.left].map(r3), extentR: [...ext.right].map(r3),
        dir: [...st.dir], left: [...st.left] }));
    const side = (b) => (!b ? null : b.open ? 'open' : [r3(b.wet), r3(b.rise2), r3(b.rise10), r3(b.rise20), r3(b.steep10), r3(b.blend), b.cls, r3(b.pocket)]);
    fs.writeFileSync(`${base}-metrics.json`, JSON.stringify({ summary,
        columns: 's, inLake, dry, lineDry, trench, depthLine, width, left [wet, rise2, rise10, rise20, steep10, blend, class, pocket], right [same], ledges [n, width, rise] under 2 spacings, spacing',
        rows: rows.map(r => [r.s, r.inLake ? 1 : 0, r.dry ? 1 : 0, r.lineDry ? 1 : 0, r3(r.trench), r3(r.depthLine),
            r.edgeL != null && r.edgeR != null ? r3(r.edgeL - r.edgeR) : null, side(r.left), side(r.right),
            r.ledges.filter(l => l.spacings < 2).map(l => [r3(l.n), r3(l.width), r3(l.rise)]), r3(r.spacing)]) }));
    report[`metrics_${v.name}`] = { rid, mountain: src.mountain, listed: src.listed, lengthM: Math.round(arc[arc.length - 1]), hw: [r3(hwMin), r3(hwMax)],
        stations: st.count, halfSpanM: half, maxDepth, segments, sampleMs, totalMs: Date.now() - t0, summary };
    save();
}

// census: { waitS }: the planet's rivers for offline analysis
// (tools/perf/riverMetrics/riverCensus.mjs; owner 2026-10-13: rivers are
// hard to find). The water graph's sampled grid (heights, precipitation,
// from the service's cache) to <name>-grid.f32.gz, and every lake and river
// (kind, grid cells) with the traced ones now and after waitS seconds with
// the camera still (waitS: seconds or a list) to <name>-rivers.json.
async function waterCensus(v) {
    const traced = () => page.evaluate(() => { const s = window.gameEngine.waterService, g = window.gameEngine.waterGpuData;
        return { t: Math.round(performance.now()), traced: [...s.riverRecs.keys()], failed: [...(s._failedRivers ?? [])],
            drawn: [...(g?._inGpu ?? [])], dropped: g?._droppedRivers ?? null, timings: s.timings }; });
    const head = await page.evaluate(async () => {
        const s = window.gameEngine.waterService;
        window.__censusGrid = s.config.cache ? await s._cache.get(`grid:${s._key}`) : null;
        return { N: s.N, R: s.radius, seaLevelM: window.__censusGrid?.seaLevelM ?? null, params: s.config.params, stats: s.stats,
            lakes: s.lakes.map(l => [l.id, l.mountain ? 1 : 0, l.cellCount ?? 0, l.outflowQ ?? 0, l.level, l.river ?? -1]),
            rivers: s.rivers.map(r => ({ id: r.id, mountain: !!r.mountain, fromLake: r.fromLake, to: r.to, cells: Array.from(r.cells ?? []) })) };
    });
    const snapshots = [await traced()];
    if (head.seaLevelM != null) {
        const per = head.N * head.N, H = new Float32Array(6 * per), Pc = new Float32Array(6 * per);
        const dec = (b) => new Float32Array(Uint8Array.from(Buffer.from(b, 'base64')).buffer);
        for (let f = 0; f < 6; f++) {
            const r = await page.evaluate((f, per) => {
                const g = window.__censusGrid;
                const b64 = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t); };
                return { h: b64(g.heights.subarray(f * per, (f + 1) * per)), p: b64(g.precip.subarray(f * per, (f + 1) * per)) };
            }, f, per);
            H.set(dec(r.h), f * per);
            Pc.set(dec(r.p), f * per);
        }
        fs.writeFileSync(path.join(out, `${v.name}-grid.f32.gz`), zlib.gzipSync(Buffer.concat([Buffer.from(H.buffer), Buffer.from(Pc.buffer)])));
    }
    await page.evaluate(() => { delete window.__censusGrid; });
    // waitS: seconds, or a list of them (one snapshot after each, counted from here).
    let waited = 0;
    for (const w of [].concat(v.census?.waitS ?? [])) { await sleep((w - waited) * 1000); waited = w; snapshots.push(await traced()); }
    const pose = await page.evaluate(() => window.__lr.pose());
    fs.writeFileSync(path.join(out, `${v.name}-rivers.json`), JSON.stringify({ ...head, pose, snapshots,
        layout: 'grid.f32.gz: 6 N N float32 heights (m), then precipitation; lakes [id, mountain, cellCount, outflowQ, level, river]' }));
    report[`census_${v.name}`] = { lakes: head.lakes.length, rivers: head.rivers.length, grid: head.seaLevelM != null,
        traced: snapshots.map(s => ({ t: s.t, traced: s.traced.length, failed: s.failed.length, drawn: s.drawn.length, dropped: s.dropped })),
        timings: snapshots[0].timings };
    save();
}
const norm = (a) => { const l = Math.hypot(...a); return a.map(v => v / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 300000, polling: 100 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true, { timeout: 600000, polling: 500 });
    report.origin = await page.evaluate(() => { const o = window.gameEngine.planetConfig.origin; return [o.x, o.y, o.z]; });
    report.radius = await page.evaluate(() => window.gameEngine.planetConfig.radius);
    // Clear weather, sun height fixed over the first view (as originalLakeRun.mjs).
    report.weather = await page.evaluate(() => { const w = window.gameEngine.renderer?.weatherController;
        if (!w) return null; w._pickNewWeatherTarget = () => {}; return w.setWeather('clear', true); });
    report.daylight = await page.evaluate((c) => window.__lr.daylightAt(c, 0.75), views[0].dir ? norm(views[0].dir) : [-1, 0, 0]);
    await page.evaluate(() => { const st = document.createElement('style'); st.id = '__hideUi'; st.textContent = 'body > *:not(#gameCanvas){visibility:hidden !important}'; document.head.appendChild(st); });
    const R = report.radius, o = report.origin;
    for (const v of views) {
        // { lake: id }: over a lake's deepest point, ground at its level, offset by offsetKm [east, north] in its tangent plane.
        if (v.lake != null) {
            const L = await page.evaluate((id) => { const s = window.gameEngine.waterService, l = s.lakes[id]; return { dir: l.centreDir, level: s.refined.get(id)?.level ?? l.level }; }, v.lake);
            let d0 = norm(L.dir);
            if (v.offsetKm) {
                const e = norm([-d0[1], d0[0], 0].map((x, i) => (Math.hypot(d0[0], d0[1]) > 1e-6 ? x : [1, 0, 0][i])));
                const n = [d0[1] * e[2] - d0[2] * e[1], d0[2] * e[0] - d0[0] * e[2], d0[0] * e[1] - d0[1] * e[0]];
                d0 = norm(d0.map((x, i) => x + (e[i] * v.offsetKm[0] + n[i] * v.offsetKm[1]) * 1000 / R));
            }
            v.dir = d0; v.groundM = L.level;
        }
        // { metrics: { river: id } or { near: view, mountain } }: the river
        // (or the nearest traced river of that kind listed for an earlier
        // pose view) seen from over its middle, then its metrics.
        let metricsRid = null;
        if (v.metrics) {
            const near = report[`rivers_${v.metrics.near}`];
            metricsRid = v.metrics.river ?? (Array.isArray(near) ? near.find(r => r.mountain === !!v.metrics.mountain)?.rid : null) ?? null;
            // { pos: [x, y, z] world, mountain }: the river of that kind whose graph cells come nearest (ids change with the graph).
            if (metricsRid == null && v.metrics.pos) metricsRid = await page.evaluate(({ pos, mountain, o }) => {
                const s = window.gameEngine.waterService, p = pos.map((x, i) => x - o[i]), l = Math.hypot(...p), d = p.map(x => x / l);
                let best = null;
                for (const r of s.rivers) {
                    if (!!r.mountain !== mountain) continue;
                    const dr = s._riverDistance(r.id, d);
                    if (!best || dr < best.d) best = { d: dr, rid: r.id };
                }
                return best?.rid ?? null;
            }, { pos: v.metrics.pos, mountain: !!v.metrics.mountain, o: report.origin });
            report[`metricsRiver_${v.name}`] = metricsRid;
            if (metricsRid == null) continue;
            v.river = metricsRid; v.frac ??= 0.5; v.altM ??= 300;
        }
        // { river: id, frac, altM, backM }: behind a traced river's point at
        // arc fraction frac (solved first if needed), looking along its flow.
        if (v.river != null) {
            const P = await page.evaluate(async ({ rid, frac }) => {
                const s = window.gameEngine.waterService;
                for (let i = 0; i < 1800 && !s.riverRecs.has(rid); i++) {
                    if (i % 20 === 0 && !s._busy) s.refineRiver(rid);
                    await new Promise(r => setTimeout(r, 100));
                }
                const rec = s.riverRecs.get(rid);
                if (!rec) return null;
                const Q = rec.points, st = rec.stride, n = Q.length / st, k = Math.round(frac * (n - 1));
                const at = (q) => [Q[q * st], Q[q * st + 1], Q[q * st + 2]];
                const a = at(Math.max(0, k - 6)), b = at(Math.min(n - 1, k + 6));
                return { dir: at(k), flow: [b[0] - a[0], b[1] - a[1], b[2] - a[2]], eta: Q[k * st + (st >= 20 ? 16 : 3)], hw: Q[k * st + 4], n };
            }, { rid: v.river, frac: v.frac ?? 0.45 });
            report[`river_${v.name}`] = P;
            if (!P) continue;
            // upstream: the camera downstream of the point, looking back up the river.
            v.dir = P.dir; v.groundM = P.eta; v.back = P.flow.map(x => x * (v.upstream ? 1 : -1)); v.backKm = (v.backM ?? 300) / 1000;
        }
        // { pos, look }: a pose as the HUD's CAMERA card shows it (world
        // coordinates; up is the planet's radial direction).
        if (v.pos && v.look) {
            const up = norm(v.pos.map((x, i) => x - o[i]));
            await page.evaluate((P) => window.qtDiag.regional.useCamera(P), {
                position: { x: v.pos[0], y: v.pos[1], z: v.pos[2] }, target: { x: v.look[0], y: v.look[1], z: v.look[2] },
                up: { x: up[0], y: up[1], z: up[2] }, fov: v.fov ?? 75 });
            await captureView(v);
            continue;
        }
        const d = norm(v.dir), g = R + (v.groundM ?? 0);
        const target = d.map(x => x * g);
        let pos;
        if (v.back) {
            const t = norm(v.back.map((x, i) => x - dot(v.back, d) * d[i]));
            pos = norm(d.map((x, i) => x + t[i] * (v.backKm * 1000) / R)).map(x => x * (g + v.altM));
        } else pos = d.map(x => x * (g + v.altM));
        const hint = v.upHint ?? (Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        const up = v.back ? d : norm(hint.map((x, i) => x - dot(hint, d) * d[i]));
        await page.evaluate((P) => window.qtDiag.regional.useCamera(P), {
            position: { x: o[0] + pos[0], y: o[1] + pos[1], z: o[2] + pos[2] },
            target: { x: o[0] + target[0], y: o[1] + target[1], z: o[2] + target[2] },
            up: { x: up[0], y: up[1], z: up[2] }, fov: v.fov ?? 75 });
        await captureView(v);
        if (metricsRid != null) await riverMetrics(v, metricsRid);
        if (v.census) await waterCensus(v);
    }
} catch (e) {
    report.failure = String(e?.stack || e);
    console.log(report.failure);
} finally {
    report.finishedAt = new Date().toISOString();
    save();
    await page.goto('about:blank').catch(() => {});
    await browser.close().catch(() => {});
    server.kill();
}
process.exitCode = report.failure ? 1 : 0;
