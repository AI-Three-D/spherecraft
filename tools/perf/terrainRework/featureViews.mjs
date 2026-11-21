// Camera poses with a clear line of sight to a feature, from two dumped
// height maps of the same area (shoot.mjs maps with dump: true), feature off
// and on. The feature centre is the largest height gain; for each requested
// (distance, height above ground) the azimuth with the best clearance over
// the "on" map is chosen, with a seeded random tie-break.
//
//   node tools/perf/terrainRework/featureViews.mjs off.json on.json name [seed]
// Prints JSON poses for shoot.mjs / captureComparison.mjs. Plan entries are
// [label, distance / extent, height above ground (m), aim below the peak as a
// fraction of the gain].
import fs from 'node:fs';

const [offFile, onFile, name = 'feature', seedArg = '1'] = process.argv.slice(2);
const off = JSON.parse(fs.readFileSync(offFile, 'utf8')), on = JSON.parse(fs.readFileSync(onFile, 'utf8'));
const { px, size, n, e1, e2, radius, origin } = on;
const cell = size / (px - 1);
let best = -Infinity, bi = 0;
for (let k = 0; k < px * px; k++) {
    const d = on.heights[k] - off.heights[k];
    if (d > best) { best = d; bi = k; }
}
// Centre: gain-weighted centroid of the area gaining > 30 % of the peak (for
// a cone the summit, for a caldera its floor rather than a point on the rim).
let sx = 0, sy = 0, sw = 0;
for (let k = 0; k < px * px; k++) {
    const d = on.heights[k] - off.heights[k];
    if (d > best * 0.3) { sx += (k % px) * d; sy += Math.floor(k / px) * d; sw += d; }
}
const ci = sx / sw, cj = sy / sw;
const cx = (ci - (px - 1) / 2) * cell, cy = ((px - 1) / 2 - cj) * cell;
const Hm = (x, y) => {
    const i = Math.round(x / cell + (px - 1) / 2), j = Math.round((px - 1) / 2 - y / cell);
    if (i < 0 || j < 0 || i >= px || j >= px) return null;
    return on.heights[j * px + i];
};
// Feature extent: radius where the gain falls below 10 % of the peak.
let extent = 0;
for (let k = 0; k < px * px; k++) {
    if (on.heights[k] - off.heights[k] > best * 0.1) {
        const x = (k % px - (px - 1) / 2) * cell, y = ((px - 1) / 2 - Math.floor(k / px)) * cell;
        extent = Math.max(extent, Math.hypot(x - cx, y - cy));
    }
}
const top = Hm(cx, cy);
// Highest point of the feature (summit or caldera rim), for sight lines.
let peakH = -Infinity;
for (let k = 0; k < px * px; k++) if (on.heights[k] - off.heights[k] > best * 0.3) peakH = Math.max(peakH, on.heights[k]);
let seed = +seedArg;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const world = (x, y, h) => {
    const d = n.map((v, k) => v * radius + e1[k] * x + e2[k] * y), l = Math.hypot(...d);
    return d.map((v, k) => +(origin[k] + v / l * (radius + h)).toFixed(1));
};
// [label, distance as multiple of the extent, height above ground (m), target height above the summit]
// FV_PLAN (JSON, same shape) overrides it.
const plan = process.env.FV_PLAN ? JSON.parse(process.env.FV_PLAN)
    : [['ground', 1.25, 25, -0.45], ['low', 1.1, 400, -0.3], ['mid', 1.6, 2500, -0.4], ['high', 1.4, 15000, -1.0], ['top', 0.25, 600, -0.05]];
const poses = [];
for (const [label, mult, above, tgt] of plan) {
    const dist = Math.max(1500, extent * mult);
    let bestAz = null;
    for (let a = 0; a < 48; a++) {
        const az = (a / 48 + rnd() * 0.01) * Math.PI * 2;
        const px0 = cx + Math.cos(az) * dist, py0 = cy + Math.sin(az) * dist;
        const g = Hm(px0, py0);
        if (g === null || g < 5) continue; // stay inside the map, on land
        // 'top' looks down into the summit (crater, caldera) from above it.
        const camH = label === 'top' ? Math.max(g + above, peakH + 700) : g + above;
        const tH = label === 'top' ? top : peakH + tgt * best;
        // Clearance of the sight line to the summit (the aim point tH lies
        // inside the feature below it).
        let clear = Infinity;
        for (let s = 0.05; s < 0.95; s += 0.025) {
            const h = Hm(px0 + (cx - px0) * s, py0 + (cy - py0) * s);
            if (h === null) continue;
            clear = Math.min(clear, camH + (peakH + 20 - camH) * s - h);
        }
        if (!bestAz || clear > bestAz.clear) bestAz = { clear, az, camH, tH, px0, py0 };
    }
    if (!bestAz) continue;
    poses.push({ name: `${name}-${label}`, position: world(bestAz.px0, bestAz.py0, bestAz.camH),
        target: world(cx, cy, bestAz.tH), info: { clearanceM: Math.round(bestAz.clear), distM: Math.round(dist) } });
}
console.log(JSON.stringify({ name, gainM: Math.round(best), extentM: Math.round(extent), summitM: top, poses }, null, 1));
