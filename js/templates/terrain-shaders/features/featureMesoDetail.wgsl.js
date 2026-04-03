// js/world/shaders/webgpu/terrain/features/featureMesoDetail.wgsl.js
//
// Continuous micro- and meso-scale noise that fills gaps between features.
// All layers are additive on top of existing terrain.
//
// Layers:
//   micro2 — 5–10 m wavelength, ±DISP_MICRO2 m, surface-type-dependent
//   meso1  — 15–30 m wavelength, ±DISP_MESO1 m
//   meso2  — 40–70 m wavelength, ±DISP_MESO2 m
//   meso3  — 80–120 m wavelength, ±DISP_MESO3 m
//
// micro2 uses three distinct noise characters blended by climate/roughness:
//   sand   — anisotropic ripples aligned to slowly varying wind direction
//   rock   — ridged noise with geological strata direction
//   general — multi-character blend (gentle/bumpy/dips)
//
// Amplitudes are defined in METERS as constants (knobs) in earthLikeBase.

export function createTerrainFeatureMesoDetail() {
  return `
// ==================== Feature: Meso Detail ====================
// Returns vec4(micro2, meso1, meso2, meso3), each in roughly [-1, 1].
// Caller multiplies by the per-layer DISP_* constant / maxTerrainHeightM().

// --- Directional (anisotropic) FBM ---
// Stretches noise along a given angle for elongated features.
fn directionalFbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, stretch: f32, angle: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    let w = wavelength_m(scale, GEOLOGY_SCALE);
    if (uniforms.face >= 0) {
        let up = unitDir;
        let refDir = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(up.y) > 0.99);
        let t1 = normalize(cross(up, refDir));
        let t2 = cross(up, t1);
        let windT = cos(angle) * t1 + sin(angle) * t2;
        let perpT = -sin(angle) * t1 + cos(angle) * t2;
        let R = noiseReferenceRadiusM();
        let p = unitDir * R;
        let uc = dot(p, windT) / (w * stretch);
        let vc = dot(p, perpT) / w;
        let wc = dot(p, up) / w;
        return fbm3D(rotateDomain3(vec3<f32>(uc, vc, wc)), octaves, seed, lac, gain);
    } else {
        let cA = cos(angle);
        let sA = sin(angle);
        let rX = (cA * wx + sA * wy) / (w * stretch);
        let rY = (-sA * wx + cA * wy) / w;
        return fbm(vec2<f32>(rX, rY), octaves, seed, lac, gain);
    }
}

// --- Directional ridged multifractal ---
fn directionalRidgedAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, stretch: f32, angle: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32, offset: f32
) -> f32 {
    let w = wavelength_m(scale, GEOLOGY_SCALE);
    if (uniforms.face >= 0) {
        let up = unitDir;
        let refDir = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(up.y) > 0.99);
        let t1 = normalize(cross(up, refDir));
        let t2 = cross(up, t1);
        let windT = cos(angle) * t1 + sin(angle) * t2;
        let perpT = -sin(angle) * t1 + cos(angle) * t2;
        let R = noiseReferenceRadiusM();
        let p = unitDir * R;
        let uc = dot(p, windT) / (w * stretch);
        let vc = dot(p, perpT) / w;
        let wc = dot(p, up) / w;
        return ridgedMultifractal3D(rotateDomain3(vec3<f32>(uc, vc, wc)), octaves, seed, lac, gain, offset);
    } else {
        let cA = cos(angle);
        let sA = sin(angle);
        let rX = (cA * wx + sA * wy) / (w * stretch);
        let rY = (-sA * wx + cA * wy) / w;
        return ridgedMultifractal(vec2<f32>(rX, rY), octaves, seed, lac, gain, offset);
    }
}

// --- Directional sin wave (for regular sand ripple ridges) ---
fn directionalSinAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, angle: f32
) -> f32 {
    let w = wavelength_m(scale, GEOLOGY_SCALE);
    if (uniforms.face >= 0) {
        let up = unitDir;
        let refDir = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(up.y) > 0.99);
        let t1 = normalize(cross(up, refDir));
        let t2 = cross(up, t1);
        let perpT = -sin(angle) * t1 + cos(angle) * t2;
        let R = noiseReferenceRadiusM();
        let coord = dot(unitDir * R, perpT) / w;
        return sin(coord * 6.2831853);
    } else {
        let cA = cos(angle);
        let sA = sin(angle);
        let coord = (-sA * wx + cA * wy) / w;
        return sin(coord * 6.2831853);
    }
}

// ==================== Sand micro2 ====================
// Anisotropic wind-blown ripples with dune envelope modulation.
fn sandMicro2(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32
) -> f32 {
    // Wind direction: slowly varying angle (50 km scale)
    let windNoise = fbmAuto(wx, wy, unitDir, SCALE_SAND_WIND_DIR, 2, seed + 9610, 2.0, 0.5);
    let windAngle = windNoise * PI;

    // Elongated ripple pattern (directional fBm, 3.5x stretch)
    let ripple = directionalFbmAuto(
        wx, wy, unitDir,
        SCALE_SAND_RIPPLE, SAND_RIPPLE_STRETCH, windAngle,
        2, seed + 9620, 2.0, 0.42
    );

    // Subtle periodic ridge (sin wave perpendicular to wind)
    let sinRidge = directionalSinAuto(wx, wy, unitDir, SCALE_SAND_RIPPLE * 1.3, windAngle);

    let combined = ripple * 0.65 + sinRidge * 0.25;

    // Dune shape envelope (1 km): individual dune modulation
    let duneEnv = fbmAuto(wx, wy, unitDir, SCALE_SAND_DUNE_ENVELOPE, 2, seed + 9630, 2.0, 0.5);
    let duneShape = duneEnv * 0.5 + 0.5;

    // Dune field envelope (5 km): where dune fields exist
    let fieldEnv = fbmAuto(wx, wy, unitDir, SCALE_SAND_FIELD_ENVELOPE, 2, seed + 9640, 2.0, 0.5);
    let fieldMask = smoothstep(0.25, 0.65, fieldEnv * 0.5 + 0.5);

    return combined * duneShape * fieldMask;
}

// ==================== Rock micro2 ====================
// Sharp ridged features with geological strata direction.
fn rockMicro2(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32
) -> f32 {
    // Strata direction: varies at 30 km scale
    let strataNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_STRATA_DIR, 2, seed + 9650, 2.0, 0.5);
    let strataAngle = strataNoise * PI;

    // Sharp ridged features (directional ridged, 2x stretch along strata)
    let ridged = directionalRidgedAuto(
        wx, wy, unitDir,
        SCALE_ROCK_MICRO, ROCK_MICRO_STRETCH, strataAngle,
        2, seed + 9660, 2.0, 0.5, 1.0
    );
    let sharpRock = (ridged - 0.5) * 0.8;

    // Character variation: smooth layered vs jagged broken rock (3 km scale)
    let charNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_CHARACTER, 2, seed + 9670, 2.0, 0.5);
    let jaggedWeight = smoothstep(-0.2, 0.4, charNoise);

    // Jagged variant: billowed noise for broken rock
    let jagged = billowAuto(wx, wy, unitDir, SCALE_ROCK_MICRO, 2, seed + 9680, 2.3, 0.48) - 0.4;

    return mix(sharpRock, jagged, jaggedWeight);
}

// ==================== General micro2 ====================
// Multi-character blend: gentle rolling, bumpy, irregular dips.
// Varies spatially to avoid uniform "golf ball" appearance.
fn generalMicro2(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32
) -> f32 {
    // Character variation noise (2 km and 8 km scales)
    let charA = fbmAuto(wx, wy, unitDir, SCALE_GENERAL_CHARACTER, 2, seed + 9690, 2.0, 0.5) * 0.5 + 0.5;
    let charB = fbmAuto(wx, wy, unitDir, SCALE_GENERAL_SHAPE, 2, seed + 9695, 2.0, 0.5) * 0.5 + 0.5;

    // Flavor 1: gentle rolling (1 octave, very smooth)
    let gentle = fbmAuto(wx, wy, unitDir, SCALE_MICRO2, 1, seed + 9600, 2.0, 0.5);

    // Flavor 2: standard bumps (2 octaves, slightly different lacunarity)
    let bumpy = fbmAuto(wx, wy, unitDir, SCALE_MICRO2, 2, seed + 9601, 2.3, 0.48);

    // Flavor 3: irregular dips (billow creates uneven hollows)
    let dips = billowAuto(wx, wy, unitDir, SCALE_MICRO2, 2, seed + 9602, 2.0, 0.45) - 0.35;

    // Blend weights from spatial character
    let gentleW = smoothstep(0.6, 0.3, charA);
    let bumpyW = smoothstep(0.3, 0.6, charA) * smoothstep(0.7, 0.4, charA);
    let dipsW = smoothstep(0.5, 0.8, charA) * smoothstep(0.4, 0.7, charB);
    let totalW = max(gentleW + bumpyW + dipsW, 0.001);

    return (gentle * gentleW + bumpy * bumpyW + dips * dipsW) / totalW;
}

// ==================== Main meso detail function ====================

fn featureMesoDetail(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    profile: TerrainProfile, roughness: f32, elevation: f32
) -> vec4<f32> {

    // === Roughness-dependent intensity ===
    let roughMod = smoothstep(0.05, 0.40, roughness);

    // Local quiet patches (1.5 km scale)
    let localVar = fbmAuto(wx, wy, unitDir, 1.5, 2, seed + 9500, 2.0, 0.5);
    let quietPatch = mix(0.20, 1.0, smoothstep(-0.4, 0.2, localVar));

    // Regional variation (10 km scale)
    let regionVar = fbmAuto(wx, wy, unitDir, 10.0, 2, seed + 9550, 2.0, 0.5);
    let regionMod = mix(0.35, 1.0, smoothstep(-0.3, 0.3, regionVar));

    // Combined modulation
    let _mod = roughMod * quietPatch * regionMod * clamp(profile.microGain, 0.0, 5.0);

    // === Surface hint: climate-driven type weights ===
    let climate = getClimate(wx, wy, unitDir, elevation, seed);

    // Sand weight: hot + dry
    let sandW = smoothstep(0.35, 0.15, climate.precipitation)
              * smoothstep(0.5, 0.8, climate.temperature);

    // Rock weight: rough terrain
    let rockW = smoothstep(0.3, 0.7, roughness);

    // Normalize so sand + rock <= 1, remainder is general
    let totalHint = sandW + rockW;
    let cappedSand = select(sandW, sandW / totalHint, totalHint > 1.0);
    let cappedRock = select(rockW, rockW / totalHint, totalHint > 1.0);
    let generalW = max(0.0, 1.0 - cappedSand - cappedRock);

    // === micro2: surface-type-dependent ===
    var micro2 = 0.0;

    if (cappedSand > 0.05) {
        micro2 += sandMicro2(wx, wy, unitDir, seed) * cappedSand;
    }
    if (cappedRock > 0.05) {
        micro2 += rockMicro2(wx, wy, unitDir, seed) * cappedRock;
    }
    if (generalW > 0.05) {
        micro2 += generalMicro2(wx, wy, unitDir, seed) * generalW;
    }

    micro2 *= _mod;

    // === meso1: 15–30 m wavelength ===
    let meso1 = fbmAuto(wx, wy, unitDir, SCALE_MESO1, 2, seed + 9700, 2.0, 0.48) * _mod;

    // === meso2: 40–70 m wavelength ===
    let meso2 = fbmAuto(wx, wy, unitDir, SCALE_MESO2, 3, seed + 9800, 2.0, 0.50) * _mod;

    // === meso3: 80–120 m wavelength ===
    let meso3 = fbmAuto(wx, wy, unitDir, SCALE_MESO3, 3, seed + 9900, 2.0, 0.50) * _mod;

    return vec4<f32>(micro2, meso1, meso2, meso3);
}
`;
}
