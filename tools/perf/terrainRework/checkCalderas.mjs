// Production startup choices: lake terrain and river-planning sampler agreement.
import fs from 'node:fs';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:8777';
const output = process.argv[3];
const sites = [[-.547596,.037986,-.835880],[.157076,-.038889,-.986821],
    [.009740,-.801322,-.598154],[-.818124,-.570302,-.073679],[-132482,5596,-355]];
const points = [];
for (const site of sites) {
    const len = Math.hypot(...site), n = site.map(v => v / len);
    points.push(n);
    if (site === sites.at(-1)) continue;
    const ref = Math.abs(n[1]) < .9 ? [0,1,0] : [1,0,0];
    const e = [n[1]*ref[2]-n[2]*ref[1],n[2]*ref[0]-n[0]*ref[2],n[0]*ref[1]-n[1]*ref[0]];
    const el = Math.hypot(...e);
    for (const distance of [-3500,3500]) points.push(n.map((v,k) => v*131072+e[k]/el*distance));
}
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist'],
});
const results = [];
try {
    for (const scenario of [
        { name:'off', enabled:false, trials:'' },
        { name:'on', enabled:true, trials:'' },
        { name:'stack', enabled:true, trials:'mountains,foothills,valleys,rolling,coast,coves' },
    ]) {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`${base}/wizard_game/standalone.html?lakeCells=1&labNoClouds=1&terrainRework=${scenario.trials}&calderas=${scenario.enabled?1:0}`,{waitUntil:'load',timeout:120000});
        await page.waitForFunction(() => window.gameEngine?.waterService?.state==='ready' && window.gameEngine?.waterService?._sampler && window.gameEngine?.waterService?._lakeCells?.rivers?.table,
            {timeout:240000,polling:1000});
        const result = await page.evaluate(async points => {
            const g = window.gameEngine, table = g.terrainGenerator.lakeTable;
            const dirs = points.map(p => { const l=Math.hypot(...p);return p.map(v=>v/l); });
            const rivers = g.waterService._lakeCells.rivers.table;
            for (const d of dirs) { table.ensureArea(d,3500); rivers.ensureArea(d,3500); }
            const input = new Float32Array(dirs.flatMap(d=>[...d,0]));
            const terrain = Array.from(await table.sampleHeights(input));
            const water = Array.from(await g.waterService._sampler.sampleDirsNatural(input));
            return { enabled:g.terrainGenerator.calderas.enabled, key:g.waterService._sampler.terrainKey,
                terrain,water,differences:terrain.map((h,i)=>Math.abs(h-water[i])) };
        },points);
        if(errors.length || result.enabled!==scenario.enabled || [...result.terrain,...result.water].some(v=>!Number.isFinite(v)) || result.differences.some(d=>d>.5)) {
            throw new Error(JSON.stringify({scenario,result,errors}));
        }
        results.push({scenario:scenario.name,...result});
        console.log(JSON.stringify(results.at(-1)));
        await page.close();
    }
    if(new Set(results.map(r=>r.key)).size!==results.length) throw new Error('Caldera startup selection reused a cache key');
    if(!results[0].terrain.some((h,i)=>results[1].terrain[i]-h>200)) throw new Error('Caldera did not measurably change any review site');
    if(output) fs.writeFileSync(output,JSON.stringify({points,results},null,2));
} finally { await browser.close(); }
