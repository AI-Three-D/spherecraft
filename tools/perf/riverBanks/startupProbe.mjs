// Sample normal startup without waiting for water or changing game state.
// Usage: node tools/perf/riverBanks/startupProbe.mjs OUTPUT.json [seconds]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = process.cwd(), output = process.argv[2], seconds = Number(process.argv[3] ?? 25), poseName = process.argv[4], query = process.argv[5] ?? '', early = process.argv[6] === 'early';
const require = createRequire(path.resolve(root, '../terrain-lab/package.json'));
const { default: puppeteer } = await import(require.resolve('puppeteer-core'));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), '8233', root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 600));
    browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
        userDataDir: process.env.RIVER_PROBE_PROFILE ?? '/private/tmp/spherecraft-river-startup-probe', defaultViewport: { width: 1440, height: 900 },
        args: ['--enable-unsafe-webgpu', '--enable-gpu', '--enable-webgpu-developer-features', '--no-first-run', '--no-default-browser-check',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const page = await browser.newPage(), errors = [], warnings = [], samples = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (['warning', 'error'].includes(m.type()) && /\[Water\]|GPU/i.test(m.text())) warnings.push(m.text()); });
    await page.goto('http://127.0.0.1:8233/wizard_game/standalone.html' + query, { waitUntil: 'domcontentloaded', timeout: 180000 });
    if (poseName) {
        await page.waitForFunction(early => window.gameEngine?._initialLoadState && window.qtDiag?.regional?.useCamera && (early || window.gameEngine.getLoadingStatus?.()?.complete), { timeout: 180000 }, early);
        let view;
        if (poseName === 'first-river') {
            await page.waitForFunction(() => window.gameEngine?.waterService?.state === 'ready', { timeout: 180000 });
            await page.evaluate(async () => {
                const { patchRectsMayOverlap } = await import('/core/world/hydrology/patchOverlap.js');
                const s = window.gameEngine.waterService, apply = s._apply;
                s._invalidationProbe = [];
                s._apply = async function (id, rec) {
                    const before = new Map(this.riverRecs), affected = [id, ...(rec.merged ?? [])];
                    const oldFrames = affected.map(lake => this.refined.get(lake)?.frame).filter(Boolean);
                    const result = await apply.call(this, id, rec);
                    for (const [riverId, river] of before) if (!this.riverRecs.has(riverId)) {
                        const anchored = affected.includes(river.src) || (river.dest?.type === 'lake' && affected.includes(river.dest.id));
                        const possible = patchRectsMayOverlap(river.dependencyFrame, rec.frame, this.radius)
                            || oldFrames.some(frame => patchRectsMayOverlap(river.dependencyFrame, frame, this.radius));
                        this._invalidationProbe.push({ lake: id, river: riverId, anchored, possible, tributary: river.dest?.type === 'river' });
                    }
                    return result;
                };
            });
            await page.waitForFunction(() => window.gameEngine?.waterService?.riverRecs?.size > 0, { timeout: 180000 });
            view = await page.evaluate(() => {
                const g = window.gameEngine, rec = g.waterService.riverRecs.values().next().value, P = rec.points, st = rec.stride;
                const k = Math.max(1, Math.min(P.length / st - 2, Math.floor(P.length / st / 2)));
                const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
                const up = norm(Array.from(P.subarray(k * st, k * st + 3)));
                const tangent = norm([0, 1, 2].map(i => P[(k + 1) * st + i] - P[(k - 1) * st + i]));
                const o = g.planetConfig.origin, origin = [o.x, o.y, o.z], radius = g.planetConfig.radius + P[k * st + 3];
                const look = up.map((v, i) => origin[i] + v * radius);
                return { look, pos: look.map((v, i) => v + 80 * up[i] - 100 * tangent[i]) };
            });
        } else if (poseName === 'reported') {
            view = { pos: [-132145.9, -2122.0, 2890.5], look: [-132140.5, -2120.2, 2894.6] };
        } else {
            const views = JSON.parse(fs.readFileSync(path.join(root, 'tools/perf/lakeLook/ownerViews-2026-11-05d.json'), 'utf8')).views;
            view = views.find(v => v.name === poseName);
            if (!view) throw new Error(`Unknown pose ${poseName}`);
        }
        await page.evaluate(v => {
            const vec = a => ({ x: a[0], y: a[1], z: a[2] }), length = Math.hypot(...v.pos);
            window.qtDiag.regional.useCamera({ position: vec(v.pos), target: vec(v.look), up: vec(v.pos.map(x => x / length)), fov: 75 });
        }, view);
    }
    let firstFieldCaptured = false;
    for (let t = 0; t <= seconds; t += 2) {
        if (t) await new Promise(r => setTimeout(r, 2000));
        const sample = await page.evaluate(() => {
            const g = window.gameEngine, s = g?.waterService, f = g?.riverFieldService, load = g?.getLoadingStatus?.();
            const near = f?._lastDir ? f._nearRivers(f._lastDir) : [];
            const regen = g?.renderer?.quadtreeTileManager?.tileStreamer?.getRegenerationStats?.();
            return { at: Math.round(performance.now()), regen, load: load && { phase: load.phase, complete: load.complete, waterPending: load.waterPending,
                elapsed: Math.round(performance.now() - load.startedAt) }, water: s && { state: s.state, busy: s._busy, lakes: s.refined?.size,
                rivers: s.riverRecs?.size, failed: s._failedRivers?.size, precomputed: s.precomputed, precompute: s.config?.refine?.precompute, timings: s.timings, mountain: s.mountainStats, invalidations: s._invalidationProbe }, field: f && { busy: f.busy, idle: f.isIdle, pending: f._pending,
                stage: f.stage, pages: f.pages.size, rivers: f.rivers.size, nearTraced: near.length,
                near: near.map(([id, rec]) => ({ id, lengthM: rec.lengthM, points: rec.points.length / rec.stride,
                    fromLake: s.rivers[id]?.fromLake, to: s.rivers[id]?.to, mountain: !!s.rivers[id]?.mountain })), stats: f.stats } };
        });
        samples.push(sample);
        console.log(JSON.stringify({ at: sample.at, load: sample.load?.phase, lakes: sample.water?.lakes,
            rivers: sample.water?.rivers, field: sample.field?.stage, pages: sample.field?.pages }));
        fs.writeFileSync(output, JSON.stringify({ samples, errors, warnings }, null, 2));
        if (poseName && sample.field?.pages && !firstFieldCaptured) {
            firstFieldCaptured = true;
            await page.screenshot({ path: output.replace(/\.json$/, '-first-field.png') });
            for (let i = 1; i <= 6; i++) {
                await new Promise(r => setTimeout(r, 300));
                await page.screenshot({ path: output.replace(/\.json$/, `-arrival-${i}.png`) });
            }
        }
        if (poseName && (t <= 10 || t % 10 === 0)) await page.screenshot({ path: output.replace(/\.json$/, `-${t}s.png`) });
    }
} finally { await browser?.close(); server.kill(); }
