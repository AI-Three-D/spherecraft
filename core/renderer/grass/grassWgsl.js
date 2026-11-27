// Grass (GrassPass.js). One field of tufts, defined on a lattice fixed to each face of the cube the planet is made of, so
// a tuft stays where it grew as the camera moves. Each frame a compute pass walks the patches about the camera, keeps
// the lattice points where the ground the terrain draws is grass (the same landscape rules as terrainPass.wgsl.js), and
// writes each tuft's blades, seed stems and flowers; the draw builds each as a curved strip.
//
// After Ghost of Tsushima (Wohllaib, GDC 2021: Voronoi clumps for height and facing, several blades per instance where
// grass is short, blades turned to the camera when seen edge-on, rounded normals, one scrolling wind field), AMD's mesh
// shader grass (2024: length-kept Bezier, fewer and wider blades far off) and Black Ops 4 (Pesce, 2024: translucency is
// what makes grass, a height ramp is its occlusion, thin highlights, every fake fades near and far).
//
// How many: the ground stays hidden where a sight line's run through the canopy, H d / eye, times blades per m^2 times
// their width is about 2.5. So blades per m^2 fall as 1 / d, and as 1 / H: some 1500 at 2 m in grass 35 cm tall, 300 at
// 10 m, 65 at 46 m with blades widened to a pixel. About 220 thousand blades in view.
//
// Positions are worked out about the camera, never in planet coordinates: those are 131 km long and step by 1.5 cm in
// 32-bit floats, more than a blade is wide. A tuft's place is the face's anchor plus its lattice offset, and the
// difference of two directions on the sphere is computed without subtracting large numbers (placeAbout).

import { GROUND_LAYERS, GROUND_WIDE, GROUND_WIDE_LAYERS } from '../terrain/materials/groundMaterials.js';
import { GRASS_CANOPY, GROUND_LIGHT_WGSL, lattices } from '../terrain/shaders/webgpu/terrainPass.wgsl.js';
import { buildTerrainLightWGSL } from '../terrain/light/terrainLight.wgsl.js';
import { biomeCoverWGSL, unpackBiomeIceWGSL } from '../../../templates/terrain-shaders/biomeLandscape.wgsl.js';
import { GRASS_CANOPY_WGSL, GRASS_HUE_WGSL } from './grassHue.wgsl.js';
import { GRAIN_LATTICES, GRAIN_SIZE, GRAIN_WRAP_M } from './grassGrain.js';
import { GRASS_PORTRAIT_WGSL, PORTRAIT_PERIOD_M, PORTRAIT_SIZE } from './grassPortraits.js';

/** Patches per tile edge (2^6): a patch is 2 m where tiles are 128 m. Lattice points (tufts) per patch edge. */
export const PATCH_LEVELS = 6;
export const CELLS = 48;
export const MAX_FACES = 3;
export const GRID_MAX = 256;
/** Strip segments of a blade by distance band, and how many blades each band holds at most. */
export const LOD_SEGMENTS = [7, 4, 2];
/** Blades an instance draws (an index buffer of so many strips). One blade an instance left most of the GPU's vertex
 * lanes empty: the far band alone cost 1.9 ms, 0.8 ms with 16 (M1 Pro, GRASS_FINDINGS.md), and fewer rows a blade cost
 * more, not less. Band starts are multiples of it. */
export const BLADES_PER_INSTANCE = 16;
export const LOD_CAPACITY = [131072, 262144, 524288];
/** A tuft's blade as the cache keeps it (3 x vec4<u32>), and a patch's record of this frame (4 x vec4<u32>). */
export const RECORD_WORDS = 8;
export const PATCH_WORDS = 16;
/** Blades the cache holds, each of its two halves (this frame's, last frame's); entries of each half of its patch table. */
export const STORE_CAP = 1048576;
export const HASH_CAP = 8192;
/** The control words: counts (0 patches, 1-3 blades per band, 4 blades kept, 5 patches to make), then the halves' blade
 * counts (kept from frame to frame), the list of patches to make, and where last frame's patches are now. */
export const CTRL = Object.freeze({ STORE: 4, GEN: 5, COPIED: 6, WHY: 7, SPLIT: 11, PERSIST: 16, GENLIST: 32 });
/** Patches kept in a frame at most: about 15 thousand are in view at 240 m. */
export const MAX_PATCHES = 65536;
/** Tallest blade (m) and widest (m) the packed form holds. */
export const MAX_HEIGHT = 2.0;
export const MAX_WIDTH = 0.05;
export const FRAME_FLOATS = 96 + MAX_FACES * 28;
export const CONTROL_WORDS = CTRL.GENLIST + 2 * MAX_PATCHES;
export const CTRL_REMAP = CTRL.GENLIST + MAX_PATCHES;
/** Every sway's rate is a whole number of turns in this many seconds, so time can wrap at it without a jump. */
export const WAVE_PERIOD = 3600;
/** Blade kinds. */
export const KIND = Object.freeze({ MEADOW: 0, DRY: 1, WOOD: 2, TUNDRA: 3, REED: 4, SEED: 5, BLOSSOM: 6, SPIKE: 7, LEAF: 8 });

const n = x => { const s = Number(x).toPrecision(9); return /[.e]/.test(s) ? s : `${s}.0`; };
const v2 = a => `vec2<f32>(${a.map(n).join(', ')})`;
const v3 = a => `vec3<f32>(${a.map(n).join(', ')})`;
const mean = name => v3(GROUND_LAYERS.find(l => l.name === name).mean);


const FRAME_WGSL = /* wgsl */`
struct Face {
    ca: vec4<f32>,      // the anchor's point on the cube (exact in floats), its length
    du: vec4<f32>,      // how that point moves per patch along the face's x, the face
    dv: vec4<f32>,      // per patch along y, metres a patch spans on the sphere (largest side)
    da: vec4<f32>,      // the anchor's direction times the radius, less the camera (from the planet's centre), m
    na: vec4<f32>,      // the anchor's direction, patch area on the sphere (m^2)
    anchor: vec4<i32>,  // the anchor patch x, y on its face, the face, the patch grid's half width
    wind: vec4<f32>,    // how far the gusts have been carried (face metres, x and y), the wind's way on the face
};
struct Frame {
    clip: mat4x4<f32>,             // of a point about the camera
    planes: array<vec4<f32>, 5>,   // inward, about the camera
    up: vec4<f32>,                 // up at the camera, planet radius
    east: vec4<f32>,               // level directions, height scale (m)
    north: vec4<f32>,              // face size (m)
    sunDir: vec4<f32>,             // time (s, 0..${WAVE_PERIOD}: every sway repeats in that time, so it wraps unseen)
    sunColor: vec4<f32>,           // wind speed (m/s)
    ambient: vec4<f32>,            // radians per pixel
    wind: vec4<f32>,               // wind east, north, gust strength, sway
    dist: vec4<f32>,               // greatest distance, blades per m^2 close by, distance they begin to thin (1 / d), from
                                   // where they are a pixel wide and thin as 1 / d^2 (fewer, wider: the same cover)
    lod: vec4<f32>,                // band edges (m), least width in pixels, most widening
    camera: vec4<f32>,             // from the planet's centre (for the land's light), sea level (m)
    counts: vec4<u32>,             // faces, deepest tile level, hash mask, hash capacity
    visible: vec4<u32>,            // the drawn tiles' table: mask, capacity, this frame's epoch; coarsest mesh level
    cache: vec4<u32>,              // which half of the cache is this frame's (0 or 1)
    light: vec4<f32>,              // the same for every blade pixel this frame (GrassPass.js): the sky's light, the day
    bounce: vec4<f32>,             // the ground's bounce (before the depth in the canopy), the sun's depth factor in it
    faces: array<Face, ${MAX_FACES}>,
};
`;

const WAVE_WGSL = /* wgsl */`
// A sine at about this rate (rad/s), rounded to a whole number of turns per ${WAVE_PERIOD} s; its phase from the fraction of
// turns, so it stays exact however long the game runs.
fn wave(t: f32, rate: f32, phase: f32) -> f32 {
    let turns = round(rate * ${(WAVE_PERIOD / (2 * Math.PI)).toFixed(6)});
    return sin(6.2831853 * fract((t / ${WAVE_PERIOD}.0) * turns) + phase);
}
`;

const HASH_WGSL = /* wgsl */`
fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn hash3(x: u32, y: u32, z: u32) -> u32 { return pcg(x ^ pcg(y ^ pcg(z + 0x9e3779b9u))); }
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
fn step3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
`;

/** Compute: patches about the camera, then tufts in them. */
/**
 * skip: for measuring only, parts left out (tools/perf/grass/scatterParts.mjs): tuft (all after the rank test), height
 * (the finest heights, not the drawn triangles), growth (one fixed meadow), noise (value noise constant), clump,
 * drawn (patches on the finest loaded tiles).
 */
