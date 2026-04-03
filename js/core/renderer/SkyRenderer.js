import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Geometry } from './resources/geometry.js';
import { Material } from './resources/material.js';
import { RenderTarget } from './resources/renderTarget.js';
import { TextureFormat } from './resources/texture.js';
export class SkyRenderer {
    constructor(backend, atmosphereLUT, options = {}) {
        if (!options.nightSkyTheme) {
            throw new Error('SkyRenderer requires options.nightSkyTheme (NightSkyGameConfig, getNightSkyDetailPreset, NightSkyDetailLevel)');
        }
        this._nightSkyTheme = options.nightSkyTheme;
        this.NightSkyGameConfig = options.nightSkyTheme.NightSkyGameConfig;
        this.getNightSkyDetailPreset = options.nightSkyTheme.getNightSkyDetailPreset;
        this.NightSkyDetailLevel = options.nightSkyTheme.NightSkyDetailLevel;

        this.backend = backend;
        this.atmosphereLUT = atmosphereLUT;
        this.enabled = true;
        this.numSamples = 16;
        this.initialized = false;
        this.skyMaterial = null;
        this.fullscreenGeometry = null;

        // Time tracking for animations
        this._time = 0;
        this._lastFrameTime = performance.now();

        // Night sky configuration
        this._nightSkyConfig = options.nightSkyConfig instanceof this.NightSkyGameConfig
            ? options.nightSkyConfig
            : new this.NightSkyGameConfig(options.nightSkyConfig || {});

        // Detail level from engine config
        this._detailLevel = options.detailLevel || this.NightSkyDetailLevel.MEDIUM;
        this._detailPreset = this.getNightSkyDetailPreset(this._detailLevel);
        
        // Altitude threshold for LOD switching (meters)
        // LOD 0 = ground (less detail), LOD 1 = space (more detail)
        this._spaceLODThreshold = options.spaceLODThreshold ?? 50000;
        this._currentSpaceLOD = 0;

        // Low-res offscreen rendering (quarter resolution by default)
        this._resolutionScale = options.skyResolutionScale ?? 0.5; // 0.5 = quarter pixels
        this._skyRT = null;
        this._skyRTWidth = 0;
        this._skyRTHeight = 0;
        this._blitMaterial = null;
    }

    /**
     * Update night sky configuration at runtime.
     */
    setNightSkyConfig(config) {
        this._nightSkyConfig = config instanceof this.NightSkyGameConfig
            ? config
            : new this.NightSkyGameConfig(config || {});
    }

    /**
     * Update detail level at runtime.
     */
    setDetailLevel(level) {
        this._detailLevel = level;
        this._detailPreset = this.getNightSkyDetailPreset(level);
    }

    /**
     * Set the altitude threshold for space LOD.
     */
    setSpaceLODThreshold(meters) {
        this._spaceLODThreshold = meters;
    }


    _ensureSkyRT(fullWidth, fullHeight) {
        const w = Math.max(1, Math.ceil(fullWidth * this._resolutionScale));
        const h = Math.max(1, Math.ceil(fullHeight * this._resolutionScale));
        if (this._skyRTWidth === w && this._skyRTHeight === h && this._skyRT) return;

        if (this._skyRT) {
            this.backend.deleteRenderTarget?.(this._skyRT);
            this._skyRT.dispose?.();
        }

        this._skyRTWidth = w;
        this._skyRTHeight = h;
        this._skyRT = new RenderTarget(w, h, {
            colorCount: 1,
            format: TextureFormat.RGBA16F,
            depthBuffer: false
        });
    }

    async initialize() {
        if (!this.backend) {
            return;
        }

        const apiName = this.backend.getAPIName?.() || 'webgl2';

        if (apiName === 'webgpu') {
            await this._initializeWebGPU();
        } else {
            await this._initializeWebGL2();
        }

        this.initialized = true;
    }

    async _initializeWebGPU() {
        this.vertexWGSL = this._getSkyVertexWGSL();
        this.fragmentWGSL = this._getSkyFragmentWGSL();
        this.fullscreenGeometry = this._createFullscreenTriangle();
        this.skyMaterial = new Material({
            name: 'SkyRenderer_WebGPU',
            vertexShader: this.vertexWGSL,
            fragmentShader: this.fragmentWGSL,
            bindGroupLayoutSpec: [
                {
                    label: 'SkyUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'skyUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'invViewProj' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'nightSkyConfig' },
                        { binding: 3, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'nightSkyDetail' }
                    ]
                },
                {
                    label: 'Transmittance',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float' }, name: 'transmittanceLUT' },
                        { binding: 1, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'transmittanceSampler' },
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float' }, name: 'multiScatterLUT' },
                        { binding: 3, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'multiScatterSampler' }
                    ]
                }
            ],
            uniforms: {
                skyUniforms: { value: new Float32Array(28) },  // Increased for time
                invViewProj: { value: new Float32Array(16) },
                nightSkyConfig: { value: new Float32Array(16) },
                nightSkyDetail: { value: new Float32Array(12) },
                transmittanceLUT: { value: this.atmosphereLUT?.transmittanceLUT || null },
                transmittanceSampler: { value: 'linear' },
                multiScatterLUT: { value: this.atmosphereLUT?.multiScatterLUT || null },
                multiScatterSampler: { value: 'linear' }
            },
            vertexLayout: [],
            depthTest: false,
            depthWrite: false,
            side: 'double',
            targetFormat: 'rgba16float'
        });
        if (this.backend.compileShader) {
            this.backend.compileShader(this.skyMaterial);
        }

        // Blit material for upscaling low-res sky to screen
        this._blitMaterial = new Material({
            name: 'SkyBlit_WebGPU',
            vertexShader: this._getBlitVertexWGSL(),
            fragmentShader: this._getBlitFragmentWGSL(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'SkyBlitTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'sourceTexture' },
                        { binding: 1, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'sourceSampler' }
                    ]
                }
            ],
            uniforms: {
                sourceTexture: { value: null },
                sourceSampler: { value: 'linear' }
            },
            transparent: false,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always'
        });
        if (this.backend.compileShader) {
            this.backend.compileShader(this._blitMaterial);
        }
    }

    async _initializeWebGL2() {
        this.vertexShader = this._getSkyVertexGLSL();
        this.fragmentShader = this._getSkyFragmentGLSL();

        this.fullscreenGeometry = this._createFullscreenTriangle();
        this.skyMaterial = new Material({
            name: 'SkyRenderer_WebGL2',
            vertexShader: this.vertexShader,
            fragmentShader: this.fragmentShader,
            uniforms: {
                cameraPosition: { value: new THREE.Vector3() },
                viewerAltitude: { value: 0.0 },
                sunDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
                planetCenter: { value: new THREE.Vector3(0, 0, 0) },
                planetRadius: { value: 50000 },
                atmosphereRadius: { value: 60000 },
                scaleHeightRayleigh: { value: 800 },
                scaleHeightMie: { value: 120 },
                mieAnisotropy: { value: 0.8 },
                rayleighScattering: { value: new THREE.Vector3(5.5e-5, 13.0e-5, 22.4e-5) },
                mieScattering: { value: 21e-5 },
                sunIntensity: { value: 20.0 },
                numSamples: { value: this.numSamples },
                hasLUT: { value: 0.0 },
                invViewProjMatrix: { value: new THREE.Matrix4() },
                transmittanceLUT: { value: this.atmosphereLUT?.transmittanceLUT || null },
                multiScatterLUT: { value: this.atmosphereLUT?.multiScatterLUT || null },
                sunAngularDiameter: { value: 0.00935 },
                sunColor: { value: new THREE.Color(1.0, 0.98, 0.9) },
                sunDiskFade: { value: 1.0 },
                time: { value: 0.0 },
                // Night sky uniforms
                starSeed: { value: 12345.0 },
                galaxyCount: { value: 1.0 },
                galaxySeed: { value: 54321.0 },
                galaxyBrightness: { value: 1.0 },
                galaxySpread: { value: 0.25 },
                spaceLOD: { value: 0.0 },
                detailLevel: { value: 1.0 },
                starBoost: { value: this._detailPreset?.starBoost ?? 1.0 },
                starDensityMultiplier: { value: this._detailPreset?.starDensityMultiplier ?? 1.0 }
            },
            depthTest: false,
            depthWrite: false,
            side: 'double'
        });

        if (this.backend.compileShader) {
            this.backend.compileShader(this.skyMaterial);
        }
    }

    render(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade = 1.0) {
        if (!this.enabled || !this.initialized) return;

        // Update time
        const now = performance.now();
        const deltaMs = now - this._lastFrameTime;
        this._lastFrameTime = now;
        this._time += deltaMs * 0.001;  // Convert to seconds
        // Determine space LOD based on altitude
        const viewerAltitude = uniformManager?.uniforms?.viewerAltitude?.value ?? 0;
        this._currentSpaceLOD = viewerAltitude > this._spaceLODThreshold ? 1 : 0;

        const apiName = this.backend.getAPIName?.() || 'webgl2';

        if (apiName === 'webgpu') {
            this._renderWebGPU(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade);
        } else {
            this._renderWebGL2(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade);
        }
    }

    _renderWebGPU(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade) {
        if (!this.skyMaterial || !this.fullscreenGeometry) return;
        
        const hasLUT = !!(this.atmosphereLUT?.transmittanceLUT && this.atmosphereLUT.transmittanceLUT._gpuTexture);

        const u = this.skyMaterial.uniforms.skyUniforms.value;
        const planetCenter = uniformManager?.uniforms?.planetCenter?.value || new THREE.Vector3();
        const planetRadius = atmosphereSettings?.planetRadius ??
            uniformManager?.uniforms?.atmospherePlanetRadius?.value ?? 50000;
        const atmosphereRadius = atmosphereSettings?.atmosphereRadius ??
            uniformManager?.uniforms?.atmosphereRadius?.value ?? planetRadius + 10000;
        const rayleigh = atmosphereSettings?.rayleighScattering ??
            uniformManager?.uniforms?.atmosphereRayleighScattering?.value ??
            new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6);
        const mieScattering = atmosphereSettings?.mieScattering ??
            uniformManager?.uniforms?.atmosphereMieScattering?.value ?? 21e-6;
        const mieAnisotropy = atmosphereSettings?.mieAnisotropy ??
            uniformManager?.uniforms?.atmosphereMieAnisotropy?.value ?? 0.758;
        const sunIntensity = atmosphereSettings?.sunIntensity ??
            uniformManager?.uniforms?.atmosphereSunIntensity?.value ?? 20.0;
        const scaleHeightR = atmosphereSettings?.scaleHeightRayleigh ??
            uniformManager?.uniforms?.atmosphereScaleHeightRayleigh?.value ?? 8000;
        const scaleHeightM = atmosphereSettings?.scaleHeightMie ??
            uniformManager?.uniforms?.atmosphereScaleHeightMie?.value ?? 1200;

        const sDir = (sunDir || uniformManager?.uniforms?.sunLightDirection?.value || new THREE.Vector3(0.5, 1.0, 0.3)).clone().normalize();

        // Pack uniforms (matches SkyUniforms in WGSL)
        u[0] = camera.position.x;
        u[1] = camera.position.y;
        u[2] = camera.position.z;
        u[3] = 0; // viewerAltitude (filled below)
        u[4] = sDir.x;
        u[5] = sDir.y;
        u[6] = sDir.z;
        u[7] = uniformManager?.uniforms?.starAngularDiameter?.value ?? 0.00935;
        u[8] = planetCenter.x;
        u[9] = planetCenter.y;
        u[10] = planetCenter.z;
        u[11] = planetRadius;
        u[12] = atmosphereRadius;
        u[13] = scaleHeightR;
        u[14] = scaleHeightM;
        u[15] = mieAnisotropy;
        u[16] = rayleigh.x;
        u[17] = rayleigh.y;
        u[18] = rayleigh.z;
        u[19] = mieScattering;
        u[20] = sunIntensity;
        u[21] = this.numSamples;
        u[22] = hasLUT ? 1.0 : 0.0;
        u[23] = sunDiskFade;
        u[24] = this._time;  // Time uniform
        u[25] = this._currentSpaceLOD;  // Space LOD (0 = ground, 1 = space)

        u[26] = 0.0;  // Reserved
        u[27] = 0.0;  // Reserved

