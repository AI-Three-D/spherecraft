// js/world/shaders/webgpu/terrain/features/featureMesoDetail.wgsl.js
//
// Continuous meso-scale noise that fills gaps between features, additive on
// top of the terrain (sphere, dual numbers):
//   meso1 — 80 m wavelength, ±DISP_MESO1 m
//   meso2 — 750 m wavelength, ±DISP_MESO2 m
//   meso3 — 4 km wavelength, ±DISP_MESO3 m
// meso3 is part of the eroded landform; meso1/meso2 go on top of the eroded
// terrain. Amplitudes are METRES, constants in earthLikeBase. Also holds the
// directional (anisotropic) noise helpers used by featureMicro.

export function createTerrainFeatureMesoDetail() {
  return `
// ==================== Feature: Meso Detail ====================

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

// ==================== Main meso detail function ====================

// Meso detail (sphere): meso1-3 as duals. micro2 is not implemented (its
// amplitude DISP_MICRO2 is 0); add it here before giving DISP_MICRO2 a
// non-zero value.
struct MesoDetailD {
    meso1: vec4<f32>,
    meso2: vec4<f32>,
    meso3: vec4<f32>,
};

fn featureMesoDetail_d(
    unitDir: vec3<f32>, seed: i32,
    profile: TerrainProfile, roughness: vec4<f32>
) -> MesoDetailD {
    let roughMod = dSmoothstep(0.05, 0.40, roughness);

    let localVar = fbmAuto_d(unitDir, 1.5, 2, seed + 9500, 2.0, 0.5);
    let quietPatch = dMix(dConst(0.20), dConst(1.0), dSmoothstep(-0.4, 0.2, localVar));

    let regionVar = fbmAuto_d(unitDir, 10.0, 2, seed + 9550, 2.0, 0.5);
    let regionMod = dMix(dConst(0.35), dConst(1.0), dSmoothstep(-0.3, 0.3, regionVar));

    let _mod = dMul(dMul(roughMod, quietPatch), regionMod) * clamp(profile.microGain, 0.0, 5.0);

    var out: MesoDetailD;
    out.meso1 = dMul(fbmAuto_d(unitDir, SCALE_MESO1, 2, seed + 9700, 2.0, 0.48), _mod);
    out.meso2 = dMul(fbmAuto_d(unitDir, SCALE_MESO2, 3, seed + 9800, 2.0, 0.50), _mod);
    out.meso3 = dMul(fbmAuto_d(unitDir, SCALE_MESO3, 3, seed + 9900, 2.0, 0.50), _mod);
    return out;
}
`;
}
