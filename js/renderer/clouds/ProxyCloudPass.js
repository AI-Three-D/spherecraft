// js/renderer/clouds/ProxyCloudPass.js
// Proxy cloud rendering pass for medium-distance volumes
// Uses simplified raymarching with volume-constrained bounds

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { getCloudCommonWGSL, CLOUD_VOLUME_STRUCTS_WGSL } from './shaders/cloudCommon.wgsl.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

export class ProxyCloudPass {
    constructor(backend, config = {}) {
        this.backend = backend;
        this.enabled = true;
        this.initialized = false;
        
        // Configuration
        this.config = {
            maxSteps: config.maxSteps ?? 32,
            shadowSteps: config.shadowSteps ?? 3,
            minLodBlend: config.minLodBlend ?? 0.0,  // Start rendering when lodBlend >= this
            maxLodBlend: config.maxLodBlend ?? 1.0,  // Full proxy when lodBlend >= this
        };
        
        this.material = null;
        this.fullscreenGeometry = null;
        
        // Shared resources (set by parent renderer)
        this._volumeParamsBuffer = null;
        this._noiseTextures = {};
        this._uniformBuffers = {};
    }
    
    async initialize() {
        if (this.initialized) return;
        
        // Create fullscreen triangle geometry
        this.fullscreenGeometry = this._createFullscreenTriangle();
        
        // Create proxy material
        this.material = new Material({
            name: 'ProxyCloudPass',
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'ProxyUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'matrixUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'cloudParams' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'atmosphereParams' },
                        { binding: 3, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'volumeParams' }
                    ]
                },
                {
                    label: 'ProxyTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseBase' },
                        { binding: 1, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseDetail' },
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseErosion' },
                        { binding: 3, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerRepeat' },
                        { binding: 4, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerClamp' },
                        { binding: 5, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'transmittanceLUT' },
                        { binding: 6, visibility: 'fragment', texture: { sampleType: 'depth', viewDimension: '2d' }, name: 'sceneDepthTexture' }
                    ]
                }
            ],
            uniforms: {
                matrixUniforms: { value: null },  // Shared from main renderer
                cloudParams: { value: null },      // Shared from main renderer
                atmosphereParams: { value: null }, // Shared from main renderer
                volumeParams: { value: null },     // Volume params buffer
                noiseBase: { value: null },
                noiseDetail: { value: null },
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
        // FIX: Pass the Float32Array data, not just the GPUBuffer reference
        if (resources.volumeParamsData) {
            this.material.uniforms.volumeParams.value = resources.volumeParamsData;
        }
        if (resources.noiseBase) {
            this.material.uniforms.noiseBase.value = resources.noiseBase;
        }
        if (resources.noiseDetail) {
            this.material.uniforms.noiseDetail.value = resources.noiseDetail;
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
    /**
     * Update pass state
     */
    update(volumeSelector) {
        if (!this.initialized || !this.enabled) return;
        
        // Check if we have any active volumes that need proxy rendering
        const activeCount = volumeSelector?.getActiveCount() ?? 0;
        if (activeCount === 0) {
            this._hasWork = false;
            return;
        }
        
        // Check if any volumes have lodBlend > minLodBlend (need proxy rendering)
        const volumeBuffer = volumeSelector.getVolumeBuffer();
        let needsProxy = false;
        
        for (let i = 0; i < activeCount; i++) {
            const lodBlend = volumeBuffer[i * 16 + 7]; // lodBlend is at offset 7
            if (lodBlend >= this.config.minLodBlend) {
                needsProxy = true;
                break;
            }
        }
        
        this._hasWork = needsProxy;
    }
    
    /**
     * Render the proxy pass
     */
    render(backend) {
        if (!this.initialized || !this.enabled || !this._hasWork) return;
        if (!this.material.uniforms.noiseBase.value) return;
        
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
// PROXY CLOUD PASS - Medium distance volume rendering
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

    // Layer parameters (simplified - we mainly use low layer for proxy)
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

@group(1) @binding(0) var noiseBase: texture_3d<f32>;
@group(1) @binding(1) var noiseDetail: texture_3d<f32>;
@group(1) @binding(2) var noiseErosion: texture_3d<f32>;
@group(1) @binding(3) var noiseSamplerRepeat: sampler;
@group(1) @binding(4) var noiseSamplerClamp: sampler;
@group(1) @binding(5) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(6) var sceneDepthTexture: texture_depth_2d;

const PI: f32 = 3.14159265359;
const PROXY_MAX_STEPS: u32 = 32u;
const PROXY_LIGHT_STEPS: u32 = 3u;
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

fn bayer4(p: vec2<f32>) -> f32 {
    let x = u32(p.x) % 4u;
    let y = u32(p.y) % 4u;
    var m = array<u32, 16>(
        0u, 8u, 2u, 10u,
        12u, 4u, 14u, 6u,
        3u, 11u, 1u, 9u,
        15u, 7u, 13u, 5u
    );
    return f32(m[y * 4u + x]) / 16.0;
}

// ----------------------------------------------------------------------------
// Volume Intersection
// ----------------------------------------------------------------------------

struct VolumeHit {
    volumeIndex: i32,
    tNear: f32,
    tFar: f32,
    lodBlend: f32,
};

fn findClosestVolumeHit(ro: vec3<f32>, rd: vec3<f32>, maxT: f32) -> VolumeHit {
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
// Simplified Density Sampling for Proxy
// ----------------------------------------------------------------------------

fn sampleNoise3D(tex: texture_3d<f32>, coord: vec3<f32>, lod: f32) -> vec4<f32> {
    return textureSampleLevel(tex, noiseSamplerRepeat, fract(coord), lod);
}

fn getLocalCoord(worldPos: vec3<f32>, tileSize: f32) -> vec3<f32> {
    let rel = worldPos - params.planetCenter;
    return rel / tileSize;
}

fn sampleProxyDensity(worldPos: vec3<f32>, volume: VolumeDesc) -> f32 {
    // Local position within volume
    let localPos = worldPos - volume.center;
    let normalizedPos = vec3<f32>(
        localPos.x / volume.radiusH,
        localPos.y / volume.radiusV,
        localPos.z / volume.radiusH
    );
    
    // Distance from center (for shape falloff)
    let distFromCenter = length(normalizedPos);
    if (distFromCenter > 1.0) { return 0.0; }
    
    // Height fraction within volume
    let heightFrac = (normalizedPos.y + 1.0) * 0.5; // -1..1 -> 0..1
    
    // Volume profile (cumulus, fog, etc)
    let profile = cloudGetVolumeProfile(heightFrac, volume.fogType, localPos);
    
    // Wind animation
    let windOffset = vec3<f32>(params.windOffsetX, 0.0, params.windOffsetY);
    let animPos = worldPos - windOffset;
    
    // Sample base noise (coarse, fast)
    let baseCoord = getLocalCoord(animPos, params.baseTileSize * 0.5);
    let baseSample = sampleNoise3D(noiseBase, baseCoord, 1.0);
    
    // Combined base shape
    let combinedBase = mix(baseSample.r, baseSample.g, 0.4);
    
    // Coverage threshold with volume's local coverage
    let effCoverage = clamp(volume.coverageLocal * params.layerLow_coverage * 1.5, 0.0, 1.0);
    let threshold = 1.0 - effCoverage;
    
    var shape = smoothstep(threshold, threshold + 0.3, combinedBase);
    
    // Apply profile and edge falloff
    let edgeFalloff = 1.0 - smoothstep(0.7, 1.0, distFromCenter);
    shape *= profile * edgeFalloff * volume.densityMult;
    
    // Quick detail pass (optional, for slightly better quality)
    if (shape > 0.05) {
        let detailCoord = getLocalCoord(animPos, params.detailTileSize * 0.5);
        let detailSample = sampleNoise3D(noiseDetail, detailCoord, 1.5);
        shape *= 0.8 + detailSample.r * 0.4;
    }
    
    return max(0.0, shape);
}

// ----------------------------------------------------------------------------
// Simplified Light Sampling for Proxy
// ----------------------------------------------------------------------------

fn sampleProxyLight(worldPos: vec3<f32>, sunDir: vec3<f32>, volume: VolumeDesc) -> vec3<f32> {
    let stepSize = volume.radiusV * 0.5;
    
    var opticalDepth = 0.0;
    for (var i = 0u; i < PROXY_LIGHT_STEPS; i++) {
        let t = (f32(i) + 0.5) * stepSize;
        let samplePos = worldPos + sunDir * t;
        let density = sampleProxyDensity(samplePos, volume);
        opticalDepth += density * stepSize;
    }
    
    // Atmospheric transmittance
    let altitude = length(worldPos - params.planetCenter) - params.planetRadius;
    let up = normalize(worldPos - params.planetCenter);
    let sunZenith = dot(up, sunDir);
    let sunTrans = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, altitude, sunZenith, params.planetRadius, atmo.atmosphereRadius);
    
    // Beer-Lambert with powder term
    let absorptionCoeff = 0.02;
    let beer = exp(-opticalDepth * absorptionCoeff);
    let powder = 1.0 - exp(-opticalDepth * absorptionCoeff * 2.0);
    let lightIntensity = mix(beer, powder * 0.4 + beer * 0.6, 0.3);
    
    return sunTrans * lightIntensity;
}

// ----------------------------------------------------------------------------
// Main Fragment
// ----------------------------------------------------------------------------

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rayDir = getRayDirection(uv);
    let rayOrigin = matrices.cameraPosition;
    let sunDir = normalize(vec3<f32>(params.sunDirX, params.sunDirY, params.sunDirZ));
    
    // Early out if no active volumes
    if (volumeParams.activeCount == 0u) {
        return vec4<f32>(0.0);
    }
    
    // Scene depth for occlusion
    let sceneDepthValue = getSceneDepth(uv);
    let near = 1.0;
    let far = params.planetRadius * 3.0;
    let linearDepth = linearizeDepth(sceneDepthValue, near, far);
    
    // Find closest volume hit
    let volumeHit = findClosestVolumeHit(rayOrigin, rayDir, linearDepth);
    
    if (volumeHit.volumeIndex < 0) {
        return vec4<f32>(0.0);
    }
    
    let volume = volumeParams.volumes[volumeHit.volumeIndex];
    let tNear = volumeHit.tNear;
    let tFar = volumeHit.tFar;
    let lodBlend = volumeHit.lodBlend;
    
    // Check for planet intersection
    let planetHit = cloudRayPlanetIntersect(rayOrigin, rayDir, params.planetCenter, params.planetRadius);
    var marchEnd = tFar;
    if (planetHit > 0.0 && planetHit < marchEnd) {
        if (planetHit < tNear) { return vec4<f32>(0.0); }
        marchEnd = planetHit;
    }
    
    let marchDist = marchEnd - tNear;
    if (marchDist < 1.0) { return vec4<f32>(0.0); }
    
    // Adaptive step count based on volume size
    let volumeSize = max(volume.radiusH, volume.radiusV);
    let stepCount = u32(clamp(marchDist / volumeSize * 16.0, 12.0, f32(PROXY_MAX_STEPS)));
    let stepSize = marchDist / f32(stepCount);
    
    // Dithered start
    let dither = bayer4(uv * vec2<f32>(params.viewportWidth, params.viewportHeight));
    var t = tNear + stepSize * dither;
    
    // Raymarch state
    var transmittance = 1.0;
    var color = vec3<f32>(0.0);
    var foundCloud = false;
    var firstHitT = marchEnd;
    
    // Phase function
    let cosAngle = dot(rayDir, sunDir);
    let phase = cloudDualLobePhase(cosAngle, params.cloudAnisotropy);
    
    // Ambient colors
    let ambientTop = vec3<f32>(0.8, 0.85, 0.95);
    let ambientBottom = vec3<f32>(0.5, 0.55, 0.62);
    
    // Raymarch loop
    for (var i = 0u; i < stepCount; i++) {
        if (t >= marchEnd) { break; }
        if (transmittance < 0.02) { break; }
        
        let pos = rayOrigin + rayDir * t;
        let density = sampleProxyDensity(pos, volume);
        
        if (density > 0.005) {
            if (!foundCloud) {
                foundCloud = true;
                firstHitT = t;
            }
            
            // Extinction
            let extinction = params.layerLow_extinction * 0.8; // Slightly softer for proxy
            let sigmaE = density * extinction;
            let sampleTrans = exp(-sigmaE * stepSize);
            
            // Lighting
            let lightEnergy = sampleProxyLight(pos, sunDir, volume);
            
            // Height-based ambient
            let localHeight = (pos.y - volume.center.y) / volume.radiusV;
            let heightFrac = clamp((localHeight + 1.0) * 0.5, 0.0, 1.0);
            let ambient = mix(ambientBottom, ambientTop, heightFrac);
            
            // Combined lighting
            let albedo = params.layerLow_albedo;
            let direct = lightEnergy * phase * albedo;
            let ambientLight = ambient * 0.6 * albedo;
            let totalLight = direct + ambientLight;
            
            // Accumulate
            let opacity = 1.0 - sampleTrans;
            color += transmittance * totalLight * opacity;
            transmittance *= sampleTrans;
        }
        
        t += stepSize;
    }
    
    var alpha = 1.0 - transmittance;
    
    // Apply lodBlend - fade in as we transition from volumetric to proxy
    // lodBlend=0: fully volumetric (this pass contributes 0)
    // lodBlend=1: fully proxy (this pass contributes full alpha)
    alpha *= lodBlend;
    color *= lodBlend;
    
    // Distance fade
    if (foundCloud) {
        let cloudDist = firstHitT;
        var fadeStart = params.volumeFadeStart;
        var fadeEnd = params.volumeFadeEnd;
        if (fadeEnd <= fadeStart + 1.0) {
            fadeEnd = max(params.volumeTierBMaxDist, 30000.0);
            fadeStart = fadeEnd * 0.6;
        }
        let distFade = 1.0 - smoothstep(fadeStart, fadeEnd, cloudDist);
        alpha *= distFade;
        color *= distFade;
    }
    
    // Apply aerial perspective for distant proxy clouds
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
        let apBlend = 1.0 - exp(-apDist * 0.00004);
        
        color = ap_applyWithBlend(color, apResult, apBlend * 0.4);
        alpha *= (1.0 - apBlend * 0.2);
    }
    
    // Soft edge cleanup
    let edgeFade = smoothstep(0.002, 0.05, alpha);
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
