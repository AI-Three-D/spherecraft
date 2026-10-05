// core/world/water/riverShapeNoise.js
//
// Natural irregularity of a river along its length (owner 2026-10-05: an
// even width and straight banks read as a dug moat): the width varies, the
// channel wanders a little around the traced line, the banks rise more or
// less. All of it is 1D value noise of the arc length s along the river
// (seeded by the river's id), so it is continuous across segments and the
// same wherever it is evaluated: the terrain carve and the water shading
// (waterWgsl.js waterRiverPoint), the simulation strip (WaterRiverSim.js)
// and the lab's CPU mirrors. Integer hashing (no sin hash), so the GPU and
// JavaScript agree exactly.

// Wavelengths (m) and weights of the octaves.
export const RIVER_NOISE = Object.freeze({
    width: [[90, 0.7], [35, 0.3]],
    wobble: [[70, 1.0]],
    bank: [[50, 0.7], [21, 0.3]],
});

const SALT = { width: 0x9e37, wobble: 0x7f4a, bank: 0x2c1b };

function hashU32(x) {
    x = (x ^ 61) ^ (x >>> 16);
    x = Math.imul(x, 9) >>> 0;
    x = (x ^ (x >>> 4)) >>> 0;
    x = Math.imul(x, 0x27d4eb2d) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
}
const hashF = (i, seed) => hashU32(((i | 0) + Math.imul(seed, 0x632be5ab)) >>> 0) / 4294967296;

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

/**
 * Shape of a river at arc length s: half-width, centre offset (m, + left),
 * bank-height factor, and their derivatives per metre along the river.
 * P: { widthVar, wobble, bankVar } (WaterGpuData look.shape / carve config).
 */
export function riverShapeAt(s, river, hw, P) {
    const w = riverNoise(s, river, 'width'), o = riverNoise(s, river, 'wobble'), b = riverNoise(s, river, 'bank');
    return {
        hw: hw * (1 + P.widthVar * w.v), dhw: hw * P.widthVar * w.dv,
        off: P.wobble * hw * o.v, doff: P.wobble * hw * o.dv,
        bank: 1 + P.bankVar * b.v,
    };
}

/** Largest half-width factor (incl. the offset) the shape can reach. */
export const riverShapeMaxScale = (P) => 1 + P.widthVar + P.wobble;

/** WGSL of riverNoise: waterRiverNoise(s, river, kind 0 width / 1 wobble / 2 bank) -> vec2(v, dv/ds). */
export function createRiverNoiseWgsl() {
    const octaves = (kind, k) => RIVER_NOISE[kind].map(([lambda, w]) => `
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
`;
}
