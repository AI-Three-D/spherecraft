/**
 * BiomeQuery — GPU compute shader that samples the tile type ID
 * at an arbitrary world-space position using the quadtree tile textures.
 *
 * This is a general-purpose utility: given a 3D position on the planet
 * surface, it returns the TILE_TYPES integer stored in the tile texture
 * at that location. Reusable for hover inspection, biome diagnostics,
 * asset placement queries, etc.
 *
 * Usage:
 *   const query = new BiomeQuery(device, tileStreamer);
 *   query.initialize();
 *   // each frame (throttle to ~10Hz):
 *   query.dispatch(encoder, worldPos, planetConfig, quadtreeGPU, textures, hashBuf);
 *   // after submit:
 *   const result = await query.resolve();
 *   // result = { tileId: 42, face: 0, u: 0.5, v: 0.5 } or null
 */

import { gpuFormatSampleType } from '../renderer/resources/texture.js';

function buildBiomeQueryShader() {
    return /* wgsl */`
struct Params {
    origin:      vec3<f32>,
    radius:      f32,
    heightScale: f32,
    faceSize:    f32,
    hashMask:    u32,
    hashCapacity:u32,
    tileTexSize: u32,
    maxDepth:    u32,
    _pad0:       u32,
    _pad1:       u32,
    queryPos:    vec3<f32>,
    _pad2:       f32,
}

@group(0) @binding(0) var<uniform>              params:    Params;
@group(0) @binding(1) var                       tileTex:   texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read>        hashTable: array<u32>;
@group(0) @binding(3) var<storage, read_write>  result:    array<u32>;
// result layout: [tileId, face, depth, tileX, tileY, localU*1000, localV*1000, valid]

const MAX_PROBE: u32 = 64u;

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

@compute @workgroup_size(1)
fn main() {
    let dir = normalize(params.queryPos - params.origin);
    let fuv = dirToFaceUV(dir);
    let face = u32(fuv.x);
    let u = clamp(fuv.y, 0.0, 0.999999);
    let v = clamp(fuv.z, 0.0, 0.999999);
    let texSize = i32(params.tileTexSize);

    var foundDepth = 0u;
    var foundTileX = 0u;
    var foundTileY = 0u;
    var tileId = 0u;
    var localU = 0u;
    var localV = 0u;
    var valid = 0u;

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
            let px = clamp(i32(lu * f32(texSize - 1) + 0.5), 0, texSize - 1);
            let py = clamp(i32(lv * f32(texSize - 1) + 0.5), 0, texSize - 1);
            let rawR = textureLoad(tileTex, vec2<i32>(px, py), layer, 0).r;
            let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
            tileId = u32(tileIdF + 0.5);
            foundDepth = d;
            foundTileX = tx;
            foundTileY = ty;
            localU = u32(lu * 1000.0);
            localV = u32(lv * 1000.0);
            valid = 1u;
            break;
        }
        if (d == 0u) { break; }
        d = d - 1u;
    }

    result[0] = tileId;
    result[1] = face;
    result[2] = foundDepth;
    result[3] = foundTileX;
    result[4] = foundTileY;
    result[5] = localU;
    result[6] = localV;
    result[7] = valid;
}
`;
}

export class BiomeQuery {
    /**
     * @param {GPUDevice} device
     * @param {object} tileStreamer - for texture format info
     */
    constructor(device, tileStreamer) {
        this.device = device;
        this._tileStreamer = tileStreamer;
        this._pipeline = null;
        this._bgl = null;
        this._bg = null;
        this._paramsBuffer = null;
        this._resultBuffer = null;
        this._readbackBuffer = null;
        this._readbackState = 'idle';
        this._initialized = false;
    }

    initialize() {
        const code = buildBiomeQueryShader();
        const mod = this.device.createShaderModule({
            label: 'BiomeQuery-SM', code,
        });

        const formats = this._tileStreamer?.textureFormats ?? {};
        const tileSampleType = gpuFormatSampleType(formats.tile || 'r8unorm');

        this._bgl = this.device.createBindGroupLayout({
            label: 'BiomeQuery-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
            ],
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'BiomeQuery-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._paramsBuffer = this.device.createBuffer({
            label: 'BiomeQuery-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._resultBuffer = this.device.createBuffer({
            label: 'BiomeQuery-Result',
            size: 64,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this._readbackBuffer = this.device.createBuffer({
            label: 'BiomeQuery-Readback',
            size: 64,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
    }

    /**
     * Dispatch a biome query at a world position. Non-blocking.
     * @param {GPUCommandEncoder} encoder
     * @param {{x:number,y:number,z:number}} worldPos  Hit point on terrain surface
     * @param {object} planetConfig
     * @param {object} quadtreeGPU  Quadtree GPU state
     * @param {object} textures  { tile } texture arrays
     * @param {GPUBuffer} hashBuf
     * @returns {boolean} true if dispatch succeeded
     */
    dispatch(encoder, worldPos, planetConfig, quadtreeGPU, textures, hashBuf) {
        if (!this._initialized) return false;
        if (this._readbackState !== 'idle') return false;

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
        f32[12] = worldPos.x; f32[13] = worldPos.y; f32[14] = worldPos.z;
        f32[15] = 0;

        this.device.queue.writeBuffer(this._paramsBuffer, 0, buf);

        this._rebuildBG(textures, hashBuf);
        if (!this._bg) return false;

        const pass = encoder.beginComputePass({ label: 'BiomeQuery' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bg);
        pass.dispatchWorkgroups(1);
        pass.end();

        encoder.copyBufferToBuffer(this._resultBuffer, 0, this._readbackBuffer, 0, 32);
        this._readbackState = 'copied';
        return true;
    }

    /**
     * Resolve the last dispatched query.
     * @returns {Promise<{tileId:number, face:number, depth:number, tileX:number, tileY:number}|null>}
     */
    resolve() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);

        this._readbackState = 'mapping';
        return this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const u = new Uint32Array(this._readbackBuffer.getMappedRange(0, 32));
            const valid = u[7] > 0;
            const result = valid ? {
                tileId: u[0],
                face:   u[1],
                depth:  u[2],
                tileX:  u[3],
                tileY:  u[4],
                localU: u[5] / 1000,
                localV: u[6] / 1000,
            } : null;
            this._readbackBuffer.unmap();
            this._readbackState = 'idle';
            return result;
        }).catch(() => {
            this._readbackState = 'idle';
            return null;
        });
    }

    _rebuildBG(textures, hashBuf) {
        const tView = this._getTextureView(textures?.tile);
        const resolvedHashBuf = this._getGPUBuffer(hashBuf);
        if (!tView || !resolvedHashBuf) {
            this._bg = null;
            return;
        }

        this._bg = this.device.createBindGroup({
            label: 'BiomeQuery-BG',
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: tView },
                { binding: 2, resource: { buffer: resolvedHashBuf } },
                { binding: 3, resource: { buffer: this._resultBuffer } },
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
