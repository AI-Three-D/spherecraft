// How flat a lake reads, from armReview captures: node lakeMetrics.mjs ARM_DIR VIEWS.json
// Water pixels come from the water debug view 7 capture (blue = water), kept a
// few pixels inside the shore so banks do not count as texture. Image rows turn
// into distance along the lake's plane from the view's height above it.
//   detail: spread (sRGB codes) along an image row, each row's mean removed, so
//           it is texture, not the gradient from near to far;
//   lum / rgb: mean colour of the band;
//   sync: frame t2 against the first: |mean change| / spread of the change.
//         Far above 1 means the whole surface moved together, not its waves.
//         Changes under one code round away: it cannot tell then.
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { readPng } from '../riverMetrics/png.js';

const [dir, viewsPath] = process.argv.slice(2);
const { views } = JSON.parse(fs.readFileSync(viewsPath, 'utf8'));
const BANDS = [0, 150, 300, 600, 1200, 2400, 5000, 1e9];
const FOV_Y = 75 * Math.PI / 180;
const ERODE = 6;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

function waterMask(im) {
    const { w, h, px } = im;
    let m = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) m[k] = px[k * 3 + 2] > 100 && px[k * 3] < 60 && px[k * 3 + 1] < 60 ? 1 : 0;
    for (let e = 0; e < ERODE; e++) {
        const n = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const k = y * w + x;
            n[k] = m[k] & m[k - 1] & m[k + 1] & m[k - w] & m[k + w];
        }
        m = n;
    }
    return m;
}

for (const v of views) {
    const file = n => path.join(dir, `${v.name}${n}.png`);
    if (!fs.existsSync(file('-dbgw7'))) continue;
    const im = readPng(fs.readFileSync(file('')));
    const t2 = fs.existsSync(file('-look-t2')) ? readPng(fs.readFileSync(file('-look-t2'))) : null;
    const m = waterMask(readPng(fs.readFileSync(file('-dbgw7'))));
    const { w, h, px } = im;
    const up = unit(v.pos), fwd = unit(sub(v.look, v.pos));
    const right = unit([fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]]);
    const camUp = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const tanY = Math.tan(FOV_Y / 2);
    const bands = BANDS.slice(1).map(() => ({ n: 0, rgb: [0, 0, 0], l: 0, sq: 0, dn: 0, d: 0, d2: 0 }));
    for (let y = 0; y < h; y++) {
        const ny = (1 - 2 * (y + 0.5) / h) * tanY;
        const ray = unit(fwd.map((c, i) => c + camUp[i] * ny));
        const down = -dot(ray, up);
        if (down <= 0) continue;
        const dist = v.heightM / down;
        const b = bands[BANDS.findIndex((t, i) => dist >= t && dist < BANDS[i + 1])];
        if (!b) continue;
        let n = 0, s = 0;
        for (let x = 0; x < w; x++) if (m[y * w + x]) { n++; s += lum(px, (y * w + x) * 3); }
        if (n < 24) continue;
        const mean = s / n;
        for (let x = 0; x < w; x++) if (m[y * w + x]) {
            const i = (y * w + x) * 3, l = lum(px, i);
            b.n++; b.l += l; b.sq += (l - mean) ** 2;
            for (let c = 0; c < 3; c++) b.rgb[c] += px[i + c];
            if (t2) { const d = lum(t2.px, i) - l; b.dn++; b.d += d; b.d2 += d * d; }
        }
    }
    console.log(v.name);
    bands.forEach((b, k) => {
        if (b.n < 500) return;
        const label = `${BANDS[k]}-${BANDS[k + 1] > 1e8 ? '' : BANDS[k + 1]} m`.padEnd(13);
        const rgb = b.rgb.map(c => (c / b.n).toFixed(0).padStart(3)).join(' ');
        const dm = b.dn ? b.d / b.dn : 0, ds = b.dn ? Math.sqrt(Math.max(b.d2 / b.dn - dm * dm, 0)) : 0;
        console.log(`  ${label} px ${String(b.n).padStart(7)}  rgb ${rgb}  detail ${Math.sqrt(b.sq / b.n).toFixed(2).padStart(5)}  change ${dm.toFixed(2).padStart(6)} +- ${ds.toFixed(2).padStart(5)}  sync ${(Math.abs(dm) / Math.max(ds, 0.01)).toFixed(1).padStart(5)}`);
    });
}
