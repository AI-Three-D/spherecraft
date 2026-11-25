// Which tiles are drawn, with which mesh and which shader (TerrainPass.js). The quadtree's own list is kept wide, all
// around the camera, for streaming; what is drawn of it is decided here with every tile's true height range.

import { TILE_BLOCKS } from '../../../world/quadtree/tileBounds.js';

/** What a tile's shader has to do. NEAR: close surfaces. MID: none so close, and the way into the far tier. FAR: that alone. ALL: everything. */
export const TILE_KIND = Object.freeze({ NEAR: 0, MID: 1, FAR: 2, ALL: 3 });
export const TILE_KINDS = 4;
/** Buckets of one mesh: the kinds, each dry and with far water. */
export const TILE_CLASSES = TILE_KINDS * 2;
export const DRAW_LIST_FRAME_FLOATS = 5 * 4 + 7 * 4 + 16;
/** Screen rectangle of the sea: least x, y, largest x, y (1 is SEA_VIEW_ONE), 1 when there is sea about, 1 when the camera is under the ground. */
export const SEA_VIEW_WORDS = 8;
export const SEA_VIEW_ONE = 8192;
const THREADS = 64;
/** The horizon around the camera: directions, and rings from one distance to another (m), each as much wider than the last. */
export const HORIZON_DIRECTIONS = 512;
export const HORIZON_RINGS = 48;
export const HORIZON_FROM_M = 60;
export const HORIZON_TO_M = 60000;
export const HORIZON_TILES = 384;
/** Frames after which the cells' frame numbers begin again, and the cells have to be cleared. */
export const HORIZON_EPOCHS = 4095;
const RING_STEP = Math.log(HORIZON_TO_M / HORIZON_FROM_M) / HORIZON_RINGS;

/** Index of a bucket's draw arguments. */
export const drawBucket = (mesh, kind, wet) => (kind * 2 + (wet ? 1 : 0)) * 8 + mesh;
export const DRAW_BUCKETS = TILE_CLASSES * 8;

