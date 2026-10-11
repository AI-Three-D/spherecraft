/* global process, Buffer */
// Original (non-regional, terrain-sampled) lakes: inventory, stage timings
// and reproducible captures, in an owned server + headless Chrome.
//
//   node tools/perf/lakeRecovery/originalLakeRun.mjs --out=DIR [--port=8193]
//        [--observeS=150] [--profile=DIR (warm IndexedDB/driver caches)] [--lake=ID]
//
// Writes DIR/report.json, the sampled grid (grid-heights.f32, grid-precip.f32),
// lake cell lists, refined masks and PNG captures. Never reuses a non-empty DIR.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const req = createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : '1']; }));
if (!args.out) throw new Error('--out=DIR required');
const out = path.resolve(args.out);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`evidence directory not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });
const port = Number(args.port ?? 8193);
const query = args.query ?? 'regionalTerrain=0&regionalBanks=legacy&riverSim=off';
const observeS = Number(args.observeS ?? 150);
const url = `http://127.0.0.1:${port}/wizard_game/standalone.html?${query}`;
const SPAWN = [-1, 0, 0];

const report = { url, startedAt: new Date().toISOString(), args, notes: [], captures: [], errors: [], console: [] };
// Puppeteer can reject after the report is written (browser teardown); keep it visible but not fatal.
process.on('unhandledRejection', (e) => { console.log('unhandled rejection:', String(e?.stack || e).slice(0, 300)); report.unhandled = (report.unhandled ?? 0) + 1; });
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));

// Source hashes of what is served (measurement discipline: served-source identity).
function hashTree(rel) {
    const abs = path.join(root, rel), h = {};
    const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const q = path.join(p, e.name);
            if (e.isDirectory()) walk(q);
            else if (/\.(js|json|html)$/.test(e.name) && !/\.test\.js$/.test(e.name)) h[path.relative(root, q)] = crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex').slice(0, 16);
        }
    };
    if (fs.statSync(abs).isDirectory()) walk(abs); else h[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
    return h;
}
report.sources = Object.assign({}, ...['core/world/hydrology', 'core/world/water', 'core/world/webgpuTerrainGenerator.js', 'core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js',
    'templates/terrain-shaders', 'wizard_game/standalone.html', 'wizard_game/gameEngine.js', 'wizard_game/runtimeConfigs.js', 'wizard_game/world'].map(hashTree));

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
// Crash diagnostics: renderer crash, disconnect, and the RSS of every browser
// process (renderer, GPU, ...) sampled every second.
page.on('error', e => { report.crash = { t: Date.now(), error: String(e) }; console.log('PAGE CRASH', String(e)); });
browser.on('disconnected', () => { report.disconnectedAt = Date.now(); });
report.memory = [];
const rootPid = browser.process()?.pid;
const { execSync } = await import('node:child_process');
const memTimer = setInterval(() => {
    try {
        const rows = execSync('ps -axo pid=,ppid=,rss=,command=', { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/));
        const kids = new Set([rootPid]);
        for (let changed = true; changed;) { changed = false; for (const r of rows) if (kids.has(+r[1]) && !kids.has(+r[0])) { kids.add(+r[0]); changed = true; } }
        const procs = rows.filter(r => kids.has(+r[0])).map(r => ({ pid: +r[0], rssMB: Math.round(+r[2] / 1024), type: r.slice(3).join(' ').match(/--type=([a-z-]+)/)?.[1] ?? 'browser' }));
        report.memory.push({ t: Date.now(), totalMB: procs.reduce((a, p) => a + p.rssMB, 0), procs });
    } catch { /* sampling is best effort */ }
}, 1000);
page.on('console', m => { const t = m.text(); if (/^\[(Water|GameEngine|Standalone)\]|rror|WARN/.test(t)) report.console.push(t.slice(0, 400)); });
await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/lakeRecovery/pageInstrument.js'), 'utf8'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pnow = () => page.evaluate(() => performance.now());
const writeB64 = (name, b64) => { if (b64) fs.writeFileSync(path.join(out, name), Buffer.from(b64, 'base64')); };

