import { biomeCoverWGSL, unpackBiomeIceWGSL } from '../../../../../templates/terrain-shaders/biomeLandscape.wgsl.js';
// Close and middle ground (terrainShader.groundMaterials): what the terrain is
// made of at a pixel, from the textures of groundMaterials.js.
//
// The tile's splat gives four families (organic, mineral, soil, cold). Each is
// a mosaic of surfaces: a wide pattern, the slope and the family shares decide
// which. The two strongest are drawn and interlock by their heights. Rock on
// steep ground is drawn from the sides. Past FINE_END the textures have
// averaged out: their mean colours and the wide patterns remain.

import { GROUND_LAYERS, GROUND_WIDE, GROUND_WIDE_LAYERS } from '../../materials/groundMaterials.js';

/** Metres after which the ground coordinate repeats, as a share of the cube face: a power of two, so it stays exact. */
export const GROUND_WRAP_SHARE = 1 / 128;

// Whole repeats per wrap along and across, so that the pattern also wraps when turned.
function lattice(wrapM, periodM, degrees) {
    const n = wrapM / periodM, a = degrees * Math.PI / 180;
    return [Math.round(n * Math.cos(a)), Math.round(n * Math.sin(a))];
}

const vec = (values, n) => `vec${n}<f32>(${values.map(v => Number(v).toFixed(5)).join(', ')})`;
const table = (name, type, rows) => `const ${name} = array<${type}, ${rows.length}>(${rows.join(', ')});`;

