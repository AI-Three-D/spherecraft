// js/renderer/terrain/QuadtreeTerrainRenderer.js
//
// Renders terrain driven by the GPU quadtree tile manager.
// Pure rendering concern: builds geometries/materials, consumes
// instance + indirect buffers from the tile manager, issues draw calls.

import { Matrix4, Vector4 } from '../../../shared/math/index.js';
import { TerrainGeometryBuilder } from './geometry/terrainGeometryBuilder.js';
import { TerrainMaterialBuilder } from './materials/terrainMaterialBuilder.js';
import { createGroundMaterials } from './materials/groundMaterials.js';
import { TerrainLightMap } from './light/TerrainLightMap.js';
import { TerrainPass } from './draw/TerrainPass.js';
import { GrassPass } from '../grass/GrassPass.js';
import { createGrassGrain } from '../grass/grassGrain.js';
import { usesBiomeLandscape } from '../../world/terrain-generator/biomeLandscapeConfig.js';
import { aerialFadeRange } from './shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import { computeSolidTierFadeDistances } from '../../world/quadtree/solidTierFade.js';
import { Logger } from '../../../shared/Logger.js';

export class QuadtreeTerrainRenderer {
    /** @param {import('./QuadtreeTerrainRenderer.js').QuadtreeTerrainRendererOptions} options */
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
        this._ground = null;
        this._landLight = null;
        /** Draws the terrain when it can (TerrainPass.js). */
        this.pass = null;
        /** Grass blades over it (GrassPass.js), with the pass only. */
        this.grass = null;
        this._wetness = 0;
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

        if (this.engineConfig.rendering?.terrainShader?.groundMaterials === true) {
            this._ground ??= await createGroundMaterials(this.backend.device);
            if (!this._landLight && this.engineConfig.rendering.terrainShader.landLight) {
                this._landLight = new TerrainLightMap(this.backend.device);
                await this._landLight.initialize();
            }
        }
        await this._buildGeometriesAndMaterials();
        await this._createPass();

        // Feed index counts back to the tile manager so indirect draw args are correct
        this.tileManager?.updateLodIndexCounts(this._lodIndexCounts);

