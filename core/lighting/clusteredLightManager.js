
import { Vector3, Vector4, Box3 } from '../../shared/math/index.js';
import { Light, LightType } from './lightManager.js';
import { Texture, TextureFormat, TextureFilter } from '../renderer/resources/texture.js';

export class ClusteredLightManager {
    constructor(clusterGrid, options = {}) {
        this.clusterGrid = clusterGrid;

        this.maxLightsPerCluster = options.maxLightsPerCluster || 32;
        this.maxLightIndices = options.maxLightIndices || 16384;
        this.maxLights = options.maxLights || 128;

        this.lights = [];
        this.directionalLights = [];
        this.pointLights = [];
        this.spotLights = [];

        this.clusterLightCount = new Uint32Array(this.clusterGrid.totalClusters);
        this.clusterLightIndices = new Float32Array(this.maxLightIndices);
        this.clusterLightOffset = new Uint32Array(this.clusterGrid.totalClusters);

        this.lightBuffer = new Float32Array(this.maxLights * 16);
        this.clusterBuffer = new Float32Array(this.clusterGrid.totalClusters * 4);
        this.indexBuffer = new Float32Array(this.maxLightIndices);

        this.framesSinceUpdate = 0;
        this.updateFrequency = 3;
        this.dynamicLights = new Set();
        this.staticLightCache = new Map();

        this.globalLightBounds = new Box3();

        this._viewSpaceLights = new Array(this.maxLights);
        for (let i = 0; i < this.maxLights; i++) {
            this._viewSpaceLights[i] = {
                position: new Vector3(),
                radius: 0,
                type: 0,
                index: 0
            };
        }

        this.stats = {
            totalLights: 0,
            assignedLights: 0,
            clustersWithLights: 0,
            maxLightsInCluster: 0
        };

        this.lightDataTexture = null;
        this.clusterDataTexture = null;
        this.lightIndicesTexture = null;

        this._lightSpatialHash = new Map();

        
    }

    addLight(type, options = {}) {
        const light = new Light(type, options);
        this.lights.push(light);

        switch(type) {
            case LightType.DIRECTIONAL:
                this.directionalLights.push(light);
                break;
            case LightType.POINT:
                this.pointLights.push(light);
                break;
            case LightType.SPOT:
                this.spotLights.push(light);
                break;
        }

        if (options.dynamic) {
            this.dynamicLights.add(light.id);
        } else {
            this.staticLightCache.set(light.id, {
                position: light.position.clone(),
                radius: light.radius,
                type: light.type
            });
        }

        this.stats.totalLights = this.lights.length;
        return light;
    }

    assignLightsToClusters(camera, forceUpdate = false) {
        if (!forceUpdate && this.framesSinceUpdate < this.updateFrequency) {
            this.framesSinceUpdate++;
            return false;
        }

        this.framesSinceUpdate = 0;

        const viewMatrix = camera.matrixWorldInverse;
        this._transformLightsToViewSpace(viewMatrix);

        this.clusterLightCount.fill(0);
        this.clusterLightOffset.fill(0);
        this.clusterLightIndices.fill(0);
        this.indexBuffer.fill(0);

        let totalIndices = 0;
        this.stats.assignedLights = 0;
        this.stats.clustersWithLights = 0;
        this.stats.maxLightsInCluster = 0;

        const relevantClusters = this._getRelevantClusters();

        for (const clusterIdx of relevantClusters) {
            const coords = this._getClusterCoords(clusterIdx);
            const aabb = this.clusterGrid.getClusterAABB(coords.x, coords.y, coords.z);

            const result = this._assignLightsToCluster(clusterIdx, aabb, totalIndices);
            totalIndices = result.newTotalIndices;

            if (result.lightCount > 0) {
                this.stats.clustersWithLights++;
                this.stats.maxLightsInCluster = Math.max(this.stats.maxLightsInCluster, result.lightCount);
            }
        }

        this.stats.assignedLights = totalIndices;
        this._updateGPUBuffers();

        return true;
    }