/** close, farTier: with the close ground, with the far tiers' (and the way from one to the other). */
export function buildGroundSurfaceWGSL({ faceSizeMeters, fineEndMeters = 150, deepEndMeters = 16, close = true, farTier = true, biomeLandscape = null }) {
    const wrap = faceSizeMeters * GROUND_WRAP_SHARE;
    const turns = [11, 37, 23, 68, 52, 0, 17, 74, 31, 58, 42, 65];
    const near = GROUND_LAYERS.map((l, i) => lattice(wrap, l.periodM, turns[i]));
    const far = GROUND_LAYERS.map((l, i) => lattice(wrap, l.periodM * 4.7, turns[i] + 33));
    const mosaic = lattice(wrap, GROUND_WIDE[0].periodM, 20);
    // For the coordinate that is not wrapped: any period and turn.
    const turned = (periodM, degrees) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)].map(x => x * wrap / periodM);
    const fields = [turned(GROUND_WIDE[2].periodM, -35), turned(GROUND_WIDE[2].periodM * 5.3, 12)];
    const cliff = [lattice(wrap, GROUND_WIDE[1].periodM, 0), ...[4.6, 21, 97].map((k, i) => turned(GROUND_WIDE[1].periodM * k, [7, -5, 4][i]))];
    const W = GROUND_WIDE_LAYERS;
    const n = GROUND_LAYERS.length;
    return (biomeLandscape ? biomeCoverWGSL(biomeLandscape) : '') + /* wgsl */`
const GROUND_COUNT: i32 = ${n};
const GROUND_WRAP: f32 = ${wrap.toFixed(4)};
const GROUND_FINE_END: f32 = ${fineEndMeters.toFixed(1)};
const GROUND_DEEP_END: f32 = ${deepEndMeters.toFixed(1)};
// Depth (m) of the relief seen close by; 0 for what has none to show.
${table('GROUND_DEPTH', 'f32', GROUND_LAYERS.map(l => (deepEndMeters > 0 ? l.deepM ?? 0 : 0).toFixed(4)))}
const G_GRASS: i32 = 0; const G_DRY: i32 = 1; const G_FOREST: i32 = 2; const G_DIRT: i32 = 3; const G_GRAVEL: i32 = 4;
const G_ROCK: i32 = 5; const G_SAND: i32 = 6; const G_SNOW: i32 = 7; const G_MUD: i32 = 8; const G_TUNDRA: i32 = 9;
const G_ICE: i32 = 10; const G_MARSH: i32 = 11;
${table('GROUND_MEAN', 'vec3<f32>', GROUND_LAYERS.map(l => vec(l.mean, 3)))}
${table('GROUND_SLOPE', 'f32', GROUND_LAYERS.map(l => l.slope.toFixed(3)))}
${table('GROUND_NEAR', 'vec2<f32>', near.map(v => vec(v, 2)))}
${table('GROUND_FAR', 'vec2<f32>', far.map(v => vec(v, 2)))}
const MOSAIC = ${vec(mosaic, 2)};
const FIELDS = ${vec(fields[0], 2)};
const FIELDS_WIDE = ${vec(fields[1], 2)};
const MOSAIC_SLOPE: f32 = ${GROUND_WIDE[0].slope.toFixed(3)};
${table('CLIFF_N', 'vec2<f32>', cliff.map(v => vec(v, 2)))}
const CLIFF_SLOPE: f32 = ${GROUND_WIDE[1].slope.toFixed(3)};
const L_MOSAIC: i32 = ${W.masks};
const L_MOSAIC_SLOPE: i32 = ${W.slopes};
const L_CLIFF: i32 = ${W.cliff};
const L_FIELDS: i32 = ${W.fields};
const MOSAIC_VARIANTS: f32 = ${GROUND_WIDE[0].variants.toFixed(1)};
const CLIFF_VARIANTS: f32 = ${GROUND_WIDE[1].variants.toFixed(1)};

// The ground coordinate at a pixel and how it runs over the world. A height field over (g.x, g.y, h) has the world
// gradient x * ud + y * vd + h * up.
struct GroundFrame {
    g: vec3<f32>, q: vec3<f32>, dx: vec3<f32>, dy: vec3<f32>,
    ud: vec3<f32>, vd: vec3<f32>, up: vec3<f32>,
};
struct GroundSample { albedo: vec3<f32>, height: f32, gradient: vec3<f32>, rough: f32, open: f32 };
// wet: how far rain darkens it; pool: how far it stands in water when all is soaked.
// gradient: what it adds to the slope of the mesh.
struct Ground { albedo: vec3<f32>, gradient: vec3<f32>, open: f32, rough: f32, leaf: f32, wet: f32, pool: f32 };

// face: the coordinate along the cube face, not wrapped (good to a few cm).
fn groundFrame(g: vec3<f32>, face: vec2<f32>, dx: vec3<f32>, dy: vec3<f32>, up: vec3<f32>) -> GroundFrame {
    let a = abs(up);
    var axis: vec3<f32>; var u: vec3<f32>; var v: vec3<f32>;
    if (a.x >= a.y && a.x >= a.z) {
        let s = sign(up.x); axis = vec3<f32>(s, 0.0, 0.0); u = vec3<f32>(0.0, 0.0, -s); v = vec3<f32>(0.0, 1.0, 0.0);
    } else if (a.y >= a.z) {
        let s = sign(up.y); axis = vec3<f32>(0.0, s, 0.0); u = vec3<f32>(1.0, 0.0, 0.0); v = vec3<f32>(0.0, 0.0, -s);
    } else {
        let s = sign(up.z); axis = vec3<f32>(0.0, 0.0, s); u = vec3<f32>(s, 0.0, 0.0); v = vec3<f32>(0.0, 1.0, 0.0);
    }
    let l = 1.0 / dot(up, axis);
    var f: GroundFrame;
    f.g = g; f.q = vec3<f32>(face, g.z); f.dx = dx; f.dy = dy; f.up = up;
    f.ud = l * (u - axis * (dot(up, u) * l));
    f.vd = l * (v - axis * (dot(up, v) * l));
    return f;
}

fn latticeUv(n: vec2<f32>, p: vec2<f32>) -> vec2<f32> { return vec2<f32>(dot(n, p), dot(vec2<f32>(-n.y, n.x), p)) / GROUND_WRAP; }
// A slope along the turned axes, back along the ground's.
fn latticeSlope(n: vec2<f32>, s: vec2<f32>) -> vec2<f32> { return (s.x * n + s.y * vec2<f32>(-n.y, n.x)) / length(n); }

// How a pattern lies at a lattice coordinate: which variant, and 1 or -1 for turned around. All share one border, the
// same either way round, so nothing shows where they meet and nothing repeats in rows.
fn groundLie(uv: vec2<f32>, variants: f32) -> vec2<f32> {
    var p = fract(floor(uv).xyx * 0.1031);
    p += dot(p, p.yzx + 33.33);
    let k = fract((p.x + p.y) * p.z) * variants;
    return vec2<f32>(floor(k), select(-1.0, 1.0, fract(k) < 0.5));
}
// All differences broader than the mosaic's: fields of 16 m to 1 km, and the same larger. x lush, y bare, z lively, w dry.
// bend (m): how far the larger ones push the mosaic about, so that its lattice has no straight lines.
struct GroundBroad { b: vec4<f32>, bend: vec2<f32> };
fn groundBroad(q: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>) -> GroundBroad {
    let a = textureSampleGrad(groundSurface, groundWideSampler, latticeUv(FIELDS, q), L_FIELDS, latticeUv(FIELDS, dx), latticeUv(FIELDS, dy));
    let b = textureSampleGrad(groundSurface, groundWideSampler, latticeUv(FIELDS_WIDE, q), L_FIELDS, latticeUv(FIELDS_WIDE, dx), latticeUv(FIELDS_WIDE, dy));
    return GroundBroad(clamp(a + 0.7 * (b - 0.5), vec4<f32>(0.0), vec4<f32>(1.0)), (b.xw - 0.5) * 160.0);
}

fn groundTap(layer: i32, n: vec2<f32>, p: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, ax: vec3<f32>, ay: vec3<f32>) -> GroundSample {
    let uv = latticeUv(n, p);
    // A little softer than the footprint: nothing but the mips keeps it still in motion.
    let gx = latticeUv(n, dx) * 1.15;
    let gy = latticeUv(n, dy) * 1.15;
    let c = textureSampleGrad(groundAlbedo, groundSampler, uv, layer, gx, gy);
    let s = textureSampleGrad(groundSurface, groundSampler, uv, layer, gx, gy);
    let slope = latticeSlope(n, (s.xy * 2.0 - 1.0) * GROUND_SLOPE[layer]);
    return GroundSample(c.rgb, c.a, slope.x * ax + slope.y * ay, s.z, s.w);
}

// How much of each side of a steep place faces: along u, along v, up.
fn groundSides(f: GroundFrame, normal: vec3<f32>) -> vec3<f32> {
    var w = abs(vec3<f32>(dot(normal, normalize(f.ud)), dot(normal, normalize(f.vd)), dot(normal, f.up) * 0.80));
    w = w * w; w = w * w; w = w * w;
    w = max(w / (w.x + w.y + w.z) - 0.06, vec3<f32>(0.0));
    return w / (w.x + w.y + w.z);
}

fn groundFine(layer: i32, f: GroundFrame, sides: vec3<f32>, bend: vec3<f32>) -> GroundSample {
    if (layer != G_ROCK) {
        return groundTap(layer, GROUND_NEAR[layer], f.g.xy + bend.xy, f.dx.xy, f.dy.xy, f.ud, f.vd);
    }
    var out = GroundSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), 0.0, 0.0);
    let n = GROUND_NEAR[layer];
    if (sides.x > 0.0) {
        let s = groundTap(layer, n, f.g.yz + bend.yz, f.dx.yz, f.dy.yz, f.vd, f.up);
        out.albedo += s.albedo * sides.x; out.height += s.height * sides.x; out.gradient += s.gradient * sides.x; out.rough += s.rough * sides.x; out.open += s.open * sides.x;
    }
    if (sides.y > 0.0) {
        let s = groundTap(layer, n, f.g.xz + bend.xz, f.dx.xz, f.dy.xz, f.ud, f.up);
        out.albedo += s.albedo * sides.y; out.height += s.height * sides.y; out.gradient += s.gradient * sides.y; out.rough += s.rough * sides.y; out.open += s.open * sides.y;
    }
    if (sides.z > 0.0) {
        let s = groundTap(layer, n, f.g.xy + bend.xy, f.dx.xy, f.dy.xy, f.ud, f.vd);
        out.albedo += s.albedo * sides.z; out.height += s.height * sides.z; out.gradient += s.gradient * sides.z; out.rough += s.rough * sides.z; out.open += s.open * sides.z;
    }
    return out;
}

// The wide cliff pattern: its gradient, openness and tint. Drawn from the side the land faces most; where that changes
// the border is ragged, as a crack is. The pattern grows with distance, in steps that cross-fade: it stays about as
// large on the screen. One projection and no loops: this code is in the way of every pixel, rock or not.
// Softer than the footprint: sharper, a far cliff flickers as one moves.
const CLIFF_SOFT: f32 = 1.4;
struct GroundCliff { gradient: vec3<f32>, open: f32, tint: f32 };
fn groundCliff(f: GroundFrame, normal: vec3<f32>, ragged: f32, distance: f32) -> GroundCliff {
    let w = abs(vec3<f32>(dot(normal, normalize(f.ud)), dot(normal, normalize(f.vd)), dot(normal, f.up) * 0.80)) + vec3<f32>(ragged, -ragged, 0.0);
    var p = f.g.xy; var q = f.q.xy; var dx = f.dx.xy; var dy = f.dy.xy; var ax = f.ud; var ay = f.vd; var side = 91.0;
    if (w.x > max(w.y, w.z)) { p = f.g.yz; q = f.q.yz; dx = f.dx.yz; dy = f.dy.yz; ax = f.vd; ay = f.up; side = 0.0; }
    else if (w.y > w.z) { p = f.g.xz; q = f.q.xz; dx = f.dx.xz; dy = f.dy.xz; ax = f.ud; ay = f.up; side = 517.0; }
    let k = clamp(log2(max(distance, 1.0) / 110.0) / log2(4.6), 0.0, 3.0);
    let i = i32(floor(k));
    let blend = smoothstep(0.78, 1.0, k - floor(k));
    let n = CLIFF_N[i];
    let cell = latticeUv(n, q);
    // Nearest, where it counts, by the exact coordinate.
    let lie = groundLie(cell + side, CLIFF_VARIANTS);
    var s = textureSampleGrad(groundSurface, groundWideSampler, select(cell, latticeUv(n, p), i == 0) * lie.y, L_CLIFF + i32(lie.x), latticeUv(n, dx) * CLIFF_SOFT, latticeUv(n, dy) * CLIFF_SOFT);
    var slope = latticeSlope(n, (s.xy * 2.0 - 1.0) * (CLIFF_SLOPE * lie.y));
    if (blend > 0.0) {
        let m = CLIFF_N[min(i + 1, 3)];
        let cell2 = latticeUv(m, q);
        let lie2 = groundLie(cell2 + side, CLIFF_VARIANTS);
        let t = textureSampleGrad(groundSurface, groundWideSampler, cell2 * lie2.y, L_CLIFF + i32(lie2.x), latticeUv(m, dx) * CLIFF_SOFT, latticeUv(m, dy) * CLIFF_SOFT);
        slope = mix(slope, latticeSlope(m, (t.xy * 2.0 - 1.0) * (CLIFF_SLOPE * lie2.y)), blend);
        s = mix(s, t, blend);
    }
    return GroundCliff(slope.x * ax + slope.y * ay, s.z, s.w);
}

// Steep enough for bare rock, 0..1. edge: -0.5..0.5 breaks the line up.
fn groundSteep(slope: f32, edge: f32) -> f32 { return smoothstep(0.15, 0.31, slope + 0.16 * edge); }

// Snow slides off what is too steep for it.
fn groundShed(slope: f32, edge: f32) -> f32 { return smoothstep(0.20, 0.40, slope + 0.18 * edge); }

// What the organic family is made of from far away.
fn groundField(a: vec4<f32>, b: vec4<f32>, slope: f32) -> vec3<f32> {
    let dry = smoothstep(0.39, 0.75, a.w * 0.45 + b.w * 0.55 + 0.35 * slope);
    let wood = 0.45 * smoothstep(0.60, 0.80, b.x * 0.5 + a.x * 0.25 + 0.25 * (1.0 - a.w));
    let bare = smoothstep(0.64, 0.84, a.y * 0.6 + b.y * 0.4 + 0.9 * slope);
    var c = mix(GROUND_MEAN[G_GRASS], GROUND_MEAN[G_DRY], dry);
    c = mix(c, GROUND_MEAN[G_FOREST], wood);
    return mix(c, GROUND_MEAN[G_DIRT], bare);
}
fn groundTone(a: vec4<f32>, b: vec4<f32>) -> vec3<f32> {
    let tone = 1.0 + 0.34 * (b.x - 0.5) + 0.40 * (a.x - 0.5) + 0.22 * (b.w - 0.5);
    return tone * vec3<f32>(1.0 + 0.16 * (b.w - 0.5), 1.0, 1.0 - 0.18 * (b.w - 0.5));
}
// The far tiers: the fields and the bare rock of the close ground go on in the tile's own colour.
struct GroundFar { color: vec3<f32>, rock: f32, leaf: f32, snow: f32 };
fn groundFar(coarse: vec3<f32>, a: vec4<f32>, b: vec4<f32>, slope: f32, edge: f32) -> GroundFar {
    let bright = dot(coarse, vec3<f32>(0.3333));
    let hue = coarse.b / max(coarse.g, 0.001);
    // Fields are the only far colour with much less blue than green; stony ground is grey.
    let organic = (1.0 - smoothstep(0.42, 0.58, hue)) * (1.0 - smoothstep(0.16, 0.24, bright));
    let stony = smoothstep(0.80, 0.86, hue) * (1.0 - smoothstep(0.16, 0.24, bright));
    let snow = smoothstep(0.35, 0.6, bright);
    let ledge = stony * smoothstep(0.35, 0.62, 0.55 * a.x + 0.45 * b.x + slope * 1.2);
    let steep = groundSteep(slope, edge);
    var out: GroundFar;
    out.color = mix(coarse, groundField(a, b, slope), 0.85 * organic);
    out.rock = mix(max(steep, ledge), groundShed(slope, edge), snow);
    out.leaf = 0.85 * organic * (1.0 - steep);
    out.snow = snow;
    return out;
}

struct GroundRank { first: i32, second: i32, w1: f32, w2: f32, w3: f32 };
fn groundRank(r: ptr<function, GroundRank>, i: i32, w: f32) {
    if (w > (*r).w1) { (*r).w3 = (*r).w2; (*r).w2 = (*r).w1; (*r).second = (*r).first; (*r).w1 = w; (*r).first = i; }
    else if (w > (*r).w2) { (*r).w3 = (*r).w2; (*r).w2 = w; (*r).second = i; }
    else if (w > (*r).w3) { (*r).w3 = w; }
}

// families: organic, mineral, soil, cold. bed: the soil's share under water courses. coarse: the tile's colour.
// far: 0 the close ground (made of families), 1 the far tiers' (of coarse), between them one turns into the other.
// The wide patterns and the cliffs are the same in both.
fn shadeGround(f: GroundFrame, families: vec4<f32>, bed: f32, coarse: vec3<f32>, far: f32, tileNormal: vec3<f32>, toEye: vec3<f32>, distance: f32${biomeLandscape ? ', climate: vec4<f32>, elevation: f32' : ''}) -> Ground {
    let slope = 1.0 - clamp(dot(tileNormal, f.up), 0.0, 1.0);
    let broad = groundBroad(f.q.xy, f.dx.xy, f.dy.xy);
    let b = broad.b;
    let lie = groundLie(latticeUv(MOSAIC, f.q.xy + broad.bend), MOSAIC_VARIANTS);
    let variant = i32(lie.x);
    let uvA = latticeUv(MOSAIC, f.g.xy + broad.bend) * lie.y;
    // Nearby a little sharper than the footprint: seen flat along the ground the pattern would blur away.
    let sharp = mix(0.65, 1.0, smoothstep(800.0, 2000.0, distance));
    let axA = latticeUv(MOSAIC, f.dx.xy) * sharp;
    let ayA = latticeUv(MOSAIC, f.dy.xy) * sharp;
    var a = vec4<f32>(0.5);
    if (distance < 9000.0) {
        a = mix(textureSampleGrad(groundSurface, groundWideSampler, uvA, L_MOSAIC + variant, axA, ayA), a, smoothstep(5000.0, 9000.0, distance));
    }
    let edge = 0.6 * (a.x - 0.5) + 0.5 * (b.y - 0.5) + 0.35 * (a.y - 0.5);
${biomeLandscape ? `
    let setback = clamp(dot(tileNormal, f.up), 0.0, 1.0);
    let cover = biomeCover(climate.r, climate.g, sqrt(max(1.0 - setback * setback, 0.0)), elevation, edge);
    let ice = ${unpackBiomeIceWGSL};
    let lithology = biomeLithology(climate.a);
    let mineral = smoothstep(0.30, 0.74, 0.64 * a.x + 0.36 * b.y);
    let rockTint = lithology.x * vec3<f32>(0.103, 0.107, 0.111)
        + lithology.y * vec3<f32>(0.158, 0.158, 0.156)
        + lithology.z * mix(vec3<f32>(0.150, 0.123, 0.099), vec3<f32>(0.204, 0.168, 0.134), mineral);
    let grainTone = rockTint / GROUND_MEAN[G_ROCK];
    let sandTone = mix(vec3<f32>(0.68, 0.63, 0.53), vec3<f32>(0.89, 0.82, 0.71),
        smoothstep(0.24, 0.75, 0.6 * b.y + 0.4 * a.z));
    let tundraTone = mix(vec3<f32>(0.92, 1.01, 0.91), vec3<f32>(1.21, 0.82, 0.72),
        smoothstep(0.34, 0.70, 0.47 * a.x + 0.35 * b.w + 0.18 * (1.0 - climate.y)));
    let dryBias = (0.55 - climate.y) * 0.95;
    let dryGrass = smoothstep(0.38, 0.73, a.w * 0.45 + b.w * 0.55 + 0.35 * slope + dryBias);
    let litter = mix(0.78, 1.0, smoothstep(0.3, 0.7, a.x * 0.5 + b.x * 0.5));
    let shortGrass = cover.grass + cover.forest * (1.0 - litter);
    let peat = 0.75 * smoothstep(0.39, 0.69, 0.64 * a.y + 0.36 * b.x);
    let marshColor = mix(GROUND_MEAN[G_MARSH], GROUND_MEAN[G_MUD] * vec3<f32>(0.66, 0.62, 0.53), peat);
