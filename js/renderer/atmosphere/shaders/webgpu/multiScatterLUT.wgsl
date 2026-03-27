struct AtmosphereUniforms {
    planetRadius: f32,
    atmosphereRadius: f32,
    rayleighScaleHeight: f32,
    mieScaleHeight: f32,

    rayleighScattering: vec3<f32>,
    mieScattering: f32,

    ozoneAbsorption: vec3<f32>,
    mieAnisotropy: f32,

    textureSize: vec2<f32>,
    _pad1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> atmo: AtmosphereUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var transmittanceLUT: texture_2d<f32>;
@group(0) @binding(3) var transmittanceSampler: sampler;

const PI: f32 = 3.14159265359;
const ANGLE_SAMPLES: i32 = 16;

fn getDensityRayleigh(altitude: f32) -> f32 {
    return exp(-max(0.0, altitude) / atmo.rayleighScaleHeight);
}

fn getDensityMie(altitude: f32) -> f32 {
    return exp(-max(0.0, altitude) / atmo.mieScaleHeight);
}

fn rayleighPhase(cosTheta: f32) -> f32 {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

fn miePhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 / (4.0 * PI)) * (1.0 - g2) / pow(denom, 1.5);
}

fn transmittanceUVFromAltitudeAndCosTheta(altitude: f32, cosTheta: f32) -> vec2<f32> {
    let H = sqrt(atmo.atmosphereRadius * atmo.atmosphereRadius -
                 atmo.planetRadius * atmo.planetRadius);

    let r = atmo.planetRadius + altitude;
    let rho = sqrt(max(0.0, r * r - atmo.planetRadius * atmo.planetRadius));

    let u = rho / H;

    let dMin = atmo.atmosphereRadius - r;
    let dMax = rho + H;
    // Match transmittance LUT mapping (uv.y encodes distance to top of atmosphere).
    let cosT = clamp(cosTheta, -1.0, 1.0);
    let disc = max(0.0, r * r * cosT * cosT + atmo.atmosphereRadius * atmo.atmosphereRadius - r * r);
    let d = -r * cosT + sqrt(disc);

    let v = (d - dMin) / (dMax - dMin);

    return vec2<f32>(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

fn sampleTransmittance(altitude: f32, cosTheta: f32) -> vec3<f32> {
    let uv = transmittanceUVFromAltitudeAndCosTheta(altitude, cosTheta);
    return textureSampleLevel(transmittanceLUT, transmittanceSampler, uv, 0.0).rgb;
}

fn computeMultiScatter(altitude: f32, cosSunZenith: f32) -> vec3<f32> {
    let rayleighDensity = getDensityRayleigh(altitude);
    let mieDensity = getDensityMie(altitude);

    let rayleighScatter = atmo.rayleighScattering * rayleighDensity;
    let mieScatter = vec3<f32>(atmo.mieScattering) * mieDensity;
    let totalScatter = rayleighScatter + mieScatter;

    var multiScatterSum = vec3<f32>(0.0);

    for (var i = 0; i < ANGLE_SAMPLES; i++) {
        let theta = (f32(i) + 0.5) / f32(ANGLE_SAMPLES) * PI;
        let cosTheta = cos(theta);
        let sinTheta = sin(theta);

        let transmittance = sampleTransmittance(altitude, cosTheta);

        let rayleighPhaseValue = rayleighPhase(cosSunZenith);
        let miePhaseValue = miePhase(cosSunZenith, atmo.mieAnisotropy);

        let phaseWeighted = rayleighScatter * rayleighPhaseValue +
                           mieScatter * miePhaseValue;

        multiScatterSum += transmittance * phaseWeighted * sinTheta;
    }

    let solidAngleStep = (2.0 * PI) / f32(ANGLE_SAMPLES);
    return multiScatterSum * solidAngleStep;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let texSize = vec2<u32>(u32(atmo.textureSize.x), u32(atmo.textureSize.y));

    if (id.x >= texSize.x || id.y >= texSize.y) {
        return;
    }

    let uv = vec2<f32>(
        (f32(id.x) + 0.5) / f32(texSize.x),
        (f32(id.y) + 0.5) / f32(texSize.y)
    );

    let atmosphereHeight = atmo.atmosphereRadius - atmo.planetRadius;
    let altitude = uv.y * atmosphereHeight;
    let cosSunZenith = uv.x * 2.0 - 1.0;

    let multiScatter = computeMultiScatter(altitude, cosSunZenith);

    textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(multiScatter, 1.0));
}