    _getRelevantClusters() {
        const bounds = this.globalLightBounds;
        if (bounds.isEmpty()) {
            return [];
        }

        const relevantClusters = [];
        
        for (let clusterIdx = 0; clusterIdx < this.clusterGrid.totalClusters; clusterIdx++) {
            const coords = this._getClusterCoords(clusterIdx);
            const aabb = this.clusterGrid.getClusterAABB(coords.x, coords.y, coords.z);
            
            if (this._aabbIntersectsGlobalBounds(aabb)) {
                relevantClusters.push(clusterIdx);
            }
        }

        return relevantClusters;
    }

    _transformLightsToViewSpace(viewMatrix) {
        this.globalLightBounds.makeEmpty();

        for (let i = 0; i < this.lights.length; i++) {
            const light = this.lights[i];
            
            if (!light.enabled) continue;
            
            const viewLight = this._viewSpaceLights[i];

            if (!this.dynamicLights.has(light.id)) {
                const cached = this.staticLightCache.get(light.id);
                if (cached && cached.position.equals(light.position)) {
                    continue;
                }
            }

            const worldPos = new Vector4(
                light.position.x,
                light.position.y,
                light.position.z,
                1.0
            );

            worldPos.applyMatrix4(viewMatrix);

            viewLight.position.set(worldPos.x, worldPos.y, worldPos.z);
            viewLight.radius = light.radius;
            viewLight.type = light.type;
            viewLight.index = i;

            if (light.type === LightType.POINT || light.type === LightType.SPOT) {
                const minBound = viewLight.position.clone().subScalar(light.radius);
                const maxBound = viewLight.position.clone().addScalar(light.radius);
                this.globalLightBounds.expandByPoint(minBound);
                this.globalLightBounds.expandByPoint(maxBound);
            }
        }
    }

    _assignLightsToCluster(clusterIdx, aabb, currentTotalIndices) {
        let lightCount = 0;
        const startOffset = currentTotalIndices;
        let newTotalIndices = currentTotalIndices;

        for (const light of this.directionalLights) {
            if (!light.enabled) continue;

            if (lightCount < this.maxLightsPerCluster && newTotalIndices < this.maxLightIndices) {
                this.clusterLightIndices[newTotalIndices++] = this.lights.indexOf(light);
                lightCount++;
            }
        }

        for (let i = 0; i < this.lights.length && lightCount < this.maxLightsPerCluster; i++) {
            const light = this.lights[i];
            if (!light.enabled) continue;
            if (light.type === LightType.DIRECTIONAL) continue;

            const viewLight = this._viewSpaceLights[i];

            if (this._lightIntersectsAABB(viewLight, aabb)) {
                if (newTotalIndices < this.maxLightIndices) {
                    this.clusterLightIndices[newTotalIndices++] = i;
                    lightCount++;
                }
            }
        }

        this.clusterLightCount[clusterIdx] = lightCount;
        this.clusterLightOffset[clusterIdx] = startOffset;

        return { lightCount, newTotalIndices };
    }

    _updateGPUBuffers() {
        for (let i = 0; i < this.clusterGrid.totalClusters; i++) {
            const offset = i * 4;
            this.clusterBuffer[offset + 0] = this.clusterLightCount[i];
            this.clusterBuffer[offset + 1] = this.clusterLightOffset[i];
            this.clusterBuffer[offset + 2] = 0;
            this.clusterBuffer[offset + 3] = 0;
        }

        for (let i = 0; i < this.maxLightIndices; i++) {
            this.indexBuffer[i] = this.clusterLightIndices[i];
        }
    }