export function buildGrassComputeWGSL({ faceSizeMeters, biome, skip = {}, segments = LOD_SEGMENTS }) {
    const L = lattices(faceSizeMeters);
    const W = GROUND_WIDE_LAYERS;
    const [b0, b1, b2] = LOD_CAPACITY;
    return /* wgsl */`${FRAME_WGSL}${HASH_WGSL}${WAVE_WGSL}${GRASS_HUE_WGSL}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> hashTable: array<u32>;
@group(0) @binding(2) var<storage, read_write> patches: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
// The cache: tufts' blades as offsets from their patch, both halves (this frame's, last frame's).
@group(0) @binding(4) var<storage, read_write> store: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> args: array<u32>;
// The blades drawn this frame, by band, as the vertex shader takes them (2 x vec4<u32>: selectMain).
@group(0) @binding(7) var<storage, read_write> drawn: array<vec4<u32>>;
// The patches of this frame and of the last, by key (key, key, stamp, stamp, slot; 8 words), both halves.
@group(0) @binding(8) var<storage, read_write> patchHash: array<atomic<u32>>;
// The quadtree's tiles drawn this frame (instanceBufferBuilder.wgsl.js VisibleEntry: key, epoch, pad).
@group(0) @binding(6) var<storage, read> visibleTable: array<vec4<u32>>;
@group(1) @binding(0) var heightTexture: texture_2d_array<f32>;
@group(1) @binding(1) var tileNormals: texture_2d_array<f32>;
@group(1) @binding(2) var climateMap: texture_2d_array<f32>;
@group(1) @binding(3) var groundSurface: texture_2d_array<f32>;
@group(1) @binding(4) var wideSampler: sampler;
@group(1) @binding(5) var clampSampler: sampler;
${buildTerrainLightWGSL(1, 6, 7)}
@group(1) @binding(8) var tileBeds: texture_2d_array<f32>;
@group(1) @binding(9) var grassGrain: texture_2d<f32>;
@group(1) @binding(10) var grassPortraits: texture_2d_array<f32>;

const CELLS: u32 = ${CELLS}u;
const PATCH_LEVELS: u32 = ${PATCH_LEVELS}u;
const MAX_PATCHES: u32 = ${MAX_PATCHES}u;
const STORE_CAP: u32 = ${STORE_CAP}u;
const HASH_CAP: u32 = ${HASH_CAP}u;
const CTRL_STORE: u32 = ${CTRL.STORE}u;
const CTRL_COPIED: u32 = ${CTRL.COPIED}u;
const CTRL_WHY: u32 = ${CTRL.WHY}u;
const CTRL_SPLIT: u32 = ${CTRL.SPLIT}u;
const CTRL_GEN: u32 = ${CTRL.GEN}u;
const CTRL_PERSIST: u32 = ${CTRL.PERSIST}u;
const CTRL_GENLIST: u32 = ${CTRL.GENLIST}u;
const CTRL_REMAP: u32 = ${CTRL_REMAP}u;
const BAND0: u32 = ${b0}u;
const BAND1: u32 = ${b1}u;
const BAND2: u32 = ${b2}u;
const MAX_H: f32 = ${n(MAX_HEIGHT)};
const MAX_W: f32 = ${n(MAX_WIDTH)};
const FIELDS = ${v2(L.over(L.fields[0]))};
const FIELDS_WIDE = ${v2(L.over(L.fields[1]))};
const MOSAIC = ${v2(L.over(L.mosaic))};
const GOLDEN: f32 = 2.39996323;
${GRAIN_LATTICES.map((n, i) => `const GRAIN${i} = ${v2(n.map(x => x / GRAIN_WRAP_M))};`).join('\n')}

${GRASS_PORTRAIT_WGSL.replace(/fn portraitTap\(s: sampler, uv: vec2<f32>, layer: i32, dpx[\s\S]*?\n}\n/, '').replace(/\/\/ x: the structure[\s\S]*$/, '')}
const GRAIN0_TURN: f32 = ${n(Math.atan2(GRAIN_LATTICES[0][1], GRAIN_LATTICES[0][0]))};
// The field as the ground wears it at a place of the face (terrainPass.wgsl.js): its portrait seen from the camera
// (grassPortraits.js), and the tussocks' grain, over a footprint (m). rel: from the camera; fx, fy: the face's x and y
// on the level.
fn grainAt(q: vec2<f32>, rel: vec3<f32>, fx: vec3<f32>, fy: vec3<f32>, footprint: f32, distance: f32) -> vec3<f32> {
    let p = q - ${GRAIN_WRAP_M}.0 * floor(q / ${GRAIN_WRAP_M}.0);
    let away = rel / max(length(rel), 0.01);
    let azimuth = atan2(dot(away, fy), dot(away, fx)) - GRAIN0_TURN;
    let slant = max(-dot(away, frame.up.xyz), 0.02);
    let g0 = grassPortraitLevel(wideSampler, turnedUv(GRAIN0, p), slant, azimuth, log2(max(footprint / ${n(PORTRAIT_PERIOD_M / PORTRAIT_SIZE)}, 1.0))).rgb;
    let g1 = textureSampleLevel(grassGrain, wideSampler, turnedUv(GRAIN1, p), log2(max(footprint / ${n(GRAIN_WRAP_M / Math.hypot(...GRAIN_LATTICES[1]) / GRAIN_SIZE)}, 1.0))).rgb;
    let keep = 1.0 + 1.4 * smoothstep(40.0, 220.0, distance);
    return max(vec3<f32>(1.0) + keep * (g0 * mix(vec3<f32>(1.0), g1, 0.75) - 1.0), vec3<f32>(0.15));
}
${biome ? biomeCoverWGSL(biome) : ''}

// ---- the loaded tiles (residentTileHeightLookupWgsl.js)
fn hashKey(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    return ((kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u)) & frame.counts.z;
}
// A loaded tile's layer, with 4096 added when its material (the beds) is made; -1 when not loaded.
fn lookupLayer(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = (x & 0xFFFFu) | ((y & 0xFFFFu) << 16u);
    let keyHi = (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u);
    var idx = hashKey(keyLo, keyHi);
    for (var i = 0u; i < min(frame.counts.w, 256u); i++) {
        let base = idx * 4u;
        let hi = hashTable[base + 1u];
        if (hi == 0xFFFFFFFFu) { return -1; }
        if (hi == keyHi && hashTable[base] == keyLo) {
            let made = hashTable[base + 3u] != 0xFFFFFFFFu && (hashTable[base + 3u] & 1u) != 0u;
            return i32(hashTable[base + 2u] & 4095u) + select(0, 4096, made);
        }
        idx = (idx + 1u) & frame.counts.z;
    }
    return -1;
}
// The finest loaded tile over a patch: its layer (4096 more with beds), and patches per tile edge as a shift. -1: none.
fn tileOver(face: u32, p: vec2<u32>) -> vec2<i32> {
    for (var k = 0u; k < 4u; k++) {
        let depth = frame.counts.y - k;
        let shift = PATCH_LEVELS + k;
        let layer = lookupLayer(face, depth, p.x >> shift, p.y >> shift);
        if (layer >= 0) { return vec2<i32>(layer, i32(shift)); }
    }
    return vec2<i32>(-1, 0);
}
// Where in its tile a point of a patch lies (0..1).
fn inTile(p: vec2<u32>, shift: u32, f: vec2<f32>) -> vec2<f32> {
    return (vec2<f32>(p & vec2<u32>((1u << shift) - 1u)) + f) / f32(1u << shift);
}

// ---- the ground as the terrain draws it. Blades stand on the drawn triangles, not on the finest heights loaded: the
// terrain picks coarser meshes for high ground near the camera (2-16 m fans), and finer heights there leave blades
// under or over the surface by up to metres.
fn visibleAt(face: u32, depth: u32, x: u32, y: u32) -> bool {
    let keyLo = (x & 0xFFFFu) | ((y & 0xFFFFu) << 16u);
    let keyHi = (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u);
    let start = hashKeyVisible(keyLo, keyHi);
    for (var i = 0u; i < min(frame.visible.y, 128u); i++) {
        let e = visibleTable[(start + i) & frame.visible.x];
        if (e.y == 0xFFFFFFFFu) { return false; }
        if (e.y == keyHi && e.x == keyLo && e.z == frame.visible.z) { return true; }
    }
    return false;
}
fn hashKeyVisible(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    return ((kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u)) & frame.visible.x;
}
// The drawn tile over a patch: x its geometry's layer (4096 more when its material is made), y patches per drawn tile
// edge as a shift, z ancestor levels up to the geometry's layer, w the mesh's level. x -1: none drawn or loaded.
fn drawnOver(face: u32, p: vec2<u32>) -> vec4<i32> {
    let deepest = frame.counts.y;
    var depth = deepest + 1u;
    for (var k = 0u; k <= 7u && k <= deepest; k++) {
        let d = deepest - k;
        let t = p >> vec2<u32>(PATCH_LEVELS + k);
        if (visibleAt(face, d, t.x, t.y)) { depth = d; break; }
    }
    if (depth > deepest) {
        // Not among the drawn tiles (beside the view): the finest loaded heights.
        let loaded = tileOver(face, p);
        return vec4<i32>(loaded.x, loaded.y, 0, 0);
    }
    let shift = PATCH_LEVELS + deepest - depth;
    // Geometry: the nearest loaded layer, own then ancestors (instanceBufferBuilder.wgsl.js).
    for (var up = 0u; up < 5u && up <= depth; up++) {
        let t = p >> vec2<u32>(shift + up);
        let layer = lookupLayer(face, depth - up, t.x, t.y);
        if (layer >= 0) { return vec4<i32>(layer, i32(shift), i32(up), i32(min(deepest - depth, frame.visible.w))); }
    }
    return vec4<i32>(-1, 0, 0, 0);
}
// A texel row of the 129 x 129 vertex grid of a drawn tile, as terrainChunkVertexShaderBuilder.js sampleHeightChunkLocal
// takes it from its layer: own tile (up 0), or the part of an ancestor's.
fn vertexHeight(layer: i32, up: u32, part: vec2<f32>, v: vec2<f32>) -> f32 {
    let size = vec2<f32>(textureDimensions(heightTexture));
    let scale = 1.0 / f32(1u << up);
    let chunkSize = max(vec2<i32>(floor(size * scale + 0.5)), vec2<i32>(1));
    let maxLocal = max(chunkSize - 1, vec2<i32>(1));
    let base = vec2<i32>(floor(part * size + 0.5));
    let coord = vec2<f32>(base) + clamp(v / 128.0, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(maxLocal);
    let c0 = floor(coord);
    let f = coord - c0;
    let lo = base;
    let hi = min(base + maxLocal, vec2<i32>(size) - 1);
    let a = clamp(vec2<i32>(c0), lo, hi);
    let b = clamp(vec2<i32>(c0) + 1, lo, hi);
    let h0 = mix(textureLoad(heightTexture, a, layer, 0).r, textureLoad(heightTexture, vec2<i32>(b.x, a.y), layer, 0).r, f.x);
    let h1 = mix(textureLoad(heightTexture, vec2<i32>(a.x, b.y), layer, 0).r, textureLoad(heightTexture, b, layer, 0).r, f.x);
    return mix(h0, h1, f.y) * frame.east.w;
}
// The adaptive cell of a drawn tile's mesh over grid point g (terrainGeometryBuilder.js _buildAdaptiveCells): x, z, size.
fn meshCell(g: vec2<f32>, maxStep: i32) -> vec3<i32> {
    var c = vec3<i32>(0, 0, 128);
    for (var i = 0; i < 8; i++) {
        let inset = min(min(c.x, c.y), min(128 - (c.x + c.z), 128 - (c.y + c.z)));
        if (c.z <= 1 || (c.z <= maxStep && inset >= c.z)) { break; }
        let half = c.z >> 1u;
        c = vec3<i32>(c.x + select(0, half, g.x >= f32(c.x + half)), c.y + select(0, half, g.y >= f32(c.y + half)), half);
    }
    return c;
}
// Height of the drawn surface at a point of a drawn tile (0..1): the triangle of its mesh that holds it.
fn drawnHeight(layer: i32, up: u32, part: vec2<f32>, lod: u32, local: vec2<f32>) -> f32 {
    let g = clamp(local, vec2<f32>(0.0), vec2<f32>(0.99999)) * 128.0;
    let maxStep = min(1 << lod, 128);
    let cell = meshCell(g, maxStep);
    let c0 = vec2<f32>(cell.xy);
    let size = f32(cell.z);
    if (cell.z <= 1) {
        // Two triangles split from (x1, z0) to (x0, z1).
        let f = g - c0;
        if (f.x + f.y < 1.0) {
            let h00 = vertexHeight(layer, up, part, c0);
            return h00 + f.x * (vertexHeight(layer, up, part, c0 + vec2<f32>(1.0, 0.0)) - h00) + f.y * (vertexHeight(layer, up, part, c0 + vec2<f32>(0.0, 1.0)) - h00);
        }
        let h11 = vertexHeight(layer, up, part, c0 + 1.0);
        return h11 + (1.0 - f.x) * (vertexHeight(layer, up, part, c0 + vec2<f32>(0.0, 1.0)) - h11) + (1.0 - f.y) * (vertexHeight(layer, up, part, c0 + vec2<f32>(1.0, 0.0)) - h11);
    }
    // A fan about the cell's middle; its rim has a vertex wherever the neighbour beyond an edge is a smaller cell.
    let centre = c0 + 0.5 * size;
    let d = g - centre;
    var a = vec2<f32>(0.0);
    var b = vec2<f32>(0.0);
    if (abs(d.x) >= abs(d.y)) {
        let x = select(c0.x, c0.x + size, d.x > 0.0);
        let z = centre.y + d.y * (0.5 * size / max(abs(d.x), 1.0e-6));
        var lo = c0.y;
        var hi = c0.y + size;
        let outside = x + select(-0.5, 0.5, d.x > 0.0);
        if (outside > 0.0 && outside < 128.0) {
            let n = meshCell(vec2<f32>(outside, clamp(z, c0.y, c0.y + size - 0.001)), maxStep);
            lo = max(lo, f32(n.y));
            hi = min(hi, f32(n.y + n.z));
        }
        a = vec2<f32>(x, lo);
        b = vec2<f32>(x, hi);
    } else {
        let z = select(c0.y, c0.y + size, d.y > 0.0);
        let x = centre.x + d.x * (0.5 * size / max(abs(d.y), 1.0e-6));
        var lo = c0.x;
        var hi = c0.x + size;
        let outside = z + select(-0.5, 0.5, d.y > 0.0);
        if (outside > 0.0 && outside < 128.0) {
            let n = meshCell(vec2<f32>(clamp(x, c0.x, c0.x + size - 0.001), outside), maxStep);
            lo = max(lo, f32(n.x));
            hi = min(hi, f32(n.x + n.z));
        }
        a = vec2<f32>(lo, z);
        b = vec2<f32>(hi, z);
    }
    // Barycentric about the triangle centre, a, b.
    let e1 = a - centre;
    let e2 = b - centre;
    let det = e1.x * e2.y - e1.y * e2.x;
    let wa = (d.x * e2.y - d.y * e2.x) / det;
    let wb = (e1.x * d.y - e1.y * d.x) / det;
    let hc = vertexHeight(layer, up, part, centre);
    return hc + wa * (vertexHeight(layer, up, part, a) - hc) + wb * (vertexHeight(layer, up, part, b) - hc);
}
// Ground height (m), between texels, as the terrain's vertices take it.
fn heightAt(layer: i32, local: vec2<f32>) -> f32 {
    let last = vec2<i32>(textureDimensions(heightTexture)) - 1;
    let at = clamp(local, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(last);
    let i = min(vec2<i32>(floor(at)), last);
    let j = min(i + 1, last);
    let f = at - vec2<f32>(i);
    let h0 = mix(textureLoad(heightTexture, i, layer, 0).r, textureLoad(heightTexture, vec2<i32>(j.x, i.y), layer, 0).r, f.x);
    let h1 = mix(textureLoad(heightTexture, vec2<i32>(i.x, j.y), layer, 0).r, textureLoad(heightTexture, j, layer, 0).r, f.x);
    return mix(h0, h1, f.y) * frame.east.w;
}
// The texel centres of a tile's edges lie on its edges.
fn texelUv(local: vec2<f32>) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(tileNormals));
    return (clamp(local, vec2<f32>(0.0), vec2<f32>(1.0)) * (size - 1.0) + 0.5) / size;
}

// A point of the face, d patches from the anchor, at height h: from the camera, and its direction from the planet's centre.
// n1 - na = dc / |c1| + ca (1 / |c1| - 1 / |ca|), with the last bracket as a quotient of small numbers.
struct Place { rel: vec3<f32>, up: vec3<f32> };
fn placeAbout(F: Face, d: vec2<f32>, h: f32) -> Place {
    let dc = F.du.xyz * d.x + F.dv.xyz * d.y;
    let la = F.ca.w;
    let grow = 2.0 * dot(F.ca.xyz, dc) + dot(dc, dc);
    let l1 = sqrt(la * la + grow);
    let dn = dc / l1 - F.ca.xyz * (grow / ((la + l1) * l1 * la));
    let up = F.na.xyz + dn;
    return Place(frame.up.w * dn + F.da.xyz + h * up, up);
}

fn turnedUv(m: vec2<f32>, p: vec2<f32>) -> vec2<f32> { return vec2<f32>(dot(m, p), m.x * p.y - m.y * p.x); }
fn lieOf(uv: vec2<f32>, variants: f32) -> vec2<f32> {
    var p = fract(floor(uv).xyx * 0.1031);
    p += dot(p, p.yzx + 33.33);
    let k = fract((p.x + p.y) * p.z) * variants;
    return vec2<f32>(floor(k), select(-1.0, 1.0, fract(k) < 0.5));
}

// Value noise: the wind's gusts, flower patches.
fn vnoise(p: vec2<f32>, seed: u32) -> f32 {
    ${skip.noise ? 'return 0.5;' : ''}
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let k = vec2<u32>(vec2<i32>(i) + vec2<i32>(1 << 20));
    let a = u01(hash3(k.x, k.y, seed));
    let b = u01(hash3(k.x + 1u, k.y, seed));
    let c = u01(hash3(k.x, k.y + 1u, seed));
    let e = u01(hash3(k.x + 1u, k.y + 1u, seed));
    return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}

// What the ground is at a place, as the terrain draws it, reduced to what grows there.
struct Growth {
    grass: f32, dry: f32, forest: f32, tundra: f32, marsh: f32, sparse: f32,
    lush: f32, lively: f32, tall: f32, temp: f32, wet: f32, slope: f32, dryness: f32,
    tone: vec3<f32>,
};
fn growthAt(layer: i32, local: vec2<f32>, q: vec2<f32>, elevation: f32) -> Growth {
    var g: Growth;
    let uv = texelUv(local);
    let up = frame.up.xyz;
    let e = textureSampleLevel(tileNormals, clampSampler, uv, layer, 0.0).rg * 2.0 - 1.0;
    var tx = vec3<f32>(-up.z, 0.0, up.x);
    if (abs(up.y) > 0.99) { tx = vec3<f32>(0.0, up.z, -up.y); }
    tx = normalize(tx);
    let tileNormal = normalize(e.x * tx + e.y * cross(up, tx) + (1.0 - abs(e.x) - abs(e.y)) * up);
    let level = saturate(dot(tileNormal, up));
    let slope = 1.0 - level;
    g.slope = slope;
    let fa = textureSampleLevel(groundSurface, wideSampler, turnedUv(FIELDS, q), ${W.fields}, 0.0);
    let fb = textureSampleLevel(groundSurface, wideSampler, turnedUv(FIELDS_WIDE, q), ${W.fields}, 0.0);
    let b = saturate(fa + 0.7 * (fb - 0.5));
    let wideBend = (fb.xw - 0.5) * 160.0;
    let at = turnedUv(MOSAIC, q + wideBend);
    let lie = lieOf(at, ${GROUND_WIDE[0].variants}.0);
    let a = textureSampleLevel(groundSurface, wideSampler, at * lie.y, ${W.masks} + i32(lie.x), 0.0);
    let edge = 0.6 * (a.x - 0.5) + 0.5 * (b.y - 0.5) + 0.35 * (a.y - 0.5);
    g.lush = b.x;
    g.lively = 0.6 * b.z + 0.4 * a.z;
    // Patches of taller growth a field wide, where the ground is lush.
    g.tall = step3(0.50, 0.76, 0.55 * a.x + 0.45 * b.x);
    // The terrain's broad colour (terrainPass.wgsl.js tone).
    g.tone = (1.0 + 0.34 * (b.x - 0.5) + 0.40 * (a.x - 0.5) + 0.22 * (b.w - 0.5)) * vec3<f32>(1.0 + 0.16 * (b.w - 0.5), 1.0, 1.0 - 0.18 * (b.w - 0.5));
    ${biome ? `
    let climate = textureSampleLevel(climateMap, clampSampler, uv, layer, 0.0);
    g.temp = climate.r;
    g.wet = climate.g;
    let ice = ${unpackBiomeIceWGSL};
    let cover = biomeCover(climate.r, climate.g, sqrt(max(1.0 - level * level, 0.0)), elevation, edge);
    let dryGrass = step3(0.38, 0.73, a.w * 0.45 + b.w * 0.55 + 0.35 * slope + (0.55 - climate.g) * 0.95);
    g.dryness = dryGrass;
    let litter = mix(0.78, 1.0, step3(0.3, 0.7, a.x * 0.5 + b.x * 0.5));
    let shortGrass = cover.grass + cover.forest * (1.0 - litter);
    let bare = 0.42 * step3(0.64, 0.85, 0.6 * a.y + 0.4 * b.y + slope);
    let gravel = step3(0.075, 0.25, slope) * step3(0.36, 0.72, 0.6 * a.z + 0.4 * b.y);
    let peat = 0.75 * step3(0.39, 0.69, 0.64 * a.y + 0.36 * b.x);
    let open = 1.0 - ice;
    let turf = shortGrass * (1.0 - bare) * (1.0 - gravel) * open;
    g.grass = turf * (1.0 - dryGrass);
    g.dry = turf * dryGrass;
    g.forest = cover.forest * litter * open;
    g.tundra = cover.tundra * open;
    g.marsh = cover.marsh * (1.0 - peat) * open;
    g.sparse = shortGrass * (bare + 0.35 * gravel) * open;` : `
    // No landscape rules: grass where the ground is not steep, drier where the fields say so.
    g.temp = 0.55;
    g.wet = 0.5;
    let turf = 1.0 - step3(0.15, 0.31, slope + 0.16 * edge);
    let dry = step3(0.39, 0.75, a.w * 0.45 + b.w * 0.55 + 0.35 * slope);
    g.dryness = dry;
    g.grass = turf * (1.0 - dry);
    g.dry = turf * dry;`}
    return g;
}

// The patch grid of each face: patches near enough and in view, with their tile.
@compute @workgroup_size(64)
fn patchesMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let slot = id.z;
    if (slot >= frame.counts.x) { return; }
    let F = frame.faces[slot];
    let half = F.anchor.w;
    let side = 2 * half;
    if (id.x >= u32(side * side)) { return; }
    let d = vec2<i32>(i32(id.x) % side, i32(id.x) / side) - half;
    let P = F.anchor.xy + d;
    let edge = 1 << (frame.counts.y + PATCH_LEVELS);
    if (any(P < vec2<i32>(0)) || any(P >= vec2<i32>(edge))) { return; }
    // Far off one workgroup takes a block of 2 x 2 or 4 x 4 patches, aligned on the face (the same blocks however the
    // camera moves, and the same lattice points in them): enough tufts to fill its threads. Every patch of a block
    // decides alike, by the level distance to the block's middle; only the block's first patch goes on.
    var span = 1;
    for (var s = 4; s >= 2; s /= 2) {
        let B = P & vec2<i32>(~(s - 1));
        let mid = placeAbout(F, vec2<f32>(B - F.anchor.xy) + 0.5 * f32(s), 0.0).rel;
        let flat = length(mid - frame.up.xyz * dot(mid, frame.up.xyz));
        if (flat > frame.dist.x * select(0.17, 0.38, s == 4)) { span = s; break; }
    }
    if (any((P & vec2<i32>(span - 1)) != vec2<i32>(0))) { return; }
    let sf = f32(span);
    let reach = F.dv.w * 0.75 * sf;
    let sea = placeAbout(F, vec2<f32>(d) + 0.5 * sf, 0.0);
    // Level distance first: nothing to read for most of the grid.
    let level = sea.rel - frame.up.xyz * dot(sea.rel, frame.up.xyz);
    if (length(level) - reach > frame.dist.x) { return; }
    let face = u32(F.anchor.z);
    let p = vec2<u32>(P);
    let tile = ${skip.drawn ? 'vec4<i32>(tileOver(face, p), 0, 0)' : 'drawnOver(face, p)'};
    if (tile.x < 0) { return; }
    let up = u32(tile.z);
    let part = vec2<f32>((p >> vec2<u32>(u32(tile.y))) & vec2<u32>((1u << up) - 1u)) / f32(1u << up);
    let h = drawnHeight(tile.x & 4095, up, part, u32(tile.w), inTile(p, u32(tile.y), vec2<f32>(0.5 * sf)));
    if (h < frame.camera.w) { return; }
    let rel = sea.rel + h * sea.up;
    let distance = length(rel);
    if (distance - reach > frame.dist.x) { return; }
    // Kept: in view or near it (about 10 degrees around), so that turning does not make everything anew. What is drawn
    // of it is decided blade by blade (selectMain).
    let centre = rel + frame.up.xyz * 0.7;
    let radius = reach + 2.4 + 0.18 * distance;
    for (var k = 0; k < 5; k++) {
        if (dot(frame.planes[k].xyz, centre) + frame.planes[k].w < -radius) { return; }
    }
    let slotOut = atomicAdd(&control[0], 1u);
    if (slotOut >= MAX_PATCHES) { return; }
    let land = landLightAt(frame.camera.xyz + rel, clampSampler);
    let packedD = u32(d.x + 32768) | (u32(d.y + 32768) << 16u);
    let headY = slot | (u32(tile.y) << 4u) | (up << 8u) | (u32(tile.w) << 12u) | (u32(span) << 16u);
    let nearest = max(distance - reach, 0.0);
    // Distance in steps of 15 %: a patch's tufts are made again when it moves to another step.
    let bucket = u32(clamp(floor(log(max(nearest, 2.0)) / log(1.15)), 0.0, 63.0));
    patches[slotOut * 4u] = vec4<u32>(packedD, headY, u32(tile.x), bitcast<u32>(nearest));
    patches[slotOut * 4u + 1u] = vec4<u32>(bitcast<u32>(F.na.w / f32(CELLS * CELLS)), pack2x16unorm(land), bucket, 0u);
    // The block's corner at the drawn height of its middle, from the camera: its tufts are kept as offsets from it, small
    // enough for half floats (selectMain). The height is the drawn mesh's, which the patch's stamp holds alike.
    // In view this frame: a ball about every blade's middle with selectMain's margin (relief across the block at most
    // its reach). Out of it, its blades' records are not read further.
    var seen = 1u;
    for (var k = 0; k < 5 && frame.cache.z == 0u; k++) {
        if (dot(frame.planes[k].xyz, rel) + frame.planes[k].w < -(2.0 * reach + 0.5 * MAX_H + 1.6)) { seen = 0u; }
    }
    patches[slotOut * 4u + 2u] = vec4<u32>(bitcast<vec3<u32>>(placeAbout(F, vec2<f32>(d), h).rel), seen);
    // The wind's gusts at the block's corners, this frame (carried with the wind: GrassPass.js).
    let metres = frame.north.w / f32(1u << (frame.counts.y + PATCH_LEVELS));
    var g = vec4<f32>(0.0);
    for (var c = 0u; c < 4u; c++) {
        let carried = (vec2<f32>(P) + vec2<f32>(f32(c & 1u), f32(c >> 1u)) * sf) * metres - F.wind.xy;
        g[c] = vnoise(carried / 22.0, 7u) * 0.75 + vnoise(carried / 7.5 + 13.1, 11u) * 0.25;
    }
    patches[slotOut * 4u + 3u] = vec4<u32>(pack2x16float(g.xy), pack2x16float(g.zw), 0u, 0u);
    // Its entry in this frame's table. If last frame had it alike (the same tile, mesh and distance step), its tufts are
    // carried over (copyMain); else they are made (generateMain).
    let key0 = ((u32(P.x) & 0x1FFFFu) | (face << 17u) | (u32(span) << 20u)) + 1u;
    let key1 = u32(P.y);
    let stamp0 = (headY & ~15u) | (bucket << 24u);
    let stamp1 = u32(tile.x);
    patches[slotOut * 4u + 1u].w = insertPatch(key0, key1, stamp0, stamp1, slotOut);
    let before = findPrevious(key0, key1);
    if (before >= 0 && atomicLoad(&patchHash[u32(before) + 2u]) == stamp0 && atomicLoad(&patchHash[u32(before) + 3u]) == stamp1) {
        atomicStore(&control[CTRL_REMAP + atomicLoad(&patchHash[u32(before) + 4u])], slotOut + 1u);
    } else {
        let at = atomicAdd(&control[CTRL_GEN], 1u);
        if (at < MAX_PATCHES) { atomicStore(&control[CTRL_GENLIST + at], slotOut); }
        // Why (counts(), for measuring): new here, its distance step nearer or farther, or the ground under it changed.
        var why = 0u;
        if (before >= 0) {
            let was = atomicLoad(&patchHash[u32(before) + 2u]);
            why = 3u;
            if ((was & 0x00FFFFFFu) == (stamp0 & 0x00FFFFFFu) && atomicLoad(&patchHash[u32(before) + 3u]) == stamp1) {
                why = select(2u, 1u, (was >> 24u) > bucket);
            }
        }
        atomicAdd(&control[CTRL_WHY + why], 1u);
    }
}

fn patchHashIndex(key0: u32, key1: u32) -> u32 {
    return ((key0 * 0x9E3779B1u) ^ (key1 * 0x85EBCA77u) ^ (key0 >> 15u)) & (HASH_CAP - 1u);
}
// The entry's first word, or NO_ENTRY when the table is full.
const NO_ENTRY: u32 = 0xFFFFFFFFu;
fn insertPatch(key0: u32, key1: u32, stamp0: u32, stamp1: u32, slot: u32) -> u32 {
    let base = frame.cache.x * HASH_CAP;
    var i = patchHashIndex(key0, key1);
    for (var n = 0u; n < HASH_CAP; n++) {
        let at = (base + i) * 8u;
        let r = atomicCompareExchangeWeak(&patchHash[at], 0u, key0);
        if (r.exchanged) {
            atomicStore(&patchHash[at + 1u], key1);
            atomicStore(&patchHash[at + 2u], stamp0);
            atomicStore(&patchHash[at + 3u], stamp1);
            atomicStore(&patchHash[at + 4u], slot);
            return at;
        }
        // A weak exchange may fail for no reason: the same entry again.
        if (r.old_value != 0u) { i = (i + 1u) & (HASH_CAP - 1u); }
    }
    return NO_ENTRY;
}
// A patch whose blades did not all fit in the store this frame: next frame it is made again, not carried over with
// the hole (a stamp no patch has).
fn incomplete(slot: u32) {
    let entry = patches[slot * 4u + 1u].w;
    if (entry != NO_ENTRY) { atomicStore(&patchHash[entry + 2u], NO_ENTRY); }
}
// Last frame's entry of a patch (its first word), or -1.
fn findPrevious(key0: u32, key1: u32) -> i32 {
    let base = (1u - frame.cache.x) * HASH_CAP;
    var i = patchHashIndex(key0, key1);
    for (var n = 0u; n < 64u; n++) {
        let at = (base + i) * 8u;
        let k0 = atomicLoad(&patchHash[at]);
        if (k0 == 0u) { return -1; }
        if (k0 == key0 && atomicLoad(&patchHash[at + 1u]) == key1) { return i32(at); }
        i = (i + 1u) & (HASH_CAP - 1u);
    }
    return -1;
}

@compute @workgroup_size(1)
fn dispatchMain() {
    let previous = min(atomicLoad(&control[CTRL_PERSIST + 1u - frame.cache.x]), STORE_CAP);
    args[0] = (previous + 255u) / 256u;
    args[1] = 1u;
    args[2] = 1u;
    // The patches to make, each over several workgroups when they are few: walking makes about 15 a frame, and as many
    // workgroups, each a long loop over its lattice, left the GPU nearly idle while the frame waited (1 ms for 2 % of
    // the tufts). Workgroups across a patch's lattice (x), patches (y: at most 65535 a dimension).
    let made = min(atomicLoad(&control[CTRL_GEN]), 65535u);
    let split = select(clamp(256u / max(made, 1u), 1u, 16u), frame.cache.y, frame.cache.y != 0u);
    atomicStore(&control[CTRL_SPLIT], split);
    args[3] = split;
    args[4] = made;
    args[5] = 1u;
}

// A kept blade this frame (copyMain for those carried over, selectMain for those just made): near enough, dense enough
// at its distance, in view; what it is this frame, once per blade (its vertices only build it): grown in by its rank,
// bent by the gusts at its patch's corners (carried with the wind), its tuft's sway and the comb, its colour toward the
// ground's far off. Band 3: not drawn.
struct Chosen { band: u32, out0: vec4<u32>, out1: vec4<u32> };
fn chooseBlade(r0: vec4<u32>, r1: vec4<u32>, owner: u32) -> Chosen {
    var chosen = Chosen(3u, vec4<u32>(0u), vec4<u32>(0u));
    let offset = vec3<f32>(unpack2x16float(r0.x), unpack2x16float(r0.y).x);
    let rel = bitcast<vec3<f32>>(patches[owner * 4u + 2u].xyz) + offset;
    let distance = length(rel);
    let shape = unpack4x8unorm(r0.z);
    let tall = shape.y * MAX_H;
    let rs = unpack2x16float(r1.z);
    var keep = distance <= frame.dist.x && rs.x < densityAt(distance) * rs.y;
    // Seed heads and flowers end where they would be under a pixel.
    let place = unpack4x8unorm(r1.w);
    let v = place.w;
    let look = unpack4x8unorm(r0.w);
    let kindFlags = u32(look.w * 255.0 + 0.5);
    let kind = kindFlags & 15u;
    let rule = (kindFlags >> 5u) & 3u;
    if (rule == 1u) { keep = keep && v < 1.0 - step3(frame.dist.x * 0.08, frame.dist.x * 0.16, distance); }
    if (rule == 2u) { keep = keep && v < 1.0 - step3(frame.dist.x * 0.12, frame.dist.x * 0.3, distance); }
    let middle = rel + frame.up.xyz * (tall * 0.5);
    for (var p = 0; p < 5; p++) {
        if (dot(frame.planes[p].xyz, middle) + frame.planes[p].w < -(tall * 0.7 + 0.15)) { keep = false; }
    }
    if (keep) {
        chosen.band = select(select(2u, 1u, distance < frame.lod.y), 0u, distance < frame.lod.x);
        // What the blade is this frame, once per blade (its vertices only build it): grown in by its rank, bent by
        // the gusts at its owner's corners (carried with the wind), its tuft's sway and the comb, its colour toward
        // the ground's far off.
        let near = unpack4x8unorm(r1.x);
        let farC = unpack4x8unorm(r1.y);
        let head = patches[owner * 4u];
        let gusts = patches[owner * 4u + 3u];
        let tufts = densityAt(distance) * rs.y;
        let fadeIn = saturate((tufts - rs.x) / max(0.3 * tufts, 1.0e-6));
        // Where in its block the blade stands: its offset along the face's metres per owner (placeAbout), over the
        // block's patches.
        let F = frame.faces[head.y & 15u];
        let toMetres = frame.up.w / F.ca.w;
        let jx = toMetres * (F.du.xyz - F.na.xyz * dot(F.na.xyz, F.du.xyz));
        let jy = toMetres * (F.dv.xyz - F.na.xyz * dot(F.na.xyz, F.dv.xyz));
        let fc = saturate(vec2<f32>(dot(offset, jx) / dot(jx, jx), dot(offset, jy) / dot(jy, jy)) / f32((head.y >> 16u) & 7u));
        let g01 = unpack2x16float(gusts.x);
        let g23 = unpack2x16float(gusts.y);
        let gust = mix(mix(g01.x, g01.y, fc.x), mix(g23.x, g23.y, fc.x), fc.y);
        let push = frame.wind.z * (0.45 + 0.55 * gust);
        let sway = frame.wind.w * wave(frame.sunDir.w, mix(3.2, 5.0, shape.z), shape.w * 6.2831853) * (0.6 + 0.6 * gust)
            * (1.0 - 0.8 * step3(10.0, 35.0, distance));
        let combTurn = (place.x - 0.5) * 2.2;
        let prevailing = frame.wind.xy * cos(combTurn) + vec2<f32>(-frame.wind.y, frame.wind.x) * sin(combTurn);
        let bend = frame.wind.xy * push + vec2<f32>(-frame.wind.y, frame.wind.x) * sway + prevailing * (0.12 + 0.35 * place.y);
        let farness = select(0.0, step3(frame.dist.x * 0.3, frame.dist.x * 0.85, distance), kind <= 2u || kind == ${KIND.LEAF}u);
        chosen.out0 = vec4<u32>(bitcast<vec3<u32>>(rel), pack2x16unorm(vec2<f32>(shape.x, shape.y * fadeIn)));
        chosen.out1 = vec4<u32>(pack2x16float(bend), pack4x8unorm(vec4<f32>(look.x * mix(0.5, 1.0, fadeIn), look.yz, f32(kind) / 255.0)),
            pack4x8unorm(vec4<f32>(mix(near.rgb, farC.rgb, farness), near.a)),
            pack4x8unorm(vec4<f32>(unpack2x16unorm(patches[owner * 4u + 1u].y), place.z, farC.a)));
    }
    return chosen;
}
// The chosen blades, by band: a workgroup's count per band is added once (bandBase), each blade written at its place.
var<workgroup> bandCount: array<atomic<u32>, 3>;
var<workgroup> bandBase: array<u32, 3>;
fn writeChosen(chosen: Chosen, local: u32) {
    if (chosen.band < 3u) {
        var cap = BAND2;
        var start = BAND0 + BAND1;
        if (chosen.band == 0u) { cap = BAND0; start = 0u; } else if (chosen.band == 1u) { cap = BAND1; start = BAND0; }
        let at = bandBase[chosen.band] + local;
        if (at < cap) {
            drawn[(start + at) * 2u] = chosen.out0;
            drawn[(start + at) * 2u + 1u] = chosen.out1;
        }
    }
}

// Last frame's blades whose patch is kept alike, into this frame's half (with the patch's slot of this frame). Each is
// chosen for drawing here, while it is in hand: the select then reads only the blades just made.
var<workgroup> groupCount: atomic<u32>;
var<workgroup> groupBase: u32;
@compute @workgroup_size(256)
fn copyMain(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) thread: u32) {
    if (thread == 0u) { atomicStore(&groupCount, 0u); }
    if (thread < 3u) { atomicStore(&bandCount[thread], 0u); }
    workgroupBarrier();
    let previous = min(atomicLoad(&control[CTRL_PERSIST + 1u - frame.cache.x]), STORE_CAP);
    var r0 = vec4<u32>(0u);
    var r1 = vec4<u32>(0u);
    var slot = 0u;
    var local = 0xFFFFFFFFu;
    var chosen = Chosen(3u, vec4<u32>(0u), vec4<u32>(0u));
    var drawnAt = 0u;
    if (id.x < previous) {
        let source = ((1u - frame.cache.x) * STORE_CAP + id.x) * 2u;
        r0 = store[source];
        let now = atomicLoad(&control[CTRL_REMAP + (r0.y >> 16u)]);
        if (now != 0u) {
            slot = now - 1u;
            local = atomicAdd(&groupCount, 1u);
            r1 = store[source + 1u];
            // Of a patch out of view: kept, not drawn (patchesMain).
            if (patches[slot * 4u + 2u].w != 0u) { chosen = chooseBlade(r0, r1, slot); }
            if (chosen.band < 3u) { drawnAt = atomicAdd(&bandCount[chosen.band], 1u); }
        }
    }
    workgroupBarrier();
    if (thread == 0u) {
        groupBase = atomicAdd(&control[CTRL_STORE], atomicLoad(&groupCount));
        atomicAdd(&control[CTRL_COPIED], atomicLoad(&groupCount));
    }
    if (thread < 3u) { bandBase[thread] = atomicAdd(&control[1u + thread], atomicLoad(&bandCount[thread])); }
    workgroupBarrier();
    let at = groupBase + local;
    if (local != 0xFFFFFFFFu) {
        if (at < STORE_CAP) {
            let to = (frame.cache.x * STORE_CAP + at) * 2u;
            store[to] = vec4<u32>(r0.x, (r0.y & 0xFFFFu) | (slot << 16u), r0.zw);
            store[to + 1u] = r1;
        } else {
            incomplete(slot);
        }
    }
    writeChosen(chosen, drawnAt);
}

@compute @workgroup_size(1)
fn selectDispatchMain() {
    let first = min(atomicLoad(&control[CTRL_COPIED]), STORE_CAP);
    args[6] = (min(atomicLoad(&control[CTRL_STORE]), STORE_CAP) - first + 255u) / 256u;
    args[7] = 1u;
    args[8] = 1u;
}

// The blades just made (generateMain), after those copied: chosen as copyMain chooses the rest.
@compute @workgroup_size(256)
fn selectMain(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) thread: u32) {
    if (thread < 3u) { atomicStore(&bandCount[thread], 0u); }
    workgroupBarrier();
    let first = min(atomicLoad(&control[CTRL_COPIED]), STORE_CAP);
    let count = min(atomicLoad(&control[CTRL_STORE]), STORE_CAP);
    let i = first + id.x;
    var chosen = Chosen(3u, vec4<u32>(0u), vec4<u32>(0u));
    var local = 0u;
    if (i < count) {
        let index = frame.cache.x * STORE_CAP + i;
        let r0 = store[index * 2u];
        let owner = r0.y >> 16u;
        if (patches[owner * 4u + 2u].w != 0u) { chosen = chooseBlade(r0, store[index * 2u + 1u], owner); }
        if (chosen.band < 3u) { local = atomicAdd(&bandCount[chosen.band], 1u); }
    }
    workgroupBarrier();
    if (thread < 3u) { bandBase[thread] = atomicAdd(&control[1u + thread], atomicLoad(&bandCount[thread])); }
    workgroupBarrier();
    writeChosen(chosen, local);
}

// Blades per square metre at a distance, for grass 35 cm tall. Close by the ground hides behind a sight line's run
// through the canopy, which grows with d: 1 / d. Past frame.dist.w blades are widened to a pixel, which also grows with
// d: 1 / d^2. Either way the same share of each pixel is grass.
fn densityAt(d: f32) -> f32 {
    let x = max(d, 0.01);
    return frame.dist.y * min(1.0, frame.dist.z / x) * min(1.0, frame.dist.w / x);
}

// Lattice points are ranked so that the coarser ones of a nested set come first: a point on every 2^k-th row and column
// has a rank under 4^-k. A patch whose ranks kept end under 4^-k needs to visit only those points, and as the camera
// moves the kept set still changes one point at a time. Level of a point (up to 4, every 16th) and its rank:
fn latticeLevel(g: vec2<u32>) -> u32 {
    let m = g.x | g.y | 16u;
    return countTrailingZeros(m);
}
fn latticeRank(level: u32, u: f32) -> f32 {
    let hi = exp2(-2.0 * f32(level));
    let lo = select(hi * 0.25, 0.0, level >= 4u);
    return mix(lo, hi, u);
}

// Flower colours (linear): buttercup, hawkweed orange, daisy white, cornflower blue, poppy red; spikes: lupine, pink
// orchid, deep violet.
fn blossomColor(kind: u32, pick: f32, g: Growth) -> vec3<f32> {
    let warmDry = step3(0.5, 0.75, g.temp) * step3(0.55, 0.3, g.wet);
    if (kind == ${KIND.SPIKE}u) {
        if (pick < 0.45) { return vec3<f32>(0.20, 0.085, 0.42); }
        if (pick < 0.8) { return vec3<f32>(0.52, 0.17, 0.30); }
        return vec3<f32>(0.14, 0.06, 0.30);
    }
    if (pick < 0.12 * warmDry) { return vec3<f32>(0.60, 0.04, 0.025); }
    if (pick < 0.40) { return vec3<f32>(0.66, 0.44, 0.015); }
    if (pick < 0.52) { return vec3<f32>(0.72, 0.30, 0.02); }
    if (pick < 0.84) { return vec3<f32>(0.70, 0.70, 0.64); }
    return vec3<f32>(0.09, 0.16, 0.60);
}

// A blade as the cache keeps it (selectMain, vsMain read it): its root as an offset from its patch's corner and the
// patch's slot of this frame; its shape; its colour near and far; its share of the lattice (rank) and how many tufts its
// point holds per unit of density (scale); where in the patch it stands (for the gusts), its comb, its sway; flags.
// A blade as the cache keeps it, 32 bytes (the copy moves every kept blade each frame, the select reads them):
//   0: offset x, y from the patch's corner (half floats; the corner is at the block's drawn height, so they stay metres)
//   1: offset z (half), the patch's slot (16 bits)
//   2: facing, height, sway rate, sway phase     3: width, lean, crowding, kind | flags << 4
//   4: colour (sqrt), random                      5: far colour (sqrt), how grassy
//   6: rank, scale (half floats)                  7: comb turn, comb amount, clump, v
// Where in its block a blade stands (for the gusts at the corners) follows from the offset (selectMain).
fn writeRecord(index: u32, offset: vec3<f32>, slot: u32, facing: f32, tall: f32, width: f32, lean: f32, crowd: f32, kind: u32,
               albedo: vec3<f32>, seed: f32, far: vec3<f32>, grassy: f32, rank: f32, scale: f32, comb: vec2<f32>,
               rate: f32, phase: f32, clump: f32, v: f32, flags: u32) {
    let at = (frame.cache.x * STORE_CAP + index) * 2u;
    store[at] = vec4<u32>(pack2x16float(offset.xy), (pack2x16float(vec2<f32>(offset.z, 0.0)) & 0xFFFFu) | (slot << 16u),
        pack4x8unorm(vec4<f32>(fract(facing / 6.2831853), saturate(tall / MAX_H), rate, phase)),
        pack4x8unorm(vec4<f32>(saturate(width / MAX_W), lean, crowd, f32(kind | (flags << 4u)) / 255.0)));
    store[at + 1u] = vec4<u32>(pack4x8unorm(vec4<f32>(sqrt(saturate(albedo / 0.8)), seed)),
        pack4x8unorm(vec4<f32>(sqrt(saturate(far / 0.8)), grassy)), pack2x16float(vec2<f32>(rank, scale)),
        pack4x8unorm(vec4<f32>(comb, clump, saturate(v))));
}

// A patch's corners: the ground's rules, the height, and the noises that change over metres, worked out once per patch
// for its tufts to take between (about 7 in 8 lattice points that pass the first test are no tuft in the end).
struct Corner { grow: Growth, height: f32, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32> };
var<workgroup> corners: array<Corner, 4>;
fn mixGrowth(a: Growth, b: Growth, t: f32) -> Growth {
    return Growth(mix(a.grass, b.grass, t), mix(a.dry, b.dry, t), mix(a.forest, b.forest, t), mix(a.tundra, b.tundra, t),
        mix(a.marsh, b.marsh, t), mix(a.sparse, b.sparse, t), mix(a.lush, b.lush, t), mix(a.lively, b.lively, t),
        mix(a.tall, b.tall, t), mix(a.temp, b.temp, t), mix(a.wet, b.wet, t), mix(a.slope, b.slope, t), mix(a.dryness, b.dryness, t),
        mix(a.tone, b.tone, t));
}
fn between(a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, e: vec4<f32>, f: vec2<f32>) -> vec4<f32> { return mix(mix(a, b, f.x), mix(c, e, f.x), f.y); }
// The kinds' weights where the ground is so (grass, dry, woodland, tundra, reed).
fn kindWeights(g: Growth) -> array<f32, 5> {
    return array<f32, 5>(g.grass + 0.12 * g.sparse, 0.85 * g.dry, 0.3 * g.forest, 0.55 * g.tundra, 0.9 * g.marsh);
}
// At a corner: the kinds' total weight, the fewest blades a tuft of a kind growing there has, how much they gather in
// clumps (tuftsBound).
fn tuftTerms(g: Growth) -> vec3<f32> {
    let w = kindWeights(g);
    var fewest = 99.0;
    if (w[0] > 0.0) { fewest = min(fewest, 4.0); }   // meadow (its rosettes)
    if (w[1] > 0.0) { fewest = min(fewest, 12.0); }
    if (w[2] > 0.0) { fewest = min(fewest, 2.5); }
    if (w[3] > 0.0) { fewest = min(fewest, 8.0); }
    if (w[4] > 0.0) { fewest = min(fewest, 5.0); }
    let total = w[0] + w[1] + w[2] + w[3] + w[4];
    return vec3<f32>(total, fewest, max(1.0 - total, select(0.0, 0.8, w[1] > 0.0 || w[3] > 0.0)));
}
// Most tufts a lattice point of the patch can hold, over density: every corner's largest weight over the fewest blades,
// the tallest share for short grass (1.6), the densest clumps. What lies between corners lies between their values.
fn tuftsBound() -> f32 {
    let a = tuftTerms(corners[0].grow);
    let b = tuftTerms(corners[1].grow);
    let c = tuftTerms(corners[2].grow);
    let e = tuftTerms(corners[3].grow);
    let most = max(max(a, b), max(c, e));
    let fewest = min(min(a.y, b.y), min(c.y, e.y));
    return most.x * 1.6 * (1.0 + 0.9 * saturate(most.z)) / fewest;
}

// A patch's tufts, made anew: every tuft the patch can need while it stays in its distance step (the rest of the blades
// are chosen as drawn: selectMain), as offsets from the patch's corner.
@compute @workgroup_size(64)
fn generateMain(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) thread: u32) {
    let at = atomicLoad(&control[CTRL_GENLIST + group.y]);
    let split = atomicLoad(&control[CTRL_SPLIT]);
    let head = patches[at * 4u];
    let more = patches[at * 4u + 1u];
    let origin = bitcast<vec3<f32>>(patches[at * 4u + 2u].xyz);
    let d = vec2<i32>(i32(head.x & 0xFFFFu) - 32768, i32(head.x >> 16u) - 32768);
    let slot = head.y & 15u;
    let shift = (head.y >> 4u) & 15u;
    let ancestor = (head.y >> 8u) & 15u;
    let lod = (head.y >> 12u) & 15u;
    // Patches in this block along each side (1, 2 or 4: patchesMain).
    let span = (head.y >> 16u) & 7u;
    let sf = f32(span);
    let layer = i32(head.z & 4095u);
    let beds = head.z >= 4096u;
    let nearest = bitcast<f32>(head.w);
    let cellArea = bitcast<f32>(more.x);
    let land = unpack2x16unorm(more.y);
    let F = frame.faces[slot];
    let face = u32(F.anchor.z);
    let P = vec2<u32>(F.anchor.xy + d);
    // The drawn tile's part of its geometry's layer (an ancestor's quarter, sixteenth...).
    let part = vec2<f32>((P >> vec2<u32>(shift)) & vec2<u32>((1u << ancestor) - 1u)) / f32(1u << ancestor);
    let partScale = 1.0 / f32(1u << ancestor);
    let metres = frame.north.w / f32(1u << (frame.counts.y + PATCH_LEVELS));
    if (thread < 4u) {
        let cf = vec2<f32>(f32(thread & 1u), f32(thread >> 1u)) * sf;
        let localC = part + inTile(P, shift, cf) * partScale;
        let hC = heightAt(layer, localC);
        let qC = (vec2<f32>(P) + cf) * metres;
        let carried = qC - F.wind.xy;
        corners[thread] = Corner(${skip.growth ? 'Growth(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.3, 0.55, 0.5, 0.05, 0.0, vec3<f32>(1.0))' : 'growthAt(layer, localC, qC, hC)'}, hC,
            vec4<f32>(vnoise(qC / 8.5, 51u), vnoise(qC / 4.2 + 7.3, 53u), vnoise(qC / 6.1 + 3.1, 57u), vnoise(qC / 11.0 + 5.7, 61u)),
            vec4<f32>(vnoise(qC / 7.0, 23u), vnoise(qC / 2.3, 29u), vnoise(qC / 4.5, 59u), vnoise(qC / 3.2, 63u)),
            vec4<f32>(vnoise(qC / 19.0, 31u), vnoise(qC / 13.0, 37u), vnoise(carried / 22.0, 7u), vnoise(carried / 7.5 + 13.1, 11u)));
    }
    workgroupBarrier();
    // Most tufts a lattice point can hold here, over density: the first test, before anything is read for a point.
    let bound = tuftsBound();
    // For the nearest the patch can come while in its distance step (15 %; near the camera, density does not change).
    let keepMost = densityAt(nearest / 1.15) * cellArea * bound;
    let up = frame.up.xyz;
    let east = frame.east.xyz;
    let north = frame.north.xyz;
    let time = frame.sunDir.w;
    // The face's x and y in the level frame (east, north): tufts' turns and the clumps' ways are face-fixed.
    let fx3 = normalize(F.du.xyz - up * dot(F.du.xyz, up));
    let faceX = vec2<f32>(dot(fx3, east), dot(fx3, north));
    let faceY = vec2<f32>(-faceX.y, faceX.x);
    // Visit only the points of the coarsest set that holds every rank kept here.
    var level = 0u;
    for (var k = 1u; k <= 4u; k++) { if (keepMost <= exp2(-2.0 * f32(k))) { level = k; } }
    let stride = 1u << level;
    let points = CELLS * span / stride;
    for (var k = thread + group.x * 64u; k < points * points; k += 64u * split) {
        let c = vec2<u32>(k % points, k / points) * stride;
        let g = P * CELLS + c;
        let h0 = hash3(g.x, g.y, face);
        let own = latticeLevel(g);
        let rank = latticeRank(own, u01(h0));
        if (rank >= keepMost${skip.tuft ? ' || true' : ''}) { continue; }
        let h1 = pcg(h0);
        let h2 = pcg(h1);
        // A point of a coarser set lies anywhere in its own block, so that the set does not stand in rows.
        let f = (vec2<f32>(c) + vec2<f32>(u01(h1), u01(h2)) * f32(1u << own)) / f32(CELLS);
        let drawn = inTile(P, shift, f);
        let local = part + drawn * partScale;
        // The distance from the corners' heights decides; the drawn height only places what is kept.
        let fc = f / sf;
        let hApprox = mix(mix(corners[0].height, corners[1].height, fc.x), mix(corners[2].height, corners[3].height, fc.x), fc.y);
        let distance = length(placeAbout(F, vec2<f32>(d) + f, hApprox - 0.03).rel);
        // While the patch stays in its step a tuft comes at most 15 % nearer (its distance falls no faster than the
        // patch's); by the camera's feet, where patches share the first step, density is the same within 2 m.
        let reachD = select(distance / 1.15, min(distance / 1.15, 2.0), nearest < 2.0);
        if (reachD > frame.dist.x || rank >= densityAt(reachD) * cellArea * bound) { continue; }
        // Face metres, for the ground's patterns and the wind.
        let q = (vec2<f32>(P) + f) * metres;
        var grow = mixGrowth(mixGrowth(corners[0].grow, corners[1].grow, fc.x), mixGrowth(corners[2].grow, corners[3].grow, fc.x), fc.y);
        let n0 = between(corners[0].n0, corners[1].n0, corners[2].n0, corners[3].n0, fc);
        let n1 = between(corners[0].n1, corners[1].n1, corners[2].n1, corners[3].n1, fc);
        let n2 = between(corners[0].n2, corners[1].n2, corners[2].n2, corners[3].n2, fc);
        // Nothing grows in the beds of rivers and lakes, as the terrain draws them (its 1 - bed).
        if (beds) {
            let bed = saturate(textureSampleLevel(tileBeds, clampSampler, texelUv(local), layer, 0.0).r);
            let dryLand = 1.0 - bed;
            grow.grass *= dryLand; grow.dry *= dryLand; grow.forest *= dryLand; grow.tundra *= dryLand; grow.marsh *= dryLand; grow.sparse *= dryLand;
        }
        var w = kindWeights(grow);
        let total = w[0] + w[1] + w[2] + w[3] + w[4];
        if (total < 0.02) { continue; }

        // Which kind this tuft is: drawn in proportion to what grows here.
        let h3v = pcg(h2);
        var pick = u01(h3v) * total;
        var kind = 4u;
        for (var i = 0u; i < 4u; i++) { if (pick < w[i]) { kind = i; break; } pick -= w[i]; }

        // Clumps (Voronoi, about 0.6 m): height, facing and colour shared, blades drawn toward the middle.
        let cq = q * ${skip.clump ? '0.0' : '1.7'};
        let ci = vec2<i32>(floor(cq));
        var best = 9.0;
        var centre = vec2<f32>(0.0);
        var clumpHash = 0u;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let cell = vec2<u32>(ci + vec2<i32>(x, y) + vec2<i32>(1 << 22));
                let ch = hash3(cell.x, cell.y, face + 17u);
                let o = vec2<f32>(ci + vec2<i32>(x, y)) + vec2<f32>(u01(ch), u01(pcg(ch)));
                let dd = dot(o - cq, o - cq);
                if (dd < best) { best = dd; centre = o; clumpHash = ch; }
            }
        }
        let clump = u01(pcg(clumpHash + 3u));
        let clumpTurn = u01(pcg(clumpHash + 5u)) * 6.2831853;
        let apart = (cq - centre) / 1.7;
        let outward = length(apart);
        let crowd = saturate(1.0 - outward * 2.6);

        let h4 = pcg(h3v);
        let h5 = pcg(h4);
        let r = u01(h4);
        let r2 = u01(h5);
        let r3 = u01(pcg(h5));
        // Tuft: height (m), blades, spread (m), how far its blades arch out.
        let lushness = saturate(0.55 * grow.lush + 0.65 * grow.wet - 0.15);
        var tall = 0.3;
        var perTuft = 4.0;
        var spread = 0.03;
        var arch = 0.4;
        var width = 0.012;
        switch (kind) {
            case 0u: { tall = mix(0.24, 0.46, lushness) + 0.4 * grow.tall * (0.4 + 0.6 * lushness); perTuft = 4.5; spread = 0.035; arch = 0.45; width = mix(0.008, 0.015, r3); }
            case 1u: { tall = mix(0.32, 0.66, r3) + 0.3 * grow.tall; perTuft = 12.0; spread = 0.075; arch = 0.85; width = mix(0.005, 0.009, r3); }
            case 2u: { tall = mix(0.12, 0.26, lushness); perTuft = 2.5; spread = 0.03; arch = 0.5; width = mix(0.006, 0.01, r3); }
            case 3u: { tall = mix(0.12, 0.3, r3); perTuft = 8.0; spread = 0.05; arch = 0.75; width = mix(0.004, 0.007, r3); }
            default: { tall = mix(0.75, 1.3, lushness); perTuft = 5.0; spread = 0.04; arch = 0.15; width = mix(0.011, 0.018, r3); }
        }
        // Zones a few metres across within one ground: taller and shorter stands, yellower and deeper greens, more or
        // less straw. About mean-neutral, so the ground's own colour still matches far off.
        let zone = step3(0.3, 0.75, n0.x);
        let hueZone = step3(0.25, 0.75, n0.y);
        let strawZone = step3(0.45, 0.9, n0.z);
        tall *= mix(0.7, 1.12, sqrt(r)) * mix(0.75, 1.25, clump) * mix(0.75, 1.3, zone) * (1.0 - 0.5 * step3(0.15, 0.35, grow.slope));
        // Low broadleaf plants among the grass of a meadow (plantain, clover, young dock): a rosette of a few wide leaves
        // that lie out low. They give the field a lower, darker body of other shapes.
        let forb = kind == 0u && u01(pcg(h2 + 77u)) < 0.16 * step3(0.25, 0.6, grow.wet) * mix(0.6, 1.4, grow.lively);
        if (forb) { tall = mix(0.08, 0.17, r3); perTuft = 4.0; spread = 0.015; arch = 0.9; width = mix(0.024, 0.04, r3); }
        // Fewer tufts where grass is tall (it hides the ground sooner), more where short.
        let byHeight = clamp(0.35 / max(tall, 0.05), 0.5, 1.6);
        // Bunchgrass and thin grass gather in clumps with gaps between; a meadow stays even.
        let gather = select(1.0 - total, 0.8, kind == 1u || kind == 3u);
        let clumpy = mix(1.0, mix(0.25, 1.9, clump * clump), saturate(gather));
        // Tufts a lattice point holds per blade per square metre: as drawn, times the density at the distance.
        let tuftScale = cellArea * total * byHeight * clumpy / perTuft;
        let tufts = densityAt(reachD) * tuftScale;
        if (rank >= tufts) { continue; }
        let height = ${skip.height ? 'heightAt(layer, local)' : 'drawnHeight(layer, ancestor, part, lod, drawn)'};
        let place = placeAbout(F, vec2<f32>(d) + f, height - 0.03);
        // Tufts thin out with distance by their rank: one just kept grows out of the ground, so none pops.
        let count = clamp(u32(ceil(perTuft * mix(0.6, 1.4, r2))), 1u, 12u);

        // Seed heads stand out of tall and dry tufts; flowers in patches a few metres wide, where the meadow is lively.
        // Rusty dock and sorrel in patches a few metres wide.
        let dockPatch = step3(0.62, 0.85, n0.w) * step3(0.3, 0.6, grow.wet) * select(0.0, 1.0, kind == 0u);
        // A tuft is about a 70th of a square metre close by: a plant or two per square metre where dock grows.
        let dock = u01(pcg(h5 + 31u)) < 0.025 * dockPatch;
        let seedChance = (0.12 + 0.5 * grow.tall + 0.3 * zone) * select(0.4, 1.0, kind == 1u || kind == 0u) * step3(0.18, 0.4, tall);
        let seedU = u01(pcg(h5 + 9u));
        let seeds = select(0u, 1u, dock || (seedU < seedChance && step3(frame.dist.x * 0.08, frame.dist.x * 0.16, reachD) < 1.0));
        let seedV = select(seedU / max(seedChance, 1.0e-6), 0.0, dock);
        let flowerPatch = n1.x * 0.65 + n1.y * 0.35;
        let meadow = step3(0.35, 0.75, grow.lively) * step3(0.25, 0.5, grow.wet) * select(0.25, 1.0, kind == 0u) * select(1.0, 0.0, kind >= 3u);
        let blossomShare = meadow * step3(0.48, 0.78, flowerPatch);
        // Seed heads stop where they are under a pixel; flowers go on further, fewer and as dots of colour (their heads
        // are widened to a pixel below), thinning out to the blades' end: patches of colour stay in the far meadow.
        let farOut = 1.0 - step3(frame.dist.x * 0.145, frame.dist.x * 0.21, distance);
        let flowerOut = 1.0 - step3(frame.dist.x * 0.12, frame.dist.x * 0.3, reachD);
        let flowerU = u01(pcg(h5 + 13u));
        let blossoms = select(0u, 1u, flowerU < 0.42 * blossomShare && flowerOut > 0.0);
        let flowerV = flowerU / max(0.42 * blossomShare, 1.0e-6);
        let several = count + seeds + blossoms;

        // Wind: gusts carried with it (the same field moves the far meadows), each tuft's sway, and a lasting comb.
        // The gusts' field is fixed to the ground and moved by how far the wind has carried it, summed frame by frame:
        // a wind that turns changes only where the field drifts next. (Taken as the wind's way times the place, a
        // turn of 0.1 rad/s swept it past a blade 150 km from the face's corner at 15 km/s: violent shaking.)
        // Gusts roll on with the wind as broad waves; a tuft sways at its own pace (about 0.5-0.8 Hz, set by its
        // stiffness, not by the wind's speed), less far off where a blade is a pixel and any motion only flickers.
        // The wind's parts that stay (each tuft's pace and phase of sway, the lasting comb); the rest is worked out as
        // drawn, from the gusts at the patch's corners (patchesMain).
        let swayPhase = fract(n1.z + r * 1.2 / 6.2831853);

        // In view? A ball about the tuft.

        let first = atomicAdd(&control[CTRL_STORE], several);
        if (first + several > STORE_CAP) { incomplete(at); continue; }

        // The tuft's colour: the ground's own grass colour (so blades and ground agree), its hue by climate, the
        // fields' broad tone; brighter than the ground's mean, which holds soil and shade.
        let hue = grassHue(grow.temp, grow.wet);
        let shade = mix(0.82, 1.2, clump) * mix(0.92, 1.08, r);
        var base = ${mean('grass')} * hue * grow.tone * 1.5;
        switch (kind) {
            case 1u: { base = ${mean('dryGrass')} * mix(hue, vec3<f32>(1.0), 0.7) * grow.tone * vec3<f32>(2.05, 1.72, 1.05); }
            case 2u: { base = ${mean('grass')} * hue * grow.tone * 1.45; }
            case 3u: { base = mix(vec3<f32>(0.17, 0.15, 0.07), vec3<f32>(0.21, 0.10, 0.05), step3(0.4, 0.95, r)) * mix(0.8, 1.15, clump); }
            case 4u: { base = ${mean('marsh')} * hue * 1.8; }
            default: {}
        }
        if (forb) { base = ${mean('grass')} * hue * vec3<f32>(0.95, 1.12, 1.25) * 1.2; }
        // Muted, as grass is: a little of its own grey.
        base = mix(base, vec3<f32>(dot(base, vec3<f32>(0.2126, 0.7152, 0.0722))), 0.18);
        // Patches a few metres across a little lighter or darker: clumps and their shade, as a meadow is seen from above.
        base *= shade * mix(0.8, 1.16, step3(0.2, 0.8, n1.w));
        if (kind == 0u || kind == 2u) { base *= mix(vec3<f32>(1.14, 1.05, 0.78), vec3<f32>(0.86, 0.97, 1.08), hueZone); }
        let straw = mix(${mean('dryGrass')} * vec3<f32>(1.5, 1.35, 1.0), vec3<f32>(0.22, 0.2, 0.15), u01(pcg(h5 + 21u)));
        // Far off, grass takes the colour the ground past the blades has (terrainPass.wgsl.js canopyAlbedo): each blade
        // keeps part of its own difference from its tuft, so the field keeps its grain but not a shade of its own.
        let tint = ${biome ? 'mix(hue, vec3<f32>(1.0), 0.7 * grow.dryness)' : 'vec3<f32>(1.0)'};
        let canopy = mix(${mean('grass')}, ${mean('dryGrass')} * vec3<f32>(1.09, 0.97, 0.69), grow.dryness) * tint * grow.tone * vec3<f32>(1.0, 0.96, 1.07);
        // Toward the end of their reach blades take the colour the ground beyond has (as they take its light: fsMain).
        var grainHere = vec3<f32>(1.0);
        if (kind <= 2u || forb) { grainHere = grainAt(q, place.rel, fx3, cross(up, fx3), distance * frame.ambient.w, distance); }
        var deadShare = select(mix(0.02, 0.11, strawZone), 0.0, forb);
        switch (kind) { case 1u: { deadShare = 0.55; } case 3u: { deadShare = 0.3; } case 4u: { deadShare = 0.28; } default: {} }

        for (var i = 0u; i < several; i++) {
            let hb = pcg(h5 + (i + 1u) * 0x9E3779B9u);
            let u1 = u01(hb);
            let u2 = u01(pcg(hb + 1u));
            let u3 = u01(pcg(hb + 2u));
            let u4 = u01(pcg(hb + 3u));
            // Roots in a small disc; the clump draws them a little toward its middle.
            let ring = spread * sqrt(u1);
            let around = u2 * 6.2831853;
            let off = (cos(around) * faceX + sin(around) * faceY) * ring - (apart.x * faceX + apart.y * faceY) * (0.05 * crowd);
            let root = place.rel + off.x * east + off.y * north;
            // Facing: half the clump's way, half out of the tuft (a fan), with a golden-angle spread.
            let outAngle = atan2(off.y, off.x);
            var facing = mix(clumpTurn + f32(i) * GOLDEN, outAngle, 0.5) + (u3 - 0.5) * 0.8;
            // Outer blades of a tuft arch out, inner ones stand; long blades droop under their own weight.
            let outer = sqrt(u1);
            let droop = 0.35 * step3(0.25, 0.8, tall) * select(1.0, 0.3, kind == 4u);
            var lean = saturate(arch * mix(0.25, 1.5, outer) * mix(0.75, 1.25, u4) + droop + 0.2 * (1.0 - crowd));
            // Heights spread wide: most blades make a low body, fewer stand up out of it.
            var bladeTall = tall * mix(0.38, 1.06, u3);
            var bladeWidth = width * mix(0.8, 1.2, u1);
            var bladeKind = select(kind, ${KIND.LEAF}u, forb);
            let dead = u01(pcg(hb + 4u)) < deadShare;
            // Kept only so far off (selectMain): 1 seed heads, 2 flowers; v the share of that distance's chance it needs.
            var rule = 0u;
            var v = 0.0;
            var color = select(base * mix(vec3<f32>(0.93, 1.0, 1.05), vec3<f32>(1.08, 1.0, 0.92), u4), straw, dead);
            // Dead blades are fallen ones: lower, and lying out.
            if (dead) { bladeTall *= 0.75; lean = saturate(lean + 0.3); }
            if (i >= count) {
                if (i == count && seeds == 1u && dock) {
                    // A dock spike, rust red over green.
                    bladeKind = ${KIND.SPIKE}u;
                    bladeTall = max(tall, 0.25) * mix(1.1, 1.6, u3) + 0.1;
                    bladeWidth = mix(0.008, 0.014, u1);
                    lean = 0.05 + 0.15 * u4;
                    color = mix(vec3<f32>(0.13, 0.045, 0.025), vec3<f32>(0.19, 0.075, 0.03), u2) * mix(0.8, 1.1, u1);
                } else if (i == count && seeds == 1u) {
                    bladeKind = ${KIND.SEED}u;
                    rule = 1u;
                    v = seedV;
                    // A seed head over the tuft: pale straw, some flushed pink, some still green.
                    bladeTall = tall * mix(1.15, 1.45, u3) + 0.05;
                    bladeWidth = mix(0.0035, 0.006, u1);
                    lean = 0.12 + 0.3 * u4;
                    let pale = mix(vec3<f32>(0.27, 0.23, 0.15), vec3<f32>(0.26, 0.17, 0.17), step3(0.6, 0.95, u4));
                    color = mix(pale, vec3<f32>(0.30, 0.34, 0.16), step3(0.75, 1.0, u2) * 0.7) * mix(0.8, 1.1, u1);
                } else {
                    bladeKind = select(${KIND.BLOSSOM}u, ${KIND.SPIKE}u, u01(pcg(clumpHash + 41u)) < 0.28 * step3(0.4, 0.7, grow.wet));
                    rule = 2u;
                    v = flowerV;
                    // Among the grass, few above it; spikes stand taller.
                    bladeTall = min(tall * mix(0.45, 1.0, u3) + 0.03, mix(0.4, 0.6, u4));
                    if (bladeKind == ${KIND.SPIKE}u) { bladeTall = max(tall, 0.3) * mix(1.0, 1.4, u3); }
                    bladeWidth = select(mix(0.014, 0.04, u1 * u1), mix(0.014, 0.022, u1), bladeKind == ${KIND.SPIKE}u);
                    lean = 0.05 + 0.15 * u4;
                    // A patch keeps to one or two kinds of flower.
                    color = blossomColor(bladeKind, fract(u01(pcg(clumpHash + 43u)) + 0.25 * step3(0.7, 1.0, u4)), grow);
                }
            }
            // Far off a blade takes the canopy's colour with the ground's grain where it stands (the ground past the blades
            // wears the same), and a little of its own difference: worked out here, blended by distance as drawn.
            var farColor = color;
            if (bladeKind <= 2u || bladeKind == ${KIND.LEAF}u) {
                let own = clamp(color / max(base, vec3<f32>(0.002)), vec3<f32>(0.4), vec3<f32>(2.5));
                farColor = canopy * ${n(GRASS_CANOPY.gain)} * grainHere * mix(vec3<f32>(1.0), own, 0.12);
            }
            writeRecord(first + i, root - origin, at, facing, bladeTall, bladeWidth, lean, crowd, bladeKind, color, u4, farColor,
                step3(0.0, 1.0, total), rank, tuftScale, n2.xy, r2, swayPhase, clump, v, select(0u, 1u, forb) | (rule << 1u));
        }
    }
}

@compute @workgroup_size(1)
fn finishMain() {
    let segments = array<u32, 3>(${segments.map(s => `${s}u`).join(', ')});
    let caps = array<u32, 3>(BAND0, BAND1, BAND2);
    let starts = array<u32, 3>(0u, BAND0, BAND0 + BAND1);
    // Indexed draws of ${BLADES_PER_INSTANCE} blades an instance: index count, instances, first index, base vertex, first
    // instance. The last instance's blades past the count are drawn as nothing (a blade of no size).
    for (var b = 0u; b < 3u; b++) {
        let count = min(atomicLoad(&control[1u + b]), caps[b]);
        let instances = (count + ${BLADES_PER_INSTANCE - 1}u) / ${BLADES_PER_INSTANCE}u;
        args[4u + b * 5u] = ${BLADES_PER_INSTANCE}u * 3u * (segments[b] * 2u - 1u);
        args[5u + b * 5u] = instances;
        args[6u + b * 5u] = 0u;
        args[7u + b * 5u] = 0u;
        args[8u + b * 5u] = starts[b] / ${BLADES_PER_INSTANCE}u;
        for (var i = count; i < instances * ${BLADES_PER_INSTANCE}u; i++) {
            drawn[(starts[b] + i) * 2u] = vec4<u32>(0u);
            drawn[(starts[b] + i) * 2u + 1u] = vec4<u32>(0u);
        }
    }
    // This half's blades, for the next frame to carry over.
    atomicStore(&control[CTRL_PERSIST + frame.cache.x], min(atomicLoad(&control[CTRL_STORE]), STORE_CAP));
}
`;
}

