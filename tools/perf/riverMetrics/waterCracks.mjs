// node waterCracks.mjs DIR [minPixels]: thin gaps in the water of each pose in an
// armReview output. Water = pixels where NAME.png differs from NAME-dbgw10.png;
// a crack = a run of non-water pixels with strong water (not a shore's soft fade)
// within GAP pixels on both sides along one axis. Reports connected runs of at
// least minPixels that are at least four times longer than they are wide.
import fs from 'node:fs';
import path from 'node:path';
import { readPng } from './png.js';
const [dir, minArg] = process.argv.slice(2), minPixels = Number(minArg ?? 10), T = 18, STRONG = 40, GAP = 3;
const axes = [[1, 0], [0, 1], [1, 1], [1, -1]];
let total = 0;
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.png') && !n.includes('-dbg')).sort()) {
    const name = f.slice(0, -4), dryFile = path.join(dir, name + '-dbgw10.png');
    if (!fs.existsSync(dryFile)) continue;
    const a = readPng(fs.readFileSync(path.join(dir, f))), b = readPng(fs.readFileSync(dryFile)), W = a.w, H = a.h;
    const water = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
        const d = Math.max(Math.abs(a.px[i * 3] - b.px[i * 3]), Math.abs(a.px[i * 3 + 1] - b.px[i * 3 + 1]), Math.abs(a.px[i * 3 + 2] - b.px[i * 3 + 2]));
        water[i] = d > STRONG ? 2 : d > T ? 1 : 0;
    }
    const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && water[y * W + x] === 2;
    const crack = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (water[y * W + x]) continue;
        for (const [dx, dy] of axes) {
            let p = false, n = false;
            for (let k = 1; k <= GAP; k++) { p ||= at(x + dx * k, y + dy * k); n ||= at(x - dx * k, y - dy * k); }
            if (p && n) { crack[y * W + x] = 1; break; }
        }
    }
    const seen = new Uint8Array(W * H), runs = [];
    for (let s = 0; s < W * H; s++) {
        if (!crack[s] || seen[s]) continue;
        const stack = [s]; seen[s] = 1;
        let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
        while (stack.length) {
            const q = stack.pop(), x = q % W, y = (q - x) / W;
            n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                const u = x + dx, v = y + dy, r = v * W + u;
                if (u >= 0 && v >= 0 && u < W && v < H && crack[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
            }
        }
        const len = Math.max(x1 - x0, y1 - y0) + 1;
        if (n >= minPixels && len * len >= 4 * n) runs.push({ n, box: [x0, y0, x1, y1], len });
    }
    runs.sort((p, q) => q.len - p.len);
    total += runs.length;
    if (runs.length) console.log(name.padEnd(26), runs.length, JSON.stringify(runs.slice(0, 4)));
}
console.log('poses with runs listed above; total runs', total);
