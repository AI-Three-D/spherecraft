// @ts-nocheck
// Places, hashes, the sphere's metric and ownership across face edges (ECOLOGY_FOUNDATION_PLAN.md F1). The CPU mirror of
// ecologyLattice.wgsl.js: the same hashes and ranks bit for bit, used by tests and by CPU queries (which cells lie
// about a point, whose candidate wins).
//
// A place is (face, ix, iy) on a lattice level: the cube face cut into 2^level cells along each edge. The faces follow
// the terrain's getCubePoint (terrainChunkVertexShaderBuilder.js): u = 0..1 along FACES[face].u, v along .v.

/** Seeds of the layers that scatter things: each draws from its own stream (ecoCellHash). At most 8. */
export const ECO_LAYERS = Object.freeze({ GRASS: 0, TREES: 1, ROCKS: 2, GROUND_COVER: 3, DEADFALL: 4, HABITAT: 5, OBSTACLES: 6, SPARE: 7 });

/** The cube's faces as the terrain lays them out: a point of face f at (s, t) in -1..1 is axis + s u + t v. */
export const ECO_FACES = Object.freeze([
    { axis: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { axis: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { axis: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { axis: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { axis: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function pcg(v) {
    const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
    const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
}
export function hash3(x, y, z) {
    return pcg((x ^ pcg((y ^ pcg((z + 0x9e3779b9) >>> 0)) >>> 0)) >>> 0);
}
export function u01(h) { return (h >>> 8) * (1 / 16777216); }

/** The hash of a cell of a layer; the grass's (layer 0, world seed 0) is its old hash3(x, y, face). */
export function ecoCellHash(face, ix, iy, layer = 0, worldSeed = 0) {
    return hash3(ix >>> 0, iy >>> 0, (face + 8 * (layer + 8 * worldSeed)) >>> 0);
}
/** The k-th draw from a cell's hash (k from 0). */
export function ecoDraw(cellHash, k) {
    return pcg((cellHash + Math.imul(k + 1, 0x9E3779B9)) >>> 0);
}

/** Level of a lattice point among the nested sets (up to 4: every 16th row and column), and a rank in it. */
export function latticeLevel(gx, gy) {
    const m = (gx | gy | 16) >>> 0;
    return 31 - Math.clz32(m & -m);
}
export function latticeRank(level, u) {
    const hi = 2 ** (-2 * level);
    const lo = level >= 4 ? 0 : hi * 0.25;
    return lo + (hi - lo) * u;
}

/**
 * A stable 64-bit id of a candidate, as two u32 (lo, hi): ix, iy below 2^24, k below 256, level below 32.
 * Ties between candidates break on it (ecoBefore), and tables carry it.
 */
export function ecoId(face, level, ix, iy, k = 0) {
    return [((ix & 0xFFFFFF) | ((k & 0xFF) << 24)) >>> 0, ((iy & 0xFFFFFF) | ((level & 31) << 24) | ((face & 7) << 29)) >>> 0];
}
/** The one order every layer uses: higher priority first, then the smaller id. True when a comes before b. */
export function ecoBefore(priorityA, idA, priorityB, idB) {
    if (priorityA !== priorityB) return priorityA > priorityB;
    if (idA[1] !== idB[1]) return idA[1] < idB[1];
    return idA[0] < idB[0];
}

/** The point of a face at (u, v) (may lie past 0..1: on the face's plane beyond its edge), not normalized. */
export function faceDirection(face, u, v) {
    const F = ECO_FACES[face], s = 2 * u - 1, t = 2 * v - 1;
    return [0, 1, 2].map(i => F.axis[i] + s * F.u[i] + t * F.v[i]);
}
/** The face a direction falls on and its (u, v) there. */
export function directionToFace(dir) {
    const a = dir.map(Math.abs);
    const axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
    const face = axis * 2 + (dir[axis] >= 0 ? 0 : 1);
    const F = ECO_FACES[face];
    const c = dir.map(x => x / Math.abs(dir[axis]));
    return { face, u: (dot(c, F.u) + 1) / 2, v: (dot(c, F.v) + 1) / 2 };
}

/**
 * A cell's true area on a sphere of radius R (m^2): the solid angle of its rectangle on the face's plane (the exact
 * gnomonic integral; a cell near a face's corner covers about a fifth of one at its middle).
 */
export function cellAreaM2(face, level, ix, iy, R) {
    const n = 2 ** level;
    const A = (s, t) => Math.atan2(s * t, Math.sqrt(1 + s * s + t * t));
    const s0 = 2 * ix / n - 1, s1 = 2 * (ix + 1) / n - 1, t0 = 2 * iy / n - 1, t1 = 2 * (iy + 1) / n - 1;
    return R * R * (A(s1, t1) - A(s0, t1) - A(s1, t0) + A(s0, t0));
}
/** A cell's edge lengths along u and v at its middle (m). */
export function cellAxesM(face, level, ix, iy, R) {
    const n = 2 ** level, ds = 2 / n;
    const s = 2 * (ix + 0.5) / n - 1, t = 2 * (iy + 0.5) / n - 1;
    const q = 1 + s * s + t * t;
    return [R * ds * Math.sqrt(1 + t * t) / q, R * ds * Math.sqrt(1 + s * s) / q];
}
/** The lattice level whose cells are nearest a spacing in metres at a face's middle, on a sphere of radius R. */
export function latticeFor(spacingM, R) {
    return Math.max(0, Math.round(Math.log2(2 * R / spacingM)));
}

/**
 * The cell dx, dy cells from (face, ix, iy) on the same level, across the face's edge if it lies beyond: through the
 * point on the face's plane, onto the face that point's direction falls on (three-face corners included).
 */
export function neighbourCell(face, level, ix, iy, dx, dy) {
    const n = 2 ** level;
    const jx = ix + dx, jy = iy + dy;
    if (jx >= 0 && jx < n && jy >= 0 && jy < n) return { face, ix: jx, iy: jy };
    const to = directionToFace(faceDirection(face, (jx + 0.5) / n, (jy + 0.5) / n));
    return { face: to.face, ix: Math.min(n - 1, Math.max(0, Math.floor(to.u * n))), iy: Math.min(n - 1, Math.max(0, Math.floor(to.v * n))) };
}

const unit = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
/** The direction of a cell's middle (unit). */
export function cellCentre(face, level, ix, iy) {
    const n = 2 ** level;
    return unit(faceDirection(face, (ix + 0.5) / n, (iy + 0.5) / n));
}

/**
 * Every cell whose area meets a disc of radiusM about the middle of (face, ix, iy), on this face and the neighbouring
 * ones, in the one canonical order (face, iy, ix). Each cell once.
 */
export function cellsWithin(face, level, ix, iy, radiusM, R) {
    const axes = cellAxesM(face, level, ix, iy, R);
    const reach = Math.ceil(radiusM / Math.min(...axes)) + 1;
    const centre = cellCentre(face, level, ix, iy);
    const seen = new Map();
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const c = neighbourCell(face, level, ix, iy, dx, dy);
            const key = `${c.face}/${c.ix}/${c.iy}`;
            if (seen.has(key)) continue;
            const a = cellAxesM(c.face, level, c.ix, c.iy, R);
            const halfDiagonal = 0.5 * Math.hypot(a[0], a[1]);
            const angle = Math.acos(Math.min(1, Math.max(-1, dot(centre, cellCentre(c.face, level, c.ix, c.iy)))));
            if (angle * R - halfDiagonal <= radiusM) seen.set(key, c);
        }
    }
    return [...seen.values()].sort((a, b) => a.face - b.face || a.iy - b.iy || a.ix - b.ix);
}
