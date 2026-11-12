// core/world/water/riverField.js
//
// One baked field owns the ground and the water near rivers
// (RIVERS_AND_LAKES.md section 7). For every traced river the bake writes,
// on a planet-global paged raster of ~2 m texels, the ground change Δ from
// the natural terrain, the water surface W and the signed distance to the
// connected water. The terrain generation adds Δ, the water is drawn at W
// where the field says wet, and bed materials read the depth below W.
//
// Raster: the cube faces (waterGraph.js faceUVToDir convention) with
// equal-angle coordinates a = 4/pi atan(x) (gnomonic x), T texels per face
// edge (arc per texel at the face's axes = texelM), pages of P x P texels.
// GPU pages carry an apron of A texels (bicubic support), found through a
// hash table (riverField.wgsl.js).
//
// Bake per river (pure CPU, natural ground sampled on the GPU in one batch):
// 1. Pages within the corridor (water + bank reach) and around its ends.
// 2. Stations every texel along the river: centre (with the wobble), half-
//    width, bed depth, bank slopes per side, water level W: the trace's
//    level, lowered where the ground beside the channel is lower (never
//    raised banks), never rising downstream, between the end lakes' levels.
// 3. Per texel: nearest point on the river (arc s, offset n); target
//    surface T(n) = channel under W, banks rising from the water's edge;
//    ground = smooth min(natural, T): cuts only. Into a lake the channel's
//    depth fades out and it widens, so its bed meets the lake bed.
// 4. Δ = ground - natural over all rivers (lowest wins), blurred.
// 5. Wet: ground below W, connected to a channel or to lake water.
//    Signed distance to that region for soft edges and materials.

import { dirToFaceUV, faceUVToDir } from '../hydrology/waterGraph.js';
import { riverHash } from './riverShapeNoise.js';
import { riverBankType } from './riverSection.js';
import { packFlowTexel, plumeAt, riverFlowDesign, riverPlumes, riverRocks, RIVER_FLOW, RIVER_ROCK_FLOATS } from './riverFlow.js';
import { rockFlowDeflection } from './rockFlow.js';

