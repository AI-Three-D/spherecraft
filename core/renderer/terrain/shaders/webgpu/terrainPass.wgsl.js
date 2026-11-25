// The terrain as the game draws it: generated ground surfaces, light over the land, far water, air (TerrainPass.js).
// The same picture as terrainChunkFragmentShaderBuilder.js with groundMaterials and productionDraw, whose diagnostics,
// atlas, shadow cascades and clustered lights this has not. What a tile does not need is left out of its shader: on this
// GPU code costs registers and time whether it runs or not.

import { GROUND_LAYERS, GROUND_WIDE, GROUND_WIDE_LAYERS } from '../../materials/groundMaterials.js';
import { buildTerrainLightWGSL } from '../../light/terrainLight.wgsl.js';
import { createWaterWgsl } from '../../../../world/water/waterWgsl.js';
import { getAerialPerspectiveWGSL } from '../../../atmosphere/shaders/aerialPerspectiveCommon.js';
import { AIR_FRAME_WGSL, AIR_READ_WGSL, AIR_SUN_WGSL } from '../../draw/TerrainAir.js';
import { GROUND_WRAP_SHARE } from './groundSurface.wgsl.js';
import { buildEdgeStitchWGSL, CUBE_POINT_WGSL, SAMPLE_HEIGHT_WGSL } from './terrainChunkVertexShaderBuilder.js';

export const TERRAIN_PASS_FLOATS = 60;

const FRAME_WGSL = /* wgsl */`
struct Frame {
    view: mat4x4<f32>,
    projection: mat4x4<f32>,
    planetOrigin: vec3<f32>, planetRadius: f32,
    camera: vec3<f32>, heightScale: f32,
    sunDir: vec3<f32>, wetness: f32,
    sun: vec3<f32>, fadeStart: f32,
    ambient: vec3<f32>, fadeEnd: f32,
    fogColor: vec3<f32>, normalStart: f32,
    normalEnd: f32, useAtlasMode: f32, pad0: f32, pad1: f32,
};
`;

