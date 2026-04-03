import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

import { Texture, TextureFormat, TextureFilter, TextureWrap } from '../renderer/resources/texture.js';
import { TileTransitionTableBuilder } from '../world/tileTransitionTableBuilder.js'
import { getAllProceduralVariantsForLevel } from './webgpu/textureGenerator.js';

function stableStringify(obj) {
    if (Array.isArray(obj)) {
        return '[' + obj.map(stableStringify).join(',') + ']';
    } else if (obj && typeof obj === 'object') {
        return '{' + Object.keys(obj).sort().map(
            key => `"${key}":${stableStringify(obj[key])}`
        ).join(',') + '}';
    } else {
        return JSON.stringify(obj);
    }
}

function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash >>> 0;
}

function getLayerConfigHash(layers) {
    const stable = stableStringify(layers) + (layers?.[0]?.uniqueId || '');
    return djb2Hash(stable).toString(36);
}

export class TextureAtlasManager {
    constructor(enableDebug = false, gpuDevice = null, proceduralTextureGenerator = null, tileTheme = null) {
        if (!tileTheme) {
            throw new Error('TextureAtlasManager requires tileTheme (TILE_CONFIG, TEXTURE_LEVELS, ATLAS_CONFIG, TEXTURE_CONFIG, TextureConfigHelper, SEASONS, TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES)');
        }
        this.TILE_CONFIG = tileTheme.TILE_CONFIG;
        this.TEXTURE_LEVELS = tileTheme.TEXTURE_LEVELS;
        this.ATLAS_CONFIG = tileTheme.ATLAS_CONFIG;
        this.TEXTURE_CONFIG = tileTheme.TEXTURE_CONFIG;
        this.TextureConfigHelper = tileTheme.TextureConfigHelper;
        this.SEASONS = tileTheme.SEASONS;
        this.TILE_LAYER_HEIGHTS = tileTheme.TILE_LAYER_HEIGHTS;
        this.TILE_TRANSITION_RULES = tileTheme.TILE_TRANSITION_RULES;
        this.gpuDevice = gpuDevice;
        this.proceduralTextureGenerator = proceduralTextureGenerator;
        this._backend = null;
        this._busy = false;
        this.atlases = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.currentSeason = this.SEASONS.SUMMER;
        this.PADDING = 32;
    
        this._uvCache = new Map();
        this._initialized = false;
    
        Object.values(this.TEXTURE_LEVELS).forEach(level => {
            this.atlases.set(level, {
                texture: null,
                canvas: null,
                context: null,
                layout: null,
                textureMap: new Map(),
                seasonalTextureMap: new Map(),
            });
        });
    
        this.loaded = false;
        window.SEASONS = this.SEASONS;
        window.ATLAS = this;
        window.TEXTURE_LEVELS = this.TEXTURE_LEVELS;
    
        this.lookupTables = {
            tileTypeLookup: null,
            macroTileTypeLookup: null,
            numVariantsTex: null,
            blendModeTable: null,
            tileLayerHeights: null,
        };
    
        this._lookupTablesReady = false;
    }

    set backend(value) {
        this._backend = value;
        
        // If lookup tables exist but weren't uploaded, upload them now
        if (this._lookupTablesReady && this.lookupTables.tileTypeLookup && !this.lookupTables.tileTypeLookup._gpuTexture) {
            
            this._uploadLookupTablesToGPU();
        }
    }
    get backend() {
        return this._backend;
    }
    

    async _loadTextureGeneratorModule() {
        if (this._textureGeneratorModule) {
            return this._textureGeneratorModule;
        }
        if (this.apiName === 'webgpu') {
            this._textureGeneratorModule = await import('./webgpu/textureGenerator.js');
        } else {
            this._textureGeneratorModule = await import('./webgl2/textureGenerator.js');
        }

        return this._textureGeneratorModule;
    }

    async _createTextureGenerator(width, height) {
        const module = await this._loadTextureGeneratorModule();
        
        if (this.apiName === 'webgpu') {
            if (!this.gpuDevice) {
                throw new Error('WebGPU device required for WebGPU texture generation');
            }
            const generator = new module.ProceduralTextureGenerator(this.gpuDevice, width, height);
            await generator.initialize();
            return generator;
        } else {
            return new module.ProceduralTextureGenerator(width, height);
        }
    }