` : ''}

    var rock = 0.0;
    var snow = 0.0;
    var leaf = 0.0;
    var albedo = vec3<f32>(0.0);
    var farColor = vec3<f32>(0.0);
    var farRock = 0.0;
${farTier ? `${close ? '    if (far > 0.0) {' : '    {'}
${biomeLandscape ? `
        farColor = (shortGrass * mix(GROUND_MEAN[G_GRASS], GROUND_MEAN[G_DRY], dryGrass)
            + cover.forest * litter * GROUND_MEAN[G_FOREST] + cover.tundra * GROUND_MEAN[G_TUNDRA] * tundraTone
            + cover.sand * GROUND_MEAN[G_SAND] * sandTone + cover.snow * GROUND_MEAN[G_SNOW]
            + cover.marsh * marshColor) / max(1.0 - cover.rock, 0.001);
        farRock = cover.rock;
        rock = cover.rock * far; leaf = shortGrass * far; snow = cover.snow * far;
` : `
        let t = groundFar(coarse, a, b, slope, edge);
        farColor = t.color; farRock = t.rock;
        rock = t.rock * far; leaf = t.leaf * far; snow = t.snow * far;
`}
    }
` : ''}${close ? `
    let near = 1.0 - far;
    var relief = vec4<f32>(0.5, 0.5, 0.9, 0.5);
    var nearRock = 0.0;
    var first = G_GRASS;
    var second = G_GRASS;
    var w1 = 1.0;
    var w2 = 0.0;
    if (far < 1.0) {
        if (distance < 1400.0) { relief = mix(textureSampleGrad(groundSurface, groundWideSampler, uvA, L_MOSAIC_SLOPE + variant, axA, ayA), relief, smoothstep(900.0, 1400.0, distance)); }
${biomeLandscape ? `
        let exposed = 1.0 - bed;
        let bare = 0.42 * smoothstep(0.64, 0.85, 0.6 * a.y + 0.4 * b.y + slope);
        let gravel = smoothstep(0.075, 0.25, slope) * smoothstep(0.36, 0.72, 0.6 * a.z + 0.4 * b.y);
        let meadow = shortGrass * exposed;
        let turf = meadow * (1.0 - bare) * (1.0 - gravel);
        let wGrass = turf * (1.0 - dryGrass);
        let wDry = turf * dryGrass;
        let wForest = cover.forest * litter * exposed;
        let wDirt = meadow * bare * (1.0 - gravel);
        let wGravel = meadow * gravel;
        let wRock = cover.rock * exposed;
        let wSand = cover.sand * exposed;
        let wSnow = cover.snow * exposed;
        let wTundra = cover.tundra * exposed;
        let wMarsh = cover.marsh * exposed * (1.0 - peat);
        let wMud = bed + cover.marsh * exposed * peat;
` : `
        let steep = groundSteep(slope, edge);
        // What the families are here.
        let bareness = a.y * 0.6 + b.y * 0.4;
        let dryness = a.w * 0.45 + b.w * 0.55;
        let lowland = 1.0 - smoothstep(0.02, 0.10, slope);
        let bare = smoothstep(0.66, 0.78, bareness + 0.9 * slope);
        let dry = smoothstep(0.39, 0.75, dryness + 0.35 * slope);
        let wood = smoothstep(0.60, 0.74, b.x * 0.5 + a.x * 0.25 + 0.25 * (1.0 - a.w)) * (1.0 - bare);
        let scree = smoothstep(0.07, 0.19, slope + 0.10 * (b.y - 0.5)) * smoothstep(0.36, 0.60, bareness + 0.25 * a.z);
        let stones = a.z * smoothstep(0.35, 0.6, b.y + 0.5 * slope);

        let organic = families.x * (1.0 - steep);
        let turf = organic * (1.0 - bare) * (1.0 - scree) * (1.0 - 0.85 * stones);
        let mineral = families.y * (1.0 - steep);
        let ledge = smoothstep(0.35, 0.62, 0.55 * a.x + 0.45 * b.x + slope * 1.2);
        let poor = smoothstep(0.4, 0.6, bareness);
        let soil = families.z * (1.0 - 0.9 * steep);
        let dune = smoothstep(0.66, 0.50, bareness);
        let shed = groundShed(slope, edge);
        let wGrass = turf * (1.0 - 0.9 * wood) * (1.0 - dry);
        let wDry = turf * (1.0 - 0.9 * wood) * dry + mineral * (1.0 - ledge) * 0.45 * (1.0 - poor) * (0.4 + 0.6 * lowland);
        let wForest = turf * wood * 0.9;
        let wDirt = organic * bare * (1.0 - scree);
        let wGravel = organic * max(scree, 0.85 * stones) + mineral * (1.0 - ledge) * mix(0.55, 1.0, poor) + soil * (1.0 - bed) * (1.0 - dune) * 0.75;
        let wRock = (families.x + families.y + 0.9 * families.z) * steep + mineral * ledge + families.w * shed;
        let wSand = soil * (1.0 - bed) * mix(0.25, 1.0, dune);
        let wSnow = families.w * (1.0 - shed);
        let wMud = soil * bed;

`}
        // The two strongest, and the third to fade them out before they change places.
        var rank = GroundRank(0, 0, 0.0, 0.0, 0.0);
        groundRank(&rank, G_GRASS, wGrass);
        groundRank(&rank, G_DRY, wDry);
        groundRank(&rank, G_FOREST, wForest);
        groundRank(&rank, G_DIRT, wDirt);
        groundRank(&rank, G_GRAVEL, wGravel);
        groundRank(&rank, G_ROCK, wRock);
        groundRank(&rank, G_SAND, wSand);
        groundRank(&rank, G_SNOW, wSnow);
        groundRank(&rank, G_MUD, wMud);
${biomeLandscape ? `        groundRank(&rank, G_TUNDRA, wTundra);
        groundRank(&rank, G_MARSH, wMarsh);` : ''}
        first = rank.first;
        second = rank.second;
        w2 = max(rank.w2 - rank.w3, 0.0);
        w1 = max(rank.w1 - 0.5 * rank.w3, 0.0001);
        nearRock = clamp(wRock, 0.0, 1.0);
        rock += nearRock * near;
        snow += ${biomeLandscape ? 'wSnow' : 'families.w'} * near;
        leaf += clamp((wGrass + wDry) / max(w1 + w2 + rank.w3, 0.001), 0.0, 1.0) * near;
    }
