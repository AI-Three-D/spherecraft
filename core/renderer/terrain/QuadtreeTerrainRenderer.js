// js/renderer/terrain/QuadtreeTerrainRenderer.js
//
// Renders terrain driven by the GPU quadtree tile manager.
// Pure rendering concern: builds geometries/materials, consumes
// instance + indirect buffers from the tile manager, issues draw calls.

import { Matrix4, Vector4 } from '../../../shared/math/index.js';
import { TerrainGeometryBuilder } from '../../mesh/terrain/terrainGeometryBuilder.js';
import { TerrainMaterialBuilder } from '../../mesh/terrain/terrainMaterialBuilder.js';
import { Logger } from '../../../shared/Logger.js';

export class QuadtreeTerrainRenderer {
    constructor(options = {}) {
        if (!options.terrainAODefaults) {
            throw new Error('QuadtreeTerrainRenderer requires options.terrainAODefaults');
        }
        if (!options.groundFieldDefaults) {
            throw new Error('QuadtreeTerrainRenderer requires options.groundFieldDefaults');
        }
        if (!Array.isArray(options.tileCategories)) {
            throw new Error('QuadtreeTerrainRenderer requires options.tileCategories');
        }
        this.terrainAODefaults = options.terrainAODefaults;
        this.groundFieldDefaults = options.groundFieldDefaults;
        this.tileCategories = options.tileCategories;
        this.backend = options.backend || null;
        this.tileManager = options.tileManager || null;
        this.engineConfig = options.engineConfig || null;
        this.planetConfig = options.planetConfig || null;
        this.textureManager = options.textureManager || null;
        this.uniformManager = options.uniformManager || null;
        this._atmosphereLUT = null;
        this._geometries = new Map();
        this._materials = new Map();
        this._overlayMaterials = new Map();
        this._lodIndexCounts = [];
        this._lodSegments = null;
        this._maxGeomLOD = 0;
        this._initialized = false;
        this._terrainLayerViewMode = 0;
        this._terrainHoverOverlay = {
            face: -1,
            flags: 0,
            microRect: new Vector4(0, 0, 0, 0),
            macroRect: new Vector4(0, 0, 0, 0),
            microColor: new Vector4(1.0, 0.42, 0.42, 1.5),
            macroColor: new Vector4(0.42, 0.64, 1.0, 2.0),
        };
    }

    async initialize() {
        const baseSegments = this.engineConfig.chunkSegments;
        this._lodSegments = TerrainGeometryBuilder.buildSegmentArray(baseSegments);
        this._maxGeomLOD = this.tileManager?.maxGeomLOD ??
            Math.max(0, this._lodSegments.length - 1);

        await this._buildGeometriesAndMaterials();

        // Feed index counts back to the tile manager so indirect draw args are correct
        this.tileManager?.updateLodIndexCounts(this._lodIndexCounts);

        this._initialized = true;
        Logger.info('[QuadtreeTerrainRenderer] Initialized');
    }

    get geometries() {
        return this._geometries;
    }

    get maxGeomLOD() {
        return this._maxGeomLOD;
    }

    get lodIndexCounts() {
        return this._lodIndexCounts;
    }

    setAtmosphereLUT(lut) {
        this._atmosphereLUT = lut || null;
    }

    setTerrainHoverOverlay(overlay = null) {
        const next = overlay && typeof overlay === 'object' ? overlay : {};
        const flags =
            (next.microRect ? 1 : 0) |
            (next.macroRect ? 2 : 0);

        this._terrainHoverOverlay.face = Number.isInteger(next.face) ? next.face : -1;
        this._terrainHoverOverlay.flags = this._terrainHoverOverlay.face >= 0 ? flags : 0;

        const copyRect = (target, rect) => {
            if (!rect) {
                target.set(0, 0, 0, 0);
                return;
            }
            target.set(
                rect.minX ?? rect.minU01 ?? 0,
                rect.minY ?? rect.minV01 ?? 0,
                rect.maxX ?? rect.maxU01 ?? 0,
                rect.maxY ?? rect.maxV01 ?? 0
            );
        };
        copyRect(this._terrainHoverOverlay.microRect, next.microRect);
        copyRect(this._terrainHoverOverlay.macroRect, next.macroRect);
    }

