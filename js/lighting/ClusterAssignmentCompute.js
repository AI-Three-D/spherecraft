// js/lighting/ClusterAssignmentCompute.js

import { Logger } from '../config/Logger.js';

const WORKGROUP_SIZE = 64;

export class ClusterAssignmentCompute {
    constructor(device, clusterGrid, maxLights = 64) {
        this.device = device;
        this.clusterGrid = clusterGrid;
        this.maxLights = maxLights;

        const totalClusters = clusterGrid.totalClusters;

        this.clusterAABBBuffer = device.createBuffer({
            label: 'CL-ClusterAABBs',
            size: Math.max(256, totalClusters * 6 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this.atomicCounterBuffer = device.createBuffer({
            label: 'CL-AtomicCounter',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        // View matrix uniform (64 bytes = mat4x4)
        this.viewMatrixBuffer = device.createBuffer({
            label: 'CL-ViewMatrix',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this._aabbScratch = new Float32Array(totalClusters * 6);
        this._viewMatrixScratch = new Float32Array(16);
        this._pipeline = null;
        this._bindGroupLayout = null;
        this._bindGroup = null;
        this._initialized = false;

        Logger.info(
            `[ClusterAssignmentCompute] clusters=${totalClusters} ` +
            `workgroups=${Math.ceil(totalClusters / WORKGROUP_SIZE)}`
        );
    }

    initialize(lightBuffers) {
        if (this._initialized) return;
        this._createPipeline();
        this._createBindGroup(lightBuffers);
        this._initialized = true;
    }

    _createPipeline() {
        const shaderCode = this._buildShaderCode();

        const module = this.device.createShaderModule({
            label: 'CL-AssignCompute',
            code: shaderCode
        });

        this._bindGroupLayout = this.device.createBindGroupLayout({
            label: 'CL-AssignLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'CL-AssignPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._bindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });
    }

    _createBindGroup(lightBuffers) {
        this._bindGroup = this.device.createBindGroup({
            label: 'CL-AssignBindGroup',
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: lightBuffers.lightBuffer } },
                { binding: 1, resource: { buffer: this.clusterAABBBuffer } },
                { binding: 2, resource: { buffer: lightBuffers.clusterBuffer } },
                { binding: 3, resource: { buffer: lightBuffers.lightIndexBuffer } },
                { binding: 4, resource: { buffer: this.atomicCounterBuffer } },
                { binding: 5, resource: { buffer: lightBuffers.paramBuffer } },
                { binding: 6, resource: { buffer: this.viewMatrixBuffer } },
            ]
        });
    }

    uploadClusterAABBs() {
        const aabbs = this.clusterGrid.clusterAABBs;
        this._aabbScratch.set(aabbs);
        this.device.queue.writeBuffer(this.clusterAABBBuffer, 0, this._aabbScratch);
    }

    uploadViewMatrix(camera) {
        const m = camera.matrixWorldInverse;
        if (m && m.elements) {
            this._viewMatrixScratch.set(m.elements);
        } else {
            this._viewMatrixScratch.set([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ]);
        }
        this.device.queue.writeBuffer(this.viewMatrixBuffer, 0, this._viewMatrixScratch);
    }

    dispatch(commandEncoder, numLights) {
        if (!this._initialized || numLights === 0) return;

        const zeros = new Uint32Array([0, 0, 0, 0]);
        this.device.queue.writeBuffer(this.atomicCounterBuffer, 0, zeros);

        const totalClusters = this.clusterGrid.totalClusters;
        const numWorkgroups = Math.ceil(totalClusters / WORKGROUP_SIZE);

        const pass = commandEncoder.beginComputePass({ label: 'CL-Assignment' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.dispatchWorkgroups(numWorkgroups);
        pass.end();
    }

    _buildShaderCode() {
        const totalClusters = this.clusterGrid.totalClusters;
        const maxLightsPerCluster = 32;

        return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const TOTAL_CLUSTERS: u32 = ${totalClusters}u;
const MAX_LIGHTS_PER_CLUSTER: u32 = ${maxLightsPerCluster}u;

struct Light {
    position:   vec3<f32>, radius:    f32,
    color:      vec3<f32>, intensity: f32,
    direction:  vec3<f32>, lightType: f32,
    angle:      f32,       penumbra:  f32,
    decay:      f32,       castShadow:f32,
}

struct ClusterData {
    lightCount:  u32,
    lightOffset: u32,
    _pad0:       u32,
    _pad1:       u32,
}

struct Params {
    dims:           vec3<f32>, numLights:     f32,
    near:           f32,       far:           f32,
    maxPerCluster:  f32,       _pad:          f32,
    invTanHalfFovX: f32,       invTanHalfFovY:f32,
    _pad2:          f32,       _pad3:         f32,
    _r0: f32, _r1: f32, _r2: f32, _r3: f32,
}

@group(0) @binding(0) var<storage, read>       lights:        array<Light>;
@group(0) @binding(1) var<storage, read>       clusterAABBs:  array<f32>;
@group(0) @binding(2) var<storage, read_write> clusterData:   array<ClusterData>;
@group(0) @binding(3) var<storage, read_write> lightIndices:  array<u32>;
@group(0) @binding(4) var<storage, read_write> atomicCounter: array<atomic<u32>>;


@group(0) @binding(5) var<uniform>             params:        Params;
@group(0) @binding(6) var<uniform>             viewMatrix:    mat4x4<f32>;

fn getClusterAABB(idx: u32) -> array<f32, 6> {
    let base = idx * 6u;
    return array<f32, 6>(
        clusterAABBs[base],      clusterAABBs[base + 1u], clusterAABBs[base + 2u],
        clusterAABBs[base + 3u], clusterAABBs[base + 4u], clusterAABBs[base + 5u]
    );
}

fn sphereIntersectsAABB(center: vec3<f32>, radius: f32, aabb: array<f32, 6>) -> bool {
    let minP = vec3<f32>(aabb[0], aabb[1], aabb[2]);
    let maxP = vec3<f32>(aabb[3], aabb[4], aabb[5]);
    let closest = clamp(center, minP, maxP);
    let dist2 = dot(closest - center, closest - center);
    return dist2 <= radius * radius;
}

fn transformToViewSpace(worldPos: vec3<f32>) -> vec3<f32> {
    let vp = viewMatrix * vec4<f32>(worldPos, 1.0);
    return vp.xyz;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let clusterIdx = globalId.x;
    if (clusterIdx >= TOTAL_CLUSTERS) { return; }

    let numLights = u32(params.numLights);
    let aabb = getClusterAABB(clusterIdx);

    var count: u32 = 0u;
    var indices: array<u32, ${maxLightsPerCluster}>;

    for (var i = 0u; i < numLights; i++) {
        let light = lights[i];

        // Directional lights affect all clusters
        if (light.lightType < 0.5) {
            if (count < MAX_LIGHTS_PER_CLUSTER) {
                indices[count] = i;
                count++;
            }
            continue;
        }

        // Transform light position to view space
        let viewPos = transformToViewSpace(light.position);

        // Sphere-AABB test in view space
        if (sphereIntersectsAABB(viewPos, light.radius, aabb)) {
            if (count < MAX_LIGHTS_PER_CLUSTER) {
                indices[count] = i;
                count++;
            }
        }
    }

    let offset = atomicAdd(&atomicCounter[0], count);

    clusterData[clusterIdx].lightCount = count;
    clusterData[clusterIdx].lightOffset = offset;

    for (var i = 0u; i < count; i++) {
        lightIndices[offset + i] = indices[i];
    }
}
`;
    }

    dispose() {
        this.clusterAABBBuffer.destroy();
        this.atomicCounterBuffer.destroy();
        this.viewMatrixBuffer.destroy();
    }
}