// The vertex index is the vertex: a grid of SEGMENTS cells, row by row.
export function buildTerrainPassVertexWGSL({ segments }) {
    return /* wgsl */`${FRAME_WGSL}${AIR_FRAME_WGSL}${getAerialPerspectiveWGSL()}
struct ChunkInstance {
    position: vec3<f32>, face: u32,
    chunkLocation: vec2<f32>, chunkSizeUV: f32, pad: f32,
    uvOffset: vec2<f32>, uvScale: f32, lod: u32,
    neighborLODs: vec2<u32>, layer: u32, edgeMask: u32,
};
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) ground: vec3<f32>,  // metres along the cube face, wrapped, and the height
    @location(1) rel: vec3<f32>,     // from the camera
    @location(2) uv: vec4<f32>,      // in the tile of the shape, in the tile of the material
    @location(3) up: vec3<f32>,
    @location(4) land: vec2<f32>,
    @location(5) ud: vec3<f32>,      // how the ground's coordinate runs over the world
    @location(6) vd: vec3<f32>,
    @location(7) @interpolate(flat) face: vec2<f32>, // from the wrapped coordinate to the whole face's
    @location(8) @interpolate(flat) tile: u32,       // layer, layer of the material, 1 without material
    @location(9) sunlight: vec3<f32>, // on the air before it
};
@group(0) @binding(0) var<uniform> uniforms: Frame;
@group(1) @binding(0) var heightTexture: texture_2d_array<f32>;
@group(3) @binding(0) var<storage, read> chunks: array<ChunkInstance>;
@group(3) @binding(1) var<storage, read> edgeStitch: array<vec4<u32>>;
@group(3) @binding(2) var<storage, read> drawn: array<u32>;
@group(3) @binding(5) var landSampler: sampler;
@group(3) @binding(6) var<uniform> air: AirFrame;
@group(3) @binding(7) var transmittanceLUT: texture_2d<f32>;
${AIR_SUN_WGSL}${buildTerrainLightWGSL(3, 3, 4)}
fn loadHeightTex(coord: vec2<i32>, layer: i32) -> f32 { return textureLoad(heightTexture, coord, layer, 0).r; }
${CUBE_POINT_WGSL}
${SAMPLE_HEIGHT_WGSL}
${buildEdgeStitchWGSL(segments)}
@vertex
fn main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
    let instanceIdx = drawn[instance];
    let chunk = chunks[instanceIdx];
    let face = i32(chunk.face);
    let layer = i32(chunk.layer);
    var uv = vec2<f32>(f32(vertex % ${segments + 1}u), f32(vertex / ${segments + 1}u)) / ${segments}.0;
    let edge = any(uv == vec2<f32>(0.0)) || any(uv == vec2<f32>(1.0));
    if (edge) { uv = snapToStitchedVertex(uv, instanceIdx); }
    let heightMultiplier = max(uniforms.heightScale, 0.0001);
    var height = sampleHeightChunkLocal(uv, chunk.uvOffset, chunk.uvScale, layer);
    let faceUV = chunk.chunkLocation + uv * chunk.chunkSizeUV;
    let cubePoint = getCubePoint(face, faceUV);
    var sphereDir = normalize(cubePoint);
    var worldPosition = uniforms.planetOrigin + sphereDir * (uniforms.planetRadius + (height * heightMultiplier));
    if (edge) {
        let sewn = stitchEdgeVertex(uv, instanceIdx, face, chunk.chunkLocation, chunk.chunkSizeUV, heightMultiplier);
        if (sewn.applied) {
            height = sewn.height;
            worldPosition = sewn.worldPosition;
            sphereDir = normalize(worldPosition - uniforms.planetOrigin);
        }
    }
    var out: Out;
    let viewPos = uniforms.view * vec4<f32>(worldPosition, 1.0);
    out.clip = uniforms.projection * viewPos;
    let faceSize = uniforms.planetRadius * 2.0;
    let wrapped = fract(chunk.chunkLocation / ${GROUND_WRAP_SHARE}) * (faceSize * ${GROUND_WRAP_SHARE});
    out.ground = vec3<f32>(wrapped + uv * chunk.chunkSizeUV * faceSize, height * heightMultiplier);
    out.face = chunk.chunkLocation * faceSize - wrapped;
    out.rel = worldPosition - uniforms.camera;
    out.up = sphereDir;
    out.sunlight = sunOnPath(worldPosition - uniforms.planetOrigin, uniforms.camera - uniforms.planetOrigin, uniforms.sunDir);
    out.land = landLightAt(worldPosition - uniforms.planetOrigin, landSampler);
    // On the cube's face the point is its axis + s u + t v: along u it moves by l (u - l s axis).
    let l = 1.0 / length(cubePoint);
    let st = faceUV * 2.0 - 1.0;
    let axis = getCubePoint(face, vec2<f32>(0.5, 0.5));
    let u = getCubePoint(face, vec2<f32>(1.0, 0.5)) - axis;
    let v = getCubePoint(face, vec2<f32>(0.5, 1.0)) - axis;
    let grow = 1.0 / l;
    out.ud = grow * (u - sphereDir * (dot(sphereDir, u)));
    out.vd = grow * (v - sphereDir * (dot(sphereDir, v)));
    // Texel centres of the tile's edges lie on its edges.
    let size = vec2<f32>(textureDimensions(heightTexture));
    let packed = chunk.neighborLODs.y;
    var material = vec3<f32>(chunk.uvOffset, chunk.uvScale);
    var materialLayer = chunk.layer;
    if ((packed & 16u) == 0u) {
        let levels = (packed >> 20u) & 31u;
        let span = 1u << levels;
        let tile = vec2<u32>(round(chunk.chunkLocation / max(chunk.chunkSizeUV, 1.0e-9)));
        material = vec3<f32>(vec2<f32>(tile & vec2<u32>(span - 1u)) / f32(span), 1.0 / f32(span));
        materialLayer = (packed >> 8u) & 0xFFFu;
    }
    let inner = size - vec2<f32>(1.0);
    out.uv = vec4<f32>(((chunk.uvOffset + uv * chunk.uvScale) * inner + 0.5) / size, ((material.xy + uv * material.z) * inner + 0.5) / size);
    out.tile = (chunk.layer & 0xFFFu) | (materialLayer << 12u) | (((packed >> 4u) & 1u) << 24u);
    return out;
}
`;
}

// Whole repeats per wrap along and across, so that the pattern also wraps when turned (groundSurface.wgsl.js).
function lattices(faceSizeMeters) {
    const wrap = faceSizeMeters * GROUND_WRAP_SHARE;
    const lattice = (period, degrees) => {
        const n = wrap / period, a = degrees * Math.PI / 180;
        return [Math.round(n * Math.cos(a)), Math.round(n * Math.sin(a))];
    };
    // Rounded as groundSurface.wgsl.js prints them: over the planet a last digit moves the patterns by metres.
    const turned = (period, degrees) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)].map(x => Number((x * wrap / period).toFixed(5)));
    const turns = [11, 37, 23, 68, 52, 0, 17, 74, 31];
    const [mosaic, cliff, fields] = GROUND_WIDE;
    const unit = n => n.map(x => x / Math.hypot(...n));
    return {
        over: n => n.map(x => x / wrap), unit,
        near: GROUND_LAYERS.map((l, i) => lattice(l.periodM, turns[i])),
        far: GROUND_LAYERS.map((l, i) => lattice(l.periodM * 4.7, turns[i] + 33)),
        mosaic: lattice(mosaic.periodM, 20),
        fields: [turned(fields.periodM, -35), turned(fields.periodM * 5.3, 12)],
        cliff: [lattice(cliff.periodM, 0), ...[4.6, 21, 97].map((k, i) => turned(cliff.periodM * k, [7, -5, 4][i]))],
    };
}

const number = (x) => { const s = Number(x).toPrecision(9); return /[.e]/.test(s) ? s : `${s}.0`; };
const vector = (values, type = 'f32') => `vec${values.length}<${type}>(${values.map(number).join(', ')})`;
const table = (name, type, rows) => `const ${name} = array<${type}, ${rows.length}>(${rows.join(', ')});`;