    setTerrainLayerViewMode(mode = 0) {
        if (typeof mode === 'string') {
            if (mode === 'micro') {
                this._terrainLayerViewMode = 1;
                return;
            }
            if (mode === 'macro') {
                this._terrainLayerViewMode = 2;
                return;
            }
            this._terrainLayerViewMode = 0;
            return;
        }
        const numericMode = Number.isFinite(mode) ? Math.max(0, Math.min(2, Math.trunc(mode))) : 0;
        this._terrainLayerViewMode = numericMode;
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._initialized || !this.tileManager?.isReady()) return;

        const instanceBuffer = this.tileManager.getInstanceBuffer();
        const indirectBuffer = this.tileManager.getIndirectArgsBuffer();
        const overlayEnabled = this._isHoverOverlayEnabled();

        for (let lod = 0; lod <= this._maxGeomLOD; lod++) {
            this._drawTerrainLod(
                lod,
                camera,
                viewMatrix,
                projectionMatrix,
                instanceBuffer,
                indirectBuffer,
                overlayEnabled
            );
        }
    }

    _isHoverOverlayEnabled() {
        return this._terrainHoverOverlay.face >= 0 && this._terrainHoverOverlay.flags !== 0;
    }

    _drawTerrainLod(lod, camera, viewMatrix, projectionMatrix, instanceBuffer, indirectBuffer, overlayEnabled) {
        const geo = this._geometries.get(lod);
        const mat = this._materials.get(lod);
        if (!geo || !mat) return;

        this._bindChunkInstances(mat, instanceBuffer);
        this._applyMaterialUniforms(mat, camera, viewMatrix, projectionMatrix, lod);

        const offset = this.tileManager.getIndirectArgsOffsetBytes(lod);
        this.backend.drawIndexedIndirect(geo, mat, indirectBuffer, offset);

        if (overlayEnabled) {
            this._drawTerrainOverlay(lod, geo, camera, viewMatrix, projectionMatrix, instanceBuffer, indirectBuffer, offset);
        }
    }

    _drawTerrainOverlay(lod, geo, camera, viewMatrix, projectionMatrix, instanceBuffer, indirectBuffer, offset) {
        const overlayMat = this._overlayMaterials.get(lod);
        if (!overlayMat) return;

        this._bindChunkInstances(overlayMat, instanceBuffer);
        this._applyMaterialUniforms(overlayMat, camera, viewMatrix, projectionMatrix, lod);
        this.backend.drawIndexedIndirect(geo, overlayMat, indirectBuffer, offset);
    }

    _bindChunkInstances(material, instanceBuffer) {
        if (!material.storageBuffers) material.storageBuffers = {};
        material.storageBuffers.chunkInstances = instanceBuffer;
    }

    setShadowRenderer(renderer) {
        this._shadowRenderer = renderer || null;
    }

    async rebuildMaterials() {
        for (const mat of this._materials.values()) {
            try {
                this.backend?.destroyMaterial?.(mat);
            } catch { /* ignore cleanup failure */ }
        }
        for (const mat of this._overlayMaterials.values()) {
            try {
                this.backend?.destroyMaterial?.(mat);
            } catch { /* ignore cleanup failure */ }
        }
        this._materials.clear();
        this._overlayMaterials.clear();
        await this._buildGeometriesAndMaterials();
    }
    async _buildGeometriesAndMaterials() {
        const context = this._createTerrainBuildContext();

        for (let lod = 0; lod <= this._maxGeomLOD; lod++) {
            const geometry = this._buildGeometryForLod(lod, context);
            if (!geometry) continue;

            this._geometries.set(lod, geometry);
            this._lodIndexCounts[lod] = geometry.index?.count || 0;

            const material = await TerrainMaterialBuilder.create(
                this._createTerrainMaterialOptions(lod, context)
            );
            if (material) {
                this._materials.set(lod, material);
            }

            const overlayMaterial = await TerrainMaterialBuilder.createHoverOverlay(
                this._createHoverOverlayMaterialOptions(lod, context)
            );
            if (overlayMaterial) {
                this._overlayMaterials.set(lod, overlayMaterial);
            }
        }
        Logger.info(`[QTR] Built ${this._geometries.size} LOD geometries, lodIndexCounts=[${this._lodIndexCounts.join(', ')}]`);
    }

    _createTerrainBuildContext() {
        const planetConfig = this.planetConfig;
        return {
            planetConfig,
            heightScale: planetConfig.heightScale,
            faceSize: planetConfig.chunksPerFace,
            atlasTextures: {
                micro: this.textureManager?.getAtlasTexture?.('micro') || null,
                macro: this.textureManager?.getAtlasTexture?.('macro') || null
            },
            lookupTables: this.textureManager?.getLookupTables?.() || {},
            cachedTextures: this.tileManager.getArrayTextures(),
            environmentState: this.uniformManager?.currentEnvironmentState || {},
            lodSegments: this._lodSegments,
            subdivisions: TerrainGeometryBuilder.buildSubdivisionMap(this.engineConfig.chunkSegments),
            useTransitionTopology: true,
            debugConfig: this.engineConfig?.debug || {}
        };
    }

    _buildGeometryForLod(lod, context) {
        const dummyChunk = { size: 1, heights: null };
        return TerrainGeometryBuilder.build(
            dummyChunk,
            0,
            0,
            lod,
            true,
            {
                subdivisions: context.subdivisions,
                useTransitionTopology: context.useTransitionTopology
            }
        );
    }

    _createCommonMaterialOptions(lod, context) {
        return {
            terrainAODefaults: this.terrainAODefaults,
            groundFieldDefaults: this.groundFieldDefaults,
            tileCategories: this.tileCategories,
            backend: this.backend,
            atlasTextures: context.atlasTextures,
            lookupTables: context.lookupTables,
            cachedTextures: context.cachedTextures,
            chunkOffsetX: 0,
            chunkOffsetZ: 0,
            chunkSize: this.engineConfig.chunkSizeMeters,
            environmentState: context.environmentState,
            uniformManager: this.uniformManager,
            faceIndex: 0,
            faceU: 0,
            faceV: 0,
            faceSize: context.faceSize,
            planetConfig: context.planetConfig,
            useAtlasMode: true,
            uvTransform: { offsetX: 0, offsetY: 0, scale: 1 },
            heightScale: context.heightScale,
            transmittanceLUT: this._atmosphereLUT?.transmittanceLUT || null,
            aerialPerspectiveEnabled: context.planetConfig.hasAtmosphere ? 1.0 : 0.0,
            enableInstancing: true,
            useStorageBufferInstancing: true,
            lod,
            chunksPerFace: context.faceSize,
            lodSegments: context.lodSegments,
            debugVertexMode: context.debugConfig.terrainVertexDebugMode ?? 0,
            useTransitionTopology: context.useTransitionTopology,
            blendModeTable: { value: context.lookupTables.blendModeTable ?? null },
            tileLayerHeights: { value: context.lookupTables.tileLayerHeights ?? null }
        };
    }

    _createTerrainMaterialOptions(lod, context) {
        return {
            ...this._createCommonMaterialOptions(lod, context),
            terrainShaderConfig: this._createTerrainShaderConfig(),
            debugMode: context.debugConfig.terrainFragmentDebugMode ?? 0
        };
    }

    _createHoverOverlayMaterialOptions(lod, context) {
        return {
            ...this._createCommonMaterialOptions(lod, context),
            terrainShaderConfig: this.engineConfig?.rendering?.terrainShader ?? null,
            debugMode: 0
        };
    }

    _createTerrainShaderConfig() {
        const baseConfig = this.engineConfig?.rendering?.terrainShader ?? null;
        if (this.engineConfig?.features?.shadows === false) {
            return { ...baseConfig, shadowMaxLod: -1 };
        }

        const shadowDistanceMax = baseConfig?.shadowDistanceMaxMeters;
        const distances = this.engineConfig?.lod?.distancesMeters ?? [];
        if (!Number.isFinite(shadowDistanceMax)) {
            return baseConfig;
        }

        let shadowMaxLod = 0;
        for (let i = 1; i < distances.length; i++) {
            if (distances[i - 1] <= shadowDistanceMax) {
                shadowMaxLod = i;
            } else {
                break;
            }
        }
        return { ...baseConfig, shadowMaxLod };
    }

    _applyMaterialUniforms(mat, camera, viewMatrix, projectionMatrix, lodLevel = 0) {
        const uniforms = mat.uniforms;
        this._ensureMaterialFrameUniforms(uniforms);
        this._applyFrameUniforms(uniforms, camera, viewMatrix, projectionMatrix, lodLevel);
        this._applyTerrainHoverUniforms(uniforms);

        const u = this.uniformManager?.uniforms;
        if (!u) return;

        this._applyLightingUniforms(uniforms, u);
        this._applyWeatherUniforms(uniforms, u);
        this._applyAtmosphereUniforms(uniforms, u);
        this._applyWeatherUniforms(uniforms, u);
    }

    _ensureMaterialFrameUniforms(uniforms) {
        if (!uniforms.viewMatrix) uniforms.viewMatrix = { value: new Matrix4() };
        if (!uniforms.projectionMatrix) uniforms.projectionMatrix = { value: new Matrix4() };
        if (!uniforms.modelMatrix) uniforms.modelMatrix = { value: new Matrix4() };
        if (!uniforms._shadowRenderer) uniforms._shadowRenderer = { value: null };
    }

    _applyFrameUniforms(uniforms, camera, viewMatrix, projectionMatrix, lodLevel) {
        if (uniforms.cameraPosition && camera?.position) {
            uniforms.cameraPosition.value.copy(camera.position);
        }
        uniforms._shadowRenderer.value = this._shadowRenderer || null;
        uniforms.viewMatrix.value.copy(viewMatrix);
        uniforms.projectionMatrix.value.copy(projectionMatrix);
        uniforms.modelMatrix.value.identity();
        if (uniforms.geometryLOD) uniforms.geometryLOD.value = lodLevel;
        if (uniforms.lodLevel) uniforms.lodLevel.value = lodLevel;
        if (uniforms.useInstancing) uniforms.useInstancing.value = 1.0;
        if (uniforms.terrainLayerViewMode) {
            uniforms.terrainLayerViewMode.value = this._terrainLayerViewMode;
        }
    }

    _applyTerrainHoverUniforms(uniforms) {
        if (uniforms.terrainHoverFace) {
            uniforms.terrainHoverFace.value = this._terrainHoverOverlay.face;
        }
        if (uniforms.terrainHoverFlags) {
            uniforms.terrainHoverFlags.value = this._terrainHoverOverlay.flags;
        }
        if (uniforms.terrainHoverMicroRect) {
            uniforms.terrainHoverMicroRect.value.copy(this._terrainHoverOverlay.microRect);
        }
        if (uniforms.terrainHoverMacroRect) {
            uniforms.terrainHoverMacroRect.value.copy(this._terrainHoverOverlay.macroRect);
        }
        if (uniforms.terrainHoverMicroColor) {
            uniforms.terrainHoverMicroColor.value.copy(this._terrainHoverOverlay.microColor);
        }
        if (uniforms.terrainHoverMacroColor) {
            uniforms.terrainHoverMacroColor.value.copy(this._terrainHoverOverlay.macroColor);
        }
    }

    _applyLightingUniforms(uniforms, sourceUniforms) {
        if (uniforms.sunLightDirection && sourceUniforms.sunLightDirection) {
            uniforms.sunLightDirection.value.copy(sourceUniforms.sunLightDirection.value);
        }
        if (uniforms.sunLightColor && sourceUniforms.sunLightColor) {
            uniforms.sunLightColor.value.copy(sourceUniforms.sunLightColor.value);
        }
        if (uniforms.sunLightIntensity && sourceUniforms.sunLightIntensity) {
            uniforms.sunLightIntensity.value = sourceUniforms.sunLightIntensity.value;
        }
        if (uniforms.ambientLightColor && sourceUniforms.ambientLightColor) {
            uniforms.ambientLightColor.value.copy(sourceUniforms.ambientLightColor.value);
        }
        if (uniforms.ambientLightIntensity && sourceUniforms.ambientLightIntensity) {
            uniforms.ambientLightIntensity.value = sourceUniforms.ambientLightIntensity.value;
        }
        if (uniforms.fogColor && sourceUniforms.fogColor) {
            uniforms.fogColor.value.copy(sourceUniforms.fogColor.value);
        }
        if (uniforms.fogDensity && sourceUniforms.fogDensity) {
            uniforms.fogDensity.value = sourceUniforms.fogDensity.value;
        }
    }

    _applyWeatherUniforms(uniforms, sourceUniforms) {
        if (uniforms.weatherIntensity && sourceUniforms.weatherIntensity) {
            uniforms.weatherIntensity.value = sourceUniforms.weatherIntensity.value;
        }
        if (uniforms.currentWeather && sourceUniforms.currentWeather) {
            uniforms.currentWeather.value = sourceUniforms.currentWeather.value;
        }
    }

    _applyAtmosphereUniforms(uniforms, sourceUniforms) {
        if (uniforms.aerialPerspectiveEnabled && sourceUniforms.aerialPerspectiveEnabled) {
            uniforms.aerialPerspectiveEnabled.value = sourceUniforms.aerialPerspectiveEnabled.value;
        }
        if (uniforms.planetCenter && sourceUniforms.planetCenter) {
            uniforms.planetCenter.value.copy(sourceUniforms.planetCenter.value);
        }
        if (uniforms.atmospherePlanetRadius && sourceUniforms.atmospherePlanetRadius) {
            uniforms.atmospherePlanetRadius.value = sourceUniforms.atmospherePlanetRadius.value;
        }
        if (uniforms.atmosphereRadius && sourceUniforms.atmosphereRadius) {
            uniforms.atmosphereRadius.value = sourceUniforms.atmosphereRadius.value;
        }
        if (uniforms.atmosphereScaleHeightRayleigh && sourceUniforms.atmosphereScaleHeightRayleigh) {
            uniforms.atmosphereScaleHeightRayleigh.value = sourceUniforms.atmosphereScaleHeightRayleigh.value;
        }
        if (uniforms.atmosphereScaleHeightMie && sourceUniforms.atmosphereScaleHeightMie) {
            uniforms.atmosphereScaleHeightMie.value = sourceUniforms.atmosphereScaleHeightMie.value;
        }
        if (uniforms.atmosphereRayleighScattering && sourceUniforms.atmosphereRayleighScattering) {
            uniforms.atmosphereRayleighScattering.value
                .copy(sourceUniforms.atmosphereRayleighScattering.value);
        }
        if (uniforms.atmosphereMieScattering && sourceUniforms.atmosphereMieScattering) {
            uniforms.atmosphereMieScattering.value = sourceUniforms.atmosphereMieScattering.value;
        }
        if (uniforms.atmosphereMieAnisotropy && sourceUniforms.atmosphereMieAnisotropy) {
            uniforms.atmosphereMieAnisotropy.value = sourceUniforms.atmosphereMieAnisotropy.value;
        }
        if (uniforms.atmosphereSunIntensity && sourceUniforms.atmosphereSunIntensity) {
            uniforms.atmosphereSunIntensity.value = sourceUniforms.atmosphereSunIntensity.value;
        }
        if (uniforms.transmittanceLUT && sourceUniforms.transmittanceLUT?.value) {
            uniforms.transmittanceLUT.value = sourceUniforms.transmittanceLUT.value;
        }
    }
}
