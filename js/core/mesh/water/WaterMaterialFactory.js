import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { buildWaterVertexShader, buildWaterFragmentShader } from './waterShaderBuilder.js';

/**
 * Factory for creating water materials
 */
export class WaterMaterialFactory {
    /**
     * Creates a new WaterMaterialFactory
     * @param {Object} textureManager - The texture manager
     * @param {Object} uniformManager - The uniform manager for lighting
     */
    constructor(textureManager, uniformManager) {
        this.textureManager = textureManager;
        this.uniformManager = uniformManager;
        this.waterMaterialCache = new Map();
        this.foamTextureCache = null;
    }
    
    /**
     * Get or create a water material for a feature
     * @param {Object} feature - The water feature
     * @param {THREE.Texture} heightTexture - The terrain height texture
     * @param {Object} environmentState - The environment state
     * @returns {THREE.ShaderMaterial} The water material
     */
    getMaterialForWater(feature, heightTexture, environmentState) {
        const key = `water_${feature.chunkX}_${feature.chunkY}`;
        
        if (this.waterMaterialCache.has(key)) {
            return this.waterMaterialCache.get(key);
        }
        
        const material = this.createWaterMaterial(feature, heightTexture, environmentState);
        this.waterMaterialCache.set(key, material);
        return material;
    }
    
    /**
     * Create foam texture for water
     * @returns {THREE.DataTexture} The foam texture
     */
    getFoamTexture() {
        if (this.foamTextureCache) {
            return this.foamTextureCache;
        }
        
        const size = 256;
        const data = new Uint8Array(size * size * 4);
        
        for (let i = 0; i < size * size; i++) {
            const x = (i % size) / size;
            const y = Math.floor(i / size) / size;
            
            // Perlin-like noise pattern for foam
            const noise1 = Math.sin(x * 10.0) * Math.sin(y * 10.0);
            const noise2 = Math.sin(x * 25.0 + 1.57) * Math.sin(y * 25.0 + 1.57);
            const noise3 = Math.sin(x * 50.0 + 3.14) * Math.sin(y * 50.0 + 3.14);
            
            const foam = (noise1 * 0.5 + noise2 * 0.3 + noise3 * 0.2) * 0.5 + 0.5;
            const value = Math.floor(foam * 255);
            
            data[i * 4 + 0] = value;
            data[i * 4 + 1] = value;
            data[i * 4 + 2] = value;
            data[i * 4 + 3] = 255;
        }
        
        this.foamTextureCache = new THREE.DataTexture(data, size, size);
        this.foamTextureCache.wrapS = THREE.RepeatWrapping;
        this.foamTextureCache.wrapT = THREE.RepeatWrapping;
        this.foamTextureCache.needsUpdate = true;
        
        return this.foamTextureCache;
    }
    
    createWaterMaterial(feature, heightTexture, environmentState) {
        const foamTexture = this.getFoamTexture();
        
        if (!heightTexture) {
            
            heightTexture = this.createDefaultTexture();
        }
        
        const waterLevel = feature.waterLevel ?? feature.waterHeight ?? 8.0;
        const heightScale = feature.heightScale ?? 1.0;
        
        const currentTime = environmentState?.time ? environmentState.time * 0.001 : 0.0;
        
        const materialUniforms = {
            time: { value: currentTime },
            waveHeight: { value: 0.35 },
            waveFrequency: { value: 0.8 },
            windDirection: { value: new THREE.Vector2(1.0, 0.0).normalize() },
            windSpeed: { value: 5.0 },
            
            chunkSeed: { value: new THREE.Vector2(feature.chunkX || 0, feature.chunkY || 0) },
            
            waterColorShallow: { value: new THREE.Color(0x2f6f73) },
            waterColorDeep: { value: new THREE.Color(0x0f2f3b) },
            
            waterLevel: { value: waterLevel },
            depthRange: { value: 8.0 },
            shallowAlpha: { value: 0.14 },
            deepAlpha: { value: 0.82 },
            
            foamTexture: { value: foamTexture },
            foamTiling: { value: 0.06 },
            foamIntensity: { value: 0.6 },
            foamDepthStart: { value: 0.0 },
            foamDepthEnd: { value: 2.5 },
            
            terrainHeightMap: { value: heightTexture },
            terrainSize: { value: new THREE.Vector2(
                feature.chunkSize || 64,
                feature.chunkSize || 64
            )},
            terrainOffset: { value: new THREE.Vector2(
                (feature.chunkX || 0) * (feature.chunkSize || 64),
                (feature.chunkY || 0) * (feature.chunkSize || 64)
            )},
            heightScale: { value: heightScale }
        };
        
        // Merge with shared lighting/fog uniforms
        let uniforms;
        if (this.uniformManager) {
            const lightingUniforms = this.uniformManager.getLightingUniforms();
            uniforms = { ...materialUniforms, ...lightingUniforms };
        } else {
            // Fallback uniforms
            uniforms = {
                ...materialUniforms,
                sunLightDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
                sunLightColor: { value: new THREE.Color(0xffffff) },
                sunLightIntensity: { value: 1.0 },
                ambientLightColor: { value: new THREE.Color(0x404040) },
                ambientLightIntensity: { value: 0.2 },
                fogColor: { value: new THREE.Color(0xcccccc) },
                fogDensity: { value: 0.005 },
                weatherIntensity: { value: 0.0 },
                currentWeather: { value: 0.0 }
            };
        }
        
        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: buildWaterVertexShader(),
            fragmentShader: buildWaterFragmentShader(),
            transparent: true,
            fog: true,
            side: THREE.FrontSide,
            depthWrite: false,
            depthTest: true,
        });
        
        // Register material with uniform manager
        if (this.uniformManager) {
            this.uniformManager.registerMaterial(material);
        }
        
        return material;
    }
    
    /**
     * Create a default texture if none provided
     * @returns {THREE.DataTexture} A default texture
     */
    createDefaultTexture() {
        // Create a 1x1 texture with zero height (below water)
        const data = new Float32Array([0.0]);
        const texture = new THREE.DataTexture(data, 1, 1, THREE.RedFormat, THREE.FloatType);
        texture.needsUpdate = true;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        return texture;
    }
    
    /**
     * Remove a material from cache when chunk unloads
     * @param {number} chunkX - Chunk X coordinate
     * @param {number} chunkY - Chunk Y coordinate
     */
    removeMaterial(chunkX, chunkY) {
        const key = `water_${chunkX}_${chunkY}`;
        const material = this.waterMaterialCache.get(key);
        
        if (material) {
            // Unregister from uniform manager
            if (this.uniformManager) {
                this.uniformManager.unregisterMaterial(material);
            }
            
            material.dispose();
            this.waterMaterialCache.delete(key);
        }
    }
    
    /**
     * Clear the material cache
     */
    clearCache() {
        for (const material of this.waterMaterialCache.values()) {
            if (this.uniformManager) {
                this.uniformManager.unregisterMaterial(material);
            }
            material.dispose();
        }
        this.waterMaterialCache.clear();
    }
    
    /**
     * Dispose of all resources
     */
    dispose() {
        this.clearCache();
        
        if (this.foamTextureCache) {
            this.foamTextureCache.dispose();
            this.foamTextureCache = null;
        }
    }
}
