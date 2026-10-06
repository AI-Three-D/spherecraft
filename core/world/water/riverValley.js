// core/world/water/riverValley.js
//
// River valleys in the terrain (WATER_HANDOFF.md §5, option B: network
// first, terrain second, water third). The terrain is shaped toward each
// river's valley before the erosion filter, so the filter's gullies drain
// into it and the river sits on a valley floor instead of in a trench dug
// into a finished terrain (owner 2026-10-06: "the moat"). Lab:
// terrain-lab/valley-proto.mjs (4 rivers, 66 km: no water escapes, bank
// crest ~2 m above the water, lakes unchanged within 4 cm).
//
// The field: per texel of a cube-face grid (texels per face edge, 64-128 m
// on a 131 km planet), stored in pages of page^2 texels with a 2-texel
// apron (the 4 x 4 B-spline footprint of any sample inside the page stays
// in it), only where a river comes within dBig:
//   d      distance to the nearest river's centre line (m, clamped to dBig)
//   F      that river's valley floor there (m; riverRefine.js riverValleyShape)
//   wc     its floor half-width (m)
//   wFill  1: ground lower than the floor is raised to it, 0: not (on lake
//          water, at the river's ends)
//   sWall  the valley side's slope
//   rim    the level of lake water within rimProbeM (else the floor), and
//   wRim   1 there: the valley side is not cut below that level (the lake
//          keeps its rim and level)
// packed as 4 x u32: F as f32, then pairs of half floats (d, wc), (wFill,
// sWall), (wRim, rim - F): a texel's values depend on the texel alone, so
// pages sharing apron texels store them identically (no seams). The shader
// samples it with a cubic B-spline (C2: the erosion filter's input must be
// C2) and builds the cross-section (riverValley.wgsl.js).
//
// Pure JS (worker-friendly). Texel (i, j) of a face sits at face UV
// ((i + 0.5) / texels, (j + 0.5) / texels); apron texels past the face's edge
// use the gnomonic map extended past it (waterGraph.js faceUVToDir), so
// pages on both sides of an edge agree.

import { dirToFaceUV, faceUVToDir } from '../hydrology/waterGraph.js';
import { tangentBasis } from '../hydrology/lakeRefine.js';

export const RIVER_VALLEY_DEFAULTS = Object.freeze({
    enabled: true,
    texels: 2048,        // per cube-face edge (lab: 2048 and 4096 hold the same)
    page: 32,            // texels per page side (+2 apron each side)
    dBig: 2000,          // stored distance clamp (m)
    reach0: 1200,        // the valley's effect fades out between reach0 ..
    reach1: 1700,        // .. and reach1 (m from the river)
    // Cross-section, x = metres past the floor's edge: the valley side rises
    // vH (1 - e^(-x / vS)) + wallSlope x (Whitewater's river.js valley),
    // switched on over wallL; ground above it is cut toward it, blending over
    // kCut (m of height); ground below the floor is raised to it within the
    // floor (fill weight), falling away past its edge at fillSlope (C2 over
    // fillL), blending over kSmooth.
    vH: 12, vS: 90, wallL: 30,
    kCut: 15, kSmooth: 1.5,
    fillSlope: 0.15, fillL: 20,
    // Lake rims: texels with lake water within any of these distances (m).
    rimProbeM: [50, 100, 150],
    rimMarginM: 0.3,     // the cut stops this far above the lake's level
});

/** Floats of data per texel before packing. */
const FIELDS = 7;   // d, F, wc, wFill, sWall, rim, wRim

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