export const RIVER_FIELD = Object.freeze({
    texelM: 2,
    page: 32,
    apron: 2,
    // How far beyond the water's edge the banks may cut (m), and the
    // corridor's margin beyond that (pages).
    reachM: 160,
    marginM: 16,
    // W stays at least this far (m) under the ground beside the channel,
    // probed this far beyond the water's edge on both sides.
    containM: 0.25,
    containProbeM: [1, 2, 3, 4, 6, 8],
    // Notches in the banks narrower than this (m along the river) do not
    // lower W: the water spills into them (connected flood draws it).
    notchM: 8,
    // Banks: beyond the water's edge the ground goes from the toe (the
    // channel's edge slope, at most toeSlopeMax) to the natural ground over
    // a width B per side, a C2 ramp (smootherstep): no curvature step where
    // it ends on a hillside (a C1 ramp drew a line there: the carve's bank
    // blend, owner 2026-11-04/05, phase 0 A/B). B = bankB0 + bankC x the
    // height of the natural ground over W where a bank that wide reaches it
    // (probed at bankProbeM), per bank type tau 0 (no bank), 1 (ledge),
    // 2 (cut bank); the steepest slope is ~1.9 / bankC. Smoothed along the river.
    // Cut banks steeper than ~0.65 drew dark faces along whole rivers in the
    // lighting (f3, o04-mouth-poly).
    // Rivers run 2-4 m under the natural ground where it rises along them
    // (a monotone level): over that incision banks of slope ~0.4+ read as
    // walls (f4a line probes, o04-walls).
    bankB0: [16, 10, 5], bankC: [8, 5, 3.2], bankProbeM: [6, 12, 24, 48, 72, 96], bankSmoothM: 24, bankOpen: 0.5,
    toeSlopeMax: 0.3,
    // Bank widths vary along each side: exp(a N(s / L1) + b N(s / L2)) within
    // bankVaryRange, a bank no steeper than bankSteepMax (the 1 m grid).
    // Owner 2026-11-09: banks should vary outwards much more (reaches of broad
    // floodplain beside tight ones): the long wave swings further, up to 4 times.
    bankVary: [0.75, 0.3], bankVaryM: [350, 90], bankVaryRange: [0.5, 4], bankSteepMax: 0.6,
    // Banks are at least mouthBankM wide at a mouth, back to their own
    // width mouthNearM up the river.
    mouthBankM: 24, mouthNearM: 80,
    // Past a lake's shore a channel cuts no land: over mouthHoldM (m) from the shore it stops
    // cutting ground over the lake's level (fully mouthHoldRiseM above it). Its centre is
    // under the lake there, but its sides are wide and went on through the land where the shore
    // curved away: thin slots of lake water with a black cut at their tip, and points of land
    // between them and the lake (owner 2026-11-05, g-wedge, g-notch).
    mouthHoldM: 20, mouthHoldRiseM: 1,
    // Smooth min with the natural ground (m of height): cuts only.
    sminK: 0.3,
    // Into a lake the channel fades out and widens by fadeWiden: as the lake's
    // bed goes below it (mouthFadeDepth: lake depth in channel depths), so no bar
    // stands across its mouth, the mud showing through on top (owner's muddy
    // rim). Traces stop at the shore, so rivers are carried on into their lakes
    // (extendRiverEnds), mouthCarryM + mouthCarryPerHw x hw (m), all faded out
    // mouthTailM before the end. Without lake water at an end: over fadeM +
    // fadePerHw x hw (m) from the mouth.
    fadeM: 30, fadePerHw: 3, fadeWiden: 0.6,
    mouthFadeDepth: [0.6, 1.2], mouthCarryM: 60, mouthCarryPerHw: 2, mouthTailM: 16,
    // Gaussian blur of Δ (sigma, m), fully from the water's edge, none blurFromM inside it.
    blurM: 1.5, blurFromM: 3,
    // Signed distance clamp (m).
    sdfM: 16,
    // Shores: each bank's line wanders by shoreAmp of the half-width on its
    // own, two octaves (m): even banks read as dug (owner 2026-11-04: shores
    // were too smooth in many places; ragged is good).
    shoreAmp: 0.22, shoreWaveM: [37, 14],
    // Width: never narrower than traced. A river's own factor up to widenRiver
    // (squared: few are that wide) times reaches up to widenReach, widenMax at
    // most, in waves of widenWaveM (m), toward the ends widenEndM back to the
    // river's own. Each bank goes only as far as the ground stays above the water
    // (forced wider, the level would drop for all that lies downstream), and
    // steep rivers stay as they are (fall widenFall[0]..[1] fades it out).
    // Depth grows with the root of the width, and the bed flattens toward
    // widenFlat (the cross-section's power, 2 at the traced width, full at 3x):
    // a parabola's shallow margin grows with the width, and wide and shallow
    // is mud.
    widenRiver: 1.5, widenReach: 1.6, widenMax: 2, widenWaveM: [250, 700], widenEndM: 120, widenFall: [0.04, 0.15], widenFlat: 4,
    // Banks do not climb: where the natural ground at a bank's edge stands more than
    // bankCutM over the water that bank comes in, to bankLeast of its width or bankLeastM
    // at the least. A wide channel on a hillside is a one-sided cut: 13 m walls along
    // rivers, and at outlets, the level held at the lake's, a point of land and a dark
    // face (owner's edge walls, 2026-11-05 o-blue). Flaring mouths instead dug further in.
    bankCutM: 3, bankLeast: 0.4, bankLeastM: 4,
    // Meanders: the centre swings meanderAmp river widths either way over
    // meanderWave widths (two octaves), on flat ground only (cross slope
    // meanderFlat[0]..[1] fades it out), tapered over half a wavelength
    // toward ends and mouths (the river meets its lakes where traced). 1 (was 1.5
    // of narrower rivers): twice the old swing, and the pages' reach goes by it.
    meanderAmp: 1, meanderWave: 12, meanderWaveM: [60, 900], meanderFlat: [0.03, 0.12],
    // Levels and depths are linear between trace points: smoothed over this
    // along the river, or each segment's slope drew a band across the bed, seen
    // through the water too (the accordion, o29c-accordion). Before containment,
    // which keeps the last word on W. The bed alone will not do: at a concave
    // joint it meets the least depth and follows W's kink again.
    profileSmoothM: 32,
    // W reaches the lake's level at a mouth: containment relaxes over the
    // last mouthRelaxM (m) before it (lowered there, a step drew a line across
    // the river where it met its lake: o03-thalweg).
    mouthRelaxM: [20, 80],
    // A river's level meets its lake's where its centre enters the lake's
    // water (the 32 m mask can begin before the trace's mouth station: a step
    // across the river, o03-thalweg), eased over at least lakeEaseM (m), and
    // lakeEasePerM (m per m of level) for a steep stream. On the stations, so
    // the bed follows: per texel it left the bed above the water, a land
    // bridge (o04-mouth-yellow).
    lakeEaseM: 40, lakeEasePerM: 10,
    // River water reaches at most this far (m) beyond the channel's edge: the
    // fringe at its waterline. Farther it ran on along lower ground as a sheet
    // or a thin second channel beside the river (o29c-accordion).
    spillM: 3,
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };

/** Layout of the raster on a planet of radius R (m). */
export function riverFieldLayout(R, o = RIVER_FIELD) {
    const P = o.page, A = o.apron;
    const T = Math.ceil(Math.PI / 2 * R / o.texelM / P) * P;
    return { R, T, P, A, PE: T / P, ST: P + 2 * A, TEX: (P + 2 * A) ** 2 };
}

const QUARTER_PI = Math.PI / 4;
/** Face and continuous texel coordinates (texel i spans [i, i + 1)) of a unit direction. */
export function fieldCoords(dir, L) {
    const { face, u, v } = dirToFaceUV(dir);
    const a = Math.atan(2 * u - 1) / QUARTER_PI, b = Math.atan(2 * v - 1) / QUARTER_PI;
    return { face, x: (a + 1) * 0.5 * L.T, y: (b + 1) * 0.5 * L.T };
}
/** Unit direction of the point at continuous texel coordinates (x, y) on a face. */
export function fieldDir(face, x, y, L) {
    const a = x / L.T * 2 - 1, b = y / L.T * 2 - 1;
    return faceUVToDir(face, (Math.tan(a * QUARTER_PI) + 1) * 0.5, (Math.tan(b * QUARTER_PI) + 1) * 0.5);
}
export const pageKey = (face, pi, pj, L) => (face * L.PE + pj) * L.PE + pi;
export function pageOf(key, L) {
    const pi = key % L.PE, r = (key - pi) / L.PE, pj = r % L.PE;
    return { face: (r - pj) / L.PE, pi, pj };
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A river in its own tangent plane (metres): points, arc lengths and the
// values the bake needs at each point.
function riverPlane(river, R) {
    const { rec, arc } = river, P = rec.points, st = rec.stride, n = P.length / st;
    let c = [0, 0, 0];
    for (let k = 0; k < n; k++) for (let i = 0; i < 3; i++) c[i] += P[k * st + i];
    c = norm(c);
    const ref = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = norm(cross(ref, c)), e2 = cross(c, e1);
    const toPlane = (d) => { const k = dot(d, c); return [dot(d, e1) / k * R, dot(d, e2) / k * R]; };
    const x = new Float64Array(n), y = new Float64Array(n);
    for (let k = 0; k < n; k++) { const p = toPlane([P[k * st], P[k * st + 1], P[k * st + 2]]); x[k] = p[0]; y[k] = p[1]; }
    return { frame: { c, e1, e2 }, toPlane, x, y, n, arc };
}

/**
 * A river with its ends in lakes carried on straight into them: { rec, arc,
 * levels, srcLevel, destLevel, ... }, one more point at each such end.
 */
export function extendRiverEnds(river, R, o = RIVER_FIELD) {
    const { rec, arc, levels } = river, P = rec.points, st = rec.stride, n = P.length / st;
    if (n < 2) return river;
    const carry = (a, b) => {
        const t = [P[a * st] - P[b * st], P[a * st + 1] - P[b * st + 1], P[a * st + 2] - P[b * st + 2]], l = Math.hypot(t[0], t[1], t[2]);
        if (!(l > 0)) return null;
        const len = o.mouthCarryM + o.mouthCarryPerHw * P[a * st + 4], row = P.slice(a * st, (a + 1) * st);
        const d = norm([P[a * st] + t[0] / l * len / R, P[a * st + 1] + t[1] / l * len / R, P[a * st + 2] + t[2] / l * len / R]);
        row[0] = d[0]; row[1] = d[1]; row[2] = d[2];
        return { row, len };
    };
    const head = Number.isFinite(river.srcLevel) ? carry(0, 1) : null, tail = Number.isFinite(river.destLevel) ? carry(n - 1, n - 2) : null;
    if (!head && !tail) return river;
    const m = n + (head ? 1 : 0) + (tail ? 1 : 0), off = head ? 1 : 0, shift = head ? head.len : 0;
    const points = new P.constructor(m * st), arc2 = new Float64Array(m), levels2 = new Float64Array(m);
    points.set(P, off * st);
    for (let k = 0; k < n; k++) { arc2[k + off] = arc[k] + shift; levels2[k + off] = levels[k]; }
    if (head) { points.set(head.row, 0); levels2[0] = river.srcLevel; }
    if (tail) { points.set(tail.row, (m - 1) * st); arc2[m - 1] = arc2[m - 2] + tail.len; levels2[m - 1] = river.destLevel; }
    const mouths = (rec.mouths ?? []).map(q => ({ ...q, s: q.s + shift }));
    return { ...river, rec: { ...rec, points, mouths }, arc: arc2, levels: levels2 };
}

/**
 * Pages a set of rivers needs: within reach of every segment and around
 * every end. rivers: [{ rec, arc }]. Returns Map key -> Set of river indices.
 */
export function riverFieldPages(rivers, L, o = RIVER_FIELD) {
    const pages = new Map(), R = L.R;
    const add = (dir, ri) => {
        const q = fieldCoords(dir, L);
        const key = pageKey(q.face, clamp(Math.floor(q.x / L.P), 0, L.PE - 1), clamp(Math.floor(q.y / L.P), 0, L.PE - 1), L);
        let set = pages.get(key);
        if (!set) pages.set(key, (set = new Set()));
        set.add(ri);
    };
    const pageM = L.P * o.texelM * 0.5;
    rivers.forEach((river, ri) => {
        const P = river.rec.points, st = river.rec.stride, n = P.length / st;
        for (let k = 0; k < n; k++) {
            const d = [P[k * st], P[k * st + 1], P[k * st + 2]];
            const hw = P[k * st + 4], end = k === 0 || k === n - 1;
            const fade = end ? o.fadeM + o.fadePerHw * hw : 0;
            const wider = riverWidthFactor(river.rid ?? 0, river.arc[k], river.arc[n - 1], o) - 1;
            const ext = hw * (1 + 2 * o.meanderAmp + o.fadeWiden + o.shoreAmp + wider * (1 + o.shoreAmp)) + o.reachM + o.marginM + fade;   // meanders: up to amp x width
            const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const e1 = norm(cross(ref, d)), e2 = cross(d, e1);
            // Along the segment to the next point too.
            const next = k + 1 < n ? [P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]] : d;
            const len = Math.acos(clamp(dot(d, next), -1, 1)) * R;
            const steps = Math.max(1, Math.ceil(len / pageM));
            for (let t = 0; t < steps; t++) {
                const f = t / steps, c = norm([d[0] + (next[0] - d[0]) * f, d[1] + (next[1] - d[1]) * f, d[2] + (next[2] - d[2]) * f]);
                for (let ox = -ext; ox <= ext + 1e-6; ox += Math.min(pageM, ext)) for (let oy = -ext; oy <= ext + 1e-6; oy += Math.min(pageM, ext)) {
                    add(norm([c[0] + (ox * e1[0] + oy * e2[0]) / R, c[1] + (ox * e1[1] + oy * e2[1]) / R, c[2] + (ox * e1[2] + oy * e2[2]) / R]), ri);
                }
            }
        }
    });
    return pages;
}

// Pool-adjacent-violators: the non-increasing least-squares fit of v.
// Value noise along a river, -1..1.
function vn(x, sd) {
    const i0 = Math.floor(x), f = x - i0, q = f * f * f * (f * (f * 6 - 15) + 10);
    const a = riverHash(i0, sd), b = riverHash(i0 + 1, sd);
    return (a + (b - a) * q) * 2 - 1;
}

// How many times wider than traced a river wants to be at s (m) of total.
export function riverWidthFactor(rid, s, total, o = RIVER_FIELD) {
    const seed = ((rid | 0) * 48271 + 0x3a91) >>> 0, r = riverHash(0, seed), w = riverHash(1, seed);
    const own = 1 + (o.widenRiver - 1) * r * r;
    const lambda = o.widenWaveM[0] + (o.widenWaveM[1] - o.widenWaveM[0]) * w;
    const n = 0.65 * vn(s / lambda, seed + 3) + 0.35 * vn(s / (0.37 * lambda), seed + 7);
    const reach = (o.widenReach - 1) * smoothstep(-0.05, 0.7, n) * smoothstep(0, o.widenEndM, Math.min(s, total - s));
    return Math.min(o.widenMax, own * (1 + reach));
}

// Smooth value noise (-1..1) along a bank, x in wavelengths.
function bankNoise(x, seed) {
    const h = (i) => { let v = Math.imul((i | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x9e3779b1); v ^= v >>> 15; v = Math.imul(v, 0x85ebca6b); v ^= v >>> 13; return ((v >>> 0) / 4294967296) * 2 - 1; };
    const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f);
    return h(i) + (h(i + 1) - h(i)) * t;
}

// A moving average along stations, twice, ends held: keeps a level non-increasing.
function smoothAlong(v, h) {
    const n = v.length, t = new Float64Array(n);
    for (let pass = 0; pass < 2; pass++) {
        let acc = 0;
        for (let i = -h; i <= h; i++) acc += v[clamp(i, 0, n - 1)];
        for (let i = 0; i < n; i++) {
            t[i] = acc / (2 * h + 1);
            acc += v[clamp(i + h + 1, 0, n - 1)] - v[clamp(i - h, 0, n - 1)];
        }
        v.set(t);
    }
}

/**
 * Stations of one river every ds metres: centre (plane m), unit tangent,
 * half-width, depth below W, W, bank slopes left/right, fade into lakes.
 * groundAt(x, y) samples the natural ground in the river's plane.
 */
function riverStations(river, plane, groundAt, lakeWaterAt, o) {
    const { rec, arc, rid, levels } = river, P = rec.points, st = rec.stride, n = P.length / st;
    const L = arc[n - 1], ds = o.texelM;
    const m = Math.max(2, Math.ceil(L / ds) + 1);
    // ds > 0 even for a degenerate trace (a zero spacing made the smoothing windows infinite).
    const S = { m, ds: Math.max(L / (m - 1), 1e-3), s: new Float64Array(m), x: new Float64Array(m), y: new Float64Array(m), tx: new Float64Array(m), ty: new Float64Array(m),
        hw: new Float64Array(m), hwL: new Float64Array(m), hwR: new Float64Array(m), D: new Float64Array(m), W: new Float64Array(m), skew: new Float64Array(m),
        BL: new Float64Array(m), BR: new Float64Array(m), EL: new Float64Array(m), ER: new Float64Array(m), wide: new Float64Array(m).fill(1), fade: new Float64Array(m), mouth: new Float64Array(m), lake: new Uint8Array(m), hold: new Float64Array(m), holdLevel: new Float64Array(m) };
    const tauL = new Float64Array(m), tauR = new Float64Array(m), relax = new Float64Array(m), past = new Uint8Array(m);
    const mouths = rec.mouths ?? [];
    let k = 0;
    const wl = levels;
    for (let i = 0; i < m; i++) {
        const s = i * S.ds;
        while (k < n - 2 && arc[k + 1] < s) k++;
        const t = clamp((s - arc[k]) / Math.max(arc[k + 1] - arc[k], 1e-9), 0, 1);
        const a = k * st, b = (k + 1) * st;
        const lerp = (o2) => P[a + o2] + (P[b + o2] - P[a + o2]) * t;
        let tx = plane.x[k + 1] - plane.x[k], ty = plane.y[k + 1] - plane.y[k];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const hw = lerp(4);
        const w = wl[k] + (wl[k + 1] - wl[k]) * t;
        const bed = lerp(3) - lerp(5);
        S.s[i] = s;
        S.x[i] = plane.x[k] + (plane.x[k + 1] - plane.x[k]) * t;
        S.y[i] = plane.y[k] + (plane.y[k + 1] - plane.y[k]) * t;
        S.tx[i] = tx; S.ty[i] = ty;
        S.hw[i] = hw;
        S.D[i] = Math.max(0.4, w - bed);
        S.W[i] = w;
        S.lake[i] = lerp(9) < -0.5 ? 1 : 0;
        S.skew[i] = lerp(10);
        const kappa = lerp(12);
        tauL[i] = riverBankType(s, rid, true, kappa);
        tauR[i] = riverBankType(s, rid, false, kappa);
    }
    const hs = Math.max(1, Math.round(o.profileSmoothM / S.ds / 2));
    smoothAlong(S.W, hs); smoothAlong(S.D, hs);
    // Each bank's own line.
    {
        const seed = ((rid | 0) * 104729 + 0x2f6b) >>> 0, [w0, w1] = o.shoreWaveM;
        for (let i = 0; i < m; i++) {
            const s = S.s[i], side = (sd) => 1 + o.shoreAmp * (0.6 * vn(s / w0, sd) + 0.4 * vn(s / w1, sd + 3));
            S.hwL[i] = S.hw[i] * side(seed); S.hwR[i] = S.hw[i] * side(seed + 11);
        }
    }
    // Meanders on flat ground.
    {
        const hws = Array.from(S.hw).sort((a, b) => a - b), width = 2 * hws[hws.length >> 1];
        const lambda = clamp(o.meanderWave * width, o.meanderWaveM[0], o.meanderWaveM[1]), amp = o.meanderAmp * width;
        const seed = ((rid | 0) * 7919 + 0x51ed) >>> 0;
        const flat = new Float64Array(m);
        for (let i = 0; i < m; i++) {
            const nx = -S.ty[i], ny = S.tx[i], d = S.hw[i] + 12;
            const g1 = groundAt(S.x[i] + nx * d, S.y[i] + ny * d), g2 = groundAt(S.x[i] - nx * d, S.y[i] - ny * d);
            const cross = Number.isFinite(g1) && Number.isFinite(g2) ? Math.abs(g1 - g2) / (2 * d) : 1;
            // Its own fall too: a stream straight down a hillside has no cross
            // slope, and meandered there its line tore across the slope
            // (o29c-accordion).
            const a = Math.max(0, i - 8), b = Math.min(m - 1, i + 8), fall = Math.abs(S.W[a] - S.W[b]) / Math.max(S.s[b] - S.s[a], S.ds);
            flat[i] = (1 - smoothstep(o.meanderFlat[0], o.meanderFlat[1], cross)) * (1 - smoothstep(o.meanderFlat[0], o.meanderFlat[1], fall));
        }
        // Smooth the flatness over a quarter wavelength (no sudden swings).
        const h = Math.min(m, Math.max(1, Math.round(lambda / 4 / S.ds))), flatS = new Float64Array(m);
        let acc = 0, cnt = 0;
        for (let i = -h; i < m + h; i++) {
            if (i + h < m) { acc += flat[i + h]; cnt++; }
            if (i - h - 1 >= 0) { acc -= flat[i - h - 1]; cnt--; }
            if (i >= 0 && i < m) flatS[i] = acc / cnt;
        }
        const Ltot = S.s[m - 1];
        // Offsets along a smoothed normal: the trace's turns at each point would tear the line.
        const nx = Float64Array.from(S.ty, v => -v), ny = Float64Array.from(S.tx);
        smoothAlong(nx, hs); smoothAlong(ny, hs);
        for (let i = 0; i < m; i++) {
            const s = S.s[i];
            let taper = smoothstep(0, lambda * 0.5, s) * smoothstep(0, lambda * 0.5, Ltot - s);
            for (const mo of mouths) taper *= smoothstep(0, lambda * 0.25, Math.abs(s - mo.s));
            const off = amp * flatS[i] * taper * (0.7 * vn(s / lambda, seed) + 0.3 * vn(s / (0.4 * lambda), seed + 17));
            const l = Math.hypot(nx[i], ny[i]) || 1;
            S.x[i] += nx[i] / l * off; S.y[i] += ny[i] / l * off;
        }
        // Tangents of the displaced line.
        for (let i = 0; i < m; i++) {
            const a = Math.max(0, i - 2), b = Math.min(m - 1, i + 2);
            const dx = S.x[b] - S.x[a], dy = S.y[b] - S.y[a], l = Math.hypot(dx, dy) || 1;
            S.tx[i] = dx / l; S.ty[i] = dy / l;
        }
    }
    // Width, on the final line. Per bank: as far as asked, or where the ground
    // would no longer hold the water.
    let widened = 1;
    {
        const total = S.s[m - 1], keep = [new Float64Array(m), new Float64Array(m)], step = 4;
        for (let i = 0; i < m; i++) {
            const a = Math.max(0, i - 8), b = Math.min(m - 1, i + 8), fall = Math.abs(S.W[a] - S.W[b]) / Math.max(S.s[b] - S.s[a], S.ds);
            const want = (riverWidthFactor(rid, S.s[i], total, o) - 1) * (1 - smoothstep(o.widenFall[0], o.widenFall[1], fall)) * S.hw[i];
            const nx = -S.ty[i], ny = S.tx[i];
            [1, -1].forEach((side, k2) => {
                const edge = side > 0 ? S.hwL[i] : S.hwR[i], last = Math.max(...o.containProbeM);
                let room = 0;
                for (let d = step; d <= want + last + step; d += step) {
                    if (!(groundAt(S.x[i] + nx * side * (edge + d), S.y[i] + ny * side * (edge + d)) >= S.W[i] + o.containM)) break;
                    room = d;
                }
                keep[k2][i] = Math.min(want, Math.max(0, room - last));
            });
        }
        const held = keep.map(v => Float64Array.from(v));
        const h = Math.max(1, Math.round(o.widenEndM / 4 / S.ds));
        for (const v of keep) smoothAlong(v, h);
        for (let i = 0; i < m; i++) {
            // The smoothing may not pass the ground's limit by much: a little
            // the containment takes up, more would lower the level for good.
            const hw = S.hw[i], most = (o.widenMax - 1) * hw;
            const l = Math.min(keep[0][i], held[0][i] + 2 * S.ds, most), r = Math.min(keep[1][i], held[1][i] + 2 * S.ds, most);
            S.hwL[i] += l; S.hwR[i] += r;
            const f = 1 + (l + r) / (2 * hw);
            S.hw[i] = hw * f; S.D[i] *= Math.sqrt(f); S.wide[i] = f;
            widened = Math.max(widened, f);
        }
    }
    S.widened = widened;
    // Banks do not climb. The widest pull over bankSmoothM, then smoothed: each station
    // keeps what its neighbours need, and a bank's line stays a line.
    {
        const pull = [new Float64Array(m), new Float64Array(m)], step = 2, h = Math.max(1, Math.round(o.bankSmoothM / S.ds / 2));
        for (let i = 0; i < m; i++) {
            const nx = -S.ty[i], ny = S.tx[i];
            [1, -1].forEach((side, k2) => {
                const edge = side > 0 ? S.hwL[i] : S.hwR[i], least = Math.min(edge, Math.max(o.bankLeast * edge, o.bankLeastM));
                let e = edge;
                // Rising against the river's own centre line: through a cut
                // (the land high on both sides) measured against the water
                // every station was pinched to its least width, the water in
                // dry-separated pieces (owner 2026-11-09, lake-cell rapids).
                const centre = groundAt(S.x[i], S.y[i]), ref = Number.isFinite(centre) ? Math.max(S.W[i], centre) : S.W[i];
                while (e > least && groundAt(S.x[i] + nx * side * e, S.y[i] + ny * side * e) > ref + o.bankCutM) e -= step;
                pull[k2][i] = edge - Math.max(e, least);
            });
        }
        for (const v of pull) {
            const held = Float64Array.from(v);
            for (let i = 0; i < m; i++) { let top = 0; for (let j = Math.max(0, i - h); j <= Math.min(m - 1, i + h); j++) top = Math.max(top, held[j]); v[i] = top; }
            smoothAlong(v, h);
        }
        for (let i = 0; i < m; i++) {
            const l = Math.min(pull[0][i], S.hwL[i] - Math.min(S.hwL[i], o.bankLeastM)), r = Math.min(pull[1][i], S.hwR[i] - Math.min(S.hwR[i], o.bankLeastM));
            S.hwL[i] -= l; S.hwR[i] -= r; S.hw[i] -= (l + r) / 2;
        }
    }
    // Where the centre enters its end lakes' water (the run of lake water from
    // each end, gaps of a few stations for shore wiggles): the channel fades
    // from there, not from the trace's mouth station, which can lie on land
    // before the water: faded on land it left a bar across the channel
    // (o03-thalweg). Without lake water at an end the mouth station stands in.
    const inLake = new Uint8Array(m);
    for (let i = 0; i < m; i++) inLake[i] = Number.isFinite(lakeWaterAt(S.x[i], S.y[i])) ? 1 : 0;
    const runEnd = (from, step) => {
        if (!inLake[from]) return -1;
        let e = from, miss = 0;
        for (let i = from; i >= 0 && i < m && miss <= 4; i += step) { if (inLake[i]) { e = i; miss = 0; } else miss++; }
        return e;
    };
    const eDest = Number.isFinite(river.destLevel) ? runEnd(m - 1, -1) : -1, eSrc = Number.isFinite(river.srcLevel) ? runEnd(0, 1) : -1;
    const ends = [];
    if (eDest >= 0) ends.push({ s: S.s[eDest], sign: 1, level: river.destLevel });
    if (eSrc >= 0) ends.push({ s: S.s[eSrc], sign: -1, level: river.srcLevel });
    for (const mo of mouths) if ((mo.sign > 0 ? eDest : eSrc) < 0) ends.push({ s: mo.s, sign: mo.sign });
    S.ends = ends;
    for (let i = 0; i < m; i++) {
        let fade = 0, near = 0, relaxW = 1;
        for (const end of ends) {
            const x = (S.s[i] - end.s) * end.sign;    // metres past the shore
            if (x > 0) {
                past[i] = 1;
                if (end.level === undefined) fade = Math.max(fade, smoothstep(0, o.fadeM + o.fadePerHw * S.hw[i], x));
                else {
                    const [a, b] = o.mouthFadeDepth;
                    fade = Math.max(fade, smoothstep(a * S.D[i], b * S.D[i], end.level - groundAt(S.x[i], S.y[i])), 1 - smoothstep(0, o.mouthTailM, end.sign > 0 ? S.s[m - 1] - S.s[i] : S.s[i]));
                    const hold = smoothstep(0, o.mouthHoldM, x);
                    if (hold > S.hold[i]) { S.hold[i] = hold; S.holdLevel[i] = end.level; }
                }
            }
            near = Math.max(near, 1 - smoothstep(0, o.mouthNearM, -x));
            if (x <= 0) relaxW = Math.min(relaxW, smoothstep(o.mouthRelaxM[0], o.mouthRelaxM[1], -x));
        }
        S.fade[i] = fade; S.mouth[i] = near; relax[i] = relaxW;
    }
    // Once faded, faded: the lake's bed may rise again farther out.
    for (const end of ends) {
        if (end.level === undefined) continue;
        let top = 0;
        for (let i = end.sign > 0 ? 0 : m - 1; i >= 0 && i < m; i += end.sign) {
            if ((S.s[i] - end.s) * end.sign <= 0) continue;
            top = Math.max(top, S.fade[i]); S.fade[i] = top;
        }
    }
    // Containment: W at most the ground beside the channel minus containM,
    // narrow notches ignored, never rising downstream, between the lakes.
    const cap = new Float64Array(m).fill(Infinity);
    for (let i = 0; i < m; i++) {
        const nx = -S.ty[i], ny = S.tx[i];
        for (const side of [1, -1]) {
            // From this side's own edge, as the spill is measured: from the
            // average width, low ground just past the probes took water.
            const hw = side > 0 ? S.hwL[i] : S.hwR[i];
            let lo = Infinity;
            for (const d of o.containProbeM) lo = Math.min(lo, groundAt(S.x[i] + nx * side * (hw + d), S.y[i] + ny * side * (hw + d)));
            if (!past[i] && !S.lake[i]) cap[i] = Math.min(cap[i], lo - o.containM);
        }
    }
    // Ignore notches: the cap's max over a window of notchM.
    const half = Math.min(m, Math.max(1, Math.round(o.notchM / S.ds / 2))), capW = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        let v = -Infinity;
        for (let j = Math.max(0, i - half); j <= Math.min(m - 1, i + half); j++) v = Math.max(v, cap[j]);
        capW[i] = v;
    }
    // The highest level under the cap that never rises downstream: a running
    // minimum. Averaging the dips away instead put W back over the bank at the
    // lowest points, and the water leaked out there.
    const lo = river.destLevel ?? -Infinity, hi = river.srcLevel ?? Infinity;
    let run = Infinity;
    for (let i = 0; i < m; i++) {
        run = Math.min(run, S.W[i], capW[i] + (1 - relax[i]) * 1e4);
        // Keep the bed depth: the bed follows a lowered surface.
        S.W[i] = clamp(run, lo, hi);
    }
    // Meet the end lakes' water at their levels.
    const meet = (from, step, e, lvl) => {
        if (e < 0) return;
        for (let i = from; i !== e + step; i += step) S.W[i] = lvl;
        const ease = Math.max(o.lakeEaseM, o.lakeEasePerM * Math.abs((S.W[e + step] ?? lvl) - lvl));
        for (let i = e + step, x = S.ds; i >= 0 && i < m && x < ease; i += step, x += S.ds) S.W[i] = lvl + (S.W[i] - lvl) * smoothstep(0, ease, x);
    };
    meet(m - 1, -1, eDest, river.destLevel);
    meet(0, 1, eSrc, river.srcLevel);
    // Bank widths per side from the bank type and the incision, smoothed along the river.
    const bankLerp = (arr, tau) => tau < 1 ? arr[0] + (arr[1] - arr[0]) * tau : arr[1] + (arr[2] - arr[1]) * (tau - 1);
    const raw2 = [new Float64Array(m), new Float64Array(m)];
    for (let i = 0; i < m; i++) {
        const nx = -S.ty[i], ny = S.tx[i], hw = S.hw[i];
        for (const [k2, tau, side] of [[0, tauL[i], 1], [1, tauR[i], -1]]) {
            // Out to where a bank of this side's slope meets the natural
            // ground (a river through a ridge: measured beside the water the
            // bank came out as a black cliff, o29c-accordion).
            const C = bankLerp(o.bankC, tau);
            const atEdge = groundAt(S.x[i] + nx * side * hw, S.y[i] + ny * side * hw);
            (k2 ? S.ER : S.EL)[i] = Number.isFinite(atEdge) ? atEdge : S.W[i];
            // At least out of the channel: through a ridge the ground is high
            // at the water's edge already.
            const least = Number.isFinite(atEdge) ? C * Math.max(0, atEdge - S.W[i]) : 0;
            let need = least, gPrev = atEdge, dPrev = 0;
            for (const d of o.bankProbeM) {
                const g = groundAt(S.x[i] + nx * side * (hw + d), S.y[i] + ny * side * (hw + d));
                if (!Number.isFinite(g)) break;
                // A hillside steeper than this bank never meets it: the hill is
                // the bank from here. Searching on took the bank to reachM, and
                // the jump between such stations and their neighbours stood as a
                // black wall across the slope (o29c-accordion).
                if (d >= least && (g - gPrev) * C >= d - dPrev) { need = Math.max(least, dPrev); break; }
                need = Math.max(least, C * Math.max(0, g - S.W[i]));
                if (d >= need) break;
                gPrev = g; dPrev = d;
            }
            // Toward a mouth the banks open out (a channel cut steeply into
            // its lake's shore drew a dark face along it: o03-thalweg).
            const open = o.mouthBankM * S.mouth[i];
            // Each side's own width at two scales (gentle long slopes, steeper
            // short ones), never steeper than bankSteepMax: one bank type for
            // a whole river read as a uniform moat (owner 2026-11-09).
            const vary = Math.exp(o.bankVary[0] * bankNoise(S.s[i] / o.bankVaryM[0], rid * 2 + k2) + o.bankVary[1] * bankNoise(S.s[i] / o.bankVaryM[1], rid * 2 + k2 + 101));
            const height = Number.isFinite(atEdge) ? Math.max(0, atEdge - S.W[i]) : 0;
            const width = Math.max((bankLerp(o.bankB0, tau) + need) * clamp(vary, o.bankVaryRange[0], o.bankVaryRange[1]), height / o.bankSteepMax);
            raw2[k2][i] = Math.min(o.reachM, Math.max(width, open));
        }
    }
    const hb = Math.min(m, Math.max(1, Math.round(o.bankSmoothM / S.ds / 2)));
    for (const [src, dst] of [[raw2[0], S.BL], [raw2[1], S.BR]]) {
        // Banks open gradually along the river: a sudden change of width is an
        // edge across the slope, however smooth each cross-section is.
        const open = o.bankOpen * S.ds;
        for (let i = 1; i < m; i++) src[i] = Math.max(src[i], src[i - 1] - open);
        for (let i = m - 2; i >= 0; i--) src[i] = Math.max(src[i], src[i + 1] - open);
        let acc = 0, cnt = 0;
        for (let i = -hb; i < m + hb; i++) {
            if (i + hb < m) { acc += src[i + hb]; cnt++; }
            if (i - hb - 1 >= 0) { acc -= src[i - hb - 1]; cnt--; }
            if (i >= 0 && i < m) dst[i] = acc / cnt;
        }
    }
    smoothAlong(S.EL, hb); smoothAlong(S.ER, hb);
    return S;
}

