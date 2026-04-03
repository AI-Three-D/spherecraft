// js/renderer/streamer/shaders/midNearRender.wgsl.js
//
// Three pipelines: trunk + canopy hull + impostor.
//
// The canopy hull VS is the key innovation: it reads the per-tree anchor
// positions from a storage buffer and deforms the unit sphere to wrap
// around them, producing a single coherent canopy silhouette per tree.

const BAYER_WGSL = /* wgsl */`
fn ditherDiscard(fragCoord: vec4<f32>, fade: f32) -> bool {
    let px = vec2<u32>(fragCoord.xy);
    var s = px.x * 1664525u + px.y * 1013904223u + 747796405u;
    s = (s ^ (s >> 16u)) * 2246822519u;
    s = s ^ (s >> 13u);
    let n = f32(s & 0x00FFFFFFu) / 16777216.0;
    return n > fade;
}
`;

// ═════════════════════════════════════════════════════════════════════════
// TRUNK PIPELINE
// ═════════════════════════════════════════════════════════════════════════

export function buildMidNearTrunkVertexShader(config = {}) {
    return /* wgsl */`

struct TrunkInstance {
    baseX: f32, baseY: f32, baseZ: f32, rotation: f32,
    trunkHeight: f32, trunkRadius: f32, distanceToCamera: f32, tierFade: f32,
    barkR: f32, barkG: f32, barkB: f32, speciesF: f32,
}

struct TrunkUniforms {
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

@group(0) @binding(0) var<uniform>       uniforms:  TrunkUniforms;
@group(0) @binding(1) var<storage, read> instances: array<TrunkInstance>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vNormal:       vec3<f32>,
    @location(1) vColor:        vec3<f32>,
    @location(2) vDist:         f32,
    @location(3) vHeight:       f32,
    @location(4) @interpolate(flat) vTierFade: f32,
    @location(5) @interpolate(flat) vSpecies:  u32,
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let inst = instances[instIdx];
    let base = vec3<f32>(inst.baseX, inst.baseY, inst.baseZ);

    let sphereDir = normalize(base - uniforms.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));

    let cosR = cos(inst.rotation);
    let sinR = sin(inst.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    let local = vec3<f32>(
        input.position.x * inst.trunkRadius,
        input.position.y * inst.trunkHeight,
        input.position.z * inst.trunkRadius
    );

    let worldPos = base
                 + rotT      * local.x
                 + sphereDir * local.y
                 + rotB      * local.z;

    let worldNormal = normalize(
        rotT      * input.normal.x +
        sphereDir * input.normal.y +
        rotB      * input.normal.z
    );

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos   = uniforms.projectionMatrix * viewPos;
    out.vNormal   = worldNormal;
    out.vColor    = vec3<f32>(inst.barkR, inst.barkG, inst.barkB);
    out.vDist     = length(viewPos.xyz);
    out.vHeight   = input.uv.y;
    out.vTierFade = inst.tierFade;
    out.vSpecies  = u32(inst.speciesF + 0.5);

    return out;
}
`;
}

export function buildMidNearTrunkFragmentShader(config = {}) {
    const fadeInStart  = Number(config.fadeInStart  ?? 55).toFixed(1);
    const fadeInEnd    = Number(config.fadeInEnd    ?? 68).toFixed(1);
    const fadeOutStart = Number(config.fadeOutStart ?? 200).toFixed(1);
    const fadeOutEnd   = Number(config.fadeOutEnd   ?? 220).toFixed(1);

    return /* wgsl */`

${BAYER_WGSL}

struct TrunkFragUniforms {
    lightDirection: vec3<f32>, lightIntensity: f32,
    lightColor:     vec3<f32>, _pad0: f32,
    ambientColor:   vec3<f32>, ambientIntensity: f32,
    fogColor:       vec3<f32>, fogDensity: f32,
}

struct FragInput {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) vNormal:  vec3<f32>,
    @location(1) vColor:   vec3<f32>,
    @location(2) vDist:    f32,
    @location(3) vHeight:  f32,
    @location(4) @interpolate(flat) vTierFade: f32,
    @location(5) @interpolate(flat) vSpecies:  u32,
}

@group(1) @binding(0) var<uniform> fragUniforms: TrunkFragUniforms;

const FADE_IN_START:  f32 = ${fadeInStart};
const FADE_IN_END:    f32 = ${fadeInEnd};
const FADE_OUT_START: f32 = ${fadeOutStart};
const FADE_OUT_END:   f32 = ${fadeOutEnd};

@fragment
fn main(in: FragInput) -> @location(0) vec4<f32> {
    let fadeIn  = smoothstep(FADE_IN_START,  FADE_IN_END,  in.vDist);
    let fadeOut = 1.0 - smoothstep(FADE_OUT_START, FADE_OUT_END, in.vDist);
    let tierFade = fadeIn * fadeOut;
    if (ditherDiscard(in.fragCoord, tierFade)) { discard; }

    let N = normalize(in.vNormal);
    let L = normalize(fragUniforms.lightDirection);
    let NdotL = max(dot(N, L), 0.0);

    let baseAO = mix(0.55, 1.0, smoothstep(0.0, 0.15, in.vHeight));

    var albedo = in.vColor;

    // Birch lenticel bands
    if (in.vSpecies == 2u) {
        let lenticel = sin(in.vHeight * 38.0) * 0.5 + 0.5;
        albedo = albedo * mix(0.80, 0.94, lenticel);
    }

    let lit = albedo * (
        fragUniforms.ambientColor * fragUniforms.ambientIntensity * baseAO * 0.85
      + fragUniforms.lightColor   * fragUniforms.lightIntensity   * NdotL  * baseAO
    );
    // Prevent bright "glow trunk" look in very low-light/night conditions.
    let envLight = clamp(fragUniforms.ambientIntensity * 0.62 + fragUniforms.lightIntensity * 0.88, 0.20, 1.0);

    var color = lit * envLight;
    let fog = 1.0 - exp(-in.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));
    color = color / (color + vec3<f32>(1.0));

    return vec4<f32>(color, 1.0);
}
`;
}

// ═════════════════════════════════════════════════════════════════════════
// CANOPY HULL PIPELINE
// ═════════════════════════════════════════════════════════════════════════

