// How high channels cut into the ground beside them: at every baked river's stations
// (every stepM) the natural ground at the water's real edge over W, on each side, split
// by distance from a river's end. A wide channel held at its lake's level on a hillside
// is a one-sided cut: the dark faces and points of land at outlets.
export async function bankCuts({ stepM = 8, nearEndM = 80, reachM = 200 } = {}) {
    const { sampleRiverField } = await import('/core/world/water/riverField.js');
    const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, w = g.waterGpuData, L = svc.layout, R = L.R;
    const at = (d, e, m) => { const v = d.map((x, i) => x + e[i] * m / R), l = Math.hypot(...v); return v.map(x => x / l); };
    const wet = d => { const f = sampleRiverField(svc.pages, L, d); return f && f.sdf > 0; };
    const rows = [];
    for (const [id, rec] of s.riverRecs) {
        if (!svc.rivers.has(id)) continue;
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec), total = arc[n - 1], sides = [];
        let next = 0;
        for (let k = 1; k < n - 1; k++) {
            if (arc[k] < next || P[k * st + 9] < -0.5) continue;
            next = arc[k] + stepM;
            const d = [P[k * st], P[k * st + 1], P[k * st + 2]], a = (k - 1) * st, b = (k + 1) * st;
            const t = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
            const nrm = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]], l = Math.hypot(...nrm) || 1, e = nrm.map(v => v / l);
            if (!wet(d) || w.lakeEdgeAt?.(d)?.inside > 0) continue;
            for (const sgn of [1, -1]) {
                let m = 0;
                while (m < reachM && wet(at(d, e, sgn * (m + 2)))) m += 2;
                sides.push({ s: arc[k], dir: at(d, e, sgn * (m + 2)), W: sampleRiverField(svc.pages, L, at(d, e, sgn * m)).W, m });
            }
        }
        if (!sides.length) continue;
        const nat = await s._sampler.sampleDirsNatural(Float32Array.from(sides.flatMap(q => [...q.dir, 0])));
        sides.forEach((q, i) => rows.push({ id, s: Math.round(q.s), end: Math.min(q.s, total - q.s) < nearEndM, hw: q.m, up: nat[i] - q.W }));
    }
    const q = (a, p) => a.length ? +a[Math.floor(p * (a.length - 1))].toFixed(2) : null;
    const sum = (f) => { const a = rows.filter(f).map(r => r.up).sort((x, y) => x - y); return { n: a.length, p50: q(a, .5), p90: q(a, .9), p99: q(a, .99), max: q(a, 1) }; };
    return { nearEnd: sum(r => r.end), along: sum(r => !r.end), worst: rows.sort((a, b) => b.up - a.up).slice(0, 12).map(r => ({ id: r.id, s: r.s, hw: r.hw, up: +r.up.toFixed(1), end: r.end })) };
}
