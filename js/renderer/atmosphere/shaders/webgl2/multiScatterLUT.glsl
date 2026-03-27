#version 300 es
precision highp float;

uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uRayleighScattering;
uniform float uMieScattering;
uniform float uRayleighScaleHeight;
uniform float uMieScaleHeight;
uniform float uMieAnisotropy;
uniform sampler2D uTransmittanceLUT;

in vec2 vUv;
out vec4 fragColor;

const float PI = 3.14159265359;
const int ANGLE_SAMPLES = 16;

float getDensityRayleigh(float altitude) {
    return exp(-max(0.0, altitude) / uRayleighScaleHeight);
}

float getDensityMie(float altitude) {
    return exp(-max(0.0, altitude) / uMieScaleHeight);
}

float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 / (4.0 * PI)) * (1.0 - g2) / pow(denom, 1.5);
}

vec2 transmittanceUVFromAltitudeAndCosTheta(float altitude, float cosTheta) {
    float H = sqrt(uAtmosphereRadius * uAtmosphereRadius -
                   uPlanetRadius * uPlanetRadius);

    float r = uPlanetRadius + altitude;
    float rho = sqrt(max(0.0, r * r - uPlanetRadius * uPlanetRadius));

    float u = rho / H;

    float dMin = uAtmosphereRadius - r;
    float dMax = rho + H;
    // Match transmittance LUT mapping (v encodes distance to top of atmosphere).
    float cosT = clamp(cosTheta, -1.0, 1.0);
    float disc = max(0.0, r * r * cosT * cosT + uAtmosphereRadius * uAtmosphereRadius - r * r);
    float d = -r * cosT + sqrt(disc);

    float v = (d - dMin) / (dMax - dMin);

    return vec2(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

vec3 sampleTransmittance(float altitude, float cosTheta) {
    vec2 uv = transmittanceUVFromAltitudeAndCosTheta(altitude, cosTheta);
    return texture(uTransmittanceLUT, uv).rgb;
}

vec3 computeMultiScatter(float altitude, float cosSunZenith) {
    float rayleighDensity = getDensityRayleigh(altitude);
    float mieDensity = getDensityMie(altitude);

    vec3 rayleighScatter = uRayleighScattering * rayleighDensity;
    vec3 mieScatter = vec3(uMieScattering) * mieDensity;
    vec3 totalScatter = rayleighScatter + mieScatter;

    vec3 multiScatterSum = vec3(0.0);

    for (int i = 0; i < ANGLE_SAMPLES; i++) {
        float theta = (float(i) + 0.5) / float(ANGLE_SAMPLES) * PI;
        float cosTheta = cos(theta);
        float sinTheta = sin(theta);

        vec3 transmittance = sampleTransmittance(altitude, cosTheta);

        float rayleighPhaseValue = rayleighPhase(cosSunZenith);
        float miePhaseValue = miePhase(cosSunZenith, uMieAnisotropy);

        vec3 phaseWeighted = rayleighScatter * rayleighPhaseValue +
                             mieScatter * miePhaseValue;

        multiScatterSum += transmittance * phaseWeighted * sinTheta;
    }

    float solidAngleStep = (2.0 * PI) / float(ANGLE_SAMPLES);
    return multiScatterSum * solidAngleStep;
}

void main() {
    float atmosphereHeight = uAtmosphereRadius - uPlanetRadius;
    float altitude = vUv.y * atmosphereHeight;
    float cosSunZenith = vUv.x * 2.0 - 1.0;

    vec3 multiScatter = computeMultiScatter(altitude, cosSunZenith);

    fragColor = vec4(multiScatter, 1.0);
}
