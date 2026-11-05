// tools/perf/riverBanks/widthProbe.js
//
// River widths as traced (record points, field 4 = half-width): per river
// its min / median / max width (m) and the share of points narrower than
// given widths, over every river the water service holds.
export async function widthProbe({ under = [4, 6, 8, 12] } = {}) {
    const svc = window.gameEngine.waterService, all = [], rivers = [];
    for (const [id, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride, w = [];
        for (let k = 0; k < P.length / st; k++) if (P[k * st + 9] >= 0) w.push(2 * P[k * st + 4]);
        if (!w.length) continue;
        w.sort((a, b) => a - b);
        all.push(...w);
        rivers.push({ id, n: w.length, min: +w[0].toFixed(1), median: +w[w.length >> 1].toFixed(1), max: +w[w.length - 1].toFixed(1) });
    }
    all.sort((a, b) => a - b);
    const q = (p) => +all[Math.floor(p * (all.length - 1))].toFixed(1);
    return { rivers: rivers.length, points: all.length,
        quantiles: { p1: q(0.01), p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
        shareUnder: Object.fromEntries(under.map(u => [u, +(all.filter(x => x < u).length / all.length).toFixed(3)])),
        riverMedians: (m => ({ p10: m[Math.floor(0.1 * (m.length - 1))], p25: m[Math.floor(0.25 * (m.length - 1))], p50: m[m.length >> 1], p75: m[Math.floor(0.75 * (m.length - 1))], p90: m[Math.floor(0.9 * (m.length - 1))] }))(rivers.map(r => r.median).sort((a, b) => a - b)),
        maxOverMin: rivers.map(r => r.max / r.min).sort((a, b) => a - b).filter((_, i, a) => i === 0 || i === a.length >> 1 || i === a.length - 1).map(x => +x.toFixed(1)),
        narrowest: rivers.sort((a, b) => a.min - b.min).slice(0, 5) };
}

// Widths as drawn: across every baked river each stepM along it, the run of wet field
// texels at its centre (sdf > 0, not lake water), so meanders, widening and banks count.
// Length-weighted, so a long thin river weighs what it shows. Rivers with no wet run
// across most of their stations are reported apart.
// pinches: stations (every stepM) where the water is under pinchShare of its width a
// little way up and down the river, or missing: land bridges and necks, wherever they are.
export async function bakedWidths({ stepM = 24, reachM = 160, under = [10, 16, 24, 32, 48], pinchShare = 0.45 } = {}) {
    const { sampleRiverField } = await import('/core/world/water/riverField.js');
    const g = window.gameEngine, svc = g.riverFieldService, s = g.waterService, w = g.waterGpuData, L = svc.layout, R = L.R;
    const all = [], perRiver = [], pinches = [];
    const wet = d => { const f = sampleRiverField(svc.pages, L, d); return f && f.sdf > 0; };
    const at = (d, e, m) => { const v = d.map((x, i) => x + e[i] * m / R), l = Math.hypot(...v); return v.map(x => x / l); };
    for (const [id, rec] of s.riverRecs) {
        if (!svc.rivers.has(id)) continue;
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec), own = [], line = [];
        let next = 0;
        for (let k = 1; k < n - 1; k++) {
            if (arc[k] < next || P[k * st + 9] < -0.5) continue;
            next = arc[k] + stepM;
            const d = [P[k * st], P[k * st + 1], P[k * st + 2]], a = (k - 1) * st, b = (k + 1) * st;
            const t = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
            const nrm = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]], l = Math.hypot(...nrm) || 1;
            const e = nrm.map(v => v / l);
            // The run nearest the trace's line: a meander may have moved it aside.
            let start = null;
            for (let m = 0; m <= reachM && start === null; m += 2) for (const sgn of [1, -1]) if (wet(at(d, e, sgn * m))) { start = sgn * m; break; }
            if (start === null) { line.push({ s: arc[k], width: 0, d }); continue; }
            if (w.lakeEdgeAt?.(at(d, e, start))?.inside > 0) continue;
            let lo = start, hi = start;
            while (hi - start < 400 && wet(at(d, e, hi + 2))) hi += 2;
            while (start - lo < 400 && wet(at(d, e, lo - 2))) lo -= 2;
            own.push(hi - lo + 2);
            line.push({ s: arc[k], width: hi - lo + 2, d });
        }
        // Against the wider of the widths two to four stations each way along it.
        line.forEach((q, i) => {
            const near = [i - 4, i - 3, i - 2, i + 2, i + 3, i + 4].map(j => line[j]?.width ?? 0);
            const up = Math.max(...near.slice(0, 3)), down = Math.max(...near.slice(3));
            if (Math.min(up, down) > 0 && q.width < pinchShare * Math.min(up, down)) pinches.push({ id, s: Math.round(q.s), of: Math.round(arc[n - 1]), width: q.width, up, down, dir: q.d.map(v => +v.toFixed(6)) });
        });
        if (!own.length) continue;
        all.push(...own);
        own.sort((a, b) => a - b);
        perRiver.push({ id, stations: own.length, median: own[own.length >> 1], max: own[own.length - 1] });
    }
    all.sort((a, b) => a - b);
    const q = p => all.length ? all[Math.floor(p * (all.length - 1))] : 0;
    const medians = perRiver.map(r => r.median).sort((a, b) => a - b);
    return { rivers: perRiver.length, stations: all.length, quantiles: { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99) },
        riverMedians: { p10: medians[Math.floor(0.1 * (medians.length - 1))], p50: medians[medians.length >> 1], p90: medians[Math.floor(0.9 * (medians.length - 1))] },
        shareUnder: Object.fromEntries(under.map(u => [u, +(all.filter(x => x < u).length / Math.max(all.length, 1)).toFixed(3)])), pinchCount: pinches.length, pinches, perRiver: perRiver.sort((a, b) => a.median - b.median) };
}
