/* global process, Buffer */
// Seams in the carved ground on patches a waterViews.mjs view sampled
// (river redesign R3b, carveSeams.js):
//
//   node tools/perf/riverMetrics/carvePatches.mjs RUN_DIR
//
// The view's eval returns { N, sp, patches: { name: { carved, plain } } }
// (base64 Float32 heights, views-carve-seams.json). Writes per patch
// RUN_DIR/patch-<name>.png (hillshade, carve depth blue, seams red; north
// up = +e2) and RUN_DIR/carve-seams.json, and prints the counts.
import fs from 'node:fs';
import path from 'node:path';
import { carveSeams, seamImage } from './carveSeams.js';
import { writePng } from './png.js';

const dir = path.resolve(process.argv[2] ?? '');
const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
const out = {};
for (const [key, val] of Object.entries(report)) {
    if (!key.startsWith('eval_') || !val?.patches) continue;
    const { N, sp } = val;
    for (const [name, p] of Object.entries(val.patches)) {
        const f32 = (b) => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
        const h = f32(p.carved), h0 = f32(p.plain);
        const s = carveSeams(h, h0, N, N);
        let carved = 0, maxCut = 0;
        for (let i = 0; i < h.length; i++) { const c = h0[i] - h[i]; if (c > 0.01) carved++; maxCut = Math.max(maxCut, c); }
        // Image rows from +y down (north up).
        const img = seamImage(h, h0, N, N, sp, s), flip = new Uint8Array(img.length);
        for (let y = 0; y < N; y++) flip.set(img.subarray((N - 1 - y) * N * 3, (N - y) * N * 3), y * N * 3);
        fs.writeFileSync(path.join(dir, `patch-${name}.png`), writePng(N, N, flip));
        out[name] = { seams: s.count, seamLengthM: +(s.count * sp).toFixed(1), maxJumpM: +s.maxJumpM.toFixed(2), carvedShare: +(carved / h.length).toFixed(3), maxCutM: +maxCut.toFixed(2), sizeM: N * sp, spacingM: sp };
        console.log(`${name.padEnd(12)} seams ${String(s.count).padStart(5)} (${(s.count * sp).toFixed(0)} m) max jump ${s.maxJumpM.toFixed(2)} m | carved ${(100 * carved / h.length).toFixed(1)} % max cut ${maxCut.toFixed(1)} m`);
    }
}
fs.writeFileSync(path.join(dir, 'carve-seams.json'), JSON.stringify(out, null, 1));
