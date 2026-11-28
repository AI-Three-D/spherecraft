// @ts-nocheck
// Places, hashes, the sphere's metric and ownership across face edges, for shaders (ECOLOGY_FOUNDATION_PLAN.md F1).
// ecologyLattice.js is the CPU mirror: the same values bit for bit. Faces as the terrain's getCubePoint.
//
// ECOLOGY_LATTICE_WGSL defines pcg, hash3, u01, step3 (the grass's names, so a shader holds them once).

export const ECOLOGY_LATTICE_WGSL = /* wgsl */`
fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn hash3(x: u32, y: u32, z: u32) -> u32 { return pcg(x ^ pcg(y ^ pcg(z + 0x9e3779b9u))); }
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
fn step3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }

// The hash of a cell of a layer (ecologyLattice.js ECO_LAYERS): grass (0) with world seed 0 is hash3(x, y, face).
fn ecoCellHash(face: u32, ix: u32, iy: u32, layer: u32, worldSeed: u32) -> u32 {
    return hash3(ix, iy, face + 8u * (layer + 8u * worldSeed));
}
// The k-th draw from a cell's hash.
fn ecoDraw(cellHash: u32, k: u32) -> u32 { return pcg(cellHash + (k + 1u) * 0x9E3779B9u); }

// Lattice points ranked so that the coarser ones of a nested set come first: a point on every 2^k-th row and column
// has a rank under 4^-k, so a layer thinning by rank drops points one at a time as the camera moves.
fn latticeLevel(g: vec2<u32>) -> u32 { return countTrailingZeros(g.x | g.y | 16u); }
fn latticeRank(level: u32, u: f32) -> f32 {
    let hi = exp2(-2.0 * f32(level));
    let lo = select(hi * 0.25, 0.0, level >= 4u);
    return mix(lo, hi, u);
}

// Value noise over a 3D position (0..1): continuous across cube faces and at the poles, for anything that varies over
// the world (the wind's gusts, stands). Integer cells offset by 2^22: fine for positions to 4 million cells.
fn ecoNoise3(p: vec3<f32>, seed: u32) -> f32 {
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

// A stable id of a candidate (lo, hi), and the one order of candidates: higher priority first, then the smaller id.
fn ecoId(face: u32, level: u32, ix: u32, iy: u32, k: u32) -> vec2<u32> {
    return vec2<u32>((ix & 0xFFFFFFu) | ((k & 0xFFu) << 24u), (iy & 0xFFFFFFu) | ((level & 31u) << 24u) | ((face & 7u) << 29u));
}
fn ecoBefore(priorityA: u32, idA: vec2<u32>, priorityB: u32, idB: vec2<u32>) -> bool {
    if (priorityA != priorityB) { return priorityA > priorityB; }
    if (idA.y != idB.y) { return idA.y < idB.y; }
    return idA.x < idB.x;
}

// The point of a face at (u, v), which may lie past 0..1 (on the face's plane beyond its edge), not normalized.
fn ecoFaceDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let st = uv * 2.0 - 1.0;
    switch (face) {
        case 0u: { return vec3<f32>(1.0, st.y, -st.x); }
        case 1u: { return vec3<f32>(-1.0, st.y, st.x); }
        case 2u: { return vec3<f32>(st.x, 1.0, -st.y); }
        case 3u: { return vec3<f32>(st.x, -1.0, st.y); }
        case 4u: { return vec3<f32>(st.x, st.y, 1.0); }
        default: { return vec3<f32>(-st.x, st.y, -1.0); }
    }
}
// A direction's (u, v) on a given face's plane (past 0..1 when it falls on another face).
fn ecoUvOnFace(face: u32, dir: vec3<f32>) -> vec2<f32> {
    let c = dir / dot(dir, ecoFaceDirection(face, vec2<f32>(0.5)));
    var st = vec2<f32>(0.0);
    switch (face) {
        case 0u: { st = vec2<f32>(-c.z, c.y); }
        case 1u: { st = vec2<f32>(c.z, c.y); }
        case 2u: { st = vec2<f32>(c.x, -c.z); }
        case 3u: { st = vec2<f32>(c.x, c.z); }
        case 4u: { st = vec2<f32>(c.x, c.y); }
        default: { st = vec2<f32>(-c.x, c.y); }
    }
    return (st + 1.0) * 0.5;
}
// The face a direction falls on, and its (u, v) there: (face, u, v).
fn ecoDirectionToFace(dir: vec3<f32>) -> vec3<f32> {
    let a = abs(dir);
    var face = 4u;
    if (a.x >= a.y && a.x >= a.z) { face = select(1u, 0u, dir.x >= 0.0); }
    else if (a.y >= a.z) { face = select(3u, 2u, dir.y >= 0.0); }
    else { face = select(5u, 4u, dir.z >= 0.0); }
    return vec3<f32>(f32(face), ecoUvOnFace(face, dir));
}
// The cell (dx, dy) cells from a cell of a level, across its face's edge if beyond it: (face, ix, iy).
fn ecoNeighbourCell(face: u32, level: u32, cell: vec2<u32>, d: vec2<i32>) -> vec3<u32> {
    let n = 1u << level;
    let j = vec2<i32>(cell) + d;
    if (all(j >= vec2<i32>(0)) && all(j < vec2<i32>(i32(n)))) { return vec3<u32>(face, vec2<u32>(j)); }
    let to = ecoDirectionToFace(ecoFaceDirection(face, (vec2<f32>(j) + 0.5) / f32(n)));
    let k = clamp(vec2<i32>(floor(to.yz * f32(n))), vec2<i32>(0), vec2<i32>(i32(n) - 1));
    return vec3<u32>(u32(to.x), vec2<u32>(k));
}
// A cell's true area on a sphere of radius R (m^2), and its edge lengths along u and v at its middle (m).
fn ecoSolidRect(s: f32, t: f32) -> f32 { return atan2(s * t, sqrt(1.0 + s * s + t * t)); }
fn ecoCellArea(level: u32, cell: vec2<u32>, radius: f32) -> f32 {
    let n = f32(1u << level);
    let s0 = 2.0 * f32(cell.x) / n - 1.0;
    let s1 = 2.0 * f32(cell.x + 1u) / n - 1.0;
    let t0 = 2.0 * f32(cell.y) / n - 1.0;
    let t1 = 2.0 * f32(cell.y + 1u) / n - 1.0;
    return radius * radius * (ecoSolidRect(s1, t1) - ecoSolidRect(s0, t1) - ecoSolidRect(s1, t0) + ecoSolidRect(s0, t0));
}
fn ecoCellAxes(level: u32, cell: vec2<u32>, radius: f32) -> vec2<f32> {
    let n = f32(1u << level);
    let st = 2.0 * (vec2<f32>(cell) + 0.5) / n - 1.0;
    let q = 1.0 + dot(st, st);
    return radius * (2.0 / n) * sqrt(1.0 + st.yx * st.yx) / q;
}
`;
