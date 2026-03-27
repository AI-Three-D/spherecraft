#version 300 es
precision highp float;

uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uRayleighScattering;
uniform float uMieScattering;
uniform float uRayleighScaleHeight;
uniform float uMieScaleHeight;
uniform vec3 uOzoneAbsorption;
uniform vec2 uTextureSize;

in vec2 vUv;
out vec4 fragColor;

const float PI = 3.14159265359;
const int TRANSMITTANCE_STEPS = 40;

vec2 raySphereIntersect(vec3 origin, vec3 dir, float radius) {
    float a = dot(dir, dir);
    float b = 2.0 * dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float d = b * b - 4.0 * a * c;
    
    if (d < 0.0) {
        return vec2(-1.0, -1.0);
    }
    
    float sqrtD = sqrt(d);
    return vec2(
        (-b - sqrtD) / (2.0 * a),
        (-b + sqrtD) / (2.0 * a)
    );
}

float getAltitude(vec3 pos) {
    return length(pos) - uPlanetRadius;
}

float getDensityRayleigh(float altitude) {
    return exp(-max(0.0, altitude) / uRayleighScaleHeight);
}

float getDensityMie(float altitude) {
    return exp(-max(0.0, altitude) / uMieScaleHeight);
}

float getDensityOzone(float altitude) {
    float ozoneCenter = 25000.0;
    float ozoneWidth = 15000.0;
    float x = (altitude - ozoneCenter) / ozoneWidth;
    return max(0.0, 1.0 - x * x);
}

vec2 uvToTransmittanceParams(vec2 uv) {
    float H = sqrt(uAtmosphereRadius * uAtmosphereRadius - 
                   uPlanetRadius * uPlanetRadius);
    
    float rho = H * uv.x;
    float r = sqrt(rho * rho + uPlanetRadius * uPlanetRadius);
    
    float dMin = uAtmosphereRadius - r;
    float dMax = rho + H;
    float d = dMin + uv.y * (dMax - dMin);
    
    float cosTheta;
    if (d == 0.0) {
        cosTheta = 1.0;
    } else {
        cosTheta = (H * H - rho * rho - d * d) / (2.0 * r * d);
    }
    cosTheta = clamp(cosTheta, -1.0, 1.0);
    
    return vec2(r - uPlanetRadius, cosTheta);
}

vec3 computeTransmittance(float altitude, float cosTheta) {
    float r = uPlanetRadius + altitude;
    vec3 origin = vec3(0.0, r, 0.0);
    
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    vec3 dir = vec3(sinTheta, cosTheta, 0.0);
    
    vec2 intersection = raySphereIntersect(origin, dir, uAtmosphereRadius);
    if (intersection.y < 0.0) {
        return vec3(1.0);
    }
    
    vec2 groundIntersect = raySphereIntersect(origin, dir, uPlanetRadius);
    float rayLength = intersection.y;
    if (groundIntersect.x > 0.0) {
        rayLength = min(rayLength, groundIntersect.x);
    }
    
    float stepSize = rayLength / float(TRANSMITTANCE_STEPS);
    
    vec3 opticalDepthRayleigh = vec3(0.0);
    float opticalDepthMie = 0.0;
    vec3 opticalDepthOzone = vec3(0.0);
    
    for (int i = 0; i < TRANSMITTANCE_STEPS; i++) {
        float t = (float(i) + 0.5) * stepSize;
        vec3 pos = origin + dir * t;
        float alt = getAltitude(pos);
        
        float densityR = getDensityRayleigh(alt);
        float densityM = getDensityMie(alt);
        float densityO = getDensityOzone(alt);
        
        opticalDepthRayleigh += uRayleighScattering * densityR * stepSize;
        opticalDepthMie += uMieScattering * densityM * stepSize;
        opticalDepthOzone += uOzoneAbsorption * densityO * stepSize;
    }
    
    vec3 totalOpticalDepth = opticalDepthRayleigh + vec3(opticalDepthMie) + opticalDepthOzone;
    return exp(-totalOpticalDepth);
}

void main() {
    vec2 params = uvToTransmittanceParams(vUv);
    float altitude = params.x;
    float cosTheta = params.y;
    
    vec3 transmittance = computeTransmittance(altitude, cosTheta);
    
    fragColor = vec4(transmittance, 1.0);
}