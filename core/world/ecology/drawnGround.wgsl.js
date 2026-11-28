// @ts-nocheck
// Standing on the ground (ECOLOGY_FOUNDATION_PLAN.md F2): the faces about the camera and their anchors (GroundFrame.js),
// the loaded tiles, the ground the terrain draws this frame (a rendering surface: what stands on it does not float or
// sink when the terrain draws coarser meshes near the camera), and the generator's finest loaded heights (a stable
// height: what decides where something grows, or what it collides with, never changes with the camera).
//
// buildDrawnGroundWGSL({ frame, loaded, visible, height }) declares the bindings at the [group, binding] given and the
// functions. The shader using it supplies nothing else; patch coordinates are cells of the lattice GROUND_LEVELS below
// the deepest terrain level (GroundFrame.js: 2 m at a 131 km radius with 11 levels).

export const GROUND_LEVELS = 6;
export const GROUND_MAX_FACES = 3;
/** Floats of the GroundFrame uniform block (GroundFrame.js). */
export const GROUND_FRAME_FLOATS = 16 + GROUND_MAX_FACES * 24;

export const GROUND_DRAWN = 0;
export const GROUND_LOADED = 1;
export const GROUND_NONE = 2;

export const GROUND_FRAME_WGSL = /* wgsl */`
struct GroundFace {
    ca: vec4<f32>,      // the anchor's point on the cube (exact in floats), its length
    du: vec4<f32>,      // how that point moves per patch along the face's x, the face
    dv: vec4<f32>,      // per patch along y, metres a patch spans on the sphere (largest side)
    da: vec4<f32>,      // the anchor's direction times the radius, less the camera (from the planet's centre), m
    na: vec4<f32>,      // the anchor's direction, patch area on the sphere (m^2)
    anchor: vec4<i32>,  // the anchor patch x, y on its face, the face, the patch grid's half width for the frame's reach
};
struct GroundFrame {
    up: vec4<f32>,      // up at the camera, planet radius (m)
    tables: vec4<u32>,  // faces, deepest terrain level, loaded table mask, loaded table capacity
    visible: vec4<u32>, // drawn tiles' table: mask, capacity, this frame's epoch, coarsest mesh level
    scale: vec4<f32>,   // height scale (m), face size (m), reach (m), unused
    faces: array<GroundFace, ${GROUND_MAX_FACES}>,
};
`;

