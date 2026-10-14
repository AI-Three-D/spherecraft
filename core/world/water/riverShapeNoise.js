// core/world/water/riverShapeNoise.js
//
// Natural irregularity of a river along its length (owner 2026-10-05: an
// even width and straight banks read as a dug moat): the width varies, the
// channel wanders a little around the traced line, the banks rise more or
// less. Broad shape and independent shore displacement use 1D value noise
// of arc length s; optional bank relief also varies across the channel.
// Seeded by the river's id, these fields are continuous across segments and
// same wherever it is evaluated: the terrain carve and the water shading
// (waterWgsl.js waterRiverPoint), the simulation strip (WaterRiverSim.js)
// and the lab's CPU mirrors. Integer hashing (no sin hash), so the GPU and
// JavaScript use the same hashing and interpolation equations.

// Shared physical limits for CPU indexing/audits and generated WGSL.
// bankDetail and bankCutM remain the runtime configuration controls.
export const RIVER_BANK_DETAIL = Object.freeze({
    shoreFraction: 0.12,
    reliefM: 0.45,
    noiseCellM: 3,
    maxExtentM: 45,
    // Organic banks are laid back to about 45 degrees: the ledge (the bank's
    // rise beyond its shelf) is at least ledgeRunPerM metres wide per metre
    // of rise, and the cut fades into the natural ground over at least
    // wallRunPerM metres per metre cut. A 4.5 m ledge over 0.5 m, cut off by
    // a ~1.5 m fade, left walls up to 5 m high within 2 m wherever a stream
    // is cut into a cross slope; the 1-4 m terrain grid drew them as a saw-
    // tooth (owner 2026-10-12, "teeth"; water-look v37-v44). Each change
    // alone did nothing: both terms make the wall. The first toeRiseM of
    // the rise keeps the bank's own steepness: a laid-back bank stayed
    // within a few tenths of a metre of a stream's water (0.2 m freeboard),
    // and coarse triangles dipped under it in shards (water-look v50).
    ledgeRunPerM: 1.9,
    wallRunPerM: 2,
    toeRiseM: 1,
});
const SHORE_OCTAVES = [[23, 0.55], [7, 0.45]];

// Wavelengths (m) and weights of the octaves.
export const RIVER_NOISE = Object.freeze({
    width: [[240, 0.55], [85, 0.3], [27, 0.15]],
    wobble: [[170, 0.65], [53, 0.35]],
    bank: [[50, 0.7], [21, 0.3]],
    shoreLeft: SHORE_OCTAVES,
    shoreRight: SHORE_OCTAVES,
    // These fields are baked into the trace/valley, outside the GPU shader.
    reach: [[430, 0.65], [145, 0.35]],
    depth: [[180, 0.7], [61, 0.3]],
    valley: [[320, 0.7], [113, 0.3]],
    // River cross-section (riverSection.js): width along the river (baked
    // into the trace's half-width) and each side's bank type.
    widthLong: [[420, 0.6], [160, 0.4]],
    bankLeft: [[320, 0.6], [130, 0.4]],
    bankRight: [[320, 0.6], [130, 0.4]],
});

export const RIVER_CARVE_DEFAULTS = Object.freeze({
    enabled: true,
    waterFrac: 0.75,
    bankH: 0.8, bankSoftM: 8, bankGrade: 0.035,
    bankW: 10, blendW: 65,
    // Width along a river is baked into the trace's half-width now
    // (riverSection.js riverWidthFactor); no width noise on top in the shader.
    widthVar: 0, wobble: 0.3, bankVar: 0.55,
    islandHeightM: 2.5,
    bankDetail: 0, // opt-in independent shores, bank relief and shore materials
    bankCutM: 6,   // maximum excavation beyond the wet channel (metres)
});

export const RIVER_NOISE_SALT = Object.freeze({ width: 0x9e37, wobble: 0x7f4a, bank: 0x2c1b, shoreLeft: 0x4729, shoreRight: 0xa351,
    reach: 0x51e3, depth: 0x68bc, valley: 0x319d, widthLong: 0x3b17, bankLeft: 0xc61d, bankRight: 0x5e83 });
const SALT = RIVER_NOISE_SALT;

