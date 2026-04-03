// js/renderer/terrain/QuadtreeTerrainRenderer.js
//
// Renders terrain driven by the GPU quadtree tile manager.
// Pure rendering concern: builds geometries/materials, consumes
// instance + indirect buffers from the tile manager, issues draw calls.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
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
        this._lodIndexCounts = [];
        this._lodSegments = null;
        this._maxGeomLOD = 0;
        this._initialized = false;
        this._directDrawArgs = null;
        this._directDrawPending = false;
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

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._initialized || !this.tileManager?.isReady()) return;
    
        if (this._renderLogCounter == null) this._renderLogCounter = 0;
        if (this._renderLogFrame == null) this._renderLogFrame = 0;
        if (!this._renderLogInterval) this._renderLogInterval = 180;
        this._renderLogCounter++;
        this._renderLogFrame = (this._renderLogFrame + 1) % this._renderLogInterval;
        const shouldLog = this._renderLogFrame === 0;
    

        const instanceBuffer = this.tileManager.getInstanceBuffer();
        const indirectBuffer = this.tileManager.getIndirectArgsBuffer();
        const debugConfig = this.engineConfig?.debug || {};
        const supportsIndirectFirstInstance = this.backend?.supportsIndirectFirstInstance !== false;
        const forceDirectDraw = debugConfig.terrainForceDirectDraw === true || !supportsIndirectFirstInstance;

    /*    if (forceDirectDraw && this.tileManager?.debugReadIndirectArgs) {
            if (!this._directDrawPending) {
                this._directDrawPending = true;
                this.tileManager.debugReadIndirectArgs()
                    .then(args => { this._directDrawArgs = args || null; })
                    .catch(err => {
                        Logger.warn(`[QTR-Draw] Direct draw args readback failed: ${err?.message || err}`);
                    })
                    .finally(() => { this._directDrawPending = false; });
            }
        } else {
            this._directDrawArgs = null;
            this._directDrawPending = false;
        }*/
