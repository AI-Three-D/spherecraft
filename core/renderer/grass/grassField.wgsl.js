// @ts-nocheck
// The grass field's own variation on the ground past the blades (terrainPass.wgsl.js): the blades' clumps (Voronoi,
// about 0.6 m), their shade patches (3.2 m), hue zones (4.2 m) and straw zones (6.1 m), by the same hashes at the same
// places (grassWgsl.js generateMain: face metres, the cube face). The fine textures the ground wears (grassPortraits.js,
// grassGrain.js) are one stand and repeat every 4 m; what varies over the field comes from here, so it neither repeats
// nor changes where the blades end. Each part is the blades' colour factor over its mean, faded to 1 where a pixel is
// wider than it (it would flicker and stand in rows).

export const GRASS_FIELD_WGSL = /* wgsl */`
fn gfPcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn gfHash3(x: u32, y: u32, z: u32) -> u32 { return gfPcg(x ^ gfPcg(y ^ gfPcg(z + 0x9e3779b9u))); }
fn gfU01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
fn gfStep3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
// As the blades' vnoise (grassWgsl.js).
fn gfNoise(p: vec2<f32>, seed: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let k = vec2<u32>(vec2<i32>(i) + vec2<i32>(1 << 20));
    let a = gfU01(gfHash3(k.x, k.y, seed));
    let b = gfU01(gfHash3(k.x + 1u, k.y, seed));
    let c = gfU01(gfHash3(k.x, k.y + 1u, seed));
    let e = gfU01(gfHash3(k.x + 1u, k.y + 1u, seed));
    return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}
// The blades' clump here (generateMain: Voronoi on face metres times 1.7, hashed with the face): its value 0..1.
fn gfClump(q: vec2<f32>, face: u32) -> f32 {
    let cq = q * 1.7;
    let ci = vec2<i32>(floor(cq));
    var best = 9.0;
    var hash = 0u;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let cell = vec2<u32>(ci + vec2<i32>(x, y) + vec2<i32>(1 << 22));
            let ch = gfHash3(cell.x, cell.y, face + 17u);
            let o = vec2<f32>(ci + vec2<i32>(x, y)) + vec2<f32>(gfU01(ch), gfU01(gfPcg(ch)));
            let d = dot(o - cq, o - cq);
            if (d < best) { best = d; hash = ch; }
        }
    }
    return gfU01(gfPcg(hash + 3u));
}
// The field's colour factor at face metres q on face, for a pixel minor (across) and major (along the view) metres wide;
// dry: how much of the grass is straw already (the straw zones show less on dry ground).
fn grassFieldColour(q: vec2<f32>, face: u32, minor: f32, major: f32, dry: f32) -> vec3<f32> {
    let wide = sqrt(minor * major);
    var c = vec3<f32>(1.0);
    // Clumps: shade 0.82-1.2 (mean 1.01), seen while a pixel is a third of one.
    let clumpSeen = 1.0 - gfStep3(0.12, 0.35, wide);
    if (clumpSeen > 0.0) { c *= mix(1.0, mix(0.82, 1.2, gfClump(q, face)) / 1.01, clumpSeen); }
    // Shade patches 3.2 m: 0.8-1.16; hue zones 4.2 m; straw zones 6.1 m (the blades' n1.w, n0.y, n0.z).
    let patchSeen = 1.0 - gfStep3(0.8, 2.4, minor);
    if (patchSeen > 0.0) {
        c *= mix(1.0, mix(0.8, 1.16, gfStep3(0.2, 0.8, gfNoise(q / 3.2, 63u))) / 0.98, patchSeen);
        let hueZone = gfStep3(0.25, 0.75, gfNoise(q / 4.2 + 7.3, 53u));
        c *= mix(vec3<f32>(1.0), mix(vec3<f32>(1.14, 1.05, 0.78), vec3<f32>(0.86, 0.97, 1.08), hueZone) / vec3<f32>(1.0, 1.01, 0.93), patchSeen);
        let straw = mix(0.02, 0.11, gfStep3(0.45, 0.9, gfNoise(q / 6.1 + 3.1, 57u)));
        c *= mix(vec3<f32>(1.0), vec3<f32>(1.0) + (straw - 0.045) * vec3<f32>(2.6, 1.9, 0.4) * (1.0 - dry), patchSeen);
    }
    return c;
}
`;
