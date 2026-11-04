/**
 * Lattice value noise shared by rock appearance, veins and brush roughness.
 * The JS functions and the WGSL source below are twins: change them together.
 */
export function hash3(ix, iy, iz, seed) {                 // [-1, 1)
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1;
}

const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => a * (1 - t) + b * t;

export function noise3(x, y, z, seed) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const u = fade(x - x0), v = fade(y - y0), w = fade(z - z0);
    return mix(
        mix(mix(hash3(x0, y0, z0, seed), hash3(x0 + 1, y0, z0, seed), u),
            mix(hash3(x0, y0 + 1, z0, seed), hash3(x0 + 1, y0 + 1, z0, seed), u), v),
        mix(mix(hash3(x0, y0, z0 + 1, seed), hash3(x0 + 1, y0, z0 + 1, seed), u),
            mix(hash3(x0, y0 + 1, z0 + 1, seed), hash3(x0 + 1, y0 + 1, z0 + 1, seed), u), v),
        w);
}

export const noiseWGSL = /* wgsl */ `
fn hash3(p: vec3<i32>, seed: u32) -> f32 {
    var h = (bitcast<u32>(p.x) * 0x27d4eb2du) ^ (bitcast<u32>(p.y) * 0x165667b1u) ^ (bitcast<u32>(p.z) * 0x9e3779b1u) ^ seed;
    h = (h ^ (h >> 15u)) * 0x85ebca6bu;
    h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
    h = h ^ (h >> 16u);
    return f32(h) / 4294967296.0 * 2.0 - 1.0;
}
fn fade3(t: vec3<f32>) -> vec3<f32> {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
fn noise3(p: vec3<f32>, seed: u32) -> f32 {
    let cell = floor(p);
    let i = vec3<i32>(cell);
    let u = fade3(p - cell);
    let n000 = hash3(i, seed);
    let n100 = hash3(i + vec3<i32>(1, 0, 0), seed);
    let n010 = hash3(i + vec3<i32>(0, 1, 0), seed);
    let n110 = hash3(i + vec3<i32>(1, 1, 0), seed);
    let n001 = hash3(i + vec3<i32>(0, 0, 1), seed);
    let n101 = hash3(i + vec3<i32>(1, 0, 1), seed);
    let n011 = hash3(i + vec3<i32>(0, 1, 1), seed);
    let n111 = hash3(i + vec3<i32>(1, 1, 1), seed);
    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z);
}

// Value and exact spatial derivative. Vein coverage needs both; evaluate the
// eight corner hashes once instead of repeating the noise at three offsets.
fn noise3Gradient(p: vec3<f32>, seed: u32) -> vec4<f32> {
    let cell=floor(p);
    let i=vec3<i32>(cell);
    let t=p-cell;
    let u=fade3(t);
    let du=30.0*t*t*(t-vec3<f32>(1))*(t-vec3<f32>(1));
    let a=hash3(i,seed);
    let b=hash3(i+vec3<i32>(1,0,0),seed);
    let c=hash3(i+vec3<i32>(0,1,0),seed);
    let d=hash3(i+vec3<i32>(1,1,0),seed);
    let e=hash3(i+vec3<i32>(0,0,1),seed);
    let f=hash3(i+vec3<i32>(1,0,1),seed);
    let g=hash3(i+vec3<i32>(0,1,1),seed);
    let h=hash3(i+vec3<i32>(1,1,1),seed);
    let x0=mix(a,b,u.x);
    let x1=mix(c,d,u.x);
    let x2=mix(e,f,u.x);
    let x3=mix(g,h,u.x);
    let z0=mix(x0,x1,u.y);
    let z1=mix(x2,x3,u.y);
    return vec4<f32>(mix(z0,z1,u.z),
        mix(mix(b-a,d-c,u.y),mix(f-e,h-g,u.y),u.z)*du.x,
        mix(x1-x0,x3-x2,u.z)*du.y,(z1-z0)*du.z);
}
`;