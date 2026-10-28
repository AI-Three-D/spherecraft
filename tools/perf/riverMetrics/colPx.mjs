// node colPx.mjs IMG.png x0 x1 y0 y1: per row y, mean RGB over columns x0..x1.
import fs from 'node:fs';
import { readPng } from './png.js';
const a = readPng(fs.readFileSync(process.argv[2]));
const [x0, x1, y0, y1] = process.argv.slice(3, 7).map(Number);
for (let y = y0; y <= y1; y++) {
    const s = [0, 0, 0];
    for (let x = x0; x <= x1; x++) for (let c = 0; c < 3; c++) s[c] += a.px[(y * a.w + x) * 3 + c];
    console.log(y, s.map(v => (v / (x1 - x0 + 1)).toFixed(0)).join(' '));
}