    async _getAllProceduralVariants(level) {
        const module = await this._loadTextureGeneratorModule();
        return module.getAllProceduralVariantsForLevel(level, this.TEXTURE_CONFIG, this.SEASONS);
    }

    initializeLookupTables() {
        if (this._lookupTablesReady) {
            
            return;
        }

        

        const maxTileTypes = 256;
        const maxMicroVariants = 8;
        const maxMacroVariants = 8;

        const seasons = [
            this.SEASONS.SPRING,
            this.SEASONS.SUMMER,
            this.SEASONS.AUTUMN,
            this.SEASONS.WINTER
        ];

        const transitionBuilder = new TileTransitionTableBuilder(this.gpuDevice);
        const { blendModeTable, tileLayerHeights: layerHeightsTex } =
            transitionBuilder.build({
                tileTransitionRules: this.TILE_TRANSITION_RULES,
                tileLayerHeights: this.TILE_LAYER_HEIGHTS,
            });
        this.lookupTables.blendModeTable = blendModeTable;
        this.lookupTables.tileLayerHeights = layerHeightsTex;

        this.lookupTables.tileTypeLookup = this._buildTileTypeLookup(
            maxTileTypes,
            maxMicroVariants,
            this.TEXTURE_LEVELS.MICRO,
            seasons
        );

        this.lookupTables.macroTileTypeLookup = this._buildTileTypeLookup(
            maxTileTypes,
            maxMacroVariants,
            this.TEXTURE_LEVELS.MACRO,
            seasons
        );

        this.lookupTables.numVariantsTex = this._buildNumVariantsTexture(
            maxTileTypes,
            seasons
        );
        
        this._lookupTablesReady = true;
        
        // Only upload if backend is available
        if (this._backend) {
            this._uploadLookupTablesToGPU();
        } else {
            
        }
    }
    _uploadLookupTablesToGPU() {
        if (!this._backend) {
            
            return;
        }
        
    
        
        if (this.lookupTables.blendModeTable && !this.lookupTables.blendModeTable._gpuTexture) {
            this._backend.createTexture(this.lookupTables.blendModeTable);
        }
        
        if (this.lookupTables.layerHeightsTex && !this.lookupTables.layerHeightsTex._gpuTexture) {
            this._backend.createTexture(this.lookupTables.layerHeightsTex);
        }
        
        // Use backend's createTexture instead of direct GPU calls
        if (this.lookupTables.tileTypeLookup && !this.lookupTables.tileTypeLookup._gpuTexture) {
            this._backend.createTexture(this.lookupTables.tileTypeLookup);
        }
        
        if (this.lookupTables.macroTileTypeLookup && !this.lookupTables.macroTileTypeLookup._gpuTexture) {
            this._backend.createTexture(this.lookupTables.macroTileTypeLookup);
        }
        
        if (this.lookupTables.numVariantsTex && !this.lookupTables.numVariantsTex._gpuTexture) {
            this._backend.createTexture(this.lookupTables.numVariantsTex);
        }
        
        
    }
    

    _buildTileTypeLookup(maxTileTypes, maxVariants, level, seasons) {
        const numSeasons = seasons.length;
        const width = numSeasons * maxVariants;
        const height = maxTileTypes;
        const lookupData = new Float32Array(width * height * 4);
        const atlas = this.atlases.get(level);
        const isArrayAtlas = !!atlas?.texture?._isArray;

        let successCount = 0;
        let failCount = 0;
        
        for (let tileId = 0; tileId < maxTileTypes; tileId++) {
            for (let s = 0; s < numSeasons; s++) {
                const season = seasons[s];
                const variantCount = this.getNumVariants(tileId, season, level);

                for (let v = 0; v < maxVariants; v++) {
                    const safeVar = Math.min(v, variantCount - 1);
                    const x = s * maxVariants + v;
                    const idx = (tileId * width + x) * 4;

                    if (isArrayAtlas) {
                        const key = `${tileId}:${season}:${safeVar}`;
                        const layer = atlas?.seasonalTextureMap?.get(key);
                        if (layer !== undefined) {
                            lookupData[idx + 0] = layer;
                            lookupData[idx + 1] = 0.0;
                            lookupData[idx + 2] = 0.0;
                            lookupData[idx + 3] = 0.0;
                            successCount++;
                        } else {
                            lookupData[idx + 0] = 0.0;
                            lookupData[idx + 1] = 0.0;
                            lookupData[idx + 2] = 0.0;
                            lookupData[idx + 3] = 0.0;
                            failCount++;
                        }
                    } else {
                        const uvs = this.getSeasonalTextureUV(tileId, season, safeVar, level);
                        if (uvs) {
                            lookupData[idx + 0] = uvs.u1;
                            lookupData[idx + 1] = uvs.v1;
                            lookupData[idx + 2] = uvs.u2;
                            lookupData[idx + 3] = uvs.v2;
                            successCount++;
                        } else {
                            lookupData[idx + 0] = 0.0;
                            lookupData[idx + 1] = 0.0;
                            lookupData[idx + 2] = 1.0;
                            lookupData[idx + 3] = 1.0;
                            failCount++;
                        }
                    }
                }
            }
        }

        
        
        const texture = new Texture({
            width: width,
            height: height,
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            wrapS: TextureWrap.CLAMP,
            wrapT: TextureWrap.CLAMP,
            generateMipmaps: false,
            data: lookupData
        });

        return texture;
    }