export function buildMidNearCanopyHullVertexShader(config = {}) {
    const MAX_ANCHORS = config.maxAnchorsPerTree ?? 16;
    const HULL_INFLATION = Number(config.hullInflation ?? 1.05).toFixed(4);
    const HULL_SHRINK_WRAP = Number(config.hullShrinkWrap ?? 0.65).toFixed(4);
    const HULL_VERTICAL_BIAS = Number(config.hullVerticalBias ?? 1.20).toFixed(4);
    const HULL_SPREAD_RADIAL_SCALE = Number(config.hullSpreadRadialScale ?? 1.00).toFixed(4);
    const HULL_SPREAD_VERTICAL_SCALE = Number(config.hullSpreadVerticalScale ?? 0.35).toFixed(4);
    const HULL_THIN_BASE = Number(config.hullThinBase ?? 0.12).toFixed(4);
    const HULL_TOP_SHRINK_START = Number(config.hullTopShrinkStart ?? 0.65).toFixed(4);
    const HULL_TOP_SHRINK_END = Number(config.hullTopShrinkEnd ?? 0.98).toFixed(4);
    const HULL_TOP_SHRINK_STRENGTH = Number(config.hullTopShrinkStrength ?? 0.28).toFixed(4);

    return /* wgsl */`

const MAX_ANCHORS_PER_TREE: u32 = ${MAX_ANCHORS}u;
const HULL_INFLATION: f32 = ${HULL_INFLATION};
const HULL_SHRINK_WRAP: f32 = ${HULL_SHRINK_WRAP};
const HULL_VERTICAL_BIAS: f32 = ${HULL_VERTICAL_BIAS};
const HULL_SPREAD_RADIAL_SCALE: f32 = ${HULL_SPREAD_RADIAL_SCALE};
const HULL_SPREAD_VERTICAL_SCALE: f32 = ${HULL_SPREAD_VERTICAL_SCALE};
const HULL_THIN_BASE: f32 = ${HULL_THIN_BASE};
const HULL_TOP_SHRINK_START: f32 = ${HULL_TOP_SHRINK_START};
const HULL_TOP_SHRINK_END: f32 = ${HULL_TOP_SHRINK_END};
const HULL_TOP_SHRINK_STRENGTH: f32 = ${HULL_TOP_SHRINK_STRENGTH};

struct HullUniforms {
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

struct MidNearTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, subBand: u32, subBandBlendBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    anchorStart: u32, anchorCount: u32, templateIndex: u32, impostorCount: u32,
    sourceIndex: u32, _res0: u32, tileTypeId: u32, _res1: u32,
    windPhase: f32, health: f32, age: f32, tierFade: f32,
    _res2: u32, _res3: u32, _res4: u32, _res5: u32,
}

struct AnchorPoint {
    posX: f32, posY: f32, posZ: f32, spread: f32,
    dirX: f32, dirY: f32, dirZ: f32, density: f32,
    tier: u32, childStart: u32, childCount: u32, parentIdx: u32,
}

@group(0) @binding(0) var<uniform>       uniforms:  HullUniforms;
@group(0) @binding(1) var<storage, read> trees:     array<MidNearTreeInfo>;
@group(0) @binding(2) var<storage, read> anchors:   array<AnchorPoint>;

struct VertexInput {
    @location(0) position: vec3<f32>,  // unit sphere
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPos:   vec4<f32>,
    @location(0) vNormal:         vec3<f32>,
    @location(1) vColor:          vec3<f32>,
    @location(2) vDist:           f32,
    @location(3) vUV:             vec2<f32>,
    @location(4) @interpolate(flat) vTierFade: f32,
    @location(5) vLocalHeight:    f32,
    @location(6) vLocalPos:       vec3<f32>,
    @location(7) @interpolate(flat) vTreeIndex: u32,
    @location(8) vWorldPos:       vec3<f32>,
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let tree = trees[instIdx];
    let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);

    // Tree-local coordinate frame
    let sphereDir = normalize(treePos - uniforms.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));
    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    // ── Compute canopy bounds from a stratified anchor subset ───────────
    // If a tier has more anchors than MAX_ANCHORS_PER_TREE, sample evenly
    // across the tier so the hull does not bias toward the first anchors.
    let anchorStart = tree.anchorStart;
    let sourceAnchorCount = tree.anchorCount;
    let anchorCount = min(sourceAnchorCount, MAX_ANCHORS_PER_TREE);

    var bmin = vec3<f32>(1e6);
    var bmax = vec3<f32>(-1e6);
    var centroid = vec3<f32>(0.0);

    for (var i = 0u; i < anchorCount; i++) {
        var sampleOffset = i;
        if (sourceAnchorCount > anchorCount) {
            sampleOffset = (i * sourceAnchorCount) / anchorCount;
        }

        let a = anchors[anchorStart + sampleOffset];
        let localPos = vec3<f32>(
            a.posX * tree.scaleX,
            a.posY * tree.scaleY,
            a.posZ * tree.scaleZ
        );

        let spreadBase = max(0.001, a.spread);
        let spreadR = clamp(
            spreadBase * (tree.scaleX + tree.scaleZ) * 0.5 * HULL_SPREAD_RADIAL_SCALE,
            0.04, 1.60
        );
        let spreadY = clamp(
            spreadBase * tree.scaleY * HULL_SPREAD_VERTICAL_SCALE,
            0.02, spreadR
        );

        let upSpreadY = spreadY * 0.38;
        let downSpreadY = spreadY * 0.92;
        bmin = min(bmin, localPos - vec3<f32>(spreadR, downSpreadY, spreadR));
        bmax = max(bmax, localPos + vec3<f32>(spreadR, upSpreadY, spreadR));
        centroid += localPos;
    }

    if (anchorCount == 0u) {
        // Fallback: a conservative tall ellipsoid (birch-like silhouette).
        bmin = vec3<f32>(-tree.scaleX * 0.28, tree.scaleY * 0.20, -tree.scaleZ * 0.28);
        bmax = vec3<f32>( tree.scaleX * 0.28, tree.scaleY * 0.96,  tree.scaleZ * 0.28);
    }

    var centre = (bmax + bmin) * 0.5;
    if (anchorCount > 0u) {
        centre = centroid / f32(anchorCount);
    }
    var extents = max((bmax - bmin) * 0.5 * HULL_INFLATION, vec3<f32>(0.03, 0.08, 0.03));
    let radialExtent = max(extents.x, extents.z);
    extents.y = max(extents.y, radialExtent * HULL_VERTICAL_BIAS);

    // ── Vertical profile solver: thin starting ellipsoid -> tight support net
    // Solve canopy radius as r(y, theta) from anchor cross-sections.
    let yN = clamp(input.position.y * 0.5 + 0.5, 0.0, 1.0);
    let targetY = mix(bmin.y, bmax.y, yN);

    var dirXZ = vec2<f32>(1.0, 0.0);
    let dirLen = length(input.position.xz);
    if (dirLen > 1e-5) {
        dirXZ = input.position.xz / dirLen;
    }

    let crownShape = max(0.0, 1.0 - pow(abs((yN - 0.52) / 0.52), 1.75));
    let thinRad = max(0.02, radialExtent * HULL_THIN_BASE * (0.35 + 0.65 * crownShape));

    var supportRad = thinRad;
    if (anchorCount > 0u) {
        supportRad = 0.0;
        for (var i = 0u; i < anchorCount; i++) {
            var sampleOffset = i;
            if (sourceAnchorCount > anchorCount) {
                sampleOffset = (i * sourceAnchorCount) / anchorCount;
            }

            let a = anchors[anchorStart + sampleOffset];
            let localPos = vec3<f32>(
                a.posX * tree.scaleX,
                a.posY * tree.scaleY,
                a.posZ * tree.scaleZ
            );

            let spreadBase = max(0.001, a.spread);
            let spreadR = clamp(
                spreadBase * (tree.scaleX + tree.scaleZ) * 0.5 * HULL_SPREAD_RADIAL_SCALE,
                0.04, 1.60
            );
            let spreadY = clamp(
                spreadBase * tree.scaleY * HULL_SPREAD_VERTICAL_SCALE,
                0.02, spreadR
            );

            let dy = targetY - localPos.y;
            let ay = abs(dy);
            if (ay < spreadY) {
                let cross = sqrt(max(0.0, 1.0 - (dy * dy) / max(spreadY * spreadY, 1e-4)));
                let sectionR = spreadR * cross;
                let relXZ = vec2<f32>(localPos.x - centre.x, localPos.z - centre.z);
                let s = dot(relXZ, dirXZ) + sectionR;
                if (s > supportRad) {
                    supportRad = s;
                }
            }
        }
    }

    var finalRad = mix(thinRad, supportRad, HULL_SHRINK_WRAP);
    let topShrinkT = smoothstep(HULL_TOP_SHRINK_START, HULL_TOP_SHRINK_END, yN);
    let topShrink = 1.0 - topShrinkT * HULL_TOP_SHRINK_STRENGTH;
    finalRad = finalRad * topShrink;
    finalRad = clamp(finalRad, thinRad, radialExtent * 1.12);
    let deformedLocal = vec3<f32>(
        centre.x + dirXZ.x * finalRad,
        targetY,
        centre.z + dirXZ.y * finalRad
    );

    // ── Transform to world space ────────────────────────────────────────
    let worldPos = treePos
                 + rotT      * deformedLocal.x
                 + sphereDir * deformedLocal.y
                 + rotB      * deformedLocal.z;

    // Approximate normal from deformed local position against ellipsoid axes.
    let localNormal = normalize(vec3<f32>(
        (deformedLocal.x - centre.x) / max(extents.x, 0.03),
        (deformedLocal.y - centre.y) / max(extents.y, 0.03),
        (deformedLocal.z - centre.z) / max(extents.z, 0.03)
    ));
    let worldNormal = normalize(
        rotT      * localNormal.x +
        sphereDir * localNormal.y +
        rotB      * localNormal.z
    );

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos    = uniforms.projectionMatrix * viewPos;
    out.vNormal    = worldNormal;
    out.vColor     = vec3<f32>(tree.foliageR, tree.foliageG, tree.foliageB);
    out.vDist      = length(viewPos.xyz);
    out.vUV        = input.uv;
    out.vTierFade  = tree.tierFade;
    // Local height for AO: where on the canopy this vertex sits (0=bottom, 1=top)
    out.vLocalHeight = clamp((deformedLocal.y - bmin.y) / max(bmax.y - bmin.y, 0.1), 0.0, 1.0);
    out.vLocalPos = deformedLocal;
    out.vTreeIndex = instIdx;
    out.vWorldPos = worldPos;

    return out;
}
`;
}

