/* global cloudLab */
// Adds descriptor features (<scene>.extra.f32) to existing teacher records.
//   node tools/neural/extraRun.mjs [scene-regex]
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const pattern = new RegExp(process.argv[2] ?? '.');
const dataDir = path.resolve('tools/neural/data');
const url = process.env.LAB_URL ?? 'http://127.0.0.1:8000';
const names = (await fs.readdir(dataDir)).filter(f => f.endsWith('.records.f32')).map(f => f.slice(0, -12)).filter(n => pattern.test(n));
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, protocolTimeout: 0, args: ['--enable-unsafe-webgpu'],
});
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 800, height: 500 });
    page.on('console', async m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text(), ...(await Promise.all(m.args().map(a => a.jsonValue().catch(() => '?'))))); });
    await page.goto(new URL('/cloud_lab/?radius=131', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudLabFrameCount > 2 || window.cloudLabError, { polling: 250 });
    await page.evaluate(() => { cloudLab.clouds.enabled = false; });
    for (const name of names) {
        const meta = JSON.parse(await fs.readFile(path.join(dataDir, `${name}.json`), 'utf8'));
        const records = (await fs.readFile(path.join(dataDir, `${name}.records.f32`))).toString('base64');
        const b64 = await page.evaluate(async (uniforms, records) => {
            const { TeacherGpu } = await import('/neural_lab/teacherGpu.js');
            const bin = atob(records);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const values = await new TeacherGpu(cloudLab.clouds).extra(uniforms, new Float32Array(bytes.buffer));
            const out = new Uint8Array(values.buffer);
            let s = '';
            for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
            return btoa(s);
        }, meta.uniforms, records);
        await fs.writeFile(path.join(dataDir, `${name}.extra.f32`), Buffer.from(b64, 'base64'));
        console.log(`${name}: extra features`);
    }
} finally {
    await browser.close();
}