function hashU32(x) {
    x = (x ^ 61) ^ (x >>> 16);
    x = Math.imul(x, 9) >>> 0;
    x = (x ^ (x >>> 4)) >>> 0;
    x = Math.imul(x, 0x27d4eb2d) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
}
const hashF = (i, seed) => hashU32(((i | 0) + Math.imul(seed, 0x632be5ab)) >>> 0) / 4294967296;

/** A river's own value in [0, 1) for a salt (as WGSL waterHashF(river, salt)). */
export const riverHash = (river, salt) => hashF(river, salt);

/** Noise in [-1, 1] at arc length s and its derivative per metre. */
export function riverNoise(s, river, kind) {
    let v = 0, dv = 0;
    const seed = (((river | 0) * 4099) ^ SALT[kind]) >>> 0;
    for (const [lambda, w] of RIVER_NOISE[kind]) {
        const x = s / lambda + 0.5, i = Math.floor(x), f = x - i;
        const a = hashF(i, seed + lambda), b = hashF(i + 1, seed + lambda);
        const t = f * f * f * (f * (f * 6 - 15) + 10), dt = 30 * f * f * (f - 1) * (f - 1);
        v += w * ((a + (b - a) * t) * 2 - 1);
        dv += w * (b - a) * dt * 2 / lambda;
    }
    return { v, dv };
}

/** Bounded spatial relief in the river's metre-based (arc, signed offset) frame. */
export function riverBankNoise(s, n, river) {
    const cell = RIVER_BANK_DETAIL.noiseCellM;
    const x = s / cell, y = n / cell, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const q = f => f * f * f * (f * (f * 6 - 15) + 10), dq = f => 30 * f * f * (f - 1) * (f - 1);
    const seed = (((river | 0) * 4099) ^ 0x93bd) >>> 0;
    const h = (i, j) => hashF((i + Math.imul(j, 501125321)) | 0, seed);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1), tx = q(fx), ty = q(fy);
    return {
        v: 2 * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) - 1,
        ds: 2 * ((b - a) * (1 - ty) + (d - c) * ty) * dq(fx) / cell,
        dn: 2 * ((c - a) * (1 - tx) + (d - b) * tx) * dq(fy) / cell,
    };
}

/**
 * Shape of a river at arc length s: half-width, centre offset (m, + left),
 * bank-height factor, and their derivatives per metre along the river.
 * P: { widthVar, wobble, bankVar } (WaterGpuData look.shape / carve config).
 */
export function riverShapeAt(s, river, hw, P) {
    const w = riverNoise(s, river, 'width'), o = riverNoise(s, river, 'wobble'), b = riverNoise(s, river, 'bank');
    const shape = {
        hw: hw * (1 + P.widthVar * w.v), dhw: hw * P.widthVar * w.dv,
        off: P.wobble * hw * o.v, doff: P.wobble * hw * o.dv,
        bank: 1 + P.bankVar * b.v,
        bankLeft: 1 + P.bankVar * b.v, bankRight: 1 - P.bankVar * b.v,
    };
    if (P.bankDetail > 0) {
        const l = riverNoise(s, river, 'shoreLeft'), r = riverNoise(s, river, 'shoreRight');
        const amplitude = hw * RIVER_BANK_DETAIL.shoreFraction * Math.min(P.bankDetail, 1);
        shape.hw += amplitude * (l.v + r.v) * 0.5;
        shape.dhw += amplitude * (l.dv + r.dv) * 0.5;
        shape.off += amplitude * (l.v - r.v) * 0.5;
        shape.doff += amplitude * (l.dv - r.dv) * 0.5;
        shape.bankMorphLeft = Math.min(1, Math.max(0, 0.5 + b.v * 0.55 + w.v * 0.45));
        shape.bankMorphRight = Math.min(1, Math.max(0, 0.5 + o.v * 0.65 - b.v * 0.25));
    }
    return shape;
}

/** Largest half-width factor (incl. the offset) the shape can reach. */
export const riverShapeMaxScale = (P) => 1 + P.widthVar + P.wobble + RIVER_BANK_DETAIL.shoreFraction * Math.min(Math.max(P.bankDetail ?? 0, 0), 1);