` : ''}
    var cliff = GroundCliff(vec3<f32>(0.0), 1.0, 0.5);
    if (rock > 0.02) { cliff = groundCliff(f, tileNormal, 0.30 * (a.y - 0.5) + 0.20 * (a.w - 0.5), distance); }
    let tone = groundTone(a, b);
    let rockTone = (0.66 + 0.76 * cliff.tint)${biomeLandscape ? ' * grainTone' : ''};
    var gradient = vec3<f32>(0.0);
    // What is left of the small hollows' shade where they are not drawn.
    var open = 0.77;
    var rough = 0.8;
${close ? `
    if (far < 1.0) {
        var sides = vec3<f32>(0.0, 0.0, 1.0);
        if (nearRock > 0.02) { sides = groundSides(f, tileNormal); }
        // The broadest pattern bends the fine ones, so that their repeats do not line up. (A finer one would smear them.)
        var bend = vec3<f32>(b.x - 0.5, b.w - 0.5, b.y - 0.5) * 4.0;
${deepEndMeters > 0 ? `        // Close by, stones and rock hide each other: the point on their relief this view ray meets.
        if (distance < GROUND_DEEP_END && GROUND_DEPTH[first] > 0.0) {
            let into = -toEye;
            let steep1 = max(dot(tileNormal, toEye), 0.18);
            let along = into / steep1 + tileNormal;
            let shift = vec3<f32>(dot(along, f.ud), dot(along, f.vd), dot(along, f.up));
            let depth = GROUND_DEPTH[first] * (1.0 - smoothstep(0.5 * GROUND_DEEP_END, GROUND_DEEP_END, distance));
            // The projection that shows most of it.
            var p = f.g.xy + bend.xy; var q = shift.xy;
            if (first == G_ROCK) {
                if (sides.x > max(sides.y, sides.z)) { p = f.g.yz + bend.yz; q = shift.yz; }
                else if (sides.y > sides.z) { p = f.g.xz + bend.xz; q = shift.xz; }
            }
            let n = GROUND_NEAR[first];
            let px = latticeUv(n, f.dx.xy + vec2<f32>(0.0, f.dx.z));
            let py = latticeUv(n, f.dy.xy + vec2<f32>(0.0, f.dy.z));
            let mip = max(0.0, 10.0 + 0.5 * log2(max(min(dot(px, px), dot(py, py)), 1.0e-12)));
            // Three steps toward the height found, each from the last: shapes are shallow, so this settles.
            var z = 0.5;
            z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, groundWideSampler, latticeUv(n, p + q * ((z - 0.5) * depth)), first, mip).a, 0.7);
            z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, groundWideSampler, latticeUv(n, p + q * ((z - 0.5) * depth)), first, mip).a, 0.6);
            z = mix(z, 1.0 - textureSampleLevel(groundAlbedo, groundWideSampler, latticeUv(n, p + q * ((z - 0.5) * depth)), first, mip).a, 0.5);
            bend += shift * ((z - 0.5) * depth);
        }
` : ''}        // Fine surfaces, interlocked by height.
        var fine = GroundSample(GROUND_MEAN[first], 0.5, vec3<f32>(0.0), 0.8, 0.86);
        var share = w2 / (w1 + w2);
        let fineFade = 1.0 - smoothstep(GROUND_FINE_END * 0.6, GROUND_FINE_END, distance);
        if (fineFade > 0.0) {
            let s1 = groundFine(first, f, sides, bend);
            fine = s1;
            // Under this share the second never stands out of the first.
            if (share > 0.13) {
                let s2 = groundFine(second, f, sides, bend);
                let h1 = s1.height + 0.10 - share;
                let h2 = s2.height + share - 0.90;
                let top = max(h1 + 1.0, h2 + 1.0) - 0.22;
                let m1 = max(h1 + 1.0 - top, 0.0);
                let m2 = max(h2 + 1.0 - top, 0.0);
                // Far off the pieces are too small to interlock: the same ones would stand out of every repeat.
                let over = mix(m2 / max(m1 + m2, 0.0001), share, smoothstep(18.0, 75.0, distance));
                share = over;
                fine = GroundSample(mix(s1.albedo, s2.albedo, over), mix(s1.height, s2.height, over), mix(s1.gradient, s2.gradient, over),
                    mix(s1.rough, s2.rough, over), mix(s1.open, s2.open, over));
            } else { share = 0.0; }
            // The same surface, larger and turned, so that its repeats do not show.
            if (first != G_ROCK) {
                let n = GROUND_FAR[first];
                let big = textureSampleGrad(groundAlbedo, groundSampler, latticeUv(n, f.g.xy), first, latticeUv(n, f.dx.xy), latticeUv(n, f.dy.xy));
                fine.albedo *= mix(vec3<f32>(1.0), clamp(big.rgb / GROUND_MEAN[first], vec3<f32>(0.55), vec3<f32>(1.7)), 0.65 * (1.0 - share));
            }
        }
        let mean = mix(GROUND_MEAN[first], GROUND_MEAN[second], w2 / (w1 + w2));
        fine.albedo = mix(mean, fine.albedo, fineFade);
        // Broad colour: patches a field or a hillside wide.
        ${biomeLandscape ? `let dampPeat = 0.76 * cover.marsh * peat;
        let surfaceTone = tone * mix(vec3<f32>(1.0), sandTone, cover.sand) * mix(vec3<f32>(1.0), tundraTone, cover.tundra)
            * mix(vec3<f32>(1.0), vec3<f32>(0.62, 0.58, 0.49), dampPeat);` : 'let surfaceTone = tone;'}
        albedo = fine.albedo * mix(surfaceTone, vec3<f32>(rockTone), nearRock) * near;
        let hummocks = latticeSlope(MOSAIC, (relief.xy * 2.0 - 1.0) * (MOSAIC_SLOPE * lie.y));
        let soft = (1.0 - nearRock) * (1.0 - 0.6 * ${biomeLandscape ? 'cover.snow' : 'families.w'});
        gradient = (fine.gradient * (fineFade * mix(0.8, 0.6, nearRock)) + (hummocks.x * f.ud + hummocks.y * f.vd) * (soft * 0.8)) * near;
        open = mix(mix(0.86, fine.open, fineFade) * mix(1.0, relief.z, soft), open, far);
        rough = mix(fine.rough, rough, far);
    }