// Spatial index of station segments in the river's plane: cell -> station indices.
// Groups of GROUP stations with their bounding boxes, and a spatial index
// of the groups in the river's plane: cell -> group ids. A texel tests the
// groups listed for its cell nearest-box first and skips any farther than
// its best segment so far (stations are every texel; per-segment lists
// reached ~150 segments per cell on wide rivers: minutes per bake).
const GROUP = 8;
function stationIndex(S, cellM, reach) {
    const ng = Math.ceil((S.m - 1) / GROUP), box = new Float64Array(ng * 4), cells = new Map();
    for (let g = 0; g < ng; g++) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, r = 0;
        for (let i = g * GROUP; i <= Math.min(S.m - 1, (g + 1) * GROUP); i++) {
            x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); y0 = Math.min(y0, S.y[i]); y1 = Math.max(y1, S.y[i]);
            if (i < S.m - 1) r = Math.max(r, reach(i));
        }
        box.set([x0, y0, x1, y1], g * 4);
        if (!Number.isFinite(x0 + x1 + y0 + y1 + r)) continue;
        for (let cy = Math.floor((y0 - r) / cellM); cy <= Math.floor((y1 + r) / cellM); cy++) {
            for (let cx = Math.floor((x0 - r) / cellM); cx <= Math.floor((x1 + r) / cellM); cx++) {
                const key = cx * 1e6 + cy;
                let list = cells.get(key);
                if (!list) cells.set(key, (list = []));
                list.push(g);
            }
        }
    }
    return { cells, box, ng };
}

