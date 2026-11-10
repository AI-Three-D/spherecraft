// js/actors/nav/TerrainRaycaster.js
//
// GPU compute shader that ray-marches along a world-space ray,
// sampling the height-array texture to find precise terrain intersection.
// Returns hit position via readback buffer.
//
// Uses the same height texture + hash table as movementResolver.

import { Logger } from '../../../shared/Logger.js';
import { gpuFormatSampleType } from '../../../core/renderer/resources/texture.js';

function buildTerrainRaycastShader() {
    return /* wgsl */`
const MAX_PROBE: u32 = 64u;
const MAX_STEPS: u32 = 256u;

struct Params {
    origin:      vec3<f32>,  // planet center
    radius:      f32,
    heightScale: f32,
    faceSize:    f32,
    hashMask:    u32,
    hashCapacity:u32,
    tileTexSize: u32,
    maxDepth:    u32,
    _pad0:       u32,
    _pad1:       u32,
    // Ray
    rayOrigin:   vec3<f32>,
    _pad2:       f32,
    rayDir:      vec3<f32>,
    maxDist:     f32,
}

@group(0) @binding(0) var<uniform>              params:    Params;
@group(0) @binding(1) var                       heightTex: texture_2d_array<f32>;
@group(0) @binding(2) var                       normalTex: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read>        hashTable: array<u32>;
@group(0) @binding(4) var<storage, read_write>  result:    array<f32>;
// result layout:
// [hit(0/1), x, y, z, distance, normalX, normalY, normalZ,
//  face, depth, tileX, tileY, layer, localU, localV, heightMeters]

fn hashKey(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    let h = (kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u);
    return h & params.hashMask;
}

fn lookupLayer(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = (x & 0xFFFFu) | ((y & 0xFFFFu) << 16u);
    let keyHi = (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u);
    var idx = hashKey(keyLo, keyHi);
    let cap = params.hashCapacity;
    for (var i = 0u; i < min(cap, MAX_PROBE); i++) {
        let base = idx * 4u;
        let hi = hashTable[base + 1u];
        if (hi == 0xFFFFFFFFu) { return -1; }
        if (hi == keyHi && hashTable[base] == keyLo) {
            return i32(hashTable[base + 2u]);
        }
        idx = (idx + 1u) & params.hashMask;
    }
    return -1;
}

fn dirToFaceUV(d: vec3<f32>) -> vec3<f32> {
    let ad = abs(d);
    var face = 0u; var s = 0.0; var t = 0.0; var inv: f32;
    if (ad.x >= ad.y && ad.x >= ad.z) {
        inv = 1.0 / ad.x;
        if (d.x > 0.0) { face = 0u; s = -d.z * inv; t = d.y * inv; }
        else           { face = 1u; s =  d.z * inv; t = d.y * inv; }
    } else if (ad.y >= ad.z) {
        inv = 1.0 / ad.y;
        if (d.y > 0.0) { face = 2u; s = d.x * inv; t = -d.z * inv; }
        else           { face = 3u; s = d.x * inv; t =  d.z * inv; }
    } else {
        inv = 1.0 / ad.z;
        if (d.z > 0.0) { face = 4u; s =  d.x * inv; t = d.y * inv; }
        else           { face = 5u; s = -d.x * inv; t = d.y * inv; }
    }
    return vec3<f32>(f32(face), s * 0.5 + 0.5, t * 0.5 + 0.5);
}

struct HeightSample {
    height: f32,
    layer: i32,
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    localUV: vec2<f32>,
}

fn emptyHeightSample(worldPos: vec3<f32>) -> HeightSample {
    let dir = normalize(worldPos - params.origin);
    let fuv = dirToFaceUV(dir);
    return HeightSample(
        0.0,
        -1,
        u32(fuv.x),
        0u,
        0u,
        0u,
        vec2<f32>(clamp(fuv.y, 0.0, 1.0), clamp(fuv.z, 0.0, 1.0))
    );
}

fn sampleHeight(worldPos: vec3<f32>) -> HeightSample {
    let dir = normalize(worldPos - params.origin);
    let fuv = dirToFaceUV(dir);
    let face = u32(fuv.x);
    let u = clamp(fuv.y, 0.0, 0.999999);
    let v = clamp(fuv.z, 0.0, 0.999999);
    let texSize = i32(params.tileTexSize);

    var d = params.maxDepth;
    loop {
        let grid = 1u << d;
        let tx = min(u32(u * f32(grid)), grid - 1u);
        let ty = min(u32(v * f32(grid)), grid - 1u);
        let layer = lookupLayer(face, d, tx, ty);
        if (layer >= 0) {
            let tileSize = 1.0 / f32(grid);
            let lu = (u - f32(tx) * tileSize) / tileSize;
            let lv = (v - f32(ty) * tileSize) / tileSize;
            let coord = vec2<f32>(clamp(lu, 0.0, 1.0), clamp(lv, 0.0, 1.0)) * f32(max(texSize - 1, 1));
            let base = vec2<i32>(floor(coord));
            let frac = coord - vec2<f32>(base);
            let maxCoord = vec2<i32>(texSize - 1);
            let c00 = clamp(base, vec2<i32>(0), maxCoord);
            let c10 = clamp(base + vec2<i32>(1, 0), vec2<i32>(0), maxCoord);
            let c01 = clamp(base + vec2<i32>(0, 1), vec2<i32>(0), maxCoord);
            let c11 = clamp(base + vec2<i32>(1, 1), vec2<i32>(0), maxCoord);
            let h00 = textureLoad(heightTex, c00, layer, 0).r;
            let h10 = textureLoad(heightTex, c10, layer, 0).r;
            let h01 = textureLoad(heightTex, c01, layer, 0).r;
            let h11 = textureLoad(heightTex, c11, layer, 0).r;
            let h0 = mix(h00, h10, frac.x);
            let h1 = mix(h01, h11, frac.x);
            return HeightSample(
                mix(h0, h1, frac.y) * params.heightScale,
                layer,
                face,
                d,
                tx,
                ty,
                vec2<f32>(clamp(lu, 0.0, 1.0), clamp(lv, 0.0, 1.0))
            );
        }
        if (d == 0u) { break; }
        d = d - 1u;
    }
    return emptyHeightSample(worldPos);
}

@compute @workgroup_size(1)
fn main() {
    let ro = params.rayOrigin;
    let rd = params.rayDir;
    let maxDist = params.maxDist;

    // Adaptive step: start coarse, refine on sign change
    var hit = false;
    var hitPos = vec3<f32>(0.0);
    var hitDist = 0.0;
    var hitSample = emptyHeightSample(ro);

    // Coarse march
    let coarseStep = maxDist / f32(MAX_STEPS);
    var prevAbove = true;
    var prevT = 0.0;

    for (var i = 0u; i < MAX_STEPS; i++) {
        let t = f32(i) * coarseStep;
        let p = ro + rd * t;
        let pSample = sampleHeight(p);
        let surfR = params.radius + pSample.height;
        let sampleR = length(p - params.origin);
        let above = sampleR >= surfR;

        if (i > 0u && !above && prevAbove) {
            // Sign change — bisect to refine
            var lo = prevT;
            var hi = t;
            for (var j = 0u; j < 8u; j++) {
                let mid = (lo + hi) * 0.5;
                let mp = ro + rd * mid;
                let mSample = sampleHeight(mp);
                let mSurfR = params.radius + mSample.height;
                let mR = length(mp - params.origin);
                if (mR >= mSurfR) { lo = mid; } else { hi = mid; }
            }
            hitDist = (lo + hi) * 0.5;
            hitPos = ro + rd * hitDist;
            // Snap to surface
            let hUp = normalize(hitPos - params.origin);
            hitSample = sampleHeight(hitPos);
            hitPos = params.origin + hUp * (params.radius + hitSample.height);
            hitSample = sampleHeight(hitPos);
            hit = true;
            break;
        }
        prevAbove = above;
        prevT = t;
    }

    result[0] = select(0.0, 1.0, hit);
    result[1] = hitPos.x;
    result[2] = hitPos.y;
    result[3] = hitPos.z;
    result[4] = hitDist;
    // Surface normal (up direction at hit point)
    let nUp = select(vec3(0.0, 1.0, 0.0), normalize(hitPos - params.origin), hit);
    result[5] = nUp.x;
    result[6] = nUp.y;
    result[7] = nUp.z;
    result[8] = f32(hitSample.face);
    result[9] = f32(hitSample.depth);
    result[10] = f32(hitSample.tileX);
    result[11] = f32(hitSample.tileY);
    result[12] = f32(hitSample.layer);
    result[13] = hitSample.localUV.x;
    result[14] = hitSample.localUV.y;
    result[15] = hitSample.height;
}
`;
}

