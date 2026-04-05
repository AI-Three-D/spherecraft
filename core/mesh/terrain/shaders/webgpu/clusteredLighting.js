export function getClusteredLightingModule(maxLightIndices = 8192) {
    return `


struct ClusteredLight {
    position: vec3<f32>,
    radius: f32,
    color: vec3<f32>,
    intensity: f32,
    direction: vec3<f32>,
    lightType: f32,
    angle: f32,
    penumbra: f32,
    decay: f32,
    castShadow: f32,
}

fn getClusterIndex(viewPos: vec3<f32>) -> i32 {
    let viewZ = -viewPos.z;
    if (viewZ <= 0.0) { return -1; }
    if (viewZ <= fragUniforms.cameraNear) { return 0; }
    if (viewZ >= fragUniforms.cameraFar) { return -1; }

    let logDepth = log(viewZ / fragUniforms.cameraNear) / log(fragUniforms.cameraFar / fragUniforms.cameraNear);
    let clusterZ = clamp(logDepth * fragUniforms.clusterDimensions.z, 0.0, fragUniforms.clusterDimensions.z - 1.0);

    let cluster = vec3<i32>(
        i32(floor(fragUniforms.clusterDimensions.x * 0.5)),
        i32(floor(fragUniforms.clusterDimensions.y * 0.5)),
        i32(floor(clusterZ))
    );

    return cluster.z * i32(fragUniforms.clusterDimensions.x * fragUniforms.clusterDimensions.y) +
           cluster.y * i32(fragUniforms.clusterDimensions.x) +
           cluster.x;
}

fn fetchClusteredLight(lightIndex: i32) -> ClusteredLight {
    var light: ClusteredLight;
    let basePixel = lightIndex * 4;
    
    let data0 = textureLoad(lightDataTexture, vec2<i32>(basePixel + 0, 0), 0);
    let data1 = textureLoad(lightDataTexture, vec2<i32>(basePixel + 1, 0), 0);
    let data2 = textureLoad(lightDataTexture, vec2<i32>(basePixel + 2, 0), 0);
    let data3 = textureLoad(lightDataTexture, vec2<i32>(basePixel + 3, 0), 0);

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

fn calculatePointLightWGSL(light: ClusteredLight, worldPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>, albedo: vec3<f32>) -> vec3<f32> {
    let toLight = light.position - worldPos;
    let distanceSq = dot(toLight, toLight);
    let radiusSq = light.radius * light.radius;
    if (distanceSq > radiusSq) { return vec3<f32>(0.0); }

    let distance = sqrt(distanceSq);
    let lightDir = toLight / distance;
    let NdL = max(dot(normal, lightDir), 0.0);
    var attenuation = 1.0 / (1.0 + light.decay * distanceSq);

    let fadeStart = light.radius * 0.8;
    if (distance > fadeStart) {
        attenuation *= 1.0 - smoothstep(fadeStart, light.radius, distance);
    }

    return albedo * light.color * light.intensity * NdL * attenuation;
}

fn calculateSpotLightWGSL(light: ClusteredLight, worldPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>, albedo: vec3<f32>) -> vec3<f32> {
    let toLight = light.position - worldPos;
    let distance = length(toLight);
    if (distance > light.radius) { return vec3<f32>(0.0); }

    let lightDir = normalize(toLight);
    let cosAngle = dot(-lightDir, normalize(light.direction));
    let outerCone = cos(light.angle);
    if (cosAngle < outerCone) { return vec3<f32>(0.0); }

    let NdL = max(dot(normal, lightDir), 0.0);
    let halfDir = normalize(lightDir + viewDir);
    let NdH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdH, 32.0) * 0.25;

    var attenuation = 1.0 / (1.0 + light.decay * distance * distance);
    let fadeStart = light.radius * 0.75;
    attenuation *= 1.0 - smoothstep(fadeStart, light.radius, distance);

    let innerCone = cos(light.angle * (1.0 - light.penumbra));
    let coneAttenuation = smoothstep(outerCone, innerCone, cosAngle);

    let diffuse = albedo * NdL;
    let spec = vec3<f32>(specular);

    return (diffuse + spec) * light.color * light.intensity * attenuation * coneAttenuation;
}

fn evaluateClusteredLights(worldPos: vec3<f32>, viewPos: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>) -> vec3<f32> {
    var totalLight = vec3<f32>(0.0);
    let clusterIndex = getClusterIndex(viewPos);
    if (clusterIndex < 0) { return totalLight; }

    let viewDir = normalize(fragUniforms.cameraPosition - worldPos);

    let clusterData = textureLoad(clusterDataTexture, vec2<i32>(clusterIndex, 0), 0);

    let lightCount = min(i32(clusterData.r), MAX_LIGHTS_PER_CLUSTER);
    let lightOffset = i32(clusterData.g);

    for (var i = 0; i < MAX_LIGHTS_PER_CLUSTER; i++) {
        if (i >= lightCount) { break; }

        let lightIndexF = textureLoad(lightIndicesTexture, vec2<i32>(lightOffset + i, 0), 0).r;
        let lightIndex = i32(lightIndexF + 0.5);

        if (lightIndex < 0 || lightIndex >= i32(fragUniforms.numLights)) { continue; }

        let light = fetchClusteredLight(lightIndex);

        if (light.lightType < 0.5) {
            // Directional - skip
        } else if (light.lightType < 1.5) {
            totalLight += calculatePointLightWGSL(light, worldPos, normal, viewDir, albedo);
        } else if (light.lightType < 2.5) {
            totalLight += calculateSpotLightWGSL(light, worldPos, normal, viewDir, albedo);
        }
    }

    return totalLight;
}
`;
}