// js/renderer/streamer/shaders/leafRender.wgsl.js

export function buildLeafVertexShader(config = {}) {
    const enableWind = config.enableWind === true;

    return /* wgsl */`

const ENABLE_LEAF_WIND: bool = ${enableWind ? 'true' : 'false'};

struct LeafUniforms {
    viewMatrix:       mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    cameraPosition:   vec3<f32>,
    time:             f32,
    planetOrigin:     vec3<f32>,
    planetRadius:     f32,
    windDirection:    vec2<f32>,
    windStrength:     f32,
    windSpeed:        f32,
}

struct LeafInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    twigDirX: f32, twigDirY: f32, twigDirZ: f32, clusterVariant: f32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition:        vec4<f32>,
    @location(0) vUv:                       vec2<f32>,
    @location(1) vNormal:                   vec3<f32>,
    @location(2) vWorldPosition:            vec3<f32>,
    @location(3) vColor:                    vec4<f32>,
    @location(4) vDistanceToCamera:         f32,
    @location(5) vCluster:                  f32,
    @location(6) @interpolate(flat) vFlags: u32,
    @location(7) vDiagCardUpDotUp:          f32,
    // Tangent-space vectors for directional lighting (LOD 0/1)
    @location(8) vTangent:                  vec3<f32>,
    @location(9) vBitangent:                vec3<f32>,
    // UV in card-local space for procedural vein texture (LOD 0 only)
    @location(10) vCardUV:                  vec2<f32>,
    // Instance detail level (band index, flat)
    @location(11) @interpolate(flat) vBand: u32,
}

@group(0) @binding(0) var<uniform>       uniforms:  LeafUniforms;
@group(0) @binding(1) var<storage, read> instances: array<LeafInstance>;

fn leafWindNoise(pos: vec2<f32>, t: f32) -> f32 {
    let p = pos * 0.08 + vec2<f32>(t * 0.5, t * 0.35);
    return sin(p.x * 3.1 + p.y * 1.7) * 0.4 +
           sin(p.x * 5.7 - p.y * 2.3 + t * 1.2) * 0.3 + 0.5;
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let inst = instances[instIdx];
    let leafCenter = vec3<f32>(inst.posX, inst.posY, inst.posZ);

    let sphereDir = normalize(leafCenter - uniforms.planetOrigin);
    let viewDir = normalize(uniforms.cameraPosition - leafCenter);

    var cardUp = normalize(vec3<f32>(inst.twigDirX, inst.twigDirY, inst.twigDirZ));
    if (length(cardUp) < 0.0001) {
        cardUp = sphereDir;
    }

    out.vDiagCardUpDotUp = dot(cardUp, sphereDir);

    var refAxis = sphereDir;
    if (abs(dot(cardUp, refAxis)) > 0.92) { refAxis = vec3<f32>(0.0, 1.0, 0.0); }
    if (abs(dot(cardUp, refAxis)) > 0.92) { refAxis = vec3<f32>(1.0, 0.0, 0.0); }
    let right   = normalize(cross(cardUp, refAxis));
    let forward = normalize(cross(right, cardUp));

    let cosR = cos(inst.rotation);
    let sinR = sin(inst.rotation);
    let rotRight   = right * cosR + forward * sinR;
    let rotForward = -right * sinR + forward * cosR;

    var local = input.position;
    local.x *= inst.width;
    local.y *= inst.height;

    var windOffset = vec3<f32>(0.0);
    if (ENABLE_LEAF_WIND) {
        let windSample = leafWindNoise(leafCenter.xz, uniforms.time);
        let windFade = 1.0 - smoothstep(100.0, 200.0, length(leafCenter - uniforms.cameraPosition));
        let flutter = (input.uv.y - 0.5) * uniforms.windStrength * windSample * windFade * 0.08;
        let windDir3D = rotRight * uniforms.windDirection.x + rotForward * uniforms.windDirection.y;
        windOffset = windDir3D * flutter;
    }

    let worldPos = leafCenter
                 + rotRight   * local.x
                 + cardUp     * local.y
                 + rotForward * local.z
                 + windOffset;

    let worldNormal = normalize(
        rotForward * input.normal.x +
        cardUp     * input.normal.y +
        rotRight   * input.normal.z
    );

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPosition      = uniforms.projectionMatrix * viewPos;
    out.vUv               = input.uv;
    out.vNormal           = worldNormal;
    out.vWorldPosition    = worldPos;
    out.vDistanceToCamera = length(viewPos.xyz);
    out.vColor            = vec4<f32>(inst.colorR, inst.colorG, inst.colorB, inst.colorA);
    out.vCluster          = inst.clusterVariant;
    out.vFlags            = inst.bandIndex;

    // Pass card-local UV for procedural venation (not tiled, raw 0-1 over card)
    out.vCardUV = input.uv;

    // Tangent-space for lighting
    out.vTangent   = rotRight;
    out.vBitangent = rotForward;

    // Band index (low 3 bits of flags)
    out.vBand = inst.bandIndex & 0x7u;

    return out;
}
`;
}