    _buildNumVariantsTexture(maxTileTypes, seasons) {
        const numSeasons = seasons.length;
        const numVariants = new Uint8Array(maxTileTypes * numSeasons);

        for (let s = 0; s < numSeasons; s++) {
            for (let t = 0; t < maxTileTypes; t++) {
                const varCount = this.getNumVariants(t, seasons[s], this.TEXTURE_LEVELS.MICRO) || 1;
                numVariants[s * maxTileTypes + t] = varCount;
            }
        }

        const texture = new Texture({
            width: maxTileTypes,
            height: numSeasons,
            format: TextureFormat.R8,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            wrapS: TextureWrap.CLAMP,
            wrapT: TextureWrap.CLAMP,
            generateMipmaps: false,
            data: numVariants
        });

        return texture;
    }

    getLookupTables() {
        if (!this.loaded && this.atlases.get('micro').seasonalTextureMap.size === 0) {
            
            return this.lookupTables;
        }

        if (!this._lookupTablesReady) {
            
            this.initializeLookupTables();
        }
        return this.lookupTables;
    }

    calculateLayout(numTextures, atlasSize, textureSize) {
        const paddedTextureSize = textureSize + (this.PADDING * 2);
        const maxTilesPerSide = Math.floor(atlasSize / paddedTextureSize);
        const maxTotalTiles = maxTilesPerSide * maxTilesPerSide;

        if (numTextures > maxTotalTiles) {
        }

        const tilesPerRow = maxTilesPerSide;
        const rows = Math.ceil(numTextures / tilesPerRow);

        return {
            tilesPerRow: tilesPerRow,
            rows: Math.min(rows, maxTilesPerSide),
            totalTextures: Math.min(numTextures, maxTotalTiles),
            maxCapacity: maxTotalTiles,
            paddedTextureSize: paddedTextureSize,
            atlasSize: atlasSize,
            textureSize: textureSize
        };
    }

    extendPadding(ctx, x, y, textureSize, padding) {
        const topEdge = ctx.getImageData(x, y, textureSize, 1);
        for (let i = 1; i <= padding; i++) {
            ctx.putImageData(topEdge, x, y - i);
        }

        const bottomEdge = ctx.getImageData(x, y + textureSize - 1, textureSize, 1);
        for (let i = 1; i <= padding; i++) {
            ctx.putImageData(bottomEdge, x, y + textureSize - 1 + i);
        }

        const leftEdge = ctx.getImageData(x, y, 1, textureSize);
        for (let i = 1; i <= padding; i++) {
            ctx.putImageData(leftEdge, x - i, y);
        }

        const rightEdge = ctx.getImageData(x + textureSize - 1, y, 1, textureSize);
        for (let i = 1; i <= padding; i++) {
            ctx.putImageData(rightEdge, x + textureSize - 1 + i, y);
        }

        const tlCorner = ctx.getImageData(x, y, 1, 1);
        ctx.fillStyle = `rgba(${tlCorner.data[0]},${tlCorner.data[1]},${tlCorner.data[2]},${tlCorner.data[3] / 255})`;
        ctx.fillRect(x - padding, y - padding, padding, padding);

        const trCorner = ctx.getImageData(x + textureSize - 1, y, 1, 1);
        ctx.fillStyle = `rgba(${trCorner.data[0]},${trCorner.data[1]},${trCorner.data[2]},${trCorner.data[3] / 255})`;
        ctx.fillRect(x + textureSize, y - padding, padding, padding);

        const blCorner = ctx.getImageData(x, y + textureSize - 1, 1, 1);
        ctx.fillStyle = `rgba(${blCorner.data[0]},${blCorner.data[1]},${blCorner.data[2]},${blCorner.data[3] / 255})`;
        ctx.fillRect(x - padding, y + textureSize, padding, padding);

        const brCorner = ctx.getImageData(x + textureSize - 1, y + textureSize - 1, 1, 1);
        ctx.fillStyle = `rgba(${brCorner.data[0]},${brCorner.data[1]},${brCorner.data[2]},${brCorner.data[3] / 255})`;
        ctx.fillRect(x + textureSize, y + textureSize, padding, padding);
    }

