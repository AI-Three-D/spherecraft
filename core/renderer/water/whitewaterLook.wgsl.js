// core/renderer/water/whitewaterLook.wgsl.js
//
// The moving water's surface: what the mid-range mesh (fieldWaterSurface.wgsl.js,
// baked flow) and the near simulation's mesh (whitewaterSurface.wgsl.js) both
// draw, so the two only differ in their inputs. From Whitewater's fsWater: two
// phases of noise carried along the velocity and cross-faded, so the pattern
// moves with the water without ever stretching out; ripples and foam from it.
// Beyond Whitewater: octaves fade by the pixel's footprint and foam turns into
// plain coverage with distance (no shimmer), foam has body (shaded by its own
// pattern, tinted by the sky), and a lit edge where it thins.

// Keep in step with WhitewaterSim.js whitewaterUniforms.
export const WHITE_UNIFORM_FLOATS = 32;
export const WHITE_FLAG_LOOK = 1;
export const WHITE_FLAG_NEAR = 2;

export const WHITE_UNIFORMS_WGSL = /* wgsl */`
// Frame of the near simulation (a tangent plane; also the coordinates the
// surface pattern is laid out in, at any distance).
struct WhiteU {
    c: vec3<f32>, R: f32,
    e1: vec3<f32>, time: f32,
    e2: vec3<f32>, dx: f32,
    N: u32, flags: u32, blockCells: u32, gridBlocks: u32,
    originBlock: vec2<i32>, hmin: f32, waveAmp: f32,
    cameraXY: vec2<f32>, nearFadeM: vec2<f32>,
    foamGain: f32, rockDrawM: f32, pad1: f32, pad2: f32,
    pad3: vec4<f32>,
};
fn whiteFrameXY(dir: vec3<f32>) -> vec2<f32> {
    let k = W.R / max(dot(dir, W.c), 1.0e-6);
    return vec2<f32>(dot(dir, W.e1), dot(dir, W.e2)) * k;
}
fn whiteFrameDir(xy: vec2<f32>) -> vec3<f32> {
    return normalize(W.c + (W.e1 * xy.x + W.e2 * xy.y) / W.R);
}
`;