/**
 * Ground of a river at plane point (px, py) over natural ground nat:
 * { h, W, edge } or null where its index lists no station. edge: distance
 * beyond the water's edge (m, < 0 in the water).
 */
function riverGround(S, index, cellM, px, py, nat, o) {
    const list = index.cells.get(Math.floor(px / cellM) * 1e6 + Math.floor(py / cellM));
    if (!list) return null;
    let best = Infinity, bi = -1, bt = 0;
    const box = index.box;
    for (const g of list) {
        const dx0 = Math.max(box[g * 4] - px, 0, px - box[g * 4 + 2]), dy0 = Math.max(box[g * 4 + 1] - py, 0, py - box[g * 4 + 3]);
        if (dx0 * dx0 + dy0 * dy0 >= best) continue;
        for (let i = g * GROUP; i < Math.min(S.m - 1, (g + 1) * GROUP); i++) {
            const ax = S.x[i], ay = S.y[i], bx = S.x[i + 1] - ax, by = S.y[i + 1] - ay;
            const l2 = bx * bx + by * by;
            // Round caps at the river's ends: its trace runs into its lakes,
            // where the channel has faded already (S.fade).
            const t = clamp(l2 > 0 ? ((px - ax) * bx + (py - ay) * by) / l2 : 0, 0, 1);
            const dx = px - ax - bx * t, dy = py - ay - by * t, d2 = dx * dx + dy * dy;
            if (d2 < best) { best = d2; bi = i; bt = t; }
        }
    }
    if (bi < 0) return null;
    const i = bi, tc = bt;
    const lerp = (a) => a[i] + (a[i + 1] - a[i]) * tc;
    const bx = S.x[i + 1] - S.x[i], by = S.y[i + 1] - S.y[i];
    const side = bx * (py - S.y[i]) - by * (px - S.x[i]) >= 0 ? 1 : -1;   // + left of the flow
    const n = Math.sqrt(best) * side;
    const fade = lerp(S.fade);
    const hw = lerp(n >= 0 ? S.hwL : S.hwR) * (1 + o.fadeWiden * fade), W = lerp(S.W), D = lerp(S.D) * (1 - fade);
    const d = Math.abs(n), edge = d - hw;
    const B = n >= 0 ? lerp(S.BL) : lerp(S.BR);
    if (edge >= B) return { h: nat, W, edge, st: i + tc, side, fade };
    // Channel: the thalweg toward the outer bank (skew), the bed at W - D.
    const sk = clamp(lerp(S.skew), -0.35, 0.35), u = n / hw;
    const de = u < sk ? (u - sk) / (1 + sk) : (u - sk) / (1 - sk);
    const power = 2 + (o.widenFlat - 2) * smoothstep(1, 3, lerp(S.wide));
    let target;
    if (edge < 0) target = W - D * (1 - Math.abs(de) ** power);
    else {
        // Toe: the channel's edge slope; then the C2 ramp to natural ground.
        const e = Math.min(o.toeSlopeMax, power * D / (hw * (n >= 0 ? 1 - sk : 1 + sk)));
        const t = edge / B, r = t * t * t * (t * (t * 6 - 15) + 10);
        // On a hillside the bank follows the hill: a depth measured at the water's
        // edge, fading out. To a level instead, the texels sharing a station on
        // the outside of a bend cut a shelf into the slope, its head a black
        // wall (o29c-accordion). The low side keeps its level (containment).
        const foot = lerp(n >= 0 ? S.EL : S.ER);
        target = Math.max((W + e * edge) * (1 - r) + nat * r, nat + (W + e * edge - foot) * (1 - r));
    }
    const cut = smin(nat, target, o.sminK), hold = lerp(S.hold);
    return { h: hold > 0 ? cut + (nat - cut) * hold * smoothstep(0, o.mouthHoldRiseM, nat - S.holdLevel[i + (S.hold[i] > 0 ? 0 : 1)]) : cut, W, edge, st: i + tc, target, side, fade };
}

