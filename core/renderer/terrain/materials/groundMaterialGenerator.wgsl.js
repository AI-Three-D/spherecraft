// Shaders of the ground material generator (groundMaterials.js): tileable
// close-up surfaces made from real small geometry, seen from straight above.
//
//   relief   - the bed of a material, then blades, leaves, twigs and stones
//              scattered over it, depth tested by their own height
//   resolve  - slopes, cavity and colour from that relief
//   mips     - averaged in linear colour; the last pass sets each material's
//              mean colour exactly, so far terrain can use the mean alone
//
// Everything wraps: noise is periodic and scattered pieces are drawn again
// across the edges.

export const GROUND_KIND = Object.freeze({ bed: 0, blade: 1, straw: 2, leaf: 3, twig: 4, stone: 5, moss: 6, clover: 7 });

const COMMON = /* wgsl */`
const TAU: f32 = 6.2831853;
struct Layer {
    index: u32,
    seed: u32,
    period: f32,    // metres across the texture
    size: f32,      // texels of the relief
    mean: vec4f,    // linear mean albedo, w slope range
    look: vec4f,    // material dependent
};
fn pcg3(v0: vec3u) -> vec3u {
    var v = v0 * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v = v ^ (v >> vec3u(16u));
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
fn rand3(v: vec3u) -> vec3f { return vec3f(pcg3(v) >> vec3u(8u)) / 16777216.0; }
fn wrapCell(c: vec2i, n: i32) -> vec2u { return vec2u(((c % n) + n) % n); }
fn cellRand(c: vec2i, n: i32, seed: u32) -> vec3f { return rand3(vec3u(wrapCell(c, n), seed)); }
fn quintic(f: vec2f) -> vec2f { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }
// Periodic gradient noise, about -0.7..0.7. p in cells, n cells across.
fn gnoise(p: vec2f, n: i32, seed: u32) -> f32 {
    let i = vec2i(floor(p));
    let f = p - floor(p);
    let u = quintic(f);
    var g: array<f32, 4>;
    for (var k = 0; k < 4; k++) {
        let o = vec2i(k & 1, k >> 1);
        let a = cellRand(i + o, n, seed).x * TAU;
        g[k] = dot(vec2f(cos(a), sin(a)), f - vec2f(o));
    }
    return mix(mix(g[0], g[1], u.x), mix(g[2], g[3], u.x), u.y);
}
// The same over a turned grid: its axes are (l.x, l.y) and (-l.y, l.x) cells per texture, whole numbers, so it wraps too.
fn turned(uv: vec2f, l: vec2i) -> vec2f { return vec2f(f32(l.x) * uv.x - f32(l.y) * uv.y, f32(l.y) * uv.x + f32(l.x) * uv.y); }
fn turnedCell(c: vec2i, l: vec2i) -> vec2u {
    let d = f32(l.x * l.x + l.y * l.y);
    let t = vec2i(floor((vec2f(vec2i(l.x * c.x + l.y * c.y, l.x * c.y - l.y * c.x)) + 0.5) / d));
    return vec2u(c - vec2i(l.x * t.x - l.y * t.y, l.y * t.x + l.x * t.y) + 8192);
}
fn gnoiseTurned(uv: vec2f, l: vec2i, shift: vec2f, seed: u32) -> f32 {
    let p = turned(uv, l) + shift;
    let i = vec2i(floor(p));
    let f = p - floor(p);
    let u = quintic(f);
    var g: array<f32, 4>;
    for (var k = 0; k < 4; k++) {
        let o = vec2i(k & 1, k >> 1);
        let a = rand3(vec3u(turnedCell(i + o, l), seed)).x * TAU;
        g[k] = dot(vec2f(cos(a), sin(a)), f - vec2f(o));
    }
    return mix(mix(g[0], g[1], u.x), mix(g[2], g[3], u.x), u.y);
}
// Every octave turned and shifted its own way: grids that line up show as bands along the axes and at the edges.
fn octave(uv: vec2f, n: i32, k: i32, seed: u32) -> f32 {
    let a = 0.5 + 2.4 * f32(k) + 0.7 * f32(seed & 3u);
    let l = vec2i(round(f32(n) * vec2f(cos(a), sin(a))));
    return gnoiseTurned(uv, l, fract(vec2f(0.371, 0.713) * f32(k + 1)), seed);
}
fn fbm(uv: vec2f, n0: i32, octaves: i32, gain: f32, seed: u32) -> f32 {
    var v = 0.0; var a = 1.0; var n = n0; var total = 0.0;
    for (var k = 0; k < octaves; k++) {
        v += a * octave(uv, n, k, seed + u32(k) * 17u);
        total += a; a *= gain; n *= 2;
    }
    return v / total * 1.6;
}
fn ridged(uv: vec2f, n0: i32, octaves: i32, gain: f32, seed: u32) -> f32 {
    var v = 0.0; var a = 1.0; var n = n0; var total = 0.0;
    for (var k = 0; k < octaves; k++) {
        v += a * (1.0 - min(1.0, 2.2 * abs(octave(uv, n, k, seed + u32(k) * 31u))));
        total += a; a *= gain; n *= 2;
    }
    return v / total;
}
struct Cell { f1: f32, f2: f32, id: vec3f, to: vec2f };
// Periodic Worley. stretch: cells per axis (both wrap).
fn worley(uv: vec2f, n: vec2i, jitter: f32, seed: u32) -> Cell {
    let p = uv * vec2f(n);
    let i = vec2i(floor(p));
    let f = p - floor(p);
    var out = Cell(9.0, 9.0, vec3f(0.0), vec2f(0.0));
    for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
        let c = i + vec2i(x, y);
        let w = vec2u(((c % n) + n) % n);
        let r = rand3(vec3u(w, seed));
        let d = vec2f(f32(x), f32(y)) + 0.5 + (r.xy - 0.5) * jitter - f;
        let l = length(d);
        if (l < out.f1) { out.f2 = out.f1; out.f1 = l; out.id = rand3(vec3u(w, seed + 7u)); out.to = d; }
        else if (l < out.f2) { out.f2 = l; }
    } }
    return out;
}
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
`;