export function buildMidNearCanopyHullFragmentShader(config = {}) {
    const fadeInStart  = Number(config.fadeInStart  ?? 55).toFixed(1);
    const fadeInEnd    = Number(config.fadeInEnd    ?? 68).toFixed(1);
    const fadeOutStart = Number(config.fadeOutStart ?? 200).toFixed(1);
    const fadeOutEnd   = Number(config.fadeOutEnd   ?? 220).toFixed(1);
    const MAX_ANCHORS = config.maxAnchorsPerTree ?? 16;
    const HULL_VERTICAL_BIAS = Number(config.hullVerticalBias ?? 1.20).toFixed(4);
    const HULL_SPREAD_RADIAL_SCALE = Number(config.hullSpreadRadialScale ?? 1.00).toFixed(4);
    const HULL_SPREAD_VERTICAL_SCALE = Number(config.hullSpreadVerticalScale ?? 0.35).toFixed(4);
    const CANOPY_ENVELOPE_EXPAND = Number(
        config.canopyEnvelopeExpand ?? config.canopyFieldGain ?? 1.03
    ).toFixed(4);
    const CANOPY_ENVELOPE_SOFTNESS = Number(
        config.canopyEnvelopeSoftness ?? config.canopyFieldSoftness ?? 0.08
    ).toFixed(4);
    const CANOPY_BUMP_STRENGTH = Number(config.canopyBumpStrength ?? 0.22).toFixed(4);
    const CANOPY_CUTOUT_STRENGTH = Number(config.canopyCutoutStrength ?? 0.018).toFixed(4);
    const CANOPY_BRIGHTNESS = Number(config.canopyBrightness ?? 1.12).toFixed(4);
    const hasTex = config.enableCanopyTexture === true;

    const texBinds = hasTex ? `
@group(1) @binding(1) var canopyTex:  texture_2d_array<f32>;
@group(1) @binding(2) var canopySamp: sampler;
` : '';

    const texSample = hasTex ? `
    // Leafy procedural texture from MidNearTextureBaker layer 0, sampled
    // triplanar in local space to avoid spherical UV stretching.
    let localP = in.vLocalPos * 1.35;
    let wRaw = abs(normalize(in.vNormal)) + vec3<f32>(0.001);
    let w = wRaw / (wRaw.x + wRaw.y + wRaw.z);

    let texX = textureSample(canopyTex, canopySamp, localP.yz, 0).rgb;
    let texY = textureSample(canopyTex, canopySamp, localP.xz, 0).rgb;
    let texZ = textureSample(canopyTex, canopySamp, localP.xy, 0).rgb;
    let texTri = texX * w.x + texY * w.y + texZ * w.z;

    let fineA = textureSample(canopyTex, canopySamp, localP.xz * 2.8 + vec2<f32>(0.17, 0.31), 0).rgb;
    let fineB = textureSample(canopyTex, canopySamp, localP.yx * 3.6 + vec2<f32>(0.43, 0.11), 0).rgb;
    var leafyTex = texTri * 0.70 + (fineA * 0.6 + fineB * 0.4) * 0.30;
    let n0 = fract(sin(dot(localP, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let n1 = fract(sin(dot(localP * 1.93 + vec3<f32>(0.17, 0.37, 0.53), vec3<f32>(23.131, 11.219, 91.733))) * 15731.743);
    let proc = mix(0.60, 1.45, n0 * 0.65 + n1 * 0.35);
    leafyTex = pow(clamp(leafyTex * proc, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.85));
    albedo = mix(albedo * 0.35, leafyTex * 1.85, 0.95);
` : `
    // Fallback when texture bind is unavailable: procedural leafy breakup.
    let p = in.vLocalPos * 2.8;
    let n0 = fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let n1 = fract(sin(dot(p * 2.11 + vec3<f32>(0.21, 0.43, 0.17), vec3<f32>(27.123, 19.777, 63.517))) * 19641.531);
    let n = clamp(n0 * 0.6 + n1 * 0.4, 0.0, 1.0);
    let leafyTex = mix(vec3<f32>(0.16, 0.30, 0.10), vec3<f32>(0.64, 0.90, 0.40), n);
    albedo = mix(albedo * 0.35, leafyTex * 1.55, 0.95);
`;

    return /* wgsl */`

${BAYER_WGSL}

struct HullFragUniforms {
    lightDirection: vec3<f32>, lightIntensity: f32,
    lightColor:     vec3<f32>, _pad0: f32,
    ambientColor:   vec3<f32>, ambientIntensity: f32,
    fogColor:       vec3<f32>, fogDensity: f32,
}

struct HullGeomUniforms {
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

struct MidNearTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, subBand: u32, subBandBlendBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    anchorStart: u32, anchorCount: u32, templateIndex: u32, impostorCount: u32,
    sourceIndex: u32, _res0: u32, tileTypeId: u32, _res1: u32,
    windPhase: f32, health: f32, age: f32, tierFade: f32,
    _res2: u32, _res3: u32, _res4: u32, _res5: u32,
}

struct AnchorPoint {
    posX: f32, posY: f32, posZ: f32, spread: f32,
    dirX: f32, dirY: f32, dirZ: f32, density: f32,
    tier: u32, childStart: u32, childCount: u32, parentIdx: u32,
}

struct FragInput {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) vNormal:   vec3<f32>,
    @location(1) vColor:    vec3<f32>,
    @location(2) vDist:     f32,
    @location(3) vUV:       vec2<f32>,
    @location(4) @interpolate(flat) vTierFade: f32,
    @location(5) vLocalHeight: f32,
    @location(6) vLocalPos: vec3<f32>,
    @location(7) @interpolate(flat) vTreeIndex: u32,
    @location(8) vWorldPos: vec3<f32>,
}

@group(0) @binding(0) var<uniform> hullUniforms: HullGeomUniforms;
@group(0) @binding(1) var<storage, read> trees:   array<MidNearTreeInfo>;
@group(0) @binding(2) var<storage, read> anchors: array<AnchorPoint>;
@group(1) @binding(0) var<uniform> fragUniforms: HullFragUniforms;
${texBinds}

const FADE_IN_START:  f32 = ${fadeInStart};
const FADE_IN_END:    f32 = ${fadeInEnd};
const FADE_OUT_START: f32 = ${fadeOutStart};
const FADE_OUT_END:   f32 = ${fadeOutEnd};
const MAX_ANCHORS_PER_TREE: u32 = ${MAX_ANCHORS}u;
const HULL_VERTICAL_BIAS: f32 = ${HULL_VERTICAL_BIAS};
const HULL_SPREAD_RADIAL_SCALE: f32 = ${HULL_SPREAD_RADIAL_SCALE};
const HULL_SPREAD_VERTICAL_SCALE: f32 = ${HULL_SPREAD_VERTICAL_SCALE};
const CANOPY_ENVELOPE_EXPAND: f32 = ${CANOPY_ENVELOPE_EXPAND};
const CANOPY_ENVELOPE_SOFTNESS: f32 = ${CANOPY_ENVELOPE_SOFTNESS};
const CANOPY_BUMP_STRENGTH: f32 = ${CANOPY_BUMP_STRENGTH};
const CANOPY_CUTOUT_STRENGTH: f32 = ${CANOPY_CUTOUT_STRENGTH};
const CANOPY_BRIGHTNESS: f32 = ${CANOPY_BRIGHTNESS};

@fragment
fn main(in: FragInput) -> @location(0) vec4<f32> {
    let fadeIn  = smoothstep(FADE_IN_START,  FADE_IN_END,  in.vDist);
    let fadeOut = 1.0 - smoothstep(FADE_OUT_START, FADE_OUT_END, in.vDist);
    // Keep canopy occupancy stable through near→mid handoff:
    // avoid a mid-tier "thin dip" while near-tier is phasing out.
    let handoffFloor = mix(0.90, 1.00, fadeIn);
    let tierFade = clamp(handoffFloor * fadeOut, 0.0, 1.0);

    let N = normalize(in.vNormal);
    let V = normalize(hullUniforms.cameraPosition - in.vWorldPos);

    // Cheap pseudo-bump in tangent frame.
    var t1 = cross(N, vec3<f32>(0.0, 1.0, 0.0));
    if (length(t1) < 1e-4) {
        t1 = cross(N, vec3<f32>(1.0, 0.0, 0.0));
    }
    t1 = normalize(t1);
    let t2 = normalize(cross(N, t1));

    let bp = in.vLocalPos * 6.0;
    let bx = sin(dot(bp, vec3<f32>(2.31, 1.77, 3.13))) * 0.60
           + sin(dot(bp * 1.9 + vec3<f32>(0.31, 0.17, 0.57), vec3<f32>(1.41, 3.77, 2.19))) * 0.40;
    let by = sin(dot(bp, vec3<f32>(3.61, 1.29, 2.47))) * 0.60
           + sin(dot(bp * 2.3 + vec3<f32>(0.93, 0.11, 0.41), vec3<f32>(2.07, 2.71, 3.37))) * 0.40;
    let Nd = normalize(N + (t1 * bx + t2 * by) * CANOPY_BUMP_STRENGTH);

    // Tiny raggedness at silhouette-facing rim only.
    let rim = pow(clamp(1.0 - abs(dot(Nd, V)), 0.0, 1.0), 3.2);

    // Persistent porous coverage so canopy does not become a solid blob
    // after transition. Keep variation subtle and spatially uniform.
    let tree = trees[in.vTreeIndex];
    let seedNorm = f32(tree.variantSeed & 65535u) * (1.0 / 65535.0);
    let seed3 = vec3<f32>(
        seedNorm * 11.3 + 0.73,
        seedNorm * 7.9  + 1.31,
        seedNorm * 13.7 + 2.17
    );

    let anchorCount = min(tree.anchorCount, MAX_ANCHORS_PER_TREE);
    let probeCount = min(anchorCount, 12u);

    var anchorDensity = 0.0;
    if (probeCount > 0u) {
        for (var i = 0u; i < probeCount; i++) {
            let sampleOffset = (i * anchorCount) / probeCount;
            let a = anchors[tree.anchorStart + sampleOffset];

            let ap = vec3<f32>(
                a.posX * tree.scaleX,
                a.posY * tree.scaleY,
                a.posZ * tree.scaleZ
            );

            let spreadBase = max(0.001, a.spread);
            let spreadR = clamp(
                spreadBase * (tree.scaleX + tree.scaleZ) * 0.5 * HULL_SPREAD_RADIAL_SCALE,
                0.04, 1.60
            );
            let spreadY = clamp(
                spreadBase * tree.scaleY * HULL_SPREAD_VERTICAL_SCALE,
                0.02, spreadR
            );

            let rel = in.vLocalPos - ap;
            // Tighter density kernel than geometry kernel:
            // dense near anchors, visibly thinner between them.
            let densR = max(spreadR * 0.58, 0.03);
            let densY = max(spreadY * 0.46, 0.03);
            let dEll = length(vec3<f32>(
                rel.x / densR,
                rel.y / densY,
                rel.z / densR
            ));
            let localInfluence = 1.0 - smoothstep(0.42, 1.15, dEll);
            anchorDensity = max(anchorDensity, localInfluence);
        }
    } else {
        anchorDensity = 0.45;
    }

    let densP = in.vLocalPos * vec3<f32>(9.3, 6.1, 9.3) + seed3;
    let densN0 = fract(sin(dot(densP, vec3<f32>(17.13, 41.37, 29.97))) * 15731.743);
    let densN1 = fract(sin(dot(densP * 1.61 + vec3<f32>(1.11, 0.23, 0.67), vec3<f32>(39.346, 11.135, 83.155))) * 24634.6345);
    let densityNoise = clamp(densN0 * 0.65 + densN1 * 0.35, 0.0, 1.0);

    let support = clamp(anchorDensity, 0.0, 1.0);
    let supportCore = smoothstep(0.08, 0.52, support);
    let supportFeather = smoothstep(0.03, 0.18, support);

    // Keep hull as lightweight volume support; impostor strands should
    // carry most of the visible leaf mass in near-mid.
    var canopyDensity = 0.18 + 0.46 * pow(supportCore, 0.88);

    // Reduce chunky low-canopy fill near trunk base.
    let baseAtten = mix(0.62, 0.95, smoothstep(0.10, 0.42, in.vLocalHeight));
    canopyDensity = canopyDensity * baseAtten;

    // Side views (against horizon) need significantly more fill than top-down
    // to avoid a "mosquito net" look.
    let upN = normalize(in.vWorldPos - hullUniforms.planetOrigin);
    let sideView = smoothstep(0.12, 0.92, 1.0 - abs(dot(V, upN)));
    canopyDensity += sideView * 0.10;

    let noiseAmp = mix(1.0, mix(0.975, 1.025, densityNoise), supportFeather);
    canopyDensity = canopyDensity * noiseAmp;
    canopyDensity = clamp(canopyDensity, 0.14, 0.90);

    // Coverage mask in local space (camera-stable), not screen-space dither.
    // Use lower frequency with side-view bias to avoid perforated silhouettes.
    let covP = in.vLocalPos * vec3<f32>(18.0, 14.0, 18.0) + seed3 * 2.0;
    let cov0 = fract(sin(dot(covP, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let cov1 = fract(sin(dot(covP * 1.87 + vec3<f32>(0.37, 0.11, 0.59), vec3<f32>(23.417, 51.823, 19.151))) * 24634.6345);
    let cov2 = fract(sin(dot(covP * 0.47 + seed3 * 1.7, vec3<f32>(31.713, 14.117, 53.271))) * 19641.531);
    var coverageNoise = clamp(cov0 * 0.52 + cov1 * 0.30 + cov2 * 0.18, 0.0, 1.0);
    coverageNoise = mix(coverageNoise, smoothstep(0.18, 0.88, coverageNoise), 0.35);

    let sideFill = mix(0.0, 0.12, sideView);
    let fadeCov = clamp(tierFade * canopyDensity + sideFill, 0.0, 1.0);
    if (coverageNoise > fadeCov) { discard; }

    let edgeCut = CANOPY_CUTOUT_STRENGTH * rim * mix(1.0, 0.75, sideView);
    if (edgeCut > 1e-4) {
        let rag = fract(sin(dot(in.vLocalPos * 24.0 + seed3, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
        if (rag > (1.0 - edgeCut)) {
            discard;
        }
    }

    let L = normalize(fragUniforms.lightDirection);

    // Wrap-Lambert for foliage
    let NdotL = dot(Nd, L);
    let wrapNdotL = max(NdotL * 0.45 + 0.55, 0.0);
    let diffuse = wrapNdotL;
    let trans = max(-NdotL, 0.0) * 0.22;

    // Canopy self-shadowing: bottom of canopy is darker
    let canopyAO = mix(0.82, 1.05, in.vLocalHeight);

    var albedo = in.vColor;
${texSample}

    let lit = albedo * (
        fragUniforms.ambientColor * fragUniforms.ambientIntensity * canopyAO * 1.05
      + fragUniforms.lightColor   * fragUniforms.lightIntensity   * (diffuse + trans) * canopyAO * 1.10
    );

    var color = lit * CANOPY_BRIGHTNESS;
    let fog = 1.0 - exp(-in.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));
    color = color / (color + vec3<f32>(1.0));

    return vec4<f32>(color, 1.0);
}
`;
}

