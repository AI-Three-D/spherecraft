// js/actors/nav/ObjectPicker.js
//
// GPU compute: tests a ray against the close-tree cylinder buffer.
// Returns the nearest tree hit (if any).

import { Logger } from '../../../shared/Logger.js';

function buildObjectPickerShader() {
    return /* wgsl */`
const CLOSE_TREE_STRIDE: u32 = 32u;
const MAX_TREES: u32 = 512u;

struct Params {
    rayOrigin:   vec3<f32>, _pad0: f32,
    rayDir:      vec3<f32>, maxDist: f32,
    planetOrigin:vec3<f32>, planetRadius: f32,
    maxColliders:u32,
    interactRadius: f32,  // how wide the pick cylinder is
    _pad1: u32, _pad2: u32,
}

@group(0) @binding(0) var<uniform>             params:    Params;
@group(0) @binding(1) var<storage, read>       closeTrees: array<f32>;
@group(0) @binding(2) var<storage, read>       closeTreeCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> result:    array<f32>;
// result: [hit(0/1), worldX, worldY, worldZ, distance, treeIndex, treeRadius, 0]

@compute @workgroup_size(1)
fn main() {
    let n = min(closeTreeCount[0], min(params.maxColliders, MAX_TREES));
    let ro = params.rayOrigin;
    let rd = params.rayDir;

    var bestDist = params.maxDist;
    var bestIdx = -1;
    var bestPos = vec3<f32>(0.0);
    var bestR = 0.0;

    // For each tree, test ray-cylinder intersection in the
    // tangent plane (project to local up axis).
    for (var i = 0u; i < n; i++) {
        let b = i * CLOSE_TREE_STRIDE;
        let treePos = vec3<f32>(closeTrees[b], closeTrees[b+1u], closeTrees[b+2u]);
        let treeW = closeTrees[b + 4u];
        let treeH = closeTrees[b + 5u];

        let trunkR = max(treeW * 0.08, 0.35) + params.interactRadius;

        let up = normalize(treePos - params.planetOrigin);

        // Project ray to tangent plane relative to tree
        let oc = ro - treePos;
        let ocH = dot(oc, up);
        let rdH = dot(rd, up);
        let oc2 = oc - up * ocH;
        let rd2 = rd - up * rdH;

        let a = dot(rd2, rd2);
        let b2 = 2.0 * dot(oc2, rd2);
        let c = dot(oc2, oc2) - trunkR * trunkR;
        let disc = b2 * b2 - 4.0 * a * c;

        if (disc < 0.0 || a < 1e-8) { continue; }

        let sq = sqrt(disc);
        let t0 = (-b2 - sq) / (2.0 * a);
        let t1 = (-b2 + sq) / (2.0 * a);
        var t = t0;
        if (t < 0.01) { t = t1; }
        if (t < 0.01 || t >= bestDist) { continue; }

        // Height check: is hit within trunk height?
        let hitH = ocH + rdH * t;
        if (hitH < -0.5 || hitH > treeH * 0.8) { continue; }

        bestDist = t;
        bestIdx = i32(i);
        bestPos = ro + rd * t;
        bestR = trunkR;
    }

    result[0] = select(0.0, 1.0, bestIdx >= 0);
    result[1] = bestPos.x;
    result[2] = bestPos.y;
    result[3] = bestPos.z;
    result[4] = bestDist;
    result[5] = f32(bestIdx);
    result[6] = bestR;
    result[7] = 0.0;
}
`;
}

export class ObjectPicker {
    constructor(device) {
        this.device = device;
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
        const mod = this.device.createShaderModule({
            label: 'ObjectPicker-SM',
            code: buildObjectPickerShader(),
        });

        this._bgl = this.device.createBindGroupLayout({
            label: 'ObjectPicker-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'ObjectPicker-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._paramsBuffer = this.device.createBuffer({
            label: 'ObjectPicker-Params', size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._resultBuffer = this.device.createBuffer({
            label: 'ObjectPicker-Result', size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        this._readbackBuffer = this.device.createBuffer({
            label: 'ObjectPicker-Readback', size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this._initialized = true;
    }

    /**
     * @param {GPUCommandEncoder} encoder
     * @param {object} ray { origin, dir }
     * @param {object} planetConfig
     * @param {GPUBuffer} closeTreeBuf
     * @param {GPUBuffer} closeTreeCountBuf
     * @param {number} maxColliders
     * @param {number} maxDist
     */
    dispatch(encoder, ray, planetConfig, closeTreeBuf, closeTreeCountBuf, maxColliders, maxDist = 200) {
        if (!this._initialized || this._readbackState !== 'idle') return;
        if (!closeTreeBuf || !closeTreeCountBuf) return;

        const buf = new ArrayBuffer(256);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        f32[0] = ray.origin.x; f32[1] = ray.origin.y; f32[2] = ray.origin.z; f32[3] = 0;
        f32[4] = ray.dir.x; f32[5] = ray.dir.y; f32[6] = ray.dir.z; f32[7] = maxDist;
        const o = planetConfig.origin || { x: 0, y: 0, z: 0 };
        f32[8] = o.x; f32[9] = o.y; f32[10] = o.z; f32[11] = planetConfig.radius;
        u32[12] = maxColliders; f32[13] = 0.3; // interactRadius
        u32[14] = 0; u32[15] = 0;

        this.device.queue.writeBuffer(this._paramsBuffer, 0, buf);

        this._bg = this.device.createBindGroup({
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: { buffer: closeTreeBuf } },
                { binding: 2, resource: { buffer: closeTreeCountBuf } },
                { binding: 3, resource: { buffer: this._resultBuffer } },
            ],
        });

        const pass = encoder.beginComputePass({ label: 'ObjectPicker' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bg);
        pass.dispatchWorkgroups(1);
        pass.end();

        encoder.copyBufferToBuffer(this._resultBuffer, 0, this._readbackBuffer, 0, 32);
        this._readbackState = 'copied';
    }

    resolveHit() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);
        this._readbackState = 'mapping';
        return this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const f = new Float32Array(this._readbackBuffer.getMappedRange(0, 32));
            const hit = f[0] > 0.5;
            const result = hit ? {
                hit: true, type: 'tree',
                position: { x: f[1], y: f[2], z: f[3] },
                distance: f[4],
                objectIndex: Math.round(f[5]),
                radius: f[6],
            } : { hit: false, type: null, position: null, distance: -1 };
            this._readbackBuffer.unmap();
            this._readbackState = 'idle';
            return result;
        }).catch(() => { this._readbackState = 'idle'; return null; });
    }

    dispose() {
        this._paramsBuffer?.destroy();
        this._resultBuffer?.destroy();
        this._readbackBuffer?.destroy();
    }
}