// Bed heights (metres) and what they are made of.
const BEDS = /* wgsl */`
struct Bed { height: f32, aux: f32, tint: f32, kind: f32 };

fn soilBed(uv: vec2f, P: f32, amount: f32, seed: u32) -> Bed {
    let lumps = fbm(uv, i32(P * 5.0), 4, 0.55, seed);
    let crumbs = worley(uv + 0.004 * vec2f(fbm(uv, i32(P * 30.0), 2, 0.5, seed + 5u), fbm(uv, i32(P * 30.0), 2, 0.5, seed + 9u)),
        vec2i(i32(P * 42.0)), 0.95, seed + 1u);
    let small = worley(uv, vec2i(i32(P * 110.0)), 0.95, seed + 2u);
    let crumb = sqrt(max(0.0, 1.0 - 1.35 * crumbs.f1 * crumbs.f1)) * smoothstep(0.15, 0.5, crumbs.id.x + 0.4 * lumps);
    let grit = sqrt(max(0.0, 1.0 - 1.6 * small.f1 * small.f1)) * step(0.45, small.id.y);
    let h = amount * (0.016 * lumps + 0.0075 * crumb * (0.4 + crumbs.id.y) + 0.0022 * grit);
    return Bed(h, crumb, sat(0.5 + 0.55 * lumps + 0.25 * (crumbs.id.z - 0.5)), 0.0);
}

// One size of broken rock: flat faces, each turned and set back by its own amount, meeting in sharp edges.
struct Facet { height: f32, id: vec3f, edge: f32 };
fn facets(uv: vec2f, n: vec2i, seed: u32, tilt: f32) -> Facet {
    let c = worley(uv, n, 0.98, seed);
    let lean = (c.id.xy - 0.5) * 2.0;
    return Facet((c.id.z - 0.5) + tilt * dot(c.to, lean), c.id, c.f2 - c.f1);
}
// Bedded, broken rock; v runs down the face. Four sizes of faces, worn ledges and a few wandering cracks.
// k: how many times as many of everything.
fn rockBed(uv0: vec2f, k: i32, seed: u32) -> Bed {
    let kf = f32(k);
    let warp = vec2f(fbm(uv0, 4 * k, 5, 0.55, seed + 40u), fbm(uv0, 4 * k, 5, 0.55, seed + 41u));
    let uv = uv0 + 0.030 / kf * warp;
    let a = facets(uv, vec2i(4, 6) * k, seed + 60u, 0.75);
    let b = facets(uv + 0.016 / kf * warp.yx, vec2i(9, 15) * k, seed + 61u, 0.75);
    let c = facets(uv - 0.010 / kf * warp, vec2i(23, 34) * k, seed + 62u, 0.8);
    let d = facets(uv + 0.006 / kf * warp.yx, vec2i(61, 83) * k, seed + 63u, 0.8);
    // Beds: alternating hard and soft layers, a little folded.
    let fold = uv0.y * 5.0 * kf + 0.9 * gnoise(uv0 * 2.0 * kf, 2 * k, seed + 44u) + 0.22 * warp.x;
    let layerWave = gnoise(vec2f(0.5 + 0.3 * warp.y, fold * 2.0), 10 * k, seed + 45u) + 0.5 * gnoise(vec2f(0.2, fold * 5.0), 25 * k, seed + 46u);
    let hard = smoothstep(-0.12, 0.16, layerWave);
    // Broken less where the rock is massive.
    let broken = smoothstep(-0.25, 0.3, fbm(uv0, 3 * k, 3, 0.5, seed + 47u) - 0.1);
    let crackField = gnoise(uv * 5.0 * kf + 0.5 * warp, 5 * k, seed + 70u);
    let crackWidth = 0.006 + 0.018 * smoothstep(0.0, 0.5, warp.x + 0.2);
    let crackA = (1.0 - smoothstep(0.0, crackWidth, abs(crackField))) * smoothstep(-0.05, 0.2, warp.y);
    let crackB = (1.0 - smoothstep(0.0, 0.03, abs(gnoise(uv * 11.0 * kf - 0.4 * warp, 11 * k, seed + 71u)))) * smoothstep(0.1, 0.3, warp.x);
    let crack = max(crackA, 0.6 * crackB);
    let rough = fbm(uv0, 40 * k, 5, 0.62, seed + 80u);
    let grooves = fbm(uv0, 12 * k, 3, 0.5, seed + 81u);
    let h = 0.62 * a.height + mix(0.16, 0.34, broken) * b.height + mix(0.04, 0.14, broken) * c.height + mix(0.008, 0.035, broken) * d.height
        + 0.20 * hard + 0.08 * grooves + 0.075 * rough - 0.12 * crack + 0.28 * fbm(uv0, 2 * k, 3, 0.5, seed + 90u);
    let tint = sat(0.5 + 0.28 * (a.id.x - 0.5) + 0.34 * (b.id.y - 0.5) + 0.22 * (c.id.x - 0.5) + 0.30 * (hard - 0.5) + 0.22 * warp.x);
    return Bed(h * 0.75, crack, tint, 0.0);
}

fn bedOf(layer: Layer, uv: vec2f) -> Bed {
    let P = layer.period;
    let s = layer.seed;
    switch (layer.index) {
        case 0u, 1u: { // grass: dark soil and dead thatch under the blades
            var b = soilBed(uv, P, 0.7, s);
            let hummock = fbm(uv, 4, 3, 0.5, s + 3u);
            b.height = b.height - 0.026 + 0.016 * hummock;
            return b;
        }
        case 2u: { // forest floor: soil, needles, patches of moss
            var b = soilBed(uv, P, 1.0, s);
            let m = fbm(uv, 4, 4, 0.6, s + 11u) + 0.12 * fbm(uv, 40, 2, 0.5, s + 12u);
            let moss = smoothstep(0.12, 0.3, m);
            let tuft = worley(uv, vec2i(i32(P * 60.0)), 0.9, s + 13u);
            b.height += moss * (0.016 + 0.006 * (1.0 - tuft.f1) + 0.006 * fbm(uv, 22, 3, 0.5, s + 14u));
            b.tint = mix(b.tint, 0.35 + 0.5 * tuft.id.x, moss);
            b.kind = select(0.0, 6.0, moss > 0.5);
            b.aux = moss;
            return b;
        }
        case 3u: { // bare earth, cracked where it dried
            var b = soilBed(uv, P, 1.35, s);
            let w = vec2f(fbm(uv, 6, 3, 0.5, s + 21u), fbm(uv, 6, 3, 0.5, s + 22u));
            let c = worley(uv + 0.025 * w, vec2i(9), 0.9, s + 23u);
            let dry = smoothstep(0.0, 0.35, fbm(uv, 3, 3, 0.5, s + 24u));
            b.height -= dry * 0.012 * (1.0 - smoothstep(0.0, 0.055, c.f2 - c.f1));
            return b;
        }
        case 4u: { // between stones
            var b = soilBed(uv, P, 1.5, s);
            b.height -= 0.02;
            return b;
        }
        case 5u: { return rockBed(uv, 1, s); }
        case 6u: { // sand: wind ripples and grains
            let w = vec2f(fbm(uv, 3, 4, 0.5, s + 31u), fbm(uv, 3, 4, 0.5, s + 32u));
            let phase = (uv.y * 22.0 + 1.3 * w.x + 0.8 * gnoise(uv * 9.0, 9, s + 33u)) ;
            let f = fract(phase);
            let ripple = select((1.0 - f) / 0.35, f / 0.65, f < 0.65);
            let strength = 0.35 + 0.65 * smoothstep(-0.25, 0.4, w.y);
            let grain = worley(uv, vec2i(320), 0.95, s + 34u);
            let h = 0.0095 * strength * smoothstep(0.0, 1.0, ripple) + 0.02 * w.x + 0.0013 * grain.id.x;
            return Bed(h, ripple * strength, sat(0.5 + 0.5 * w.y + 0.5 * (grain.id.y - 0.5)), 0.0);
        }
        case 7u: { // snow: soft drifts with a broken crust
            let w = vec2f(fbm(uv, 3, 4, 0.5, s + 41u), fbm(uv, 3, 4, 0.5, s + 42u));
            let drift = fbm(uv + 0.06 * w, 3, 5, 0.45, s + 43u);
            let crust = smoothstep(0.05, 0.22, fbm(uv + 0.03 * w, 7, 4, 0.55, s + 44u));
            let grain = worley(uv, vec2i(280), 0.95, s + 45u);
            let sastrugi = fbm(vec2f(uv.x + 0.25 * w.x, uv.y) * vec2f(1.0, 1.0) + 0.05 * w, 5, 5, 0.5, s + 46u);
            let h = 0.070 * drift + 0.006 * crust + 0.05 * sastrugi + 0.0016 * grain.id.x;
            return Bed(h, crust, sat(0.6 + 0.4 * drift + 0.3 * (grain.id.y - 0.5)), 0.0);
        }
        default: { // mud: silt, worn smooth
            let w = vec2f(fbm(uv, 4, 4, 0.5, s + 51u), fbm(uv, 4, 4, 0.5, s + 52u));
            let h = 0.028 * w.x + 0.004 * fbm(uv, 40, 3, 0.5, s + 53u);
            return Bed(h, 0.0, sat(0.5 + 0.6 * w.y), 0.0);
        }
    }
}
`;