    addTextureToAtlas(level, image, index, texturePath = null) {
        const atlas = this.atlases.get(level);
        const layout = atlas.layout;
        const padding = layout.padding !== undefined ? layout.padding : this.PADDING;

        const row = Math.floor(index / layout.tilesPerRow);
        const col = index % layout.tilesPerRow;

        const x = col * layout.paddedTextureSize + padding;
        const y = row * layout.paddedTextureSize + padding;

        atlas.context.drawImage(
            image,
            0, 0, image.width, image.height,
            x, y, layout.textureSize, layout.textureSize
        );

        this.extendPadding(atlas.context, x, y, layout.textureSize, padding);
    }

    createPlaceholderTexture(level, index, texturePath) {
        const atlas = this.atlases.get(level);
        const layout = atlas.layout;

        const row = Math.floor(index / layout.tilesPerRow);
        const col = index % layout.tilesPerRow;

        const x = col * layout.paddedTextureSize + this.PADDING;
        const y = row * layout.paddedTextureSize + this.PADDING;

        atlas.context.fillStyle = `hsl(${(index * 137.5) % 360}, 50%, 50%)`;
        atlas.context.fillRect(x, y, layout.textureSize, layout.textureSize);

        atlas.context.fillStyle = 'rgba(255, 255, 255, 0.3)';
        atlas.context.fillRect(x, y, layout.textureSize / 2, layout.textureSize / 2);
        atlas.context.fillRect(x + layout.textureSize / 2, y + layout.textureSize / 2,
            layout.textureSize / 2, layout.textureSize / 2);

        
    }

    calculateUVFromIndex(level, index) {
        const cacheKey = `${level}_${index}`;
        if (this._uvCache.has(cacheKey)) {
            return this._uvCache.get(cacheKey);
        }

        const atlas = this.atlases.get(level);
        if (!atlas || !atlas.layout) return null;
        const layout = atlas.layout;

        const row = Math.floor(index / layout.tilesPerRow);
        const col = index % layout.tilesPerRow;

        const textureSize = layout.textureSize;
        const paddedTextureSize = layout.paddedTextureSize;
        const atlasSize = layout.atlasSize;
        const padding = layout.padding !== undefined ? layout.padding : this.PADDING;

        const x1 = col * paddedTextureSize + padding;
        const y1 = row * paddedTextureSize + padding;

        const x2 = x1 + textureSize;
        const y2 = y1 + textureSize;
        const inset = 1.5;

        const u1 = (x1 + inset) / atlasSize;
        const v1 = (y1 + inset) / atlasSize;

        const u2 = (x2 - inset) / atlasSize;
        const v2 = (y2 - inset) / atlasSize;

        const result = { u1, v1, u2, v2 };
        this._uvCache.set(cacheKey, result);

        return result;
    }

    updateSeasonData(gameTime) {
        const [daysUntilNext, newSeason] = gameTime.getRunningSeasonInfo();

        if (this.currentSeason !== newSeason) {
            this.currentSeason = newSeason;
            
        }
    }

