// core/world/water/riverFlow.js
//
// The flow of the baked rivers (riverField.js), for whitewater: what the far
// foam, the animated mid-range water and the near simulation all read, so the
// three agree where they hand over.
//
// The traces' own discharge is no use here: it comes from the catchment on a
// coarse grid (0.005-0.3 m3/s) while the drawn channels are 1-3 m deep and
// 8-30 m wide on slopes of 4-50 %. Left to that discharge a simulated channel
// would simply drain. So the flow is designed from the channel as baked:
// - a speed from Jarrett's high-gradient law V = C Rh^0.83 S^0.12 (Manning with
//   a constant n reaches 15 m/s at these slopes; real step-pool streams do not,
//   they spend the head on turbulence), held to one discharge per river so the
//   water is conserved where the width changes (Whitewater's per-row discharge
//   matching: without it bends and pinches start with the wrong flux and launch
//   a wave downstream);
// - a Manning n per station chosen so that exactly this flow is in balance at
//   the baked level W: gravity down the surface = friction. The simulation
//   then starts on its own steady state, which is the answer to Whitewater's
//   900-step warm-up (WhitewaterSim.js).
// Foam is gradient based, from the fall of W and the Froude number. Rocks, in
// the channel where it falls, are kept apart from the ground: tiles never hold
// them, a mesh does (riverRocks.js in the renderer), and the simulation's bed
// where the water is supercritical (rockSolidFroude).

import { riverHash } from './riverShapeNoise.js';

