// js/renderer/streamer/shaders/midTreeRender.wgsl.js
//
// Trunk and hull render shaders for the mid tier.
//
// The hull VS is the rewrite. It reads PRECOMPUTED canopy bounds from
// MidTreeInfo (set by the tracker) and only does a small residual
// anchor-support pass for lumpiness. The old mid-near VS did the full
// bounds computation twice per vertex.
//
// The hull FS has NO anchor loop. Porosity is noise-only. At 200m+
// anchor-cluster density is below the Nyquist limit anyway.

const MID_TREE_INFO_WGSL = /* wgsl */`
struct MidTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, templateIndex: u32, tierFadeBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    anchorStart: u32, anchorCount: u32, _r40: u32, _r41: u32,
    canopyCenterX: f32, canopyCenterY: f32, canopyCenterZ: f32, _r5: f32,
    canopyExtentX: f32, canopyExtentY: f32, canopyExtentZ: f32, _r6: f32,
    _r70: f32, _r71: f32, _r72: f32, _r73: f32,
}
`;

const DITHER_WGSL = /* wgsl */`
// Spatial hash dither. Stable in screen space, no temporal shimmer
// (unlike Bayer which can alias with geometry edges at certain distances).
fn ditherDiscard(fragCoord: vec4<f32>, fade: f32) -> bool {
    let px = vec2<u32>(fragCoord.xy);
    var s = px.x * 1664525u + px.y * 1013904223u + 747796405u;
    s = (s ^ (s >> 16u)) * 2246822519u;
    s = s ^ (s >> 13u);
    let n = f32(s & 0x00FFFFFFu) / 16777216.0;
    return n > fade;
}
`;

const UNIFORMS_WGSL = /* wgsl */`
struct MidUniforms {
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

struct MidFragUniforms {
    lightDirection: vec3<f32>, lightIntensity: f32,
    lightColor:     vec3<f32>, _pad0: f32,
    ambientColor:   vec3<f32>, ambientIntensity: f32,
    fogColor:       vec3<f32>, fogDensity: f32,
}
`;

// ═════════════════════════════════════════════════════════════════════════
// TRUNK
// ═════════════════════════════════════════════════════════════════════════

export function buildMidTrunkVertexShader(config = {}) {
    const fmt = (v, fb) => Number(Number.isFinite(v) ? v : fb).toFixed(4);
    return /* wgsl */`
${UNIFORMS_WGSL}
${MID_TREE_INFO_WGSL}

const TRUNK_HEIGHT_FRAC: f32 = ${fmt(config.visibleHeightFrac, 0.38)};
const TRUNK_RADIUS_FRAC: f32 = ${fmt(config.baseRadiusFrac, 0.025)};
const TRUNK_RADIUS_MIN: f32 = 0.06;
const TRUNK_RADIUS_MAX: f32 = 0.40;

@group(0) @binding(0) var<uniform>       uniforms: MidUniforms;
@group(0) @binding(1) var<storage, read> trees: array<MidTreeInfo>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vNormal: vec3<f32>,
    @location(1) @interpolate(flat) vSpecies: u32,
    @location(2) vHeight: f32,
    @location(3) vDist: f32,
    @location(4) @interpolate(flat) vTierFade: f32,
}

fn getSpeciesBarkColor(s: u32) -> vec3<f32> {
    switch (s) {
        case 0u: { return vec3<f32>(0.25, 0.18, 0.12); }
        case 1u: { return vec3<f32>(0.40, 0.28, 0.18); }
        case 2u: { return vec3<f32>(0.68, 0.66, 0.62); }  // birch: light but not white
        case 3u: { return vec3<f32>(0.35, 0.28, 0.22); }
        case 4u: { return vec3<f32>(0.30, 0.22, 0.15); }
        case 5u: { return vec3<f32>(0.50, 0.48, 0.45); }
        default: { return vec3<f32>(0.35, 0.25, 0.18); }
    }
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;
    let tree = trees[instIdx];
    let base = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);

    let sphereDir = normalize(base - uniforms.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));
    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    let trunkH = tree.scaleY * TRUNK_HEIGHT_FRAC;
    let trunkR = clamp(tree.scaleX * TRUNK_RADIUS_FRAC, TRUNK_RADIUS_MIN, TRUNK_RADIUS_MAX);

    let local = vec3<f32>(
        input.position.x * trunkR,
        input.position.y * trunkH,
        input.position.z * trunkR
    );
    let worldPos = base + rotT * local.x + sphereDir * local.y + rotB * local.z;
    let worldNormal = normalize(rotT * input.normal.x + sphereDir * input.normal.y + rotB * input.normal.z);

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos = uniforms.projectionMatrix * viewPos;
    out.vNormal = worldNormal;
    out.vSpecies = tree.speciesIndex;
    out.vHeight = input.uv.y;
    out.vDist = length(viewPos.xyz);
    out.vTierFade = bitcast<f32>(tree.tierFadeBits);
    return out;
}
`;
}

