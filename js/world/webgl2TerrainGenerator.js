// js/world/webgl2TerrainGenerator.js - FIXED with atlas support

import { Texture, TextureFormat, TextureFilter, TextureWrap } from '../renderer/resources/texture.js';
import { RenderTarget } from '../renderer/resources/RenderTarget.js';
import { Geometry } from '../renderer/resources/geometry.js';
import { Material } from '../renderer/resources/material.js';
import { terrainVertexShader, terrainFragmentShader } from './shaders/webgl2/terrainCompute.glsl.js';
import { splatVertexShader, splatFragmentShader } from './shaders/webgl2/splatCompute.glsl.js';
import { TILE_TYPES } from '../types.js';

export class WebGL2TerrainGenerator {
    constructor(backend, seed, chunkSize, macroConfig, splatConfig, textureCache, options = {}) {
        this.backend = requireObject(backend, 'backend');
        this.seed = requireInt(seed, 'seed', 0);
        this.chunkSize = requireNumber(chunkSize, 'chunkSize');
        const macro = requireObject(macroConfig, 'macroConfig');
        this.macroConfig = {
            biomeScale: requireNumber(macro.biomeScale, 'macroConfig.biomeScale'),
            regionScale: requireNumber(macro.regionScale, 'macroConfig.regionScale')
        };
        const splat = requireObject(splatConfig, 'splatConfig');
        this.splatDensity = requireInt(splat.splatDensity, 'splatConfig.splatDensity', 1);
        this.splatKernelSize = requireInt(splat.splatKernelSize, 'splatConfig.splatKernelSize', 1);
        this.textureCache = requireObject(textureCache, 'textureCache');
        this.atlasSplatDensity = 1;
        this.lodAtlasConfig = requireObject(options.lodAtlasConfig, 'lodAtlasConfig');
        this.setPlanetConfig(requireObject(options.planetConfig, 'planetConfig'));
 
        this.detailScale = 0.08;
        this.ridgeScale = 0.02;
        this.plateauScale = 0.005;
        this.valleyScale = 0.012;
    

        this.streamedTypes = new Map();
        this.initializeStreamedTypes();
        
        this.terrainMaterial = null;
        this.splatMaterial = null;
        this.quadGeometry = null;
        this.initialized = false;
    }

    setPlanetConfig(config) {
        const planetConfig = requireObject(config, 'planetConfig');
        this.planetConfig = planetConfig;
        this.worldScale = requireNumber(planetConfig.radius, 'planetConfig.radius');
        this.chunksPerFace = requireInt(planetConfig.chunksPerFace, 'planetConfig.chunksPerFace', 1);
        this.heightScale = requireNumber(planetConfig.maxTerrainHeight, 'planetConfig.maxTerrainHeight');
        this.elevationScale = 1.0 / requireNumber(this.chunkSize, 'chunkSize');

        if (this.terrainMaterial?.uniforms?.u_worldScale) {
            this.terrainMaterial.uniforms.u_worldScale.value = this.worldScale;
        }
        if (this.terrainMaterial?.uniforms?.u_chunksPerFace) {
            this.terrainMaterial.uniforms.u_chunksPerFace.value = this.chunksPerFace;
        }
        if (this.terrainMaterial?.uniforms?.u_heightScale) {
            this.terrainMaterial.uniforms.u_heightScale.value = this.heightScale;
        }
        if (this.terrainMaterial?.uniforms?.u_elevationScale) {
            this.terrainMaterial.uniforms.u_elevationScale.value = this.elevationScale;
        }
    }
    
    initialize() {
        if (this.initialized) return;
        
        this.quadGeometry = this.createQuadGeometry();
        this.terrainMaterial = this.createTerrainMaterial();
        this.splatMaterial = this.createSplatMaterial();
        
        this.backend.compileShader(this.terrainMaterial);
        this.backend.compileShader(this.splatMaterial);
        
        this.initialized = true;
        
    }
    
    createQuadGeometry() {
        const geometry = new Geometry();
        
        const positions = new Float32Array([
            -1, -1, 0,
             1, -1, 0,
             1,  1, 0,
            -1,  1, 0
        ]);
        
        const uvs = new Float32Array([
            0, 0,
            1, 0,
            1, 1,
            0, 1
        ]);
        
        const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
        
        geometry.setAttribute('position', positions, 3);
        geometry.setAttribute('uv', uvs, 2);
        geometry.setIndex(indices);
        
        return geometry;
    }
    
