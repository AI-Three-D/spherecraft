// Sparse cut-only bank retreat, applied after the existing terrain stack.
// C2 B-spline sampling and identical page aprons keep bank slopes continuous.
// The four-word storage layout is retained; unused words are reserved and zero.

import { dirToFaceUV, faceUVToDir } from '../hydrology/waterGraph.js';
import { planeToDir, tangentBasis } from '../hydrology/lakeRefine.js';
import { riverIncisionSampler } from '../hydrology/riverLandscape.js';

export const RIVER_VALLEY_DEFAULTS = Object.freeze({
    enabled: true,
    texels: 4096,
    page: 32,
    dBig: 650,
});

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const f32bits = x => { f32[0] = x; return u32[0]; };

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
    const ext = opts.dBig + 1.25 * pageM, st = pageM / 3;
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

/** Pages touched by sparse excavation, including its interpolation support. */
export function valleyIncisionPages(landscape, R, opts = RIVER_VALLEY_DEFAULTS) {
    const { T, P, PE } = valleyLayout(opts), pages = new Set(), f = landscape.frame;
    const add = (face, pi, pj) => {
        if (pi < 0 || pj < 0 || pi >= PE || pj >= PE) {
            const d = faceUVToDir(face, (pi + 0.5) / PE, (pj + 0.5) / PE);
            const q = dirToFaceUV(d);
            face = q.face; pi = Math.min(PE - 1, Math.floor(q.u * PE)); pj = Math.min(PE - 1, Math.floor(q.v * PE));
        }
        pages.add(face * PE * PE + pj * PE + pi);
    };
    for (const k of landscape.cells) {
        const d = planeToDir(f.x0 + (k % f.nx + 0.5) * f.spacing, f.y0 + (Math.floor(k / f.nx) + 0.5) * f.spacing, f, R);
        const { face, u, v } = dirToFaceUV(d), x = u * T, y = v * T;
        const pi = Math.min(PE - 1, Math.floor(x / P)), pj = Math.min(PE - 1, Math.floor(y / P));
        // Two B-spline texels plus the fine field's bilinear support.
        const margin = 3 + f.spacing / (2 * R / T / Math.sqrt(3));
        const dx = x - pi * P < margin ? -1 : x - pi * P > P - margin ? 1 : 0;
        const dy = y - pj * P < margin ? -1 : y - pj * P > P - margin ? 1 : 0;
        add(face, pi, pj);
        if (dx) add(face, pi + dx, pj);
        if (dy) add(face, pi, pj + dy);
        if (dx && dy) add(face, pi + dx, pj + dy);
    }
    return pages;
}

/** Cache sparse field support; unchanged rivers need no new index or scan. */
export function valleyRiverIncisionPages(rv, R, opts = RIVER_VALLEY_DEFAULTS) {
    const key = `${opts.texels}:${opts.page}`;
    rv.pageSupport ??= new Map();
    let pages = rv.pageSupport.get(key);
    if (!pages) { pages = valleyIncisionPages(rv.landscape, R, opts); rv.pageSupport.set(key, pages); }
    return pages;
}

/** River directions and sparse baked landscape for page selection. */
export function valleyRiverFromRecord(rec, R) {
    const P = rec.points, st = rec.stride, n = P.length / st;
    const dirs = [], s = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const o = k * st;
        dirs.push([P[o], P[o + 1], P[o + 2]]);
        // acos(dot) loses whole 20 m steps after directions are stored as f32.
        if (k) s[k] = s[k - 1] + Math.hypot(...dirs[k].map((v, i) => v - dirs[k - 1][i])) * R;
    }
    return { dirs, s, river: rec.riverId ?? 0, landscape: rec.landscape,
        field: rec.landscape ? riverIncisionSampler(rec.landscape, R) : null };
}

/** Packed ValleyParams uniform, 64 bytes. The unused words stay zero. */
export function valleyParamsData(opts = RIVER_VALLEY_DEFAULTS, on = true) {
    const { T, P, PE } = valleyLayout(opts);
    const buf = new ArrayBuffer(64), f = new Float32Array(buf), u = new Uint32Array(buf);
    f[0] = T; u[1] = P; u[2] = PE; u[3] = on ? 1 : 0;
    return buf;
}

// Texels hold f32 cut depth in x and a categorical lake guard in z's high bit.
// y and w are reserved. No hill, extra erosion or terrain fill data is baked.
export function bakeValleyPages(pageIds, rivers, { R, lakeLevelAt = null }, opts = RIVER_VALLEY_DEFAULTS) {
    const { T, P, PE, ST, TEX } = valleyLayout(opts);
    const fields = rivers.filter(r => r.landscape).map(r => ({ sample: r.field ?? riverIncisionSampler(r.landscape, R),
        pages: valleyRiverIncisionPages(r, R, opts) }));
    const texels = new Uint32Array(pageIds.length * TEX * 4);
    let near = 0;
    pageIds.forEach((pid, slot) => {
        const face = Math.floor(pid / (PE * PE)), pj = Math.floor((pid % (PE * PE)) / PE), pi = pid % PE;
        const i0 = pi * P - 2, j0 = pj * P - 2;
        const localFields = fields.filter(f => f.pages.has(pid));
        for (let j = 0; j < ST; j++) for (let i = 0; i < ST; i++) {
            const dir = faceUVToDir(face, (i0 + i + 0.5) / T, (j0 + j + 0.5) / T);
            const lake = lakeLevelAt && Number.isFinite(lakeLevelAt(dir));
            let cut = 0;
            if (!lake) for (const field of localFields) cut = Math.max(cut, field.sample(dir));
            const w = (slot * TEX + j * ST + i) * 4;
            texels[w] = f32bits(cut);
            texels[w + 2] = lake ? 0x80000000 : 0;
            if (cut > 0) near++;
        }
    });
    return { texels, near };
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
