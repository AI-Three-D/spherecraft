// @ts-nocheck
// The shared wind's gusts (WindField.js), for shaders. Needs ecoNoise3 (ecologyLattice.wgsl.js).

export function buildWindWGSL({ binding = [0, 0] } = {}) {
    return /* wgsl */`
struct WindFrame {
    dir: vec4<f32>,     // the wind's way (world, level at the camera), speed (m/s)
    origin: vec4<f32>,  // the camera from the planet's centre less what the wind has carried (m), gust strength
};
@group(${binding[0]}) @binding(${binding[1]}) var<uniform> wind: WindFrame;
// The gusts at a point (rel: from the camera, m): 0..1, broad waves 22 m across and finer ones, carried with the wind.
fn windGust(rel: vec3<f32>) -> f32 {
    let p = wind.origin.xyz + rel;
    return ecoNoise3(p / 22.0, 7u) * 0.75 + ecoNoise3(p / 7.5 + 13.1, 11u) * 0.25;
}
`;
}