    createTerrainMaterial() {
        return new Material({
            vertexShader: terrainVertexShader,
            fragmentShader: terrainFragmentShader,
            uniforms: {
                u_chunkCoord: { value: [0, 0], type: 'ivec2' },
                u_chunkSize: { value: this.chunkSize, type: 'int' },
                u_seed: { value: this.seed, type: 'int' },
                u_elevationScale: { value: this.elevationScale, type: 'float' },
                u_heightScale: { value: this.heightScale, type: 'float' },
                u_biomeScale: { value: this.macroConfig.biomeScale, type: 'float' },
                u_regionScale: { value: this.macroConfig.regionScale, type: 'float' },
                u_detailScale: { value: this.detailScale, type: 'float' },
                u_ridgeScale: { value: this.ridgeScale, type: 'float' },
                u_valleyScale: { value: this.valleyScale, type: 'float' },
                u_plateauScale: { value: this.plateauScale, type: 'float' },
                u_worldScale: { value: this.worldScale, type: 'float' },
                u_outputType: { value: 0, type: 'int' },
                u_face: { value: -1, type: 'int' },
                u_textureSize: { value: this.chunkSize + 1, type: 'int' },
                u_chunksPerFace: { value: this.chunksPerFace, type: 'int' }
            },
            depthTest: false,
            depthWrite: false
        });
    }
    
    createSplatMaterial() {
        return new Material({
            vertexShader: splatVertexShader,
            fragmentShader: splatFragmentShader,
            uniforms: {
                u_heightMap: { value: null, type: 'sampler2D' },
                u_tileMap: { value: null, type: 'sampler2D' },
                u_chunkCoord: { value: [0, 0], type: 'ivec2' },
                u_chunkSize: { value: this.chunkSize, type: 'int' },
                u_splatDensity: { value: this.splatDensity, type: 'int' },
                u_kernelSize: { value: this.splatKernelSize, type: 'int' },
                u_seed: { value: this.seed, type: 'int' }
            },
            depthTest: false,
            depthWrite: false
        });
    }
    
    initializeStreamedTypes() {

    }

    createRenderTarget(width, height, options = {}) {
        const {
            format = TextureFormat.RGBA32F,
            colorCount = 1,
            minFilter = TextureFilter.NEAREST,
            magFilter = TextureFilter.NEAREST,
            depthBuffer = false
        } = options;

        return new RenderTarget(width, height, {
            format,
            colorCount,
            minFilter,
            magFilter,
            depthBuffer
        });
    }

    estimateAtlasMemory(config) {
        const textureSize = config.textureSize;
        const heightNormalSize = textureSize;
        const tileSize = textureSize;
        const splatSize = textureSize * this.atlasSplatDensity;
        const bytesPerPixel = 16;
        const total = (heightNormalSize**2 + heightNormalSize**2 + tileSize**2 + splatSize**2 + splatSize**2) * bytesPerPixel;
        
        return { total, totalMB: (total / 1024 / 1024).toFixed(2) };
    }

    async generateAtlasTextures(atlasKey, config) {
        if (!this.initialized) {
            this.initialize();
        }
        
        const textureSize = config.textureSize;
        const heightNormalSize = textureSize;
        const tileSize = textureSize;
        const splatSize = textureSize * this.atlasSplatDensity;

        const face = atlasKey.face !== null ? atlasKey.face : -1;
        const atlasChunkX = atlasKey.atlasX * config.chunksPerAxis;
        const atlasChunkY = atlasKey.atlasY * config.chunksPerAxis;

        // Create render targets for atlas-sized textures
        const heightRT = this.createRenderTarget(heightNormalSize, heightNormalSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST
        });

        const normalRT = this.createRenderTarget(heightNormalSize, heightNormalSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        const tileRT = this.createRenderTarget(tileSize, tileSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST
        });

