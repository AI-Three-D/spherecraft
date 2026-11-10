/* global process, Buffer */
// Rendered lake water agreement between two runs at the same camera pose:
// a pixel is lake water where the run's lake-id tint capture differs from
// its untinted capture (qtDiag.water.tint(1) recolours only lake pixels).
//
//   node tools/perf/lakeRecovery/renderedWaterDiff.mjs RUN_A RUN_B NAME [NAME...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function readPng(file) {
    const buf = fs.readFileSync(file);
    let w = 0, h = 0, ct = 0, idat = [];
    for (let o = 8; o < buf.length;) {
        const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('8-bit non-interlaced only'); }
        else if (type === 'IDAT') idat.push(data);
        o += 12 + len;
    }
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`colour type ${ct}`); })();
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = new Uint8Array(w * h * 3);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
            let p = 0;
            if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            cur[x] = (line[x] + p) & 255;
        }
        for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) px[(y * w + x) * 3 + k] = cur[x * bpp + k];
        [prev, cur] = [cur, prev];
    }
    return { w, h, px };
}
function waterMask(dir, name) {
    const a = readPng(path.join(dir, `${name}.png`)), b = readPng(path.join(dir, `${name}-tint1.png`));
    const m = new Uint8Array(a.w * a.h);
    for (let i = 0; i < m.length; i++) {
        const d = Math.abs(a.px[3 * i] - b.px[3 * i]) + Math.abs(a.px[3 * i + 1] - b.px[3 * i + 1]) + Math.abs(a.px[3 * i + 2] - b.px[3 * i + 2]);
        m[i] = d > 40 ? 1 : 0;
    }
    return m;
}
const [A, B, ...names] = process.argv.slice(2);
// NAME may be 'nameA=nameB' (two captures of the same pose under different names).
for (const spec of names) {
    const [na, nb = na] = spec.split('='), name = spec;
    const ma = waterMask(A, na), mb = waterMask(B, nb);
    let ia = 0, ib = 0, inter = 0, uni = 0;
    for (let i = 0; i < ma.length; i++) { ia += ma[i]; ib += mb[i]; inter += ma[i] & mb[i]; uni += ma[i] | mb[i]; }
    console.log(JSON.stringify({ name, a: path.basename(A), b: path.basename(B), waterPxA: ia, waterPxB: ib, iou: +(inter / Math.max(uni, 1)).toFixed(4), onlyA: ia - inter, onlyB: ib - inter }));
}
