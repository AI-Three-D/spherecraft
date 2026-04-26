import { Vector2, Vector3, Vector4 } from '../../../shared/math/index.js';
import { Material } from '../../renderer/resources/material.js';
import { requireBool, requireInt, requireNumber, requireObject } from '../../../shared/requireUtil.js';

export class TerrainMaterialBuilder {
    static _shaderBuilders = null;

    static async _loadShaderBuilders() {
        if (this._shaderBuilders) {
            return this._shaderBuilders;
        }
        try {
            const vertex = await import('./shaders/webgpu/terrainChunkVertexShaderBuilder.js');
            const fragment = await import('./shaders/webgpu/terrainChunkFragmentShaderBuilder.js');
            const overlay = await import('./shaders/webgpu/terrainChunkHoverOverlayFragmentShaderBuilder.js');

            if (!vertex.buildTerrainChunkVertexShader ||
                !fragment.buildTerrainChunkFragmentShader ||
                !overlay.buildTerrainChunkHoverOverlayFragmentShader) {
                throw new Error('WebGPU shader builders missing export functions');
            }

            this._shaderBuilders = {
                buildTerrainChunkVertexShader: vertex.buildTerrainChunkVertexShader,
                buildTerrainChunkFragmentShader: fragment.buildTerrainChunkFragmentShader,
                buildTerrainChunkHoverOverlayFragmentShader: overlay.buildTerrainChunkHoverOverlayFragmentShader,
            };
        } catch (e) {
            throw new Error(`Cannot load WebGPU shaders: ${e.message}`);
        }

        return this._shaderBuilders;
    }

    static async create(options) {
        return this._createMaterial(options, false);
    }

    static async createHoverOverlay(options) {
        return this._createMaterial(options, true);
    }