        const macroRT = this.createRenderTarget(splatSize, splatSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        const splatDataRT = this.createRenderTarget(splatSize, splatSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        // Set uniforms for atlas generation
        this.terrainMaterial.uniforms.u_chunkCoord.value = [atlasChunkX, atlasChunkY];
        this.terrainMaterial.uniforms.u_face.value = face;
        this.terrainMaterial.uniforms.u_textureSize.value = heightNormalSize;

        // Generate height
        this.terrainMaterial.uniforms.u_outputType.value = 0;
        this.renderToTarget(heightRT, this.terrainMaterial);

        // Generate normal
        this.terrainMaterial.uniforms.u_outputType.value = 1;
        this.renderToTarget(normalRT, this.terrainMaterial);

        // Generate tile - use tile size
        this.terrainMaterial.uniforms.u_textureSize.value = tileSize;
        this.terrainMaterial.uniforms.u_outputType.value = 2;
        this.renderToTarget(tileRT, this.terrainMaterial);

        // Generate macro - use splat size
        this.terrainMaterial.uniforms.u_textureSize.value = splatSize;
        this.terrainMaterial.uniforms.u_outputType.value = 3;
        this.renderToTarget(macroRT, this.terrainMaterial);

        // Generate splat data
        if (!heightRT.texture._gpuTexture) {
            this.backend.createTexture(heightRT.texture);
        }
        if (!tileRT.texture._gpuTexture) {
            this.backend.createTexture(tileRT.texture);
        }
        
        this.splatMaterial.uniforms.u_heightMap.value = heightRT.texture;
        this.splatMaterial.uniforms.u_tileMap.value = tileRT.texture;
        this.splatMaterial.uniforms.u_chunkCoord.value = [atlasChunkX, atlasChunkY];
        this.renderToTarget(splatDataRT, this.splatMaterial);

        this.backend.setRenderTarget(null);

        const textures = {
            height: heightRT.texture,
            normal: normalRT.texture,
            tile: tileRT.texture,
            macro: macroRT.texture,
            splatData: splatDataRT.texture
        };

        // Set texture filtering
        textures.normal.minFilter = TextureFilter.LINEAR;
        textures.normal.magFilter = TextureFilter.LINEAR;
        textures.splatData.minFilter = TextureFilter.LINEAR;
        textures.splatData.magFilter = TextureFilter.LINEAR;

        for (const tex of Object.values(textures)) {
            tex.wrapS = TextureWrap.CLAMP;
            tex.wrapT = TextureWrap.CLAMP;
        }

        // Cache textures
        const bytesPerPixel = 16;
        this.textureCache.set(atlasKey, null, 'height', textures.height, heightNormalSize * heightNormalSize * bytesPerPixel);
        this.textureCache.set(atlasKey, null, 'normal', textures.normal, heightNormalSize * heightNormalSize * bytesPerPixel);
        this.textureCache.set(atlasKey, null, 'tile', textures.tile, tileSize * tileSize * bytesPerPixel);
        this.textureCache.set(atlasKey, null, 'macro', textures.macro, splatSize * splatSize * bytesPerPixel);
        this.textureCache.set(atlasKey, null, 'splatData', textures.splatData, splatSize * splatSize * bytesPerPixel);

        return {
            atlasKey: atlasKey,
            textures: textures,
            memoryUsed: 0
        };
    }

    async extractChunkDataFromAtlas(atlasKey, chunkX, chunkY, config, face = null) {
        const heightAtlasData = this.textureCache.getAtlasForChunk(chunkX, chunkY, 'height', config, face);
        const tileAtlasData = this.textureCache.getAtlasForChunk(chunkX, chunkY, 'tile', config, face);
        
        if (!heightAtlasData || !tileAtlasData) {
            
            return null;
        }
    
        const localPos = config.getLocalChunkPosition(chunkX, chunkY);
        const chunkSize = config.chunkSize;
        
        // Get the actual texture objects
        const heightTex = heightAtlasData.texture;
        const tileTex = tileAtlasData.texture;
    
        if (!heightTex || !tileTex) {
            
            return null;
        }
        
        // Ensure textures have GPU resources
        if (!heightTex._gpuTexture) {
            this.backend.createTexture(heightTex);
        }
        if (!tileTex._gpuTexture) {
            this.backend.createTexture(tileTex);
        }
    
        try {
            const heightData = await this.readTextureSubregion(
                heightTex, 
                localPos.localX * chunkSize, 
                localPos.localY * chunkSize,
                chunkSize + 1, 
                chunkSize + 1, 
                config.textureSize
            );
            
            if (!heightData) {
                
                return null;
            }
            
            const tileData = await this.readTextureSubregion(
                tileTex, 
                localPos.localX * chunkSize, 
                localPos.localY * chunkSize,
                chunkSize, 
                chunkSize, 
                config.textureSize
            );
            
            if (!tileData) {
                
                return null;
            }
            
            return { heightData, tileData };
        } catch(e) { 
            return null; 
        }
    }
    async readTextureSubregion(texture, offsetX, offsetY, width, height, textureWidth) {
        const gl = this.backend.gl;
        
        // Create a framebuffer to read from the texture
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        
        // Ensure texture is uploaded and get the actual WebGL texture
        if (!texture._gpuTexture) {
            this.backend.createTexture(texture);
        }
        
        // FIX: Access the actual WebGL texture object (glTexture), not the wrapper
        const glTexture = texture._gpuTexture.glTexture;
        
        if (!glTexture) {
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            return null;
        }
        
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTexture, 0);
        
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            return null;
        }
        