/*
        if (shouldLog) {
            Logger.info(`[QTR-Draw] frame=${this._renderLogCounter} maxGeomLOD=${this._maxGeomLOD}`);
            Logger.info(`[Debug frame] instanceBuffer=${instanceBuffer?.label || 'raw'} size=${instanceBuffer?.size}`);
            Logger.info(`[Debug frame] indirectBuffer=${indirectBuffer?.label || 'raw'} size=${indirectBuffer?.size}`);
            if (this.tileManager?.debugReadIndirectArgs) {
                this.tileManager.debugReadIndirectArgs().then(args => {
                    if (!args?.length) return;
                    const parts = args.map(a => {
                        const off = this.tileManager.getIndirectArgsOffsetBytes(a.lod);
                        return `L${a.lod}: idx=${a.indexCount} inst=${a.instanceCount} firstInst=${a.firstInstance} off=${off}`;
                    });
                    Logger.info(`[QTR-Draw] Indirect args: ${parts.join(' | ')}`);
                });
            }
        }*/
        for (var lod = 0; lod <= this._maxGeomLOD; lod++) {
            const geo = this._geometries.get(lod);
            const mat = this._materials.get(lod);
            if (!geo || !mat) continue;

            if (!mat.storageBuffers) mat.storageBuffers = {};
            mat.storageBuffers.chunkInstances = instanceBuffer;

            this._applyMaterialUniforms(mat, camera, viewMatrix, projectionMatrix, lod);

            const offset = this.tileManager.getIndirectArgsOffsetBytes(lod);

        /*     if (shouldLog) {
                const geoLOD = mat.uniforms.geometryLOD?.value;
                const lodLevel = mat.uniforms.lodLevel?.value;
                const useInst = mat.uniforms.useInstancing?.value;
                const indexCount = geo.index?.count || 0;
                Logger.info(
                    `[Debug frame]  LOD ${lod}: geoLOD=${geoLOD} lodLevel=${lodLevel} ` +
                    `useInstancing=${useInst} indexCount=${indexCount} ` +
                    `indirectOffset=${offset} matId=${mat.id} ` +
                    `depthTest=${mat.depthTest} depthWrite=${mat.depthWrite} ` +
                    `depthCompare=${mat.depthCompare} side=${mat.side} ` +
                    `transparent=${mat.transparent} blending=${mat.blending}`
                );
            }
            if (forceDirectDraw) {
                const args = Array.isArray(this._directDrawArgs) ? this._directDrawArgs[lod] : null;
                if (args && args.indexCount > 0 && args.instanceCount > 0 && args.lod === lod) {
                    const prevStart = geo.drawRange?.start ?? 0;
                    const prevCount = geo.drawRange?.count ?? Infinity;
                    const prevInstCount = geo.instanceCount;
                    const prevInstStart = geo.instanceStart;

                    geo.drawRange.start = args.firstIndex ?? 0;
                    geo.drawRange.count = args.indexCount;
                    geo.instanceCount = args.instanceCount;
                    geo.instanceStart = args.firstInstance ?? 0;

                    this.backend.draw(geo, mat);

                    geo.drawRange.start = prevStart;
                    geo.drawRange.count = prevCount;
                    geo.instanceCount = prevInstCount;
                    geo.instanceStart = prevInstStart;
                } else if (supportsIndirectFirstInstance) {
                    if (shouldLog) {
                        Logger.info(`[QTR-Draw] Direct draw fallback LOD ${lod}: args not ready/empty`);
                    }
                    this.backend.drawIndexedIndirect(geo, mat, indirectBuffer, offset);
                } else if (shouldLog) {
                    Logger.info(`[QTR-Draw] Direct draw waiting for args LOD ${lod}: indirect-first-instance unsupported`);
                }
                continue;
            }*/

            this.backend.drawIndexedIndirect(geo, mat, indirectBuffer, offset);
        }
    }
    setShadowRenderer(renderer) {
        this._shadowRenderer = renderer || null;
    }

    async rebuildMaterials() {
        for (const mat of this._materials.values()) {
            try {
                this.backend?.destroyMaterial?.(mat);
            } catch (_) {}
        }
        this._materials.clear();
        await this._buildGeometriesAndMaterials();
    }
    async _buildGeometriesAndMaterials() {
        const pConfig = this.planetConfig;
        const heightScale = pConfig.heightScale;
        const faceSize = pConfig.chunksPerFace;
        const atlasTextures = {
            micro: this.textureManager?.getAtlasTexture?.('micro') || null,
            macro: this.textureManager?.getAtlasTexture?.('macro') || null
        };
        const lookupTables = this.textureManager?.getLookupTables?.() || {};
        const cachedTextures = this.tileManager.getArrayTextures();
        const environmentState = this.uniformManager?.currentEnvironmentState || {};
        const lodSegments = this._lodSegments;
        const subdivisions = TerrainGeometryBuilder.buildSubdivisionMap(this.engineConfig.chunkSegments);
        const useTransitionTopology = true;
        const debugConfig = this.engineConfig?.debug || {};


        for (var lod = 0; lod <= this._maxGeomLOD; lod++) {
            const dummyChunk = { size: 1, heights: null };
            const geometry = TerrainGeometryBuilder.build(
                dummyChunk,
                0,
                0,
                lod,
                true,
                { subdivisions, useTransitionTopology }
            );
            if (!geometry) continue;
            this._geometries.set(lod, geometry);
            this._lodIndexCounts[lod] = geometry.index?.count || 0;

            const material = await TerrainMaterialBuilder.create({
                terrainAODefaults: this.terrainAODefaults,
                groundFieldDefaults: this.groundFieldDefaults,
                tileCategories: this.tileCategories,
                backend: this.backend,
                atlasTextures,
                lookupTables,
                cachedTextures,
                chunkOffsetX: 0,
                chunkOffsetZ: 0,
                chunkSize: this.engineConfig.chunkSizeMeters,
                environmentState,
                uniformManager: this.uniformManager,
                faceIndex: 0,
                faceU: 0,
                faceV: 0,
                faceSize: faceSize,
                planetConfig: pConfig,
                useAtlasMode: true,
                uvTransform: { offsetX: 0, offsetY: 0, scale: 1 },
                heightScale,
                terrainShaderConfig: (() => {
                    const baseConfig = this.engineConfig?.rendering?.terrainShader ?? null;
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
                })(),
                transmittanceLUT: this._atmosphereLUT?.transmittanceLUT || null,
                aerialPerspectiveEnabled: pConfig.hasAtmosphere ? 1.0 : 0.0,
                enableInstancing: true,
                useStorageBufferInstancing: true,
                lod: lod,
                chunksPerFace: faceSize,
                lodSegments: lodSegments,
                debugMode: debugConfig.terrainFragmentDebugMode ?? 0,
                debugVertexMode: debugConfig.terrainVertexDebugMode ?? 0,
                useTransitionTopology,
                        // === BLEND MODE LOOKUP TABLES (new) ===
                // Both are built by TileTransitionTableBuilder.
                // Callers that have not yet integrated the builder can pass null;
                // the material falls back to single-pixel all-zeros textures which
                // produce blend_soft for every pair.
                blendModeTable:   { value: lookupTables.blendModeTable   ?? null },
                tileLayerHeights: { value: lookupTables.tileLayerHeights ?? null },

            });
            if (material) {
                this._materials.set(lod, material);
            }
        }
        Logger.info(`[QTR] Built ${this._geometries.size} LOD geometries, lodIndexCounts=[${this._lodIndexCounts.join(', ')}]`);
    }

    _applyMaterialUniforms(mat, camera, viewMatrix, projectionMatrix, lodLevel = 0) {
        if (!mat.uniforms.viewMatrix) mat.uniforms.viewMatrix = { value: new THREE.Matrix4() };
        if (!mat.uniforms.projectionMatrix) mat.uniforms.projectionMatrix = { value: new THREE.Matrix4() };
        if (!mat.uniforms.modelMatrix) mat.uniforms.modelMatrix = { value: new THREE.Matrix4() };
        if (mat.uniforms.cameraPosition && camera?.position) {
            mat.uniforms.cameraPosition.value.copy(camera.position);
        }
           // Shadow renderer reference for bind group creation
    if (!mat.uniforms._shadowRenderer) {
        mat.uniforms._shadowRenderer = { value: null };
    }
    // This gets picked up by _createTerrainBindGroups in the backend
    mat.uniforms._shadowRenderer.value = this._shadowRenderer || null;
        mat.uniforms.viewMatrix.value.copy(viewMatrix);
        mat.uniforms.projectionMatrix.value.copy(projectionMatrix);
        mat.uniforms.modelMatrix.value.identity();
        if (mat.uniforms.geometryLOD) mat.uniforms.geometryLOD.value = lodLevel;
        if (mat.uniforms.lodLevel) mat.uniforms.lodLevel.value = lodLevel;
        if (mat.uniforms.useInstancing) mat.uniforms.useInstancing.value = 1.0;

        const u = this.uniformManager?.uniforms;
        if (!u) return;

        if (mat.uniforms.sunLightDirection && u.sunLightDirection) {
            mat.uniforms.sunLightDirection.value.copy(u.sunLightDirection.value);
        }
        if (mat.uniforms.sunLightColor && u.sunLightColor) {
            mat.uniforms.sunLightColor.value.copy(u.sunLightColor.value);
        }
        if (mat.uniforms.sunLightIntensity && u.sunLightIntensity) {
            mat.uniforms.sunLightIntensity.value = u.sunLightIntensity.value;
        }
        if (mat.uniforms.ambientLightColor && u.ambientLightColor) {
            mat.uniforms.ambientLightColor.value.copy(u.ambientLightColor.value);
        }
        if (mat.uniforms.ambientLightIntensity && u.ambientLightIntensity) {
            mat.uniforms.ambientLightIntensity.value = u.ambientLightIntensity.value;
        }
        if (mat.uniforms.fogColor && u.fogColor) {
            mat.uniforms.fogColor.value.copy(u.fogColor.value);
        }
        if (mat.uniforms.fogDensity && u.fogDensity) {
            mat.uniforms.fogDensity.value = u.fogDensity.value;
        }
        if (mat.uniforms.weatherIntensity && u.weatherIntensity) {
            mat.uniforms.weatherIntensity.value = u.weatherIntensity.value;
        }
        if (mat.uniforms.currentWeather && u.currentWeather) {
            mat.uniforms.currentWeather.value = u.currentWeather.value;
        }

            // ── Atmosphere / aerial-perspective uniforms ────────────────────────────
    // These must be refreshed every frame so the LUT-based fog path sees
    // current values (LUT may have been recomputed, camera altitude changes
    // fog density, planet-switch invalidates all coefficients).
    if (mat.uniforms.aerialPerspectiveEnabled && u.aerialPerspectiveEnabled) {
        mat.uniforms.aerialPerspectiveEnabled.value = u.aerialPerspectiveEnabled.value;
    }
    if (mat.uniforms.planetCenter && u.planetCenter) {
        mat.uniforms.planetCenter.value.copy(u.planetCenter.value);
    }
    if (mat.uniforms.atmospherePlanetRadius && u.atmospherePlanetRadius) {
        mat.uniforms.atmospherePlanetRadius.value = u.atmospherePlanetRadius.value;
    }
    if (mat.uniforms.atmosphereRadius && u.atmosphereRadius) {
        mat.uniforms.atmosphereRadius.value = u.atmosphereRadius.value;
    }
    if (mat.uniforms.atmosphereScaleHeightRayleigh && u.atmosphereScaleHeightRayleigh) {
        mat.uniforms.atmosphereScaleHeightRayleigh.value = u.atmosphereScaleHeightRayleigh.value;
    }
    if (mat.uniforms.atmosphereScaleHeightMie && u.atmosphereScaleHeightMie) {
        mat.uniforms.atmosphereScaleHeightMie.value = u.atmosphereScaleHeightMie.value;
    }
    if (mat.uniforms.atmosphereRayleighScattering && u.atmosphereRayleighScattering) {
        mat.uniforms.atmosphereRayleighScattering.value
            .copy(u.atmosphereRayleighScattering.value);
    }
    if (mat.uniforms.atmosphereMieScattering && u.atmosphereMieScattering) {
        mat.uniforms.atmosphereMieScattering.value = u.atmosphereMieScattering.value;
    }
    if (mat.uniforms.atmosphereMieAnisotropy && u.atmosphereMieAnisotropy) {
        mat.uniforms.atmosphereMieAnisotropy.value = u.atmosphereMieAnisotropy.value;
    }
    if (mat.uniforms.atmosphereSunIntensity && u.atmosphereSunIntensity) {
        mat.uniforms.atmosphereSunIntensity.value = u.atmosphereSunIntensity.value;
    }
    // Transmittance LUT — the Texture object reference can change after a
    // planet switch or after the first compute() call completes.
    if (mat.uniforms.transmittanceLUT && u.transmittanceLUT?.value) {
        mat.uniforms.transmittanceLUT.value = u.transmittanceLUT.value;
    }

    if (mat.uniforms.weatherIntensity && u.weatherIntensity) {
        mat.uniforms.weatherIntensity.value = u.weatherIntensity.value;
    }
    if (mat.uniforms.currentWeather && u.currentWeather) {
        mat.uniforms.currentWeather.value = u.currentWeather.value;
    }
    }
}
