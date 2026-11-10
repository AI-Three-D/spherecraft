
export function getClusteredLightingModule(maxLightIndices = 8192) {
    return `
#ifndef MAX_LIGHTS_PER_CLUSTER
    #define MAX_LIGHTS_PER_CLUSTER 32
#endif
#ifndef MAX_LIGHT_INDICES
    #define MAX_LIGHT_INDICES ${maxLightIndices}
#endif

uniform vec3 cameraPosition;
uniform vec3 clusterDimensions;
uniform sampler2D clusterDataTexture;
uniform sampler2D lightDataTexture;
uniform sampler2D lightIndicesTexture;
uniform float numLights;
uniform float maxLightsPerCluster;
uniform float cameraNear;
uniform float cameraFar;
uniform mat4 projectionMatrix;

struct ClusteredLight {
    vec3 position;
    float radius;
    vec3 color;
    float intensity;
    vec3 direction;
    float lightType;
    float angle;
    float penumbra;
    float decay;
    float castShadow;
};

int getClusterIndex(vec3 viewPos) {
    float viewZ = -viewPos.z;
    
    if (viewZ <= 0.0) return -1;
    if (viewZ <= cameraNear) return 0;
    if (viewZ >= cameraFar) return -1;
    
    vec4 clipPos = projectionMatrix * vec4(viewPos, 1.0);
    
    if (clipPos.w <= 0.0) return -1;
    
    vec3 ndc = clipPos.xyz / clipPos.w;
    
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return -1;
    
    vec2 clusterXY = (ndc.xy * 0.5 + 0.5) * clusterDimensions.xy;
    
    float logDepth = log(viewZ / cameraNear) / log(cameraFar / cameraNear);
    float clusterZ = clamp(logDepth * clusterDimensions.z, 0.0, clusterDimensions.z - 1.0);
    
    ivec3 cluster = ivec3(
        clamp(floor(clusterXY.x), 0.0, clusterDimensions.x - 1.0),
        clamp(floor(clusterXY.y), 0.0, clusterDimensions.y - 1.0),
        floor(clusterZ)
    );
    
    return cluster.z * int(clusterDimensions.x * clusterDimensions.y) + 
           cluster.y * int(clusterDimensions.x) + 
           cluster.x;
}

ClusteredLight fetchClusteredLight(int lightIndex) {
    ClusteredLight light;
    
    int basePixel = lightIndex * 4;
    float texWidth = max(1.0, numLights * 4.0);
    
    vec4 data0 = texture(lightDataTexture, vec2((float(basePixel) + 0.5) / texWidth, 0.5));
    vec4 data1 = texture(lightDataTexture, vec2((float(basePixel) + 1.5) / texWidth, 0.5));
    vec4 data2 = texture(lightDataTexture, vec2((float(basePixel) + 2.5) / texWidth, 0.5));
    vec4 data3 = texture(lightDataTexture, vec2((float(basePixel) + 3.5) / texWidth, 0.5));
    
    light.position = data0.xyz;
    light.radius = data0.w;
    light.color = data1.xyz;
    light.intensity = data1.w;
    light.direction = data2.xyz;
    light.lightType = data2.w;
    light.angle = data3.x;
    light.penumbra = data3.y;
    light.decay = data3.z;
    light.castShadow = data3.w;
    
    return light;
}

vec3 calculatePointLight(
    ClusteredLight light,
    vec3 worldPos,
    vec3 normal,
    vec3 viewDir,
    vec3 albedo
) {
    vec3 toLight = light.position - worldPos;
    float distanceSq = dot(toLight, toLight);
    float radiusSq = light.radius * light.radius;
    
    if (distanceSq > radiusSq) return vec3(0.0);
    
    float distance = sqrt(distanceSq);
    vec3 lightDir = toLight / distance;
    
    float NdL = max(dot(normal, lightDir), 0.0);
    
    float attenuation = 1.0 / (1.0 + light.decay * distanceSq);
    
    float fadeStart = light.radius * 0.8;
    if (distance > fadeStart) {
        attenuation *= 1.0 - smoothstep(fadeStart, light.radius, distance);
    }
    
    return albedo * light.color * light.intensity * NdL * attenuation;
}

vec3 calculateSpotLight(
    ClusteredLight light,
    vec3 worldPos,
    vec3 normal,
    vec3 viewDir,
    vec3 albedo
) {
    vec3 toLight = light.position - worldPos;
    float distance = length(toLight);
    
    if (distance > light.radius) return vec3(0.0);
    
    vec3 lightDir = normalize(toLight);
    
    float cosAngle = dot(-lightDir, normalize(light.direction));
    float outerCone = cos(light.angle);
    
    if (cosAngle < outerCone) return vec3(0.0);
    
    float NdL = max(dot(normal, lightDir), 0.0);
    
    vec3 halfDir = normalize(lightDir + viewDir);
    float NdH = max(dot(normal, halfDir), 0.0);
    float specular = pow(NdH, 32.0) * 0.25;
    
    float attenuation = 1.0 / (1.0 + light.decay * distance * distance);
    float fadeStart = light.radius * 0.75;
    attenuation *= 1.0 - smoothstep(fadeStart, light.radius, distance);
    
    float innerCone = cos(light.angle * (1.0 - light.penumbra));
    float coneAttenuation = smoothstep(outerCone, innerCone, cosAngle);
    
    vec3 diffuse = albedo * NdL;
    vec3 spec = vec3(specular);
    
    return (diffuse + spec) * light.color * light.intensity * attenuation * coneAttenuation;
}

vec3 evaluateClusteredLights(
    vec3 worldPos,
    vec3 viewPos,
    vec3 normal,
    vec3 albedo
) {
    vec3 totalLight = vec3(0.0);
    
    int clusterIndex = getClusterIndex(viewPos);
    
    if (clusterIndex < 0) return totalLight;

    vec3 viewDir = normalize(cameraPosition - worldPos);
    
    float clusterTexWidth = clusterDimensions.x * clusterDimensions.y * clusterDimensions.z;
    vec4 clusterData = texture(
        clusterDataTexture, 
        vec2((float(clusterIndex) + 0.5) / clusterTexWidth, 0.5)
    );
    
    int lightCount = min(int(clusterData.r), MAX_LIGHTS_PER_CLUSTER);
    int lightOffset = int(clusterData.g);
    
    for (int i = 0; i < MAX_LIGHTS_PER_CLUSTER; i++) {
        if (i >= lightCount) break;
        
        float indexTexCoord = (float(lightOffset + i) + 0.5) / float(MAX_LIGHT_INDICES);
        float lightIndexF = texture(lightIndicesTexture, vec2(indexTexCoord, 0.5)).r;
        int lightIndex = int(lightIndexF + 0.5);
        
        if (lightIndex < 0 || lightIndex >= int(numLights)) continue;
        
        ClusteredLight light = fetchClusteredLight(lightIndex);
        
        if (light.lightType < 0.5) {
        } else if (light.lightType < 1.5) {
            totalLight += calculatePointLight(light, worldPos, normal, viewDir, albedo);
        } else if (light.lightType < 2.5) {
            totalLight += calculateSpotLight(light, worldPos, normal, viewDir, albedo);
        }
    }
    
    return totalLight;
}
`;
}