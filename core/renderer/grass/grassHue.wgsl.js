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
fn grassSunDepth(sunUp: f32, share: f32, toEye: vec3<f32>, sunDir: vec3<f32>) -> f32 {
    let hot = pow(saturate(dot(toEye, sunDir)), 6.0);
    return 1.72 * mix(1.6, 0.6, saturate(sunUp)) * share * (1.0 - hot);
}
`;
