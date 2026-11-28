// @ts-nocheck
// The habitat writer (ECOLOGY_FOUNDATION_PLAN.md F3; EcologyField.js): for each pool layer given, its tile's habitat
// from climate, terrain and water, and its realized forest: empty, or the mock forest when asked for. A workgroup of
// 8 x 8 texels, z: the job (one layer).
//
// Coarse tiles are sampled at their texels' middles here (climate is smooth). A forest producer writes realized values
// for every level from its population (area averages of cover, crownLAI keeping the mean transmission at 45 degrees).

import { ECOLOGY_LATTICE_WGSL } from './ecologyLattice.wgsl.js';
import { biomeCoverWGSL, unpackBiomeIceWGSL } from '../../../templates/terrain-shaders/biomeLandscape.wgsl.js';
import { ECO_LAI_SCALE, ECO_TOP_SCALE } from './ecologyField.wgsl.js';
import { ECO_MAX_ECOSYSTEMS } from './ecologyRegistry.js';

export function buildEcologyWriterWGSL({ biome }) {
    return /* wgsl */`${ECOLOGY_LATTICE_WGSL}
${biome ? biomeCoverWGSL(biome) : ''}
struct WriterFrame {
    counts: vec4<u32>,  // jobs, resolution, mock forest (1), the mock's stand everywhere vegetated (0: by habitat)
    scale: vec4<f32>,   // planet radius (m), height scale (m), unused, unused
};
@group(0) @binding(0) var<uniform> wf: WriterFrame;
// Two per job: (layer, face, depth, beds made), (x, y, unused, unused).
@group(0) @binding(1) var<storage, read> jobs: array<vec4<u32>>;
// The registry (ecologyRegistry.js): a header, two per ecosystem, three per stand.
@group(0) @binding(2) var<storage, read> registry: array<vec4<f32>>;
@group(0) @binding(3) var outA: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(4) var outB: texture_storage_2d_array<r32uint, write>;
@group(1) @binding(0) var tileHeight: texture_2d_array<f32>;
@group(1) @binding(1) var tileNormals: texture_2d_array<f32>;
@group(1) @binding(2) var climateMap: texture_2d_array<f32>;
@group(1) @binding(3) var tileBeds: texture_2d_array<f32>;

const STANDS_AT: u32 = ${1 + 2 * ECO_MAX_ECOSYSTEMS}u;

// A share of a cover class of the landscape (ecologyRegistry.js ECO_COVER_CLASSES' order).
${biome ? `fn coverShare(c: BiomeCover, k: u32) -> f32 {
    switch (k) {
        case 0u: { return c.grass; }
        case 1u: { return c.forest; }
        case 2u: { return c.marsh; }
        case 3u: { return c.tundra; }
        case 4u: { return c.snow; }
        case 5u: { return c.sand; }
        default: { return c.rock; }
    }
}` : ''}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wg: vec3<u32>) {
    let res = wf.counts.y;
    if (wg.z >= wf.counts.x || gid.x >= res || gid.y >= res) { return; }
    let j0 = jobs[wg.z * 2u];
    let j1 = jobs[wg.z * 2u + 1u];
    let layer = i32(j0.x);
    let face = j0.y;
    let depth = j0.z;
    let local = (vec2<f32>(gid.xy) + 0.5) / f32(res);
    // The tile's texel under this one (its texels' middles lie on its edges).
    let size = vec2<i32>(textureDimensions(tileHeight));
    let src = clamp(vec2<i32>(round(local * vec2<f32>(size - 1))), vec2<i32>(0), size - 1);
    // Where it is: the face's (u, v), the direction from the planet's centre, the world position (for noise).
    let faceUv = (vec2<f32>(j1.xy) + local) / f32(1u << depth);
    let up = normalize(ecoFaceDirection(face, faceUv));
    let world = up * wf.scale.x;
    var suitability = 0.0;
    var hint = ${0}u;
    ${biome ? `
    let climate = textureLoad(climateMap, src, layer, 0);
    let ice = ${unpackBiomeIceWGSL};
    let e = textureLoad(tileNormals, src, layer, 0).rg * 2.0 - 1.0;
    var tx = vec3<f32>(-up.z, 0.0, up.x);
    if (abs(up.y) > 0.99) { tx = vec3<f32>(0.0, up.z, -up.y); }
    tx = normalize(tx);
    let n = normalize(e.x * tx + e.y * cross(up, tx) + (1.0 - abs(e.x) - abs(e.y)) * up);
    let level = saturate(dot(n, up));
    let elevation = textureLoad(tileHeight, src, layer, 0).r * wf.scale.y;
    let cover = biomeCover(climate.r, climate.g, sqrt(max(1.0 - level * level, 0.0)), elevation, 0.0);
    var bed = 0.0;
    if (j0.w != 0u) { bed = saturate(textureLoad(tileBeds, src, layer, 0).r); }
    suitability = saturate(cover.forest * (1.0 - bed) * (1.0 - ice));
    // The first ecosystem whose cover class holds here and whose climate band this is; a stand of it by its share,
    // in patches a couple of hundred metres across.
    let ecosystems = u32(registry[0].x);
    for (var k = 0u; k < ecosystems; k++) {
        let a = registry[1u + k * 2u];
        let b = registry[2u + k * 2u];
        if (coverShare(cover, u32(a.x)) < 0.2 || climate.r < a.y || climate.r > a.z || climate.g < a.w || climate.g > b.x) { continue; }
        let first = u32(b.y);
        let count = u32(b.z);
        var total = 0.0;
        for (var s = 0u; s < count; s++) { total += registry[STANDS_AT + (first + s) * 3u].y; }
        var pick = (ecoNoise3(world / 180.0, 71u) * 0.7 + ecoNoise3(world / 60.0, 73u) * 0.3) * total;
        hint = u32(registry[STANDS_AT + first * 3u].x);
        for (var s = 0u; s < count; s++) {
            let stand = registry[STANDS_AT + (first + s) * 3u];
            hint = u32(stand.x);
            if (pick < stand.y) { break; }
            pick -= stand.y;
        }
        break;
    }` : ''}
    // Realized: empty, or the mock forest (a stand of trees where its hint is one, its canopy ranges by noise, gaps).
    // A lab can ask for one stand wherever the landscape is vegetated (wf.counts.w), whatever the climate.
    var realized = vec3<f32>(0.0);
    var stand = ${0}u;
    var mockHint = hint;
    var mockSuit = suitability;
    ${biome ? `if (wf.counts.w != 0u) { mockHint = wf.counts.w; mockSuit = 0.9 * step3(0.25, 0.5, cover.grass + cover.forest) * (1.0 - ice); }` : ''}
    if (wf.counts.z == 1u && mockHint != 0u) {
        let hint = mockHint;
        let suitability = mockSuit;
        let standCount = u32(registry[0].y);
        for (var s = 0u; s < standCount; s++) {
            let a = registry[STANDS_AT + s * 3u];
            if (u32(a.x) != hint) { continue; }
            let b = registry[STANDS_AT + s * 3u + 1u];
            if (registry[STANDS_AT + s * 3u + 2u].x > 0.5) {
                let gaps = smoothstep(0.18, 0.4, ecoNoise3(world / 35.0, 79u));
                let cover = suitability * mix(a.z, a.w, ecoNoise3(world / 90.0, 83u)) * gaps;
                if (cover > 0.02) {
                    stand = hint;
                    realized = vec3<f32>(cover, mix(b.z, b.w, ecoNoise3(world / 70.0, 89u)), mix(b.x, b.y, ecoNoise3(world / 110.0, 97u)));
                }
            }
            break;
        }
    }
    textureStore(outA, gid.xy, layer, vec4<f32>(suitability, realized.x, realized.y / ${ECO_LAI_SCALE}.0, realized.z / ${ECO_TOP_SCALE}.0));
    textureStore(outB, gid.xy, layer, vec4<u32>(stand | (hint << 16u), 0u, 0u, 0u));
}
`;
}
