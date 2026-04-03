// js/world/shaders/webgpu/terrain/features/featureMicro.wgsl.js

export function createTerrainFeatureMicro() {
  return `
// ==================== Feature: Micro Detail ====================
// Ground-level variation (1-15m primary, modulated at 500m - 1000+ km).
// Multiple "flavors": bumps, gentle rolls, soft roughness, near-flat.
// Regional modulation ensures each area has distinct micro character.

// NOTE: This is now treated as "forest floor" micro.
fn featureMicroDetail(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    profile: TerrainProfile
) -> f32 {
    var wxw = wx;
    var wyw = wy;
    var dir = unitDir;

    let warpStrength = 0.01 + 0.02 * profile.warpStrength;
    if (uniforms.face >= 0) {
        // Avoid spherical warp here; it creates large-scale banding/ripples on micro detail.
        dir = unitDir;
    } else {
        let warped = warpFlatAuto(wx, wy, unitDir, 1.5, 120.0 * warpStrength, seed + 8700);
        wxw = warped.x;
        wyw = warped.y;
    }

    // === Micro detail sources (1-15m wavelength) ===

    // Standard bumps and dents (symmetric FBM, + and - equally)
    let bumpRaw5  = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_5,  4, seed + 9100, 2.05, 0.50);
    let bumpRaw15 = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_15, 3, seed + 9150, 2.05, 0.48);
    let bumps = bumpRaw5 * 0.60 + bumpRaw15 * 0.30;

    // Gentle rolling at 50m scale (very subdued broad undulation)
    let gentle = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_50, 2, seed + 9180, 2.0, 0.45) * 0.20;

    // Soft roughness without ridged pits (avoids "golf ball" dimpling)
    let rough = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_15 * 0.9, 2, seed + 9190, 2.1, 0.48) * 0.12;

    // === Modulation masks (WHERE each flavor appears) ===

    // Meso-scale patches (500m - 2km): local character within a region
    let patchA = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_500, 2, seed + 9200, 2.0, 0.5);
    let patchB = microFbmAuto(wxw, wyw, dir, SCALE_MICRO_300, 2, seed + 9250, 2.0, 0.5);

    // Macro-scale regional character (10+ km, 100+ km)
    let regionChar  = microFbmAuto(wxw, wyw, dir, 10.0, 3, seed + 9300, 2.0, 0.5);
    let regionChar2 = microFbmAuto(wxw, wyw, dir, 80.0, 2, seed + 9350, 2.0, 0.5);

    // Flavor weights — keep variation but avoid trenchy/holed patterns
    let wBump   = smoothstep(-0.2, 0.2, patchA);
    let wGentle = smoothstep(-0.3, 0.05, regionChar);
    let wRough  = smoothstep(0.15, 0.45, patchB) * smoothstep(0.05, 0.35, regionChar2);

    // === Overall intensity modulation ===
    // Controls how "loud" micro detail is. Some areas are nearly silent,
    // others have full detail. Varies at 2km and 5km scales.
    let intensityA = smoothstep(-0.25, 0.35, microFbmAuto(wxw, wyw, dir, 2.0, 3, seed + 8800, 2.0, 0.5));
    let intensityB = smoothstep(-0.10, 0.40, microFbmAuto(wxw, wyw, dir, 5.0, 2, seed + 8850, 2.0, 0.5));
    // Range: 0.08 (nearly flat) to 1.0 (full detail)
    let intensity = mix(0.08, 1.0, intensityA) * mix(0.3, 1.0, intensityB);

    // === Combine flavors ===
    let combined = bumps  * wBump
                 + gentle * wGentle
                 + rough  * wRough;

    return combined * intensity;
}

// ==================== Per-octave rotated FBM for sphere surfaces ====================
// Standard 3D Perlin FBM creates visible "crop circle" artifacts when sampled on a
// sphere, because the cubic lattice intersection repeats. Rotating the domain between
// octaves breaks lattice coherence so successive octaves don't reinforce the pattern.
fn fbm3DRotated(p: vec3<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32) -> f32 {
    var value = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    var sumAmp = 0.0;
    var pp = p;

    for (var i = 0; i < 8; i++) {
        if (i >= octaves) { break; }
        value += perlin3D(pp * freq, seed + i) * amp;
        sumAmp += amp;
        amp *= gain;
        freq *= lacunarity;
        // Orthogonal rotation between octaves (verified: rows are unit length, pairwise dot = 0)
        pp = vec3<f32>(
             0.36 * pp.x + 0.48 * pp.y - 0.80 * pp.z,
            -0.80 * pp.x + 0.60 * pp.y + 0.00 * pp.z,
             0.48 * pp.x + 0.64 * pp.y + 0.60 * pp.z
        );
    }

    return value / max(sumAmp, 1e-6);
}

// Rotated FBM helper: uses per-octave rotation on sphere to prevent crop circles.
fn microFbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    if (uniforms.face >= 0) {
        let R = max(noiseReferenceRadiusM(), 1.0);
        let w = wavelength_m(scale, GEOLOGY_SCALE);
        let p = rotateDomain3(unitDir * R / w);
        return fbm3DRotated(p, octaves, seed, lac, gain);
    }
    return fbmMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain);
}

// Grass-specific FBM: uses per-octave rotation on sphere to prevent crop circles
fn grassFbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    if (uniforms.face >= 0) {
        let R = max(noiseReferenceRadiusM(), 1.0);
        let w = wavelength_m(scale, GEOLOGY_SCALE);
        let p = rotateDomain3(unitDir * R / w);
        return fbm3DRotated(p, octaves, seed, lac, gain);
    }
    return fbmMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain);
}

// ==================== Grass micro ====================
// Softer, finer variation than forest floor.
// Uses grassFbmAuto (per-octave rotated) to avoid sphere lattice artifacts.
fn grassMicroDetail(
    wx: f32, wy: f32, dir: vec3<f32>, seed: i32
) -> f32 {
    let small  = grassFbmAuto(wx, wy, dir, SCALE_MICRO_15, 3, seed + 12100, 2.1, 0.50);
    let fine   = grassFbmAuto(wx, wy, dir, SCALE_MICRO_5,  3, seed + 12110, 2.2, 0.48) * 0.5;
    let gentle = grassFbmAuto(wx, wy, dir, SCALE_MICRO_50, 3, seed + 12120, 2.0, 0.45) * 0.25;

    let patchNoise = grassFbmAuto(wx, wy, dir, SCALE_MICRO_300, 2, seed + 12130, 2.0, 0.5);
    let patchMask = mix(0.35, 1.0, smoothstep(-0.2, 0.35, patchNoise));

    return (small * 0.55 + fine * 0.25 + gentle * 0.35) * patchMask;
}

// ==================== Sand micro (flat) ====================
// Wind-blown ripples with gentle dune envelope.
fn sandMicroDetailFlat(
    wx: f32, wy: f32, dir: vec3<f32>, seed: i32
) -> f32 {
    let windNoise = microFbmAuto(wx, wy, dir, SCALE_SAND_WIND_DIR, 2, seed + 12200, 2.0, 0.5);
    let windAngle = windNoise * PI;

    let ripple = directionalFbmAuto(
        wx, wy, dir,
        SCALE_SAND_RIPPLE, SAND_RIPPLE_STRETCH, windAngle,
        2, seed + 12210, 2.0, 0.42
    );
    let sinRidge = directionalSinAuto(wx, wy, dir, SCALE_SAND_RIPPLE * 1.3, windAngle);
    let combined = ripple * 0.65 + sinRidge * 0.25;

    let duneEnv = microFbmAuto(wx, wy, dir, SCALE_SAND_DUNE_ENVELOPE, 2, seed + 12220, 2.0, 0.5);
    let duneShape = duneEnv * 0.5 + 0.5;

    let fieldEnv = microFbmAuto(wx, wy, dir, SCALE_SAND_FIELD_ENVELOPE, 2, seed + 12230, 2.0, 0.5);
    let fieldMask = smoothstep(0.25, 0.65, fieldEnv * 0.5 + 0.5);

    return combined * duneShape * fieldMask;
}

// ==================== Sand micro (steep) ====================
// Less regular ripples, more broken streaks.
fn sandMicroDetailSteep(
    wx: f32, wy: f32, dir: vec3<f32>, seed: i32
) -> f32 {
    let windNoise = microFbmAuto(wx, wy, dir, SCALE_SAND_WIND_DIR, 2, seed + 12300, 2.0, 0.5);
    let windAngle = windNoise * PI;

    let streak = directionalFbmAuto(
        wx, wy, dir,
        SCALE_SAND_RIPPLE * 1.6, SAND_RIPPLE_STRETCH * 1.8, windAngle,
        2, seed + 12310, 2.2, 0.45
    );
    let breakNoise = microFbmAuto(wx, wy, dir, SCALE_SAND_DUNE_ENVELOPE * 0.7, 2, seed + 12320, 2.0, 0.5);
    let breakMask = smoothstep(0.15, 0.6, breakNoise * 0.5 + 0.5);
    return streak * breakMask;
}

// ==================== Generic micro ====================
// Very gentle fallback for unknown tile types.
fn genericMicroDetail(
    wx: f32, wy: f32, dir: vec3<f32>, seed: i32
) -> f32 {
    let gentle = microFbmAuto(wx, wy, dir, SCALE_MICRO_50, 2, seed + 12400, 2.0, 0.5) * 0.3;
    let soft = microFbmAuto(wx, wy, dir, SCALE_MICRO_120, 2, seed + 12410, 2.0, 0.5) * 0.2;
    return gentle + soft;
}

// ==================== Tile-based micro selector ====================
fn tileMicroDetail(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    slope: f32, profile: TerrainProfile, tileId: u32
) -> f32 {
    var wxw = wx;
    var wyw = wy;
    var dir = unitDir;

    let warpStrength = 0.01 + 0.02 * profile.warpStrength;
    if (uniforms.face >= 0) {
        // Avoid spherical warp here; it creates large-scale banding/ripples on micro detail.
        dir = unitDir;
    } else {
        let warped = warpFlatAuto(wx, wy, unitDir, 1.5, 120.0 * warpStrength, seed + 8700);
        wxw = warped.x;
        wyw = warped.y;
    }

    var micro = 0.0;

    if (isForestFloorTile(tileId)) {
        micro = featureMicroDetail(wxw, wyw, dir, seed + 200, profile);
    } else if (isSandTile(tileId)) {
        let t = smoothstep(0.25, 0.65, slope);
        let flat = sandMicroDetailFlat(wxw, wyw, dir, seed + 300);
        let steep = sandMicroDetailSteep(wxw, wyw, dir, seed + 310);
        micro = mix(flat, steep, t);
    } else if (isGrassTile(tileId)) {
        micro = grassMicroDetail(wxw, wyw, dir, seed + 400);
    } else {
        micro = genericMicroDetail(wxw, wyw, dir, seed + 500);
    }

    // Macro-scale modulation (2 km + 8 km)
    let macroA = microFbmAuto(wxw, wyw, dir, 2.0, 2, seed + 9300, 2.0, 0.5);
    let macroB = microFbmAuto(wxw, wyw, dir, 8.0, 2, seed + 9310, 2.0, 0.5);
    let modA = mix(0.35, 1.0, smoothstep(-0.3, 0.3, macroA));
    let modB = mix(0.50, 1.0, smoothstep(-0.2, 0.2, macroB));

    return  modA * modB * micro;
}
`;
}
