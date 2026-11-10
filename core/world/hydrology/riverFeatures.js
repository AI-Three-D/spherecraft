// Local river features baked into the existing segment records. A waterfall
// redistributes an available downhill drop; it never invents extra elevation
// loss or changes the lakes. Fine samples are added only around its lip.

const clamp01 = x => Math.max(0, Math.min(1, x));
const quintic = x => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };

export const RIVER_FALL_DEFAULTS = Object.freeze({
    enabled: true,
    minDropM: 4,
    maxDropM: 12,
    windowM: 180,
    lengthM: 8,
    minSlope: 0.08,
    minTotalDropM: 100,
    spacingM: 1200,
    lakeMarginM: 300,
    dropShare: 0.7,
    pinch: 0.3,
    poolDepthShare: 0.18,
});

/** Select isolated steep reaches; collapse part of their existing drop into a lip. */
export function riverWaterfalls(points, stride, arc, overrides = {}) {
    const P = { ...RIVER_FALL_DEFAULTS, ...overrides }, n = arc.length;
    if (!P.enabled || n < 3 || points[16] - points[(n - 1) * stride + 16] < P.minTotalDropM) return [];
    const candidates = [];
    let a = 0, b = 0;
    for (let k = 1; k < n - 1; k++) {
        const s = arc[k];
        if (s < P.lakeMarginM + P.windowM || arc[n - 1] - s < P.lakeMarginM + P.windowM) continue;
        while (a + 1 < k && arc[a + 1] < s - P.windowM / 2) a++;
        b = Math.max(b, k + 1);
        while (b < n - 1 && arc[b] < s + P.windowM / 2) b++;
        const hi = points[a * stride + 16], lo = points[b * stride + 16];
        const slope = (points[(k - 1) * stride + 16] - points[(k + 1) * stride + 16]) / Math.max(1, arc[k + 1] - arc[k - 1]);
        const drop = Math.min(P.maxDropM, (hi - lo) * P.dropShare);
        if (drop < P.minDropM || slope < P.minSlope) continue;
        let wet = false;
        for (let j = a; j <= b; j++) if (points[j * stride + 9] < 0) { wet = true; break; }
        if (wet) continue;
        const centre = (arc[a] + arc[b]) / 2;
        candidates.push({ a: arc[a], b: arc[b], hi, lo, drop, start: centre - P.lengthM / 2, end: centre + P.lengthM / 2, slope });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    const falls = [];
    for (const c of candidates) {
        if (falls.some(f => Math.abs(f.start - c.start) < P.spacingM)) continue;
        falls.push(c);
    }
    return falls.sort((a, b) => a.start - b.start);
}

/** Returns new points and arc lengths, plus waterfall records for diagnostics. */
export function bakeRiverWaterfalls(points, stride, arc, overrides = {}) {
    const P = { ...RIVER_FALL_DEFAULTS, ...overrides };
    const falls = riverWaterfalls(points, stride, arc, P);
    if (!falls.length) return { points, arc, waterfalls: falls };
    const samples = new Set(arc);
    for (const f of falls) {
        samples.add(f.a); samples.add(f.b);
        for (let k = 0; k <= 4; k++) samples.add(f.start + (f.end - f.start) * k / 4);
    }
    const s = Float64Array.from([...samples].sort((a, b) => a - b));
    const out = new Float32Array(s.length * stride);
    let seg = 0;
    for (let k = 0; k < s.length; k++) {
        const x = s[k];
        while (seg < arc.length - 2 && arc[seg + 1] < x) seg++;
        const t = clamp01((x - arc[seg]) / Math.max(1e-6, arc[seg + 1] - arc[seg]));
        const o = k * stride;
        for (let j = 0; j < stride; j++) out[o + j] = points[seg * stride + j] + (points[(seg + 1) * stride + j] - points[seg * stride + j]) * t;
        const len = Math.hypot(out[o], out[o + 1], out[o + 2]);
        out[o] /= len; out[o + 1] /= len; out[o + 2] /= len;
        // Lake guards are categorical; interpolating a sentinel loses the guard.
        out[o + 18] = Math.max(points[seg * stride + 18], points[(seg + 1) * stride + 18]);
        for (const f of falls) {
            if (x < f.a || x > f.b) continue;
            const level = f.hi - (f.hi - f.lo - f.drop) * ((x - f.a) / (f.b - f.a)) - f.drop * quintic((x - f.start) / (f.end - f.start));
            out[o + 3] = level; out[o + 16] = level;
            const lip = Math.exp(-(((x - (f.start + f.end) / 2) / 16) ** 2));
            const pool = Math.exp(-(((x - (f.end + 25)) / 30) ** 2));
            out[o + 4] *= 1 - P.pinch * lip;
            out[o + 5] += P.poolDepthShare * f.drop * pool;
            out[o + 17] = out[o + 5];
            out[o + 11] = Math.max(out[o + 11], lip, 0.8 * pool);
            out[o + 19] = 0; // no island through the waterfall's channel
        }
    }
    return { points: out, arc: s, waterfalls: falls };
}