export class TerrainRaycaster {
    /**
     * @param {GPUDevice} device
     * @param {object} tileStreamer - for texture formats
     */
    constructor(device, tileStreamer) {
        this.device = device;
        this._tileStreamer = tileStreamer;

        this._pipeline = null;
        this._bgl = null;
        this._bg = null;
        this._bgDirty = true;

        this._paramsBuffer = null;
        this._resultBuffer = null;
        this._readbackBuffer = null;
        this._readbackState = 'idle'; // idle | copied | mapping
        this._pendingResolve = null;

        this._initialized = false;
    }

    initialize() {
        const code = buildTerrainRaycastShader();
        const mod = this.device.createShaderModule({
            label: 'TerrainRaycast-SM', code,
        });
        const formats = this._tileStreamer?.textureFormats ?? {};
        const heightSampleType = gpuFormatSampleType(formats.height || 'r32float');
        const normalSampleType = gpuFormatSampleType(formats.normal || 'rgba8unorm');

        this._bgl = this.device.createBindGroupLayout({
            label: 'TerrainRaycast-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: normalSampleType, viewDimension: '2d-array' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
            ],
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'TerrainRaycast-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._paramsBuffer = this.device.createBuffer({
            label: 'TerrainRaycast-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._resultBuffer = this.device.createBuffer({
            label: 'TerrainRaycast-Result',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this._readbackBuffer = this.device.createBuffer({
            label: 'TerrainRaycast-Readback',
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
    }

    /**
     * Dispatch a raycast. Non-blocking. Call resolveHit() later.
     * @param {GPUCommandEncoder} encoder
     * @param {object} ray  { origin:{x,y,z}, dir:{x,y,z} }
     * @param {object} planetConfig
     * @param {object} quadtreeGPU
     * @param {object} textures  { height, normal } array textures
     * @param {GPUBuffer} hashBuf
     * @param {number} maxDist
     */
    dispatch(encoder, ray, planetConfig, quadtreeGPU, textures, hashBuf, maxDist = 500) {
        if (!this._initialized) return;
        if (this._readbackState !== 'idle') return; // previous still in flight

        // Write params
        const buf = new ArrayBuffer(256);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        const o = planetConfig.origin || { x: 0, y: 0, z: 0 };
        f32[0] = o.x; f32[1] = o.y; f32[2] = o.z;
        f32[3] = planetConfig.radius;
        f32[4] = planetConfig.heightScale ?? 1000;
        f32[5] = quadtreeGPU?.faceSize ?? (planetConfig.radius * 2);
        u32[6] = quadtreeGPU?.loadedTableMask ?? 0;
        u32[7] = quadtreeGPU?.loadedTableCapacity ?? 0;
        u32[8] = this._tileStreamer?.tileTextureSize ?? 128;
        u32[9] = quadtreeGPU?.maxDepth ?? 12;
        u32[10] = 0; u32[11] = 0;
        // Ray
        f32[12] = ray.origin.x; f32[13] = ray.origin.y; f32[14] = ray.origin.z;
        f32[15] = 0;
        f32[16] = ray.dir.x; f32[17] = ray.dir.y; f32[18] = ray.dir.z;
        f32[19] = maxDist;

        this.device.queue.writeBuffer(this._paramsBuffer, 0, buf);

        // Rebuild bind group if textures changed
        this._rebuildBG(textures, hashBuf);

        if (!this._bg) return false;

        const pass = encoder.beginComputePass({ label: 'TerrainRaycast' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bg);
        pass.dispatchWorkgroups(1);
        pass.end();

        encoder.copyBufferToBuffer(this._resultBuffer, 0, this._readbackBuffer, 0, 64);
        this._readbackState = 'copied';
        return true;
    }

    /**
     * Call after submit. Returns a Promise<{hit, position, distance, normal}|null>.
     */
    resolveHit() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);

        this._readbackState = 'mapping';
        return this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const f = new Float32Array(this._readbackBuffer.getMappedRange(0, 64));
            const hit = f[0] > 0.5;
            const result = hit ? {
                hit: true,
                position: { x: f[1], y: f[2], z: f[3] },
                distance: f[4],
                normal: { x: f[5], y: f[6], z: f[7] },
                lookup: {
                    face: Math.round(f[8]),
                    depth: Math.round(f[9]),
                    x: Math.round(f[10]),
                    y: Math.round(f[11]),
                    layer: Math.round(f[12]),
                    localUV: { x: f[13], y: f[14] },
                    height: f[15],
                },
            } : { hit: false, position: null, distance: -1, normal: null };
            this._readbackBuffer.unmap();
            this._readbackState = 'idle';
            return result;
        }).catch(() => {
            this._readbackState = 'idle';
            return null;
        });
    }

    _rebuildBG(textures, hashBuf) {
        const hView = this._getTextureView(textures?.height);
        const nView = this._getTextureView(textures?.normal);
        const resolvedHashBuf = this._getGPUBuffer(hashBuf);
        if (!hView || !nView || !resolvedHashBuf) {
            this._bg = null;
            return;
        }

        this._bg = this.device.createBindGroup({
            label: 'TerrainRaycast-BG',
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: hView },
                { binding: 2, resource: nView },
                { binding: 3, resource: { buffer: resolvedHashBuf } },
                { binding: 4, resource: { buffer: this._resultBuffer } },
            ],
        });
    }

    _getTextureView(texture) {
        const gpuTexture = texture?._gpuTexture?.texture ?? texture;
        if (!gpuTexture?.createView) return null;
        return gpuTexture.createView({ dimension: '2d-array' });
    }

    _getGPUBuffer(buffer) {
        if (!buffer) return null;
        if (typeof buffer.mapAsync === 'function' || typeof buffer.destroy === 'function') {
            return buffer;
        }
        return buffer.buffer ?? null;
    }

    dispose() {
        this._paramsBuffer?.destroy();
        this._resultBuffer?.destroy();
        this._readbackBuffer?.destroy();
    }
}
