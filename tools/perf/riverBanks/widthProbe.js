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
        maxOverMin: rivers.map(r => r.max / r.min).sort((a, b) => a - b).filter((_, i, a) => i === 0 || i === a.length >> 1 || i === a.length - 1).map(x => +x.toFixed(1)),
        narrowest: rivers.sort((a, b) => a.min - b.min).slice(0, 5) };
}
