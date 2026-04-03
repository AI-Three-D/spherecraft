import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Material } from '../../renderer/resources/material.js';
import { requireBool, requireInt, requireNumber, requireObject } from '../../../shared/requireUtil.js';
import { TERRAIN_AO_CONFIG, GROUND_FIELD_BAKE_CONFIG } from '../../renderer/streamer/streamerConfig.js';

export class TerrainMaterialBuilder {
    static _shaderBuilders = new Map();

    static async _loadShaderBuilders(apiName) {
        if (this._shaderBuilders.has(apiName)) {
            return this._shaderBuilders.get(apiName);
        }
        let builders;
        if (apiName === 'webgpu') {
            try {
                const vertex = await import('./shaders/webgpu/terrainChunkVertexShaderBuilder.js');
                const fragment = await import('./shaders/webgpu/terrainChunkFragmentShaderBuilder.js');

                if (!vertex.buildTerrainChunkVertexShader || !fragment.buildTerrainChunkFragmentShader) {
                    throw new Error('WebGPU shader builders missing export functions');
                }

                builders = {
                    buildTerrainChunkVertexShader: vertex.buildTerrainChunkVertexShader,
                    buildTerrainChunkFragmentShader: fragment.buildTerrainChunkFragmentShader
                };

            } catch (e) {
                throw new Error(`Cannot load WebGPU shaders: ${e.message}`);
            }
        } else {
            throw new Error('WebGL2 terrain shaders are no longer supported');
        }

        this._shaderBuilders.set(apiName, builders);
        return builders;
    }


