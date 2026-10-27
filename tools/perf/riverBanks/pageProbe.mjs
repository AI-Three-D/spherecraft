// tools/perf/riverBanks/pageProbe.mjs
//
// Loads the owner's configuration URL headless (own no-cache server :8233),
// waits for the water precompute, calls one exported page-side function and
// prints its JSON result. Closes Chrome at the end.
//
//   node tools/perf/riverBanks/pageProbe.mjs /tools/perf/riverBanks/MODULE.js EXPORT ['{"json":"args"}'] [--profile DIR] [--url-extra S]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const [modulePath, exportName, argsJson] = positional;
if (!modulePath || !exportName) throw new Error('Usage: pageProbe.mjs /module.js EXPORT [json-args] [--profile DIR] [--url-extra S]');
const PORT = 8233;
const URL_PATH = '/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1' + (arg('--url-extra') ?? '');
const req = createRequire(path.join(root, '../terrain-lab/package.json'));
const { default: puppeteer } = await import(req.resolve('puppeteer-core'));
const server = spawn('python3', [path.join(root, 'tools/perf/lakeRecovery/noCacheServer.py'), String(PORT), root], { stdio: 'ignore' });
let browser;
try {
    await new Promise(r => setTimeout(r, 600));
    browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900000,
        ...(arg('--profile') ? { userDataDir: path.resolve(arg('--profile')) } : {}),
        args: ['--enable-unsafe-webgpu', '--enable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/lakeRecovery/pageInstrument.js'), 'utf8'));
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root, 'tools/perf/terrainDetail/gpuTimer.js'), 'utf8'));
    await page.goto(`http://127.0.0.1:${PORT}${URL_PATH}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.gameEngine?.waterService?.precomputed === true && window.gameEngine?.getLoadingStatus?.()?.complete,
        { timeout: 900000, polling: 500 });
    const result = await page.evaluate(async (m, e, a) => (await import(m))[e](a ? JSON.parse(a) : undefined), modulePath, exportName, argsJson ?? null);
    console.log(JSON.stringify(result, null, 1));
    await page.goto('about:blank');
} finally {
    await browser?.close();
    server.kill();
}
