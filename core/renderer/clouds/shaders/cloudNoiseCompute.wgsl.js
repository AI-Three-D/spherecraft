// js/renderer/clouds/shaders/cloudNoiseCompute.wgsl.js
import { createNoiseLibrary } from '../../../world/shaders/webgpu/noiseLibrary.wgsl.js';

export function createCloudNoiseComputeShader() {
    const noiseLib = createNoiseLibrary();

    return /* wgsl */`
    ${noiseLib}

    struct NoiseParams {
        gridDimX: u32,
        gridDimY: u32,
        gridDimZ: u32,
        seed: i32,
        noiseType: u32,  // 0 = base, 1 = detail, 2 = erosion
        period: u32,     // >0 = periodic noise (tileable), 0 = world-space clipmap
        _pad0: u32,
        _pad1: u32,
        origin: vec3<f32>,
        voxelSize: f32,
        noiseScale: f32,
    };

    @group(0) @binding(0) var<uniform> params: NoiseParams;
    @group(0) @binding(1) var noiseTexture: texture_storage_3d<rgba8unorm, write>;

    // ============================================================
    // Worley (cellular) noise - produces cloud cell boundaries
    // ============================================================
    fn hash3(p: vec3<f32>) -> vec3<f32> {
        var q = vec3<f32>(
            dot(p, vec3<f32>(127.1, 311.7, 74.7)),
            dot(p, vec3<f32>(269.5, 183.3, 246.1)),
            dot(p, vec3<f32>(113.5, 271.9, 124.6))
        );
        return fract(sin(q) * 43758.5453123);
    }

    fn worley3D(p: vec3<f32>, seed: i32) -> f32 {
        let seedOffset = vec3<f32>(f32(seed) * 0.1, f32(seed) * 0.07, f32(seed) * 0.13);
        let pp = p + seedOffset;
        let cell = floor(pp);
        let local = fract(pp);

        var minDist = 1.0;

        for (var z = -1; z <= 1; z++) {
            for (var y = -1; y <= 1; y++) {
                for (var x = -1; x <= 1; x++) {
                    let offset = vec3<f32>(f32(x), f32(y), f32(z));
                    let neighbor = cell + offset;
                    let point = hash3(neighbor) + offset;
                    let diff = point - local;
                    let dist = dot(diff, diff);
                    minDist = min(minDist, dist);
                }
            }
        }

        return sqrt(minDist);
    }

    fn worleyFBM(p: vec3<f32>, octaves: i32, seed: i32) -> f32 {
        var sum = 0.0;
        var amplitude = 1.0;
        var frequency = 1.0;
        var totalAmplitude = 0.0;

        for (var i = 0; i < octaves; i++) {
            sum += amplitude * worley3D(p * frequency, seed + i * 7);
            totalAmplitude += amplitude;
            frequency *= 2.0;
            amplitude *= 0.5;
        }

        return sum / totalAmplitude;
    }

    fn modI32(x: i32, m: i32) -> i32 {
        let r = x % m;
        return select(r + m, r, r < 0);
    }

    fn wrapI32(p: vec3<i32>, period: i32) -> vec3<i32> {
        return vec3<i32>(modI32(p.x, period), modI32(p.y, period), modI32(p.z, period));
    }

    fn perlin3DPeriodic(p: vec3<f32>, seed: i32, period: i32) -> f32 {
        let i = vec3<i32>(floor(p));
        let f = fract(p);
        let u = vec3<f32>(fade(f.x), fade(f.y), fade(f.z));

        let i000 = wrapI32(i, period);
        let i100 = wrapI32(i + vec3<i32>(1, 0, 0), period);
        let i010 = wrapI32(i + vec3<i32>(0, 1, 0), period);
        let i110 = wrapI32(i + vec3<i32>(1, 1, 0), period);
        let i001 = wrapI32(i + vec3<i32>(0, 0, 1), period);
        let i101 = wrapI32(i + vec3<i32>(1, 0, 1), period);
        let i011 = wrapI32(i + vec3<i32>(0, 1, 1), period);
        let i111 = wrapI32(i + vec3<i32>(1, 1, 1), period);

        let h000 = hash3d(i000, seed);
        let h100 = hash3d(i100, seed);
        let h010 = hash3d(i010, seed);
        let h110 = hash3d(i110, seed);
        let h001 = hash3d(i001, seed);
        let h101 = hash3d(i101, seed);
        let h011 = hash3d(i011, seed);
        let h111 = hash3d(i111, seed);

        let g000 = grad3(h000, f.x,       f.y,       f.z);
        let g100 = grad3(h100, f.x - 1.0, f.y,       f.z);
        let g010 = grad3(h010, f.x,       f.y - 1.0, f.z);
        let g110 = grad3(h110, f.x - 1.0, f.y - 1.0, f.z);
        let g001 = grad3(h001, f.x,       f.y,       f.z - 1.0);
        let g101 = grad3(h101, f.x - 1.0, f.y,       f.z - 1.0);
        let g011 = grad3(h011, f.x,       f.y - 1.0, f.z - 1.0);
        let g111 = grad3(h111, f.x - 1.0, f.y - 1.0, f.z - 1.0);

        let x00 = mix(g000, g100, u.x);
        let x10 = mix(g010, g110, u.x);
        let x01 = mix(g001, g101, u.x);
        let x11 = mix(g011, g111, u.x);

        let y0 = mix(x00, x10, u.y);
        let y1 = mix(x01, x11, u.y);

        return mix(y0, y1, u.z);
    }

    fn fbm3DPeriodic(p: vec3<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32, basePeriod: i32) -> f32 {
        var value = 0.0;
        var amp = 1.0;
        var freq = 1.0;
        var sumAmp = 0.0;
        var period = max(basePeriod, 1);

        for (var i = 0; i < 16; i++) {
            if (i >= octaves) { break; }
            value += perlin3DPeriodic(p * freq, seed + i, period) * amp;
            sumAmp += amp;
            amp *= gain;
            freq *= lacunarity;
            period *= i32(lacunarity);
        }

        return value / max(sumAmp, 1e-6);
    }

    fn worley3DPeriodic(p: vec3<f32>, seed: i32, period: i32) -> f32 {
        let seedOffset = vec3<f32>(f32(seed) * 0.1, f32(seed) * 0.07, f32(seed) * 0.13);
        let pp = p + seedOffset;
        let cell = floor(pp);
        let local = fract(pp);

        var minDist = 1.0;

        for (var z = -1; z <= 1; z++) {
            for (var y = -1; y <= 1; y++) {
                for (var x = -1; x <= 1; x++) {
                    let offset = vec3<f32>(f32(x), f32(y), f32(z));
                    let offseti = vec3<i32>(x, y, z);
                    let neighbor = wrapI32(vec3<i32>(cell) + offseti, period);
                    let point = hash3(vec3<f32>(neighbor)) + offset;
                    let diff = point - local;
                    let dist = dot(diff, diff);
                    minDist = min(minDist, dist);
                }
            }
        }

        return sqrt(minDist);
    }

    // Multi-octave Worley
    fn worleyFBMPeriodic(p: vec3<f32>, octaves: i32, seed: i32, basePeriod: i32) -> f32 {
        var sum = 0.0;
        var amplitude = 1.0;
        var frequency = 1.0;
        var totalAmplitude = 0.0;
        var period = max(basePeriod, 1);

        for (var i = 0; i < octaves; i++) {
            sum += amplitude * worley3DPeriodic(p * frequency, seed + i * 7, period);
            totalAmplitude += amplitude;
            frequency *= 2.0;
            amplitude *= 0.5;
            period *= 2;
        }

        return sum / totalAmplitude;
    }

    @compute @workgroup_size(4, 4, 4)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
        let dim = params.gridDimX;
        if (globalId.x >= dim || globalId.y >= dim || globalId.z >= dim) {
            return;
        }

        let uvw = (vec3<f32>(globalId) + 0.5) / f32(dim);
        let isPeriodic = params.period > 0u;
        let worldPos = params.origin + (vec3<f32>(globalId) + 0.5) * params.voxelSize;
        let coord = worldPos * params.noiseScale;
        var result: vec4<f32>;

        if (params.noiseType == 0u) {
            // BASE SHAPE (32³)
            // Perlin-Worley hybrid: gives billowing cloud cells
            let freq = 4.0;

            // Perlin for overall variation
            let perlin = select(
                perlin3D(coord * freq, params.seed),
                perlin3DPeriodic(uvw * freq, params.seed, i32(freq)),
                isPeriodic
            );
            let perlinNorm = perlin * 0.5 + 0.5;

            // Worley for cell structure (inverted - 1.0 at center, 0.0 at edges)
            let worleyVal = select(
                1.0 - worley3D(coord * freq, params.seed + 5),
                1.0 - worley3DPeriodic(uvw * freq, params.seed + 5, i32(freq)),
                isPeriodic
            );

            // Perlin-Worley: remap Perlin using Worley as threshold
            // This creates clouds with defined cell boundaries
            let perlinWorley = remap(perlinNorm, worleyVal * 0.4, 1.0, 0.0, 1.0);
            let baseShape = clamp(perlinWorley, 0.0, 1.0);

            // Lower frequency Worley for larger cell variation
            let worleyLow = select(
                1.0 - worley3D(coord * 2.0, params.seed + 11),
                1.0 - worley3DPeriodic(uvw * 2.0, params.seed + 11, 2),
                isPeriodic
            );

            // Coverage variation (very low freq)
            let coverageNoise = select(
                perlin3D(coord * 2.0, params.seed + 31),
                perlin3DPeriodic(uvw * 2.0, params.seed + 31, 2),
                isPeriodic
            ) * 0.5 + 0.5;

            result = vec4<f32>(baseShape, worleyLow, coverageNoise, 1.0);

        } else if (params.noiseType == 1u) {
            // DETAIL (64³)
            // Multi-octave Worley for billowing detail
            let freq = 4.0;

            // FBM Worley - creates billowy medium detail
            let worleyDetail = select(
                1.0 - worleyFBM(coord * freq, 3, params.seed + 50),
                1.0 - worleyFBMPeriodic(uvw * freq, 3, params.seed + 50, i32(freq)),
                isPeriodic
            );

            // Perlin detail for variation
            let perlinDetail = select(
                fbm3D(coord * freq * 1.5, 3, params.seed + 67, 2.0, 0.5),
                fbm3DPeriodic(uvw * freq * 1.5, 3, params.seed + 67, 2.0, 0.5, i32(freq) * 2),
                isPeriodic
            ) * 0.5 + 0.5;

            // Mix of Worley and Perlin detail
            let mixedDetail = worleyDetail * 0.7 + perlinDetail * 0.3;

            // Second channel: higher frequency worley
            let worleyHigh = select(
                1.0 - worley3D(coord * freq * 2.0, params.seed + 73),
                1.0 - worley3DPeriodic(uvw * freq * 2.0, params.seed + 73, i32(freq) * 2),
                isPeriodic
            );

            result = vec4<f32>(mixedDetail, worleyHigh, perlinDetail, 1.0);

        } else {
            // EROSION (128³)
            // High-frequency Worley for wispy edges
            let freq = 4.0;

            // Multi-octave Worley erosion
            let erosion = select(
                1.0 - worleyFBM(coord * freq, 4, params.seed + 100),
                1.0 - worleyFBMPeriodic(uvw * freq, 4, params.seed + 100, i32(freq)),
                isPeriodic
            );

            // Higher freq for fine wisps
            let fineWorley = select(
                1.0 - worleyFBM(coord * freq * 2.0, 3, params.seed + 117),
                1.0 - worleyFBMPeriodic(uvw * freq * 2.0, 3, params.seed + 117, i32(freq) * 2),
                isPeriodic
            );

            // Curl-like distortion noise
            let curlX = select(
                perlin3D(coord * freq * 3.0 + vec3<f32>(0.0, 7.5, 0.0), params.seed + 130),
                perlin3DPeriodic(uvw * freq * 3.0 + vec3<f32>(0.0, 7.5, 0.0), params.seed + 130, i32(freq) * 3),
                isPeriodic
            );
            let curlY = select(
                perlin3D(coord * freq * 3.0 + vec3<f32>(7.5, 0.0, 0.0), params.seed + 131),
                perlin3DPeriodic(uvw * freq * 3.0 + vec3<f32>(7.5, 0.0, 0.0), params.seed + 131, i32(freq) * 3),
                isPeriodic
            );
            let curl = (curlX * curlY) * 0.5 + 0.5;

            result = vec4<f32>(erosion, fineWorley, curl, 1.0);
        }

        textureStore(noiseTexture, vec3<i32>(globalId), result);
    }

    fn remap(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
        return newLo + (v - lo) / max(hi - lo, 0.0001) * (newHi - newLo);
    }
`;
}
