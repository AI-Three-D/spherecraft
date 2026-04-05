// js/mesh/terrain/shaders/webgpu/proceduralDetailNoise.js
//
// Procedural detail noise functions for terrain.
// Patterns are continuous across tile boundaries (world-space based).
// All patterns return darkening factor in [0, 1] where 1 = no change, <1 = darker.

export function getProceduralDetailWGSL() {
    return `
// ----------------------------------------------------------------------------
// Procedural Detail Noise Module
// ----------------------------------------------------------------------------

// Improved hash for detail patterns - better distribution
fn detailHash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x + p.y) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.x + p3.y) * p3.z);
}

fn detailHash2(p: vec2<f32>) -> vec2<f32> {
    let h1 = detailHash(p);
    let h2 = detailHash(p + vec2<f32>(127.1, 311.7));
    return vec2<f32>(h1, h2);
}

// Smooth noise for continuous patterns
fn detailNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    let a = detailHash(i);
    let b = detailHash(i + vec2<f32>(1.0, 0.0));
    let c = detailHash(i + vec2<f32>(0.0, 1.0));
    let d = detailHash(i + vec2<f32>(1.0, 1.0));
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// FBM for organic variation
fn detailFBM(p: vec2<f32>, octaves: i32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var maxValue = 0.0;
    
    for (var i = 0; i < octaves; i++) {
        value += amplitude * detailNoise(p * frequency);
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value / maxValue;
}

// Voronoi distance for cellular patterns (cracks, etc)
fn voronoiDistance(p: vec2<f32>) -> vec2<f32> {
    let n = floor(p);
    let f = fract(p);
    
    var minDist1 = 1.0;
    var minDist2 = 1.0;
    
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let neighbor = vec2<f32>(f32(i), f32(j));
            let cellPoint = detailHash2(n + neighbor);
            let diff = neighbor + cellPoint - f;
            let dist = length(diff);
            
            if (dist < minDist1) {
                minDist2 = minDist1;
                minDist1 = dist;
            } else if (dist < minDist2) {
                minDist2 = dist;
            }
        }
    }
    
    return vec2<f32>(minDist1, minDist2);
}

// ----------------------------------------------------------------------------
// Pattern: General Micro (subtle variation for all surfaces)
// Scale: ~3-8m patterns, very sparse
// ----------------------------------------------------------------------------
fn patternGeneralMicro(worldPos: vec2<f32>) -> f32 {
    // Large offset to avoid origin artifacts
    let p = worldPos + vec2<f32>(5347.0, 8291.0);
    
    // Primary variation at ~6m scale
    let n1 = detailFBM(p * 0.16, 2);
    
    // Secondary variation at ~3m scale  
    let n2 = detailNoise(p * 0.33 + vec2<f32>(173.0, 291.0));
    
    // Sparsity mask - only affects ~15% of surface
    let sparsity = detailNoise(p * 0.05);
    let sparseMask = smoothstep(0.82, 0.88, sparsity);
    
    // Combine: subtle darkening where pattern exists
    let pattern = mix(n1, n2, 0.3);
    let darkening = mix(1.0, 0.88 + pattern * 0.12, sparseMask);
    
    return darkening;
}

// ----------------------------------------------------------------------------
// Pattern: Cracks (for rock, mud, dried earth)
// Scale: ~4-10m crack networks, very sparse
// ----------------------------------------------------------------------------
fn patternCracks(worldPos: vec2<f32>) -> f32 {
    let p = worldPos + vec2<f32>(2917.0, 6143.0);
    
    // Voronoi for crack network at ~7m cell size
    let v1 = voronoiDistance(p * 0.14);
    let crackEdge = v1.y - v1.x;
    
    // Thin crack lines
    let crackWidth = 0.08;
    let crack1 = 1.0 - smoothstep(0.0, crackWidth, crackEdge);
    
    // Secondary smaller cracks at ~3m scale
    let v2 = voronoiDistance(p * 0.35 + vec2<f32>(97.0, 163.0));
    let crack2 = 1.0 - smoothstep(0.0, crackWidth * 0.7, v2.y - v2.x);
    
    // Sparsity: only ~8% of area has visible cracks
    let sparsity = detailFBM(p * 0.02 + vec2<f32>(431.0, 599.0), 2);
    let sparseMask = smoothstep(0.88, 0.96, sparsity);
    
    // Combine cracks
    let totalCrack = max(crack1 * 0.7, crack2 * 0.4);
    
    // Darken cracks (0.65 = fairly dark crack interior)
    let darkening = mix(1.0, 0.65 + totalCrack * 0.2, sparseMask * totalCrack);
    
    return darkening;
}

// ----------------------------------------------------------------------------
// Pattern: Ditches/Grooves (for grass, forest floor, soil)
// Scale: ~5-12m linear features, sparse
// ----------------------------------------------------------------------------
fn patternDitches(worldPos: vec2<f32>) -> f32 {
    let p = worldPos + vec2<f32>(3691.0, 7523.0);
    
    // Rotate coordinates for non-axis-aligned ditches
    let angle1 = 0.38; // ~22 degrees
    let c1 = cos(angle1);
    let s1 = sin(angle1);
    let rot1 = vec2<f32>(p.x * c1 - p.y * s1, p.x * s1 + p.y * c1);
    
    // Primary ditch direction at ~8m spacing
    let ditch1 = detailNoise(vec2<f32>(rot1.x * 0.12, rot1.y * 0.02));
    let ditchLine1 = 1.0 - smoothstep(0.48, 0.52, ditch1);
    
    // Secondary perpendicular features at ~5m spacing
    let angle2 = angle1 + 1.57; // perpendicular
    let c2 = cos(angle2);
    let s2 = sin(angle2);
    let rot2 = vec2<f32>(p.x * c2 - p.y * s2, p.x * s2 + p.y * c2);
    let ditch2 = detailNoise(vec2<f32>(rot2.x * 0.19, rot2.y * 0.03) + vec2<f32>(271.0, 0.0));
    let ditchLine2 = 1.0 - smoothstep(0.46, 0.54, ditch2);
    
    // Sparsity: ~12% coverage
    let sparsity = detailFBM(p * 0.015, 2);
    let sparseMask = smoothstep(0.84, 0.94, sparsity);
    
    // Combine ditches
    let totalDitch = max(ditchLine1 * 0.8, ditchLine2 * 0.5);
    
    // Soft darkening for ditches
    let darkening = mix(1.0, 0.75, sparseMask * totalDitch);
    
    return darkening;
}

// ----------------------------------------------------------------------------
// Pattern: Waves/Ripples (for sand, dunes)
// Scale: ~4-8m wave patterns, moderate coverage
// ----------------------------------------------------------------------------
fn patternWaves(worldPos: vec2<f32>) -> f32 {
    let p = worldPos + vec2<f32>(4729.0, 1847.0);
    
    // Wind direction rotation (~15 degrees)
    let angle = 0.26;
    let c = cos(angle);
    let s = sin(angle);
    let rotP = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
    
    // Primary wave pattern at ~6m wavelength
    let wave1 = sin(rotP.x * 1.05 + detailNoise(rotP * 0.08) * 2.0);
    let wavePattern1 = smoothstep(-0.3, 0.3, wave1);
    
    // Secondary ripples at ~2.5m wavelength
    let wave2 = sin(rotP.x * 2.5 + detailNoise(rotP * 0.15 + vec2<f32>(83.0, 0.0)) * 1.5);
    let wavePattern2 = smoothstep(-0.4, 0.4, wave2);
    
    // Sparsity: ~20% coverage (sand patterns more visible)
    let sparsity = detailFBM(p * 0.025 + vec2<f32>(197.0, 353.0), 2);
    let sparseMask = smoothstep(0.75, 0.92, sparsity);
    
    // Combine waves - subtle shadow in troughs
    let combined = mix(wavePattern1, wavePattern2, 0.3);
    let shadow = 1.0 - combined * 0.15;
    
    let darkening = mix(1.0, shadow, sparseMask);
    
    return darkening;
}

// ----------------------------------------------------------------------------
// Pattern: Macro Detail (for macro texture variation)
// Scale: ~40-80m features, sparse large-scale variation
// ----------------------------------------------------------------------------
fn patternMacro(worldPos: vec2<f32>) -> f32 {
    let p = worldPos + vec2<f32>(9371.0, 2689.0);
    
    // Large-scale variation at ~64m
    let n1 = detailFBM(p * 0.016, 3);
    
    // Medium variation at ~32m
    let n2 = detailFBM(p * 0.031 + vec2<f32>(547.0, 839.0), 2);
    
    // Sparsity: ~18% coverage
    let sparsity = detailNoise(p * 0.008 + vec2<f32>(673.0, 419.0));
    let sparseMask = smoothstep(0.78, 0.93, sparsity);
    
    // Combine for organic variation
    let pattern = n1 * 0.6 + n2 * 0.4;
    
    // Subtle darkening for macro features
    let darkening = mix(1.0, 0.82 + pattern * 0.18, sparseMask);
    
    return darkening;
}

// ----------------------------------------------------------------------------
// Main application functions
// ----------------------------------------------------------------------------

// Apply micro detail based on pattern style (0=general, 1=cracks, 2=ditches, 3=waves)
fn applyMicroDetail(color: vec3<f32>, worldPos: vec2<f32>, patternStyle: i32) -> vec3<f32> {
    var darkening = 1.0;
    
    if (patternStyle == 1) {
        darkening = patternCracks(worldPos);
    } else if (patternStyle == 2) {
        darkening = patternDitches(worldPos);
    } else if (patternStyle == 3) {
        darkening = patternWaves(worldPos);
    } else {
        darkening = patternGeneralMicro(worldPos);
    }
    
    return color * darkening;
}

// Apply macro detail
fn applyMacroDetail(color: vec3<f32>, worldPos: vec2<f32>) -> vec3<f32> {
    let darkening = patternMacro(worldPos);
    return color * darkening;
}
`;
}