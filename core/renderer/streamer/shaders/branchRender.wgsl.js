// js/renderer/streamer/shaders/branchRender.wgsl.js
//
// Changes:
//   • Vertex shader: distance-dependent branch hierarchy culling.
//     Reads branchLODBands (baked constants) and the tree's
//     distanceToCamera. Vertices whose hierarchy level exceeds
//     the allowed maximum for the tree's distance are collapsed
//     to a degenerate point behind the near plane. The rasteriser
//     culls degenerate triangles at zero cost.
//
//   Sort/indirect and fragment shaders: unchanged.

// ═════════════════════════════════════════════════════════════════════════
// Sort + Indirect builder (unchanged)
// ═════════════════════════════════════════════════════════════════════════

export function buildBranchSortAndIndirectShader(config = {}) {
    const VARIANT_COUNT          = config.variantCount ?? 4;
    const MAX_CLOSE_TREES        = config.maxCloseTrees ?? 64;
    const MAX_BRANCH_DETAIL_LEVEL = config.maxBranchDetailLevel ?? 0;

    return /* wgsl */`

const VARIANT_COUNT:           u32 = ${VARIANT_COUNT}u;
const MAX_CLOSE_TREES:         u32 = ${MAX_CLOSE_TREES}u;
const MAX_BRANCH_DETAIL_LEVEL: u32 = ${MAX_BRANCH_DETAIL_LEVEL}u;

struct CloseTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, detailLevel: u32, sourceIndex: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    barkR: f32, barkG: f32, barkB: f32, barkA: f32,
    leafStart: u32, leafCount: u32, clusterStart: u32, clusterCount: u32,
    windPhase: f32, health: f32, age: f32, tileTypeId: u32,
    bandBlend: f32, _res0: f32, _res1: f32, _res2: f32,
}

struct VariantMeta {
    indexStart: u32,
    indexCount: u32,
    baseVertex: u32,
    _pad:       u32,
}

struct SortParams {
    viewProjection: mat4x4<f32>,
    _pad: vec4<f32>,
}

@group(0) @binding(0) var<storage, read>       closeTrees:     array<CloseTreeInfo>;
@group(0) @binding(1) var<storage, read>       closeTreeCount: array<u32>;
@group(0) @binding(2) var<storage, read>       variantMeta:    array<VariantMeta>;
@group(0) @binding(3) var<storage, read_write> sortedTrees:    array<u32>;
@group(0) @binding(4) var<storage, read_write> sortedCounts:   array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> indirectArgs:   array<u32>;
@group(0) @binding(6) var<uniform>             params:         SortParams;

fn pcgHash(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn getRow(m: mat4x4<f32>, r: u32) -> vec4<f32> {
    return vec4<f32>(m[0][r], m[1][r], m[2][r], m[3][r]);
}

fn isTreeCulled(worldPos: vec3<f32>, radius: f32) -> bool {
    let row0 = getRow(params.viewProjection, 0u);
    let row1 = getRow(params.viewProjection, 1u);
    let row2 = getRow(params.viewProjection, 2u);
    let row3 = getRow(params.viewProjection, 3u);

    let planes = array<vec4<f32>, 6>(
        row3 + row0, row3 - row0,
        row3 + row1, row3 - row1,
        row3 + row2, row3 - row2
    );

    for (var i = 0u; i < 6u; i++) {
        let p = planes[i];
        let nLen = length(p.xyz);
        if (nLen < 1e-4) { continue; }
        if ((dot(p.xyz, worldPos) + p.w) / nLen < -radius) {
            return true;
        }
    }
    return false;
}

@compute @workgroup_size(1)
fn main() {
    let treeCount = min(closeTreeCount[0], MAX_CLOSE_TREES);

    for (var t: u32 = 0u; t < treeCount; t++) {
        let tree = closeTrees[t];

        if (tree.detailLevel > MAX_BRANCH_DETAIL_LEVEL) { continue; }

        let pos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);
        if (isTreeCulled(pos, tree.scaleY)) { continue; }

        let variant = pcgHash(tree.variantSeed) % VARIANT_COUNT;
        let slot = atomicAdd(&sortedCounts[variant], 1u);
        if (slot < MAX_CLOSE_TREES) {
            sortedTrees[variant * MAX_CLOSE_TREES + slot] = t;
        }
    }

    for (var v: u32 = 0u; v < VARIANT_COUNT; v++) {
        let vMeta = variantMeta[v];
        let count = min(atomicLoad(&sortedCounts[v]), MAX_CLOSE_TREES);

        let base = v * 5u;
        indirectArgs[base + 0u] = vMeta.indexCount;
        indirectArgs[base + 1u] = count;
        indirectArgs[base + 2u] = vMeta.indexStart;
        indirectArgs[base + 3u] = 0u;
        indirectArgs[base + 4u] = v * MAX_CLOSE_TREES;
    }
}
`;
}