export const RIVER_FLOW = Object.freeze({
    // The fall is measured over this much river (m) and smoothed over as much again.
    slopeM: 24,
    // Jarrett's C (m/s; his own fit is 2.56), flows of a fast mountain river.
    jarrettC: 3.4,
    // Centre speed (m/s) kept within this, and the share of the channel's
    // bounding rectangle that holds water (a parabola's 2/3).
    speedM: [0.25, 5.5], areaShape: 0.66, leastDepthM: 0.3,
    // Manning's n kept within this.
    manning: [0.02, 0.8],
    // Texel encoding: velocity components up to speedRangeM (m/s).
    speedRangeM: 8,
    // Steep reaches run shallow and fast. Jarrett's law is fitted below 4 %, and a wide
    // channel at the river's one discharge crawled: 1.9 m/s down a 44 % fall, friction
    // n 0.34 holding it there (river 453, owner 2026-11-05). So a channel falling faster
    // than steepSlope[0] is filled up to the normal depth of a rough bed (Manning
    // steepManning), fully from steepSlope[1]: same discharge, less section.
    steepManning: 0.1, steepSlope: [0.02, 0.08],
    // A river's momentum goes on into its lake as a plume, flow only (riverField.js
    // riverFieldFlow): its core plumeCore half-widths long, then a plane jet's
    // 1 / sqrt(x), spreading by plumeSpread per metre, fanning out by plumeFan,
    // wandering by plumeWander of its length. plumeLength half-widths long at 2 m/s,
    // within plumeRangeM: pages reach about 200 m past a shore, and flow cut off at a
    // page's edge would be a straight line. Its speed is the fastest over the last
    // plumeBackM (m) of river, its depth full from plumeDepthM. Slower than plumeLeastV
    // (m/s), a river makes none. Its foam starts as the river's, or the shore shows a
    // border, and falls away over plumeFoamM of its length: a long way out it was a
    // white tongue.
    plumeCore: 6, plumeSpread: 0.16, plumeFan: 0.2, plumeWander: 0.08, plumeLength: 14, plumeRangeM: [50, 200],
    plumeBackM: 60, plumeDepthM: 1.2, plumeLeastV: 0.6, plumeFoamM: 0.22,
    // A river's start draws on its lake the same way, reversed: water converges on the outlet
    // through a section widening by up to intakeSpread per metre, easing in from the exit, so its
    // speed falls with that width, gone by intakeLength half-widths (within plumeRangeM). Without
    // one the flow stopped dead on a line across the water (owner 2026-11-05, u-start), and the lake,
    // giving nothing at the outlet, left the river's first 100 m 50 cm low. No foam: water being drawn.
    intakeLength: 12, intakeSpread: 0.3, intakeFan: 0.5,
    // Past a lake's shore, or once its level is within endLevelM of the lake's, a river's
    // own speed is gone by endFadeM + endFadePerHw x hw (m), whatever the channel does:
    // a narrow end ran at the limit on flat lake water (5.4 m/s at river 2557's outlet).
    // Leaving a lake water has only the fall so far to speed up with, sqrt(2 g fall) +
    // endLeastV: the same outlet ran into its river and raised a bulge of 0.3 m.
    endFadeM: 20, endFadePerHw: 2, endLevelM: 0.05, endLeastV: 0.3,
    // A river out of a lake carries what its outlet can pass: the section times that
    // speed, least over the stretch from a fall of outletFallM[0] to outletFallM[1] (m).
    // Designed for more, the solver found out on arrival, and the difference drained
    // down the river as a fall of 0.3 m.
    outletFallM: [0.25, 1.5],
    // Rocks stop water. Upstream of supercritical flow nothing can hear them, but where
    // the Froude number is under rockSolidFroude they dam the river: 0.5 m of head that
    // the baked level does not know, going up the river as a slow wave on arrival (owner
    // 2026-11-05: rocks out of the bed, wave gone). There they are drawn, with their
    // wake, and are not in the solver's bed.
    rockSolidFroude: 1.2,
    // Foam: from the fall (slope) and the Froude number, each 0..1 between
    // its two values, the higher wins; riffles and runs of foamWaveM (m).
    foamSlope: [0.012, 0.09], foamFroude: [0.95, 1.8], foamWaveM: 41, foamWaveAmp: 0.3,
    // Rocks: per m2 of channel from rockSlope[0] to rockSlope[1]. Radius (m)
    // long-tailed, r0 (r1 / r0)^(a^rockRadiusTail) for a in 0..1: half under
    // 0.65 m, one in ten over 2.4 m. A share of them above the water, tops up to
    // emergentM over it or submergedM under, but at most rockTallest radii over
    // the bed: small stones in deep water stay under it, not pillars reaching up.
    rockDensity: 0.01, rockSlope: [0.012, 0.07], rockRadiusM: [0.4, 3.8], rockRadiusTail: 2.2, rockEmergent: 0.5, rockTallest: 1.8,
    rockEmergentM: [0.25, 0.95], rockSubmergedM: [0.1, 0.5], rockAcross: 0.8, rockMaxHw: 0.45, rockBankM: 0.3, rockLeastM: 0.35,
    // Ledges: a broken lip of low rocks across the channel every ledgeGapM (m)
    // where it falls faster than ledgeSlope.
    ledgeSlope: 0.03, ledgeGapM: [70, 200], ledgeRadiusM: [0.6, 2.1], ledgeStepM: 2.2, ledgeTopM: [0.12, 0.3], ledgeMiss: 0.45,
    // Foam behind a rock whose top is at most wakeDepthM under the water, wakeLen radii long.
    wakeDepthM: 0.35, wakeLen: 7,
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function boxAlong(v, h) {
    const n = v.length, t = new Float64Array(n);
    let acc = 0;
    for (let i = -h; i <= h; i++) acc += v[clamp(i, 0, n - 1)];
    for (let i = 0; i < n; i++) {
        t[i] = acc / (2 * h + 1);
        acc += v[clamp(i + h + 1, 0, n - 1)] - v[clamp(i - h, 0, n - 1)];
    }
    v.set(t);
}

// Value noise along a river, 0..1.
function along(x, seed) {
    const i = Math.floor(x), f = x - i, q = f * f * (3 - 2 * f);
    return riverHash(i, seed) * (1 - q) + riverHash(i + 1, seed) * q;
}

/**
 * Adds to stations S (riverField.js riverStations): slope (fall of W per m), V
 * (centre speed, m/s), n (Manning), foam (0..1), Rh (hydraulic depth, m).
 */
export function riverFlowDesign(S, rid, o = RIVER_FLOW) {
    const m = S.m, seed = ((rid | 0) * 92821 + 0x6d2b) >>> 0;
    const h = Math.max(1, Math.round(o.slopeM / S.ds / 2));
    S.slope = new Float64Array(m); S.V = new Float64Array(m); S.n = new Float64Array(m); S.foam = new Float64Array(m); S.Rh = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        const a = Math.max(0, i - h), b = Math.min(m - 1, i + h);
        S.slope[i] = Math.max(0, (S.W[a] - S.W[b]) / Math.max(S.s[b] - S.s[a], S.ds));
    }
    boxAlong(S.slope, h);
    const area = new Float64Array(m), discharge = [];
    for (let i = 0; i < m; i++) {
        const depth = Math.max(S.D[i] * (1 - S.fade[i]), o.leastDepthM);
        S.Rh[i] = o.areaShape * depth;
        area[i] = S.Rh[i] * (S.hwL[i] + S.hwR[i]);
        if (S.fade[i] < 0.5) discharge.push(o.jarrettC * S.Rh[i] ** 0.83 * Math.max(S.slope[i], 1e-4) ** 0.12 * area[i]);
    }
    // One discharge for the river: speed follows the section it passes through.
    discharge.sort((a, b) => a - b);
    let Q = discharge[discharge.length >> 1] ?? 0;
    for (const end of S.ends ?? []) {
        if (end.level === undefined || end.sign > 0) continue;
        for (let i = 0; i < m; i++) {
            const fall = end.level - S.W[i];
            if (fall < o.outletFallM[0]) continue;
            if (fall > o.outletFallM[1]) break;
            Q = Math.min(Q, (o.endLeastV + Math.sqrt(2 * 9.81 * fall)) * o.areaShape * Math.max(S.D[i], o.leastDepthM) * (S.hwL[i] + S.hwR[i]));
        }
    }
    S.Q = Q;
    const shallower = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        const normal = (Q * o.steepManning / ((S.hwL[i] + S.hwR[i]) * Math.sqrt(Math.max(S.slope[i], 1e-4)))) ** 0.6 / o.areaShape;
        shallower[i] = smoothstep(o.steepSlope[0], o.steepSlope[1], S.slope[i]) * Math.max(S.D[i] - Math.max(normal, 2 * o.leastDepthM), 0);
    }
    boxAlong(shallower, h);
    for (let i = 0; i < m; i++) {
        S.D[i] -= Math.min(shallower[i], Math.max(S.D[i] - 2 * o.leastDepthM, 0));
        S.Rh[i] = o.areaShape * Math.max(S.D[i] * (1 - S.fade[i]), o.leastDepthM);
        // The river's own section, not the faded one: the channel fades out into a lake
        // because the lake is deep, and by that smaller area water sped up to the limit
        // on flat lake water and stopped dead, on straight lines (owner's triangle),
        // sending a wave back up the river.
        area[i] = o.areaShape * Math.max(S.D[i], o.leastDepthM) * (S.hwL[i] + S.hwR[i]);
        S.V[i] = clamp(Q / Math.max(area[i], 1e-3), o.speedM[0], o.speedM[1]);
    }
    boxAlong(S.V, h);
    // Friction comes from this speed, not from the capped one below: mass makes the solver
    // carry Q / area past an outlet, and n from a capped V is too much friction for that
    // (river 2557: 12 cm more sag under the baked level for its first 100 m).
    const free = Float64Array.from(S.V);
    for (const end of S.ends ?? []) {
        if (end.level === undefined || end.sign > 0) continue;
        for (let i = 0; i < m; i++) S.V[i] = Math.min(S.V[i], o.endLeastV + Math.sqrt(2 * 9.81 * Math.max(end.level - S.W[i], 0)));
    }
    for (let i = 0; i < m; i++) {
        const fade = S.fade[i];
        // By the depth, not the hydraulic depth: the raster's speed V (h / D)^(2/3) with
        // the solver's friction n^2 v^2 / h^(4/3) comes to n^2 V^2 / D^(4/3) at every
        // point of the section. With Rh friction was 57 % of gravity: the river ran away
        // from its baked state, and the fall in level went up it as a slow wave.
        S.n[i] = clamp((S.Rh[i] / o.areaShape) ** (2 / 3) * Math.sqrt(Math.max(S.slope[i], 1e-6)) / free[i], o.manning[0], o.manning[1]);
        const froude = S.V[i] / Math.sqrt(9.81 * S.Rh[i]);
        const white = Math.max(smoothstep(o.foamSlope[0], o.foamSlope[1], S.slope[i]), smoothstep(o.foamFroude[0], o.foamFroude[1], froude));
        S.foam[i] = white * (1 - o.foamWaveAmp + o.foamWaveAmp * along(S.s[i] / o.foamWaveM, seed)) * (1 - fade);
        S.V[i] *= 1 - fade;
    }
    for (const end of S.ends ?? []) {
        if (end.level === undefined) continue;
        // Where the level leaves the lake's, walking in from the lake.
        let edge = end.sign > 0 ? m - 1 : 0;
        while (edge >= 0 && edge < m && Math.abs(S.W[edge] - end.level) <= o.endLevelM) edge -= end.sign;
        edge = clamp(edge, 0, m - 1);
        for (let i = 0; i < m; i++) {
            const past = Math.max((S.s[i] - end.s) * end.sign, (S.s[i] - S.s[edge]) * end.sign);
            if (past > 0) S.V[i] *= 1 - smoothstep(0, o.endFadeM + o.endFadePerHw * 0.5 * (S.hwL[i] + S.hwR[i]), past);
        }
    }
}

