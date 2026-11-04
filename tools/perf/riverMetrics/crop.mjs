// node crop.mjs OUT.png x0 y0 w h scale A.png B.png ...: the same crop of each image side by side, nearest-neighbour upscaled.
import fs from 'node:fs';
import { readPng, writePng } from './png.js';
const [out, x0, y0, w, h, sc, ...files] = process.argv.slice(2), X = +x0, Y = +y0, Wd = +w, Hd = +h, s = +sc;
const ims = files.map(f => readPng(fs.readFileSync(f)));
const W = ims.length * (Wd * s + 6) - 6, H = Hd * s, px = new Uint8Array(W * H * 3).fill(255);
ims.forEach((im, k) => { for (let y = 0; y < H; y++) for (let x = 0; x < Wd * s; x++) { const sx = X + Math.floor(x / s), sy = Y + Math.floor(y / s); for (let c = 0; c < 3; c++) px[(y * W + k * (Wd * s + 6) + x) * 3 + c] = im.px[(sy * im.w + sx) * 3 + c]; } });
fs.writeFileSync(out, writePng(W, H, px));
