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
    dims:           vec3<f32>,
    numLights:      f32,
    near:           f32,
    far:            f32,
    maxPerCluster:  f32,
    _pad:           f32,
    invTanHalfFovX: f32,
    invTanHalfFovY: f32,
    _pad2:          f32,
    _pad3:          f32,
    _r0: f32, _r1: f32, _r2: f32, _r3: f32,
}

@group(3) @binding(1) var<storage, read> clLights:   array<ClLight>;
@group(3) @binding(2) var<storage, read> clClusters: array<ClCluster>;
@group(3) @binding(3) var<storage, read> clIndices:  array<u32>;
@group(3) @binding(4) var<uniform>       clParams:   ClParams;

struct ClCoord {
    ix0: u32,
    iy0: u32,
    ix1: u32,
    iy1: u32,
    iz:  u32,
    tx:  f32,
    ty:  f32,
    valid: bool,
}

fn cl_getFlatIndex(ix: u32, iy: u32, iz: u32) -> u32 {
    let dimX = u32(clParams.dims.x);
    let dimY = u32(clParams.dims.y);
    return iz * (dimX * dimY) + iy * dimX + ix;
}

fn cl_getInterpolatedCoord(viewPos: vec3<f32>) -> ClCoord {
    let vz = -viewPos.z;

    if (vz <= 0.0 || vz >= clParams.far) {
        return ClCoord(0u, 0u, 0u, 0u, 0u, 0.0, 0.0, false);
    }

    let dimXf = clParams.dims.x;
    let dimYf = clParams.dims.y;
    let dimZf = clParams.dims.z;

    // Logarithmic Z slice, still discrete for now
    let logRatio = log(max(vz, clParams.near) / clParams.near);
    let logRange = log(clParams.far / clParams.near);
    let zf = clamp(logRatio / logRange * dimZf, 0.0, dimZf - 1.0);
    let iz = u32(floor(zf));

    // Continuous NDC XY
    let ndcX = clamp(viewPos.x / (-viewPos.z) * clParams.invTanHalfFovX, -1.0, 1.0);
    let ndcY = clamp(viewPos.y / (-viewPos.z) * clParams.invTanHalfFovY, -1.0, 1.0);

    // Map to continuous cluster coordinates in [0, dims-1]
    let gx = clamp((ndcX * 0.5 + 0.5) * dimXf - 0.5, 0.0, dimXf - 1.0);
    let gy = clamp((ndcY * 0.5 + 0.5) * dimYf - 0.5, 0.0, dimYf - 1.0);

    let x0f = floor(gx);
    let y0f = floor(gy);
    let x1f = min(x0f + 1.0, dimXf - 1.0);
    let y1f = min(y0f + 1.0, dimYf - 1.0);

    let tx = fract(gx);
    let ty = fract(gy);

    return ClCoord(
        u32(x0f), u32(y0f),
        u32(x1f), u32(y1f),
        iz,
        tx, ty,
        true
    );
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

    let dist     = sqrt(dist2);
    let lightDir = toLight / max(dist, 0.0001);
    let NdotL    = max(dot(N, lightDir), 0.0);

    var atten = 1.0 / (1.0 + L.decay * dist2);
    let fade  = L.radius * 0.8;
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

    var atten = 1.0 / (1.0 + L.decay * dist * dist);
    atten *= 1.0 - smoothstep(L.radius * 0.75, L.radius, dist);

    return albedo * L.color * L.intensity * NdotL * atten * spot;
}

fn cl_evalCluster(
    clusterIndex: u32,
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>
) -> vec3<f32> {
    var total = vec3<f32>(0.0);

    let cluster = clClusters[clusterIndex];
    let count   = min(cluster.lightCount, u32(clParams.maxPerCluster));

    for (var i = 0u; i < count; i++) {
        let li = clIndices[cluster.lightOffset + i];
        if (li >= u32(clParams.numLights)) { continue; }

        let L = clLights[li];

        if (L.lightType < 0.5) {
            // directional handled elsewhere
        } else if (L.lightType < 1.5) {
            total += cl_pointLight(L, worldPos, normal, albedo);
        } else if (L.lightType < 2.5) {
            total += cl_spotLight(L, worldPos, normal, albedo);
        }
    }

    return total;
}

fn evaluateClusteredLights(
    worldPos: vec3<f32>,
    viewPos:  vec3<f32>,
    normal:   vec3<f32>,
    albedo:   vec3<f32>
) -> vec3<f32> {
    if (clParams.numLights < 0.5) {
        return vec3<f32>(0.0);
    }

    let cc = cl_getInterpolatedCoord(viewPos);
    if (!cc.valid) {
        return vec3<f32>(0.0);
    }

    let c00 = cl_getFlatIndex(cc.ix0, cc.iy0, cc.iz);
    let c10 = cl_getFlatIndex(cc.ix1, cc.iy0, cc.iz);
    let c01 = cl_getFlatIndex(cc.ix0, cc.iy1, cc.iz);
    let c11 = cl_getFlatIndex(cc.ix1, cc.iy1, cc.iz);

    let w00 = (1.0 - cc.tx) * (1.0 - cc.ty);
    let w10 =        cc.tx  * (1.0 - cc.ty);
    let w01 = (1.0 - cc.tx) *        cc.ty;
    let w11 =        cc.tx  *        cc.ty;

    var total = vec3<f32>(0.0);
    total += cl_evalCluster(c00, worldPos, normal, albedo) * w00;
    total += cl_evalCluster(c10, worldPos, normal, albedo) * w10;
    total += cl_evalCluster(c01, worldPos, normal, albedo) * w01;
    total += cl_evalCluster(c11, worldPos, normal, albedo) * w11;

    return total;
}
`;
}