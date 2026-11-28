// @ts-nocheck
// The shared wind's gusts (WindField.js), for shaders. Needs hash3 and u01 (ecologyLattice.wgsl.js).

export function buildWindWGSL({ binding = [0, 0] } = {}) {
    return /* wgsl */`
struct WindFrame {
    dir: vec4<f32>,     // the wind's way (world, level at the camera), speed (m/s)
    origin: vec4<f32>,  // the camera from the planet's centre less what the wind has carried (m), gust strength
};
@group(${binding[0]}) @binding(${binding[1]}) var<uniform> wind: WindFrame;
fn windNoise3(p: vec3<f32>, seed: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let w = f * f * (3.0 - 2.0 * f);
    let k = vec3<u32>(vec3<i32>(i) + vec3<i32>(1 << 22));
    let s = seed * 0x9E3779B1u;
    let a = mix(u01(hash3(k.x ^ s, k.y, k.z)), u01(hash3((k.x + 1u) ^ s, k.y, k.z)), w.x);
    let b = mix(u01(hash3(k.x ^ s, k.y + 1u, k.z)), u01(hash3((k.x + 1u) ^ s, k.y + 1u, k.z)), w.x);
    let c = mix(u01(hash3(k.x ^ s, k.y, k.z + 1u)), u01(hash3((k.x + 1u) ^ s, k.y, k.z + 1u)), w.x);
    let e = mix(u01(hash3(k.x ^ s, k.y + 1u, k.z + 1u)), u01(hash3((k.x + 1u) ^ s, k.y + 1u, k.z + 1u)), w.x);
    return mix(mix(a, b, w.y), mix(c, e, w.y), w.z);
}
// The gusts at a point (rel: from the camera, m): 0..1, broad waves 22 m across and finer ones, carried with the wind.
fn windGust(rel: vec3<f32>) -> f32 {
    let p = wind.origin.xyz + rel;
    return windNoise3(p / 22.0, 7u) * 0.75 + windNoise3(p / 7.5 + 13.1, 11u) * 0.25;
}
`;
}