/**
 * fine: the close surfaces (within fineEndMeters). live: tiles made of the splat's families; else all far tier.
 * far: the far tier's share of live tiles. water: lakes, rivers and the sea where the near meshes do not draw them.
 * half: 16-bit floats where they are enough. exactAir: the air worked out here, not from TerrainAir's tables.
 */
export function buildTerrainPassFragmentWGSL({ faceSizeMeters, fine = true, live = true, far = true, water = false, rain = false, half = true, exactAir = false, fineEndMeters = 150, deepEndMeters = 16 }) {
    const L = lattices(faceSizeMeters);
    const W = GROUND_WIDE_LAYERS;
    const deep = fine && deepEndMeters > 0;
    const close = live && fine;
    const farTier = far || !live;
    const mean = name => `h3(${GROUND_LAYERS.find(l => l.name === name).mean.map(number).join(', ')})`;
    const weights = ['wGrass', 'wDry', 'wForest', 'wDirt', 'wGravel', 'wRock', 'wSand', 'wSnow', 'wMud'];
    return /* wgsl */`${half ? 'enable f16;' : ''}
alias h = ${half ? 'f16' : 'f32'}; alias h2 = vec2<h>; alias h3 = vec3<h>; alias h4 = vec4<h>;
${FRAME_WGSL}${AIR_FRAME_WGSL}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var heightTexture: texture_2d_array<f32>;
@group(1) @binding(1) var tileNormals: texture_2d_array<f32>;
@group(1) @binding(2) var tileFamilies: texture_2d_array<f32>;
@group(1) @binding(3) var tileBeds: texture_2d_array<f32>;
@group(1) @binding(4) var tileColors: texture_2d_array<f32>;
@group(1) @binding(5) var groundAlbedo: texture_2d_array<f32>;
@group(1) @binding(6) var groundSurface: texture_2d_array<f32>;
@group(1) @binding(7) var groundSampler: sampler;
@group(1) @binding(8) var wideSampler: sampler;
@group(1) @binding(9) var clampSampler: sampler;
@group(1) @binding(10) var airTable: texture_2d_array<f32>;
@group(1) @binding(11) var<uniform> air: AirFrame;
@group(1) @binding(12) var transmittanceLUT: texture_2d<f32>;
${exactAir ? getAerialPerspectiveWGSL() : AIR_READ_WGSL}
${water ? createWaterWgsl({ group: 2, riverField: true }) : ''}
const G_ROCK: i32 = 5;
${table('NEAR', 'vec4<f32>', L.near.map((n, i) => vector([...L.over(n), GROUND_LAYERS[i].slope / Math.hypot(...L.over(n)), deep ? GROUND_LAYERS[i].deepM ?? 0 : 0])))}
${table('NEAR_WIDE', 'vec2<f32>', L.far.map(n => vector(L.over(n))))}
${table('MEAN', 'vec3<f32>', GROUND_LAYERS.map(l => vector(l.mean)))}
${table('CLIFF', 'vec4<f32>', L.cliff.map(n => vector([...L.over(n), ...L.unit(n).map(x => x * GROUND_WIDE[1].slope)])))}
const MOSAIC = ${vector(L.over(L.mosaic))};
const MOSAIC_TURN = ${vector(L.unit(L.mosaic).map(x => x * GROUND_WIDE[0].slope))};
const FIELDS = ${vector(L.over(L.fields[0]))};
const FIELDS_WIDE = ${vector(L.over(L.fields[1]))};

struct In {
    @builtin(position) pos: vec4<f32>,
    @location(0) ground: vec3<f32>,
    @location(1) rel: vec3<f32>,
    @location(2) uv: vec4<f32>,
    @location(3) up: vec3<f32>,
    @location(4) land: vec2<f32>,
    @location(5) ud: vec3<f32>,
    @location(6) vd: vec3<f32>,
    @location(7) @interpolate(flat) face: vec2<f32>,
    @location(8) @interpolate(flat) tile: u32,
    @location(9) sunlight: vec3<f32>,
};

fn turnedUv(n: vec2<f32>, p: vec2<f32>) -> vec2<f32> { return vec2<f32>(dot(n, p), n.x * p.y - n.y * p.x); }
fn turnedSlope(n: h2, s: h2) -> h2 { return s.x * n + s.y * h2(-n.y, n.x); }
fn step3(a: h, b: h, x: h) -> h { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }

// How a pattern lies at a lattice coordinate: which variant, and 1 or -1 for turned around (groundSurface.wgsl.js groundLie).
fn lieOf(uv: vec2<f32>, variants: f32) -> vec2<f32> {
    var p = fract(floor(uv).xyx * 0.1031);
    p += dot(p, p.yzx + 33.33);
    let k = fract((p.x + p.y) * p.z) * variants;
    return vec2<f32>(floor(k), select(-1.0, 1.0, fract(k) < 0.5));
}

// The side a steep place faces most: what rock and cliffs are drawn from. x, y: along the ground's coordinate; else from above.
struct Side { p: vec2<f32>, q: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, ax: h3, ay: h3, seed: f32 };

struct Cliff { gradient: h3, open: h, tint: h };
fn cliffAt(side: Side, distance: f32) -> Cliff {
    let k = clamp(log2(max(distance, 1.0)) * ${number(1 / Math.log2(4.6))} - ${number(Math.log2(110) / Math.log2(4.6))}, 0.0, 3.0);
    let i = i32(k);
    let blend = step3(0.78, 1.0, h(fract(k)));
    let n = CLIFF[i];
    let cell = turnedUv(n.xy, side.q);
    let lie = lieOf(cell + side.seed, ${GROUND_WIDE[1].variants}.0);
    // Softer than the footprint: sharper, a far cliff flickers as one moves.
    var s = h4(textureSampleGrad(groundSurface, wideSampler, select(cell, turnedUv(n.xy, side.p), i == 0) * lie.y, ${W.cliff} + i32(lie.x),
        turnedUv(n.xy, side.dx) * 1.4, turnedUv(n.xy, side.dy) * 1.4));
    var slope = turnedSlope(h2(n.zw), (s.xy * 2.0 - 1.0) * h(lie.y));
    if (blend > 0.0) {
        let m = CLIFF[min(i + 1, 3)];
        let cell2 = turnedUv(m.xy, side.q);
        let lie2 = lieOf(cell2 + side.seed, ${GROUND_WIDE[1].variants}.0);
        let t = h4(textureSampleGrad(groundSurface, wideSampler, cell2 * lie2.y, ${W.cliff} + i32(lie2.x), turnedUv(m.xy, side.dx) * 1.4, turnedUv(m.xy, side.dy) * 1.4));
        slope = mix(slope, turnedSlope(h2(m.zw), (t.xy * 2.0 - 1.0) * h(lie2.y)), blend);
        s = mix(s, t, blend);
    }
    return Cliff(slope.x * side.ax + slope.y * side.ay, s.z, s.w);
}

${close ? `
struct Fine { albedo: h3, height: h, gradient: h3, rough: h, open: h };
fn fineAt(layer: i32, p: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, ax: h3, ay: h3) -> Fine {
    let n = NEAR[layer];
    let uv = turnedUv(n.xy, p);
    // A little softer than the footprint: nothing but the mips keeps it still in motion.
    let gx = turnedUv(n.xy, dx) * 1.15;
    let gy = turnedUv(n.xy, dy) * 1.15;
    let c = h4(textureSampleGrad(groundAlbedo, groundSampler, uv, layer, gx, gy));
    let s = h4(textureSampleGrad(groundSurface, groundSampler, uv, layer, gx, gy));
    let slope = turnedSlope(h2(n.xy * n.z), s.xy * 2.0 - 1.0);
    return Fine(c.rgb, c.a, slope.x * ax + slope.y * ay, s.z, s.w);
}
` : ''}

// Daylight on the ground (terrainChunkFragmentShaderBuilder.js terrainLight).
fn lightAt(n: h3, shape: h3, up: h3, sunDir: h3, sun: h3, ambient: h3, open: h, leaf: h, land: h2) -> h3 {
    let sunUp = dot(up, sunDir);
    let day = step3(-0.10, 0.20, sunUp);
    let facing = dot(n, sunDir);
    var direct = max(facing, 0.0) * saturate(facing + 2.0 * open - 1.0);
    direct = mix(direct, max((facing + 0.35) / 1.35, 0.0) * mix(h(0.75), 1.0, open), 0.6 * leaf);
    direct *= step3(-0.06, 0.18, dot(shape, sunDir)) * land.x;
    let skyTint = ambient / max(dot(ambient, h3(0.333)), 1.0e-4);
    let overhead = 0.5 + 0.5 * dot(n, up);
    let sky = dot(sun, h3(0.333)) * 0.34 * day * mix(h3(1.0), skyTint, 0.8);
    let covered = 1.0 - land.y;
    let bounce = sun * max(sunUp, 0.0) * h3(0.115, 0.105, 0.070) * mix(h(0.55), 1.0, land.x) * (covered + (1.0 - overhead) * 0.8);
    let hollow = mix(open, 1.0, 0.45);
    let light = sun * direct + (ambient + sky * overhead * land.y + bounce) * hollow;
    return max(light, h3(mix(h(0.30), 0.06, day) * mix(1.0, hollow, day)));
}

@fragment
fn main(in: In) -> @location(0) vec4<f32> {
    let layer = i32(in.tile & 4095u);
    let distance = length(in.rel);
    let up32 = normalize(in.up);
    let up = h3(up32);
    let ud = h3(in.ud);
    let vd = h3(in.vd);
    let dx = dpdx(in.ground);
    let dy = dpdy(in.ground);
    let toEye = h3(-in.rel / max(distance, 0.01));

    // The tile's normal, about the planet's: its tangent lies level, across the planet's axis.
    let e = textureSampleLevel(tileNormals, clampSampler, in.uv.xy, layer, 0.0).rg * 2.0 - 1.0;
    var tx = vec3<f32>(-up32.z, 0.0, up32.x);
    if (abs(up32.y) > 0.99) { tx = vec3<f32>(0.0, up32.z, -up32.y); }
    tx = normalize(tx);
    let tileNormal32 = normalize(e.x * tx + e.y * cross(up32, tx) + (1.0 - abs(e.x) - abs(e.y)) * up32);
    let tileNormal = h3(tileNormal32);

    var albedo = ${mean('mud')};
    var gradient = h3(0.0);
    var open: h = 1.0;
    var leaf: h = 0.0;
    var rough: h = 0.8;
    var wet: h = 0.35;
    var pool: h = 0.0;
    ${live && farTier ? 'let share = select(h(smoothstep(frame.fadeStart, frame.fadeEnd, distance)), 0.0, frame.fadeEnd <= frame.fadeStart);\n    let farShare = select(share, 1.0, (in.tile >> 24u) != 0u);' : `let farShare: h = ${live ? '0.0' : '1.0'};`}
    ${live && water ? `// Nothing of the sea's bed is seen through this much water.
    if (!(waterParams.enabled != 0u && waterParams.sea.y > 0.5 && in.ground.z < waterParams.sea.x - 60.0))` : ''} {
        let slope = h(1.0 - saturate(dot(tileNormal32, up32)));
        let q = vec3<f32>(in.ground.xy + in.face, in.ground.z);

        // All differences broader than the mosaic's: fields, and the same larger, which also bends the mosaic's cells.
        // x lush, y bare, z lively, w dry.
        // The bends are lengths: in half floats they would step.
        let fa = (textureSampleGrad(groundSurface, wideSampler, turnedUv(FIELDS, q.xy), ${W.fields}, turnedUv(FIELDS, dx.xy), turnedUv(FIELDS, dy.xy)));
        let fb = (textureSampleGrad(groundSurface, wideSampler, turnedUv(FIELDS_WIDE, q.xy), ${W.fields}, turnedUv(FIELDS_WIDE, dx.xy), turnedUv(FIELDS_WIDE, dy.xy)));
        let broad = saturate(fa + 0.7 * (fb - 0.5));
        let b = h4(broad);
        let wideBend = (fb.xw - 0.5) * 160.0;
        let lie = lieOf(turnedUv(MOSAIC, q.xy + wideBend), ${GROUND_WIDE[0].variants}.0);
        let uvA = turnedUv(MOSAIC, in.ground.xy + wideBend) * lie.y;
        // Nearby a little sharper than the footprint: seen flat along the ground the pattern would blur away.
        let sharp = mix(0.65, 1.0, smoothstep(800.0, 2000.0, distance));
        let axA = turnedUv(MOSAIC, dx.xy) * sharp;
        let ayA = turnedUv(MOSAIC, dy.xy) * sharp;
        var a = h4(0.5);
        if (distance < 9000.0) {
            a = mix(h4(textureSampleGrad(groundSurface, wideSampler, uvA, ${W.masks} + i32(lie.x), axA, ayA)), a, h(smoothstep(5000.0, 9000.0, distance)));
        }
        let edge = 0.6 * (a.x - 0.5) + 0.5 * (b.y - 0.5) + 0.35 * (a.y - 0.5);
        let steep = step3(0.15, 0.31, slope + 0.16 * edge);
        let shed = step3(0.20, 0.40, slope + 0.18 * edge);
        let ledges = step3(0.35, 0.62, 0.55 * a.x + 0.45 * b.x + slope * 1.2);
        let dry = step3(0.39, 0.75, a.w * 0.45 + b.w * 0.55 + 0.35 * slope);
        let bareness = a.y * 0.6 + b.y * 0.4;
        let woods = b.x * 0.5 + a.x * 0.25 + 0.25 * (1.0 - a.w);
        let tone = (1.0 + 0.34 * (b.x - 0.5) + 0.40 * (a.x - 0.5) + 0.22 * (b.w - 0.5)) * h3(1.0 + 0.16 * (b.w - 0.5), 1.0, 1.0 - 0.18 * (b.w - 0.5));

        var rock: h = 0.0;
        var snow: h = 0.0;
        var farColor = h3(0.0);
        var farRock: h = 0.0;
        ${farTier ? `
        // The far tiers: the fields and the bare rock of the close ground go on in the tile's own colour.
        ${live ? 'if (farShare > 0.0) ' : ''}{
            let coarse = h3(textureSampleLevel(tileColors, clampSampler, in.uv.xy, layer, 0.0).rgb);
            let bright = dot(coarse, h3(0.3333));
            let hue = coarse.b / max(coarse.g, 0.001);
            let dim = 1.0 - step3(0.16, 0.24, bright);
            let organic = (1.0 - step3(0.42, 0.58, hue)) * dim;
            let stony = step3(0.80, 0.86, hue) * dim;
            let snowy = step3(0.35, 0.6, bright);
            var field = mix(${mean('grass')}, ${mean('dryGrass')}, dry);
            field = mix(field, ${mean('forest')}, 0.45 * step3(0.60, 0.80, woods));
            field = mix(field, ${mean('dirt')}, step3(0.64, 0.84, bareness + 0.9 * slope));
            farColor = mix(coarse, field, 0.85 * organic);
            farRock = mix(max(steep, stony * ledges), shed, snowy);
            rock = farRock * farShare;
            leaf = 0.85 * organic * (1.0 - steep) * farShare;
            snow = snowy * farShare;
        }` : ''}
        ${live ? `
        let near = 1.0 - farShare;
        var relief = h4(0.5, 0.5, 0.9, 0.5);
        var nearRock: h = 0.0;
        var first = 0;
        var second = 0;
        var w1: h = 1.0;
        var w2: h = 0.0;
        var cold: h = 0.0;
        ${farTier ? 'if (farShare < 1.0) ' : ''}{
            // What the families are here: organic, mineral, soil, cold.
            let materialLayer = i32((in.tile >> 12u) & 4095u);
            var families = h4(textureSampleLevel(tileFamilies, clampSampler, in.uv.zw, materialLayer, 0.0));
            let total = families.x + families.y + families.z + families.w;
            families = select(h4(1.0, 0.0, 0.0, 0.0), families / max(total, 0.001), total > 0.001);
            var bed: h = 0.0;
            if (families.z > 0.02) { bed = saturate(h(textureSampleLevel(tileBeds, clampSampler, in.uv.zw, materialLayer, 0.0).r) / families.z); }
            if (distance < 1400.0) {
                relief = mix(h4(textureSampleGrad(groundSurface, wideSampler, uvA, ${W.slopes} + i32(lie.x), axA, ayA)), relief, h(smoothstep(900.0, 1400.0, distance)));
            }
            cold = families.w;
            let lowland = 1.0 - step3(0.02, 0.10, slope);
            let bare = step3(0.66, 0.78, bareness + 0.9 * slope);
            let wood = step3(0.60, 0.74, woods) * (1.0 - bare);
            let scree = step3(0.07, 0.19, slope + 0.10 * (b.y - 0.5)) * step3(0.36, 0.60, bareness + 0.25 * a.z);
            let stones = a.z * step3(0.35, 0.6, b.y + 0.5 * slope);
            let organic = families.x * (1.0 - steep);
            let turf = organic * (1.0 - bare) * (1.0 - scree) * (1.0 - 0.85 * stones);
            let mineral = families.y * (1.0 - steep);
            let poor = step3(0.4, 0.6, bareness);
            let soil = families.z * (1.0 - 0.9 * steep);
            let dune = 1.0 - step3(0.50, 0.66, bareness);
            let grown = turf * (1.0 - 0.9 * wood);
            let grit = mineral * (1.0 - ledges);
            let loose = soil * (1.0 - bed);
            let wGrass = grown * (1.0 - dry);
            let wDry = grown * dry + grit * 0.45 * (1.0 - poor) * (0.4 + 0.6 * lowland);
            let wForest = turf * wood * 0.9;
            let wDirt = organic * bare * (1.0 - scree);
            let wGravel = organic * max(scree, 0.85 * stones) + grit * mix(h(0.55), 1.0, poor) + loose * (1.0 - dune) * 0.75;
            let wRock = (families.x + families.y + 0.9 * families.z) * steep + mineral * ledges + families.w * shed;
            let wSand = loose * mix(h(0.25), 1.0, dune);
            let wSnow = families.w * (1.0 - shed);
            let wMud = soil * bed;
            // The three largest. A weight and its index are one number, so min and max alone sort them.
            var m1 = 0.0; var m2 = 0.0; var m3 = 0.0; var key = 0.0; var top = 0.0;
            ${weights.map((w, i) => `key = floor(f32(${w}) * 4096.0) * 16.0 + ${i}.0; top = max(m1, key); key = min(m1, key); m1 = top; top = max(m2, key); key = min(m2, key); m2 = top; m3 = max(m3, key);`).join('\n            ')}
            first = i32(m1) & 15;
            second = i32(m2) & 15;
            let w3 = h(floor(m3 / 16.0) / 4096.0);
            // The third fades the second out before they change places.
            w2 = max(h(floor(m2 / 16.0) / 4096.0) - w3, 0.0);
            w1 = max(h(floor(m1 / 16.0) / 4096.0) - 0.5 * w3, 0.0005);
            nearRock = saturate(wRock);
            rock += nearRock * near;
            snow += cold * near;
            leaf += saturate((wGrass + wDry) / max(w1 + w2 + w3, 0.001)) * near;
        }` : ''}

        var cliff = Cliff(h3(0.0), 1.0, 0.5);
        var side: Side;
        if (rock > 0.02) {
            // Where the side changes the border is ragged, as a crack is.
            let ragged = 0.30 * (a.y - 0.5) + 0.20 * (a.w - 0.5);
            let w = abs(h3(dot(tileNormal, normalize(ud)), dot(tileNormal, normalize(vd)), dot(tileNormal, up) * 0.80)) + h3(ragged, -ragged, 0.0);
            side = Side(in.ground.xy, q.xy, dx.xy, dy.xy, ud, vd, 91.0);
            if (w.x > max(w.y, w.z)) { side = Side(in.ground.yz, q.yz, dx.yz, dy.yz, vd, up, 0.0); }
            else if (w.y > w.z) { side = Side(in.ground.xz, q.xz, dx.xz, dy.xz, ud, up, 517.0); }
            cliff = cliffAt(side, distance);
        }
        let rockTone = 0.66 + 0.76 * cliff.tint;
        // What is left of the small hollows' shade where they are not drawn.
        open = 0.77;
        ${live ? `
        ${farTier ? 'if (farShare < 1.0) ' : ''}{
            var over = w2 / (w1 + w2);
            let plain = mix(h3(MEAN[first]), h3(MEAN[second]), over);
            var color = plain;
            var soft = (1.0 - nearRock) * (1.0 - 0.6 * cold);
            let hummocks = turnedSlope(h2(MOSAIC_TURN), (relief.xy * 2.0 - 1.0) * h(lie.y));
            var bumps = (hummocks.x * ud + hummocks.y * vd) * (soft * 0.8);
            var hollows: h = 0.86;
            var grain: h = 0.8;
            ${fine ? `
            let fineFade = h(1.0 - smoothstep(${number(fineEndMeters * 0.6)}, ${number(fineEndMeters)}, distance));
            if (fineFade > 0.0) {
                // The broadest pattern bends the fine ones, so that their repeats do not line up. (A finer one would smear them.)
                var bend = (broad.xwy - 0.5) * 4.0;
                let rock1 = first == G_ROCK;
                let rock2 = second == G_ROCK;
                ${deep ? `
                // Close by, stones and rock hide each other: the point on their relief this view ray meets.
                let depth1 = NEAR[first].w;
                if (distance < ${number(deepEndMeters)} && depth1 > 0.0) {
                    let along = tileNormal - toEye / max(dot(tileNormal, toEye), 0.18);
                    let shift = vec3<f32>(h3(dot(along, ud), dot(along, vd), dot(along, up)));
                    let depth = depth1 * (1.0 - smoothstep(${number(deepEndMeters * 0.5)}, ${number(deepEndMeters)}, distance));
                    var p = in.ground.xy + bend.xy;
                    var s = shift.xy;
                    if (rock1) {
                        if (side.seed == 0.0) { p = in.ground.yz + bend.yz; s = shift.yz; }
                        else if (side.seed == 517.0) { p = in.ground.xz + bend.xz; s = shift.xz; }
                    }
                    let n = NEAR[first].xy;
                    let px = dx.xy + vec2<f32>(0.0, dx.z);
                    let py = dy.xy + vec2<f32>(0.0, dy.z);
                    let mip = max(0.0, 10.0 + 0.5 * log2(max(dot(n, n) * min(dot(px, px), dot(py, py)), 1.0e-12)));
                    let at = turnedUv(n, p);
                    let stride = turnedUv(n, s * depth);
                    // Three steps toward the height found, each from the last: shapes are shallow, so this settles.
                    var z = 0.5;
                    z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, wideSampler, at + stride * (z - 0.5), first, mip).a, 0.7);
                    z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, wideSampler, at + stride * (z - 0.5), first, mip).a, 0.6);
                    z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, wideSampler, at + stride * (z - 0.5), first, mip).a, 0.5);
                    bend += shift * ((z - 0.5) * depth);
                }` : ''}
                // Fine surfaces, interlocked by height. Rock is drawn from its side.
                let g = in.ground + bend;
                var sideP = g.xy;
                if (side.seed == 0.0) { sideP = g.yz; } else if (side.seed == 517.0) { sideP = g.xz; }
                var fine = fineAt(first, select(g.xy, sideP, rock1), select(dx.xy, side.dx, rock1), select(dy.xy, side.dy, rock1), select(ud, side.ax, rock1), select(vd, side.ay, rock1));
                // Under this share the second never stands out of the first.
                if (over > 0.13) {
                    let s2 = fineAt(second, select(g.xy, sideP, rock2), select(dx.xy, side.dx, rock2), select(dy.xy, side.dy, rock2), select(ud, side.ax, rock2), select(vd, side.ay, rock2));
                    let h1 = fine.height + 1.10 - over;
                    let h2 = s2.height + over + 0.10;
                    let top = max(h1, h2) - 0.22;
                    let m1 = max(h1 - top, 0.0);
                    let m2 = max(h2 - top, 0.0);
                    // Far off the pieces are too small to interlock: the same ones would stand out of every repeat.
                    over = mix(m2 / max(m1 + m2, 0.001), over, h(smoothstep(18.0, 75.0, distance)));
                    fine = Fine(mix(fine.albedo, s2.albedo, over), 0.5, mix(fine.gradient, s2.gradient, over), mix(fine.rough, s2.rough, over), mix(fine.open, s2.open, over));
                } else { over = 0.0; }
                // The same surface, larger and turned, so that its repeats do not show.
                if (!rock1) {
                    let n = NEAR_WIDE[first];
                    let big = h3(textureSampleGrad(groundAlbedo, groundSampler, turnedUv(n, in.ground.xy), first, turnedUv(n, dx.xy), turnedUv(n, dy.xy)).rgb);
                    fine.albedo *= mix(h3(1.0), clamp(big / h3(MEAN[first]), h3(0.55), h3(1.7)), 0.65 * (1.0 - over));
                }
                color = mix(plain, fine.albedo, fineFade);
                bumps += fine.gradient * (fineFade * mix(h(0.8), 0.6, nearRock));
                hollows = mix(hollows, fine.open, fineFade);
                grain = fine.rough;
            }` : ''}
            // Broad colour: patches a field or a hillside wide.
            albedo = color * mix(tone, h3(rockTone), nearRock) * near;
            gradient = bumps * near;
            open = mix(hollows * mix(1.0, relief.z, soft), open, farShare);
            rough = mix(grain, rough, farShare);
        } ${farTier ? 'else { albedo = h3(0.0); }' : ''}` : 'albedo = h3(0.0);'}
        ${farTier ? `albedo += mix(farColor * tone, ${mean('rock')} * rockTone, farRock) * farShare;` : ''}
        gradient += cliff.gradient * (0.6 * rock);
        open *= mix(1.0, cliff.open, rock);
        ${rain ? `
        let dryable = 1.0 - snow;
        wet = dryable * mix(h(0.42), 0.30, rock);
        pool = dryable * (1.0 - rock) * (1.0 - farShare) * (1.0 - step3(0.0015, 0.010, slope)) * (1.0 - step3(0.36, 0.50, 0.6 * a.x + 0.4 * b.x));` : ''}
    }

    var shape = mix(up, tileNormal, h(1.0 - smoothstep(frame.normalStart, frame.normalEnd, distance)));
    shape = normalize(select(shape, -shape, dot(shape, up) < 0.0));
    var n = normalize(shape - (gradient - shape * dot(gradient, shape)));
    let land = h2(in.land);
    ${rain ? `
    // Rain: soaked ground is darker, and lies smooth under its puddles.
    let wetness = h(frame.wetness);
    if (wetness > 0.0) {
        pool *= step3(0.35, 0.9, wetness) * (1.0 - farShare);
        albedo *= 1.0 - wet * wetness - 0.35 * pool;
        n = normalize(mix(n, up, pool));
    }` : ''}
    var color = albedo * lightAt(n, shape, up, h3(frame.sunDir), h3(frame.sun), h3(frame.ambient), open, leaf, land);
    ${rain ? `
    if (wetness > 0.0) {
        // A film of water over it, a mirror in the puddles.
        let grazing = 1.0 - max(dot(n, toEye), 0.0);
        let g2 = grazing * grazing;
        let mirror = 0.02 + 0.98 * g2 * g2 * grazing;
        let film = wetness * mix(0.16 * open, 1.0, pool);
        // The sky is grey while it rains.
        let fog = h3(frame.fogColor);
        let skyLight = mix(h3(dot(fog, h3(0.30, 0.45, 0.25))), fog, 0.25) * (0.5 + 0.5 * land.y);
        color = mix(color, skyLight, saturate(mirror * film));
    }` : ''}
    ${water ? `
    // Lake, river and sea water (exact shoreline per pixel). Past the near meshes the ground's height for it is the
    // tile's texel height, not the triangles' (waterWgsl.js waterCoverHeight).
    var texHeight = -1.0e30;
    if (waterParams.sea.w > 0.5 && distance > waterParams.near.x) {
        let last = vec2<i32>(textureDimensions(heightTexture)) - 1;
        let at = clamp(in.uv.xy * vec2<f32>(last + 1) - 0.5, vec2<f32>(0.0), vec2<f32>(last));
        let i = vec2<i32>(at);
        let j = min(i + 1, last);
        let f = fract(at);
        texHeight = mix(mix(textureLoad(heightTexture, i, layer, 0).r, textureLoad(heightTexture, vec2<i32>(j.x, i.y), layer, 0).r, f.x),
            mix(textureLoad(heightTexture, vec2<i32>(i.x, j.y), layer, 0).r, textureLoad(heightTexture, j, layer, 0).r, f.x), f.y);
    }
    color = h3(applyWater(vec3<f32>(color), frame.camera + in.rel, frame.camera, frame.planetOrigin, frame.sunDir, frame.sun, frame.ambient, clampSampler, texHeight));
    // Water debug views 6 and 7 (who draws the water): flat colours, no haze.
    if (waterParams.debugMode == 6u || waterParams.debugMode == 7u) { return vec4<f32>(vec3<f32>(color), 1.0); }` : ''}
    ${exactAir ? `
    let reach = smoothstep(air.sun.x, air.sun.y, distance);
    var through = vec3<f32>(1.0);
    var light = vec3<f32>(0.0);
    if (reach > 0.001) {
        let ap = ap_computeSimple(transmittanceLUT, clampSampler, frame.camera + in.rel, frame.camera, frame.sunDir, frame.planetOrigin,
            air.planet.x, air.planet.y, air.planet.z, air.planet.w, air.rayleigh.xyz, air.rayleigh.w, air.sun.z, air.sun.w);
        through = mix(vec3<f32>(1.0), ap.transmittance, reach);
        light = ap.inscatter * (mix(0.2, 1.0, smoothstep(-0.10, 0.10, dot(up32, frame.sunDir))) * reach);
    }
    return vec4<f32>(vec3<f32>(color) * through + light, 1.0);` : `
    if (distance <= air.sun.x) { return vec4<f32>(vec3<f32>(color), 1.0); }
    return vec4<f32>(throughAir(vec3<f32>(color), in.ground.z, distance, vec3<f32>(toEye), frame.sunDir, in.sunlight), 1.0);`}
}
`;
}