// NEW — rotation-only view matrix eliminates large-value precision loss:
const rotOnlyView = camera.matrixWorldInverse.clone();
rotOnlyView.elements[12] = 0;
rotOnlyView.elements[13] = 0;
rotOnlyView.elements[14] = 0;
const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, rotOnlyView);
const inv = this.skyMaterial.uniforms.invViewProj.value;
inv.set(viewProj.clone().invert().elements);

        const dx = camera.position.x - planetCenter.x;
        const dy = camera.position.y - planetCenter.y;
        const dz = camera.position.z - planetCenter.z;
        const viewerAlt = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - planetRadius);
        u[3] = viewerAlt;

        // Pack night sky game config
        const nightConfig = this.skyMaterial.uniforms.nightSkyConfig.value;
        const configData = this._nightSkyConfig.toGPUData();
        nightConfig.set(configData);

        // Pack detail preset
        const detailData = this.skyMaterial.uniforms.nightSkyDetail.value;
        const preset = this._detailPreset;
        detailData[0] = preset.starLayers;
        detailData[1] = preset.maxStarBrightness;
        detailData[2] = preset.starTwinkle ? 1.0 : 0.0;
        detailData[3] = preset.galaxyEnabled ? 1.0 : 0.0;
        detailData[4] = preset.galaxySamples;

        detailData[6] = preset.ditherEnabled ? 1.0 : 0.0;
        detailData[7] = preset.starBoost ?? 1.0;
        detailData[8] = preset.starDensityMultiplier ?? 1.0;
        detailData[9] = 0.0;
        detailData[10] = 0.0;
        detailData[11] = 0.0;

        this.skyMaterial.uniforms.transmittanceLUT.value = hasLUT ? this.atmosphereLUT.transmittanceLUT : null;
        this.skyMaterial.uniforms.multiScatterLUT.value = hasLUT ? this.atmosphereLUT.multiScatterLUT : null;

        // --- Render sky to low-res offscreen target, then blit to screen ---
        const canvas = this.backend.canvas || this.backend.device?.canvas;
        const fullWidth = canvas?.width || 1920;
        const fullHeight = canvas?.height || 1080;
        this._ensureSkyRT(fullWidth, fullHeight);

        // Save viewport, switch to RT dimensions (bypass setViewport to avoid depth texture recreation)
        const savedViewport = { ...this.backend._viewport };
        this.backend._viewport = { x: 0, y: 0, width: this._skyRTWidth, height: this._skyRTHeight };

        // Draw sky into low-res RT
        this.backend.setRenderTarget(this._skyRT);
        this.backend.clear(true, false);
        this.backend.draw(this.fullscreenGeometry, this.skyMaterial);

        // Restore viewport and switch back to screen
        this.backend._viewport = savedViewport;
        this.backend.setRenderTarget(null);
        this.backend.resumeRenderPass();

        // Blit low-res sky to screen
        if (this._skyRT._gpuRenderTarget) {
            const srcView = this._skyRT._gpuRenderTarget.colorViews[0];
            if (srcView) {
                this._blitMaterial.uniforms.sourceTexture.value = { _isGPUTextureView: true, view: srcView };
            }
        }
        this.backend.draw(this.fullscreenGeometry, this._blitMaterial);
    }

    _renderWebGL2(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade) {
        if (!this.skyMaterial || !this.fullscreenGeometry) {
            return;
        }

        const uniforms = this.skyMaterial.uniforms;
        const uManager = uniformManager || {};
        const global = uManager.uniforms || {};

        uniforms.cameraPosition.value.copy(camera.position);

        const planetCenter = global.planetCenter?.value || new THREE.Vector3(0, 0, 0);
        uniforms.planetCenter.value.copy(planetCenter);

        const planetRadius = atmosphereSettings?.planetRadius ??
            global.atmospherePlanetRadius?.value ?? 50000;
        uniforms.planetRadius.value = planetRadius;
        uniforms.atmosphereRadius.value = atmosphereSettings?.atmosphereRadius ??
            global.atmosphereRadius?.value ??
            planetRadius + (atmosphereSettings?.atmosphereHeight ?? 10000);

        uniforms.scaleHeightRayleigh.value = atmosphereSettings?.scaleHeightRayleigh ?? global.atmosphereScaleHeightRayleigh?.value ?? 8000;
        uniforms.scaleHeightMie.value = atmosphereSettings?.scaleHeightMie ?? global.atmosphereScaleHeightMie?.value ?? 1200;
        uniforms.rayleighScattering.value.copy(
            atmosphereSettings?.rayleighScattering ?? global.atmosphereRayleighScattering?.value ?? new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6)
        );
        uniforms.mieScattering.value = atmosphereSettings?.mieScattering ?? global.atmosphereMieScattering?.value ?? 21e-6;
        uniforms.mieAnisotropy.value = atmosphereSettings?.mieAnisotropy ?? global.atmosphereMieAnisotropy?.value ?? 0.758;
        uniforms.sunIntensity.value = atmosphereSettings?.sunIntensity ?? global.atmosphereSunIntensity?.value ?? 20.0;
        uniforms.numSamples.value = this.numSamples;

        const sunDirValue = (sunDir || global.sunLightDirection?.value || new THREE.Vector3(0.5, 1.0, 0.3)).clone().normalize();
        uniforms.sunDirection.value.copy(sunDirValue);

        const sunStrength = global.sunLightIntensity?.value ?? 1.0;
        const baseSunIntensity = atmosphereSettings?.sunIntensity ?? global.atmosphereSunIntensity?.value ?? 20.0;
        uniforms.sunIntensity.value = baseSunIntensity * sunStrength;

        uniforms.sunAngularDiameter.value = global.starAngularDiameter?.value ?? 0.00935;
        if (uniforms.sunColor && global.starColor?.value) {
            uniforms.sunColor.value.copy(global.starColor.value);
        }
        uniforms.sunDiskFade.value = sunDiskFade;
        uniforms.time.value = this._time;

        const hasLUT = !!(this.atmosphereLUT?.transmittanceLUT);
        uniforms.hasLUT.value = hasLUT ? 1.0 : 0.0;
        uniforms.transmittanceLUT.value = hasLUT ? this.atmosphereLUT.transmittanceLUT : null;
        uniforms.multiScatterLUT.value = hasLUT ? this.atmosphereLUT.multiScatterLUT : null;

        const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        uniforms.invViewProjMatrix.value.copy(viewProj).invert();

        const dx = camera.position.x - planetCenter.x;
        const dy = camera.position.y - planetCenter.y;
        const dz = camera.position.z - planetCenter.z;
        const computedAlt = Math.sqrt(dx * dx + dy * dy + dz * dz) - planetRadius;
        const viewerAlt = global.viewerAltitude?.value ?? Math.max(0, computedAlt);
        uniforms.viewerAltitude.value = viewerAlt;

        // Night sky config
        const config = this._nightSkyConfig;
        uniforms.starSeed.value = config.starSeed;
        uniforms.galaxyCount.value = config.galaxies.count;
        uniforms.galaxySeed.value = config.galaxies.seed;
        uniforms.galaxyBrightness.value = config.galaxies.brightness;
        uniforms.galaxySpread.value = config.galaxies.spread;
        uniforms.spaceLOD.value = this._currentSpaceLOD;
        
        // Map detail level to numeric value for shader
        const detailMap = { 'low': 0.0, 'medium': 1.0, 'high': 2.0 };
        uniforms.detailLevel.value = detailMap[this._detailLevel] ?? 1.0;
        if (uniforms.starBoost) {
            uniforms.starBoost.value = this._detailPreset?.starBoost ?? 1.0;
        }
        if (uniforms.starDensityMultiplier) {
            uniforms.starDensityMultiplier.value = this._detailPreset?.starDensityMultiplier ?? 1.0;
        }

        // Render sky to low-res RT, then blit to screen
        const canvas = this.backend.canvas;
        const fullWidth = canvas?.width || 1920;
        const fullHeight = canvas?.height || 1080;
        this._ensureSkyRT(fullWidth, fullHeight);

        this.backend.setRenderTarget(this._skyRT);
        this.backend.setViewport(0, 0, this._skyRTWidth, this._skyRTHeight);
        this.backend.clear(true, false);
        this.backend.draw(this.fullscreenGeometry, this.skyMaterial);

        // Blit back to screen
        this.backend.setRenderTarget(null);
        this.backend.setViewport(0, 0, fullWidth, fullHeight);
        // WebGL2: use blitFramebuffer for simple copy
        const gl = this.backend.gl;
        if (gl && this._skyRT._gpuFramebuffer) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._skyRT._gpuFramebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            gl.blitFramebuffer(
                0, 0, this._skyRTWidth, this._skyRTHeight,
                0, 0, fullWidth, fullHeight,
                gl.COLOR_BUFFER_BIT, gl.LINEAR
            );
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        }
    }

    _getSkyVertexWGSL() {
        return `
struct SkyUniforms {
    cameraPosition: vec3<f32>,
    viewerAltitude: f32,
    sunDirection: vec3<f32>,
    sunAngularDiameter: f32,
    planetCenter: vec3<f32>,
    planetRadius: f32,
    atmosphereRadius: f32,
    scaleHeightRayleigh: f32,
    scaleHeightMie: f32,
    mieAnisotropy: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    sunIntensity: f32,
    numSamples: f32,
    hasLUT: f32,
    sunDiskFade: f32,
    time: f32,
    spaceLOD: f32,
    _pad0: f32,
    _pad1: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: SkyUniforms;
@group(0) @binding(1) var<uniform> invViewProjMatrix: mat4x4<f32>;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    let pos = positions[vertexIndex];
    output.position = vec4<f32>(pos, 0.9999, 1.0);
    output.uv = pos * 0.5 + 0.5;
    return output;
}
`;
    }

    _getSkyFragmentWGSL() {
        return `
struct SkyUniforms {
    cameraPosition: vec3<f32>,
    viewerAltitude: f32,
    sunDirection: vec3<f32>,
    sunAngularDiameter: f32,
    planetCenter: vec3<f32>,
    planetRadius: f32,
    atmosphereRadius: f32,
    scaleHeightRayleigh: f32,
    scaleHeightMie: f32,
    mieAnisotropy: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    sunIntensity: f32,
    numSamples: f32,
    hasLUT: f32,
    sunDiskFade: f32,
    time: f32,
    spaceLOD: f32,
    _pad0: f32,
    _pad1: f32,
}

// Night sky game configuration (per-world, seeded)
struct NightSkyConfig {
    starSeed: f32,
    galaxyCount: f32,
    galaxySeed: f32,
    galaxyBrightness: f32,
    galaxySpread: f32,
    colorSeed: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
}

// Night sky detail level (engine config)
struct NightSkyDetail {
    starLayers: f32,
    maxStarBrightness: f32,
    starTwinkle: f32,
    galaxyEnabled: f32,
    galaxySamples: f32,
    ditherEnabled: f32,
    starBoost: f32,
    starDensityMultiplier: f32,
    _pad0: f32,
    _pad1: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: SkyUniforms;
@group(0) @binding(1) var<uniform> invViewProjMatrix: mat4x4<f32>;
@group(0) @binding(2) var<uniform> nightConfig: NightSkyConfig;
@group(0) @binding(3) var<uniform> nightDetail: NightSkyDetail;
@group(1) @binding(0) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(1) var transmittanceSampler: sampler;
@group(1) @binding(2) var multiScatterLUT: texture_2d<f32>;
@group(1) @binding(3) var multiScatterSampler: sampler;

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

// ============================================================================
// NOISE FUNCTIONS
// ============================================================================

fn hash11(p: f32) -> f32 {
    var p3 = fract(p * 0.1031);
    // WGSL dot() requires vectors; for scalar use multiply.
    p3 = p3 + p3 * (p3 + 33.33);
    return fract(p3 * p3);
}

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash13(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 = p3 + dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
    let n = sin(dot(p, vec2<f32>(41.0, 289.0)));
    return fract(vec2<f32>(262144.0, 32768.0) * n);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q = q + dot(q, q.yxz + 33.33);
    return fract((q.xxy + q.yxx) * q.zyx);
}

// Seeded hash functions
fn seededHash12(p: vec2<f32>, seed: f32) -> f32 {
    return hash13(vec3<f32>(p.x, p.y, seed));
}

fn seededHash22(p: vec2<f32>, seed: f32) -> vec2<f32> {
    let h1 = hash13(vec3<f32>(p.x, p.y, seed));
    let h2 = hash13(vec3<f32>(p.y, p.x, seed + 127.1));
    return vec2<f32>(h1, h2);
}

// Value noise for smooth galaxy patterns
fn valueNoise(p: vec2<f32>, seed: f32) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    let a = seededHash12(i + vec2<f32>(0.0, 0.0), seed);
    let b = seededHash12(i + vec2<f32>(1.0, 0.0), seed);
    let c = seededHash12(i + vec2<f32>(0.0, 1.0), seed);
    let d = seededHash12(i + vec2<f32>(1.0, 1.0), seed);
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// FBM for galaxy dust
fn fbmNoise(p: vec2<f32>, seed: f32, octaves: i32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var pos = p;
    
    for (var i = 0; i < octaves; i = i + 1) {
        value = value + amplitude * valueNoise(pos * frequency, seed + f32(i) * 13.7);
        amplitude = amplitude * 0.5;
        frequency = frequency * 2.0;
    }
    
    return value;
}

// ============================================================================
// COORDINATE TRANSFORMS
// ============================================================================

fn dirToUV(dir: vec3<f32>) -> vec2<f32> {
    let phi = atan2(dir.z, dir.x);
    let theta = acos(clamp(dir.y, -1.0, 1.0));
    let u = phi / TAU + 0.5;
    let v = theta / PI;
    return vec2<f32>(u, v);
}

fn dirToSpherical(dir: vec3<f32>) -> vec2<f32> {
    // Returns (longitude, latitude) in range [0,1]
    let phi = atan2(dir.z, dir.x);
    let theta = asin(clamp(dir.y, -1.0, 1.0));
    let lon = phi / TAU + 0.5;
    let lat = theta / PI + 0.5;
    return vec2<f32>(lon, lat);
}

fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 1.0, 1.0);
    var worldPos = invViewProjMatrix * ndc;
    worldPos = worldPos / worldPos.w;
    return normalize(worldPos.xyz);  // ← removed "- uniforms.cameraPosition"
}

// ============================================================================
// STAR FIELD RENDERING
// ============================================================================

// Get star color based on temperature (seeded)
fn getStarColor(seed: f32, colorSeed: f32) -> vec3<f32> {
    let temp = hash11(seed + colorSeed * 0.1);
    
    // Temperature distribution: most stars are yellowish-white
    // temp 0.0-0.3: red/orange (cool)
    // temp 0.3-0.7: yellow/white (medium)
    // temp 0.7-1.0: blue/white (hot)
    
    if (temp < 0.3) {
        // Cool stars: red to orange
        let t = temp / 0.3;
        return mix(vec3<f32>(1.0, 0.4, 0.2), vec3<f32>(1.0, 0.7, 0.4), t);
    } else if (temp < 0.7) {
        // Medium stars: orange-yellow to white
        let t = (temp - 0.3) / 0.4;
        return mix(vec3<f32>(1.0, 0.85, 0.6), vec3<f32>(1.0, 1.0, 0.95), t);
    } else {
        // Hot stars: white to blue-white
        let t = (temp - 0.7) / 0.3;
        return mix(vec3<f32>(0.95, 0.95, 1.0), vec3<f32>(0.7, 0.8, 1.0), t);
    }
}

// Single star layer with configurable parameters
fn starLayer(uv: vec2<f32>, scale: f32, density: f32, intensity: f32, 
             starSeed: f32, colorSeed: f32, twinkle: bool, time: f32, densityBoost: f32) -> vec3<f32> {
    let cell = uv * scale;
    let ip = floor(cell);
    let fp = fract(cell);

    // Seeded random offset for star position within cell
    let offset = seededHash22(ip, starSeed) * 0.6 - 0.3;
    let starPos = fp - 0.5 - offset;

    // Density check (seeded)
    let h = seededHash12(ip, starSeed + 100.0);
    let boostedDensity = clamp(density * densityBoost, 0.0, 1.0);
    let star = step(1.0 - boostedDensity, h);

    // Star size varies with brightness
    let brightnessRand = seededHash12(ip, starSeed + 200.0);
    let size = mix(0.02, 0.10, brightnessRand * brightnessRand);
    let dist = length(starPos);
    let shapeBase = 1.0 - smoothstep(0.0, size, dist);
    let shape = shapeBase * shapeBase;

    // Star color (seeded)
    let color = getStarColor(seededHash12(ip, starSeed + 300.0), colorSeed);

    // Twinkle effect (optional)
    var twinkleFactor = 1.0;
    if (twinkle) {
        let twinklePhase = seededHash12(ip, starSeed + 400.0) * TAU;
        let twinkleSpeed = 1.0 + seededHash12(ip, starSeed + 500.0) * 2.0;
        twinkleFactor = 0.7 + 0.3 * sin(time * twinkleSpeed + twinklePhase);
    }

    // Brightness variation
    let brightnessMult = 0.3 + brightnessRand * 0.7;

    return color * star * shape * intensity * twinkleFactor * brightnessMult;
}

// Complete star field with multiple layers
fn getStarfieldColor(dir: vec3<f32>, starSeed: f32, colorSeed: f32, 
                     numLayers: i32, maxBrightness: f32, twinkle: bool, 
                     time: f32, spaceLOD: f32, densityBoost: f32) -> vec3<f32> {
    let uv = dirToUV(dir);
    var stars = vec3<f32>(0.0);

    // Layer configurations: scale, density, intensity
    // More layers = more detail, higher scales = finer stars
    
    // Base layers (always present)
    if (numLayers >= 1) {
        stars = stars + starLayer(uv, 200.0, 0.004, maxBrightness * 0.6, starSeed, colorSeed, twinkle, time, densityBoost);
    }
    if (numLayers >= 2) {
        stars = stars + starLayer(uv + vec2<f32>(0.37, 0.71), 400.0, 0.006, maxBrightness * 0.8, starSeed + 1000.0, colorSeed, twinkle, time, densityBoost);
    }
    
    // Medium detail layers
    if (numLayers >= 3) {
        stars = stars + starLayer(uv + vec2<f32>(0.13, 0.29), 100.0, 0.002, maxBrightness * 1.2, starSeed + 2000.0, colorSeed, twinkle, time, densityBoost);
    }
    if (numLayers >= 4) {
        stars = stars + starLayer(uv + vec2<f32>(0.53, 0.17), 600.0, 0.008, maxBrightness * 0.4, starSeed + 3000.0, colorSeed, twinkle, time, densityBoost);
    }
    
    // High detail layers (space LOD or high detail setting)
    if (numLayers >= 5) {
        stars = stars + starLayer(uv + vec2<f32>(0.73, 0.41), 800.0, 0.01, maxBrightness * 0.3, starSeed + 4000.0, colorSeed, twinkle, time, densityBoost);
    }
    if (numLayers >= 6) {
        stars = stars + starLayer(uv + vec2<f32>(0.19, 0.83), 50.0, 0.001, maxBrightness * 2.0, starSeed + 5000.0, colorSeed, twinkle, time, densityBoost);
    }

    // Extra detail in space (LOD 1)
    if (spaceLOD > 0.5 && numLayers >= 4) {
        stars = stars + starLayer(uv + vec2<f32>(0.31, 0.67), 1000.0, 0.012, maxBrightness * 0.2, starSeed + 6000.0, colorSeed, twinkle, time, densityBoost);
        stars = stars + starLayer(uv + vec2<f32>(0.89, 0.23), 1200.0, 0.015, maxBrightness * 0.15, starSeed + 7000.0, colorSeed, twinkle, time, densityBoost);
    }

    return stars;
}

// ============================================================================
// GALAXY RENDERING
// ============================================================================

// Single galaxy band
fn galaxyBand(dir: vec3<f32>, bandIndex: i32, galaxySeed: f32, spread: f32, 
              samples: i32, brightness: f32) -> vec3<f32> {
    // Each galaxy has a unique orientation derived from seed
    let bandSeed = galaxySeed + f32(bandIndex) * 1000.0;
    
    // Random rotation for this galaxy band
    let rotX = seededHash12(vec2<f32>(f32(bandIndex), 0.0), bandSeed) * PI;
    let rotY = seededHash12(vec2<f32>(f32(bandIndex), 1.0), bandSeed) * TAU;
    let rotZ = seededHash12(vec2<f32>(f32(bandIndex), 2.0), bandSeed) * PI * 0.5;
    
    // Rotate direction into galaxy's local space
    // Simple rotation around Y then X
    let cosY = cos(rotY);
    let sinY = sin(rotY);
    let cosX = cos(rotX);
    let sinX = sin(rotX);
    
    var d = dir;
    // Rotate around Y
    d = vec3<f32>(d.x * cosY + d.z * sinY, d.y, -d.x * sinY + d.z * cosY);
    // Rotate around X  
    d = vec3<f32>(d.x, d.y * cosX - d.z * sinX, d.y * sinX + d.z * cosX);
    
    // Convert to spherical for galaxy plane distance
    let lat = asin(clamp(d.y, -1.0, 1.0));
    let lon = atan2(d.z, d.x);
    
    // Distance from galaxy plane (equator)
    let planeDistance = abs(lat) / (PI * 0.5);
    
    // Galaxy core is thicker, edges are thinner
    let coreDistance = abs(lon) / PI; // 0 at lon=0, 1 at lon=PI
    let bandWidth = spread * (1.0 - coreDistance * 0.5);
    
    // Main band shape
    let bandMask = 1.0 - smoothstep(0.0, bandWidth, planeDistance);
    
    if (bandMask < 0.01) {
        return vec3<f32>(0.0);
    }
    
    // Galaxy dust and structure (noise-based)
    let uvGalaxy = vec2<f32>(lon / TAU + 0.5, planeDistance / spread);
    
    var dust = 0.0;
    if (samples >= 1) {
        dust = fbmNoise(uvGalaxy * 8.0, bandSeed, min(samples, 4));
    }
    
    // Spiral arm hint (very subtle)
    let spiralAngle = lon + planeDistance * 4.0;
    let spiral = 0.5 + 0.5 * sin(spiralAngle * 2.0);
    
    // Core brightness
    let coreGlow = exp(-coreDistance * 3.0) * exp(-planeDistance * planeDistance / (spread * spread * 0.5));
    
    // Combine components
    let structure = mix(dust, spiral, 0.3) * bandMask;
    let core = coreGlow * bandMask * 2.0;
    
    // Galaxy colors: core is warm, arms are cooler
    let coreColor = vec3<f32>(1.0, 0.95, 0.8);
    let armColor = vec3<f32>(0.7, 0.75, 0.9);
    let dustColor = vec3<f32>(0.4, 0.35, 0.5);
    
    var galaxyColor = mix(armColor, coreColor, coreGlow);
    galaxyColor = mix(galaxyColor, dustColor, dust * 0.5);
    
    let totalBrightness = (structure * 0.3 + core * 0.7) * brightness;
    
    return galaxyColor * totalBrightness * bandMask;
}

// Complete galaxy field
fn getGalaxyColor(dir: vec3<f32>, galaxyCount: i32, galaxySeed: f32, 
                  spread: f32, samples: i32, brightness: f32) -> vec3<f32> {
    if (galaxyCount <= 0) {
        return vec3<f32>(0.0);
    }
    
    var totalGalaxy = vec3<f32>(0.0);
    
    for (var i = 0; i < galaxyCount; i = i + 1) {
        if (i >= 4) { break; } // Max 4 galaxies for performance
        totalGalaxy = totalGalaxy + galaxyBand(dir, i, galaxySeed, spread, samples, brightness);
    }
    
    return totalGalaxy;
}

// ============================================================================
// ATMOSPHERE (from original)
// ============================================================================

fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>, radius: f32) -> vec2<f32> {
    let oc = origin - center;
    let a = dot(dir, dir);
    let b = 2.0 * dot(oc, dir);
    let c = dot(oc, oc) - radius * radius;
    let discriminant = b * b - 4.0 * a * c;
    if (discriminant < 0.0) {
        return vec2<f32>(-1.0, -1.0);
    }
    let sqrtD = sqrt(discriminant);
    let t1 = (-b - sqrtD) / (2.0 * a);
    let t2 = (-b + sqrtD) / (2.0 * a);
    return vec2<f32>(t1, t2);
}

fn rayleighPhase(cosTheta: f32) -> f32 {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

fn miePhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let num = (1.0 - g2);
    let denom = 4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / max(denom, 0.0001);
}

fn getTransmittanceUV(altitude: f32, cosTheta: f32) -> vec2<f32> {
    let H = sqrt(max(0.0, uniforms.atmosphereRadius * uniforms.atmosphereRadius - uniforms.planetRadius * uniforms.planetRadius));
    let rho = sqrt(max(0.0, (uniforms.planetRadius + altitude) * (uniforms.planetRadius + altitude) - uniforms.planetRadius * uniforms.planetRadius));
    let u = clamp(rho / max(H, 0.001), 0.0, 1.0);
    let r = uniforms.planetRadius + altitude;
    let dMin = uniforms.atmosphereRadius - r;
    let dMax = rho + H;
    let cosT = clamp(cosTheta, -1.0, 1.0);
    let disc = max(0.0, r * r * cosT * cosT + uniforms.atmosphereRadius * uniforms.atmosphereRadius - r * r);
    let d = -r * cosT + sqrt(disc);
    let v = clamp((d - dMin) / max(dMax - dMin, 0.001), 0.0, 1.0);
    return vec2<f32>(u, v);
}

fn sampleTransmittanceLOD(altitude: f32, cosTheta: f32) -> vec3<f32> {
    let uv = getTransmittanceUV(altitude, cosTheta);
    return textureSampleLevel(transmittanceLUT, transmittanceSampler, uv, 0.0).rgb;
}

fn sampleMultiScatterLOD(altitude: f32, cosSunZenith: f32) -> vec3<f32> {
    let atmoHeight = max(1.0, uniforms.atmosphereRadius - uniforms.planetRadius);
    let u = clamp(cosSunZenith * 0.5 + 0.5, 0.0, 1.0);
    let v = clamp(altitude / atmoHeight, 0.0, 1.0);
    return textureSampleLevel(multiScatterLUT, multiScatterSampler, vec2<f32>(u, v), 0.0).rgb;
}

fn getDensity(altitude: f32) -> vec2<f32> {
    let clampedAlt = max(0.0, altitude);
    let densityR = exp(-clampedAlt / uniforms.scaleHeightRayleigh);
    let densityM = exp(-clampedAlt / uniforms.scaleHeightMie);
    return vec2<f32>(densityR, densityM);
}

// ============================================================================
// MAIN FRAGMENT SHADER
// ============================================================================

@fragment
fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    let rayDir = getRayDirection(input.uv);
    let rayOrigin = uniforms.cameraPosition;

    let planetHit = raySphereIntersect(rayOrigin, rayDir, uniforms.planetCenter, uniforms.planetRadius);
    let atmoHit = raySphereIntersect(rayOrigin, rayDir, uniforms.planetCenter, uniforms.atmosphereRadius);
    let atmoHeight = uniforms.atmosphereRadius - uniforms.planetRadius;
    
    let terminatorAlt = smoothstep(0.0, atmoHeight * 0.6, uniforms.viewerAltitude);
    let terminatorWidth = mix(0.6, 0.12, terminatorAlt);
    let terminatorCenter = mix(-0.2, -0.05, terminatorAlt);
    let sunSideAlt = smoothstep(0.0, atmoHeight * 0.5, uniforms.viewerAltitude);

    let hitsPlanet = planetHit.x > 0.0 || (planetHit.x < 0.0 && planetHit.y > 0.0);
    let planetMask = select(1.0, 0.0, hitsPlanet);
    let atmoLen = max(atmoHit.y - max(atmoHit.x, 0.0), 0.0);
    let atmoSoft = max(500.0, atmoHeight * 0.05);
    let atmoMask = smoothstep(0.0, atmoSoft, atmoLen);

    let tStart = max(0.0, atmoHit.x) * atmoMask;
    let tEnd = atmoHit.y * atmoMask;
    let marchLength = max(tEnd - tStart, 0.0);
    let numSteps = i32(uniforms.numSamples);
    let stepSize = marchLength / max(uniforms.numSamples, 1.0);

    var inscatter = vec3<f32>(0.0);
    var transmittance = vec3<f32>(1.0);

    let cosTheta = dot(rayDir, uniforms.sunDirection);
    let phaseR = rayleighPhase(cosTheta);
    let phaseM = miePhase(cosTheta, uniforms.mieAnisotropy);

    let upAtCamera = normalize(rayOrigin - uniforms.planetCenter);
    let cosSunZenithCamera = dot(uniforms.sunDirection, upAtCamera);

    let sunTransmittanceAtViewer = sampleTransmittanceLOD(uniforms.viewerAltitude, cosSunZenithCamera);
    let multiScatter = sampleMultiScatterLOD(max(0.0, uniforms.viewerAltitude), cosSunZenithCamera);
    let dayFactorForVisibility = smoothstep(-0.2, 0.15, cosSunZenithCamera);

    // Ray march through atmosphere
    for (var i: i32 = 0; i < numSteps; i = i + 1) {
        let t = tStart + (f32(i) + 0.5) * stepSize;
        let samplePos = rayOrigin + rayDir * t;
        let sampleAltitude = length(samplePos - uniforms.planetCenter) - uniforms.planetRadius;

        let sampleValid = select(0.0, 1.0, sampleAltitude >= 0.0);
        let clampedAltitude = max(0.0, sampleAltitude);

        let density = getDensity(clampedAltitude);

        let upAtSample = normalize(samplePos - uniforms.planetCenter);
        let cosSunZenith = dot(uniforms.sunDirection, upAtSample);

        var sunVisibility = smoothstep(terminatorCenter - terminatorWidth, terminatorCenter + terminatorWidth, cosSunZenith);
        let minVisibility = dayFactorForVisibility * mix(0.25, 0.0, terminatorAlt);
        sunVisibility = max(sunVisibility, minVisibility);

        let sunTransmittance = sampleTransmittanceLOD(clampedAltitude, cosSunZenith);

        let scatterR = uniforms.rayleighScattering * density.x * phaseR;
        let scatterM = vec3<f32>(uniforms.mieScattering * density.y * phaseM);

        let scatterContrib = (scatterR + scatterM) * sunTransmittance * sunVisibility * stepSize * sampleValid;
        inscatter = inscatter + transmittance * scatterContrib;

        let extinctionR = uniforms.rayleighScattering * density.x * sampleValid;
        let extinctionM = vec3<f32>(uniforms.mieScattering * density.y * 1.1 * sampleValid);
        transmittance = transmittance * exp(-(extinctionR + extinctionM) * stepSize);
    }

    var skyColor = inscatter * uniforms.sunIntensity * atmoMask;

    let hasLUTFactor = select(0.0, 1.0, uniforms.hasLUT > 0.5);
    skyColor = skyColor + multiScatter * uniforms.sunIntensity * 0.4 * atmoMask * hasLUTFactor;

    let ambientDayFactor = smoothstep(-0.1, 0.3, cosSunZenithCamera);
    let ambientSkyColor = vec3<f32>(0.15, 0.35, 0.65) * ambientDayFactor * uniforms.sunIntensity * 0.08;
    let ambientFade = exp(-max(uniforms.viewerAltitude, 0.0) / (uniforms.scaleHeightRayleigh * 3.0));
    skyColor = skyColor + ambientSkyColor * ambientFade * atmoMask;

    let densityFade = exp(-max(uniforms.viewerAltitude, 0.0) / (uniforms.scaleHeightRayleigh * 2.0));
    let skyFade = clamp(densityFade, 0.0, 1.0);

    let cosViewUp = dot(rayDir, upAtCamera);
    let lookingUp = max(cosViewUp, 0.0);
    let lookingHorizon = 1.0 - abs(cosViewUp);

    let horizonDip = acos(uniforms.planetRadius / (uniforms.planetRadius + max(uniforms.viewerAltitude, 0.0)));
    let sunElevationRad = asin(clamp(cosSunZenithCamera, -1.0, 1.0));
    let sunElevationAboveHorizon = sunElevationRad + horizonDip;
    let sunAltitude = sin(sunElevationAboveHorizon);
    let dayFactor = smoothstep(-0.15, 0.4, sunAltitude);

    let twilightLow = smoothstep(-0.25, -0.05, sunAltitude);
    let twilightHigh = 1.0 - smoothstep(0.0, 0.25, sunAltitude);
    let twilightFactorBase = twilightLow * twilightHigh;
    let twilightAtmoFade = exp(-uniforms.viewerAltitude / (uniforms.scaleHeightRayleigh * 4.0));
    let twilightFactor = twilightFactorBase * twilightAtmoFade;

    let horizonBrightening = pow(lookingHorizon, 3.0) * 0.3;
    let sunSideBlend = smoothstep(-0.2, 0.5, cosTheta);
    let sunSideBase = mix(0.7, 1.0, sunSideBlend);
    let sunSideFactor = mix(1.0, sunSideBase, sunSideAlt);
    let ambientSkyBoost = dayFactor * 0.15 * lookingUp;

    skyColor = skyColor * (1.0 + horizonBrightening + ambientSkyBoost) * sunSideFactor;

    let sunDirFlat = uniforms.sunDirection - upAtCamera * dot(uniforms.sunDirection, upAtCamera);
    let sunDirFlatLen = length(sunDirFlat);
    let sunDirHorizon = select(vec3<f32>(0.0), sunDirFlat / sunDirFlatLen, sunDirFlatLen > 0.001);

    let towardsSunHorizon = dot(rayDir, sunDirHorizon);
    let sunSideOnly = smoothstep(-0.2, 0.4, towardsSunHorizon);

    let twilightColor = vec3<f32>(1.0, 0.55, 0.25);
    let horizonFactor = pow(lookingHorizon, 1.5) * (1.0 - lookingUp * 0.8);
    let twilightAmount = twilightFactor * horizonFactor * sunSideOnly;

    skyColor = mix(skyColor, twilightColor * uniforms.sunIntensity * 0.25, twilightAmount * 0.6);

    // ========== NIGHT SKY ==========
    
    // Calculate star/galaxy visibility
    let nightFactor = 1.0 - smoothstep(-0.1, 0.2, sunAltitude);
    let spaceFactor = smoothstep(atmoHeight * 0.3, atmoHeight * 1.5, uniforms.viewerAltitude);
  
let distToCenter = length(rayOrigin - uniforms.planetCenter);
let cosGeoHorizon = -sqrt(max(0.0, 1.0 - (uniforms.planetRadius / distToCenter)
                                        * (uniforms.planetRadius / distToCenter)));
let atmoH = max(uniforms.atmosphereRadius - uniforms.planetRadius, 1.0);
let altFrac = clamp(uniforms.viewerAltitude / atmoH, 0.0, 1.0);

// Ground: wide fade (atmosphere washes out stars near horizon)
// Orbit:  tight fade right at the planet limb
let fadeW = mix(0.12, 0.005, sqrt(altFrac));
let starHorizonFade = smoothstep(cosGeoHorizon - fadeW,
                                  cosGeoHorizon + fadeW * 3.0,
                                  cosViewUp);

let atmosphereBlock = 1.0 - skyFade * dayFactor;
let starVisibility = max(nightFactor, spaceFactor) * starHorizonFade * atmosphereBlock;

    // Get detail settings
    let numStarLayers = i32(nightDetail.starLayers);
    let maxBrightness = nightDetail.maxStarBrightness;
    let starBoost = max(nightDetail.starBoost, 1.0);
    let densityBoost = max(nightDetail.starDensityMultiplier, 1.0);
    let twinkleEnabled = nightDetail.starTwinkle > 0.5;
    let galaxyEnabled = nightDetail.galaxyEnabled > 0.5;
    let galaxySamples = i32(nightDetail.galaxySamples);

    // Stars
    let stars = getStarfieldColor(
        rayDir, 
        nightConfig.starSeed, 
        nightConfig.colorSeed,
        numStarLayers, 
        maxBrightness, 
        twinkleEnabled, 
        uniforms.time,
        uniforms.spaceLOD,
        densityBoost
    ) * starVisibility * 2.0 * starBoost;

    // Galaxies (if enabled and count > 0)
    var galaxies = vec3<f32>(0.0);
    if (galaxyEnabled && nightConfig.galaxyCount > 0.0) {
        galaxies = getGalaxyColor(
            rayDir,
            i32(nightConfig.galaxyCount),
            nightConfig.galaxySeed,
            nightConfig.galaxySpread,
            galaxySamples,
            nightConfig.galaxyBrightness
        ) * starVisibility * 0.125;
    }


    // Combine night sky elements
    skyColor = skyColor + (stars + galaxies) * transmittance;

    // ========== SUN DISC ==========
    let cosAngleToSun = dot(rayDir, uniforms.sunDirection);
    let sunAngularRadius = uniforms.sunAngularDiameter * 0.5;
    let cosSunRadius = cos(sunAngularRadius);

    let edgeSoftness = sunAngularRadius * 0.1;
    let sunEdge = smoothstep(cosSunRadius - edgeSoftness, cosSunRadius + edgeSoftness * 0.3, cosAngleToSun);
    let limbDarkening = 1.0 - pow(max(0.0, 1.0 - sunEdge), 0.4) * 0.35;
    let sunColorBase = vec3<f32>(1.0, 0.98, 0.9);
    let sunDiscColor = sunColorBase * uniforms.sunIntensity * 8.0 * limbDarkening * sunTransmittanceAtViewer * uniforms.sunDiskFade;

    skyColor = mix(skyColor, sunDiscColor, sunEdge * uniforms.sunDiskFade);

    // Sun corona/glow
    let glowAngle = acos(clamp(cosAngleToSun, -1.0, 1.0));
    let glowWidth = sunAngularRadius * 10.0;
    let glow = exp(-glowAngle * glowAngle / (glowWidth * glowWidth * 2.0));

    let sunBelowHorizon = max(0.0, -sunAltitude);
    let sunAboveHorizon = max(0.0, sunAltitude);
    let viewAboveHorizon = max(0.0, cosViewUp);
    let maxGlowHeight = mix(1.0, 0.0, smoothstep(0.0, 0.25, sunBelowHorizon));

    let postSunsetHeightFade = select(
        1.0,
        1.0 - smoothstep(maxGlowHeight * 0.5, maxGlowHeight + 0.1, viewAboveHorizon),
        sunBelowHorizon > 0.01
    );
    let postSunsetIntensityFade = 1.0 - smoothstep(0.0, 0.35, sunBelowHorizon);
    let glowFade = select(1.0, postSunsetHeightFade * postSunsetIntensityFade, sunBelowHorizon > 0.01);

    let coronaColor = sunColorBase * glow * uniforms.sunIntensity * 0.5 * sunTransmittanceAtViewer * uniforms.sunDiskFade * glowFade;
    skyColor = skyColor + coronaColor;

    // View-angle dependent glare
    let cameraForward = getRayDirection(vec2<f32>(0.5, 0.5));
    let sunInViewCenter = dot(cameraForward, uniforms.sunDirection);
    let viewAngleFactor = pow(max(sunInViewCenter, 0.0), 6.0);

    let wideGlowWidth = 0.4;
    let wideGlow = exp(-glowAngle * glowAngle / (wideGlowWidth * wideGlowWidth));
    let glareIntensity = wideGlow * uniforms.sunIntensity * 0.2 * sunTransmittanceAtViewer * glowFade * viewAngleFactor;

    let sunHorizonFactor = 1.0 - abs(uniforms.sunDirection.y);
    let glareWarmth = mix(vec3<f32>(1.0, 0.98, 0.95), vec3<f32>(1.0, 0.85, 0.6), sunHorizonFactor);
    let glareColor = glareWarmth * glareIntensity * uniforms.sunDiskFade;
    skyColor = skyColor + glareColor;

    // Lens flare streaks
    let sunDirView = uniforms.sunDirection;
    let rayDirDiff = rayDir - sunDirView;

    let horizontalStreak = exp(-abs(rayDirDiff.y) * 15.0) * exp(-length(rayDirDiff.xz) * 3.0);
    let verticalStreak = exp(-abs(rayDirDiff.x) * 25.0) * exp(-abs(rayDirDiff.y) * 8.0);

    let angleToSun = atan2(rayDirDiff.y, rayDirDiff.x);
    let starPattern = pow(abs(cos(angleToSun * 3.0)), 12.0);
    let starFalloff = exp(-glowAngle * 6.0);

    let streakIntensity = (horizontalStreak * 0.4 + verticalStreak * 0.15 + starPattern * starFalloff * 0.3);
    let streakColor = glareWarmth * streakIntensity * uniforms.sunIntensity * 0.12 * sunTransmittanceAtViewer * uniforms.sunDiskFade * glowFade * viewAngleFactor;
    skyColor = skyColor + streakColor;

    // Mask by planet
    skyColor = skyColor * planetMask;

    // Tone mapping
    skyColor = skyColor / (skyColor + vec3<f32>(1.0));

    // Slight contrast boost
    skyColor = pow(skyColor, vec3<f32>(0.95));

    return vec4<f32>(skyColor, 1.0);
}
`;
    }

    _getSkyVertexGLSL() {
        return `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
    vec2 positions[3];
    positions[0] = vec2(-1.0, -1.0);
    positions[1] = vec2(3.0, -1.0);
    positions[2] = vec2(-1.0, 3.0);

    vec2 pos = positions[gl_VertexID];
    gl_Position = vec4(pos, 0.9999, 1.0);
    vUv = pos * 0.5 + 0.5;
}
`;
    }

    _getSkyFragmentGLSL() {
        return `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec3 cameraPosition;
uniform float viewerAltitude;
uniform vec3 sunDirection;
uniform vec3 planetCenter;
uniform float planetRadius;
uniform float atmosphereRadius;
uniform float scaleHeightRayleigh;
uniform float scaleHeightMie;
uniform float mieAnisotropy;
uniform vec3 rayleighScattering;
uniform float mieScattering;
uniform float sunIntensity;
uniform int numSamples;
uniform mat4 invViewProjMatrix;
uniform float hasLUT;
uniform float sunAngularDiameter;
uniform vec3 sunColor;
uniform float sunDiskFade;
uniform float time;

// Night sky uniforms
uniform float starSeed;
uniform float galaxyCount;
uniform float galaxySeed;
uniform float galaxyBrightness;
uniform float galaxySpread;
uniform float spaceLOD;
uniform float detailLevel;
uniform float starBoost;
uniform float starDensityMultiplier;

uniform sampler2D transmittanceLUT;
uniform sampler2D multiScatterLUT;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

// ============================================================================
// NOISE FUNCTIONS
// ============================================================================

float hash11(float p) {
    float p3 = fract(p * 0.1031);
    p3 += dot(p3, p3 + 33.33);
    return fract(p3 * p3);
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p) {
    vec3 p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    float n = sin(dot(p, vec2(41.0, 289.0)));
    return fract(vec2(262144.0, 32768.0) * n);
}

float seededHash12(vec2 p, float seed) {
    return hash13(vec3(p.x, p.y, seed));
}

vec2 seededHash22(vec2 p, float seed) {
    float h1 = hash13(vec3(p.x, p.y, seed));
    float h2 = hash13(vec3(p.y, p.x, seed + 127.1));
    return vec2(h1, h2);
}

float valueNoise(vec2 p, float seed) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    float a = seededHash12(i + vec2(0.0, 0.0), seed);
    float b = seededHash12(i + vec2(1.0, 0.0), seed);
    float c = seededHash12(i + vec2(0.0, 1.0), seed);
    float d = seededHash12(i + vec2(1.0, 1.0), seed);
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbmNoise(vec2 p, float seed, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    
    for (int i = 0; i < 4; i++) {
        if (i >= octaves) break;
        value += amplitude * valueNoise(p * frequency, seed + float(i) * 13.7);
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value;
}

// ============================================================================
// COORDINATE TRANSFORMS
// ============================================================================

vec2 dirToUV(vec3 dir) {
    float phi = atan(dir.z, dir.x);
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float u = phi / TAU + 0.5;
    float v = theta / PI;
    return vec2(u, v);
}

vec3 getRayDirection(vec2 uv) {
    vec4 ndc = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 1.0, 1.0);
    vec4 worldPos = invViewProjMatrix * ndc;
    worldPos /= worldPos.w;
    return normalize(worldPos.xyz - cameraPosition);
}

// ============================================================================
// STAR FIELD RENDERING
// ============================================================================

vec3 getStarColor(float seed, float colorSeed) {
    float temp = hash11(seed + colorSeed * 0.1);
    
    if (temp < 0.3) {
        float t = temp / 0.3;
        return mix(vec3(1.0, 0.4, 0.2), vec3(1.0, 0.7, 0.4), t);
    } else if (temp < 0.7) {
        float t = (temp - 0.3) / 0.4;
        return mix(vec3(1.0, 0.85, 0.6), vec3(1.0, 1.0, 0.95), t);
    } else {
        float t = (temp - 0.7) / 0.3;
        return mix(vec3(0.95, 0.95, 1.0), vec3(0.7, 0.8, 1.0), t);
    }
}

vec3 starLayer(vec2 uv, float scale, float density, float intensity, 
               float seed, float colorSeed, bool twinkle, float densityBoost) {
    vec2 cell = uv * scale;
    vec2 ip = floor(cell);
    vec2 fp = fract(cell);

    vec2 offset = seededHash22(ip, seed) * 0.6 - 0.3;
    vec2 starPos = fp - 0.5 - offset;

    float h = seededHash12(ip, seed + 100.0);
    float boostedDensity = clamp(density * densityBoost, 0.0, 1.0);
    float star = step(1.0 - boostedDensity, h);

    float brightnessRand = seededHash12(ip, seed + 200.0);
    float size = mix(0.02, 0.10, brightnessRand * brightnessRand);
    float dist = length(starPos);
    float shapeBase = 1.0 - smoothstep(0.0, size, dist);
    float shape = shapeBase * shapeBase;

    vec3 color = getStarColor(seededHash12(ip, seed + 300.0), colorSeed);

    float twinkleFactor = 1.0;
    if (twinkle) {
        float twinklePhase = seededHash12(ip, seed + 400.0) * TAU;
        float twinkleSpeed = 1.0 + seededHash12(ip, seed + 500.0) * 2.0;
        twinkleFactor = 0.7 + 0.3 * sin(time * twinkleSpeed + twinklePhase);
    }

    float brightnessMult = 0.3 + brightnessRand * 0.7;

    return color * star * shape * intensity * twinkleFactor * brightnessMult;
}

vec3 getStarfieldColor(vec3 dir, float seed, float colorSeed, int numLayers, 
                       float maxBrightness, bool twinkle, float sLOD, float densityBoost) {
    vec2 uv = dirToUV(dir);
    vec3 stars = vec3(0.0);

    if (numLayers >= 1) {
        stars += starLayer(uv, 200.0, 0.004, maxBrightness * 0.6, seed, colorSeed, twinkle, densityBoost);
    }
    if (numLayers >= 2) {
        stars += starLayer(uv + vec2(0.37, 0.71), 400.0, 0.006, maxBrightness * 0.8, seed + 1000.0, colorSeed, twinkle, densityBoost);
    }
    if (numLayers >= 3) {
        stars += starLayer(uv + vec2(0.13, 0.29), 100.0, 0.002, maxBrightness * 1.2, seed + 2000.0, colorSeed, twinkle, densityBoost);
    }
    if (numLayers >= 4) {
        stars += starLayer(uv + vec2(0.53, 0.17), 600.0, 0.008, maxBrightness * 0.4, seed + 3000.0, colorSeed, twinkle, densityBoost);
    }

    if (sLOD > 0.5 && numLayers >= 4) {
        stars += starLayer(uv + vec2(0.31, 0.67), 1000.0, 0.012, maxBrightness * 0.2, seed + 6000.0, colorSeed, twinkle, densityBoost);
    }

    return stars;
}

// ============================================================================
// GALAXY RENDERING  
// ============================================================================

vec3 galaxyBand(vec3 dir, int bandIndex, float gSeed, float spread, 
                int samples, float brightness) {
    float bandSeed = gSeed + float(bandIndex) * 1000.0;
    
    float rotX = seededHash12(vec2(float(bandIndex), 0.0), bandSeed) * PI;
    float rotY = seededHash12(vec2(float(bandIndex), 1.0), bandSeed) * TAU;
    
    float cosY = cos(rotY);
    float sinY = sin(rotY);
    float cosX = cos(rotX);
    float sinX = sin(rotX);
    
    vec3 d = dir;
    d = vec3(d.x * cosY + d.z * sinY, d.y, -d.x * sinY + d.z * cosY);
    d = vec3(d.x, d.y * cosX - d.z * sinX, d.y * sinX + d.z * cosX);
    
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float lon = atan(d.z, d.x);
    
    float planeDistance = abs(lat) / (PI * 0.5);
    float coreDistance = abs(lon) / PI;
    float bandWidth = spread * (1.0 - coreDistance * 0.5);
    
    float bandMask = 1.0 - smoothstep(0.0, bandWidth, planeDistance);
    
    if (bandMask < 0.01) {
        return vec3(0.0);
    }
    
    vec2 uvGalaxy = vec2(lon / TAU + 0.5, planeDistance / spread);
    
    float dust = 0.0;
    if (samples >= 1) {
        dust = fbmNoise(uvGalaxy * 8.0, bandSeed, min(samples, 4));
    }
    
    float spiralAngle = lon + planeDistance * 4.0;
    float spiral = 0.5 + 0.5 * sin(spiralAngle * 2.0);
    
    float coreGlow = exp(-coreDistance * 3.0) * exp(-planeDistance * planeDistance / (spread * spread * 0.5));
    
    float structure = mix(dust, spiral, 0.3) * bandMask;
    float core = coreGlow * bandMask * 2.0;
    
    vec3 coreColor = vec3(1.0, 0.95, 0.8);
    vec3 armColor = vec3(0.7, 0.75, 0.9);
    vec3 dustColor = vec3(0.4, 0.35, 0.5);
    
    vec3 galaxyColor = mix(armColor, coreColor, coreGlow);
    galaxyColor = mix(galaxyColor, dustColor, dust * 0.5);
    
    float totalBrightness = (structure * 0.3 + core * 0.7) * brightness;
    
    return galaxyColor * totalBrightness * bandMask;
}

vec3 getGalaxyColor(vec3 dir, int gCount, float gSeed, float spread, 
                    int samples, float brightness) {
    if (gCount <= 0) {
        return vec3(0.0);
    }
    
    vec3 totalGalaxy = vec3(0.0);
    
    for (int i = 0; i < 4; i++) {
        if (i >= gCount) break;
        totalGalaxy += galaxyBand(dir, i, gSeed, spread, samples, brightness);
    }
    
    return totalGalaxy;
}

// ============================================================================
// ATMOSPHERE
// ============================================================================

vec2 raySphereIntersect(vec3 origin, vec3 dir, vec3 center, float radius) {
    vec3 oc = origin - center;
    float a = dot(dir, dir);
    float b = 2.0 * dot(oc, dir);
    float c = dot(oc, oc) - radius * radius;
    float discriminant = b * b - 4.0 * a * c;
    if (discriminant < 0.0) {
        return vec2(-1.0, -1.0);
    }
    float sqrtD = sqrt(discriminant);
    float t1 = (-b - sqrtD) / (2.0 * a);
    float t2 = (-b + sqrtD) / (2.0 * a);
    return vec2(t1, t2);
}

float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
    float g2 = g * g;
    float num = (1.0 - g2);
    float denom = 4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / max(denom, 0.0001);
}

vec2 getTransmittanceUV(float altitude, float cosTheta) {
    float H = sqrt(max(0.0, atmosphereRadius * atmosphereRadius - planetRadius * planetRadius));
    float rho = sqrt(max(0.0, (planetRadius + altitude) * (planetRadius + altitude) - planetRadius * planetRadius));
    float u = clamp(rho / max(H, 0.001), 0.0, 1.0);
    float r = planetRadius + altitude;
    float dMin = atmosphereRadius - r;
    float dMax = rho + H;
    float cosT = clamp(cosTheta, -1.0, 1.0);
    float disc = max(0.0, r * r * cosT * cosT + atmosphereRadius * atmosphereRadius - r * r);
    float d = -r * cosT + sqrt(disc);
    float v = clamp((d - dMin) / max(dMax - dMin, 0.001), 0.0, 1.0);
    return vec2(u, v);
}

vec3 sampleTransmittance(float altitude, float cosTheta) {
    vec2 uv = getTransmittanceUV(altitude, cosTheta);
    return texture(transmittanceLUT, uv).rgb;
}

vec3 sampleMultiScatter(float altitude, float cosSunZenith) {
    float atmoHeight = max(1.0, atmosphereRadius - planetRadius);
    float u = clamp(cosSunZenith * 0.5 + 0.5, 0.0, 1.0);
    float v = clamp(altitude / atmoHeight, 0.0, 1.0);
    return texture(multiScatterLUT, vec2(u, v)).rgb;
}

vec2 getDensity(float altitude) {
    float densityR = exp(-max(0.0, altitude) / scaleHeightRayleigh);
    float densityM = exp(-max(0.0, altitude) / scaleHeightMie);
    return vec2(densityR, densityM);
}

// ============================================================================
// MAIN
// ============================================================================

void main() {
    vec3 rayDir = getRayDirection(vUv);
    vec3 rayOrigin = cameraPosition;

    vec2 planetHit = raySphereIntersect(rayOrigin, rayDir, planetCenter, planetRadius);
    float planetMask = planetHit.y > 0.0 ? 0.0 : 1.0;

    vec2 atmoHit = raySphereIntersect(rayOrigin, rayDir, planetCenter, atmosphereRadius);
    float atmoHeight = max(atmosphereRadius - planetRadius, 1.0);
    float terminatorAlt = smoothstep(0.0, atmoHeight * 0.6, viewerAltitude);
    float terminatorWidth = mix(0.6, 0.12, terminatorAlt);
    float terminatorCenter = mix(-0.2, -0.05, terminatorAlt);
    float atmoLen = max(atmoHit.y - max(atmoHit.x, 0.0), 0.0);
    float atmoSoft = max(500.0, atmoHeight * 0.05);
    float atmoMask = smoothstep(0.0, atmoSoft, atmoLen);

    float tStart = max(0.0, atmoHit.x) * atmoMask;
    float tEnd = atmoHit.y * atmoMask;
    float marchLength = max(tEnd - tStart, 0.0);

    float stepSize = marchLength / float(numSamples);

    vec3 inscatter = vec3(0.0);
    vec3 transmittance = vec3(1.0);

    float cosTheta = dot(rayDir, sunDirection);
    float phaseR = rayleighPhase(cosTheta);
    float phaseM = miePhase(cosTheta, mieAnisotropy);

    for (int i = 0; i < 64; i++) {
        if (i >= numSamples) break;

        float t = tStart + (float(i) + 0.5) * stepSize;
        vec3 samplePos = rayOrigin + rayDir * t;
        float sampleAltitude = length(samplePos - planetCenter) - planetRadius;

        if (sampleAltitude < 0.0) continue;

        vec2 density = getDensity(sampleAltitude);

        vec3 upAtSample = normalize(samplePos - planetCenter);
        float cosSunZenith = dot(sunDirection, upAtSample);
        float sunVisibility = smoothstep(terminatorCenter - terminatorWidth, terminatorCenter + terminatorWidth, cosSunZenith);
        vec3 sunTransmittance = sampleTransmittance(sampleAltitude, cosSunZenith);

        vec3 scatterR = rayleighScattering * density.x * phaseR;
        vec3 scatterM = vec3(mieScattering * density.y * phaseM);

        vec3 scatterContrib = (scatterR + scatterM) * sunTransmittance * sunVisibility * stepSize;
        inscatter += transmittance * scatterContrib;

        vec3 extinctionR = rayleighScattering * density.x;
        vec3 extinctionM = vec3(mieScattering * density.y * 1.1);
        transmittance *= exp(-(extinctionR + extinctionM) * stepSize);
    }

    vec3 skyColor = inscatter * sunIntensity * atmoMask;

    vec3 upAtCamera = normalize(rayOrigin - planetCenter);
    if (hasLUT > 0.5) {
        float cosSunZenith = dot(sunDirection, upAtCamera);
        vec3 multiScatter = sampleMultiScatter(max(0.0, viewerAltitude), cosSunZenith);
        skyColor += multiScatter * sunIntensity * 0.6 * atmoMask;
    }

    float cosViewUp = dot(rayDir, upAtCamera);
    float horizonFactor = pow(clamp(1.0 - max(cosViewUp, 0.0), 0.0, 1.0), 1.4);
    float densityFade = exp(-max(viewerAltitude, 0.0) / max(scaleHeightRayleigh * 2.2, 1.0));
    float skyFade = clamp(densityFade, 0.0, 1.0);
    skyColor *= skyFade * mix(0.35, 1.0, horizonFactor);

    float sunAlt = clamp(dot(sunDirection, upAtCamera) * 0.5 + 0.5, 0.0, 1.0);
    vec3 horizonColor = mix(vec3(0.55, 0.75, 0.95), vec3(0.95, 0.75, 0.45), 1.0 - sunAlt);
    vec3 zenithColor = mix(vec3(0.15, 0.35, 0.7), vec3(0.25, 0.45, 0.75), sunAlt);
    vec3 gradientSky = mix(zenithColor, horizonColor, horizonFactor);

    float gradientWeight = skyFade * mix(0.4, 1.0, horizonFactor);
    skyColor = skyColor + gradientSky * (sunAlt + 0.3) * gradientWeight * 0.6;
    vec3 minBlue = vec3(0.1, 0.2, 0.4) * sunAlt * skyFade;
    skyColor = max(skyColor, minBlue);

    // ========== NIGHT SKY ==========
    float nightFactor = 1.0 - smoothstep(0.25, 0.6, sunAlt);
    float spaceFactor = smoothstep(atmoHeight * 0.4, atmoHeight * 1.6, viewerAltitude);
   
float distToCenter = length(rayOrigin - planetCenter);
float cosGeoHorizon = -sqrt(max(0.0, 1.0 - (planetRadius / distToCenter)
                                           * (planetRadius / distToCenter)));

float atmoH  = max(atmosphereRadius - planetRadius, 1.0);
float altFrac = clamp(viewerAltitude / atmoH, 0.0, 1.0);

float fadeW = mix(0.12, 0.005, sqrt(altFrac));
float starHorizonFade = smoothstep(cosGeoHorizon - fadeW,
                                    cosGeoHorizon + fadeW * 3.0,
                                    cosViewUp);

float atmosphereFade = mix(0.25, 1.0, 1.0 - skyFade);
float starVisibility = mix(nightFactor, 1.0, spaceFactor) * starHorizonFade * atmosphereFade;

    // Determine detail settings based on detailLevel uniform
    int numStarLayers = detailLevel < 0.5 ? 2 : (detailLevel < 1.5 ? 4 : 6);
    float maxBrightness = detailLevel < 0.5 ? 1.2 : (detailLevel < 1.5 ? 2.0 : 3.0);
    bool twinkleEnabled = detailLevel >= 0.5;
    bool galaxyEnabled = detailLevel >= 1.0;
    int galaxySamples = detailLevel < 1.5 ? 4 : 8;

    // Stars
    vec3 stars = getStarfieldColor(rayDir, starSeed, starSeed + 5000.0, numStarLayers, 
                                    maxBrightness, twinkleEnabled, spaceLOD, starDensityMultiplier) * starVisibility * starBoost;

    // Galaxies
    vec3 galaxies = vec3(0.0);
    if (galaxyEnabled && galaxyCount > 0.0) {
        galaxies = getGalaxyColor(rayDir, int(galaxyCount), galaxySeed, galaxySpread, 
                                   galaxySamples, galaxyBrightness) * starVisibility * 0.125;
    }



    skyColor += (stars + galaxies) * transmittance;

    // ========== SUN DISC ==========
    float cosAngleToSun = dot(rayDir, sunDirection);
    float sunAngularRadius = sunAngularDiameter * 0.5;
    float cosSunRadius = cos(sunAngularRadius);

    if (cosAngleToSun > cosSunRadius - 0.002) {
        float sunEdge = smoothstep(cosSunRadius - 0.002, cosSunRadius, cosAngleToSun);
        float limbDarkening = 1.0 - pow(1.0 - sunEdge, 0.5) * 0.3;

        vec3 sunTransmittanceVal = vec3(1.0);
        if (hasLUT > 0.5) {
            float cosSunZenith = dot(sunDirection, upAtCamera);
            sunTransmittanceVal = sampleTransmittance(viewerAltitude, cosSunZenith);
        }

        vec3 sunDiscColor = sunColor * sunIntensity * 5.0 * limbDarkening * sunTransmittanceVal * sunDiskFade;
        skyColor = mix(skyColor, sunDiscColor, sunEdge * sunDiskFade);
    }

    float glowAngle = acos(clamp(cosAngleToSun, -1.0, 1.0));
    float glowWidth = sunAngularRadius * 8.0;
    float glow = exp(-glowAngle * glowAngle / (glowWidth * glowWidth * 2.0));
    vec3 coronaColor = sunColor * glow * sunIntensity * 0.3 * sunDiskFade;
    skyColor += coronaColor;

    skyColor *= planetMask;
    skyColor = skyColor / (skyColor + vec3(1.0));

    fragColor = vec4(skyColor, 1.0);
}
`;
    }

    dispose() {
        this.initialized = false;
        this.skyMaterial = null;
        this.fullscreenGeometry = null;
    }

    _getBlitVertexWGSL() {
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
    output.position = vec4<f32>(pos[vertexIndex], 0.9999, 1.0);
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    return output;
}
        `;
    }

    _getBlitFragmentWGSL() {
        return /* wgsl */`
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);
    return textureSampleLevel(sourceTexture, sourceSampler, flippedUV, 0.0);
}
        `;
    }

    _createFullscreenTriangle() {
        const geom = new Geometry();
        const positions = new Float32Array([
            -1, -1, 0,
             3, -1, 0,
            -1,  3, 0,
        ]);
        const normals = new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]);
        const uvs = new Float32Array([
            0, 0,
            2, 0,
            0, 2
        ]);

        geom.setAttribute('position', positions, 3);
        geom.setAttribute('normal', normals, 3);
        geom.setAttribute('uv', uvs, 2);
        return geom;
    }
}
