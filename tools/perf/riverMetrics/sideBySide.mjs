// node sideBySide.mjs A.png B.png OUT.png: A left, B right, 8 px gap.
import fs from 'node:fs';
import { readPng, writePng } from './png.js';
const [a, c] = process.argv.slice(2, 4).map(f => readPng(fs.readFileSync(f)));
const gap = 8, w = a.w * 2 + gap, px = new Uint8Array(w * a.h * 3).fill(255);
for (let y = 0; y < a.h; y++) {
    px.set(a.px.subarray(y * a.w * 3, (y + 1) * a.w * 3), y * w * 3);
    px.set(c.px.subarray(y * c.w * 3, (y + 1) * c.w * 3), (y * w + a.w + gap) * 3);
}
fs.writeFileSync(process.argv[4], writePng(w, a.h, px));
