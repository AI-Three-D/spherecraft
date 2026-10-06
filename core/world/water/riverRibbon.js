// core/world/water/riverRibbon.js
//
// Near river surfaces (core/renderer/water/NearWaterRenderer.js), the lakes'
// approach for rivers: the stretches of each traced river within range of
// the camera as a ribbon flat across at the river's water level, along the
// channel's centre (the traced line moved by the shape noise's wobble,
// riverShapeNoise.js, as waterWgsl.js waterRiverPoint does) and as wide as
// the channel plus a margin: the banks rise above the level and hide the
// rest, as lake shores do. Where a river runs into or out of a lake its
// level eases to the lake's (riverWaterLevels; the terrain shading's river
// segments get the same levels, WaterGpuData), so the two surfaces meet
// without a step (the lake's surface covers its mask; the ribbon gives way
// there, in the shader). At a river's ends the ribbon runs on by the
// channel's half-width, over the round end the terrain shading's river
// water has there. In tight bends the inner edge stays short of the bend's
// centre so the ribbon never folds over itself.
//
// Output (world positions with the terrain's arithmetic: origin + dir (R + level)):
// - points: RIBBON_POINT_FLOATS per ribbon point: left edge xyz, river id,
//   right edge xyz, level (m);
// - quads: the first point of each quad (point k to k + 1).

import { riverShapeAt } from './riverShapeNoise.js';

export const RIBBON_POINT_FLOATS = 8;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Bounding cap of a river's points (centre direction, angular radius), per record.
const caps = new WeakMap();
export function riverCap(rec) {
    let cap = caps.get(rec);
    if (cap) return cap;
    const P = rec.points, st = rec.stride, n = P.length / st;
    let c = [0, 0, 0];
    for (let k = 0; k < n; k++) { c[0] += P[k * st]; c[1] += P[k * st + 1]; c[2] += P[k * st + 2]; }
    c = norm(c);
    let angle = 0;
    for (let k = 0; k < n; k++) angle = Math.max(angle, Math.acos(Math.min(1, c[0] * P[k * st] + c[1] * P[k * st + 1] + c[2] * P[k * st + 2])));
    caps.set(rec, (cap = { c, angle }));
    return cap;
}

/**
 * Water level (m) at each point of a traced river (points 16, or the design
 * level 3 on older records), eased to the level of a lake whose mask covers
 * a point over easeM of arc from it, so river and lake surfaces meet.
 * @param {(dir: number[]) => ({ level: number } | null)} lakeAt
 */
export function riverWaterLevels(rec, arc, lakeAt, easeM = 80) {
    const P = rec.points, st = rec.stride, n = P.length / st;
    const out = new Float64Array(n), toLake = new Float64Array(n).fill(Infinity), lakeLevel = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        out[k] = st >= 20 ? P[k * st + 16] : P[k * st + 3];
        const l = lakeAt([P[k * st], P[k * st + 1], P[k * st + 2]]);
        if (l) { toLake[k] = 0; lakeLevel[k] = l.level; }
    }
    for (let k = 1; k < n; k++) {
        const d = toLake[k - 1] + arc[k] - arc[k - 1];
        if (d < toLake[k]) { toLake[k] = d; lakeLevel[k] = lakeLevel[k - 1]; }
    }
    for (let k = n - 2; k >= 0; k--) {
        const d = toLake[k + 1] + arc[k + 1] - arc[k];
        if (d < toLake[k]) { toLake[k] = d; lakeLevel[k] = lakeLevel[k + 1]; }
    }
    for (let k = 0; k < n; k++) {
        if (Number.isFinite(toLake[k])) out[k] = lakeLevel[k] + (out[k] - lakeLevel[k]) * smoothstep(0, easeM, toLake[k]);
    }
    return out;
}

/**
 * @param {object} o
 * @param {Iterable<[number, object]>} o.rivers  [river id, traced record] (points stride >= 12; water level at 16 when stride >= 20)
 * @param {(rec: object) => Float64Array} o.arcOf  arc length (m) at each point (as the GPU segments have it)
 * @param {{x,y,z}} o.camera  planet-centred
 * @param {number} o.rangeM
 * @param {number} o.R
 * @param {{x,y,z}} o.origin  planet centre in world space
 * @param {object} o.shape  { widthVar, wobble, bankVar } (the carve's shape noise)
 * @param {(dir: number[]) => ({ level: number } | null)} o.lakeAt  the lake whose mask covers a direction
 * @returns {{ points: Float32Array, quads: Uint32Array }}
 */