// ═════════════════════════════════════════════════════════════════════════
// IMPOSTOR PIPELINE
// ═════════════════════════════════════════════════════════════════════════

const ANCHOR_INSTANCE_WGSL = /* wgsl */`
struct AnchorInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    sizeA: f32, sizeB: f32, upX: f32, upY: f32,
    upZ: f32, subBand: u32, weightBits: u32, hangBits: u32,
    colorR: f32, colorG: f32, colorB: f32, anchorSeedBits: u32,
}
`;

export function buildMidNearImpostorVertexShader(config = {}) {
    return /* wgsl */`

${ANCHOR_INSTANCE_WGSL}

struct ImpostorUniforms {
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

@group(0) @binding(0) var<uniform>       uniforms:  ImpostorUniforms;
@group(0) @binding(1) var<storage, read> instances: array<AnchorInstance>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPos:   vec4<f32>,
    @location(0) vUV:             vec2<f32>,
    @location(1) vNormal:         vec3<f32>,
    @location(2) vColor:          vec3<f32>,
    @location(3) vDist:           f32,
    @location(4) vWeight:         f32,
    @location(5) @interpolate(flat) vSubBand: u32,
    @location(6) @interpolate(flat) vAnchorSeed: u32,
    @location(7) @interpolate(flat) vHang: f32,
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let inst = instances[instIdx];
    let centre = vec3<f32>(inst.posX, inst.posY, inst.posZ);
    let weight = bitcast<f32>(inst.weightBits);
    let hang = clamp(bitcast<f32>(inst.hangBits), 0.0, 1.0);

    let sphereDir = normalize(centre - uniforms.planetOrigin);
    var upAxis = vec3<f32>(inst.upX, inst.upY, inst.upZ);
    if (length(upAxis) < 1e-4) {
        upAxis = sphereDir;
    } else {
        upAxis = normalize(upAxis);
    }

    var rotT: vec3<f32>;
    var rotB: vec3<f32>;
    // Axial billboard for all sub-bands:
    // preserve droop direction as up-axis, but face cards toward camera
    // so families read as hanging curtains instead of radial spikes.
    let toCam = normalize(uniforms.cameraPosition - centre);
    var right = cross(upAxis, toCam);
    let rLen = length(right);
    if (rLen > 1e-4) {
        right = right / rLen;
        let fwd = normalize(cross(right, upAxis));
        let cosR = cos(inst.rotation); let sinR = sin(inst.rotation);
        rotT =  right * cosR + fwd * sinR;
        rotB = -right * sinR + fwd * cosR;
    } else {
        var refDir = sphereDir;
        if (abs(dot(upAxis, refDir)) > 0.97) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
        if (abs(dot(upAxis, refDir)) > 0.97) { refDir = vec3<f32>(0.0, 0.0, 1.0); }
        let baseRight = normalize(cross(upAxis, refDir));
        let baseFwd = normalize(cross(baseRight, upAxis));
        let cosR = cos(inst.rotation); let sinR = sin(inst.rotation);
        rotT =  baseRight * cosR + baseFwd * sinR;
        rotB = -baseRight * sinR + baseFwd * cosR;
    }

    var local = input.position * vec3<f32>(inst.sizeA, inst.sizeB, inst.sizeA);
    let y01 = clamp(input.uv.y, 0.0, 1.0);
    let sideShiftSeed = f32(inst.anchorSeedBits & 1023u) * (1.0 / 1023.0) - 0.5;
    let midBelly = exp(-pow((y01 - 0.42) / 0.24, 2.0));
    let topPinch = smoothstep(0.62, 1.0, y01);
    let lowPinch = 1.0 - smoothstep(0.00, 0.16, y01);
    var widthProfile = (0.86 + 0.42 * midBelly) * mix(1.0, 0.93, hang);
    widthProfile = widthProfile * mix(1.0, 0.72, topPinch * hang);
    widthProfile = widthProfile * mix(1.0, 0.90, lowPinch * hang);
    local.x = local.x * widthProfile;
    let sway = sin(y01 * (5.8 + hang * 2.7) + sideShiftSeed * 6.2831853) * inst.sizeA * (0.03 + 0.08 * hang);
    let sideShift = sideShiftSeed * inst.sizeA * (0.03 + 0.12 * hang) * smoothstep(0.16, 1.0, y01);
    local.x = local.x + sway + sideShift;
    let alongBend = pow(y01, 1.45) * inst.sizeB * (0.05 + 0.30 * hang);
    local.z = local.z + alongBend;

    let worldPos = centre
                 + rotT      * local.x
                 + upAxis    * local.y
                 + rotB      * local.z;

    let worldNormal = rotB;

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos  = uniforms.projectionMatrix * viewPos;
    out.vUV      = input.uv;
    out.vNormal  = worldNormal;
    out.vColor   = vec3<f32>(inst.colorR, inst.colorG, inst.colorB);
    out.vDist    = length(viewPos.xyz);
    out.vWeight  = weight;
    out.vSubBand = inst.subBand;
    out.vAnchorSeed = bitcast<u32>(bitcast<f32>(inst.anchorSeedBits));
    out.vHang = hang;

    return out;
}
`;
}

