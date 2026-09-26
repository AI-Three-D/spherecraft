// core/renderer/shaders/residentTileHeightLookupWgsl.js
//
// Shared WGSL snippet: world-direction -> cube face/UV -> loaded-tile hash
// lookup -> resident array-texture layer. Extracted verbatim from
// core/renderer/rivers/shaders/riverBedBakeShader.wgsl.js so the lake
// height diagnostic/sampler (core/renderer/lakes/shaders/) resolves
// residency through the exact same walk instead of a third, subtly
// different lookup — see CODEX_RIVER_LAKE_HANDOFF.md's non-negotiable
// contract. Behavior is unchanged from the original inline copy (only its
// location moved); RiverBedBake's own nearest-texel sampling in its main()
// is untouched and still calls these same functions.
//
// The including shader module must declare, at whatever binding indices it
// chooses:
//   - a uniform named `params` with at least `hashMask: u32` and
//     `hashCapacity: u32` fields;
//   - `var<storage, read> hashTable: array<u32>;` (4 x u32 per slot:
//     [keyLo, keyHi, layer, unused], empty sentinel 0xFFFFFFFF).

export function buildResidentTileHeightLookupWGSL() {
    return /* wgsl */`
// Must match the real loaded-tile hash table's own probe limit
// (core/world/quadtree/quadtreeTraversal.wgsl.js's isLoaded()), not the
// smaller value BiomeQuery.js happens to use — a real, populated tile's
// probe chain can run past 64 while comfortably under 256, especially for
// tiles streamed in together (spatial locality clusters in hash space).
const MAX_PROBE: u32 = 256u;

fn hashKey(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    let h = (kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u);
    return h & params.hashMask;
}

fn lookupLayer(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = (x & 0xFFFFu) | ((y & 0xFFFFu) << 16u);
    let keyHi = (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u);
    var idx = hashKey(keyLo, keyHi);
    let cap = params.hashCapacity;
    for (var i = 0u; i < min(cap, MAX_PROBE); i++) {
        let base = idx * 4u;
        let hi = hashTable[base + 1u];
        if (hi == 0xFFFFFFFFu) { return -1; }
        if (hi == keyHi && hashTable[base] == keyLo) {
            return i32(hashTable[base + 2u]);
        }
        idx = (idx + 1u) & params.hashMask;
    }
    return -1;
}

fn dirToFaceUV(d: vec3<f32>) -> vec3<f32> {
    let ad = abs(d);
    var face = 0u; var s = 0.0; var t = 0.0; var inv: f32;
    if (ad.x >= ad.y && ad.x >= ad.z) {
        inv = 1.0 / ad.x;
        if (d.x > 0.0) { face = 0u; s = -d.z * inv; t = d.y * inv; }
        else           { face = 1u; s =  d.z * inv; t = d.y * inv; }
    } else if (ad.y >= ad.z) {
        inv = 1.0 / ad.y;
        if (d.y > 0.0) { face = 2u; s = d.x * inv; t = -d.z * inv; }
        else           { face = 3u; s = d.x * inv; t =  d.z * inv; }
    } else {
        inv = 1.0 / ad.z;
        if (d.z > 0.0) { face = 4u; s =  d.x * inv; t = d.y * inv; }
        else           { face = 5u; s = -d.x * inv; t = d.y * inv; }
    }
    return vec3<f32>(f32(face), s * 0.5 + 0.5, t * 0.5 + 0.5);
}
`;
}
