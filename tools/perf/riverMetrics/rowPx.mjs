// node rowPx.mjs IMG.png y x0 x1 step: mean RGB of rows y-2..y+2 every step px from x0 to x1.
import fs from 'node:fs';
import { readPng } from './png.js';
const a = readPng(fs.readFileSync(process.argv[2]));
const [y, x0, x1, step] = process.argv.slice(3, 7).map(Number);
const out = [];
for (let x = x0; x <= x1; x += step) {
    const s = [0, 0, 0];
    for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x; xx < x + step; xx++) for (let c = 0; c < 3; c++) s[c] += a.px[(yy * a.w + xx) * 3 + c];
    out.push(`${x}:${s.map(v => Math.round(v / (5 * step))).join(',')}`);
}
console.log(out.join(' '));
