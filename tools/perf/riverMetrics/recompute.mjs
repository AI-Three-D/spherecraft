/* global process */
// River metrics again from a run's raw sections, without the GPU, with the
// definitions as they are now (sectionMetrics.js):
//
//   node tools/perf/riverMetrics/recompute.mjs RUN_DIR
//
// Reads every <name>-river<id>-stations.json and -sections.f32.gz that
// waterViews.mjs metrics views wrote, and writes RUN_DIR/metrics-recomputed.json
// ({ "<name>": { rid, summary } }). The run's own files are left as they were.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lod0Spacing } from './riverSections.js';
import { sectionMetrics, summarizeRiver } from './sectionMetrics.js';

const dir = path.resolve(process.argv[2] ?? '');
const out = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('-stations.json')).sort()) {
    const base = path.join(dir, f.replace(/-stations\.json$/, ''));
    const [, name, rid] = path.basename(base).match(/^(.*)-river(\d+)$/);
    const st = JSON.parse(fs.readFileSync(`${base}-stations.json`, 'utf8'));
    const raw = zlib.gunzipSync(fs.readFileSync(`${base}-sections.f32.gz`));
    const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), n = st.s.length, c = st.count;
    const rows = [];
    for (let q = 0; q < n; q++) {
        const spacing = lod0Spacing(st.dir.slice(3 * q, 3 * q + 3), st.R, st.maxDepth, st.segments);
        const m = sectionMetrics({ h: all.subarray(q * c, (q + 1) * c), h0: all.subarray((n + q) * c, (n + q + 1) * c),
            dn: st.dn, wl: st.wl[q], extentL: st.extentL[q], extentR: st.extentR[q], spacing });
        rows.push({ ...m, s: st.s[q], inLake: st.pool[q] < 0, spacing });
    }
    out[name] = { rid: Number(rid), summary: summarizeRiver(rows, { stepM: st.stepM }) };
}
fs.writeFileSync(path.join(dir, 'metrics-recomputed.json'), JSON.stringify(out, null, 1));
console.log(`${Object.keys(out).length} rivers -> ${path.join(dir, 'metrics-recomputed.json')}`);
