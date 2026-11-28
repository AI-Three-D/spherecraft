// @ts-nocheck
// The grass field past the blades, traced through slices standing on the ground (terrainPass.wgsl.js; after Habel,
// Wimmer and Jeschke, Instant Animated Grass, 2007). The analytic canopy (grassHue.wgsl.js grassCanopy) is right on
// average but nothing stands in it: past where blades are drawn one by one, the field read as a carpet with a picture of
// grass laid flat on it. Here the sight line is walked from where it enters the grass layer down to the ground point,
// across a grid of vertical slices (grassSlices.js): at each it meets the blades of that slab seen from the side, at the
// height it passes, nearer ones in front. Each slice stands as tall as the blades' own zones make the stand there
// (grassWgsl.js vnoise, face metres, the same places), and is as full as the ground is grassy.
//
// Returns (view, lit, through) as grassCanopy's (x, y, z) before its division by what is met: the ramp of what the sight
// line meets (relative to the field's mean colour), the same lit by the sun, and the share that reaches the ground.

import { SLICES_PER_WAY, SLICE_HEIGHT, SLICE_HEIGHT_M, SLICE_PERIOD_M, SLICE_SPACING_M, SLICE_WIDTH } from './grassSlices.js';

export function grassMediumWGSL({ crossings = 24 } = {}) {
    const n = x => (Number.isInteger(x) ? `${x}.0` : `${x}`);
    return /* wgsl */`
fn gmPcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn gmHash3(x: u32, y: u32, z: u32) -> u32 { return gmPcg(x ^ gmPcg(y ^ gmPcg(z + 0x9e3779b9u))); }
fn gmU01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
// As the blades' vnoise (grassWgsl.js), on face metres: the same zones at the same places.
fn gmNoise(p: vec2<f32>, seed: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let k = vec2<u32>(vec2<i32>(i) + vec2<i32>(1 << 20));
    let a = gmU01(gmHash3(k.x, k.y, seed));
    let b = gmU01(gmHash3(k.x + 1u, k.y, seed));
    let c = gmU01(gmHash3(k.x, k.y + 1u, seed));
    let e = gmU01(gmHash3(k.x + 1u, k.y + 1u, seed));
    return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}
fn gmStep3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
// The stand's height here, against the slices' (the blades' zones: 0.75-1.3).
fn gmStand(face: vec2<f32>) -> f32 { return mix(0.75, 1.3, gmStep3(0.3, 0.75, gmNoise(face / 8.5, 51u))); }

// face: the ground point in face metres (the blades' coordinates); tile: the same in the slices' tile (metres, turned
// as the grain); eye: toward the eye, in the tile's frame (x, y) and up (z); faceEye: its level part in face metres;
// share: how grassy; sunDepth: the sun's optical depth through the stand per unit of its height (grassSunDepth);
// footprint: a pixel across on the ground (m); mean: the field's mean colour (the slices' last level).
fn grassMedium(face: vec2<f32>, tile: vec2<f32>, eye: vec3<f32>, faceEye: vec2<f32>, share: f32, sunDepth: f32,
               footprint: f32, mean: vec3<f32>) -> vec3<f32> {
    let slant = max(eye.z, 0.02);
    // From where the sight line enters the tallest stands down to the ground point (m along it); past 48 m of it, the
    // field is a few pixels deep and has long hidden the ground.
    let top = ${n(SLICE_HEIGHT_M)} * 1.3;
    let run = min(top / slant, 48.0);
    // The stands' height at both ends (the zones change over metres: between them, linear).
    let standNear = gmStand(face);
    let standFar = gmStand(face + faceEye * run);
    // Walk from the entry toward the ground point: the slices are the planes x, y = (i + 0.5) spacing.
    let start = tile + eye.xy * run;
    let dir = -eye.xy;
    let spacing = ${n(SLICE_SPACING_M)};
    let cell = floor(start / spacing - 0.5);
    let stepI = vec2<f32>(select(-1.0, 1.0, dir.x > 0.0), select(-1.0, 1.0, dir.y > 0.0));
    let invDir = 1.0 / max(abs(dir), vec2<f32>(1.0e-5));
    var next = (cell + 0.5 + max(stepI, vec2<f32>(0.0))) * spacing;
    var sNext = (next - start) * stepI * invDir;
    let sStep = spacing * invDir;
    var index = vec2<i32>(cell + max(stepI, vec2<f32>(0.0)));
    let lod = log2(max(footprint * ${n(SLICE_WIDTH / SLICE_PERIOD_M)}, 1.0));
    let meanLum = max(dot(mean, vec3<f32>(0.3333)), 1.0e-4);
    var through = 1.0;
    var view = 0.0;
    var lit = 0.0;
    for (var i = 0u; i < ${crossings}u; i++) {
        let wayY = sNext.y < sNext.x;
        let s = select(sNext.x, sNext.y, wayY);
        if (s >= run) { break; }
        let back = run - s;
        let z = back * slant;
        let p = start + dir * s;
        let stand = ${n(SLICE_HEIGHT_M)} * mix(standNear, standFar, back / run);
        if (z < stand) {
            // A slice across x (its slab's blades seen along x) holds them by y, and so the other way.
            let slab = select(index.x, index.y, wayY);
            let layer = select(0, ${SLICES_PER_WAY}, wayY) + ((slab % ${SLICES_PER_WAY}) + ${SLICES_PER_WAY}) % ${SLICES_PER_WAY};
            let along = select(p.y, p.x, wayY) / ${n(SLICE_PERIOD_M)};
            let v = clamp(1.0 - z / stand, ${n(0.5 / SLICE_HEIGHT)}, ${n(1 - 0.5 / SLICE_HEIGHT)});
            let c = textureSampleLevel(grassSlices, groundSampler, vec2<f32>(along, v), layer, lod);
            let a = saturate(c.a * share);
            let rampLum = dot(c.rgb, vec3<f32>(0.3333)) / meanLum * share;
            let sun = 0.2 + 0.8 * exp(-sunDepth * (1.0 - z / stand));
            view += through * rampLum;
            lit += through * rampLum * sun;
            through *= 1.0 - a;
            if (through < 0.02) { break; }
        }
        if (wayY) { sNext.y += sStep.y; index.y += i32(stepI.y); } else { sNext.x += sStep.x; index.x += i32(stepI.x); }
    }
    return vec3<f32>(view, lit, through);
}
`;
}
