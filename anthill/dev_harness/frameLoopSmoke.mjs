// Optional real-WebGPU frame pacing and tab suspension regression check.
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
const results = [];
try {
    for (const name of ['voxel', 'index']) {
        const page = await browser.newPage();
        await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(new URL(`dev_harness/${name}.html`, arg('url', 'http://127.0.0.1:8026/')).href);
        await page.waitForFunction(() => window.harnessFrameCount > 15 || window.harnessError, { timeout: 60000 });
        assert.equal(await page.evaluate(() => window.harnessError), undefined);
        await page.evaluate(() => {
            const h = window.harness;
            window.pacing = { submissions: 0, deltas: [] };
            const queue = h.renderer.backend.device.queue, submit = queue.submit.bind(queue);
            queue.submit = buffers => { window.pacing.submissions++; return submit(buffers); };
            const onFrame = h.frameLoop.onFrame;
            h.frameLoop.onFrame = (time, dt) => { window.pacing.deltas.push(dt); onFrame(time, dt); };
            if (h.cube) h.cube.paused = true;
        });
        await new Promise(resolve => setTimeout(resolve, 600));
        const measure = () => page.evaluate(async () => {
            const start = performance.now(), first = window.harness.renderer.frameCount;
            const submissions = window.pacing.submissions;
            let refreshes = 0;
            await new Promise(resolve => {
                const sample = () => {
                    refreshes++;
                    if (performance.now() - start < 1200) requestAnimationFrame(sample);
                    else resolve();
                };
                requestAnimationFrame(sample);
            });
            const frames = window.harness.renderer.frameCount - first;
            return { frames, submissions: window.pacing.submissions - submissions,
                refreshes, fps: frames * 1000 / (performance.now() - start) };
        });
        const idle = await measure();
        assert.ok(idle.frames > 0 && idle.fps <= 32, `idle cap: ${JSON.stringify(idle)}`);
        assert.equal(idle.submissions, idle.frames, 'only rendered frames submit GPU work');
        if (name === 'voxel') await page.keyboard.down('i');
        else await page.keyboard.press('Space');
        const active = await measure();
        assert.ok(active.frames >= active.refreshes - 2, `active rate: ${JSON.stringify(active)}`);
        if (name === 'voxel') {
            await page.keyboard.up('i');
            await page.keyboard.down('d');
            await page.waitForFunction(() => window.harness.character.digging);
            await page.mouse.move(700, 450);
            await page.mouse.down();
            await page.waitForFunction(() => document.querySelector('canvas').matches(':active'));
            await page.evaluate(() => window.harness.camera.startTurn(1, 2));
        }
        const otherTab = await browser.newPage();
        await otherTab.bringToFront();
        await page.waitForFunction(() => document.hidden, { polling: 50 });
        const snapshot = () => page.evaluate(() => {
            const h = window.harness;
            return { frames: h.renderer.frameCount, submissions: window.pacing.submissions,
                time: h.renderer.time, position: h.character?.position, revision: h.region?.volume.revision,
                turnElapsed: h.camera.turn?.elapsed, angle: h.cube?.angle,
                pendingFrame: h.frameLoop._requestId };
        });
        const hidden = await snapshot();
        assert.equal(hidden.pendingFrame, null, 'hidden tab cancels its animation request');
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.deepEqual(await snapshot(), hidden, 'hidden tab does no simulation, rendering or GPU submissions');
        await page.evaluate(() => { window.pacing.deltas = []; });
        await page.bringToFront();
        await page.waitForFunction(() => window.pacing.deltas.length > 2);
        assert.equal(await page.evaluate(() => window.pacing.deltas[0]), 0, 'resume resets the frame clock');
        if (name === 'voxel') {
            await page.waitForFunction(() => !window.harness.character.digging);
            await page.mouse.up();
            await page.keyboard.up('d');
            assert.equal(await page.evaluate(() => window.harness.region.volume.revision), hidden.revision,
                'hidden-tab input reset prevents continued digging or a stale pointer edit');
        }
        assert.equal(await page.evaluate(() => window.harnessError), undefined);
        assert.deepEqual(errors, []);
        results.push({ page: name, idleFps: Math.round(idle.fps), activeFps: Math.round(active.fps),
            hiddenFrames: 0, hiddenSubmissions: 0, resumeDelta: 0 });
        await otherTab.close();
        await page.close();
    }
    console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
    await browser.close();
}
