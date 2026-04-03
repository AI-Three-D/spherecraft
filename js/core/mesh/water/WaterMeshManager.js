import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { WaterMaterialFactory } from './WaterMaterialFactory.js';
import { WaterGeometryGenerator } from './waterGeometryGenerator.js';

export class WaterMeshManager {
    constructor(terrainMeshManager, textureManager, uniformManager, chunkSize) {
        this.terrainMeshManager = terrainMeshManager;
        this.materialFactory = new WaterMaterialFactory(textureManager, uniformManager);
        this.waterGeometryGenerator = new WaterGeometryGenerator();
        this.waterMeshes = new Map();

        this.chunkSize = chunkSize;
        
        this.sharedGeometries = [];
        this.geometryInitialized = false;
    }

    initializeSharedGeometries() {
        if (this.geometryInitialized) return;
        
        const sizes = [
            { segments: 32, lod: 0 },
            { segments: 16, lod: 1 },
            { segments: 8, lod: 2 },
            { segments: 4, lod: 3 }
        ];
        
        for (const { segments, lod } of sizes) {
            const geometry = new THREE.PlaneGeometry(
                this.chunkSize, 
                this.chunkSize, 
                segments, 
                segments
            );
            geometry.rotateX(-Math.PI / 2);
            
            geometry.translate(this.chunkSize / 2, 0, this.chunkSize / 2);
            
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            
            this.sharedGeometries[lod] = geometry;
        }
        
        this.geometryInitialized = true;
    }
    createWaterMeshSync(feature, chunkKey, chunkData, globalSeaLevel, environmentState) {
        this.initializeSharedGeometries();
        
        feature.type = 'water';
        feature.chunkX = chunkData.chunkX;
        feature.chunkY = chunkData.chunkY;
        feature.waterLevel = globalSeaLevel;
        feature.chunkSize = chunkData.size;
        
        const lodLevel = chunkData.lodLevel || 0;
        const geometry = this.sharedGeometries[Math.min(lodLevel, this.sharedGeometries.length - 1)];
        
        if (!geometry) {
            
            return null;
        }
        
        const heightTexture = this.terrainMeshManager.getHeightTexture(chunkData.chunkX, chunkData.chunkY);
        if (!heightTexture) {
            
            return null;
        }
        
        const material = this.materialFactory.getMaterialForWater(
            feature,
            heightTexture,
            environmentState
        );
        
        if (!material) {
            
            return null;
        }
        
        const mesh = new THREE.Mesh(geometry, material);
        
        const chunkWorldX = chunkData.chunkX * chunkData.size;
        const chunkWorldZ = chunkData.chunkY * chunkData.size;
        mesh.position.set(chunkWorldX, globalSeaLevel, chunkWorldZ);
        
        mesh.renderOrder = 20;
        mesh.frustumCulled = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.name = `Water_${chunkKey}`;
        mesh.userData = {
            type: 'water',
            chunkKey,
            lodLevel
        };
        
        return mesh;
    }

    async loadWaterFeatures(chunkKey, waterFeatures, chunkData, environmentState) {
        return [];
        if (!waterFeatures || waterFeatures.length === 0) return [];

        const terrainMesh = this.terrainMeshManager.chunkMeshes.get(chunkKey);
        if (!terrainMesh) {
            
            return [];
        }

        const waterMeshes = [];
        const globalSeaLevel = 8.0;

        for (const feature of waterFeatures) {
            try {
                const mesh = this.createWaterMeshSync(
                    feature,
                    chunkKey,
                    chunkData,
                    globalSeaLevel,
                    environmentState
                );

                if (mesh) {
                    this.scene.add(mesh);
                    waterMeshes.push(mesh);
                }
            } catch (err) {
                
            }
        }

        this.waterMeshes.set(chunkKey, waterMeshes);
        return waterMeshes;
    }

    unloadChunk(chunkKey) {
        const meshes = this.waterMeshes.get(chunkKey);
        if (meshes) {
            for (const mesh of meshes) {
                this.scene.remove(mesh);
                
                // Remove material from cache
                if (mesh.userData.chunkKey) {
                    const [cx, cy] = mesh.userData.chunkKey.split(',').map(Number);
                    this.materialFactory.removeMaterial(cx, cy);
                }
                
                // Don't dispose shared geometry!
                // Material is disposed by materialFactory.removeMaterial()
            }
            this.waterMeshes.delete(chunkKey);
        }
    }

    dispose() {
        // Unload all chunks
        for (const chunkKey of this.waterMeshes.keys()) {
            this.unloadChunk(chunkKey);
        }
        
        // Dispose shared geometries
        for (const geometry of this.sharedGeometries) {
            if (geometry) geometry.dispose();
        }
        this.sharedGeometries = [];
        this.geometryInitialized = false;
        
        // Dispose material factory
        this.materialFactory.dispose();
    }

    // Compatibility alias (MasterChunkLoader expects cleanup())
    cleanup() {
        this.dispose();
    }
}