export function whitewaterLookWgsl() {
    return /* wgsl */`
fn whiteRidge(p: vec2<f32>) -> f32 { return 1.0 - abs(2.0 * waterNoise(p) - 1.0); }
// Baked foam stands in patches: a rapid is not white from bank to bank.
fn whiteBakedFoam(foam: f32, xy: vec2<f32>) -> f32 {
    return foam * W.foamGain * (0.45 + 1.1 * waterNoise(xy * 0.085 + 3.1));
}
// Debug views (qtDiag.water.tint), Whitewater's F1 modes: 11 speed, 12 foam, 13
// turbulence, 14 Froude, 15 who draws it (magenta simulation, green baked flow).
fn whiteHeat(x: f32) -> vec3<f32> {
    let t = clamp(x, 0.0, 1.0);
    return mix(mix(vec3<f32>(0.0, 0.0, 0.6), vec3<f32>(0.0, 0.9, 0.2), smoothstep(0.0, 0.5, t)), vec3<f32>(1.0, 0.1, 0.0), smoothstep(0.5, 1.0, t));
}
fn whiteDebug(mode: u32, vel: vec2<f32>, foam: f32, turb: f32, h: f32, tier: vec3<f32>) -> vec4<f32> {
    var c = tier;
    if (mode == 11u) { c = whiteHeat(length(vel) / 6.0); }
    else if (mode == 12u) { c = whiteHeat(foam); }
    else if (mode == 13u) { c = whiteHeat(turb); }
    else if (mode == 14u) { c = whiteHeat(length(vel) / sqrt(9.81 * max(h, 0.02)) / 2.0); }
    return vec4<f32>(c, 1.0);
}

// Surface terms over the body (nearWaterCompose): rgb added, a how much of the
// body it hides. N0: the surface's normal before ripples. vel: m/s, xy: m, in the
// frame. foam 0..1, turb 0..1.
fn whiteSurface(wp: vec3<f32>, N0: vec3<f32>, xy: vec2<f32>, vel: vec2<f32>, foam: f32, turb: f32) -> vec4<f32> {
    let toCam = U.cameraPos - wp;
    let dist = length(toCam);
    let V = toCam / dist;
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    // A pixel's width on the water (m), wider at grazing angles.
    let px = dist * 0.0011 / max(abs(dot(V, N0)), 0.12);
    // A short cycle: over Whitewater's 1.5 s the pattern travels 5-10 m here,
    // and shear between neighbouring vertices drew it into zigzags.
    let T = 0.8;
    let t = W.time;
    let ph0 = fract(t / T);
    let ph1 = fract(t / T + 0.5);
    let blend = abs(2.0 * ph0 - 1.0);
    let uvA = xy - vel * (ph0 * T);
    let uvB = xy - vel * (ph1 * T) + vec2<f32>(37.0, 11.0);

    // Ripples: two octaves, the finer one gone by a few hundred metres.
    let o0 = 1.0 - smoothstep(0.35, 1.2, px);
    let o1 = 1.0 - smoothstep(0.12, 0.45, px);
    var g = vec2<f32>(0.0);
    if (o0 > 0.0) {
        g = mix(waterNoiseGrad(uvA * 1.6), waterNoiseGrad(uvB * 1.6), blend) * o0;
        if (o1 > 0.0) { g += mix(waterNoiseGrad(uvA * 4.3 + 9.0), waterNoiseGrad(uvB * 4.3 + 9.0), blend) * (0.45 * o1); }
    }
    let strength = 0.03 + 0.14 * max(turb, 0.09 * length(vel));
    let e1 = normalize(W.e1 - N0 * dot(W.e1, N0));
    let e2 = normalize(W.e2 - N0 * dot(W.e2, N0));
    let N = normalize(N0 - (e1 * g.x + e2 * g.y) * strength);
    let Nf = N * select(-1.0, 1.0, dot(N, V) >= 0.0);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(Nf, V), 0.0), 5.0);
    let R = reflect(-V, Nf);
    let spec = pow(max(dot(R, L), 0.0), 240.0) * 1.6;
    let reflected = sky * waterParams.deepColor.a * fres + sun * spec;

    // Foam: coverage rises with foam; ridged octaves of the moving pattern cut it
    // into lace and filaments (plain noise, thresholded, made cow spots), fading
    // to plain coverage as pixels outgrow them.
    let fa = clamp(foam, 0.0, 1.0);
    if (fa <= 0.002) { return vec4<f32>(reflected, fres); }
    let c0 = 1.0 - smoothstep(0.5, 1.8, px);
    let c1 = 1.0 - smoothstep(0.18, 0.6, px);
    let c2 = 1.0 - smoothstep(0.07, 0.22, px);
    var pat = 0.62;
    if (c0 > 0.0) {
        pat = mix(pat, mix(whiteRidge(uvA * 0.55), whiteRidge(uvB * 0.55), blend), 0.62 * c0);
        if (c1 > 0.0) { pat += (mix(whiteRidge(uvA * 1.7 + 3.0), whiteRidge(uvB * 1.7 + 3.0), blend) - 0.62) * (0.42 * c1); }
        if (c2 > 0.0) { pat += (mix(waterNoise(uvA * 5.5 + 7.0), waterNoise(uvB * 5.5 + 7.0), blend) - 0.5) * (0.22 * c2); }
    }
    // Never quite closed: even a cascade shows dark water between its foam.
    let cut = 1.0 - 0.52 * fa;
    let soft = 0.035 + 0.3 * (1.0 - c1) + 0.25 * (1.0 - c0);
    let mask = smoothstep(cut - soft, cut + soft, pat) * smoothstep(0.0, 0.12, fa);
    // Foam is not a white sheet: thin lace lets the water through and goes grey,
    // thick foam is bright, and the sun models it by the surface's own slope.
    let lit = sky * 0.85 + sun * (0.1 + 0.9 * max(dot(N, L), 0.0));
    // Far away the pattern is gone and only its average brightness is left.
    let thick = mix(0.82, smoothstep(cut, cut + 0.32, pat), c1);
    let foamCol = vec3<f32>(0.90, 0.94, 0.97) * lit * mix(0.13, 0.36, thick);
    nearWaterHardShore = mask;
    return vec4<f32>(mix(reflected, foamCol, mask), mix(fres, 1.0, mask));
}
`;
}
