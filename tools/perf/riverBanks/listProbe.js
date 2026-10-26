// tools/perf/riverBanks/listProbe.js
//
// Page side (pageProbe.mjs): does the GPU river lookup see each river along
// its own channel? CPU mirror of waterWgsl.js waterRiverList: at samples on
// the channel's centre line, the sub-cell's segment list (WaterGpuData index
// and segment buffers), whether it holds the river, and which river the
// nearest listed segment belongs to (the carve's shore materials use it).

import { RIVER_SEG_FLOATS, RIVER_SUB } from '/core/world/water/waterWgsl.js';
import { dirToCellSub } from '/core/world/hydrology/waterGraph.js';

export async function listAt(view) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, N = w.N, SS = RIVER_SUB * RIVER_SUB;
    const o = g.planetConfig.origin, p = g.camera.position, cam = [p.x - o.x, p.y - o.y, p.z - o.z];
    const F = RIVER_SEG_FLOATS, segs = w._segs, index = w.index, cells = w.cells;
    const segRiver = (i) => segs[i * F + 22];
    const lineDist = (i, d) => {
        const a = [segs[i * F], segs[i * F + 1], segs[i * F + 2]], b = [segs[i * F + 4], segs[i * F + 5], segs[i * F + 6]];
        const ab = b.map((v, k) => v - a[k]), ad = d.map((v, k) => v - a[k]);
        const t = Math.max(0, Math.min(1, (ad[0] * ab[0] + ad[1] * ab[1] + ad[2] * ab[2]) / Math.max(1e-20, ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
        return Math.hypot(...d.map((v, k) => v - (a[k] + ab[k] * t))) * R;
    };
    const out = [];
    for (const [rid, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        const at = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
        if (![...Array(n).keys()].some(k => { const r = R + P[k * st + 3]; const d = at(k); return Math.hypot(d[0] * r - cam[0], d[1] * r - cam[1], d[2] * r - cam[2]) < 1500; })) continue;
        const runs = [];
        let run = null, samples = 0;
        for (let k = 0; k + 1 < n; k++) {
            const a = at(k), b = at(k + 1), L = Math.max(1, Math.round((arc[k + 1] - arc[k]) / 2));
            for (let i = 0; i < L; i++, samples++) {
                const t = i / L, l = Math.hypot(...a.map((v, m) => v + (b[m] - v) * t));
                const d = a.map((v, m) => (v + (b[m] - v) * t) / l);
                const id = dirToCellSub(d, N, RIVER_SUB), c = Math.floor(id / SS), sub = id % SS;
                const block = index[cells + c] & 0x1ffff;
                const e = block ? index[2 * cells + (block - 1) * SS + sub] : 0, first = e >>> 8, count = e & 0xff;
                let has = false, near = -1, nearD = Infinity;
                for (let q = first; q < first + count; q++) {
                    if (segRiver(q) === rid) has = true;
                    const dd = lineDist(q, d);
                    if (dd < nearD) { nearD = dd; near = segRiver(q); }
                }
                const bad = !has || near !== rid;
                const why = !block ? 'no block' : !count ? 'empty list' : !has ? 'river not listed' : `nearest is ${near}`;
                const sArc = Math.round(arc[k] + (arc[k + 1] - arc[k]) * t);
                if (bad && (!run || run.why !== why)) { if (run) runs.push(run); run = { why, s0: sArc, count }; }
                if (bad) run.s1 = sArc;
                if (!bad && run) { runs.push(run); run = null; }
            }
        }
        if (run) runs.push(run);
        out.push({ rid, lengthM: Math.round(arc[n - 1]), samples, inGpu: w._appliedRivers?.has?.(rid), runs });
    }
    return out;
}
