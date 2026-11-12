// core/renderer/water/whitewaterLook.wgsl.js
//
// The surface of all water near the camera: what the lake sheets
// (nearWaterSurface.wgsl.js), the mid-range mesh (fieldWaterSurface.wgsl.js, baked
// flow) and the near simulation's mesh (whitewaterSurface.wgsl.js) all draw, so they
// only differ in their inputs. The camera picks the level of detail, not the water:
// within lakeDetailM still water has this surface too, and past it the distant
// water's statistics (waterWgsl.js waterSurfaceTerms) take over.
// From Whitewater's fsWater: two phases of noise carried along the velocity and
// cross-faded, so the pattern moves with the water without ever stretching out;
// ripples and foam from it. Beyond Whitewater: octaves fade by the pixel's footprint
// and foam turns into plain coverage with distance (no shimmer), foam has body
// (shaded by its own pattern, tinted by the sky), and a lit edge where it thins.

// Keep in step with WhitewaterSim.js whitewaterUniforms.
export const WHITE_UNIFORM_FLOATS = 32;
export const WHITE_FLAG_LOOK = 1;
export const WHITE_FLAG_NEAR = 2;
export const WHITE_FLAG_WALLS = 4;

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
    foamGain: f32, rockDrawM: f32, frameS: f32, simFoamFloor: f32,   // share of the baked foam kept under the solver's
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
// The velocity's gradient (1/s) where the solver draws (whitewaterSurface.wgsl.js);
// the baked tiers' flow is smooth.
var<private> nearWaterShear: f32 = 0.0;
// Ridged noise. Ridges of one lattice follow it: from above the foam was a maze of
// rounded squares. Two lattices at unrelated angles do not line up. 1.4 keeps the
// mean and spread of a single ridge, 0.65 and 0.24.
fn whiteRidge(p: vec2<f32>) -> f32 {
    let a = waterNoise(vec2<f32>(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) + 5.2);
    let b = waterNoise(vec2<f32>(0.28 * p.x + 0.96 * p.y, -0.96 * p.x + 0.28 * p.y) * 1.31 + 1.7);
    return max(0.0, 1.0 - 1.4 * abs(a + b - 1.0));
}
// Foam's bubble walls: cellular noise (Worley), F2 - F1 of a jittered unit grid, 0 on
// a wall between two cells, up to about 1 in a cell's middle. Thresholded noise alone
// drew soft blobs (owner 2026-11-09: stretched and blurred, not sharp enough); walls
// make the patches' edges lace and leave holes in thick foam.
fn whiteCellHash(c: vec2<f32>) -> vec2<f32> {
    var v = vec2<u32>(bitcast<u32>(i32(c.x)), bitcast<u32>(i32(c.y)));
    v = v * 1664525u + 1013904223u;
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v = v ^ (v >> vec2<u32>(16u));
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v = v ^ (v >> vec2<u32>(16u));
    return vec2<f32>(v & vec2<u32>(0xffffu)) * (0.8 / 65535.0) + 0.1;
}
fn whiteCellWalls(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    var d1 = 9.0;
    var d2 = 9.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let o = vec2<f32>(f32(x), f32(y));
            let r = o + whiteCellHash(i + o) - f;
            let d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
    }
    return sqrt(d2) - sqrt(d1);
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