// Waits for an empty generation queue with every visible tile exact.
async function settle(label, capMs = 90000) {
    const t0 = Date.now();
    let streak = 0, last = null;
    while (Date.now() - t0 < capMs) {
        last = await page.evaluate(() => ({ ...window.__lr.residency(),
            regenPending: window.gameEngine?.renderer?.quadtreeTileManager?.tileStreamer?.getRegenerationStats?.()?.pending ?? 0 }));
        const idle = last && last.pendingGenerations === 0 && last.activeGenerations === 0 && last.pendingCopies === 0 && last.exactVisibleRatio >= 0.999 && last.visibleTiles > 0 && last.regenPending === 0;
        streak = idle ? streak + 1 : 0;
        if (streak >= 8) return { label, settled: true, ms: Date.now() - t0, residency: last };
        await sleep(150);
    }
    return { label, settled: false, ms: Date.now() - t0, residency: last };
}

async function capture(name, { tint = 0, hideUi = true } = {}) {
    await page.evaluate((tint) => window.qtDiag.water.tint(tint), tint);
    if (hideUi) await page.addStyleTag({ content: 'body > *:not(#gameCanvas){visibility:hidden !important}' }).catch(() => {});
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(out, file) });
    const meta = await page.evaluate(() => ({ t: performance.now(), pose: window.__lr.pose(), residency: window.__lr.residency(), water: window.gameEngine.waterService.summary() }));
    if (tint) await page.evaluate(() => window.qtDiag.water.tint(0));
    report.captures.push({ name, file, tint, ...meta });
    save();
}

// Camera pose helpers (planet centred at origin; see report.origin).
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const tangentToward = (c, d) => { const t = add(d, c, -dot(d, c)); return Math.hypot(...t) > 1e-9 ? norm(t) : null; };
async function usePose(pose) {
    const o = report.origin;
    const P = { position: { x: o.x + pose.position[0], y: o.y + pose.position[1], z: o.z + pose.position[2] },
        target: { x: o.x + pose.target[0], y: o.y + pose.target[1], z: o.z + pose.target[2] },
        up: { x: pose.up[0], y: pose.up[1], z: pose.up[2] }, fov: pose.fov ?? report.fov };
    return page.evaluate((P) => window.qtDiag.regional.useCamera(P), P);
}

