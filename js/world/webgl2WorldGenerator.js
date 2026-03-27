
import { BaseWorldGenerator } from './baseWorldGenerator.js';
import { WebGL2TerrainGenerator } from "./webgl2TerrainGenerator.js";
import { ChunkData } from "./chunkData.js";
import { TreeFeature } from './features/treeFeature.js';
import { TextureAtlasKey } from './textureAtlasKey.js';

export class WebGL2WorldGenerator extends BaseWorldGenerator {

    constructor(backend, textureCache, chunkSize, seed, options = {}) {
        super(backend, textureCache, chunkSize, seed, options);
        this.backend = backend;
        this.gl = null;
        this.lodAtlasConfig = requireObject(options.lodAtlasConfig, 'lodAtlasConfig');
        this.planetConfig = requireObject(options.planetConfig, 'planetConfig');
        this.chunksPerFace = requireInt(this.planetConfig.chunksPerFace, 'planetConfig.chunksPerFace', 1);
        this._applyLODAtlasConfig();
        
        // Match WebGPU settings
        this.useAtlasMode = true;

    }

    getAPIName() {
        return 'WebGL2';
    }

    async initializeAPI() {
        if (!this.backend) {
            throw new Error('Backend is required for WebGL2WorldGenerator');
        }
        
        this.gl = this.backend.getContext();

        if (!this.gl) {
            throw new Error('WebGL2 context not available from backend');
        }

        const ext = this.gl.getExtension('EXT_color_buffer_float');
        if (!ext) {
            
        }
    }

    async initializeModules() {
        if (this.modules.tiledTerrain.enabled) {
            this.modules.tiledTerrain.instance = new WebGL2TerrainGenerator(
                this.backend,
                this.seed,
                this.chunkSize,
                this.macroConfig,
                this.splatConfig,
                this.textureCache,
                {
                    planetConfig: this.planetConfig,
                    lodAtlasConfig: this.lodAtlasConfig
                }
            );
        }
    }

    _applyLODAtlasConfig() {
        const lodCfg = requireObject(this.lodAtlasConfig, 'lodAtlasConfig');
        const chunksPerFace = requireInt(this.chunksPerFace, 'chunksPerFace', 1);
        lodCfg.chunksPerFace = chunksPerFace;
        this.textureCache?.setLODAtlasConfig?.(lodCfg);
    }

    setPlanetConfig(config) {
        const planetConfig = requireObject(config, 'planetConfig');
        super.setPlanetConfig(planetConfig);
        this.planetConfig = planetConfig;
        this.chunksPerFace = requireInt(planetConfig.chunksPerFace, 'planetConfig.chunksPerFace', 1);
        this._applyLODAtlasConfig();
    }

    async generateChunk(chunkX, chunkY, face = null, lod = 0) {
        await this._ready;
        
        // Validate inputs
        if (typeof chunkX !== 'number' || isNaN(chunkX) || 
            typeof chunkY !== 'number' || isNaN(chunkY)) {
            throw new Error('Invalid chunk coordinates: chunkX=' + chunkX + ', chunkY=' + chunkY);
        }

        const chunkData = new ChunkData(chunkX, chunkY, this.chunkSize);
        chunkData.face = face;
        
        if (this.planetConfig) {
            chunkData.isSpherical = true;
            chunkData.baseAltitude = this.planetConfig.radius;
        }
        
        if (this.useAtlasMode) {
            await this._setupAtlasTextures(chunkData, chunkX, chunkY, face);
        } else {
            await this._setupLegacyTextures(chunkData, chunkX, chunkY, face);
        }

        if (this.modules.staticObjects.enabled) {
            this.generateObjectData(chunkData, chunkX, chunkY);
        }

        return chunkData;
    }