/** The relief: the bed as a full-screen triangle, then instanced pieces. */
export function buildReliefShader() {
    return COMMON + BEDS + /* wgsl */`
struct Scatter {
    shape: u32, count: u32, seed: u32, kind: u32,
    size: vec4f,   // min and max length (m), min and max width (m)
    place: vec4f,  // min and max height of the root (m), rise (m), clump threshold
    style: vec4f,  // curl, combing (0 any direction .. 1 one way), clump cells, coverage fade
};
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var<uniform> scatter: Scatter;

struct Out {
    @builtin(position) pos: vec4f,
    @location(0) local: vec2f,                      // along 0..1, across -1..1
    @location(1) height: f32,
    @location(2) @interpolate(flat) rnd: vec4f,
    @location(3) @interpolate(flat) size: vec2f,    // length and width (m)
    @location(4) @interpolate(flat) id: u32,
};
struct Texel { @location(0) value: vec4f, @builtin(frag_depth) depth: f32 };
fn depthOf(h: f32) -> f32 { return clamp(h * 1.6 + 0.5, 0.0, 1.0); }

@vertex
fn bedVertex(@builtin(vertex_index) i: u32) -> Out {
    var o: Out;
    o.local = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    o.pos = vec4f(o.local * 2.0 - 1.0, 0.5, 1.0);
    return o;
}
@fragment
fn bedFragment(in: Out) -> Texel {
    let b = bedOf(layer, in.pos.xy / layer.size);
    return Texel(vec4f(b.height, b.aux, b.tint, b.kind), depthOf(b.height));
}

const SEGMENTS: u32 = 6u;
@vertex
fn pieceVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
    let copy = ii & 3u;
    let id = ii >> 2u;
    let a = rand3(vec3u(id, scatter.seed, 1u));
    let b = rand3(vec3u(id, scatter.seed, 2u));
    let c = rand3(vec3u(id, scatter.seed, 3u));
    var root = a.xy;
    let clumpN = i32(scatter.style.z);
    let clump = fbm(root, clumpN, 3, 0.5, scatter.seed + 77u);
    var o: Out;
    let tall = sat(0.5 + clump);
    let len = mix(scatter.size.x, scatter.size.y, b.x * b.x) * mix(1.0, 0.6 + 0.8 * tall, sat(scatter.style.w));
    let wid = mix(scatter.size.z, scatter.size.w, b.y);
    let flow = gnoise(root * f32(clumpN), clumpN, scatter.seed + 78u) * TAU + gnoise(root * f32(clumpN * 3), clumpN * 3, scatter.seed + 79u) * 2.0;
    let angle = mix(a.z * TAU, flow + (a.z - 0.5) * 1.6, scatter.style.y);
    // Quads for flat shapes, a bent strip for blades and twigs.
    let seg = vi / 6u;
    let corner = vi % 6u;
    let top = corner == 2u || corner == 3u || corner == 5u;
    let right = corner == 1u || corner == 4u || corner == 5u;
    let t = (f32(seg) + f32(top)) / f32(SEGMENTS);
    let across = select(-1.0, 1.0, right);
    let bend = (c.x - 0.5) * 2.0 * scatter.style.x;
    let turn = angle + bend * t;
    // Position along a circular arc.
    var along: vec2f;
    if (abs(bend) < 1.0e-3) { along = vec2f(cos(angle), sin(angle)) * t; }
    else { along = vec2f(sin(angle + bend * t) - sin(angle), cos(angle) - cos(angle + bend * t)) / bend; }
    let normal = vec2f(-sin(turn), cos(turn));
    var width = wid;
    var height = mix(scatter.place.x, scatter.place.y, b.z);
    if (scatter.shape == 0u) { // blade: up, over and tapering
        width = wid * (1.0 - 0.82 * t * t);
        height += scatter.place.z * (0.6 + 0.8 * c.y) * (1.75 * t - 1.05 * t * t) * (0.5 + 0.7 * tall);
    } else if (scatter.shape == 1u) { // twig: lies, a little uneven
        width = wid * (1.0 - 0.45 * t);
        height += scatter.place.z * sin(t * 3.1 + c.y * TAU) * 0.5;
    } else { // flat card, turned and tilted
        height += (t - 0.5) * (c.y - 0.5) * 2.0 * scatter.place.z + across * (c.z - 0.5) * scatter.place.z;
    }
    var p = root + (along * len + normal * across * 0.5 * width) / layer.period;
    p -= floor(root);
    p += vec2f(f32(copy & 1u), f32(copy >> 1u)) * -sign(root - 0.5);
    let hidden = clump < scatter.place.w - 0.35 * (c.z - 0.5);
    o.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - 2.0 * p.y, 0.5, 1.0);
    if (hidden) { o.pos = vec4f(2.0, 2.0, 0.5, 1.0); }
    o.local = vec2f(t, across);
    o.height = height;
    o.rnd = vec4f(b.x, c.y, c.z, fract(a.x * 91.7 + a.y * 37.3));
    o.size = vec2f(len, wid);
    o.id = id;
    return o;
}

fn smin(a: f32, b: f32, k: f32) -> f32 { let h = sat(0.5 + 0.5 * (b - a) / k); return mix(b, a, h) - k * h * (1.0 - h); }

@fragment
fn pieceFragment(in: Out) -> Texel {
    let t = in.local.x;
    let s = in.local.y;
    var h = in.height;
    var aux = t;
    var tint = in.rnd.w;
    var keep = true;
    switch (scatter.shape) {
        case 0u: { // blade: a fold along the middle
            h -= abs(s) * in.size.y * 0.35;
        }
        case 1u: { // twig: round, with bark
            let r = 0.5 * in.size.y * (1.0 - 0.45 * t);
            h += r * sqrt(max(0.0, 1.0 - s * s));
            let bark = gnoise(vec2f(t * 60.0 + in.rnd.x * 50.0, s * 3.0 + 7.0), 4096, in.id);
            h += bark * r * 0.2;
            aux = 0.5 + 0.5 * bark;
            keep = abs(s) < 1.0;
        }
        case 2u: { // leaf: pointed oval, midrib and side veins
            let x = t * 2.0 - 1.0;
            let edge = (1.0 - x * x) * (0.75 + 0.35 * t) * (1.0 + 0.10 * sin(t * 40.0) * step(0.5, in.rnd.y));
            keep = abs(s) < edge;
            let rib = exp(-abs(s) * 26.0);
            let veins = smoothstep(0.75, 1.0, sin((t + abs(s) * 0.45) * 46.0));
            h += in.size.y * (0.10 * abs(s) * (in.rnd.x - 0.3) + 0.05 * (1.0 - x * x) * (in.rnd.y - 0.4)) - 0.0008 * veins + 0.0011 * rib;
            aux = sat(rib + 0.35 * veins);
        }
        case 3u: { // stone: a rounded body cut by a few flat faces
            let q = vec2f(t * 2.0 - 1.0, s);
            let a = atan2(q.y, q.x);
            let wob = 1.0 + 0.10 * sin(a * 2.0 + in.rnd.x * TAU) + 0.07 * sin(a * 3.0 + in.rnd.y * TAU) + 0.04 * sin(a * 5.0 + in.rnd.z * TAU);
            let d = length(q) / (0.86 * wob);
            keep = d < 1.0;
            var body = sqrt(max(0.0, 1.0 - pow(d, 2.4)));
            let angular = scatter.style.x;
            for (var k = 0u; k < 4u; k++) {
                let r = rand3(vec3u(in.id, scatter.seed, 20u + k));
                let dir = vec2f(cos(r.x * TAU), sin(r.x * TAU));
                let plane = mix(0.42, 0.95, r.y) - dot(q, dir) * mix(0.25, 1.15, r.z);
                body = mix(body, smin(body, plane, 0.06), angular);
            }
            let grain = gnoise(q * 9.0 + in.rnd.xy * 31.0, 4096, in.id) * 0.05 + gnoise(q * 23.0 + in.rnd.zy * 17.0, 4096, in.id + 5u) * 0.025;
            let lean = dot(q, in.rnd.xy - 0.5) * 0.35;
            h += in.size.y * 0.5 * scatter.style.w * max(0.0, body + grain + lean);
            aux = sat(0.5 + 6.0 * grain);
        }
        default: { // clover: three round leaflets
            let q = vec2f(t * 2.0 - 1.0, s);
            var best = 9.0;
            for (var k = 0; k < 3; k++) {
                let a = f32(k) * TAU / 3.0 + in.rnd.x * TAU;
                let d = q - 0.46 * vec2f(cos(a), sin(a));
                let rot = vec2f(dot(d, vec2f(cos(a), sin(a))), dot(d, vec2f(-sin(a), cos(a))));
                best = min(best, length(rot * vec2f(1.0, 1.15)));
            }
            keep = best < 0.47;
            aux = sat(best / 0.47);
            h += 0.004 * (1.0 - aux);
        }
    }
    if (!keep) { discard; }
    return Texel(vec4f(h, aux, tint, f32(scatter.kind)), depthOf(h));
}
`;
}

