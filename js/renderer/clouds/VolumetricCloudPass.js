// js/renderer/clouds/VolumetricCloudPass.js
// True volumetric cloud rendering pass for close-distance volumes
// High-quality raymarching with 128³ noise textures

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { getCloudCommonWGSL } from './shaders/cloudCommon.wgsl.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

export class VolumetricCloudPass {
    constructor(backend, config = {}) {
        this.backend = backend;
        this.enabled = true;
        this.initialized = false;
        
        // Configuration
        this.config = {
            maxSteps: config.maxSteps ?? 96,
            shadowSteps: config.shadowSteps ?? 6,
            maxLodBlend: config.maxLodBlend ?? 0.95,  // Stop rendering when lodBlend >= this
        };
        
        this.material = null;
        this.fullscreenGeometry = null;
        
        // Track which volumes need volumetric rendering
        this._activeVolumeIndices = [];
        this._hasWork = false;
    }
    
    async initialize() {
        if (this.initialized) return;
        
        this.fullscreenGeometry = this._createFullscreenTriangle();
        
        this.material = new Material({
            name: 'VolumetricCloudPass',
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'VolumetricUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'matrixUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'cloudParams' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'atmosphereParams' },
                        { binding: 3, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'volumeParams' }
                    ]
                },
                {
                    label: 'VolumetricTextures',
                    entries: [
                        // High-res volumetric noise textures
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseVolBase' },
                        { binding: 1, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseVolDetail' },
                        // Standard noise for fallback/blending
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseErosion' },
                        { binding: 3, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerRepeat' },
                        { binding: 4, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerClamp' },
                        { binding: 5, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'transmittanceLUT' },
                        { binding: 6, visibility: 'fragment', texture: { sampleType: 'depth', viewDimension: '2d' }, name: 'sceneDepthTexture' }
                    ]
                }
            ],
            uniforms: {
                matrixUniforms: { value: null },
                cloudParams: { value: null },
                atmosphereParams: { value: null },
                volumeParams: { value: null },
                noiseVolBase: { value: null },
                noiseVolDetail: { value: null },
                noiseErosion: { value: null },
                noiseSamplerRepeat: { value: 'linear-repeat' },
                noiseSamplerClamp: { value: 'linear' },
                transmittanceLUT: { value: null },
                sceneDepthTexture: { value: null }
            },
            transparent: true,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'premultiplied'
        });
        