// IEEE 754 half float bits of a number (round to nearest even).
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalfBits(x) {
    f32[0] = x;
    const b = u32[0], sign = (b >>> 16) & 0x8000;
    let exp = ((b >>> 23) & 0xff) - 127 + 15, mant = b & 0x7fffff;
    if (exp >= 31) return sign | 0x7c00;                      // overflow: inf
    if (exp <= 0) {
        if (exp < -10) return sign;                           // underflow: 0
        mant |= 0x800000;
        const shift = 14 - exp;
        let h = mant >>> shift;
        const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
        if (rem > half || (rem === half && (h & 1))) h++;
        return sign | h;
    }
    let h = (exp << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
    return sign | h;
}
export function fromHalfBits(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}
const pack2 = (a, b) => (toHalfBits(a) | (toHalfBits(b) << 16)) >>> 0;
const f32bits = (x) => { f32[0] = x; return u32[0]; };

/** Layout constants of a field configuration. */
export function valleyLayout(opts = RIVER_VALLEY_DEFAULTS) {
    const T = opts.texels, P = opts.page, PE = T / P, ST = P + 4;
    if (!Number.isInteger(PE)) throw new Error('riverValley: texels must be a multiple of page');
    return { T, P, PE, ST, TEX: ST * ST, pageCount: 6 * PE * PE };
}

/**
 * Pages within reach (dBig + a page) of a river line (unit directions,
 * arc lengths), probed on a tangent grid every ~200 m along it.
 * @returns {Set<number>} page ids (face * PE^2 + pj * PE + pi)
 */
export function valleyPagesNear(dirs, s, R, opts = RIVER_VALLEY_DEFAULTS) {
    const { T, P, PE } = valleyLayout(opts);
    const out = new Set();
    const pageM = P * (2 * Math.PI * R / 4) / T;
    const ext = opts.dBig + 1.5 * pageM, st = pageM / 3;
    const every = Math.max(1, Math.round(200 / Math.max(1, (s[1] ?? 20) - (s[0] ?? 0))));
    for (let k = 0; k < dirs.length; k += every) {
        const c = dirs[k], { e1, e2 } = tangentBasis(c);
        for (let ox = -ext; ox <= ext; ox += st) for (let oy = -ext; oy <= ext; oy += st) {
            if (ox * ox + oy * oy > ext * ext) continue;
            const d = norm3([c[0] + (ox * e1[0] + oy * e2[0]) / R, c[1] + (ox * e1[1] + oy * e2[1]) / R, c[2] + (ox * e1[2] + oy * e2[2]) / R]);
            const { face, u, v } = dirToFaceUV(d);
            const pi = Math.min(PE - 1, Math.max(0, Math.floor(u * PE))), pj = Math.min(PE - 1, Math.max(0, Math.floor(v * PE)));
            out.add(face * PE * PE + pj * PE + pi);
        }
    }
    return out;
}

/**
 * River lines for the bake from traced river records (riverRefine.js
 * RIVER_POINT_STRIDE: valley floor, floor half-width, fill weight and wall
 * slope at floats 12..15).
 */
export function valleyRiverFromRecord(rec, R) {
    const P = rec.points, st = rec.stride, n = P.length / st;
    const dirs = [], s = new Float64Array(n), F = new Float64Array(n), wc = new Float64Array(n), wFill = new Float64Array(n), sWall = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const o = k * st;
        dirs.push([P[o], P[o + 1], P[o + 2]]);
        if (k) s[k] = s[k - 1] + Math.acos(Math.min(1, dot3(dirs[k - 1], dirs[k]))) * R;
        F[k] = P[o + 12]; wc[k] = P[o + 13]; wFill[k] = P[o + 14]; sWall[k] = P[o + 15];
    }
    return { dirs, s, F, wc, wFill, sWall };
}

/**
 * Bakes pages of the field.
 * @param {number[]} pageIds
 * @param {Array} rivers   valleyRiverFromRecord() results (all rivers that may reach the pages)
 * @param {object} p
 * @param {number} p.R
 * @param {(dir: number[]) => number} [p.lakeLevelAt]  level of lake (or sea) water at a
 *   unit direction on the natural terrain, NaN where dry
 * @returns {{ texels: Uint32Array, near: number }}
 *   texels: per page (P + 4)^2 x 4 u32; near: texels within dBig
 */
