// tools/perf/riverMetrics/riverSections.js
//
// Cross-sections of a traced river for the river metrics (river redesign
// R1(b), CLAUDE_LAKE_RIVER_HANDOFF.md section 10). Stations every stepM
// metres of arc along the traced line; at each, the line's direction, the
// unit vector across it (+ left of the flow, as waterWgsl.js waterRiverPoint)
// and the water level the renderers draw. clipExtents gives how far each
// side's section stays nearer to its own station than to any other part of
// the river (bends, meanders): a sample farther out belongs to another reach.
// Pure JavaScript, no GPU: unit directions on a sphere of radius R (m).

const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

/**
 * @param {object} o
 * @param {Float32Array|number[]} o.points  traced record points (dir.xyz at 0..2, half-width at 4, pool at 9 when stride >= 20)
 * @param {number} o.stride
 * @param {Float64Array|number[]} o.arc     arc length (m) at each point (WaterGpuData._arcLengths)
 * @param {Float64Array|number[]} o.levels  water level (m) at each point (riverRibbon.js riverWaterLevels)
 * @param {number} [o.stepM=4]              station spacing along the line (m)
 * @param {number} [o.tangentM=8]           the line's direction from the points this far before and after (m)
 * @returns {{ count, s: Float64Array, dir: Float64Array, left: Float64Array, wl: Float64Array, hw: Float64Array, pool: Float64Array }}
 */
export function buildStations({ points: P, stride: st, arc, levels, stepM = 4, tangentM = 8 }) {
    const n = P.length / st, L = arc[n - 1];
    const count = Math.floor(L / stepM) + 1;
    // Segment k and fraction t at arc length s (k advances monotonically within one pass).
    const locate = (s, k0) => {
        let k = Math.max(0, Math.min(k0, n - 2));
        while (k > 0 && arc[k] > s) k--;
        while (k < n - 2 && arc[k + 1] < s) k++;
        const span = arc[k + 1] - arc[k];
        return { k, t: span > 0 ? Math.min(1, Math.max(0, (s - arc[k]) / span)) : 0 };
    };
    const dirAt = (s, k0) => {
        const { k, t } = locate(s, k0), a = k * st, b = (k + 1) * st;
        return norm(P[a] + (P[b] - P[a]) * t, P[a + 1] + (P[b + 1] - P[a + 1]) * t, P[a + 2] + (P[b + 2] - P[a + 2]) * t);
    };
    const out = { count, s: new Float64Array(count), dir: new Float64Array(3 * count), left: new Float64Array(3 * count),
        wl: new Float64Array(count), hw: new Float64Array(count), pool: new Float64Array(count) };
    let k = 0;
    for (let q = 0; q < count; q++) {
        const s = q * stepM, at = locate(s, k);
        k = at.k;
        const t = at.t, a = k * st, b = (k + 1) * st;
        const d = dirAt(s, k);
        const d0 = dirAt(Math.max(0, s - tangentM), k), d1 = dirAt(Math.min(L, s + tangentM), k);
        // Along the line in the tangent plane at d; left = d x along.
        let tx = d1[0] - d0[0], ty = d1[1] - d0[1], tz = d1[2] - d0[2];
        const r = tx * d[0] + ty * d[1] + tz * d[2];
        [tx, ty, tz] = norm(tx - r * d[0], ty - r * d[1], tz - r * d[2]);
        const left = norm(d[1] * tz - d[2] * ty, d[2] * tx - d[0] * tz, d[0] * ty - d[1] * tx);
        out.s[q] = s;
        out.dir.set(d, 3 * q);
        out.left.set(left, 3 * q);
        out.wl[q] = levels[k] + (levels[k + 1] - levels[k]) * t;
        out.hw[q] = P[a + 4] + (P[b + 4] - P[a + 4]) * t;
        out.pool[q] = st >= 20 ? P[a + 9] + (P[b + 9] - P[a + 9]) * t : 0;
    }
    return out;
}

/**
 * How far (m) each station's section stays nearer to that station than to
 * any other station, per side, at most maxM: { left, right } Float64Arrays.
 * A station c at (u across, v along) from station o, with u > 1 on a side,
 * is nearer than o (by at least 1 m) to the section's point at offset n on
 * that side once n > (u^2 + v^2 - 1) / (2 (u - 1)) (from (n - u)^2 + v^2 <
 * (n - 1)^2). Stations farther than 2 maxM + 1 can never be.
 */
export function clipExtents(st, R, maxM) {
    const { count, dir, left } = st;
    const cell = 2 * maxM + 1, reach2 = cell * cell;
    const pos = new Float64Array(3 * count);
    for (let i = 0; i < 3 * count; i++) pos[i] = dir[i] * R;
    const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    const grid = new Map();
    for (let q = 0; q < count; q++) {
        const kq = key(pos[3 * q], pos[3 * q + 1], pos[3 * q + 2]);
        let list = grid.get(kq);
        if (!list) grid.set(kq, (list = []));
        list.push(q);
    }
    const outL = new Float64Array(count).fill(maxM), outR = new Float64Array(count).fill(maxM);
    for (let q = 0; q < count; q++) {
        const ox = pos[3 * q], oy = pos[3 * q + 1], oz = pos[3 * q + 2];
        const lx = left[3 * q], ly = left[3 * q + 1], lz = left[3 * q + 2];
        const dx = dir[3 * q], dy = dir[3 * q + 1], dz = dir[3 * q + 2];
        // along = left x dir
        const ax = ly * dz - lz * dy, ay = lz * dx - lx * dz, az = lx * dy - ly * dx;
        const gx = Math.floor(ox / cell), gy = Math.floor(oy / cell), gz = Math.floor(oz / cell);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
            const list = grid.get(`${gx + i},${gy + j},${gz + k}`);
            if (!list) continue;
            for (const c of list) {
                if (c === q) continue;
                const cx = pos[3 * c] - ox, cy = pos[3 * c + 1] - oy, cz = pos[3 * c + 2] - oz;
                if (cx * cx + cy * cy + cz * cz > reach2) continue;
                const u = cx * lx + cy * ly + cz * lz, v = cx * ax + cy * ay + cz * az;
                const w = Math.abs(u);
                if (w <= 1) continue;
                const nc = (u * u + v * v - 1) / (2 * (w - 1));
                if (u > 0) { if (nc < outL[q]) outL[q] = nc; } else if (nc < outR[q]) outR[q] = nc;
            }
        }
    }
    return { left: outL, right: outR };
}

/**
 * Terrain vertex spacing (m) at LOD 0 at a unit direction: cube faces mapped
 * to the sphere by normalising (advancedTerrainCompute getSpherePoint), face
 * [-1, 1] split into 2^maxDepth tiles of `segments` quads. The coarser of the
 * face's two axes: about 1 m at face centres, down to ~0.35-0.7 m near edges.
 */
export function lod0Spacing(d, R, maxDepth, segments) {
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    const major = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const m = Math.abs(d[major]);
    const p = [d[0] / m, d[1] / m, d[2] / m], lp = Math.hypot(p[0], p[1], p[2]);
    const step = 2 / (2 ** maxDepth * segments);
    let worst = 0;
    for (let a = 0; a < 3; a++) {
        if (a === major) continue;
        const c = p[a] / lp;
        worst = Math.max(worst, R * step * Math.sqrt(Math.max(0, 1 - c * c)) / lp);
    }
    return worst;
}