` : ''}
${farTier ? '    albedo += mix(farColor * tone, GROUND_MEAN[G_ROCK] * rockTone, farRock) * far;' : ''}
${biomeLandscape ? `
    if (ice > 0.005) {
        var iceColor = GROUND_MEAN[G_ICE];
        var iceGradient = vec3<f32>(0.0);
        var iceRough = 0.56;
        let iceMid = smoothstep(45.0, 180.0, distance) * (1.0 - smoothstep(700.0, 1950.0, distance));
        if (iceMid > 0.0) {
            let n = GROUND_FAR[G_ICE];
            let bend = vec2<f32>(a.x - 0.5, a.y - 0.5) * 31.0;
            let broadIce = textureSampleGrad(groundAlbedo, groundWideSampler, latticeUv(n, f.g.xy + bend), G_ICE,
                latticeUv(n, f.dx.xy), latticeUv(n, f.dy.xy));
            iceColor = mix(iceColor, broadIce.rgb, iceMid * 0.67);
        }
${close ? `        let iceDetail = (1.0 - far) * (1.0 - smoothstep(120.0, 340.0, distance));
        if (iceDetail > 0.0) {
            let sample = groundFine(G_ICE, f, vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0));
            iceColor = mix(iceColor, sample.albedo, iceDetail);
            iceGradient = sample.gradient * iceDetail;
            iceRough = mix(iceRough, sample.rough, iceDetail);
        }
` : ''}        // Firn in the upper accumulation zone layers over darker, exposed ice below.
        let frost = (1.0 - smoothstep(0.21, 0.37, climate.r)) * smoothstep(0.30, 0.74, 0.68 * a.x + 0.32 * b.x);
        albedo = mix(albedo, mix(iceColor, GROUND_MEAN[G_SNOW], 0.47 * frost) * tone, ice);
        gradient = mix(gradient, iceGradient, ice);
        rough = mix(rough, iceRough, ice);
        rock *= 1.0 - ice;
        leaf *= 1.0 - ice;
        snow = mix(snow, 1.0, ice);
    }
` : ''}

    var ground: Ground;
    ground.albedo = albedo;
    ground.leaf = leaf;
    ground.gradient = gradient + cliff.gradient * (0.6 * rock${biomeLandscape ? ' * dot(lithology, vec3<f32>(0.84, 1.25, 0.70))' : ''});
    ground.open = open * mix(1.0, cliff.open, rock);
    ground.rough = rough;
    let dryable = 1.0 - snow;
    ground.wet = dryable * mix(0.42, 0.30, rock);
    ground.pool = dryable * (1.0 - rock) * (1.0 - far) * (1.0 - smoothstep(0.0015, 0.010, slope)) * smoothstep(0.50, 0.36, 0.6 * a.x + 0.4 * b.x);
    return ground;
}
`;
}