export function buildMidTrunkFragmentShader(config = {}) {
    const fmt = (v) => Number(v).toFixed(1);
    return /* wgsl */`
${UNIFORMS_WGSL}
${DITHER_WGSL}

const FADE_IN_START:  f32 = ${fmt(config.fadeInStart ?? 180)};
const FADE_IN_END:    f32 = ${fmt(config.fadeInEnd ?? 220)};
const FADE_OUT_START: f32 = ${fmt(config.fadeOutStart ?? 520)};
const FADE_OUT_END:   f32 = ${fmt(config.fadeOutEnd ?? 600)};
// Trunk fades out earlier than hull — it's sub-pixel past ~400m.
const TRUNK_FADE_END: f32 = ${fmt(config.trunkFadeEnd ?? 400)};

struct FragInput {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) vNormal: vec3<f32>,
    @location(1) @interpolate(flat) vSpecies: u32,
    @location(2) vHeight: f32,
    @location(3) vDist: f32,
    @location(4) @interpolate(flat) vTierFade: f32,
}

@group(1) @binding(0) var<uniform> fragUniforms: MidFragUniforms;

fn getSpeciesBarkColor(s: u32) -> vec3<f32> {
    switch (s) {
        case 0u: { return vec3<f32>(0.25, 0.18, 0.12); }
        case 1u: { return vec3<f32>(0.40, 0.28, 0.18); }
        case 2u: { return vec3<f32>(0.68, 0.66, 0.62); }
        case 3u: { return vec3<f32>(0.35, 0.28, 0.22); }
        case 4u: { return vec3<f32>(0.30, 0.22, 0.15); }
        case 5u: { return vec3<f32>(0.50, 0.48, 0.45); }
        default: { return vec3<f32>(0.35, 0.25, 0.18); }
    }
}

@fragment
fn main(in: FragInput) -> @location(0) vec4<f32> {
    let tierIn  = smoothstep(FADE_IN_START, FADE_IN_END, in.vDist);
    let tierOut = 1.0 - smoothstep(FADE_OUT_START, FADE_OUT_END, in.vDist);
    let trunkOut = 1.0 - smoothstep(TRUNK_FADE_END * 0.75, TRUNK_FADE_END, in.vDist);
    let fade = tierIn * tierOut * trunkOut;
    if (ditherDiscard(in.fragCoord, fade)) { discard; }

    let N = normalize(in.vNormal);
    let L = normalize(fragUniforms.lightDirection);
    let NdotL = max(dot(N, L), 0.0);

    var albedo = getSpeciesBarkColor(in.vSpecies);
    // Birch lenticel bands — cheap, reads well even at 200m.
    if (in.vSpecies == 2u) {
        let lenticel = sin(in.vHeight * 38.0) * 0.5 + 0.5;
        albedo = albedo * mix(0.80, 0.94, lenticel);
    }
    let baseAO = mix(0.55, 1.0, smoothstep(0.0, 0.15, in.vHeight));

    let lit = albedo * (
        fragUniforms.ambientColor * fragUniforms.ambientIntensity * baseAO * 0.85 +
        fragUniforms.lightColor   * fragUniforms.lightIntensity   * NdotL  * baseAO
    );

    var color = lit;
    let fog = 1.0 - exp(-in.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));
    color = color / (color + vec3<f32>(1.0));

    return vec4<f32>(color, 1.0);
}
`;
}