    async initializeAtlases(procedural = false) {
        // Sequential — the shared generator is stateful and cannot be used
        // concurrently across atlas levels.
        for (const level of Object.values(this.TEXTURE_LEVELS)) {
            if (procedural) {
                await this.createProceduralAtlas(level);
            } else {
                await this.createAtlas(level);
            }
        }
    
        this._lookupTablesReady = false;
    
        if (this.lookupTables.tileTypeLookup?._gpuTexture) {
            this.lookupTables.tileTypeLookup = null;
        }
        if (this.lookupTables.macroTileTypeLookup?._gpuTexture) {
            this.lookupTables.macroTileTypeLookup = null;
        }
        if (this.lookupTables.numVariantsTex?._gpuTexture) {
            this.lookupTables.numVariantsTex = null;
        }
    
        this.initializeLookupTables();
        this.loaded = true;
    }
    async createProceduralAtlas(level) {
        const config = this.ATLAS_CONFIG[level];
        const atlas = this.atlases.get(level);
        const hasTransparent = (level === this.TEXTURE_LEVELS.MICRO);
    
        const variants = getAllProceduralVariantsForLevel(level, this.TEXTURE_CONFIG, this.SEASONS);
        if (!variants || variants.length === 0) return null;
    
        const gen = this.proceduralTextureGenerator;
        if (!gen) {
            throw new Error('[TextureAtlasManager] proceduralTextureGenerator not injected');
        }
    
        // Deduplicate by layer-config hash
        const hashToUniqueIndex = new Map();
        const uniqueVariants = [];
        const variantIndexToUniqueIndex = new Map();
        const startIndex = hasTransparent ? 1 : 0;
    
        for (let i = 0; i < variants.length; i++) {
            const variant = variants[i];
            const hash = getLayerConfigHash(variant.layers);
            let uniqueIdx = hashToUniqueIndex.get(hash);
            if (uniqueIdx === undefined) {
                uniqueIdx = uniqueVariants.length + startIndex;
                hashToUniqueIndex.set(hash, uniqueIdx);
                uniqueVariants.push({
                    hash,
                    layers: variant.layers,
                    firstTileType: variant.tileType,
                    firstSeason: variant.season,
                    firstVariant: variant.variant
                });
            }
            variantIndexToUniqueIndex.set(i, uniqueIdx);
        }
    
        const textureSize = config.proceduralTextureSize || config.textureSize;
        const totalLayers = uniqueVariants.length + startIndex;
        const bytesPerLayer = textureSize * textureSize * 4; // RGBA8
        const allLayerData = new Uint8Array(totalLayers * bytesPerLayer);
    
        // Layer 0: solid grey placeholder (transparent tile stand-in)
        if (hasTransparent) {
            for (let i = 0; i < textureSize * textureSize; i++) {
                allLayerData[i * 4 + 0] = 128;
                allLayerData[i * 4 + 1] = 128;
                allLayerData[i * 4 + 2] = 128;
                allLayerData[i * 4 + 3] = 255;
            }
        }
    
        // Size the shared generator once for this atlas level.
        gen.setSize(textureSize, textureSize);
        if (config.seamless && typeof gen.configureSeamless === 'function') {
            gen.configureSeamless(config.seamless);
        }
    
        // Generate each unique variant into its layer slot.
        for (let i = 0; i < uniqueVariants.length; i++) {
            const atlasIndex = i + startIndex;
            const layerOffset = atlasIndex * bytesPerLayer;
            try {
                const layers = uniqueVariants[i].layers;
                if (!Array.isArray(layers)) {
                    this._fillProceduralFallback(allLayerData, layerOffset, textureSize, atlasIndex);
                    continue;
                }
    
                gen.clearLayers();
                layers.forEach(layerConfig => gen.addLayer(layerConfig));
                const textureCanvas = await gen.generate();
    
                // Copy canvas pixels into the layer buffer.
                const copyCanvas = document.createElement('canvas');
                copyCanvas.width = textureSize;
                copyCanvas.height = textureSize;
                const copyCtx = copyCanvas.getContext('2d');
                copyCtx.drawImage(textureCanvas, 0, 0);
                const imageData = copyCtx.getImageData(0, 0, textureSize, textureSize);
                allLayerData.set(new Uint8Array(imageData.data.buffer), layerOffset);
            } catch (error) {
                this._fillProceduralFallback(allLayerData, layerOffset, textureSize, atlasIndex);
            }
        }
    
        // Seasonal map: key → layer index
        for (let i = 0; i < variants.length; i++) {
            const { tileType, season, variant } = variants[i];
            const key = `${tileType}:${season}:${variant}`;
            atlas.seasonalTextureMap.set(key, variantIndexToUniqueIndex.get(i));
        }
    
        // Create array texture — each layer is independent, mipmaps per layer.
        atlas.texture = new Texture({
            width: textureSize,
            height: textureSize,
            depth: totalLayers,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR_MIPMAP_LINEAR,
            magFilter: TextureFilter.LINEAR,
            wrapS: TextureWrap.REPEAT,
            wrapT: TextureWrap.REPEAT,
            generateMipmaps: true,
            data: allLayerData,
            _isArray: true
        });
    
        if (this._backend) {
            this._backend.createTexture(atlas.texture);
        }
    
        return atlas.texture;
    }
    