    buildGPUBuffers() {
        for (let i = 0; i < this.lights.length; i++) {
            const light = this.lights[i];
            const offset = i * 16;

            this.lightBuffer[offset + 0] = light.position.x;
            this.lightBuffer[offset + 1] = light.position.y;
            this.lightBuffer[offset + 2] = light.position.z;
            this.lightBuffer[offset + 3] = light.radius;

            this.lightBuffer[offset + 4] = light.color.r;
            this.lightBuffer[offset + 5] = light.color.g;
            this.lightBuffer[offset + 6] = light.color.b;
            this.lightBuffer[offset + 7] = light.intensity;

            this.lightBuffer[offset + 8] = light.direction.x;
            this.lightBuffer[offset + 9] = light.direction.y;
            this.lightBuffer[offset + 10] = light.direction.z;
            this.lightBuffer[offset + 11] = light.type;

            this.lightBuffer[offset + 12] = light.angle;
            this.lightBuffer[offset + 13] = light.penumbra;
            this.lightBuffer[offset + 14] = light.decay;
            this.lightBuffer[offset + 15] = light.castShadow ? 1.0 : 0.0;
        }

        return this._createOptimizedTextures();
    }

// Fixed ClusteredLightManager._createOptimizedTextures()

_createOptimizedTextures() {
    if (this.lightDataTexture) this.lightDataTexture.dispose();
    if (this.clusterDataTexture) this.clusterDataTexture.dispose();
    if (this.lightIndicesTexture) this.lightIndicesTexture.dispose();

    const lightDataWidth = Math.max(1, this.lights.length * 4);
    this.lightDataTexture = new Texture({
        width: lightDataWidth,
        height: 1,
        format: TextureFormat.RGBA32F,
        minFilter: TextureFilter.NEAREST,
        magFilter: TextureFilter.NEAREST,
        generateMipmaps: false,
        data: this.lightBuffer.slice(0, lightDataWidth * 4) // Copy data
    });

    this.clusterDataTexture = new Texture({
        width: this.clusterGrid.totalClusters,
        height: 1,
        format: TextureFormat.RGBA32F,
        minFilter: TextureFilter.NEAREST,
        magFilter: TextureFilter.NEAREST,
        generateMipmaps: false,
        data: this.clusterBuffer.slice() // Copy data
    });

    this.lightIndicesTexture = new Texture({
        width: this.maxLightIndices,
        height: 1,
        format: TextureFormat.R32F,
        minFilter: TextureFilter.NEAREST,
        magFilter: TextureFilter.NEAREST,
        generateMipmaps: false,
        data: this.indexBuffer.slice() // Copy data
    });

    return {
        lightData: this.lightDataTexture,
        clusterData: this.clusterDataTexture,
        lightIndices: this.lightIndicesTexture,
        metadata: {
            maxLights: this.maxLights,
            numLights: this.lights.length,
            maxLightsPerCluster: this.maxLightsPerCluster
        }
    };
}
    _lightIntersectsAABB(viewLight, aabb) {
        if (viewLight.type === LightType.POINT) {
            const closest = new Vector3(
                Math.max(aabb.min.x, Math.min(viewLight.position.x, aabb.max.x)),
                Math.max(aabb.min.y, Math.min(viewLight.position.y, aabb.max.y)),
                Math.max(aabb.min.z, Math.min(viewLight.position.z, aabb.max.z))
            );

            const distSq = closest.distanceToSquared(viewLight.position);
            return distSq <= viewLight.radius * viewLight.radius;
        }

        return false;
    }

    _getClusterCoords(idx) {
        const z = Math.floor(idx / (this.clusterGrid.gridSizeX * this.clusterGrid.gridSizeY));
        const y = Math.floor((idx % (this.clusterGrid.gridSizeX * this.clusterGrid.gridSizeY)) / this.clusterGrid.gridSizeX);
        const x = idx % this.clusterGrid.gridSizeX;
        return { x, y, z };
    }

    _aabbIntersectsGlobalBounds(aabb) {
        const bounds = this.globalLightBounds;
        return !(
            aabb.max.x < bounds.min.x || aabb.min.x > bounds.max.x ||
            aabb.max.y < bounds.min.y || aabb.min.y > bounds.max.y ||
            aabb.max.z < bounds.min.z || aabb.min.z > bounds.max.z
        );
    }

    getStats() {
        return {
            ...this.stats,
            lightTypes: {
                directional: this.directionalLights.length,
                point: this.pointLights.length,
                spot: this.spotLights.length
            }
        };
    }

    cleanup() {
        if (this.lightDataTexture) this.lightDataTexture.dispose();
        if (this.clusterDataTexture) this.clusterDataTexture.dispose();
        if (this.lightIndicesTexture) this.lightIndicesTexture.dispose();

        this.lights = [];
        this.directionalLights = [];
        this.pointLights = [];
        this.spotLights = [];
        this.staticLightCache.clear();
    }
}