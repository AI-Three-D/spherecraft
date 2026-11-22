import { CloudRenderer } from './cloudRenderer.js';
import { Material } from '../resources/material.js';
import { RenderTarget } from '../resources/renderTarget.js';
import { Vector2, Vector3, Matrix4 } from '../../../shared/math/index.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js'

// Fraction of the cirrus band that the volume's slab spans (the shader's CIRRUS_SLAB_FRACTION). The
// frontend draws the cirrus over the scene once the camera is inside the slab.
export const CIRRUS_SLAB_FRACTION = 0.42;

export class WebGPUCloudRenderer extends CloudRenderer {
    get cirrusSlabFraction() { return CIRRUS_SLAB_FRACTION; }


    // ---------------------------------------------------------------
    //  Lifecycle
    // ---------------------------------------------------------------

    async initialize() {
        await super.initialize();

        this._windOffset = new Vector2(0, 0);
        this._smoothedWindDir = new Vector2(1, 0);
        this._smoothedWindSpeed = 5.0;
        this._lastTime = performance.now() / 1000;
        this.frameCount = 0;

        this._defaultLayerParams = {
            name: 'high', altMin: 0, altMax: 0, coverage: 0, densityMultiplier: 0.5,
            noiseScale: 1.0, verticalStretch: 1.0, worleyInfluence: 0.5,
            edgeSoftness: 0.5, extinction: 0.05, albedo: 0.9, cauliflower: 0.35,
            precipitation: 0.0, darkness: 0.0, layerKind: 0.0
        };
        this._smoothedLayers = new Map();
        this._renderLayers = [];
        this._layerParamContext = null;

        this.cirrusTarget = null;
        this.cirrusTargetWidth = 0;
        this.cirrusTargetHeight = 0;
        this._cirrusQualitySettings = this._getCirrusQualitySettings();

        // CPU-side typed arrays matching the CirrusParams / MatrixUniforms / AtmosphereParams structs.
        this._matrixUniformData = new Float32Array(64);
        this._cirrusParamData   = new Float32Array(CIRRUS_PARAM_FLOATS);
        this._atmosphereData    = new Float32Array(12);

        this.blitMaterial = new Material({
            name: 'CirrusBlit',
            vertexShader: this._getBlitVertexShader(),
            fragmentShader: this._getBlitFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [{
                label: 'BlitTextures',
                entries: [
                    { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'sourceTexture' },
                    { binding: 1, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'sourceSampler' },
                    { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'blitParams' },
                ]
            }],
            uniforms: {
                sourceTexture: { value: null },
                sourceSampler: { value: 'linear' },
                blitParams: { value: new Float32Array(4) },
            },
            transparent: true,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'premultiplied'
        });

        // Two materials with the same shader: the far part of each ray (drawn behind the scene) and
        // the near part (drawn over it, see renderCirrus). Uniform buffers belong to a material and
        // are written at draw time, so one material drawn twice in a frame would give both draws
        // the last draw's parameters.
        const makeCirrusMaterial = (name, shellOnly = false) => new Material({
            name,
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getCirrusFragmentShader(shellOnly),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'CirrusUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'matrixUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'cirrusParams' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'atmosphereParams' }
                    ]
                },
                {
                    label: 'CirrusTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseBase' },
                        { binding: 1, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseDetail' },
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseErosion' },
                        { binding: 3, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerRepeat' },
                        { binding: 4, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'transmittanceLUT' },
                        { binding: 5, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerClamp' }
                    ]
                }
            ],
            uniforms: {
                matrixUniforms:   { value: new Float32Array(64) },
                cirrusParams:     { value: new Float32Array(CIRRUS_PARAM_FLOATS) },
                atmosphereParams: { value: new Float32Array(12) },
                noiseBase:          { value: null },
                noiseDetail:        { value: null },
                noiseErosion:       { value: null },
                noiseSamplerRepeat: { value: 'linear-repeat' },
                transmittanceLUT:   { value: null },
                noiseSamplerClamp:  { value: 'linear' }
            },
            transparent: true,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'premultiplied'
        });
        this.cirrusMaterial = makeCirrusMaterial('CirrusLayer_WebGPU');
        this.cirrusNearMaterial = makeCirrusMaterial('CirrusLayerNear_WebGPU');
        this.cirrusShellMaterial = makeCirrusMaterial('CirrusShell_WebGPU', true);
        this.cirrusShellNearMaterial = makeCirrusMaterial('CirrusShellNear_WebGPU', true);

        this.initialized = true;
    }

    // ---------------------------------------------------------------
    //  Per-frame update — populates cirrus uniform data
    // ---------------------------------------------------------------

    update(camera, environmentState, uniformManager) {
        if (!this.initialized || !this.cirrusMaterial || !this.planetConfig) return;

        if (this.noiseGenerator) {
            this.noiseGenerator.update(camera, environmentState, uniformManager, this.planetConfig);
        }

        const now = performance.now() / 1000;
        const dt = Math.min(Math.max(0, now - this._lastTime), 0.1);
        this._lastTime = now;
        this.frameCount++;

        // Smooth wind
        const targetWindDir   = environmentState?.windDirection || new Vector2(1, 0);
        const targetWindSpeed = environmentState?.windSpeed || 5.0;
        const lerpFactor = 1.0 - Math.exp(-dt * 1.8);

        this._smoothedWindSpeed += (targetWindSpeed - this._smoothedWindSpeed) * lerpFactor;
        this._smoothedWindDir.x += (targetWindDir.x - this._smoothedWindDir.x) * lerpFactor;
        this._smoothedWindDir.y += (targetWindDir.y - this._smoothedWindDir.y) * lerpFactor;
        this._smoothedWindDir.normalize();

        // Smooth every authored weather cloud layer. Layers are rendered
        // highest-first so dense rain decks blend over thin high cloud.
        const cloudLayersArray = environmentState?.cloudLayers || [];
        this._syncCloudLayers(cloudLayersArray, lerpFactor);

        // Accumulate wind offset
        this._windOffset.x += this._smoothedWindDir.x * this._smoothedWindSpeed * dt;
        this._windOffset.y += this._smoothedWindDir.y * this._smoothedWindSpeed * dt;

        // --- Matrix uniforms (shared with vertex shader) ---
        const inverseProjection = camera.projectionMatrix.clone().invert();
        const inverseView       = camera.matrixWorldInverse.clone().invert();

        const mat = this._matrixUniformData;
        mat.set(inverseView.elements, 0);
        mat.set(inverseProjection.elements, 16);
        mat[32] = camera.position.x;
        mat[33] = camera.position.y;
        mat[34] = camera.position.z;
        mat[35] = 0.0;
        for (let j = 36; j < 64; j++) mat[j] = 0.0;

        // --- Shared cloud param context ---
        const sunDir = (environmentState?.sunLightDirection ||
            uniformManager?.uniforms?.sunLightDirection?.value ||
            new Vector3(0, 1, 0)).clone().normalize();

        const origin       = this.planetConfig.origin || new Vector3(0, 0, 0);
        const planetRadius = this.planetConfig.radius || 2048;
        const atmosphereHeight = this.planetConfig.atmosphereHeight || planetRadius * 0.2;
        const cloudShellInner = this.planetConfig.cumulusInnerRadius || planetRadius + atmosphereHeight * 0.05;
        const cloudShellOuter = this.planetConfig.cumulusOuterRadius || planetRadius + atmosphereHeight * 0.15;
        const baseTileSize = Math.max((cloudShellOuter - cloudShellInner) * 12.0, 8000.0);
        const time = (performance.now() / 1000) % 100000;

        this._layerParamContext = {
            origin,
            planetRadius,
            sunDir,
            sunIntensity: environmentState?.sunIntensity || 5.0,
            time,
            baseTileSize,
        };

        // --- Atmosphere params ---
        if (uniformManager && uniformManager.uniforms.atmosphereRadius) {
            const ab = this._atmosphereData;
            const u  = uniformManager.uniforms;
            ab[0] = u.atmosphereRadius.value;
            ab[1] = u.atmosphereScaleHeightRayleigh.value;
            ab[2] = u.atmosphereScaleHeightMie.value;
            ab[3] = u.atmosphereMieAnisotropy.value;
            ab[4] = u.atmosphereRayleighScattering.value.x;
            ab[5] = u.atmosphereRayleighScattering.value.y;
            ab[6] = u.atmosphereRayleighScattering.value.z;
            ab[7] = u.atmosphereMieScattering.value;
        }

        // --- Texture bindings ---
        if (this.noiseGenerator) {
            const bv = this.noiseGenerator.getBaseTextureView?.();
            const dv = this.noiseGenerator.getDetailTextureView?.();
            const ev = this.noiseGenerator.getErosionTextureView?.();
            for (const m of this._cirrusMaterials()) {
                if (bv) m.uniforms.noiseBase.value   = { _isGPUTextureView: true, view: bv };
                if (dv) m.uniforms.noiseDetail.value = { _isGPUTextureView: true, view: dv };
                if (ev) m.uniforms.noiseErosion.value = { _isGPUTextureView: true, view: ev };
            }
        }

        if (uniformManager?.uniforms?.transmittanceLUT?.value) {
            const tLUT = uniformManager.uniforms.transmittanceLUT.value;
            if (tLUT?._gpuTexture) {
                for (const m of this._cirrusMaterials()) m.uniforms.transmittanceLUT.value = tLUT;
            }
        }

        const cp = this._cirrusParamData;
        if (this._renderLayers.length > 0) {
            this._writeLayerParams(this._renderLayers[0]);
        } else {
            this._writeLayerParams(this._defaultLayerParams);
        }

        // Push typed arrays into material uniforms.
        // The near material gets its own parameter array (it differs in the ray part, see renderCirrus).
        this._cirrusNearParamData ??= new Float32Array(CIRRUS_PARAM_FLOATS);
        this._cirrusNearParamData.set(cp);
        for (const m of this._cirrusMaterials()) {
            m.uniforms.matrixUniforms.value   = mat;
            const near = m === this.cirrusNearMaterial || m === this.cirrusShellNearMaterial;
            m.uniforms.cirrusParams.value     = near ? this._cirrusNearParamData : cp;
            m.uniforms.atmosphereParams.value = this._atmosphereData;
        }
    }

    _cirrusMaterials() {
        return [this.cirrusMaterial, this.cirrusNearMaterial, this.cirrusShellMaterial,
            this.cirrusShellNearMaterial].filter(Boolean);
    }

    // ---------------------------------------------------------------
    //  render() — dispatches the noise compute pass (cirrus depends on it)
    // ---------------------------------------------------------------

    render(camera, environmentState, uniformManager) {
        if (!this.initialized || !this.noiseGenerator?.needsDispatch) return;
        this.backend.endRenderPassForCompute();
        const commandEncoder = this.backend.getCommandEncoder();
        this.noiseGenerator.dispatch(commandEncoder);
        this.backend.resumeRenderPass();
    }

    // ---------------------------------------------------------------
    //  renderCirrus() — draws the cirrus shell
    // ---------------------------------------------------------------

    /**
     * part: 'far' draws only the cirrus beyond each ray's closest approach to the planet (behind any
     * lower cloud and ground on that ray; drawn before the scene), 'near' only the cirrus before it
     * (in front of them; drawn after the scene and the volumetric clouds), anything else the whole ray.
     * Cirrus lies above the cumulus, so on the way down a ray meets cirrus first and on the way up
     * cumulus first: the split is exact for every camera height.
     */
    renderCirrus(camera, environmentState, uniformManager, part = 'all', forceShell = false) {
        const partCode = part === 'near' ? 1 : part === 'far' ? 2 : 0;
        if (!this.initialized || !this.noiseGenerator) return;

        const layers = this._renderLayers.filter((layer) => layer.coverage > 0.01 && layer.altMax > layer.altMin);
        if (layers.length === 0) return;

        const settings = this._cirrusQualitySettings || this._getCirrusQualitySettings();
        const center = this._layerParamContext.origin;
        const altitude = Math.hypot(camera.position.x - center.x, camera.position.y - center.y,
            camera.position.z - center.z) - this._layerParamContext.planetRadius;
        const hasVolume = !forceShell && layers.some(layer => {
            const band = layer.altMax - layer.altMin;
            const middle = (layer.altMin + layer.altMax) * 0.5;
            const halfSlab = band * CIRRUS_SLAB_FRACTION * 0.5;
            return altitude > middle - halfSlab - band * 0.6 && altitude < middle + halfSlab + band * 5;
        });
        const material = hasVolume
            ? (partCode === 1 ? this.cirrusNearMaterial : this.cirrusMaterial)
            : (partCode === 1 ? this.cirrusShellNearMaterial : this.cirrusShellMaterial);
        if (!material?.uniforms.noiseBase.value) return;
        const params = material.uniforms.cirrusParams.value;
        const renderScale = hasVolume ? Math.min(settings.renderScale, this.config.cirrusVolumeScale) : settings.renderScale;

        if (renderScale < 0.99) {
            const backend = this.backend;
            const viewport = backend._viewport;
            const sceneTarget = backend._currentRenderTarget;
            const clearColor = backend._clearColor;
            this._ensureCirrusTarget(viewport.width, viewport.height, renderScale);
            try {
                backend.setRenderTarget(this.cirrusTarget);
                this.cirrusTarget._needsSetup = false;
                // This viewport is local to the cirrus target. setViewport would reallocate
                // the canvas depth texture both here and on the return to the HDR scene.
                backend._viewport = { x: 0, y: 0, width: this.cirrusTargetWidth, height: this.cirrusTargetHeight };
                backend.setClearColor(0.0, 0.0, 0.0, 0.0);
                backend.clear(true, false);
                for (const layer of layers) {
                    this._writeLayerParams(layer, partCode, params);
                    backend.draw(this.fullscreenGeometry, material);
                }
            } finally {
                backend._viewport = viewport;
                backend.setRenderTarget(sceneTarget);
                backend.setClearColor(clearColor.r, clearColor.g, clearColor.b, clearColor.a);
            }

            const srcView = this.cirrusTarget._gpuRenderTarget.colorViews[0];
            this.blitMaterial.uniforms.sourceTexture.value = { _isGPUTextureView: true, view: srcView };
            this.blitMaterial.uniforms.blitParams.value[0] = settings.renderScale < 0.99 ? 1 : 0;
            backend.resumeRenderPass();
            backend.draw(this.fullscreenGeometry, this.blitMaterial);
            return;
        }

        for (const layer of layers) {
            this._writeLayerParams(layer, partCode, params);
            this.backend.draw(this.fullscreenGeometry, material);
        }
    }

    // ---------------------------------------------------------------
    //  Cirrus quality
    // ---------------------------------------------------------------

    setCirrusQuality(quality) {
        const next = `${quality || ''}`.toLowerCase();
        if (this.config.cirrusQuality === next) return this._getCirrusQualityKey();

        this.config.cirrusQuality = next;
        const settings = this._getCirrusQualitySettings();
        this.config.cirrusQuality = settings.key;
        const changed = this._cirrusQualitySettings?.key !== settings.key;
        this._cirrusQualitySettings = settings;

        if (changed) {
            for (const m of this._cirrusMaterials()) {
                m.fragmentShader = this._getCirrusFragmentShader(m === this.cirrusShellMaterial || m === this.cirrusShellNearMaterial);
                m._needsCompile = true;
                m._gpuPipeline  = null;
            }
        }
        return settings.key;
    }

    _getCirrusQualityKey() {
        const raw = `${this.config.cirrusQuality || 'high'}`.toLowerCase();
        if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'ultra') return raw;
        return 'high';
    }

    _getCirrusQualitySettings() {
        const key = this._getCirrusQualityKey();
        const PRESETS = {
            low:    { key: 'low',    renderScale: 0.5, flowPasses: 0, warpStrength: 0.06, baseLod: 1.5, detailLod: 1.1, erosionLod: 0.9, detailFreq: 2.0, erosionFreq: 3.5, useErosion: false, extraDetail: false, extraDetailFreq: 4.0, extraDetailLod: 0.0, extraDetailWeight: 0.0 },
            medium: { key: 'medium', renderScale: 1.0, flowPasses: 1, warpStrength: 0.1,  baseLod: 1.2, detailLod: 0.9, erosionLod: 0.5, detailFreq: 2.3, erosionFreq: 4.2, useErosion: true,  extraDetail: false, extraDetailFreq: 4.4, extraDetailLod: 0.0, extraDetailWeight: 0.0 },
            high:   { key: 'high',   renderScale: 1.0, flowPasses: 2, warpStrength: 0.12, baseLod: 1.0, detailLod: 0.5, erosionLod: 0.0, detailFreq: 2.7, erosionFreq: 5.1, useErosion: true,  extraDetail: false, extraDetailFreq: 4.6, extraDetailLod: 0.0, extraDetailWeight: 0.0 },
            ultra:  { key: 'ultra',  renderScale: 1.0, flowPasses: 2, warpStrength: 0.12, baseLod: 1.0, detailLod: 0.35,erosionLod: 0.0, detailFreq: 3.0, erosionFreq: 5.6, useErosion: true,  extraDetail: true,  extraDetailFreq: 4.8, extraDetailLod: 0.0, extraDetailWeight: 0.25 },
        };
        return PRESETS[key] || PRESETS.high;
    }

    // ---------------------------------------------------------------
    //  Helpers
    // ---------------------------------------------------------------

    _ensureCirrusTarget(fullWidth, fullHeight, scale) {
        const tw = Math.max(1, Math.ceil(fullWidth * scale));
        const th = Math.max(1, Math.ceil(fullHeight * scale));
        if (this.cirrusTarget && this.cirrusTargetWidth === tw && this.cirrusTargetHeight === th) return;

        if (this.cirrusTarget) {
            this.backend.deleteRenderTarget?.(this.cirrusTarget);
            this.cirrusTarget.dispose?.();
        }
        this.cirrusTargetWidth  = tw;
        this.cirrusTargetHeight = th;
        this.cirrusTarget = new RenderTarget(tw, th, {
            colorCount: 1,
            depthBuffer: true,
            format: this.backend.sceneFormat || this.backend.format || 'rgba8unorm'
        });
    }

    dispose() {
        if (this.cirrusTarget) {
            this.backend.deleteRenderTarget(this.cirrusTarget);
            this.cirrusTarget.dispose();
            this.cirrusTarget = null;
        }
        for (const material of [...this._cirrusMaterials(), this.blitMaterial]) {
            if (material) this.backend.destroyMaterial(material);
        }
        super.dispose();
    }

    _syncCloudLayers(targetLayers, t) {
        const seen = new Set();
        for (const rawLayer of targetLayers) {
            if (!rawLayer || rawLayer.coverage <= 0.001) continue;
            const target = this._normalizeLayer(rawLayer);
            const key = target.name || `layer_${seen.size}`;
            seen.add(key);

            let current = this._smoothedLayers.get(key);
            if (!current) {
                current = { ...target, coverage: 0.0 };
                this._smoothedLayers.set(key, current);
            }
            this._smoothLayer(current, target, t);
        }

        for (const [key, current] of this._smoothedLayers.entries()) {
            if (seen.has(key)) continue;
            this._smoothLayer(current, { ...current, coverage: 0.0 }, t);
            if (current.coverage < 0.002) {
                this._smoothedLayers.delete(key);
            }
        }

        this._renderLayers = Array.from(this._smoothedLayers.values())
            .filter((layer) => layer.coverage > 0.002 && layer.altMax > layer.altMin)
            .filter((layer) => this._layerEnabled(layer))
            .sort((a, b) => b.altMax - a.altMax);
    }

    _layerEnabled(layer) {
        const name = `${layer?.name ?? ''}`.toLowerCase();
        if (name === 'low') return this.config.lowClouds !== false;
        if (name === 'mid') return this.config.midClouds !== false;
        if (name === 'high') return this.config.highClouds !== false;
        return true;
    }

    _normalizeLayer(layer) {
        const d = this._defaultLayerParams;
        const name = layer.name || d.name;
        return {
            name,
            altMin: Number.isFinite(layer.altMin) ? layer.altMin : d.altMin,
            altMax: Number.isFinite(layer.altMax) ? layer.altMax : d.altMax,
            coverage: Number.isFinite(layer.coverage) ? Math.max(0, Math.min(1, layer.coverage)) : d.coverage,
            densityMultiplier: Number.isFinite(layer.densityMultiplier) ? layer.densityMultiplier : d.densityMultiplier,
            noiseScale: Number.isFinite(layer.noiseScale) ? layer.noiseScale : d.noiseScale,
            verticalStretch: Number.isFinite(layer.verticalStretch) ? layer.verticalStretch : d.verticalStretch,
            worleyInfluence: Number.isFinite(layer.worleyInfluence) ? layer.worleyInfluence : d.worleyInfluence,
            edgeSoftness: Number.isFinite(layer.edgeSoftness) ? layer.edgeSoftness : d.edgeSoftness,
            extinction: Number.isFinite(layer.extinction) ? layer.extinction : d.extinction,
            albedo: Number.isFinite(layer.albedo) ? layer.albedo : d.albedo,
            cauliflower: Number.isFinite(layer.cauliflower) ? layer.cauliflower : d.cauliflower,
            precipitation: Number.isFinite(layer.precipitation) ? layer.precipitation : d.precipitation,
            darkness: Number.isFinite(layer.darkness) ? layer.darkness : d.darkness,
            layerKind: this._layerKindForName(name),
        };
    }

    _layerKindForName(name) {
        if (name === 'low') return 2.0;
        if (name === 'mid') return 1.0;
        return 0.0;
    }

    _smoothLayer(current, target, t) {
        current.name = target.name;
        current.layerKind = target.layerKind;
        current.altMin += (target.altMin - current.altMin) * t;
        current.altMax += (target.altMax - current.altMax) * t;
        current.coverage += (target.coverage - current.coverage) * t;
        current.densityMultiplier += (target.densityMultiplier - current.densityMultiplier) * t;
        current.noiseScale += (target.noiseScale - current.noiseScale) * t;
        current.verticalStretch += (target.verticalStretch - current.verticalStretch) * t;
        current.worleyInfluence += (target.worleyInfluence - current.worleyInfluence) * t;
        current.edgeSoftness += (target.edgeSoftness - current.edgeSoftness) * t;
        current.extinction += (target.extinction - current.extinction) * t;
        current.albedo += (target.albedo - current.albedo) * t;
        current.cauliflower += (target.cauliflower - current.cauliflower) * t;
        current.precipitation += (target.precipitation - current.precipitation) * t;
        current.darkness += (target.darkness - current.darkness) * t;
    }

    /** part: 0 the whole ray, 1 its near part, 2 its far part (see renderCirrus). */
    _writeLayerParams(layer, part = 0, cp = this._cirrusParamData) {
        const ctx = this._layerParamContext || {};
        const origin = ctx.origin || this.planetConfig?.origin || new Vector3(0, 0, 0);
        const planetRadius = ctx.planetRadius || this.planetConfig?.radius || 2048;
        const sunDir = ctx.sunDir || new Vector3(0, 1, 0);
        const atmosphereHeight = this.planetConfig?.atmosphereHeight || planetRadius * 0.2;
        const baseTileSize = ctx.baseTileSize || Math.max(atmosphereHeight * 0.12, 8000.0);
        let i = 0;

        cp[i++] = origin.x;  cp[i++] = origin.y;  cp[i++] = origin.z;  cp[i++] = planetRadius;
        cp[i++] = sunDir.x;  cp[i++] = sunDir.y;  cp[i++] = sunDir.z;  cp[i++] = ctx.sunIntensity || 5.0;
        cp[i++] = ctx.time || 0.0;  cp[i++] = this.config.cloudAnisotropy;  cp[i++] = baseTileSize;  cp[i++] = 0.0;
        cp[i++] = this._windOffset.x;  cp[i++] = this._windOffset.y;  cp[i++] = 0.0;  cp[i++] = 0.0;
        cp[i++] = layer.altMin;  cp[i++] = layer.altMax;  cp[i++] = layer.coverage;  cp[i++] = layer.noiseScale;
        cp[i++] = layer.albedo;  cp[i++] = layer.densityMultiplier;  cp[i++] = layer.verticalStretch;  cp[i++] = layer.worleyInfluence;
        cp[i++] = layer.edgeSoftness;  cp[i++] = layer.extinction;  cp[i++] = layer.precipitation;  cp[i++] = layer.darkness;
        cp[i++] = layer.layerKind;  cp[i++] = layer.cauliflower;  cp[i++] = part;  cp[i++] = 0.0;
    }

    // ---------------------------------------------------------------
    //  Shaders
    // ---------------------------------------------------------------

    _getVertexShader() {
        return /* wgsl */`
        struct MatrixUniforms {
            inverseView: mat4x4<f32>,
            inverseProjection: mat4x4<f32>,
            cameraPosition: vec3<f32>,
            _pad0: f32,
            _pad1: mat4x4<f32>
        };
        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) uv: vec2<f32>
        };
        @group(0) @binding(0) var<uniform> matrices: MatrixUniforms;

        @vertex
        fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var pos = array<vec2<f32>, 3>(
                vec2<f32>(-1.0, -1.0),
                vec2<f32>( 3.0, -1.0),
                vec2<f32>(-1.0,  3.0)
            );
            var output: VertexOutput;
            output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
            output.uv = pos[vertexIndex] * 0.5 + 0.5;
            return output;
        }
        `;
    }

    _getBlitVertexShader() {
        return /* wgsl */`
        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) uv: vec2<f32>
        };
        @vertex
        fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var pos = array<vec2<f32>, 3>(
                vec2<f32>(-1.0, -1.0),
                vec2<f32>( 3.0, -1.0),
                vec2<f32>(-1.0,  3.0)
            );
            var output: VertexOutput;
            output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
            output.uv = pos[vertexIndex] * 0.5 + 0.5;
            return output;
        }
        `;
    }

    _getBlitFragmentShader() {
        return /* wgsl */`
        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        @group(0) @binding(1) var sourceSampler: sampler;
        @group(0) @binding(2) var<uniform> blitParams: vec4f;

        @fragment
        fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
            let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);
            if (blitParams.x < 0.5) { return textureSampleLevel(sourceTexture, sourceSampler, flippedUV, 0.0); }
            // The low preset's existing 3x3 tent, grouped into four bilinear samples.
            let size = vec2f(textureDimensions(sourceTexture));
            let p = flippedUV * size - 0.5;
            let f = fract(p);
            let a = 0.75 - 0.5 * f;
            let b = 1.0 - a;
            let lo = (floor(p) - 0.5 + (0.5 - 0.25 * f) / a) / size;
            let hi = (floor(p) + 1.5 + 0.25 * f / b) / size;
            return textureSampleLevel(sourceTexture, sourceSampler, lo, 0.0) * (a.x * a.y)
                 + textureSampleLevel(sourceTexture, sourceSampler, vec2f(hi.x, lo.y), 0.0) * (b.x * a.y)
                 + textureSampleLevel(sourceTexture, sourceSampler, vec2f(lo.x, hi.y), 0.0) * (a.x * b.y)
                 + textureSampleLevel(sourceTexture, sourceSampler, hi, 0.0) * (b.x * b.y);
        }
        `;
    }

    _getCirrusFragmentShader(shellOnly = false) {
        const settings = this._cirrusQualitySettings || this._getCirrusQualitySettings();
        this._cirrusQualitySettings = settings;

        return /* wgsl */`
    // cirrus-quality:${settings.key}
    ${AERIAL_PERSPECTIVE_WGSL}

    struct MatrixUniforms {
        inverseView: mat4x4<f32>,
        inverseProjection: mat4x4<f32>,
        cameraPosition: vec3<f32>,
        _pad0: f32,
        _pad1: mat4x4<f32>
    };

    struct CirrusParams {
        planetCenter: vec3<f32>,
        planetRadius: f32,

        sunDir: vec3<f32>,
        sunIntensity: f32,

        time: f32,
        cloudAnisotropy: f32,
        baseTileSize: f32,
        _pad0: f32,

        windOffsetX: f32,
        windOffsetY: f32,
        _pad1: f32,
        _pad2: f32,

        altMin: f32,
        altMax: f32,
        coverage: f32,
        noiseScale: f32,

        albedo: f32,
        densityMultiplier: f32,
        verticalStretch: f32,
        worleyInfluence: f32,

        edgeSoftness: f32,
        extinction: f32,
        precipitation: f32,
        darkness: f32,

        layerKind: f32,
        cauliflower: f32,
        part: f32,          // 0 whole ray, 1 before its closest approach to the planet, 2 after
        _pad4: f32,
    };

    struct AtmosphereParams {
        atmosphereRadius: f32,
        scaleHeightRayleigh: f32,
        scaleHeightMie: f32,
        mieAnisotropy: f32,
        rayleighScattering: vec3<f32>,
        mieScattering: f32,
        _padAtmo: vec4<f32>,
    };

    @group(0) @binding(0) var<uniform> matrices: MatrixUniforms;
    @group(0) @binding(1) var<uniform> cp: CirrusParams;
    @group(0) @binding(2) var<uniform> atmo: AtmosphereParams;

    @group(1) @binding(0) var noiseBase: texture_3d<f32>;
    @group(1) @binding(1) var noiseDetail: texture_3d<f32>;
    @group(1) @binding(2) var noiseErosion: texture_3d<f32>;
    @group(1) @binding(3) var noiseSamplerRepeat: sampler;
    @group(1) @binding(4) var transmittanceLUT: texture_2d<f32>;
    @group(1) @binding(5) var noiseSamplerClamp: sampler;

    const TIME_SCALE: f32 = 0.066;
    const CIRRUS_FLOW_PASSES: i32 = ${settings.flowPasses};
    const CIRRUS_WARP_STRENGTH: f32 = ${settings.warpStrength};
    const CIRRUS_BASE_LOD: f32 = ${settings.baseLod};
    const CIRRUS_DETAIL_LOD: f32 = ${settings.detailLod};
    const CIRRUS_EROSION_LOD: f32 = ${settings.erosionLod};
    const CIRRUS_DETAIL_FREQ: f32 = ${settings.detailFreq};
    const CIRRUS_EROSION_FREQ: f32 = ${settings.erosionFreq};
    const CIRRUS_USE_EROSION: bool = ${settings.useErosion};
    const CIRRUS_EXTRA_DETAIL: bool = ${settings.extraDetail};
    const CIRRUS_EXTRA_DETAIL_FREQ: f32 = ${settings.extraDetailFreq};
    const CIRRUS_EXTRA_DETAIL_LOD: f32 = ${settings.extraDetailLod};
    const CIRRUS_EXTRA_DETAIL_WEIGHT: f32 = ${settings.extraDetailWeight};

    fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
        let clip = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
        let view = matrices.inverseProjection * clip;
        let world = matrices.inverseView * vec4<f32>(view.xyz / view.w, 0.0);
        return normalize(world.xyz);
    }

    fn sampleNoise3D(tex: texture_3d<f32>, coord: vec3<f32>, lod: f32) -> vec4<f32> {
        return textureSampleLevel(tex, noiseSamplerRepeat, fract(coord), lod);
    }

    fn domainWarp(coord: vec3<f32>, strength: f32) -> vec3<f32> {
        let warpSample = sampleNoise3D(noiseErosion, coord * 0.25, 2.0).xyz;
        return coord + (warpSample - vec3<f32>(0.5)) * strength;
    }

    fn softenSunTransmittance(alt: f32, sunZenith: f32, sunTrans: vec3<f32>) -> vec3<f32> {
        let atmoHeight = max(atmo.atmosphereRadius - cp.planetRadius, 1.0);
        let altNorm = clamp(alt / atmoHeight, 0.0, 1.0);
        let terminatorWidth = mix(0.7, 0.18, altNorm);
        let terminatorCenter = mix(-0.25, -0.08, altNorm);
        let sunVisibility = smoothstep(terminatorCenter - terminatorWidth, terminatorCenter + terminatorWidth, sunZenith);
        let twilightFloor = mix(vec3<f32>(0.06, 0.07, 0.09), vec3<f32>(0.01, 0.015, 0.02), altNorm);
        return mix(twilightFloor, sunTrans, sunVisibility);
    }

    fn flowAdvect(coord: vec3<f32>, time: f32, speed: f32, strength: f32) -> vec3<f32> {
        let flowSample = sampleNoise3D(noiseErosion, coord * 0.12 + vec3<f32>(time * speed, 0.0, time * speed), 1.0).xy;
        let flow = (flowSample - vec2<f32>(0.5)) * 2.0;
        return coord + vec3<f32>(flow.x, 0.0, flow.y) * strength;
    }

    fn getAltitude(worldPos: vec3<f32>) -> f32 {
        return length(worldPos - cp.planetCenter) - cp.planetRadius;
    }

    // Colour and column opacity of the cirrus pattern at pos (shared by the shell and the volume).
    // footprint: size of the pixel (or sample) at pos in world units; picks noise mip levels.
    fn cirrusAt(up: vec3<f32>, radius: f32, rayDir: vec3<f32>, sunDir: vec3<f32>, intensity: f32, footprint: f32) -> vec4<f32> {
        // ---- Noise sampling ----
        let nsScale  = max(cp.noiseScale, 0.1);
        let denseLayer = clamp(cp.layerKind * 0.5, 0.0, 1.0);
        let tileSize = cp.baseTileSize * mix(5.0, 1.8, denseLayer) / nsScale;

        let rel = up * radius;

        let streakScale = mix(4.0, 1.15, denseLayer);
        let sideScale = mix(0.5, 1.2, denseLayer);
        let verticalScale = max(0.05, cp.verticalStretch * mix(0.35, 0.55, denseLayer));
        // The radial position has zero projection onto both local wind tangents.
        let p = rel * verticalScale;

        let cirrusTime = cp.time * TIME_SCALE;
        let windDrift  = vec3<f32>(cp.windOffsetX * 0.0001, 0.0, cp.windOffsetY * 0.0001);
        let coord = p / tileSize + windDrift * cirrusTime;

        var flowCoord = coord;
        if (CIRRUS_WARP_STRENGTH > 0.0) { flowCoord = domainWarp(flowCoord, CIRRUS_WARP_STRENGTH); }
        if (CIRRUS_FLOW_PASSES >= 1) { flowCoord = flowAdvect(flowCoord, cirrusTime * 0.15, 0.4, 0.35); }
        if (CIRRUS_FLOW_PASSES >= 2) { flowCoord = flowAdvect(flowCoord + vec3<f32>(0.5, 0.3, 0.7), cirrusTime * 0.08, 0.3, 0.2); }
        if (CIRRUS_FLOW_PASSES >= 3) { flowCoord = flowAdvect(flowCoord + vec3<f32>(0.17, 0.53, 0.31), cirrusTime * 0.05, 0.25, 0.15); }

        // Mip levels from the footprint (in noise-texture texels, along the streak axis where the
        // pattern is finest). Fixed levels sampled the full-resolution noise at any distance, which
        // aliased into speckles that flickered as the camera moved.
        let minif = max(footprint, 1.0e-3) * max(streakScale, sideScale) / tileSize;
        let n0 = sampleNoise3D(noiseBase, flowCoord + vec3<f32>(0.17, 0.23, 0.13),
            max(CIRRUS_BASE_LOD, log2(minif * 64.0))).r;
        var n1 = sampleNoise3D(noiseDetail, flowCoord * CIRRUS_DETAIL_FREQ + vec3<f32>(0.51, 0.07, 0.29),
            max(CIRRUS_DETAIL_LOD, log2(minif * CIRRUS_DETAIL_FREQ * 96.0))).r;
        var n2: f32 = 0.5;
        if (CIRRUS_USE_EROSION) {
            n2 = sampleNoise3D(noiseErosion, flowCoord * CIRRUS_EROSION_FREQ + vec3<f32>(0.11, 0.67, 0.41),
                max(CIRRUS_EROSION_LOD, log2(minif * CIRRUS_EROSION_FREQ * 128.0))).r;
        }
        if (CIRRUS_EXTRA_DETAIL) {
            let n1b = sampleNoise3D(noiseDetail, flowCoord * CIRRUS_EXTRA_DETAIL_FREQ + vec3<f32>(0.21, 0.61, 0.43),
                max(CIRRUS_EXTRA_DETAIL_LOD, log2(minif * CIRRUS_EXTRA_DETAIL_FREQ * 96.0))).r;
            n1 = mix(n1, n1b, CIRRUS_EXTRA_DETAIL_WEIGHT);
        }

        let ridge = 1.0 - abs(n1 * 2.0 - 1.0);
        let coverage = clamp(cp.coverage, 0.0, 1.0);
        let coverageT = min(coverage, 0.82);
        let worley = clamp(cp.worleyInfluence, 0.0, 1.0);

        let ridgeInfluence = mix(mix(0.7, 0.45, coverageT), worley, denseLayer);
        let cauliflowerMask = clamp(cp.cauliflower, 0.0, 1.0);
        let fbm = n0 * (1.0 - ridgeInfluence) + ridge * ridgeInfluence + n2 * mix(0.12, 0.28, cauliflowerMask);

        let thresh = mix(0.42, 0.12, coverageT);
        let softWidth = mix(0.18, 0.52, clamp(cp.edgeSoftness, 0.0, 1.0));
        var shape = smoothstep(thresh, min(thresh + softWidth, 0.98), fbm);
        let ridgeMask = smoothstep(0.18, 0.85, ridge);
        let gapNoise  = smoothstep(0.12, 0.85, n2);
        shape *= mix(0.6, 1.0, ridgeMask) * mix(0.7, 1.0, gapNoise);
        shape = mix(shape, max(shape, smoothstep(thresh - 0.08, thresh + 0.25, n0)), denseLayer * 0.45);

        // ---- Lighting ----
        let alt = radius - cp.planetRadius;
        let sunZenith = dot(up, sunDir);
        let sunTransRaw = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, alt, sunZenith, cp.planetRadius, atmo.atmosphereRadius);
        let sunTrans = softenSunTransmittance(alt, sunZenith, sunTransRaw);

        let stormShade = clamp(cp.darkness + cp.precipitation * 0.28 + cp.extinction * 4.0, 0.0, 0.88);
        let ambientCirrus = mix(vec3<f32>(0.6, 0.65, 0.7), vec3<f32>(0.22, 0.25, 0.30), stormShade);

        let sunBrightness = max(max(sunTrans.r, sunTrans.g), sunTrans.b);
        let neutralSunTrans = mix(vec3<f32>(sunBrightness), sunTrans, 0.35);
        let litColor = max(neutralSunTrans, vec3<f32>(0.22)) * cp.albedo * intensity;
        // Lit and ambient terms have fixed floors, so dim the whole colour with the sun: at night the
        // cirrus glowed bright grey.
        let daylight = mix(0.07, 1.0, smoothstep(0.02, 0.35, sunBrightness));
        var color = mix(litColor + ambientCirrus * 0.45, litColor * 0.36 + ambientCirrus * 0.78, stormShade) * daylight;
        // Seen from above, the sunlit top reflects sunlight like other cloud tops. Without this the
        // layer was about as bright as the sunlit ground under it and vanished from above, while
        // from below (against the sky) the same colour reads white.
        let lookingDown = smoothstep(0.0, 0.3, -dot(rayDir, up));
        color *= mix(1.0, CIRRUS_TOP_GAIN, lookingDown * smoothstep(0.0, 0.25, sunZenith));

        // Large-scale breakup (fields a few tiles across): real cirrus comes in bands and patches with
        // clear sky between, not one even veil; from above it read as a uniform sheet.
        let breakCoord = rel / (tileSize * 3.0) + windDrift * cirrusTime * 0.3 + vec3<f32>(0.37, 0.11, 0.71);
        let breakN = sampleNoise3D(noiseBase, breakCoord, max(0.5, log2(max(footprint, 1.0e-3) / (tileSize * 3.0) * 64.0))).r;
        let breakN2 = sampleNoise3D(noiseBase, breakCoord * 2.7 + vec3<f32>(0.53, 0.19, 0.83),
            max(0.5, log2(max(footprint, 1.0e-3) / (tileSize * 3.0) * 64.0 * 2.7))).r;
        // Clumped rather than thinned: opacity gathers into patches with clear gaps between them, so
        // the layer has structure from above instead of reading as an even veil.
        let breakup = mix(0.05, 1.5, smoothstep(0.42, 0.62, breakN * 0.7 + breakN2 * 0.3));
        let alpha = shape * breakup * coverage * (0.75 + clamp(cp.densityMultiplier, 0.0, 2.5) * 0.75);
        return vec4<f32>(color, clamp(alpha, 0.0, 1.0));
    }

    // Horizon fade shared by shell and volume.
    fn horizonFadeFor(rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> f32 {
        let camAlt = getAltitude(rayOrigin);
        let distToCenter = length(rayOrigin - cp.planetCenter);
        let camUp = normalize(rayOrigin - cp.planetCenter);
        let cosViewUp = dot(rayDir, camUp);
        let cosGeoHorizon = -sqrt(max(0.0, 1.0 - (cp.planetRadius / distToCenter) * (cp.planetRadius / distToCenter)));
        let cirrusAltFrac = clamp(camAlt / max(cp.altMax, 1.0), 0.0, 1.0);
        let cirrusFadeW   = mix(0.06, 0.005, sqrt(cirrusAltFrac));
        return smoothstep(cosGeoHorizon - cirrusFadeW, cosGeoHorizon + cirrusFadeW * 2.0, cosViewUp);
    }

    // 1 for rays from above that miss the planet (they cross the layer edge-on and drew a ring
    // around the planet from orbit), 0 otherwise.
    fn missesPlanet(oc: vec3<f32>, bCoeff: f32, band: f32) -> f32 {
        let closestAlt = sqrt(max(dot(oc, oc) - bCoeff * bCoeff, 0.0)) - cp.planetRadius;
        return select(1.0, smoothstep(-band * 0.02, 0.0, closestAlt), bCoeff < 0.0);
    }

    // The layer drawn as one surface at its mid radius: right from the ground and from far above.
    fn shellSample(rayOrigin: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>, intensity: f32, tPlanet: f32, pixAngle: f32) -> vec4<f32> {
        let innerR = cp.planetRadius + cp.altMin;
        let outerR = cp.planetRadius + cp.altMax;
        let band   = outerR - innerR;
        let midR   = (innerR + outerR) * 0.5;
        let camAlt = getAltitude(rayOrigin);
        let oc     = rayOrigin - cp.planetCenter;
        let bCoeff = dot(oc, rayDir);
        let disc   = bCoeff * bCoeff - (dot(oc, oc) - midR * midR);
        if (disc < 0.0) { return vec4<f32>(0.0); }
        let sqrtDisc = sqrt(disc);
        let tMid0 = -bCoeff - sqrtDisc;
        let tMid1 = -bCoeff + sqrtDisc;
        var tSample: f32;
        if (tMid0 > 0.01) { tSample = tMid0; }
        else if (tMid1 > 0.01) { tSample = tMid1; }
        else { return vec4<f32>(0.0); }
        if (tSample > tPlanet) { return vec4<f32>(0.0); }
        if (!inRayPart(tSample, -bCoeff)) { return vec4<f32>(0.0); }

        let up = normalize(oc + rayDir * tSample);
        // Footprint on the shell, stretched at grazing angles.
        let cosN = abs(dot(rayDir, up));
        let c = cirrusAt(up, midR, rayDir, sunDir, intensity, tSample * pixAngle / max(cosN, 0.12));
        let midAlt = 0.5 * (cp.altMin + cp.altMax);
        // The horizon fade hides rays below the horizon, which from below the layer hit the planet
        // first. From above those rays look down onto the layer, so it must not apply there: it left
        // the cirrus visible only against space.
        let belowLayer = 1.0 - smoothstep(midAlt - band * 0.2, midAlt + band * 0.2, camAlt);
        // Seen from above (where the shell takes over from the volume, far above the layer), a slanted
        // ray crosses more of the layer, as the volume integrates it, and the edge-on part at the limb
        // stays: fading it there (and against space) erased the layer the volume had just shown.
        let fromAbove = smoothstep(midAlt, midAlt + band * 0.35, camAlt);
        let slant = mix(1.0, 1.0 / max(cosN, 0.05), fromAbove);
        var alpha = 1.0 - pow(1.0 - min(c.a, 0.98), slant);
        if (belowLayer > 0.0) { alpha *= mix(1.0, horizonFadeFor(rayOrigin, rayDir), belowLayer); }

        // Fade as the camera nears the surface, so flying through it does not pop.
        alpha *= smoothstep(0.0, band * 0.35, abs(camAlt - midAlt));
        // Grazing rays from below.
        alpha *= mix(smoothstep(0.0, 0.08, cosN), 1.0, fromAbove);
        alpha = clamp(alpha, 0.0, 1.0);
        return vec4<f32>(c.rgb * alpha, alpha);
    }

    // Near or far part of the ray (cp.part; see renderCirrus). tStar: closest approach to the planet.
    fn inRayPart(t: f32, tStar: f32) -> bool {
        if (cp.part > 1.5) { return t > tStar; }
        if (cp.part > 0.5) { return t <= tStar; }
        return true;
    }

    // Mean of the sheet profile 1 - d^2 (0 outside |d| < 1) over [d0, d1]. Evaluated at one height
    // per shell, the profile became a staircase that showed as faint horizontal bands wherever rays
    // cross the sheet at a shallow angle (from below and near the layer).
    fn sheetProfileMean(d0: f32, d1: f32) -> f32 {
        if (d1 - d0 < 1.0e-4) {
            let d = 0.5 * (d0 + d1);
            return max(1.0 - d * d, 0.0);
        }
        let x0 = clamp(d0, -1.0, 1.0);
        let x1 = clamp(d1, -1.0, 1.0);
        return ((x1 - x1 * x1 * x1 / 3.0) - (x0 - x0 * x0 * x0 / 3.0)) / (d1 - d0);
    }

    fn sphereHit(oc: vec3<f32>, rd: vec3<f32>, r: f32) -> vec2<f32> {
        let b = dot(oc, rd);
        let d = b * b - (dot(oc, oc) - r * r);
        if (d < 0.0) { return vec2<f32>(1.0e30, -1.0e30); }
        let s = sqrt(d);
        return vec2<f32>(-b - s, -b + s);
    }

    // The layer as a volume, for a camera near it: the same pattern, in a sheet about
    // CIRRUS_SHEET_FRACTION of the band thick whose height wanders (by a low-frequency noise) through a
    // slab CIRRUS_SLAB_FRACTION of the band thick. A sheet at one radius had a perfectly spherical
    // base and top; seen edge-on from near them they drew a clear band and seams along the horizon.
    // Fixed-radius shells the slab is cut into for sampling (see volumeSample).
    const CIRRUS_VOLUME_STEPS: i32 = 24;
    const CIRRUS_SLAB_FRACTION: f32 = ${CIRRUS_SLAB_FRACTION};
    const CIRRUS_SHEET_FRACTION: f32 = 0.16;
    // Distance from the camera (world units) the volume is integrated to: past every edge-on view
    // below the hand-off back to the shell, so the layer converges to the horizon like a real deck.
    const CIRRUS_MAX_DISTANCE: f32 = 400000.0;
// Brightness of the sunlit top relative to the underside (see cirrusAt).
const CIRRUS_TOP_GAIN: f32 = 3.0;

    // A smooth swell from three plane waves on the sphere (wavelengths ~16-40 km for the high layer).
    // It was a linear lookup on mip 3 of the 64^3 base noise: a ~5 km grid with a break in the
    // sheet's tilt at every texel. The path through a thin sheet seen nearly edge-on follows its
    // tilt, so each break showed as a straight seam across the cirrus.
    fn sheetCenterOffset(up: vec3<f32>, tileSize: f32, slab: f32, sheet: f32) -> f32 {
        let x = up * (cp.planetRadius / (tileSize * 2.2));
        let w = sin(dot(x, vec3<f32>(0.62, 0.48, -0.62)) * 6.3 + 0.4) * 0.45
              + sin(dot(x, vec3<f32>(-0.27, 0.83, 0.49)) * 9.7 + 2.1) * 0.33
              + sin(dot(x, vec3<f32>(0.71, -0.36, 0.60)) * 15.1 + 4.7) * 0.22;
        return (smoothstep(0.2, 0.8, 0.5 + 0.5 * w) - 0.5) * (slab - sheet);
    }

    fn volumeSample(rayOrigin: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>, intensity: f32, tPlanet: f32, pixAngle: f32) -> vec4<f32> {
        let midR   = cp.planetRadius + 0.5 * (cp.altMin + cp.altMax);
        let slab   = (cp.altMax - cp.altMin) * CIRRUS_SLAB_FRACTION;
        let sheet  = (cp.altMax - cp.altMin) * CIRRUS_SHEET_FRACTION;
        let innerR = midR - 0.5 * slab;
        let outerR = midR + 0.5 * slab;
        let nsScale = max(cp.noiseScale, 0.1);
        let tileSize = cp.baseTileSize * mix(5.0, 1.8, clamp(cp.layerKind * 0.5, 0.0, 1.0)) / nsScale;
        let oc     = rayOrigin - cp.planetCenter;
        // World-anchored sampling, like the cumulus steps: the slab is cut into CIRRUS_VOLUME_STEPS
        // shells of fixed radius, and each stretch of the ray between two shells (one, or two where the
        // ray dips into the shell and comes back out) gets one sample weighted by its exact length.
        // Moving the camera slides each sample along its shell instead of re-spacing samples along the
        // ray, which shuffled the streaks while climbing or descending; and the stretches change
        // continuously with the ray, so neighbouring rays never split differently (no seams).
        let bq = dot(oc, rayDir);
        let cq = dot(oc, oc);
        let tStar = -bq;
        let closestSquared = cq - bq * bq;
        let outerD = outerR * outerR - closestSquared;
        if (outerD <= 0.0) { return vec4<f32>(0.0); }
        let outerS = sqrt(outerD);
        var rayStart = max(tStar - outerS, 0.0);
        var rayEnd = min(tStar + outerS, min(tPlanet, CIRRUS_MAX_DISTANCE));
        if (cp.part > 1.5) { rayStart = max(rayStart, tStar); }
        else if (cp.part > 0.5) { rayEnd = min(rayEnd, tStar); }
        if (rayEnd <= rayStart) { return vec4<f32>(0.0); }

        let rClosest = sqrt(max(closestSquared, 0.0));
        let dr = slab / f32(CIRRUS_VOLUME_STEPS);
        var tau = 0.0;
        var colorSum = vec3<f32>(0.0);
        var prevD = innerR * innerR - closestSquared;
        var prevS = sqrt(max(prevD, 0.0));
        for (var k = 0; k < CIRRUS_VOLUME_STEPS; k++) {
            let rHi = innerR + f32(k + 1) * dr;
            let hiD = rHi * rHi - closestSquared;
            let loD = prevD;
            let loS = prevS;
            let hiS = sqrt(max(hiD, 0.0));
            prevD = hiD;
            prevS = hiS;
            if (hiD <= 0.0) { continue; }
            var spans: array<vec2<f32>, 2>;
            var spanCount = 1;
            if (loD > 0.0) {
                let descend = vec2<f32>(-bq - hiS, -bq - loS);
                let ascend = vec2<f32>(-bq + loS, -bq + hiS);
                spans[0] = select(descend, ascend, rayStart >= tStar);
                if (rayStart < tStar && rayEnd > tStar) {
                    spans[1] = ascend;
                    spanCount = 2;
                }
            } else {
                spans[0] = vec2<f32>(-bq - hiS, -bq + hiS);
            }
            for (var j = 0; j < spanCount; j++) {
                let a = max(spans[j].x, rayStart);
                let b = min(spans[j].y, rayEnd);
                if (b <= a) { continue; }
                let len = b - a;
                let t = 0.5 * (a + b);
                let up = normalize(oc + rayDir * t);
                let center = midR + sheetCenterOffset(up, tileSize, slab, sheet);
                // Heights the stretch covers: its ends, down to the closest approach when the ray
                // turns inside it.
                let rA = length(oc + rayDir * a);
                let rB = length(oc + rayDir * b);
                var rLow = min(rA, rB);
                if (tStar > a && tStar < b) { rLow = rClosest; }
                let h0 = (rLow - center) / sheet + 0.5;
                let h1 = (max(rA, rB) - center) / sheet + 0.5;
                if (h1 <= 0.0 || h0 >= 1.0) { continue; }
                // Prefilter along the ray by at most half a sheet (a whole far, edge-on stretch would
                // average the pattern away and no ray could thread through a gap).
                // The wisp pattern is read at the slab's middle radius, the same for every shell: read at
                // each shell's own radius, the noise's variation with height made the shells show as bands
                // edge-on that squeezed and stretched (an accordion) as the camera moved vertically. The
                // sheet's thickness below still follows this pattern, so its edges stay ragged.
                let c = cirrusAt(up, midR, rayDir, sunDir, intensity, max(t * pixAngle, min(len * 0.5, sheet * 0.5)));
                // The sheet is as thick as the pattern is dense: dense patches fill it, thin wisps are thin
                // and clear gaps have none. So its top and base are the ragged edges of the same wisps
                // seen from below (as cumulus shapes come from their own noise), not a cut sphere. The
                // floor keeps thin wisps thicker than the shell spacing.
                let w = mix(0.4, 1.0, smoothstep(0.05, 0.5, c.a));
                let profile = sheetProfileMean((2.0 * h0 - 1.0) / w, (2.0 * h1 - 1.0) / w);
                if (profile <= 0.0) { continue; }
                // Column optical depth -ln(1 - a), spread over the profile (its integral is 2/3 w sheets).
                let dTau = -log(1.0 - min(c.a, 0.98)) / (sheet * w) * profile * 1.5 * len;
                tau += dTau;
                colorSum += c.rgb * dTau;
            }
        }
        if (tau <= 0.0) { return vec4<f32>(0.0); }
        // A thin layer of nearly uniform colour: composited order-independently.
        let T = exp(-tau);
        let L = colorSum / tau * (1.0 - T);
        // No limb fade: the layer seen edge-on against space is the same cirrus as over the planet.
        // Fading it (an old fix for a halo when cirrus showed only against space) erased the layer
        // while climbing through it.
        return vec4<f32>(L, 1.0 - T);
    }

    @fragment
    fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let rayDir = getRayDirection(uv);
        // Angle covered by one pixel (uniform control flow, before any branch).
        let pixAngle = max(length(fwidth(rayDir)), 1.0e-5);
        let rayOrigin = matrices.cameraPosition;
        let sunDir = normalize(cp.sunDir);
        if (cp.coverage <= 0.01 || cp.altMax <= cp.altMin) {
            return vec4<f32>(0.0);
        }
        let band = cp.altMax - cp.altMin;
        let camAlt = getAltitude(rayOrigin);
        let oc = rayOrigin - cp.planetCenter;
        let planet = sphereHit(oc, rayDir, cp.planetRadius);
        var tPlanet = 1.0e30;
        if (planet.x < planet.y && planet.x > 0.0) { tPlanet = planet.x; }
        let intensity = mix(0.7, 1.2, ap_miePhase(dot(rayDir, sunDir), cp.cloudAnisotropy));
        if (${shellOnly}) { return shellSample(rayOrigin, rayDir, sunDir, intensity, tPlanet, pixAngle); }

        // From the ground the layer is a shell. Well below it (just above the cumulus tops) it turns into
        // the real volume with the same pattern, which can be flown through; it hands back to the shell
        // only far above the layer (as the cumulus hands over to its proxy). Both hand-offs happen far
        // from the layer.
        let midAlt = 0.5 * (cp.altMin + cp.altMax);
        let halfSlab = 0.5 * band * CIRRUS_SLAB_FRACTION;
        let volMix = smoothstep(midAlt - halfSlab - band * 0.6, midAlt - halfSlab - band * 0.3, camAlt)
                   * (1.0 - smoothstep(midAlt + halfSlab + band * 3.0, midAlt + halfSlab + band * 5.0, camAlt));
        var result = vec4<f32>(0.0);
        if (volMix < 0.999) { result = shellSample(rayOrigin, rayDir, sunDir, intensity, tPlanet, pixAngle); }
        if (volMix > 0.001) {
            result = mix(result, volumeSample(rayOrigin, rayDir, sunDir, intensity, tPlanet, pixAngle), volMix);
        }
        return result;
    }
        `;
    }
}

const CIRRUS_PARAM_FLOATS = 32;
