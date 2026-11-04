// Optional real WebGPU/input check. Serve anthill on 8026, then provide an existing Puppeteer.
// node dev_harness/minerSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? fallback : process.argv[i + 1];
};
const modulePath = arg('puppeteer', 'puppeteer-core');
const puppeteer = (await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath)).default;
const capturePrefix = arg('capture-prefix', null);
const browser = await puppeteer.launch({
    executablePath: arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: true,
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-sandbox'],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const wait = predicate => page.waitForFunction(predicate, { timeout: 15000 });
    const capture = async name => { if (capturePrefix) await page.screenshot({ path: `${capturePrefix}-${name}.png` }); };
    await page.goto(arg('url', 'http://127.0.0.1:8026/dev_harness/voxel.html'));
    await page.waitForFunction(() => window.harnessFrameCount > 15 || window.harnessError, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.harnessError), undefined);
    await wait(() => window.harness.character.grounded);
    await capture('start');

    // Inspect rendered pixels at the actor, catching missing/misbound vertex attributes too.
    const png = Buffer.from(await page.screenshot()).toString('base64');
    const bluePixels = await page.evaluate(async png => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const h = window.harness, a = h.character;
        const at = h.camera.planeToScreen(h.plane.project(a.position.x, a.position.z).s, a.position.y + 0.9);
        const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 70;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, at.x - 20, at.y - 35, 40, 70, 0, 0, 40, 70); img.close();
        const pixels = ctx.getImageData(0, 0, 40, 70).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 2] > 60 && pixels[i + 1] > pixels[i] * 1.15 && pixels[i + 2] > pixels[i] * 1.25) count++;
        return count;
    }, png);
    assert.ok(bluePixels > 25, `visible blue miner: ${bluePixels} pixels`);

    const initial = await page.evaluate(() => ({ x: window.harness.character.position.x, revision: window.harness.region.volume.revision }));
    await page.keyboard.down('ArrowLeft'); await page.keyboard.down('d');
    await page.waitForFunction(x => window.harness.character.position.x < x - 2, { timeout: 15000 }, initial.x);
    await page.keyboard.up('ArrowLeft'); await page.keyboard.up('d');
    await wait(() => !window.harness.character.digging);
    assert.ok(await page.evaluate(revision => window.harness.region.volume.revision > revision, initial.revision));

    await page.keyboard.down('i');
    await wait(() => window.harness.character.pitch > 0.2);
    await page.keyboard.up('i');
    await page.$eval('#dig-angle', input => { input.value = '-25'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.ok(await page.evaluate(() => window.harness.character.pitch < -0.4));
    await capture('dig');

    await page.keyboard.press('f');
    await wait(() => !!window.harness.inspectionCamera);
    const z = await page.evaluate(() => window.harness.character.position.z);
    await page.keyboard.down('ArrowDown'); await page.keyboard.down('d');
    await page.waitForFunction(z => window.harness.character.position.z > z + 0.8, { timeout: 15000 }, z);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('d');
    assert.ok(await page.evaluate(() => {
        const h = window.harness, p = h.character.position;
        return Math.abs(h.plane.project(p.x, p.z).distance + 0.34) < 1e-5;
    }), 'free-view cut follows movement through depth');
    await page.mouse.move(1000, 600); await page.mouse.down(); await page.mouse.move(1090, 660, { steps: 12 }); await page.mouse.up();
    await capture('free-cutaway');
    await page.keyboard.press('c');
    assert.equal(await page.evaluate(() => window.harness.view.clipEnabled), false);
    await capture('free-hillside');
    await page.keyboard.press('f');
    await wait(() => !window.harness.inspectionCamera && window.harness.character.grounded);
    await page.keyboard.press('e');
    await wait(() => !window.harness.camera.turn);
    assert.ok(await page.evaluate(() => Math.abs(window.harness.plane.angle - Math.PI / 2) < 1e-8));

    const y = await page.evaluate(() => window.harness.character.position.y);
    await page.keyboard.down('Space');
    await page.waitForFunction(y => window.harness.character.position.y > y + 0.3, { timeout: 15000 }, y);
    await page.keyboard.up('Space');
    await wait(() => window.harness.character.grounded);
    await page.evaluate(() => {
        const h = window.harness, p = h.character.position;
        h.region.apply({ shape: { type: 'capsule', a: [p.x, p.y + 1, p.z], b: [p.x, p.y - 24, p.z], radius: 1.5 } });
    });
    await wait(() => !window.harness.character.alive);
    await capture('fatal-fall');
    const revision = await page.evaluate(() => window.harness.region.volume.revision);
    await page.keyboard.press('p');
    await wait(() => window.harness.character.alive && window.harness.character.grounded);
    assert.equal(await page.evaluate(() => window.harness.region.volume.revision), revision);
    assert.equal(await page.evaluate(() => window.harness.character.deaths), 1);
    await page.keyboard.down('d');
    await wait(() => window.harness.character.digging);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await wait(() => !window.harness.character.digging);
    await page.keyboard.up('d');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, bluePixels, frames: await page.evaluate(() => window.harnessFrameCount), checks: [
        'WebGPU rendering', 'held digging and release', 'keyboard and slider aim', '3D free movement',
        'cutaway and full hillside', 'quarter turn', 'jump', 'fatal shaft fall', 'respawn retains edits', 'blur releases keys',
    ] }, null, 2));
} finally {
    await browser.close();
}
