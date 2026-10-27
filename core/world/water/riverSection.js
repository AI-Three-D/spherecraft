// core/world/water/riverSection.js
//
// The river cross-section (river redesign R2, CLAUDE_LAKE_RIVER_HANDOFF.md
// section 10): one definition of the ground a river shapes, here in
// JavaScript and generated as WGSL from the same constants. At arc length s
// along a river and offset n from its channel's centre (m, + left of the
// flow), given the natural ground h0 there:
// - the channel: Whitewater's bed, thalweg T + D (1 - (1 - u^2)^1.5) with the
//   thalweg moved toward the outer bank (skew), bank-full at the half-width;
// - beyond it, each side climbs from bank-full to the natural ground as a
//   step, a terrace and a blend. Its bank type tau in [0, 2] (0 no bank, 1
//   low ledge, 2 cut bank) comes from long-wavelength noise per side, the
//   bends (cut banks on their outer side, bars on the inner) and the river's
//   own style; the parameters interpolate between the three types, so the
//   ground is continuous in s and n;
// - only ever a cut: it never rises above h0, and it meets h0 continuously
//   where the cut ends. Within softM of the natural ground the cut fades in
//   (C1), with the channel lowered by softM / 2 so the design depth holds.
// Every step and blend has its slope constant over its middle (1 - 2
// rampRound of it), eased in and out over rampRound of it, and is wide
// enough for its height that its curvature stays under maxCurv: no corner
// sharp enough for the 1 m terrain grid to draw a saw-tooth (teeth metric,
// sectionMetrics.js; water-look v44).
// The width along a river (riverWidthFactor) is baked into the trace's
// half-width; the per-river amplitude makes some rivers vary more than
// others (owner 2026-10-13).

import { RIVER_NOISE, RIVER_NOISE_SALT, riverHash, riverNoise } from './riverShapeNoise.js';

