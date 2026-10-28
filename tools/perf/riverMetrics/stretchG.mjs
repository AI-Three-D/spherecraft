// node stretchG.mjs IN.png OUT.png x0 y0 w h lo hi: the green channel of a crop, stretched lo..hi to 0..255 (grey).
import fs from 'node:fs';
import { readPng, writePng } from './png.js';
const a = readPng(fs.readFileSync(process.argv[2]));
const [x0, y0, w, h, lo, hi] = process.argv.slice(4, 10).map(Number);
const px = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = a.px[((y0 + y) * a.w + x0 + x) * 3 + 1], v = Math.max(0, Math.min(255, Math.round((g - lo) / (hi - lo) * 255)));
    px.set([v, v, v], (y * w + x) * 3);
}
fs.writeFileSync(process.argv[3], writePng(w, h, px));