        this.initialized = true;
    }
    
    setSharedResources(resources) {
        if (resources.matrixUniforms) {
            this.material.uniforms.matrixUniforms.value = resources.matrixUniforms;
        }
        if (resources.cloudParams) {
            this.material.uniforms.cloudParams.value = resources.cloudParams;
        }
        if (resources.atmosphereParams) {
            this.material.uniforms.atmosphereParams.value = resources.atmosphereParams;
        }
        if (resources.volumeParamsData) {
            this.material.uniforms.volumeParams.value = resources.volumeParamsData;
        }
        if (resources.noiseVolBase) {
            this.material.uniforms.noiseVolBase.value = resources.noiseVolBase;
        }
        if (resources.noiseVolDetail) {
            this.material.uniforms.noiseVolDetail.value = resources.noiseVolDetail;
        }
        if (resources.noiseErosion) {
            this.material.uniforms.noiseErosion.value = resources.noiseErosion;
        }
        if (resources.transmittanceLUT) {
            this.material.uniforms.transmittanceLUT.value = resources.transmittanceLUT;
        }
        if (resources.sceneDepthTexture) {
            this.material.uniforms.sceneDepthTexture.value = resources.sceneDepthTexture;
        }
    }
    
    update(volumeSelector) {
        return;
        if (!this.initialized || !this.enabled) return;
        
        const activeCount = volumeSelector?.getActiveCount() ?? 0;
        if (activeCount === 0) {
            this._hasWork = false;
            this._activeVolumeIndices = [];
            return;
        }
        
        // Find volumes that need volumetric rendering (lodBlend < maxLodBlend)
        const volumeBuffer = volumeSelector.getVolumeBuffer();
        this._activeVolumeIndices = [];
        
        for (let i = 0; i < activeCount; i++) {
            const lodBlend = volumeBuffer[i * 16 + 7];
            if (lodBlend < this.config.maxLodBlend) {
                this._activeVolumeIndices.push(i);
            }
        }
        
        this._hasWork = this._activeVolumeIndices.length > 0;
    }
    
    render(backend) {
        return;
        if (!this.initialized || !this.enabled || !this._hasWork) return;
        if (!this.material.uniforms.noiseVolBase.value) return;
        
        // Render single fullscreen pass - shader handles all volumes
        backend.draw(this.fullscreenGeometry, this.material);
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
    
    _getVertexShader() {
        return /* wgsl */`
        struct MatrixUniforms {
            inverseView: mat4x4<f32>,
            inverseProjection: mat4x4<f32>,
            cameraPosition: vec3<f32>,
            _pad0: f32,
            prevViewProj: mat4x4<f32>
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
    
    _getFragmentShader() {
        const cloudCommon = getCloudCommonWGSL();
        
        return /* wgsl */`
${AERIAL_PERSPECTIVE_WGSL}
${cloudCommon}

// ============================================================================
// VOLUMETRIC CLOUD PASS - High-quality close-distance volume rendering
// ============================================================================

struct MatrixUniforms {
    inverseView: mat4x4<f32>,
    inverseProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _pad0: f32,
    prevViewProj: mat4x4<f32>
};

struct CloudParams {
    planetCenter: vec3<f32>,
    planetRadius: f32,
    cumulusInnerRadius: f32,
    cumulusOuterRadius: f32,
    cirrusInnerRadius: f32,
    cirrusOuterRadius: f32,

    sunDirX: f32,
    sunDirY: f32,
    sunDirZ: f32,
    sunIntensity: f32,

    coverage: f32,
    time: f32,
    windSpeed: f32,
    cloudAnisotropy: f32,

    windDirX: f32,
    windDirY: f32,
    baseTileSize: f32,
    detailTileSize: f32,
    erosionTileSize: f32,

    historyBlend: f32,
    historyValid: f32,
    weatherType: f32,

    lodSteps: f32,
    lodLightSteps: f32,
    frameIndex: f32,
    renderScale: f32,

    windOffsetX: f32,
    windOffsetY: f32,
    volumetricLowOnly: f32,

    viewportWidth: f32,
    viewportHeight: f32,

    _pad3: vec4<f32>,
    _pad4: vec4<f32>,
    _pad5: vec4<f32>,

    layerLow_altMin: f32, layerLow_altMax: f32, layerLow_coverage: f32, layerLow_densityMult: f32,
    layerLow_noiseScale: f32, layerLow_verticalStretch: f32, layerLow_worleyInfluence: f32, layerLow_edgeSoftness: f32,
    layerLow_extinction: f32, layerLow_albedo: f32, layerLow_cauliflower: f32,
    layerLow_pad0: f32, layerLow_pad1: f32, layerLow_pad2: f32, layerLow_pad3: f32, layerLow_pad4: f32,

    layerMid_altMin: f32, layerMid_altMax: f32, layerMid_coverage: f32, layerMid_densityMult: f32,
    layerMid_noiseScale: f32, layerMid_verticalStretch: f32, layerMid_worleyInfluence: f32, layerMid_edgeSoftness: f32,
    layerMid_extinction: f32, layerMid_albedo: f32, layerMid_cauliflower: f32,
    layerMid_pad0: f32, layerMid_pad1: f32, layerMid_pad2: f32, layerMid_pad3: f32, layerMid_pad4: f32,

    layerHigh_altMin: f32, layerHigh_altMax: f32, layerHigh_coverage: f32, layerHigh_densityMult: f32,
    layerHigh_noiseScale: f32, layerHigh_verticalStretch: f32, layerHigh_worleyInfluence: f32, layerHigh_edgeSoftness: f32,
    layerHigh_extinction: f32, layerHigh_albedo: f32, layerHigh_cauliflower: f32,
    layerHigh_pad0: f32, layerHigh_pad1: f32, layerHigh_pad2: f32, layerHigh_pad3: f32, layerHigh_pad4: f32,

    // Volume tuning (extended cloud params)
    volumeTierAMaxDist: f32,
    volumeTierBMaxDist: f32,
    volumeFadeStart: f32,
    volumeFadeEnd: f32,
    volumeCellSize: f32,
    volumeFogCellSize: f32,
    volumeMinCoverage: f32,
    volumeDebugFlags: f32,
    volumePad: array<vec4<f32>, 14>,
};

struct AtmosphereParams {
    atmosphereRadius: f32,
    scaleHeightRayleigh: f32,
    scaleHeightMie: f32,
    mieAnisotropy: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> matrices: MatrixUniforms;
@group(0) @binding(1) var<uniform> params: CloudParams;
@group(0) @binding(2) var<uniform> atmo: AtmosphereParams;
@group(0) @binding(3) var<uniform> volumeParams: VolumeParams;

@group(1) @binding(0) var noiseVolBase: texture_3d<f32>;
@group(1) @binding(1) var noiseVolDetail: texture_3d<f32>;
@group(1) @binding(2) var noiseErosion: texture_3d<f32>;
@group(1) @binding(3) var noiseSamplerRepeat: sampler;
@group(1) @binding(4) var noiseSamplerClamp: sampler;
@group(1) @binding(5) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(6) var sceneDepthTexture: texture_depth_2d;

const PI: f32 = 3.14159265359;
const VOL_MAX_STEPS: u32 = 96u;
const VOL_LIGHT_STEPS: u32 = 6u;
const TIME_SCALE: f32 = 0.066;

// ----------------------------------------------------------------------------
// Ray Helpers
// ----------------------------------------------------------------------------

fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let view = matrices.inverseProjection * clip;
    let world = matrices.inverseView * vec4<f32>(view.xyz / view.w, 0.0);
    return normalize(world.xyz);
}

fn getSceneDepth(uv: vec2<f32>) -> f32 {
    let depthDims = textureDimensions(sceneDepthTexture);
    let uvDepth = vec2<f32>(uv.x, 1.0 - uv.y);
    let coord = vec2<i32>(uvDepth * vec2<f32>(f32(depthDims.x), f32(depthDims.y)));
    let clampedCoord = clamp(coord, vec2<i32>(0), vec2<i32>(depthDims) - vec2<i32>(1));
    return textureLoad(sceneDepthTexture, clampedCoord, 0);
}

fn linearizeDepth(depth: f32, near: f32, far: f32) -> f32 {
    return (near * far) / (far - depth * (far - near));
}

fn bayer8(p: vec2<f32>) -> f32 {
    let x = u32(p.x) % 8u;
    let y = u32(p.y) % 8u;
    var m = array<u32, 64>(
        0u, 32u, 8u, 40u, 2u, 34u, 10u, 42u,
        48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
        12u, 44u, 4u, 36u, 14u, 46u, 6u, 38u,
        60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
        3u, 35u, 11u, 43u, 1u, 33u, 9u, 41u,
        51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
        15u, 47u, 7u, 39u, 13u, 45u, 5u, 37u,
        63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u
    );
    return f32(m[y * 8u + x]) / 64.0;
}

// ----------------------------------------------------------------------------
// High-Resolution Noise Sampling
// ----------------------------------------------------------------------------

fn sampleVolNoise3D(tex: texture_3d<f32>, coord: vec3<f32>, lod: f32) -> vec4<f32> {
    return textureSampleLevel(tex, noiseSamplerRepeat, fract(coord), lod);
}

fn domainWarpVol(coord: vec3<f32>, strength: f32) -> vec3<f32> {
    let warpSample = sampleVolNoise3D(noiseErosion, coord * 0.3, 1.0).xyz;
    let warp = (warpSample - vec3<f32>(0.5)) * strength;
    return coord + warp;
}

fn flowAdvectVol(coord: vec3<f32>, time: f32, speed: f32, strength: f32) -> vec3<f32> {
    let flowSample = sampleVolNoise3D(noiseErosion, coord * 0.15 + vec3<f32>(time * speed, 0.0, time * speed * 0.7), 1.0).xy;
    let flow = (flowSample - vec2<f32>(0.5)) * 2.0;
    return coord + vec3<f32>(flow.x, 0.0, flow.y) * strength;
}

// ----------------------------------------------------------------------------
// Volumetric Density Sampling (High Quality)
// ----------------------------------------------------------------------------

fn sampleVolumetricDensity(worldPos: vec3<f32>, volume: VolumeDesc, sunDir: vec3<f32>) -> f32 {
    // Local position within volume
    let localPos = worldPos - volume.center;
    let normalizedPos = vec3<f32>(
        localPos.x / volume.radiusH,
        localPos.y / volume.radiusV,
        localPos.z / volume.radiusH
    );
    
    // Distance from center
    let distFromCenter = length(normalizedPos);
    if (distFromCenter > 1.05) { return 0.0; }
    
    // Height fraction within volume
    let heightFrac = clamp((normalizedPos.y + 1.0) * 0.5, 0.0, 1.0);
    
    // Volume profile
    let profile = cloudGetVolumeProfile(heightFrac, volume.fogType, localPos);
    
    // Wind animation
    let windOffset = vec3<f32>(params.windOffsetX, 0.0, params.windOffsetY);
    let animPos = worldPos - windOffset;
    let animTime = params.time * TIME_SCALE;
    
    // High-res base noise coordinate
    let baseTileSize = params.baseTileSize * 0.3; // Tighter tiling for detail
    let baseCoord = (animPos - params.planetCenter) / baseTileSize;
    
    // Domain warping for organic shapes
    var warpedCoord = domainWarpVol(baseCoord, 0.08);
    warpedCoord = flowAdvectVol(warpedCoord, animTime * 0.03, 0.5, 0.4);
    
    // Sample high-res base noise (128³)
    let baseSample = sampleVolNoise3D(noiseVolBase, warpedCoord, 0.0);
    
    // Perlin-Worley hybrid for shape
    let worleyInfluence = params.layerLow_worleyInfluence;
    let combinedBase = mix(baseSample.r, baseSample.g, worleyInfluence * 0.6);
    
    // Coverage with local variation
    let coverageMod = mix(0.8, 1.2, baseSample.b);
    let effCoverage = clamp(volume.coverageLocal * params.layerLow_coverage * coverageMod * 1.3, 0.0, 1.0);
    
    // Soft threshold
    let threshold = 1.0 - effCoverage;
    var shape = cloudSmoothstep(threshold - 0.1, threshold + 0.2, combinedBase);
    
    // Early out for empty regions
    if (shape < 0.01) { return 0.0; }
    
    // Apply volume profile
    shape *= profile;
    
    // Edge falloff
    let edgeFalloff = 1.0 - cloudSmoothstep(0.75, 1.0, distFromCenter);
    shape *= edgeFalloff;
    
    // Detail noise pass (64³)
    let detailTileSize = params.detailTileSize * 0.4;
    let detailCoord = (animPos - params.planetCenter) / detailTileSize + vec3<f32>(0.37, 0.11, 0.73);
    let detailWarped = domainWarpVol(detailCoord, 0.05);
    let detailFlowed = flowAdvectVol(detailWarped, animTime * 0.05, 0.6, 0.3);
    let detailSample = sampleVolNoise3D(noiseVolDetail, detailFlowed, 0.0);
    
    // Detail modulation
    let detailMod = 0.7 + detailSample.r * 0.6;
    shape *= detailMod;
    
    // Cauliflower billowing (high-quality version)
    let cauliflower = clamp(params.layerLow_cauliflower, 0.0, 1.0);
    if (cauliflower > 0.001 && shape > 0.02) {
        let billowCoord = detailFlowed * 1.7 + vec3<f32>(0.19, 0.71, 0.37);
        let billowSample = sampleVolNoise3D(noiseVolDetail, billowCoord, 0.5);
        
        let ridgeBase = cloudRidgeNoise(billowSample.r);
        let ridge2 = cloudRidgeNoise(billowSample.g * 0.8 + detailSample.g * 0.2);
        let combinedRidge = mix(ridgeBase, ridge2, 0.4);
        
        // Sun-facing bias for realistic lighting interaction
        let up = normalize(worldPos - params.planetCenter);
        let sunFacing = clamp(dot(up, sunDir) * 0.5 + 0.5, 0.0, 1.0);
        
        // Top bias - billows stronger at top of clouds
        let topBias = cloudSmoothstep(0.3, 0.8, heightFrac);
        
        // Edge emphasis
        let edgeBias = 1.0 - cloudSmoothstep(0.2, 0.7, shape);
        
        let billowStrength = cauliflower 
            * mix(0.2, 1.0, topBias)
            * mix(0.4, 1.0, edgeBias)
            * mix(0.8, 1.2, sunFacing)
            * (0.7 + baseSample.b * 0.6);
        
        shape = clamp(shape + combinedRidge * billowStrength * 0.15, 0.0, 1.0);
    }
    
    // Erosion pass for wispy edges
    if (shape > 0.01) {
        let erosionCoord = (animPos - params.planetCenter) / params.erosionTileSize + vec3<f32>(0.61, 0.29, 0.19);
        let erosionWarped = domainWarpVol(erosionCoord, 0.04);
        let erosionSample = sampleVolNoise3D(noiseErosion, erosionWarped, 0.0);
        
        let edgeMask = 1.0 - cloudSmoothstep(0.15, 0.5, shape);
        let edgeSoftness = params.layerLow_edgeSoftness;
        let wispStrength = (1.0 - edgeSoftness) * 0.1;
        
        let worleyCarve = (1.0 - erosionSample.r) * wispStrength * edgeMask;
        shape = max(0.0, shape - worleyCarve);
    }
    
    // Final density
    return max(0.0, shape * volume.densityMult * params.layerLow_densityMult);
}

// ----------------------------------------------------------------------------
// Volumetric Light Sampling (High Quality)
// ----------------------------------------------------------------------------

fn sampleVolumetricLight(worldPos: vec3<f32>, sunDir: vec3<f32>, volume: VolumeDesc) -> vec3<f32> {
    let maxStepDist = max(volume.radiusH, volume.radiusV) * 0.8;
    let stepSize = maxStepDist / f32(VOL_LIGHT_STEPS);
    
    var opticalDepth = 0.0;
    for (var i = 0u; i < VOL_LIGHT_STEPS; i++) {
        let t = (f32(i) + 0.5) * stepSize;
        let samplePos = worldPos + sunDir * t;
        let density = sampleVolumetricDensity(samplePos, volume, sunDir);
        opticalDepth += density * stepSize;
    }
    
    // Atmospheric transmittance
    let altitude = length(worldPos - params.planetCenter) - params.planetRadius;
    let up = normalize(worldPos - params.planetCenter);
    let sunZenith = dot(up, sunDir);
    let sunTrans = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, altitude, sunZenith, params.planetRadius, atmo.atmosphereRadius);
    
    // Beer-Lambert with enhanced powder term for volumetrics
    let absorptionCoeff = params.layerLow_extinction * 0.8;
    let beer = exp(-opticalDepth * absorptionCoeff);
    let powder = 1.0 - exp(-opticalDepth * absorptionCoeff * 2.0);
    
    // Multiple scattering approximation
    let ms = 1.0 - exp(-opticalDepth * 0.1);
    let multiScatterBoost = 0.4 * ms;
    
    let lightIntensity = mix(beer, powder * 0.35 + beer * 0.65, 0.4) + multiScatterBoost;
    
    return sunTrans * lightIntensity;
}

// ----------------------------------------------------------------------------
// Volume Hit Detection
// ----------------------------------------------------------------------------

struct VolumeHit {
    volumeIndex: i32,
    tNear: f32,
    tFar: f32,
    lodBlend: f32,
};

fn findClosestVolumetricHit(ro: vec3<f32>, rd: vec3<f32>, maxT: f32) -> VolumeHit {
    var result: VolumeHit;
    result.volumeIndex = -1;
    result.tNear = maxT;
    result.tFar = maxT;
    result.lodBlend = 0.0;
    
    let activeCount = volumeParams.activeCount;
    if (activeCount == 0u) { return result; }
    
    for (var i = 0u; i < min(activeCount, 4u); i++) {
        let vol = volumeParams.volumes[i];
        
        // FIX: For now, render ALL volumes (remove lodBlend check until Tier A exists)
        // Later: if (vol.lodBlend < 0.01) { continue; }
        
        let hit = cloudRayEllipsoidIntersect(ro, rd, vol.center, vol.radiusH, vol.radiusV);
        
        if (hit.x >= 0.0 && hit.x < result.tNear) {
            result.volumeIndex = i32(i);
            result.tNear = max(hit.x, 0.0);
            result.tFar = min(hit.y, maxT);
            result.lodBlend = vol.lodBlend;
        }
    }
    
    return result;
}
// ----------------------------------------------------------------------------
// Main Fragment
// ----------------------------------------------------------------------------

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rayDir = getRayDirection(uv);
    let rayOrigin = matrices.cameraPosition;
    let sunDir = normalize(vec3<f32>(params.sunDirX, params.sunDirY, params.sunDirZ));
    
    // Early out if no volumes
    if (volumeParams.activeCount == 0u) {
        return vec4<f32>(0.0);
    }
    
    // Scene depth
    let sceneDepthValue = getSceneDepth(uv);
    let near = 1.0;
    let far = params.planetRadius * 3.0;
    let linearDepth = linearizeDepth(sceneDepthValue, near, far);
    
    // Find closest volumetric hit
    let volumeHit = findClosestVolumetricHit(rayOrigin, rayDir, linearDepth);
    
    if (volumeHit.volumeIndex < 0) {
        return vec4<f32>(0.0);
    }
    
    let volume = volumeParams.volumes[volumeHit.volumeIndex];
    let tNear = volumeHit.tNear;
    let tFar = volumeHit.tFar;
    let lodBlend = volumeHit.lodBlend;
    
    // Planet intersection check
    let planetHit = cloudRayPlanetIntersect(rayOrigin, rayDir, params.planetCenter, params.planetRadius);
    var marchEnd = tFar;
    if (planetHit > 0.0 && planetHit < marchEnd) {
        if (planetHit < tNear) { return vec4<f32>(0.0); }
        marchEnd = planetHit;
    }
    
    let marchDist = marchEnd - tNear;
    if (marchDist < 1.0) { return vec4<f32>(0.0); }
    
    // Adaptive step count - more steps for closer, larger volumes
    let volumeSize = max(volume.radiusH, volume.radiusV);
    let tierA = max(params.volumeTierAMaxDist, 1.0);
    let distFactor = clamp(1.0 - (tNear / tierA), 0.5, 1.0);
    let stepCount = u32(clamp(marchDist / volumeSize * 24.0 * distFactor, 32.0, f32(VOL_MAX_STEPS)));
    let baseStepSize = marchDist / f32(stepCount);
    
    // Dithered start for temporal stability
    let frameOffset = vec2<f32>(
        f32(u32(params.frameIndex) % 4u) * 2.0,
        f32(u32(params.frameIndex) / 4u % 4u) * 2.0
    );
    let dither = bayer8(uv * vec2<f32>(params.viewportWidth, params.viewportHeight) + frameOffset);
    var t = tNear + baseStepSize * dither;
    
    // Raymarch state
    var transmittance = 1.0;
    var color = vec3<f32>(0.0);
    var foundCloud = false;
    var firstHitT = marchEnd;
    var inCloud = false;
    var emptySteps = 0u;
    
    // Phase function
    let cosAngle = dot(rayDir, sunDir);
    let phase = cloudDualLobePhase(cosAngle, params.cloudAnisotropy);
    
    // Ambient colors
    let ambientTop = vec3<f32>(0.85, 0.92, 1.05);
    let ambientBottom = vec3<f32>(0.5, 0.55, 0.62);
    
    // Adaptive stepping
    let smallStep = baseStepSize;
    let largeStep = baseStepSize * 3.0;
    
    // Raymarch loop
    for (var i = 0u; i < stepCount; i++) {
        if (t >= marchEnd) { break; }
        if (transmittance < 0.01) { break; }
        
        let pos = rayOrigin + rayDir * t;
        let density = sampleVolumetricDensity(pos, volume, sunDir);
        
        // Soft edge detection for adaptive stepping
        let edgeMask = cloudSmoothstep(0.005, 0.02, density);
        let currentStep = mix(largeStep, smallStep, edgeMask);
        
        if (density > 0.003) {
            // Refinement step when entering cloud
            if (!inCloud && !foundCloud) {
                t = max(tNear, t - currentStep * 0.5);
                inCloud = true;
                emptySteps = 0u;
                continue;
            }
            
            inCloud = true;
            emptySteps = 0u;
            
            if (!foundCloud) {
                foundCloud = true;
                firstHitT = t;
            }
            
            // Extinction
            let extinction = params.layerLow_extinction;
            let sigmaE = density * extinction;
            let sampleTrans = exp(-sigmaE * currentStep);
            
            // High-quality lighting
            let lightEnergy = sampleVolumetricLight(pos, sunDir, volume);
            
            // Height-based ambient
            let localPos = pos - volume.center;
            let heightFrac = clamp((localPos.y / volume.radiusV + 1.0) * 0.5, 0.0, 1.0);
            let ambient = mix(ambientBottom, ambientTop, heightFrac);
            
            // Combined lighting
            let albedo = params.layerLow_albedo;
            let phaseMod = mix(1.0, phase, 0.6);
            let direct = lightEnergy * phaseMod * albedo;
            
            let lightLuma = dot(lightEnergy, vec3<f32>(0.299, 0.587, 0.114));
            let ambientOcc = mix(0.55, 1.0, lightLuma);
            let ambientLight = ambient * 0.7 * ambientOcc * albedo;
            
            let totalLight = direct + ambientLight;
            
            // Accumulate
            let opacity = (1.0 - sampleTrans) * edgeMask;
            color += transmittance * totalLight * opacity;
            transmittance *= sampleTrans;
            
        } else {
            if (inCloud) {
                emptySteps++;
                if (emptySteps > 2u) { inCloud = false; }
            }
        }
        
        t += currentStep;
    }
    
    var alpha = 1.0 - transmittance;
    
    // Apply lodBlend - fade out as we transition to proxy
    // lodBlend=0: full volumetric (this pass contributes full alpha)
    // lodBlend=1: full proxy (this pass contributes 0)
    let volumetricWeight = 1.0 - lodBlend;
    alpha *= volumetricWeight;
    color *= volumetricWeight;
    
    // Contrast enhancement for close clouds
    alpha = pow(alpha, 1.1);
    
    // Apply aerial perspective
    if (alpha > 0.001 && foundCloud) {
        let cloudPos = rayOrigin + rayDir * firstHitT;
        let apResult = ap_computeSimple(
            transmittanceLUT, noiseSamplerClamp,
            cloudPos, rayOrigin, sunDir,
            params.planetCenter, params.planetRadius, atmo.atmosphereRadius,
            atmo.scaleHeightRayleigh, atmo.scaleHeightMie,
            atmo.rayleighScattering, atmo.mieScattering,
            atmo.mieAnisotropy, params.sunIntensity
        );
        
        let apDist = length(cloudPos - rayOrigin);
        let apBlend = 1.0 - exp(-apDist * 0.00003);
        
        color = ap_applyWithBlend(color, apResult, apBlend * 0.35);
        alpha *= (1.0 - apBlend * 0.15);
    }
    
    // Soft edge cleanup
    let edgeFade = cloudSmoothstep(0.002, 0.06, alpha);
    color *= edgeFade;
    alpha *= edgeFade;
    
    return vec4<f32>(color, alpha);
}
        `;
    }
    
    dispose() {
        this.material = null;
        this.fullscreenGeometry = null;
        this.initialized = false;
    }
}