// Still water. No flow carries a pattern here, and the two phases of moving water
// would boil on the spot at these speeds, so each scale drifts its own way and their
// sum keeps changing, at half the noise. Laid out in the frame, as moving water is:
// the same at every tier's edge.
fn whiteRippleBand(q: vec2<f32>, invM: f32, c: f32, s: f32, drift: vec2<f32>) -> vec2<f32> {
    let r = vec2<f32>(c * q.x - s * q.y, s * q.x + c * q.y) * invM + drift * W.time;
    let g = waterNoiseGrad(r);
    return vec2<f32>(c * g.x + s * g.y, -s * g.x + c * g.y);
}
// Its slope, in two parts: waves of 2 to 14 m, which all calm close water has, moving or
// not, and the scales of moving water up close (ruffle: their strength), which moving
// water has of its own. Each goes before a pixel reaches it.
fn whiteCoarseSlope(xy: vec2<f32>, px: f32) -> vec2<f32> {
    let a = 1.0 - smoothstep(3.0, 8.0, px);
    if (a <= 0.0) { return vec2<f32>(0.0); }
    var g = whiteRippleBand(xy, 1.0 / 14.0, 0.8, 0.6, vec2<f32>(0.11, -0.05)) * (0.075 * a);
    let b = 1.0 - smoothstep(1.2, 3.2, px);
    if (b <= 0.0) { return g; }
    g += whiteRippleBand(xy, 1.0 / 5.3, 0.28, 0.96, vec2<f32>(-0.17, 0.12)) * (0.07 * b);
    let c = 1.0 - smoothstep(0.45, 1.2, px);
    if (c > 0.0) { g += whiteRippleBand(xy, 0.5, -0.6, 0.8, vec2<f32>(0.22, 0.26)) * (0.05 * c); }
    return g;
}
fn whiteFineSlope(xy: vec2<f32>, px: f32, ruffle: f32) -> vec2<f32> {
    let d = 1.0 - smoothstep(0.15, 0.6, px);
    if (d <= 0.0) { return vec2<f32>(0.0); }
    var g = whiteRippleBand(xy, 1.6, 0.96, -0.28, vec2<f32>(-0.36, 0.3)) * (ruffle * d);
    let e = 1.0 - smoothstep(0.05, 0.18, px);
    if (e > 0.0) { g += whiteRippleBand(xy, 4.3, 0.6, 0.8, vec2<f32>(0.5, -0.42)) * (0.45 * ruffle * e); }
    return g;
}
// Its lace, as a change to the pattern: moving water's without the phases, each octave on
// its own drift. A web three times coarser (cc) takes over as the fine one goes: ending, it
// drew a ring around the camera. Each web keeps plain noise of about its own size for as
// long as it shows: bare ridges, the finer noise gone, read as a jigsaw from above.
fn whiteCoarseLace(xy: vec2<f32>, cc: f32) -> f32 {
    return (whiteRidge(xy * 0.17 + vec2<f32>(-0.016, 0.021) * W.time + 9.4) - 0.65) * (0.62 * cc)
        + (waterNoise(xy * 0.23 + vec2<f32>(0.021, 0.017) * W.time + 4.6) - 0.5) * (0.55 * cc);
}
fn whiteFineLace(xy: vec2<f32>, c0: f32, c1: f32, c2: f32) -> f32 {
    if (c0 <= 0.0) { return 0.0; }
    var pat = (whiteRidge(xy * 0.55 + vec2<f32>(0.05, -0.03) * W.time) - 0.65) * (0.62 * c0);
    pat += (waterNoise(xy * 0.71 + vec2<f32>(0.06, 0.05) * W.time + 8.3) - 0.5) * (0.55 * c0 * (1.0 - c1));
    if (c1 > 0.0) { pat += (waterNoise(xy * 1.7 + 3.0 + vec2<f32>(-0.09, 0.07) * W.time) - 0.5) * (0.46 * c1); }
    if (c2 > 0.0) { pat += (waterNoise(xy * 5.5 + 7.0 + vec2<f32>(0.13, 0.11) * W.time) - 0.5) * (0.22 * c2); }
    return pat;
}

