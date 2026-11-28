// @ts-nocheck
// The grass field's own variation on the ground past the blades (terrainPass.wgsl.js): the blades' shade patches
// (3.2 m), hue zones (4.2 m) and straw zones (6.1 m), by the same noise at the same places (grassWgsl.js generateMain:
// face metres). The fine textures the ground wears (grassPortraits.js,
// grassGrain.js) are one stand and repeat every 4 m; what varies over the field comes from here, so it neither repeats
// nor changes where the blades end. Each part is the blades' colour factor over its mean, faded to 1 where a pixel is
// wider than it (it would flicker and stand in rows).

/** The field's patch noise (shade 3.2 m, hue 4.2 m, straw 6.1 m): value noise on face metres with a cheap hash (one
 * round, against the blades' three-round pcg: the ground evaluates three of these on every grass pixel). Shared by the
 * blades (grassWgsl.js) and the ground, so their patches lie at the same places. */
export const FIELD_NOISE_WGSL = /* wgsl */`
fn fieldHash(x: u32, y: u32, seed: u32) -> f32 {
    var h = (x * 0x27d4eb2du) ^ (y * 0x165667b1u) ^ (seed * 0x9e3779b9u);
    h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
    h = h ^ (h >> 12u);
    return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn fieldNoise(p: vec2<f32>, seed: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let k = vec2<u32>(vec2<i32>(i) + vec2<i32>(1 << 20));
    let a = fieldHash(k.x, k.y, seed);
    let b = fieldHash(k.x + 1u, k.y, seed);
    let c = fieldHash(k.x, k.y + 1u, seed);
    let e = fieldHash(k.x + 1u, k.y + 1u, seed);
    return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}
`;

export const GRASS_FIELD_WGSL = /* wgsl */`
${FIELD_NOISE_WGSL}
fn gfStep3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
// The field's colour factor at face metres q on face, for a pixel minor (across) and major (along the view) metres wide;
// dry: how much of the grass is straw already (the straw zones show less on dry ground).
fn grassFieldColour(q: vec2<f32>, face: u32, minor: f32, major: f32, dry: f32) -> vec3<f32> {
    // (The blades' clumps, 0.6 m, are not here: where a pixel holds less than one, blades stand over the ground and hide
    // it; worked out on every pixel they cost more than the rest of the ground's grass.)
    var c = vec3<f32>(1.0);
    // Shade patches 3.2 m: 0.8-1.16; hue zones 4.2 m; straw zones 6.1 m (the blades' n1.w, n0.y, n0.z).
    let patchSeen = 1.0 - gfStep3(0.8, 2.4, minor);
    if (patchSeen > 0.0) {
        c *= mix(1.0, mix(0.8, 1.16, gfStep3(0.2, 0.8, fieldNoise(q / 3.2, 63u))) / 0.98, patchSeen);
        let hueZone = gfStep3(0.25, 0.75, fieldNoise(q / 4.2 + 7.3, 53u));
        c *= mix(vec3<f32>(1.0), mix(vec3<f32>(1.07, 1.025, 0.89), vec3<f32>(0.93, 0.985, 1.04), hueZone) / vec3<f32>(1.0, 1.005, 0.965), patchSeen);
        let straw = mix(0.03, 0.075, gfStep3(0.45, 0.9, fieldNoise(q / 6.1 + 3.1, 57u)));
        c *= mix(vec3<f32>(1.0), vec3<f32>(1.0) + (straw - 0.0525) * vec3<f32>(2.6, 1.9, 0.4) * (1.0 - dry), patchSeen);
    }
    return c;
}
`;
