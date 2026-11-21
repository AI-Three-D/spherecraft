// Check that terrain and hydrology see the same coast for independent trials.
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:8804';
const scenarios = [[], ['coast'], ['coves'], ['coast', 'coves']];
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
const samples = [];
try {
    for (const selected of scenarios) {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const features = ['mountains', 'foothills', 'valleys', 'rolling', ...selected];
        await page.goto(`${base}/wizard_game/standalone.html?lakeCells=1&terrainRework=${features.join(',')}`,
            { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.gameEngine?.waterService?._lakeCells?.rivers?.table &&
            window.gameEngine?.waterService?._sampler && window.gameEngine?.waterService?.state === 'ready',
        { timeout: 240000, polling: 1000 });
        const result = await page.evaluate(async () => {
            const g = window.gameEngine, table = g.terrainGenerator.lakeTable, rivers = g.waterService._lakeCells.rivers.table;
            const center = [-0.5337303186499118, -0.09766055665665128, -0.8399966444143553];
            const along = [-0.8075758131002261, -0.23585136087783376, 0.5405510537105468];
            const across = [0.2509048685246509, -0.9668694592578599, -0.0470127185455257];
            const dirs = [];
            for (const a of [-4000, -2000, 0, 2000, 4000]) for (const b of [-2000, -1000, 0, 1000, 2000]) {
                const p = center.map((x, i) => x * g.planetConfig.radius + along[i] * a + across[i] * b);
                const n = Math.hypot(...p), d = p.map(x => x / n);
                dirs.push(...d, 0); table.ensureArea(d, 3500); rivers.ensureArea(d, 3500);
            }
            const input = new Float32Array(dirs);
            const terrain = await table.sampleHeights(input);
            const water = await g.waterService._sampler.sampleDirsNatural(input);
            return { key: g.waterService._sampler.terrainKey, heights: Array.from(terrain),
                differences: Array.from(terrain, (h, i) => Math.abs(h - water[i])) };
        });
        await page.close();
        if (errors.length || result.differences.some(x => !Number.isFinite(x) || x > 0.5)) {
            throw new Error(`Coastal terrain and water disagree: ${JSON.stringify({ selected, result, errors })}`);
        }
        samples.push(result);
        console.log(JSON.stringify({ selected, key: result.key, maxDifferenceM: Math.max(...result.differences) }));
    }
    for (const index of [1, 2, 3]) {
        if (samples[index].key === samples[0].key || samples[index].heights.every((h, i) => Math.abs(h - samples[0].heights[i]) < 1)) {
            throw new Error(`Coastal selection did not affect the sampled shore: ${scenarios[index]}`);
        }
    }
} finally {
    await browser.close();
}