/** Entry points, in this order: sift; with the horizon on also raise (HORIZON_TILES workgroups) and sweep; place. */
export function buildTerrainDrawListWGSL({ lodLevels, capacity, solidLod }) {
    const B = TILE_BLOCKS;
    return /* wgsl */`
struct ChunkInstance {
    position: vec3<f32>, face: u32,
    location: vec2<f32>, sizeUV: f32, pad: f32,
    uvOffset: vec2<f32>, uvScale: f32, lod: u32,
    neighbors: vec2<u32>, layer: u32, edgeMask: u32,
};
struct Frame {
    planes: array<vec4<f32>, 5>,  // inward, about the planet's centre
    camera: vec4<f32>,            // from the planet's centre, its length
    planet: vec4<f32>,            // radius, the camera's height over it, radius that hides what lies behind it (0: nothing), 1 land hides too
    ranges: vec4<f32>,            // the close surfaces' end, the far tier's fade start and end (0: no fade), distance the near water reaches (0: none)
    water: vec4<f32>,             // sea level (m; -1e9 without a sea), the coverage's depth (0: none), 1 every tile is wet, 1 cull
    east: vec4<f32>,              // level directions at the camera, for the horizon
    north: vec4<f32>,
    spare: vec4<f32>,             // the horizon's frame, 1..${HORIZON_EPOCHS}
    clip: mat4x4<f32>,            // of a point about the camera
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> instances: array<ChunkInstance>;
@group(0) @binding(2) var<storage, read> quadtreeMeta: array<u32>;
@group(0) @binding(3) var<storage, read> bounds: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> indexCounts: array<u32>;
@group(0) @binding(5) var<storage, read_write> list: array<u32>;
@group(0) @binding(6) var<storage, read_write> draws: array<atomic<u32>>;
@group(0) @binding(7) var coverage: texture_2d_array<u32>;
@group(0) @binding(8) var<storage, read_write> seaView: array<atomic<i32>, ${SEA_VIEW_WORDS}>;
@group(0) @binding(9) var<storage, read> blocks: array<f32>;
// Direction by direction, ring by ring: the lowest ground of each cell (with the frame it is of, so that nothing has to
// be cleared), and the steepest rise of all land before the ring.
@group(0) @binding(10) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> horizon: array<f32>;

const LODS: u32 = ${lodLevels}u;
const CAPACITY: u32 = ${capacity}u;
const UNKNOWN_HEIGHT: f32 = 9000.0;
const KEPT: u32 = ${DRAW_BUCKETS * capacity}u;      // the kept tiles, behind the draw list
const KEPT_COUNT: u32 = ${DRAW_BUCKETS * 5}u;       // behind the draws
const IN_VIEW: u32 = 0x80000000u;
const DIRECTIONS: i32 = ${HORIZON_DIRECTIONS};
const RINGS: i32 = ${HORIZON_RINGS};
const PI: f32 = 3.14159265;
const RAISED: u32 = ${HORIZON_TILES}u;        // tiles whose land can be in the horizon; with more there is none
const FIRST_RING: u32 = ${DRAW_BUCKETS * 5 + 1}u;   // rings before this are too near to tell directions apart
const KEY_BITS: u32 = 19u;

fn cubePoint(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>(1.0, t, -s); }
        case 1u { return vec3<f32>(-1.0, t, s); }
        case 2u { return vec3<f32>(s, 1.0, -t); }
        case 3u { return vec3<f32>(s, -1.0, t); }
        case 4u { return vec3<f32>(s, t, 1.0); }
        default { return vec3<f32>(-s, t, -1.0); }
    }
}

// Where a direction meets a face, as its UV; outside 0..1 off it.
fn faceUv(face: u32, d: vec3<f32>) -> vec2<f32> {
    let m = array<f32, 6>(d.x, -d.x, d.y, -d.y, d.z, -d.z)[face];
    if (m <= 0.0) { return vec2<f32>(-1.0); }
    var p = vec2<f32>(0.0);
    switch (face) {
        case 0u { p = vec2<f32>(-d.z, d.y); }
        case 1u { p = vec2<f32>(d.z, d.y); }
        case 2u { p = vec2<f32>(d.x, -d.z); }
        case 3u { p = vec2<f32>(d.x, d.z); }
        case 4u { p = vec2<f32>(d.x, d.y); }
        default { p = vec2<f32>(-d.x, d.y); }
    }
    return p / m * 0.5 + 0.5;
}

// The angle between a direction and the camera's, from the planet's centre. Not acos of their product: that is good to some 50 m only.
fn awayFromCamera(d: vec3<f32>) -> f32 { return 2.0 * asin(clamp(0.5 * length(d - frame.camera.xyz / frame.camera.w), 0.0, 1.0)); }

// How steeply a place rises from the camera, as a tangent over the level: its height, and its angle from the camera's place.
fn riseAt(height: f32, angle: f32) -> f32 {
    let r = frame.planet.x + height;
    let half = sin(0.5 * angle);
    return (height - frame.planet.y - 2.0 * r * half * half) / max(r * sin(angle), 1.0e-3);
}
fn ringOf(angle: f32) -> i32 { return i32(floor(log(max(angle * frame.planet.x, 1.0e-3) / ${HORIZON_FROM_M}.0) / ${RING_STEP.toFixed(8)})); }
fn ringAngle(ring: i32) -> f32 { return ${HORIZON_FROM_M}.0 * exp(f32(ring) * ${RING_STEP.toFixed(8)}) / frame.planet.x; }
fn directionOf(d: vec3<f32>) -> f32 { return atan2(dot(d, frame.north.xyz), dot(d, frame.east.xyz)); }

// Whether lakes or rivers may stand on a tile (WaterCoverage.js).
fn wetGround(face: u32, location: vec2<f32>, depth: i32) -> bool {
    let finest = i32(frame.water.y);
    if (finest == 0) { return true; }
    let level = max(finest - depth, 0);
    if (level >= i32(textureNumLevels(coverage))) { return true; }
    let grid = 1 << u32(finest - level);
    let cell = clamp(vec2<i32>(floor((location + 0.5 * exp2(-f32(max(depth, finest)))) * f32(grid))), vec2<i32>(0), vec2<i32>(grid - 1));
    return textureLoad(coverage, cell, i32(face), level).r != 0u;
}

// Where on the screen a tile's sea can be: the rectangle about the corners of its piece of the sea's surface.
fn showSea(tile: ChunkInstance, shore: f32, bulge: f32) {
    var low = vec2<f32>(1.0);
    var high = vec2<f32>(-1.0);
    for (var k = 0u; k < 8u; k++) {
        let corner = normalize(cubePoint(tile.face, tile.location + tile.sizeUV * vec2<f32>(f32(k & 1u), f32((k >> 1u) & 1u))));
        let c = frame.clip * vec4<f32>(corner * (shore + select(-2.0, bulge + 2.0, k > 3u)) - frame.camera.xyz, 1.0);
        if (c.w < 1.0) { low = vec2<f32>(-1.0); high = vec2<f32>(1.0); break; }
        low = min(low, c.xy / c.w);
        high = max(high, c.xy / c.w);
    }
    // A little more: the sea also fills a band over its horizon (seaSurface.wgsl.js).
    low = clamp(low - vec2<f32>(0.01, 0.06), vec2<f32>(-1.0), vec2<f32>(1.0));
    high = clamp(high + vec2<f32>(0.01, 0.06), vec2<f32>(-1.0), vec2<f32>(1.0));
    if (any(low >= high)) { return; }
    atomicMin(&seaView[0], i32(floor(low.x * ${SEA_VIEW_ONE}.0)));
    atomicMin(&seaView[1], i32(floor(low.y * ${SEA_VIEW_ONE}.0)));
    atomicMax(&seaView[2], i32(ceil(high.x * ${SEA_VIEW_ONE}.0)));
    atomicMax(&seaView[3], i32(ceil(high.y * ${SEA_VIEW_ONE}.0)));
}

// How far (m) a tile's hull between two heights is on the far side of a plane of the view, at most: none of it is seen if that is under 0.
fn inView(tile: ChunkInstance, bottom: f32, top: f32) -> f32 {
    var least = 1.0e30;
    var corners: array<vec3<f32>, 4>;
    for (var k = 0u; k < 4u; k++) { corners[k] = normalize(cubePoint(tile.face, tile.location + tile.sizeUV * vec2<f32>(f32(k & 1u), f32(k >> 1u)))); }
    for (var p = 0; p < 5; p++) {
        let plane = frame.planes[p];
        var furthest = -1.0e30;
        for (var k = 0; k < 4; k++) {
            let along = dot(plane.xyz, corners[k]);
            furthest = max(furthest, plane.w + along * select(bottom, top, along > 0.0));
        }
        least = min(least, furthest);
    }
    return least;
}

// Lowest ground of a block of a tile, whichever layer the tile is drawn from.
fn blockLow(tile: ChunkInstance, block: vec2<u32>) -> f32 {
    let local = tile.uvOffset + tile.uvScale * (vec2<f32>(block) + 0.5) / ${B}.0;
    let at = min(vec2<u32>(local * ${B}.0), vec2<u32>(${B - 1}u));
    return blocks[tile.layer * ${B * B}u + at.y * ${B}u + at.x];
}

struct Survey {
    depth: i32, width: f32, low: f32, high: f32, known: bool, sunk: bool,
    middle: vec3<f32>, angle: f32, spread: f32, bulge: f32,
};
fn survey(tile: ChunkInstance) -> Survey {
    let radius = frame.planet.x;
    let known = bounds[tile.layer];
    var s: Survey;
    s.depth = i32(round(-log2(tile.sizeUV)));
    s.width = 2.0 * radius * tile.sizeUV;
    s.known = known.w > 0.5;
    // Edges sewn to a neighbour follow its heights, which may lie a little outside this tile's own.
    let margin = 12.0 + 0.04 * s.width;
    s.low = select(-UNKNOWN_HEIGHT, known.x - margin, s.known);
    s.high = select(UNKNOWN_HEIGHT, known.y + margin, s.known);
    // Water is told from the tile's own heights, without the margin: that grows with the tile.
    s.sunk = select(-UNKNOWN_HEIGHT, known.x, s.known) < frame.water.x;
    s.middle = normalize(cubePoint(tile.face, tile.location + 0.5 * tile.sizeUV));
    s.angle = awayFromCamera(s.middle);
    s.spread = 0.7072 * s.width / radius;
    // The sphere bulges over a tile's corners.
    s.bulge = s.width * s.width / (3.6 * radius);
    return s;
}

fn consider(index: u32) {
    let tile = instances[index];
    let radius = frame.planet.x;
    let cameraLength = frame.camera.w;
    let s = survey(tile);
    let small = s.depth > 2;
    if (s.angle <= s.spread) {
        // The tile under the camera, if it is this one: is the camera under its ground?
        let local = (faceUv(tile.face, frame.camera.xyz / cameraLength) - tile.location) / tile.sizeUV;
        if (all(local >= vec2<f32>(0.0)) && all(local < vec2<f32>(1.0)) && s.known
            && frame.planet.y < blockLow(tile, vec2<u32>(local * ${B}.0)) - 1.0) { atomicStore(&seaView[5], 1); }
    }
    if (s.sunk) {
        // The sea over it: seen past the ground, so with its own height. Past its own horizon it is behind itself, or
        // behind land that stands higher.
        let shore = radius + frame.water.x;
        if (cameraLength <= shore || !small || s.angle - s.spread <= acos(shore / cameraLength)) {
            atomicStore(&seaView[4], 1);
            if (!small || inView(tile, radius + s.low, max(radius + s.high, shore) + s.bulge) >= 0.0) { showSea(tile, shore, s.bulge); }
        }
    }
    var flag = IN_VIEW;
    if (frame.water.w > 0.5 && small) {
        // Behind the planet.
        let hiding = frame.planet.z;
        if (s.known && hiding > 0.0 && cameraLength > hiding && radius + s.high > hiding
            && s.angle - s.spread > acos(hiding / cameraLength) + acos(hiding / (radius + s.high))) { return; }
        let top = radius + s.high + s.bulge;
        let seen = inView(tile, radius + s.low, top);
        if (seen < 0.0) {
            // Land just beside the view still counts for the horizon: a cell of it at the edge has both.
            if (frame.planet.w < 0.5 || seen < -(s.width + 0.15 * s.angle * radius)) { return; }
            flag = 0u;
        }
    }
    list[KEPT + atomicAdd(&draws[KEPT_COUNT], 1u)] = index | flag;
}

@compute @workgroup_size(${THREADS})
fn sift(@builtin(local_invocation_index) thread: u32) {
    for (var b = thread; b < ${DRAW_BUCKETS}u; b += ${THREADS}u) {
        let mesh = b & 7u;
        atomicStore(&draws[b * 5u], select(0u, indexCounts[min(mesh, LODS - 1u)], mesh < LODS));
        atomicStore(&draws[b * 5u + 1u], 0u);
        atomicStore(&draws[b * 5u + 2u], 0u);
        atomicStore(&draws[b * 5u + 3u], 0u);
        atomicStore(&draws[b * 5u + 4u], b * CAPACITY);
    }
    if (thread == 0u) {
        atomicStore(&draws[KEPT_COUNT], 0u);
        atomicStore(&draws[FIRST_RING], 0u);
        atomicStore(&seaView[0], ${SEA_VIEW_ONE * 2});
        atomicStore(&seaView[1], ${SEA_VIEW_ONE * 2});
        atomicStore(&seaView[2], -${SEA_VIEW_ONE * 2});
        atomicStore(&seaView[3], -${SEA_VIEW_ONE * 2});
        atomicStore(&seaView[4], 0);
        atomicStore(&seaView[5], 0);
    }
    storageBarrier();
    workgroupBarrier();
    for (var lod = 0u; lod < LODS; lod++) {
        // The quadtree's draw arguments of this level: count, and where its instances begin.
        let at = LODS * 3u + lod * 5u;
        let count = quadtreeMeta[at + 1u];
        let first = quadtreeMeta[at + 4u];
        for (var i = thread; i < count; i += ${THREADS}u) { consider(first + i); }
    }
}

// A kept tile's blocks, into the cells of the horizon they touch: the lowest ground of each is what all sight lines
// through it must clear. A block's drawn ground is nowhere lower than its lowest texel: the cells of the mesh are no
// larger than blocks, from level 5 on than two by two.
@compute @workgroup_size(${B * B})
fn raise(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) thread: u32) {
    let count = atomicLoad(&draws[KEPT_COUNT]);
    if (group.x >= count || count > RAISED) { return; }
    let tile = instances[list[KEPT + group.x] & ~IN_VIEW];
    if (bounds[tile.layer].w < 0.5) { return; }
    var block = vec2<u32>(thread % ${B}u, thread / ${B}u);
    var low = blockLow(tile, block);
    var size = 1u;
    if (tile.lod >= 5u) {
        // Two by two, by one thread of four.
        if (any((block & vec2<u32>(1u)) != vec2<u32>(0u))) { return; }
        size = 2u;
        low = min(min(low, blockLow(tile, block + vec2<u32>(1u, 0u))), min(blockLow(tile, block + vec2<u32>(0u, 1u)), blockLow(tile, block + vec2<u32>(1u))));
    }
    // Edges sewn to a coarser neighbour can be a little lower.
    low -= 2.0 + 0.005 * frame.planet.x * 2.0 * tile.sizeUV;
    let d = normalize(cubePoint(tile.face, tile.location + tile.sizeUV * (vec2<f32>(block) + 0.5 * f32(size)) / ${B}.0));
    let angle = awayFromCamera(d);
    let spread = 0.7072 * 2.0 * tile.sizeUV * f32(size) / ${B}.0;
    let last = min(ringOf(angle + spread), RINGS - 1);
    if (last < 0) { return; }
    let first = max(ringOf(max(angle - spread, 1.0e-9)), 0);
    if (first >= RINGS) { return; }
    // Land this close spreads over too many directions: what is before its end does not count at all.
    if (angle < 3.0 * spread) {
        atomicMax(&draws[FIRST_RING], u32(last + 1));
        return;
    }
    let middle = directionOf(d);
    let aside = asin(min(sin(spread) / sin(angle), 1.0));
    let begin = i32(floor((middle - aside) / (2.0 * PI) * f32(DIRECTIONS)));
    let end = i32(floor((middle + aside) / (2.0 * PI) * f32(DIRECTIONS)));
    let key = (u32(frame.spare.x) << KEY_BITS) | (u32((UNKNOWN_HEIGHT - clamp(low, -UNKNOWN_HEIGHT, UNKNOWN_HEIGHT - 1.0)) * 16.0) + 1u);
    for (var k = begin; k <= end; k++) {
        let direction = ((k % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
        for (var ring = first; ring <= last; ring++) { atomicMax(&cells[direction * RINGS + ring], key); }
    }
}

@compute @workgroup_size(${THREADS})
fn sweep(@builtin(global_invocation_id) id: vec3<u32>) {
    let at = i32(id.x) * RINGS;
    let nearest = i32(atomicLoad(&draws[FIRST_RING]));
    let whole = atomicLoad(&draws[KEPT_COUNT]) <= RAISED;
    var steepest = -1.0e9;
    for (var ring = 0; ring < RINGS; ring++) {
        let key = atomicLoad(&cells[at + ring]);
        horizon[at + ring] = steepest;
        if (whole && ring >= nearest && (key >> KEY_BITS) == u32(frame.spare.x)) {
            let low = UNKNOWN_HEIGHT - f32(key & ((1u << KEY_BITS) - 1u)) / 16.0;
            steepest = max(steepest, max(riseAt(low, ringAngle(ring)), riseAt(low, ringAngle(ring + 1))));
        }
    }
}

// Whether a tile's highest ground lies under the horizon before it, in all directions it covers.
fn behindLand(tile: ChunkInstance, s: Survey) -> bool {
    let nearest = s.angle - s.spread;
    if (nearest <= 0.0) { return false; }
    let ring = min(ringOf(nearest), RINGS - 1);
    if (ring < 1) { return false; }
    let top = s.high + s.bulge;
    var rise = max(riseAt(top, nearest), riseAt(top, s.angle + s.spread));
    if (top < frame.planet.y) {
        // Seen from above, ground that falls away with the planet rises steepest where it just vanishes.
        rise = max(rise, riseAt(top, clamp(acos((frame.planet.x + top) / frame.camera.w), nearest, s.angle + s.spread)));
    }
    rise += 1.0e-4;
    let middle = directionOf(s.middle);
    var left = 0.0;
    var right = 0.0;
    for (var k = 0u; k < 4u; k++) {
        var turn = directionOf(normalize(cubePoint(tile.face, tile.location + tile.sizeUV * vec2<f32>(f32(k & 1u), f32(k >> 1u))))) - middle;
        turn -= 2.0 * PI * round(turn / (2.0 * PI));
        left = min(left, turn);
        right = max(right, turn);
    }
    if (right - left > 2.5) { return false; }
    let begin = i32(floor((middle + left) / (2.0 * PI) * f32(DIRECTIONS)));
    let end = i32(floor((middle + right) / (2.0 * PI) * f32(DIRECTIONS)));
    for (var k = begin; k <= end; k++) {
        let direction = ((k % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
        if (horizon[direction * RINGS + ring] <= rise) { return false; }
    }
    return true;
}

fn settle(index: u32) {
    let tile = instances[index];
    let s = survey(tile);
    if (frame.planet.w > 0.5 && s.known && s.depth > 2 && behindLand(tile, s)) { return; }

    // Nearest and farthest the tile's ground can be.
    let radius = frame.planet.x;
    let above = frame.planet.y;
    let gap = max(max(above - s.high, s.low - above), 0.0);
    // The distance between two heights an angle apart: their difference, and the chord between them.
    let chord = 4.0 * frame.camera.w * vec2<f32>(radius + s.low, radius + s.high) * pow(sin(0.5 * vec2<f32>(max(s.angle - s.spread, 0.0), s.angle + s.spread)), vec2<f32>(2.0));
    let nearest = sqrt(gap * gap + chord.x) - 2.0;
    let rise = max(abs(above - s.high), abs(above - s.low));
    let farthest = sqrt(rise * rise + chord.y) + 2.0;

    let fades = frame.ranges.z > frame.ranges.y;
    let bare = (tile.neighbors.y & 16u) != 0u; // no material yet: the far colour
    var kind = ${TILE_KIND.MID}u;
    if (tile.lod >= ${solidLod}u || bare || (fades && nearest >= frame.ranges.z)) { kind = ${TILE_KIND.FAR}u; }
    else if (nearest < frame.ranges.x) { kind = select(${TILE_KIND.NEAR}u, ${TILE_KIND.ALL}u, fades && farthest > frame.ranges.y); }

    var wet = frame.water.z > 0.5;
    if (!wet && farthest >= frame.ranges.w) { wet = s.sunk || wetGround(tile.face, tile.location, s.depth); }

    let bucket = (kind * 2u + select(0u, 1u, wet)) * 8u + tile.lod;
    let slot = atomicAdd(&draws[bucket * 5u + 1u], 1u);
    if (slot < CAPACITY) { list[bucket * CAPACITY + slot] = index; }
}

@compute @workgroup_size(${THREADS})
fn place(@builtin(local_invocation_index) thread: u32) {
    let count = atomicLoad(&draws[KEPT_COUNT]);
    for (var i = thread; i < count; i += ${THREADS}u) {
        let kept = list[KEPT + i];
        if ((kept & IN_VIEW) != 0u) { settle(kept & ~IN_VIEW); }
    }
}
`;
}

/** Frustum planes (inward, about the planet's centre) of a view-projection, left, right, bottom, top, near: 5 x 4 numbers. */
export function frustumPlanes(view, projection, origin, out = new Float32Array(20), offset = 0) {
    const row = r => [0, 1, 2, 3].map(c => {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += projection[r + k * 4] * view[k + c * 4];
        return sum;
    });
    const [x, y, z, w] = [0, 1, 2, 3].map(row);
    const planes = [w.map((v, i) => v + x[i]), w.map((v, i) => v - x[i]), w.map((v, i) => v + y[i]), w.map((v, i) => v - y[i]), z];
    planes.forEach((p, i) => {
        const l = Math.hypot(p[0], p[1], p[2]) || 1;
        out.set([p[0] / l, p[1] / l, p[2] / l, (p[3] + p[0] * origin.x + p[1] * origin.y + p[2] * origin.z) / l], offset + i * 4);
    });
    return out;
}