    _fillProceduralFallback(buffer, offset, size, index) {
        const r = Math.floor((index * 137.5) % 256);
        for (let p = 0; p < size * size; p++) {
            buffer[offset + p * 4 + 0] = r;
            buffer[offset + p * 4 + 1] = 64;
            buffer[offset + p * 4 + 2] = 64;
            buffer[offset + p * 4 + 3] = 255;
        }
    }
    
    async createAtlas(level) {
        const config = this.ATLAS_CONFIG[level];
        const atlas = this.atlases.get(level);
        const allTexturePaths = this.TextureConfigHelper.getAllTexturesForLevel(level);
    
        const hasTransparent = (level === this.TEXTURE_LEVELS.MICRO);
        const startIndex = hasTransparent ? 1 : 0;
        const totalLayers = allTexturePaths.length + startIndex;
        const textureSize = config.textureSize;
        const bytesPerLayer = textureSize * textureSize * 4;
    
        const allLayerData = new Uint8Array(totalLayers * bytesPerLayer);
    
        // Layer 0: grey placeholder
        if (hasTransparent) {
            for (let i = 0; i < textureSize * textureSize; i++) {
                allLayerData[i * 4 + 0] = 128;
                allLayerData[i * 4 + 1] = 128;
                allLayerData[i * 4 + 2] = 128;
                allLayerData[i * 4 + 3] = 255;
            }
        }
    
        let currentIndex = startIndex;
        for (const texturePath of allTexturePaths) {
            if (currentIndex >= totalLayers) break;
            try {
                const img = await this.loadImage(texturePath);
    
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width  = textureSize;
                tempCanvas.height = textureSize;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(img, 0, 0, textureSize, textureSize);
                const imageData = tempCtx.getImageData(0, 0, textureSize, textureSize);
    
                const layerOffset = currentIndex * bytesPerLayer;
                allLayerData.set(new Uint8Array(imageData.data.buffer), layerOffset);
    
                atlas.textureMap.set(texturePath, currentIndex);
                currentIndex++;
            } catch (error) {
                // Fallback solid colour
                const layerOffset = currentIndex * bytesPerLayer;
                const r = Math.floor((currentIndex * 137.5) % 256);
                for (let p = 0; p < textureSize * textureSize; p++) {
                    allLayerData[layerOffset + p * 4 + 0] = r;
                    allLayerData[layerOffset + p * 4 + 1] = 64;
                    allLayerData[layerOffset + p * 4 + 2] = 64;
                    allLayerData[layerOffset + p * 4 + 3] = 255;
                }
                atlas.textureMap.set(texturePath, currentIndex);
                currentIndex++;
            }
        }
    
        // Seasonal map
        for (const tileConfig of this.TILE_CONFIG) {
            for (const season of Object.values(this.SEASONS)) {
                const textures = this.TextureConfigHelper.getTexturesForSeason(tileConfig.id, season, level);
                for (let variant = 0; variant < textures.length; variant++) {
                    const texturePath = textures[variant];
                    const key = `${tileConfig.id}:${season}:${variant}`;
                    const index = atlas.textureMap.get(texturePath);
                    atlas.seasonalTextureMap.set(key, index);
                }
            }
        }
    
        atlas.texture = new Texture({
            width: textureSize,
            height: textureSize,
            depth: totalLayers,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR_MIPMAP_LINEAR,
            magFilter: TextureFilter.LINEAR,
            wrapS: TextureWrap.REPEAT,
            wrapT: TextureWrap.REPEAT,
            generateMipmaps: true,
            data: allLayerData,
            _isArray: true
        });
    
        if (this._backend) {
            this._backend.createTexture(atlas.texture);
        }
    
        return atlas.texture;
    }
    