// ═════════════════════════════════════════════════════════════════════════
// HULL
// ═════════════════════════════════════════════════════════════════════════

export function buildMidHullVertexShader(config = {}) {
    const VS_ANCHOR_SAMPLES = Math.max(0, config.vsAnchorSamples ?? 8);
    const fmt = (v, fb) => Number(Number.isFinite(v) ? v : fb).toFixed(4);

    // Anchor support loop is only emitted if samples > 0. Pure ellipsoid
    // is a valid (and cheapest) configuration.
    const anchorSupportBlock = VS_ANCHOR_SAMPLES > 0 ? /* wgsl */`
    // ── Residual anchor support ─────────────────────────────────────────
    // Bounds are already computed. This pass adds per-direction
    // lumpiness by checking which anchors extend furthest in the
    // current vertex's direction. Only ${VS_ANCHOR_SAMPLES} reads.
    let srcCount = tree.anchorCount;
    if (srcCount > 0u) {
        var supportRad: f32 = 0.0;
        let sampleCount = min(srcCount, ${VS_ANCHOR_SAMPLES}u);
        for (var i = 0u; i < sampleCount; i++) {
            var off = i;
            if (srcCount > sampleCount) { off = (i * srcCount) / sampleCount; }
            let a = anchors[tree.anchorStart + off];
            let lp = vec3<f32>(a.posX * tree.scaleX, a.posY * tree.scaleY, a.posZ * tree.scaleZ);
            let dy = targetY - lp.y;
            let spreadY = max(0.04, a.spread * tree.scaleY * 0.4);
            if (abs(dy) < spreadY) {
                let crossFrac = sqrt(max(0.0, 1.0 - (dy * dy) / (spreadY * spreadY)));
                let spreadR = clamp(a.spread * (tree.scaleX + tree.scaleZ) * 0.5, 0.05, 2.0);
                let rel = vec2<f32>(lp.x - centre.x, lp.z - centre.z);
                supportRad = max(supportRad, dot(rel, dirXZ) + spreadR * crossFrac);
            }
        }
        finalRad = mix(finalRad, max(finalRad, supportRad), HULL_SHRINK_WRAP);
    }
    ` : `// VS_ANCHOR_SAMPLES = 0: pure ellipsoid, no anchor reads.`;

    return /* wgsl */`
${UNIFORMS_WGSL}
${MID_TREE_INFO_WGSL}

struct AnchorPoint {
    posX: f32, posY: f32, posZ: f32, spread: f32,
    dirX: f32, dirY: f32, dirZ: f32, density: f32,
    tier: u32, childStart: u32, childCount: u32, parentIdx: u32,
}

const HULL_INFLATION:    f32 = ${fmt(config.inflation, 0.95)};
const HULL_SHRINK_WRAP:  f32 = ${fmt(config.shrinkWrap, 0.55)};
const HULL_VERT_BIAS:    f32 = ${fmt(config.verticalBias, 1.15)};
const TOP_SHRINK_START:  f32 = ${fmt(config.topShrinkStart, 0.60)};
const TOP_SHRINK_STRENGTH: f32 = ${fmt(config.topShrinkStrength, 0.35)};

@group(0) @binding(0) var<uniform>       uniforms: MidUniforms;
@group(0) @binding(1) var<storage, read> trees: array<MidTreeInfo>;
@group(0) @binding(2) var<storage, read> anchors: array<AnchorPoint>;

struct VertexInput {
    @location(0) position: vec3<f32>,  // unit sphere vertex
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vNormal:       vec3<f32>,
    @location(1) vColor:        vec3<f32>,
    @location(2) vDist:         f32,
    @location(3) vLocalHeight:  f32,
    @location(4) vLocalPos:     vec3<f32>,
    @location(5) @interpolate(flat) vTierFade: f32,
    @location(6) @interpolate(flat) vSeed: u32,
    @location(7) vWorldPos:     vec3<f32>,
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;
    let tree = trees[instIdx];
    let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);

    // ── Tree-local frame ────────────────────────────────────────────────
    let sphereDir = normalize(treePos - uniforms.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));
    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    // ── Precomputed bounds (from tracker) ───────────────────────────────
    let centre = vec3<f32>(tree.canopyCenterX, tree.canopyCenterY, tree.canopyCenterZ);
    var extent = vec3<f32>(tree.canopyExtentX, tree.canopyExtentY, tree.canopyExtentZ) * HULL_INFLATION;

    // Vertical bias: canopies are usually taller than wide (or at least
    // the silhouette reads better that way).
    let radialExt = max(extent.x, extent.z);
    extent.y = max(extent.y, radialExt * HULL_VERT_BIAS);

    // ── Map unit sphere vertex onto the ellipsoid ───────────────────────
    // input.position.y ∈ [-1, 1] → yN ∈ [0, 1]
    let yN = clamp(input.position.y * 0.5 + 0.5, 0.0, 1.0);
    let targetY = centre.y + (yN * 2.0 - 1.0) * extent.y;

    // Direction in the XZ plane.
    var dirXZ = vec2<f32>(1.0, 0.0);
    let dirLen = length(input.position.xz);
    if (dirLen > 1e-5) { dirXZ = input.position.xz / dirLen; }

    // Base ellipsoid radius at this height. Cosine profile = smooth
    // dome top and bottom.
    let vertT = abs(yN - 0.5) * 2.0;  // 0 at equator, 1 at poles
    let ellipseR = sqrt(max(0.0, 1.0 - vertT * vertT));
    var finalRad = mix(extent.x, extent.z, (dirXZ.x * dirXZ.x)) * ellipseR;

    ${anchorSupportBlock}

    // Top taper: prevents mushroom dome on tall canopies.
    let topT = smoothstep(TOP_SHRINK_START, 0.98, yN);
    finalRad = finalRad * (1.0 - topT * TOP_SHRINK_STRENGTH);

    finalRad = max(finalRad, 0.02);  // degenerate safety

    let deformedLocal = vec3<f32>(
        centre.x + dirXZ.x * finalRad,
        targetY,
        centre.z + dirXZ.y * finalRad
    );

    // ── World transform ─────────────────────────────────────────────────
    let worldPos = treePos
                 + rotT      * deformedLocal.x
                 + sphereDir * deformedLocal.y
                 + rotB      * deformedLocal.z;

    // Cheap normal: outward from the ellipsoid. Good enough at 200m+.
    let localN = normalize(vec3<f32>(
        (deformedLocal.x - centre.x) / max(extent.x, 0.05),
        (deformedLocal.y - centre.y) / max(extent.y, 0.05),
        (deformedLocal.z - centre.z) / max(extent.z, 0.05)
    ));
    let worldNormal = normalize(rotT * localN.x + sphereDir * localN.y + rotB * localN.z);

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos = uniforms.projectionMatrix * viewPos;
    out.vNormal = worldNormal;
    out.vColor = vec3<f32>(tree.foliageR, tree.foliageG, tree.foliageB);
    out.vDist = length(viewPos.xyz);
    out.vLocalHeight = yN;
    out.vLocalPos = deformedLocal;
    out.vTierFade = bitcast<f32>(tree.tierFadeBits);
    out.vSeed = tree.variantSeed;
    out.vWorldPos = worldPos;
    return out;
}
`;
}

