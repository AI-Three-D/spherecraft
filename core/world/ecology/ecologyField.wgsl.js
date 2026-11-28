// @ts-nocheck
// The ecology field for shaders (ECOLOGY_FOUNDATION_PLAN.md F3, F4, F6; EcologyField.js). Readers see quantities, never
// the storage: buildEcologyReadWGSL declares the bindings and EcologySample / ecologyAtLayer / ecologyAtPatch.
//
// Habitat (made from climate, terrain and water, always): suitability (how much forest the place could carry, 0..1)
// and standHint (the stand the registry's rules prefer). Realized (made by the forest producer; empty until one exists,
// or by the mock forest when asked for): cover (share of the footprint under crowns), crownLAI (leaf area per unit of
// crown-projected area, inside crowns), top (cover-weighted crown tops over the stable ground, m), stand (categorical).
// A sample describes one texel's footprint at its tile's level. Stand ids are never filtered.

export const ECO_MISSING = 0;
export const ECO_PENDING = 1;
export const ECO_READY = 2;
/** Stand id of open ground, and of unknown. */
export const ECO_STAND_OPEN = 0;
export const ECO_STAND_UNKNOWN = 65535;
/** Storage scales: crownLAI / 8 and top / 64 m in rgba8unorm (EcologyField.js). */
export const ECO_LAI_SCALE = 8;
export const ECO_TOP_SCALE = 64;

export const ECOLOGY_SAMPLE_WGSL = /* wgsl */`
const ECO_READY: u32 = 0u;
const ECO_FALLBACK: u32 = 1u;
const ECO_UNKNOWN: u32 = 2u;
const ECO_STAND_OPEN: u32 = ${ECO_STAND_OPEN}u;
const ECO_STAND_UNKNOWN: u32 = ${ECO_STAND_UNKNOWN}u;
struct EcologySample {
    status: u32,          // ECO_READY, ECO_FALLBACK (from an ancestor tile), ECO_UNKNOWN (neutral: no forest)
    suitability: f32,
    standHint: u32,
    cover: f32,
    crownLAI: f32,
    top: f32,
    stand: u32,
};
fn ecologyUnknown() -> EcologySample { return EcologySample(ECO_UNKNOWN, 0.0, ECO_STAND_UNKNOWN, 0.0, 0.0, 0.0, ECO_STAND_UNKNOWN); }

// ---- light under the canopy (F6): broad, at the texel's footprint. Direct sun through the realized canopy at the sun's
// height (sunUp: its cosine to the vertical): gaps pass it whole, crowns as Beer-Lambert of their own leaf area
// (G = 0.5). The sky as the share not under crowns, a little through them. A receiver above the ground leaves the
// canopy's shade by the crown tops. A first approximation, to be fitted once there is a forest to fit it against.
fn canopyTransmission(e: EcologySample, sunUp: f32) -> f32 {
    if (e.status == ECO_UNKNOWN || e.cover <= 0.0) { return 1.0; }
    return (1.0 - e.cover) + e.cover * exp(-0.5 * e.crownLAI / max(sunUp, 0.1));
}
fn canopySky(e: EcologySample) -> f32 {
    if (e.status == ECO_UNKNOWN) { return 1.0; }
    return 1.0 - 0.7 * e.cover;
}
fn canopyShare(heightAboveGround: f32, top: f32) -> f32 {
    return 1.0 - smoothstep(0.6 * max(top, 0.5), max(top, 0.5), heightAboveGround);
}
// The land light's (sun, sky) factors under the canopy for a receiver so high over the ground (m).
fn canopyLight(e: EcologySample, sunUp: f32, heightAboveGround: f32) -> vec2<f32> {
    let s = canopyShare(heightAboveGround, e.top);
    return vec2<f32>(mix(1.0, canopyTransmission(e, sunUp), s), mix(1.0, canopySky(e), s));
}
// Debug views of the field (a terrain debug mode): 1 suitability, 2 realized cover, 3 stand hint, 4 realized stand,
// 5 crownLAI (0..8), 6 crown tops (0..40 m), 7 status (green ready, amber from an ancestor, red unknown).
fn ecologyStandColour(stand: u32) -> vec3<f32> {
    if (stand == ECO_STAND_OPEN) { return vec3<f32>(0.85, 0.80, 0.55); }
    if (stand == ECO_STAND_UNKNOWN) { return vec3<f32>(0.6, 0.0, 0.6); }
    let h = stand * 2654435761u;
    return vec3<f32>(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0 * 0.8 + 0.1;
}
fn ecologyDebugColour(e: EcologySample, mode: u32) -> vec3<f32> {
    switch (mode) {
        case 1u: { return mix(vec3<f32>(0.35, 0.3, 0.25), vec3<f32>(0.1, 0.6, 0.15), e.suitability); }
        case 2u: { return mix(vec3<f32>(0.85, 0.85, 0.75), vec3<f32>(0.05, 0.3, 0.08), e.cover); }
        case 3u: { return ecologyStandColour(e.standHint); }
        case 4u: { return ecologyStandColour(e.stand); }
        case 5u: { return vec3<f32>(e.crownLAI / 8.0); }
        case 6u: { return vec3<f32>(e.top / 40.0); }
        default: {
            if (e.status == ECO_READY) { return vec3<f32>(0.2, 0.7, 0.2); }
            if (e.status == ECO_FALLBACK) { return vec3<f32>(0.9, 0.6, 0.1); }
            return vec3<f32>(0.8, 0.1, 0.1);
        }
    }
}

// Sun flecks and trunk shadows near the camera (the forest's near shadows: a correction of mean 1 over each broad
// texel, so the canopy's mean extinction is applied once). 1 until the forest provides it.
fn nearShadowAt(rel: vec3<f32>) -> f32 { return 1.0; }
`;