export const RIVER_SECTION = Object.freeze({
    // Width: half-width x exp(sigma N(s / scale)), N the 'widthLong' noise
    // (420 / 160 m for a river widthRefM wide; pools and narrows come every
    // few widths, so its wavelengths scale with the river's typical width,
    // clamped), sigma per river between these (p90/p10 ~ exp(1.6 sigma)).
    sigmaMin: 0.55, sigmaMax: 1.15,
    // A share of the rivers varies more: their widest reaches 3-4 x their
    // typical width (the others ~2 x; owner 2026-10-26).
    wideShare: 0.35, wideSigma: [1.5, 1.65],
    widthRefM: 60, widthScale: [0.25, 2],
    // Bank type tau = typeBase + typeNoise N_side(s) + bendGain clamp(outer kappa
    // bendRefM, -1, 1) + river style (+-styleSpread), clamped to [0, 2].
    typeBase: 0.85, typeNoise: 1.6, bendGain: 0.8, bendRefM: 150, styleSpread: 0.35,
    // Per type: step height (m), steepest slope of the step, terrace and
    // blend widths (m). No bank: a blend of noBankBlendM (per river).
    // freeboard: the side's bank-full height above the water, as a share
    // of the design's (1 - waterFrac) D: a bar with no bank lets the water
    // lap onto a gentle slope (its channel side shallows out, the water
    // spreads wider), cut banks and ledges keep the full freeboard.
    none: Object.freeze({ stepM: 0, slope: 0.5, terraceM: 0, blendM: 75, freeboard: 0.2 }),
    ledge: Object.freeze({ stepM: 0.7, slope: 0.6, terraceM: 8, blendM: 30, freeboard: 1 }),
    cut: Object.freeze({ stepM: 3, slope: 1.4, terraceM: 1, blendM: 20, freeboard: 1 }),
    noBankBlendM: [60, 90],
    waterFrac: 0.75,   // the water fills this of D (RIVER_LEVEL_DEFAULTS, carve waterFrac)
    // Steps and blends are at least minStepM wide, and wide enough for their
    // height that the ramp's curvature stays under maxCurv (1/m): teeth on a
    // 1.41 m grid ~ curvature x 1.41^2 / 8 = 0.25 x maxCurv.
    minStepM: 2, rampRound: 0.35, maxCurv: 0.45,
    // A step this high or more starts the blend after it (lower: in between).
    stepPresentM: 0.3,
    softM: 0.5, stepSoftM: 0.25, widthSoftM: 0.5,
    // Ground changes at most this far (m) beyond the half-width.
    reachM: 110,
    // Lake rims (riverBankRim): a bank keeps lakeMarginM above drawn water
    // within lakeBandM of the river's line, lakeSlope (per m) lower farther
    // away. The band covers the lake's 16 m shore band beyond its 32 m solve
    // cells, which the trace sees as 16 m cells (20 m left a bank 0.3 m under
    // the lake beside an outlet, water-look v87).
    lakeMarginM: 0.3, lakeBandM: 40, lakeSlope: 0.2,
    // Containment (owner 2026-10-17: raise banks only where needed, to the
    // water + ~0.3 m, a few metres wide, blending back): beyond the channel's
    // edge the ground stays at least marginM above the water out to crestM,
    // so the near river surface can end there and the depth test draws the
    // shoreline. Each side's bank-full is at least the water + marginM
    // (riverSideDepth); natural ground lower than that is raised by the
    // carve to riverContainFloor: from bank-full over riseM to the water +
    // marginM, flat to crestM, then down at outSlope. Fill fades out where
    // the floor is wetFadeM below the water (hollows under it stay) and is
    // at most maxFillM (more means the level is wrong there).
    marginM: 0.3,
    contain: Object.freeze({ riseM: 1, crestM: 2.5, outSlope: 0.4, maxFillM: 1.5, wetFadeM: 1 }),
    salts: Object.freeze({ sigma: 0x7d21, style: 0x2fa9, noBank: 0x91c3, wide: 0x5e17 }),
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
// dSmoothMin / dSmoothMax (terrainCommon.wgsl.js).
const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const smax = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return a + (b - a) * h + k * h * (1 - h); };

/** 0..1 over t in [0, 1], slope ramping up over a, constant, down over a (C1). */
export function riverRamp(t, a = RIVER_SECTION.rampRound) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const m = 1 / (1 - a);
    if (t < a) return m * t * t / (2 * a);
    if (t > 1 - a) return 1 - m * (1 - t) * (1 - t) / (2 * a);
    return m * (t - a / 2);
}

/** max(0, d) with the corner rounded over k: 0, d^2 / 2k, d - k / 2 (C1). */
export const riverSoftCut = (d, k) => (d <= 0 ? 0 : d < k ? d * d / (2 * k) : d - k / 2);

/**
 * Width factor along a river: { f, df (per m), sigma }. widthM: the river's
 * typical width (m; one value per river, so the noise's argument stays s / scale).
 */
export function riverWidthFactor(s, river, widthM = RIVER_SECTION.widthRefM, P = RIVER_SECTION) {
    const h = riverHash(river, P.salts.sigma);
    const sigma = riverHash(river, P.salts.wide) < P.wideShare ? lerp(P.wideSigma[0], P.wideSigma[1], h) : lerp(P.sigmaMin, P.sigmaMax, h);
    const scale = clamp(widthM / P.widthRefM, P.widthScale[0], P.widthScale[1]);
    const { v, dv } = riverNoise(s / scale, river, 'widthLong');
    const f = Math.exp(sigma * v);
    return { f, df: f * sigma * dv / scale, sigma };
}

/** Bank type tau in [0, 2] of one side; kappa: signed curvature (1/m, + turning left). */
export function riverBankType(s, river, left, kappa, P = RIVER_SECTION) {
    const noise = riverNoise(s, river, left ? 'bankLeft' : 'bankRight').v;
    const outer = clamp((left ? -1 : 1) * kappa * P.bendRefM, -1, 1);
    const style = (riverHash(river, P.salts.style) * 2 - 1) * P.styleSpread;
    return clamp(P.typeBase + P.typeNoise * noise + P.bendGain * outer + style, 0, 2);
}

