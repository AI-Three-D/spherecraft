// @ts-nocheck
// The obstacle table for shaders (ECOLOGY_FOUNDATION_PLAN.md F5; ObstacleCells.js): what the next layer keeps clear of,
// as discs (boulders, trunks, stumps; logs as chains of discs), kept in world cells about the camera on a fixed lattice
// level (about 128 m), whatever level of detail the terrain shows there.
//
// A record is 4 u32, no f16: the candidate's id (its ecoId's low word); x, y in the cell as unorm16 (2 mm at 128 m);
// radius in mm | height in cm << 16; kind | flags << 16, flags' top 4 bits the writer's priority (geology over trees).
// Writers append records to a cell's staging; the finalize pass sorts each cell's records into one order (priority, then
// the record), keeps the first `capacity` (the rest counted as overflow, the cell marked incomplete) and bins them 8 x 8.

export const OBSTACLE_BINS = 8;
export const OBSTACLE_HEADER_WORDS = 80;
/** Header: key lo, key hi, state | version << 2, count, overflow, largest radius (mm), staged, unused, then 65 bin offsets. */
export const OBSTACLE_HEADER = Object.freeze({ KEY_LO: 0, KEY_HI: 1, STATE: 2, COUNT: 3, OVERFLOW: 4, MAX_RADIUS: 5, STAGED: 6, BINS: 8 });
/** The largest disc any writer puts in (m): a query looks this far past its search into the cells about it. */
export const OBSTACLE_MAX_RADIUS_M = 8;
export const OBSTACLE_KINDS = Object.freeze({ BOULDER: 1, STONE: 2, TRUNK: 16, STUMP: 17, LOG: 18 });
/** Writers' priorities (higher first when a cell overflows). */
export const OBSTACLE_PRIORITY = Object.freeze({ GEOLOGY: 15, TREES: 10, DEADFALL: 5 });

// The cell table: open addressing from (face, ix, iy) of the obstacle level to a slot. 4 u32 an entry: key lo, key hi,
// slot + 1 (0 empty), unused.
export const OBSTACLE_TABLE_CAP = 512;

export function obstacleKey(face, level, ix, iy) {
    return [(ix & 0xFFFFFF) >>> 0, ((iy & 0xFFFFFF) | ((level & 31) << 24) | ((face & 7) << 29)) >>> 0];
}
export function obstacleHash(lo, hi) {
    const kl = (lo ^ (lo >>> 16)) >>> 0, kh = (hi ^ (hi >>> 16)) >>> 0;
    return ((Math.imul(kl, 0x9E3779B1) ^ Math.imul(kh, 0x85EBCA77)) >>> 0) & (OBSTACLE_TABLE_CAP - 1);
}

const COMMON = /* wgsl */`
const OBSTACLE_BINS: u32 = ${OBSTACLE_BINS}u;
const OBSTACLE_HEADER_WORDS: u32 = ${OBSTACLE_HEADER_WORDS}u;
const OBSTACLE_TABLE_CAP: u32 = ${OBSTACLE_TABLE_CAP}u;
const OBSTACLE_MAX_RADIUS_M: f32 = ${OBSTACLE_MAX_RADIUS_M}.0;
struct ObstacleFrame {
    counts: vec4<u32>,   // level, capacity a cell, staging a cell (a power of two), jobs
    scale: vec4<f32>,    // planet radius (m), unused...
};
fn obstacleKey(face: u32, level: u32, cell: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(cell.x & 0xFFFFFFu, (cell.y & 0xFFFFFFu) | ((level & 31u) << 24u) | ((face & 7u) << 29u));
}
fn obstacleHash(key: vec2<u32>) -> u32 {
    let kl = key.x ^ (key.x >> 16u);
    let kh = key.y ^ (key.y >> 16u);
    return ((kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u)) & (OBSTACLE_TABLE_CAP - 1u);
}
`;

