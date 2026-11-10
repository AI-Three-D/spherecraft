// js/lighting/ClusteredLightBuffers.js

import { Logger } from '../../shared/Logger.js';
import { ClusterAssignmentCompute } from './ClusterAssignmentCompute.js';

const LIGHT_STRIDE_F32 = 16;

export class ClusteredLightBuffers {
    constructor(device, clusterGrid, maxLights = 64) {
        this.device = device;
        this.clusterGrid = clusterGrid;
        this.maxLights = maxLights;

        const totalClusters = clusterGrid.totalClusters;
        const maxIndices = totalClusters * 32;

        this.lightBuffer = device.createBuffer({
            label: 'CL-Lights',
            size: Math.max(256, maxLights * LIGHT_STRIDE_F32 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.clusterBuffer = device.createBuffer({
            label: 'CL-Clusters',
            size: Math.max(256, totalClusters * 16),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.lightIndexBuffer = device.createBuffer({
            label: 'CL-Indices',
            size: Math.max(256, maxIndices * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.paramBuffer = device.createBuffer({
            label: 'CL-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this._lightScratch = new Float32Array(maxLights * LIGHT_STRIDE_F32);
        this._clusterScratch = new Uint32Array(totalClusters * 4);
        this._indexScratch = new Uint32Array(maxIndices);
        this._paramScratch = new Float32Array(16);
        this.numLights = 0;

        this._tanHalfFovX = 0.8;
        this._tanHalfFovY = 0.6;
        this._camera = null;

        this._compute = new ClusterAssignmentCompute(device, clusterGrid, maxLights);
  
        this._lastCameraVersion = -1;

        Logger.info(
            `[ClusteredLightBuffers] clusters=${totalClusters} ` +
            `maxLights=${maxLights} `
        );
    }

    setCamera(camera) {
        this._camera = camera;
        this._tanHalfFovX = Math.tan((camera.fov * Math.PI / 180) * 0.5) * camera.aspect;
        this._tanHalfFovY = Math.tan((camera.fov * Math.PI / 180) * 0.5);

        const version = `${camera.near}_${camera.far}_${camera.fov}_${camera.aspect}`;
        if (this._lastCameraVersion !== version) {
            this._lastCameraVersion = version;
            this._cameraChanged = true;
        }
    }

    upload(lightManager) {
        this._uploadLightData(lightManager.lights);
        this._uploadParams();
    }

    uploadCPUAssignment(lightManager) {
        this._uploadClusterDataCPU(
            lightManager.clusterLightCount,
            lightManager.clusterLightOffset,
            lightManager.clusterLightIndices
        );
    }

    dispatchCompute(commandEncoder) {
        if (!this._compute._initialized) {
            this._compute.initialize(this);
        }
    
        // Skip if no lights
        if (this.numLights === 0) return;
    
        if (this._cameraChanged) {
            this._compute.uploadClusterAABBs();
            this._cameraChanged = false;
        }
    
        if (this._camera) {
            this._compute.uploadViewMatrix(this._camera);
        }
    
        this._compute.dispatch(commandEncoder, this.numLights);
    }

    _uploadLightData(lights) {
        const count = Math.min(lights.length, this.maxLights);
        const d = this._lightScratch;
        for (let i = 0; i < count; i++) {
            const L = lights[i];
            const o = i * LIGHT_STRIDE_F32;
            d[o]    = L.position.x;  d[o+1]  = L.position.y;
            d[o+2]  = L.position.z;  d[o+3]  = L.radius;
            d[o+4]  = L.color.r;     d[o+5]  = L.color.g;
            d[o+6]  = L.color.b;     d[o+7]  = L.intensity;
            d[o+8]  = L.direction.x; d[o+9]  = L.direction.y;
            d[o+10] = L.direction.z; d[o+11] = L.type;
            d[o+12] = L.angle;       d[o+13] = L.penumbra;
            d[o+14] = L.decay;       d[o+15] = L.castShadow ? 1.0 : 0.0;
        }
        this.numLights = count;
        this.device.queue.writeBuffer(
            this.lightBuffer, 0,
            d.buffer, 0, count * LIGHT_STRIDE_F32 * 4
        );
        if (!this._debugFrame) this._debugFrame = 0;
/*this._debugFrame++;

if ((this._debugFrame % 120) === 0) {
    console.log(
        '[ClusteredLightBuffers]',
        'numLights=', this.numLights,
        'near=', g.nearPlane,
        'far=', g.farPlane,
        'dims=', g.gridSizeX, g.gridSizeY, g.gridSizeZ,
        'invTanX=', invTanX.toFixed(4),
        'invTanY=', invTanY.toFixed(4)
    );
}
if (count > 0) {
    const L = lights[0];
    console.log(
        '[ClusteredLightBuffers:firstLight]',
        'type=', L.type,
        'pos=', L.position.x.toFixed(2), L.position.y.toFixed(2), L.position.z.toFixed(2),
        'radius=', L.radius,
        'intensity=', L.intensity
    );
}else console.log('[ClusteredLightBuffers] no lights to upload');*/
    }

    _uploadClusterDataCPU(counts, offsets, indices) {
        const total = this.clusterGrid.totalClusters;
        const cd = this._clusterScratch;
        for (let i = 0; i < total; i++) {
            cd[i*4]   = counts[i]  || 0;
            cd[i*4+1] = offsets[i] || 0;
            cd[i*4+2] = 0;
            cd[i*4+3] = 0;
        }
        this.device.queue.writeBuffer(this.clusterBuffer, 0, cd);

        const id = this._indexScratch;
        const idxCount = Math.min(indices.length, id.length);
        for (let i = 0; i < idxCount; i++) id[i] = indices[i] | 0;
        this.device.queue.writeBuffer(
            this.lightIndexBuffer, 0,
            id.buffer, 0, idxCount * 4
        );
    }

    _uploadParams() {
        const p = this._paramScratch;
        const g = this.clusterGrid;

        const invTanX = 1.0 / Math.max(this._tanHalfFovX, 0.001);
        const invTanY = 1.0 / Math.max(this._tanHalfFovY, 0.001);

        p[0]  = g.gridSizeX;  p[1]  = g.gridSizeY;
        p[2]  = g.gridSizeZ;  p[3]  = this.numLights;
        p[4]  = g.nearPlane;  p[5]  = g.farPlane;
        p[6]  = 32.0;         p[7]  = 0.0;
        p[8]  = invTanX;      p[9]  = invTanY;
        p[10] = 0.0;          p[11] = 0.0;
        p[12] = 0.0;          p[13] = 0.0;
        p[14] = 0.0;          p[15] = 0.0;

        this.device.queue.writeBuffer(this.paramBuffer, 0, p.buffer, 0, 16 * 4);
    }

    dispose() {
        this.lightBuffer.destroy();
        this.clusterBuffer.destroy();
        this.lightIndexBuffer.destroy();
        this.paramBuffer.destroy();
        this._compute?.dispose();
    }
}