/**
 * The plumes of a river into its lakes and the intakes at its starts, from its stations (after
 * riverFlowDesign). Both run from the shore out into the lake: tx, ty point that way, and an
 * intake's water flows the other way along them.
 */
export function riverPlumes(S, rid, o = RIVER_FLOW) {
    const out = [], back = Math.round(o.plumeBackM / S.ds);
    for (const end of S.ends ?? []) {
        if (end.level === undefined) continue;
        const intake = end.sign < 0;
        let shore = 0;
        while (shore < S.m - 1 && S.s[shore] < end.s) shore++;
        let V = 0, foam = 0, tx = 0, ty = 0;
        for (let i = intake ? shore : Math.max(0, shore - back); i <= (intake ? Math.min(S.m - 1, shore + back) : shore); i++) {
            V = Math.max(V, S.V[i]); foam = Math.max(foam, S.foam[i]); tx += S.tx[i]; ty += S.ty[i];
        }
        if (V < o.plumeLeastV) continue;
        const l = (Math.hypot(tx, ty) || 1) * (intake ? -1 : 1), b = 0.5 * (S.hwL[shore] + S.hwR[shore]);
        out.push({ x: S.x[shore], y: S.y[shore], tx: tx / l, ty: ty / l, b, V, foam: intake ? 0 : foam, intake,
            length: clamp((intake ? o.intakeLength * b : o.plumeLength * b * Math.sqrt(V / 2)), o.plumeRangeM[0], o.plumeRangeM[1]), seed: riverHash(shore, rid >>> 0) });
    }
    return out;
}

