// Screenshots of the game (?lakeCells=1) at one camera pose, headless in the
// system Chrome (the bundled one cannot render SphereCraft): normal, the
// tiles' geometry LOD (terrain debug 90) and who draws the water (water
// debug 6). Waits for the rivers near the pose to be planned and baked and
// the tile queue to empty. Ask the owner before running (their GPU).
//   node tools/perf/lakeCells/poseShots.mjs OUT_PREFIX "px,py,pz" "lx,ly,lz" "ux,uy,uz"   (from spherecraft/)
import puppeteer from '../../../../terrain-lab/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

//   node tools/perf/lakeCells/poseShots.mjs OUT_PREFIX river:INDEX[:FRACTION:ALTITUDE:BACK]
//   node tools/perf/lakeCells/poseShots.mjs OUT_PREFIX rapid[:ALTITUDE:BACK]
// A published lake-cell river (qtDiag.regional.river), or the first with a
// rapid seen at the rapid's middle; the pose is printed for later runs.
const [prefix, posS, lookS, upS] = process.argv.slice(2);
const vec = s => s.split(',').map(Number);
const site = /^(river|rapid)/.test(posS) ? posS.split(':') : null;
let pose = site ? null : { position: vec(posS), target: vec(lookS), up: vec(upS) };
const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('[page error]', e.message));
try {
    await page.goto('http://localhost:8000/wizard_game/standalone.html?lakeCells=1', { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.state === 'ready' && window.qtDiag?.regional, { timeout: 180000, polling: 1000 });
    await page.evaluate(async () => { (await import('/shared/Logger.js')).Logger.setLevel(2); });
    if (site) {
        await page.waitForFunction(() => (window.gameEngine.waterService?.riverRecs?.size ?? 0) > 0 && !window.gameEngine.waterService._lakeCells?.planning,
            { timeout: 240000, polling: 1000 });
        pose = await page.evaluate((a) => {
            const recs = [...window.gameEngine.waterService.riverRecs.values()], R = window.qtDiag.regional;
            const num = (s, d) => (s == null || s === '' ? d : Number(s));
            let index, fraction, alt, back;
            if (a[0] === 'rapid') {
                index = recs.findIndex(r => r.rapid);
                if (index < 0) throw new Error('No river with a rapid is published');
                const r = recs[index];
                fraction = (r.rapid.startM + r.rapid.lengthM / 2) / r.lengthM; alt = num(a[1], 120); back = num(a[2], 250);
            } else {
                index = num(a[1], 0); fraction = num(a[2], 0.5); alt = num(a[3], 150); back = num(a[4], 300);
            }
            R.river(fraction, alt, back, index);
            const c = R.camera(), arr = v => [v.x, v.y, v.z];
            return { position: arr(c.position), target: arr(c.target), up: arr(c.up), why: `river ${index} of ${recs.length} at ${fraction.toFixed(2)}` };
        }, site);
        const f = v => v.map(x => x.toFixed(1)).join(',');
        console.log(`[shots] ${pose.why}: "${f(pose.position)}" "${f(pose.target)}" "${pose.up.map(x => x.toFixed(4)).join(',')}"`);
    }
    await page.evaluate((p) => {
        const set = () => {
            const c = window.qtDiag.regional.camera();
            const xyz = a => ({ x: a[0], y: a[1], z: a[2] });
            window.qtDiag.regional.useCamera({ position: xyz(p.position), target: xyz(p.target), up: xyz(p.up), fov: c.fov });
        };
        set();
        window.__holdPose = setInterval(set, 500);
        window.gameEngine.setDayNightFrozen?.(true);
        // Daylight at the pose, the same in every run (as qtDiag.regional.daylight
        // does at the basin): the planet turned so the sun stands at about
        // 50 degrees there; the star system paused.
        const s = window.gameEngine.starSystem, body = s?.currentBody;
        if (body) {
            s.paused = true; s.useGameTimeRotation = false;
            const o = window.gameEngine.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
            const c = [p.position[0] - o.x, p.position[1] - o.y, p.position[2] - o.z], n = Math.hypot(...c);
            let best = Infinity, rotation = 0;
            for (let i = 0; i < 720; i++) {
                body.currentRotation = i * Math.PI * 2 / 720;
                const d = body.getStarDirection(s.primaryStar).direction;
                const score = Math.abs((d.x * c[0] + d.y * c[1] + d.z * c[2]) / n - 0.75);
                if (score < best) { best = score; rotation = body.currentRotation; }
            }
            body.currentRotation = rotation;
        }
    }, pose);
    // Rivers near the pose planned and baked, tiles settled.
    const t0 = Date.now();
    let state = null;
    for (;;) {
        state = await page.evaluate(() => {
            const g = window.gameEngine, L = g.waterService?._lakeCells, f = g.riverFieldService, st = g.renderer?.quadtreeTileManager?.tileStreamer;
            return { planning: L?.planning, known: L?.known.size, plannedKnown: L?.plannedKnown, rivers: g.waterService?.riverRecs?.size ?? 0,
                fieldBusy: f?.busy, fieldRivers: f?.rivers?.size ?? 0, queue: st?.queue?.pendingCount ?? st?._queue?.length ?? null };
        });
        const settled = !state.planning && state.plannedKnown === state.known && !state.fieldBusy && state.fieldRivers > 0;
        if (settled && Date.now() - t0 > 20000) break;
        if (Date.now() - t0 > 240000) { console.log('[shots] not settled after 240 s', JSON.stringify(state)); break; }
        await new Promise(r => setTimeout(r, 2000));
    }
    await new Promise(r => setTimeout(r, 8000));
    // LAKE_SHOTS_EVAL: a console line run once settled (e.g. a terrain feature
    // off: qtDiag.setTerrainFeatures({ waterCarve: false })), then time for
    // the tiles to regenerate.
    if (process.env.LAKE_SHOTS_EVAL) {
        console.log('[shots] eval', JSON.stringify(await page.evaluate(async src => { try { return String(await (0, eval)(src)); } catch (e) { return `error: ${e.message}`; } }, process.env.LAKE_SHOTS_EVAL)).slice(0, 300));
        await new Promise(r => setTimeout(r, 20000));
    }
    console.log('[shots] state', JSON.stringify(state), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
    // The near simulation (WhitewaterSim): stepped blocks, fills, steps, rocks, and what it draws.
    console.log('[shots] whitewater', await page.evaluate(() => {
        const w = window.gameEngine.whitewater;
        return JSON.stringify(w ? { ...w.summary(), draw: w.drawCount, rocksDrawn: w.rocksToDraw, spray: w.sprayToDraw, camH: w._camH } : null);
    }));
    // The river field's bakes so far: rivers, pages, ms (total, main thread, worker).
    console.log('[shots] bakes', await page.evaluate(() => JSON.stringify((window.gameEngine.riverFieldService?.history ?? [])
        .map(h => ({ rivers: h.rivers, pages: h.pages, total: Math.round(h.total), main: Math.round(h.main), finish: Math.round(h.finish ?? 0), sample: Math.round(h.sample) })))));
    // The visible tiles: depth and geometry LOD, and the segments per LOD (vertex spacing).
    console.log('[shots] tiles', await page.evaluate(() => {
        const g = window.gameEngine, st = g.renderer?.quadtreeTileManager?.tileStreamer, qt = g.renderer?.quadtreeTileManager;
        const list = st?._lastVisibleTilesList ?? [], R = g.planetConfig.radius, hist = {};
        for (const t of list) { const k = `d${t.depth ?? t.level}/g${t.lod ?? t.geomLOD ?? '?'}`; hist[k] = (hist[k] ?? 0) + 1; }
        const segs = qt?.gpuQuadtree?._diagLodSegments ?? qt?._diagLodSegments ?? g.renderer?.quadtreeTerrainRenderer?.gpuQuadtree?._diagLodSegments ?? null;
        return JSON.stringify({ n: list.length, sample: list[0], hist, segs, faceM: Math.PI / 2 * R });
    }));
    await page.screenshot({ path: `${prefix}-normal.png` });
    // LAKE_SHOTS_PAIR: a second frame LAKE_SHOTS_PAIR ms later (flicker: diff the two).
    if (process.env.LAKE_SHOTS_PAIR) {
        await new Promise(r => setTimeout(r, +process.env.LAKE_SHOTS_PAIR));
        await page.screenshot({ path: `${prefix}-normal2.png` });
    }
    await page.evaluate(() => window.gameEngine.setTerrainDebugMode(90));
    await new Promise(r => setTimeout(r, 2500));
    await page.screenshot({ path: `${prefix}-lod90.png` });
    await page.evaluate(() => { window.gameEngine.setTerrainDebugMode(0); window.gameEngine.setWaterDebugMode?.(6); });
    await new Promise(r => setTimeout(r, 2500));
    await page.screenshot({ path: `${prefix}-water6.png` });
    // LAKE_SHOTS_AFTER: a console line awaited after the shots (a probe), printed.
    if (process.env.LAKE_SHOTS_AFTER) {
        await page.evaluate(() => window.gameEngine.setWaterDebugMode?.(0));
        console.log('[shots] after', await page.evaluate(async src => { try { return String(await (0, eval)(src)); } catch (e) { return `error: ${e.message}`; } }, process.env.LAKE_SHOTS_AFTER));
    }
} finally {
    await page.goto('about:blank').catch(() => {});
    await browser.close();
}