/** Step, terrace and blend of a bank of type tau on river `river`. */
export function riverBankParams(tau, river, P = RIVER_SECTION) {
    const t = clamp(tau, 0, 2);
    const none = { ...P.none, blendM: lerp(P.noBankBlendM[0], P.noBankBlendM[1], riverHash(river, P.salts.noBank)) };
    const [a, b, f] = t < 1 ? [none, P.ledge, t] : [P.ledge, P.cut, t - 1];
    return { stepM: lerp(a.stepM, b.stepM, f), slope: lerp(a.slope, b.slope, f), terraceM: lerp(a.terraceM, b.terraceM, f),
        blendM: lerp(a.blendM, b.blendM, f), freeboard: lerp(a.freeboard, b.freeboard, f) };
}

/**
 * A bank next to a lake (riverRefine.js riverLakeRims): its step rises at
 * least to rim, the floor on that side, from the side's bank-full height.
 * Cut below a lake's level, the banks let the lake hang over lower ground
 * at outlets (owner 2026-10-13, water-look v85). The step's ramp and the
 * blend beyond it keep their shape, so the river leaves the lake through a
 * notch in its rim.
 */
export function riverBankRim(b, rim, bankFull) {
    return { ...b, stepM: Math.max(b.stepM, rim - bankFull) };
}

/**
 * Bank-full depth of a side: the water's depth plus the side's freeboard;
 * drawn (softM / 2 lower, riverSectionHeight) at least marginM above the water.
 */
export const riverSideDepth = (depth, freeboard, P = RIVER_SECTION) =>
    Math.max(depth * (P.waterFrac + freeboard * (1 - P.waterFrac)), depth * P.waterFrac + P.marginM + P.softM / 2);

/**
 * Containment floor at x m beyond the channel's edge (x > 0): from the
 * side's drawn bank-full height to top (the water + marginM) over riseM,
 * flat to crestM, then down at outSlope (corner rounded over 1 m). Inside
 * the channel the floor is the drawn channel (riverChannel - softM / 2); at
 * x = 0 both are bank-full. riverContainedHeight raises the ground to it.
 */
export function riverContainFloor(x, bankFull, top, P = RIVER_SECTION) {
    const C = P.contain;
    if (x < C.riseM) return bankFull + (top - bankFull) * riverRamp(x / C.riseM, 0.5);
    return top - C.outSlope * riverSoftCut(x - C.crestM, 1);
}

/**
 * Ground of one river with containment (the carve's rule for a lone river,
 * away from lakes): the cut section, raised toward the floor where that is
 * above it, fully where the floor is at or above the water, fading out over
 * wetFadeM below it, by at most maxFillM. Arguments as riverSectionHeight.
 */
export function riverContainedHeight(x, P = RIVER_SECTION) {
    const h = riverSectionHeight(x, P);
    const { n, hw, bed, depth, skew, left, right } = x, C = P.contain, d = Math.abs(n);
    const water = bed + P.waterFrac * depth;
    const depthL = riverSideDepth(depth, left.freeboard, P), depthR = riverSideDepth(depth, right.freeboard, P);
    const floor = d < hw ? riverChannel(n, hw, bed, depthL, depthR, skew) - P.softM / 2
        : riverContainFloor(d - hw, bed + (n >= 0 ? depthL : depthR) - P.softM / 2, water + P.marginM, P);
    const t = clamp((floor - (water - C.wetFadeM)) / C.wetFadeM, 0, 1);
    return h + Math.min(C.maxFillM, Math.max(0, floor - h) * t * t * (3 - 2 * t));
}

/**
 * Channel bed height at offset n (|n| <= hw). Each side of the thalweg has
 * its own bank-full depth (depthL left of it, depthR right); both start
 * flat at the thalweg, so the bed is smooth there.
 */
