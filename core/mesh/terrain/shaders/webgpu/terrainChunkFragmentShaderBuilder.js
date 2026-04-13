// js/mesh/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js

import { getAerialPerspectiveWGSL } from '../../../../renderer/atmosphere/shaders/aerialPerspectiveCommon.js';
import { getProceduralDetailWGSL } from './prroceduralDetailNoise.wgsl.js';
import { getClusteredLightingWGSL } from '../../../../lighting/shaders/clusteredLighting.wgsl.js';

const blendModeBlock = /* wgsl */`
// ============================================================================
// Blend mode + break style constants
// (Must match BLEND_MODES / BREAK_STYLES in tileTransitionTableBuilder.js)
// ============================================================================

const BREAK_NONE:         i32 = 0;
const BREAK_SMOOTH_CURVE: i32 = 1;
const BREAK_UNEVEN:       i32 = 2;
const BREAK_STREAKY:      i32 = 3;
const BREAK_TURBULENT:    i32 = 4;


// ============================================================================
// Transition parameter lookup
// ============================================================================


struct TransitionParams {
    mode:          i32,
    breakStyle:    i32,
    breakStrength: f32,
}

fn lookupTransitionParams(tileId1: f32, tileId2: f32) -> TransitionParams {
    let t1 = clamp(i32(round(tileId1)), 0, 255);
    let t2 = clamp(i32(round(tileId2)), 0, 255);
    let s  = textureLoad(blendModeTable, vec2<i32>(t1, t2), 0);
    var p: TransitionParams;
    p.mode          = i32(round(s.r * 255.0));
    p.breakStyle    = i32(round(s.g * 255.0));
    p.breakStrength = s.b;
    return p;
}


// ============================================================================
// Per-material noise
//
// Called separately for material 1 (seed 0.31) and material 2 (seed 0.71).
// The different seeds produce fully independent noise fields so each material
// can extend its territory independently — this is what creates genuine
// protrusions rather than edge-parallel slices.
// ============================================================================

fn materialNoise(worldPos: vec2<f32>, style: i32, seed: f32) -> f32 {
    // Fold seed into a stable 2-D offset. Different seeds → different fields.
    let s = vec2<f32>(
        fract(seed * 127.1 + 0.5) * 91.0 + 7.0,
        fract(seed * 311.7 + 0.5) * 91.0 + 13.0
    );

    if (style == BREAK_SMOOTH_CURVE) {
        // Very low-frequency, gently curving patches.
        let n0 = edgeNoise(worldPos * 0.045 + s);
        let n1 = edgeNoise(worldPos * 0.095 + s * 1.73);
        return n0 * 0.78 + n1 * 0.22;
    }

    if (style == BREAK_UNEVEN) {
        // Multi-octave blobs with some mid/high-frequency roughness.
        let n0 = edgeNoise(worldPos * 0.12 + s);
        let n1 = edgeNoise(worldPos * 0.31 + s * 1.57);
        let n2 = edgeNoise(worldPos * 0.68 + s * 2.31);
        let n3 = edgeNoise(worldPos * 1.25 + s * 3.09);
        return n0 * 0.52 + n1 * 0.25 + n2 * 0.15 + n3 * 0.08;
    }

    if (style == BREAK_STREAKY) {
        // Anisotropic: long bands with a slight orientation offset per seed.
        let angle = seed * 6.2831853;
        let c = cos(angle);
        let ss = sin(angle);
        let rot = vec2<f32>(
            worldPos.x * c  - worldPos.y * ss,
            worldPos.x * ss + worldPos.y * c
        );
        let q = rot * vec2<f32>(0.05, 0.28) + s;
        let n0 = edgeNoise(q);
        let n1 = edgeNoise(q * vec2<f32>(1.0, 2.4) + s * 0.73);
        let n2 = edgeNoise(q * vec2<f32>(0.35, 3.1) + s * 1.11);
        return n0 * 0.60 + n1 * 0.25 + n2 * 0.15;
    }

    if (style == BREAK_TURBULENT) {
        // Domain warp to fold edges back on themselves (fault-like cuts).
        let warpScale = 7.0;
        let wx = (edgeNoise(worldPos * 0.09 + s)               - 0.5) * warpScale;
        let wy = (edgeNoise(worldPos * 0.09 + s + vec2<f32>(7.3, 3.1)) - 0.5) * warpScale;
        let warped = worldPos + vec2<f32>(wx, wy);
        let n0 = edgeNoise(warped * 0.16 + s * 1.41);
        let n1 = edgeNoise(warped * 0.33 + s * 2.07);
        return n0 * 0.68 + n1 * 0.32;
    }

    // BREAK_NONE — neutral (no territory extension for either material)
    return 0.5;
}

// ============================================================================
// Blend mode lookup
// ============================================================================

/// Returns the blend mode integer for a given tile-type pair.
/// Symmetric: lookupBlendMode(a,b) == lookupBlendMode(b,a).
/// Default (all-zero table) returns BLEND_SOFT.
fn lookupBlendMode(tileId1: f32, tileId2: f32) -> i32 {
    let t1 = clamp(i32(round(tileId1)), 0, 255);
    let t2 = clamp(i32(round(tileId2)), 0, 255);
    let s = textureLoad(blendModeTable, vec2<i32>(t1, t2), 0);
    return i32(round(s.r * 255.0));
}

fn lookupLayerHeight(tileId: f32) -> f32 {
    let _t = clamp(i32(round(tileId)), 0, 255);
    return 0.0;
}
// ============================================================================
// Smooth value noise  (C1-continuous — avoids derivative discontinuities)
// ============================================================================


fn edgeNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash12(i),                        hash12(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash12(i + vec2<f32>(0.0, 1.0)), hash12(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}
// ============================================================================
// Break style implementations
//
// Each returns a value in [0, 1] representing the local noise field at
// worldPos for the chosen style.  The caller maps this to a signed offset:
//   breakOffset = (n - 0.5) * breakStrength
// which is then added to the normalised blend position t = w1/(w1+w2).
// ============================================================================

/// BREAK_SMOOTH_CURVE
/// Single low-frequency octave.  The boundary follows gently sweeping
/// arcs with no abrupt corners.  Appropriate for biome-scale gradients
/// (snow, tundra, forest edge).
fn breakSmoothCurve(worldPos: vec2<f32>) -> f32 {
    return edgeNoise(worldPos * 0.07 + vec2<f32>(7.3, 2.1));
}

/// BREAK_UNEVEN
/// Three octaves at medium frequencies with strongly unequal weights.
/// The dominant octave drives large blobs; the finer ones roughen their
/// edges into irregular protrusions.  Good for organic material boundaries
/// (grass patches on bare earth, marshy ground, clumped forest floor).
fn breakUneven(worldPos: vec2<f32>) -> f32 {
    let n0 = edgeNoise(worldPos * 0.13 + vec2<f32>( 3.7, 11.3));
    let n1 = edgeNoise(worldPos * 0.34 + vec2<f32>(17.1,  5.9));
    let n2 = edgeNoise(worldPos * 0.79 + vec2<f32>(29.3, 41.7));
    return n0 * 0.55 + n1 * 0.30 + n2 * 0.15;
}

/// BREAK_STREAKY
/// Anisotropic: the sample grid is compressed on Y and stretched on X,
/// then a second harmonic adds fine cross-fibre texture.
/// Produces bands / veins / strata running roughly along one world axis.
/// Appropriate for geological layering, wind-blown sand, lava flow channels.
fn breakStreaky(worldPos: vec2<f32>) -> f32 {
    let p  = worldPos * vec2<f32>(0.035, 0.27);
    let n0 = edgeNoise(p                       + vec2<f32>( 5.3, 0.7));
    let n1 = edgeNoise(p * vec2<f32>(2.8, 1.9) + vec2<f32>(11.9, 3.1));
    return n0 * 0.68 + n1 * 0.32;
}

/// BREAK_TURBULENT
/// Domain-warped noise: a secondary noise field displaces the sample
/// coordinate before the primary evaluation, folding the boundary back
/// on itself.  The warp magnitude scales with breakStrength so the effect
/// is subtle at low strength and dramatic at high strength.
/// Appropriate for geological faults, magma intrusions, violent contact zones.
fn breakTurbulent(worldPos: vec2<f32>, strength: f32) -> f32 {
    let warpMag = strength * 6.0;
    let wx = (edgeNoise(worldPos * 0.10 + vec2<f32>(1.7, 9.2)) - 0.5) * warpMag;
    let wy = (edgeNoise(worldPos * 0.10 + vec2<f32>(8.3, 2.4)) - 0.5) * warpMag;
    return edgeNoise((worldPos + vec2<f32>(wx, wy)) * 0.14 + vec2<f32>(3.1, 7.6));
}

/// Compute the signed offset that is added to the blend position t.
/// Returns 0 when style == BREAK_NONE or strength < epsilon.
/// The raw noise value n is mapped from [0,1] to [-0.5, 0.5] and then
/// scaled by breakStrength so that at strength=1 the boundary can shift
/// up to ±0.5 in normalised weight space.
fn computeBreakOffset(worldPos: vec2<f32>, style: i32, strength: f32) -> f32 {
    if (style == BREAK_NONE || strength < 0.001) { return 0.0; }

    var n: f32;
    if (style == BREAK_SMOOTH_CURVE) {
        n = breakSmoothCurve(worldPos);
    } else if (style == BREAK_UNEVEN) {
        n = breakUneven(worldPos);
    } else if (style == BREAK_STREAKY) {
        n = breakStreaky(worldPos);
    } else {
        // BREAK_TURBULENT (default for any unknown style)
        n = breakTurbulent(worldPos, strength);
    }

    return (n - 0.5) * strength;
}

// ============================================================================
// Blend mode implementations
// Each receives the pre-computed breakOffset from computeBreakOffset.
// ============================================================================

const SEED_MAT1: f32 = 0.31;
const SEED_MAT2: f32 = 0.71;

fn edgeMaskFromWeights(w1: f32, w2: f32) -> f32 {
    // 0 at interior, 1 at the boundary (w1 ≈ w2).
    let d = abs(w1 - w2);
    return 1.0 - smoothstep(0.18, 0.60, d);
}

fn computeHeights(
    w1: f32, w2: f32,
    worldPos: vec2<f32>,
    style: i32, strength: f32
) -> vec2<f32> {
    if (style == BREAK_NONE || strength < 0.001) {
        return vec2<f32>(w1, w2);
    }
    let edge = edgeMaskFromWeights(w1, w2);
    let amp = strength * edge;
    let n1 = materialNoise(worldPos, style, SEED_MAT1);
    let n2 = materialNoise(worldPos, style, SEED_MAT2);
    return vec2<f32>(
        w1 + (n1 - 0.5) * amp,
        w2 + (n2 - 0.5) * amp
    );
}
 // ── blend_soft ────────────────────────────────────────────────────────────────
// Wide crossing band: [-0.35, +0.35] in height-difference space.
// The boundary is noise-modulated; across it the transition is gradual.
// At strength = 0, this is a clean smooth gradient.
fn applyBlendSoft(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    worldPos: vec2<f32>, style: i32, strength: f32
) -> vec4<f32> {
    let h    = computeHeights(w1, w2, worldPos, style, strength);
    let d    = h.x - h.y;
    // Visible crossing band ≈ 0.70 in h-space. Produces clearly visible
    // gradients even when the underlying splat boundary is narrow.
    let t    = smoothstep(-0.35, 0.35, d);
    return vec4<f32>(mix(color2.rgb, color1.rgb, t), max(color1.a, color2.a));
}

// ── blend_hard ────────────────────────────────────────────────────────────────
// Narrow crossing band: [-0.06, +0.06] in height-difference space.
// The boundary is noise-modulated; across it the transition is sharp.
// Visually distinct from blend_soft: materials stay nearly pure up to the edge.
fn applyBlendHard(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    worldPos: vec2<f32>, style: i32, strength: f32
) -> vec4<f32> {
    let h    = computeHeights(w1, w2, worldPos, style, strength);
    let d    = h.x - h.y;
    let t    = smoothstep(-0.06, 0.06, d);
    return vec4<f32>(mix(color2.rgb, color1.rgb, t), max(color1.a, color2.a));
}

// ── step_overlay ──────────────────────────────────────────────────────────────
// Height-priority blend. Per-tile layer heights bias the competition so the
// "taller" material dominates at boundary edges, creating a visible lip.
// Noise independently shifts each material's height before the priority calc.
fn applyStepOverlay(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    tileId1: f32, tileId2: f32,
    worldPos: vec2<f32>, style: i32, strength: f32
) -> vec4<f32> {
    let lh1 = lookupLayerHeight(tileId1);
    let lh2 = lookupLayerHeight(tileId2);
    let h   = computeHeights(w1, w2, worldPos, style, strength);
    // Add the physical layer height on top of the noise-modulated weight.
    let hb1 = h.x + lh1;
    let hb2 = h.y + lh2;
    // OVERLAP: controls how wide the lip transition is.
    // Smaller → sharper lip. 0.2 is a good starting point.
    let OVERLAP = 0.2;
    let ma  = max(hb1, hb2) - OVERLAP;
    let a1  = max(hb1 - ma, 0.0);
    let a2  = max(hb2 - ma, 0.0);
    let den = max(a1 + a2, 0.0001);
    let out = color1 * (a1 / den) + color2 * (a2 / den);
    return vec4<f32>(out.rgb, max(color1.a, color2.a));
}
// ── Dispatcher ────────────────────────────────────────────────────────────────
fn blendTileColors(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    tileId1: f32, tileId2: f32,
    worldPos: vec2<f32>
) -> vec4<f32> {
    let p = lookupTransitionParams(tileId1, tileId2);

    if (p.mode == BLEND_HARD) {
        return applyBlendHard(
            color1, color2, w1, w2,
            worldPos, p.breakStyle, p.breakStrength
        );
    }
    if (p.mode == STEP_OVERLAY) {
        return applyStepOverlay(
            color1, color2, w1, w2, tileId1, tileId2,
            worldPos, p.breakStyle, p.breakStrength
        );
    }
    return applyBlendSoft(
        color1, color2, w1, w2,
        worldPos, p.breakStyle, p.breakStrength
    );
}
`;
const blendModeBlockSimple = /* wgsl */`
fn blendTileColorsSimple(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32
) -> vec4<f32> {
    let total = max(w1 + w2, 0.0001);
    let tRaw = w1 / total;
    let t = smoothstep(0.35, 0.65, tRaw);
    return vec4<f32>(mix(color2.rgb, color1.rgb, t), max(color1.a, color2.a));
}
`;
const shadowBindings = `
@group(3) @binding(5)  var shadowCascade0: texture_depth_2d;
@group(3) @binding(6)  var shadowCascade1: texture_depth_2d;
@group(3) @binding(9)  var shadowCascade2: texture_depth_2d;
@group(3) @binding(10) var shadowSampler:  sampler_comparison;

struct ShadowUniforms {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    splits:     vec4<f32>,   // [split0, split1, split2, 0]
    params:     vec4<f32>,   // [bias, normalBias, mapSize, enabled]
}
@group(3) @binding(11) var<uniform> shadowUniforms: ShadowUniforms;
`;

