import { Vector3, Matrix4, Color } from '../../shared/math/index.js';
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

        this.vertexWGSL = this._getSkyVertexWGSL();
        this.fragmentWGSL = this._getSkyFragmentWGSL();
        this.fullscreenGeometry = this._createFullscreenTriangle();
        this.skyMaterial = new Material({
            name: 'SkyRenderer',
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
            name: 'SkyBlit',
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

        this.initialized = true;
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

        this._renderSky(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade);
    }

    _renderSky(camera, atmosphereSettings, sunDir, uniformManager, sunDiskFade) {
        if (!this.skyMaterial || !this.fullscreenGeometry) return;
        
        const hasLUT = !!(this.atmosphereLUT?.transmittanceLUT && this.atmosphereLUT.transmittanceLUT._gpuTexture);

        const u = this.skyMaterial.uniforms.skyUniforms.value;
        const planetCenter = uniformManager?.uniforms?.planetCenter?.value || new Vector3();
        const planetRadius = atmosphereSettings?.planetRadius ??
            uniformManager?.uniforms?.atmospherePlanetRadius?.value ?? 50000;
        const atmosphereRadius = atmosphereSettings?.atmosphereRadius ??
            uniformManager?.uniforms?.atmosphereRadius?.value ?? planetRadius + 10000;
        const rayleigh = atmosphereSettings?.rayleighScattering ??
            uniformManager?.uniforms?.atmosphereRayleighScattering?.value ??
            new Vector3(5.5e-6, 13.0e-6, 22.4e-6);
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

        const sDir = (sunDir || uniformManager?.uniforms?.sunLightDirection?.value || new Vector3(0.5, 1.0, 0.3)).clone().normalize();

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
const viewProj = new Matrix4().multiplyMatrices(camera.projectionMatrix, rotOnlyView);
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
