// Does the near simulation keep the river's water in its channel? (owner 2026-11-10:
// water over the banks, pits in the river's surface.) At each pose, headless in the
// system Chrome, ?lakeCells=1: screenshots with the solver on and off, wwContain
// (spill, level against the baked W, volume, a top-down map), the level along the
// nearest river (wwAlong), and a cold start of every block sampled over time.
// Ask the owner before running (their GPU).
//   node tools/perf/whitewater/containment.mjs OUT_PREFIX POSES.json   (from spherecraft/)
// POSES.json: [{ "name", "position": [x,y,z], "target": [x,y,z], "up": [x,y,z] }, ...]
// CONTAIN_EVAL: a console line run once settled, before the shots (an A/B arm).
import fs from 'node:fs';
import puppeteer from '../../../../terrain-lab/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const [prefix, posesPath] = process.argv.slice(2);
const poses = JSON.parse(fs.readFileSync(posesPath, 'utf8'));
const coldS = (process.env.CONTAIN_COLD ?? '2,5,10,20,40').split(',').filter(Boolean).map(Number);
const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('[page error]', e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = (name, arg) => page.evaluate(async (n, a) => (await import('/tools/perf/whitewater/wwProbe.js'))[n](a), name, arg);
const saveMap = (r, path) => {
    if (!r?.map) return r;
    fs.writeFileSync(path, Buffer.from(r.map.url.split(',')[1], 'base64'));
    return { ...r, map: { file: path, originM: r.map.originM, size: r.map.size } };
};
try {
    // CONTAIN_URL: the page (127.0.0.1, not localhost: another checkout's server may answer on ::1).
    await page.goto(process.env.CONTAIN_URL ?? 'http://127.0.0.1:8000/wizard_game/standalone.html?lakeCells=1', { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.state === 'ready' && window.qtDiag?.regional, { timeout: 180000, polling: 1000 });
    await page.evaluate(async () => { (await import('/shared/Logger.js')).Logger.setLevel(2); });
    for (const pose of poses) {
        const tag = `${prefix}-${pose.name}`;
        await page.evaluate((p) => {
            clearInterval(window.__holdPose);
            const set = () => {
                const c = window.qtDiag.regional.camera(), xyz = a => ({ x: a[0], y: a[1], z: a[2] });
                window.qtDiag.regional.useCamera({ position: xyz(p.position), target: xyz(p.target), up: xyz(p.up), fov: c.fov });
            };
            set();
            window.__holdPose = setInterval(set, 500);
            window.gameEngine.setDayNightFrozen?.(true);
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
        const t0 = Date.now();
        let state = null;
        for (;;) {
            state = await page.evaluate(() => {
                const g = window.gameEngine, L = g.waterService?._lakeCells, f = g.riverFieldService;
                return { planning: L?.planning, known: L?.known.size, plannedKnown: L?.plannedKnown, rivers: g.waterService?.riverRecs?.size ?? 0,
                    fieldBusy: f?.busy, fieldRivers: f?.rivers?.size ?? 0, active: g.whitewater?.activeCount ?? 0 };
            });
            const settled = !state.planning && state.plannedKnown === state.known && !state.fieldBusy && state.fieldRivers > 0 && state.active > 0;
            if (settled && Date.now() - t0 > 20000) break;
            if (Date.now() - t0 > 240000) { console.log(`[contain] ${pose.name}: not settled after 240 s`, JSON.stringify(state)); break; }
            await sleep(2000);
        }
        if (process.env.CONTAIN_EVAL) {
            console.log('[contain] eval', JSON.stringify(await page.evaluate(async src => { try { return String(await (0, eval)(src)); } catch (e) { return `error: ${e.message}`; } }, process.env.CONTAIN_EVAL)).slice(0, 300));
            await sleep(5000);
        }
        await sleep(10000);
        // CONTAIN_PROBE: a file of page code (an async function body, given the pose) whose result
        // is printed in full; with CONTAIN_ONLY_PROBE the rest of the pose is skipped.
        if (process.env.CONTAIN_PROBE) {
            const body = fs.readFileSync(process.env.CONTAIN_PROBE, 'utf8');
            console.log(`[contain] ${pose.name} probe`, await page.evaluate(async (src, p) => { try { return JSON.stringify(await (new Function('pose', `return (async () => { ${src} })()`))(p)); } catch (e) { return `error: ${e.stack}`; } }, body, pose));
            if (process.env.CONTAIN_ONLY_PROBE) continue;
        }
        // CONTAIN_SHOTS_ONLY: after the probe, the shots with the solver on and off only (a tree without wwContain).
        if (process.env.CONTAIN_SHOTS_ONLY) {
            console.log(`[contain] ${pose.name} state`, JSON.stringify(state));
            await page.screenshot({ path: `${tag}-on.png` });
            await page.evaluate(() => window.gameEngine.setWhitewater?.(false));
            await sleep(3000);
            await page.screenshot({ path: `${tag}-off.png` });
            await page.evaluate(() => window.gameEngine.setWhitewater?.(true));
            await sleep(2000);
            continue;
        }
        console.log(`[contain] ${pose.name} state`, JSON.stringify(state), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
        console.log(`[contain] ${pose.name} whitewater`, JSON.stringify(await probe('wwStatus', {})));
        await page.screenshot({ path: `${tag}-on.png` });
        console.log(`[contain] ${pose.name} settled`, JSON.stringify(saveMap(await probe('wwContain', { map: true }), `${tag}-map.png`)));
        // The level along the nearest river, downstream first-to-last: W must never rise.
        const river = await page.evaluate(() => {
            const g = window.gameEngine, s = g.waterService, c = g.camera.position, l = Math.hypot(c.x, c.y, c.z), cd = [c.x / l, c.y / l, c.z / l];
            let best = null;
            for (const [id, rec] of s.riverRecs) {
                const P = rec.points, st = rec.stride;
                for (let k = 0; k < P.length / st; k++) {
                    const dot = P[k * st] * cd[0] + P[k * st + 1] * cd[1] + P[k * st + 2] * cd[2];
                    if (!best || dot > best.dot) best = { id, dot, k, n: P.length / st };
                }
            }
            return best && { id: best.id, k: best.k, n: best.n, distM: Math.round(Math.acos(Math.min(1, best.dot)) * g.planetConfig.radius) };
        });
        console.log(`[contain] ${pose.name} river`, JSON.stringify(river));
        if (river) {
            const along = await probe('wwAlong', { river: river.id, stepM: 4, rangeM: 170, half: 3 });
            let rises = 0, worst = 0;
            for (let i = 1; i < along.length; i++) {
                const e0 = along[i - 1].W + along[i - 1].dev / 100, e1 = along[i].W + along[i].dev / 100;
                if (e1 > e0 + 0.02) { rises++; worst = Math.max(worst, e1 - e0); }
            }
            console.log(`[contain] ${pose.name} along (s m, dev cm, v, vb, h, hb, W): rises ${rises}, worst ${worst.toFixed(2)} m`);
            console.log(along.map(a => `${a.s},${a.dev},${a.v},${a.vb},${a.h},${a.hb},${a.W}`).join(' | '));
        }
        // Cold start: every block refills from the baked state; spill and volume over time.
        // CONTAIN_ARMS: [{ "name", "eval" }, ...], each run in turn before its own cold start
        // (an arm sets every switch it compares, so arms do not carry over).
        const arms = process.env.CONTAIN_ARMS ? JSON.parse(process.env.CONTAIN_ARMS) : [{ name: 'base', eval: '' }];
        for (const arm of arms) {
            if (arm.eval) console.log(`[contain] ${pose.name} arm ${arm.name}`, JSON.stringify(await page.evaluate(async src => { try { return String(await (0, eval)(src)); } catch (e) { return `error: ${e.message}`; } }, arm.eval)).slice(0, 200));
            await page.evaluate(() => { window.__coldT0 = performance.now(); window.gameEngine.whitewater._reset(); });
            for (const s of coldS) {
                await page.waitForFunction((t) => (performance.now() - window.__coldT0) / 1000 >= t, { polling: 50, timeout: 120000 }, s);
                const r = await probe('wwContain', { map: s === coldS[coldS.length - 1] });
                const { spillAt, pitAt, ...rest } = saveMap(r, `${tag}-${arm.name}-cold${s}-map.png`);
                console.log(`[contain] ${pose.name} ${arm.name} cold ${s} s`, JSON.stringify(rest), 'spillAt', JSON.stringify(spillAt?.slice(0, 4)), 'pitAt', JSON.stringify(pitAt?.slice(0, 4)));
            }
            if (process.env.CONTAIN_ALONG && river) {
                // CONTAIN_ALONG_HALF: the averaging square's half side in cells (3: 3.5 m; 8: 8.5 m),
                // CONTAIN_ALONG_STEP the spacing (m).
                const along = await probe('wwAlong', { river: river.id, stepM: +(process.env.CONTAIN_ALONG_STEP ?? 4), rangeM: 170, half: +(process.env.CONTAIN_ALONG_HALF ?? 3) });
                let rises = 0, worst = 0;
                for (let i = 1; i < along.length; i++) {
                    const e0 = along[i - 1].W + along[i - 1].dev / 100, e1 = along[i].W + along[i].dev / 100;
                    if (e1 > e0 + 0.02) { rises++; worst = Math.max(worst, e1 - e0); }
                }
                console.log(`[contain] ${pose.name} ${arm.name} along: rises ${rises}, worst ${worst.toFixed(2)} m; dev cm:`, along.map(a => `${a.s}:${a.dev}/${a.v}`).join(' '));
            }
            await page.screenshot({ path: `${tag}-${arm.name}.png` });
        }
        await page.evaluate(() => window.gameEngine.setWhitewater(false));
        await sleep(3000);
        await page.screenshot({ path: `${tag}-off.png` });
        await page.evaluate(() => window.gameEngine.setWhitewater(true));
        await sleep(3000);
    }
} finally {
    await page.goto('about:blank').catch(() => {});
    await browser.close();
}