export function buildMidNearImpostorFragmentShader(config = {}) {
    const fadeInStart  = Number(config.fadeInStart  ?? 55).toFixed(1);
    const fadeInEnd    = Number(config.fadeInEnd    ?? 68).toFixed(1);
    const fadeOutStart = Number(config.fadeOutStart ?? 200).toFixed(1);
    const fadeOutEnd   = Number(config.fadeOutEnd   ?? 220).toFixed(1);
    const TEX_VARIANTS = config.impostorTexVariants ?? 4;
    const hasTex = config.enableImpostorTexture === true;
    const alphaFromMaskRG = config.impostorAlphaFromMaskRG === true;
    const defaultCutout = alphaFromMaskRG ? 0.14 : 0.30;
    const CUTOUT = Number(config.cutoutThreshold ?? defaultCutout).toFixed(3);

    const texBinds = hasTex ? `
@group(1) @binding(1) var impTex:  texture_2d_array<f32>;
@group(1) @binding(2) var impSamp: sampler;
` : '';

    const alphaBlock = hasTex ? `
    let variantIdx = (in.vAnchorSeed ^ (in.vSubBand * 131u)) % ${TEX_VARIANTS}u;
    let uvC = in.vUV - vec2<f32>(0.5, 0.5);
    let mirrorX = select(-1.0, 1.0, (in.vAnchorSeed & 1u) == 0u);
    var uvR = vec2<f32>(uvC.x * mirrorX, uvC.y);
    let uvSx = mix(0.94, 1.06, fract(seedF * 17.0));
    let uvSy = mix(0.96, 1.04, fract(seedF * 29.0));
    uvR = vec2<f32>(uvR.x / uvSx, uvR.y / uvSy);
    let uvMaskRaw = uvR + vec2<f32>(0.5, 0.5);
    let uvMask = clamp(uvMaskRaw, vec2<f32>(0.001), vec2<f32>(0.999));
    let texel = textureSample(impTex, impSamp, uvMask, i32(variantIdx));
    let n0 = fract(sin(dot(uvMask * (19.7 + in.vHang * 7.3) + vec2<f32>(seedF * 3.1, seedF * 1.9), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let n1 = fract(sin(dot(uvMask * vec2<f32>(47.1, 29.3) + vec2<f32>(seedF * 5.7, seedF * 2.3), vec2<f32>(53.121, 17.337))) * 24634.6345);
    let tailFade = 1.0 - smoothstep(0.38, 0.98, uvMask.y);
    let erosion = (n0 * 0.62 + n1 * 0.38) * mix(${alphaFromMaskRG ? '0.006' : '0.020'}, ${alphaFromMaskRG ? '0.028' : '0.080'}, in.vHang) * tailFade;
    let shapeMod = mix(1.0, droopShape, 0.22 + 0.18 * in.vHang);
    let alphaBase = ${alphaFromMaskRG ? 'clamp(max(texel.r * 1.18, texel.g * 0.96), 0.0, 1.0)' : 'texel.a'};

    let border = min(min(uvMask.x, 1.0 - uvMask.x), min(uvMask.y, 1.0 - uvMask.y));
    let edgeSoft = smoothstep(0.0, 0.24, border);
    let edgeCore = smoothstep(0.03, 0.34, border);
    let dens0 = fract(sin(dot(uvMask * vec2<f32>(83.1, 47.2) + vec2<f32>(seedF * 13.3, seedF * 5.9), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let dens1 = fract(sin(dot(uvMask.yx * vec2<f32>(61.7, 29.4) + vec2<f32>(seedF * 23.1, seedF * 17.9), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let dens2 = fract(sin(dot(uvMask * vec2<f32>(27.9, 95.3) + vec2<f32>(seedF * 7.1, seedF * 19.7), vec2<f32>(53.121, 17.337))) * 19641.531);
    let organicNoise = clamp(dens0 * 0.52 + dens1 * 0.33 + dens2 * 0.15, 0.0, 1.0);
    let clump = smoothstep(0.24, 0.86, organicNoise);
    let leafMaskDensity = clamp(alphaBase * 0.78 + texel.r * 0.62 + texel.g * 0.28, 0.0, 1.0);
    clusterDensity = clamp(
        leafMaskDensity * mix(0.46, 1.02, clump) * mix(0.55, 1.0, edgeCore) * mix(0.48, 1.0, edgeSoft),
        0.0, 1.0
    );

    cutoutAlpha = (alphaBase - erosion) * shapeMod * clusterDensity;
    if (cutoutAlpha < ${CUTOUT}) { discard; }
    let edgeT = smoothstep(${CUTOUT}, ${Number((Number(CUTOUT) + 0.24).toFixed(3))}, cutoutAlpha);
    let melt0 = fract(sin(dot(uvMask * vec2<f32>(73.1, 41.7) + vec2<f32>(seedF * 17.3, seedF * 29.7), vec2<f32>(12.9898, 78.233))) * 15731.743);
    let melt1 = fract(sin(dot(uvMask.yx * vec2<f32>(57.3, 23.9) + vec2<f32>(seedF * 11.9, seedF * 3.7), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let meltNoise = clamp(melt0 * 0.58 + melt1 * 0.42, 0.0, 1.0);
    let meltKeep = mix(0.60, 0.992, edgeT * mix(0.68, 1.0, clusterDensity));
    if (meltNoise > meltKeep) { discard; }
    ${alphaFromMaskRG
        ? 'albedo = albedo * mix(0.82, 1.04, leafMaskDensity);'
        : 'albedo = mix(albedo, albedo * texel.rgb * 1.35, in.vWeight * 0.62);'}
` : `
    let c = in.vUV - vec2<f32>(0.5, 0.5);
    let ex = (c.x - sway) / mix(1.0, 0.58, in.vHang);
    let ey = (c.y - in.vHang * 0.08) / mix(1.0, 1.36, in.vHang);
    let r = length(vec2<f32>(ex, ey)) * 2.0;
    let ang = atan2(c.y, c.x);
    let fringe = sin(ang * 7.0 + seedF * 6.2831853) * 0.12
               + sin(ang * 11.0 + seedF * 12.566)   * 0.07;

    let border = min(min(in.vUV.x, 1.0 - in.vUV.x), min(in.vUV.y, 1.0 - in.vUV.y));
    let edgeSoft = smoothstep(0.0, 0.24, border);
    let edgeCore = smoothstep(0.03, 0.34, border);
    let dens0 = fract(sin(dot(in.vUV * vec2<f32>(83.1, 47.2) + vec2<f32>(seedF * 13.3, seedF * 5.9), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let dens1 = fract(sin(dot(in.vUV.yx * vec2<f32>(61.7, 29.4) + vec2<f32>(seedF * 23.1, seedF * 17.9), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let dens2 = fract(sin(dot(in.vUV * vec2<f32>(27.9, 95.3) + vec2<f32>(seedF * 7.1, seedF * 19.7), vec2<f32>(53.121, 17.337))) * 19641.531);
    let organicNoise = clamp(dens0 * 0.52 + dens1 * 0.33 + dens2 * 0.15, 0.0, 1.0);
    let clump = smoothstep(0.24, 0.86, organicNoise);
    let rawAlpha = (1.0 - smoothstep(0.55 + fringe, 0.95 + fringe, r)) * droopShape;
    clusterDensity = clamp(
        rawAlpha * mix(0.50, 1.02, clump) * mix(0.56, 1.0, edgeCore) * mix(0.50, 1.0, edgeSoft),
        0.0, 1.0
    );

    cutoutAlpha = clusterDensity;
    if (cutoutAlpha < ${CUTOUT}) { discard; }
    let edgeT = smoothstep(${CUTOUT}, ${Number((Number(CUTOUT) + 0.24).toFixed(3))}, cutoutAlpha);
    let melt0 = fract(sin(dot(in.vUV * vec2<f32>(73.1, 41.7) + vec2<f32>(seedF * 17.3, seedF * 29.7), vec2<f32>(12.9898, 78.233))) * 15731.743);
    let melt1 = fract(sin(dot(in.vUV.yx * vec2<f32>(57.3, 23.9) + vec2<f32>(seedF * 11.9, seedF * 3.7), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let meltNoise = clamp(melt0 * 0.58 + melt1 * 0.42, 0.0, 1.0);
    let meltKeep = mix(0.60, 0.992, edgeT * mix(0.68, 1.0, clusterDensity));
    if (meltNoise > meltKeep) { discard; }
`;

    return /* wgsl */`

${BAYER_WGSL}

struct ImpostorFragUniforms {
    lightDirection: vec3<f32>, lightIntensity: f32,
    lightColor:     vec3<f32>, _pad0: f32,
    ambientColor:   vec3<f32>, ambientIntensity: f32,
    fogColor:       vec3<f32>, fogDensity: f32,
}

struct FragInput {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) vUV:       vec2<f32>,
    @location(1) vNormal:   vec3<f32>,
    @location(2) vColor:    vec3<f32>,
    @location(3) vDist:     f32,
    @location(4) vWeight:   f32,
    @location(5) @interpolate(flat) vSubBand: u32,
    @location(6) @interpolate(flat) vAnchorSeed: u32,
    @location(7) @interpolate(flat) vHang: f32,
}

@group(1) @binding(0) var<uniform> fragUniforms: ImpostorFragUniforms;
${texBinds}

const FADE_IN_START:  f32 = ${fadeInStart};
const FADE_IN_END:    f32 = ${fadeInEnd};
const FADE_OUT_START: f32 = ${fadeOutStart};
const FADE_OUT_END:   f32 = ${fadeOutEnd};

@fragment
fn main(in: FragInput) -> @location(0) vec4<f32> {
    var albedo = in.vColor;
    let seedF = f32(in.vAnchorSeed & 0xFFFFu) / 65536.0;
    let y01 = clamp(in.vUV.y, 0.0, 1.0);
    let xC = in.vUV.x - 0.5;
    let midBelly = exp(-pow((y01 - 0.42) / 0.24, 2.0));
    let topPinch = smoothstep(0.62, 1.0, y01);
    let lowPinch = 1.0 - smoothstep(0.00, 0.16, y01);
    let sway = sin(y01 * (6.4 + in.vHang * 3.1) + seedF * 6.2831853) * (0.020 + 0.060 * in.vHang);
    var halfW = (0.13 + 0.27 * midBelly) * mix(1.0, 0.88, in.vHang);
    halfW = halfW * mix(1.0, 0.72, topPinch * in.vHang);
    halfW = halfW * mix(1.0, 0.90, lowPinch * in.vHang);
    let coreDx = abs(xC - sway);
    let coreMask = 1.0 - smoothstep(halfW, halfW + 0.065, coreDx);
    let splitGate = smoothstep(0.30, 0.95, y01) * in.vHang * 0.42;
    let splitOff = (0.045 + 0.052 * in.vHang) * (0.70 + 0.30 * sin(seedF * 31.7));
    let splitDx = abs(abs(xC - sway) - splitOff);
    let splitMask = (1.0 - smoothstep(halfW * 0.35, halfW * 0.35 + 0.045, splitDx)) * splitGate;
    let droopShape = clamp(max(coreMask, splitMask), 0.0, 1.0);
    var cutoutAlpha = 1.0;
    var clusterDensity = 1.0;

${alphaBlock}

    let porous0 = fract(sin(dot(in.vUV * vec2<f32>(121.7, 63.9) + vec2<f32>(seedF * 37.1, seedF * 19.7), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let porous1 = fract(sin(dot(in.vUV.yx * vec2<f32>(43.1, 97.3) + vec2<f32>(seedF * 9.7, seedF * 27.1), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let porousNoise = clamp(porous0 * 0.57 + porous1 * 0.43, 0.0, 1.0);
    let porousBorder = smoothstep(0.0, 0.26, min(min(in.vUV.x, 1.0 - in.vUV.x), min(in.vUV.y, 1.0 - in.vUV.y)));
    let porousKeep = clamp(cutoutAlpha * 0.90 + clusterDensity * 0.18 + porousBorder * 0.22, 0.0, 1.0);
    if (porousNoise > porousKeep) { discard; }

    let chromaNoise = fract(sin(dot(in.vUV * vec2<f32>(67.7, 39.3) + vec2<f32>(seedF * 15.7, seedF * 33.1), vec2<f32>(53.121, 17.337))) * 19641.531);
    let densityShade = mix(0.92, 1.02, clusterDensity);
    let chromaVar = mix(0.96, 1.03, chromaNoise);
    albedo = albedo * vec3<f32>(0.97, 0.94, 0.96) * densityShade * chromaVar;

    let fadeIn  = smoothstep(FADE_IN_START,  FADE_IN_END,  in.vDist);
    let fadeOut = 1.0 - smoothstep(FADE_OUT_START, FADE_OUT_END, in.vDist);
    let hangBoost = mix(0.88, 1.0, in.vHang);
    let fadeInSoft = smoothstep(FADE_IN_START, FADE_IN_END + 18.0, in.vDist);
    let tierFadeCore = fadeInSoft * fadeOut * mix(0.72, 1.0, in.vWeight) * hangBoost;
    let tierFade = max(tierFadeCore, 0.08 * fadeOut);
    let stableD0 = fract(sin(dot(in.vUV * vec2<f32>(97.13, 57.31) + vec2<f32>(seedF * 3.7, seedF * 5.1), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let stableD1 = fract(sin(dot(in.vUV.yx * vec2<f32>(41.73, 83.19) + vec2<f32>(seedF * 7.9, seedF * 2.3), vec2<f32>(39.346, 11.135))) * 24634.6345);
    let stableDither = clamp(stableD0 * 0.62 + stableD1 * 0.38, 0.0, 1.0);
    if (stableDither > tierFade) { discard; }

    let N = normalize(in.vNormal);
    let L = normalize(fragUniforms.lightDirection);
    let NdotL = dot(N, L);
    let front = max( NdotL, 0.0);
    let back  = max(-NdotL, 0.0);
    let diffuse = fragUniforms.lightColor * fragUniforms.lightIntensity
                * (front * 0.65 + back * 0.28);
    let ambient = fragUniforms.ambientColor * fragUniforms.ambientIntensity * 0.75;

    let weightBoost = mix(0.55, 1.0, in.vWeight);

    var color = albedo * (ambient + diffuse) * weightBoost;
    color *= mix(0.76, 0.98, in.vUV.y);

    let fog = 1.0 - exp(-in.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));
    color = color / (color + vec3<f32>(1.0));

    return vec4<f32>(color, 1.0);
}
`;
}