export function buildDrawnGroundWGSL({ frame = [0, 0], loaded = [0, 1], visible = [0, 2], height = [0, 3] } = {}) {
    const at = ([g, b]) => `@group(${g}) @binding(${b})`;
    return /* wgsl */`${GROUND_FRAME_WGSL}
${at(frame)} var<uniform> ground: GroundFrame;
${at(loaded)} var<storage, read> groundLoaded: array<u32>;
${at(visible)} var<storage, read> groundVisible: array<vec4<u32>>;
${at(height)} var groundHeight: texture_2d_array<f32>;
const GROUND_LEVELS: u32 = ${GROUND_LEVELS}u;
const GROUND_DRAWN: u32 = ${GROUND_DRAWN}u;
const GROUND_LOADED: u32 = ${GROUND_LOADED}u;
const GROUND_NONE: u32 = ${GROUND_NONE}u;

// ---- the loaded tiles (residentTileHeightLookupWgsl.js)
fn groundHashKey(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    return ((kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u)) & ground.tables.z;
}
// A tile's key in the loaded and drawn tables: (lo, hi).
fn groundTileKey(face: u32, depth: u32, x: u32, y: u32) -> vec2<u32> {
    return vec2<u32>((x & 0xFFFFu) | ((y & 0xFFFFu) << 16u), (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u));
}
// A loaded tile's layer, with 4096 added when its material (the beds) is made; -1 when not loaded.
fn groundLookupLayer(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let key = groundTileKey(face, depth, x, y);
    var idx = groundHashKey(key.x, key.y);
    for (var i = 0u; i < min(ground.tables.w, 256u); i++) {
        let base = idx * 4u;
        let hi = groundLoaded[base + 1u];
        if (hi == 0xFFFFFFFFu) { return -1; }
        if (hi == key.y && groundLoaded[base] == key.x) {
            let made = groundLoaded[base + 3u] != 0xFFFFFFFFu && (groundLoaded[base + 3u] & 1u) != 0u;
            return i32(groundLoaded[base + 2u] & 4095u) + select(0, 4096, made);
        }
        idx = (idx + 1u) & ground.tables.z;
    }
    return -1;
}
// The finest loaded tile over a patch (up to 3 levels coarser): its layer (4096 more with beds), and patches per tile
// edge as a shift. x -1: none.
fn groundTileOver(face: u32, p: vec2<u32>) -> vec2<i32> {
    for (var k = 0u; k < 4u; k++) {
        let depth = ground.tables.y - k;
        let shift = GROUND_LEVELS + k;
        let layer = groundLookupLayer(face, depth, p.x >> shift, p.y >> shift);
        if (layer >= 0) { return vec2<i32>(layer, i32(shift)); }
    }
    return vec2<i32>(-1, 0);
}
// Where in its tile a point of a patch lies (0..1): f is the point within the patch (0..1, or past it).
fn groundInTile(p: vec2<u32>, shift: u32, f: vec2<f32>) -> vec2<f32> {
    return (vec2<f32>(p & vec2<u32>((1u << shift) - 1u)) + f) / f32(1u << shift);
}

// ---- the ground as the terrain draws it: the terrain picks coarser meshes for high ground near the camera (2-16 m
// fans), and finer heights there leave what stands on them under or over the surface by up to metres.
fn groundHashKeyVisible(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    return ((kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u)) & ground.visible.x;
}
fn groundVisibleAt(face: u32, depth: u32, x: u32, y: u32) -> bool {
    let key = groundTileKey(face, depth, x, y);
    let start = groundHashKeyVisible(key.x, key.y);
    for (var i = 0u; i < min(ground.visible.y, 128u); i++) {
        let e = groundVisible[(start + i) & ground.visible.x];
        if (e.y == 0xFFFFFFFFu) { return false; }
        if (e.y == key.y && e.x == key.x && e.z == ground.visible.z) { return true; }
    }
    return false;
}
// The drawn tile over a patch: x its geometry's layer (4096 more when its material is made), y patches per drawn tile
// edge as a shift, z ancestor levels up to the geometry's layer, w the mesh's level. Not drawn (beside the view): the
// finest loaded tile, w -1. x -1: none drawn or loaded.
fn groundDrawnOver(face: u32, p: vec2<u32>) -> vec4<i32> {
    let deepest = ground.tables.y;
    var depth = deepest + 1u;
    for (var k = 0u; k <= 7u && k <= deepest; k++) {
        let d = deepest - k;
        let t = p >> vec2<u32>(GROUND_LEVELS + k);
        if (groundVisibleAt(face, d, t.x, t.y)) { depth = d; break; }
    }
    if (depth > deepest) {
        let loaded = groundTileOver(face, p);
        return vec4<i32>(loaded.x, loaded.y, 0, select(-1, 0, loaded.x < 0));
    }
    let shift = GROUND_LEVELS + deepest - depth;
    // Geometry: the nearest loaded layer, own then ancestors (instanceBufferBuilder.wgsl.js).
    for (var up = 0u; up < 5u && up <= depth; up++) {
        let t = p >> vec2<u32>(shift + up);
        let layer = groundLookupLayer(face, depth - up, t.x, t.y);
        if (layer >= 0) { return vec4<i32>(layer, i32(shift), i32(up), i32(min(deepest - depth, ground.visible.w))); }
    }
    return vec4<i32>(-1, 0, 0, 0);
}
// A texel row of the 129 x 129 vertex grid of a drawn tile, as terrainChunkVertexShaderBuilder.js sampleHeightChunkLocal
// takes it from its layer: own tile (up 0), or the part of an ancestor's.
fn groundVertexHeight(layer: i32, up: u32, part: vec2<f32>, v: vec2<f32>) -> f32 {
    let size = vec2<f32>(textureDimensions(groundHeight));
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
    let h0 = mix(textureLoad(groundHeight, a, layer, 0).r, textureLoad(groundHeight, vec2<i32>(b.x, a.y), layer, 0).r, f.x);
    let h1 = mix(textureLoad(groundHeight, vec2<i32>(a.x, b.y), layer, 0).r, textureLoad(groundHeight, b, layer, 0).r, f.x);
    return mix(h0, h1, f.y) * ground.scale.x;
}
// The adaptive cell of a drawn tile's mesh over grid point g (terrainGeometryBuilder.js _buildAdaptiveCells): x, z, size.
fn groundMeshCell(g: vec2<f32>, maxStep: i32) -> vec3<i32> {
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
fn groundDrawnHeight(layer: i32, up: u32, part: vec2<f32>, lod: u32, local: vec2<f32>) -> f32 {
    let g = clamp(local, vec2<f32>(0.0), vec2<f32>(0.99999)) * 128.0;
    let maxStep = min(1 << lod, 128);
    let cell = groundMeshCell(g, maxStep);
    let c0 = vec2<f32>(cell.xy);
    let size = f32(cell.z);
    if (cell.z <= 1) {
        // Two triangles split from (x1, z0) to (x0, z1).
        let f = g - c0;
        if (f.x + f.y < 1.0) {
            let h00 = groundVertexHeight(layer, up, part, c0);
            return h00 + f.x * (groundVertexHeight(layer, up, part, c0 + vec2<f32>(1.0, 0.0)) - h00) + f.y * (groundVertexHeight(layer, up, part, c0 + vec2<f32>(0.0, 1.0)) - h00);
        }
        let h11 = groundVertexHeight(layer, up, part, c0 + 1.0);
        return h11 + (1.0 - f.x) * (groundVertexHeight(layer, up, part, c0 + vec2<f32>(0.0, 1.0)) - h11) + (1.0 - f.y) * (groundVertexHeight(layer, up, part, c0 + vec2<f32>(1.0, 0.0)) - h11);
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
            let n = groundMeshCell(vec2<f32>(outside, clamp(z, c0.y, c0.y + size - 0.001)), maxStep);
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
            let n = groundMeshCell(vec2<f32>(clamp(x, c0.x, c0.x + size - 0.001), outside), maxStep);
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
    let hc = groundVertexHeight(layer, up, part, centre);
    return hc + wa * (groundVertexHeight(layer, up, part, a) - hc) + wb * (groundVertexHeight(layer, up, part, b) - hc);
}
// The generator's heights at a point of a loaded tile (0..1), between texels as the terrain's vertices take them (m).
fn groundHeightAt(layer: i32, local: vec2<f32>) -> f32 {
    let last = vec2<i32>(textureDimensions(groundHeight)) - 1;
    let at = clamp(local, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(last);
    let i = min(vec2<i32>(floor(at)), last);
    let j = min(i + 1, last);
    let f = at - vec2<f32>(i);
    let h0 = mix(textureLoad(groundHeight, i, layer, 0).r, textureLoad(groundHeight, vec2<i32>(j.x, i.y), layer, 0).r, f.x);
    let h1 = mix(textureLoad(groundHeight, vec2<i32>(i.x, j.y), layer, 0).r, textureLoad(groundHeight, j, layer, 0).r, f.x);
    return mix(h0, h1, f.y) * ground.scale.x;
}

// ---- what callers use
struct GroundSample { height: f32, status: u32, tile: vec4<i32> };
// The ground the terrain draws at a point of patch p (f within it): GROUND_DRAWN, rebuilt from the mesh drawn this
// frame; GROUND_LOADED, a tile beside the view, its finest loaded heights; GROUND_NONE, nothing loaded. A caller keeps
// the tile and status it got with what it placed, and places it again when they change (only the height follows).
fn groundDrawnAt(face: u32, p: vec2<u32>, f: vec2<f32>) -> GroundSample {
    let tile = groundDrawnOver(face, p);
    if (tile.x < 0) { return GroundSample(0.0, GROUND_NONE, tile); }
    let up = u32(tile.z);
    let part = vec2<f32>((p >> vec2<u32>(u32(tile.y))) & vec2<u32>((1u << up) - 1u)) / f32(1u << up);
    let local = groundInTile(p, u32(tile.y), f);
    if (tile.w < 0) { return GroundSample(groundHeightAt(tile.x & 4095, local), GROUND_LOADED, tile); }
    return GroundSample(groundDrawnHeight(tile.x & 4095, up, part, u32(tile.w), local), GROUND_DRAWN, tile);
}
// The generator's height at a point of patch p, whatever the camera sees: for where things grow and for collision.
fn groundStableAt(face: u32, p: vec2<u32>, f: vec2<f32>) -> GroundSample {
    let tile = groundTileOver(face, p);
    if (tile.x < 0) { return GroundSample(0.0, GROUND_NONE, vec4<i32>(tile, 0, -1)); }
    return GroundSample(groundHeightAt(tile.x & 4095, groundInTile(p, u32(tile.y), f)), GROUND_LOADED, vec4<i32>(tile, 0, -1));
}

// A point of the face, d patches from a face's anchor, at height h (m): from the camera, and its direction from the
// planet's centre. n1 - na = dc / |c1| + ca (1 / |c1| - 1 / |ca|), the last bracket as a quotient of small numbers, so it
// keeps a tenth of a millimetre at 60 m in floats (grassWgsl.test.js).
struct GroundPlace { rel: vec3<f32>, up: vec3<f32> };
fn groundPlace(F: GroundFace, d: vec2<f32>, h: f32) -> GroundPlace {
    let dc = F.du.xyz * d.x + F.dv.xyz * d.y;
    let la = F.ca.w;
    let grow = 2.0 * dot(F.ca.xyz, dc) + dot(dc, dc);
    let l1 = sqrt(la * la + grow);
    let dn = dc / l1 - F.ca.xyz * (grow / ((la + l1) * l1 * la));
    let up = F.na.xyz + dn;
    return GroundPlace(ground.up.w * dn + F.da.xyz + h * up, up);
}
`;
}
