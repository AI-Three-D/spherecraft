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
    foamGain: f32, rockDrawM: f32, frameS: f32, pad2: f32,
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
// Ridged noise. Ridges of one lattice follow it: from above the foam was a maze of
// rounded squares. Two lattices at unrelated angles do not line up. 1.4 keeps the
// mean and spread of a single ridge, 0.65 and 0.24.
fn whiteRidge(p: vec2<f32>) -> f32 {
    let a = waterNoise(vec2<f32>(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) + 5.2);
    let b = waterNoise(vec2<f32>(0.28 * p.x + 0.96 * p.y, -0.96 * p.x + 0.28 * p.y) * 1.31 + 1.7);
    return max(0.0, 1.0 - 1.4 * abs(a + b - 1.0));
}
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
    // How long the pattern travels before it fades into its other phase. Longer is
    // calmer; too long and shear between vertices draws it into zigzags.
    let T = 1.2;
    let t = W.time;
    let ph0 = fract(t / T);
    let ph1 = fract(t / T + 0.5);
    let blend = abs(2.0 * ph0 - 1.0);
    // Mixing two noises loses contrast half way through. Thresholded, that made
    // the foam's coverage pulse at twice the cycle's rate: the owner's flicker
    // (flicker.mjs: beat at exactly T / 2, gone with the pattern held still).
    // Scaling back up holds the variance through the fade.
    let contrast = inverseSqrt(blend * blend + (1.0 - blend) * (1.0 - blend));
    let uvA = xy - vel * (ph0 * T);
    let uvB = xy - vel * (ph1 * T) + vec2<f32>(37.0, 11.0);

    // Ripples: two octaves, faded before they reach pixel size: under a sharp sun
    // highlight, a sub-pixel ripple is a glint that blinks.
    let o0 = 1.0 - smoothstep(0.15, 0.6, px);
    let o1 = 1.0 - smoothstep(0.05, 0.18, px);
    var g = vec2<f32>(0.0);
    if (o0 > 0.0) {
        g = mix(waterNoiseGrad(uvA * 1.6), waterNoiseGrad(uvB * 1.6), blend) * (o0 * contrast);
        if (o1 > 0.0) { g += mix(waterNoiseGrad(uvA * 4.3 + 9.0), waterNoiseGrad(uvB * 4.3 + 9.0), blend) * (0.45 * o1 * contrast); }
    }
    let strength = 0.03 + 0.14 * max(turb, 0.09 * length(vel));
    let e1 = normalize(W.e1 - N0 * dot(W.e1, N0));
    let e2 = normalize(W.e2 - N0 * dot(W.e2, N0));
    let N = normalize(N0 - (e1 * g.x + e2 * g.y) * strength);
    let Nf = N * select(-1.0, 1.0, dot(N, V) >= 0.0);
    var fres = 0.02 + 0.98 * pow(1.0 - max(dot(Nf, V), 0.0), 5.0);
    let R = reflect(-V, Nf);
    let spec = pow(max(dot(R, L), 0.0), 240.0) * 1.6;
    // Glitter is the statistics of the whole surface: on the solver's normal it stopped
    // at every cross-wave, in a straight line.
    let level = normalize(wp - U.origin);
    var reflected = waterSkyColor(level, abs(dot(R, N0)), L, sky) * waterParams.deepColor.a * fres + sun * (spec + (0.2 + 0.8 * smoothstep(0.4, 1.2, px)) * waterGlitter(V, level, level, L, 0.1));
    // Still water is the lakes' surface whichever tier draws it: the solver's blocks
    // and the field's pages end in straight lines across a lake.
    let still = 1.0 - smoothstep(0.05, 0.6, length(vel));
    nearWaterAerated = smoothstep(0.8, 2.5, length(vel));
    if (still > 0.001) {
        let lake = waterSurfaceTerms(wp, level, U.cameraPos, L, sun, sky);
        reflected = mix(reflected, lake.rgb, still);
        fres = mix(fres, lake.a, still);
        waterWindNow = mix(0.5, waterWindNow, still);
    }

    // Foam: coverage rises with foam; the moving pattern, ridged first (plain noise
    // alone, thresholded, made cow spots), cuts it into lace and wisps, fading to plain
    // coverage as pixels outgrow them.
    let fa = clamp(foam, 0.0, 1.0);
    if (fa <= 0.002) { return vec4<f32>(reflected, fres); }
    // Octaves go before their finest features reach pixel size. A ridged octave's
    // filaments are a fraction of its lattice: left in, a filament a pixel wide lights
    // a pixel for one frame as it passes, which reads as flicker from above.
    let c0 = 1.0 - smoothstep(0.2, 0.7, px);
    let c1 = 1.0 - smoothstep(0.06, 0.2, px);
    // The finest also when it moves so far a frame that it strobes (at the game's
    // 30 FPS when still: from ~2 m/s).
    let c2 = (1.0 - smoothstep(0.03, 0.09, px)) * (1.0 - smoothstep(0.07, 0.16, length(vel) * W.frameS));
    var pat = 0.62;
    if (c0 > 0.0) {
        pat += (mix(whiteRidge(uvA * 0.55), whiteRidge(uvB * 0.55), blend) - 0.65) * (0.62 * c0 * contrast);
        // Plain noise breaks the ridges into wisps: two ridged octaves drew cracks in glass.
        if (c1 > 0.0) { pat += (mix(waterNoise(uvA * 1.7 + 3.0), waterNoise(uvB * 1.7 + 3.0), blend) - 0.5) * (0.46 * c1 * contrast); }
        if (c2 > 0.0) { pat += (mix(waterNoise(uvA * 5.5 + 7.0), waterNoise(uvB * 5.5 + 7.0), blend) - 0.5) * (0.22 * c2 * contrast); }
    }
    // Never quite closed: even a cascade shows dark water between its foam.
    let cut = 1.0 - 0.52 * fa;
    // Antialiased: the pattern changes by about 2 per metre, so a hard edge seen from
    // above is a coin toss per pixel, and shimmers as it moves.
    let soft = 0.035 + min(1.8 * px, 0.45);
    let mask = smoothstep(cut - soft, cut + soft, pat) * smoothstep(0.0, 0.12, fa) * waterFoamFar(dist);
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
