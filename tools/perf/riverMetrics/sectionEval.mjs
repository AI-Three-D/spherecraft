/* global process */
// The river cross-section function (riverSection.js, river redesign R2) on
// real rivers' natural ground, offline, against the ground the tiles draw
// today (same stations, same metrics):
//
//   node tools/perf/riverMetrics/sectionEval.mjs RUN_DIR [--drawn]
//
// --drawn (a run whose terrain is carved with the function, river redesign
// R3): the function with the record's own half-width and curvature and the
// channel's wobble, against the ground the tiles draw: the carve's error.
//
// For every river a waterViews.mjs metrics view saved (stations, natural
// sections, traced record): the half-width from the record's discharge
// (riverShape) x riverWidthFactor (scaled to its typical width), bank types from the bends (curvature of
// the stations' line) and the noise, the record's bed, depth and skew, and
// the natural ground h0 at each offset. The channel's centre is taken on the
// traced line (no wobble), and mouths keep no flare. Writes
// RUN_DIR/section-eval.json and prints today vs the function.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lod0Spacing } from './riverSections.js';
import { sectionMetrics, summarizeRiver } from './sectionMetrics.js';
import { RIVER_SECTION, riverBankParams, riverBankType, riverSectionHeight, riverWidthFactor } from '../../../core/world/water/riverSection.js';
import { RIVER_SHAPE_DEFAULTS, riverShape } from '../../../core/world/hydrology/riverRefine.js';
import { RIVER_CARVE_DEFAULTS, riverNoise } from '../../../core/world/water/riverShapeNoise.js';
import { quantile } from './sectionMetrics.js';
import { MOUNTAIN_LAKE_DEFAULTS } from '../../../core/world/hydrology/mountainLakes.js';

