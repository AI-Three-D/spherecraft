/* global process, Buffer */
// Carve near lakes at river starts (river redesign), offline:
//
//   node tools/perf/riverMetrics/startPatches.mjs RUN_DIR
//
// For each 'start<rid>' patch a view's eval sampled (views-owner-look3.json:
// carved and natural ground, 240 m at 0.5 m around the river's first point,
// with the traced records of the rivers nearby): bank spill below the source
// lake's level within 20 m of its natural water (lakeSpill.js) and seams in
// the carve (carveSeams.js). Writes RUN_DIR/start-patches.json.
import fs from 'node:fs';
import path from 'node:path';
import { carveSeams } from './carveSeams.js';
import { channelTest, lakeSpill } from './lakeSpill.js';

const dir = path.resolve(process.argv[2] ?? '');
const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
const f32 = (b) => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const out = {}, total = { spillM2: 0, channelM2: 0, seams: 0 };
for (const [key, ev] of Object.entries(report)) {
    if (!key.startsWith('eval_') || !ev?.patches || !ev.rivers) continue;
    const { N, sp, R } = ev;
    for (const [name, p] of Object.entries(ev.patches)) {
        const rid = Number(name.replace(/^start/, ''));
        if (out[name]) continue;
        const rv = ev.rivers.find(r => r.rid === rid);
        const level = rv?.src?.level;
        if (level == null) continue;
        const toPlane = (d) => { const k = dot(d, p.c); return [dot(d, p.e1) / k * R, dot(d, p.e2) / k * R]; };
        const polys = ev.rivers.map(r => {
            const xy = new Float64Array(2 * r.n), hw = new Float64Array(r.n);
            for (let k = 0; k < r.n; k++) {
                const q = toPlane(r.pts.slice(k * r.st, k * r.st + 3));
                xy[2 * k] = q[0]; xy[2 * k + 1] = q[1]; hw[k] = r.pts[k * r.st + 4];
            }
            return { xy, hw };
        });
        const inCh = channelTest(polys), x0 = -N * sp / 2;
        const h = f32(p.carved), h0 = f32(p.plain);
        const spill = lakeSpill(h, h0, level, (i) => inCh(x0 + (i % N) * sp, x0 + Math.floor(i / N) * sp), sp * sp, { nx: N, spacing: sp });
        const seams = carveSeams(h, h0, N, N);
        out[name] = { level: +level.toFixed(2), ...spill, seams: seams.count, maxJumpM: +seams.maxJumpM.toFixed(2) };
        total.spillM2 += spill.spillM2; total.channelM2 += spill.channelM2; total.seams += seams.count;
        console.log(`${name.padEnd(10)} level ${level.toFixed(2)} | bank spill ${spill.spillM2.toFixed(0)} m2, channel below level ${spill.channelM2.toFixed(0)} m2 | seams ${seams.count} (max ${seams.maxJumpM.toFixed(2)} m)`);
    }
}
console.log(`total bank spill ${total.spillM2.toFixed(0)} m2, seams ${total.seams}`);
fs.writeFileSync(path.join(dir, 'start-patches.json'), JSON.stringify({ patches: out, total }, null, 1));