export function bakeValleyPages(pageIds, rivers, { R, lakeLevelAt = null }, opts = RIVER_VALLEY_DEFAULTS) {
    const { T, P, PE, ST, TEX } = valleyLayout(opts);
    const dBig = opts.dBig;
    // Segments (3D chords) of all rivers, with per-end attributes.
    let nSeg = 0;
    for (const rv of rivers) nSeg += Math.max(0, rv.dirs.length - 1);
    const A = new Float64Array(nSeg * 3), B = new Float64Array(nSeg * 3), MID = new Float64Array(nSeg * 3), RAD = new Float64Array(nSeg);
    const segRiver = new Int32Array(nSeg), segK = new Int32Array(nSeg);
    let q = 0;
    rivers.forEach((rv, ri) => {
        for (let k = 0; k + 1 < rv.dirs.length; k++, q++) {
            const a = rv.dirs[k], b = rv.dirs[k + 1];
            A.set(a, 3 * q); B.set(b, 3 * q);
            MID.set(norm3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]), 3 * q);
            RAD[q] = 0.5 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * R;
            segRiver[q] = ri; segK[q] = k;
        }
    });
    const probe = [[0, 0]];
    for (const r of opts.rimProbeM) for (let m = 0; m < 8; m++) probe.push([r * Math.cos(m * Math.PI / 4), r * Math.sin(m * Math.PI / 4)]);
    const texels = new Uint32Array(pageIds.length * TEX * 4);
    const cand = new Int32Array(nSeg), raw = new Float64Array(TEX * FIELDS);
    let near = 0;
    pageIds.forEach((pid, slot) => {
        const face = Math.floor(pid / (PE * PE)), pj = Math.floor((pid % (PE * PE)) / PE), pi = pid % PE;
        const i0 = pi * P - 2, j0 = pj * P - 2;
        const pc = faceUVToDir(face, (pi + 0.5) / PE, (pj + 0.5) / PE), corner = faceUVToDir(face, pi / PE, pj / PE);
        const pr = Math.acos(Math.min(1, dot3(pc, corner))) * R * 1.3 + 3 * (P * (2 * Math.PI * R / 4) / T) / P;
        // Candidate segments: every one that can be the nearest for a texel
        // of the page within dBig + a margin; with none, all of them (every
        // texel takes its nearest river's values, so pages sharing apron
        // texels agree exactly).
        let nc = 0;
        for (let i = 0; i < nSeg; i++) {
            const cosA = MID[3 * i] * pc[0] + MID[3 * i + 1] * pc[1] + MID[3 * i + 2] * pc[2];
            if (Math.acos(Math.min(1, cosA)) * R - RAD[i] < pr + dBig + 1000) cand[nc++] = i;
        }
        if (!nc) for (let i = 0; i < nSeg; i++) cand[nc++] = i;
        for (let jj = 0; jj < ST; jj++) for (let ii = 0; ii < ST; ii++) {
            const t = jj * ST + ii, o = t * FIELDS;
            const p = faceUVToDir(face, (i0 + ii + 0.5) / T, (j0 + jj + 0.5) / T);
            let best = Infinity, bi = -1, bt = 0;
            for (let c = 0; c < nc; c++) {
                const i = cand[c], a0 = A[3 * i], a1 = A[3 * i + 1], a2 = A[3 * i + 2];
                const ux = B[3 * i] - a0, uy = B[3 * i + 1] - a1, uz = B[3 * i + 2] - a2;
                const px = p[0] - a0, py = p[1] - a1, pz = p[2] - a2;
                const L2 = ux * ux + uy * uy + uz * uz;
                const tt = L2 > 0 ? Math.max(0, Math.min(1, (px * ux + py * uy + pz * uz) / L2)) : 0;
                const dx = px - tt * ux, dy = py - tt * uy, dz = pz - tt * uz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best) { best = d2; bi = i; bt = tt; }
            }
            if (bi < 0) { raw.fill(0, o, o + FIELDS); raw[o] = dBig; continue; }
            const dist = Math.sqrt(best) * R;
            if (dist < dBig) near++;
            const rv = rivers[segRiver[bi]], k = segK[bi];
            const lerp = (arr) => arr[k] + (arr[k + 1] - arr[k]) * bt;
            const F = lerp(rv.F);
            raw[o] = Math.min(dist, dBig); raw[o + 1] = F; raw[o + 2] = lerp(rv.wc); raw[o + 3] = lerp(rv.wFill); raw[o + 4] = lerp(rv.sWall);
            raw[o + 5] = F; raw[o + 6] = 0;
            // Lake water nearby: the cut stops at its level (the lake keeps its
            // rim); on lake water itself, no fill (a fill there dammed the
            // lake's edge; dry ground beside it is still filled, or a river
            // leaving a lake spilled into hollows beside its outlet).
            if (lakeLevelAt && dist < opts.reach1 + 200) {
                const { e1, e2 } = tangentBasis(p);
                let lv = -Infinity;
                for (const [ox, oy] of probe) {
                    const here = !ox && !oy;
                    const d = here ? p : norm3([p[0] + (ox * e1[0] + oy * e2[0]) / R, p[1] + (ox * e1[1] + oy * e2[1]) / R, p[2] + (ox * e1[2] + oy * e2[2]) / R]);
                    const l = lakeLevelAt(d);
                    if (!Number.isFinite(l)) continue;
                    lv = Math.max(lv, l);
                    if (here) raw[o + 3] = 0;
                }
                if (lv > -Infinity) { raw[o + 5] = lv + opts.rimMarginM; raw[o + 6] = 1; }
            }
        }
        for (let t = 0; t < TEX; t++) {
            const o = t * FIELDS, w = (slot * TEX + t) * 4;
            texels[w] = f32bits(raw[o + 1]);
            texels[w + 1] = pack2(raw[o], raw[o + 2]);
            texels[w + 2] = pack2(raw[o + 3], raw[o + 4]);
            texels[w + 3] = pack2(raw[o + 6], raw[o + 5] - raw[o + 1]);
        }
    });
    return { texels, near };
}

