export function getClusteredLightingWGSL() {
    return /* wgsl */`
// ═══════════════════════════════════════════════════════════════════════════
// Clustered Forward Lighting — group(3) bindings 1-4
// ═══════════════════════════════════════════════════════════════════════════

struct ClLight {
    position:   vec3<f32>,
    radius:     f32,
    color:      vec3<f32>,
    intensity:  f32,
    direction:  vec3<f32>,
    lightType:  f32,
    angle:      f32,
    penumbra:   f32,
    decay:      f32,
    castShadow: f32,
}

struct ClCluster {
    lightCount:  u32,
    lightOffset: u32,
    _pad0:       u32,
    _pad1:       u32,
}

struct ClParams {
    dims:          vec3<f32>,
    numLights:     f32,
    near:          f32,
    far:           f32,
    maxPerCluster: f32,
    _pad:          f32,
    invTanHalfFovX: f32,
    invTanHalfFovY: f32,
    _pad2:          f32,
    _pad3:          f32,
    // 4 more reserved floats (total 16 = 64 bytes)
    _r0: f32, _r1: f32, _r2: f32, _r3: f32,
}

@group(3) @binding(1) var<storage, read> clLights:   array<ClLight>;
@group(3) @binding(2) var<storage, read> clClusters: array<ClCluster>;
@group(3) @binding(3) var<storage, read> clIndices:  array<u32>;
@group(3) @binding(4) var<uniform>       clParams:   ClParams;

fn cl_getClusterIndex(viewPos: vec3<f32>) -> i32 {
    let vz = -viewPos.z;
    if (vz <= 0.0 || vz >= clParams.far) { return -1; }

    // Depth slice (logarithmic)
    let logRatio = log(max(vz, clParams.near) / clParams.near);
    let logRange = log(clParams.far / clParams.near);
    let iz = u32(clamp(
        logRatio / logRange * clParams.dims.z,
        0.0, clParams.dims.z - 1.0
    ));

    // Screen-space XY: project view position to NDC
    // Use simple perspective divide — assumes symmetric frustum
    let projX = viewPos.x / (-viewPos.z);
    let projY = viewPos.y / (-viewPos.z);

    // projX/projY are in [-tan(fovX/2), +tan(fovX/2)] range
    // Map to [0, dims.x] / [0, dims.y] using NDC normalization
    // We normalize to [-1,1] by clamping with a generous range
    let ndcX = clamp(viewPos.x / (-viewPos.z) * clParams.invTanHalfFovX, -1.0, 1.0);
    let ndcY = clamp(viewPos.y / (-viewPos.z) * clParams.invTanHalfFovY, -1.0, 1.0);
    
    let ix = u32(clamp(
        (ndcX * 0.5 + 0.5) * clParams.dims.x,
        0.0, clParams.dims.x - 1.0
    ));
    let iy = u32(clamp(
        (ndcY * 0.5 + 0.5) * clParams.dims.y,
        0.0, clParams.dims.y - 1.0
    ));

    return i32(iz * u32(clParams.dims.x * clParams.dims.y)
             + iy * u32(clParams.dims.x)
             + ix);
}

fn cl_pointLight(
    L:        ClLight,
    worldPos: vec3<f32>,
    N:        vec3<f32>,
    albedo:   vec3<f32>
) -> vec3<f32> {
    let toLight = L.position - worldPos;
    let dist2   = dot(toLight, toLight);
    if (dist2 > L.radius * L.radius) { return vec3<f32>(0.0); }

    let dist    = sqrt(dist2);
    let lightDir = toLight / max(dist, 0.0001);
    let NdotL   = max(dot(N, lightDir), 0.0);
    var atten   = 1.0 / (1.0 + L.decay * dist2);
    let fade    = L.radius * 0.8;
    if (dist > fade) {
        atten *= 1.0 - smoothstep(fade, L.radius, dist);
    }
    return albedo * L.color * L.intensity * NdotL * atten;
}

fn cl_spotLight(
    L:        ClLight,
    worldPos: vec3<f32>,
    N:        vec3<f32>,
    albedo:   vec3<f32>
) -> vec3<f32> {
    let toLight  = L.position - worldPos;
    let dist     = length(toLight);
    if (dist > L.radius) { return vec3<f32>(0.0); }

    let lightDir = toLight / max(dist, 0.0001);
    let cosAngle = dot(-lightDir, normalize(L.direction));
    let outerCos = cos(L.angle);
    if (cosAngle < outerCos) { return vec3<f32>(0.0); }

    let innerCos = cos(L.angle * (1.0 - L.penumbra));
    let spot     = smoothstep(outerCos, innerCos, cosAngle);
    let NdotL    = max(dot(N, lightDir), 0.0);
    var atten    = 1.0 / (1.0 + L.decay * dist * dist);
    atten       *= 1.0 - smoothstep(L.radius * 0.75, L.radius, dist);
    return albedo * L.color * L.intensity * NdotL * atten * spot;
}

fn evaluateClusteredLights(
    worldPos: vec3<f32>,
    viewPos:  vec3<f32>,
    normal:   vec3<f32>,
    albedo:   vec3<f32>
) -> vec3<f32> {
    var total = vec3<f32>(0.0);
    if (clParams.numLights < 0.5) { return total; }

    let ci = cl_getClusterIndex(viewPos);
    if (ci < 0) { return total; }

    let cluster = clClusters[u32(ci)];
    let count   = min(cluster.lightCount, u32(clParams.maxPerCluster));

    for (var i = 0u; i < count; i++) {
        let li = clIndices[cluster.lightOffset + i];
        if (li >= u32(clParams.numLights)) { continue; }
        let L = clLights[li];
        if      (L.lightType < 0.5) { /* directional: handled by sun */ }
        else if (L.lightType < 1.5) { total += cl_pointLight(L, worldPos, normal, albedo); }
        else if (L.lightType < 2.5) { total += cl_spotLight (L, worldPos, normal, albedo); }
    }
    return total;
}
`;
}