try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    report.timeOrigin = await page.evaluate(() => performance.timeOrigin);   // page ms = Date.now() - timeOrigin
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 300000, polling: 100 });
    report.loaderCompleteMs = await pnow();
    report.loading = await page.evaluate(() => window.gameEngine.getLoadingStatus());
    report.configuration = await page.evaluate(() => {
        const g = window.gameEngine, tg = g.planetConfig.terrainGeneration;
        return { regionalActive: !!g.terrainGenerator?.regionalTerrainActive, regional: tg.regionalTerrain ?? null, waterGraph: tg.waterGraph,
            radius: g.planetConfig.radius, origin: g.planetConfig.origin ?? { x: 0, y: 0, z: 0 }, fov: g.camera?.fov, seed: g.planetConfig.seed ?? null };
    });
    report.origin = report.configuration.origin; report.fov = report.configuration.fov;
    if (report.configuration.regionalActive) throw new Error('regional placement is active; not the original path');
    save();

    await page.waitForFunction(() => ['ready', 'failed'].includes(window.gameEngine?.waterService?.state), { timeout: 400000, polling: 50 });
    const lr = await page.evaluate(() => ({ states: window.__lr.states, serviceCreatedAt: window.__lr.serviceCreatedAt, samplerReadyAt: window.__lr.samplerReadyAt, compiles: window.__lr.compiles }));
    Object.assign(report, { waterStates: lr.states, serviceCreatedAt: lr.serviceCreatedAt, samplerReadyAt: lr.samplerReadyAt });

    // Inventory and the exact sampled grid (from the service's own cache entry).
    const inv = await page.evaluate(async () => {
        const s = window.gameEngine.waterService, LR = window.__lr;
        let grid = null;
        for (let k = 0; k < 50 && !grid; k++) { grid = await s._cache.get('grid:' + s._key).catch(() => null); if (!grid) await new Promise(r => setTimeout(r, 100)); }
        return {
            key: s._key, N: s.N, radius: s.radius, config: s.config, stats: s.stats, timings: s.timings, seaLevelM: grid?.seaLevelM ?? null,
            lakes: s.lakes, rivers: s.rivers.map(r => ({ id: r.id, fromLake: r.fromLake, to: r.to, cells: Array.from(r.cells) })),
            lakeCells: LR.b64(s.lakeCells), lakeCellStart: LR.b64(s.lakeCellStart),
            heights: LR.b64(grid?.heights ?? s.gridHeights), precip: grid?.precip ? LR.b64(grid.precip) : null,
        };
    });
    for (const [k, f] of [['heights', 'grid-heights.f32'], ['precip', 'grid-precip.f32'], ['lakeCells', 'lake-cells.i32'], ['lakeCellStart', 'lake-cell-start.i32']]) { writeB64(f, inv[k]); delete inv[k]; }
    fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(inv));
    report.water = { key: inv.key, N: inv.N, stats: inv.stats, timings: inv.timings, seaLevelM: inv.seaLevelM, lakes: inv.lakes.length, rivers: inv.rivers.length };
    report.waterReadyMs = report.waterStates.find(s => s.state === 'ready')?.t ?? null;
    save();

    // Lakes near the spawn: coarse area from the grid cells (solid angle), extent from the frame centre.
    const N = inv.N, R = inv.radius;
    // Node pools small Buffers: view them at their own offset.
    const readI32 = (f) => { const b = fs.readFileSync(path.join(out, f)); return new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
    const lakeCells = readI32('lake-cells.i32'), lakeCellStart = readI32('lake-cell-start.i32');
    const faceDir = (f, u, v) => { const x = u * 2 - 1, y = v * 2 - 1; const c = [[1, y, -x], [-1, y, x], [x, 1, -y], [x, -1, y], [x, y, 1], [-x, y, -1]][f]; return norm(c); };
    const cellDir = (id) => { const f = Math.floor(id / (N * N)), k = id - f * N * N; return faceDir(f, ((k % N) + 0.5) / N, (Math.floor(k / N) + 0.5) / N); };
    const cellArea = (id) => { const k = id % (N * N), x = (((k % N) + 0.5) / N) * 2 - 1, y = ((Math.floor(k / N) + 0.5) / N) * 2 - 1; return (2 / N) ** 2 * Math.pow(1 + x * x + y * y, -1.5) * R * R; };
    const lakeInfo = inv.lakes.map(l => {
        const cells = lakeCells.subarray(lakeCellStart[l.id], lakeCellStart[l.id + 1]);
        let area = 0, ext = 0;
        for (const c of cells) { area += cellArea(c); ext = Math.max(ext, Math.acos(Math.min(1, dot(cellDir(c), l.frame.c))) * R); }
        return { id: l.id, cellCount: l.cellCount, coarseAreaKm2: area / 1e6, extentM: ext, level: l.level, maxDepth: l.maxDepth, river: l.river,
            spawnDistKm: Math.acos(Math.min(1, dot(l.frame.c, SPAWN))) * R / 1000 };
    });
    report.largestCoarse = lakeInfo.slice().sort((a, b) => b.coarseAreaKm2 - a.coarseAreaKm2).slice(0, 25);
    report.nearSpawn = lakeInfo.filter(l => l.spawnDistKm < 60).sort((a, b) => a.spawnDistKm - b.spawnDistKm);
    const primary = args.lake !== undefined ? lakeInfo[Number(args.lake)] : lakeInfo.filter(l => l.spawnDistKm < 35).sort((a, b) => b.coarseAreaKm2 - a.coarseAreaKm2)[0];
    report.primary = primary;
    save();
    console.log(JSON.stringify({ loaderCompleteMs: report.loaderCompleteMs, waterReadyMs: report.waterReadyMs, lakes: inv.lakes.length, primary }));

    // Owner-like view: 4.1 km above the lake level, backed off toward the spawn.
    const lake = inv.lakes[primary.id], c = lake.frame.c;
    const back = tangentToward(c, SPAWN) ?? lake.frame.e1;
    const groundAt = (d, h) => scale(norm(d), R + h);
    const offsetDir = (dist) => norm(add(c, back, dist / R));
    report.poses = {
        close: { position: groundAt(offsetDir(primary.extentM + 4000), lake.level + 4095), target: groundAt(c, lake.level), up: c },
        broad: { position: groundAt(offsetDir(primary.extentM + 30000), lake.level + 24000), target: groundAt(c, lake.level), up: c },
        top: { position: groundAt(c, lake.level + Math.max(6000, 2.3 * primary.extentM)), target: groundAt(c, lake.level), up: lake.frame.e2 },
    };
    // --posesFrom=REPORT: the same camera poses as an earlier run (matched A/B).
    if (args.posesFrom) {
        const prev = JSON.parse(fs.readFileSync(path.resolve(args.posesFrom), 'utf8'));
        for (const k of ['close', 'broad', 'top']) if (prev.poses?.[k]) report.poses[k] = prev.poses[k];
        report.posesFrom = args.posesFrom;
    }
    // Weather held clear (measurement control: the cycle changes haze between runs).
    report.weather = await page.evaluate(() => { const w = window.gameEngine.renderer?.weatherController;
        if (!w) return null; w._pickNewWeatherTarget = () => {}; return w.setWeather('clear', true); });
    report.daylight = await page.evaluate((c) => window.__lr.daylightAt(c, 0.75), c);
    await usePose(report.poses.close);
    report.settleClose0 = await settle('close-0');
    await capture('close-at-water-ready');
    await capture('close-at-water-ready-tint1', { tint: 1 });

    // Watch the service work from this pose (nearest-first, one job at a time).
    const tObs = Date.now();
    let primaryRefinedAt = null;
    while (Date.now() - tObs < observeS * 1000) {
        const st = await page.evaluate((id) => { const s = window.gameEngine.waterService; return { refined: s.refined.has(id), failed: s._failed.has(id), rep: s.rep(id) }; }, primary.id);
        const pc = await page.evaluate(() => !!window.gameEngine.waterService.precomputed);
        if (pc && !report.precomputedAt) report.precomputedAt = await pnow();
        if (!primaryRefinedAt && (st.refined || st.failed || st.rep !== primary.id)) {
            primaryRefinedAt = await pnow();
            report.primaryResolution = { ...st, t: primaryRefinedAt };
            report.settlePrimary = await settle('close-primary');
            await capture('close-after-primary-refine');
            await capture('close-after-primary-refine-tint1', { tint: 1 });
        }
        await sleep(1000);
    }
    report.settleEnd = await settle('close-end');
    await capture('close-end');
    report.precompute = await page.evaluate(() => { const s = window.gameEngine.waterService, g = window.gameEngine.waterGpuData;
        return { precomputed: !!s.precomputed, timings: s.timings, maskBytes: g?.maskBytes ?? null, slots: g?._slots?.length ?? null,
            slotsUsed: g?._layerOf?.size ?? null, slotClasses: g?._slots ? Object.entries(g._slots.reduce((m, sl, i) => { const k = sl.size; m[k] ??= [0, 0]; m[k][0]++; if (g._layerOwner[i] !== -1) m[k][1]++; return m; }, {})) : null }; });

    // Close views of further lakes (same construction as the primary's).
    for (const id of String(args.extraLakes ?? '').split(',').filter(Boolean).map(Number)) {
        const l = lakeInfo[id], lk = inv.lakes[id], cc = lk.frame.c, bk = tangentToward(cc, SPAWN) ?? lk.frame.e1;
        const pose = { position: groundAt(norm(add(cc, bk, (l.extentM + 4000) / R)), lk.level + 4095), target: groundAt(cc, lk.level), up: cc };
        report.poses[`close-${id}`] = pose;
        await usePose(pose);
        report[`settle_close_${id}`] = await settle(`close-${id}`);
        await capture(`close-lake-${id}`);
        await capture(`close-lake-${id}-tint1`, { tint: 1 });
    }

    // River views: --riverViews=ids --riverAlts=m,m. Each altitude is captured
    // with mesh-only river water (old), profile coverage with the opaque body
    // colour, and profile coverage seeing the bed through the water.
    report.rivers = [];
    for (const rid of String(args.riverViews ?? '').split(',').filter(Boolean).map(Number)) {
        const ready = await page.evaluate(async (rid) => {
            const g = window.gameEngine, s = g.waterService;
            for (let i = 0; i < 1200; i++) {
                if (s.riverRecs.has(rid) && g.waterGpuData?.isRiverDrawn(rid)) return true;
                if (i % 50 === 49 && !s._busy && !s.riverRecs.has(rid)) s.refineRiver(rid);
                await new Promise(r => setTimeout(r, 100));
            }
            return false;
        }, rid);
        const info = await page.evaluate((rid) => {
            const rec = window.gameEngine.waterService.riverRecs.get(rid);
            if (!rec) return null;
            const P = rec.points, st = rec.stride, n = P.length / st, k = Math.round(0.45 * (n - 1));
            const at = (q) => [P[q * st], P[q * st + 1], P[q * st + 2]];
            const a = at(Math.max(0, k - 5)), b = at(Math.min(n - 1, k + 5));
            return { n, lengthM: rec.lengthM, dir: at(k), eta: P[k * st + 3], hw: P[k * st + 4], flow: [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dest: rec.dest, src: rec.src };
        }, rid);
        const entry = { id: rid, ready, info, views: [] };
        report.rivers.push(entry);
        if (!info) continue;
        const flowT = tangentToward(info.dir, add(info.dir, info.flow)) ?? [1, 0, 0];
        for (const alt of String(args.riverAlts ?? '1000,3000,8000').split(',').map(Number)) {
            const pose = { position: groundAt(norm(add(info.dir, flowT, -alt / R)), info.eta + alt), target: groundAt(info.dir, info.eta), up: info.dir };
            report.poses[`river-${rid}-${alt}`] = pose;
            await usePose(pose);
            const st = await settle(`river-${rid}-${alt}`);
            entry.views.push({ alt, settle: st.settled, ms: st.ms });
            for (const [variant, surface, body] of [['mesh', false, true], ['surface-body', true, true], ['surface-bed', true, false]]) {
                await page.evaluate((surface, body) => Object.assign(window.gameEngine.waterGpuData.look,
                    { structuredRiverSurface: surface, structuredRiverBody: body }), surface, body);
                await capture(`river-${rid}-${alt}-${variant}`);
                await capture(`river-${rid}-${alt}-${variant}-tint1`, { tint: 1 });
            }
            await page.evaluate(() => Object.assign(window.gameEngine.waterGpuData.look, { structuredRiverSurface: true, structuredRiverBody: true }));
        }
    }

    for (const v of ['broad', 'top']) {
        await usePose(report.poses[v]);
        report[`settle_${v}`] = await settle(v);
        await capture(v);
        await capture(`${v}-tint1`, { tint: 1 });
        await capture(`${v}-tint3`, { tint: 3 });
    }

    // Refined records (masks: 2 water, 1 shore band) for offline area/topology analysis.
    const refined = await page.evaluate(() => {
        const s = window.gameEngine.waterService, LR = window.__lr, outR = [];
        for (const [id, r] of s.refined) outR.push({ id, level: r.level, graphLevel: s.lakes[id].level, areaM2: r.areaM2, cells: r.cells, maxDepth: r.maxDepth,
            frame: r.frame, merged: r.merged, downstream: r.downstream, ms: r.ms, mask: LR.b64(r.mask) });
        return outR;
    });
    fs.mkdirSync(path.join(out, 'refined'), { recursive: true });
    for (const r of refined) { writeB64(`refined/lake-${r.id}.u8`, r.mask); delete r.mask; }
    report.refined = refined;
    const lrEnd = await page.evaluate(() => { const L = window.__lr; return { events: L.events, compiles: L.compiles, summaries: L.summaries, regen: L.regen, gpuErrors: L.gpuErrors,
        frames: L.frames.slice(-6000), riverRecs: [...window.gameEngine.waterService.riverRecs.entries()].map(([id, r]) => ({ id, lengthM: r.lengthM, dest: r.dest, src: r.src, ms: r.ms })) }; });
    Object.assign(report, lrEnd);
    report.finalSummary = await page.evaluate(() => window.gameEngine.waterService.summary());
    // Origin storage (IndexedDB water cache: grid, lake and river records).
    report.storage = await page.evaluate(async () => { try { const e = await navigator.storage.estimate(); return { usageMB: e.usage / 1048576, details: e.usageDetails ?? null }; } catch (e) { return { error: String(e) }; } });
} catch (e) {
    report.failure = String(e?.stack || e);
    console.log(report.failure);
    report.last = await page.evaluate(() => ({ loading: window.gameEngine?.getLoadingStatus?.(), water: window.gameEngine?.waterService?.summary?.(), lr: window.__lr && { states: window.__lr.states, events: window.__lr.events, gpuErrors: window.__lr.gpuErrors } })).catch(() => null);
} finally {
    clearInterval(memTimer);
    report.finishedAt = new Date().toISOString();
    save();
    await page.goto('about:blank').catch(() => {});
    await browser.close().catch(() => {});
    server.kill();
}
process.exitCode = report.failure || report.errors.length ? 1 : 0;
