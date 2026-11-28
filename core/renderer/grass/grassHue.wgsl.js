// Shared by the grass blades (grassWgsl.js) and the ground they stand on (terrainPass.wgsl.js).

/**
 * The hue of grass by climate, as a factor on the ground's grass colour (groundMaterials.js means): blue-green where
 * cool, deep green where warm and wet, yellow-green where it dries. The terrain (terrainPass.wgsl.js) and the blades
 * take it alike, so that blades and the ground they hand over to agree. Needs step3.
 */
export const GRASS_HUE_WGSL = /* wgsl */`
fn grassHue(temperature: f32, humidity: f32) -> vec3<f32> {
    let warm = step3(0.40, 0.68, temperature);
    let lush = mix(vec3<f32>(0.80, 1.06, 1.40), vec3<f32>(0.82, 1.10, 1.04), warm);
    return mix(lush, vec3<f32>(1.12, 1.05, 0.90), 0.7 * step3(0.55, 0.25, humidity));
}
`;

/**
 * The grass canopy as a sight line meets it (the gap-fraction and hotspot models of vegetation remote sensing: Nilson
 * 1971, Kuusk 1985). Blades fill the canopy from the ground (t 0) to their tips (t 1), darker low in it as the blades'
 * own ramp is (1 - b (1 - t)), and the sun reaches low parts less (0.2 + 0.8 exp(-k (1 - t))). tau: the canopy's optical
 * depth along the sight line; k: along the sun's, 0 where the two lines meet the same blades (the hotspot). Returns x the
 * mean ramp of what the sight line meets in the canopy, y the same times the sun that reaches it, z the share of the
 * sight line that reaches the ground (exp(-tau)). The terrain (terrainPass.wgsl.js) and the far blades (grassWgsl.js)
 * light grass with it alike: the two meet without a seam, and the look follows the view's slant, not the distance.
 */
export const GRASS_CANOPY_WGSL = /* wgsl */`
// The integral of tau exp(-sigma u) (1 - b u) over the depth below the tips u (0..1), sigma = tau + k.
fn grassCanopyRamp(tau: f32, k: f32, b: f32) -> f32 {
    let s = max(tau + k, 0.001);
    let e = exp(-s);
    let first = select((1.0 - e) / s, 1.0 - s * 0.5 + s * s / 6.0, s < 0.05);
    let second = select((1.0 - e * (1.0 + s)) / (s * s), 0.5 - s / 3.0 + s * s * 0.125, s < 0.05);
    return tau * (first - b * second);
}
fn grassCanopy(tau: f32, k: f32, b: f32) -> vec3<f32> {
    let t = max(tau, 0.001);
    let hit = 1.0 - exp(-t);
    let view = grassCanopyRamp(t, 0.0, b);
    let lit = 0.2 * view + 0.8 * grassCanopyRamp(t, k, b);
    return vec3<f32>(view / hit, lit / hit, 1.0 - hit);
}
// The sun's depth through the canopy per unit of height (the blades' own self-shade: grassWgsl.js), and how much of it
// the hotspot takes away when the view looks along the sun.
// What the analytic canopy misses, fitted to its teacher (tools/perf/grass/teacherRun.mjs, teacherFit.py: the field
// drawn as it is, zoomed in 8 times and boxed down, over 22 views of a meadow and a slope, 10-190 m off): the canopy's
// colour times this. Seen along the ground from standing height it was up to twice too bright (it is lit as a velvet
// facing up and toward the eye, where a grazing sight line meets blades' sides), most toward the sun; from above it
// was about right. log of the factor: a quadratic in log slant, log distance, with the hotspot and the sun's height.
// slant: the sight line's to the canopy; hot: toward the eye . toward the sun; sunUp; distance (m). Mean error after
// it, held out by view: 7.6 % (before: 16 %). Refitted per channel over the teacher drawn with it in place (its gaps
// show the ground, so it moves with it): teacher-2026-11-28b-fit.json, 6.5-8.7 % held out.
fn grassCanopyCorrection(slant: f32, hot: f32, sunUp: f32, distance: f32) -> vec3<f32> {
    let ls = log(clamp(slant, 0.008, 1.0));
    let ld = log(clamp(distance, 10.0, 190.0));
    let k = vec3<f32>(-0.43629, -0.44574, -0.13078)
        + vec3<f32>(0.45176, 0.44207, 0.38824) * (ls)
        + vec3<f32>(0.06529, 0.06235, 0.05885) * (ls * ls)
        + vec3<f32>(0.17967, 0.16822, 0.15585) * (hot)
        + vec3<f32>(0.00882, 0.00316, 0.01404) * (hot * ls)
        + vec3<f32>(-0.23138, -0.25157, -0.24453) * (sunUp)
        + vec3<f32>(-0.00800, -0.01308, -0.00479) * (sunUp * ls)
        + vec3<f32>(0.32127, 0.33761, 0.21339) * (ld)
        + vec3<f32>(-0.02205, -0.02343, -0.01534) * (ld * ld);
    return clamp(exp(k), vec3<f32>(0.4), vec3<f32>(1.3));
}
fn grassSunDepth(sunUp: f32, share: f32, toEye: vec3<f32>, sunDir: vec3<f32>) -> f32 {
    let along = saturate(dot(toEye, sunDir));
    let along3 = along * along * along;
    let hot = along3 * along3;
    return 1.72 * mix(1.6, 0.6, saturate(sunUp)) * share * (1.0 - hot);
}
`;