    async _setupAtlasTextures(chunkData, chunkX, chunkY, face) {
        const needsAtlas = !this.hasAtlasForChunk(chunkX, chunkY, face);
        
        if (needsAtlas) {
            await this.generateAtlasForChunk(chunkX, chunkY, face);
        }
        
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, this.atlasConfig);
        const uvTransform = this.atlasConfig.getChunkUVTransform(chunkX, chunkY);
        
        chunkData.atlasKey = atlasKey;
        chunkData.uvTransform = uvTransform;
        chunkData.useAtlasMode = true;
        
        const atlasTextures = this.getAtlasTexturesForChunk(chunkX, chunkY, face);
        
        chunkData.textureRefs = {
            chunkX: chunkX,
            chunkY: chunkY,
            atlasKey: atlasKey,
            uvTransform: uvTransform,
            useAtlasMode: true,
            isWebGPU: false,
            heightTexture: atlasTextures.height ? atlasTextures.height.texture : null,
            normalTexture: atlasTextures.normal ? atlasTextures.normal.texture : null,
            tileTexture: atlasTextures.tile ? atlasTextures.tile.texture : null,
            splatDataTexture: atlasTextures.splatData ? atlasTextures.splatData.texture : null,
            macroTexture: atlasTextures.macro ? atlasTextures.macro.texture : null
        };
        
        // CPU-side extraction intentionally disabled.
    }

    async _setupLegacyTextures(chunkData, chunkX, chunkY, face = null) {
        chunkData.useAtlasMode = false;
        
        if (this.modules.tiledTerrain.enabled && this.modules.tiledTerrain.instance) {
            await this.modules.tiledTerrain.instance.generateTerrain(chunkData, chunkX, chunkY, face);
        }
    }

    generateObjectData(chunkData, chunkX, chunkY) {
        const staticFeatures = chunkData.staticFeatures || [];
        const chunkSize = this.chunkSize;

        const chunkSeed = this.seed + chunkX * 73856093 + chunkY * 19349663;
        const rng = this.createSeededRandom(chunkSeed);

        const waterLevel = this.globalWaterLevel;

        const centerX = Math.floor(chunkSize / 2);
        const centerY = Math.floor(chunkSize / 2);
        const centerTile = chunkData.getTile(centerX, centerY);
        const isGrassland = centerTile === 3;
        const isTundra = centerTile === 6;
        const isRocky = centerTile === 5 || centerTile === 7;

        const treeCount = isGrassland ? (1 + Math.floor(rng() * 6)) :
                         isTundra ? (1 + Math.floor(rng() * 3)) :
                         isRocky ? (1 + Math.floor(rng() * 2)) :
                         (3 + Math.floor(rng() * 4));

        for (let i = 0; i < treeCount; i++) {
            const localX = 4 + rng() * (chunkSize - 8);
            const localZ = 4 + rng() * (chunkSize - 8);
            const height = chunkData.getHeight(localX, localZ);

            if (height < waterLevel) continue;

            const waterMargin = 2.0;
            if (height < waterLevel + waterMargin) continue;

            const slope = this.calculateSlope(chunkData, localX, localZ);
            if (slope > 0.5) continue;

            const tree = new TreeFeature({
                subtype: 'BIRCH',
                variant: Math.floor(rng() * 3),
                position: {
                    x: chunkX * chunkSize + localX,
                    y: height,
                    z: chunkY * chunkSize + localZ
                },
                rotation: rng() * Math.PI * 2,
                scale: 0.7 + rng() * 0.5,
                shapeSeed: Math.floor(rng() * 100000)
            });

            staticFeatures.push(tree);
        }

        chunkData.staticFeatures = staticFeatures;
    }

    dispose() {
        if (this.modules.tiledTerrain.instance) {
            this.modules.tiledTerrain.instance.dispose();
        }
    }
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`[WebGL2WorldGenerator] missing required object: ${name}`);
    }
    return value;
}

function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`[WebGL2WorldGenerator] missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`[WebGL2WorldGenerator] ${name} must be >= ${min}`);
    }
    return n;
}
