// Find camera poses that look along valleys/canyons in a dumped height map
// (shoot.mjs maps entry with dump: true). A candidate floor point is low,
// level along an axis, and has walls rising on both sides of it.
//
//   node tools/perf/terrainRework/valleyViews.mjs map.json [count] [minRiseM] [halfWidthM]
// Prints JSON poses ({name, position, target}) for shoot.mjs.
import fs from 'node:fs';

const [file, countArg = '4', riseArg = '250', halfArg = '1300'] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const { px, size, n, e1, e2, radius, origin, heights } = m;
const cell = size / (px - 1);
const H = (x, y) => {
    const i = x / cell + (px - 1) / 2, j = (px - 1) / 2 - y / cell;
    const i0 = Math.max(0, Math.min(px - 2, Math.floor(i))), j0 = Math.max(0, Math.min(px - 2, Math.floor(j)));
    const fx = Math.min(1, Math.max(0, i - i0)), fy = Math.min(1, Math.max(0, j - j0));
    const h = (a, b) => heights[b * px + a];
    return (h(i0, j0) * (1 - fx) + h(i0 + 1, j0) * fx) * (1 - fy) + (h(i0, j0 + 1) * (1 - fx) + h(i0 + 1, j0 + 1) * fx) * fy;
};
const rise = +riseArg, half = +halfArg, cands = [];
for (let j = 8; j < px - 8; j += 2) for (let i = 8; i < px - 8; i += 2) {
    const x = (i - (px - 1) / 2) * cell, y = ((px - 1) / 2 - j) * cell, h0 = H(x, y);
    if (h0 < 30) continue; // skip sea and shore
    let best = null;
    for (let a = 0; a < 180; a += 12) {
        const t = a * Math.PI / 180, ax = [Math.cos(t), Math.sin(t)], pr = [-ax[1], ax[0]];
        const l = H(x + pr[0] * half, y + pr[1] * half) - h0, r = H(x - pr[0] * half, y - pr[1] * half) - h0;
        let level = 0;
        for (const s of [-1, 1]) level = Math.max(level, Math.abs(H(x + ax[0] * 1500 * s, y + ax[1] * 1500 * s) - h0));
        const score = Math.min(l, r) - level * 0.8;
        if (Math.min(l, r) > rise && (!best || score > best.score)) best = { score, ax, l, r };
    }
    if (best) cands.push({ x, y, h0, ...best });
}
cands.sort((a, b) => b.score - a.score);
const picked = [];
for (const c of cands) {
    if (picked.every(p => Math.hypot(p.x - c.x, p.y - c.y) > size / 6)) picked.push(c);
    if (picked.length >= +countArg) break;
}
const world = (x, y, h) => {
    const d = n.map((v, k) => v * radius + e1[k] * x + e2[k] * y), l = Math.hypot(...d);
    return d.map((v, k) => +(origin[k] + v / l * (radius + h)).toFixed(1));
};
const poses = picked.flatMap((c, k) => {
    const info = { floorM: Math.round(c.h0), wallsM: [Math.round(c.l), Math.round(c.r)], score: Math.round(c.score) };
    const pose = (name, back, ahead, above) => {
        const cx = c.x - c.ax[0] * back, cy = c.y - c.ax[1] * back;
        const camH = Math.max(H(cx, cy), c.h0) + above;
        return { name, position: world(cx, cy, camH),
            target: world(c.x + c.ax[0] * ahead, c.y + c.ax[1] * ahead, c.h0 + 60), info };
    };
    return [pose(`valley${k}`, 2600, 4000, Math.min(c.l, c.r) * 0.9),
        pose(`valley${k}-high`, 4500, 5000, 1500)];
});
console.log(JSON.stringify(poses, null, 1));
