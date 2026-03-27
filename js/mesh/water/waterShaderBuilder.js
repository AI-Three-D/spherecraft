export function buildWaterVertexShader() {
  return `
precision highp float;
uniform float time;
uniform float waveHeight;
uniform float waveFrequency;
uniform vec2  windDirection;
uniform float windSpeed;
uniform vec2  chunkSeed;

varying vec2  vUv;
varying vec3  vNormal;
varying vec3  vWorldPosition;
varying vec3  vViewPosition;
varying float vWaveHeight;
varying float vDistanceToCamera;
varying vec2  vWindDirWorld;
varying float vWavePhase;

vec2 warp(vec2 p, float t){
float w1 = sin(dot(p, vec2(0.11, 0.07)) * 0.7 + t * 0.15);
float w2 = sin(dot(p, vec2(-0.09, 0.13)) * 0.8 - t * 0.12);
return vec2(w1, w2) * 0.75;
}

vec3 waveOffset(vec3 worldPos, float t) {
    vec2 dir1 = normalize(windDirection);
    vec2 dir2 = normalize(vec2(-dir1.y, dir1.x));
    vec2 dir3 = normalize(dir1 + dir2 * 0.5);

    float a1 = waveHeight;
    float a2 = a1 * 0.6;
    float a3 = a1 * 0.4;

    float f1 = waveFrequency;
    float f2 = f1 * 0.72;
    float f3 = f1 * 1.33;

    // SCALE DOWN windSpeed to reasonable animation speed
    // Map windSpeed (0-25) to animation speed (1-4)
    float animSpeed = 1.0 + (windSpeed / 25.0) * 3.0;  // Range: 1.0 to 4.0
    float s1 = animSpeed * 0.8;  // Slow base speed
    float s2 = s1 * 0.8;
    float s3 = s1 * 1.2;

    vec2 xz = worldPos.xz + warp(worldPos.xz * 0.05, t);

    float p1 = dot(xz, dir1) * f1 - t * s1;
    float p2 = dot(xz, dir2) * f2 - t * s2;
    float p3 = dot(xz, dir3) * f3 - t * s3;

    float baseY = a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);

    float chop = sin(dot(xz, vec2(0.01, 0.013)) + t * 3.0) * 0.15 +
                 sin(dot(xz, vec2(0.021, 0.009)) - t * 2.7) * 0.08;

    return vec3(0.0, baseY + waveHeight * chop, p1);
}

void main() {
vUv = uv;

vec4 worldPos = modelMatrix * vec4(position, 1.0);

vec3 off = waveOffset(worldPos.xyz, time);
worldPos.xyz += vec3(off.x, off.y, 0.0);
vWaveHeight = off.y;
vWavePhase = off.z;

vWorldPosition = worldPos.xyz;
vNormal = normalize(mat3(modelMatrix) * normal);

vec4 viewPos = viewMatrix * worldPos;
vViewPosition = viewPos.xyz;
vDistanceToCamera = length(vViewPosition);

vWindDirWorld = windDirection;

gl_Position = projectionMatrix * viewPos;
}
  `;
}