    static async _createMaterial(options, overlayPass = false) {
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
            const terrainAODefaults = requireObject(opts.terrainAODefaults, 'terrainAODefaults');
            const groundFieldDefaults = requireObject(opts.groundFieldDefaults, 'groundFieldDefaults');
            const tileCategories = opts.tileCategories;
            if (!Array.isArray(tileCategories)) {
                throw new Error('TerrainMaterialBuilder.create requires opts.tileCategories');
            }

            const builders = await this._loadShaderBuilders();

            // Enable texture arrays only if *all* streamed textures are array-backed.
            const textureList = [
                cachedTextures.height,
                cachedTextures.normal,
                cachedTextures.tile,
                cachedTextures.splatData,
                cachedTextures.splatIndex,
                cachedTextures.splatValid,
                cachedTextures.macro,
                cachedTextures.resolvedColor
            ];
            const presentTextures = textureList.filter(Boolean);
            const useArrayTextures = presentTextures.length > 0 && presentTextures.every(t => t?._isArray === true);
            const engineAO = planetConfig?.engineConfig?.terrainAO ?? null;
            const planetAO = planetConfig?.terrainAO ?? null;
            const terrainAOConfig = {
                ...terrainAODefaults,
                ...(engineAO || {}),
                ...(planetAO || {}),
            };

            const enableTerrainAO = terrainAOConfig.enabled ?? true;
            const macroLayerEnabled = terrainShaderConfig?.enableMacroLayer === false ? 0.0 : 1.0;
            const macroBlendStrength = Number.isFinite(terrainShaderConfig?.macroBlend)
                ? Math.max(0, Math.min(1, terrainShaderConfig.macroBlend))
                : 0.7;
            const macroNoiseWeight = Number.isFinite(terrainShaderConfig?.macroNoiseWeight)
                ? Math.max(0, terrainShaderConfig.macroNoiseWeight)
                : 0.3;
            const engineGroundField = planetConfig?.engineConfig?.groundFieldBake ?? null;
            const groundFieldConfig = {
                ...groundFieldDefaults,
                ...(engineGroundField || {}),
            };
            const groundFieldFallbackConfig = {
                ...(groundFieldDefaults.terrainFallback || {}),
                ...((groundFieldConfig.terrainFallback) || {}),
            };
            const enableGroundField =
                groundFieldFallbackConfig.enabled !== false &&
                cachedTextures.groundField?._isArray === true;

            const readGpuFormat = (tex) =>
                tex?._gpuFormat ?? tex?._gpuTexture?.format ?? 'rgba32float';
    
            const chunkTextureFormats = {
                height:     readGpuFormat(cachedTextures.height),
                normal:     readGpuFormat(cachedTextures.normal),
                tile:       readGpuFormat(cachedTextures.tile),
                splatData:  readGpuFormat(cachedTextures.splatData),
                splatIndex: readGpuFormat(cachedTextures.splatIndex),
                splatValid: cachedTextures.splatValid
                    ? readGpuFormat(cachedTextures.splatValid)
                    : 'rgba8unorm',
                macro:      readGpuFormat(cachedTextures.macro),
                resolvedColor: readGpuFormat(cachedTextures.resolvedColor),
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
            const resolvedColorStartLod = Number.isFinite(terrainShaderConfig?.resolvedColorStartLod)
                ? Math.floor(terrainShaderConfig.resolvedColorStartLod)
                : 2;
            const enableResolvedColor =
                !overlayPass &&
                terrainShaderConfig?.resolvedColorEnabled !== false &&
                resolvedColorStartLod >= 0 &&
                lod >= resolvedColorStartLod &&
                cachedTextures.resolvedColor?._isArray === true;


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
                tileCategories,
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
                enableResolvedColor,
            };
            const useStorageBuffer = enableInstancing && useStorageBufferInstancing;
            const vertexShader = builders.buildTerrainChunkVertexShader({
                instanced: enableInstancing,
                useArrayTextures,
                lodSegments,
                useTransitionTopology,
                useStorageBuffer,
                debugMode: debugVertexMode
            });
            const fragmentShader = overlayPass
                ? builders.buildTerrainChunkHoverOverlayFragmentShader(shaderOptions)
                : builders.buildTerrainChunkFragmentShader(shaderOptions);

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
            if (enableResolvedColor) {
                defines.USE_RESOLVED_COLOR = true;
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
            planetCenter: { value: new Vector3(origin.x, origin.y, origin.z) },
            atmospherePlanetRadius: { value: atmo.planetRadius },
            atmosphereRadius: { value: atmo.atmosphereRadius },
            atmosphereScaleHeightRayleigh: { value: atmo.scaleHeightRayleigh },
            atmosphereScaleHeightMie: { value: atmo.scaleHeightMie },
            atmosphereRayleighScattering: { value: atmo.rayleighScattering.clone() },
            atmosphereMieScattering: { value: atmo.mieScattering },
            atmosphereMieAnisotropy: { value: atmo.mieAnisotropy },
            atmosphereSunIntensity: { value: atmo.sunIntensity },

            // === BASIC CHUNK ===
            chunkOffset: { value: new Vector2(chunkOffsetX, chunkOffsetZ) },
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
            enableMacroLayer: { value: macroLayerEnabled },
            enableClusteredLights: { value: 1.0 },
            useInstancing: { value: enableInstancing ? 1.0 : 0.0 },
// === CHUNK TEXTURES ===
heightTexture: { value: cachedTextures.height },
normalTexture: { value: cachedTextures.normal },
tileTexture: { value: cachedTextures.tile },
splatDataMap: { value: cachedTextures.splatData },
splatIndexMap: { value: cachedTextures.splatIndex },
splatValidMap: { value: cachedTextures.splatValid },
macroMaskTexture: { value: cachedTextures.macro },
resolvedColorTexture: { value: cachedTextures.resolvedColor },
            // === LOOKUP TABLES ===
            tileTypeLookup: { value: lookupTables.tileTypeLookup },
            macroTileTypeLookup: { value: lookupTables.macroTileTypeLookup },
            numVariantsTex: { value: lookupTables.numVariantsTex },

            // === ATLAS TEXTURES ===
            atlasTexture: { value: atlasTextures.micro },
            atlasTextureSize: {
                value: new Vector2(
                    atlasTextures.micro?.image?.width || atlasTextures.micro?.width || 1024,
                    atlasTextures.micro?.image?.height || atlasTextures.micro?.height || 1024
                )
            },
            level2AtlasTexture: { value: atlasTextures.macro },
            level2AtlasTextureSize: {
                value: new Vector2(
                    atlasTextures.macro?.image?.width || atlasTextures.macro?.width || 1024,
                    atlasTextures.macro?.image?.height || atlasTextures.macro?.height || 1024
                )
            },

            // === MATERIAL SETTINGS ===
            macroScale: { value: 1.0 / Math.max(1, planetConfig.macroTileSpan ?? 4) },
            macroMaxLOD: { value: planetConfig.macroMaxLOD ?? 0 },
            level2Blend: { value: macroBlendStrength },
            macroNoiseWeight: { value: macroNoiseWeight },
            terrainDebugMode: { value: debugMode },
            terrainLayerViewMode: { value: 0 },
            
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
            planetOrigin: { value: new Vector3(origin.x, origin.y, origin.z) },
            chunkFace: { value: isSpherical ? faceIndex : -1 },
            chunkLocation: { value: new Vector2(chunkLocationU, chunkLocationV) },
            chunkSizeUV: { value: chunkSizeUV },

            // Height displacement scale
            heightScale: { value: heightScale },

            // LOD map for GPU-based edge stitching
            chunksPerFace: { value: chunksPerFace },

            // =============================================
            // ATLAS UV TRANSFORM
            // =============================================
            useAtlasMode: { value: useAtlasMode ? 1 : 0 },
            atlasUVOffset: { value: new Vector2(
                uvTransform?.offsetX || 0,
                uvTransform?.offsetY || 0
            )},
            atlasUVScale: { value: uvTransform?.scale || 1.0 },
        };

        if (overlayPass) {
            uniforms.terrainHoverFace = { value: -1 };
            uniforms.terrainHoverFlags = { value: 0 };
            uniforms.terrainHoverMicroRect = { value: new Vector4(0, 0, 0, 0) };
            uniforms.terrainHoverMacroRect = { value: new Vector4(0, 0, 0, 0) };
            uniforms.terrainHoverMicroColor = { value: new Vector4(1.0, 0.42, 0.42, 1.5) };
            uniforms.terrainHoverMacroColor = { value: new Vector4(0.42, 0.64, 1.0, 2.0) };
        }

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

        const vertexLayout = [
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

        const material = new Material({
            name: overlayPass ? 'TerrainHoverOverlayMaterial' : 'TerrainMaterial',
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms,
            defines,
            storageBuffers: useStorageBuffer ? { chunkInstances: null } : null,
            side: 'back',
            depthTest: true,
            depthWrite: overlayPass ? false : true,
            depthCompare: overlayPass ? 'less-equal' : 'less',
            transparent: overlayPass,
            isInstanced: true,
            vertexLayout: vertexLayout,
        });

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