// Surface terms over the body (nearWaterCompose): rgb added, a how much of the
// body it hides. N0: the surface's normal before ripples. vel: m/s, xy: m, in the
// frame. foam 0..1, turb 0..1. pixel: the fragment's, for the depth under it.
fn whiteSurface(wp: vec3<f32>, N0: vec3<f32>, xy: vec2<f32>, vel: vec2<f32>, foam: f32, turb: f32, pixel: vec2<f32>) -> vec4<f32> {
    let toCam = U.cameraPos - wp;
    let dist = length(toCam);
    let V = toCam / dist;
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    // A pixel's width on the water (m), wider at grazing angles.
    let px = dist * 0.0011 / max(abs(dot(V, N0)), 0.12);
    let level = normalize(wp - U.origin);
    // How much of this is still water, and of that how much is close enough for
    // this surface (close), the rest being far enough for the distant one (far). What
    // moves keeps its own surface at any distance. Close by (near) all water has at least
    // the ruffle and lace of still water, and calm water its coarse scales: without, the
    // slow edge of a plume, moving but carrying no foam, was a smooth patch.
    let near = waterCloseShare(dist);
    let calm = near * (1.0 - smoothstep(0.0, 0.3, foam));
    let still = 1.0 - smoothstep(0.05, 0.6, length(vel));
    let close = still * near;
    let far = still - close;
    var gust = 0.5;
    if (still > 0.001) {
        let cameraHeight = length(U.cameraPos - U.origin) - waterParams.planetRadius;
        gust = waterWind(wp, dist * 0.0011 / max(abs(dot(V, level)), 0.03), cameraHeight);
    }
    let ruffle = near * waterParams.open.a * (0.4 + 1.2 * gust);
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
    if (o0 > 0.0 && still < 0.999) {
        g = mix(waterNoiseGrad(uvA * 1.6), waterNoiseGrad(uvB * 1.6), blend) * (o0 * contrast);
        if (o1 > 0.0) { g += mix(waterNoiseGrad(uvA * 4.3 + 9.0), waterNoiseGrad(uvB * 4.3 + 9.0), blend) * (0.45 * o1 * contrast); }
    }
    g *= 0.03 + 0.14 * max(max(turb, ruffle), 0.09 * length(vel));
    if (close > 0.001) { g = mix(g, whiteFineSlope(xy, px, 0.03 + 0.14 * ruffle), close); }
    if (calm > 0.001) { g += whiteCoarseSlope(xy, px) * calm; }
    let e1 = normalize(W.e1 - N0 * dot(W.e1, N0));
    let e2 = normalize(W.e2 - N0 * dot(W.e2, N0));
    let N = normalize(N0 - e1 * g.x - e2 * g.y);
    // Seen from above the sky's reflection is weak and ripples hardly touch it, and close
    // water read as a flat colour: its slopes shade the body as well.
    nearWaterRelief = 1.0 + near * clamp(2.0 * dot(N - N0, L), -0.2, 0.3);
    let Nf = N * select(-1.0, 1.0, dot(N, V) >= 0.0);
    var fres = 0.02 + 0.98 * pow(1.0 - max(dot(Nf, V), 0.0), 5.0);
    let R = reflect(-V, Nf);
    let spec = pow(max(dot(R, L), 0.0), 240.0) * 1.6;
    // Glitter is the statistics of the whole surface: on the solver's normal it stopped
    // at every cross-wave, in a straight line.
    var reflected = waterSkyColor(level, abs(dot(R, N0)), L, sky) * waterParams.deepColor.a * fres + sun * (spec + (0.2 + 0.8 * smoothstep(0.4, 1.2, px)) * waterGlitter(V, level, level, L, 0.1));
    // Far still water is the distant surface whichever tier draws it: the solver's blocks
    // and the field's pages end in straight lines across a lake.
    nearWaterAerated = smoothstep(0.8, 2.5, length(vel));
    if (far > 0.001) {
        let lake = waterSurfaceTerms(wp, level, U.cameraPos, L, sun, sky);
        reflected = mix(reflected, lake.rgb, far);
        fres = mix(fres, lake.a, far);
    }
    waterWindNow = mix(0.5, gust, still);

    // Foam: coverage rises with foam; the moving pattern, ridged first (plain noise
    // alone, thresholded, made cow spots), cuts it into lace and wisps, fading to plain
    // coverage as pixels outgrow them.
    // Octaves go before their finest features reach pixel size. A ridged octave's
    // filaments are a fraction of its lattice: left in, a filament a pixel wide lights
    // a pixel for one frame as it passes, which reads as flicker from above.
    let c0 = 1.0 - smoothstep(0.2, 0.7, px);
    let c1 = 1.0 - smoothstep(0.06, 0.2, px);
    // The finest also when it moves so far a frame that it strobes (at the game's
    // 30 FPS when still: from ~2 m/s).
    let c2 = (1.0 - smoothstep(0.03, 0.09, px)) * (1.0 - smoothstep(0.07, 0.16, length(vel) * W.frameS));
    let cc = (1.0 - c0) * (1.0 - smoothstep(0.8, 2.6, px));
    // Close still water has lace of its own, more of it in the gusts: none in the shallows,
    // where the bed shows, and gone before the pattern is, or it would turn into a pale haze.
    var fa = clamp(foam, 0.0, 1.0);
    let reach = max(c0, 0.45 * cc);
    if (near * reach > 0.001) {
        let depth = nearWaterBehind(wp, pixel) * max(abs(dot(V, level)), 0.05);
        fa = max(fa, waterParams.absorption.a * near * reach * (0.45 + 0.55 * smoothstep(0.1, 0.9, gust)) * smoothstep(0.2, 1.6, depth));
    }
    if (fa <= 0.002) { return vec4<f32>(reflected, fres); }
    var pat = 0.62;
    if (c0 > 0.0 && still < 0.999) {
        pat += (mix(whiteRidge(uvA * 0.55), whiteRidge(uvB * 0.55), blend) - 0.65) * (0.62 * c0 * contrast);
        // Plain noise breaks the ridges into wisps: two ridged octaves drew cracks in glass.
        if (c1 > 0.0) { pat += (mix(waterNoise(uvA * 1.7 + 3.0), waterNoise(uvB * 1.7 + 3.0), blend) - 0.5) * (0.46 * c1 * contrast); }
        if (c2 > 0.0) { pat += (mix(waterNoise(uvA * 5.5 + 7.0), waterNoise(uvB * 5.5 + 7.0), blend) - 0.5) * (0.22 * c2 * contrast); }
    }
    if (close > 0.001) { pat = mix(pat, 0.62 + whiteFineLace(xy, c0, c1, c2), close); }
    if (cc * calm > 0.001) { pat += whiteCoarseLace(xy, cc) * calm; }
    // Bubble walls (whiteCellWalls) of 1.6 m cells, carried in both phases, gone
    // before they reach pixel size: the patches' edges become lace, thick foam
    // keeps holes. Finer cells (0.45 m) combed into parallel
    // stripes wherever eddies shear the carried pattern.
    // Where eddies shear the carried pattern within a phase (shear x T), sharp walls
    // drew it as combed stripes: they go there (the noise patches stay). In patches,
    // or the cells read as a net.
    var walls = 0.0;
    let sp = length(vel);
    let wallW = c0 * (1.0 - smoothstep(0.15, 0.4, nearWaterShear * T)) * smoothstep(0.25, 0.55, waterNoise(xy * 0.11 + 2.7));
    if (wallW > 0.0) {
        // Round cells: stretched along the flow, a direction that turns round an eddy
        // drew concentric stripes like a fingerprint.
        let wc = mix(whiteCellWalls(uvA / 1.6), whiteCellWalls((uvB + 5.3) / 1.6), blend);
        walls = (0.32 - wc) * (0.75 * wallW * contrast);
    }
    pat += walls;
    // Never quite closed: even a cascade shows dark water between its foam.
    let cut = 1.0 - 0.52 * fa;
    // Antialiased: the pattern changes by about 2 per metre (more where the walls
    // are), so a hard edge seen from above is a coin toss per pixel, and shimmers as
    // it moves; up close the edge is crisp.
    let soft = 0.012 + min(2.4 * mix(1.0, 0.33, calm * (1.0 - c0)) * px, 0.45);
    // Lace is a thin film, not foam: what water carries keeps its body.
    let film = 1.0 - 0.6 * calm;
    let mask = smoothstep(cut - soft, cut + soft, pat) * smoothstep(0.0, 0.12, fa) * waterFoamFar(dist) * film;
    // Foam is not a white sheet: thin lace lets the water through and goes grey,
    // thick foam is bright, and the sun models it by the surface's own slope.
    let lit = sky * 0.85 + sun * (0.1 + 0.9 * max(dot(N, L), 0.0));
    // Far away the pattern is gone and only its average brightness is left.
    let thick = mix(0.82, smoothstep(cut, cut + 0.2, pat), c1);
    let foamCol = vec3<f32>(0.90, 0.94, 0.97) * lit * mix(0.13, 0.36, thick);
    nearWaterHardShore = mask;
    return vec4<f32>(mix(reflected, foamCol, mask), mix(fres, 1.0, mask));
}
`;
}