/** Slopes, cavity and colour. */
export function buildResolveShader() {
    return COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var relief: texture_2d<f32>;
@group(0) @binding(2) var albedoOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var surfaceOut: texture_storage_2d<rgba16float, write>;

fn at(p: vec2i) -> vec4f {
    let n = i32(layer.size);
    return textureLoad(relief, ((p % n) + n) % n, 0);
}

fn soilColor(tint: f32) -> vec3f {
    return mix(vec3f(0.040, 0.027, 0.017), vec3f(0.125, 0.088, 0.056), tint);
}
fn stoneColor(tint: f32, aux: f32, uv: vec2f) -> vec3f {
    var c = mix(vec3f(0.105, 0.101, 0.096), vec3f(0.205, 0.194, 0.178), tint);
    c = mix(c, vec3f(0.175, 0.138, 0.102), smoothstep(0.72, 0.95, fract(tint * 7.31)) * 0.75);
    return c * (0.85 + 0.3 * aux);
}

fn colorOf(v: vec4f, uv: vec2f, cavity: f32) -> vec4f { // w roughness
    let aux = v.y;
    let tint = v.z;
    let kind = u32(v.w + 0.5);
    let s = layer.seed;
    switch (kind) {
        case 1u: { // green blade
            let young = vec3f(0.095, 0.118, 0.026);
            let old = vec3f(0.060, 0.085, 0.022);
            var c = mix(old, young, tint);
            c = mix(c * 0.62, c * 1.2, smoothstep(0.0, 0.75, aux));
            c = mix(c, vec3f(0.235, 0.205, 0.080), smoothstep(0.55, 1.0, aux) * smoothstep(0.35, 0.95, fract(tint * 5.7)) * 0.8);
            c = mix(c, vec3f(0.25, 0.19, 0.095) * (0.5 + 0.6 * aux), step(1.0 - layer.look.x, fract(tint * 13.3)));
            return vec4f(c, 0.72);
        }
        case 2u: { // straw
            let c = mix(vec3f(0.155, 0.112, 0.055), vec3f(0.33, 0.265, 0.145), tint);
            return vec4f(c * (0.62 + 0.5 * aux), 0.8);
        }
        case 3u: { // fallen leaf
            var c = mix(vec3f(0.092, 0.050, 0.024), vec3f(0.205, 0.108, 0.040), fract(tint * 3.1));
            c = mix(c, vec3f(0.245, 0.165, 0.062), smoothstep(0.6, 0.9, fract(tint * 11.0)));
            c = mix(c, vec3f(0.085, 0.092, 0.030), smoothstep(0.8, 0.95, fract(tint * 17.0)));
            let blotch = fbm(uv, 90, 2, 0.5, s + 3u);
            return vec4f(c * (0.85 + 0.35 * blotch) * (1.0 + 0.45 * aux), 0.62);
        }
        case 4u: { // twig
            let c = mix(vec3f(0.070, 0.050, 0.034), vec3f(0.195, 0.168, 0.140), tint);
            return vec4f(c * (0.65 + 0.6 * aux), 0.8);
        }
        case 5u: {
            var c = stoneColor(tint, aux, uv);
            let lichen = smoothstep(0.20, 0.34, fbm(uv, 34, 3, 0.6, s + 8u)) * layer.look.y;
            c = mix(c, mix(vec3f(0.20, 0.21, 0.15), vec3f(0.23, 0.17, 0.06), step(0.6, fract(tint * 9.0))), lichen * 0.7);
            return vec4f(c, 0.75);
        }
        case 6u: { // moss
            let c = mix(vec3f(0.028, 0.042, 0.008), vec3f(0.085, 0.105, 0.020), tint);
            return vec4f(c, 0.9);
        }
        case 7u: { // clover
            let c = mix(vec3f(0.045, 0.078, 0.020), vec3f(0.075, 0.115, 0.032), tint);
            return vec4f(c * (0.7 + 0.45 * aux), 0.65);
        }
        default: {}
    }
    switch (layer.index) {
        case 5u: { // rock
            var c = mix(vec3f(0.112, 0.108, 0.103), vec3f(0.190, 0.181, 0.167), tint);
            let mineral = fbm(uv, 5, 4, 0.55, s + 101u);
            c = mix(c, vec3f(0.165, 0.130, 0.098), smoothstep(0.05, 0.5, mineral) * 0.55);
            let streak = fbm(uv * vec2f(1.0, 1.0), 26, 2, 0.5, s + 102u);
            c *= 0.9 + 0.22 * streak;
            let spots = smoothstep(0.16, 0.30, fbm(uv, 19, 4, 0.62, s + 103u));
            c = mix(c, vec3f(0.235, 0.235, 0.195), spots * 0.42);
            let gold = smoothstep(0.30, 0.40, fbm(uv, 23, 4, 0.62, s + 104u));
            c = mix(c, vec3f(0.215, 0.155, 0.055), gold * 0.4);
            let black = smoothstep(0.18, 0.42, fbm(uv, 9, 4, 0.6, s + 105u));
            c *= 1.0 - 0.24 * black;
            c = mix(c, vec3f(0.060, 0.056, 0.048), aux * 0.5);
            let grain = fbm(uv, 220, 2, 0.6, s + 106u);
            return vec4f(c * (1.0 + 0.28 * grain), 0.8);
        }
        case 6u: {
            let c = mix(vec3f(0.36, 0.270, 0.165), vec3f(0.50, 0.400, 0.265), tint);
            return vec4f(c * (0.86 + 0.18 * aux), 0.85);
        }
        case 7u: {
            let c = mix(vec3f(0.74, 0.78, 0.84), vec3f(0.84, 0.865, 0.89), tint);
            return vec4f(c, 0.5 + 0.25 * aux);
        }
        case 8u: {
            let c = mix(vec3f(0.050, 0.040, 0.030), vec3f(0.112, 0.092, 0.070), tint);
            return vec4f(c, 0.42);
        }
        default: {
            let dead = smoothstep(0.1, 0.35, fbm(uv, 60, 3, 0.6, s + 5u));
            return vec4f(mix(soilColor(tint), vec3f(0.135, 0.105, 0.062), dead * layer.look.z), 0.88);
        }
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = i32(textureDimensions(albedoOut).x);
    if (any(vec2i(id.xy) >= vec2i(size))) { return; }
    let scale = i32(layer.size) / size;
    let texel = layer.period / layer.size;
    var albedo = vec3f(0.0); var slope = vec2f(0.0); var rough = 0.0; var ao = 0.0; var height = 0.0;
    for (var sy = 0; sy < scale; sy++) { for (var sx = 0; sx < scale; sx++) {
        let p = vec2i(id.xy) * scale + vec2i(sx, sy);
        let v = at(p);
        let gx = at(p + vec2i(1, 0)).x - at(p - vec2i(1, 0)).x;
        let gy = at(p + vec2i(0, 1)).x - at(p - vec2i(0, 1)).x;
        let g = vec2f(gx, gy) / (2.0 * texel);
        // Sky seen from here: horizons in eight directions at growing steps.
        var open = 0.0;
        for (var k = 0; k < 8; k++) {
            let a = (f32(k) + 0.5 * f32((sx ^ sy) & 1)) * TAU / 8.0;
            let dir = vec2f(cos(a), sin(a));
            var top = 0.0;
            var r = 2.0;
            for (var j = 0; j < 6; j++) {
                let h = at(p + vec2i(round(dir * r))).x - v.x;
                top = max(top, h / (r * texel));
                r *= 2.0;
            }
            let sine = top / sqrt(1.0 + top * top);
            open += 1.0 - sine * sine;
        }
        let uv = (vec2f(p) + 0.5) / layer.size;
        let c = colorOf(v, uv, open / 8.0);
        albedo += c.rgb; rough += c.a; ao += open / 8.0; height += v.x;
        // Steep edges clamp instead of wrapping the encoding.
        slope += g / max(1.0, length(g) / layer.mean.w);
    } }
    let k = 1.0 / f32(scale * scale);
    ao *= k;
    // Crevices keep dirt and stay darker than the light alone makes them.
    albedo *= k * mix(0.72, 1.0, smoothstep(0.15, 0.85, ao));
    textureStore(albedoOut, id.xy, vec4f(albedo, height * k));
    textureStore(surfaceOut, id.xy, vec4f(slope * k / layer.mean.w, rough * k, ao));
}
`;
}

/** Averages 2x2 into the next mip. */
export const GROUND_MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var target0: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let n = vec2i(textureDimensions(source));
    let p = vec2i(id.xy) * 2;
    var sum = vec4f(0.0);
    for (var k = 0; k < 4; k++) { sum += textureLoad(source, min(p + vec2i(k & 1, k >> 1), n - 1), 0); }
    textureStore(target0, id.xy, sum * 0.25);
}
`;

/** Stores one mip: the mean colour set exactly, sRGB coded by hand (the sRGB view decodes it), height 0..1 in alpha. */
export function buildStoreShader() {
    return COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var smallest: texture_2d<f32>;
@group(0) @binding(3) var target0: texture_storage_2d<rgba8unorm, write>;
fn toSrgb(c: vec3f) -> vec3f {
    return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308));
}
@compute @workgroup_size(8, 8)
fn albedo(@builtin(global_invocation_id) id: vec3u) {
    let v = textureLoad(source, id.xy, 0);
    let mean = textureLoad(smallest, vec2i(0), 0);
    let c = v.rgb * layer.mean.rgb / max(mean.rgb, vec3f(1.0e-4));
    textureStore(target0, id.xy, vec4f(toSrgb(clamp(c, vec3f(0.0), vec3f(1.0))), clamp(0.5 + (v.a - mean.a) * layer.look.w, 0.0, 1.0)));
}
@compute @workgroup_size(8, 8)
fn raw(@builtin(global_invocation_id) id: vec3u) {
    textureStore(target0, id.xy, textureLoad(source, id.xy, 0));
}
@compute @workgroup_size(8, 8)
fn surface(@builtin(global_invocation_id) id: vec3u) {
    let v = textureLoad(source, id.xy, 0);
    textureStore(target0, id.xy, vec4f(v.xy * 0.5 + 0.5, v.zw));
}
`;
}

/**
 * Wide patterns: the mosaic of a meadow (masks and hummocks), the face of a cliff, and the broad fields.
 * look.y: which variant of a pattern, -1 for the border they share (so any can lie beside any other, turned around or not).
 */
export function buildWideShader() {
    return COMMON + BEDS + /* wgsl */`
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var masksOut: texture_storage_2d<rgba16float, write>;

// Smooth bumps, each its own size: no creases where they meet.
fn bumps(uv: vec2f, n: i32, sharp: f32, seed: u32) -> vec2f {
    let p = uv * f32(n);
    let i = vec2i(floor(p));
    let f = p - floor(p);
    var v = vec2f(0.0);
    for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
        let r = cellRand(i + vec2i(x, y), n, seed);
        let d = vec2f(f32(x), f32(y)) + 0.5 + (r.xy - 0.5) * 0.8 - f;
        let k = exp(-dot(d, d) * sharp * (0.7 + r.z));
        v += vec2f(k * r.z, k);
    } }
    return v;
}
// x hummock height (m), y bare ground, z stones, w dryness
fn mosaic(uv: vec2f, s: u32) -> vec4f {
    let w = vec2f(fbm(uv, 8, 5, 0.55, s + 1u), fbm(uv, 8, 5, 0.55, s + 2u));
    let q = uv + 0.0175 * w;
    let tussock = bumps(uv + 0.002 * w, 240, 5.0, s + 3u).x * smoothstep(-0.35, 0.35, fbm(uv, 18, 3, 0.5, s + 13u));
    let clump = bumps(q, 74, 4.0, s + 4u).x;
    let broad = fbm(uv, 7, 6, 0.55, s + 5u);
    let h = 0.15 * tussock + 0.26 * clump + 0.70 * broad + 0.055 * fbm(uv, 300, 1, 0.6, s + 6u);
    // Bare ground in worn patches with ragged rims, and thin trails.
    let patches = fbm(uv + 0.035 * w, 5, 8, 0.66, s + 7u);
    let trail = 1.0 - smoothstep(0.0, 0.045, abs(gnoiseTurned(q, vec2i(4, 3), vec2f(0.0), s + 8u) + 0.06 * fbm(uv, 48, 3, 0.5, s + 9u)));
    let bare = sat(0.5 + 1.1 * patches + 0.40 * trail - 0.22 * tussock);
    let stone = smoothstep(0.30, 0.75, bumps(q, 128, 9.0, s + 10u).x * smoothstep(-0.05, 0.4, fbm(uv, 8, 4, 0.5, s + 11u)) * 1.5);
    let dry = sat(0.5 + 0.95 * fbm(uv + 0.03 * w, 5, 8, 0.68, s + 12u));
    return vec4f(h + 0.10 * stone, bare, stone, dry);
}
// The ground's broadest differences, from a kilometre down to what the mosaic takes over. x lush (less 0.5), y bare, z how lively, w dry
fn fields(uv: vec2f, s: u32) -> vec4f {
    let w = vec2f(fbm(uv, 5, 6, 0.55, s + 1u), fbm(uv, 5, 6, 0.55, s + 2u));
    let q = uv + 0.045 * w;
    // Some land is patchy, some even.
    let lively = smoothstep(-0.45, 0.45, fbm(uv, 4, 4, 0.5, s + 9u));
    let k = mix(0.55, 1.25, lively);
    return vec4f(clamp(0.85 * k * fbm(q, 7, 7, 0.72, s + 5u), -0.5, 0.5), sat(0.5 + 1.1 * k * fbm(q, 9, 7, 0.74, s + 7u)), lively,
        sat(0.5 + 1.0 * k * fbm(q, 6, 7, 0.74, s + 12u)));
}
fn cliff(uv: vec2f, s: u32) -> vec4f {
    let b = rockBed(uv, 2, s);
    return vec4f(b.height * 5.0, b.aux, b.tint, 0.0);
}
fn pattern(uv: vec2f, s: u32) -> vec4f {
    switch layer.index {
        case 0u: { return mosaic(uv, s); }
        case 1u: { return cliff(uv, s); }
        default: { return fields(uv, s); }
    }
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let uv = (vec2f(id.xy) + 0.5) / vec2f(textureDimensions(masksOut));
    if (layer.look.y < 0.0) {
        // The border of all variants: the first one's, made the same when turned around.
        let middle = select(vec4f(0.0, 0.5, 0.0, 0.5), vec4f(0.0, 0.0, 0.5, 0.0), layer.index == 1u);
        textureStore(masksOut, id.xy, middle + (pattern(uv, layer.seed) + pattern(1.0 - uv, layer.seed) - 2.0 * middle) * 0.70711);
        return;
    }
    let v = pattern(uv, layer.seed + 1000u * u32(layer.look.y));
    textureStore(masksOut, id.xy, v);
}
`;
}

/** Slopes and openness of a wide pattern; look.z: how many variants share the border. */
export function buildWideResolveShader() {
    return COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var masks: texture_2d<f32>;
@group(0) @binding(2) var border: texture_2d<f32>;
@group(0) @binding(3) var masksOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var slopesOut: texture_storage_2d<rgba16float, write>;
fn at(t: texture_2d<f32>, p: vec2i) -> vec4f {
    let n = vec2i(textureDimensions(t));
    return textureLoad(t, ((p % n) + n) % n, 0);
}
// Slope and openness of a pattern's height.
fn shape(t: texture_2d<f32>, p: vec2i) -> vec3f {
    let texel = layer.period / f32(textureDimensions(t).x);
    let h = at(t, p).x;
    var g = vec2f(at(t, p + vec2i(1, 0)).x - at(t, p - vec2i(1, 0)).x, at(t, p + vec2i(0, 1)).x - at(t, p - vec2i(0, 1)).x) / (2.0 * texel);
    var open = 0.0;
    for (var k = 0; k < 8; k++) {
        let a = (f32(k) + 0.25) * TAU / 8.0;
        let dir = vec2f(cos(a), sin(a));
        var top = 0.0;
        var r = 1.5;
        for (var j = 0; j < 6; j++) {
            top = max(top, (at(t, p + vec2i(round(dir * r))).x - h) / (r * texel));
            r *= 1.9;
        }
        open += 1.0 / (1.0 + top * top);
    }
    return vec3f(g, open / 8.0);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = vec2i(id.xy);
    var m = at(masks, p);
    var s = shape(masks, p);
    if (layer.look.z > 1.0) {
        // Slopes are blended, not heights: those would make a step. As lively as what they mix.
        let uv = (vec2f(id.xy) + 0.5) / vec2f(textureDimensions(masks));
        let e = min(uv, 1.0 - uv);
        let own = smoothstep(0.045, 0.16, min(e.x, e.y) + 0.035 * fbm(uv, 10, 5, 0.6, layer.seed + 5000u));
        if (own < 1.0) {
            let k = 1.0 / length(vec2f(own, 1.0 - own));
            let middle = select(vec4f(0.0, 0.5, 0.0, 0.5), vec4f(0.0, 0.0, 0.5, 0.0), layer.index == 1u);
            m = middle + (mix(at(border, p), m, own) - middle) * k;
            s = mix(shape(border, p), s, own) * vec3f(k, k, 1.0);
        }
    }
    let g = s.xy / max(1.0, length(s.xy) / layer.mean.w);
    let h = sat(0.5 + m.x * layer.look.x);
    textureStore(masksOut, id.xy, vec4f(h, m.yzw));
    // The cliff's fourth channel is its tint: one texture read gives all of it.
    textureStore(slopesOut, id.xy, vec4f(g / layer.mean.w, s.z, select(h, m.z * (1.0 - 0.35 * m.y) * (0.75 + 0.5 * h), layer.index == 1u)));
}
`;
}
