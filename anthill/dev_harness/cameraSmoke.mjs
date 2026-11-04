// Optional real WebGPU/input check. Serve anthill on 8026 and supply Puppeteer.
// node dev_harness/cameraSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? fallback : process.argv[i + 1];
};
const modulePath = arg('puppeteer', 'puppeteer-core');
const puppeteer = (await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath)).default;
const browser = await puppeteer.launch({
    executablePath: arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: true,
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-sandbox'],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 760, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const wait = async (fn, ...args) => {
        try { return await page.waitForFunction(fn, { timeout: 20000 }, ...args); }
        catch (error) {
            console.error(JSON.stringify({ predicate: String(fn), errors, state: await page.evaluate(() => ({
                mode: window.harness?.cameraMode, alive: window.harness?.character.alive,
                position: window.harness?.character.position, digging: window.harness?.character.digging,
                locked: !!document.pointerLockElement, error: window.harnessError,
            })) }, null, 2));
            throw error;
        }
    };
    const rendered = () => page.evaluate(async () => {
        const h = window.harness, first = h.renderer.frameCount;
        h.frameLoop.wake();
        while (h.renderer.frameCount < first + 3) await new Promise(requestAnimationFrame);
    });
    const capture = async name => {
        if (arg('capture-prefix', null)) await page.screenshot({ path: `${arg('capture-prefix')}-${name}.png` });
    };
    await page.goto(arg('url', 'http://127.0.0.1:8026/dev_harness/voxel.html'));
    await page.waitForFunction(() => window.harnessFrameCount > 15 || window.harnessError, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.harnessError), undefined);
    await wait(() => window.harness.character.grounded);
    await page.evaluate(() => { window.harness.lighting.running = false; });

    const side = await page.evaluate(() => {
        const h = window.harness;
        return { center: { ...h.camera.center }, mpp: h.camera.metersPerPixel };
    });
    await page.select('#camera-mode', 'first-person');
    await rendered();
    assert.ok(await page.evaluate(() => {
        const h = window.harness;
        return h.cameraMode === 'first-person' && !h.view.clipEnabled && !h.view.showGround
            && h.characterView.data[33] === 1 && h.view.rayData[31] > 0
            && document.querySelector('#follow-miner').disabled && !document.querySelector('#crosshair').hidden;
    }));
    await capture('first-person');

    // D is strafe in the perspective views, and must not turn or mine.
    const before = await page.evaluate(() => {
        const h = window.harness;
        return { z: h.character.position.z, heading: h.character.heading, revision: h.region.volume.revision };
    });
    await page.keyboard.down('d');
    await wait(z => window.harness.character.position.z < z - 0.4, before.z);
    await page.keyboard.up('d');
    assert.ok(await page.evaluate(before => {
        const h = window.harness;
        return h.character.heading === before.heading && h.region.volume.revision === before.revision;
    }, before));
    await page.keyboard.down('x'); await wait(() => window.harness.character.digging);
    await wait(revision => window.harness.region.volume.revision > revision, before.revision);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await wait(() => !window.harness.character.digging);
    await page.keyboard.up('x');

    // Capture/look/mouse mining/release exercises pointer lock rather than just the camera API.
    await page.mouse.click(850, 550);
    await wait(() => document.pointerLockElement === document.querySelector('canvas'));
    const heading = await page.evaluate(() => window.harness.character.heading);
    await page.mouse.move(910, 530, { steps: 6 });
    await wait(heading => Math.abs(window.harness.character.heading - heading) > 0.01, heading);
    await page.mouse.down(); await wait(() => window.harness.character.digging);
    await page.mouse.up(); await wait(() => !window.harness.character.digging);
    await page.keyboard.press('Escape');
    await wait(() => !document.pointerLockElement);

    await page.keyboard.press('v'); await rendered();
    assert.equal(await page.evaluate(() => window.harness.cameraMode), 'third-person');
    assert.ok(await page.evaluate(() => window.harness.characterCamera.actualDistance > 0));
    await capture('third-person');
    const distance = await page.evaluate(() => window.harness.characterCamera.distance);
    await page.mouse.wheel({ deltaY: 200 });
    await wait(distance => window.harness.characterCamera.distance > distance, distance);

    // Both the compute and reference fragment shaders must render perspective terrain.
    await page.evaluate(() => {
        const h = window.harness;
        h.character.heading = Math.PI; h.character.setPitch(-0.15);
        document.querySelector('aside').style.visibility = 'hidden';
    });
    await rendered();
    const compute = Buffer.from(await page.screenshot()).toString('base64');
    await page.evaluate(() => { window.harness.view.useCompute = false; });
    await rendered();
    const fragment = Buffer.from(await page.screenshot()).toString('base64');
    const pixels = await page.evaluate(async ({ compute, fragment }) => {
        const read = async png => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const a = await read(compute), b = await read(fragment);
        let terrain = 0, different = 0;
        for (let i = 0; i < a.length; i += 4) {
            if (Math.abs(a[i] - 9) + Math.abs(a[i + 1] - 14) + Math.abs(a[i + 2] - 23) > 15) terrain++;
            if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 12) different++;
        }
        return { terrain, different, total: a.length / 4 };
    }, { compute, fragment });
    assert.ok(pixels.terrain > pixels.total * 0.15, `terrain is visible: ${JSON.stringify(pixels)}`);
    assert.ok(pixels.different < pixels.total * 0.03, `render paths agree: ${JSON.stringify(pixels)}`);
    await page.evaluate(() => {
        window.harness.view.useCompute = true;
        document.querySelector('aside').style.visibility = '';
    });

    // The boom must retract in an edited tunnel and extend again when rock is removed.
    await page.evaluate(() => {
        const h = window.harness, a = h.character;
        h.characterCamera.distance = 4.5;
        h.region.apply({ mode: 'fill', shape: { type: 'sphere',
            center: [a.position.x + 2, a.position.y + 1.62, a.position.z], radius: 0.5 } });
        h.frameLoop.wake();
    });
    await wait(() => window.harness.characterCamera.actualDistance < 2);
    assert.ok(await page.evaluate(() => {
        const h = window.harness, p = h.characterCamera.localPosition, r = h.characterCamera.collisionRadius;
        return !h.terrain.bodyBlocked({ ...p, y: p.y - r }, r, 2 * r, 0);
    }));
    await page.evaluate(() => {
        const h = window.harness, a = h.character;
        h.region.apply({ shape: { type: 'sphere',
            center: [a.position.x + 2, a.position.y + 1.62, a.position.z], radius: 0.9 } });
        h.frameLoop.wake();
    });
    await wait(() => window.harness.characterCamera.actualDistance > 3);
    await page.keyboard.press('p');
    await wait(() => window.harness.character.grounded);
    assert.equal(await page.evaluate(() => window.harness.cameraMode), 'third-person');
    await page.select('#camera-mode', 'anthill'); await rendered();
    assert.ok(await page.evaluate(() => {
        const h = window.harness;
        return h.view.clipEnabled && h.view.showGround && h.view.rayData[31] === 0
            && h.characterView.data[33] === 0 && !document.querySelector('#follow-miner').disabled;
    }));
    assert.equal(await page.evaluate(() => window.harness.camera.metersPerPixel), side.mpp);
    await page.keyboard.press('f'); await rendered();
    assert.ok(await page.evaluate(() => !!window.harness.inspectionCamera));
    await page.keyboard.press('f');
    await page.keyboard.press('v'); await page.click('#overview'); await rendered();
    assert.equal(await page.evaluate(() => window.harness.cameraMode), 'anthill');
    assert.equal(await page.evaluate(() => window.harnessError), undefined);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, pixels, frames: await page.evaluate(() => window.harnessFrameCount), checks: [
        'first/third-person UI', 'camera-relative WASD and preserved aim', 'digging and blur reset',
        'pointer lock/look/mouse mining/Esc', 'third-person zoom', 'perspective compute/fragment rendering',
        'edited terrain boom collision', 'respawn preserves mode', 'side/inspection/overview restored',
    ] }, null, 2));
} finally {
    await browser.close();
}