// Gaussian blur weights (sigma in texels), radius ceil(2.5 sigma).
function gaussian(sigma) {
    const r = Math.max(1, Math.ceil(2.5 * sigma)), w = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); w.push(v); sum += v; }
    return { r, w: w.map(v => v / sum) };
}

// 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
function edt1(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
}
function edt2(grid, w, h) {
    const INF = 1e12, n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const out = new Float64Array(w * h);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) f[y] = grid[y * w + x] ? 0 : INF;
        edt1(f, h, d, v, z);
        for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) f[x] = out[y * w + x];
        edt1(f, w, d, v, z);
        for (let x = 0; x < w; x++) out[y * w + x] = d[x];
    }
    return out;
}

/**
 * The bake. rivers: [{ rec, arc, rid, levels, srcLevel, destLevel }];
 * sampleNatural(dirs4: Float32Array) -> Promise<Float32Array> heights (m);
 * lakeAt(dir) -> { level } | null (lake masks as drawn).
 * Returns { pages: Map key -> Float32Array(TEX * 4) [Δ, W, sdf, owner], stats }.
 */
export async function bakeRiverField({ rivers, L, sampleNatural, lakeAt, o = RIVER_FIELD, debug = false }) {
    const t0 = performance.now();
    const prep = prepareRiverFieldBake({ rivers, L, o });
    const t1 = performance.now();
    const nat = await sampleNatural(prep.dirs4);
    const t2 = performance.now();
    const lakeCand = await riverFieldLakeCandidates({ rivers, dirs4: prep.dirs4, nat, lakeAt });
    const out = finishRiverFieldBake({ rivers, L, ...prep, nat, lakeCand, o, debug });
    out.stats.ms = { dirs: t1 - t0, sample: t2 - t1, ...out.stats.ms, total: performance.now() - t0 };
    return out;
}

/** Main thread, step 1: the pages and their texels' directions (dirs4: x, y, z, 0). */
export function prepareRiverFieldBake({ rivers, L, o = RIVER_FIELD }) {
    const pageRivers = riverFieldPages(rivers, L, o);
    const keys = [...pageRivers.keys()];
    const dirs4 = riverFieldPageDirections(keys, L);
    return { keys, pageRivers: keys.map(k => [...pageRivers.get(k)]), dirs4 };
}

/** Unit directions at page texel centres, in key order. */
export function riverFieldPageDirections(keys, L) {
    const P = L.P, PP = P * P;
    const N = keys.length;
    const dirs4 = new Float32Array(N * PP * 4);
    // Equal-angle coordinates depend on just one axis. Many pages share the
    // same row or column; calculate each tangent once instead of per texel.
    const axes = new Map();
    const axis = (page) => {
        let values = axes.get(page);
        if (!values) {
            values = new Float64Array(P);
            for (let i = 0; i < P; i++) {
                const a = (page * P + i + 0.5) / L.T * 2 - 1;
                values[i] = (Math.tan(a * QUARTER_PI) + 1) * 0.5;
            }
            axes.set(page, values);
        }
        return values;
    };
    for (let p = 0; p < N; p++) {
        const { face, pi, pj } = pageOf(keys[p], L);
        const u = axis(pi), v = axis(pj);
        for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
            const d = faceUVToDir(face, u[i], v[j]), w = (p * PP + j * P + i) * 4;
            dirs4[w] = d[0]; dirs4[w + 1] = d[1]; dirs4[w + 2] = d[2];
        }
    }
    return dirs4;
}

// Lake blocks farther than this (m) from the drawn edge are all in or all out.
const EDGE_BLOCK_M = 12;
/**
 * Main thread, step 2 (the lake masks live there): per texel, the level of
 * a lake whose mask covers it where the natural ground is within reach of
 * its level (a channel cut lowers ground by a few metres), else NaN.
 */
export async function riverFieldLakeCandidates({ rivers, dirs4, nat, lakeAt, page = RIVER_FIELD.page, block = 4, pause = null }) {
    const out = new Float32Array(nat.length).fill(NaN), PP = page * page;
    let maxLake = -Infinity;
    for (const r of rivers) maxLake = Math.max(maxLake, r.srcLevel ?? -Infinity, r.destLevel ?? -Infinity);
    // One lookup per block x block texels (the masks are 32 m; 8 m blocks).
    for (let p = 0; p * PP < nat.length; p++) {
      if (pause) await pause();
      for (let bj = 0; bj < page; bj += block) for (let bi = 0; bi < page; bi += block) {
        let low = false;
        for (let j = bj; j < bj + block && !low; j++) for (let i = bi; i < bi + block; i++) if (nat[p * PP + j * page + i] < maxLake + 4) { low = true; break; }
        if (!low) continue;
        const c = p * PP + (bj + (block >> 1)) * page + bi + (block >> 1);
        const l = lakeAt([dirs4[c * 4], dirs4[c * 4 + 1], dirs4[c * 4 + 2]]);
        if (!l) continue;
        const inside = l.inside ?? Infinity;
        if (inside < -EDGE_BLOCK_M) continue;
        for (let j = bj; j < bj + block; j++) for (let i = bi; i < bi + block; i++) {
            const g = p * PP + j * page + i;
            // Near the drawn edge per texel: its shore is a smooth curve. By
            // blocks it drew a staircase wherever the ground lies under the
            // lake's level past the edge (o05-mouth-lines).
            if (inside > EDGE_BLOCK_M) { out[g] = l.level; continue; }
            const t = lakeAt([dirs4[g * 4], dirs4[g * 4 + 1], dirs4[g * 4 + 2]]);
            if (t && (t.inside ?? 1) > 0) out[g] = t.level;
        }
      }
    }
    return out;
}

/**
 * Per page, for publishing without touching its texels on the main thread: a
 * hash (what changed since the last bake) and whether it holds water (the near
 * water draws those). keys in slot order.
 */
export function riverFieldPageFacts(keys, pages, L) {
    const hash = new Uint32Array(keys.length), wet = new Uint8Array(keys.length);
    keys.forEach((key, slot) => {
        const data = pages.get(key);
        let h = 2166136261;
        for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
        hash[slot] = h;
        for (let j = L.A; j < L.A + L.P && !wet[slot]; j++) for (let i = L.A; i < L.A + L.P; i++) {
            if (riverFieldTexelSdf(data, j * L.ST + i) > -2) { wet[slot] = 1; break; }
        }
    });
    return { hash, wet };
}