/** Packed ValleyParams uniform (riverValley.wgsl.js), 64 bytes. on: 0 = the term passes through. */
export function valleyParamsData(opts = RIVER_VALLEY_DEFAULTS, on = true) {
    const { T, P, PE } = valleyLayout(opts);
    const buf = new ArrayBuffer(64), f = new Float32Array(buf), u = new Uint32Array(buf);
    f[0] = T; u[1] = P; u[2] = PE; u[3] = on ? 1 : 0;
    f[4] = opts.dBig; f[5] = opts.reach0; f[6] = opts.reach1; f[7] = opts.kSmooth;
    f[8] = opts.vH; f[9] = opts.vS; f[10] = opts.wallL; f[11] = opts.fillSlope;
    f[12] = opts.fillL; f[13] = opts.kCut; f[14] = 0; f[15] = 0;
    return buf;
}

/**
 * Grid cells (waterGraph.js, N per face edge) a page covers, with a margin
 * of one cell: the tiles there regenerate when the page changes.
 */
export function valleyPageCells(pid, N, opts = RIVER_VALLEY_DEFAULTS) {
    const { PE } = valleyLayout(opts);
    const face = Math.floor(pid / (PE * PE)), pj = Math.floor((pid % (PE * PE)) / PE), pi = pid % PE;
    const per = N / PE, out = [];
    const c0 = Math.max(0, Math.floor(pi * per) - 1), c1 = Math.min(N - 1, Math.ceil((pi + 1) * per));
    const r0 = Math.max(0, Math.floor(pj * per) - 1), r1 = Math.min(N - 1, Math.ceil((pj + 1) * per));
    for (let j = r0; j <= r1; j++) for (let i = c0; i <= c1; i++) out.push(face * N * N + j * N + i);
    return out;
}