export function buildWaterFragmentShader() {
  return `
precision highp float;

uniform vec3  waterColorShallow;
uniform vec3  waterColorDeep;

uniform float shallowAlpha;
uniform float deepAlpha;
uniform float depthRange;
uniform float waterLevel;
uniform float waveHeight;

uniform sampler2D terrainHeightMap;
uniform vec2      terrainSize;
uniform vec2      terrainOffset;
uniform float     heightScale;

uniform sampler2D foamTexture;
uniform float     foamTiling;
uniform float     foamIntensity;
uniform float     foamDepthStart;
uniform float     foamDepthEnd;

uniform vec3  fogColor;
uniform float fogDensity;
uniform float weatherIntensity;
uniform float currentWeather;
uniform vec3  sunLightDirection;
uniform vec3  sunLightColor;
uniform float sunLightIntensity;
uniform vec3  ambientLightColor;
uniform float ambientLightIntensity;

uniform vec2  windDirection;
uniform float windSpeed;

varying vec2  vUv;
varying vec3  vNormal;
varying vec3  vWorldPosition;
varying vec3  vViewPosition;
varying float vWaveHeight;
varying float vDistanceToCamera;
varying vec2  vWindDirWorld;
varying float vWavePhase;

float sampleTerrainHeight(vec2 worldXZ) {
vec2 uv = (worldXZ - terrainOffset) / terrainSize;
uv = clamp(uv, 0.0, 1.0);
return texture2D(terrainHeightMap, uv).r * heightScale;
}

vec2 getShorelineNormal(vec2 worldXZ) {
float offset = 0.5;
float hL = sampleTerrainHeight(worldXZ + vec2(-offset, 0.0));
float hR = sampleTerrainHeight(worldXZ + vec2(offset, 0.0));
float hD = sampleTerrainHeight(worldXZ + vec2(0.0, -offset));
float hU = sampleTerrainHeight(worldXZ + vec2(0.0, offset));

// Gradient points uphill (away from water, toward land)
vec2 gradient = vec2(hR - hL, hU - hD);
return length(gradient) > 0.001 ? normalize(gradient) : vec2(0.0, 0.0);
}

void main() {
vec3 N = normalize(vNormal);
vec3 L = normalize(sunLightDirection);
vec3 V = normalize(cameraPosition - vWorldPosition);
vec3 H = normalize(L + V);

float NdotL = max(dot(N, L), 0.0);
float NdotH = max(dot(N, H), 0.0);
float spec   = pow(NdotH, 64.0);

float shade = clamp(0.5 + vWaveHeight * 0.2, 0.0, 1.0);
vec3 baseWater = mix(waterColorDeep, waterColorShallow, shade);

vec3 diffuse  = baseWater * (ambientLightColor * ambientLightIntensity
                           + sunLightColor * NdotL * sunLightIntensity);
vec3 specular = sunLightColor * spec * 0.3;

float terrainH = sampleTerrainHeight(vWorldPosition.xz);
float surfaceH = waterLevel + vWaveHeight;
float depth = max(0.0, surfaceH - terrainH);

float t = clamp(depth / max(depthRange, 0.0001), 0.0, 1.0);
float alpha = mix(shallowAlpha, deepAlpha, t);
float distanceFade = smoothstep(70.0, 120.0, vDistanceToCamera);
alpha = mix(alpha, 1.0, distanceFade);  // Blend to fully opaque at distance

// === SIMPLIFIED FOAM - CONSTANT WHEN WIND APPROACHES SHORE ===

// 1. Get shoreline direction
vec2 shoreNormal = getShorelineNormal(vWorldPosition.xz);
float shoreNormalLength = length(shoreNormal);

// Only calculate foam if we have a valid shore gradient
float foam = 0.0;

if (shoreNormalLength > 0.001) {
  vec2 normalizedShoreNormal = normalize(shoreNormal);
  vec2 normalizedWind = normalize(vWindDirWorld);
  
  // Check if wind is blowing toward shore (not away)
  float windToShoreAlignment = dot(normalizedWind, normalizedShoreNormal);
  
  // Foam appears when wind has any component toward shore
  float windApproachingShore = smoothstep(-0.3, 0.4, windToShoreAlignment);
  
  // 2. Wave strength (bigger waves = more foam)
  float normalizedWaveHeight = (vWaveHeight + waveHeight) / (2.0 * waveHeight);
  float waveStrength = smoothstep(0.2, 0.85, normalizedWaveHeight);
  
  // 3. Depth-based foam distribution (fades with depth)
  float foamDepth = smoothstep(foamDepthEnd, foamDepthStart, depth);
  
  // 4. Sample foam texture with variation
  vec2 foamUV1 = vWorldPosition.xz * foamTiling;
  vec2 foamUV2 = vWorldPosition.xz * foamTiling * 1.7 + vec2(0.3, 0.7);
  float foamNoise1 = texture2D(foamTexture, foamUV1).r;
  float foamNoise2 = texture2D(foamTexture, foamUV2).r;
  float foamNoise = mix(foamNoise1, foamNoise2, 0.5);
  
  // Add local variation
  float localVariation = sin(vWorldPosition.x * 0.3) * sin(vWorldPosition.z * 0.3) * 0.5 + 0.5;
  foamNoise = mix(foamNoise, foamNoise * localVariation, 0.3);
  
  // 5. CONSTANT FOAM (no wave phase dependency)
  // Foam is simply: depth-based * wind-approaching * wave-strength * texture
  float baselineFoam = foamDepth * windApproachingShore * waveStrength * foamNoise * foamIntensity;
  
  // 6. Extra boost in very shallow water
  if (depth < 0.8 && waveStrength > 0.3) {
    baselineFoam += waveStrength * windApproachingShore * 0.4 * foamNoise;
  }
  
  // 7. Add random foam streaks in shallow areas
  float streakNoise = fract(sin(dot(vWorldPosition.xz, vec2(12.9898, 78.233))) * 43758.5453);
  if (depth < 2.0 && streakNoise > 0.93 && waveStrength > 0.4) {
    baselineFoam += 0.25;
  }
  
  foam = clamp(baselineFoam, 0.0, 1.0);
}

vec3 color = diffuse + specular;
color = mix(color, vec3(1.0), foam);

alpha = max(alpha, foam * 0.5);
alpha = clamp(alpha, 0.0, 1.0);

float fogF = 1.0 - exp(-fogDensity * vDistanceToCamera);
if (currentWeather >= 1.0) {
  fogF = mix(fogF, min(fogF * 1.5, 1.0), weatherIntensity);
}
if (currentWeather >= 3.0) {
  fogF = mix(fogF, min(fogF * 3.0, 1.0), weatherIntensity);
}
color = mix(color, fogColor, clamp(fogF, 0.0, 1.0));

gl_FragColor = vec4(color, alpha);
}`;
}