export const AERIAL_PERSPECTIVE_PARAMS = {
    LUT_WIDTH: 256,
    LUT_HEIGHT: 64,
    INSCATTER_STEPS: 8
};

export const AERIAL_PERSPECTIVE_WGSL = `
// ============================================================================
// AERIAL PERSPECTIVE - Physically-based atmospheric scattering
// ============================================================================

const AP_PI: f32 = 3.14159265359;

fn ap_rayleighPhase(cosTheta: f32) -> f32 {
    return (3.0 / (16.0 * AP_PI)) * (1.0 + cosTheta * cosTheta);
}

fn ap_miePhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let num = (1.0 - g2);
    let denom = 4.0 * AP_PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / max(denom, 0.0001);
}

fn ap_getTransmittanceUV(altitude: f32, cosTheta: f32, planetRadius: f32, atmosphereRadius: f32) -> vec2<f32> {
    let H = sqrt(max(0.0, atmosphereRadius * atmosphereRadius - planetRadius * planetRadius));
    let rho = sqrt(max(0.0, (planetRadius + altitude) * (planetRadius + altitude) - planetRadius * planetRadius));

    let u = clamp(rho / max(H, 0.001), 0.0, 1.0);

    let r = planetRadius + altitude;
    let dMin = atmosphereRadius - r;
    let dMax = rho + H;

    let cosT = clamp(cosTheta, -1.0, 1.0);
    // Match the LUT's uv->cosTheta mapping by computing the ray distance
    // to the top of the atmosphere for the given angle.
    let disc = max(0.0, r * r * cosT * cosT + atmosphereRadius * atmosphereRadius - r * r);
    let d = -r * cosT + sqrt(disc);
    let v = clamp((d - dMin) / max(dMax - dMin, 0.001), 0.0, 1.0);

    return vec2<f32>(u, v);
}

fn ap_sampleTransmittance(
    transmittanceTex: texture_2d<f32>,
    transmittanceSampler: sampler,
    altitude: f32,
    cosTheta: f32,
    planetRadius: f32,
    atmosphereRadius: f32
) -> vec3<f32> {
    let uv = ap_getTransmittanceUV(altitude, cosTheta, planetRadius, atmosphereRadius);
    return textureSampleLevel(transmittanceTex, transmittanceSampler, uv, 0.0).rgb;
}

fn ap_getDensity(altitude: f32, scaleHeightR: f32, scaleHeightM: f32) -> vec2<f32> {
    let densityR = exp(-max(0.0, altitude) / scaleHeightR);
    let densityM = exp(-max(0.0, altitude) / scaleHeightM);
    return vec2<f32>(densityR, densityM);
}

struct AerialPerspectiveResult {
    transmittance: vec3<f32>,
    inscatter: vec3<f32>,
}

fn ap_compute(
    transmittanceTex: texture_2d<f32>,
    transmittanceSampler: sampler,
    worldPos: vec3<f32>,
    cameraPos: vec3<f32>,
    sunDir: vec3<f32>,
    planetCenter: vec3<f32>,
    planetRadius: f32,
    atmosphereRadius: f32,
    scaleHeightR: f32,
    scaleHeightM: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    mieAnisotropy: f32,
    sunIntensity: f32
) -> AerialPerspectiveResult {
    var result: AerialPerspectiveResult;

    let toFragment = worldPos - cameraPos;
    let distance = length(toFragment);
    let viewDir = toFragment / max(distance, 0.001);

    let cameraAltitude = length(cameraPos - planetCenter) - planetRadius;
    let fragmentAltitude = length(worldPos - planetCenter) - planetRadius;

    let upAtCamera = normalize(cameraPos - planetCenter);
    let cosViewZenith = dot(viewDir, upAtCamera);

    result.transmittance = ap_sampleTransmittance(
        transmittanceTex, transmittanceSampler,
        max(0.0, cameraAltitude), cosViewZenith,
        planetRadius, atmosphereRadius
    );

    let cosSun = dot(viewDir, sunDir);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, mieAnisotropy);

    var totalInscatter = vec3<f32>(0.0);
    let numSteps = 8;
    let stepSize = distance / f32(numSteps);
    let atmosphereHeight = atmosphereRadius - planetRadius;

    for (var i = 0; i < numSteps; i++) {
        let t = (f32(i) + 0.5) * stepSize;
        let samplePos = cameraPos + viewDir * t;
        let sampleAltitude = length(samplePos - planetCenter) - planetRadius;

        let inside = (sampleAltitude >= 0.0) && (sampleAltitude <= atmosphereHeight);
        let sampleMask = select(0.0, 1.0, inside);
        let clampedAltitude = clamp(sampleAltitude, 0.0, atmosphereHeight);
        let density = ap_getDensity(clampedAltitude, scaleHeightR, scaleHeightM) * sampleMask;

        let upAtSample = normalize(samplePos - planetCenter);
        let cosSunZenith = dot(sunDir, upAtSample);

        let transmittanceToSun = ap_sampleTransmittance(
            transmittanceTex, transmittanceSampler,
            clampedAltitude, cosSunZenith,
            planetRadius, atmosphereRadius
        );

        let cosViewAtSample = dot(viewDir, upAtSample);
        let transmittanceToCamera = ap_sampleTransmittance(
            transmittanceTex, transmittanceSampler,
            clampedAltitude, -cosViewAtSample,
            planetRadius, atmosphereRadius
        );

        let scatterR = rayleighScattering * density.x * phaseR;
        let scatterM = vec3<f32>(mieScattering * density.y * phaseM);

        let inscatterSample = (scatterR + scatterM) * transmittanceToSun * transmittanceToCamera * stepSize * sampleMask;
        totalInscatter += inscatterSample;
    }

    result.inscatter = totalInscatter * sunIntensity;

    return result;
}
fn ap_computeSimple(
    transmittanceTex: texture_2d<f32>,
    transmittanceSampler: sampler,
    worldPos: vec3<f32>,
    cameraPos: vec3<f32>,
    sunDir: vec3<f32>,
    planetCenter: vec3<f32>,
    planetRadius: f32,
    atmosphereRadius: f32,
    scaleHeightR: f32,
    scaleHeightM: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    mieAnisotropy: f32,
    sunIntensity: f32
) -> AerialPerspectiveResult {
    var result: AerialPerspectiveResult;

    let toFragment  = worldPos - cameraPos;
    let distance    = length(toFragment);
    let viewDir     = toFragment / max(distance, 0.001);

    let cameraAltitude   = length(cameraPos - planetCenter) - planetRadius;
    let fragmentAltitude = length(worldPos  - planetCenter) - planetRadius;
    let avgAltitude      = max(0.0, (cameraAltitude + fragmentAltitude) * 0.5);

    let density         = ap_getDensity(avgAltitude, scaleHeightR, scaleHeightM);
    let extinctionR     = rayleighScattering * density.x;
    let extinctionM     = vec3<f32>(mieScattering * density.y);
    let totalExtinction = extinctionR + extinctionM;
    result.transmittance = exp(-totalExtinction * distance);

    // ── Sun direction at the fragment surface point ───────────────────────────
    // Use the surface normal (outward from planet) dot sunDir as the occlusion
    // signal. This is the same quantity NdotL uses for diffuse lighting, so the
    // aerial-perspective inscatter fade tracks the diffuse terminator exactly.
    let surfaceNormal  = normalize(worldPos - planetCenter);
    let cosSunSurface  = dot(sunDir, surfaceNormal);

    // Smooth width: wide enough that the transition is invisible below ~1 km.
    // ~0.08 ≈ 4.6° in angle space, which on a 50 km planet spans ~4 km on the
    // ground — far too gradual to see as a line from 200–300 m altitude.
    let smoothWidth = 0.08;
    let sunOcclusion = smoothstep(-smoothWidth, smoothWidth, cosSunSurface);

    // ── Sun transmittance at mid-ray ─────────────────────────────────────────
    let midPos       = cameraPos + viewDir * distance * 0.5;
    let upAtMid      = normalize(midPos - planetCenter);
    let cosSunAtMid  = dot(sunDir, upAtMid);

    let transmittanceToSun = ap_sampleTransmittance(
        transmittanceTex, transmittanceSampler,
        avgAltitude, cosSunAtMid,
        planetRadius, atmosphereRadius
    ) * sunOcclusion;    // ← fades smoothly across the terminator

    let cosSun = dot(viewDir, sunDir);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, mieAnisotropy);

    let safeExt      = max(totalExtinction, vec3<f32>(1e-7));
    let inscatterInt = (vec3<f32>(1.0) - result.transmittance) / safeExt;

    let scatterR = rayleighScattering * density.x * phaseR;
    let scatterM = vec3<f32>(mieScattering * density.y * phaseM);

    result.inscatter = (scatterR + scatterM) * transmittanceToSun * inscatterInt * sunIntensity;

    return result;
}

// Per-channel transmittance is what makes distant terrain shift blue.
// Averaging to a scalar (the old code) collapses that to a grey fade.
fn ap_apply(baseColor: vec3<f32>, ap: AerialPerspectiveResult) -> vec3<f32> {
    return baseColor * ap.transmittance + ap.inscatter;
}

fn ap_applyWithBlend(baseColor: vec3<f32>, ap: AerialPerspectiveResult, blend: f32) -> vec3<f32> {
    let withAP = ap_apply(baseColor, ap);
    return mix(baseColor, withAP, blend);
}
`;

