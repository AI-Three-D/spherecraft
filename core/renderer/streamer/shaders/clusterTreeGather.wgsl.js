export function buildClusterTreeGatherShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(32, Math.floor(config.workgroupSize ?? 64));
    const PER_LAYER_CAPACITY = Math.max(1, Math.floor(config.perLayerCapacity ?? 80));
    const MAX_RENDER_INSTANCES = Math.max(1, Math.floor(config.maxInstances ?? 16000));
    const END_DENSITY_SCALE = Number.isFinite(config.endDensityScale) ? config.endDensityScale : 1.0;

    const fmt = (value) => Number(value).toFixed(4);

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const PER_LAYER_CAPACITY: u32 = ${PER_LAYER_CAPACITY}u;
const MAX_RENDER_INSTANCES: u32 = ${MAX_RENDER_INSTANCES}u;
const END_DENSITY_SCALE: f32 = ${fmt(END_DENSITY_SCALE)};

struct GatherParams {
    cameraX: f32, cameraY: f32, cameraZ: f32, _pad0: f32,
    tierStart: f32, tierEnd: f32, tierFadeIn: f32, tierFadeOut: f32,
    activeLayerCount: u32, maxRenderInstances: u32, _pad1: u32, _pad2: u32,
}

struct ClusterTree {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    footprint: f32, height: f32, coniferFrac: f32, density: f32,
    foliageR: f32, foliageG: f32, foliageB: f32, seed: u32,
    groupRadius: f32, packedCount: f32, _r0: f32, _r1: f32,
}

struct ClusterTreeRender {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    footprint: f32, height: f32, coniferFrac: f32, density: f32,
    foliageR: f32, foliageG: f32, foliageB: f32, seed: u32,
    distToCam: f32, tierFade: f32, groupRadius: f32, packedCount: f32,
}

@group(0) @binding(0) var<uniform> params: GatherParams;
@group(0) @binding(1) var<storage, read> activeLayers: array<u32>;
@group(0) @binding(2) var<storage, read> layerMeta: array<u32>;
@group(0) @binding(3) var<storage, read> layerCounts: array<u32>;
@group(0) @binding(4) var<storage, read> clusterIn: array<ClusterTree>;
@group(0) @binding(5) var<storage, read_write> clusterOut: array<ClusterTreeRender>;
@group(0) @binding(6) var<storage, read_write> renderCount: array<atomic<u32>>;

fn computeFade(distanceToCamera: f32, start: f32, end: f32, fadeIn: f32, fadeOut: f32) -> f32 {
    if (distanceToCamera < start || distanceToCamera > end) {
        return 0.0;
    }

    var fadeInT = 1.0;
    if (fadeIn > 0.0) {
        fadeInT = smoothstep(start, start + fadeIn, distanceToCamera);
    }

    var fadeOutT = 1.0;
    if (fadeOut > 0.0) {
        fadeOutT = 1.0 - smoothstep(end - fadeOut, end, distanceToCamera);
    }

    return clamp(fadeInT * fadeOutT, 0.0, 1.0);
}

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) workgroupId: vec3<u32>,
    @builtin(local_invocation_id) localId: vec3<u32>
) {
    let layerSlot = workgroupId.x;
    if (layerSlot >= params.activeLayerCount) { return; }

    let layer = activeLayers[layerSlot];
    let count = min(layerCounts[layer], PER_LAYER_CAPACITY);
    let cameraPos = vec3<f32>(params.cameraX, params.cameraY, params.cameraZ);
    let layerBase = layer * PER_LAYER_CAPACITY;

    for (var localIndex = localId.x; localIndex < count; localIndex += WORKGROUP_SIZE) {
        let source = clusterIn[layerBase + localIndex];
        let worldPos = vec3<f32>(source.posX, source.posY, source.posZ);
        let dist = distance(worldPos, cameraPos);

        let tierFade = computeFade(
            dist,
            params.tierStart,
            params.tierEnd,
            params.tierFadeIn,
            params.tierFadeOut
        );
        if (tierFade <= 0.0) { continue; }

        let densityKeep = mix(1.0, END_DENSITY_SCALE, smoothstep(params.tierStart, params.tierEnd, dist));
        if (pcgF(source.seed ^ 0xA341316Cu) > densityKeep) { continue; }

        let slot = atomicAdd(&renderCount[0], 1u);
        if (slot >= min(params.maxRenderInstances, MAX_RENDER_INSTANCES)) {
            continue;
        }

        clusterOut[slot] = ClusterTreeRender(
            source.posX, source.posY, source.posZ, source.rotation,
            source.footprint, source.height, source.coniferFrac, source.density,
            source.foliageR, source.foliageG, source.foliageB, source.seed,
            dist, tierFade, source.groupRadius, source.packedCount
        );
    }
}
`;
}