/** The finalize pass: one workgroup a cell given in jobs (its slot). */
export function buildObstacleFinalizeWGSL() {
    return /* wgsl */`${COMMON}
@group(0) @binding(0) var<uniform> obstacleFrame: ObstacleFrame;
@group(0) @binding(1) var<storage, read> jobs: array<u32>;
@group(0) @binding(2) var<storage, read_write> headers: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> staging: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> records: array<vec4<u32>>;

// One order of records: higher priority first, then the record's words (its id first): deterministic whatever order the
// writers' threads appended them in. An empty slot (all ones) last.
fn before(a: vec4<u32>, b: vec4<u32>) -> bool {
    let pa = a.w >> 28u;
    let pb = b.w >> 28u;
    if (pa != pb) { return pa > pb; }
    if (a.x != b.x) { return a.x < b.x; }
    if (a.y != b.y) { return a.y < b.y; }
    if (a.z != b.z) { return a.z < b.z; }
    return a.w < b.w;
}
var<workgroup> binCount: array<u32, ${OBSTACLE_BINS * OBSTACLE_BINS}>;
var<workgroup> binStart: array<u32, ${OBSTACLE_BINS * OBSTACLE_BINS + 1}>;
var<workgroup> largest: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
    if (wg.x >= obstacleFrame.counts.w) { return; }
    let slot = jobs[wg.x * 4u];
    let h = slot * OBSTACLE_HEADER_WORDS;
    let n = obstacleFrame.counts.z;
    let base = slot * n;
    // What the writers appended (past the staging's room, counted only) and what of it fits.
    let requested = atomicLoad(&headers[h + ${OBSTACLE_HEADER.STAGED}u]);
    let staged = min(requested, n);
    // Empty staging slots sort last.
    for (var i = staged + t; i < n; i += 64u) { staging[base + i] = vec4<u32>(0xFFFFFFFFu); }
    storageBarrier();
    workgroupBarrier();
    // Bitonic sort of the cell's staging in place.
    for (var k = 2u; k <= n; k <<= 1u) {
        for (var j = k >> 1u; j > 0u; j >>= 1u) {
            for (var i = t; i < n; i += 64u) {
                let l = i ^ j;
                if (l > i) {
                    let a = staging[base + i];
                    let b = staging[base + l];
                    let up = (i & k) == 0u;
                    if (select(before(a, b), before(b, a), up)) { staging[base + i] = b; staging[base + l] = a; }
                }
            }
            storageBarrier();
            workgroupBarrier();
        }
    }
    let capacity = obstacleFrame.counts.y;
    let count = min(staged, capacity);
    if (t == 0u) { atomicStore(&largest, 0u); }
    if (t < ${OBSTACLE_BINS * OBSTACLE_BINS}u) { binCount[t] = 0u; }
    workgroupBarrier();
    for (var i = t; i < count; i += 64u) {
        atomicMax(&largest, staging[base + i].z & 0xFFFFu);
    }
    // Bins in the sorted order: each thread one bin, walking the list in order (the same order every time).
    let bin = t;
    let cap = slot * capacity;
    if (bin < ${OBSTACLE_BINS * OBSTACLE_BINS}u) {
        var c = 0u;
        for (var i = 0u; i < count; i++) {
            let xy = unpack2x16unorm(staging[base + i].y);
            let b = vec2<u32>(min(vec2<u32>(xy * ${OBSTACLE_BINS}.0), vec2<u32>(${OBSTACLE_BINS - 1}u)));
            if (b.y * OBSTACLE_BINS + b.x == bin) { c++; }
        }
        binCount[bin] = c;
    }
    workgroupBarrier();
    if (t == 0u) {
        var s = 0u;
        for (var b = 0u; b < ${OBSTACLE_BINS * OBSTACLE_BINS}u; b++) { binStart[b] = s; s += binCount[b]; }
        binStart[${OBSTACLE_BINS * OBSTACLE_BINS}u] = s;
    }
    workgroupBarrier();
    if (bin < ${OBSTACLE_BINS * OBSTACLE_BINS}u) {
        var at = binStart[bin];
        for (var i = 0u; i < count; i++) {
            let r = staging[base + i];
            let xy = unpack2x16unorm(r.y);
            let b = vec2<u32>(min(vec2<u32>(xy * ${OBSTACLE_BINS}.0), vec2<u32>(${OBSTACLE_BINS - 1}u)));
            if (b.y * OBSTACLE_BINS + b.x == bin) { records[cap + at] = r; at++; }
        }
    }
    // 65 offsets (each bin's start, then the end) from 64 threads: the end by thread 0.
    if (t < ${OBSTACLE_BINS * OBSTACLE_BINS}u) { atomicStore(&headers[h + ${OBSTACLE_HEADER.BINS}u + t], binStart[t]); }
    if (t == 0u) { atomicStore(&headers[h + ${OBSTACLE_HEADER.BINS + OBSTACLE_BINS * OBSTACLE_BINS}u], binStart[${OBSTACLE_BINS * OBSTACLE_BINS}u]); }
    if (t == 0u) {
        atomicStore(&headers[h + ${OBSTACLE_HEADER.COUNT}u], count);
        atomicStore(&headers[h + ${OBSTACLE_HEADER.OVERFLOW}u], requested - count);
        atomicStore(&headers[h + ${OBSTACLE_HEADER.MAX_RADIUS}u], atomicLoad(&largest));
    }
}
`;
}