const shadowSamplingCode = `
// ────────────────────────────────────────────────────────────────────
// Cascaded Shadow Map Sampling
// ────────────────────────────────────────────────────────────────────

fn getShadowCascadeVP(cascade: i32) -> mat4x4<f32> {
    if (cascade == 0) { return shadowUniforms.cascadeVP0; }
    if (cascade == 1) { return shadowUniforms.cascadeVP1; }
    return shadowUniforms.cascadeVP2;
}

fn sampleShadowMap(cascade: i32, uv: vec2<f32>, compareDepth: f32) -> f32 {
    let s0 = textureSampleCompare(shadowCascade0, shadowSampler, uv, compareDepth);
    let s1 = textureSampleCompare(shadowCascade1, shadowSampler, uv, compareDepth);
    let s2 = textureSampleCompare(shadowCascade2, shadowSampler, uv, compareDepth);
    return select(select(s2, s1, cascade == 1), s0, cascade == 0);
}
    fn sampleCascadePCF(
    cascade: i32,
    uv: vec2<f32>,
    compareDepth: f32,
    texelSize: f32
) -> f32 {
    if (SHADOW_MODE == 0) {
        return 1.0;
    }
    if (SHADOW_MODE == 1) {
        return sampleShadowMap(cascade, uv, compareDepth);
    }
    if (SHADOW_MODE == 2) {
        let offsets = array<vec2<f32>, 4>(
            vec2<f32>(-0.5, -0.5),
            vec2<f32>( 0.5, -0.5),
            vec2<f32>(-0.5,  0.5),
            vec2<f32>( 0.5,  0.5)
        );
        var sum: f32 = 0.0;
        for (var i = 0u; i < 4u; i++) {
            let sampleUV = uv + offsets[i] * texelSize;
            sum += sampleShadowMap(cascade, sampleUV, compareDepth);
        }
        return sum * 0.25;
    }

    // 9-tap PCF with Poisson-like distribution for smoother edges
    let offsets = array<vec2<f32>, 9>(
        vec2<f32>( 0.0,  0.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 0.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  0.0),
        vec2<f32>( 1.0,  0.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 0.0,  1.0),
        vec2<f32>( 1.0,  1.0)
    );
    
    // Weight center sample more heavily for sharper core, softer edges
    let weights = array<f32, 9>(
        0.25,  // center
        0.0625, 0.125, 0.0625,  // top row
        0.125,         0.125,   // middle sides
        0.0625, 0.125, 0.0625   // bottom row
    );

    var sum: f32 = 0.0;
    for (var i = 0u; i < 9u; i++) {
        let sampleUV = uv + offsets[i] * texelSize;
        sum += sampleShadowMap(cascade, sampleUV, compareDepth) * weights[i];
    }

    return sum;
}
    
fn computeShadow(worldPos: vec3<f32>, viewPos: vec3<f32>, worldNormal: vec3<f32>) -> f32 {
    if (SHADOW_MODE == 0) { return 1.0; }
    if (shadowUniforms.params.w < 0.5) { return 1.0; }

    // FIX: use view-space depth, not euclidean distance
    let viewZ = -viewPos.z;

    let bias       = shadowUniforms.params.x;
    let normalBias = shadowUniforms.params.y;
    let mapSize    = shadowUniforms.params.z;

    var cascadeIdx: i32 = 2;
    if (viewZ < shadowUniforms.splits.x) { cascadeIdx = 0; }
    else if (viewZ < shadowUniforms.splits.y) { cascadeIdx = 1; }

    var vp: mat4x4<f32> = shadowUniforms.cascadeVP2;
    if (cascadeIdx == 0) { vp = shadowUniforms.cascadeVP0; }
    else if (cascadeIdx == 1) { vp = shadowUniforms.cascadeVP1; }

    let biasedPos  = worldPos + worldNormal * normalBias;
    let shadowClip = vp * vec4<f32>(biasedPos, 1.0);
    let w          = max(abs(shadowClip.w), 0.0001);
    let shadowNDC  = shadowClip.xyz / w;

    let shadowUV_raw = shadowNDC.xy * 0.5 + 0.5;
    let uv           = vec2<f32>(shadowUV_raw.x, 1.0 - shadowUV_raw.y);
    let compareDepth = shadowNDC.z - bias;
    let texelSize    = 1.0 / mapSize;

    // FIX: check Z bounds as well as XY bounds
    let outOfBounds = uv.x < 0.0 || uv.x > 1.0
                   || uv.y < 0.0 || uv.y > 1.0
                   || shadowNDC.z < 0.0 || shadowNDC.z > 1.0;

    let shadow = sampleCascadePCF(cascadeIdx, uv, compareDepth, texelSize);
    let maskedShadow = select(shadow, 1.0, outOfBounds);

    let splitDist = select(
        select(shadowUniforms.splits.z, shadowUniforms.splits.y, cascadeIdx == 1),
        shadowUniforms.splits.x,
        cascadeIdx == 0
    );
    let fadeStart   = splitDist * 0.9;
    let cascadeFade = 1.0 - smoothstep(fadeStart, splitDist, viewZ);
    return mix(1.0, maskedShadow, max(cascadeFade, select(0.0, 1.0, cascadeIdx == 2)));
}
`;