    // Lookup table now writes layer indices.  The RGBA32F format is kept for
    // GPU compatibility but only .r is meaningful: it holds the layer index as
    // a float (0.0, 1.0, 2.0, …).  The shader rounds it back to i32.
    _buildTileTypeLookup(maxTileTypes, maxVariants, level, seasons) {
        const numSeasons = seasons.length;
        const width  = numSeasons * maxVariants;
        const height = maxTileTypes;
        const lookupData = new Float32Array(width * height * 4);
    
        const atlas = this.atlases.get(level);
    
        for (let tileId = 0; tileId < maxTileTypes; tileId++) {
            for (let s = 0; s < numSeasons; s++) {
                const season = seasons[s];
                const variantCount = this.getNumVariants(tileId, season, level);
    
                for (let v = 0; v < maxVariants; v++) {
                    const safeVar = Math.min(v, Math.max(variantCount - 1, 0));
                    const x   = s * maxVariants + v;
                    const idx = (tileId * width + x) * 4;
    
                    const key = `${tileId}:${season}:${safeVar}`;
                    const layerIndex = atlas ? atlas.seasonalTextureMap.get(key) : undefined;
    
                    if (layerIndex !== undefined) {
                        lookupData[idx + 0] = layerIndex;  // layer index
                        lookupData[idx + 1] = 0;
                        lookupData[idx + 2] = 0;
                        lookupData[idx + 3] = 0;
                    } else {
                        // Layer 0 is the grey placeholder — safe fallback.
                        lookupData[idx + 0] = 0;
                        lookupData[idx + 1] = 0;
                        lookupData[idx + 2] = 0;
                        lookupData[idx + 3] = 0;
                    }
                }
            }
        }
    
        const texture = new Texture({
            width: width,
            height: height,
            format: TextureFormat.RGBA32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            wrapS: TextureWrap.CLAMP,
            wrapT: TextureWrap.CLAMP,
            generateMipmaps: false,
            data: lookupData
        });
    
        return texture;
    }
    async createAtlas(level) {
        const config = this.ATLAS_CONFIG[level];
        const atlas = this.atlases.get(level);

        const allTextures = this.TextureConfigHelper.getAllTexturesForLevel(level);
        atlas.layout = this.calculateLayout(allTextures.length, config.atlasSize, config.textureSize);

        atlas.layout.padding = this.PADDING;

        atlas.canvas = document.createElement('canvas');
        atlas.canvas.width = atlas.layout.atlasSize;
        atlas.canvas.height = atlas.layout.atlasSize;
        atlas.context = atlas.canvas.getContext('2d');

        if (level === this.TEXTURE_LEVELS.MICRO) {
            atlas.context.fillStyle = '#888888';
            atlas.context.fillRect(0, 0, atlas.canvas.width, atlas.canvas.height);
        }
        
        atlas.texture = this._canvasToTexture(atlas.canvas, {
            minFilter: TextureFilter.LINEAR_MIPMAP_LINEAR,
            magFilter: TextureFilter.LINEAR,
            generateMipmaps: true
        });
        
        // CRITICAL: Use backend to upload
        if (this._backend) {
            
            this._backend.createTexture(atlas.texture);
            
        } else {
            
        }
        await this.loadTexturesForLevel(level);
        return atlas.texture;
    }

    _canvasToTexture(canvas, options = {}) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const texture = new Texture({
            width: canvas.width,
            height: canvas.height,
            format: TextureFormat.RGBA8,
            minFilter: options.minFilter || TextureFilter.LINEAR_MIPMAP_LINEAR,
            magFilter: options.magFilter || TextureFilter.LINEAR,
            wrapS: options.wrapS || TextureWrap.CLAMP,
            wrapT: options.wrapT || TextureWrap.CLAMP,
            generateMipmaps: options.generateMipmaps !== false,
            data: new Uint8Array(imageData.data.buffer)
        });
        
        texture.image = {
            width: canvas.width,
            height: canvas.height
        };
        
