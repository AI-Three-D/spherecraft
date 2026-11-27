/* global process */
// The grass field against its teacher over many views (grassRig.js zoomTruth): for each pose and distance, the mean
// colour of the field drawn as it is (zoomed in 8 times, blades dense, no distance shortcuts) and of the ground alone
// (the analytic canopy the terrain draws past the blades), with the spot's geometry (slant through the canopy, the sun's
// height, the hotspot). The data the canopy is fitted to (tools/perf/grass/teacherFit.mjs).
// node tools/perf/grass/teacherRun.mjs OUT.json [--game] [--only name,name]
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
if (!out || out.startsWith('--')) throw new Error('Usage: teacherRun.mjs OUT.json [--game] [--only name]');
const withGame = process.argv.includes('--game');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split(',') : null;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = Number(process.env.PORT ?? 8241);

// name, pose of poses.json or a world eye, eye height (m), turn from the sun (deg), sun height
const VIEWS = [];
for (const eye of [1.8, 5, 12]) for (const turn of [0, 100, 180]) for (const sun of [0.3, 0.7]) VIEWS.push([`meadow ${eye} m turn ${turn} sun ${sun}`, 'grassland', eye, turn, sun]);
for (const bearing of [2.7, 182.7]) for (const sun of [0.3, 0.7]) VIEWS.push([`slope ${bearing} sun ${sun}`, [-122982.2, -17974.4, 43657.0], null, bearing, sun]);

const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
const rows = [];
try {
    await new Promise(r => setTimeout(r, 700));
    browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 3600000,
        args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${PORT}/wizard_game/standalone.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.getLoadingStatus?.()?.complete, { timeout: 240000, polling: 250 });
    await page.evaluate(async () => {
        const R = window.R = await import('/tools/perf/grass/grassRig.js');
        await R.boot();
        window.windMps = 0.5;
        window.__poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
    });
    for (const [name, pose, eyeH, turn, sun] of VIEWS) {
        if (only && !only.some(o => name.includes(o))) continue;
        const t0 = Date.now();
        const result = await page.evaluate(async (pose, eyeH, turn, sun, withGame) => {
            const R = window.R, g = window.gameEngine;
            let eye, bearing, up;
            if (typeof pose === 'string') {
                const p = window.__poses.find(x => x.name === pose);
                R.sunAt(p.dir, sun);
                await R.frames(6);
                bearing = R.sunBearing(p.dir) + turn;
                await R.eyeAt(p.dir, { eye: eyeH, pitch: -8, bearing, aheadM: 150 });
                const c = g.camera.position;
                eye = [c.x, c.y, c.z];
            } else {
                eye = pose;
                const l = Math.hypot(...eye);
                up = eye.map(x => x / l);
                R.sunAt(up, sun);
                await R.frames(6);
                bearing = turn;
            }
            const rows = await R.zoomTruth({ eye, bearing, dists: [10, 16, 25, 40, 60, 90, 130, 190], game: withGame });
            return { rows, errors: window.gpuErrors.slice(0, 2) };
        }, pose, eyeH, turn, sun, withGame);
        for (const r of result.rows) rows.push({ view: name, eyeH, turn, sunHeight: sun, ...r });
        console.log(`${name}: ${result.rows.length} spots, ${((Date.now() - t0) / 1000).toFixed(0)} s${result.errors.length ? ' errors ' + result.errors.join(' | ') : ''}`);
        await writeFile(out, JSON.stringify(rows, null, 1));
    }
} finally {
    await browser?.close();
    server.kill();
}
console.log(`wrote ${rows.length} rows to ${out}`);