// ═════════════════════════════════════════════════════════════════════════
// Vertex shader
// ═════════════════════════════════════════════════════════════════════════

export function buildBranchVertexShader(config = {}) {
    const enableWind = config.enableWind === true;

    // ── Branch hierarchy LOD: distance → max allowed level ────────────
    // Up to 4 bands. The vertex shader walks them in order; the first
    // band whose distance > tree.distanceToCamera wins. Vertices with
    // level > that band's maxLevel are collapsed to a degenerate point.
    const bandCount  = Math.min(4, config.branchLODBandCount ?? 1);
    const distances  = config.branchLODDistances ?? [9999, 9999, 9999, 9999];
    const maxLevels  = config.branchLODMaxLevels ?? [4, 4, 4, 4];

    // Format floats for WGSL. Must handle both int and float inputs.
    const fmtF = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(1) : '9999.0';
    };

    return /* wgsl */`

const ENABLE_BRANCH_WIND: bool = ${enableWind ? 'true' : 'false'};

// ── Branch hierarchy LOD bands (baked constants) ──────────────────────
// BRANCH_LOD_DISTANCES: if tree.distanceToCamera < distances[i], the
// max allowed vertex level is BRANCH_LOD_MAX_LEVELS[i]. Bands are
// tested in order; first match wins.
const BRANCH_LOD_BAND_COUNT: u32  = ${bandCount}u;
const BRANCH_LOD_DISTANCES: array<f32, 4> = array<f32, 4>(${fmtF(distances[0])}, ${fmtF(distances[1])}, ${fmtF(distances[2])}, ${fmtF(distances[3])});
const BRANCH_LOD_MAX_LEVELS: array<f32, 4> = array<f32, 4>(${fmtF(maxLevels[0])}, ${fmtF(maxLevels[1])}, ${fmtF(maxLevels[2])}, ${fmtF(maxLevels[3])});

struct BranchUniforms {
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

struct CloseTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, detailLevel: u32, sourceIndex: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    barkR: f32, barkG: f32, barkB: f32, barkA: f32,
    leafStart: u32, leafCount: u32, clusterStart: u32, clusterCount: u32,
    windPhase: f32, health: f32, age: f32, tileTypeId: u32,
    bandBlend: f32, _res0: f32, _res1: f32, _res2: f32,
}

@group(0) @binding(0) var<uniform>       uniforms:    BranchUniforms;
@group(0) @binding(1) var<storage, read> closeTrees:  array<CloseTreeInfo>;
@group(0) @binding(2) var<storage, read> sortedTrees: array<u32>;

struct VertexInput {
    @location(0) localPos:  vec3<f32>,
    @location(1) localNorm: vec3<f32>,
    @location(2) uv:        vec2<f32>,
    @location(3) level:     f32,
}

struct VertexOutput {
    @builtin(position) clipPos:       vec4<f32>,
    @location(0)       vUV:           vec2<f32>,
    @location(1)       vNormal:       vec3<f32>,
    @location(2)       vWorldPos:     vec3<f32>,
    @location(3)       vColor:        vec4<f32>,
    @location(4)       vDist:         f32,
    @location(5)       vLevelHeight:  vec2<f32>,
    @location(6)       vSpeciesIndex: f32,
    @location(7)       vTangent:      vec3<f32>,
    @location(8)       vBitangent:    vec3<f32>,
}

fn branchWind(worldPos: vec3<f32>, t: f32, phase: f32, height01: f32) -> vec3<f32> {
    let p = worldPos.xz * 0.03 + vec2<f32>(t * 0.4, t * 0.25);
    let noise = sin(p.x * 2.7 + p.y * 1.3 + phase) * 0.5
              + sin(p.x * 4.1 - p.y * 3.2 + t * 0.8 + phase) * 0.3;
    let sway = height01 * height01 * noise * 0.12;
    return vec3<f32>(
        uniforms.windDirection.x * sway * uniforms.windStrength,
        0.0,
        uniforms.windDirection.y * sway * uniforms.windStrength
    );
}

// ── Determine max allowed branch level for this tree's distance ───────
fn getMaxLevelForDistance(dist: f32) -> f32 {
    for (var i = 0u; i < BRANCH_LOD_BAND_COUNT; i++) {
        if (dist < BRANCH_LOD_DISTANCES[i]) {
            return BRANCH_LOD_MAX_LEVELS[i];
        }
    }
    // Past all bands — use the last band's level as fallback.
    return BRANCH_LOD_MAX_LEVELS[BRANCH_LOD_BAND_COUNT - 1u];
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let treeIdx = sortedTrees[instIdx];
    let tree = closeTrees[treeIdx];
    let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);

    // ── Branch hierarchy LOD: collapse vertices past the allowed level ──
    // Vertices whose hierarchy level exceeds the distance-dependent max
    // are placed at a degenerate position behind the near plane. The
    // rasteriser discards the resulting degenerate triangles at zero
    // shading cost — only the vertex shader runs for these, and this
    // branch is trivially predicted.
    let allowedLevel = getMaxLevelForDistance(tree.distanceToCamera);
    if (input.level > allowedLevel + 0.5) {
        // Place behind camera. W=1 so it's a valid homogeneous point,
        // but z > 1 in NDC → clipped by near/far.
        out.clipPos       = vec4<f32>(0.0, 0.0, -1.0, 1.0);
        out.vUV           = vec2<f32>(0.0);
        out.vNormal       = vec3<f32>(0.0, 1.0, 0.0);
        out.vWorldPos     = vec3<f32>(0.0);
        out.vDist         = 0.0;
        out.vColor        = vec4<f32>(0.0);
        out.vLevelHeight  = vec2<f32>(0.0);
        out.vSpeciesIndex = 0.0;
        out.vTangent      = vec3<f32>(0.0);
        out.vBitangent    = vec3<f32>(0.0);
        return out;
    }

    let up = normalize(treePos - uniforms.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(up, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(up, refDir));
    let bitangent = normalize(cross(up, tangent));

    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    let scaled = vec3<f32>(
        input.localPos.x * tree.scaleX,
        input.localPos.y * tree.scaleY,
        input.localPos.z * tree.scaleZ
    );

    let worldPos = treePos + rotT * scaled.x + up * scaled.y + rotB * scaled.z;

    let height01 = clamp(input.localPos.y, 0.0, 1.0);

    var wind = vec3<f32>(0.0);
    if (ENABLE_BRANCH_WIND) {
        wind = branchWind(worldPos, uniforms.time, tree.windPhase, height01);
    }
    let finalPos = worldPos + wind;

    let invScale = vec3<f32>(
        1.0 / max(tree.scaleX, 0.001),
        1.0 / max(tree.scaleY, 0.001),
        1.0 / max(tree.scaleZ, 0.001)
    );
    let scaledN = input.localNorm * invScale;
    let worldNorm = normalize(rotT * scaledN.x + up * scaledN.y + rotB * scaledN.z);

    let viewPos = uniforms.viewMatrix * vec4<f32>(finalPos, 1.0);

    let BARK_TILE_SIZE: f32 = 1.2;
    let trunkCircum = tree.scaleX * 0.94;
    let tileU = max(1.0, trunkCircum / BARK_TILE_SIZE);
    let tileV = tree.scaleY / BARK_TILE_SIZE;
    let tiledUV = vec2<f32>(input.uv.x * tileU, input.uv.y * tileV);

    out.clipPos       = uniforms.projectionMatrix * viewPos;
    out.vUV           = tiledUV;
    out.vNormal       = worldNorm;
    out.vWorldPos     = finalPos;
    out.vDist         = length(viewPos.xyz);
    out.vColor        = vec4<f32>(tree.barkR, tree.barkG, tree.barkB, 1.0);
    out.vLevelHeight  = vec2<f32>(input.level, height01);
    out.vSpeciesIndex = f32(tree.speciesIndex);
    out.vTangent      = rotT;
    out.vBitangent    = up;

    return out;
}
`;
}