/** Step 3 (a worker, riverFieldWorker.js): everything else. */
export function finishRiverFieldBake({ rivers, L, keys, pageRivers: pageRiverList, dirs4, nat, lakeCand, o = RIVER_FIELD, debug = false, onProgress = null, cullPages = true }) {
    const t2 = performance.now(), P = L.P, PP = P * P, R = L.R;
    const slot = new Map(keys.map((k, i) => [k, i]));
    const N = keys.length;
    const pageInfo = keys.map(k => pageOf(k, L));
    // Neighbour access across pages of a face (none across faces).
    const texel = (p, i, j) => {
        if (i >= 0 && j >= 0 && i < P && j < P) return p * PP + j * P + i;
        const { face, pi, pj } = pageInfo[p];
        const gi = pi * P + i, gj = pj * P + j;
        if (gi < 0 || gj < 0 || gi >= L.T || gj >= L.T) return -1;
        const q = slot.get(pageKey(face, Math.floor(gi / P), Math.floor(gj / P), L));
        return q === undefined ? -1 : q * PP + (gj - Math.floor(gj / P) * P) * P + gi - Math.floor(gi / P) * P;
    };
    // Natural ground anywhere (bilinear on the texels) for the stations.
    const groundAtDir = (dir) => {
        const q = fieldCoords(dir, L), x = q.x - 0.5, y = q.y - 0.5, i0 = Math.floor(x), j0 = Math.floor(y), fx = x - i0, fy = y - j0;
        const p0 = slot.get(pageKey(q.face, clamp(Math.floor(i0 / P), 0, L.PE - 1), clamp(Math.floor(j0 / P), 0, L.PE - 1), L));
        if (p0 === undefined) return Infinity;
        const { pi, pj } = pageInfo[p0];
        const li = i0 - pi * P, lj = j0 - pj * P;
        const a = texel(p0, li, lj), b = texel(p0, li + 1, lj), c = texel(p0, li, lj + 1), d = texel(p0, li + 1, lj + 1);
        if (a < 0 || b < 0 || c < 0 || d < 0) return a >= 0 ? nat[a] : Infinity;
        return (nat[a] * (1 - fx) + nat[b] * fx) * (1 - fy) + (nat[c] * (1 - fx) + nat[d] * fx) * fy;
    };
    // Lake water at a direction: the level where the lake covers the nearest texel under its level.
    const lakeWaterAtDir = (dir) => {
        const q = fieldCoords(dir, L), i = Math.floor(q.x), j = Math.floor(q.y), pi = Math.floor(i / P), pj = Math.floor(j / P);
        const p0 = slot.get(pageKey(q.face, pi, pj, L));
        if (p0 === undefined) return NaN;
        const g = p0 * PP + (j - pj * P) * P + i - pi * P;
        return nat[g] < lakeCand[g] ? lakeCand[g] : NaN;
    };
    // Stations and indices per river.
    onProgress?.('stations', { pages: keys.length });
    const widest = [];
    const prepared = rivers.map((river, ri) => {
        const plane = riverPlane(river, R);
        const fromPlane = (x, y) => norm([plane.frame.c[0] + (x * plane.frame.e1[0] + y * plane.frame.e2[0]) / R,
            plane.frame.c[1] + (x * plane.frame.e1[1] + y * plane.frame.e2[1]) / R, plane.frame.c[2] + (x * plane.frame.e1[2] + y * plane.frame.e2[2]) / R]);
        const S = riverStations(river, plane, (x, y) => groundAtDir(fromPlane(x, y)), (x, y) => lakeWaterAtDir(fromPlane(x, y)), o);
        widest.push(S.widened);
        S.rid = river.rid ?? 0;
        riverFlowDesign(S, S.rid);
        // Bank noise varies over hundreds of metres, while stations are about
        // two metres apart. Evaluate it once per station and interpolate at
        // texels instead of hashing twice for every point in the wide corridor.
        if (o.bankPreview) {
            const b = o.bankPreview;
            S.previewReachL = new Float32Array(S.m); S.previewReachR = new Float32Array(S.m);
            S.previewRiseL = new Float32Array(S.m); S.previewRiseR = new Float32Array(S.m);
            for (let i = 0; i < S.m; i++) {
                for (const [reach, rise, side] of [[S.previewReachL, S.previewRiseL, 1], [S.previewReachR, S.previewRiseR, -1]]) {
                    reach[i] = b.meanM + b.variationM * bankNoise(S.s[i] / b.waveM, S.rid * 2 + (side > 0 ? 791 : 792));
                    rise[i] = b.riseVariationM * smoothstep(-0.35, 0.75,
                        bankNoise(S.s[i] / b.riseWaveM, S.rid * 2 + (side > 0 ? 1247 : 1248)));
                }
            }
        }
        const cellM = 32;
        let maxHw = 0;
        for (let i = 0; i < S.m; i++) maxHw = Math.max(maxHw, S.hw[i]);
        const index = stationIndex(S, cellM, (i) => S.hw[i] * (1 + o.shoreAmp) * (1 + o.fadeWiden) + Math.max(o.bankPreview?.reachM ?? 0, S.BL[i], S.BR[i], S.BL[i + 1], S.BR[i + 1]) + 4);
        let refs = 0, x0 = Infinity, x1 = -Infinity;
        for (const l of index.cells.values()) refs += l.length;
        for (let i = 0; i < S.m; i++) { x0 = Math.min(x0, S.x[i], S.y[i]); x1 = Math.max(x1, S.x[i], S.y[i]); }
        onProgress?.('river', { ri, rid: river.rid, stations: S.m, cells: index.cells.size, refs, span: x1 - x0 });
        return { plane, S, index, cellM, fromPlane };
    });
    const t3 = performance.now();
    onProgress?.('texels', { ms: t3 - t2 });
    // Most pages exist for station ground probes, beyond all indexed river
    // sections. Project the four page corners into each river plane; the
    // gnomonic projection is linear-fractional, so its extrema are at the
    // corners while the denominator is positive. Expand the bounds for the
    // Float32 direction rounding used below. Ambiguous cases are kept.
    let culledPageRivers = 0, emptyTexelPages = 0;
    const pageCandidates = cullPages ? pageRiverList.map((list, p) => {
        const { face, pi, pj } = pageInfo[p];
        const x0 = pi * P + 0.5, x1 = (pi + 1) * P - 0.5, y0 = pj * P + 0.5, y1 = (pj + 1) * P - 0.5;
        const corners = [fieldDir(face, x0, y0, L), fieldDir(face, x1, y0, L), fieldDir(face, x0, y1, L), fieldDir(face, x1, y1, L)];
        return list.filter(ri => {
            const { plane, index, cellM } = prepared[ri], { c, e1, e2 } = plane.frame;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minD = Infinity;
            for (const d of corners) {
                const den = dot(d, c);
                minD = Math.min(minD, den);
                if (den <= 1e-5) return true;
                const x = dot(d, e1) / den, y = dot(d, e2) / den;
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
            const minDen = minD / Math.sqrt(3) - 1e-6;
            if (minDen <= 0) return true;
            const margin = R * 1e-6 * (1 + Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY))) / minDen + 1e-6;
            const i0 = Math.floor((R * minX - margin) / cellM), i1 = Math.floor((R * maxX + margin) / cellM);
            const j0 = Math.floor((R * minY - margin) / cellM), j1 = Math.floor((R * maxY + margin) / cellM);
            if ((i1 - i0 + 1) * (j1 - j0 + 1) > 256) return true;
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                if (index.cells.has(i * 1e6 + j)) return true;
            }
            culledPageRivers++;
            return false;
        });
    }) : pageRiverList;
    // Per texel: ground, W, owner over the rivers listed for its page.
    const ground = new Float32Array(N * PP), W = new Float32Array(N * PP).fill(NaN), owner = new Int16Array(N * PP).fill(-1);
    const edgeOf = new Float32Array(N * PP).fill(Infinity), ownerSt = new Float32Array(N * PP);
    for (let p = 0; p < N; p++) {
        const list = pageCandidates[p];
        if (!list.length) {
            ground.set(nat.subarray(p * PP, (p + 1) * PP), p * PP);
            emptyTexelPages++;
            continue;
        }
        for (let t = 0; t < PP; t++) {
            const g = p * PP + t, w = g * 4, dx = dirs4[w], dy = dirs4[w + 1], dz = dirs4[w + 2];
            let h = nat[g], lift = 0, wetLift = 0, channelCount = 0;
            for (const ri of list) {
                const { plane, S, index, cellM } = prepared[ri];
                const { c, e1, e2 } = plane.frame, kk = R / (dx * c[0] + dy * c[1] + dz * c[2]);
                const px = (dx * e1[0] + dy * e1[1] + dz * e1[2]) * kk, py = (dx * e2[0] + dy * e2[1] + dz * e2[2]) * kk;
                const r = riverGround(S, index, cellM, px, py, nat[g], o);
                if (!r) continue;
                if (r.edge < edgeOf[g]) { edgeOf[g] = r.edge; W[g] = r.W; owner[g] = ri; ownerSt[g] = r.st; }
                h = Math.min(h, r.h);
                if (r.edge < 0) channelCount++;
                const preview = o.bankPreview;
                if (!preview || nat[g] < lakeCand[g]) continue;
                // The preview can support a river above the surrounding terrain. Leave lake beds
                // and overlapping channels alone; a lake or confluence owns those cross-sections.
                if (r.edge < 0 && Number.isFinite(r.target)) {
                    wetLift = Math.max(wetLift, Math.max(0, r.target - nat[g]) * (1 - r.fade));
                } else if (r.edge > 0 && r.edge < preview.reachM) {
                    const si = Math.min(S.m - 2, Math.floor(r.st));
                    const f = r.st - si;
                    const reaches = r.side > 0 ? S.previewReachL : S.previewReachR;
                    const rises = r.side > 0 ? S.previewRiseL : S.previewRiseR;
                    const reach = reaches[si] + (reaches[si + 1] - reaches[si]) * f;
                    const taper = 1 - smoothstep(preview.taperStart * reach, reach, r.edge);
                    // Meet the supported channel at water level and rise gently away
                    // from it. A crest at the edge creates a conspicuous levee.
                    // Long, independent waves on each side create occasional
                    // higher ground, fading in away from the waterline so the
                    // shore remains continuous with the supported channel.
                    const rise = (rises[si] + (rises[si + 1] - rises[si]) * f)
                        * smoothstep(preview.riseStartM, preview.riseFullM, r.edge);
                    const target = r.W + preview.valleySlope * r.edge + rise;
                    lift = Math.max(lift, Math.max(0, target - r.h) * taper * (1 - r.fade));
                }
            }
            ground[g] = channelCount ? (channelCount === 1 && wetLift > 0 ? nat[g] + wetLift : h) : h + lift;
        }
    }
    // Texels beyond every river's reach take the nearest owned texel's W
    // (the field's W stays smooth for interpolation and the micro clamp).
    {
        const q = new Int32Array(N * PP);
        let h0 = 0, t0q = 0;
        for (let g = 0; g < N * PP; g++) if (Number.isFinite(W[g])) q[t0q++] = g;
        while (h0 < t0q) {
            const g = q[h0++], p = Math.floor(g / PP), t = g - p * PP, i = t % P, j = (t - i) / P;
            for (let side = 0; side < 4; side++) {
                const di = (side === 0) - (side === 1), dj = (side === 2) - (side === 3);
                const n2 = texel(p, i + di, j + dj);
                if (n2 < 0 || Number.isFinite(W[n2])) continue;
                W[n2] = W[g]; q[t0q++] = n2;
            }
        }
    }
    const t4 = performance.now();
    onProgress?.('blur', { ms: t4 - t3 });
    // Blur Δ (separable, within the page set; missing neighbours count as no change).
    const delta = new Float32Array(N * PP);
    for (let g = 0; g < N * PP; g++) delta[g] = ground[g] - nat[g];
    const tmp = new Float32Array(N * PP);
    let emptyBlurPages = 0;
    const blur = (G) => {
        for (const [dx, dy, src, dst] of [[1, 0, delta, tmp], [0, 1, tmp, delta]]) {
            const nonzero = new Uint8Array(N);
            for (let p = 0; p < N; p++) {
                for (let g = p * PP; g < (p + 1) * PP; g++) {
                    if (src[g] !== 0) { nonzero[p] = 1; break; }
                }
            }
            for (let p = 0; p < N; p++) {
                const { face, pi, pj } = pageInfo[p], reach = Math.ceil(G.r / P);
                let occupied = false;
                for (let k = -reach; k <= reach; k++) {
                    const x = pi + dx * k, y = pj + dy * k;
                    if (x < 0 || y < 0 || x >= L.PE || y >= L.PE) continue;
                    const neighbour = slot.get(pageKey(face, x, y, L));
                    if (neighbour !== undefined && nonzero[neighbour]) { occupied = true; break; }
                }
                if (!occupied) {
                    // The second pass writes back into delta, which may already
                    // contain values. An empty horizontal neighbourhood guarantees
                    // the first pass wrote zero there, but clear it explicitly.
                    dst.fill(0, p * PP, (p + 1) * PP);
                    emptyBlurPages++;
                    continue;
                }
                for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
                    let v = 0;
                    for (let k = -G.r; k <= G.r; k++) { const q = texel(p, i + dx * k, j + dy * k); if (q >= 0) v += G.w[k + G.r] * src[q]; }
                    dst[p * PP + j * P + i] = v;
                }
            }
        }
    };
    const preview = o.bankPreview;
    blur(gaussian((preview?.blurM ?? o.blurM) / o.texelM));
    if (preview?.nearBlurM != null && preview.nearBlurM < preview.blurM) {
        const broad = delta.slice();
        for (let g = 0; g < N * PP; g++) delta[g] = ground[g] - nat[g];
        blur(gaussian(preview.nearBlurM / o.texelM));
        for (let g = 0; g < N * PP; g++) {
            const w = smoothstep(preview.blurFadeM[0], preview.blurFadeM[1], edgeOf[g]);
            delta[g] += (broad[g] - delta[g]) * w;
        }
    }
    // Deep in the channel the ground stays exact, smooth by construction: over
    // a steep natural surface the blur left stripes across the bed
    // (o29c-accordion) and next to a steep lake shore lifted it over the
    // water, a bar across the river. The blur is back before the water's edge:
    // without it the texels' aliasing, a few centimetres, moved shorelines on
    // flat ground by metres (ragged banks, o03-corner-wing).
    for (let g = 0; g < N * PP; g++) {
        const w = smoothstep(-o.blurFromM, 0, edgeOf[g]);
        delta[g] = (ground[g] - nat[g]) * (1 - w) + delta[g] * w;
        // Do not smear a raised preview bank into a lake's submerged ground.
        // Preserve the unblurred lake/channel result for those texels.
        if (o.bankPreview && nat[g] < lakeCand[g]) delta[g] = ground[g] - nat[g];
        ground[g] = nat[g] + delta[g];
    }
    const t5 = performance.now();
    onProgress?.('lakes', { ms: t5 - t4 });
    // Lakes: level where a lake's mask covers the texel and the ground is low. Not
    // in a channel still above the lake: the 32 m mask reaches up a steep stream's
    // last metres, and at the lake's level only the tip of its cut is under water, a
    // neck across the river just before its lake (owner 2026-11-05, o-blue). The
    // stations bring W down to the lake's level where the river really reaches it.
    const lakeLevel = new Float32Array(N * PP).fill(NaN);
    for (let g = 0; g < N * PP; g++) if (ground[g] < lakeCand[g] + 1 && !(edgeOf[g] < 0 && W[g] > lakeCand[g] + 0.02)) lakeLevel[g] = lakeCand[g];
    // Water level per texel: a lake's where it covers, else the owning river's.
    const level = new Float32Array(N * PP);
    for (let g = 0; g < N * PP; g++) level[g] = Number.isFinite(lakeLevel[g]) ? lakeLevel[g] : W[g];
    // Wet: below the level, connected to a channel's centre or to lake water.
    const wet = new Uint8Array(N * PP), queue = new Int32Array(N * PP);
    let qh = 0, qt = 0;
    for (let g = 0; g < N * PP; g++) {
        const seed = (owner[g] >= 0 && edgeOf[g] < -0.5 && ground[g] < level[g] - 0.02) || (Number.isFinite(lakeLevel[g]) && ground[g] < lakeLevel[g] - 0.05);
        if (seed) { wet[g] = 1; queue[qt++] = g; }
    }
    while (qh < qt) {
        const g = queue[qh++], p = Math.floor(g / PP), t = g - p * PP, i = t % P, j = (t - i) / P;
        for (let side = 0; side < 4; side++) {
            const di = (side === 0) - (side === 1), dj = (side === 2) - (side === 3);
            const q = texel(p, i + di, j + dj);
            if (q < 0 || wet[q] || !(ground[q] < level[q])) continue;
            // River water reaches only so far beyond its channel: texels past
            // every river's reach only inherit a level, and connected low
            // ground filled up as a flooded bay (o05-mouth-lines).
            if (!Number.isFinite(lakeLevel[q]) && (owner[q] < 0 || edgeOf[q] > o.spillM)) continue;
            wet[q] = 1; queue[qt++] = q;
        }
    }
    // River water beyond its channel's edge (texels): containment's leaks.
    let spilled = 0;
    for (let g = 0; g < N * PP; g++) if (wet[g] && !Number.isFinite(lakeLevel[g]) && edgeOf[g] > 1) spilled++;
    // Dry texels nearest a lake's water take its level: with a far river's
    // level beside a lake the surface tilted up at its shore, and small
    // hollows there showed as a dotted line (o29-mouth-corners). Texels
    // nearest a river keep their station's level, smooth along it (nearest
    // texels' levels were rough on a steep stream: hard cuts in its water).
    {
        const seen = wet.slice(), fromLake = new Uint8Array(N * PP);
        let h2 = 0, t2q = 0;
        for (let g = 0; g < N * PP; g++) if (wet[g]) { queue[t2q++] = g; fromLake[g] = Number.isFinite(lakeLevel[g]) ? 1 : 0; }
        while (h2 < t2q) {
            const g = queue[h2++], p = Math.floor(g / PP), t = g - p * PP, i = t % P, j = (t - i) / P;
            for (let side = 0; side < 4; side++) {
                const di = (side === 0) - (side === 1), dj = (side === 2) - (side === 3);
                const q = texel(p, i + di, j + dj);
                if (q < 0 || seen[q]) continue;
                seen[q] = 1; fromLake[q] = fromLake[g];
                if (fromLake[g]) level[q] = level[g];
                queue[t2q++] = q;
            }
        }
    }
    // Dry ground under the water's level that a crest cuts off from the water (owner 2026-11-10: a
    // crest 5 cm over a lake's level, a hollow 1.8 m deep behind it): the meshes draw the water KEEP_M
    // past its edge, for the terrain's depth to cut the shoreline, and over such a hollow that strip
    // stood in the air beyond the crest, a see-through sheet. It reads far outside (signed distance,
    // below): no strip there, and a wall to the near simulation. Its level stays. Low ground straight
    // beside the water is left as it was: the terrain draws the water over it at the level, and with
    // its level lowered instead the river's water stood over it as a floating platform (owner
    // 2026-11-11), with ground lifted under it as an embankment (owner: "horrible").
    const leftDry = new Uint8Array(N * PP);
    {
        const open = new Uint8Array(N * PP);
        let h = 0, t = 0;
        for (let g = 0; g < N * PP; g++) if (wet[g]) { open[g] = 1; queue[t++] = g; }
        while (h < t) {
            const g = queue[h++], p = Math.floor(g / PP), r = g - p * PP, i = r % P, j = (r - i) / P;
            for (let side = 0; side < 4; side++) {
                const di = (side === 0) - (side === 1), dj = (side === 2) - (side === 3);
                const q = texel(p, i + di, j + dj);
                if (q < 0 || open[q] || !(ground[q] < level[q])) continue;
                open[q] = 1; queue[t++] = q;
            }
        }
        for (let g = 0; g < N * PP; g++) if (!wet[g] && !open[g] && ground[g] < level[g]) leftDry[g] = 1;
    }
    const t6 = performance.now();
    onProgress?.('sdf', { ms: t6 - t5 });
    // Signed distance to the wet region's edge (m, + inside), per page with a halo.
    const sdf = new Float32Array(N * PP);
    const H = Math.ceil(o.sdfM / o.texelM), WW = P + 2 * H;
    const inside = new Uint8Array(WW * WW), outside = new Uint8Array(WW * WW);
    const wetPage = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
        for (let g = p * PP; g < (p + 1) * PP; g++) {
            if (wet[g]) { wetPage[p] = 1; break; }
        }
    }
    let drySdfPages = 0;
    for (let p = 0; p < N; p++) {
        // Whole-page occupancy is conservative: an occupied neighbour may
        // have water outside this halo, but an empty neighbourhood cannot.
        const { face, pi, pj } = pageInfo[p], reach = Math.ceil(H / P);
        let occupied = false;
        for (let y = pj - reach; y <= pj + reach && !occupied; y++) for (let x = pi - reach; x <= pi + reach; x++) {
            if (x < 0 || y < 0 || x >= L.PE || y >= L.PE) continue;
            const neighbour = slot.get(pageKey(face, x, y, L));
            if (neighbour !== undefined && wetPage[neighbour]) { occupied = true; break; }
        }
        if (!occupied && o.sdfM <= (1e6 - 0.5) * o.texelM) {
            sdf.fill(-o.sdfM, p * PP, (p + 1) * PP);
            drySdfPages++;
            continue;
        }
        let anyWet = false;
        for (let j = 0; j < WW; j++) for (let i = 0; i < WW; i++) {
            const q = texel(p, i - H, j - H), v = q >= 0 ? wet[q] : 0;
            inside[j * WW + i] = v; outside[j * WW + i] = 1 - v;
            anyWet ||= v !== 0;
        }
        // With no wet texel in the complete distance halo, the distance
        // transform can only produce the clamped dry value. Keep the halo:
        // a dry page beside water still needs its exact shoreline distances.
        if (!anyWet && o.sdfM <= (1e6 - 0.5) * o.texelM) {
            sdf.fill(-o.sdfM, p * PP, (p + 1) * PP);
            drySdfPages++;
            continue;
        }
        const dIn = edt2(inside, WW, WW), dOut = edt2(outside, WW, WW);
        for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
            const k = (j + H) * WW + i + H;
            // Distance to the boundary between texel centres: half a texel either side.
            const v = inside[k] ? Math.sqrt(dOut[k]) - 0.5 : -(Math.sqrt(dIn[k]) - 0.5);
            sdf[p * PP + j * P + i] = clamp(v * o.texelM, -o.sdfM, o.sdfM);
        }
    }
    for (let g = 0; g < N * PP; g++) if (leftDry[g]) sdf[g] = -o.sdfM;
    const t7 = performance.now();
    onProgress?.('flow', { ms: t7 - t6 });
    const { flowA, flowB, foam, manning, rocks } = riverFieldFlow({ prepared, L, N, PP, P, pageInfo, slot, owner, ownerSt, edgeOf, level, ground, wet, lakeLevel });
    const t7b = performance.now();
    onProgress?.('pack', { ms: t7b - t7 });
    // GPU pages with aprons, 2 words a texel (RIVER_FIELD_WORDS): level W
    // (f32 bits), Δ and sdf (two f16). Flow: one word (riverFlow.js).
    const A = L.A, ST = L.ST, out = new Map();
    // The worker transfers one contiguous buffer. Build the page views in
    // that buffer directly instead of allocating and copying it a second time.
    const wordsPerPage = ST * ST * RIVER_FIELD_WORDS;
    const packed = new Uint32Array(N * wordsPerPage);
    out.packed = packed;
    const flow = new Uint32Array(N * ST * ST);
    for (let p = 0; p < N; p++) {
        const data = packed.subarray(p * wordsPerPage, (p + 1) * wordsPerPage);
        for (let j = 0; j < ST; j++) for (let i = 0; i < ST; i++) {
            let q = texel(p, i - A, j - A);
            const w = (j * ST + i) * RIVER_FIELD_WORDS;
            // Outside the page set the nearest texel continues: written as dry,
            // the edge of the set drew a line across lake beds (no mud there).
            if (q < 0) q = p * PP + clamp(j - A, 0, P - 1) * P + clamp(i - A, 0, P - 1);
            data[w] = f32bits(Number.isFinite(level[q]) ? level[q] : -1e4);
            data[w + 1] = packHalf2(delta[q], sdf[q]);
            flow[p * ST * ST + j * ST + i] = packFlowTexel(flowA[q], flowB[q], foam[q], manning[q]);
        }
        out.set(keys[p], data);
    }
    const t8 = performance.now();
    widest.sort((a, b) => a - b);
    const stats = { pages: N, drySdfPages, emptyBlurPages, culledPageRivers, emptyTexelPages, texels: N * PP, rivers: rivers.length, spilled,
        widest: { median: widest[widest.length >> 1] ?? 1, p90: widest[Math.floor(widest.length * 0.9)] ?? 1, max: widest[widest.length - 1] ?? 1 },
        ms: { stations: t3 - t2, texels: t4 - t3, blur: t5 - t4, wet: t6 - t5, sdf: t7 - t6, flow: t7b - t7, pack: t8 - t7b, finish: t8 - t2 },
        rocks: rocks.length / RIVER_ROCK_FLOATS };
    const result = { pages: out, stats, flow, rocks };
    if (debug) Object.assign(result, { keys, pageInfo, nat, ground, level, wet, sdf, delta, owner, lakeLevel, leftDry, prepared });
    return result;
}

