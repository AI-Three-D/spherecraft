// js/texture/webgpu/shaders/proceduralNoise.wgsl.js

export const proceduralNoiseShader = `
struct Uniforms {
    resolution: vec2<f32>,
    seed: f32,
    noiseType: i32,
    octaves: i32,
    frequency: f32,
    amplitude: f32,
    persistence: f32,
    rotation: f32,
    turbulencePower: f32,
    ridgeOffset: f32,
    warpStrength: f32,
    warpFrequency: f32,
    cellScale: f32,
    cellRandomness: f32,
    cellElongation: f32,
    _pad: f32,
    cellStretch: vec2<f32>,
    color: vec3<f32>,
    _pad2: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
fn gainAroundHalf(x: f32, g: f32) -> f32 {
    // g=1 normal, g>1 more contrast
    return clamp((x - 0.5) * g + 0.5, 0.0, 1.0);
}
    
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn rand(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x + uniforms.seed * 0.1731, p.y + uniforms.seed * 0.3049, p.x + uniforms.seed * 0.2137) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn smoothstep_cpu(a: f32, b: f32, t: f32) -> f32 {
    let x = clamp((t - a) / (b - a), 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);

    let u = smoothstep_cpu(0.0, 1.0, f.x);
    let v = smoothstep_cpu(0.0, 1.0, f.y);

    let a = rand(i);
    let b = rand(i + vec2<f32>(1.0, 0.0));
    let c = rand(i + vec2<f32>(0.0, 1.0));
    let d = rand(i + vec2<f32>(1.0, 1.0));

    let val = mix(mix(a, b, u), mix(c, d, u), v);
    return val * 2.0 - 1.0;
}

fn grain(coord: vec2<f32>) -> f32 {
    // Integer pixel coords => stable per-pixel noise
    let ip = floor(coord);
    // Two hashes averaged -> less harsh than pure white noise
    let a = hash12(ip + vec2<f32>(uniforms.seed * 17.0, uniforms.seed * 31.0));
    let b = hash12(ip + vec2<f32>(uniforms.seed * 53.0, uniforms.seed * 97.0));
    // Triangular-ish distribution around 0.5 (less “sparkle”)
    return clamp((a + b) * 0.5, 0.0, 1.0);
}
fn fbm(p: vec2<f32>, oct: i32, persistence: f32) -> f32 {
    var value = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    var maxv = 0.0;

    for (var i = 0; i < 16; i++) {
        if (i >= oct) { break; }
        value += amp * valueNoise(p * freq + vec2<f32>(uniforms.seed));
        maxv += amp;
        amp *= persistence;
        freq *= 2.0;
    }
    return value / maxv;
}

fn turbulence(p: vec2<f32>, oct: i32, persistence: f32, power: f32) -> f32 {
    var v = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    var maxv = 0.0;

    for (var i = 0; i < 16; i++) {
        if (i >= oct) { break; }
        let n = valueNoise(p * freq + vec2<f32>(uniforms.seed * 100.0));
        v += pow(abs(n), power) * amp;
        maxv += amp;
        amp *= persistence;
        freq *= 2.0;
    }
    return clamp(v / maxv, 0.0, 1.0);
}

fn ridged(p: vec2<f32>, oct: i32, persistence: f32, offset: f32) -> f32 {
    var v = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    var maxv = 0.0;

    for (var i = 0; i < 16; i++) {
        if (i >= oct) { break; }
        var n = abs(valueNoise(p * freq + vec2<f32>(uniforms.seed * 200.0)));
        n = offset - n;
        n = n * n;
        v += n * amp;
        maxv += amp;
        amp *= persistence;
        freq *= 2.0;
    }
    return clamp(v / maxv, 0.0, 1.0);
}

fn voronoi(p: vec2<f32>, randomness: f32) -> f32 {
    let i = floor(p);
    var minD = 1e6;
    for (var j = -1; j <= 1; j++) {
        for (var i2 = -1; i2 <= 1; i2++) {
            let neighbor = vec2<f32>(f32(i2), f32(j));
            let point = vec2<f32>(
                hash12(i + neighbor + vec2<f32>(12.34 * uniforms.seed)),
                hash12(i + neighbor + vec2<f32>(56.78 * uniforms.seed))
            );
            let pointJittered = 0.5 + 0.5 * sin(point * randomness * 6.2831853);
            let diff = neighbor + pointJittered - fract(p);
            minD = min(minD, length(diff));
        }
    }
    return minD;
}

fn cellPattern(p: vec2<f32>, scale: f32, randomness: f32, elongation: f32, stretch: vec2<f32>) -> f32 {
    let pScaled = p * stretch * scale;
    let i = floor(pScaled);
    var min1 = 1e6;
    var min2 = 1e6;

    for (var y = -2; y <= 2; y++) {
        for (var x = -2; x <= 2; x++) {
            let nb = vec2<f32>(f32(x), f32(y));
            let pt = vec2<f32>(hash12(i + nb), hash12(i + nb + vec2<f32>(5.3)));
            let ptJittered = 0.5 + 0.5 * sin(pt * randomness * 6.2831853);
            let diff = nb + ptJittered - fract(pScaled);
            let dist = length(diff);
            if (dist < min1) {
                min2 = min1;
                min1 = dist;
            } else if (dist < min2) {
                min2 = dist;
            }
        }
    }
    let cell = min2 - min1;
    return smoothstep(elongation - 0.1, elongation + 0.1, cell);
}

fn rotateCoord(uv: vec2<f32>, ang: f32) -> vec2<f32> {
    let center = uniforms.resolution * 0.5;
    var p = uv * uniforms.resolution - center;
    let c = cos(ang);
    let s = sin(ang);
    p = vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
    return (p + center) / uniforms.resolution;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let texSize = textureDimensions(outputTexture);
    if (global_id.x >= texSize.x || global_id.y >= texSize.y) {
        return;
    }

    var coord = vec2<f32>(f32(global_id.x), f32(global_id.y));
    let v_uv = coord / uniforms.resolution;

    if (uniforms.rotation != 0.0) {
        coord = rotateCoord(v_uv, uniforms.rotation) * uniforms.resolution;
    }

    let maxDim = max(uniforms.resolution.x, uniforms.resolution.y);
    let px = coord.x / maxDim;
    let py = coord.y / maxDim;

    let nx = px * uniforms.frequency * uniforms.resolution.x + uniforms.seed;
    let ny = py * uniforms.frequency * uniforms.resolution.y + uniforms.seed;
    var p = vec2<f32>(nx, ny);

    if (uniforms.warpStrength > 0.0) {
        let q = vec2<f32>(
            fbm(p * uniforms.warpFrequency, 3, 0.5),
            fbm(p * uniforms.warpFrequency + vec2<f32>(5.2, 1.3), 3, 0.5)
        );
        p = p + q * uniforms.warpStrength;
    }

    var val = 0.0;

    if (uniforms.noiseType == 0) {
        val = valueNoise(p);
        val = (val + 1.0) * 0.5;
    } else if (uniforms.noiseType == 1) {
        val = fbm(p, uniforms.octaves, uniforms.persistence);
        val = (val + 1.0) * 0.5;
    } else if (uniforms.noiseType == 2) {
        val = turbulence(p, uniforms.octaves, uniforms.persistence, uniforms.turbulencePower);
    } else if (uniforms.noiseType == 3) {
        val = ridged(p, uniforms.octaves, uniforms.persistence, uniforms.ridgeOffset);
    } else if (uniforms.noiseType == 4) {
        val = voronoi(p * uniforms.cellScale, uniforms.cellRandomness);
    } else if (uniforms.noiseType == 5) {
        val = cellPattern(p, uniforms.cellScale, uniforms.cellRandomness, uniforms.cellElongation, uniforms.cellStretch);
} else if (uniforms.noiseType == 6) {
    val = grain(coord);                 // 0..1
    val = gainAroundHalf(val, uniforms.amplitude); // amplitude = contrast
}

if (uniforms.noiseType != 6) {
    val = clamp(val * uniforms.amplitude, 0.0, 1.0);
} else {
    val = clamp(val, 0.0, 1.0);
}

    let outColor = vec4<f32>(val * uniforms.color, 1.0);

    textureStore(outputTexture, vec2<i32>(global_id.xy), outColor);
}
`;