        // Read the subregion
        const data = new Float32Array(width * height * 4);
        gl.readPixels(offsetX, offsetY, width, height, gl.RGBA, gl.FLOAT, data);
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        
        return data;
    }
    // Legacy per-chunk generation (backward compatibility)
    async generateTerrain(chunkData, chunkX, chunkY, face = null) {
        if (!this.initialized) {
            this.initialize();
        }
        
        let heightTexture = this.textureCache.get(chunkX, chunkY, 'height');
        let normalTexture = this.textureCache.get(chunkX, chunkY, 'normal');
        let tileTexture = this.textureCache.get(chunkX, chunkY, 'tile');
        let splatWeightTexture = this.textureCache.get(chunkX, chunkY, 'splatWeight');
        let splatTypeTexture = this.textureCache.get(chunkX, chunkY, 'splatType');
        let macroTexture = this.textureCache.get(chunkX, chunkY, 'macro');

        const hasAllTextures = heightTexture && normalTexture && tileTexture &&
                               splatWeightTexture && splatTypeTexture && macroTexture;

        let heightData, tileData;

        if (!hasAllTextures) {
            const result = await this.generateAllTexturesForChunk(chunkX, chunkY, face);

            const size = this.chunkSize + 1;
            const tileSize = this.chunkSize;
            const splatSize = this.chunkSize * this.splatDensity;

            const heightSizeBytes = size * size * 4 * 4;
            const normalSizeBytes = size * size * 4 * 4;
            const tileSizeBytes = tileSize * tileSize * 4 * 4;
            const macroSizeBytes = splatSize * splatSize * 4 * 4;
            const splatWeightSizeBytes = splatSize * splatSize * 4 * 4;
            const splatTypeSizeBytes = splatSize * splatSize * 4 * 4;

            this.textureCache.set(chunkX, chunkY, 'height', result.textures.height, heightSizeBytes);
            this.textureCache.set(chunkX, chunkY, 'normal', result.textures.normal, normalSizeBytes);
            this.textureCache.set(chunkX, chunkY, 'tile', result.textures.tile, tileSizeBytes);
            this.textureCache.set(chunkX, chunkY, 'splatWeight', result.textures.splatWeight, splatWeightSizeBytes);
            this.textureCache.set(chunkX, chunkY, 'splatType', result.textures.splatType, splatTypeSizeBytes);
            this.textureCache.set(chunkX, chunkY, 'macro', result.textures.macro, macroSizeBytes);

            heightTexture = result.textures.height;
            normalTexture = result.textures.normal;
            tileTexture = result.textures.tile;
            splatWeight = result.textures.splatWeight;
            splatTypeTexture = result.textures.splatType;
            macroTexture = result.textures.macro;

            heightData = result.heightData;
            tileData = result.tileData;
        } else {
            const size = this.chunkSize + 1;
            const tileSize = this.chunkSize;

            heightData = await this.readTextureSubregion(heightTexture, 0, 0, size, size, size);
            tileData = await this.readTextureSubregion(tileTexture, 0, 0, tileSize, tileSize, tileSize);
        }

        this.populateChunkData(chunkData, chunkX, chunkY, heightData, tileData);

        chunkData.textureRefs = {
            chunkX,
            chunkY,
            heightTexture,
            normalTexture,
            tileTexture,
            splatWeightTexture,
            splatTypeTexture,
            macroTexture
        };
    }

    populateChunkData(chunkData, chunkX, chunkY, heightData, tileData) {
        const tileSize = this.chunkSize;
        const size = this.chunkSize + 1;

        const tilesCount = tileSize * tileSize;
        chunkData.tiles = new Uint32Array(tilesCount);
        for (let i = 0; i < tilesCount; i++) {
            chunkData.tiles[i] = Math.round(tileData[i * 4] * 255);
        }

        const heightsCount = size * size;
        chunkData.heights = new Float32Array(heightsCount);
        for (let i = 0; i < heightsCount; i++) {
            chunkData.heights[i] = heightData[i * 4];
        }

        chunkData.splatDensity = this.splatDensity;
        chunkData.offsetX = chunkX * this.chunkSize;
        chunkData.offsetZ = chunkY * this.chunkSize;

    }

    async generateAllTexturesForChunk(chunkX, chunkY, face = null) {
        const size = this.chunkSize + 1;
        const tileSize = this.chunkSize;
        const splatSize = this.chunkSize * this.splatDensity;
        const faceValue = face !== null ? face : -1;

        const heightRT = this.createRenderTarget(size, size, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST
        });

        const normalRT = this.createRenderTarget(size, size, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        const tileRT = this.createRenderTarget(tileSize, tileSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST
        });

        const macroRT = this.createRenderTarget(splatSize, splatSize, {
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        const splatRT = this.createRenderTarget(splatSize, splatSize, {
            format: TextureFormat.RGBA32F,
            colorCount: 2,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR
        });

        this.terrainMaterial.uniforms.u_chunkCoord.value = [chunkX, chunkY];
        this.terrainMaterial.uniforms.u_face.value = faceValue;

        this.terrainMaterial.uniforms.u_textureSize.value = size;
        this.terrainMaterial.uniforms.u_outputType.value = 0;
        this.renderToTarget(heightRT, this.terrainMaterial);

        const heightData = this.backend.readPixels(heightRT, 0, 0, size, size, 'rgba');

        this.terrainMaterial.uniforms.u_outputType.value = 1;
        this.renderToTarget(normalRT, this.terrainMaterial);

        this.terrainMaterial.uniforms.u_textureSize.value = tileSize;
        this.terrainMaterial.uniforms.u_outputType.value = 2;
        this.renderToTarget(tileRT, this.terrainMaterial);

        const tileData = this.backend.readPixels(tileRT, 0, 0, tileSize, tileSize, 'rgba');

        this.terrainMaterial.uniforms.u_textureSize.value = splatSize;
        this.terrainMaterial.uniforms.u_outputType.value = 3;
        this.renderToTarget(macroRT, this.terrainMaterial);

        if (!heightRT.texture._gpuTexture) {
            this.backend.createTexture(heightRT.texture);
        }
        if (!tileRT.texture._gpuTexture) {
            this.backend.createTexture(tileRT.texture);
        }
        
        this.splatMaterial.uniforms.u_heightMap.value = heightRT.texture;
        this.splatMaterial.uniforms.u_tileMap.value = tileRT.texture;
        this.splatMaterial.uniforms.u_chunkCoord.value = [chunkX, chunkY];
        this.renderToTarget(splatRT, this.splatMaterial);

        this.backend.setRenderTarget(null);

        const textures = {
            height: heightRT.texture,
            normal: normalRT.texture,
            tile: tileRT.texture,
            macro: macroRT.texture,
            splatWeight: splatRT.textures[0],
            splatType: splatRT.textures[1]
        };

        textures.normal.minFilter = TextureFilter.LINEAR;
        textures.normal.magFilter = TextureFilter.LINEAR;
        textures.splatWeight.minFilter = TextureFilter.LINEAR;
        textures.splatWeight.magFilter = TextureFilter.LINEAR;

        for (const tex of Object.values(textures)) {
            tex.wrapS = TextureWrap.CLAMP;
            tex.wrapT = TextureWrap.CLAMP;
        }

        return { textures, heightData, tileData };
    }
    
    renderToTarget(renderTarget, material) {
        this.backend.setRenderTarget(renderTarget);
        this.backend.clear(true, false, false);
        this.backend.draw(this.quadGeometry, material);
    }

    generateFeatureDistributionForChunk(chunkX, chunkZ, tiles) {
        const featureMix = {};
        const totalTiles = tiles.length || 1;

   

        return { featureMix };
    }
    
    dispose() {
        if (this.quadGeometry) {
            this.quadGeometry.dispose();
        }
        if (this.terrainMaterial) {
            this.backend.deleteShader(this.terrainMaterial);
            this.terrainMaterial.dispose();
        }
        if (this.splatMaterial) {
            this.backend.deleteShader(this.splatMaterial);
            this.splatMaterial.dispose();
        }
    }
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`WebGL2TerrainGenerator missing required object: ${name}`);
    }
    return value;
}

function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGL2TerrainGenerator missing required number: ${name}`);
    }
    return value;
}

function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGL2TerrainGenerator missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`WebGL2TerrainGenerator ${name} must be >= ${min}`);
    }
    return n;
}