export function buildMidHullFragmentShader(config = {}) {
    const fmt = (v) => Number(v).toFixed(3);
    const hasTex = config.enableCanopyTexture === true;

    const texBinds = hasTex ? /* wgsl */`
@group(1) @binding(1) var canopyTex:  texture_2d_array<f32>;
@group(1) @binding(2) var canopySamp: sampler;
` : '';

    const albedoBlock = hasTex ? /* wgsl */`
    // Triplanar sample, layer 0 (generic leafy noise from MidNearTextureBaker).
    let lp = in.vLocalPos * 1.2;
    let w = abs(normalize(in.vNormal)) + vec3<f32>(0.001);
    let wn = w / (w.x + w.y + w.z);
    let tx = textureSample(canopyTex, canopySamp, lp.yz, 0).rgb;
    let ty = textureSample(canopyTex, canopySamp, lp.xz, 0).rgb;
    let tz = textureSample(canopyTex, canopySamp, lp.xy, 0).rgb;
    let texTri = tx * wn.x + ty * wn.y + tz * wn.z;
    albedo = mix(albedo * 0.4, texTri * 1.6, 0.85);
` : /* wgsl */`
    // No texture: procedural value noise for albedo breakup.
    let p = in.vLocalPos * 2.2;
    let n = fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    albedo = albedo * (0.80 + n * 0.40);
`;

    return /* wgsl */`
${UNIFORMS_WGSL}
${MID_TREE_INFO_WGSL}
${DITHER_WGSL}

const FADE_IN_START:  f32 = ${fmt(config.fadeInStart ?? 180)};
const FADE_IN_END:    f32 = ${fmt(config.fadeInEnd ?? 220)};
const FADE_OUT_START: f32 = ${fmt(config.fadeOutStart ?? 520)};
const FADE_OUT_END:   f32 = ${fmt(config.fadeOutEnd ?? 600)};

const BASE_COVERAGE:     f32 = ${fmt(config.baseCoverage ?? 0.72)};
const COV_NOISE_AMP:     f32 = ${fmt(config.coverageNoiseAmp ?? 0.25)};
const COV_NOISE_SCALE:   f32 = ${fmt(config.coverageNoiseScale ?? 2.8)};
const BUMP_STRENGTH:     f32 = ${fmt(config.bumpStrength ?? 0.12)};
const BRIGHTNESS:        f32 = ${fmt(config.brightness ?? 1.05)};

struct FragInput {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) vNormal:      vec3<f32>,
    @location(1) vColor:       vec3<f32>,
    @location(2) vDist:        f32,
    @location(3) vLocalHeight: f32,
    @location(4) vLocalPos:    vec3<f32>,
    @location(5) @interpolate(flat) vTierFade: f32,
    @location(6) @interpolate(flat) vSeed: u32,
    @location(7) vWorldPos:    vec3<f32>,
}

@group(0) @binding(0) var<uniform>       hullUniforms: MidUniforms;
@group(0) @binding(1) var<storage, read> trees: array<MidTreeInfo>;
// binding 2 (anchors) is VS-only; not declared here
@group(1) @binding(0) var<uniform> fragUniforms: MidFragUniforms;
${texBinds}

// Three-octave value noise in local space. Stable (no camera dependence)
// so no shimmer when walking around a tree.
fn noise3(p: vec3<f32>) -> f32 {
    let n0 = fract(sin(dot(p,                      vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let n1 = fract(sin(dot(p * 2.03 + vec3<f32>(1.7, 9.2, 3.1), vec3<f32>(23.417, 51.823, 19.151))) * 24634.635);
    let n2 = fract(sin(dot(p * 4.11 + vec3<f32>(5.3, 2.8, 7.9), vec3<f32>(17.131, 41.337, 29.977))) * 15731.743);
    return n0 * 0.55 + n1 * 0.30 + n2 * 0.15;
}

@fragment
fn main(in: FragInput) -> @location(0) vec4<f32> {
    // ── Tier fade ────────────────────────────────────────────────────────
    let fadeIn  = smoothstep(FADE_IN_START, FADE_IN_END, in.vDist);
    let fadeOut = 1.0 - smoothstep(FADE_OUT_START, FADE_OUT_END, in.vDist);
    let tierFade = fadeIn * fadeOut;

    // ── Porosity: noise-driven coverage mask in LOCAL space ──────────────
    // This is the whole FS-side trick. Instead of per-fragment anchor
    // density (12 storage reads/fragment in the old system), use spatial
    // noise. At 200m+ the visual result is indistinguishable.
    //
    // Coverage noise is camera-independent (local-space eval) so the
    // porosity pattern is glued to the tree, not the screen. Walking
    // around a tree doesn't change which bits are cut out.
    let seedF = f32(in.vSeed & 65535u) * (1.0 / 65535.0);
    let seedOff = vec3<f32>(seedF * 11.3 + 0.7, seedF * 7.9 + 1.3, seedF * 13.7 + 2.1);

    let covNoise = noise3(in.vLocalPos * COV_NOISE_SCALE + seedOff);
    var coverage = BASE_COVERAGE + (covNoise - 0.5) * COV_NOISE_AMP;

    // Height modulation: denser at mid-canopy, sparser at top/bottom.
    // This is what real canopies look like from a distance — the
    // mid-belt has the most leaf mass.
    let heightMod = 1.0 - pow(abs(in.vLocalHeight - 0.55) * 2.0, 1.8) * 0.35;
    coverage = coverage * heightMod;

    // Side-view boost: looking at the horizon, a canopy silhouette
    // should be mostly opaque (you're looking through more leaf depth).
    // Looking down from above, it can be more porous.
    let V = normalize(hullUniforms.cameraPosition - in.vWorldPos);
    let upN = normalize(in.vWorldPos - hullUniforms.planetOrigin);
    let sideView = 1.0 - abs(dot(V, upN));       // 0 = top-down, 1 = horizontal
    coverage = coverage + sideView * 0.12;

    coverage = clamp(coverage, 0.15, 0.95);

    // Combine tier fade and coverage, discard via local-space hash.
    // The hash is evaluated at higher frequency than the coverage noise
    // so the discard pattern is fine-grained.
    let discardNoise = noise3(in.vLocalPos * 18.0 + seedOff * 2.0);
    if (discardNoise > tierFade * coverage) { discard; }

    // ── Lighting ─────────────────────────────────────────────────────────
    let N = normalize(in.vNormal);

    // Cheap pseudo-bump in tangent frame.
    var t1 = cross(N, vec3<f32>(0.0, 1.0, 0.0));
    if (dot(t1, t1) < 1e-6) { t1 = cross(N, vec3<f32>(1.0, 0.0, 0.0)); }
    t1 = normalize(t1);
    let t2 = cross(N, t1);

    let bp = in.vLocalPos * 5.0 + seedOff;
    let bx = sin(dot(bp, vec3<f32>(2.31, 1.77, 3.13)));
    let by = sin(dot(bp, vec3<f32>(3.61, 1.29, 2.47)));
    let Nd = normalize(N + (t1 * bx + t2 * by) * BUMP_STRENGTH);

    let L = normalize(fragUniforms.lightDirection);
    let NdotL = dot(Nd, L);
    // Wrap-Lambert for foliage: no hard terminator.
    let diffuse = max(NdotL * 0.5 + 0.5, 0.0);
    let trans = max(-NdotL, 0.0) * 0.20;   // thin-sheet SSS approx

    let canopyAO = mix(0.80, 1.05, in.vLocalHeight);   // self-shadow from below

    var albedo = in.vColor;
    ${albedoBlock}

    let lit = albedo * (
        fragUniforms.ambientColor * fragUniforms.ambientIntensity * canopyAO * 0.95 +
        fragUniforms.lightColor   * fragUniforms.lightIntensity   * (diffuse + trans) * canopyAO
    );

    var color = lit * BRIGHTNESS;
    let fog = 1.0 - exp(-in.vDist * fragUniforms.fogDensity);
    color = mix(color, fragUniforms.fogColor, clamp(fog, 0.0, 1.0));
    color = color / (color + vec3<f32>(1.0));

    return vec4<f32>(color, 1.0);
}
`;
}