/**
 * Writing into a cell's staging, for writers: obstacleAppend(slot, record) (thread-safe). The writer's own shader
 * includes this with its bindings at the [group, binding] given (headers read_write, staging read_write).
 */
export function buildObstacleAppendWGSL({ frame = [0, 0], headers = [0, 1], staging = [0, 2] } = {}) {
    const at = ([g, b]) => `@group(${g}) @binding(${b})`;
    return /* wgsl */`${COMMON}
${at(frame)} var<uniform> obstacleFrame: ObstacleFrame;
${at(headers)} var<storage, read_write> obstacleHeaders: array<atomic<u32>>;
${at(staging)} var<storage, read_write> obstacleStaging: array<vec4<u32>>;
// A disc into a cell: its id (low word), place in the cell (0..1), radius and height (m), kind, flags, priority (0..15).
fn obstacleRecord(id: u32, inCell: vec2<f32>, radiusM: f32, heightM: f32, kind: u32, flags: u32, priority: u32) -> vec4<u32> {
    let r = u32(clamp(radiusM * 1000.0, 0.0, 65535.0));
    let hgt = u32(clamp(heightM * 100.0, 0.0, 65535.0));
    return vec4<u32>(id, pack2x16unorm(clamp(inCell, vec2<f32>(0.0), vec2<f32>(1.0))), r | (hgt << 16u), (kind & 0xFFFFu) | ((flags & 0xFFFu) << 16u) | ((priority & 15u) << 28u));
}
fn obstacleAppend(slot: u32, record: vec4<u32>) {
    let at = atomicAdd(&obstacleHeaders[slot * OBSTACLE_HEADER_WORDS + ${OBSTACLE_HEADER.STAGED}u], 1u);
    if (at < obstacleFrame.counts.z) { obstacleStaging[slot * obstacleFrame.counts.z + at] = record; }
}
`;
}

/**
 * Reading, for anyone placing things: the bindings at the [group, binding] given, and obstacleClearance. Needs
 * drawnGround.wgsl.js (ground, groundPlace, GroundFace) and ecologyLattice.wgsl.js (ecoNeighbourCell, ecoFaceDirection,
 * ecoDirectionToFace, ecoCellAxes).
 */
