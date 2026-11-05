// Views of lakes at set distances, for tools/perf/riverBanks/armReview.mjs:
// node lakeViews.mjs DISCOVER_REPORT.json LAKE_ID,LAKE_ID OUT.json
// The report comes from an arm whose eval returns { R, near: [{ id, level,
// areaKm2, c, e1, e2 }] } (qtDiag.water.near's lakes with their frames).
// shore and low: over the lake's centre, looking across it at near eye height
// and from 25 m; mid and high: from outside, looking at the centre, high enough
// to clear the hills around it. Each view carries what lakeMetrics.mjs needs to
// turn image rows into distance: its height above the lake and its level.
import fs from 'node:fs';
import process from 'node:process';

const [reportPath, ids, outPath] = process.argv.slice(2);
const { R, near } = JSON.parse(fs.readFileSync(reportPath, 'utf8')).evalResult;
const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
const round = a => a.map(v => +v.toFixed(1));

const views = [];
for (const id of ids.split(',').map(Number)) {
    const lake = near.find(l => l.id === id);
    if (!lake) throw new Error(`lake ${id} is not in the report`);
    const r = Math.sqrt(lake.areaKm2 * 1e6 / Math.PI);
    const at = (m, h) => unit(add(lake.c, lake.e1, m / R)).map(v => v * (R + lake.level + h));
    for (const [name, m, h, targetM] of [
        ['shore', 0, 6, 1.5 * r],
        ['low', 0, 25, 1.5 * r],
        ['mid', -(r + 800), 450, 0],
        ['high', -(r + 3000), 1600, 0],
    ]) {
        const pos = at(m, h);
        views.push({ name: `lake${id}-${name}`, pos: round(pos), look: round(at(targetM, 0)), up: round(unit(pos)), lake: id, heightM: h, level: lake.level });
    }
}
fs.writeFileSync(outPath, JSON.stringify({ views }, null, 1));
console.log(views.map(v => `${v.name} ${v.pos}`).join('\n'));
