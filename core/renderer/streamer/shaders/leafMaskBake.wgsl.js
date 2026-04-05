// js/renderer/streamer/shaders/leafMaskBake.wgsl.js
//
// One-time compute bake of leaf alpha masks.
//
// The helper functions below are lifted verbatim from the procedural
// path that used to live in buildLeafFragmentShader. Keep them in
// lockstep — if leaf shape tuning happens, it happens here now, and
// the runtime fragment shader just samples the result.
//
// Dispatch: (ceil(RES/8), ceil(RES/8), LAYER_COUNT).
// gid.z == layer. Layers < BIRCH_VARIANTS bake birch clusters;
// the rest bake spruce needle sprays.

export function buildLeafMaskBakeShader(config = {}) {
    const RES             = config.resolution     ?? 256;
    const BIRCH_VARIANTS  = config.birchVariants  ?? 12;
    const SPRUCE_VARIANTS = config.spruceVariants ?? 8;
    const WG_DIM          = config.workgroupDim   ?? 8;

    return /* wgsl */`
const RES:             u32 = ${RES}u;
const BIRCH_VARIANTS:  u32 = ${BIRCH_VARIANTS}u;
const SPRUCE_VARIANTS: u32 = ${SPRUCE_VARIANTS}u;

@group(0) @binding(0) var outTex: texture_storage_2d_array<rgba8unorm, write>;

// ─────────────────────────────────────────────────────────────────────────
// Helpers. These MUST match the math the old fragment path used — the
// bake is supposed to produce bit-identical masks, just precomputed.
// ─────────────────────────────────────────────────────────────────────────

fn hash1(v: f32) -> f32 {
    return fract(sin(v * 127.1) * 43758.5453);
}

fn rotate2(p: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

fn distToSegment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let ab = b - a;
    let ap = p - a;
    let abLen2 = max(dot(ab, ab), 1e-6);
    let t = clamp(dot(ap, ab) / abLen2, 0.0, 1.0);
    return length(p - (a + ab * t));
}

fn birchLeafMask(local: vec2<f32>, size: vec2<f32>, angle: f32, roughSeed: f32) -> f32 {
    let pr = rotate2(local, angle);
    let sx = max(size.x, 0.0001);
    let sy = max(size.y, 0.0001);
    let q  = vec2<f32>(pr.x / sx, pr.y / sy);
    let y01 = clamp((q.y + 1.0) * 0.5, 0.0, 1.0);
    let crownProfile = 1.0 - pow(clamp(abs(y01 - 0.38) / 0.62, 0.0, 1.0), 1.85);
    let stemPinch = mix(0.38, 1.0, smoothstep(0.0, 0.22, y01));
    let widthProfile = max(0.06, (0.10 + crownProfile * 0.88) * stemPinch);
    let side = abs(q.x) / widthProfile;
    let bodyRound = pow(abs(q.y + 0.14), 1.55) * 0.52;
    let tipT = max((y01 - 0.78) / 0.22, 0.0);
    let tipSharp = smoothstep(0.78, 1.0, y01) * pow(tipT, 1.25) * 0.92;
    let body = side + bodyRound + tipSharp;
    let edgeNoise = (
        sin((pr.x + roughSeed * 13.0) * 62.0) * 0.5 +
        sin((pr.y - roughSeed *  9.0) * 88.0) * 0.5
    ) * 0.045;
    return 1.0 - smoothstep(0.92 + edgeNoise, 1.06 + edgeNoise, body);
}

// ── Birch cluster: (leafAlpha, connectorAlpha) ────────────────────────────
// This is THE loop the fragment shader ran 2× per pixel per frame.
// variantF is the representative vCluster value for this bake layer.

fn evalBirchCluster(uv: vec2<f32>, variantF: f32) -> vec2<f32> {
    let centeredUV = uv - vec2<f32>(0.5);
    let maskVariant = min(u32(floor(variantF * f32(BIRCH_VARIANTS))), BIRCH_VARIANTS - 1u);

    var leafAlpha = 0.0;
    var connectorAlpha = 0.0;
    let leafCount = 4u + (maskVariant % 5u);
    let connectorRoot = vec2<f32>(0.0, -0.5);

    for (var i: u32 = 0u; i < 7u; i++) {
        if (i >= leafCount) { break; }

        let seed = f32(maskVariant * 17u + i * 31u) + variantF * 127.0;
        let r0 = hash1(seed + 0.13);
        let r1 = hash1(seed + 1.91);
        let r2 = hash1(seed + 3.07);
        let r3 = hash1(seed + 4.73);
        let r4 = hash1(seed + 6.21);
        let r5 = hash1(seed + 8.44);
        let r6 = hash1(seed + 9.91);

        var side = 1.0;
        if (r1 < 0.5) { side = -1.0; }

        let y = 0.22 + r0 * 0.68;
        let x = side * (0.09 + r2 * 0.22) + (r5 - 0.5) * 0.045;
        let leafCenter = vec2<f32>(x, y - 0.5);

        let angle = side * (0.30 + r3 * 0.95) + (r4 - 0.5) * 0.35;
        let sx = 0.050 + r2 * 0.038;
        let sy = 0.086 + r3 * 0.060;

        let p = centeredUV - leafCenter;
        leafAlpha = max(leafAlpha, birchLeafMask(p, vec2<f32>(sx, sy), angle, r6));

        let connectorTarget = leafCenter * vec2<f32>(0.55, 0.72);
        let d = distToSegment(centeredUV, connectorRoot, connectorTarget);
        let w = 0.0028 + (1.0 - r2) * 0.0018;
        connectorAlpha = max(connectorAlpha, 1.0 - smoothstep(w, w + 0.0048, d));
    }

    return vec2<f32>(leafAlpha, connectorAlpha);
}

// ── Spruce needle spray ──────────────────────────────────────────────────

fn evalSpruceNeedleSpray(uv: vec2<f32>, variantF: f32) -> f32 {
    let centeredUV = uv - vec2<f32>(0.5);
    let maskVariant = min(u32(floor(variantF * f32(SPRUCE_VARIANTS))), SPRUCE_VARIANTS - 1u);
    var alpha = 0.0;

    // central stem
    let stemDist  = abs(centeredUV.y);
    let stemMask  = 1.0 - smoothstep(0.012, 0.020, stemDist);
    let stemTaper = smoothstep(-0.5, 0.45, centeredUV.x);
    alpha = max(alpha, stemMask * stemTaper * 0.9);

    let needleCount = 8u + (maskVariant % 5u);
    for (var n: u32 = 0u; n < 12u; n++) {
        if (n >= needleCount) { break; }

        let seed = f32(maskVariant * 13u + n * 29u) + variantF * 97.0;
        let r0 = hash1(seed + 0.17);
        let r1 = hash1(seed + 1.53);
        let r2 = hash1(seed + 2.89);

        let stemT = 0.08 + f32(n) / f32(needleCount) * 0.82 + (r0 - 0.5) * 0.06;
        let stemX = -0.45 + stemT * 0.90;

        var needleAngle = 0.5 + r1 * 0.6;
        if (n % 2u == 0u) { needleAngle = -needleAngle; }

        let midFactor = 1.0 - abs(stemT - 0.45) * 1.2;
        let needleLen = (0.12 + r2 * 0.10) * max(0.3, midFactor);

        let needleBase = vec2<f32>(stemX, 0.0);
        let needleTip  = needleBase + vec2<f32>(cos(needleAngle), sin(needleAngle)) * needleLen;

        let d = distToSegment(centeredUV, needleBase, needleTip);
        let needleWidth = 0.006 + r2 * 0.004;
        alpha = max(alpha, (1.0 - smoothstep(needleWidth, needleWidth + 0.006, d)) * 0.92);
    }

    return alpha;
}

// ─────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(${WG_DIM}, ${WG_DIM}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= RES || gid.y >= RES) { return; }

    let layer = gid.z;
    // Texel centre. Matches the implicit interpolation centre the
    // fragment shader would have evaluated at.
    let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / f32(RES);

    var outVal = vec4<f32>(0.0, 0.0, 0.0, 1.0);

    if (layer < BIRCH_VARIANTS) {
        // Centre-of-bin vCluster: floor(variantF * N) == layer exactly,
        // and the continuous seed contribution (variantF * 127.0 above)
        // is deterministic per layer.
        let variantF = (f32(layer) + 0.5) / f32(BIRCH_VARIANTS);
        let m = evalBirchCluster(uv, variantF);
        outVal = vec4<f32>(m.x, m.y, 0.0, 1.0);

    } else if (layer < BIRCH_VARIANTS + SPRUCE_VARIANTS) {
        let spruceIdx = layer - BIRCH_VARIANTS;
        let variantF = (f32(spruceIdx) + 0.5) / f32(SPRUCE_VARIANTS);
        outVal = vec4<f32>(evalSpruceNeedleSpray(uv, variantF), 0.0, 0.0, 1.0);
    }

    textureStore(outTex, vec2<i32>(gid.xy), i32(layer), outVal);
}
`;
}