/** The blades drawn: vertex and fragment. */
/** skip.shade: for measuring only, a flat colour instead of the blades' light. */
/** segments: strip segments by band (as the scatter's). */
/** perVertex: the light at the vertices, a flat fragment (blades a few pixels wide: the far bands). */
export function buildGrassDrawWGSL({ skip = {}, segments = LOD_SEGMENTS, perVertex = false } = {}) {
    const [b0, b1] = LOD_CAPACITY;
    return /* wgsl */`${FRAME_WGSL}${WAVE_WGSL}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> blades: array<vec4<u32>>;
const MAX_H: f32 = ${n(MAX_HEIGHT)};
const MAX_W: f32 = ${n(MAX_WIDTH)};
fn step3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
alias h = f32; alias h2 = vec2<f32>; alias h3 = vec3<f32>;
${GROUND_LIGHT_WGSL}
${GRASS_CANOPY_WGSL}

struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) rel: vec3<f32>,
    @location(1) normal: vec3<f32>,
    // Up the blade 0..1; 1 on a flower or seed head; on a flower's head across and up (-1..1), far below on its stem.
    @location(2) along: vec4<f32>,
    // As selectMain packed them: colour (sqrt) and a random; the land's sun and sky, clump, how grassy; width, lean,
    // crowding, kind. Few outputs: every vertex's are stored and read back (2-3 million a frame).
    @location(3) @interpolate(flat) look: vec3<u32>,
    ${perVertex ? '@location(4) shaded: vec3<f32>,                     // the light worked out at the vertex' : ''}
};

@vertex
fn vsMain(@builtin(vertex_index) corner: u32, @builtin(instance_index) group: u32) -> Out {
    // ${BLADES_PER_INSTANCE} blades an instance (BLADES_PER_INSTANCE): which blade, and which vertex of its strip.
    // Divisions by constants (a band per draw): an integer division by a number the shader only knows as it runs is slow.
    let first = group * ${BLADES_PER_INSTANCE}u;
    var segments = ${segments[2]}u;
    var instance = first + corner / ${2 * segments[2] + 1}u;
    var vertex = corner % ${2 * segments[2] + 1}u;
    if (first < ${b0}u) {
        segments = ${segments[0]}u;
        instance = first + corner / ${2 * segments[0] + 1}u;
        vertex = corner % ${2 * segments[0] + 1}u;
    } else if (first < ${b0 + b1}u) {
        segments = ${segments[1]}u;
        instance = first + corner / ${2 * segments[1] + 1}u;
        vertex = corner % ${2 * segments[1] + 1}u;
    }
    // The blade this frame (selectMain).
    let a = blades[instance * 2u];
    let b = blades[instance * 2u + 1u];
    let level = min(vertex >> 1u, segments);
    let sideSign = select(-1.0, 1.0, (vertex & 1u) == 1u);
    let root = bitcast<vec3<f32>>(a.xyz);
    let shape = unpack2x16unorm(a.w);
    let bend = unpack2x16float(b.x);
    let look = unpack4x8unorm(b.y);
    let kind = u32(look.w * 255.0 + 0.5);
    let up = frame.up.xyz;
    let east = frame.east.xyz;
    let north = frame.north.xyz;
    let distance = length(root);
    let toEye = -root / max(distance, 0.01);
    let time = frame.sunDir.w;
    let seed = unpack4x8unorm(b.z).a;
    let angle = shape.x * 6.2831853;
    // Out at the edge the blades sink into the ground: no line where they end.
    let edgeFade = smoothstep(frame.dist.x, frame.dist.x * 0.7, distance);
    let tall = shape.y * MAX_H * edgeFade;
    let fdir = cos(angle) * east + sin(angle) * north;
    // Seen edge-on a blade is a sliver: turn it partly toward the camera (Tsushima).
    var across = cross(up, fdir);
    let level2 = toEye - up * dot(toEye, up);
    let edgeOn = abs(dot(across, normalize(level2 + up * 1.0e-4)));
    across = normalize(across - normalize(level2 + up * 1.0e-4) * (dot(across, normalize(level2 + up * 1.0e-4)) * 0.55 * edgeOn));
    let lean = look.y;
    // Each blade's own flutter on top of its tuft's sway.
    let flutter = 0.012 * frame.wind.w / 0.045 * wave(time, 3.0 + 2.0 * seed, seed * 40.0) * (1.0 - smoothstep(6.0, 25.0, distance));
    // Flower stems and spikes are stiffer than blades.
    let stiff = select(1.0, 0.45, kind >= 5u && kind != ${KIND.LEAF}u);
    let windV = (bend.x * east + bend.y * north + across * flutter) * stiff;
    // A quadratic curve of about the blade's length (AMD's (2 L0 + L1) / 3): bending lowers the tip.
    var tip = up * (1.0 - 0.55 * lean * lean) + fdir * (lean * 1.05) + windV;
    var ctrl = up * 0.68 + fdir * (lean * 0.22) + windV * 0.25;
    let size = (2.0 * length(tip) + length(ctrl) + length(tip - ctrl)) / 3.0;
    tip /= size;
    ctrl /= size;

    // Rows: blades taper; seed heads and spike flowers are a stem with a head over its top part; a flower's last two
    // rows are its head, turned to the camera.
    let flowerDisc = kind == 6u;
    let spiky = kind == 5u || kind == 7u;
    var t = f32(level) / f32(segments);
    // A flower's stem ends three rows before the strip does (one before in the coarsest band): its head is those rows.
    let stemRows = select(segments - 3u, 1u, segments < 4u);
    if (flowerDisc) { t = f32(min(level, stemRows)) / f32(stemRows); }
    let s = 1.0 - t;
    var p = root + tall * (2.0 * s * t * ctrl + t * t * tip);
    let dp = normalize(2.0 * s * ctrl + 2.0 * t * (tip - ctrl) + up * 1.0e-4);
    var width = look.x * MAX_W * mix(0.3, 1.0, edgeFade);
    var side = across;
    var flower = 0.0;
    var petal = vec2<f32>(sideSign, -3.0);
    if (spiky) {
        let headFrom = select(0.7, 0.48, kind == 7u);
        let into = saturate((t - headFrom) / (1.0 - headFrom));
        flower = step(headFrom - 0.01, t);
        width = select(0.0025, width * pow(sin(3.14159 * min(into * 0.92 + 0.08, 1.0)), 0.7), t >= headFrom);
    } else if (flowerDisc) {
        // Stem, then the head about the stem's top: a lower and an upper row as wide as the head, and a point. Its face
        // turns between the camera and the sky, as flowers face up and are seen from the side.
        let facingHead = normalize(toEye + up * 0.7);
        let headUp = normalize(up - facingHead * dot(up, facingHead));
        let headSide = normalize(cross(headUp, facingHead));
        let radius = width * 0.5;
        // The stem ends at the head's lowest point; rows at -0.42 and 0.42 of its radius about the middle, then a point.
        if (level > stemRows || (segments < 4u && level == stemRows)) {
            side = headSide;
            let row = select(level - stemRows, 2u, segments < 4u && level == stemRows);
            let rise = select(select(select(1.0, 0.42, row == 2u), -0.42, row == 1u), 1.0, level == segments);
            p += headUp * (radius * (1.0 + rise));
            width = select(radius * 1.9, 0.0, level == segments);
            petal = vec2<f32>(select(sideSign, 0.0, level == segments), rise);
            flower = 1.0;
        } else {
            width = 0.0025;
            if (level == stemRows) { petal = vec2<f32>(0.0, -1.0); }
        }
    } else if (kind == ${KIND.LEAF}u) {
        // A leaf: narrow at its stalk, widest past its middle, to a point.
        width *= pow(sin(3.14159 * clamp(t * 0.92 + 0.06, 0.0, 1.0)), 0.75) * smoothstep(0.0, 0.25, t);
    } else {
        width *= (1.0 - pow(t, 1.6)) * (0.8 + 0.2 * sin(3.14159 * min(t * 1.6, 1.0)));
    }
    // At least so many pixels wide: thinner blades flicker as one moves (fewer, wider blades far off).
    let open = sqrt(max(1.0 - dot(side, toEye) * dot(side, toEye), 0.0));
    let pixels = max(width, 1.0e-4) * max(open, 0.25) / (max(distance, 0.05) * frame.ambient.w);
    // Flower heads widen to about a pixel and no more (a dot of colour; wider they stand as sticks). Seed heads keep
    // their size.
    // Blades widen to a pixel far off (fewer, wider). Heads of flowers, seeds and spikes widen at most twice (wider they
    // stand as paint strokes); their stems not at all (they would stand as dark sticks).
    var widen = clamp(frame.lod.z / pixels, 1.0, frame.lod.w);
    if (kind >= 5u && kind != ${KIND.LEAF}u) { widen = select(1.0, clamp(0.8 / pixels, 1.0, select(2.0, 1.8, flowerDisc)), flower > 0.5); }
    width *= widen;
    let pos = p + side * (0.5 * width * sideSign);
    var normal = normalize(cross(dp, side));
    normal *= select(-1.0, 1.0, dot(normal, toEye) >= 0.0);
    // Rounded across (the edges turn away) and, farther off, toward the sky: a field of blades takes the light more
    // as the ground under it would (velvet far away).
    normal = normalize(normal + side * (0.5 * sideSign));
    // Far off, the canopy's own normal: between up and toward the viewer (velvet). The ground past the blades lights
    // its grass with the same one (terrainPass.wgsl.js), so the two agree where they meet.
    let velvet = normalize(level2 + up);
    normal = normalize(mix(normalize(normal + up * 0.3), normalize(up + 0.5 * (velvet - up)), smoothstep(12.0, 40.0, distance)));
    if (flowerDisc && flower > 0.5) { normal = normalize(toEye + up); }
    var out: Out;
    out.clip = frame.clip * vec4<f32>(pos, 1.0);
    out.rel = pos;
    out.normal = normal;
    out.along = vec4<f32>(select(t, 1.0, flowerDisc && flower > 0.5), flower, petal);
    out.look = vec3<u32>(b.z, b.w, b.y);
    ${perVertex ? 'out.shaded = shadeBlade(out);' : ''}
    return out;
}

// A blade's light at a point of it (per pixel near; per vertex in the far bands: perVertex).
fn shadeBlade(in: Out) -> vec3<f32> {
    let c4 = unpack4x8unorm(in.look.x);
    let inAlbedo = vec4<f32>(c4.rgb * c4.rgb * 0.8, c4.a);
    let inLight = unpack4x8unorm(in.look.y);
    let inLook = unpack4x8unorm(in.look.z);
    ${skip.shade ? 'return inAlbedo.rgb * 2.0;' : ''}
    let distance = length(in.rel);
    let V = -in.rel / max(distance, 0.001);
    var N = normalize(in.normal);
    if (dot(N, V) < 0.0) { N = -N; }
    let L = frame.sunDir.xyz;
    let up = frame.up.xyz;
    let t = in.along.x;
    let kind = u32(inLook.w * 255.0 + 0.5);
    let crowd = inLook.z;
    let petalAt = in.along.zw;
    // A flower's head: its colour only there, a centre, the petals' edges a little darker.
    let headIn = select(in.along.y, smoothstep(-1.08, -0.92, petalAt.y), kind == 6u);
    let flower = headIn;
    // Far off a blade is a pixel: its own differences only flicker. Toward the mean with distance; the height ramp
    // fades to its mean too (every fake fades far, Black Ops 4).
    let calm = step3(16.0, 44.0, distance);
    // Stems of flowers and seed heads are green.
    var headColor = inAlbedo.rgb;
    if (kind == 6u) {
        let r = length(petalAt);
        let white = min(min(headColor.r, headColor.g), headColor.b) > 0.4;
        let centre = select(headColor * 0.45, vec3<f32>(0.55, 0.36, 0.03), white);
        headColor = mix(centre, headColor, smoothstep(0.24, 0.34, r)) * mix(1.0, 0.78, smoothstep(0.65, 1.0, r));
    }
    // Stems of flowers and seed heads as green as the grass about them: dark, they stood as sticks.
    var albedo = select(inAlbedo.rgb, mix(vec3<f32>(0.10, 0.15, 0.045), headColor, flower), kind >= 5u);
    let blade = kind < 5u || kind == ${KIND.LEAF}u;
    // Darker low in the blade, lighter toward the tip; dry grass bleaches at the tips. The ramp is the canopy's own
    // occlusion: the main reason a field looks deep.
    // Seen from above, a blade's low part lies within the canopy the ground under it already shows (terrainPass.wgsl.js
    // grassCanopy): it takes the canopy's light there rather than its own deep shade, or it stands as a dark stick.
    let fromAbove = step3(0.15, 0.6, dot(V, up));
    let ramp = mix(mix(0.16 + 0.12 * (1.0 - crowd), 1.0, pow(saturate(t), 1.15)), mix(0.62, 1.0, saturate(t)), fromAbove);
    let tipTint = select(vec3<f32>(1.12, 1.07, 0.88), vec3<f32>(1.25, 1.18, 1.08), kind == 1u);
    if (blade) { albedo *= mix(vec3<f32>(1.0), tipTint, step3(0.55, 1.0, t)); }
    albedo = mix(albedo, inAlbedo.rgb * 0.95, 0.45 * calm * select(0.0, 1.0, blade));
    // The hotspot: with the sun behind the viewer, the shadows in the canopy lie behind the blades that cast them.
    let toward = saturate(dot(V, L));
    let hotspot = toward * toward * toward;
    // Far off a blade keeps a little of its ramp: dark roots between tufts are what make a distant field read as grass.
    let occlusion = mix(mix(ramp, 1.0, 0.35 * hotspot), mix(0.66 + 0.12 * hotspot, ramp, 0.3), 0.7 * calm);

    let sunUp = dot(up, L);
    let day = frame.light.w;
    let NdotL = dot(N, L);
    // The sun reaches low parts of the canopy less, the more so the lower it stands.
    let depth = 1.0 - t;
    let canopy = exp(-depth * (1.0 + 1.8 * crowd) * frame.bounce.w * inLight.w);
    let sunSeen = inLight.x * mix(mix(mix(0.2, 1.0, canopy), 1.0, 0.75 * hotspot), 0.92, calm);
    let diffuse = max(NdotL, 0.0);
    // Light through the blade from behind, strongest looking toward the sun: without it grass is far too dark.
    let back = max(-NdotL, 0.0);
    let away = saturate(-dot(V, L));
    let away2 = away * away;
    let glow = away2 * away2 * away;
    let thin = select(0.6, 0.42, kind == 1u || kind == 3u || kind == 5u);
    let through = (back * ${n(GRASS_CANOPY.back)} + glow * ${n(GRASS_CANOPY.toward)}) * thin * albedo * ${v3(GRASS_CANOPY.tint)} * select(1.0, 1.3, flower > 0.5 && kind == ${KIND.BLOSSOM}u);
    // A thin waxy highlight along the blade (the rounded normal makes it a line), faded very near and far.
    var sheen = 0.0;
    if (calm < 1.0) {
        let H = normalize(L + V);
        let gloss = mix(24.0, 70.0, inAlbedo.a);
        sheen = pow(max(dot(N, H), 0.0), gloss) * 0.12 * (0.3 + 0.7 * t) * step3(0.6, 2.5, distance) * (1.0 - calm)
            * select(1.0, 0.25, kind == 1u || flower > 0.5);
    }

    let sun = frame.sunColor.rgb;
    let ambient = frame.ambient.rgb;
    let sky = frame.light.rgb;
    let overhead = 0.55 + 0.45 * dot(N, up);
    let bounce = frame.bounce.rgb * (0.6 + 0.4 * depth);
    let open = inLight.y;
    let lit = sun * (diffuse * albedo + through + sheen) * sunSeen + albedo * (ambient + sky * overhead * open + bounce);
    let night = albedo * vec3<f32>(mix(0.30, 0.06, day));
    let own = max(lit, night) * occlusion;
    // Toward the end of their reach, lit as the ground beyond lights its grass (terrainPass.wgsl.js, grassHue.wgsl.js
    // grassCanopy): the same canopy seen at the same slant, the same light and glow. Where they sink into the ground it
    // looks as they did. (By distance alone: a rule for views from above made a ring of blades unlike both sides.)
    let far = select(0.0, step3(frame.dist.x * 0.3, frame.dist.x * 0.85, distance), kind <= 2u || kind == ${KIND.LEAF}u);
    if (far <= 0.0) { return own; }
    let velvet = normalize(V - up * dot(V, up) + up);
    let nC = normalize(up + 0.5 * (velvet - up));
    let land = vec2<f32>(inLight.x, open);
    let share = inLight.w;
    let gc = grassCanopy(${n(GRASS_CANOPY.depth)} * share / max(dot(V, up), 0.02), grassSunDepth(sunUp, share, V, L), ${n(GRASS_CANOPY.ramp)});
    let sunShare = 0.65 * land.x * step3(0.0, 0.25, sunUp);
    let canopyLit = albedo * lightAt(nC, up, up, L, sun, ambient, 0.8, 1.0, land);
    let grassThrough = ${n(GRASS_CANOPY.back)} * max(-dot(velvet, L), 0.0) + ${n(GRASS_CANOPY.toward)} * glow;
    let ground = canopyLit * mix(gc.x, gc.y, sunShare)
        + sun * land.x * albedo * ${v3(GRASS_CANOPY.tint)} * (${n(GRASS_CANOPY.glow)} * grassThrough);
    // A blade's own light and shade stay a little: the field keeps its grain.
    let grain = clamp(dot(own, vec3<f32>(0.333)) / max(dot(canopyLit, vec3<f32>(0.333)), 1.0e-4), 0.6, 1.6);
    return mix(own, ground * mix(1.0, grain, 0.2), far);
}

@fragment
fn fsMain(in: Out) -> @location(0) vec4<f32> {
    ${perVertex ? 'return vec4<f32>(in.shaded, 1.0);' : 'return vec4<f32>(shadeBlade(in), 1.0);'}
}
`;
}