export function buildBranchFragmentShader(config = {}) {
    const fadeStart = config.fadeStart ?? 150.0;
    const fadeEnd   = config.fadeEnd   ?? 200.0;
    const enableBarkTexture = config.enableBarkTexture === true;

    const bbc = config.birchBranchColor ?? [0.18, 0.12, 0.08];

    const selfOcclusion = config.selfOcclusion || {};
    const soEnabled         = selfOcclusion.enabled !== false;
    const soMasterStrength  = selfOcclusion.masterStrength   ?? 1.0;
    const soAmbientStrength = selfOcclusion.ambientStrength  ?? 1.0;
    const soDirectStrength  = selfOcclusion.directStrength   ?? 0.4;
    const soGradientWidth   = selfOcclusion.gradientWidth    ?? 0.12;
    const soDarkening       = selfOcclusion.darkening        ?? 0.35;
    const soTerrainEmbed    = selfOcclusion.terrainEmbedding ?? 0.02;
    const soStrengthMul     = selfOcclusion.strengthMul      ?? 0.8;
    const fmtF = (v) => v.toFixed(4);

    // Blend zone half-width in level units, applied ONLY at level 0→1.
    // The blend zone spans [1 - HALF_WIDTH, 1 + HALF_WIDTH].
    // Default 0.30 → blend occupies ±0.30 around the junction, giving
    // a ~2-3 cm wide transition at typical branch attachment scale.
    const seamHalfWidth = (config.seamHalfWidth ?? 0.30).toFixed(4);

    const textureBindings = enableBarkTexture ? `
@group(1) @binding(1) var barkTexture: texture_2d_array<f32>;
@group(1) @binding(2) var barkSampler: sampler;
` : '';

    const barkSampling = enableBarkTexture ? `
    let barkLayer  = i32(input.vSpeciesIndex);
    let barkSample = textureSample(barkTexture, barkSampler, input.vUV, barkLayer);
    let trunkAlbedo = barkSample.rgb;

    let texelSize = 1.0 / 512.0;
    let bumpStrength = 1.8;
    let sR = textureSample(barkTexture, barkSampler, input.vUV + vec2<f32>(texelSize, 0.0), barkLayer);
    let sU = textureSample(barkTexture, barkSampler, input.vUV + vec2<f32>(0.0, texelSize), barkLayer);
    let lumC = dot(barkSample.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let lumR = dot(sR.rgb,         vec3<f32>(0.299, 0.587, 0.114));
    let lumU = dot(sU.rgb,         vec3<f32>(0.299, 0.587, 0.114));
    let dU = (lumR - lumC) * bumpStrength;
    let dV = (lumU - lumC) * bumpStrength;
    let trunkBumpedNormal = normalize(geometricNormal - tangent * dU - bitangent * dV);
` : `
    let trunkAlbedo = input.vColor.rgb;
    let trunkBumpedNormal = geometricNormal;
`;

    const selfOcclusionCode = soEnabled ? `
fn computeBranchSelfOcclusion(height01: f32) -> vec2<f32> {
    let gradientWidth    = ${fmtF(soGradientWidth)};
    let maxDarkening     = ${fmtF(soDarkening)};
    let terrainEmbedding = ${fmtF(soTerrainEmbed)};
    let strengthMul      = ${fmtF(soStrengthMul)};
    let masterStrength   = ${fmtF(soMasterStrength)};
    let ambientStr       = ${fmtF(soAmbientStrength)};
    let directStr        = ${fmtF(soDirectStrength)};

    let effectiveY   = max(0.0, height01 - terrainEmbedding);
    let gradientT    = clamp(effectiveY / max(gradientWidth, 0.001), 0.0, 1.0);
    let occlusionRaw = (1.0 - gradientT) * (1.0 - gradientT);
    let occlusion    = occlusionRaw * maxDarkening * strengthMul * masterStrength;

    return vec2<f32>(
        max(1.0 - occlusion * ambientStr, 0.0),
        max(1.0 - occlusion * directStr,  0.0)
    );
}
` : `
fn computeBranchSelfOcclusion(height01: f32) -> vec2<f32> {
    return vec2<f32>(1.0, 1.0);
}
`;

    return /* wgsl */`

struct BranchFragUniforms {
    lightDirection:   vec3<f32>,
    lightIntensity:   f32,
    lightColor:       vec3<f32>,
    _pad0:            f32,
    ambientColor:     vec3<f32>,
    ambientIntensity: f32,
    fogColor:         vec3<f32>,
    fogDensity:       f32,
}

struct FragInput {
    @location(0) vUV:           vec2<f32>,
    @location(1) vNormal:       vec3<f32>,
    @location(2) vWorldPos:     vec3<f32>,
    @location(3) vColor:        vec4<f32>,
    @location(4) vDist:         f32,
    @location(5) vLevelHeight:  vec2<f32>,
    @location(6) vSpeciesIndex: f32,
    @location(7) vTangent:      vec3<f32>,
    @location(8) vBitangent:    vec3<f32>,
}

@group(1) @binding(0) var<uniform> fragUniforms: BranchFragUniforms;
${textureBindings}

${selfOcclusionCode}

// ── Trunk/branch seam blend — ONLY at trunk (level 0) → primary (level 1) ──
//
// WHY only here: the attachment of a primary branch to the trunk involves
// a real anatomical transition zone where bark texture and bark colour
// grade from white birch trunk to dark branch bark over ~5-15 cm.
// Higher-level junctions (secondary off primary, twig off secondary) are
// all dark bark on dark bark — there is no visible boundary to soften.
// Blending those would actually CREATE unwanted colour banding.
//
// IMPLEMENTATION: the junction sits at level = 1.0 (the root vertex of
// a primary branch chain has level = 1). The blend zone is
//   [1.0 - SEAM_HALF_WIDTH, 1.0 + SEAM_HALF_WIDTH]
// which maps to smoothstep t = [0, 1]:
//   t = 0 → pure trunk material (level < 0.70)
//   t = 1 → pure branch material (level > 1.30)
//
// Outside this window the step is clamped and no blending occurs,
// so levels 2, 3, 4 all evaluate to isBranch = 1.0 exactly.
//
// The UV-ripple warp is similarly gated to the transition zone only,
// preventing visible artifacting on twig/secondary geometry.

const SEAM_HALF_WIDTH: f32 = ${seamHalfWidth};
const SEAM_JUNCTION:   f32 = 1.0;   // level at which trunk meets primary

fn trunkBranchBlend(level: f32) -> f32 {
    // Smooth step from 0 (trunk) to 1 (branch) across the junction zone.
    // Levels >= 2 are always 1.0 (no blending at secondary/twig junctions).
    return smoothstep(SEAM_JUNCTION - SEAM_HALF_WIDTH,
                      SEAM_JUNCTION + SEAM_HALF_WIDTH,
                      level);
}

const BIRCH_BRANCH_COLOR: vec3<f32> = vec3<f32>(${bbc[0].toFixed(3)}, ${bbc[1].toFixed(3)}, ${bbc[2].toFixed(3)});

fn hash31(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 = p3 + dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn main(input: FragInput) -> @location(0) vec4<f32> {
    let geometricNormal = normalize(input.vNormal);
    let tangent         = normalize(input.vTangent);
    let bitangent       = normalize(input.vBitangent);
    let lightDir        = normalize(fragUniforms.lightDirection);

    let branchLevel = input.vLevelHeight.x;
    let height01    = input.vLevelHeight.y;

    // Blend factor: 0 = trunk material, 1 = branch material.
    // Saturates to 1.0 for level >= 1.3 (all secondary/twig geometry).
    let blendT = trunkBranchBlend(branchLevel);

    ${barkSampling}

    // ── Species tint ─────────────────────────────────────────────────────
    let isBirch         = step(1.5, input.vSpeciesIndex) * step(input.vSpeciesIndex, 2.5);
    let genericBranchC  = trunkAlbedo * vec3<f32>(0.35, 0.32, 0.28);
    let branchAlbedo    = mix(genericBranchC, BIRCH_BRANCH_COLOR, isBirch);

    // ── Albedo blend ─────────────────────────────────────────────────────
    // UV-ripple warp is ONLY applied inside the transition zone.
    // seamProximity = 0 outside the zone, 1 at the exact junction.
    let seamProximity = 1.0 - abs(blendT - 0.5) * 2.0;
    let ripple        = sin(input.vUV.x * 22.0) * 0.045 * seamProximity;
    let blendTWarp    = clamp(blendT + ripple, 0.0, 1.0);

    let albedo = mix(trunkAlbedo, branchAlbedo, blendTWarp);

    // ── Normal blend ─────────────────────────────────────────────────────
    // Use bump-mapped normal on trunk side, geometric on branch side.
    // Same blend zone.
    let normal = normalize(mix(trunkBumpedNormal, geometricNormal, blendT));

    // ── Lighting (unchanged) ─────────────────────────────────────────────
    let NdotL = dot(normal, lightDir);
    let front = max( NdotL, 0.0);
    let back  = max(-NdotL, 0.0);
    let wrap  = front * 0.75 + back * 0.15;
    let diffuse = fragUniforms.lightColor * fragUniforms.lightIntensity * wrap;
    let ambient = fragUniforms.ambientColor * fragUniforms.ambientIntensity;

    let so = computeBranchSelfOcclusion(height01);

    let grainCell = floor(input.vWorldPos * 500.0);
    let grainA    = hash31(grainCell);
    let grainB    = hash31(grainCell + vec3<f32>(7.13, 3.77, 11.31));
    // Grain amplitude: on trunk side mirrors bark texture grain (0.07),
    // on branch side is slightly lower (0.04). Interpolate.
    let grainAmp  = mix(0.07, 0.04, blendT);
    let micro     = 1.0 - grainAmp + grainAmp * (grainA * 0.6 + grainB * 0.4);

    var color = albedo * (ambient * so.x + diffuse * so.y) * micro;

    let fogFactor = 1.0 - exp(-input.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fogFactor, 0.0, 1.0));

    let distFade = 1.0 - smoothstep(${fadeStart.toFixed(1)}, ${fadeEnd.toFixed(1)}, input.vDist);
    if (distFade < 0.01) { discard; }

    return vec4<f32>(color, distFade);
}
`;
}
