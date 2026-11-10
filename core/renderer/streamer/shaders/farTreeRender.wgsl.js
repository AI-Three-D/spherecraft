// js/renderer/streamer/shaders/farTreeRender.wgsl.js

import { buildMidHullFragmentShader } from './midTreeRender.wgsl.js';

export function buildFarHullVertexShader(config = {}) {
    const MAX_PACKED_TREES = Math.max(1, Math.floor(config.maxPackedTrees ?? 4));

    return /* wgsl */`
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
};

//
// Flat far-tier render instance.
// Produced by the far gather/compact pass from baked FarTreeSourceCache data.
//
struct FarTreeRender {
    // Row 0
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,

    // Row 1
    canopyCenterX: f32, canopyCenterY: f32, canopyCenterZ: f32, packedCount: f32,

    // Row 2
    canopyExtentX: f32, canopyExtentY: f32, canopyExtentZ: f32, scale: f32,

    // Row 3
    foliageR: f32, foliageG: f32, foliageB: f32, seedF: f32,

    // Row 4
    distToCam: f32, tierFade: f32, groupRadius: f32, _pad0: f32,
};

@group(0) @binding(0) var<uniform> uniforms: MidUniforms;
@group(0) @binding(1) var<storage, read> trees: array<FarTreeRender>;
// Kept for bind-group compatibility with TreeFarSystem / existing layout.
@group(0) @binding(2) var<storage, read> anchors: array<u32>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) canopyId: f32,
};

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vNormal: vec3<f32>,
    @location(1) vColor: vec3<f32>,
    @location(2) vDist: f32,
    @location(3) vLocalHeight: f32,
    @location(4) vLocalPos: vec3<f32>,
    @location(5) @interpolate(flat) vTierFade: f32,
    @location(6) @interpolate(flat) vSeed: u32,
    @location(7) vWorldPos: vec3<f32>,
};

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

fn hashCombine(a: u32, b: u32) -> u32 {
    return pcg(a ^ (b * 374761393u + 668265263u));
}

fn packedTreeOffset(seed: u32, treeIndex: u32, packedCount: u32, groupRadius: f32) -> vec2<f32> {
    if (packedCount <= 1u || groupRadius <= 0.0001) {
        return vec2<f32>(0.0, 0.0);
    }

    let packedSeed = hashCombine(seed, treeIndex + 17u);

    // Stable angle per packed tree.
    let angle = pcgF(hashCombine(packedSeed, 1u)) * 6.28318530718;

    // Radius grows with tree index so copies do not collapse to the same point.
    let indexFrac = clamp(f32(treeIndex) / max(f32(packedCount - 1u), 1.0), 0.0, 1.0);

    // Add some radial jitter but keep the first tree close to center.
    let radialJitter = mix(0.55, 1.0, pcgF(hashCombine(packedSeed, 2u)));
    let radialFrac = indexFrac * radialJitter;

    let r = groupRadius * radialFrac;
    return vec2<f32>(cos(angle), sin(angle)) * r;
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    let tree = trees[instIdx];
    let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);

    // Planet-relative "up" for spherical terrain.
    let sphereDir = normalize(treePos - uniforms.planetOrigin);

    // Robust tangent frame.
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) {
        refDir = vec3<f32>(1.0, 0.0, 0.0);
    }

    let tangent = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));

    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    let centre = vec3<f32>(
        tree.canopyCenterX,
        tree.canopyCenterY,
        tree.canopyCenterZ
    );

    let extent = vec3<f32>(
        max(tree.canopyExtentX, 0.05),
        max(tree.canopyExtentY, 0.05),
        max(tree.canopyExtentZ, 0.05)
    );

    let packedCount = clamp(
        u32(max(tree.packedCount, 1.0) + 0.5),
        1u,
        ${MAX_PACKED_TREES}u
    );
    let treeIndex = min(u32(input.canopyId + 0.5), packedCount - 1u);

    let seed = bitcast<u32>(tree.seedF);
    let packedOffsetXZ = packedTreeOffset(seed, treeIndex, packedCount, max(tree.groupRadius, 0.0));

    // Outer trees become slightly smaller for a softer grouped silhouette.
    let packedScale = mix(
        1.0,
        0.72,
        clamp(f32(treeIndex) / max(f32(packedCount - 1u), 1.0), 0.0, 1.0)
    );

    let deformedLocal = centre + vec3<f32>(
        input.position.x * extent.x * packedScale + packedOffsetXZ.x,
        input.position.y * extent.y * packedScale,
        input.position.z * extent.z * packedScale + packedOffsetXZ.y
    );

    let worldPos = treePos
                 + rotT      * deformedLocal.x
                 + sphereDir * deformedLocal.y
                 + rotB      * deformedLocal.z;

    let localN = normalize(vec3<f32>(
        (deformedLocal.x - centre.x) / extent.x,
        (deformedLocal.y - centre.y) / extent.y,
        (deformedLocal.z - centre.z) / extent.z
    ));
    let worldNormal = normalize(rotT * localN.x + sphereDir * localN.y + rotB * localN.z);

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);

    out.clipPos = uniforms.projectionMatrix * viewPos;
    out.vNormal = worldNormal;
    out.vColor = vec3<f32>(tree.foliageR, tree.foliageG, tree.foliageB);
    out.vDist = select(length(viewPos.xyz), tree.distToCam, tree.distToCam > 0.0);
    out.vLocalHeight = input.position.y * 0.5 + 0.5;
    out.vLocalPos = deformedLocal;
    out.vTierFade = clamp(tree.tierFade, 0.0, 1.0);
    out.vSeed = seed;
    out.vWorldPos = worldPos;
    return out;
}
`;
}

export function buildFarHullFragmentShader(config = {}) {
    let code = buildMidHullFragmentShader(config);

    // Optional stronger debug tint for far trees only.
    if (config.debugMagenta === true) {
        code = code.replace(
            'return vec4<f32>(color, 1.0);',
            'color = mix(color, vec3<f32>(1.0, 0.0, 1.0), 0.85);\n    return vec4<f32>(color, 1.0);'
        );
    }

    return code;
}