// Velocity, foam and Manning's n per texel, and the rocks with the foam behind
// them (riverFlow.js). Velocity falls off with the local depth as Whitewater's
// starting state does: Vc (h / D)^(2/3), which keeps n constant across the
// section, so the texels stay in balance at W. Components are dot products with
// the unit tangents of the raster's axes at the page's centre.
function riverFieldFlow({ prepared, L, N, PP, P, pageInfo, slot, owner, ownerSt, edgeOf, level, ground, wet, lakeLevel }) {
    const o = RIVER_FLOW, flowA = new Float32Array(N * PP), flowB = new Float32Array(N * PP), foam = new Float32Array(N * PP), manning = new Float32Array(N * PP);
    const axes = (face, pi, pj) => {
        const cx = (pi + 0.5) * P, cy = (pj + 0.5) * P, a = fieldDir(face, cx - 1, cy, L), b = fieldDir(face, cx + 1, cy, L), c = fieldDir(face, cx, cy - 1, L), d = fieldDir(face, cx, cy + 1, L);
        return [norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), norm([d[0] - c[0], d[1] - c[1], d[2] - c[2]])];
    };
    const pageAxes = pageInfo.map(q => axes(q.face, q.pi, q.pj));
    for (let p = 0; p < N; p++) {
        const [ax, ay] = pageAxes[p];
        for (let t = 0; t < PP; t++) {
            const g = p * PP + t, ri = owner[g];
            if (ri < 0) continue;
            const { S, plane } = prepared[ri], e1 = plane.frame.e1, e2 = plane.frame.e2;
            const i = Math.min(Math.floor(ownerSt[g]), S.m - 2), c = ownerSt[g] - i;
            const lerp = (a) => a[i] + (a[i + 1] - a[i]) * c;
            // Lake water carries no n: the solver holds it to the lake's level.
            manning[g] = Number.isFinite(lakeLevel[g]) ? 0 : lerp(S.n);
            if (!wet[g]) continue;
            const depth = Math.max(lerp(S.D) * (1 - lerp(S.fade)), o.leastDepthM);
            // In a lake nothing else ends the flow sideways: at full speed out to the
            // edge of what the river owns, it stopped on straight lines.
            const half = 0.5 * (lerp(S.hwL) + lerp(S.hwR));
            const side = Number.isFinite(lakeLevel[g]) ? 1 - smoothstep(-0.6 * half, 0.2 * half, edgeOf[g]) : 1;
            const v = lerp(S.V) * side * Math.min(1, Math.max(level[g] - ground[g], 0) / depth) ** (2 / 3);
            const tx = lerp(S.tx), ty = lerp(S.ty);
            const wx = e1[0] * tx + e2[0] * ty, wy = e1[1] * tx + e2[1] * ty, wz = e1[2] * tx + e2[2] * ty;
            flowA[g] = v * (wx * ax[0] + wy * ax[1] + wz * ax[2]);
            flowB[g] = v * (wx * ay[0] + wy * ay[1] + wz * ay[2]);
            // Foam is the river's: where its level eases into a lake's the fall
            // read as a rapid, a white wedge on the lake at every outlet.
            foam[g] = Number.isFinite(lakeLevel[g]) ? 0 : lerp(S.foam);
        }
    }
    // Rocks to directions, and foam streaming from those near the surface.
    const texelAt = (dir) => {
        const q = fieldCoords(dir, L), i = Math.floor(q.x), j = Math.floor(q.y), pi = Math.floor(i / P), pj = Math.floor(j / P);
        const p = slot.get(pageKey(q.face, pi, pj, L));
        return p === undefined ? -1 : p * PP + (j - pj * P) * P + i - pi * P;
    };
    const list = [];
    prepared.forEach(({ S, plane, fromPlane }, ri) => {
        for (const r of riverRocks(S, S.rid)) {
            const dir = fromPlane(r.x, r.y);
            list.push(dir[0], dir[1], dir[2], r.r, r.top, r.base, r.seed, r.W, r.solid ? 1 : 0);
            if (r.top < r.W - o.wakeDepthM) continue;
            const nx = -r.ty, ny = r.tx, len = o.wakeLen * r.r;
            // Deflect the baked velocity around the rock as well as adding
            // foam. The old wake only changed brightness, so animated water
            // kept travelling straight through visible rocks in the mid tier.
            const strength = 1 - smoothstep(-0.15, o.wakeDepthM, r.W - r.top), seen = new Set();
            const reach = 4 * r.r, step = L.texelM ?? o.texelM ?? 2;
            for (let a = -reach; a <= reach; a += step) for (let b = -reach; b <= reach; b += step) {
                const turn = rockFlowDeflection(a, b, r.r, strength);
                if (turn.weight <= 0) continue;
                const g = texelAt(fromPlane(r.x + r.tx * a + nx * b, r.y + r.ty * a + ny * b));
                if (g < 0 || seen.has(g) || !wet[g] || owner[g] !== ri || Number.isFinite(lakeLevel[g])) continue;
                seen.add(g);
                const [ax, ay] = pageAxes[Math.floor(g / PP)], cos = dot(ax, ay), den = Math.max(1 - cos * cos, 0.25);
                const wa = (flowA[g] - cos * flowB[g]) / den, wb = (flowB[g] - cos * flowA[g]) / den;
                const world = [ax[0] * wa + ay[0] * wb, ax[1] * wa + ay[1] * wb, ax[2] * wa + ay[2] * wb];
                const { e1, e2 } = plane.frame, along = (dot(world, e1) * r.tx + dot(world, e2) * r.ty);
                if (along <= 0) continue;
                const da = along * (turn.along - 1), db = along * turn.across;
                const dx = r.tx * da + nx * db, dy = r.ty * da + ny * db;
                const change = [e1[0] * dx + e2[0] * dy, e1[1] * dx + e2[1] * dy, e1[2] * dx + e2[2] * dy];
                flowA[g] += dot(change, ax); flowB[g] += dot(change, ay);
            }
            for (let d = 0; d < len; d += 1.5) {
                const half = r.r * (0.6 + 0.5 * d / len), strength = Math.exp(-2.2 * d / len);
                for (let e = -half; e <= half; e += 1.5) {
                    const g = texelAt(fromPlane(r.x + r.tx * d + nx * e, r.y + r.ty * d + ny * e));
                    if (g >= 0 && wet[g] && !Number.isFinite(lakeLevel[g])) foam[g] = Math.max(foam[g], Math.min(1, foam[g] + 0.55 * strength * (1 - Math.abs(e) / (half + 0.5))));
                }
            }
        }
    });
    // Plumes: flow only, so the ground never hears of them, on lake water and on their own
    // river's last channel: a channel above the lake keeps its level, not lake water, and
    // the speed fading out there before the plume began drew a dark line across the foam.
    prepared.forEach(({ S, plane, fromPlane }, ri) => {
        const e1 = plane.frame.e1, e2 = plane.frame.e2;
        for (const q of riverPlumes(S, S.rid)) {
            const nx = -q.ty, ny = q.tx;
            // From a little above the shore: the lake's water starts before the station
            // that stands for it, and the river's speed fades there.
            for (let a = -2 * q.b; a <= q.length; a += 1.5) {
                const { width, off, turn } = plumeAt(q, a, 0), half = 2.2 * width;
                for (let r = -half; r <= half; r += 1.5) {
                    const n = r + off, g = texelAt(fromPlane(q.x + q.tx * a + nx * n, q.y + q.ty * a + ny * n));
                    if (g < 0 || !wet[g] || (!Number.isFinite(lakeLevel[g]) && owner[g] !== ri)) continue;
                    const v = plumeAt(q, a, r).speed * Math.min(1, Math.max(level[g] - ground[g], 0) / o.plumeDepthM) ** (2 / 3);
                    if (v * v <= flowA[g] * flowA[g] + flowB[g] * flowB[g]) continue;
                    // An intake's water runs back along it, closing in on its axis.
                    const out = (q.intake ? o.intakeFan : o.plumeFan) * r / width + turn, dl = Math.hypot(1, out) * (q.intake ? -1 : 1), dx = (q.tx + nx * out) / dl, dy = (q.ty + ny * out) / dl;
                    const wx = e1[0] * dx + e2[0] * dy, wy = e1[1] * dx + e2[1] * dy, wz = e1[2] * dx + e2[2] * dy;
                    const [ax, ay] = pageAxes[Math.floor(g / PP)];
                    flowA[g] = v * (wx * ax[0] + wy * ax[1] + wz * ax[2]);
                    flowB[g] = v * (wx * ay[0] + wy * ay[1] + wz * ay[2]);
                    foam[g] = Math.max(foam[g], q.foam * (v / q.V) ** 2 * Math.exp(-Math.max(a, 0) / (o.plumeFoamM * q.length)));
                }
            }
        }
    });
    return { flowA, flowB, foam, manning, rocks: Float32Array.from(list) };
}