export function riverChannel(n, hw, bed, depthL, depthR, skew) {
    const u = n / hw, de = u < skew ? (u - skew) / (1 + skew) : (u - skew) / (1 - skew);
    return bed + (de >= 0 ? depthL : depthR) * (1 - Math.pow(Math.max(0, 1 - de * de), 1.5));
}

/**
 * Ground height (m) at offset n from the channel's centre.
 * @param {object} x
 * @param {number} x.n      offset (m, + left of the flow)
 * @param {number} x.hw     half-width (m)
 * @param {number} x.bed    thalweg height (m)
 * @param {number} x.depth  bank-full depth D (m)
 * @param {number} x.skew   thalweg skew (-0.35..0.35)
 * @param {number} x.h0     natural ground (m)
 * @param {object} x.left, x.right  riverBankParams of each side
 */
export function riverSectionHeight({ n, hw, bed, depth, skew, h0, left, right }, P = RIVER_SECTION) {
    const k = P.softM, d = Math.abs(n);
    const depthL = riverSideDepth(depth, left.freeboard, P), depthR = riverSideDepth(depth, right.freeboard, P);
    const p0 = (d < hw ? riverChannel(n, hw, bed, depthL, depthR, skew) : bed + (n >= 0 ? depthL : depthR)) - k / 2;
    const cut = riverSoftCut(h0 - p0, k);
    const x = d - hw;
    if (x <= 0) return h0 - cut;
    const b = n >= 0 ? left : right;
    const stepH = Math.max(0, smin(cut, b.stepM, P.stepSoftM)), rest = cut - stepH;
    const aa = P.rampRound * (1 - P.rampRound);
    const width = smax(smax(P.minStepM, Math.sqrt(Math.max(stepH, 1e-3) / (P.maxCurv * aa)), P.widthSoftM), stepH / ((1 - P.rampRound) * b.slope), P.widthSoftM);
    const blend = smax(b.blendM, Math.sqrt(Math.max(rest, 1e-3) / (P.maxCurv * aa)), P.widthSoftM);
    const start = b.terraceM + width * clamp(stepH / P.stepPresentM, 0, 1);
    return h0 - cut + stepH * riverRamp(x / width, P.rampRound) + rest * riverRamp((x - start) / blend, P.rampRound);
}

/**
 * WGSL of the section — the same maths as above, from the same constants:
 * riverSectionNoise(s, river, left), riverBankType, riverBankParams (a
 * RiverBank), riverChannel, riverSection (scalar: { scalar }) and
 * riverSection_d (dual: { dual }, after the scalar block in the same shader;
 * needs terrainCommon's d* helpers). Needs waterNoiseOctave and waterHashF
 * (riverShapeNoise.js createRiverNoiseWgsl).
 */