/** Plume p at a metres along it, r across: { speed, width, off: its centre's offset, turn: of its centre per m }. */
export function plumeAt(p, a, r, o = RIVER_FLOW) {
    if (p.intake) {
        const up = Math.max(a, 0), width = p.b + o.intakeSpread * up * up / (up + p.b);
        return { speed: p.V * (p.b / width) * Math.exp(-((r / width) ** 2)) * (1 - smoothstep(0.45 * p.length, p.length, a)), width, off: 0, turn: 0 };
    }
    const width = p.b + o.plumeSpread * Math.max(a, 0), w = 2 * Math.PI / (0.7 * p.length), phase = p.seed * 6.2832;
    const grow = o.plumeWander * Math.min(Math.max(a, 0), p.length);
    const core = Math.min(1, Math.sqrt(o.plumeCore * p.b / Math.max(a, 1)));
    return { speed: p.V * core * Math.exp(-((r / width) ** 2)) * (1 - smoothstep(0.45 * p.length, p.length, a)), width,
        off: grow * Math.sin(a * w + phase), turn: o.plumeWander * Math.sin(a * w + phase) + grow * w * Math.cos(a * w + phase) };
}

// Rock record: dir xyz, radius (m), top, base (m above the sphere), seed 0..1, the water's level there, 1 if in the solver's bed.
export const RIVER_ROCK_FLOATS = 9;

/**
 * The rocks of a river from its stations (after riverFlowDesign): array of
 * { x, y (river plane), r, top, base, seed, kind, tx, ty, W, solid }. Deterministic per river.
 */
