// One-time GPU generation of the tileable 3D noise volumes used by the clouds.
// Coordinates are normalised texture space; integer frequencies keep every
// octave periodic so the volumes tile seamlessly.

const NOISE_LIB_WGSL = /* wgsl */`
fn pcg3d(seed: vec3u) -> vec3u {
    var v = seed * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v = v ^ (v >> vec3u(16u));
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}

fn hash3(cell: vec3i, period: i32, seed: u32) -> vec3f {
    let p = vec3i(period);
    let wrapped = vec3u(((cell % p) + p) % p);
    let h = pcg3d(wrapped + vec3u(seed * 1013u, seed * 7919u, seed * 104729u));
    return vec3f(h) * (1.0 / 4294967295.0);
}

fn gradCorner(cell: vec3i, o: vec3i, f: vec3f, period: i32, seed: u32) -> f32 {
    let g = hash3(cell + o, period, seed) * 2.0 - 1.0;
    return dot(g, f - vec3f(o));
}

// Tileable gradient noise, roughly [-1, 1].
fn gradientNoise(p: vec3f, period: i32, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = fract(p);
    let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let n000 = gradCorner(i, vec3i(0, 0, 0), f, period, seed);
    let n100 = gradCorner(i, vec3i(1, 0, 0), f, period, seed);
    let n010 = gradCorner(i, vec3i(0, 1, 0), f, period, seed);
    let n110 = gradCorner(i, vec3i(1, 1, 0), f, period, seed);
    let n001 = gradCorner(i, vec3i(0, 0, 1), f, period, seed);
    let n101 = gradCorner(i, vec3i(1, 0, 1), f, period, seed);
    let n011 = gradCorner(i, vec3i(0, 1, 1), f, period, seed);
    let n111 = gradCorner(i, vec3i(1, 1, 1), f, period, seed);
    let x00 = mix(n000, n100, w.x);
    let x10 = mix(n010, n110, w.x);
    let x01 = mix(n001, n101, w.x);
    let x11 = mix(n011, n111, w.x);
    return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

fn perlinFbm(p: vec3f, freq: i32, octaves: i32, seed: u32) -> f32 {
    var sum = 0.0;
    var amp = 1.0;
    var norm = 0.0;
    var f = freq;
    for (var o = 0; o < octaves; o++) {
        sum += gradientNoise(p * f32(f), f, seed + u32(o)) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2;
    }
    return clamp(sum / norm * 1.6, -1.0, 1.0);
}

// Inverted F1 Worley: 1 at feature points, falling to 0 between them.
fn worley(p: vec3f, freq: i32, seed: u32) -> f32 {
    let q = p * f32(freq);
    let cell = vec3i(floor(q));
    let fq = fract(q);
    var minD = 10.0;
    for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let o = vec3i(x, y, z);
                let d = hash3(cell + o, freq, seed) + vec3f(o) - fq;
                minD = min(minD, dot(d, d));
            }
        }
    }
    return 1.0 - saturate(sqrt(minD));
}

// Dilate Perlin by Worley: remap(v, 0, 1, lo, 1).
fn remap01(v: f32, lo: f32) -> f32 {
    return lo + v * (1.0 - lo);
}

fn worleyFbm(p: vec3f, freq: i32, seed: u32) -> f32 {
    return worley(p, freq, seed) * 0.625
        + worley(p, freq * 2, seed + 1u) * 0.25
        + worley(p, freq * 4, seed + 2u) * 0.125;
}
`;

const kernel = (body) => /* wgsl */`
${NOISE_LIB_WGSL}
@group(0) @binding(0) var outVolume: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outVolume);
    if (any(id >= size)) { return; }
    let p = (vec3f(id) + 0.5) / vec3f(size);
${body}
}
`;

/** 128^3: R Perlin-Worley, GBA Worley fBm at increasing frequency. */
export const SHAPE_NOISE_WGSL = kernel(/* wgsl */`
    let perlin = perlinFbm(p, 4, 7, 11u) * 0.5 + 0.5;
    let g = worleyFbm(p, 4, 21u);
    let b = worleyFbm(p, 8, 31u);
    let a = worleyFbm(p, 16, 41u);
    let perlinWorley = remap01(perlin, g);
    textureStore(outVolume, vec3i(id), vec4f(perlinWorley, g, b, a));
`);

/** 64^3: RGB Worley fBm at increasing frequency for edge erosion. */
export const DETAIL_NOISE_WGSL = kernel(/* wgsl */`
    let r = worleyFbm(p, 2, 51u);
    let g = worleyFbm(p, 4, 61u);
    let b = worleyFbm(p, 8, 71u);
    textureStore(outVolume, vec3i(id), vec4f(r, g, b, 1.0));
`);

/** 128^3 weather: R coverage, G cloud type, B clumps, A fine variation. */
export const WEATHER_NOISE_WGSL = kernel(/* wgsl */`
    let coverage = perlinFbm(p, 3, 6, 81u) * 0.5 + 0.5;
    let kind = perlinFbm(p, 2, 4, 91u) * 0.5 + 0.5;
    let clumps = worleyFbm(p, 3, 101u);
    let fine = perlinFbm(p, 8, 4, 111u) * 0.5 + 0.5;
    textureStore(outVolume, vec3i(id), vec4f(coverage, kind, clumps, fine));
`);

/** 2x2x2 box filter from one mip to the next. */
export const DOWNSAMPLE_3D_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_3d<f32>;
@group(0) @binding(1) var dst: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dst);
    if (any(id >= size)) { return; }
    let base = vec3i(id) * 2;
    var sum = vec4f(0.0);
    for (var i = 0; i < 8; i++) {
        let o = vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1);
        sum += textureLoad(src, base + o, 0);
    }
    textureStore(dst, vec3i(id), sum * 0.125);
}
`;