        static async create(options) {
            
            const opts = requireObject(options, 'options');
            const backend = requireObject(opts.backend, 'backend');
            const atlasTextures = requireObject(opts.atlasTextures, 'atlasTextures');
            const lookupTables = requireObject(opts.lookupTables, 'lookupTables');
            const cachedTextures = requireObject(opts.cachedTextures, 'cachedTextures');
            const chunkOffsetX = requireNumber(opts.chunkOffsetX, 'chunkOffsetX');
            const chunkOffsetZ = requireNumber(opts.chunkOffsetZ, 'chunkOffsetZ');
            const chunkSize = requireNumber(opts.chunkSize, 'chunkSize');
            const environmentState = requireObject(opts.environmentState, 'environmentState');
            const uniformManager = opts.uniformManager ?? null;
            const faceIndex = requireInt(opts.faceIndex, 'faceIndex');
            const faceU = requireInt(opts.faceU, 'faceU');
            const faceV = requireInt(opts.faceV, 'faceV');
            const faceSize = requireInt(opts.faceSize, 'faceSize', 1);
            const planetConfig = requireObject(opts.planetConfig, 'planetConfig');
            const useAtlasMode = requireBool(opts.useAtlasMode, 'useAtlasMode');
            const uvTransform = opts.uvTransform ?? null;
            const heightScale = requireNumber(opts.heightScale, 'heightScale');
            const lod = requireInt(opts.lod, 'lod', 0);
            const terrainShaderConfig = opts.terrainShaderConfig ?? null;
            const enableInstancing = requireBool(opts.enableInstancing, 'enableInstancing');
            const useStorageBufferInstancing = requireBool(opts.useStorageBufferInstancing, 'useStorageBufferInstancing');
            const chunksPerFace = requireInt(opts.chunksPerFace, 'chunksPerFace', 1);
            const lodSegments = opts.lodSegments ?? null;
            const useTransitionTopology = opts.useTransitionTopology === true;
            const transmittanceLUT = opts.transmittanceLUT ?? null;
            const aerialPerspectiveEnabled = requireNumber(opts.aerialPerspectiveEnabled, 'aerialPerspectiveEnabled');
            const debugMode = Number.isFinite(opts.debugMode) ? Math.floor(opts.debugMode) : 0;
            const debugVertexMode = Number.isFinite(opts.debugVertexMode) ? Math.floor(opts.debugVertexMode) : 0;

            let apiName = 'webgl2';
            if (backend && typeof backend.getAPIName === 'function') {
                apiName = backend.getAPIName();
            } else if (backend && backend.device) {
                apiName = 'webgpu';
            }

            const builders = await this._loadShaderBuilders(apiName);

            // Enable texture arrays only if *all* streamed textures are array-backed.
            const textureList = [
                cachedTextures.height,
                cachedTextures.normal,
                cachedTextures.tile,
                cachedTextures.splatData,
                cachedTextures.macro
            ];
            const presentTextures = textureList.filter(Boolean);
            const useArrayTextures = presentTextures.length > 0 && presentTextures.every(t => t?._isArray === true);
            const engineAO = planetConfig?.engineConfig?.terrainAO ?? null;
            const planetAO = planetConfig?.terrainAO ?? null;
            const terrainAOConfig = {
                ...TERRAIN_AO_CONFIG,
                ...(engineAO || {}),
                ...(planetAO || {}),
            };

            const enableTerrainAO = terrainAOConfig.enabled ?? true;
            const engineGroundField = planetConfig?.engineConfig?.groundFieldBake ?? null;
            const groundFieldConfig = {
                ...GROUND_FIELD_BAKE_CONFIG,
                ...(engineGroundField || {}),
            };
            const groundFieldFallbackConfig = {
                ...(GROUND_FIELD_BAKE_CONFIG.terrainFallback || {}),
                ...((groundFieldConfig.terrainFallback) || {}),
            };
            const enableGroundField =
                groundFieldFallbackConfig.enabled !== false &&
                cachedTextures.groundField?._isArray === true;

            const readGpuFormat = (tex) =>
                tex?._gpuFormat ?? tex?._gpuTexture?.format ?? 'rgba32float';
    
            const chunkTextureFormats = {
                height:    readGpuFormat(cachedTextures.height),
                normal:    readGpuFormat(cachedTextures.normal),
                tile:      readGpuFormat(cachedTextures.tile),
                splatData: readGpuFormat(cachedTextures.splatData),
                macro:     readGpuFormat(cachedTextures.macro),
            };

            if (enableTerrainAO) {
                chunkTextureFormats.terrainAO = readGpuFormat(cachedTextures.terrainAO);
            }
            if (enableGroundField) {
                chunkTextureFormats.groundField = readGpuFormat(cachedTextures.groundField);
            }
    
            // Whether the normal texture can use a hardware filtering sampler.
            // When true, the fragment shader uses textureSample instead of
            // the manual 4-tap bilinear. When false (e.g. rgba32float), the
            // shader falls back to the textureLoad path.
            const normalTextureFilterable =
                cachedTextures.normal?._isFilterable === true;


            const grassConfig = planetConfig?.grassConfig ?? null;
            const grassTileTypeIds = [];
            if (grassConfig?.types) {
                for (const type of Object.values(grassConfig.types)) {
                    const tileId = type?.tileTypeId;
                    if (Number.isFinite(tileId)) {
                        grassTileTypeIds.push(Math.round(tileId));
                    }
                }
            }
            const uniqueGrassTileTypeIds = [...new Set(grassTileTypeIds)];
            let grassShadowStrength = 0.18;
            if (Number.isFinite(grassConfig?.terrainShadowStrength)) {
                grassShadowStrength = Math.min(1, Math.max(0, grassConfig.terrainShadowStrength));
            }


            const shaderOptions = {
                maxLightIndices: 8192,
                useArrayTextures,
                grassTileTypeIds: uniqueGrassTileTypeIds,
                grassShadowStrength,
                debugMode,
                lod,
                terrainShaderConfig,
                terrainAOAmbientFloor: terrainAOConfig.ambientFloor ?? 0.65,
                enableGroundField,
                groundFieldTintStrength: groundFieldFallbackConfig.tintStrength ?? 0.32,
                groundFieldGrassTint: groundFieldFallbackConfig.grassTint ?? [0.22, 0.33, 0.12],
                groundFieldFernTint: groundFieldFallbackConfig.fernTint ?? [0.10, 0.24, 0.07],
                // Compile-time kill switch. Runtime strength handles fine-tuning;
                // this removes the sample + bind entirely for distant-LOD pipelines
                // where the mask is below representable frequency anyway.
                enableTerrainAO,
                normalTextureFilterable,
            };
            const useStorageBuffer = enableInstancing && useStorageBufferInstancing && apiName === 'webgpu';
            const vertexShader = builders.buildTerrainChunkVertexShader({
                instanced: enableInstancing,
                useArrayTextures,
                lodSegments,
                useTransitionTopology,
                useStorageBuffer,
                debugMode: debugVertexMode
            });
            const fragmentShader = builders.buildTerrainChunkFragmentShader(shaderOptions);

            const isSpherical = faceIndex >= 0 && faceIndex <= 5;
            const chunkSizeUV = 1.0 / faceSize;
            const chunkLocationU = faceU * chunkSizeUV;
            const chunkLocationV = faceV * chunkSizeUV;

            // Normalize planetary configuration once for uniform access
            const pConfig = planetConfig;
            const atmo = requireObject(pConfig.atmosphereSettings, 'planetConfig.atmosphereSettings');
            const radius = requireNumber(pConfig.radius, 'planetConfig.radius');
            const origin = requireObject(pConfig.origin, 'planetConfig.origin');

            // Build defines - these MUST be set for textures to work
            const defines = {};

            if (cachedTextures.height) {
                defines.USE_HEIGHT_TEXTURE = true;
            }
            if (cachedTextures.normal) {
                defines.USE_NORMAL_TEXTURE = true;
            }
            if (cachedTextures.tile) {
                defines.USE_TILE_TEXTURE = true;
            }
            if (useArrayTextures) {
                defines.USE_TEXTURE_ARRAYS = true;
            }
            if (enableTerrainAO) {
                defines.USE_TERRAIN_AO = true;
            }
            if (enableGroundField) {
                defines.USE_GROUND_FIELD = true;
            }

        // =============================================
        // Build ALL uniforms
        // =============================================
        const uniforms = {
            //AO
            terrainAOMask:     { value: cachedTextures.terrainAO ?? null },
            groundFieldMask:   { value: cachedTextures.groundField ?? null },
            terrainAOStrength: {
                value: terrainAOConfig.sampleStrength ?? 1.0
            },
            // How much AO leaks into direct sunlight. 0 = textbook
            // ambient-only (invisible). 1 = AO treats sun same as sky
            // (too dark, looks like dirt). ~0.5 is where trees look right.
            terrainAODirectStrength: {
                value: terrainAOConfig.directStrength ?? 0.9
            },
            // Aerial Perspective / Atmosphere
            transmittanceLUT: { value: transmittanceLUT },
            aerialPerspectiveEnabled: { value: aerialPerspectiveEnabled },
            planetCenter: { value: new THREE.Vector3(origin.x, origin.y, origin.z) },
            atmospherePlanetRadius: { value: atmo.planetRadius },
            atmosphereRadius: { value: atmo.atmosphereRadius },
            atmosphereScaleHeightRayleigh: { value: atmo.scaleHeightRayleigh },
            atmosphereScaleHeightMie: { value: atmo.scaleHeightMie },
            atmosphereRayleighScattering: { value: atmo.rayleighScattering.clone() },
            atmosphereMieScattering: { value: atmo.mieScattering },
            atmosphereMieAnisotropy: { value: atmo.mieAnisotropy },
            atmosphereSunIntensity: { value: atmo.sunIntensity },

            // === BASIC CHUNK ===
            chunkOffset: { value: new THREE.Vector2(chunkOffsetX, chunkOffsetZ) },
            chunkSize: { value: chunkSize },
            chunkWidth: { value: chunkSize },
            chunkHeight: { value: chunkSize },
            maxTileTypes: { value: 256 },

            // === LOD SETTINGS ===
            lodLevel: { value: 0 },
            geometryLOD: { value: lod },
            splatLODBias: { value: 0.0 },
            macroLODBias: { value: 0.0 },
            detailFade: { value: 1.0 },
            enableSplatLayer: { value: 1.0 },
            enableMacroLayer: { value: 1.0 },
            enableClusteredLights: { value: 1.0 },
            useInstancing: { value: enableInstancing ? 1.0 : 0.0 },

            // === CHUNK TEXTURES ===
            heightTexture: { value: cachedTextures.height },
            normalTexture: { value: cachedTextures.normal },
            tileTexture: { value: cachedTextures.tile },
            splatDataMap: { value: cachedTextures.splatData },
            macroMaskTexture: { value: cachedTextures.macro },

            // === LOOKUP TABLES ===
            tileTypeLookup: { value: lookupTables.tileTypeLookup },
            macroTileTypeLookup: { value: lookupTables.macroTileTypeLookup },
            numVariantsTex: { value: lookupTables.numVariantsTex },

            // === ATLAS TEXTURES ===
            atlasTexture: { value: atlasTextures.micro },
            atlasTextureSize: {
                value: new THREE.Vector2(
                    atlasTextures.micro?.image?.width || atlasTextures.micro?.width || 1024,
                    atlasTextures.micro?.image?.height || atlasTextures.micro?.height || 1024
                )
            },
            level2AtlasTexture: { value: atlasTextures.macro },
            level2AtlasTextureSize: {
                value: new THREE.Vector2(
                    atlasTextures.macro?.image?.width || atlasTextures.macro?.width || 1024,
                    atlasTextures.macro?.image?.height || atlasTextures.macro?.height || 1024
                )
            },

            // === MATERIAL SETTINGS ===
            macroScale: { value: 1.0 / Math.max(1, planetConfig.macroTileSpan ?? 4) },
            macroMaxLOD: { value: planetConfig.macroMaxLOD ?? 0 },
            level2Blend: { value: 0.0},
            macroNoiseWeight: { value: 0.3 },
            terrainDebugMode: { value: debugMode },
            
            tileScale: { value: 1.0 },
            isFeature: { value: 0.0 },

            // === SEASON ===
            numSeasons: { value: 4 },
            currentSeason: { value: 0 },
            nextSeason: { value: 1 },
            seasonTransition: { value: 0.0 },

            blendModeTable:   { value: lookupTables.blendModeTable   ?? null },
    
            // =============================================
            // SPHERICAL PROJECTION UNIFORMS
            // =============================================
            planetRadius: { value: radius },
            planetOrigin: { value: new THREE.Vector3(origin.x, origin.y, origin.z) },
            chunkFace: { value: isSpherical ? faceIndex : -1 },
            chunkLocation: { value: new THREE.Vector2(chunkLocationU, chunkLocationV) },
            chunkSizeUV: { value: chunkSizeUV },

            // Height displacement scale
            heightScale: { value: heightScale },

            // LOD map for GPU-based edge stitching
            chunksPerFace: { value: chunksPerFace },

            // =============================================
            // ATLAS UV TRANSFORM
            // =============================================
            useAtlasMode: { value: useAtlasMode ? 1 : 0 },
            atlasUVOffset: { value: new THREE.Vector2(
                uvTransform?.offsetX || 0,
                uvTransform?.offsetY || 0
            )},
            atlasUVScale: { value: uvTransform?.scale || 1.0 },
        };

        // =============================================
        // Clone global uniforms from UniformManager
        // =============================================
        if (uniformManager && uniformManager.uniforms) {
            const globalUniforms = uniformManager.uniforms;
            const globalUniformsToClone = [
                'modelMatrix', 'viewMatrix', 'projectionMatrix',
                'sunLightColor', 'sunLightIntensity', 'sunLightDirection',
                'moonLightColor', 'moonLightIntensity', 'moonLightDirection',
                'ambientLightColor', 'ambientLightIntensity',
                'skyAmbientColor', 'groundAmbientColor',
                'thunderLightIntensity', 'thunderLightColor', 'thunderLightPosition',
                'playerLightColor', 'playerLightIntensity',
                'playerLightPosition', 'playerLightDistance',
                'fogColor', 'fogDensity', 'fogScaleHeight',
                'weatherIntensity', 'currentWeather',
                'shadowMapCascade0', 'shadowMapCascade1', 'shadowMapCascade2',
                'shadowMatrixCascade0', 'shadowMatrixCascade1', 'shadowMatrixCascade2',
                'cascadeSplits', 'numCascades',
                'shadowBias', 'shadowNormalBias', 'shadowMapSize', 'receiveShadow',
                'cameraPosition', 'cameraNear', 'cameraFar',
                'clusterDimensions', 'clusterDataTexture',
                'lightDataTexture', 'lightIndicesTexture',
                'numLights', 'maxLightsPerCluster'
            ];

            for (const key of globalUniformsToClone) {
                if (globalUniforms[key] && !uniforms[key]) {
                    uniforms[key] = {
                        value: this._cloneUniformValue(globalUniforms[key].value)
                    };
                }
            }
        }

        let vertexLayout = null;
        if (apiName === 'webgpu') {
            vertexLayout = [
                {
                    arrayStride: 12,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]
                },
                {
                    arrayStride: 12,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }]
                },
                {
                    arrayStride: 8,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }]
                }
            ];
            if (enableInstancing && !useStorageBuffer) {
                vertexLayout.push(
                    { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
                    { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
                    { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x4' }] },
                    { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 6, offset: 0, format: 'float32' }] }
                );
            }
        }

        const material = new Material({
            name: 'TerrainMaterial',
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms,
            defines,
            storageBuffers: useStorageBuffer ? { chunkInstances: null } : null,
            side: 'back',
            depthTest: true,
            depthWrite: true,
            isInstanced: true,
            vertexLayout: vertexLayout,
        });

        material._apiName = apiName;
        material._normalTextureFormat = this._getGPUFormatForTexture(cachedTextures.normal) || 'rgba32float';
        material._chunkTextureFormats = chunkTextureFormats;
        // Back-compat with the previous simpler field.
        material._normalTextureFormat = chunkTextureFormats.normal;
        return material;
    }

    static _getGPUFormatForTexture(texture) {
        // Read the GPU format that was actually used when the texture was created.
        // TileArrayPool stores this in _gpuTexture.format.
        return texture?._gpuTexture?.format ?? null;
    }

    static _cloneUniformValue(value) {
        if (value === null || value === undefined) return value;
        if (value.isVector2) return value.clone();
        if (value.isVector3) return value.clone();
        if (value.isVector4) return value.clone();
        if (value.isColor) return value.clone();
        if (value.isMatrix3) return value.clone();
        if (value.isMatrix4) return value.clone();
        if (Array.isArray(value)) return [...value];
        if (ArrayBuffer.isView(value)) return value.slice();
        return value;
    }
}
