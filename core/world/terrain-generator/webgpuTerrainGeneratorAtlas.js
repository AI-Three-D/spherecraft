import { gpuFormatBytesPerTexel, gpuFormatIsFilterable, gpuFormatToWrapperFormat, Texture, TextureFilter } from '../../renderer/resources/texture.js';
import { Logger } from '../../../shared/Logger.js';
import {
    compareSplatOutputs,
    emulateSplatOutputFromPaddedTile,
    formatCategorySummary,
    formatPairSummary,
    formatRGBA8PixelSummary,
    requireInt,
    requireNumber,
    summarizeRGBA8Pixels,
    summarizeSplatData,
    summarizeTileCategoryHistogram
} from './webgpuTerrainGeneratorDebugUtils.js';

const SPLAT_STEP_PREFIX = '[TerrainStep] [SplatStep]';

export function installWebGPUTerrainGeneratorAtlasMethods(WebGPUTerrainGenerator) {
    Object.defineProperties(
        WebGPUTerrainGenerator.prototype,
        Object.getOwnPropertyDescriptors({
        estimateAtlasMemory(config) {
                const textureSize = config.textureSize;
                const heightNormalSize = textureSize;
                const tileSize = textureSize;
                const splatSize = textureSize;
                const bytesPerPixel = 16;
                const total = (heightNormalSize**2 + heightNormalSize**2 + tileSize**2 + splatSize**2 + splatSize**2 + splatSize**2) * bytesPerPixel;
                
                return { total, totalMB: (total / 1024 / 1024).toFixed(2) };
            },

        async generateAtlasTextures(atlasKey, config) {
                const textureSize = config.textureSize;
                const chunkSizeTex = Math.max(1,
                    Math.floor(textureSize / config.chunksPerAxis));

                const atlasChunkX = atlasKey.atlasX * config.chunksPerAxis;
                const atlasChunkY = atlasKey.atlasY * config.chunksPerAxis;
                const faceIndex   = atlasKey.face !== null ? atlasKey.face : -1;

                const gpuHeight = this.getOrCreateAtlasTexture(atlasKey, 'height', textureSize);
                const gpuNormal = this.getOrCreateAtlasTexture(atlasKey, 'normal', textureSize);
                const gpuTile   = this.getOrCreateAtlasTexture(atlasKey, 'tile',   textureSize);
                const gpuHeightBase = this.createGPUTexture(textureSize, textureSize, 'rgba32float');
                let gpuSplatData = null;
                let gpuSplatIndex = null;

                await this.runTerrainPassAtlas(gpuHeightBase, atlasChunkX, atlasChunkY,
                    faceIndex, 0, textureSize, textureSize, chunkSizeTex, config.gridSize);

                await this.runTerrainPassAtlas(gpuTile, atlasChunkX, atlasChunkY,
                    faceIndex, 2, textureSize, textureSize, chunkSizeTex, config.gridSize,
                    gpuHeightBase);

                await this.runTerrainPassAtlas(gpuHeight, atlasChunkX, atlasChunkY,
                    faceIndex, 4, textureSize, textureSize, chunkSizeTex, config.gridSize,
                    gpuHeightBase, gpuTile);

                await this.runTerrainPassAtlas(gpuNormal, atlasChunkX, atlasChunkY,
                    faceIndex, 1, textureSize, textureSize, chunkSizeTex, config.gridSize,
                    gpuHeight);

                gpuSplatData = this.getOrCreateAtlasTexture(
                    atlasKey, 'splat', config.splatSize);
                gpuSplatIndex = this.getOrCreateAtlasTexture(
                    atlasKey, 'splatIndex', config.splatSize);
                await this.runSplatPassAtlas(
                    gpuHeight,
                    gpuTile,
                    gpuSplatData,
                    gpuSplatIndex,
                    atlasChunkX,
                    atlasChunkY,
                    config.splatSize,
                    config.splatSize,
                    chunkSizeTex,
                    'r32float',
                    'r32float'
                );

                return {
                    height: gpuHeight,
                    normal: gpuNormal,
                    tile: gpuTile,
                    splatData: gpuSplatData,
                    splatIndex: gpuSplatIndex
                };
            },

        async generateLODAtlasTextures(atlasKey, config) {
                if (!this.initialized) await this.initialize();

                const lodConfig      = config.getConfigForLOD(atlasKey.lod);
                const textureSize    = lodConfig.textureSize;
                const chunksPerAtlas = requireInt(
                    lodConfig.chunksPerAtlas, 'lodAtlasConfig.chunksPerAtlas', 1);
                const chunksPerFace  = requireInt(
                    config.chunksPerFace, 'lodAtlasConfig.chunksPerFace', 1);
                const atlasesPerAxis = Math.max(1,
                    Math.ceil(chunksPerFace / chunksPerAtlas));
                const atlasesPerFace = atlasesPerAxis * atlasesPerAxis;
                const arrayCapacity  = Math.min(128,
                    Math.max(16, atlasesPerFace));

                // Per-type formats. Staging textures and pool layers must agree
                // because we copyTextureToTexture between them.
                const atlasFormats = config.atlasTextureFormats || {};
                const fmt = (name) => {
                    if (name === 'splatIndex') return atlasFormats.splatIndex || 'rgba8unorm';
                    return atlasFormats[name] || 'rgba32float';
                };

                if (this._atlasGenLogCount === undefined) this._atlasGenLogCount = 0;

                // ... (pool reservation probing unchanged) ...
                const hasVirtualPool =
                    this.textureCache?.hasVirtualTexturePool?.() || false;
                let useTextureCachePool = hasVirtualPool;
                if (useTextureCachePool && this.textureCache?.canReservePooledLODAtlas) {
                    const canReserve =
                        this.textureCache.canReservePooledLODAtlas(atlasKey);
                    if (!canReserve) {
                        useTextureCachePool = false;
                        if (!this._poolFallbackWarned) this._poolFallbackWarned = new Set();
                        const warnKey = `lod${atlasKey.lod}`;
                        if (!this._poolFallbackWarned.has(warnKey))
                            this._poolFallbackWarned.add(warnKey);
                    }
                }

                // Staging textures: format now per-type (was hardcoded rgba32float).
                const gpuHeight    = this.createGPUTexture(textureSize, textureSize, fmt('height'));
                const gpuHeightBase = this.createGPUTexture(textureSize, textureSize, 'rgba32float');
                const gpuNormal    = this.createGPUTexture(textureSize, textureSize, fmt('normal'));
                const gpuTile      = this.createGPUTexture(textureSize, textureSize, fmt('tile'));
                const gpuMacro     = this.createGPUTexture(textureSize, textureSize, fmt('macro'));
                const gpuSplatData = this.createGPUTexture(textureSize, textureSize, fmt('splatData'));
                const gpuSplatIndex = this.createGPUTexture(textureSize, textureSize, fmt('splatIndex'));

                const chunkSizeTex  = Math.max(1, Math.floor(textureSize / chunksPerAtlas));
                const chunkCoordX   = atlasKey.atlasX * chunksPerAtlas;
                const chunkCoordY   = atlasKey.atlasY * chunksPerAtlas;
                const chunkGridSize = chunksPerFace;

                this._runBatchedLODTerrainPasses({
                    gpuHeightBase, gpuHeight, gpuNormal, gpuTile, gpuMacro,
                    chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize,
                    face: atlasKey.face,
                    textureSize,
                    formats: atlasFormats
                });

                // ... (pre-splat diagnostic unchanged) ...
                if (this._preSplatCheckCount === undefined) this._preSplatCheckCount = 0;
                if (this._preSplatCheckCount < 3) {
                    this._preSplatCheckCount++;
                    try {
                        const tileCheck = await this.readTextureWindowR8Unorm(
                            gpuTile, 0, 0,
                            Math.min(32, textureSize),
                            Math.min(32, textureSize));
                        let tileTypes = new Set();
                        let nonZero = 0;
                        for (let i = 0; i < tileCheck.length; i += 1) {
                            const tid = tileCheck[i];
                            tileTypes.add(tid);
                            if (tid > 0) nonZero++;
                        }
                        Logger.info(
                            `[SplatDebug] Pre-splat tile check: ${nonZero} non-zero pixels, ` +
                            `types={${[...tileTypes].sort((a,b)=>a-b).join(',')}}`);
                        if (tileTypes.size <= 1)
                            Logger.warn(`[SplatDebug] ⚠️ Tile texture has only ${tileTypes.size} type(s)`);
                        if (nonZero === 0)
                            Logger.warn(`[SplatDebug] ⚠️ Tile texture is ALL ZEROS`);
                    } catch (e) {
                        Logger.warn(`[SplatDebug] Pre-splat tile check failed: ${e}`);
                    }
                }

                await this.runLODSplatPass(
                    gpuHeight,
                    gpuTile,
                    gpuSplatData,
                    gpuSplatIndex,
                    chunkCoordX,
                    chunkCoordY,
                    config.worldCoverage,
                    textureSize,
                    atlasKey.lod,
                    fmt('height'),
                    fmt('tile')
                );

                // Wrap with per-type formats.
                const textures = {
                    height:    this.wrapGPUTexture(gpuHeight,    textureSize, textureSize, fmt('height'), true),
                    normal:    this.wrapGPUTexture(gpuNormal,    textureSize, textureSize, fmt('normal')),
                    tile:      this.wrapGPUTexture(gpuTile,      textureSize, textureSize, fmt('tile')),
                    macro:     this.wrapGPUTexture(gpuMacro,     textureSize, textureSize, fmt('macro')),
                    splatData: this.wrapGPUTexture(gpuSplatData, textureSize, textureSize, fmt('splatData')),
                    splatIndex: this.wrapGPUTexture(gpuSplatIndex, textureSize, textureSize, fmt('splatIndex'), true)
                };

                await this._debugLogAtlasStats(atlasKey, {
                    height: gpuHeight, tile: gpuTile
                }, textureSize, chunkGridSize, chunkCoordX, chunkCoordY);
                // ── Pool / array upload (unchanged from previous refactor) ──
                let pooledAllocation = null;
                if (useTextureCachePool) {
                    pooledAllocation =
                        this.textureCache.reservePooledLODAtlas?.(atlasKey) || null;
                    if (!pooledAllocation || !pooledAllocation.arrayTextures) {
                        useTextureCachePool = false;
                        if (!this._poolFallbackWarned)
                            this._poolFallbackWarned = new Set();
                        const warnKey = `alloc_lod${atlasKey.lod}`;
                        if (!this._poolFallbackWarned.has(warnKey))
                            this._poolFallbackWarned.add(warnKey);
                    }
                }

                const allowArrayPools = this.useTextureArrays
                    && !useTextureCachePool && !hasVirtualPool;
                const arrayInfoByType = {};
                const uploadToArray = (type, sourceTex) => {
                    if (!allowArrayPools) return;
                    const arrayFormat = fmt(type);
                    const texelBytes = gpuFormatBytesPerTexel(arrayFormat);   // ← was local switch
                    const bytesPerLayer = textureSize * textureSize * texelBytes;

                    const maxLayersByBudget = Math.max(1,
                        Math.floor(this.maxArrayBytesPerType / bytesPerLayer));
                    const capacity = Math.max(1,
                        Math.min(arrayCapacity, maxLayersByBudget));
                    const poolKey = `${type}_lod${atlasKey.lod}_${textureSize}_${arrayFormat}`;
                    let pool = this.arrayPools.get(poolKey);
                    if (!pool) {
                        const arrayTex = this.device.createTexture({
                            size:   [textureSize, textureSize, capacity],
                            format: arrayFormat,
                            usage:  GPUTextureUsage.TEXTURE_BINDING
                                  | GPUTextureUsage.COPY_DST
                                  | GPUTextureUsage.COPY_SRC
                        });
                        pool = { texture: arrayTex, capacity, nextLayer: 0,
                                 freeLayers: [], size: textureSize, format: arrayFormat };
                        this.arrayPools.set(poolKey, pool);
                    }
                    let layer = -1;
                    if (pool.freeLayers.length > 0) {
                        layer = pool.freeLayers.pop();
                    } else if (pool.nextLayer < pool.capacity) {
                        layer = pool.nextLayer++;
                    } else {
                        return;
                    }
                    const encoder = this.device.createCommandEncoder();
                    encoder.copyTextureToTexture(
                        { texture: sourceTex._gpuTexture.texture },
                        { texture: pool.texture, origin: { x: 0, y: 0, z: layer } },
                        { width: textureSize, height: textureSize, depthOrArrayLayers: 1 }
                    );
                    this.device.queue.submit([encoder.finish()]);
                    if (!pool.wrapper) {
                        const useNearest = (type === 'height' || type === 'tile' || type === 'splatData' || type === 'splatIndex');
                        const filterable = gpuFormatIsFilterable(arrayFormat);
                        const effectiveNearest = useNearest || !filterable;
                        const filter = effectiveNearest
                            ? TextureFilter.NEAREST : TextureFilter.LINEAR;
                        const wrap = new Texture({
                            width: textureSize, height: textureSize,
                            depth: pool.capacity,
                            format: gpuFormatToWrapperFormat(arrayFormat),
                            minFilter: filter, magFilter: filter,
                            generateMipmaps: false
                        });
                        wrap._gpuTexture = {
                            texture: pool.texture,
                            view: pool.texture.createView({ dimension: '2d-array' }),
                            format: arrayFormat
                        };
                        wrap._isArray = true;
                        wrap._needsUpload = false;
                        wrap._gpuFormat = arrayFormat;
                        wrap._isFilterable = filterable;
                        pool.wrapper = wrap;
                    }
                    arrayInfoByType[type] = {
                        layer,
                        arrayTexture: pool.wrapper,
                        poolKey,
                        release: () => {
                            if (this.arrayPools.has(poolKey)) {
                                const p = this.arrayPools.get(poolKey);
                                p.freeLayers.push(layer);
                            }
                        }
                    };
                };
                uploadToArray('height',     textures.height);
                uploadToArray('normal',     textures.normal);
                uploadToArray('tile',       textures.tile);
                uploadToArray('macro',      textures.macro);
                uploadToArray('splatData',  textures.splatData);
                uploadToArray('splatIndex', textures.splatIndex);

                const textureTypes = ['height', 'normal', 'tile', 'macro', 'splatData', 'splatIndex'];
                if (useTextureCachePool && pooledAllocation) {
                    const encoder = this.device.createCommandEncoder();
                    const layer = pooledAllocation.layer;
                    const copyToPool = (type, sourceTex) => {
                        const dstWrapper = pooledAllocation.arrayTextures[type];
                        const dstTex = dstWrapper?._gpuTexture?.texture;
                        const srcTex = sourceTex?._gpuTexture?.texture;
                        if (!dstTex || !srcTex) return;
                        const copySize = textureSize;
                        encoder.copyTextureToTexture(
                            { texture: srcTex },
                            { texture: dstTex,
                              origin: { x: 0, y: 0, z: layer } },
                            { width: copySize, height: copySize, depthOrArrayLayers: 1 }
                        );
                    };
                    copyToPool('height',     textures.height);
                    copyToPool('normal',     textures.normal);
                    copyToPool('tile',       textures.tile);
                    copyToPool('macro',      textures.macro);
                    copyToPool('splatData',  textures.splatData);
                    copyToPool('splatIndex', textures.splatIndex);
                    this.device.queue.submit([encoder.finish()]);

                    for (const type of textureTypes) {
                        const arrayTexture = pooledAllocation.arrayTextures[type];
                        const arrayInfo = { layer, arrayTexture, isPooled: true };
                        this.textureCache.setLODAtlas(
                            atlasKey, type, arrayTexture, 0, arrayInfo);
                    }

                    if (this.textureCache?.deferTextureDestruction) {
                        for (const type of textureTypes)
                            this.textureCache.deferTextureDestruction(textures[type]);
                    }
                } else {
                    const skipVirtualPool = hasVirtualPool && !useTextureCachePool;
                    const skipPoolInfo = skipVirtualPool ? { skipPool: true } : null;
                    for (const type of textureTypes) {
                        const useArray = arrayInfoByType[type]?.arrayTexture;
                        const cachedTex = useArray
                            ? arrayInfoByType[type].arrayTexture
                            : textures[type];
                        // Per-type size — normals at rgba8unorm are 4×
                        // smaller than rgba32float, so the cache's eviction
                        // watermark must see the real number.
                        const typeSize = textureSize;
                        const size = typeSize * typeSize
                                   * gpuFormatBytesPerTexel(fmt(type));
                        const arrayInfo = arrayInfoByType[type] || skipPoolInfo;
                        this.textureCache.setLODAtlas(
                            atlasKey, type, cachedTex, size, arrayInfo);
                    }
                }

                return {
                    atlasKey:    atlasKey,
                    textures:    textures,
                    lod:         atlasKey.lod,
                    textureSize: textureSize
                };
            },

        async runTerrainPassAtlas(outTex, atlasChunkX, atlasChunkY, face, type,
                w, h, chunkSize, chunkGridSize,
                heightTex = null, tileTex = null) {
        const data = new ArrayBuffer(512);
        const v = new DataView(data);

        v.setInt32(0, atlasChunkX | 0, true);
        v.setInt32(4, atlasChunkY | 0, true);
        v.setInt32(8, chunkSize | 0, true);
        v.setInt32(12, chunkGridSize | 0, true);
        v.setInt32(16, this.seed, true);

        v.setFloat32(20, this.macroConfig.biomeScale, true);
        v.setFloat32(24, this.macroConfig.regionScale, true);
        v.setFloat32(28, this.detailScale, true);
        v.setFloat32(32, this.ridgeScale, true);
        v.setFloat32(36, this.valleyScale, true);
        v.setFloat32(40, this.plateauScale, true);
        v.setFloat32(44, this.worldScale, true);

        v.setInt32(48, type, true);
        v.setInt32(52, face, true);

        v.setInt32(56, this.debugMode, true);
        v.setInt32(60, 0, true);

        const uniforms = this._getTerrainShaderUniforms();

        v.setFloat32(80,  uniforms.continentParams[0], true);
        v.setFloat32(84,  uniforms.continentParams[1], true);
        v.setFloat32(88,  uniforms.continentParams[2], true);
        v.setFloat32(92,  uniforms.continentParams[3], true);

        v.setFloat32(96,  uniforms.tectonicParams[0], true);
        v.setFloat32(100, uniforms.tectonicParams[1], true);
        v.setFloat32(104, uniforms.tectonicParams[2], true);
        v.setFloat32(108, uniforms.tectonicParams[3], true);

        v.setFloat32(112, uniforms.waterParams[0], true);
        v.setFloat32(116, uniforms.waterParams[1], true);
        v.setFloat32(120, uniforms.waterParams[2], true);
        v.setFloat32(124, uniforms.waterParams[3], true);

        v.setFloat32(128, uniforms.erosionParams[0], true);
        v.setFloat32(132, uniforms.erosionParams[1], true);
        v.setFloat32(136, uniforms.erosionParams[2], true);
        v.setFloat32(140, uniforms.erosionParams[3], true);

        v.setFloat32(144, uniforms.volcanicParams[0], true);
        v.setFloat32(148, uniforms.volcanicParams[1], true);
        v.setFloat32(152, uniforms.volcanicParams[2], true);
        v.setFloat32(156, uniforms.volcanicParams[3], true);

        v.setFloat32(160, uniforms.climateParams[0], true);
        v.setFloat32(164, uniforms.climateParams[1], true);
        v.setFloat32(168, uniforms.climateParams[2], true);
        v.setFloat32(172, uniforms.climateParams[3], true);
        this._writeTerrainPaddingUniforms(v, uniforms);
        this._writeClimateZoneUniforms(v, uniforms);

        this.device.queue.writeBuffer(this.terrainUniformBuffer, 0, data);

        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();

        // ── Select pipeline based on required inputs ──
        const isMicroPass = (type === 4 || type === 5 || type === 6) && heightTex && tileTex;
        const isHeightInputPass =
            !isMicroPass && (type === 1 || type === 2) && heightTex;

        if (isMicroPass) {
        const { pipeline, bindGroupLayout } =
        this._getMicroPipelineForFormat('rgba32float', 'r32float', 'r32float');
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
        { binding: 0,
        resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: heightTex.createView() },
        { binding: 3, resource: tileTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        } else if (isHeightInputPass) {
        const { pipeline, bindGroupLayout } =
        this._getHeightInputPipelineForFormat('rgba32float', 'r32float');
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
        { binding: 0,
        resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: heightTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        } else {
        pass.setPipeline(this.terrainPipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.terrainBindGroupLayout,
        entries: [
        { binding: 0,
        resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        }

        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
        this.device.queue.submit([enc.finish()]);
        },

        async runLODTerrainPass(outTex, chunkCoordX, chunkCoordY,
                chunkSizeTex, chunkGridSize, face, type,
                textureSize, outputFormat = 'rgba32float',
                heightTex = null, tileTex = null) {
        if (this._lodPassLogCount === undefined) this._lodPassLogCount = 0;
        if (this._lodPassLogCount < 3 && type === 0) {
        this._lodPassLogCount++;
        const uniforms = this._getTerrainShaderUniforms();
        console.log(`[TerrainDebug] runLODTerrainPass: chunkSizeTex=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, textureSize=${textureSize}, face=${face}, chunkCoord=(${chunkCoordX},${chunkCoordY})`);
        console.log(`[TerrainDebug] noiseProfileA=${JSON.stringify(uniforms.noiseProfileA)}, noiseRefRadius=${this.noiseReferenceRadiusM}, worldScale=${this.worldScale}`);
        }

        const data = new ArrayBuffer(512);
        const v = new DataView(data);

        v.setInt32(0,  chunkCoordX | 0, true);
        v.setInt32(4,  chunkCoordY | 0, true);
        v.setInt32(8,  chunkSizeTex | 0, true);
        v.setInt32(12, chunkGridSize | 0, true);
        v.setInt32(16, this.seed, true);

        v.setFloat32(20, this.macroConfig.biomeScale, true);
        v.setFloat32(24, this.macroConfig.regionScale, true);
        v.setFloat32(28, this.detailScale, true);
        v.setFloat32(32, this.ridgeScale, true);
        v.setFloat32(36, this.valleyScale, true);
        v.setFloat32(40, this.plateauScale, true);
        v.setFloat32(44, this.worldScale, true);

        v.setInt32(48, type, true);
        v.setInt32(52, face !== null ? (face | 0) : -1, true);

        v.setInt32(56, this.debugMode, true);
        v.setInt32(60, 0, true);

        const uniforms = this._getTerrainShaderUniforms();

        v.setFloat32(80,  uniforms.continentParams[0], true);
        v.setFloat32(84,  uniforms.continentParams[1], true);
        v.setFloat32(88,  uniforms.continentParams[2], true);
        v.setFloat32(92,  uniforms.continentParams[3], true);

        v.setFloat32(96,  uniforms.tectonicParams[0], true);
        v.setFloat32(100, uniforms.tectonicParams[1], true);
        v.setFloat32(104, uniforms.tectonicParams[2], true);
        v.setFloat32(108, uniforms.tectonicParams[3], true);

        v.setFloat32(112, uniforms.waterParams[0], true);
        v.setFloat32(116, uniforms.waterParams[1], true);
        v.setFloat32(120, uniforms.waterParams[2], true);
        v.setFloat32(124, uniforms.waterParams[3], true);

        v.setFloat32(128, uniforms.erosionParams[0], true);
        v.setFloat32(132, uniforms.erosionParams[1], true);
        v.setFloat32(136, uniforms.erosionParams[2], true);
        v.setFloat32(140, uniforms.erosionParams[3], true);

        v.setFloat32(144, uniforms.volcanicParams[0], true);
        v.setFloat32(148, uniforms.volcanicParams[1], true);
        v.setFloat32(152, uniforms.volcanicParams[2], true);
        v.setFloat32(156, uniforms.volcanicParams[3], true);

        v.setFloat32(160, uniforms.climateParams[0], true);
        v.setFloat32(164, uniforms.climateParams[1], true);
        v.setFloat32(168, uniforms.climateParams[2], true);
        v.setFloat32(172, uniforms.climateParams[3], true);
        this._writeTerrainPaddingUniforms(v, uniforms);
        this._writeClimateZoneUniforms(v, uniforms);

        if (this._logUniformsOnNextPass && type === 0) {
        this._logUniformsOnNextPass = false;
        console.log(`[TerrainDebug] Uniforms: chunkCoord=(${chunkCoordX},${chunkCoordY}), chunkSize=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, face=${face}`);
        console.log(`[TerrainDebug] noiseProfileA=[${uniforms.noiseProfileA}], noiseProfileB=[${uniforms.noiseProfileB}]`);
        }

        this.device.queue.writeBuffer(this.terrainUniformBuffer, 0, data);

        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();

        // ── Select pipeline based on required inputs ──
        const isMicroPass = (type === 4 || type === 5 || type === 6) && heightTex && tileTex;
        const isHeightInputPass =
            !isMicroPass && (type === 1 || type === 2) && heightTex;

        if (isMicroPass) {
        const { pipeline, bindGroupLayout } =
        this._getMicroPipelineForFormat(outputFormat);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
        { binding: 0,
         resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: heightTex.createView() },
        { binding: 3, resource: tileTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        } else if (isHeightInputPass) {
        const { pipeline, bindGroupLayout } =
        this._getHeightInputPipelineForFormat(outputFormat);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
        { binding: 0,
         resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: heightTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        } else {
        const { pipeline, bindGroupLayout } =
        this._getTerrainPipelineForFormat(outputFormat);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
        { binding: 0,
         resource: { buffer: this.terrainUniformBuffer } },
        { binding: 1, resource: outTex.createView() }
        ]
        }));
        this._setTerrainBiomeBindGroup(pass);
        }

        pass.dispatchWorkgroups(
        Math.ceil(textureSize / 8),
        Math.ceil(textureSize / 8));
        pass.end();
        this.device.queue.submit([enc.finish()]);
        },

        async runSplatPassAtlas(hTex, tTex, splatDataTex, splatIndexTex, atlasChunkX, atlasChunkY, w, h, chunkSize, heightFormat = 'r32float', tileFormat = 'r32float') {
                this._writeSplatUniformBuffer({
                    chunkCoordX: atlasChunkX,
                    chunkCoordY: atlasChunkY,
                    chunkSizeTex: chunkSize,
                    inputPadding: 0,
                });

                const paletteSize = this._getSplatPaletteDimensions(w, h, chunkSize);
                const splatPaletteTex = this.createGPUTexture(
                    paletteSize.width,
                    paletteSize.height,
                    'rgba8unorm'
                );
                const { pipeline: palettePipeline, bindGroupLayout: paletteBindGroupLayout } =
                    this._getSplatPalettePipelineForFormat(tileFormat);
                const { pipeline, bindGroupLayout } =
                    this._getSplatPipelineForFormats(heightFormat, tileFormat);
                const enc = this.device.createCommandEncoder();
                {
                    const pass = enc.beginComputePass();
                    pass.setPipeline(palettePipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: paletteBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                            { binding: 1, resource: tTex.createView() },
                            { binding: 2, resource: splatPaletteTex.createView() }
                        ]
                    }));
                    pass.dispatchWorkgroups(
                        Math.ceil(paletteSize.width / 8),
                        Math.ceil(paletteSize.height / 8)
                    );
                    pass.end();
                }
                {
                    const pass = enc.beginComputePass();
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                            { binding: 1, resource: hTex.createView() },
                            { binding: 2, resource: tTex.createView() },
                            { binding: 3, resource: splatDataTex.createView() },
                            { binding: 4, resource: splatIndexTex.createView() },
                            { binding: 5, resource: splatPaletteTex.createView() }
                        ]
                    }));
                    
                    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
                    pass.end();
                }
                this.device.queue.submit([enc.finish()]);
                this.device.queue.onSubmittedWorkDone()
                    .then(() => { try { splatPaletteTex.destroy(); } catch { /* ignore cleanup failure */ } })
                    .catch(() => {});
            },

        async runLODSplatPass(hTex, tTex, splatDataTex, splatIndexTex, chunkCoordX, chunkCoordY, worldCoverage, textureSize, lod, heightFormat = 'r32float', tileFormat = 'r32float') {
                const chunksPerAtlas = Math.max(1, Math.floor(worldCoverage / this.chunkSize));
                const chunkSizeTex = Math.max(1, Math.floor(textureSize / chunksPerAtlas));
                this._logLODSplatPass({
                    hTex,
                    tTex,
                    splatDataTex,
                    chunkCoordX,
                    chunkCoordY,
                    worldCoverage,
                    textureSize,
                    lod,
                    chunksPerAtlas,
                    chunkSizeTex
                });
            
                this._writeSplatUniformBuffer({
                    chunkCoordX,
                    chunkCoordY,
                    chunkSizeTex,
                    inputPadding: 0,
                });

                const paletteSize = this._getSplatPaletteDimensions(textureSize, textureSize, chunkSizeTex);
                const splatPaletteTex = this.createGPUTexture(
                    paletteSize.width,
                    paletteSize.height,
                    'rgba8unorm'
                );
                const { pipeline: palettePipeline, bindGroupLayout: paletteBindGroupLayout } =
                    this._getSplatPalettePipelineForFormat(tileFormat);
                const { pipeline, bindGroupLayout } =
                    this._getSplatPipelineForFormats(heightFormat, tileFormat);
                const enc = this.device.createCommandEncoder();
                this._encodeSplatPalettePass(enc, palettePipeline, paletteBindGroupLayout, tTex, splatPaletteTex, paletteSize);
                this._encodeLODSplatPass(
                    enc,
                    pipeline,
                    bindGroupLayout,
                    hTex,
                    tTex,
                    splatDataTex,
                    splatIndexTex,
                    splatPaletteTex,
                    textureSize
                );
                this.device.queue.submit([enc.finish()]);
                this._destroyTextureAfterSubmittedWork(splatPaletteTex);

                await this._maybeValidateSplatOutput(splatDataTex, tTex, textureSize, chunkSizeTex);
            },

        _logLODSplatPass({
                hTex,
                tTex,
                splatDataTex,
                chunkCoordX,
                chunkCoordY,
                worldCoverage,
                textureSize,
                lod,
                chunksPerAtlas,
                chunkSizeTex
            }) {
                if (this._splatPassLogCount === undefined) this._splatPassLogCount = 0;
                if (this._splatPassLogCount >= 5) return;

                this._splatPassLogCount++;
                Logger.info(`[SplatDebug] ═══════════════════════════════════════════════`);
                Logger.info(`[SplatDebug] runLODSplatPass #${this._splatPassLogCount}`);
                Logger.info(`[SplatDebug]   chunkCoord=(${chunkCoordX}, ${chunkCoordY})`);
                Logger.info(`[SplatDebug]   worldCoverage=${worldCoverage}`);
                Logger.info(`[SplatDebug]   this.chunkSize=${this.chunkSize}`);
                Logger.info(`[SplatDebug]   chunksPerAtlas=${chunksPerAtlas}`);
                Logger.info(`[SplatDebug]   chunkSizeTex=${chunkSizeTex}`);
                Logger.info(`[SplatDebug]   textureSize=${textureSize}`);
                Logger.info(`[SplatDebug]   lod=${lod}`);
                Logger.info(`[SplatDebug]   splatDensity=${this.splatDensity}`);
                Logger.info(`[SplatDebug]   splatKernelSize=${this.splatKernelSize}`);
                Logger.info(`[SplatDebug]   heightTex size=${hTex.width}x${hTex.height}`);
                Logger.info(`[SplatDebug]   tileTex size=${tTex.width}x${tTex.height}`);
                Logger.info(`[SplatDebug]   splatOutTex size=${splatDataTex.width}x${splatDataTex.height}`);

                const useAtlasExpected = textureSize > chunkSizeTex;
                Logger.info(`[SplatDebug]   shader useAtlas will be: ${useAtlasExpected}`);
                Logger.info(`[SplatDebug]   perChunkDim = chunkSizeTex * splatDensity = ${chunkSizeTex * this.splatDensity}`);

                if (chunkSizeTex >= textureSize) {
                    Logger.warn(`[SplatDebug]   ⚠️ chunkSizeTex >= textureSize! Only 1 chunk in atlas.`);
                    Logger.warn(`[SplatDebug]   ⚠️ Shader will treat entire texture as single chunk.`);
                }
                if (chunkSizeTex < 2) {
                    Logger.warn(`[SplatDebug]   ⚠️ chunkSizeTex < 2! Tile sampling will collapse.`);
                }
            },

        _encodeSplatPalettePass(enc, pipeline, bindGroupLayout, tileTexture, splatPaletteTex, paletteSize) {
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                        { binding: 1, resource: tileTexture.createView() },
                        { binding: 2, resource: splatPaletteTex.createView() }
                    ]
                }));
                pass.dispatchWorkgroups(
                    Math.ceil(paletteSize.width / 8),
                    Math.ceil(paletteSize.height / 8)
                );
                pass.end();
            },

        _encodeLODSplatPass(enc, pipeline, bindGroupLayout, heightTex, tileTex, splatDataTex, splatIndexTex, splatPaletteTex, textureSize) {
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                        { binding: 1, resource: heightTex.createView() },
                        { binding: 2, resource: tileTex.createView() },
                        { binding: 3, resource: splatDataTex.createView() },
                        { binding: 4, resource: splatIndexTex.createView() },
                        { binding: 5, resource: splatPaletteTex.createView() }
                    ]
                }));
                const splatW = splatDataTex.width || textureSize;
                const splatH = splatDataTex.height || textureSize;
                pass.dispatchWorkgroups(Math.ceil(splatW / 8), Math.ceil(splatH / 8));
                pass.end();
            },

        _destroyTextureAfterSubmittedWork(texture) {
                this.device.queue.onSubmittedWorkDone()
                    .then(() => { try { texture.destroy(); } catch { /* ignore cleanup failure */ } })
                    .catch(() => {});
            },

        async _maybeValidateSplatOutput(splatDataTex, tileTex, textureSize, chunkSizeTex) {
                if (this._splatReadbackCount === undefined) this._splatReadbackCount = 0;
                if (this._splatReadbackCount >= 3) return;

                this._splatReadbackCount++;
                try {
                    await this._debugValidateSplatOutput(splatDataTex, tileTex, textureSize, chunkSizeTex);
                } catch (err) {
                    Logger.warn(`[SplatDebug] Readback failed: ${err.message || err}`);
                }
            },

        async _debugValidateSplatOutput(splatGpuTex, tileGpuTex, textureSize, _chunkSizeTex) {
                const sampleSize = Math.min(64, textureSize);
                const regions = [
                    { x: 0, y: 0, label: 'top-left' },
                    { x: Math.max(0, Math.floor(textureSize / 2) - sampleSize / 2),
                      y: Math.max(0, Math.floor(textureSize / 2) - sampleSize / 2),
                      label: 'center' },
                    { x: Math.max(0, textureSize - sampleSize),
                      y: Math.max(0, textureSize - sampleSize),
                      label: 'bottom-right' }
                ];
            
                for (const region of regions) {
                    await this._readSplatDebugRegion(splatGpuTex, tileGpuTex, region, sampleSize);
                }
            },

        async _readSplatDebugRegion(splatGpuTex, tileGpuTex, region, sampleSize) {
                await this.readTextureWindowRGBA8Unorm(
                    splatGpuTex,
                    region.x,
                    region.y,
                    sampleSize,
                    sampleSize
                );
                await this.readTextureWindowR8Unorm(
                    tileGpuTex,
                    region.x,
                    region.y,
                    sampleSize,
                    sampleSize
                );
            },

        async _debugAnalyzeQuadtreeSplatPass(
                splatPass,
                paddedTileGpuTex,
                innerSize,
                paddedSize,
                padding,
                chunkCoordX,
                chunkCoordY,
                chunkGridSize,
                face,
                splatPrimePattern = null,
                debugProbeTextures = null,
                validationError = null
            ) {
                if (this._quadtreeSplatDiagCount === undefined) {
                    this._quadtreeSplatDiagCount = 0;
                }
                if (this._quadtreeSplatDiagCount >= 3) {
                    return;
                }
                this._quadtreeSplatDiagCount++;

                const sourceTile = await this._readTileTextureBytes(
                    splatPass.tileTex,
                    splatPass.tileFormat || 'r8unorm',
                    0,
                    0,
                    innerSize,
                    innerSize
                );
                const paddedTileRaw = await this.readTextureWindowRGBA8Unorm(
                    paddedTileGpuTex,
                    0,
                    0,
                    paddedSize,
                    paddedSize
                );
                const splatData = await this.readTextureWindowRGBA8Unorm(
                    splatPass.splatTex,
                    0,
                    0,
                    innerSize,
                    innerSize
                );

                let mismatchCount = 0;
                const mismatchSamples = [];
                const paddedInnerTile = new Uint8Array(innerSize * innerSize);
                for (let y = 0; y < innerSize; y++) {
                    for (let x = 0; x < innerSize; x++) {
                        const srcIdx = y * innerSize + x;
                        const padIdx = ((y + padding) * paddedSize + (x + padding)) * 4;
                        const paddedValue = paddedTileRaw[padIdx];
                        paddedInnerTile[srcIdx] = paddedValue;
                        if (paddedValue !== sourceTile[srcIdx]) {
                            mismatchCount++;
                            if (mismatchSamples.length < 6) {
                                mismatchSamples.push(
                                    `(${x},${y}) src=${sourceTile[srcIdx]} pad=${paddedValue}`
                                );
                            }
                        }
                    }
                }

                const sourceCategories = summarizeTileCategoryHistogram(sourceTile, this.tileCategories);
                const paddedCategories = summarizeTileCategoryHistogram(paddedInnerTile, this.tileCategories);
                const splatSummary = summarizeSplatData(splatData, innerSize);
                const emulatedSplatData = emulateSplatOutputFromPaddedTile(
                    paddedTileRaw,
                    paddedSize,
                    innerSize,
                    padding,
                    this.splatKernelSize,
                    this.tileCategories
                );
                const emulatedSummary = summarizeSplatData(emulatedSplatData, innerSize);
                const compareSummary = compareSplatOutputs(
                    splatData,
                    emulatedSplatData,
                    innerSize,
                    splatPrimePattern
                );
                let constantWriteProbeSummary = null;
                let tileEchoProbeSummary = null;
                let categoryEchoProbeSummary = null;
                if (debugProbeTextures) {
                    const constantWriteBytes = await this.readTextureWindowRGBA8Unorm(
                        debugProbeTextures.constantWrite,
                        0,
                        0,
                        innerSize,
                        innerSize
                    );
                    const tileEchoBytes = await this.readTextureWindowRGBA8Unorm(
                        debugProbeTextures.tileEcho,
                        0,
                        0,
                        innerSize,
                        innerSize
                    );
                    const categoryEchoBytes = await this.readTextureWindowRGBA8Unorm(
                        debugProbeTextures.categoryEcho,
                        0,
                        0,
                        innerSize,
                        innerSize
                    );
                    constantWriteProbeSummary = summarizeRGBA8Pixels(constantWriteBytes);
                    tileEchoProbeSummary = summarizeRGBA8Pixels(tileEchoBytes);
                    categoryEchoProbeSummary = summarizeRGBA8Pixels(categoryEchoBytes);
                }

                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug] Quadtree tile f${face} d≈${Math.round(Math.log2(Math.max(chunkGridSize, 1)))} ` +
                    `coord=(${chunkCoordX},${chunkCoordY}) inner=${innerSize} padded=${paddedSize} padding=${padding}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   source categories: ${formatCategorySummary(sourceCategories)}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   padded-inner categories: ${formatCategorySummary(paddedCategories)}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   padded-inner mismatches=${mismatchCount}/${innerSize * innerSize}` +
                    `${mismatchSamples.length ? ` samples=${mismatchSamples.join(' ; ')}` : ''}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   splat pairs: ${formatPairSummary(splatSummary.topPairs)} ` +
                    `boundary=${splatSummary.boundaryPct.toFixed(1)}% ` +
                    `stable4=${splatSummary.stable4Pct.toFixed(1)}% ` +
                    `weight=[${splatSummary.weightMin.toFixed(3)}, ${splatSummary.weightMax.toFixed(3)}] ` +
                    `avg=${splatSummary.weightMean.toFixed(3)}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   emulated pairs: ${formatPairSummary(emulatedSummary.topPairs)} ` +
                    `boundary=${emulatedSummary.boundaryPct.toFixed(1)}% ` +
                    `stable4=${emulatedSummary.stable4Pct.toFixed(1)}% ` +
                    `weight=[${emulatedSummary.weightMin.toFixed(3)}, ${emulatedSummary.weightMax.toFixed(3)}] ` +
                    `avg=${emulatedSummary.weightMean.toFixed(3)}`
                );
                Logger.info(
                    `${SPLAT_STEP_PREFIX} [SplatDebug]   compare: sentinel=${compareSummary.sentinelCount}/${compareSummary.totalPixels} ` +
                    `zero=${compareSummary.zeroCount}/${compareSummary.totalPixels} ` +
                    `fallback=${compareSummary.fallbackCount}/${compareSummary.totalPixels} ` +
                    `mismatch=${compareSummary.mismatchCount}/${compareSummary.totalPixels}` +
                    `${compareSummary.samples.length ? ` samples=${compareSummary.samples.join(' ; ')}` : ''}`
                );
                if (constantWriteProbeSummary) {
                    Logger.info(
                        `${SPLAT_STEP_PREFIX} [SplatDebug]   probe constant: ${formatRGBA8PixelSummary(constantWriteProbeSummary)}`
                    );
                }
                if (tileEchoProbeSummary) {
                    Logger.info(
                        `${SPLAT_STEP_PREFIX} [SplatDebug]   probe tile-echo: ${formatRGBA8PixelSummary(tileEchoProbeSummary)}`
                    );
                }
                if (categoryEchoProbeSummary) {
                    Logger.info(
                        `${SPLAT_STEP_PREFIX} [SplatDebug]   probe category-echo: ${formatRGBA8PixelSummary(categoryEchoProbeSummary)}`
                    );
                }
                if (validationError) {
                    Logger.warn(
                        `${SPLAT_STEP_PREFIX} [SplatDebug]   validation error: ${validationError.message || validationError}`
                    );
                }
            },

        async extractChunkDataFromAtlas(atlasKey, chunkX, chunkY, config, face = null) {
                const lod = atlasKey?.lod ?? 0;
                const heightAtlasData =
                    this.textureCache.getLODAtlasForChunk?.(chunkX, chunkY, 'height', lod, face, config) ||
                    this.textureCache.getAtlasForChunk?.(chunkX, chunkY, 'height', config, face);
                const tileAtlasData =
                    this.textureCache.getLODAtlasForChunk?.(chunkX, chunkY, 'tile', lod, face, config) ||
                    this.textureCache.getAtlasForChunk?.(chunkX, chunkY, 'tile', config, face);
                
                if (!heightAtlasData || !tileAtlasData) return null;

                const localPos = config.getLocalChunkPosition(chunkX, chunkY);
                const gpuHeightTex = heightAtlasData.texture._gpuTexture?.texture;
                const gpuTileTex = tileAtlasData.texture._gpuTexture?.texture;
                if (!gpuHeightTex || !gpuTileTex) return null;

                // Determine per-chunk texel dimensions for this LOD
                const lodCfg = config.getConfigForLOD ? config.getConfigForLOD(lod) : null;
                const atlasTextureSize = lodCfg
                    ? requireNumber(lodCfg.textureSize, 'lodAtlasConfig.textureSize')
                    : requireNumber(config.textureSize, 'config.textureSize');
                const chunksPerAtlas = lodCfg
                    ? requireInt(lodCfg.chunksPerAtlas, 'lodAtlasConfig.chunksPerAtlas', 1)
                    : requireInt(config.chunksPerAtlas, 'config.chunksPerAtlas', 1);
                const texelsPerChunk = Math.max(1, Math.floor(atlasTextureSize / chunksPerAtlas));

                const offsetX = localPos.localX * texelsPerChunk;
                const offsetY = localPos.localY * texelsPerChunk;

                try {
                    const heightData = await this.readTextureSubregion(
                        gpuHeightTex,
                        offsetX,
                        offsetY,
                        Math.min(texelsPerChunk + 1, atlasTextureSize - offsetX),
                        Math.min(texelsPerChunk + 1, atlasTextureSize - offsetY),
                        atlasTextureSize
                    );
                    const tileData = await this.readTextureSubregion(
                        gpuTileTex,
                        offsetX,
                        offsetY,
                        Math.min(texelsPerChunk, atlasTextureSize - offsetX),
                        Math.min(texelsPerChunk, atlasTextureSize - offsetY),
                        atlasTextureSize
                    );
                    return { heightData, tileData };
                } catch(e) { return null; }
            },

        async readTextureSubregion(gpuTex, offsetX, offsetY, width, height, textureWidth) {
                const textureHeight = textureWidth; 
                // RGBA32F = 16 bytes per pixel
                const bytesPerRow = textureWidth * 16;
                const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
                const bufferSize = alignedBytesPerRow * textureHeight;
                
                const readBuffer = this.device.createBuffer({
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });
                
                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: gpuTex },
                    { buffer: readBuffer, bytesPerRow: alignedBytesPerRow },
                    { width: textureWidth, height: textureHeight, depthOrArrayLayers: 1 }
                );
                this.device.queue.submit([encoder.finish()]);
                
                await readBuffer.mapAsync(GPUMapMode.READ);
                const fullData = new Float32Array(readBuffer.getMappedRange());
                const subregion = new Float32Array(width * height * 4);
                
                for (let y = 0; y < height; y++) {
                    const srcRow = offsetY + y;
                    const srcRowOffset = (srcRow * alignedBytesPerRow) / 4; 
                    for (let x = 0; x < width; x++) {
                        const srcIdx = srcRowOffset + (offsetX + x) * 4;
                        const dstIdx = (y * width + x) * 4;
                        subregion.set(fullData.subarray(srcIdx, srcIdx + 4), dstIdx);
                    }
                }
                
                readBuffer.unmap();
                readBuffer.destroy();
                return subregion;
            },

        async readTextureWindowR8Unorm(gpuTex, offsetX, offsetY, width, height) {
                const bytesPerPixel = 1;
                const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
                const bufferSize = rowStride * height;
                const readBuffer = this.device.createBuffer({
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });

                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
                    { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
                this.device.queue.submit([encoder.finish()]);

                await readBuffer.mapAsync(GPUMapMode.READ);
                const mapped = new Uint8Array(readBuffer.getMappedRange());
                const result = new Uint8Array(width * height);

                for (let y = 0; y < height; y++) {
                    const srcRowOffset = y * rowStride;
                    const dstRowOffset = y * width;
                    result.set(mapped.subarray(srcRowOffset, srcRowOffset + width), dstRowOffset);
                }

                readBuffer.unmap();
                readBuffer.destroy();
                return result;
            },

        async readTextureWindowRGBA8Unorm(gpuTex, offsetX, offsetY, width, height) {
                const bytesPerPixel = 4;
                const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
                const bufferSize = rowStride * height;
                const readBuffer = this.device.createBuffer({
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });

                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
                    { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
                this.device.queue.submit([encoder.finish()]);

                await readBuffer.mapAsync(GPUMapMode.READ);
                const mapped = new Uint8Array(readBuffer.getMappedRange());
                const result = new Uint8Array(width * height * 4);

                for (let y = 0; y < height; y++) {
                    const srcRowOffset = y * rowStride;
                    const dstRowOffset = y * width * 4;
                    result.set(
                        mapped.subarray(srcRowOffset, srcRowOffset + width * 4),
                        dstRowOffset
                    );
                }

                readBuffer.unmap();
                readBuffer.destroy();
                return result;
            },

        async _readTileTextureBytes(gpuTex, format, offsetX, offsetY, width, height) {
                if ((format || 'r8unorm') === 'rgba8unorm') {
                    const rgba = await this.readTextureWindowRGBA8Unorm(
                        gpuTex,
                        offsetX,
                        offsetY,
                        width,
                        height
                    );
                    const result = new Uint8Array(width * height);
                    for (let i = 0; i < result.length; i++) {
                        result[i] = rgba[i * 4];
                    }
                    return result;
                }
                return this.readTextureWindowR8Unorm(gpuTex, offsetX, offsetY, width, height);
            },

        _fillTextureRGBA8Unorm(gpuTex, width, height, rgba) {
                const bytesPerPixel = 4;
                const rowStride = Math.ceil((width * bytesPerPixel) / 256) * 256;
                const bufferSize = rowStride * height;
                const upload = new Uint8Array(bufferSize);
                const r = rgba?.[0] ?? 0;
                const g = rgba?.[1] ?? 0;
                const b = rgba?.[2] ?? 0;
                const a = rgba?.[3] ?? 0;

                for (let y = 0; y < height; y++) {
                    const rowOffset = y * rowStride;
                    for (let x = 0; x < width; x++) {
                        const i = rowOffset + x * 4;
                        upload[i] = r;
                        upload[i + 1] = g;
                        upload[i + 2] = b;
                        upload[i + 3] = a;
                    }
                }

                this.device.queue.writeTexture(
                    { texture: gpuTex },
                    upload,
                    { offset: 0, bytesPerRow: rowStride, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
            },

        async readTextureWindow(gpuTex, offsetX, offsetY, width, height) {
                const bytesPerPixel = 16; // rgba32float
                const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
                const bufferSize = rowStride * height;
                const readBuffer = this.device.createBuffer({
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });

                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
                    { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
                this.device.queue.submit([encoder.finish()]);

                await readBuffer.mapAsync(GPUMapMode.READ);
                const mapped = new Float32Array(readBuffer.getMappedRange());
                const result = new Float32Array(width * height * 4);

                for (let y = 0; y < height; y++) {
                    const srcRowOffset = (y * rowStride) / 4;
                    const dstRowOffset = y * width * 4;
                    result.set(mapped.subarray(srcRowOffset, srcRowOffset + width * 4), dstRowOffset);
                }

                readBuffer.unmap();
                readBuffer.destroy();
                return result;
            },

        async _debugLogAtlasStats(atlasKey, gpuTextures, textureSize, chunkGridSize, chunkCoordX, chunkCoordY) {
                if (this._debugAtlasLogCount >= this._debugAtlasLogBudget) return;
                this._debugAtlasLogCount++;

                const windowSize = Math.min(32, textureSize);
                const half = Math.floor(windowSize / 2);
                const offsets = [
                    { x: 0, y: 0, label: 'top-left' },
                    { x: Math.max(0, textureSize - windowSize), y: Math.max(0, textureSize - windowSize), label: 'bottom-right' },
                    { x: Math.max(0, Math.floor(textureSize / 2) - half), y: Math.max(0, Math.floor(textureSize / 2) - half), label: 'center' }
                ];

                const stats = [];
                for (const off of offsets) {
                    try {
                        const hData = await this.readTextureWindow(gpuTextures.height, off.x, off.y, windowSize, windowSize);
                        const tData = await this.readTextureWindowR8Unorm(gpuTextures.tile, off.x, off.y, windowSize, windowSize);

                        let hMin = Infinity, hMax = -Infinity;
                        for (let i = 0; i < hData.length; i += 4) {
                            const h = hData[i];
                            if (h < hMin) hMin = h;
                            if (h > hMax) hMax = h;
                        }

                        let tileMin = 255, tileMax = 0;
                        let waterCount = 0, landCount = 0;
                        for (let i = 0; i < tData.length; i += 1) {
                            const v = tData[i];
                            tileMin = Math.min(tileMin, v);
                            tileMax = Math.max(tileMax, v);
                            if (v === 2 || v === 1) waterCount++;
                            else landCount++;
                        }

                        stats.push({
                            label: off.label,
                            hMin, hMax,
                            tileMin, tileMax,
                            waterCount, landCount
                        });
                    } catch (err) {
                        Logger.warn(`[TerrainDebug] Failed to sample atlas ${atlasKey.toString()} window ${off.label}: ${err}`);
                    }
                }

                const uniformSnapshot = this._getTerrainShaderUniforms();
                Logger.info(`[TerrainDebug] Atlas ${atlasKey.toString()} texSize=${textureSize} chunksPerFace=${chunkGridSize} chunkCoord=(${chunkCoordX},${chunkCoordY}) ` +
                    `biomeScale=${this.macroConfig.biomeScale} regionScale=${this.macroConfig.regionScale} detailScale=${this.detailScale} ` +
                    `ridgeScale=${this.ridgeScale} plateauScale=${this.plateauScale} valleyScale=${this.valleyScale} worldScale=${this.worldScale} ` +
                    `uniforms.continents=${uniformSnapshot.continentParams?.join(',')} smallPlanet=${this._useSmallPlanetMode}`);
                stats.forEach(s => {
                    Logger.info(`[TerrainDebug]   window=${s.label} height[min,max]=[${s.hMin.toFixed(4)}, ${s.hMax.toFixed(4)}] ` +
                        `tile[min,max]=[${s.tileMin}, ${s.tileMax}] water=${s.waterCount} land=${s.landCount}`);
                });
            },

        wrapGPUTexture(gpuTex, w, h, formatOverride = 'rgba32float', useNearest = false) {
                const fmt = this._mapTextureFormat(formatOverride);
                const filterable = gpuFormatIsFilterable(formatOverride);
                // Caller's useNearest intent wins, but we also demote to nearest
                // if the format isn't hardware-filterable.
                const effectiveNearest = useNearest || !filterable;
                const filter = effectiveNearest ? TextureFilter.NEAREST : TextureFilter.LINEAR;
                const t = new Texture({
                    width: w, height: h,
                    format: fmt,
                    minFilter: filter,
                    magFilter: filter
                });
                t._gpuTexture = { texture: gpuTex, view: gpuTex.createView(), format: formatOverride };
                t._needsUpload = false;
                t._isGPUOnly = true;
                t._gpuFormat = formatOverride;
                t._isFilterable = filterable;
                return t;
            }
        })
    );
}