export const AERIAL_PERSPECTIVE_GLSL = `
// ============================================================================
// AERIAL PERSPECTIVE - Physically-based atmospheric scattering (GLSL)
// ============================================================================

const float AP_PI = 3.14159265359;

float ap_rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * AP_PI)) * (1.0 + cosTheta * cosTheta);
}

float ap_miePhase(float cosTheta, float g) {
    float g2 = g * g;
    float num = (1.0 - g2);
    float denom = 4.0 * AP_PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / max(denom, 0.0001);
}

vec2 ap_getTransmittanceUV(float altitude, float cosTheta, float planetRadius, float atmosphereRadius) {
    float H = sqrt(max(0.0, atmosphereRadius * atmosphereRadius - planetRadius * planetRadius));
    float rho = sqrt(max(0.0, (planetRadius + altitude) * (planetRadius + altitude) - planetRadius * planetRadius));

    float u = clamp(rho / max(H, 0.001), 0.0, 1.0);

    float r = planetRadius + altitude;
    float dMin = atmosphereRadius - r;
    float dMax = rho + H;

    float cosT = clamp(cosTheta, -1.0, 1.0);
    // Match the LUT's uv->cosTheta mapping by computing the ray distance
    // to the top of the atmosphere for the given angle.
    float disc = max(0.0, r * r * cosT * cosT + atmosphereRadius * atmosphereRadius - r * r);
    float d = -r * cosT + sqrt(disc);
    float v = clamp((d - dMin) / max(dMax - dMin, 0.001), 0.0, 1.0);

    return vec2(u, v);
}

vec3 ap_sampleTransmittance(
    sampler2D transmittanceTex,
    float altitude,
    float cosTheta,
    float planetRadius,
    float atmosphereRadius
) {
    vec2 uv = ap_getTransmittanceUV(altitude, cosTheta, planetRadius, atmosphereRadius);
    return texture(transmittanceTex, uv).rgb;
}

vec2 ap_getDensity(float altitude, float scaleHeightR, float scaleHeightM) {
    float densityR = exp(-max(0.0, altitude) / scaleHeightR);
    float densityM = exp(-max(0.0, altitude) / scaleHeightM);
    return vec2(densityR, densityM);
}

struct AerialPerspectiveResult {
    vec3 transmittance;
    vec3 inscatter;
};

AerialPerspectiveResult ap_compute(
    sampler2D transmittanceTex,
    vec3 worldPos,
    vec3 cameraPos,
    vec3 sunDir,
    vec3 planetCenter,
    float planetRadius,
    float atmosphereRadius,
    float scaleHeightR,
    float scaleHeightM,
    vec3 rayleighScattering,
    float mieScattering,
    float mieAnisotropy,
    float sunIntensity
) {
    AerialPerspectiveResult result;

    vec3 toFragment = worldPos - cameraPos;
    float distance = length(toFragment);
    vec3 viewDir = toFragment / max(distance, 0.001);

    float cameraAltitude = length(cameraPos - planetCenter) - planetRadius;

    vec3 upAtCamera = normalize(cameraPos - planetCenter);
    float cosViewZenith = dot(viewDir, upAtCamera);

    result.transmittance = ap_sampleTransmittance(
        transmittanceTex,
        max(0.0, cameraAltitude), cosViewZenith,
        planetRadius, atmosphereRadius
    );

    float cosSun = dot(viewDir, sunDir);
    float phaseR = ap_rayleighPhase(cosSun);
    float phaseM = ap_miePhase(cosSun, mieAnisotropy);

    vec3 totalInscatter = vec3(0.0);
    const int numSteps = 8;
    float stepSize = distance / float(numSteps);

    for (int i = 0; i < numSteps; i++) {
        float t = (float(i) + 0.5) * stepSize;
        vec3 samplePos = cameraPos + viewDir * t;
        float sampleAltitude = length(samplePos - planetCenter) - planetRadius;

        if (sampleAltitude < 0.0 || sampleAltitude > atmosphereRadius - planetRadius) {
            continue;
        }

        vec2 density = ap_getDensity(sampleAltitude, scaleHeightR, scaleHeightM);

        vec3 upAtSample = normalize(samplePos - planetCenter);
        float cosSunZenith = dot(sunDir, upAtSample);

        vec3 transmittanceToSun = ap_sampleTransmittance(
            transmittanceTex,
            sampleAltitude, cosSunZenith,
            planetRadius, atmosphereRadius
        );

        float cosViewAtSample = dot(viewDir, upAtSample);
        vec3 transmittanceToCamera = ap_sampleTransmittance(
            transmittanceTex,
            sampleAltitude, -cosViewAtSample,
            planetRadius, atmosphereRadius
        );

        vec3 scatterR = rayleighScattering * density.x * phaseR;
        vec3 scatterM = vec3(mieScattering * density.y * phaseM);

        vec3 inscatterSample = (scatterR + scatterM) * transmittanceToSun * transmittanceToCamera * stepSize;
        totalInscatter += inscatterSample;
    }

    result.inscatter = totalInscatter * sunIntensity;

    return result;
}

AerialPerspectiveResult ap_computeSimple(
    sampler2D transmittanceTex,
    vec3 worldPos,
    vec3 cameraPos,
    vec3 sunDir,
    vec3 planetCenter,
    float planetRadius,
    float atmosphereRadius,
    float scaleHeightR,
    float scaleHeightM,
    vec3 rayleighScattering,
    float mieScattering,
    float mieAnisotropy,
    float sunIntensity
) {
    AerialPerspectiveResult result;

    vec3 toFragment = worldPos - cameraPos;
    float distance = length(toFragment);
    vec3 viewDir = toFragment / max(distance, 0.001);

    float cameraAltitude = length(cameraPos - planetCenter) - planetRadius;
    float fragmentAltitude = length(worldPos - planetCenter) - planetRadius;
    float avgAltitude = max(0.0, (cameraAltitude + fragmentAltitude) * 0.5);

    vec3 upAtCamera = normalize(cameraPos - planetCenter);
    float cosViewZenith = dot(viewDir, upAtCamera);

    result.transmittance = ap_sampleTransmittance(
        transmittanceTex,
        max(0.0, cameraAltitude), cosViewZenith,
        planetRadius, atmosphereRadius
    );

    vec2 density = ap_getDensity(avgAltitude, scaleHeightR, scaleHeightM);

    float cosSun = dot(viewDir, sunDir);
    float phaseR = ap_rayleighPhase(cosSun);
    float phaseM = ap_miePhase(cosSun, mieAnisotropy);

    float opticalDepthScale = distance * 0.00001;

    vec3 scatterR = rayleighScattering * density.x * phaseR * opticalDepthScale;
    vec3 scatterM = vec3(mieScattering * density.y * phaseM * opticalDepthScale);

    result.inscatter = (scatterR + scatterM) * sunIntensity;

    return result;
}

vec3 ap_apply(vec3 baseColor, AerialPerspectiveResult ap) {
    float avgTransmittance = (ap.transmittance.r + ap.transmittance.g + ap.transmittance.b) / 3.0;
    return baseColor * avgTransmittance + ap.inscatter;
}

vec3 ap_applyWithBlend(vec3 baseColor, AerialPerspectiveResult ap, float blend) {
    vec3 withAP = ap_apply(baseColor, ap);
    return mix(baseColor, withAP, blend);
}
`;

export function getAerialPerspectiveWGSL() {
    return AERIAL_PERSPECTIVE_WGSL;
}

export function getAerialPerspectiveGLSL() {
    return AERIAL_PERSPECTIVE_GLSL;
}