export function buildLeafFragmentShader(config = {}) {
    const fadeStart = config.fadeStart ?? 50.0;
    const fadeEnd   = config.fadeEnd   ?? 60.0;

    const BIRCH_VARIANTS      = config.birchMaskVariants     ?? 12;
    const SPRUCE_VARIANTS     = config.spruceMaskVariants    ?? 8;
    const SPRUCE_LAYER_OFFSET = config.spruceMaskLayerOffset ?? BIRCH_VARIANTS;
    const CUTOUT = config.cutoutThreshold ?? 0.5;

    const B_L0_TEX_BASE  = config.birchL0TexBase  ?? 0;
    const B_L0_TEX_COUNT = config.birchL0TexCount ?? BIRCH_VARIANTS;
    const B_L1_TEX_BASE  = config.birchL1TexBase  ?? 0;
    const B_L1_TEX_COUNT = config.birchL1TexCount ?? BIRCH_VARIANTS;
    const B_L2_TEX_BASE  = config.birchL2TexBase  ?? 0;
    const B_L2_TEX_COUNT = config.birchL2TexCount ?? BIRCH_VARIANTS;
    const B_L3_TEX_BASE  = config.birchL3TexBase  ?? 0;
    const B_L3_TEX_COUNT = config.birchL3TexCount ?? BIRCH_VARIANTS;
    const CONNECTOR_STRENGTH = config.connectorStrength ?? 0.32;
    const ORIENTATION_DEBUG  = config.enableOrientationDebug === true;

    // LOD thresholds: which bands get which features
    const VEIN_LOD_THRESHOLD  = config.veinLODThreshold  ?? 0;
    const LIGHT_LOD_THRESHOLD = config.lightLODThreshold ?? 1;

    // Whether we have a separate albedo+normal texture bound
    const hasAlbedoTex  = config.enableAlbedoTexture  === true;
    const hasNormalTex  = config.enableNormalTexture   === true;

    const albedoBinding = hasAlbedoTex ? `
@group(1) @binding(3) var leafAlbedoTex:  texture_2d_array<f32>;
@group(1) @binding(4) var leafAlbedoSamp: sampler;
` : '';

    const normalBinding = hasNormalTex ? `
@group(1) @binding(5) var leafNormalTex:  texture_2d_array<f32>;
` : '';

    const detailAlbedoBlock = hasAlbedoTex ? `
        if (applyDetail) {
            let variantIdx = min(u32(input.vCluster * f32(BIRCH_VARIANTS)), BIRCH_VARIANTS - 1u);
            let albedoSample = textureSampleLevel(leafAlbedoTex, leafAlbedoSamp, input.vCardUV, i32(variantIdx), 0.0);
            albedo = albedoSample.rgb;
            transmission = albedoSample.a;
${hasNormalTex ? `
            let normalSample = textureSampleLevel(leafNormalTex, leafAlbedoSamp, input.vCardUV, i32(variantIdx), 0.0);
            let tsNormal = normalSample.xyz * 2.0 - vec3<f32>(1.0);
            bumpNormal = normalize(
                tangent * tsNormal.x +
                bitangent * tsNormal.y +
                geoNormal * tsNormal.z
            );
` : ''}
        } else {
            let connMix = clamp(connAlpha * (1.0 - leafAlpha * 0.55), 0.0, 1.0);
            albedo = mix(albedo, CONNECTOR_COLOR, connMix);
        }
    ` : `
        if (applyDetail) {
            let veinMask = birchLeafVeins(input.vCardUV);
            let veinColor = albedo * vec3<f32>(0.68, 0.78, 0.52);
            albedo = mix(albedo, veinColor, veinMask * 0.60);
            transmission = mix(0.65, 0.20, veinMask * 0.85);
            let bumpStrength = 0.20;
            let veinGrad = vec2<f32>(
                birchLeafVeins(input.vCardUV + vec2<f32>(0.004, 0.0)) -
                birchLeafVeins(input.vCardUV - vec2<f32>(0.004, 0.0)),
                birchLeafVeins(input.vCardUV + vec2<f32>(0.0, 0.004)) -
                birchLeafVeins(input.vCardUV - vec2<f32>(0.0, 0.004))
            );
            bumpNormal = normalize(geoNormal
                - tangent   * veinGrad.x * bumpStrength
                - bitangent * veinGrad.y * bumpStrength);
        } else {
            let connMix = clamp(connAlpha * (1.0 - leafAlpha * 0.55), 0.0, 1.0);
            albedo = mix(albedo, CONNECTOR_COLOR, connMix);
        }
        let wax = fract(sin(dot(input.vCardUV, vec2<f32>(127.1, 311.7))) * 43758.5453);
        albedo = albedo * (0.96 + wax * 0.08);
    `;

    return /* wgsl */`

const BIRCH_VARIANTS:      u32  = ${BIRCH_VARIANTS}u;
const SPRUCE_VARIANTS:     u32  = ${SPRUCE_VARIANTS}u;
const SPRUCE_LAYER_OFFSET: u32  = ${SPRUCE_LAYER_OFFSET}u;
const CUTOUT_THRESHOLD:    f32  = ${CUTOUT.toFixed(3)};
const FADE_START:          f32  = ${fadeStart.toFixed(1)};
const FADE_END:            f32  = ${fadeEnd.toFixed(1)};
const VEIN_LOD_THRESHOLD:  u32  = ${VEIN_LOD_THRESHOLD}u;
const LIGHT_LOD_THRESHOLD: u32  = ${LIGHT_LOD_THRESHOLD}u;
const HAS_ALBEDO_TEX:      bool = ${hasAlbedoTex};
const HAS_NORMAL_TEX:      bool = ${hasNormalTex};

const BIRCH_L0_TEX_BASE:  u32 = ${B_L0_TEX_BASE}u;
const BIRCH_L0_TEX_COUNT: u32 = ${B_L0_TEX_COUNT}u;
const BIRCH_L1_TEX_BASE:  u32 = ${B_L1_TEX_BASE}u;
const BIRCH_L1_TEX_COUNT: u32 = ${B_L1_TEX_COUNT}u;
const BIRCH_L2_TEX_BASE:  u32 = ${B_L2_TEX_BASE}u;
const BIRCH_L2_TEX_COUNT: u32 = ${B_L2_TEX_COUNT}u;
const BIRCH_L3_TEX_BASE:  u32 = ${B_L3_TEX_BASE}u;
const BIRCH_L3_TEX_COUNT: u32 = ${B_L3_TEX_COUNT}u;
const CONNECTOR_STRENGTH: f32 = ${Number(CONNECTOR_STRENGTH).toFixed(3)};
const ORIENTATION_DEBUG:  bool = ${ORIENTATION_DEBUG ? 'true' : 'false'};

const CONNECTOR_COLOR: vec3<f32> = vec3<f32>(0.14, 0.09, 0.05);

const BAYER4: array<f32, 16> = array<f32, 16>(
    0.03125, 0.53125, 0.15625, 0.65625,
    0.78125, 0.28125, 0.90625, 0.40625,
    0.21875, 0.71875, 0.09375, 0.59375,
    0.96875, 0.46875, 0.84375, 0.34375,
);

struct LeafFragUniforms {
    lightDirection: vec3<f32>, lightIntensity: f32,
    lightColor:     vec3<f32>, _pad0: f32,
    ambientColor:   vec3<f32>, ambientIntensity: f32,
    fogColor:       vec3<f32>, fogDensity: f32,
}

struct FragInput {
    @builtin(position) fragCoord:                   vec4<f32>,
    @location(0)  vUv:                              vec2<f32>,
    @location(1)  vNormal:                          vec3<f32>,
    @location(2)  vWorldPosition:                   vec3<f32>,
    @location(3)  vColor:                           vec4<f32>,
    @location(4)  vDistanceToCamera:                f32,
    @location(5)  vCluster:                         f32,
    @location(6)  @interpolate(flat) vFlags:        u32,
    @location(7)  vDiagCardUpDotUp:                 f32,
    @location(8)  vTangent:                         vec3<f32>,
    @location(9)  vBitangent:                       vec3<f32>,
    @location(10) vCardUV:                          vec2<f32>,
    @location(11) @interpolate(flat) vBand:         u32,
}

@group(1) @binding(0) var<uniform> fragUniforms: LeafFragUniforms;
@group(1) @binding(1) var leafMaskTex:  texture_2d_array<f32>;
@group(1) @binding(2) var leafMaskSamp: sampler;
${albedoBinding}
${normalBinding}

// ─────────────────────────────────────────────────────────────────────────
// Procedural pinnate venation — used at LOD 0 only when no albedo texture
// is available. When the albedo texture IS available this is skipped.
// ─────────────────────────────────────────────────────────────────────────

fn smoothLine(d: f32, hw: f32, aa: f32) -> f32 {
    return 1.0 - smoothstep(hw - aa, hw + aa, d);
}

fn distToSegment2D(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let ab = b - a;
    let ap = p - a;
    let t  = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return length(p - (a + ab * t));
}

fn birchLeafVeins(uv: vec2<f32>) -> f32 {
    let p  = vec2<f32>((uv.x - 0.5), uv.y);
    let aa = 0.006;

    // Midrib: vertical, tapers from thick base to thin tip
    let midribW = mix(0.020, 0.005, uv.y);
    let midrib  = smoothLine(abs(p.x), midribW, aa);

    // 7 pairs of lateral veins
    var lateral: f32 = 0.0;
    for (var i: u32 = 0u; i < 7u; i++) {
        let veinY   = 0.12 + f32(i) / 6.0 * 0.76;
        let angle   = mix(0.72, 1.02, veinY);
        let cosA    = cos(angle);
        let sinA    = sin(angle);
        let maxLen  = mix(0.40, 0.20, veinY);

        for (var side: i32 = 0; side < 2; side++) {
            let sx    = select(-cosA, cosA, side == 0);
            let root  = vec2<f32>(0.0, veinY - 0.5);   // midrib coords
            let tip   = root + vec2<f32>(sx, sinA) * maxLen;
            let dist  = distToSegment2D(p, root, tip);
            let along = dot(p - root, vec2<f32>(sx, sinA));
            if (along < -0.005) { continue; }
            let reach     = clamp(along / maxLen, 0.0, 1.0);
            let vw        = mix(0.010, 0.003, reach);
            let reachFade = 1.0 - smoothstep(0.75, 1.0, reach);
            lateral = max(lateral, smoothLine(dist, vw, aa) * reachFade);
        }
    }

    // Tertiary reticulate network — high-freq sinusoidal
    let tx = sin(p.x * 52.0 + p.y * 13.0) * 0.5 + 0.5;
    let ty = sin(p.y * 68.0 + p.x * 11.0) * 0.5 + 0.5;
    let tertiary = clamp((tx * ty - 0.72) * 4.0, 0.0, 1.0) * 0.15;

    return clamp(midrib + lateral + tertiary, 0.0, 1.0);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-leaf directional lighting — used at LOD 0 and LOD 1
// ─────────────────────────────────────────────────────────────────────────

fn computeLeafLighting(
    geoNormal:   vec3<f32>,
    bumpNormal:  vec3<f32>,
    tangent:     vec3<f32>,
    bitangent:   vec3<f32>,
    lightDir:    vec3<f32>,
    lightColor:  vec3<f32>,
    lightInt:    f32,
    ambColor:    vec3<f32>,
    ambInt:      f32,
    transmission: f32,    // [0,1] from mask alpha or procedural
) -> vec3<f32> {

    let N = bumpNormal;

    let NdotL   = dot(N, lightDir);
    let front   = max( NdotL, 0.0);
    let back    = max(-NdotL, 0.0);

    // ── Diffuse front + thin-sheet subsurface ─────────────────────────
    // Front: standard Lambertian.
    // Back: attenuated by transmission mask — thicker areas (veins) let
    // less light through, thin lamina lets more through with warm tint.
    let sssColor = vec3<f32>(1.15, 1.08, 0.72);  // warm yellow-green SSS
    let sssMask  = clamp(transmission * 1.4, 0.0, 1.0);
    let diffuse  = lightColor * lightInt
                 * (front * 0.70 + back * sssMask * 0.35 * sssColor);

    // ── Ambient ───────────────────────────────────────────────────────
    let ambient  = ambColor * ambInt * 0.78;

    // ── Specular (waxy cuticle, very tight highlight) ─────────────────
    // The cuticle on birch leaves produces a subtle specular sheen.
    // We approximate with Blinn-Phong using the bump normal.
    // Note: we don't have view direction here, so we use the geometric
    // normal as a proxy (acceptable at the distances this runs).
    let h       = normalize(lightDir + geoNormal);  // half-vector approx
    let spec    = pow(max(dot(N, h), 0.0), 48.0) * 0.08;
    let specCol = lightColor * lightInt * spec;

    // ── Rim (grazing silhouette brightening) ──────────────────────────
    let rim = pow(1.0 - abs(NdotL), 3.5) * 0.05 * lightColor;

    return ambient + diffuse + specCol + rim;
}

@fragment
fn main(input: FragInput) -> @location(0) vec4<f32> {
    let isConifer = (input.vFlags & 0x10u) != 0u;
    let emitBand  =  input.vFlags & 0x7u;
    let band      = input.vBand;

    // ── Mask layer selection ──────────────────────────────────────────
    var layer: u32;
    if (isConifer) {
        let idx = min(u32(input.vCluster * f32(SPRUCE_VARIANTS)), SPRUCE_VARIANTS - 1u);
        layer = SPRUCE_LAYER_OFFSET + idx;
    } else {
        var texBase: u32; var texCount: u32;
        switch (emitBand) {
            case 0u: { texBase = BIRCH_L0_TEX_BASE; texCount = BIRCH_L0_TEX_COUNT; }
            case 1u: { texBase = BIRCH_L1_TEX_BASE; texCount = BIRCH_L1_TEX_COUNT; }
            case 2u: { texBase = BIRCH_L2_TEX_BASE; texCount = BIRCH_L2_TEX_COUNT; }
            default: { texBase = BIRCH_L3_TEX_BASE; texCount = BIRCH_L3_TEX_COUNT; }
        }
        let idx = min(u32(input.vCluster * f32(texCount)), texCount - 1u);
        layer = texBase + idx;
    }

    let mask         = textureSample(leafMaskTex, leafMaskSamp, input.vUv, i32(layer));
    let leafAlpha    = mask.r;
    var connAlpha    = mask.g * CONNECTOR_STRENGTH;
    if (emitBand > 0u) { connAlpha = 0.0; }
    let alpha = max(leafAlpha, connAlpha * 0.94);
    if (alpha < CUTOUT_THRESHOLD) { discard; }

    // ── Distance fade (Bayer dither) ──────────────────────────────────
    let fade = clamp((FADE_END - input.vDistanceToCamera)
                     / max(0.001, FADE_END - FADE_START), 0.0, 1.0);
    let px = vec2<u32>(input.fragCoord.xy) & vec2<u32>(3u, 3u);
    if (BAYER4[px.y * 4u + px.x] > fade) { discard; }

    // ── DIAGNOSTIC ────────────────────────────────────────────────────
    if (ORIENTATION_DEBUG) {
        let d  = input.vDiagCardUpDotUp;
        let r  = clamp(0.5 - d * 0.5, 0.0, 1.0);
        let g  = clamp(0.5 + d * 0.5, 0.0, 1.0);
        return vec4<f32>(r, g, 0.1, 1.0);
    }

    // ── Normal and tangent frame ──────────────────────────────────────
    let geoNormal = normalize(input.vNormal);
    let tangent   = normalize(input.vTangent);
    let bitangent = normalize(input.vBitangent);
    let lightDir  = normalize(fragUniforms.lightDirection);

    // ── Albedo ────────────────────────────────────────────────────────
    var albedo: vec3<f32>;
    var transmission: f32 = 0.55;  // default medium transmission
    var bumpNormal = geoNormal;

    let applyDetail = !isConifer && (band <= VEIN_LOD_THRESHOLD);

    if (!isConifer) {
        // No albedo texture: use instance color + procedural veins at LOD 0
        albedo = input.vColor.rgb;
${detailAlbedoBlock}

    } else {
        // Conifer
        albedo = input.vColor.rgb;
        albedo *= 1.0 - smoothstep(0.0, 0.3, input.vUv.x) * 0.15;
        transmission = 0.25;
    }

    // ── Lighting ──────────────────────────────────────────────────────
    var color: vec3<f32>;
    let applyDirLight = (band <= LIGHT_LOD_THRESHOLD);

    if (applyDirLight) {
        let lightVec = computeLeafLighting(
            geoNormal, bumpNormal, tangent, bitangent,
            lightDir,
            fragUniforms.lightColor, fragUniforms.lightIntensity,
            fragUniforms.ambientColor, fragUniforms.ambientIntensity,
            transmission,
        );
        color = albedo * lightVec;
    } else {
        // Cheap path: LOD 2+
        let NdotL   = dot(geoNormal, lightDir);
        let front   = max( NdotL, 0.0);
        let back    = max(-NdotL, 0.0);
        let diffuse = fragUniforms.lightColor * fragUniforms.lightIntensity
                    * (front * 0.60 + back * 0.30);
        let ambient = fragUniforms.ambientColor * fragUniforms.ambientIntensity * 0.70;
        color = albedo * (ambient + diffuse);
        color += albedo * fragUniforms.lightColor * (back * 0.12);
    }

    // ── Fog only; final tone mapping happens in post ──────────────────
    let fog = 1.0 - exp(-input.vDistanceToCamera * fragUniforms.fogDensity);
    color   = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));

    return vec4<f32>(color, 1.0);
}
`;
}