        return texture;
    }

    async loadTexturesForLevel(level) {
        const atlas = this.atlases.get(level);
        const allTexturePaths = this.TextureConfigHelper.getAllTexturesForLevel(level);

        let currentIndex = 0;

        for (const texturePath of allTexturePaths) {
            if (currentIndex >= atlas.layout.maxCapacity) {
                
                continue;
            }
            try {
                const img = await this.loadImage(texturePath);
                this.addTextureToAtlas(level, img, currentIndex, texturePath);
                atlas.textureMap.set(texturePath, currentIndex);
                currentIndex++;
            } catch (error) {
                
                this.createPlaceholderTexture(level, currentIndex, texturePath);
                atlas.textureMap.set(texturePath, currentIndex);
                currentIndex++;
            }
        }

        for (const tileConfig of this.TILE_CONFIG) {
            for (const season of Object.values(this.SEASONS)) {
                const textures = this.TextureConfigHelper.getTexturesForSeason(tileConfig.id, season, level);
                for (let variant = 0; variant < textures.length; variant++) {
                    const texturePath = textures[variant];
                    const key = `${tileConfig.id}:${season}:${variant}`;
                    const index = atlas.textureMap.get(texturePath);
                    atlas.seasonalTextureMap.set(key, index);
                }
            }
        }

        atlas.texture.needsUpdate = true;
        
    }

    loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = (err) => reject(err);
            img.src = src;
        });
    }

    getSeasonalTextureUV(tileType, season, variant, level) {
        const cacheKey = `${level}_${tileType}_${season}_${variant}`;
        if (this._uvCache.has(cacheKey)) {
            return this._uvCache.get(cacheKey);
        }

        const atlas = this.atlases.get(level);

        if (!atlas) {
            
            return null;
        }

        const key = `${tileType}:${season}:${variant}`;
        const index = atlas.seasonalTextureMap.get(key);

        if (index === undefined) {
            return null;
        }

        const result = this.calculateUVFromIndex(level, index);

        if (result) {
            this._uvCache.set(cacheKey, result);
        }

        return result;
    }

    getNumVariants(tileType, season, level) {
        const atlas = this.atlases.get(level);

        if (!atlas) {
            
            return 0;
        }

        let count = 0;
        for (let v = 0; v < 16; v++) {
            const key = `${tileType}:${season}:${v}`;
            if (atlas.seasonalTextureMap.has(key)) {
                count++;
            } else {
                break;
            }
        }
        return count;
    }

    getAtlasTexture(level) {
        const atlas = this.atlases.get(level);
        return atlas ? atlas.texture : null;
    }

    getNextSeason(currentSeason) {
        const seasons = Object.values(this.SEASONS);
        const currentIndex = seasons.indexOf(currentSeason);
        return seasons[(currentIndex + 1) % seasons.length];
    }

    getTextureIndex(level, texturePath) {
        const atlas = this.atlases.get(level);
        return atlas ? atlas.textureMap.get(texturePath) ?? -1 : -1;
    }

    getTextureUV(level, texturePath) {
        const index = this.getTextureIndex(level, texturePath);
        if (index === -1) return null;
        return this.calculateUVFromIndex(level, index);
    }

    getAtlasUtilization(level) {
        const atlas = this.atlases.get(level);
        if (!atlas || !atlas.layout) return null;

        const used = atlas.textureMap.size || atlas.seasonalTextureMap.size;
        const capacity = atlas.layout.maxCapacity;

        return {
            used: used,
            capacity: capacity,
            utilization: (used / capacity * 100).toFixed(1) + '%',
            tilesPerRow: atlas.layout.tilesPerRow,
            rows: atlas.layout.rows
        };
    }

    getAtlasInfo(level) {
        const atlas = this.atlases.get(level);
        if (!atlas || !atlas.layout) return null;

        return {
            level: level,
            atlasSize: atlas.layout.atlasSize,
            textureSize: atlas.layout.textureSize,
            paddedTextureSize: atlas.layout.paddedTextureSize,
            padding: this.PADDING,
            layout: atlas.layout,
            utilization: this.getAtlasUtilization(level),
            seasonalTextures: atlas.seasonalTextureMap.size,
            totalTextures: atlas.textureMap.size
        };
    }

    getPropAtlasTexture() {
        return this.getAtlasTexture(this.TEXTURE_LEVELS.PROP);
    }

    getPropUV(propType) {
        const path = this.TextureConfigHelper.getPropTexturePath(propType);
        if (!path) return null;
        return this.getTextureUV(this.TEXTURE_LEVELS.PROP, path);
    }

    cleanup() {
        this.atlases.forEach(atlas => {
            if (atlas.texture) {
                atlas.texture.dispose();
            }
            if (atlas.canvas) {
                atlas.canvas = null;
                atlas.context = null;
            }
        });
        this.atlases.clear();

        if (this.lookupTables.tileTypeLookup) {
            this.lookupTables.tileTypeLookup.dispose();
        }
        if (this.lookupTables.macroTileTypeLookup) {
            this.lookupTables.macroTileTypeLookup.dispose();
        }
        if (this.lookupTables.numVariantsTex) {
            this.lookupTables.numVariantsTex.dispose();
        }

        this._uvCache.clear();
    }
}