        this._initialized = true;
        Logger.info('[QuadtreeTerrainRenderer] Initialized');
    }

    async _createPass() {
        const shader = this.engineConfig.rendering?.terrainShader ?? {};
        const textures = this.tileManager?.getArrayTextures?.() ?? {};
        const usable = shader.terrainPass !== false && this._ground && this._landLight && shader.solidColorTierEnabled === true
            && shader.solidColorTierEdgeBlendEnabled !== true && this.engineConfig.features?.shadows === false
            && this.planetConfig?.engineConfig?.splatConfig?.fixedMaterialFamiliesEnabled === true
            && ['height', 'normal', 'splatData', 'splatIndex', 'coarseColor'].every(name => textures[name]?._isArray)
            && TerrainPass.supported(this.backend.device, this.tileManager);
        if (!usable) return;
        // As the materials do (terrainMaterialBuilder.js enableBiomeClimate).
        const terrain = this.planetConfig?.terrainGeneration;
        const biome = usesBiomeLandscape(terrain) && textures.climate?._isArray === true && textures.climate._isFilterable === true ? terrain.biomeLandscape : null;
        // The grain of grass far off (grassGrain.js): worn by the terrain's grass, and by the far blades.
        const grassConfig = this.engineConfig.rendering?.grass;
        if (grassConfig?.enabled && !this._grain) this._grain = createGrassGrain(this.backend.device);
        const pass = new TerrainPass({
            device: this.backend.device, backend: this.backend, tileManager: this.tileManager, ground: this._ground, landLight: this._landLight,
            planetConfig: this.planetConfig, shaderConfig: shader, segments: Math.max(...this._lodSegments), biome, grain: this._grain ?? null,
            grassLook: !!grassConfig?.enabled,
            meshes: Array.from({ length: this._maxGeomLOD + 1 }, (_, lod) => this._geometries.get(lod).index.data),
        });
        try {
            await pass.initialize();
            this.pass = pass;
        } catch (error) {
            pass.destroy();
            Logger.warn(`[QTR] terrain pass unavailable, drawing with materials: ${error?.message ?? error}`);
            return;
        }
        // Grass blades over the ground the pass draws (rendering.grass).
        if (grassConfig?.enabled && GrassPass.supported(this.backend.device, this.tileManager)) {
            const grass = new GrassPass({
                device: this.backend.device, backend: this.backend, tileManager: this.tileManager, ground: this._ground,
                landLight: this._landLight, planetConfig: this.planetConfig, biome, config: grassConfig, grain: this._grain,
            });
            try {
                await grass.initialize();
                this.grass = grass;
            } catch (error) {
                grass.destroy();
                Logger.warn(`[QTR] grass unavailable: ${error?.message ?? error}`);
            }
        }
    }

    // Whether this frame's terrain is the pass's. Its uniforms are the finest level's, which are made here.
    _passDraws(camera) {
        if (!this.pass || this._terrainLayerViewMode !== 0 || !camera || !this.engineConfig.rendering.terrainShader.groundMaterials) return false;
        const mat = this._materials.get(0);
        if (!mat) return false;
        this._applyMaterialUniforms(mat, camera, camera.matrixWorldInverse, camera.projectionMatrix, 0);
        return this.pass.ready(mat.uniforms);
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

    /** Light over the land (TerrainLightMap), before the terrain is drawn with it. */
    compute(frame, encoder) {
        this._updateWetness(frame?.deltaTime);
        const sun = this.uniformManager?.uniforms?.sunLightDirection?.value;
        const position = frame?.camera?.position;
        this._drawnByPass = false;
        if (!this._landLight || !sun || !position || !encoder) return;
        const origin = this.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
        const length = Math.hypot(sun.x, sun.y, sun.z) || 1;
        this._landLight.update(encoder, {
            tileStreamer: this.tileManager?.tileStreamer,
            camera: [position.x - origin.x, position.y - origin.y, position.z - origin.z],
            radius: this.planetConfig.radius, heightScale: this.planetConfig.heightScale,
            sun: [sun.x / length, sun.y / length, sun.z / length],
        });
        this._tierFade = this._computeTierFadeDistances();
        this._drawnByPass = this._initialized && this.tileManager?.isReady() && this._passDraws(frame.camera);
        if (this._drawnByPass) {
            if (this.grass) {
                const water = this._waterData?.value;
                this.grass.compute(encoder, {
                    u: this._materials.get(0).uniforms, camera: frame.camera, deltaTime: frame.deltaTime,
                    environment: this.uniformManager?.currentEnvironmentState ?? null,
                    seaLevel: water?.sea?.enabled ? water.sea.levelM : null,
                    viewportHeight: this.backend._viewport?.height ?? this.backend.canvas?.height,
                });
            }
            this.pass.grassReach = this.grass?.drawing ? this.grass.config.distance : 0;
            this.pass.compute(encoder, {
                u: this._materials.get(0).uniforms, camera: frame.camera, water: this._waterData?.value ?? null,
                tierFade: this._tierFade, wetness: this._wetness, airFade: aerialFadeRange(this.engineConfig.rendering.terrainShader),
            });
        }
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._initialized || !this.tileManager?.isReady()) return;

        const instanceBuffer = this.tileManager.getInstanceBuffer();
        const indirectBuffer = this.tileManager.getIndirectArgsBuffer();
        const overlayEnabled = this._isHoverOverlayEnabled();
        this._tierFade = this._computeTierFadeDistances();
        this._shadersLeft = 1;
        if (this._drawnByPass) {
            const pass = this.backend.getRenderPassEncoder();
            if (pass) {
                this.pass.draw(pass);
                this.grass?.draw(pass);
                if (overlayEnabled) {
                    for (let lod = 0; lod <= this._maxGeomLOD; lod++) {
                        this._drawTerrainOverlay(lod, this._geometries.get(lod), camera, viewMatrix, projectionMatrix, instanceBuffer, indirectBuffer, this.tileManager.getIndirectArgsOffsetBytes(lod));
                    }
                }
                return;
            }
        }

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

    /** What the pass knows of the sea: { about, rect: GPUBuffer }, or null when it does not draw. */
    getSeaView() {
        return this._drawnByPass ? { about: this.pass.seaAbout, rect: this.pass.seaView } : null;
    }

    afterSubmit() { if (this._drawnByPass) this.pass.afterSubmit(); }

    // The new shader compiles beside the one in use, which draws until it is ready: no hitch when rain sets in.
    _changeFragment(mat, fragment) {
        if (mat._nextFragment?.fragmentShader !== fragment) {
            mat._nextFragment = Object.assign(Object.create(Object.getPrototypeOf(mat)), mat, {
                fragmentShader: fragment, asyncCompile: true, _needsCompile: true, _gpuPipeline: null, _pipelinePromise: null, _pipelineError: null,
            });
        }
        if (!this.backend.compileShader(mat._nextFragment)) return;
        mat._nextFragment = null;
        mat.fragmentShader = fragment;
        mat._needsCompile = true; // the backend now finds the pipeline in its cache
    }

    // Whether tiles of this level can lie past where the near water meshes have handed over to the terrain's own water.
    _drawsFarWater(lod) {
        const water = this._waterData?.value;
        if (!water?.enabled) return false;
        const near = water.near;
        if (!near?.enabled || water.debugMode > 0) return true;
        return this._farthestOf(lod) >= near.fadeStartM;
    }

    // Whether tiles of this level can lie where the ground turns into the far tier's.
    _reachesFarGround(lod) {
        return !this._tierFade || this._farthestOf(lod) >= this._tierFade.start;
    }

    // No pixel of a level's tiles is farther than this: their parent, twice as wide, was near enough to be split
    // (computeSolidTierFadeDistances). Land within a tile rises at most three quarters of its width.
    _farthestOf(lod) {
        const { lodFactor, faceSize, maxDepth, lodErrorThreshold } = this.tileManager?.getTierFadeParameters?.() ?? {};
        if (![lodFactor, faceSize, maxDepth, lodErrorThreshold].every(Number.isFinite)) return Infinity;
        const parent = faceSize / 2 ** Math.max(0, maxDepth - lod - 1);
        const threshold = Math.max(1, 4 * Math.floor(lodErrorThreshold / 4) + 2);
        return parent * lodFactor / threshold + parent * Math.hypot(Math.SQRT1_2, 0.75);
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
        const variants = mat._terrainFragmentVariants;
        if (variants) {
            const diagnostic = mat.uniforms.terrainDebugMode.value !== 0 || this._terrainLayerViewMode !== 0;
            const lit = mat.uniforms._clusterBuffers?.value?.numLights > 0;
            const key = diagnostic ? 'diagnostic'
                : [lit && 'lit', this._drawsFarWater(lod) && 'wet', this._wetness > 0 && 'rain', this._reachesFarGround(lod) && 'far'].filter(Boolean).join(' ') || 'plain';
            // At most one shader is written a frame.
            if (variants[key] || this._shadersLeft-- > 0) {
                const fragment = variants.get(key);
                if (mat.fragmentShader !== fragment) this._changeFragment(mat, fragment);
            }
        }

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
        // LOD seam stitching (bind group 3, binding 21; null = a zeroed dummy, no stitching).
        material.storageBuffers.edgeStitch = this.tileManager.getEdgeStitchBuffer?.() ?? null;
        // Lake water for the terrain shader (bind group 3, bindings 12-15).
        if (material.uniforms) {
            material.uniforms._waterData = this._waterData ?? { value: null };
            material.uniforms._landLight = { value: this._landLight };
        }
    }

    /** Water data (lakes, rivers: core/world/water/WaterGpuData.js) for the terrain shader, or null. */
    setWaterData(data) {
        this._waterData = { value: data || null };
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
            const geometry = this._geometries.get(lod) || this._buildGeometryForLod(lod, context);
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
                macro: this.textureManager?.getAtlasTexture?.('macro') || null,
                ground: this._ground && this.engineConfig.rendering.terrainShader.groundMaterials && {
                    albedo: { _gpuTexture: { texture: this._ground.albedo }, _isArray: true },
                    surface: { _gpuTexture: { texture: this._ground.surface }, _isArray: true },
                    sampler: this._ground.sampler,
                    wideSampler: this._ground.wideSampler,
                }
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
            tileAverageColors: this.textureManager?.getCategoryAverageColorMap?.(this.tileCategories) || null,
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
        if (uniforms.tierFadeStart && uniforms.tierFadeEnd) {
            uniforms.tierFadeStart.value = this._tierFade?.start ?? 0.0;
            uniforms.tierFadeEnd.value = this._tierFade?.end ?? 0.0;
        }
    }

    // Camera-distance ramp into the solid-color tier, derived each frame from
    // the traversal's LOD metric (formula in solidTierFade.js, shared with the
    // tile streamer's refinement skip). null = ramp off.
    _computeTierFadeDistances() {
        const parameters = this.tileManager?.getTierFadeParameters?.();
        return computeSolidTierFadeDistances({
            ...parameters,
            shaderConfig: this.engineConfig?.rendering?.terrainShader
        });
    }

    /** Releases draw resources only. TerrainSource and shared atlases have separate owners. */
    dispose() {
        for (const geometry of this._geometries.values()) geometry.dispose();
        for (const material of this._materials.values()) this.backend.destroyMaterial(material);
        for (const material of this._overlayMaterials.values()) this.backend.destroyMaterial(material);
        this._geometries.clear();
        this._materials.clear();
        this._overlayMaterials.clear();
        this.pass?.destroy();
        this.pass = null;
        this.grass?.destroy();
        this.grass = null;
        this._grain?.destroy();
        this._grain = null;
        this._ground?.destroy();
        this._ground = null;
        this._landLight?.dispose();
        this._landLight = null;
        this._initialized = false;
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

    // Ground soaks in under half a minute of rain and dries over a few: seconds of the game's own short days.
    _updateWetness(deltaTime) {
        const rain = Math.min(1, Math.max(0, this.uniformManager?.currentEnvironmentState?.precipitationIntensity ?? 0));
        const target = Math.min(1, rain * 1.6);
        const dt = Math.min(0.25, Math.max(0, deltaTime || 0));
        const rate = target > this._wetness ? 1 / 12 : 1 / 45;
        this._wetness += Math.max(-rate * dt, Math.min(rate * dt, target - this._wetness));
    }

    _applyWeatherUniforms(uniforms, sourceUniforms) {
        if (uniforms.terrainWetness) uniforms.terrainWetness.value = this._wetness;
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
