// Verify all independent comparison selections start before hydrology and
// share terrain with the lake and river samplers.
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:8775';
const names = ['mountains', 'foothills', 'valleys', 'rolling', 'coast', 'coves', 'canyon', 'dunes'];
// The short form checks the canyon (and the dunes) by themselves and with
// every other trial.
const masks = process.argv.includes('--canyon-smoke') ? [0, 64, 63, 127, 128, 255] : Array.from({ length: 1 << names.length }, (_, i) => i);
const keys = new Set();
const heights = new Map();
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
try {
    for (const mask of masks) {
        const selected = names.filter((_, i) => mask & (1 << i));
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`${base}/wizard_game/standalone.html?lakeCells=1&fells=0&fjords=0&terrainRework=${selected.join(',')}`,
            { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.gameEngine?.waterService?._lakeCells?.rivers?.table &&
            window.gameEngine?.waterService?._sampler && window.gameEngine?.waterService?.state === 'ready',
        { timeout: 240000, polling: 1000 });
        const result = await page.evaluate(async () => {
            const g = window.gameEngine, generator = g.terrainGenerator;
            const { landformDetails, mountainRangeModel } = generator;
            const shader = generator.terrainShaderBundle.createTerrainFeatureMountains({
                rangeModel: mountainRangeModel, rangeValleys: landformDetails.rangeValleys,
            });
            const rollingShader = generator.terrainShaderBundle.createTerrainFeatureLoneHills(landformDetails);
            const coastShader = generator.terrainShaderBundle.baseGenerators.lakeLand.base({ landformDetails });
            const d = [-96972.186, 68757.253, -56740.823], n = Math.hypot(...d), dir = d.map(x => x / n);
            const table = generator.lakeTable, rivers = g.waterService._lakeCells.rivers.table;
            table.ensureArea(dir, 3500); rivers.ensureArea(dir, 3500);
            const input = new Float32Array([...dir, 0]);
            const [terrain] = await table.sampleHeights(input);
            const [water] = await g.waterService._sampler.sampleDirsNatural(input);
            return { mountain: generator.mountainRangeModel, foothill: generator.foothills.model,
                valley: shader.includes('fn valleyRange_d('), rolling: rollingShader.includes('let regionN = fbmAuto_d('),
                coast: coastShader.includes('fn coastalHillsHeight_d(') || coastShader.includes('TERRAIN_REWORK_COAST_RELIEF_TRIAL'),
                coves: coastShader.includes('fn coastalCoves_d(') || coastShader.includes('TERRAIN_REWORK_COAST_MASK_TRIAL'),
                canyon: coastShader.includes('TERRAIN_REWORK_CANYON_TRIAL'),
                dunes: coastShader.includes('TERRAIN_REWORK_DUNES_TRIAL'), terrain, water,
                key: g.waterService._sampler.terrainKey };
        });
        await page.close();
        if (errors.length || result.mountain !== (selected.includes('mountains') ? 'directional' : 'legacy') ||
            result.foothill !== (selected.includes('foothills') ? 'regional' : 'legacy') ||
            result.valley !== selected.includes('valleys') || result.rolling !== selected.includes('rolling') ||
            result.coast !== selected.includes('coast') || result.coves !== selected.includes('coves') ||
            result.canyon !== selected.includes('canyon') || result.dunes !== selected.includes('dunes') ||
            !Number.isFinite(result.terrain) || !Number.isFinite(result.water) ||
            Math.abs(result.terrain - result.water) > 0.5) {
            throw new Error(`Preview selection failed: ${JSON.stringify({ selected, result, errors })}`);
        }
        if (keys.has(result.key)) throw new Error(`Preview reused a terrain cache key: ${JSON.stringify({ selected, result })}`);
        keys.add(result.key);
        heights.set(mask, result.terrain);
        console.log(JSON.stringify({ selected, ...result }));
    }
    for (const mask of [0, 63]) {
        const difference = Math.abs(heights.get(mask) - heights.get(mask | 64));
        if (!Number.isFinite(difference) || difference < 5) {
            throw new Error(`Canyon did not measurably affect the test site for selection ${mask}`);
        }
    }
} finally {
    await browser.close();
}
