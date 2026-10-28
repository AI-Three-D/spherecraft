// node diffMap.mjs A.png B.png OUT.png gain: |A-B| per pixel (max channel) x gain as grey.
import fs from 'node:fs';
import { readPng, writePng } from './png.js';
const [a, b] = process.argv.slice(2, 4).map(f => readPng(fs.readFileSync(f)));
const g = +(process.argv[5] ?? 10), px = new Uint8Array(a.w * a.h * 3);
for (let i = 0; i < a.w * a.h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.px[i * 3 + c] - b.px[i * 3 + c]));
    const v = Math.min(255, d * g);
    px.set([v, v, v], i * 3);
}
fs.writeFileSync(process.argv[4], writePng(a.w, a.h, px));