/**
 * a, b, layers: [group, binding] of the field's two textures and its layer records. withPatch: also ecologyAtPatch,
 * which needs drawnGround.wgsl.js (groundLookupLayer, groundTileKey, groundInTile, ground).
 */
export function buildEcologyReadWGSL({ a = [0, 0], b = [0, 1], layers = [0, 2], withPatch = false } = {}) {
    const at = ([g, k]) => `@group(${g}) @binding(${k})`;
    return /* wgsl */`${ECOLOGY_SAMPLE_WGSL}
${at(a)} var ecologyA: texture_2d_array<f32>;
${at(b)} var ecologyB: texture_2d_array<u32>;
// Per pool layer: the owner tile's key (lo, hi), state (0 missing, 1 pending, 2 ready) | version << 2, the pool's
// layer version it was made from.
${at(layers)} var<storage, read> ecologyLayers: array<vec4<u32>>;

fn ecologyReadyLayer(layer: i32) -> bool {
    return layer >= 0 && (ecologyLayers[layer].z & 3u) == ${ECO_READY}u;
}
// The field at a point of a pool layer (0..1 across its tile): ECO_READY, or ECO_UNKNOWN when the layer's field is not
// made (or belongs to another tile). The quantities between texels, the stands at the nearest.
fn ecologyAtLayer(layer: i32, local: vec2<f32>) -> EcologySample {
    if (!ecologyReadyLayer(layer)) { return ecologyUnknown(); }
    let size = vec2<i32>(textureDimensions(ecologyA));
    let at = clamp(local, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(size) - 0.5;
    let i = clamp(vec2<i32>(floor(at)), vec2<i32>(0), size - 1);
    let j = min(i + 1, size - 1);
    let f = saturate(at - vec2<f32>(i));
    let q = mix(mix(textureLoad(ecologyA, i, layer, 0), textureLoad(ecologyA, vec2<i32>(j.x, i.y), layer, 0), f.x),
        mix(textureLoad(ecologyA, vec2<i32>(i.x, j.y), layer, 0), textureLoad(ecologyA, j, layer, 0), f.x), f.y);
    let nearest = clamp(vec2<i32>(round(at)), vec2<i32>(0), size - 1);
    let s = textureLoad(ecologyB, nearest, layer, 0).r;
    return EcologySample(ECO_READY, q.x, s >> 16u, q.y, q.z * ${ECO_LAI_SCALE}.0, q.w * ${ECO_TOP_SCALE}.0, s & 0xFFFFu);
}
${withPatch ? `
// The field at a point of patch p (f within it): the finest loaded tile whose field is made for it; an ancestor's when a
// finer loaded tile's is not made yet (ECO_FALLBACK); else ECO_UNKNOWN. A layer counts only if its record names that
// tile.
fn ecologyAtPatch(face: u32, p: vec2<u32>, f: vec2<f32>) -> EcologySample {
    var skipped = false;
    for (var k = 0u; k < 8u && k <= ground.tables.y; k++) {
        let depth = ground.tables.y - k;
        let shift = GROUND_LEVELS + k;
        let t = p >> vec2<u32>(shift);
        let layer = groundLookupLayer(face, depth, t.x, t.y);
        if (layer < 0) { continue; }
        let l = layer & 4095;
        let record = ecologyLayers[l];
        let key = groundTileKey(face, depth, t.x, t.y);
        if (record.x != key.x || record.y != key.y || (record.z & 3u) != ${ECO_READY}u) { skipped = true; continue; }
        var e = ecologyAtLayer(l, groundInTile(p, shift, f));
        if (skipped) { e.status = ECO_FALLBACK; }
        return e;
    }
    return ecologyUnknown();
}` : ''}
`;
}
