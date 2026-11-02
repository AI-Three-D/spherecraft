// node grid.mjs OUT.png COLS SCALE A.png B.png ...: the images box-downscaled
// by SCALE (integer) in a grid of COLS columns, 6 px white gaps.
import fs from 'node:fs';
import { readPng, writePng } from './png.js';
const [out, colsArg, scaleArg, ...files] = process.argv.slice(2);
const cols = Number(colsArg), s = Number(scaleArg), gap = 6;
const imgs = files.map(f => readPng(fs.readFileSync(f))).map(im => {
    const w = Math.floor(im.w / s), h = Math.floor(im.h / s), px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) sum += im.px[((y * s + j) * im.w + x * s + i) * 3 + c];
        px[(y * w + x) * 3 + c] = sum / (s * s);
    }
    return { w, h, px };
});
const cw = Math.max(...imgs.map(i => i.w)), ch = Math.max(...imgs.map(i => i.h)), rows = Math.ceil(imgs.length / cols);
const W = cols * cw + (cols - 1) * gap, H = rows * ch + (rows - 1) * gap, px = new Uint8Array(W * H * 3).fill(255);
imgs.forEach((im, k) => {
    const ox = (k % cols) * (cw + gap), oy = Math.floor(k / cols) * (ch + gap);
    for (let y = 0; y < im.h; y++) px.set(im.px.subarray(y * im.w * 3, (y + 1) * im.w * 3), ((oy + y) * W + ox) * 3);
});
fs.writeFileSync(out, writePng(W, H, px));
