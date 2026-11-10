// js/renderer/streamer/shaders/assetFragment.wgsl.js
//
// ═══ INC 2 changes ═════════════════════════════════════════════════════════
//   • bandCategory == 2 → archetype-flag FAR_DIM check (grass parity)
//   • Clustered-light gate: bandIndex < 6 → lodLevel < 2 (layout-agnostic)
//   • Per-band SO arrays sized to dynamic totalBands; AssetStreamer supplies
//     all rows. Removed the category-default-fallback machinery — the
//     caller is now the single source of truth for per-band SO.

export function buildAssetFragmentShader(config = {}) {
    const fadeStart     = Number.isFinite(config.fadeStart)     ? config.fadeStart     : 500.0;
    const fadeEnd       = Number.isFinite(config.fadeEnd)       ? config.fadeEnd       : 800.0;
    const treeFadeStart = Number.isFinite(config.treeFadeStart) ? config.treeFadeStart : fadeStart;
    const treeFadeEnd   = Number.isFinite(config.treeFadeEnd)   ? config.treeFadeEnd   : fadeEnd;
    const treeFarBand   = Number.isFinite(config.treeFarBand)   ? config.treeFarBand   : 4;
    const enableShadows = config.enableShadows !== false;

    const TOTAL_BANDS       = config.totalBands       ?? 35;
    const LODS_PER_ARCH     = config.lodsPerArchetype ?? 5;

    const archetypeFlags  = config.archetypeFlags  ?? [0x02, 0x05];
    const archetypeCount  = archetypeFlags.length;
    const flagsInit = archetypeFlags.map(f => `${f >>> 0}u`).join(', ');

    // ── Self-occlusion: caller supplies per-band; no local fallbacks ──
    const so = config.selfOcclusion || {};
    const soEnabled = so.enabled !== false;
    const soMaster  = Number.isFinite(so.masterStrength)  ? so.masterStrength  : 1.0;
    const soAmbient = Number.isFinite(so.ambientStrength) ? so.ambientStrength : 1.0;
    const soDirect  = Number.isFinite(so.directStrength)  ? so.directStrength  : 0.4;
    const perBand   = so.perBand || [];

    const fmt = v => (Number.isFinite(v) ? v : 0).toFixed(4);
    const pick = (field, def) => {
        const a = [];
        for (let b = 0; b < TOTAL_BANDS; b++) a.push(fmt(perBand[b]?.[field] ?? def));
        return `array<f32, ${TOTAL_BANDS}>(${a.join(', ')})`;
    };
    const soGW = pick('gradientWidth',    0.10);
    const soDK = pick('darkening',        0.30);
    const soEM = pick('terrainEmbedding', 0.02);
    const soSM = pick('strengthMul',      0.70);

    const propTextureBindings = /* wgsl */`
@group(3) @binding(0) var propAtlas      : texture_2d_array<f32>;
@group(3) @binding(1) var propSampler    : sampler;
@group(3) @binding(2) var<storage, read> variantDefsRaw : array<f32>;

const VARIANT_STRIDE_F32 : u32 = 48u;
const SLOT_TEX_ALBEDO    : u32 = 34u;
const SLOT_TEX_SECONDARY : u32 = 35u;
const SLOT_TEX_OVERLAY   : u32 = 36u;
const SLOT_OVERLAY_STR   : u32 = 37u;
const SLOT_UV_SPLIT      : u32 = 38u;
const SLOT_TEX_NORMAL    : u32 = 40u;
const SLOT_TEX_DETAIL    : u32 = 41u;
const SLOT_NORMAL_STR    : u32 = 42u;
const SLOT_DETAIL_STR    : u32 = 43u;
`;

    // ── Shadow bindings/functions — unchanged from pre-Inc-2 ─────────
    const shadowBindings = enableShadows ? /* wgsl */`
@group(2) @binding(4) var shadowCascade0: texture_depth_2d;
@group(2) @binding(5) var shadowCascade1: texture_depth_2d;
@group(2) @binding(6) var shadowCascade2: texture_depth_2d;
@group(2) @binding(7) var shadowCompSampler: sampler_comparison;

struct AssetShadowUniforms {
    cascadeVP0: mat4x4<f32>, cascadeVP1: mat4x4<f32>, cascadeVP2: mat4x4<f32>,
    splits: vec4<f32>, params: vec4<f32>,
}
@group(2) @binding(8) var<uniform> assetShadowUniforms: AssetShadowUniforms;
` : '';

    const shadowFn = enableShadows ? /* wgsl */`
fn assetSamplePCF9(cascade: i32, uv: vec2<f32>, cmp: f32, ts: f32) -> f32 {
    let o = array<vec2<f32>,9>(
        vec2(0.,0.), vec2(-1.,-1.), vec2(0.,-1.), vec2(1.,-1.),
        vec2(-1.,0.), vec2(1.,0.), vec2(-1.,1.), vec2(0.,1.), vec2(1.,1.));
    let w = array<f32,9>(0.25, 0.0625,0.125,0.0625, 0.125,0.125, 0.0625,0.125,0.0625);
    var s0=0.; var s1=0.; var s2=0.;
    for (var i=0u;i<9u;i++){ let su=uv+o[i]*ts; let wi=w[i];
        s0+=textureSampleCompare(shadowCascade0,shadowCompSampler,su,cmp)*wi;
        s1+=textureSampleCompare(shadowCascade1,shadowCompSampler,su,cmp)*wi;
        s2+=textureSampleCompare(shadowCascade2,shadowCompSampler,su,cmp)*wi; }
    return select(select(s2,s1,cascade==1),s0,cascade==0);
}
fn assetComputeShadow(wp: vec3<f32>, vp: vec3<f32>, n: vec3<f32>) -> f32 {
    if (assetShadowUniforms.params.w < 0.5) { return 1.0; }
    let vz=-vp.z; let b=assetShadowUniforms.params.x; let nb=assetShadowUniforms.params.y;
    let ms=assetShadowUniforms.params.z;
    var ci:i32=2; if(vz<assetShadowUniforms.splits.x){ci=0;}else if(vz<assetShadowUniforms.splits.y){ci=1;}
    var m=assetShadowUniforms.cascadeVP2; if(ci==0){m=assetShadowUniforms.cascadeVP0;}else if(ci==1){m=assetShadowUniforms.cascadeVP1;}
    let bp=wp+n*nb; let cl=m*vec4(bp,1.); let w=max(abs(cl.w),0.0001); let ndc=cl.xyz/w;
    let uvr=ndc.xy*0.5+0.5; let uv=vec2(uvr.x,1.-uvr.y); let cd=ndc.z-b;
    let oob=uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.||ndc.z<0.||ndc.z>1.;
    return select(assetSamplePCF9(ci,uv,cd,1./ms),1.,oob);
}
` : '';

    const shadowCall = enableShadows
        ? 'let shadowF = assetComputeShadow(input.vWorldPosition, input.vViewPosition, normal);'
        : 'let shadowF: f32 = 1.0;';

    const soCode = soEnabled ? /* wgsl */`
const SO_MASTER:  f32 = ${fmt(soMaster)};
const SO_AMBIENT: f32 = ${fmt(soAmbient)};
const SO_DIRECT:  f32 = ${fmt(soDirect)};
const SO_GW = ${soGW};
const SO_DK = ${soDK};
const SO_EM = ${soEM};
const SO_SM = ${soSM};
fn computeSelfOcclusion(uvY: f32, band: u32) -> vec2<f32> {
    let i = min(band, ${TOTAL_BANDS - 1}u);
    let effY = max(0., uvY - SO_EM[i]);
    let t = clamp(effY / max(SO_GW[i], 0.001), 0., 1.);
    let occ = (1.-t)*(1.-t) * SO_DK[i] * SO_SM[i] * SO_MASTER;
    return vec2(1. - occ*SO_AMBIENT, 1. - occ*SO_DIRECT);
}
` : /* wgsl */`
fn computeSelfOcclusion(uvY: f32, band: u32) -> vec2<f32> { return vec2(1.,1.); }
`;

    return /* wgsl */`
const TREE_FAR_BAND:      u32 = ${treeFarBand}u;
const LODS_PER_ARCHETYPE: u32 = ${LODS_PER_ARCH}u;

const ARCH_FLAG_FAR_DIM: u32 = 0x04u;
const ROCK_ARCHETYPE_INDEX: u32 = 2u;
const ARCHETYPE_COUNT:   u32 = ${archetypeCount}u;
const ARCHETYPE_FLAGS = array<u32, ARCHETYPE_COUNT>(${flagsInit});

struct ClLight { position:vec3<f32>, radius:f32, color:vec3<f32>, intensity:f32,
    direction:vec3<f32>, lightType:f32, angle:f32, penumbra:f32, decay:f32, castShadow:f32, }
struct ClCluster { lightCount:u32, lightOffset:u32, _p0:u32, _p1:u32, }
struct ClParams { dims:vec3<f32>, numLights:f32, near:f32, far:f32, maxPerCluster:f32, _p:f32,
    invTanHalfFovX:f32, invTanHalfFovY:f32, _p2:f32, _p3:f32, _r0:f32,_r1:f32,_r2:f32,_r3:f32, }
struct AssetFragUniforms { lightDirection:vec3<f32>, lightIntensity:f32, lightColor:vec3<f32>, _p0:f32,
    ambientColor:vec3<f32>, ambientIntensity:f32, fogColor:vec3<f32>, fogDensity:f32, }
struct FragmentInput {
    @location(0) vUv:vec2<f32>, 
    @location(1) vNormal:vec3<f32>, 
    @location(2) vWorldPosition:vec3<f32>,
    @location(3) vColor:vec4<f32>, 
    @location(4) vDistanceToCamera:f32,
    @location(5) vViewPosition:vec3<f32>, 
    @location(6) vBandIndex:f32,
        @location(7) @interpolate(flat) vVariantIndex : f32,
    @location(8) @interpolate(flat) vLocalUp      : vec3<f32>,
}

@group(1) @binding(0) var<uniform> fragUniforms: AssetFragUniforms;
@group(2) @binding(0) var<storage,read> clLights:array<ClLight>;
@group(2) @binding(1) var<storage,read> clClusters:array<ClCluster>;
@group(2) @binding(2) var<storage,read> clIndices:array<u32>;
@group(2) @binding(3) var<uniform> clParams:ClParams;

${shadowBindings}
${propTextureBindings}
${shadowFn}
${soCode}

struct AssetSurfaceData {
    albedo: vec3<f32>,
    normal: vec3<f32>,
}

struct SurfaceFrame {
    tangent: vec3<f32>,
    bitangent: vec3<f32>,
    normal: vec3<f32>,
}

fn saturate(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }

fn hash12(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn hash13(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 191.9))) * 43758.5453123);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (vec3<f32>(3.0) - 2.0 * f);

    let a = hash13(i);
    let b = hash13(i + vec3<f32>(1.0, 0.0, 0.0));
    let c = hash13(i + vec3<f32>(0.0, 1.0, 0.0));
    let d = hash13(i + vec3<f32>(1.0, 1.0, 0.0));
    let e = hash13(i + vec3<f32>(0.0, 0.0, 1.0));
    let f1 = hash13(i + vec3<f32>(1.0, 0.0, 1.0));
    let g = hash13(i + vec3<f32>(0.0, 1.0, 1.0));
    let h = hash13(i + vec3<f32>(1.0, 1.0, 1.0));

    let x00 = mix(a, b, u.x);
    let x10 = mix(c, d, u.x);
    let x01 = mix(e, f1, u.x);
    let x11 = mix(g, h, u.x);
    let y0 = mix(x00, x10, u.y);
    let y1 = mix(x01, x11, u.y);
    return mix(y0, y1, u.z);
}

fn fbm2(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var freq = 1.0;
    for (var i = 0; i < 4; i++) {
        value += noise2(p * freq) * amplitude;
        freq *= 2.03;
        amplitude *= 0.5;
    }
    return value;
}

fn fbm3(p: vec3<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var freq = 1.0;
    for (var i = 0; i < 5; i++) {
        value += noise3(p * freq) * amplitude;
        freq *= 2.03;
        amplitude *= 0.5;
    }
    return value;
}

fn ridged2(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.55;
    var freq = 1.0;
    for (var i = 0; i < 3; i++) {
        let n = noise2(p * freq);
        value += (1.0 - abs(n * 2.0 - 1.0)) * amplitude;
        freq *= 2.17;
        amplitude *= 0.5;
    }
    return value;
}

fn ridged3(p: vec3<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.55;
    var freq = 1.0;
    for (var i = 0; i < 4; i++) {
        let n = noise3(p * freq);
        value += (1.0 - abs(n * 2.0 - 1.0)) * amplitude;
        freq *= 2.11;
        amplitude *= 0.5;
    }
    return value;
}

fn rotate2d(p: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(
        p.x * c - p.y * s,
        p.x * s + p.y * c
    );
}

fn triplanarWeights(n: vec3<f32>) -> vec3<f32> {
    let an = pow(abs(n), vec3<f32>(2.2, 2.2, 2.2));
    let sum = max(an.x + an.y + an.z, 1e-5);
    return an / sum;
}

fn triplanarSample(layer: i32, worldPos: vec3<f32>, n: vec3<f32>, scale: f32) -> vec4<f32> {
    let w = triplanarWeights(n);

    var uvX = vec2<f32>(
        worldPos.z + worldPos.x * 0.19 + worldPos.y * 0.04,
        worldPos.y - worldPos.x * 0.15 + worldPos.z * 0.05
    ) * scale;
    var uvY = vec2<f32>(
        worldPos.x - worldPos.y * 0.06 + worldPos.z * 0.11,
        worldPos.z + worldPos.y * 0.17 - worldPos.x * 0.04
    ) * scale;
    var uvZ = vec2<f32>(
        worldPos.x + worldPos.z * 0.13 + worldPos.y * 0.05,
        worldPos.y - worldPos.z * 0.16 + worldPos.x * 0.03
    ) * scale;

    uvX = rotate2d(uvX, 0.73);
    uvY = rotate2d(uvY, -0.58);
    uvZ = rotate2d(uvZ, 0.41);

    if (n.x < 0.0) { uvX.x = -uvX.x; }
    if (n.y < 0.0) { uvY.x = -uvY.x; }
    if (n.z < 0.0) { uvZ.x = -uvZ.x; }

    let sx = textureSampleLevel(propAtlas, propSampler, uvX, layer, 0.0);
    let sy = textureSampleLevel(propAtlas, propSampler, uvY, layer, 0.0);
    let sz = textureSampleLevel(propAtlas, propSampler, uvZ, layer, 0.0);
    return sx * w.x + sy * w.y + sz * w.z;
}

fn rockNoiseField(worldPos: vec3<f32>, scale: f32, warpStrength: f32) -> f32 {
    let p = worldPos * scale;
    let warp = vec3<f32>(
        fbm3(p.yzx * 0.71 + vec3<f32>(13.1, 7.2, 3.4)),
        fbm3(p.zxy * 0.83 + vec3<f32>(2.7, 17.3, 11.8)),
        fbm3(p.xyz * 0.65 + vec3<f32>(19.2, 5.6, 23.1))
    ) - vec3<f32>(0.5, 0.5, 0.5);
    return fbm3(p + warp * warpStrength);
}

fn perturbRockNormal(baseNormal: vec3<f32>, worldPos: vec3<f32>, strength: f32) -> vec3<f32> {
    let eps = 0.028;
    let hX0 = rockNoiseField(worldPos - vec3<f32>(eps, 0.0, 0.0), 12.0, 0.85);
    let hX1 = rockNoiseField(worldPos + vec3<f32>(eps, 0.0, 0.0), 12.0, 0.85);
    let hY0 = rockNoiseField(worldPos - vec3<f32>(0.0, eps, 0.0), 12.0, 0.85);
    let hY1 = rockNoiseField(worldPos + vec3<f32>(0.0, eps, 0.0), 12.0, 0.85);
    let hZ0 = rockNoiseField(worldPos - vec3<f32>(0.0, 0.0, eps), 12.0, 0.85);
    let hZ1 = rockNoiseField(worldPos + vec3<f32>(0.0, 0.0, eps), 12.0, 0.85);
    let grad = vec3<f32>(hX1 - hX0, hY1 - hY0, hZ1 - hZ0);
    return normalize(baseNormal - grad * strength);
}

fn rockRoughnessMask(worldPos: vec3<f32>) -> f32 {
    let broad = rockNoiseField(worldPos + vec3<f32>(11.0, 3.0, 7.0), 0.75, 1.35);
    let medium = rockNoiseField(worldPos + vec3<f32>(2.0, 17.0, 5.0), 1.85, 0.95);
    let variation = rockNoiseField(worldPos + vec3<f32>(23.0, 9.0, 13.0), 3.4, 0.55);
    let combined = broad * 0.50 + medium * 0.35 + variation * 0.15;
    return smoothstep(0.18, 0.84, combined);
}

fn buildSurfaceFrame(n: vec3<f32>) -> SurfaceFrame {
    let refUp = select(
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(1.0, 0.0, 0.0),
        abs(n.y) > 0.92
    );
    let tangent = normalize(cross(refUp, n));
    let bitangent = normalize(cross(n, tangent));
    return SurfaceFrame(tangent, bitangent, n);
}

fn applyTangentNormal(frame: SurfaceFrame, tsNormal: vec3<f32>) -> vec3<f32> {
    return normalize(
        frame.tangent * tsNormal.x +
        frame.bitangent * tsNormal.y +
        frame.normal * tsNormal.z
    );
}

fn applyGraniteNear(uv: vec2<f32>, baseColor: vec3<f32>, frame: SurfaceFrame,
                    detailLayer: i32,
                    normalStrength: f32, detailStrength: f32, lodLevel: u32) -> AssetSurfaceData {
    let detailUV0 = select(
        vec2<f32>(uv.x * 4.0 + uv.y * 0.35 + 0.17, uv.y * 3.0 + 0.11),
        vec2<f32>(uv.x * 3.0 + uv.y * 0.28 + 0.17, uv.y * 2.0 + 0.11),
        lodLevel == 1u
    );
    let detailUV1 = select(
        vec2<f32>(uv.x * 7.0 + uv.y * 0.18 + 0.43, uv.y * 5.0 + 0.29),
        vec2<f32>(uv.x * 5.0 + uv.y * 0.16 + 0.43, uv.y * 4.0 + 0.29),
        lodLevel == 1u
    );
    let detailTex0 = textureSampleLevel(propAtlas, propSampler, detailUV0, detailLayer, 0.0);
    let detailTex1 = textureSampleLevel(propAtlas, propSampler, detailUV1, detailLayer, 0.0);
    let detailTex = mix(detailTex0, detailTex1, 0.42);
    let macroBreak = detailTex.b;
    let fractures = saturate(detailTex.r * 0.92 - 0.10) * detailStrength;
    let grains = saturate(detailTex.g * 1.18 + macroBreak * 0.12) * detailStrength;
    let cavities = saturate(detailTex.a * 0.55);
    let roughnessMask = smoothstep(0.22, 0.82, macroBreak * 0.55 + detailTex.g * 0.45);
    let roughness = mix(0.62, 1.0, roughnessMask);

    var albedo = baseColor;
    albedo *= 0.94 + macroBreak * 0.12;
    albedo = mix(albedo, albedo * vec3<f32>(0.84, 0.86, 0.89), fractures * 0.10);
    albedo = mix(albedo, albedo * vec3<f32>(1.13, 1.12, 1.09) + vec3<f32>(0.05, 0.05, 0.04), grains * 0.22);
    albedo = mix(albedo, albedo * vec3<f32>(0.91, 0.91, 0.93), cavities * 0.06);
    let crackShadow = (fractures * 0.55 + cavities * 0.70) * (0.35 + 0.65 * roughness);
    albedo *= 1.0 - crackShadow * 0.14;

    var outData: AssetSurfaceData;
    outData.albedo = albedo;
    let cheapTsNormal = normalize(vec3<f32>(
        (detailTex.g - detailTex.r) * 0.95 + (macroBreak - 0.5) * 0.12,
        (detailTex.g - detailTex.a) * 0.78 - (detailTex.r - 0.5) * 0.10,
        1.0
    ));
    outData.normal = applyTangentNormal(
        frame,
        normalize(mix(vec3<f32>(0.0, 0.0, 1.0), cheapTsNormal, (0.34 + 0.24 * roughness) * normalStrength))
    );
    return outData;
}

fn applyGraniteFar(uv: vec2<f32>, baseColor: vec3<f32>, frame: SurfaceFrame,
                   detailLayer: i32,
                   normalStrength: f32, detailStrength: f32) -> AssetSurfaceData {
    let detailUV0 = vec2<f32>(uv.x * 2.0 + uv.y * 0.24 + 0.09, uv.y * 2.0 + 0.05);
    let detailUV1 = vec2<f32>(uv.x * 4.0 + uv.y * 0.10 + 0.31, uv.y * 3.0 + 0.17);
    let detailTex0 = textureSampleLevel(propAtlas, propSampler, detailUV0, detailLayer, 0.0);
    let detailTex1 = textureSampleLevel(propAtlas, propSampler, detailUV1, detailLayer, 0.0);
    let detailTex = mix(detailTex0, detailTex1, 0.35);
    let roughnessMask = smoothstep(0.24, 0.80, detailTex.b * 0.60 + detailTex.g * 0.40);
    let roughness = mix(0.58, 0.82, roughnessMask);
    let grains = saturate(detailTex.g * 1.00) * detailStrength * mix(0.82, 1.0, roughnessMask);
    let fractures = saturate(detailTex.r * 0.72 - 0.10) * detailStrength * roughness;

    var albedo = baseColor * (0.95 + detailTex.b * 0.10);
    albedo = mix(albedo, albedo * vec3<f32>(1.08, 1.08, 1.06), grains * 0.16);
    albedo = mix(albedo, albedo * vec3<f32>(0.84, 0.85, 0.88), fractures * 0.08);
    albedo *= 1.0 - (fractures * 0.08 + detailTex.a * 0.05);

    var outData: AssetSurfaceData;
    outData.albedo = albedo;
    let farTsNormal = normalize(vec3<f32>(
        (detailTex.g - detailTex.r) * 0.42 + (detailTex.b - 0.5) * 0.08,
        (detailTex.g - detailTex.a) * 0.32,
        1.0
    ));
    outData.normal = applyTangentNormal(
        frame,
        normalize(mix(vec3<f32>(0.0, 0.0, 1.0), farTsNormal, (0.16 + 0.10 * roughness) * normalStrength))
    );
    return outData;
}

fn cl_getClusterIndex(vp:vec3<f32>)->i32{
    let vz=-vp.z; if(vz<=0.||vz>=clParams.far){return -1;}
    let lr=log(max(vz,clParams.near)/clParams.near)/log(clParams.far/clParams.near);
    let iz=u32(clamp(lr*clParams.dims.z,0.,clParams.dims.z-1.));
    let nx=clamp(vp.x/(-vp.z)*clParams.invTanHalfFovX,-1.,1.);
    let ny=clamp(vp.y/(-vp.z)*clParams.invTanHalfFovY,-1.,1.);
    let ix=u32(clamp((nx*.5+.5)*clParams.dims.x,0.,clParams.dims.x-1.));
    let iy=u32(clamp((ny*.5+.5)*clParams.dims.y,0.,clParams.dims.y-1.));
    return i32(iz*u32(clParams.dims.x*clParams.dims.y)+iy*u32(clParams.dims.x)+ix);
}
fn cl_point(L:ClLight,wp:vec3<f32>,N:vec3<f32>,a:vec3<f32>)->vec3<f32>{
    let tl=L.position-wp; let d2=dot(tl,tl); if(d2>L.radius*L.radius){return vec3(0.);}
    let d=sqrt(d2); let ld=tl/max(d,.0001); let nl=max(dot(N,ld),0.);
    var at=1./(1.+L.decay*d2); let fd=L.radius*.8; if(d>fd){at*=1.-smoothstep(fd,L.radius,d);}
    return a*L.color*L.intensity*nl*at;
}
fn cl_spot(L:ClLight,wp:vec3<f32>,N:vec3<f32>,a:vec3<f32>)->vec3<f32>{
    let tl=L.position-wp; let d=length(tl); if(d>L.radius){return vec3(0.);}
    let ld=tl/max(d,.0001); let ca=dot(-ld,normalize(L.direction));
    let oc=cos(L.angle); if(ca<oc){return vec3(0.);}
    let ic=cos(L.angle*(1.-L.penumbra)); let sp=smoothstep(oc,ic,ca);
    let nl=max(dot(N,ld),0.); var at=1./(1.+L.decay*d*d); at*=1.-smoothstep(L.radius*.75,L.radius,d);
    return a*L.color*L.intensity*nl*at*sp;
}
fn evalClustered(wp:vec3<f32>,vp:vec3<f32>,n:vec3<f32>,a:vec3<f32>)->vec3<f32>{
    var t=vec3(0.); if(clParams.numLights<.5){return t;}
    let ci=cl_getClusterIndex(vp); if(ci<0){return t;}
    let cl=clClusters[u32(ci)]; let cnt=min(cl.lightCount,u32(clParams.maxPerCluster));
    for(var i=0u;i<cnt;i++){ let li=clIndices[cl.lightOffset+i]; if(li>=u32(clParams.numLights)){continue;}
        let L=clLights[li]; if(L.lightType<.5){}else if(L.lightType<1.5){t+=cl_point(L,wp,n,a);}
        else if(L.lightType<2.5){t+=cl_spot(L,wp,n,a);} } return t;
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    if (input.vColor.a < 0.01) { discard; }

    let bandIdx  = u32(input.vBandIndex + 0.5);
    let archIdx  = min(bandIdx / LODS_PER_ARCHETYPE, ARCHETYPE_COUNT - 1u);
    let lodLevel = bandIdx - archIdx * LODS_PER_ARCHETYPE;
    let flags    = ARCHETYPE_FLAGS[archIdx];

    // Far-LOD impostor treatment — grass, ferns.
    let isFarImpostor = ((flags & ARCH_FLAG_FAR_DIM) != 0u) && (lodLevel >= 3u);

    let geoNormal = normalize(input.vNormal);
    let surfaceFrame = buildSurfaceFrame(geoNormal);
    let lightDir = normalize(fragUniforms.lightDirection);
    let soF = computeSelfOcclusion(input.vUv.y, bandIdx);

    // Clustered point/spot lights — gate by LOD, not band, so it's
    // layout-agnostic. LOD 0-1 only. (Minor behavior change: close grass
    // now picks up player torches. Previously NOTHING scatter-drawn did,
    // since the old gate was band<6 which was all tree/GC bands, and
    // trees are suppressed. Considered acceptable-to-good.)
    var color = input.vColor.rgb;
    var normal = geoNormal;
    var texAlpha = 1.0;
    // ══════════════════════════════════════════════════════════════════
    // Prop texture sampling (Inc 4)
    // ══════════════════════════════════════════════════════════════════
    // Uses textureSampleLevel (mip 0) to sidestep two issues:
    //   1. Uniformity: the uvSplit branch is non-uniform (varies across
    //      a quad at the seam), which textureSample forbids.
    //   2. Derivative blowup at the seam (remapped UVs discontinuous).
    // TODO(perf): compute explicit LOD from fwidth(input.vUv) and feed
    // it to textureSampleLevel so distant props get mipmaps.
    {
        let vIdx    = u32(input.vVariantIndex);
        let base    = vIdx * VARIANT_STRIDE_F32;
        let tAlb    = variantDefsRaw[base + SLOT_TEX_ALBEDO];
        let tSec    = variantDefsRaw[base + SLOT_TEX_SECONDARY];
        let tOvl    = variantDefsRaw[base + SLOT_TEX_OVERLAY];
        let ovlStr  = variantDefsRaw[base + SLOT_OVERLAY_STR];
        let uvSplit = variantDefsRaw[base + SLOT_UV_SPLIT];
        let tNrm    = variantDefsRaw[base + SLOT_TEX_NORMAL];
        let tDtl    = variantDefsRaw[base + SLOT_TEX_DETAIL];
        let nrmStr  = variantDefsRaw[base + SLOT_NORMAL_STR];
        let dtlStr  = variantDefsRaw[base + SLOT_DETAIL_STR];

        // Negative layer index = "no texture, keep vertex colour".
        // Grass and trees hit this path and remain untouched.
        if (tAlb >= 0.0) {
            var uv    = input.vUv;
            var layer = i32(tAlb);

            // Two-region UV split: stem/bark below, cap/endgrain above.
            // Only active when a secondary layer is assigned AND split
            // is in (0,1). Remap each region to full [0,1] V-range so
            // the texture tiles correctly within its region.
            let splitActive = (tSec >= 0.0)
                           && (uvSplit > 1e-4)
                           && (uvSplit < 0.9999);
            if (splitActive) {
                if (input.vUv.y >= uvSplit) {
                    layer = i32(tSec);
                    uv.y  = (input.vUv.y - uvSplit) / (1.0 - uvSplit);
                } else {
                    uv.y  = input.vUv.y / uvSplit;
                }
            }

            let baseTex = textureSampleLevel(propAtlas, propSampler, uv, layer, 0.0);
            texAlpha = baseTex.a;
            if (texAlpha < 0.25) { discard; }
            color = baseTex.rgb;

            if (tNrm >= 0.0 && tDtl >= 0.0 && archIdx == ROCK_ARCHETYPE_INDEX) {
                var shaded: AssetSurfaceData;
                if (lodLevel < 2u) {
                    shaded = applyGraniteNear(
                        uv, color, surfaceFrame,
                        i32(tDtl), nrmStr, dtlStr, lodLevel
                    );
                } else {
                    shaded = applyGraniteFar(
                        uv, color, surfaceFrame,
                        i32(tDtl), nrmStr, dtlStr
                    );
                }
                color = shaded.albedo;
                normal = shaded.normal;
            }

            // Moss overlay — upward-facing surfaces only. overlayStrength
            // from the variant def scales the effect ([0,1]).
            if (tOvl >= 0.0 && ovlStr > 0.0) {
                let moss   = textureSampleLevel(
                    propAtlas, propSampler, input.vUv, i32(tOvl), 0.0
                );
                let upN    = normalize(input.vLocalUp);
                // NOTE: adjust 'vNormal' to your actual varying name
                let nrmN   = normalize(input.vNormal);
                let mossT  = clamp(dot(nrmN, upN), 0.0, 1.0) * ovlStr;
                color     = mix(color, moss.rgb, mossT);
            }
        }
    }

    let NdotL = dot(normal, lightDir);
    let sunFront = select(0.70, 0.56, isFarImpostor);
    let sunBack  = select(0.25, 0.06, isFarImpostor);
    let ambScale = select(0.60, 0.44, isFarImpostor);
    let sunDiff  = fragUniforms.lightColor * fragUniforms.lightIntensity
                 * (max(NdotL,0.)*sunFront + max(-NdotL,0.)*sunBack);
    let ambient  = fragUniforms.ambientColor * fragUniforms.ambientIntensity * ambScale;

    ${shadowCall}

    var lighting = ambient * soF.x + sunDiff * shadowF * soF.y;
    if (lodLevel < 2u) {
        lighting += evalClustered(input.vWorldPosition, input.vViewPosition,
                                  normal, color) * soF.y;
    }
    color = color * lighting;

    if (isFarImpostor) { color *= vec3(0.80, 0.86, 0.80); }

    let fogF = 1. - exp(-input.vDistanceToCamera * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fogF, 0., 1.));

    // Distance fade — tree far-band gets its own curve (dead while
    // suppressed; kept for correctness).
    var dFade: f32;
    if (bandIdx == TREE_FAR_BAND) {
        dFade = 1. - smoothstep(${treeFadeStart.toFixed(1)}, ${treeFadeEnd.toFixed(1)}, input.vDistanceToCamera);
    } else {
        dFade = 1. - smoothstep(${fadeStart.toFixed(1)}, ${fadeEnd.toFixed(1)}, input.vDistanceToCamera);
    }

    return vec4(color, dFade * input.vColor.a * texAlpha);
}
`;
}
