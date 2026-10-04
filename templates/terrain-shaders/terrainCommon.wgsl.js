// js/world/shaders/webgpu/terrain/terrainCommon.wgsl.js

export function createTerrainCommon() {
  return `
// ==================== Terrain Common ====================

const PI: f32 = 3.14159265;

const RARITY_COMMON: i32 = 0;
const RARITY_UNCOMMON: i32 = 1;
const RARITY_RARE: i32 = 2;
const RARITY_VERY_RARE: i32 = 3;
const RARITY_EXCEPTIONAL: i32 = 4;

// Large-scale tiers use planet-count-based rarity.
const RARITY_COUNT_SCALE_THRESHOLD: f32 = 50.0; // geology units (~50 km)
const RARITY_SOFTNESS: f32 = 0.08;

struct TerrainProfile {
    baseBias: f32,
    mountainBias: f32,
    hillBias: f32,
    canyonBias: f32,
    rareBoost: f32,
    warpStrength: f32,
    ridgeSharpness: f32,
    microGain: f32,
};

struct RegionalInfo {
    isLand: bool,
    landMask: f32,
    terrainType: f32,
    tectonicActivity: f32,
    ruggedness: f32,
    baseElevation: f32,
};

struct TerrainAmplitudes {
    oceanDepth: f32,
    continentalShelf: f32,
    plainsVariation: f32,
    hillsHeight: f32,
    loneHillsHeight: f32,
    mountainBase: f32,
    mountainPeaks: f32,
    exceptionalPeaks: f32,
    canyonDepth: f32,
    microGain: f32,
    highlandsHeight: f32,
};

fn getTerrainProfile() -> TerrainProfile {
    var profile: TerrainProfile;

    profile.baseBias = clamp(uniforms._pad3.x, 0.0, 5.0);
    profile.mountainBias = clamp(uniforms._pad3.y, 0.0, 5.0);
    profile.hillBias = clamp(uniforms._pad3.z, 0.0, 5.0);
    profile.canyonBias = clamp(uniforms._pad3.w, 0.0, 5.0);

    profile.rareBoost = clamp(uniforms._pad4.x, 0.0, 5.0);
    profile.warpStrength = clamp(uniforms._pad4.y, 0.0, 5.0);
    profile.ridgeSharpness = clamp(uniforms._pad4.z, 0.0, 5.0);
    profile.microGain = clamp(uniforms._pad4.w, 0.0, 5.0);

    return profile;
}

// ==================== Noise wrappers ====================

fn noiseReferenceRadiusM() -> f32 {
    return max(uniforms._pad2.x, 1.0);
}

fn smallPlanetMode() -> bool {
    return uniforms._pad2.y > 0.5;
}

fn maxTerrainHeightM() -> f32 {
    return max(uniforms._pad2.z, 1.0);
}

// Correct height-to-radius ratio for normal computation on the unit sphere.
// Must match the vertex shader: radius = planetRadius + height * maxTerrainHeight.
fn normalDisplacementScale() -> f32 {
    return maxTerrainHeightM() / noiseReferenceRadiusM();
}

fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn clampMacroScaleToPlanet(scale: f32) -> f32 {
    if (uniforms.face < 0) {
        return scale;
    }
    let R = noiseReferenceRadiusM();
    let maxWavelength = 6.283185307 * R / MIN_MACRO_CYCLES;
    let maxScale = maxWavelength / GEOLOGY_SCALE;
    return min(scale, maxScale);
}

fn fbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    if (uniforms.face >= 0) {
        return fbmMetricSphere3D(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain);
    }
    return fbmMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain);
}

fn ridgedAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32, offset: f32
) -> f32 {
    if (uniforms.face >= 0) {
        return ridgedMetricSphere3D(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain, offset);
    }
    return ridgedMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain, offset);
}

fn billowAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    let n = fbmAuto(wx, wy, unitDir, scale, octaves, seed, lac, gain);
    return abs(n);
}

fn warpDirAuto(unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> vec3<f32> {
    let wxp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed, 2.0, 0.5);
    let wyp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed + 11, 2.0, 0.5);
    let wzp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed + 23, 2.0, 0.5);
    return normalize(unitDir + vec3<f32>(wxp, wyp, wzp) * strength);
}

fn warpFlatAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> vec2<f32> {
    let warp = fbmAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5) * strength;
    return vec2<f32>(wx + warp, wy - warp);
}

// warpFlatAuto for coordinates that are only ever passed back into the *Auto
// noise helpers. On the sphere (face >= 0) those sample unitDir and ignore
// wx/wy, so the warp could never change the result there: skip its three
// noise octaves. (Making such warps act on the sphere would change the
// terrain; that belongs to the noise overhaul, not here.)
fn warpFlatForNoise(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> vec2<f32> {
    if (uniforms.face >= 0) {
        return vec2<f32>(wx, wy);
    }
    return warpFlatAuto(wx, wy, unitDir, scale, strength, seed);
}

// ==================== Analytic derivatives (sphere) ====================
// Dual numbers vec4(value, gradient). The gradient is with respect to
// unitDir (callers project it onto the tangent plane and scale to metres at
// the end). Values are computed with the same expressions as the plain
// functions they mirror; *_d twins exist only for the sphere (face >= 0).

fn dConst(c: f32) -> vec4<f32> { return vec4<f32>(c, 0.0, 0.0, 0.0); }

fn dMul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(a.x * b.x, a.x * b.yzw + b.x * a.yzw);
}

fn dSmoothstep(e0: f32, e1: f32, a: vec4<f32>) -> vec4<f32> {
    let t = clamp((a.x - e0) / (e1 - e0), 0.0, 1.0);
    return vec4<f32>(smoothstep(e0, e1, a.x), a.yzw * (6.0 * t * (1.0 - t) / (e1 - e0)));
}

fn dClamp(a: vec4<f32>, lo: f32, hi: f32) -> vec4<f32> {
    let inside = a.x > lo && a.x < hi;
    return vec4<f32>(clamp(a.x, lo, hi), select(vec3<f32>(0.0), a.yzw, inside));
}

fn dAbs(a: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(abs(a.x), a.yzw * sign(a.x));
}

// mix(a, b, t) with t a dual.
fn dMix(a: vec4<f32>, b: vec4<f32>, t: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(
        mix(a.x, b.x, t.x),
        a.yzw * (1.0 - t.x) + b.yzw * t.x + (b.x - a.x) * t.yzw
    );
}

// pow(a, p) for a >= 0. The derivative is taken as 0 at a = 0 (it is
// unbounded there for p < 1, where the value is 0 and flat on one side).
fn dPow(a: vec4<f32>, p: f32) -> vec4<f32> {
    let v = pow(a.x, p);
    let d = select(0.0, p * pow(a.x, p - 1.0), a.x > 0.0);
    return vec4<f32>(v, a.yzw * d);
}

// Mirrors smoothAbs.
fn dSmoothAbs(a: vec4<f32>, k: f32) -> vec4<f32> {
    let r = sqrt(a.x * a.x + k * k);
    return vec4<f32>(r - k, a.yzw * (a.x / r));
}

// Mirrors smoothMin: mix(b, a, h) - k h (1 - h), h = clamp(0.5 + 0.5 (b - a) / k).
fn dSmoothMin(a: vec4<f32>, b: vec4<f32>, k: f32) -> vec4<f32> {
    let hRaw = 0.5 + 0.5 * (b.x - a.x) / k;
    let h = clamp(hRaw, 0.0, 1.0);
    let value = mix(b.x, a.x, h) - k * h * (1.0 - h);
    let dfdh = (a.x - b.x) - k + 2.0 * k * h;
    let dh = select(vec3<f32>(0.0), (b.yzw - a.yzw) * (0.5 / k), hRaw > 0.0 && hRaw < 1.0);
    return vec4<f32>(value, b.yzw * (1.0 - h) + a.yzw * h + dfdh * dh);
}

// Mirrors smoothMax: mix(a, b, h) + kk h (1 - h), h = clamp(0.5 + 0.5 (b - a) / kk).
fn dSmoothMax(a: vec4<f32>, b: vec4<f32>, k: f32) -> vec4<f32> {
    let kk = max(k, 1e-4);
    let hRaw = 0.5 + 0.5 * (b.x - a.x) / kk;
    let h = clamp(hRaw, 0.0, 1.0);
    let value = mix(a.x, b.x, h) + kk * h * (1.0 - h);
    let dfdh = (b.x - a.x) + kk - 2.0 * kk * h;
    let dh = select(vec3<f32>(0.0), (b.yzw - a.yzw) * (0.5 / kk), hRaw > 0.0 && hRaw < 1.0);
    return vec4<f32>(value, a.yzw * (1.0 - h) + b.yzw * h + dfdh * dh);
}

// Mirrors gateRamp.
fn dGateRamp(x: vec4<f32>, g: f32) -> vec4<f32> {
    return dMul(x, dSmoothstep(g, 6.0 * g, x));
}

// Quintic smoothstep core c^3 (c (6c - 15) + 10) of a clamped dual.
fn dQuintic(c: vec4<f32>) -> vec4<f32> {
    let x = c.x;
    let s = x - 1.0;
    return vec4<f32>(x * x * x * (x * (x * 6.0 - 15.0) + 10.0), c.yzw * (30.0 * x * x * s * s));
}

// a / b for duals.
fn dDiv(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(a.x / b.x, (a.yzw * b.x - a.x * b.yzw) / (b.x * b.x));
}

// max(a, b) for duals (the larger value's dual).
fn dMax(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    return select(b, a, a.x >= b.x);
}

// smoothstep(e0, e1, x) where the edges are duals too.
fn dSmoothstepDual(e0: vec4<f32>, e1: vec4<f32>, x: vec4<f32>) -> vec4<f32> {
    let w = e1.x - e0.x;
    let tRaw = (x.x - e0.x) / w;
    let t = clamp(tRaw, 0.0, 1.0);
    let inside = tRaw > 0.0 && tRaw < 1.0;
    let dt = ((x.yzw - e0.yzw) - (x.x - e0.x) * (e1.yzw - e0.yzw) / w) / w;
    return vec4<f32>(smoothstep(e0.x, e1.x, x.x), select(vec3<f32>(0.0), 6.0 * t * (1.0 - t) * dt, inside));
}

fn dSin(a: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(sin(a.x), a.yzw * cos(a.x));
}

fn dTanh(a: vec4<f32>) -> vec4<f32> {
    let t = tanh(a.x);
    return vec4<f32>(t, a.yzw * (1.0 - t * t));
}

fn fbmAuto_d(unitDir: vec3<f32>, scale: f32, octaves: i32, seed: i32, lac: f32, gain: f32) -> vec4<f32> {
    return fbmMetricSphere3D_d(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain);
}

fn ridgedAuto_d(unitDir: vec3<f32>, scale: f32, octaves: i32, seed: i32, lac: f32, gain: f32, offset: f32) -> vec4<f32> {
    return ridgedMetricSphere3D_d(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain, offset);
}

// A warped direction d = normalize(n + strength * w(n)), w = three fbm
// fields, kept with what is needed to pull a gradient at d back to n.
struct WarpedDir {
    d: vec3<f32>,
    invLen: f32,
    strength: f32,
    ga: vec3<f32>,   // gradients of the three warp components
    gb: vec3<f32>,
    gc: vec3<f32>,
};

fn makeWarpedDir(unitDir: vec3<f32>, wa: vec4<f32>, wb: vec4<f32>, wc: vec4<f32>, strength: f32) -> WarpedDir {
    var out: WarpedDir;
    let v = unitDir + vec3<f32>(wa.x, wb.x, wc.x) * strength;
    out.d = normalize(v);
    out.invLen = 1.0 / length(v);
    out.strength = strength;
    out.ga = wa.yzw;
    out.gb = wb.yzw;
    out.gc = wc.yzw;
    return out;
}

// Chain rule through d = normalize(n + s w(n)):
// grad_n = (I + s Jw)^T (I - d d^T) / |v| grad_d.
fn pullbackWarp(w: WarpedDir, gradAtD: vec3<f32>) -> vec3<f32> {
    let q = (gradAtD - w.d * dot(w.d, gradAtD)) * w.invLen;
    return q + w.strength * (q.x * w.ga + q.y * w.gb + q.z * w.gc);
}

// Mirrors warpDirAuto (sphere).
fn warpDirAuto_d(unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> WarpedDir {
    let wa = fbmAuto_d(unitDir, scale, 3, seed, 2.0, 0.5);
    let wb = fbmAuto_d(unitDir, scale, 3, seed + 11, 2.0, 0.5);
    let wc = fbmAuto_d(unitDir, scale, 3, seed + 23, 2.0, 0.5);
    return makeWarpedDir(unitDir, wa, wb, wc, strength);
}

// Mirrors rarityNoiseAuto (sphere).
fn rarityNoiseAuto_d(unitDir: vec3<f32>, scale: f32, seed: i32) -> vec4<f32> {
    let warpScale = scale * 1.7;
    let wa = fbmAuto_d(unitDir, warpScale, 2, seed + 500, 2.0, 0.5);
    let wb = fbmAuto_d(unitDir, warpScale, 2, seed + 501, 2.0, 0.5);
    let wc = fbmAuto_d(unitDir, warpScale, 2, seed + 502, 2.0, 0.5);
    let w = makeWarpedDir(unitDir, wa, wb, wc, 0.3);
    let n = fbmAuto_d(w.d, scale, 3, seed, 2.0, 0.5);
    return vec4<f32>(n.x, pullbackWarp(w, n.yzw));
}

// Mirrors rarityMaskAuto (sphere).
fn rarityMaskAuto_d(unitDir: vec3<f32>, scale: f32, seed: i32, tier: i32, rareBoost: f32) -> vec4<f32> {
    let coverage = rarityCoverage(scale, tier, rareBoost);
    let n = rarityNoiseAuto_d(unitDir, scale, seed);
    let threshold = coverageThreshold(coverage);
    let soft = RARITY_SOFTNESS * 2.0;
    return dSmoothstep(threshold - soft, threshold + soft, n);
}

// Mirrors sparseMaskAuto (sphere).
fn sparseMaskAuto_d(unitDir: vec3<f32>, scale: f32, seed: i32, coverage: f32, softness: f32) -> vec4<f32> {
    let n = fbmAuto_d(unitDir, scale, 3, seed, 2.0, 0.5);
    let t = coverageThreshold(coverage);
    return dSmoothstep(t - softness, t + softness, n);
}

// Mirrors softClampMax / softClampMin / softClampHeight.
fn softClampMax_d(value: vec4<f32>, limit: f32, knee: f32) -> vec4<f32> {
    let k = max(knee, 0.001);
    if (value.x <= limit - k) { return value; }
    let excess = (value - dConst(limit - k)) / k;
    return dConst(limit - k) + dTanh(excess) * k;
}

fn softClampMin_d(value: vec4<f32>, limit: f32, knee: f32) -> vec4<f32> {
    let k = max(knee, 0.001);
    if (value.x >= limit + k) { return value; }
    let deficit = (dConst(limit + k) - value) / k;
    return dConst(limit + k) - dTanh(deficit) * k;
}

fn softClampHeight_d(value: vec4<f32>, minH: f32, maxH: f32, knee: f32) -> vec4<f32> {
    var h = softClampMax_d(value, maxH, knee);
    h = softClampMin_d(h, minH, knee);
    return h;
}

// ==================== Coverage / rarity helpers ====================

fn coverageThreshold(coverage: f32) -> f32 {
    return mix(0.65, -0.65, clamp(coverage, 0.0, 1.0));
}

fn sparseMaskAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, seed: i32, coverage: f32, softness: f32
) -> f32 {
    let n = fbmAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5);
    let t = coverageThreshold(coverage);
    return smoothstep(t - softness, t + softness, n);
}

fn planetSurfaceArea() -> f32 {
    let R = noiseReferenceRadiusM();
    return 4.0 * PI * R * R;
}

fn coverageFromTargetCount(scale: f32, targetCount: f32) -> f32 {
    let w = wavelength_m(scale, GEOLOGY_SCALE);
    let area = planetSurfaceArea();
    let cellArea = max(w * w, 1.0);
    let cellCount = area / cellArea;
    return clamp(targetCount / max(cellCount, 1.0), 0.0, 1.0);
}

fn tierTargetCount(tier: i32) -> f32 {
    if (tier == RARITY_EXCEPTIONAL) { return 10.0; }
    if (tier == RARITY_VERY_RARE) { return 30.0; }
    if (tier == RARITY_RARE) { return 120.0; }
    if (tier == RARITY_UNCOMMON) { return 600.0; }
    return 2000.0;
}

fn tierCoverageSmall(tier: i32) -> f32 {
    if (tier == RARITY_EXCEPTIONAL) { return 0.02; }
    if (tier == RARITY_VERY_RARE) { return 0.05; }
    if (tier == RARITY_RARE) { return 0.12; }
    if (tier == RARITY_UNCOMMON) { return 0.3; }
    return 0.6;
}

fn rarityCoverage(scale: f32, tier: i32, rareBoost: f32) -> f32 {
    var coverage = 0.0;
    if (scale >= RARITY_COUNT_SCALE_THRESHOLD) {
        coverage = coverageFromTargetCount(scale, tierTargetCount(tier));
    } else {
        let baseCoverage = tierCoverageSmall(tier);
        let t = clamp(scale / RARITY_COUNT_SCALE_THRESHOLD, 0.05, 1.0);
        coverage = mix(baseCoverage * 1.2, baseCoverage, t);
    }
    return clamp(coverage * max(rareBoost, 0.001), 0.0, 1.0);
}

// ==================== Continuous rarity system ====================
// Uses noise-based thresholding instead of discrete cells to avoid hard boundaries.
// The "rarity" is controlled by how much of the noise field exceeds a threshold.

fn rarityNoiseAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32) -> f32 {
    // Use low-octave FBM for smooth, blob-like regions
    // Add a secondary warp to break up any grid alignment
    let warpScale = scale * 1.7;
    let warpAmt = 0.3;

    var dir = unitDir;
    var wxw = wx;
    var wyw = wy;

    if (uniforms.face >= 0) {
        // Sphere mode: warp the direction slightly for more organic shapes
        let warpX = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 500, 2.0, 0.5);
        let warpY = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 501, 2.0, 0.5);
        let warpZ = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 502, 2.0, 0.5);
        dir = normalize(unitDir + vec3<f32>(warpX, warpY, warpZ) * warpAmt);
    } else {
        // Flat mode: warp coordinates
        let warpX = fbmAuto(wx, wy, unitDir, warpScale, 2, seed + 500, 2.0, 0.5);
        let warpY = fbmAuto(wx, wy, unitDir, warpScale, 2, seed + 501, 2.0, 0.5);
        wxw = wx + warpX * scale * GEOLOGY_SCALE * warpAmt;
        wyw = wy + warpY * scale * GEOLOGY_SCALE * warpAmt;
    }

    // Main noise: 3 octaves for smooth blob shapes with some detail
    return fbmAuto(wxw, wyw, dir, scale, 3, seed, 2.0, 0.5);
}

fn rarityMaskAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32, tier: i32, rareBoost: f32) -> f32 {
    let coverage = rarityCoverage(scale, tier, rareBoost);

    // Use continuous noise instead of discrete cells
    let n = rarityNoiseAuto(wx, wy, unitDir, scale, seed);

    // Convert coverage to threshold: higher coverage = lower threshold = more area passes
    let threshold = coverageThreshold(coverage);

    // Softness controls the transition width
    let soft = RARITY_SOFTNESS * 2.0;  // Wider transition for smoother blending
    return smoothstep(threshold - soft, threshold + soft, n);
}

// Shape mask: creates soft blob shapes at the given scale
// Uses noise to create organic "island" shapes instead of grid cells
fn cellShapeAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32, softness: f32) -> f32 {
    // Use ridged noise to create more defined "peaks" / regions
    let n = ridgedAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5, 1.0);
    // Normalize ridged output (typically 0-2 range) and apply softness
    let normalized = clamp(n * 0.5, 0.0, 1.0);
    return smoothstep(1.0 - softness, 1.0, normalized);
}

// Legacy function kept for compatibility but now uses continuous noise
fn cellRandomAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32) -> f32 {
    // Return continuous noise instead of discrete cell random
    return rarityNoiseAuto(wx, wy, unitDir, scale, seed) * 0.5 + 0.5;
}

// ==================== Height composition utilities ====================

// Soft upper clamp using tanh: smoothly compresses values above (limit - knee)
// toward limit, never exceeding it.
fn softClampMax(value: f32, limit: f32, knee: f32) -> f32 {
    let k = max(knee, 0.001);
    if (value <= limit - k) { return value; }
    let excess = (value - (limit - k)) / k;
    return (limit - k) + k * tanh(excess);
}

// Soft lower clamp: smoothly compresses values below (limit + knee)
// toward limit, never going below it.
fn softClampMin(value: f32, limit: f32, knee: f32) -> f32 {
    let k = max(knee, 0.001);
    if (value >= limit + k) { return value; }
    let deficit = ((limit + k) - value) / k;
    return (limit + k) - k * tanh(deficit);
}

// Bilateral soft clamp: applies both upper and lower soft limits.
fn softClampHeight(value: f32, minH: f32, maxH: f32, knee: f32) -> f32 {
    var h = softClampMax(value, maxH, knee);
    h = softClampMin(h, minH, knee);
    return h;
}

// ==================== Count-based rarity mask ====================
// Forces planet-count-based coverage regardless of scale.
// Use for discrete features (landmarks, hills) where you want
// a specific number of instances per planet.

fn countBasedRarityMask(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, seed: i32, targetCount: f32, rareBoost: f32
) -> f32 {
    let coverage = clamp(
        coverageFromTargetCount(scale, targetCount) * max(rareBoost, 0.001),
        0.0, 1.0
    );
    let n = rarityNoiseAuto(wx, wy, unitDir, scale, seed);
    let threshold = coverageThreshold(coverage);
    let soft = RARITY_SOFTNESS * 2.5;
    return smoothstep(threshold - soft, threshold + soft, n);
}
`;
}