export function createRiverSectionWgsl({ scalar = true, dual = false } = {}, P = RIVER_SECTION) {
    const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
    const oct = (kind) => RIVER_NOISE[kind].map(([lambda, w]) => `
        n += waterNoiseOctave(s, seed + ${lambda}u, ${f(lambda)}, ${w.toFixed(3)});`).join('');
    const a = P.rampRound, m = 1 / (1 - a), aa = a * (1 - a), curv = f(1 / (P.maxCurv * aa));
    const bank = (t, blend = f(t.blendM)) => `RiverBank(${f(t.stepM)}, ${f(t.slope)}, ${f(t.terraceM)}, ${blend}, ${f(t.freeboard)})`;
    const wf = f(P.waterFrac), fbScale = f(1 - P.waterFrac), minFull = f(P.marginM + P.softM / 2), C = P.contain;
    return (scalar ? /* wgsl */`
// ==================== River cross-section (core/world/water/riverSection.js) ====
struct RiverBank { stepM: f32, slope: f32, terraceM: f32, blendM: f32, freeboard: f32, };
fn riverSectionNoise(s: f32, river: f32, left: bool) -> f32 {
    var n = vec2<f32>(0.0);
    let r = u32(max(river, 0.0));
    if (left) {
        let seed = (r * 4099u) ^ ${RIVER_NOISE_SALT.bankLeft}u;${oct('bankLeft')}
    } else {
        let seed = (r * 4099u) ^ ${RIVER_NOISE_SALT.bankRight}u;${oct('bankRight')}
    }
    return n.x;
}
fn riverSectionHash(river: f32, salt: u32) -> f32 { return waterHashF(i32(max(river, 0.0)), salt); }
fn riverBankType(s: f32, river: f32, left: bool, kappa: f32) -> f32 {
    let outer = clamp(select(1.0, -1.0, left) * kappa * ${f(P.bendRefM)}, -1.0, 1.0);
    let style = (riverSectionHash(river, ${P.salts.style}u) * 2.0 - 1.0) * ${f(P.styleSpread)};
    return clamp(${f(P.typeBase)} + ${f(P.typeNoise)} * riverSectionNoise(s, river, left) + ${f(P.bendGain)} * outer + style, 0.0, 2.0);
}
fn riverBankMix(a: RiverBank, b: RiverBank, t: f32) -> RiverBank {
    return RiverBank(mix(a.stepM, b.stepM, t), mix(a.slope, b.slope, t), mix(a.terraceM, b.terraceM, t), mix(a.blendM, b.blendM, t), mix(a.freeboard, b.freeboard, t));
}
fn riverBankParams(tau: f32, river: f32) -> RiverBank {
    let t = clamp(tau, 0.0, 2.0);
    let none = ${bank(P.none, `mix(${f(P.noBankBlendM[0])}, ${f(P.noBankBlendM[1])}, riverSectionHash(river, ${P.salts.noBank}u))`)};
    if (t < 1.0) { return riverBankMix(none, ${bank(P.ledge)}, t); }
    return riverBankMix(${bank(P.ledge)}, ${bank(P.cut)}, t - 1.0);
}
fn riverSideDepth(depth: f32, freeboard: f32) -> f32 { return max(depth * (${wf} + freeboard * ${fbScale}), depth * ${wf} + ${minFull}); }
// riverBankRim (riverSection.js): the bank's step reaches the lake rim.
fn riverBankRim(b: RiverBank, rim: f32, bankFull: f32) -> RiverBank {
    return RiverBank(max(b.stepM, rim - bankFull), b.slope, b.terraceM, b.blendM, b.freeboard);
}
fn riverRamp(t: f32) -> f32 {
    if (t <= 0.0) { return 0.0; }
    if (t >= 1.0) { return 1.0; }
    if (t < ${f(a)}) { return ${f(m)} * t * t / ${f(2 * a)}; }
    if (t > ${f(1 - a)}) { let r = 1.0 - t; return 1.0 - ${f(m)} * r * r / ${f(2 * a)}; }
    return ${f(m)} * (t - ${f(a / 2)});
}
fn riverSoftCut(d: f32) -> f32 {
    if (d <= 0.0) { return 0.0; }
    if (d < ${f(P.softM)}) { return d * d / ${f(2 * P.softM)}; }
    return d - ${f(P.softM / 2)};
}
fn riverSmin(a: f32, b: f32, k: f32) -> f32 { let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return b + (a - b) * h - k * h * (1.0 - h); }
fn riverSmax(a: f32, b: f32, k: f32) -> f32 { let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return a + (b - a) * h + k * h * (1.0 - h); }
fn riverChannel(n: f32, hw: f32, bed: f32, depthL: f32, depthR: f32, skew: f32) -> f32 {
    let u = n / hw;
    let de = select((u - skew) / (1.0 - skew), (u - skew) / (1.0 + skew), u < skew);
    return bed + select(depthR, depthL, de >= 0.0) * (1.0 - pow(max(0.0, 1.0 - de * de), 1.5));
}
// Ground height at offset n from the channel's centre, natural ground h0.
fn riverSection(n: f32, hw: f32, bed: f32, depth: f32, skew: f32, h0: f32, left: RiverBank, right: RiverBank) -> f32 {
    let d = abs(n);
    let depthL = riverSideDepth(depth, left.freeboard);
    let depthR = riverSideDepth(depth, right.freeboard);
    let p0 = select(bed + select(depthR, depthL, n >= 0.0), riverChannel(n, hw, bed, depthL, depthR, skew), d < hw) - ${f(P.softM / 2)};
    let cut = riverSoftCut(h0 - p0);
    let x = d - hw;
    if (x <= 0.0) { return h0 - cut; }
    var b = right;
    if (n >= 0.0) { b = left; }
    let stepH = max(0.0, riverSmin(cut, b.stepM, ${f(P.stepSoftM)}));
    let rest = cut - stepH;
    let width = riverSmax(riverSmax(${f(P.minStepM)}, sqrt(max(stepH, 0.001) * ${curv}), ${f(P.widthSoftM)}), stepH / (${f(1 - a)} * b.slope), ${f(P.widthSoftM)});
    let blend = riverSmax(b.blendM, sqrt(max(rest, 0.001) * ${curv}), ${f(P.widthSoftM)});
    let start = b.terraceM + width * clamp(stepH / ${f(P.stepPresentM)}, 0.0, 1.0);
    return h0 - cut + stepH * riverRamp(x / width) + rest * riverRamp((x - start) / blend);
}
` : '') + (dual ? /* wgsl */`
fn riverRamp_d(t: vec4<f32>) -> vec4<f32> {
    if (t.x <= 0.0) { return dConst(0.0); }
    if (t.x >= 1.0) { return dConst(1.0); }
    if (t.x < ${f(a)}) { return vec4<f32>(${f(m)} * t.x * t.x / ${f(2 * a)}, t.yzw * (${f(m / a)} * t.x)); }
    if (t.x > ${f(1 - a)}) { let r = 1.0 - t.x; return vec4<f32>(1.0 - ${f(m)} * r * r / ${f(2 * a)}, t.yzw * (${f(m / a)} * r)); }
    return vec4<f32>(${f(m)} * (t.x - ${f(a / 2)}), t.yzw * ${f(m)});
}
// Dual of riverSoftCut over k (m): 0, d^2 / 2k, d - k / 2.
fn riverSoftCutK_d(d: vec4<f32>, k: f32) -> vec4<f32> {
    if (d.x <= 0.0) { return dConst(0.0); }
    if (d.x < k) { return vec4<f32>(d.x * d.x / (2.0 * k), d.yzw * (d.x / k)); }
    return vec4<f32>(d.x - 0.5 * k, d.yzw);
}
// Dual of riverChannel (the bed, side depths and half-width as duals).
fn riverChannel_d(n: vec4<f32>, hw: vec4<f32>, bed: vec4<f32>, depthL: vec4<f32>, depthR: vec4<f32>, skew: f32) -> vec4<f32> {
    let u = dDiv(n, hw);
    let de = (u - dConst(skew)) * select(1.0 / (1.0 - skew), 1.0 / (1.0 + skew), u.x < skew);
    let q = dConst(1.0) - dMul(de, de);
    return bed + dMul(select(depthR, depthL, de.x >= 0.0), dConst(1.0) - dPow(vec4<f32>(max(q.x, 0.0), select(vec3<f32>(0.0), q.yzw, q.x > 0.0)), 1.5));
}
fn riverSideDepth_d(depth: vec4<f32>, freeboard: f32) -> vec4<f32> {
    return dMax(depth * (${wf} + freeboard * ${fbScale}), depth * ${wf} + dConst(${minFull}));
}
// soft: the cut fades in over this (m) of natural ground above the
// section (softM; wider where a channel meets a steep lake basin, whose
// crossing with it drew a crease).
fn riverSection_d(n: vec4<f32>, hw: vec4<f32>, bed: vec4<f32>, depth: vec4<f32>, skew: f32, h0: vec4<f32>, left: RiverBank, right: RiverBank, soft: f32) -> vec4<f32> {
    let d = n * select(-1.0, 1.0, n.x >= 0.0);
    let depthL = riverSideDepth_d(depth, left.freeboard);
    let depthR = riverSideDepth_d(depth, right.freeboard);
    let p0 = select(bed + select(depthR, depthL, n.x >= 0.0), riverChannel_d(n, hw, bed, depthL, depthR, skew), d.x < hw.x) - dConst(0.5 * soft);
    let cut = riverSoftCutK_d(h0 - p0, soft);
    let x = d - hw;
    if (x.x <= 0.0) { return h0 - cut; }
    var b = right;
    if (n.x >= 0.0) { b = left; }
    let stepH = dMax(dConst(0.0), dSmoothMin(cut, dConst(b.stepM), ${f(P.stepSoftM)}));
    let rest = cut - stepH;
    let widthC = dSmoothMax(dConst(${f(P.minStepM)}), dSqrt(dMax(stepH, dConst(0.001)) * ${curv}), ${f(P.widthSoftM)});
    let width = dSmoothMax(widthC, stepH * (1.0 / (${f(1 - a)} * b.slope)), ${f(P.widthSoftM)});
    let blend = dSmoothMax(dConst(b.blendM), dSqrt(dMax(rest, dConst(0.001)) * ${curv}), ${f(P.widthSoftM)});
    let start = dConst(b.terraceM) + dMul(width, dClamp(stepH * (1.0 / ${f(P.stepPresentM)}), 0.0, 1.0));
    return h0 - cut + dMul(stepH, riverRamp_d(dDiv(x, width))) + dMul(rest, riverRamp_d(dDiv(x - start, blend)));
}
// Containment (riverSection.js riverContainFloor, riverContainedHeight):
// the floor at offset n (the drawn channel inside, the raised bank beyond),
// and the fill that raises ground h toward it for water level wl.
fn riverContainFloor_d(n: vec4<f32>, hw: vec4<f32>, bed: vec4<f32>, depth: vec4<f32>, skew: f32, wl: vec4<f32>, left: RiverBank, right: RiverBank) -> vec4<f32> {
    let depthL = riverSideDepth_d(depth, left.freeboard);
    let depthR = riverSideDepth_d(depth, right.freeboard);
    let x = n * select(-1.0, 1.0, n.x >= 0.0) - hw;
    if (x.x < 0.0) { return riverChannel_d(n, hw, bed, depthL, depthR, skew) - dConst(${f(P.softM / 2)}); }
    let full = bed + select(depthR, depthL, n.x >= 0.0) - dConst(${f(P.softM / 2)});
    let top = wl + dConst(${f(P.marginM)});
    if (x.x < ${f(C.riseM)}) {
        // riverRamp with rampRound 0.5: 2 t^2, then 1 - 2 (1 - t)^2.
        let t = x * ${f(1 / C.riseM)};
        let r = select(dConst(1.0) - dMul(dConst(1.0) - t, dConst(1.0) - t) * 2.0, dMul(t, t) * 2.0, t.x < 0.5);
        return full + dMul(top - full, r);
    }
    // riverSoftCut over 1 m: 0, d^2 / 2, d - 1 / 2.
    let dx = x - dConst(${f(C.crestM)});
    let soft = select(select(dx - dConst(0.5), dMul(dx, dx) * 0.5, dx.x < 1.0), dConst(0.0), dx.x <= 0.0);
    return top - soft * ${f(C.outSlope)};
}
fn riverContainFill_d(floor: vec4<f32>, h: vec4<f32>, wl: vec4<f32>) -> vec4<f32> {
    let t = dSmoothstep(0.0, 1.0, (floor - wl) * ${f(1 / C.wetFadeM)} + dConst(1.0));
    let fill = dMul(dMax(floor - h, dConst(0.0)), t);
    return fill - dMax(fill - dConst(${f(C.maxFillM)}), dConst(0.0));
}
` : '');
}