/** Extent beyond one wet edge; morph is the clamped shelf/steep-bank mixture. */
export const riverBankExtent = (morph, blendW) => 1 + (Math.max(1, Math.min(blendW, RIVER_BANK_DETAIL.maxExtentM)) - 1) * (1 - morph) ** 3;

/** WGSL of riverNoise: waterRiverNoise(s, river, kind 0 width / 1 wobble / 2 bank) -> vec2(v, dv/ds). */
export function createRiverNoiseWgsl() {
    const octaves = (kind) => RIVER_NOISE[kind].map(([lambda, w]) => `
        n += waterNoiseOctave(s, seed + ${lambda}u, ${lambda.toFixed(1)}, ${w.toFixed(3)});`).join('');
    return /* wgsl */`
fn waterHashU32(xIn: u32) -> u32 {
    var x = (xIn ^ 61u) ^ (xIn >> 16u);
    x = x * 9u;
    x = x ^ (x >> 4u);
    x = x * 0x27d4eb2du;
    return x ^ (x >> 15u);
}
fn waterHashF(i: i32, seed: u32) -> f32 {
    return f32(waterHashU32(bitcast<u32>(i) + seed * 0x632be5abu)) / 4294967296.0;
}
fn waterNoiseOctave(s: f32, seed: u32, lambda: f32, w: f32) -> vec2<f32> {
    let x = s / lambda + 0.5;
    let fi = floor(x);
    let f = x - fi;
    let i = i32(fi);
    let a = waterHashF(i, seed);
    let b = waterHashF(i + 1, seed);
    let t = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let dt = 30.0 * f * f * (f - 1.0) * (f - 1.0);
    return vec2<f32>(w * ((a + (b - a) * t) * 2.0 - 1.0), w * (b - a) * dt * 2.0 / lambda);
}
// Value and metre derivatives in the river tangent frame. Bounded [-1,1].
fn waterBankNoise(s: f32, n: f32, river: f32) -> vec3<f32> {
    let xy = vec2<f32>(s, n) / ${RIVER_BANK_DETAIL.noiseCellM.toFixed(1)};
    let ij = vec2<i32>(floor(xy));
    let f = fract(xy);
    let t = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let dt = 30.0 * f * f * (f - 1.0) * (f - 1.0);
    let seed = (u32(max(river, 0.0)) * 4099u) ^ 0x93bdu;
    let a = waterHashF(ij.x + ij.y * 501125321, seed);
    let b = waterHashF(ij.x + 1 + ij.y * 501125321, seed);
    let c = waterHashF(ij.x + (ij.y + 1) * 501125321, seed);
    let d = waterHashF(ij.x + 1 + (ij.y + 1) * 501125321, seed);
    return vec3<f32>(2.0 * mix(mix(a, b, t.x), mix(c, d, t.x), t.y) - 1.0,
        2.0 * mix(b - a, d - c, t.y) * dt.x / ${RIVER_BANK_DETAIL.noiseCellM.toFixed(1)},
        2.0 * mix(c - a, d - b, t.x) * dt.y / ${RIVER_BANK_DETAIL.noiseCellM.toFixed(1)});
}
// Noise of a river along its arc length s: vec2(value in -1..1, d/ds).
fn waterRiverNoise(s: f32, river: f32, kind: u32) -> vec2<f32> {
    var n = vec2<f32>(0.0);
    let r = u32(max(river, 0.0));
    if (kind == 0u) {
        let seed = (r * 4099u) ^ ${SALT.width}u;${octaves('width')}
    } else if (kind == 1u) {
        let seed = (r * 4099u) ^ ${SALT.wobble}u;${octaves('wobble')}
    } else {
        let seed = (r * 4099u) ^ ${SALT.bank}u;${octaves('bank')}
    }
    return n;
}
// Keep short shore noise out of the existing general noise call graph.
// Its values are identical for left/right; only the independent salt differs.
fn waterShoreNoise(s: f32, river: f32, left: bool) -> vec2<f32> {
    let seed = (u32(max(river, 0.0)) * 4099u) ^ select(${SALT.shoreRight}u, ${SALT.shoreLeft}u, left);
    return ${SHORE_OCTAVES.map(([lambda, w]) => `waterNoiseOctave(s, seed + ${lambda}u, ${lambda.toFixed(1)}, ${w.toFixed(3)})`).join(' + ')};
}
`;
}
