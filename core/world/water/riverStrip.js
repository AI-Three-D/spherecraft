// core/world/water/riverStrip.js
//
// Geometry of a simulation strip along a traced river (WaterRiverSim.js):
// arc length along the river's points (waterWorkerCore.js solveRiver), the
// frame of a strip row at any arc length (centre, flow direction, left
// normal; past the river's ends it continues straight along the end
// direction), the river's values there, and the arc length nearest to a
// point. Pure JS.

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * @param {{points: Float32Array, stride: number}} rec  traced river
 * @param {number} R  planet radius (m)
 * @param {object} [o]
 * @param {number} [o.tangentM=20]  the flow direction is taken over +- this (m)
 */
export function createRiverStrip(rec, R, { tangentM = 20 } = {}) {
    const P = rec.points, st = rec.stride, n = P.length / st;
    const dirs = [], s = new Float64Array(n);
    for (let k = 0; k < n; k++) dirs.push([P[k * st], P[k * st + 1], P[k * st + 2]]);
    for (let k = 1; k < n; k++) {
        const a = dirs[k - 1], b = dirs[k];
        s[k] = s[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * R;
    }
    const length = s[n - 1];
    const val = (k, o) => P[k * st + o];

    // Segment and position along it for arc length x (clamped to the river).
    const locate = (x) => {
        let lo = 0, hi = n - 1;
        if (x <= 0) return { k: 0, t: 0 };
        if (x >= length) return { k: Math.max(0, n - 2), t: 1 };
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid] <= x) lo = mid; else hi = mid; }
        const span = s[lo + 1] - s[lo];
        return { k: lo, t: span > 0 ? (x - s[lo]) / span : 0 };
    };
    // Centre direction at arc length x; past the ends straight along the end direction.
    const centre = (x) => {
        if (n < 2) return dirs[0];
        if (x < 0 || x > length) {
            const [a, b, e] = x < 0 ? [dirs[1], dirs[0], -x] : [dirs[n - 2], dirs[n - 1], x - length];
            const d = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
            return norm3([b[0] + d[0] * e / R, b[1] + d[1] * e / R, b[2] + d[2] * e / R]);
        }
        const { k, t } = locate(x), a = dirs[k], b = dirs[Math.min(n - 1, k + 1)];
        return norm3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    };

    return {
        length,
        /** Arc length (m) of each river point. */
        s,
        /**
         * Row frame and river values at arc length x: c (centre, unit
         * direction), along (unit flow direction), left (unit, + across),
         * eta (the water's level: normal depth of Q, waterWorkerCore.js),
         * hw (half-width), bed (thalweg), speed (mean), Q (m^3/s).
         */
        at(x) {
            const c = centre(x);
            const f = centre(x + tangentM), b = centre(x - tangentM);
            let along = [f[0] - b[0], f[1] - b[1], f[2] - b[2]];
            along = norm3([along[0] - c[0] * dot3(along, c), along[1] - c[1] * dot3(along, c), along[2] - c[2] * dot3(along, c)]);
            const left = norm3(cross3(c, along));
            const { k, t } = locate(x), k1 = Math.min(n - 1, k + 1);
            const lerp = (o) => val(k, o) + (val(k1, o) - val(k, o)) * t;
            const design = lerp(3), depth = lerp(5);
            const eta = st >= 20 ? lerp(16) : design;
            return { c, along, left, eta, hw: lerp(4), bed: design - depth, speed: lerp(6), Q: lerp(7) };
        },
        /**
         * Arc length of the river point nearest to unit direction d, and the
         * distance (m) to it; searched near `hint` (arc length) when given.
         */
        nearest(d, hint = null, windowM = 2000) {
            let k0 = 0, k1 = n - 2;
            if (hint !== null) { k0 = Math.max(0, locate(hint - windowM).k); k1 = Math.min(n - 2, locate(hint + windowM).k); }
            let best = { s: 0, dist: Infinity };
            for (let k = k0; k <= k1; k++) {
                const a = dirs[k], b = dirs[k + 1];
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = dot3(ab, ab) || 1e-30;
                const t = Math.max(0, Math.min(1, dot3([d[0] - a[0], d[1] - a[1], d[2] - a[2]], ab) / L2));
                const dist = Math.hypot(d[0] - a[0] - ab[0] * t, d[1] - a[1] - ab[1] * t, d[2] - a[2] - ab[2] * t) * R;
                if (dist < best.dist) best = { s: s[k] + (s[k + 1] - s[k]) * t, dist };
            }
            return best;
        },
        /** Max half-width over the river. */
        maxHalfWidth() { let m = 0; for (let k = 0; k < n; k++) m = Math.max(m, val(k, 4)); return m; },
    };
}
