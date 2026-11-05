// How crooked lake outlines are, from captures: node shoreMetric.mjs IMAGE.png ...
// Water is where blue beats green and red. Per image: outline pixels over the square
// root of the area: a circle is 3.5 at any size, a crooked shore far more.
import fs from 'node:fs';
import process from 'node:process';
import { readPng } from '../riverMetrics/png.js';

for (const f of process.argv.slice(2)) {
    const { w, h, px } = readPng(fs.readFileSync(f));
    const wet = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) { const r = px[k * 3], g = px[k * 3 + 1], b = px[k * 3 + 2]; wet[k] = b > g + 6 && b > r + 14 && b < 215 && k > w * h * 0.12 ? 1 : 0; }
    let area = 0, edge = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        if (!wet[k]) continue;
        area++;
        if (!wet[k - 1] || !wet[k + 1] || !wet[k - w] || !wet[k + w]) edge++;
    }
    console.log(f.split('/').slice(-2).join('/').padEnd(40), 'area', String(area).padStart(7), 'outline', String(edge).padStart(6), 'ratio', (edge / Math.sqrt(area)).toFixed(1));
}