const dir = path.resolve(process.argv[2] ?? ''), drawn = process.argv.includes('--drawn');
const gz = (f) => { const b = zlib.gunzipSync(fs.readFileSync(f)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const out = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('-stations.json')).sort()) {
    const base = path.join(dir, f.replace(/-stations\.json$/, ''));
    if (!fs.existsSync(`${base}-record.f32.gz`)) continue;
    const [, name, rid] = path.basename(base).match(/^(.*)-river(\d+)$/), river = Number(rid);
    const st = JSON.parse(fs.readFileSync(`${base}-stations.json`, 'utf8'));
    const today = JSON.parse(fs.readFileSync(`${base}-metrics.json`, 'utf8')).summary;
    const sec = gz(`${base}-sections.f32.gz`), rec = gz(`${base}-record.f32.gz`), rs = st.recordStride;
    const n = st.s.length, c = st.count, H0 = sec.subarray(n * c);
    // The record's arc length (as the stations: chord sum x R).
    const m = rec.length / rs, arc = new Float64Array(m);
    for (let k = 1; k < m; k++) arc[k] = arc[k - 1] + Math.hypot(rec[k * rs] - rec[(k - 1) * rs], rec[k * rs + 1] - rec[(k - 1) * rs + 1], rec[k * rs + 2] - rec[(k - 1) * rs + 2]) * st.R;
    let k = 0;
    const at = (s, field) => {
        while (k > 0 && arc[k] > s) k--;
        while (k < m - 2 && arc[k + 1] < s) k++;
        const t = Math.min(1, Math.max(0, (s - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])));
        return rec[k * rs + field] + (rec[(k + 1) * rs + field] - rec[k * rs + field]) * t;
    };
    // Mountain streams take the narrower stream shape (as the trace).
    const mountain = name.startsWith('m-strip') || name.startsWith('m-shot') || name.startsWith('m-s1');
    const shapeP = mountain ? { ...RIVER_SHAPE_DEFAULTS, ...MOUNTAIN_LAKE_DEFAULTS.streamShape } : RIVER_SHAPE_DEFAULTS;
    // Signed curvature of the stations' line over +-32 m (+ turning left).
    const kappaAt = (q) => {
        const a = Math.max(0, q - 8), b = Math.min(n - 1, q + 8);
        if (b - a < 4) return 0;
        const d = (i) => st.dir.slice(3 * i, 3 * i + 3), A = d(a), B = d(q), C = d(b);
        const f0 = A.map((x, i) => B[i] - x), f1 = B.map((x, i) => C[i] - x);
        const l0 = Math.hypot(...f0), l1 = Math.hypot(...f1);
        if (!(l0 > 0 && l1 > 0)) return 0;
        const cr = [f0[1] * f1[2] - f0[2] * f1[1], f0[2] * f1[0] - f0[0] * f1[2], f0[0] * f1[1] - f0[1] * f1[0]];
        return ((cr[0] * B[0] + cr[1] * B[1] + cr[2] * B[2]) / (l0 * l1)) / (0.5 * (l0 + l1) * st.R);
    };
    // The river's typical width (median over its record) sets its width noise's scale.
    const widths = []; for (let j = 0; j < m; j++) widths.push(riverShape(rec[j * rs + 7], 0.001, shapeP).width);
    widths.sort((x, y) => x - y);
    const typicalW = widths[widths.length >> 1];
    const rows = [], h = new Float64Array(c), H = sec.subarray(0, n * c), errs = [];
    for (let q = 0; q < n; q++) {
        const s = st.s[q], wl = st.wl[q], Qm3s = at(s, 7), depth = at(s, 5) / RIVER_SECTION.waterFrac, skew = at(s, 10);
        const hw = drawn ? Math.max(at(s, 4), 0.5) : 0.5 * riverShape(Qm3s, 0.001, shapeP).width * riverWidthFactor(s, river, typicalW).f;
        const kappa = drawn ? at(s, 12) : kappaAt(q);
        // The channel's centre wanders off the traced line (waterWgsl.js waterRiverPoint).
        const off = drawn ? RIVER_CARVE_DEFAULTS.wobble * hw * riverNoise(s, river, 'wobble').v : 0;
        const left = riverBankParams(riverBankType(s, river, true, kappa), river), right = riverBankParams(riverBankType(s, river, false, kappa), river);
        const h0 = H0.subarray(q * c, (q + 1) * c);
        for (let i = 0; i < c; i++) {
            const nLine = (i - st.N) * st.dn;
            h[i] = riverSectionHeight({ n: nLine - off, hw, bed: wl - RIVER_SECTION.waterFrac * depth, depth, skew, h0: h0[i], left, right });
            if (drawn && st.pool[q] >= 0 && Math.abs(nLine) < Math.min(hw + RIVER_SECTION.reachM, nLine >= 0 ? st.extentL[q] : st.extentR[q])) errs.push(Math.abs(H[q * c + i] - h[i]));
        }
        const spacing = lod0Spacing(st.dir.slice(3 * q, 3 * q + 3), st.R, st.maxDepth, st.segments);
        const mm = sectionMetrics({ h, h0, dn: st.dn, wl, extentL: st.extentL[q], extentR: st.extentR[q], spacing });
        rows.push({ ...mm, s, inLake: st.pool[q] < 0, spacing });
    }
    const fn = summarizeRiver(rows, { stepM: st.stepM });
    out[name] = { rid: river, today, fn };
    if (drawn) out[name].carveError = { samples: errs.length, p50: quantile(errs, 0.5), p99: quantile(errs, 0.99), max: errs.reduce((a, b) => Math.max(a, b), 0) };
    const r2 = (x) => (x == null ? '-' : (Math.round(x * 100) / 100).toString());
    const line = (label, S) => {
        const L = S.sides.left, R = S.sides.right, cls = (b) => `${r2(b.classes.high ?? b.classes.cut)}/${r2(b.classes.low)}/${r2(b.classes.none)}`;
        return `  ${label.padEnd(9)} width p90/p10 ${r2(S.width.ratio9010)} | classes high/low/none L ${cls(L)} R ${cls(R)} | blend>=50 L ${r2(L.blend50)} R ${r2(R.blend50)} | sides differ ${r2(S.sidesDiffer)} | teeth p90 ${r2(S.teeth?.p90)} max ${r2(S.teeth?.max)} | trench p50 ${r2(S.trench.p50)}`;
    };
    console.log(`${name} (river ${river})`);
    console.log(line('today', today));
    console.log(line('function', fn));
    if (drawn) console.log(`  carve - function: p50 ${r2(out[name].carveError.p50)} p99 ${r2(out[name].carveError.p99)} max ${r2(out[name].carveError.max)} m (${errs.length} samples)`);
}
fs.writeFileSync(path.join(dir, drawn ? 'section-eval-drawn.json' : 'section-eval.json'), JSON.stringify(out, null, 1));