// Texel words (2): f32 level, f16 pair (Δ, sdf) as WGSL unpack2x16float reads them.
export const RIVER_FIELD_WORDS = 2;
const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
const f32bits = (x) => { f32b[0] = x; return u32b[0]; };
const bitsf32 = (u) => { u32b[0] = u; return f32b[0]; };
/** Signed distance (m) of texel k of a packed page. */
export const riverFieldTexelSdf = (data, k) => fromHalf(data[k * RIVER_FIELD_WORDS + 1] >>> 16);
export function toHalf(x) {
    f32b[0] = x; const b = u32b[0], sign = (b >>> 16) & 0x8000;
    let e = ((b >>> 23) & 0xff) - 127 + 15, m = b & 0x7fffff;
    if (e >= 31) return sign | 0x7bff;                       // clamp to the largest finite half
    if (e <= 0) { if (e < -10) return sign; m |= 0x800000; const sh = 14 - e; return sign | ((m + (1 << (sh - 1))) >> sh); }
    // Rounding the mantissa can carry into the exponent. OR loses that
    // carry when the exponent's low bit is already set (e.g. just below
    // 32 m becomes 16 m), leaving holes in strongly lifted banks.
    const h = sign | ((e << 10) + ((m + 0x1000) >> 13));
    return (h & 0x7c00) === 0x7c00 ? sign | 0x7bff : h;
}
function fromHalf(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}
const packHalf2 = (a, b) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;

const bw = (f) => { const f2 = f * f, f3 = f2 * f; return [(1 - 3 * f + 3 * f2 - f3) / 6, (4 - 6 * f2 + 3 * f3) / 6, (1 + 3 * f + 3 * f2 - 3 * f3) / 6, f3 / 6]; };
/**
 * CPU mirror of riverField.wgsl.js riverFieldAt: the published pages
 * (Map key -> Float32Array(TEX * 4)) at a unit direction:
 * { found, delta, W, sdf, owner }.
 */
export function sampleRiverField(pages, L, dir) {
    const q = fieldCoords(dir, L), tx = q.x - 0.5, ty = q.y - 0.5;
    const ib = Math.floor(tx), jb = Math.floor(ty), pi = Math.floor((ib + 1) / L.P), pj = Math.floor((jb + 1) / L.P);
    const data = pages.get(pageKey(q.face, pi, pj, L));
    if (!data) return { found: false, delta: 0, W: NaN, sdf: -RIVER_FIELD.sdfM, owner: 0 };
    const li0 = clamp(ib + 1 - pi * L.P, 0, L.P), lj0 = clamp(jb + 1 - pj * L.P, 0, L.P);
    const fx = tx - ib, fy = ty - jb, wx = bw(fx), wy = bw(fy), v = [0, 0, 0];
    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) {
        const o = ((lj0 + jj) * L.ST + li0 + ii) * RIVER_FIELD_WORDS, w = wx[ii] * wy[jj];
        v[0] += fromHalf(data[o + 1] & 0xffff) * w; v[1] += bitsf32(data[o]) * w; v[2] += fromHalf(data[o + 1] >>> 16) * w;
    }
    return { found: true, delta: v[0], W: v[1], sdf: v[2] };
}
