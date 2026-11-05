// What the ground and the water do along a river at a point picked on screen: the ray
// through pixel sx, sy of a pose meets the water, the nearest river is walked through it,
// and each row gives carved and natural ground, W, sdf and lake level on its line, plus
// the wet width across it. Land bridges and pinches at mouths show here as ground over W.
export async function neck({ pos, look, sx, sy, w = 1440, h = 900, fov = 75, levelM = null, spanM = 120, stepM = 4, nearest = 4 }) {
    const { sampleRiverField } = await import('/core/world/water/riverField.js');
    const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, wd = g.waterGpuData, L = svc.layout, R = L.R;
    const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = unit(look.map((v, i) => v - pos[i])), up = unit(pos), right = unit(cross(f, up)), camUp = cross(right, f);
    const k = (h / 2) / Math.tan(fov * Math.PI / 360);
    const ray = unit(f.map((v, i) => v + right[i] * (sx - w / 2) / k - camUp[i] * (sy - h / 2) / k));
    // Hit a sphere at the level (nearest lake's when not given).
    const lv = levelM ?? wd.lakesNear({ x: pos[0], y: pos[1], z: pos[2] }, 4000, 1).map(i => wd.lakeInfo?.(i)?.level)[0] ?? 0;
    let t = 0;
    for (let i = 0; i < 40; i++) t += (Math.hypot(...pos.map((v, j) => v + ray[j] * t)) - (R + lv));
    const hit = unit(pos.map((v, j) => v + ray[j] * t));
    let best = null;
    for (const [id, rec] of s.riverRecs) {
        if (!svc.rivers.has(id)) continue;
        const P = rec.points, st = rec.stride;
        for (let i = 0; i < P.length / st; i++) {
            const d = R * Math.acos(Math.min(1, P[i * st] * hit[0] + P[i * st + 1] * hit[1] + P[i * st + 2] * hit[2]));
            if (!best || d < best.d) best = { d, id, rec, i };
        }
    }
    // Every river within reach of the point, nearest first: what is cutting the ground here.
    const around = [];
    for (const [rid, r] of s.riverRecs) {
        if (!svc.rivers.has(rid)) continue;
        const Q = r.points, q = r.stride, A = wd._arcLengths(r);
        let b = null;
        for (let k = 0; k < Q.length / q; k++) {
            const d = R * Math.acos(Math.min(1, Q[k * q] * hit[0] + Q[k * q + 1] * hit[1] + Q[k * q + 2] * hit[2]));
            if (!b || d < b.d) b = { id: rid, d: +d.toFixed(0), s: Math.round(A[k]), of: Math.round(A[Q.length / q - 1]), hw: +Q[k * q + 4].toFixed(1), level: +Q[k * q + 16].toFixed(2), pool: Q[k * q + 9] };
        }
        if (b) around.push(b);
    }
    around.sort((a, b) => a.d - b.d);
    const { id, rec, i } = best, P = rec.points, st = rec.stride, n = P.length / st, arc = wd._arcLengths(rec);
    const rows = [], dirs = [], meta = [];
    for (let m = -spanM; m <= spanM; m += stepM) {
        // Walk the trace by arc length; past its end carry straight on.
        const s0 = arc[best.i] + m;
        let a = 0;
        while (a < n - 2 && arc[a + 1] < s0) a++;
        const u = (s0 - arc[a]) / Math.max(arc[a + 1] - arc[a], 1e-6);
        const d = unit([0, 1, 2].map(c => P[a * st + c] + (P[(a + 1) * st + c] - P[a * st + c]) * u));
        dirs.push(d[0], d[1], d[2], 0); meta.push({ m, s0, d, hw: P[a * st + 4] + (P[(a + 1) * st + 4] - P[a * st + 4]) * Math.min(Math.max(u, 0), 1), a });
    }
    const carved = await svc.service?._sampler?.sampleDirsCarved?.(Float32Array.from(dirs)) ?? await s._sampler.sampleDirsCarved(Float32Array.from(dirs));
    const natural = await s._sampler.sampleDirsNatural(Float32Array.from(dirs));
    meta.forEach((q, r) => {
        const fld = sampleRiverField(svc.pages, L, q.d), lake = wd.lakeEdgeAt?.(q.d);
        rows.push([q.m, Math.round(q.s0), +q.hw.toFixed(1), +carved[r].toFixed(2), +natural[r].toFixed(2), fld ? +fld.W.toFixed(2) : null, fld ? +(fld.W - carved[r]).toFixed(2) : null, fld ? +fld.sdf.toFixed(1) : null, fld ? +fld.delta.toFixed(2) : null, lake ? +lake.level.toFixed(2) : null, lake ? +lake.inside.toFixed(1) : null]);
    });
    return { around: around.slice(0, nearest), id, nearestM: +best.d.toFixed(1), level: lv, length: +arc[n - 1].toFixed(0), k: best.i, n, srcLake: rec.src, destLake: rec.dest, cols: 'm s hw carved natural W depth sdf delta lakeLevel lakeInside', rows };
}
