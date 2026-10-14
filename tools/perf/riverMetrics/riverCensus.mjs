/* global process */
// How common rivers are, offline from a waterViews.mjs census view
// (owner 2026-10-13: "it's still very hard to find rivers. They should be
// more common"):
//
//   node tools/perf/riverMetrics/riverCensus.mjs RUN_DIR NAME
//
// Rebuilds the water graph from the census grid (checks it gives the
// browser's lake and river counts), then for each set of rivers the land's
// distance to the nearest one (riverCoverage.js): every river the planet
// has (graph rivers, mountain streams), the ones traced (drawn) at the
// census snapshots, more lakes with an outlet river (minRiverQ swept), and
// rivers that also start where the drainage alone collects Q (headwaters,
// not at a lake; against the 2026-10-03 rule that rivers start at lakes).
// Each also by terrain: plains, hills and mountains by the relief over a
// cell's 5 x 5 grid cells (mountainLakes.js gridRelief; mountain streams
// come only from cells of 300 m or more). Writes RUN_DIR/river-census.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildWaterGraph, cellDir, dirToCell } from '../../../core/world/hydrology/waterGraph.js';
import { gridRelief } from '../../../core/world/hydrology/mountainLakes.js';
import { coverage, distanceToCells } from './riverCoverage.js';

const [dir, name] = process.argv.slice(2);
const head = JSON.parse(fs.readFileSync(path.join(dir, `${name}-rivers.json`), 'utf8'));
const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}-grid.f32.gz`)));
const { N, R, seaLevelM, params } = head, total = 6 * N * N;
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const heights = all.subarray(0, total), precip = all.subarray(total, 2 * total);
const km = (m) => (m == null ? null : Math.round(m / 100) / 10);

const t0 = Date.now();
const g = buildWaterGraph({ N, heights, seaLevelM, precip, params });
const browserGraphRivers = head.rivers.filter(r => !r.mountain).length;
const check = { lakes: g.lakes.length, browserLakes: head.stats?.lakeCount, rivers: g.rivers.length, browserRivers: browserGraphRivers, ms: Date.now() - t0 };
console.log('rebuild', JSON.stringify(check));

const land = new Uint8Array(total);
for (let c = 0; c < total; c++) land[c] = heights[c] > seaLevelM && g.lakeOf[c] === -1 ? 1 : 0;
// Terrain classes by relief (m): plains < 100, hills 100-300, mountains >= 300.
const relief = gridRelief(heights, N), TERRAIN = { plains: [0, 100], hills: [100, 300], mountains: [300, Infinity] };
const terrainMask = Object.fromEntries(Object.entries(TERRAIN).map(([k, [a, b]]) =>
    [k, Uint8Array.from(land, (l, c) => (l && relief[c] >= a && relief[c] < b ? 1 : 0))]));
const terrainOf = (c) => Object.keys(TERRAIN).find(k => relief[c] >= TERRAIN[k][0] && relief[c] < TERRAIN[k][1]);
const lakesByTerrain = (graph) => Object.fromEntries(Object.keys(TERRAIN).map(k => {
    const ls = graph.lakes.filter(l => terrainOf(l.outletCell) === k);
    return [k, { lakes: ls.length, withRiver: ls.filter(l => l.river >= 0).length }];
}));
const spawnCell = (() => { const p = head.pose.position, l = Math.hypot(p.x, p.y, p.z); return dirToCell([p.x / l, p.y / l, p.z / l], N); })();
const cellLen = (cells) => { let s = 0; for (let k = 1; k < cells.length; k++) { const a = cellDir(cells[k - 1], N), b = cellDir(cells[k], N); s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * R; } return s; };
const measure = (label, riverCells, extra = {}) => {
    const set = new Set();
    for (const cells of riverCells) for (const c of cells) set.add(c);
    const dist = distanceToCells(N, R, set);
    const cov = coverage(dist, land);
    const row = { label, ...extra, cells: set.size, landP50Km: km(cov.p50), landP90Km: km(cov.p90),
        within2km: cov.within[2000], within5km: cov.within[5000], within10km: cov.within[10000], spawnKm: km(dist[spawnCell]),
        terrain: Object.fromEntries(Object.entries(terrainMask).map(([k, m]) => { const t = coverage(dist, m); return [k, { cells: t.cells, p50Km: km(t.p50), within5km: t.within[5000] }]; })) };
    console.log(JSON.stringify(row));
    return row;
};

const landCells = land.reduce((a, b) => a + b, 0);
const out = { check, terrainLandShare: Object.fromEntries(Object.entries(terrainMask).map(([k, m]) => [k, m.reduce((a, b) => a + b, 0) / landCells])),
    lakesByTerrain: lakesByTerrain(g), now: [], minRiverQ: [], headwaters: [] };
const graphRivers = head.rivers.filter(r => !r.mountain), streams = head.rivers.filter(r => r.mountain);
out.now.push(measure('graph rivers (all)', graphRivers.map(r => r.cells), { rivers: graphRivers.length, lengthKm: km(graphRivers.reduce((s, r) => s + cellLen(r.cells), 0)) }));
out.now.push(measure('mountain streams (all)', streams.map(r => r.cells), { rivers: streams.length }));
out.now.push(measure('all rivers', head.rivers.map(r => r.cells), { rivers: head.rivers.length }));
for (const snap of head.snapshots) {
    const ids = new Set(snap.traced), drawn = head.rivers.filter(r => ids.has(r.id));
    out.now.push(measure(`traced at ${Math.round(snap.t / 1000)} s`, drawn.map(r => r.cells),
        { rivers: drawn.length, graph: drawn.filter(r => !r.mountain).length, streams: drawn.filter(r => r.mountain).length }));
}

// More lakes with an outlet river.
for (const q of [1200, 800, 600, 400, 300, 200, 150, 100]) {
    const gq = q === (params.minRiverQ ?? 1200) ? g : buildWaterGraph({ N, heights, seaLevelM, precip, params: { ...params, minRiverQ: q } });
    out.minRiverQ.push(measure(`minRiverQ ${q}`, gq.rivers.map(r => r.cells), { minRiverQ: q, rivers: gq.rivers.length,
        lengthKm: km(gq.rivers.reduce((s, r) => s + cellLen(r.cells), 0)), lakesByTerrain: lakesByTerrain(gq) }));
}

// Headwaters: every land cell whose drainage collects at least q, plus the
// existing graph rivers; heads = such cells with no such cell upstream.
const isChannel = (c, q) => land[c] && g.Q[c] >= q;
for (const q of [1200, 600, 300, 150]) {
    const cells = [], fed = new Uint8Array(total);
    for (let c = 0; c < total; c++) {
        if (!isChannel(c, q)) continue;
        cells.push(c);
        const p = g.parent[c];
        if (p >= 0) fed[p] = 1;
    }
    const heads = cells.filter(c => !fed[c]).length;
    out.headwaters.push(measure(`headwaters Q >= ${q}`, [cells, ...graphRivers.map(r => r.cells)],
        { q, heads, channelKm: km(cells.length * (2 * R / N) * 0.85) }));
}
fs.writeFileSync(path.join(dir, 'river-census.json'), JSON.stringify(out, null, 1));
console.log(`-> ${path.join(dir, 'river-census.json')} (${Math.round((Date.now() - t0) / 1000)} s)`);