export function buildObstacleReadWGSL({ frame = [0, 0], table = [0, 1], headers = [0, 2], records = [0, 3] } = {}) {
    const at = ([g, b]) => `@group(${g}) @binding(${b})`;
    return /* wgsl */`${COMMON}
${at(frame)} var<uniform> obstacleFrame: ObstacleFrame;
${at(table)} var<storage, read> obstacleTable: array<vec4<u32>>;
${at(headers)} var<storage, read> obstacleHeaders: array<u32>;
${at(records)} var<storage, read> obstacleRecords: array<vec4<u32>>;
// The slot of a resident cell, or -1.
fn obstacleSlot(face: u32, cell: vec2<u32>) -> i32 {
    let key = obstacleKey(face, obstacleFrame.counts.x, cell);
    var i = obstacleHash(key);
    for (var n = 0u; n < 32u; n++) {
        let e = obstacleTable[i];
        if (e.z == 0u) { return -1; }
        if (e.x == key.x && e.y == key.y) { return i32(e.z) - 1; }
        i = (i + 1u) & (OBSTACLE_TABLE_CAP - 1u);
    }
    return -1;
}
// The ground frame's face for a cube face, or -1.
fn obstacleGroundFace(face: u32) -> i32 {
    for (var k = 0u; k < ground.tables.x; k++) { if (u32(ground.faces[k].anchor.z) == face) { return i32(k); } }
    return -1;
}
// A point of a cell (frac 0..1 in it) from the camera, through the ground frame's anchor for its face: the cell's corner
// as whole patches from the anchor (exact), the rest small (a tenth of a millimetre about the camera).
fn obstacleRel(k: i32, cell: vec2<u32>, frac: vec2<f32>) -> vec3<f32> {
    let F = ground.faces[k];
    let shift = ground.tables.y + GROUND_LEVELS - obstacleFrame.counts.x;
    let base = vec2<i32>(cell << vec2<u32>(shift)) - F.anchor.xy;
    return groundPlace(F, vec2<f32>(base) + frac * f32(1u << shift), 0.0).rel;
}
// How far a point is from the nearest disc's edge among the kinds asked for (a mask of 32 kinds by kind & 31), on the
// level about it (m): searchM when none is that near; -1 when a cell that could hold one is not ready, or its face is not
// in the ground frame. The point as the ground's functions take it: patch p of its face, f within the patch.
fn obstacleClearance(face: u32, p: vec2<u32>, f: vec2<f32>, searchM: f32, kinds: u32) -> f32 {
    let level = obstacleFrame.counts.x;
    let n = f32(1u << level);
    let qk = obstacleGroundFace(face);
    if (qk < 0) { return -1.0; }
    let shift = ground.tables.y + GROUND_LEVELS - level;
    let home = p >> vec2<u32>(shift);
    let q = obstacleRel(qk, home, (vec2<f32>(p & vec2<u32>((1u << shift) - 1u)) + f) / f32(1u << shift));
    let patches = f32(1u << (ground.tables.y + GROUND_LEVELS));
    let dir = ecoFaceDirection(face, (vec2<f32>(p) + f) / patches);
    let up = normalize(dir);
    let reach = searchM + OBSTACLE_MAX_RADIUS_M;
    var best = searchM;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let c = ecoNeighbourCell(face, level, home, vec2<i32>(dx, dy));
            // The point in that cell's own (u, v): on its face's plane, extended past the edge for a cell beside.
            let local = ecoUvOnFace(c.x, dir) * n - vec2<f32>(c.yz);
            let axes = ecoCellAxes(level, c.yz, obstacleFrame.scale.x);
            let outside = max(max(-local, local - 1.0), vec2<f32>(0.0)) * axes;
            if (length(outside) > reach) { continue; }
            let slot = obstacleSlot(c.x, c.yz);
            if (slot < 0) { return -1.0; }
            let h = u32(slot) * OBSTACLE_HEADER_WORDS;
            if ((obstacleHeaders[h + ${OBSTACLE_HEADER.STATE}u] & 3u) != 2u) { return -1.0; }
            let ck = obstacleGroundFace(c.x);
            if (ck < 0) { return -1.0; }
            let pad = (reach + f32(obstacleHeaders[h + ${OBSTACLE_HEADER.MAX_RADIUS}u]) * 0.001) / axes;
            let lo = vec2<i32>(clamp(floor((local - pad) * ${OBSTACLE_BINS}.0), vec2<f32>(0.0), vec2<f32>(${OBSTACLE_BINS - 1}.0)));
            let hi = vec2<i32>(clamp(floor((local + pad) * ${OBSTACLE_BINS}.0), vec2<f32>(0.0), vec2<f32>(${OBSTACLE_BINS - 1}.0)));
            for (var by = lo.y; by <= hi.y; by++) {
                for (var bx = lo.x; bx <= hi.x; bx++) {
                    let b = u32(by) * OBSTACLE_BINS + u32(bx);
                    let first = obstacleHeaders[h + ${OBSTACLE_HEADER.BINS}u + b];
                    let last = obstacleHeaders[h + ${OBSTACLE_HEADER.BINS}u + b + 1u];
                    for (var i = first; i < last; i++) {
                        let r = obstacleRecords[u32(slot) * obstacleFrame.counts.y + i];
                        if (((kinds >> ((r.w & 0xFFFFu) & 31u)) & 1u) == 0u) { continue; }
                        let d = obstacleRel(ck, c.yz, unpack2x16unorm(r.y));
                        var v = d - q;
                        v -= up * dot(v, up);
                        best = min(best, length(v) - f32(r.z & 0xFFFFu) * 0.001);
                    }
                }
            }
        }
    }
    return best;
}
`;
}
