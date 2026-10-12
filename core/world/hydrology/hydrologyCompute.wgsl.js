// core/world/hydrology/hydrologyCompute.wgsl.js
//
// GPU compute shaders for a one-time hydrology precompute: given a region of
// the planet, find a real valley to carve a river channel along, instead of
// an authored fixed straight line.
//
// Originally this sampled the *full* detailed terrain height (every noise
// octave: mountains, hills, micro-detail, the works) and ran an iterative
// flow-accumulation simulation (250 GPU passes) over it to find channels.
// That worked, but was needlessly expensive and — worse — unreliable: fine
// surface-noise detail creates spurious local pits that a flow-accumulation
// simulation dutifully routes around, finding "technically real" channels
// that still run across a hillside instead of through an actual valley,
// because raw flow accumulation just isn't the same signal as "this is a
// valley a human would recognize as one."
//
// Real valleys in this terrain generator are ultimately shaped by the same
// broad, low-frequency landform noise as everything else (see
// getRegionalCharacter()'s baseElevation in featureContinents.wgsl.js) —
// mountains/hills/micro-detail are all layered on *top* of that. Sampling
// just that coarse landform signal directly — the same noise the terrain
// itself is built from, at the resolution where valleys actually exist —
// is both cheaper (skips every other feature's noise octaves entirely) and
// a more direct match for "is this actually a valley": no simulation
// needed, just check whether a point sits below a wide ring of samples
// around it (HydrologyPrecompute.js's valleyDepthAt()).
//
// Two passes:
//   1. Base elevation — bakes getRegionalCharacter().baseElevation (rivers
//      disabled, to avoid carving based on already-carved height) over a
//      flat grid covering the region. Appended onto the real, assembled
//      terrain shader source so it's the exact same noise production uses.
//   2. Flow direction — per cell, the steepest-descent neighbor of the 8
//      surrounding it (or -1 if this cell is a local pit / region edge),
//      on this same smooth field — used only to trace a path CPU-side once
//      a real valley point is found (HydrologyPrecompute.js), not to
//      detect valleys itself.

export const HYDRO_MAX_GRID = 512;

export function buildHydroHeightEntryPoint({ paramsBinding, outBinding }) {
  return `
struct HydroHeightParams {
    origin:         vec3<f32>, cellSize: f32,
    regionAnchor:   vec3<f32>, gridW: f32,
    regionRight:    vec3<f32>, gridL: f32,
    regionForward:  vec3<f32>, _pad: f32,
}
@group(0) @binding(${paramsBinding}) var<uniform> hydroParams: HydroHeightParams;
@group(0) @binding(${outBinding}) var<storage, read_write> hydroHeightOut: array<f32>;

@compute @workgroup_size(8, 8)
fn hydroHeightMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let gw = u32(hydroParams.gridW);
    let gl = u32(hydroParams.gridL);
    if (gid.x >= gw || gid.y >= gl) { return; }

    let localX = (f32(gid.x) + 0.5) * hydroParams.cellSize - 0.5 * f32(gw) * hydroParams.cellSize;
    let localZ = (f32(gid.y) + 0.5) * hydroParams.cellSize - 0.5 * f32(gl) * hydroParams.cellSize;
    let worldPos = hydroParams.regionAnchor
        + hydroParams.regionRight * localX
        + hydroParams.regionForward * localZ;
    let dir = normalize(worldPos - hydroParams.origin);
    let wx = dir.x;
    let wy = dir.z;

    // Only the broad landform signal, not the full detailed height: skips
    // foothills/lone-hills/meso-detail/ocean-floor noise entirely
    // (cheaper) and gives a smooth field where genuine large-scale basins
    // are actually findable (no fine-noise-created spurious pits). Rivers
    // don't need disabling here — featureRiverHeight() was never part of
    // this call graph to begin with.
    let profile = getTerrainProfile();
    let regional = getRegionalCharacter(wx, wy, dir, uniforms.seed, profile);
    hydroHeightOut[gid.y * gw + gid.x] = regional.baseElevation;
}
`;
}

// Neighbor offset table shared by both the flow-direction and accumulation
// passes — index i's offset is the step taken by flowDir value i.
const OFFSETS_WGSL = `
const HYDRO_OFFSETS = array<vec2<i32>, 8>(
    vec2<i32>(0, -1), vec2<i32>(1, -1), vec2<i32>(1, 0), vec2<i32>(1, 1),
    vec2<i32>(0, 1), vec2<i32>(-1, 1), vec2<i32>(-1, 0), vec2<i32>(-1, -1)
);
const HYDRO_DIST = array<f32, 8>(
    1.0, 1.4142135, 1.0, 1.4142135, 1.0, 1.4142135, 1.0, 1.4142135
);
`;

export function buildFlowDirectionShader() {
  return `
struct FlowParams { gridW: u32, gridL: u32, cellSize: f32, _pad: f32 }
@group(0) @binding(0) var<uniform> flowParams: FlowParams;
@group(0) @binding(1) var<storage, read> flowHeightIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> flowDirOut: array<i32>;

${OFFSETS_WGSL}

@compute @workgroup_size(8, 8)
fn flowDirectionMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let gw = flowParams.gridW;
    let gl = flowParams.gridL;
    if (gid.x >= gw || gid.y >= gl) { return; }
    let idx = gid.y * gw + gid.x;

    // Region edges are treated as drainage boundaries (flow simply exits
    // the analyzed area here) rather than pits needing lake-filling —
    // rivers-only scope, no lake detection yet.
    if (gid.x == 0u || gid.y == 0u || gid.x == gw - 1u || gid.y == gl - 1u) {
        flowDirOut[idx] = -1;
        return;
    }

    let here = flowHeightIn[idx];
    var bestSlope: f32 = 0.0;
    var bestDir: i32 = -1;
    for (var i = 0; i < 8; i = i + 1) {
        let off = HYDRO_OFFSETS[i];
        let nx = i32(gid.x) + off.x;
        let ny = i32(gid.y) + off.y;
        let nIdx = u32(ny) * gw + u32(nx);
        let neighborH = flowHeightIn[nIdx];
        let slope = (here - neighborH) / HYDRO_DIST[i];
        if (slope > bestSlope) {
            bestSlope = slope;
            bestDir = i;
        }
    }
    flowDirOut[idx] = bestDir;
}
`;
}