export function buildTerrainChunkFragmentShader(options = {}) {
    if (!options.tileCategories) {
        throw new Error('buildTerrainChunkFragmentShader requires options.tileCategories');
    }
    const tileCategories = options.tileCategories;
    const normalTextureFilterable = options.normalTextureFilterable === true;

    const enableTerrainAO = options.enableTerrainAO !== false;
    const enableGroundField = options.enableGroundField === true;
    const maxLightIndices = options.maxLightIndices || 8192;
    const useArrayTextures = options.useArrayTextures === true;
    const aerialPerspectiveCode = getAerialPerspectiveWGSL();
    const chunkTextureType = useArrayTextures ? 'texture_2d_array<f32>' : 'texture_2d<f32>';
    const debugMode =  Number.isFinite(options.debugMode) ? Math.floor(options.debugMode) : 0;
    const lod = Number.isFinite(options.lod) ? Math.max(0, Math.floor(options.lod)) : 0;
    const terrainShaderConfig = options.terrainShaderConfig || {};
    const fullMaxLod = Number.isFinite(terrainShaderConfig.fullMaxLOD)
        ? Math.max(0, Math.floor(terrainShaderConfig.fullMaxLOD))
        : 0;
    const nearMaxLod = Number.isFinite(terrainShaderConfig.nearMaxLOD)
        ? Math.max(fullMaxLod, Math.floor(terrainShaderConfig.nearMaxLOD))
        : 2;
    const midMaxLod = Number.isFinite(terrainShaderConfig.midMaxLOD)
        ? Math.max(nearMaxLod, Math.floor(terrainShaderConfig.midMaxLOD))
        : 4;
    const nearToMidFadeStartChunks = Number.isFinite(terrainShaderConfig.nearToMidFadeStartChunks)
        ? Math.max(0.0, terrainShaderConfig.nearToMidFadeStartChunks)
        : 2.5;
    const nearToMidFadeEndChunks = Number.isFinite(terrainShaderConfig.nearToMidFadeEndChunks)
        ? Math.max(nearToMidFadeStartChunks + 0.01, terrainShaderConfig.nearToMidFadeEndChunks)
        : 4.0;
    const pointSampleLodStart = Number.isFinite(terrainShaderConfig.pointSampleLodStart)
        ? Math.max(0, Math.floor(terrainShaderConfig.pointSampleLodStart))
        : 2;
    const macroStartLod = Number.isFinite(terrainShaderConfig.macroStartLod)
        ? Math.max(0, Math.floor(terrainShaderConfig.macroStartLod))
        : 2;
    const forceMacroOverlay = terrainShaderConfig.forceMacroOverlay === true;
    const clusteredMaxLod = Number.isFinite(terrainShaderConfig.clusteredMaxLod)
        ? Math.max(0, Math.floor(terrainShaderConfig.clusteredMaxLod))
        : 1;
    const aerialMaxLod = Number.isFinite(terrainShaderConfig.aerialMaxLod)
        ? Math.max(0, Math.floor(terrainShaderConfig.aerialMaxLod))
        : 2;
    const normalMapMaxLod = Number.isFinite(terrainShaderConfig.normalMapMaxLod)
        ? Math.max(-1, Math.floor(terrainShaderConfig.normalMapMaxLod))
        : 2;
    const altitudeNormalMinMeters = Number.isFinite(terrainShaderConfig.altitudeNormalMinMeters)
        ? Math.max(0, terrainShaderConfig.altitudeNormalMinMeters)
        : 8000;
    const altitudeShadowMinMeters = Number.isFinite(terrainShaderConfig.altitudeShadowMinMeters)
        ? Math.max(0, terrainShaderConfig.altitudeShadowMinMeters)
        : 12000;
    const shadowMaxLod = Number.isFinite(terrainShaderConfig.shadowMaxLod)
        ? Math.max(0, Math.floor(terrainShaderConfig.shadowMaxLod))
        : null;
    const useAdvancedBlend = false;
    const useVariantBlend = false;

    const useVariantRotation = false;//lod <= fullMaxLod;
    const enableSplat = lod <= nearMaxLod;
    const splatBlendMaxLod = Number.isFinite(terrainShaderConfig.splatBlendMaxLod)
    ? Math.max(0, Math.floor(terrainShaderConfig.splatBlendMaxLod))
    : 1;
    let splatTier = 0;
    if (enableSplat && lod <= splatBlendMaxLod) {
        splatTier = 2;
    } else if (enableSplat) {
        splatTier = 1;
    }
    const enableNearToMidFade = lod === nearMaxLod;
    const enableMacroOverlay = forceMacroOverlay || lod >= macroStartLod;
    const usePointSampling = false;//lod >= pointSampleLodStart;
    const enableClusteredLights = true;//lod <= clusteredMaxLod;
    const enableAerialPerspective = lod <= aerialMaxLod;
    const enablePointSplat = false;
    
    const enableNormalMap = lod <= normalMapMaxLod;
    const enableLighting = true;

    const apFadeStartMeters = Number.isFinite(terrainShaderConfig.aerialFadeStartMeters)
        ? Math.max(0, terrainShaderConfig.aerialFadeStartMeters)
        : 400;
    const apFadeEndMeters = Number.isFinite(terrainShaderConfig.aerialFadeEndMeters)
        ? Math.max(apFadeStartMeters + 1, terrainShaderConfig.aerialFadeEndMeters)
        : 500;
    let shadowMode = 0;
    if (lod == 0) {
        shadowMode = 3;
    } else if (lod == 1) {
        shadowMode = 2;
    } else if (lod == 2) {
        shadowMode = 1;
    }
    if (shadowMaxLod !== null && lod > shadowMaxLod) {
        shadowMode = 0;
    }
    const rawGrassIds = Array.isArray(options.grassTileTypeIds) ? options.grassTileTypeIds : [];
    const filteredGrassIds = rawGrassIds
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(-1, Math.min(255, Math.round(value))));
    const grassTileIds = filteredGrassIds.length > 0 ? filteredGrassIds : [-1];
    const grassTileCount = grassTileIds.length;
    let grassShadowStrength = 0.18;
    if (Number.isFinite(options.grassShadowStrength)) {
        grassShadowStrength = Math.min(1, Math.max(0, options.grassShadowStrength));
    }
    let terrainAOAmbientFloor = 0.65;
    if (Number.isFinite(options.terrainAOAmbientFloor)) {
        terrainAOAmbientFloor = Math.min(1, Math.max(0, options.terrainAOAmbientFloor));
    }
    let groundFieldTintStrength = 0.32;
    if (Number.isFinite(options.groundFieldTintStrength)) {
        groundFieldTintStrength = Math.min(1, Math.max(0, options.groundFieldTintStrength));
    }
    const normalizeTint = (value, fallback) => {
        if (!Array.isArray(value) || value.length < 3) return fallback;
        return value.slice(0, 3).map((v, i) => {
            const f = Number.isFinite(v) ? v : fallback[i];
            return Math.min(1, Math.max(0, f));
        });
    };
    const groundFieldGrassTint = normalizeTint(options.groundFieldGrassTint, [0.22, 0.33, 0.12]);
    const groundFieldFernTint = normalizeTint(options.groundFieldFernTint, [0.10, 0.24, 0.07]);
    const clusteredLightingCode = getClusteredLightingWGSL();
    const proceduralDetailCode = getProceduralDetailWGSL();
    const terrainAOBindingDecl = enableTerrainAO
        ? `@group(1) @binding(6) var terrainAOMask: ${chunkTextureType};`
        : '';
    const groundFieldBindingDecl = enableGroundField
        ? `@group(1) @binding(7) var groundFieldMask: ${chunkTextureType};`
        : '';
    const terrainAOCode = enableTerrainAO ? `
fn sampleTerrainAO(input: FragmentInput, layer: i32) -> f32 {
    let uv = applyChunkAtlasUV(
        input.vUv, terrainAOMask,
        input.vAtlasOffset, input.vAtlasScale
    );
    // r32float is unfilterable on most hardware — manual bilinear.
    // The mask is low-frequency so this is the only filter it needs.
    return clamp(sampleRGBA32FBilinear(terrainAOMask, uv, layer).r, 0.0, 1.0);
}
` : `
fn sampleTerrainAO(_input: FragmentInput, _layer: i32) -> f32 {
    return 1.0;
}
`;
    const groundFieldCode = enableGroundField ? `
fn sampleGroundField(input: FragmentInput, layer: i32) -> vec4<f32> {
    let uv = applyChunkAtlasUV(
        input.vUv, groundFieldMask,
        input.vAtlasOffset, input.vAtlasScale
    );
    return clamp(
        sampleRGBA32FBilinear(groundFieldMask, uv, layer),
        vec4<f32>(0.0, 0.0, 0.0, 0.0),
        vec4<f32>(1.0, 1.0, 1.0, 1.0)
    );
}

fn applyGroundFieldFallback(baseColor: vec3<f32>, input: FragmentInput, layer: i32) -> vec3<f32> {
    let field = sampleGroundField(input, layer);
    let grass = clamp(field.r, 0.0, 1.0);
    let fern = clamp(field.g, 0.0, 1.0);
    let weight = clamp(max(grass, fern) * GROUND_FIELD_TINT_STRENGTH, 0.0, 1.0);
    if (weight <= 0.0001) {
        return baseColor;
    }
    let total = max(grass + fern, 0.0001);
    let tint = (GROUND_FIELD_GRASS_TINT * grass + GROUND_FIELD_FERN_TINT * fern) / total;
    let tintTarget = mix(baseColor, tint, 0.30);
    return mix(baseColor, tintTarget, weight);
}
` : `
fn sampleGroundField(_input: FragmentInput, _layer: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

fn applyGroundFieldFallback(baseColor: vec3<f32>, _input: FragmentInput, _layer: i32) -> vec3<f32> {
    return baseColor;
}
`;
    const blendModeConstants = useAdvancedBlend ? `
const BLEND_SOFT:    i32 = 0;
const BLEND_HARD:    i32 = 1;
const STEP_OVERLAY:  i32 = 2;

    ` : '';
    const blendModeCode = useAdvancedBlend ? `
${blendModeBlock}
fn blendTileColorsSplat(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    tileId1: f32, tileId2: f32,
    worldPos: vec2<f32>
) -> vec4<f32> {
    return blendTileColors(color1, color2, w1, w2, tileId1, tileId2, worldPos);
}
` : `
${blendModeBlockSimple}
fn blendTileColorsSplat(
    color1: vec4<f32>, color2: vec4<f32>,
    w1: f32, w2: f32,
    _tileId1: f32, _tileId2: f32,
    _worldPos: vec2<f32>
) -> vec4<f32> {
    return blendTileColorsSimple(color1, color2, w1, w2);
}
`;
 
    
    const grassConstants = `
const GRASS_TILE_ID_COUNT: i32 = ${grassTileCount};
const GRASS_TILE_IDS: array<i32, ${grassTileCount}> = array<i32, ${grassTileCount}>(${grassTileIds.join(', ')});
const GRASS_SHADOW_STRENGTH: f32 = ${grassShadowStrength.toFixed(3)};
`;
    const textureCanonicalTileIdWGSL = `
fn canonicalTextureTileId(tileId: f32) -> f32 {
    let t = clamp(i32(round(tileId)), 0, 255);
${tileCategories.map((category) => {
        const canonicalTileId = category.ranges[0][0];
        return category.ranges
            .map(([minTileId, maxTileId]) =>
                `    if (t >= ${minTileId} && t <= ${maxTileId}) { return ${canonicalTileId}.0; }`
            )
            .join('\n');
    }).join('\n')}
    return tileId;
}
`;


    return `
const NORMAL_TEXTURE_FILTERABLE: bool = ${normalTextureFilterable ? 'true' : 'false'};

const ENABLE_TERRAIN_AO: bool = ${enableTerrainAO ? 'true' : 'false'};
const ENABLE_GROUND_FIELD: bool = ${enableGroundField ? 'true' : 'false'};
const TERRAIN_AO_AMBIENT_FLOOR: f32 = ${terrainAOAmbientFloor.toFixed(3)};
const GROUND_FIELD_TINT_STRENGTH: f32 = ${groundFieldTintStrength.toFixed(3)};
const GROUND_FIELD_GRASS_TINT: vec3<f32> = vec3<f32>(
    ${groundFieldGrassTint[0].toFixed(3)},
    ${groundFieldGrassTint[1].toFixed(3)},
    ${groundFieldGrassTint[2].toFixed(3)}
);
const GROUND_FIELD_FERN_TINT: vec3<f32> = vec3<f32>(
    ${groundFieldFernTint[0].toFixed(3)},
    ${groundFieldFernTint[1].toFixed(3)},
    ${groundFieldFernTint[2].toFixed(3)}
);

const DEBUG_EDGE_EPS: f32 = 0.02;
const DEBUG_MAX_LOD: f32 = 6.0;
const SHADER_LOD: i32 = ${lod};
const USE_ADVANCED_BLEND: bool = ${useAdvancedBlend ? 'true' : 'false'};
const USE_VARIANT_BLEND: bool = ${useVariantBlend ? 'true' : 'false'};
const USE_VARIANT_ROTATION: bool = ${useVariantRotation ? 'true' : 'false'};
const USE_POINT_SAMPLING: bool = ${usePointSampling ? 'true' : 'false'};
const USE_POINT_SPLAT: bool = ${enablePointSplat ? 'true' : 'false'};
const AP_FADE_START: f32 = ${apFadeStartMeters.toFixed(1)};
const AP_FADE_END: f32 = ${apFadeEndMeters.toFixed(1)};

const ENABLE_SPLAT: bool = ${enableSplat ? 'true' : 'false'};
const SPLAT_TIER: i32 = ${splatTier};
const ENABLE_NEAR_TO_MID_FADE: bool = ${enableNearToMidFade ? 'true' : 'false'};
const NEAR_TO_MID_FADE_START_CHUNKS: f32 = ${nearToMidFadeStartChunks.toFixed(2)};
const NEAR_TO_MID_FADE_END_CHUNKS: f32 = ${nearToMidFadeEndChunks.toFixed(2)};
const ENABLE_MACRO_OVERLAY: bool = ${enableMacroOverlay ? 'true' : 'false'};
const ENABLE_CLUSTERED_LIGHTS: bool = ${enableClusteredLights ? 'true' : 'false'};
const ENABLE_AERIAL_PERSPECTIVE: bool = ${enableAerialPerspective ? 'true' : 'false'};
const ENABLE_NORMAL_MAP: bool = ${enableNormalMap ? 'true' : 'false'};
const ENABLE_LIGHTING: bool = ${enableLighting ? 'true' : 'false'};
const SHADOW_MODE: i32 = ${shadowMode};
const ALTITUDE_NORMAL_MIN: f32 = ${altitudeNormalMinMeters.toFixed(2)};
const ALTITUDE_SHADOW_MIN: f32 = ${altitudeShadowMinMeters.toFixed(2)};
const DEBUG_LOD_COLORS: array<vec3<f32>, 7> = array<vec3<f32>, 7>(
    vec3<f32>(0.2, 0.8, 1.0),
    vec3<f32>(0.2, 1.0, 0.5),
    vec3<f32>(0.8, 1.0, 0.2),
    vec3<f32>(1.0, 0.8, 0.2),
    vec3<f32>(1.0, 0.5, 0.2),
    vec3<f32>(1.0, 0.2, 0.5),
    vec3<f32>(0.8, 0.2, 1.0)
);
${blendModeConstants}


${grassConstants}
${aerialPerspectiveCode}
${clusteredLightingCode}
struct FragmentUniforms {
    cameraPosition: vec3<f32>,
    time: f32,

    chunkOffset: vec2<f32>,
    chunkWidth: f32,
    chunkHeight: f32,

    lightDirection: vec3<f32>,
    sunLightIntensity: f32,

    lightColor: vec3<f32>,
    terrainAODirectStrength: f32, 

    ambientColor: vec3<f32>,
    ambientLightIntensity: f32,

    enableSplatLayer: f32,
    enableMacroLayer: f32,
    geometryLOD: i32,
    currentSeason: i32,

    nextSeason: i32,
    seasonTransition: f32,
    atlasTextureSize: f32,
    terrainAOStrength: f32, 

    atlasUVOffset: vec2<f32>,
    atlasUVScale: f32,
    useAtlasMode: i32,

    isFeature: f32,
    aerialPerspectiveEnabled: f32,
    macroScale: f32,
    macroMaxLOD: i32,

    planetCenter: vec3<f32>,
    atmospherePlanetRadius: f32,

    atmosphereRadius: f32,
    atmosphereScaleHeightRayleigh: f32,
    atmosphereScaleHeightMie: f32,
    atmosphereMieAnisotropy: f32,

    atmosphereRayleighScattering: vec3<f32>,
    atmosphereMieScattering: f32,

    atmosphereSunIntensity: f32,
    fogDensity: f32,
    fogScaleHeight: f32,
    level2Blend: f32,

    fogColor: vec3<f32>,
    macroNoiseWeight: f32,
    terrainDebugMode: i32,
    terrainLayerViewMode: i32,
    _debugPad1: i32,
    _debugPad2: i32,
};

@group(0) @binding(1) var<uniform> fragUniforms: FragmentUniforms;

@group(1) @binding(0) var heightTexture_f: ${chunkTextureType};
@group(1) @binding(1) var normalTexture: ${chunkTextureType};
@group(1) @binding(2) var tileTexture: ${chunkTextureType};
@group(1) @binding(3) var splatDataMap: ${chunkTextureType};      // top-4 weights
@group(1) @binding(4) var splatIndexMap: ${chunkTextureType};     // top-4 representative tile ids
@group(1) @binding(5) var macroMaskTexture: ${chunkTextureType};
${terrainAOBindingDecl}
${groundFieldBindingDecl}

@group(2) @binding(0) var atlasTexture: texture_2d_array<f32>;
@group(2) @binding(1) var level2AtlasTexture: texture_2d_array<f32>;
@group(2) @binding(2) var tileTypeLookup: texture_2d<f32>;
@group(2) @binding(3) var macroTileTypeLookup: texture_2d<f32>;
@group(2) @binding(4) var numVariantsTex: texture_2d<f32>;
@group(2) @binding(5) var textureSampler: sampler;
@group(2) @binding(6) var nearestSampler: sampler;

@group(2) @binding(7) var blendModeTable:   texture_2d<f32>;
@group(2) @binding(8) var chunkLinearSampler: sampler;
@group(3) @binding(7) var transmittanceLUT: texture_2d<f32>;
@group(3) @binding(8) var transmittanceSampler: sampler;
${shadowBindings}
struct FragmentInput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vUv: vec2<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vWorldPosition: vec3<f32>,
    @location(3) vViewPosition: vec3<f32>,
    @location(4) vDistanceToCamera: f32,
    @location(5) vTileUv: vec2<f32>,
    @location(6) vWorldPos: vec2<f32>,
    @location(7) vSphereDir: vec3<f32>,
    @location(8) vHeight: f32,
    @location(9) vDisplacement: f32,
    @location(10) vAtlasOffset: vec2<f32>,
    @location(11) vAtlasScale: f32,
    @location(12) vLayer: f32,
    @location(13) vDebugEdge: vec4<f32>,
    @location(14) vDebugSample: vec4<f32>,
    @location(15) vFaceInfo: vec4<f32>,
};

// ----------------------------------------------------------------------------
// Chunk-texture helpers
// ----------------------------------------------------------------------------

fn sampleRGBA32FNearest(tex: texture_2d_array<f32>, uv: vec2<f32>, layer: i32) -> vec4<f32> {
    let texSize = vec2<f32>(textureDimensions(tex));
    let coord = vec2<i32>(floor(uv * texSize));
    let maxCoord = vec2<i32>(texSize) - vec2<i32>(1);
    return textureLoad(tex, clamp(coord, vec2<i32>(0), maxCoord), layer, 0);
}

fn sampleRGBA32FBilinear(tex: texture_2d_array<f32>, uv: vec2<f32>, layer: i32) -> vec4<f32> {
    let size = vec2<f32>(textureDimensions(tex));
    let coord = uv * size - 0.5;
    let base = floor(coord);
    let f = fract(coord);
    let maxCoord = vec2<i32>(textureDimensions(tex)) - vec2<i32>(1);

    let c00 = textureLoad(tex, clamp(vec2<i32>(base),                  vec2<i32>(0), maxCoord), layer, 0);
    let c10 = textureLoad(tex, clamp(vec2<i32>(base) + vec2<i32>(1,0), vec2<i32>(0), maxCoord), layer, 0);
    let c01 = textureLoad(tex, clamp(vec2<i32>(base) + vec2<i32>(0,1), vec2<i32>(0), maxCoord), layer, 0);
    let c11 = textureLoad(tex, clamp(vec2<i32>(base) + vec2<i32>(1,1), vec2<i32>(0), maxCoord), layer, 0);

    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn hemiOctDecode(e: vec2<f32>) -> vec3<f32> {
    // e is in [-1,1]². Recover z from the L1 constraint; z ≥ 0 always.
    // normalize() absorbs the small off-sphere drift from bilinear/trilinear
    // interpolation between stored octahedral values.
    let z = 1.0 - abs(e.x) - abs(e.y);
    return normalize(vec3<f32>(e, z));
}

fn applyChunkAtlasUV(uv: vec2<f32>, tex: texture_2d_array<f32>, atlasOffset: vec2<f32>, atlasScale: f32) -> vec2<f32> {
    if (fragUniforms.useAtlasMode == 0) { return uv; }
    let texSize = vec2<f32>(textureDimensions(tex));
    let parentLocalUV = atlasOffset
                      + clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * atlasScale;


    let maxF = max(texSize - vec2<f32>(1.0), vec2<f32>(1.0));
    return (parentLocalUV * maxF + vec2<f32>(0.5)) / texSize;
}

fn applyChunkAtlasUV_2d(uv: vec2<f32>, texSize: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32) -> vec2<f32> {
    if (fragUniforms.useAtlasMode == 0) { return uv; }
    let parentLocalUV = atlasOffset
                      + clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * atlasScale;
    let maxF = max(texSize - vec2<f32>(1.0), vec2<f32>(1.0));
    return (parentLocalUV * maxF + vec2<f32>(0.5)) / texSize;
}

fn decodeDebugEdgeMask(packedTopAndMask: f32) -> i32 {
    let packed = fract(packedTopAndMask);
    return clamp(i32(round(packed * 4096.0)), 0, 4095);
}

fn computeChunkAtlasRect(texSize: vec2<i32>, atlasOffset: vec2<f32>, atlasScale: f32) -> vec4<i32> {
    let texSizeF = vec2<f32>(texSize);
    let width = max(1, i32(floor(texSizeF.x * atlasScale + 0.5)));
    let height = max(1, i32(floor(texSizeF.y * atlasScale + 0.5)));
    let minX = clamp(i32(floor(atlasOffset.x * texSizeF.x + 0.5)), 0, texSize.x - 1);
    let minY = clamp(i32(floor(atlasOffset.y * texSizeF.y + 0.5)), 0, texSize.y - 1);
    let maxX = clamp(minX + width - 1, minX, texSize.x - 1);
    let maxY = clamp(minY + height - 1, minY, texSize.y - 1);
    return vec4<i32>(minX, minY, maxX, maxY);
}

struct AtlasLeakRisk {
    any: bool,
    leakX: bool,
    leakY: bool,
    isFallback: bool,
};

fn computeAtlasBilinearLeakRisk(
    uv: vec2<f32>,
    tex: texture_2d_array<f32>,
    atlasOffset: vec2<f32>,
    atlasScale: f32
) -> AtlasLeakRisk {
    let texSizeI = vec2<i32>(textureDimensions(tex));
    let texSizeF = vec2<f32>(texSizeI);
    let rect = computeChunkAtlasRect(texSizeI, atlasOffset, atlasScale);
    let atlasUV = applyChunkAtlasUV_2d(uv, texSizeF, atlasOffset, atlasScale);
    let coord = atlasUV * texSizeF - 0.5;
    let base = floor(coord);
    let leakX = base.x < f32(rect.x) || (base.x + 1.0) > f32(rect.z);
    let leakY = base.y < f32(rect.y) || (base.y + 1.0) > f32(rect.w);

    var risk: AtlasLeakRisk;
    risk.any = leakX || leakY;
    risk.leakX = leakX;
    risk.leakY = leakY;
    risk.isFallback = atlasScale < 0.999;
    return risk;
}

fn snappedTileCenterUV(uv01: vec2<f32>, tilesPerSide: f32) -> vec2<f32> {
    let t = uv01 * vec2<f32>(tilesPerSide, tilesPerSide);
    let idx = clamp(floor(t), vec2<f32>(0.0), vec2<f32>(tilesPerSide - 1.0));
    return (idx + 0.5) / vec2<f32>(tilesPerSide, tilesPerSide);
}

fn decodeTileId(r: f32) -> f32 {
    return select(r * 255.0, r, r > 1.0);
}

fn sampleChunkTileId(input: FragmentInput, layer: i32) -> f32 {
    let tilesPerSide = fragUniforms.chunkWidth;
    let tileUV = snappedTileCenterUV(input.vUv, tilesPerSide);
    let uv = applyChunkAtlasUV(tileUV, tileTexture, input.vAtlasOffset, input.vAtlasScale);
    let s = sampleRGBA32FNearest(tileTexture, uv, layer);
    return decodeTileId(s.r);
}

fn debugHash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn debugTileIdColor(tileId: f32) -> vec3<f32> {
    let tid = floor(tileId + 0.5);
    let h0 = debugHash12(vec2<f32>(tid, 1.0));
    let h1 = debugHash12(vec2<f32>(tid, 7.0));
    let h2 = debugHash12(vec2<f32>(tid, 17.0));
    return vec3<f32>(
        0.2 + 0.8 * h0,
        0.2 + 0.8 * h1,
        0.2 + 0.8 * h2
    );
}

fn debugTileCategory(tileId: f32) -> i32 {
    let tid = i32(round(tileId));
    if (tid >= 0 && tid <= 3) { return 0; }
    if (tid >= 10 && tid <= 29) { return 1; }
    if (tid >= 30 && tid <= 41) { return 2; }
    if (tid >= 42 && tid <= 53) { return 3; }
    if (tid >= 54 && tid <= 65) { return 4; }
    if ((tid >= 66 && tid <= 81) || (tid >= 142 && tid <= 149)) { return 5; }
    if (tid >= 82 && tid <= 93) { return 6; }
    if (tid >= 94 && tid <= 105) { return 7; }
    if (tid >= 106 && tid <= 117) { return 8; }
    if (tid >= 118 && tid <= 129) { return 9; }
    if (tid >= 130 && tid <= 141) { return 10; }
    if (tid >= 150 && tid <= 165) { return 11; }
    return -1;
}

fn debugCategoryColor(cat: i32) -> vec3<f32> {
    if (cat == 0) { return vec3<f32>(0.15, 0.35, 0.85); }
    if (cat == 1) { return vec3<f32>(0.20, 0.60, 0.20); }
    if (cat == 2) { return vec3<f32>(0.82, 0.72, 0.42); }
    if (cat == 3) { return vec3<f32>(0.55, 0.55, 0.60); }
    if (cat == 4) { return vec3<f32>(0.50, 0.72, 0.32); }
    if (cat == 5) { return vec3<f32>(0.10, 0.38, 0.16); }
    if (cat == 6) { return vec3<f32>(0.14, 0.32, 0.22); }
    if (cat == 7) { return vec3<f32>(0.58, 0.40, 0.22); }
    if (cat == 8) { return vec3<f32>(0.45, 0.28, 0.22); }
    if (cat == 9) { return vec3<f32>(0.36, 0.14, 0.12); }
    if (cat == 10) { return vec3<f32>(0.85, 0.87, 0.92); }
    if (cat == 11) { return vec3<f32>(0.72, 0.58, 0.24); }
    return vec3<f32>(1.0, 0.0, 1.0);
}

// ----------------------------------------------------------------------------
// Splat data sampling (top-4 sparse local mixture)
// ----------------------------------------------------------------------------
struct SplatData {
    tileIds:     vec4<f32>,
    weights:     vec4<f32>,
    cellLocal:   vec2<f32>,
    hasBoundary: bool,
    bilinearValid: bool,
};

fn grassHash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn grassValueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let n00 = grassHash(i);
    let n10 = grassHash(i + vec2<f32>(1.0, 0.0));
    let n01 = grassHash(i + vec2<f32>(0.0, 1.0));
    let n11 = grassHash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

fn grassPatchMask(worldPos: vec2<f32>) -> f32 {
    let n1 = grassValueNoise(worldPos * 0.018 + vec2<f32>(3.7, 11.2));
    let n2 = grassValueNoise(worldPos * 0.047 + vec2<f32>(17.3, 31.9));
    let n3 = grassValueNoise(worldPos * 0.13 + vec2<f32>(53.1, 11.7));
    let n4 = grassValueNoise(worldPos * 0.31 + vec2<f32>(89.3, 67.1));
    let combined = n1 * 0.4 + n2 * 0.3 + n3 * 0.2 + n4 * 0.1;
    let coarse = smoothstep(0.3, 0.7, combined);
    let fine = mix(0.7, 1.0, n4);
    return coarse * fine;
}

fn isGrassTileId(tileId: f32) -> f32 {
    let tid = i32(round(tileId));
    var mask: f32 = 0.0;
    for (var i: i32 = 0; i < GRASS_TILE_ID_COUNT; i += 1) {
        if (tid == GRASS_TILE_IDS[i]) {
            mask = 1.0;
        }
    }
    return mask;
}

fn addTypeWeight(
    tid: i32,
    w: f32,
    types: ptr<function, array<i32, 8>>,
    weights: ptr<function, array<f32, 8>>,
    count: ptr<function, i32>
) {
    if (w <= 0.0) { return; }
    if (tid < 0 || tid >= 100) { return; }

    let n = *count;
    for (var i = 0; i < n; i += 1) {
        if ((*types)[i] == tid) {
            (*weights)[i] += w;
            return;
        }
    }

    if (n < 8) {
        (*types)[n] = tid;
        (*weights)[n] = w;
        *count = n + 1;
    }
}

fn decodeSplatTileId(encoded: f32) -> i32 {
    return i32(floor(encoded * 255.0 + 0.5));
}

fn splatEntryValid(tileId: i32, weight: f32) -> bool {
    return tileId >= 0 && tileId < 255 && weight > 0.0001;
}

fn addAccumWeight(
    tileId: i32,
    weight: f32,
    ids: ptr<function, array<i32, 16>>,
    weights: ptr<function, array<f32, 16>>,
    count: ptr<function, i32>
) {
    if (!splatEntryValid(tileId, weight)) {
        return;
    }

    let n = *count;
    for (var i = 0; i < n; i += 1) {
        if ((*ids)[i] == tileId) {
            (*weights)[i] = (*weights)[i] + weight;
            return;
        }
    }

    if (n < 16) {
        (*ids)[n] = tileId;
        (*weights)[n] = weight;
        *count = n + 1;
    }
}

fn insertTop4Accum(
    tileId: i32,
    weight: f32,
    topIds: ptr<function, array<i32, 4>>,
    topWeights: ptr<function, array<f32, 4>>
) {
    if (!splatEntryValid(tileId, weight)) {
        return;
    }

    var insertAt = -1;
    for (var i = 0; i < 4; i = i + 1) {
        let existingId = (*topIds)[i];
        let existingWeight = (*topWeights)[i];
        if (
            weight > existingWeight ||
            (weight == existingWeight && (!splatEntryValid(existingId, existingWeight) || tileId < existingId))
        ) {
            insertAt = i;
            break;
        }
    }

    if (insertAt < 0) {
        return;
    }

    for (var i = 3; i > insertAt; i = i - 1) {
        (*topIds)[i] = (*topIds)[i - 1];
        (*topWeights)[i] = (*topWeights)[i - 1];
    }

    (*topIds)[insertAt] = tileId;
    (*topWeights)[insertAt] = weight;
}

fn loadSplatWeights(coord: vec2<i32>, layer: i32) -> vec4<f32> {
    return clamp(textureLoad(splatDataMap, coord, layer, 0), vec4<f32>(0.0), vec4<f32>(1.0));
}

fn loadSplatIndices(coord: vec2<i32>, layer: i32) -> vec4<i32> {
    let s = textureLoad(splatIndexMap, coord, layer, 0);
    return vec4<i32>(
        decodeSplatTileId(s.r),
        decodeSplatTileId(s.g),
        decodeSplatTileId(s.b),
        decodeSplatTileId(s.a)
    );
}

fn accumulateLoadedCornerMixture(
    ids4: vec4<i32>,
    weights4: vec4<f32>,
    scale: f32,
    ids: ptr<function, array<i32, 16>>,
    weights: ptr<function, array<f32, 16>>,
    count: ptr<function, i32>
) {
    let w = weights4 * scale;

    addAccumWeight(ids4.x, w.x, ids, weights, count);
    addAccumWeight(ids4.y, w.y, ids, weights, count);
    addAccumWeight(ids4.z, w.z, ids, weights, count);
    addAccumWeight(ids4.w, w.w, ids, weights, count);
}

fn splatIdSetsMatch(a: vec4<i32>, b: vec4<i32>) -> bool {
    return a.x == b.x && a.y == b.y && a.z == b.z && a.w == b.w;
}

fn buildAccumulatedTop4(
    ids: ptr<function, array<i32, 16>>,
    weights: ptr<function, array<f32, 16>>,
    count: i32,
    topIds: ptr<function, array<i32, 4>>,
    topWeights: ptr<function, array<f32, 4>>
) {
    for (var i = 0; i < 4; i = i + 1) {
        (*topIds)[i] = 255;
        (*topWeights)[i] = 0.0;
    }

    for (var i = 0; i < count; i = i + 1) {
        insertTop4Accum((*ids)[i], (*weights)[i], topIds, topWeights);
    }

    let sumTop =
        (*topWeights)[0] +
        (*topWeights)[1] +
        (*topWeights)[2] +
        (*topWeights)[3];
    if (sumTop <= 0.0001) {
        return;
    }

    for (var i = 0; i < 4; i = i + 1) {
        (*topWeights)[i] = (*topWeights)[i] / sumTop;
    }
}

fn splatWeightSum(splat: SplatData) -> f32 {
    return splat.weights.x + splat.weights.y + splat.weights.z + splat.weights.w;
}

fn splatActiveCount(splat: SplatData) -> i32 {
    var count = 0;
    if (splat.weights.x > 0.0001) { count = count + 1; }
    if (splat.weights.y > 0.0001) { count = count + 1; }
    if (splat.weights.z > 0.0001) { count = count + 1; }
    if (splat.weights.w > 0.0001) { count = count + 1; }
    return count;
}

fn splatPrimaryWeight(splat: SplatData, _local: vec2<f32>) -> f32 {
    let total = max(splatWeightSum(splat), 0.0001);
    return clamp(splat.weights.x / total, 0.0, 1.0);
}

fn sampleSplatData(input: FragmentInput, layer: i32) -> SplatData {
    let uv = applyChunkAtlasUV(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
    let splatTexSize = vec2<f32>(textureDimensions(splatDataMap));
    let centerCoord = clamp(
        vec2<i32>(floor(uv * splatTexSize)),
        vec2<i32>(0),
        vec2<i32>(splatTexSize) - vec2<i32>(1)
    );
    let coord = uv * splatTexSize - 0.5;
    let base = floor(coord);
    let f = fract(coord);
    let maxCoord = vec2<i32>(splatTexSize) - vec2<i32>(1);

    let c00 = clamp(vec2<i32>(base),                  vec2<i32>(0), maxCoord);
    let c10 = clamp(vec2<i32>(base) + vec2<i32>(1,0), vec2<i32>(0), maxCoord);
    let c01 = clamp(vec2<i32>(base) + vec2<i32>(0,1), vec2<i32>(0), maxCoord);
    let c11 = clamp(vec2<i32>(base) + vec2<i32>(1,1), vec2<i32>(0), maxCoord);
    let centerWeights = loadSplatWeights(centerCoord, layer);
    let centerIds = loadSplatIndices(centerCoord, layer);
    let weights00 = loadSplatWeights(c00, layer);
    let weights10 = loadSplatWeights(c10, layer);
    let weights01 = loadSplatWeights(c01, layer);
    let weights11 = loadSplatWeights(c11, layer);
    let ids00 = loadSplatIndices(c00, layer);
    let ids10 = loadSplatIndices(c10, layer);
    let ids01 = loadSplatIndices(c01, layer);
    let ids11 = loadSplatIndices(c11, layer);
    let bilinearValid =
        splatIdSetsMatch(ids00, ids10) &&
        splatIdSetsMatch(ids00, ids01) &&
        splatIdSetsMatch(ids00, ids11);

    var topIds: array<i32, 4>;
    var topWeights: array<f32, 4>;

    if (bilinearValid) {
        let blendedWeights = clamp(
            mix(
                mix(weights00, weights10, f.x),
                mix(weights01, weights11, f.x),
                f.y
            ),
            vec4<f32>(0.0),
            vec4<f32>(1.0)
        );
        topIds = array<i32, 4>(ids00.x, ids00.y, ids00.z, ids00.w);
        topWeights = array<f32, 4>(
            blendedWeights.x,
            blendedWeights.y,
            blendedWeights.z,
            blendedWeights.w
        );
    } else {
        // Corner slot layouts disagree.  Accumulate the actual weighted corner
        // mixtures instead of snapping to the center texel; the old snap left
        // visible square "ghost borders" at the mixed→pure transition edge.
        var accumIds: array<i32, 16>;
        var accumWeights: array<f32, 16>;
        var accumCount: i32 = 0;

        accumulateLoadedCornerMixture(ids00, weights00, (1.0 - f.x) * (1.0 - f.y), &accumIds, &accumWeights, &accumCount);
        accumulateLoadedCornerMixture(ids10, weights10, f.x * (1.0 - f.y),         &accumIds, &accumWeights, &accumCount);
        accumulateLoadedCornerMixture(ids01, weights01, (1.0 - f.x) * f.y,         &accumIds, &accumWeights, &accumCount);
        accumulateLoadedCornerMixture(ids11, weights11, f.x * f.y,                 &accumIds, &accumWeights, &accumCount);

        buildAccumulatedTop4(&accumIds, &accumWeights, accumCount, &topIds, &topWeights);
    }

    let topSum = topWeights[0] + topWeights[1] + topWeights[2] + topWeights[3];
    if (topSum <= 0.0001) {
        let centerSum = max(centerWeights.x + centerWeights.y + centerWeights.z + centerWeights.w, 0.0001);
        topIds = array<i32, 4>(centerIds.x, centerIds.y, centerIds.z, centerIds.w);
        topWeights = array<f32, 4>(
            centerWeights.x / centerSum,
            centerWeights.y / centerSum,
            centerWeights.z / centerSum,
            centerWeights.w / centerSum
        );
    } else {
        topWeights = array<f32, 4>(
            topWeights[0] / topSum,
            topWeights[1] / topSum,
            topWeights[2] / topSum,
            topWeights[3] / topSum
        );
    }

    var result: SplatData;
    result.tileIds = vec4<f32>(
        f32(topIds[0]),
        f32(topIds[1]),
        f32(topIds[2]),
        f32(topIds[3])
    );
    result.weights = vec4<f32>(
        topWeights[0],
        topWeights[1],
        topWeights[2],
        topWeights[3]
    );
    let total = splatWeightSum(result);
    if (total > 0.0001) {
        result.weights = result.weights / total;
    } else {
        result.weights = vec4<f32>(1.0, 0.0, 0.0, 0.0);
    }
    result.cellLocal = fract(uv * splatTexSize);
    result.hasBoundary = splatActiveCount(result) > 1;
    result.bilinearValid = bilinearValid;
    return result;
}

fn buildSphericalTBN(sphereDir: vec3<f32>) -> mat3x3<f32> {
    let up = normalize(sphereDir);
    var reference = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(up, reference)) > 0.99) {
        reference = vec3<f32>(1.0, 0.0, 0.0);
    }
    let tangent = normalize(cross(up, reference));
    let bitangent = normalize(cross(up, tangent));
    return mat3x3<f32>(tangent, bitangent, up);
}

fn calculateGeometricNormal(input: FragmentInput) -> vec3<f32> {
    let dpdxWorld = dpdx(input.vWorldPosition);
    let dpdyWorld = dpdy(input.vWorldPosition);
    var n = normalize(cross(dpdyWorld, dpdxWorld));
    if (dot(n, n) < 0.01) {
        n = normalize(input.vSphereDir);
    }
    if (dot(n, input.vSphereDir) < 0.0) {
        n = -n;
    }
    return n;
}

fn calculateNormal(input: FragmentInput, layer: i32) -> vec3<f32> {
    let uv = applyChunkAtlasUV(input.vUv, normalTexture, input.vAtlasOffset, input.vAtlasScale);
    ${normalTextureFilterable
        ? `
    // Diagnostic: force mip 0 to test whether border seams are being widened
    // by normal-map mip generation / trilinear blending across inconsistent tiles.
    let s = textureSampleLevel(normalTexture, chunkLinearSampler, uv, layer, 0.0);`
        : `
    let s = sampleRGBA32FBilinear(normalTexture, uv, layer);`
    }
    let tangentNormal = hemiOctDecode(s.rg * 2.0 - 1.0);
    let TBN = buildSphericalTBN(input.vSphereDir);
    var worldNormal = normalize(TBN * tangentNormal);
    if (dot(worldNormal, worldNormal) < 0.01) {
        worldNormal = normalize(input.vSphereDir);
    }
    if (dot(worldNormal, input.vSphereDir) < 0.0) {
        worldNormal = -worldNormal;
    }
    return worldNormal;
}

fn sampleSlope(input: FragmentInput, layer: i32) -> f32 {
    let uv = applyChunkAtlasUV(input.vUv, normalTexture, input.vAtlasOffset, input.vAtlasScale);
    ${normalTextureFilterable
        ? `return textureSampleLevel(normalTexture, chunkLinearSampler, uv, layer, 0.0).b;`
        : `return sampleRGBA32FBilinear(normalTexture, uv, layer).b;`
    }
}

fn sampleHeightDebug(input: FragmentInput, layer: i32) -> f32 {
    let uv = applyChunkAtlasUV(input.vUv, heightTexture_f, input.vAtlasOffset, input.vAtlasScale);
    let h = sampleRGBA32FNearest(heightTexture_f, uv, layer).r;
    return clamp(h * 2.0 + 0.5, 0.0, 1.0);
}
// ----------------------------------------------------------------------------
// Tile variant selection helpers
// ----------------------------------------------------------------------------

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

${textureCanonicalTileIdWGSL}

fn getNumVariants(tileId: f32, season: i32) -> i32 {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let t = clamp(i32(canonicalTileId + 0.5), 0, 255);
    let s = clamp(season, 0, 3);
    let v = textureLoad(numVariantsTex, vec2<i32>(t, s), 0).r;
    return max(1, i32(round(v * 255.0)));
}

// Sample the zone mask at the snapped tile center — used for micro variant selection
// so that the variant is stable per tile.
fn sampleChunkZoneMask(input: FragmentInput, layer: i32) -> f32 {
    let tilesPerSide = fragUniforms.chunkWidth;
    let tileUV = snappedTileCenterUV(input.vUv, tilesPerSide);
    let uv = applyChunkAtlasUV(tileUV, macroMaskTexture, input.vAtlasOffset, input.vAtlasScale);
    let s = sampleRGBA32FNearest(macroMaskTexture, uv, layer);
    return clamp(s.r, 0.0, 1.0);
}

// Sample the zone mask with BILINEAR filtering at the fragment's actual UV —
// used for smooth macro blending that doesn't snap to tile boundaries.
fn sampleZoneMaskSmooth(input: FragmentInput, layer: i32) -> f32 {
    let uv = applyChunkAtlasUV(input.vUv, macroMaskTexture, input.vAtlasOffset, input.vAtlasScale);
    let s = sampleRGBA32FBilinear(macroMaskTexture, uv, layer);
    return clamp(s.r, 0.0, 1.0);
}

fn calculateRotation(worldTileCoord: vec2<f32>, tileId: f32, season: i32, seed: f32) -> f32 {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let h = hash12(worldTileCoord + vec2<f32>(canonicalTileId * 0.17, seed + f32(season) * 0.19));
    return floor(h * 4.0) * 1.5707963;
}

fn rotateUV(uv: vec2<f32>, angle: f32) -> vec2<f32> {
    let centered = uv - 0.5;
    let c = cos(angle);
    let s = sin(angle);
    let rotated = vec2<f32>(centered.x * c - centered.y * s, centered.x * s + centered.y * c);
    return rotated + 0.5;
}

fn rotateDeriv(v: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(v.x * c - v.y * s, v.x * s + v.y * c);
}

// ----------------------------------------------------------------------------
// Procedural noise for macro masking
// ----------------------------------------------------------------------------

fn fade(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn perlin2D(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let n00 = hash12(i);
    let n01 = hash12(i + vec2<f32>(0.0, 1.0));
    let n10 = hash12(i + vec2<f32>(1.0, 0.0));
    let n11 = hash12(i + vec2<f32>(1.0, 1.0));
    let u = vec2<f32>(fade(f.x), fade(f.y));
    return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 2.0 - 1.0;
}

fn octaveNoise(p: vec2<f32>, octaves: i32) -> f32 {
    var v: f32 = 0.0;
    var amp: f32 = 1.0;
    var freq: f32 = 1.0;
    var norm: f32 = 0.0;
    for (var i: i32 = 0; i < octaves; i += 1) {
        v += perlin2D(p * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    return v / norm;
}
fn macroVariationNoise(worldPos: vec2<f32>) -> f32 {
    let p = worldPos + vec2<f32>(7919.0, 10007.0);
    let n1 = octaveNoise(p * 0.0002, 3);
    let n2 = octaveNoise(p * 0.0007 + vec2<f32>(173.7, 291.3), 3);
    let n3 = octaveNoise(p * 0.003 + vec2<f32>(571.1, 839.7), 2);
    let combined = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
    let normalized = combined * 0.5 + 0.5;
    return smoothstep(0.1, 0.9, normalized);
}
${proceduralDetailCode}

// Helper to determine micro pattern style from tile ID
fn getMicroPatternStyle(tileId: f32) -> i32 {
    let tid = i32(round(tileId));
    /*
    // Rock types (example IDs - adjust to your tile type mapping)
    if (tid == 4 || tid == 5 || tid == 14 || tid == 15) {
        return 1; // Cracks
    }
    
    // Grass/forest types
    if (tid == 1 || tid == 2 || tid == 6 || tid == 7 || tid == 10 || tid == 11) {
        return 2; // Ditches
    }
    
    // Sand types
    if (tid == 3 || tid == 8 || tid == 12 || tid == 16) {
        return 3; // Waves
    }
    */
    // Default for all others
    return 0; // General micro
}
// ----------------------------------------------------------------------------
// Atlas layer lookup and sampling
// ----------------------------------------------------------------------------

fn lookupTileLayer(tileId: f32, season: i32, variantIdx: i32) -> i32 {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let lookupSize = vec2<i32>(textureDimensions(tileTypeLookup));
    let maxVariants = lookupSize.x / 4;
    let x = (season * maxVariants + (variantIdx % maxVariants)) % lookupSize.x;
    let y = i32(canonicalTileId) % lookupSize.y;
    let sample = textureLoad(tileTypeLookup, vec2<i32>(x, y), 0);
    return i32(round(sample.r));
}

fn lookupMacroTileLayer(tileId: f32, season: i32, variantIdx: i32) -> i32 {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let lookupSize = vec2<i32>(textureDimensions(macroTileTypeLookup));
    let maxVariants = lookupSize.x / 4;
    let x = (season * maxVariants + (variantIdx % maxVariants)) % lookupSize.x;
    let y = i32(canonicalTileId) % lookupSize.y;
    let sample = textureLoad(macroTileTypeLookup, vec2<i32>(x, y), 0);
    return i32(round(sample.r));
}

fn sampleAtlasLayer(
    layer: i32,
    tileUv: vec2<f32>,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>
) -> vec4<f32> {
    if (USE_POINT_SAMPLING) {
        return textureSampleGrad(atlasTexture, nearestSampler, tileUv, layer, ddx_vUv, ddy_vUv);
    }
    return textureSampleGrad(atlasTexture, textureSampler, tileUv, layer, ddx_vUv, ddy_vUv);
}

fn sampleMacroAtlasLayer(
    layer: i32,
    tileUv: vec2<f32>,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>
) -> vec4<f32> {
    if (USE_POINT_SAMPLING) {
        return textureSampleGrad(level2AtlasTexture, nearestSampler, tileUv, layer, ddx_vUv, ddy_vUv);
    }
    return textureSampleGrad(level2AtlasTexture, textureSampler, tileUv, layer, ddx_vUv, ddy_vUv);
}

fn sampleVariantAt(
    tileId: f32,
    tileCoord: vec2<f32>,
    worldPos: vec2<f32>,
    activeSeason: i32,
    variantIdx: i32,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>
) -> vec4<f32> {
    let localUV = fract(worldPos - tileCoord);
    let r = calculateRotation(tileCoord, tileId, activeSeason, 9547.0);
    let atlasLayer = lookupTileLayer(tileId, activeSeason, variantIdx);
    let rotatedLocal = rotateUV(localUV, r);
    let ddx_rot = rotateDeriv(ddx_vUv, r);
    let ddy_rot = rotateDeriv(ddy_vUv, r);
    return sampleAtlasLayer(atlasLayer, rotatedLocal, ddx_rot, ddy_rot);
}

fn getVariantAt(tileCoord: vec2<f32>, hashOffset: vec2<f32>, varCount: i32) -> i32 {
    return clamp(i32(floor(hash12(tileCoord + hashOffset) * f32(varCount))), 0, varCount - 1);
}

fn sampleTileColor(
    tileId: f32,
    worldTileCoord: vec2<f32>,
    localUV: vec2<f32>,
    activeSeason: i32,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>
) -> vec4<f32> {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let varCount = getNumVariants(canonicalTileId, activeSeason);
    let hashOffset = vec2<f32>(canonicalTileId * 0.17, f32(activeSeason) * 0.31);

    var currentVariant: i32 = 0;
    if (varCount > 1) {
        currentVariant = getVariantAt(worldTileCoord, hashOffset, varCount);
    }

    // Sample current tile
    var atlasLayer = lookupTileLayer(canonicalTileId, activeSeason, currentVariant);
    var rotatedLocal = localUV;
    var ddx_rot = ddx_vUv;
    var ddy_rot = ddy_vUv;
    if (USE_VARIANT_ROTATION) {
        let r = calculateRotation(worldTileCoord, canonicalTileId, activeSeason, 9547.0);
        rotatedLocal = rotateUV(localUV, r);
        ddx_rot = rotateDeriv(ddx_vUv, r);
        ddy_rot = rotateDeriv(ddy_vUv, r);
    }
    var color = sampleAtlasLayer(atlasLayer, rotatedLocal, ddx_rot, ddy_rot);

    if (!USE_VARIANT_BLEND || varCount <= 1) { return color; }

    // Bilinear variant blending across tile boundaries.
    // Shift by 0.5 so the blend straddles each tile edge.
    let worldPos = worldTileCoord + localUV;
    let p = worldPos - 0.5;
    let base = floor(p);
    let t = fract(p);
    let blend = smoothstep(vec2<f32>(0.0), vec2<f32>(1.0), t);

    let v00 = getVariantAt(base, hashOffset, varCount);
    let v10 = getVariantAt(base + vec2<f32>(1.0, 0.0), hashOffset, varCount);
    let v01 = getVariantAt(base + vec2<f32>(0.0, 1.0), hashOffset, varCount);
    let v11 = getVariantAt(base + vec2<f32>(1.0, 1.0), hashOffset, varCount);

    // Fast path: all 4 corners share the same variant — no blending needed
    if (v00 == v10 && v10 == v01 && v01 == v11) {
        return color;
    }

    // Sample each corner tile with its own rotation and variant
    let c00 = sampleVariantAt(tileId, base, worldPos, activeSeason, v00, ddx_vUv, ddy_vUv);
    let c10 = sampleVariantAt(tileId, base + vec2<f32>(1.0, 0.0), worldPos, activeSeason, v10, ddx_vUv, ddy_vUv);
    let c01 = sampleVariantAt(tileId, base + vec2<f32>(0.0, 1.0), worldPos, activeSeason, v01, ddx_vUv, ddy_vUv);
    let c11 = sampleVariantAt(tileId, base + vec2<f32>(1.0, 1.0), worldPos, activeSeason, v11, ddx_vUv, ddy_vUv);

    // Bilinear interpolation
    let c0 = mix(c00, c10, blend.x);
    let c1 = mix(c01, c11, blend.x);
    return mix(c0, c1, blend.y);
}


// ────────────────────────────────────────────────────────────────────────
// Contact AO
//
// The AO mask is baked per-tile by TerrainAOBaker from the same
// deterministic placement grid the scatter shader uses. Each tree that
// would scatter darkens the mask around its base; ground cover adds
// smaller pockets. We sample with the standard atlas UV transform so
// fallback tiles correctly read their parent's AO.
//
// AO modulates AMBIENT only. Direct sun light already has proper
// shadow-map occlusion; applying AO to it would double-darken.
// ────────────────────────────────────────────────────────────────────────
${terrainAOCode}
${groundFieldCode}

// Sample macro (level2) atlas for a given tile type.
// Uses a different rotation seed and hash-based variant selection
// so the macro pattern doesn't align with the micro pattern.
fn sampleMacroTileColor(
    tileId: f32,
    worldTileCoord: vec2<f32>,
    localUV: vec2<f32>,
    activeSeason: i32,
    ddx_uv: vec2<f32>,
    ddy_uv: vec2<f32>
) -> vec4<f32> {
    let canonicalTileId = canonicalTextureTileId(tileId);
    let r = calculateRotation(worldTileCoord, canonicalTileId, activeSeason, 100.0);

    let varCount = getNumVariants(canonicalTileId, activeSeason);
    var varIdx: i32 = 0;
    if (varCount > 1) {
        let h = hash12(worldTileCoord + vec2<f32>(canonicalTileId * 0.31, f32(activeSeason) * 0.53));
        varIdx = clamp(i32(floor(h * f32(varCount))), 0, varCount - 1);
    }

    let macroLayer = lookupMacroTileLayer(canonicalTileId, activeSeason, varIdx);
    let rotatedLocal = rotateUV(localUV, r);

    let ddx_rot = rotateDeriv(ddx_uv, r);
    let ddy_rot = rotateDeriv(ddy_uv, r);

    return sampleMacroAtlasLayer(macroLayer, rotatedLocal, ddx_rot, ddy_rot);
}

fn sampleMicroTexture(
    input: FragmentInput,
    activeSeason: i32,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>,
    layer: i32
) -> vec4<f32> {
    let worldTileCoord = floor(input.vWorldPos);
    let local = fract(input.vWorldPos);
    let tileId = sampleChunkTileId(input, layer);
    return sampleTileColor(tileId, worldTileCoord, local, activeSeason, ddx_vUv, ddy_vUv);
}
${blendModeCode}

fn computeNearToMidDetailFade(input: FragmentInput) -> f32 {
    if (!ENABLE_NEAR_TO_MID_FADE) {
        return 1.0;
    }
    let fadeStart = max(fragUniforms.chunkWidth * NEAR_TO_MID_FADE_START_CHUNKS, 0.0);
    let fadeEnd = max(fragUniforms.chunkWidth * NEAR_TO_MID_FADE_END_CHUNKS, fadeStart + 0.001);
    return 1.0 - smoothstep(fadeStart, fadeEnd, input.vDistanceToCamera);
}

fn sampleMicroTextureWithSplat(
    input: FragmentInput,
    activeSeason: i32,
    ddx_vUv: vec2<f32>,
    ddy_vUv: vec2<f32>,
    layer: i32,
    splat: SplatData
) -> vec4<f32> {
    let worldTileCoord = floor(input.vWorldPos);
    let local = fract(input.vWorldPos);
    let activeCount = splatActiveCount(splat);

    if (!splat.hasBoundary || activeCount <= 1) {
        return sampleTileColor(
            splat.tileIds.x, worldTileCoord, local,
            activeSeason, ddx_vUv, ddy_vUv
        );
    }

    let top2Sum = max(splat.weights.x + splat.weights.y, 0.0001);
    let primaryWeight = clamp(splat.weights.x / top2Sum, 0.0, 1.0);
    if (primaryWeight > 0.995) {
        return sampleTileColor(
            splat.tileIds.x, worldTileCoord, local,
            activeSeason, ddx_vUv, ddy_vUv
        );
    }
    if (primaryWeight < 0.005) {
        return sampleTileColor(
            splat.tileIds.y, worldTileCoord, local,
            activeSeason, ddx_vUv, ddy_vUv
        );
    }
    let color1 = sampleTileColor(
        splat.tileIds.x, worldTileCoord, local,
        activeSeason, ddx_vUv, ddy_vUv
    );
    let color2 = sampleTileColor(
        splat.tileIds.y, worldTileCoord, local,
        activeSeason, ddx_vUv, ddy_vUv
    );
    return blendTileColorsSplat(
        color1, color2,
        primaryWeight, 1.0 - primaryWeight,
        splat.tileIds.x, splat.tileIds.y,
        input.vWorldPos
    );
}

fn normalizeMacroTileId(tileId: f32) -> f32 {
    return select(tileId, tileId - 100.0, tileId >= 100.0);
}

fn sampleMacroTileColorBilinear(
    tileId: f32,
    macroWorld: vec2<f32>,
    local: vec2<f32>,
    activeSeason: i32,
    ddx_uv: vec2<f32>,
    ddy_uv: vec2<f32>
) -> vec3<f32> {
    let id = normalizeMacroTileId(tileId);
    let shifted = macroWorld - 0.5;
    let base = floor(shifted);
    let f = smoothstep(vec2<f32>(0.0), vec2<f32>(1.0), fract(shifted));

    let c00 = sampleMacroTileColor(id, base,                       local, activeSeason, ddx_uv, ddy_uv).rgb;
    let c10 = sampleMacroTileColor(id, base + vec2<f32>(1.0, 0.0), local, activeSeason, ddx_uv, ddy_uv).rgb;
    let c01 = sampleMacroTileColor(id, base + vec2<f32>(0.0, 1.0), local, activeSeason, ddx_uv, ddy_uv).rgb;
    let c11 = sampleMacroTileColor(id, base + vec2<f32>(1.0, 1.0), local, activeSeason, ddx_uv, ddy_uv).rgb;

    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn sampleMacroOverlaySplat(
    input: FragmentInput,
    activeSeason: i32,
    layer: i32,
    splat: SplatData
) -> vec3<f32> {
    let macroScale = max(fragUniforms.macroScale, 0.0001);
    let macroWorld = input.vWorldPos * macroScale;
    let local = fract(macroWorld);
    let ddx_uv = dpdx(macroWorld);
    let ddy_uv = dpdy(macroWorld);
    let activeCount = splatActiveCount(splat);

    if (!splat.hasBoundary || activeCount <= 1) {
        return sampleMacroOverlaySimplePrepared(
            macroWorld,
            local,
            activeSeason,
            ddx_uv,
            ddy_uv,
            splat.tileIds.x
        );
    }

    let top2Sum = max(splat.weights.x + splat.weights.y, 0.0001);
    let w1 = splat.weights.x / top2Sum;
    let w2 = splat.weights.y / top2Sum;
    let primary = sampleMacroTileColorBilinear(splat.tileIds.x, macroWorld, local, activeSeason, ddx_uv, ddy_uv);
    let secondary = sampleMacroTileColorBilinear(splat.tileIds.y, macroWorld, local, activeSeason, ddx_uv, ddy_uv);
    return primary * w1 + secondary * w2;
}

fn sampleMacroOverlaySimplePrepared(
    macroWorld: vec2<f32>,
    local: vec2<f32>,
    activeSeason: i32,
    ddx_uv: vec2<f32>,
    ddy_uv: vec2<f32>,
    tileId: f32
) -> vec3<f32> {
    var id = tileId;
    if (id >= 100.0) { id -= 100.0; }

    let macroTileCoord = floor(macroWorld);
    return sampleMacroTileColor(id, macroTileCoord, local, activeSeason, ddx_uv, ddy_uv).rgb;
}

fn sampleMacroOverlaySimple(
    input: FragmentInput,
    activeSeason: i32,
    tileId: f32
) -> vec3<f32> {
    let macroScale = max(fragUniforms.macroScale, 0.0001);
    let macroWorld = input.vWorldPos * macroScale;
    let local = fract(macroWorld);
    let ddx_uv = dpdx(macroWorld);
    let ddy_uv = dpdy(macroWorld);
    return sampleMacroOverlaySimplePrepared(
        macroWorld,
        local,
        activeSeason,
        ddx_uv,
        ddy_uv,
        tileId
    );
}
fn computeMacroBlendStrength(
    input: FragmentInput,
    layer: i32,
    macroAlpha: f32
) -> f32 {
    let macroMask = sampleZoneMaskSmooth(input, layer);
    let flatBlend = smoothstep(0.15, 0.9, macroMask);
    let baseOpacity = clamp(fragUniforms.level2Blend, 0.0, 1.0);
    let alpha = clamp(macroAlpha, 0.0, 1.0);
    return clamp(flatBlend * baseOpacity * alpha, 0.0, 0.9);
}

fn applyDitchDarkening(macroColor: vec3<f32>, worldPos: vec2<f32>) -> vec3<f32> {
    let ditchScale: f32 = 1.0;
    let cosD: f32 = 0.94;
    let sinD: f32 = 0.34;
    let rotatedDitch = vec2<f32>(
        worldPos.x * cosD - worldPos.y * sinD,
        worldPos.x * sinD + worldPos.y * cosD
    );
    let ditchNoise = octaveNoise(rotatedDitch * ditchScale, 3);
    let ditchWidth: f32 = 0.01;
    let ditchMask = 1.0 - smoothstep(-ditchWidth, ditchWidth, ditchNoise);
    let ditchDarken: f32 = 0.8;
    let luminanceMask = mix(1.0, ditchDarken, ditchMask);
    return macroColor * luminanceMask;
}

${shadowSamplingCode}
// ----------------------------------------------------------------------------
// FRAGMENT MAIN
// ----------------------------------------------------------------------------

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
//return vec4((f32(fragUniforms.geometryLOD) + 1.0)/6.0, 0.0, 0.0, 0.5);
    let activeSeason = select(fragUniforms.nextSeason, fragUniforms.currentSeason, fragUniforms.seasonTransition < 0.5);
    let layer = i32(round(input.vLayer));
    let debugMode = fragUniforms.terrainDebugMode;
    let layerViewMode = fragUniforms.terrainLayerViewMode;

    let segDims = vec2<f32>(fragUniforms.chunkWidth, fragUniforms.chunkHeight);
    let ddx_vUv = dpdx(input.vUv) * segDims;
    let ddy_vUv = dpdy(input.vUv) * segDims;

    if (debugMode == 1) {
        let tileId = sampleChunkTileId(input, layer);
        let v_dbg = fract(tileId * 0.137);
        return vec4<f32>(v_dbg, v_dbg, v_dbg, 1.0);
    }
    if (debugMode == 8) {
        let tileId = sampleChunkTileId(input, layer);
        let v = clamp(tileId / 255.0, 0.0, 1.0);
        return vec4<f32>(v, v, v, 1.0);
    }
    if (debugMode == 9) {
        let tileId = sampleChunkTileId(input, layer);
        let water = select(0.0, 1.0, tileId < 0.5);
        return vec4<f32>(water, 0.0, 0.0, 1.0);
    }
    if (debugMode == 10) {
        let loc = clamp(input.vFaceInfo.xy, vec2<f32>(0.0), vec2<f32>(1.0));
        let size = clamp(input.vFaceInfo.z * 8.0, 0.0, 1.0);
        return vec4<f32>(loc.x, loc.y, size, 1.0);
    }
    if (debugMode == 11) {
        var layers = 1.0;
        ${useArrayTextures ? 'layers = max(1.0, f32(textureNumLayers(tileTexture)));' : ''}
        let denom = max(layers - 1.0, 1.0);
        let v = clamp(f32(layer) / denom, 0.0, 1.0);
        return vec4<f32>(v, v, v, 1.0);
    }
    if (debugMode == 12) {
        let off = fract(input.vAtlasOffset);
        let scale = clamp(input.vAtlasScale, 0.0, 1.0);
        return vec4<f32>(off.x, off.y, scale, 1.0);
    }
    if (debugMode == 13) {
        let t = input.vFaceInfo.w;
        let r = fract(t * 0.1031);
        let g = fract(t * 0.1137 + 0.1);
        let b = fract(t * 0.1379 + 0.3);
        return vec4<f32>(r, g, b, 1.0);
    }
    if (debugMode == 14) {
        let left = input.vDebugEdge.x;
        let right = input.vDebugEdge.y;
        let bottom = input.vDebugEdge.z;
        var top = floor(input.vDebugEdge.w);
        let maxLod = DEBUG_MAX_LOD;
        let invalid =
            (left > maxLod) || (right > maxLod) ||
            (bottom > maxLod) || (top > maxLod);
        let sentinel =
            (left >= 15.0) || (right >= 15.0) ||
            (bottom >= 15.0) || (top >= 15.0);
        let r = clamp(left / maxLod, 0.0, 1.0);
        let g = clamp(right / maxLod, 0.0, 1.0);
        let b = clamp(bottom / maxLod, 0.0, 1.0);
        var col = vec3<f32>(r, g, b);
        col = select(col, vec3<f32>(1.0, 0.0, 0.0), sentinel);
        col = select(col, vec3<f32>(1.0, 0.0, 1.0), invalid);
        return vec4<f32>(col, 1.0);
    }
    if (debugMode == 15) {
        let selfLod = input.vDebugSample.x;
        let sampleLod = input.vDebugSample.w;
        let axis = input.vDebugSample.z; // 0=none, 1=x-edge, 2=y-edge
        let r = clamp(sampleLod / DEBUG_MAX_LOD, 0.0, 1.0);
        let g = clamp(selfLod / DEBUG_MAX_LOD, 0.0, 1.0);
        let b = clamp(axis / 2.0, 0.0, 1.0);
        return vec4<f32>(r, g, b, 1.0);
    }
    if (debugMode == 16) {
     /*   let ao = sampleTerrainAO(input, layer);
        return vec4<f32>(ao, ao, ao, 1.0);*/
    }
    if (debugMode == 2) {
        let splat = sampleSplatData(input, layer);
        let weight = splatPrimaryWeight(splat, splat.cellLocal);
        let pairChange = select(0.0, 1.0, splat.hasBoundary);
        let bilinearValid = select(0.0, 1.0, splat.bilinearValid);
        return vec4<f32>(weight, pairChange, bilinearValid, 1.0);
    }
    if (debugMode == 3) {
        let splat = sampleSplatData(input, layer);
        let weight = splatPrimaryWeight(splat, splat.cellLocal);
        return vec4<f32>(weight, weight, weight, 1.0);
    }
    if (debugMode == 4) {
        let splatSize = vec2<f32>(textureDimensions(splatDataMap));
        let tileSize = vec2<f32>(textureDimensions(tileTexture));
        return vec4<f32>(splatSize.x / 1024.0, tileSize.x / 1024.0, 0.0, 1.0);
    }
    if (debugMode == 25) {
        let uv = applyChunkAtlasUV(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
        let splatSize = vec2<f32>(textureDimensions(splatDataMap));
        let cell = fract(uv * splatSize);
        let edgeDist = min(min(cell.x, cell.y), min(1.0 - cell.x, 1.0 - cell.y));
        let grid = 1.0 - smoothstep(0.02, 0.05, edgeDist);
        let splat = sampleSplatData(input, layer);
        let w = splatPrimaryWeight(splat, splat.cellLocal);
        let base = vec3<f32>(w, w, w);
        return vec4<f32>(mix(base, vec3<f32>(1.0, 0.1, 0.1), grid), 1.0);
    }
    if (debugMode == 26) {
        let splat = sampleSplatData(input, layer);
        return vec4<f32>(debugTileIdColor(splat.tileIds.x), 1.0);
    }
    if (debugMode == 27) {
        let splat = sampleSplatData(input, layer);
        return vec4<f32>(debugTileIdColor(splat.tileIds.y), 1.0);
    }
    if (debugMode == 28) {
        let tileId = sampleChunkTileId(input, layer);
        let cat = debugTileCategory(tileId);
        return vec4<f32>(debugCategoryColor(cat), 1.0);
    }
    if (debugMode == 29) {
        let uv = applyChunkAtlasUV(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
        let splatSize = vec2<f32>(textureDimensions(splatDataMap));
        let gridCell = fract(uv * splatSize);
        let edgeDist = min(min(gridCell.x, gridCell.y), min(1.0 - gridCell.x, 1.0 - gridCell.y));
        let grid = 1.0 - smoothstep(0.02, 0.05, edgeDist);
        let splat = sampleSplatData(input, layer);
        let baseColor = select(
            vec3<f32>(0.08, 0.08, 0.08),
            vec3<f32>(1.0, 0.2, 0.2),
            splat.hasBoundary
        );
        return vec4<f32>(mix(baseColor, vec3<f32>(1.0, 1.0, 1.0), grid * 0.45), 1.0);
    }
    if (debugMode == 30) {
        let h = sampleHeightDebug(input, layer);
        return vec4<f32>(h, h, h, 1.0);
    }
    if (debugMode == 31) {
        let splat = sampleSplatData(input, layer);
        let weight = splatPrimaryWeight(splat, splat.cellLocal);
        return vec4<f32>(weight, weight, weight, 1.0);
    }
    if (debugMode == 32) {
        let uv = applyChunkAtlasUV(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
        let splatSize = vec2<f32>(textureDimensions(splatDataMap));
        let gridCell = fract(uv * splatSize);
        let edgeDist = min(min(gridCell.x, gridCell.y), min(1.0 - gridCell.x, 1.0 - gridCell.y));
        let grid = 1.0 - smoothstep(0.02, 0.05, edgeDist);
        let splat = sampleSplatData(input, layer);
        let v = select(0.0, 1.0, splat.bilinearValid);
        let base = vec3<f32>(v, v, v);
        return vec4<f32>(mix(base, vec3<f32>(0.1, 0.6, 1.0), grid * 0.35), 1.0);
    }
    if (debugMode == 33) {
        let edgeMask = decodeDebugEdgeMask(input.vDebugEdge.w);
        let isFallback = input.vAtlasScale < 0.999;
        let hasEdgeMask = edgeMask != 0;
        let edgeDist = min(min(input.vUv.x, input.vUv.y), min(1.0 - input.vUv.x, 1.0 - input.vUv.y));
        let edgeGlow = 1.0 - smoothstep(0.03, 0.07, edgeDist);
        var base = vec3<f32>(0.10, 0.62, 0.16);
        if (!isFallback && hasEdgeMask) {
            base = vec3<f32>(0.10, 0.72, 0.92);
        }
        if (isFallback && hasEdgeMask) {
            base = vec3<f32>(0.95, 0.58, 0.16);
        }
        if (isFallback && !hasEdgeMask) {
            base = vec3<f32>(1.0, 0.18, 0.18);
        }
        return vec4<f32>(mix(base, vec3<f32>(1.0), edgeGlow * 0.18), 1.0);
    }
    if (debugMode == 34) {
        let risk = computeAtlasBilinearLeakRisk(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
        let uv = applyChunkAtlasUV(input.vUv, splatDataMap, input.vAtlasOffset, input.vAtlasScale);
        let splatSize = vec2<f32>(textureDimensions(splatDataMap));
        let gridCell = fract(uv * splatSize);
        let edgeDist = min(min(gridCell.x, gridCell.y), min(1.0 - gridCell.x, 1.0 - gridCell.y));
        let grid = 1.0 - smoothstep(0.02, 0.05, edgeDist);
        var base = vec3<f32>(0.05, 0.10, 0.05);
        if (risk.isFallback) {
            base = vec3<f32>(0.28, 0.22, 0.08);
        }
        if (risk.leakX && !risk.leakY) {
            base = vec3<f32>(1.0, 0.18, 0.18);
        }
        if (risk.leakY && !risk.leakX) {
            base = vec3<f32>(0.18, 0.55, 1.0);
        }
        if (risk.leakX && risk.leakY) {
            base = vec3<f32>(1.0, 0.0, 1.0);
        }
        return vec4<f32>(mix(base, vec3<f32>(1.0), grid * 0.18), 1.0);
    }
    if (debugMode == 99) {
        return vec4<f32>(1.0, 0.0, 1.0, 1.0);
    }
    if (debugMode == 5) {
        let zm = sampleZoneMaskSmooth(input, layer);
        return vec4<f32>(zm, zm, zm, 1.0);
    }
    if (debugMode == 6) {
        let dbgTileId = sampleChunkTileId(input, layer);
        let macroScaleDbg = max(fragUniforms.macroScale, 0.0001);
        let macroWorldDbg = input.vWorldPos * macroScaleDbg;
        let ddxDbg = dpdx(macroWorldDbg);
        let ddyDbg = dpdy(macroWorldDbg);
        var dbgId = dbgTileId;
        if (dbgId >= 100.0) { dbgId -= 100.0; }
        let macroSample = sampleMacroTileColor(dbgId, floor(macroWorldDbg), fract(macroWorldDbg), activeSeason, ddxDbg, ddyDbg);
        return vec4<f32>(macroSample.rgb, 1.0);
    }
    if (debugMode == 7) {
        let strength = computeMacroBlendStrength(input, layer, 1.0);
        return vec4<f32>(strength, strength, strength, 1.0);
    }

if (debugMode == 16) {
 /*   let ao = sampleTerrainAO(input, layer);
    let occ = clamp((1.0 - ao) * 12.0, 0.0, 1.0);
    return vec4<f32>(occ, 1.0 - occ, 0.0, 1.0);*/
}
    if (debugMode == 17) {
        let ao = sampleTerrainAO(input, layer);
        let occ = clamp((1.0 - ao) * 5.0, 0.0, 1.0);
        return vec4<f32>(occ, 1.0 - occ, 0.0, 1.0);
    }

    if (debugMode == 18) {
        let s = clamp(fragUniforms.terrainAOStrength, 0.0, 1.0);
        return vec4<f32>(s, s, s, 1.0);
    }

    if (debugMode == 19) {
    /*
        if (!ENABLE_TERRAIN_AO) {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
        let dims = textureDimensions(terrainAOMask);
        let v = f32(dims.x) / 256.0;
        return vec4<f32>(v, v, v, 1.0);
        */
    }

    if (debugMode == 20) {
   /*     if (!ENABLE_TERRAIN_AO) {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
        let dims = vec2<i32>(textureDimensions(terrainAOMask));
        let mc = dims - vec2<i32>(1);
        let c  = clamp(vec2<i32>(input.vUv * vec2<f32>(dims)), vec2<i32>(0), mc);
        let ao = textureLoad(terrainAOMask, c, layer, 0).r;
        return vec4<f32>(ao, ao, ao, 1.0);  */
    }

    if (debugMode == 21) {
        if (ENABLE_TERRAIN_AO) {
            return vec4<f32>(0.0, 1.0, 0.0, 1.0);
        }
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
    }

    if (debugMode == 22) {
        var worldNormal = normalize(input.vSphereDir);
        if (ENABLE_NORMAL_MAP) {
            worldNormal = calculateNormal(input, layer);
            if (dot(worldNormal, input.vSphereDir) < 0.0) { worldNormal = -worldNormal; }
        }
        let lightDir = normalize(fragUniforms.lightDirection);
        let NdotL_d = max(dot(worldNormal, lightDir), 0.0);

        let ambL = dot(fragUniforms.ambientColor, vec3<f32>(0.2126, 0.7152, 0.0722))
                 * fragUniforms.ambientLightIntensity;
        let sunL = dot(fragUniforms.lightColor, vec3<f32>(0.2126, 0.7152, 0.0722))
                 * fragUniforms.sunLightIntensity * NdotL_d;

        let headroom = ambL / max(ambL + sunL, 0.0001);
        return vec4<f32>(headroom, headroom, headroom, 1.0);
    }

    if (debugMode == 23) {
        let albedo = sampleMicroTexture(input, activeSeason, ddx_vUv, ddy_vUv, layer).rgb;
        let ao = sampleTerrainAO(input, layer);
        let amb = fragUniforms.ambientColor * fragUniforms.ambientLightIntensity;
        return vec4<f32>(albedo * amb * ao, 1.0);
    }

    if (debugMode == 24) {
        var worldNormal = normalize(input.vSphereDir);
        if (ENABLE_NORMAL_MAP) {
            worldNormal = calculateNormal(input, layer);
            if (dot(worldNormal, input.vSphereDir) < 0.0) { worldNormal = -worldNormal; }
        }
        let lightDir = normalize(fragUniforms.lightDirection);
        let NdotL_d = max(dot(worldNormal, lightDir), 0.0);

        let ambient = fragUniforms.ambientColor * fragUniforms.ambientLightIntensity;
        let sunDiffuse = fragUniforms.lightColor * fragUniforms.sunLightIntensity * NdotL_d;
        let ao = sampleTerrainAO(input, layer);
        let aoF = mix(1.0, ao, clamp(fragUniforms.terrainAOStrength, 0.0, 1.0));

        let albedo = sampleMicroTexture(input, activeSeason, ddx_vUv, ddy_vUv, layer).rgb;
        return vec4<f32>(albedo * (ambient + sunDiffuse) * aoF, 1.0);
    }

    var microSample: vec4<f32>;
    let nearToMidDetailFade = computeNearToMidDetailFade(input);

    let fallbackTileId = sampleChunkTileId(input, layer);
    let worldTileCoord = floor(input.vWorldPos);
    let local = fract(input.vWorldPos);
   
    var splatResult: SplatData;
    splatResult.tileIds = vec4<f32>(fallbackTileId, fallbackTileId, fallbackTileId, fallbackTileId);
    splatResult.weights = vec4<f32>(1.0, 0.0, 0.0, 0.0);
    splatResult.cellLocal = vec2<f32>(0.0, 0.0);
    splatResult.hasBoundary = false;
    splatResult.bilinearValid = true;
    var dominantTileId = fallbackTileId;
    if (ENABLE_SPLAT && fragUniforms.enableSplatLayer > 0.5) {
        splatResult = sampleSplatData(input, layer);
        let detailedMicro = sampleMicroTextureWithSplat(
            input, activeSeason, ddx_vUv, ddy_vUv, layer, splatResult
        );
        microSample = detailedMicro;
        dominantTileId = splatResult.tileIds.x;

        if (ENABLE_NEAR_TO_MID_FADE && nearToMidDetailFade < 0.999) {
            let coarseMicro = sampleTileColor(
                fallbackTileId, worldTileCoord, local,
                activeSeason, ddx_vUv, ddy_vUv
            );
            microSample = mix(coarseMicro, detailedMicro, nearToMidDetailFade);
            dominantTileId = select(fallbackTileId, splatResult.tileIds.x, nearToMidDetailFade > 0.5);
        }
    } else {
        microSample = sampleTileColor(
            fallbackTileId, worldTileCoord, local,
            activeSeason, ddx_vUv, ddy_vUv
        );
    }

    if (microSample.a < 0.0) {
        discard;
    }

    let microPatternStyle = getMicroPatternStyle(dominantTileId);
    var baseColor = microSample.rgb;

    let macroForcedVisible = layerViewMode == 2;
    let macroAllowedByLod = fragUniforms.geometryLOD <= fragUniforms.macroMaxLOD || macroForcedVisible;
    if (ENABLE_MACRO_OVERLAY && fragUniforms.enableMacroLayer > 0.5 && macroAllowedByLod) {
        var macroColor = sampleMacroOverlaySimple(input, activeSeason, dominantTileId);
        if (ENABLE_SPLAT && fragUniforms.enableSplatLayer > 0.5) {
            let detailedMacro = sampleMacroOverlaySplat(input, activeSeason, layer, splatResult);
            let macroFade = select(1.0, nearToMidDetailFade, ENABLE_NEAR_TO_MID_FADE);
            macroColor = mix(macroColor, detailedMacro, macroFade);
        }
        if (macroForcedVisible) {
            baseColor = macroColor;
        } else if (layerViewMode != 1) {
            let macroStrength = computeMacroBlendStrength(input, layer, 1.0);
            baseColor = mix(baseColor, macroColor, macroStrength);
        }
    }

    if (ENABLE_GROUND_FIELD) {
        baseColor = applyGroundFieldFallback(baseColor, input, layer);
    }

    var finalColor = baseColor;
    var NdotL: f32 = 1.0;
    if (ENABLE_LIGHTING || ENABLE_AERIAL_PERSPECTIVE) {
        var worldNormal = normalize(input.vSphereDir);
        if (ENABLE_NORMAL_MAP) {
            worldNormal = calculateNormal(input, layer);
        }
        if (dot(worldNormal, input.vSphereDir) < 0.0) {
            worldNormal = -worldNormal;
        }
        let lightDir = normalize(fragUniforms.lightDirection);
        NdotL = max(dot(worldNormal, lightDir), 0.0);

        if (ENABLE_LIGHTING) {
            let ambient = fragUniforms.ambientColor * fragUniforms.ambientLightIntensity;
            let sunDiffuse = fragUniforms.lightColor * fragUniforms.sunLightIntensity * NdotL;

            var clusteredLight = vec3<f32>(0.0);
            if (ENABLE_CLUSTERED_LIGHTS) {
                clusteredLight = evaluateClusteredLights(
                    input.vWorldPosition,
                    input.vViewPosition,
                    worldNormal,
                    baseColor
                );
            }

            var shadowFactor: f32 = 1.0;
            if (SHADOW_MODE != 0) {
                let shadowBiasNormal = normalize(input.vSphereDir);
                let rawShadow = computeShadow(input.vWorldPosition, input.vViewPosition, shadowBiasNormal);

                const minShadow: f32 = 0.35;
                const shadowSoftness: f32 = 0.15;

                let softShadow = smoothstep(0.0, shadowSoftness, rawShadow);
                shadowFactor = mix(minShadow, 1.0, softShadow);
            }

            var aoAmbient: f32 = 1.0;
            var aoDirect:  f32 = 1.0;
            if (ENABLE_TERRAIN_AO) {
                let ao = sampleTerrainAO(input, layer);
                let master = clamp(fragUniforms.terrainAOStrength, 0.0, 1.0);
                aoAmbient = max(TERRAIN_AO_AMBIENT_FLOOR, mix(1.0, ao, master));
                aoDirect = mix(
                    1.0, ao,
                    clamp(fragUniforms.terrainAODirectStrength, 0.0, 1.0) * master
                );
            }
        
            finalColor = baseColor
                       * (ambient * aoAmbient + sunDiffuse * shadowFactor * aoDirect)
                       + clusteredLight;
        }
    }

    var foggedColor = finalColor;

    if (ENABLE_AERIAL_PERSPECTIVE && fragUniforms.aerialPerspectiveEnabled > 0.5) {
        let apBlend = smoothstep(AP_FADE_START, AP_FADE_END, input.vDistanceToCamera);

        if (apBlend > 0.001) {
            var ap = ap_computeSimple(
                transmittanceLUT,
                transmittanceSampler,
                input.vWorldPosition,
                fragUniforms.cameraPosition,
                normalize(fragUniforms.lightDirection),
                fragUniforms.planetCenter,
                fragUniforms.atmospherePlanetRadius,
                fragUniforms.atmosphereRadius,
                fragUniforms.atmosphereScaleHeightRayleigh,
                fragUniforms.atmosphereScaleHeightMie,
                fragUniforms.atmosphereRayleighScattering,
                fragUniforms.atmosphereMieScattering,
                fragUniforms.atmosphereMieAnisotropy,
                fragUniforms.atmosphereSunIntensity
            );
            let apSunVis = smoothstep(0.0, 0.2, NdotL);
            ap.inscatter *= mix(0.2, 1.0, apSunVis);
            foggedColor = ap_applyWithBlend(finalColor, ap, apBlend);
        }
    } else {
        let fogFactor = (1.0 - exp(-input.vDistanceToCamera * fragUniforms.fogDensity));
        foggedColor = mix(finalColor, fragUniforms.fogColor, clamp(fogFactor, 0.0, 1.0));
    }

    return vec4<f32>(foggedColor, 1.0);
}

`;
}
