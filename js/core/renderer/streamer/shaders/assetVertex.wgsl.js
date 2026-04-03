// js/renderer/streamer/shaders/assetVertex.wgsl.js
//
// ═══ INC 2: archetype-flag dispatch ════════════════════════════════════════
// Replaced `bandCategory == N` branching with per-archetype flag bitfield.
// Grass moved from category 2 (bands 10-14) to archetype 1 (bands 5-9);
// the old check would have lost wind on grass. Flags fix that and let
// ferns pick up wind in Inc 3 with no shader change.

export function buildAssetVertexShader(config = {}) {
    const windMaxDistance  = config.windMaxDistance  ?? 30;
    const windFadeDistance = config.windFadeDistance ?? 10;
    const lodsPerArchetype = config.lodsPerArchetype ?? 5;
    const treeBillboardLodStart = config.treeBillboardLodStart ?? 3;

    // archetypeFlags: u32[] indexed by archetype index. Bit layout:
    //   0x01 WIND       — bend by wind × uv.y²
    //   0x02 BILLBOARD  — far-LOD camera-facing
    //   0x04 (FAR_DIM   — fragment only, ignored here)
    const archetypeFlags  = config.archetypeFlags  ?? [0x02, 0x05]; // tree, grass fallback
    const archetypeCount  = archetypeFlags.length;
    const flagsInit = archetypeFlags.map(f => `${f >>> 0}u`).join(', ');

    return /* wgsl */`

struct AssetUniforms {
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

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition:      vec4<f32>,
    @location(0) vUv:               vec2<f32>,
    @location(1) vNormal:           vec3<f32>,
    @location(2) vWorldPosition:    vec3<f32>,
    @location(3) vColor:            vec4<f32>,
    @location(4) vDistanceToCamera: f32,
    @location(5) vViewPosition:     vec3<f32>,
    @location(6) vBandIndex:        f32,
        // Variant index for fragment-side def lookup. Flat because it is
    // per-instance and must not be interpolated.
    @location(7) @interpolate(flat) vVariantIndex : f32,
    // Planet-surface "up" at the instance anchor, used for moss overlay
    // (dot with world normal). Flat because every vertex of an instance
    // shares the same anchor.
    @location(8) @interpolate(flat) vLocalUp      : vec3<f32>,
}

@group(0) @binding(0) var<uniform>       uniforms:  AssetUniforms;
@group(0) @binding(1) var<storage, read> instances: array<AssetInstance>;

const WIND_MAX_DISTANCE:        f32 = ${windMaxDistance}.0;
const WIND_FADE_DISTANCE:       f32 = ${windFadeDistance}.0;
const LODS_PER_ARCHETYPE:       u32 = ${lodsPerArchetype}u;
const TREE_BILLBOARD_LOD_START: u32 = ${treeBillboardLodStart}u;

const ARCH_FLAG_WIND:      u32 = 0x01u;
const ARCH_FLAG_BILLBOARD: u32 = 0x02u;
const FALLEN_LOG_ARCHETYPE: u32 = 5u;

const ARCHETYPE_COUNT: u32 = ${archetypeCount}u;
const ARCHETYPE_FLAGS = array<u32, ARCHETYPE_COUNT>(${flagsInit});

fn windNoise(pos: vec2<f32>, time: f32) -> f32 {
    let p = pos * 0.05 + vec2<f32>(time * 0.3, time * 0.2);
    return sin(p.x * 2.7 + p.y * 1.3) * 0.5 + 0.5;
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let inst = instances[instanceIdx];
    let worldAnchor = vec3<f32>(inst.posX, inst.posY, inst.posZ);

    // TBN from planet-sphere normal
    let surfaceN = vec3<f32>(inst.surfaceNX, inst.surfaceNY, inst.surfaceNZ);
    var up = normalize(worldAnchor - uniforms.planetOrigin);
    if (length(surfaceN) > 0.0001) {
        up = normalize(surfaceN);
    }
    var _ref = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(up, _ref)) > 0.99) { _ref = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(up, _ref));
    let bitangent = normalize(cross(up, tangent));

    // Archetype dispatch
    let archIdx  = min(inst.bandIndex / LODS_PER_ARCHETYPE, ARCHETYPE_COUNT - 1u);
    let lodLevel = inst.bandIndex - archIdx * LODS_PER_ARCHETYPE;
    let flags    = ARCHETYPE_FLAGS[archIdx];

    // Billboard: camera-facing far-LOD (tree_standard only; dead while
    // scatter-tree draws are suppressed, but kept for correctness).
    var rotT = tangent;
    var rotB = bitangent;
    if ((flags & ARCH_FLAG_BILLBOARD) != 0u && lodLevel >= TREE_BILLBOARD_LOD_START) {
        let viewDir = normalize(uniforms.cameraPosition - worldAnchor);
        var right = cross(up, viewDir);
        let rl = length(right);
        if (rl > 0.0001) {
            right /= rl;
            rotT = right;
            rotB = normalize(cross(right, up));
        }
    } else {
        let c = cos(inst.rotation);
        let s = sin(inst.rotation);
        rotT =  tangent * c + bitangent * s;
        rotB = -tangent * s + bitangent * c;
    }

    var localPos = input.position;
    if (archIdx == FALLEN_LOG_ARCHETYPE) {
        // Fallen logs are authored lying along local X. Their gameplay-facing
        // "height" parameter is used as length, while "width" is diameter.
        localPos.x *= inst.height;
        localPos.y *= inst.width;
        localPos.z *= inst.width;
    } else {
        localPos.x *= inst.width;
        localPos.y *= inst.height;
        localPos.z *= inst.width;
    }

    // Wind bend (grass, ferns)
    var windOffset = vec3<f32>(0.0);
    let heightFactor = input.uv.y;
    if ((flags & ARCH_FLAG_WIND) != 0u) {
        let ws  = windNoise(worldAnchor.xz, uniforms.time);
        let fd  = max(WIND_FADE_DISTANCE, 0.001);
        let st  = max(WIND_MAX_DISTANCE - fd, 0.0);
        let d   = length(worldAnchor - uniforms.cameraPosition);
        let wf  = 1.0 - smoothstep(st, WIND_MAX_DISTANCE, d);
        let amt = heightFactor * heightFactor * uniforms.windStrength * ws * wf;
        windOffset = (rotT * uniforms.windDirection.x + rotB * uniforms.windDirection.y) * amt * 0.15;
    }

    let worldPos = worldAnchor
                 + rotT * localPos.x
                 + up   * localPos.y
                 + rotB * localPos.z
                 + windOffset;

    let worldN = normalize(rotT * input.normal.x + up * input.normal.y + rotB * input.normal.z);

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);
    out.clipPosition      = uniforms.projectionMatrix * viewPos;
    out.vViewPosition     = viewPos.xyz;
    out.vDistanceToCamera = length(viewPos.xyz);
    out.vWorldPosition    = worldPos;
    out.vNormal           = worldN;
    out.vUv               = input.uv;
    out.vBandIndex        = f32(inst.bandIndex);

    // Vertex-tint: base→tip along height
    let base = vec3<f32>(inst.colorR, inst.colorG, inst.colorB);
    let tip  = base + vec3<f32>(0.1, 0.1, 0.05);
    var a = inst.colorA;

    // Tree canopy fade at LOD 2 — tree-specific hack. Dead code while
    // tree scatter is suppressed; kept for the day someone turns it on.
    if (archIdx == 0u && lodLevel == 2u) {
        let cf = smoothstep(0.3, 0.5, input.position.y);
        a *= mix(1.0, 0.45, cf);
    }

    out.vColor = vec4<f32>(mix(base, tip, heightFactor), a);
    out.vVariantIndex = f32(inst.tileTypeId);
    out.vLocalUp = up;
    return out;
}
`;
}
