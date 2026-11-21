// Startup-model check against the real lake-table and river-planning samplers.
// Run with a local server: node checkWater.mjs [http://127.0.0.1:8000]
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:8000';
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
const results = {};
try {
    const scenarios = [
        { name: 'legacy', mountain: 'legacy', foothill: 'legacy' },
        { name: 'directional', mountain: 'directional', foothill: 'legacy' },
        { name: 'regional', mountain: 'directional', foothill: 'regional' },
    ];
    for (const scenario of scenarios) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/wizard_game/standalone.html?lakeCells=1&mountainRangeModel=${scenario.mountain}&foothillModel=${scenario.foothill}`,
            { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.gameEngine?.waterService?._lakeCells?.rivers?.table &&
            window.gameEngine?.waterService?._sampler && window.gameEngine?.waterService?.state === 'ready',
        { timeout: 240000, polling: 1000 });
        results[scenario.name] = await page.evaluate(async () => {
            const g = window.gameEngine;
            const table = g.terrainGenerator.lakeTable, rivers = g.waterService._lakeCells.rivers.table;
            const { faceUVToDir } = await import('/core/world/hydrology/waterGraph.js');
            const dirs = [];
            for (const [u, v] of [[0.367, 0.369], [0.37, 0.37], [0.36, 0.36], [0.397, 0.361], [0.41, 0.34]]) {
                const d = faceUVToDir(5, u, v);
                dirs.push(...d, 0);
                table.ensureArea(d, 3500);
                rivers.ensureArea(d, 3500);
            }
            const input = new Float32Array(dirs);
            const terrain = await table.sampleHeights(input);
            const water = await g.waterService._sampler.sampleDirsNatural(input);
            return { mountain: g.terrainGenerator.mountainRangeModel, foothill: g.terrainGenerator.foothills.model,
                terrainKey: g.waterService._sampler.terrainKey,
                heights: Array.from(terrain), differences: Array.from(terrain, (h, i) => Math.abs(h - water[i])) };
        });
        await page.close();
        if (errors.length || results[scenario.name].mountain !== scenario.mountain ||
            results[scenario.name].foothill !== scenario.foothill ||
            results[scenario.name].differences.some(d => !Number.isFinite(d) || d > 0.5)) {
            throw new Error(`Water sampler mismatch: ${JSON.stringify({ scenario, errors, result: results[scenario.name] })}`);
        }
    }
    if (results.legacy.terrainKey === results.directional.terrainKey ||
        results.legacy.heights.every((h, i) => Math.abs(h - results.directional.heights[i]) < 1)) {
        throw new Error('Model selection did not change the terrain and hydrology cache key');
    }
    if (results.directional.terrainKey === results.regional.terrainKey ||
        results.directional.heights.every((h, i) => Math.abs(h - results.regional.heights[i]) < 1)) {
        throw new Error('Foothill selection did not change the terrain and hydrology cache key');
    }
    console.log(JSON.stringify(results, null, 2));
} finally {
    await browser.close();
}