export function riverRocks(S, rid, o = RIVER_FLOW) {
    const rocks = [], m = S.m, seed = ((rid | 0) * 69069 + 0x1b873593) >>> 0;
    let k = 0;
    const rnd = () => riverHash(k++, seed);
    const place = (i, u, rWanted, topAbove, kind) => {
        const hw = u >= 0 ? S.hwL[i] : S.hwR[i], nx = -S.ty[i], ny = S.tx[i], n = u * hw;
        // Inside the channel: a dome reaching the bank drew a line over the grass.
        const r = Math.min(rWanted, (1 - Math.abs(u)) * hw + o.rockBankM);
        if (r < o.rockLeastM) return;
        // The bed falls away under its downhill half: a dome on a level base hung
        // in the air on a cascade, water showing under it (river 458, 60 % slope).
        const bed = S.W[i] - S.D[i] * (1 - Math.min(1, Math.abs(u)) ** 2);
        const base = bed - 1.2 * S.slope[i] * r;
        const top = Math.max(Math.min(S.W[i] + topAbove, bed + o.rockTallest * r), bed + 0.25);
        const solid = S.V[i] / Math.sqrt(9.81 * Math.max(S.D[i], o.leastDepthM)) >= o.rockSolidFroude;
        rocks.push({ x: S.x[i] + nx * n, y: S.y[i] + ny * n, r, top, base, seed: rnd(), kind, tx: S.tx[i], ty: S.ty[i], W: S.W[i], solid });
    };
    let owed = rnd(), ledgeAt = o.ledgeGapM[0] * rnd();
    for (let i = 0; i < m; i++) {
        if (S.fade[i] > 0.02 || S.mouth[i] > 0.5) continue;
        const steep = smoothstep(o.rockSlope[0], o.rockSlope[1], S.slope[i]);
        const width = S.hwL[i] + S.hwR[i];
        owed += o.rockDensity * steep * width * S.ds;
        while (owed >= 1) {
            owed -= 1;
            const a = rnd(), b = rnd(), hw = 0.5 * width;
            const r = Math.min(o.rockRadiusM[0] * (o.rockRadiusM[1] / o.rockRadiusM[0]) ** (a ** o.rockRadiusTail), o.rockMaxHw * hw);
            const out = rnd() < o.rockEmergent;
            const top = out ? o.rockEmergentM[0] + (o.rockEmergentM[1] - o.rockEmergentM[0]) * b : -(o.rockSubmergedM[0] + (o.rockSubmergedM[1] - o.rockSubmergedM[0]) * b);
            place(i, (rnd() * 2 - 1) * o.rockAcross, r, top, 0);
        }
        if (S.slope[i] > o.ledgeSlope && S.s[i] >= ledgeAt) {
            ledgeAt = S.s[i] + o.ledgeGapM[0] + (o.ledgeGapM[1] - o.ledgeGapM[0]) * rnd();
            const count = Math.max(2, Math.round(width / o.ledgeStepM)), lip = -(o.ledgeTopM[0] + (o.ledgeTopM[1] - o.ledgeTopM[0]) * rnd());
            for (let c = 0; c < count; c++) {
                const u = ((c + 0.5) / count * 2 - 1) * 0.85;
                if (rnd() < o.ledgeMiss) continue;
                place(i, u, o.ledgeRadiusM[0] + (o.ledgeRadiusM[1] - o.ledgeRadiusM[0]) * rnd(), lip + 0.1 * (rnd() - 0.5), 1);
            }
        }
    }
    return rocks;
}

// Flow texel (one word): velocity along the raster's two axes (snorm8 of
// speedRangeM, as dot products with the axes' unit tangents), foam (unorm8),
// Manning's n (unorm8: 0 lake water, n = 0 here; else log scale from 1).
// WGSL: riverField.wgsl.js riverFlowUnpack.
const MANNING_LOG = Math.log(RIVER_FLOW.manning[1] / RIVER_FLOW.manning[0]);
export function packFlowTexel(a, b, foam, n, o = RIVER_FLOW) {
    const s8 = (v) => Math.round(clamp(v / o.speedRangeM, -1, 1) * 127) & 0xff;
    const u8 = (v) => Math.round(clamp(v, 0, 1) * 255);
    const nq = n > 0 ? 1 + Math.round(Math.log(clamp(n, o.manning[0], o.manning[1]) / o.manning[0]) / MANNING_LOG * 254) : 0;
    return (s8(a) | (s8(b) << 8) | (u8(foam) << 16) | (nq << 24)) >>> 0;
}
export function unpackFlowTexel(w, o = RIVER_FLOW) {
    const s8 = (v) => { const x = (v & 0xff) << 24 >> 24; return Math.max(x / 127, -1) * o.speedRangeM; };
    const nq = (w >>> 24) & 0xff;
    return { a: s8(w), b: s8(w >>> 8), foam: ((w >>> 16) & 0xff) / 255, n: nq ? o.manning[0] * Math.exp((nq - 1) / 254 * MANNING_LOG) : 0 };
}