export function buildRiverRibbons({ rivers, arcOf, camera, rangeM, R, origin, shape, lakeAt, marginM = 2, easeM = 80 }) {
    const pts = [], quads = [];
    const cam = [camera.x, camera.y, camera.z];
    const camDir = norm(cam);
    for (const [rid, rec] of rivers) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        if (n < 2) continue;
        const cap = riverCap(rec);
        if ((Math.acos(Math.min(1, dot(camDir, cap.c))) - cap.angle) * R > rangeM + 500) continue;
        const dirAt = (k) => [P[k * st], P[k * st + 1], P[k * st + 2]];
        // Points within range (with one more at each end of a run).
        const inRange = new Uint8Array(n);
        let any = false;
        for (let k = 0; k < n; k++) {
            const d = dirAt(k), r = R + (st >= 20 ? P[k * st + 16] : P[k * st + 3]), reach = P[k * st + 4] * 2 + marginM;
            if (Math.hypot(d[0] * r - cam[0], d[1] * r - cam[1], d[2] * r - cam[2]) < rangeM + reach) { inRange[k] = 1; any = true; }
        }
        if (!any) continue;
        const arc = arcOf(rec);
        const levels = riverWaterLevels(rec, arc, lakeAt, easeM);

        // Ribbon point at point k; cap -1 / +1: moved back / on along the
        // river by the half-width (over the round end of the channel's water).
        const ribbonPoint = (k, capSign) => {
            const a = dirAt(Math.max(0, k - 1)), b = dirAt(Math.min(n - 1, k + 1)), p = dirAt(k);
            const tangent = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
            const sh = riverShapeAt(arc[k], rid, Math.max(P[k * st + 4], 0.5), shape);
            const hw = Math.max(sh.hw, 0.5) + marginM;
            const d = capSign ? norm([p[0] + tangent[0] * capSign * hw / R, p[1] + tangent[1] * capSign * hw / R, p[2] + tangent[2] * capSign * hw / R]) : p;
            const left = norm(cross(d, tangent));
            // Bend: radius from the turn at this point; the inner edge stays inside it.
            let wl = hw, wr = hw;
            if (!capSign && k > 0 && k < n - 1) {
                const t0 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], t1 = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
                const l0 = Math.hypot(...t0), l1 = Math.hypot(...t1);
                const angle = Math.acos(Math.min(1, Math.max(-1, dot(t0, t1) / (l0 * l1 || 1))));
                if (angle > 1e-6) {
                    const radius = 0.5 * (l0 + l1) * R / angle;
                    if (dot(cross(t0, t1), p) > 0) wl = Math.min(wl, Math.max(0.8 * radius - sh.off, 0.5));
                    else wr = Math.min(wr, Math.max(0.8 * radius + sh.off, 0.5));
                }
            }
            const c = norm([d[0] + left[0] * sh.off / R, d[1] + left[1] * sh.off / R, d[2] + left[2] * sh.off / R]);
            const L = norm([c[0] + left[0] * wl / R, c[1] + left[1] * wl / R, c[2] + left[2] * wl / R]);
            const Rt = norm([c[0] - left[0] * wr / R, c[1] - left[1] * wr / R, c[2] - left[2] * wr / R]);
            const r = R + levels[k];
            return [origin.x + L[0] * r, origin.y + L[1] * r, origin.z + L[2] * r, rid,
                origin.x + Rt[0] * r, origin.y + Rt[1] * r, origin.z + Rt[2] * r, levels[k]];
        };

        let runStart = -1;
        for (let k = 0; k <= n; k++) {
            const want = k < n && (inRange[k] || (k > 0 && inRange[k - 1]) || (k + 1 < n && inRange[k + 1]));
            if (want && runStart < 0) runStart = k;
            if (!want && runStart >= 0) {
                // The run's points, with a cap beyond the river's own ends.
                const run = [];
                if (runStart === 0) run.push(ribbonPoint(0, -1));
                for (let m = runStart; m < k; m++) run.push(ribbonPoint(m, 0));
                if (k === n) run.push(ribbonPoint(n - 1, 1));
                const base = pts.length / RIBBON_POINT_FLOATS;
                run.forEach((p, i) => { pts.push(...p); if (i > 0) quads.push(base + i - 1); });
                runStart = -1;
            }
        }
    }
    return { points: Float32Array.from(pts), quads: Uint32Array.from(quads) };
}
