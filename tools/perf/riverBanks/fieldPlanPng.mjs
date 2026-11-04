// node fieldPlanPng.mjs report.json OUTDIR: writes the fieldPlan probes' images as PNGs.
import fs from 'node:fs';
import path from 'node:path';
import { writePng } from '../riverMetrics/png.js';
const [reportFile, outDir] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
for (const [label, v] of Object.entries(r.probes ?? {})) {
    if (!v?.shade) continue;
    for (const k of ['shade', 'wet', 'delta']) fs.writeFileSync(path.join(outDir, `${label.replace(/\//g, '-')}-${k}.png`), writePng(v.px, v.px, Buffer.from(v[k], 'base64')));
}
