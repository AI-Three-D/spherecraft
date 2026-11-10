/* global process */
// Captures listed camera views of the water (owned server + headless Chrome,
// warm profile), each settled, with water tints and terrain debug modes.
//
//   node tools/perf/lakeRecovery/waterViews.mjs --out=DIR --views=FILE.json
//        [--port=8193] [--profile=DIR] [--query=...]
//
// Views: [{ name, dir: [x, y, z] (ground point), groundM, altM, back: [x, y, z]
// (tangent the camera steps back along, km in backKm; omitted: straight
// down), upHint, tints: [0, 3], terrain: [10], eval: "js returning JSON" }].
// Writes DIR/report.json and DIR/<name>[-tintN|-dbgN].png. Never reuses a
// non-empty DIR.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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
    // variants: [{ name, set: "js", reset: "js" }] captured after the tints.
    for (const x of v.variants ?? []) {
        await page.evaluate(x.set);
        await sleep(300);
        await shot(`${v.name}-${x.name}`);
        await page.evaluate(x.reset);
    }
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
        // { river: id, frac, altM, backM }: behind a traced river's point at
        // arc fraction frac (solved first if needed), looking along its flow.
        if (v.river != null) {
            const P = await page.evaluate(async ({ rid, frac }) => {
                const s = window.gameEngine.waterService;
                for (let i = 0; i < 600 && !s.riverRecs.has(rid); i++) {
                    if (i % 50 === 0 && !s._busy) s.refineRiver(rid);
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
