// node pngDiff.mjs A.png B.png: share of pixels differing by > 24 (max channel), mean abs diff.
import fs from 'node:fs';
import { readPng } from './png.js';
const [a, b] = process.argv.slice(2, 4).map(f => readPng(fs.readFileSync(f)));
let n = 0, sum = 0;
for (let i = 0; i < a.px.length; i += 3) {
    const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
    if (d > 24) n++; sum += d;
}
console.log(JSON.stringify({ changed: (n / (a.px.length / 3)).toFixed(4), meanDiff: (sum / (a.px.length / 3)).toFixed(2) }));
