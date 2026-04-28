//js//mesh/terrain/shaders/webgpu/terrainChunkVertexShaderBuilder.js
export function buildTerrainChunkVertexShader(options = {}) {
    const instanced = options.instanced === true;
    const useArrayTextures = options.useArrayTextures === true;
    const useStorageBuffer = options.useStorageBuffer === true;
    const useTransitionTopology = options.useTransitionTopology === true;
    const debugMode = Number.isFinite(options.debugMode) ? Math.floor(options.debugMode) : 0;
    const terrainShaderConfig = options.terrainShaderConfig || {};
    const lod = Number.isFinite(options.lod) ? Math.max(0, Math.floor(options.lod)) : 0;
    const lodEdgeFadeMaxLod = Number.isFinite(terrainShaderConfig.lodEdgeFadeMaxLod)
        ? Math.max(-1, Math.floor(terrainShaderConfig.lodEdgeFadeMaxLod))
        : 4;
    const lodEdgeFadeWidth = Number.isFinite(terrainShaderConfig.lodEdgeFadeWidth)
        ? Math.min(0.30, Math.max(0.001, terrainShaderConfig.lodEdgeFadeWidth))
        : 0.04;
    const enableLodEdgeFade =
        terrainShaderConfig.lodEdgeFadeEnabled === true &&
        lodEdgeFadeMaxLod >= 0 &&
        lod <= lodEdgeFadeMaxLod;
    const defaultSegments = [128, 64, 32, 16, 8, 4, 2];
    const lodSegments = Array.isArray(options.lodSegments) ? options.lodSegments : defaultSegments;
    const segments = defaultSegments.map((value, index) => {
        const candidate = lodSegments[index];
        return Number.isFinite(candidate) ? candidate : value;
    });
    const segmentLiteral = segments.map(value => `${Math.max(2, Math.floor(value))}.0`).join(', ');

    const instanceInputs = instanced && !useStorageBuffer ? `
struct InstanceInput {
    @location(3) instanceData0: vec4<f32>,
    @location(4) instanceData1: vec4<f32>,
    @location(5) instanceData2: vec4<f32>,
    @location(6) instanceLayer: f32,
}
` : '';

    const instanceParam = instanced
        ? (useStorageBuffer ? ', @builtin(instance_index) instanceIdx: u32' : ', instance: InstanceInput')
        : '';
    const heightTextureType = useArrayTextures ? 'texture_2d_array<f32>' : 'texture_2d<f32>';
    const storageBufferDecl = useStorageBuffer ? `
struct ChunkInstance {
    position: vec3<f32>,
    face: u32,
    chunkLocation: vec2<f32>,
    chunkSizeUV: f32,
    _pad: f32,
    uvOffset: vec2<f32>,
    uvScale: f32,
    lod: u32,
    neighborLODs: vec2<u32>,
    layer: u32,
    edgeMask: u32,
}

@group(3) @binding(0) var<storage, read> chunks: array<ChunkInstance>;
` : '';

    const storageHelpers = useStorageBuffer ? `
fn unpackNeighborLODs(packed: vec2<u32>) -> vec4<f32> {
    let left = f32((packed.x >> 0u) & 0xFu);
    let right = f32((packed.x >> 4u) & 0xFu);
    let bottom = f32((packed.x >> 8u) & 0xFu);
    let top = f32((packed.x >> 12u) & 0xFu);
    return vec4<f32>(left, right, bottom, top);
}
` : '';

    const instancingBlock = instanced ? (useStorageBuffer ? `
        let chunk = chunks[instanceIdx];
        debugInstanceIndex = f32(instanceIdx);
        chunkFace = i32(chunk.face);
        chunkOffset = chunk.position.xz;
        chunkLocation = chunk.chunkLocation;
        chunkSizeUVLocal = chunk.chunkSizeUV;
        neighborLODs = unpackNeighborLODs(chunk.neighborLODs);
        heightLayer = i32(chunk.layer);
        debugEdgeMask = f32(chunk.edgeMask);
        selfLOD = i32(chunk.lod);
        if (uniforms.useAtlasMode > 0.5) {
            atlasOffset = chunk.uvOffset;
            atlasScale = chunk.uvScale;
        }
    ` : `
        chunkFace = i32(round(instance.instanceData0.z));
        chunkOffset = instance.instanceData0.xy;
        chunkLocation = vec2<f32>(instance.instanceData0.w, instance.instanceData1.x);
        neighborLODs = instance.instanceData2;
        heightLayer = i32(round(instance.instanceLayer));
        if (uniforms.useAtlasMode > 0.5) {
            atlasOffset = instance.instanceData1.yz;
            atlasScale = instance.instanceData1.w;
        }
    `) : '';

    return `
// LOD_SEGMENTS: ${segments.join(',')}
const FORCE_HEIGHT_TEST : bool = false;
const FORCE_HEIGHT_VALUE : f32 = 500.0;
const FORCE_HEIGHT_MULT : f32 = 1.0;
const DEBUG_SAMPLE_MODE : bool = false;
const DEBUG_VERTEX_MODE : i32 = ${debugMode};
const DEBUG_SAMPLE_SCALE : f32 = 20.0;
const DEBUG_SAMPLE_FIX : bool = true;
const DEBUG_STITCH_STEP_FIX : bool = true;
const USE_TRANSITION_TOPOLOGY : bool = ${useTransitionTopology ? 'true' : 'false'};
const ENABLE_LOD_EDGE_FADE : bool = ${enableLodEdgeFade ? 'true' : 'false'};
const LOD_EDGE_FADE_WIDTH : f32 = ${lodEdgeFadeWidth.toFixed(4)};
const MAX_MORPH_DISTANCE : f32 = 1e9;
const SEGMENTS_PER_LOD : array<f32, 7> = array<f32, 7>(${segmentLiteral});
const MAX_LOD : f32 = 6.0;
const EDGE_EPSILON : f32 = 0.001;

struct VertexUniforms {
    modelMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,

    chunkOffset: vec2<f32>,
    chunkSize: f32,
    macroScale: f32,

    planetRadius: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,

    planetOrigin: vec3<f32>,
    _pad3: f32,

    chunkFace: i32,
    _padFace: f32,
    chunkLocation: vec2<f32>,
    chunkSizeUV: f32,

    useAtlasMode: f32,
    atlasUVOffset: vec2<f32>,
    atlasUVScale: f32,
    useInstancing: f32,

    heightScale: f32,
    atlasTextureSize: f32,
    chunksPerFace: f32,
    _pad5: f32,

    geometryLOD: i32,
    lodMorphStart: f32,
    lodMorphEnd: f32,
    _padMorph: f32,

    cameraPosition: vec3<f32>,
    _pad6: f32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
}

${instanceInputs}
${storageBufferDecl}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vUv: vec2<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vWorldPosition: vec3<f32>,
    @location(3) vViewPosition: vec3<f32>,
    @location(4) vDistanceToCamera: f32,
    @location(5) vTileUv: vec2<f32>,
    @location(6) vWorldPos: vec2<f32>,
    @location(7) vSphereDir: vec3<f32>,
    @location(8) vHeight: f32,
    @location(9) vDisplacement: f32,
    @location(10) vAtlasOffset: vec2<f32>,
    @location(11) vAtlasScale: f32,
    @location(12) vLayer: f32,
    @location(13) vDebugEdge: vec4<f32>,
    @location(14) vDebugSample: vec4<f32>,
    @location(15) vFaceInfo: vec4<f32>,
    
}

@group(0) @binding(0) var<uniform> uniforms: VertexUniforms;
@group(1) @binding(0) var heightTexture: ${heightTextureType};
struct SnapResult {
    uv: vec2<f32>,
    sampleLOD: i32,
    edgeAxis: i32,
    edgeValue: f32,
}

struct StitchedPositionResult {
    worldPosition: vec3<f32>,
    sphereDir: vec3<f32>,
    height: f32,
    applied: u32,
}

${useArrayTextures ? `
fn loadHeightTex(coord: vec2<i32>, layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, layer, 0).r;
}
` : `
fn loadHeightTex(coord: vec2<i32>, _layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, 0).r;
}
`}
${storageHelpers}

fn getCubePoint(face: i32, uv: vec2<f32>) -> vec3<f32> {
    let xy = uv * 2.0 - 1.0;
    if (face == 0) { return vec3<f32>(1.0, xy.y, -xy.x); }
    if (face == 1) { return vec3<f32>(-1.0, xy.y, xy.x); }
    if (face == 2) { return vec3<f32>(xy.x, 1.0, -xy.y); }
    if (face == 3) { return vec3<f32>(xy.x, -1.0, xy.y); }
    if (face == 4) { return vec3<f32>(xy.x, xy.y, 1.0); }
    return vec3<f32>(-xy.x, xy.y, -1.0);
}

fn computeEdgeSnappedUV(uv: vec2<f32>, selfLOD: i32, neighborLODs: vec4<f32>) -> SnapResult {
    let lodLeft = i32(neighborLODs.x);
    let lodRight = i32(neighborLODs.y);
    let lodBottom = i32(neighborLODs.z);
    let lodTop = i32(neighborLODs.w);

    let onLeft = uv.x < EDGE_EPSILON;
    let onRight = uv.x > (1.0 - EDGE_EPSILON);
    let onBottom = uv.y < EDGE_EPSILON;
    let onTop = uv.y > (1.0 - EDGE_EPSILON);

    var maxNeighborLOD = selfLOD;
    var edgeAxis = -1;
    var edgeValue = 0.0;
    if (onLeft && lodLeft > maxNeighborLOD) { maxNeighborLOD = lodLeft; edgeAxis = 0; edgeValue = 0.0; }
    if (onRight && lodRight > maxNeighborLOD) { maxNeighborLOD = lodRight; edgeAxis = 0; edgeValue = 1.0; }
    if (onBottom && lodBottom > maxNeighborLOD) { maxNeighborLOD = lodBottom; edgeAxis = 1; edgeValue = 0.0; }
    if (onTop && lodTop > maxNeighborLOD) { maxNeighborLOD = lodTop; edgeAxis = 1; edgeValue = 1.0; }

    var snappedUV = uv;
    if (edgeAxis >= 0 && maxNeighborLOD > selfLOD) {
        let coarseSegments = SEGMENTS_PER_LOD[clamp(maxNeighborLOD, 0, 6)];
        let coarseStep = 1.0 / max(coarseSegments, 1.0);
        if (edgeAxis == 0) {
            snappedUV = vec2<f32>(edgeValue, round(uv.y / coarseStep) * coarseStep);
        } else {
            snappedUV = vec2<f32>(round(uv.x / coarseStep) * coarseStep, edgeValue);
        }
        snappedUV = clamp(snappedUV, vec2<f32>(0.0), vec2<f32>(1.0));
    }

    return SnapResult(snappedUV, maxNeighborLOD, edgeAxis, edgeValue);
}

fn sanitizeNeighborLODs(raw: vec4<f32>, selfLOD: i32) -> vec4<f32> {
    let selfVal = f32(selfLOD);
    let left = select(selfVal, raw.x, raw.x < 15.0);
    let right = select(selfVal, raw.y, raw.y < 15.0);
    let bottom = select(selfVal, raw.z, raw.z < 15.0);
    let top = select(selfVal, raw.w, raw.w < 15.0);
    return vec4<f32>(left, right, bottom, top);
}

fn computeLodEdgeFade(localUV: vec2<f32>, edgeMaskValue: f32) -> f32 {
    if (!ENABLE_LOD_EDGE_FADE) {
        return 1.0;
    }

    let mask = u32(clamp(edgeMaskValue, 0.0, 4095.0) + 0.5);
    if (mask == 0u) {
        return 1.0;
    }

    let width = max(LOD_EDGE_FADE_WIDTH, 0.0001);
    var fade = 1.0;
    // Coarser neighbor (fine chunk side): bits 1,2,4,8
    if ((mask & 8u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, localUV.x));
    }
    if ((mask & 2u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, 1.0 - localUV.x));
    }
    if ((mask & 4u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, localUV.y));
    }
    if ((mask & 1u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, 1.0 - localUV.y));
    }
    // Finer neighbor (coarse chunk side): bits 16,32,64,128 — bilateral seam fix
    if ((mask & 128u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, localUV.x));
    }
    if ((mask & 32u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, 1.0 - localUV.x));
    }
    if ((mask & 64u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, localUV.y));
    }
    if ((mask & 16u) != 0u) {
        fade = min(fade, smoothstep(0.0, width, 1.0 - localUV.y));
    }
    return clamp(fade, 0.0, 1.0);
}

fn remapToTexelGrid(localUV: vec2<f32>, lod: i32) -> vec2<f32> {
    let segments = SEGMENTS_PER_LOD[clamp(lod, 0, 6)];
    let denom = max(segments - 1.0, 1.0);
    let scale = segments / denom;
    return clamp(localUV * scale, vec2<f32>(0.0), vec2<f32>(1.0));
}

fn sampleHeightNearestChunkLocal(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let globalMax = vec2<i32>(textureDimensions(heightTexture)) - vec2<i32>(1);
    var baseOffset = vec2<f32>(0.0);
    var baseScale = 1.0;
    if (uniforms.useAtlasMode > 0.5) {
        baseOffset = atlasOffset;
        baseScale = atlasScale;
    }
    let chunkSizeF = max(texSize * baseScale, vec2<f32>(1.0));
    let chunkSizeI = vec2<i32>(floor(chunkSizeF + vec2<f32>(0.5)));
    let maxLocalI = max(chunkSizeI - vec2<i32>(1), vec2<i32>(1));
    let localCoord = clamp(localUV, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(maxLocalI);
    let baseCoordI = vec2<i32>(floor(baseOffset * texSize + vec2<f32>(0.5)));
    let texelCoord = baseCoordI + vec2<i32>(floor(localCoord + vec2<f32>(0.5)));
    let maxCoord = min(baseCoordI + maxLocalI, globalMax);
    let clampedCoord = clamp(texelCoord, baseCoordI, maxCoord);
    return loadHeightTex(clampedCoord, layer);
}

fn sampleHeightChunkLocal(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let globalMax = vec2<i32>(textureDimensions(heightTexture)) - vec2<i32>(1);
    var baseOffset = vec2<f32>(0.0);
    var baseScale = 1.0;
    if (uniforms.useAtlasMode > 0.5) {
        baseOffset = atlasOffset;
        baseScale = atlasScale;
    }
    let chunkSizeF = max(texSize * baseScale, vec2<f32>(1.0));
    let chunkSizeI = vec2<i32>(floor(chunkSizeF + vec2<f32>(0.5)));
    let maxLocalI = max(chunkSizeI - vec2<i32>(1), vec2<i32>(1));
    let localCoord = clamp(localUV, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(maxLocalI);
    let baseCoordI = vec2<i32>(floor(baseOffset * texSize + vec2<f32>(0.5)));
    let coord = vec2<f32>(baseCoordI) + localCoord;
    let baseCoord = floor(coord);
    let f = coord - baseCoord;

    let c00 = vec2<i32>(baseCoord);
    let c10 = c00 + vec2<i32>(1, 0);
    let c01 = c00 + vec2<i32>(0, 1);
    let c11 = c00 + vec2<i32>(1, 1);

    let minCoord = baseCoordI;
    let maxCoord = min(baseCoordI + maxLocalI, globalMax);

    let h00 = loadHeightTex(clamp(c00, minCoord, maxCoord), layer);
    let h10 = loadHeightTex(clamp(c10, minCoord, maxCoord), layer);
    let h01 = loadHeightTex(clamp(c01, minCoord, maxCoord), layer);
    let h11 = loadHeightTex(clamp(c11, minCoord, maxCoord), layer);

    let h0 = mix(h00, h10, f.x);
    let h1 = mix(h01, h11, f.x);

    return mix(h0, h1, f.y);
}

fn sampleHeightNearest(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, lod: i32, layer: i32) -> f32 {
    if (DEBUG_SAMPLE_FIX) {
        return sampleHeightNearestChunkLocal(localUV, atlasOffset, atlasScale, layer);
    }
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let maxIdx = max(texSize - vec2<f32>(1.0), vec2<f32>(1.0));

    var sampleUV = remapToTexelGrid(localUV, lod);
    if (uniforms.useAtlasMode > 0.5) {
        sampleUV = atlasOffset + sampleUV * atlasScale;
    }
    sampleUV = clamp(sampleUV, vec2<f32>(0.0), vec2<f32>(1.0));

    let coord = sampleUV * maxIdx;
    let texelCoord = vec2<i32>(floor(coord + 0.5));
    let maxCoord = vec2<i32>(maxIdx);
    let clampedCoord = clamp(texelCoord, vec2<i32>(0), maxCoord);
    return loadHeightTex(clampedCoord, layer);
}

fn sampleHeightLegacy(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let halfPix = 0.5 / texSize;
    var sampleUV = localUV;
    if (uniforms.useAtlasMode > 0.5) {
        sampleUV = atlasOffset + sampleUV * atlasScale;
    }
    sampleUV = clamp(sampleUV, halfPix, vec2<f32>(1.0) - halfPix);

    let coord = sampleUV * texSize - 0.5;
    let baseCoord = floor(coord);
    let f = fract(coord);
    let c00 = vec2<i32>(baseCoord);
    let c10 = c00 + vec2<i32>(1, 0);
    let c01 = c00 + vec2<i32>(0, 1);
    let c11 = c00 + vec2<i32>(1, 1);
    let maxCoord = vec2<i32>(texSize) - vec2<i32>(1);
    let h00 = loadHeightTex(clamp(c00, vec2<i32>(0), maxCoord), layer);
    let h10 = loadHeightTex(clamp(c10, vec2<i32>(0), maxCoord), layer);
    let h01 = loadHeightTex(clamp(c01, vec2<i32>(0), maxCoord), layer);
    let h11 = loadHeightTex(clamp(c11, vec2<i32>(0), maxCoord), layer);
    let h0 = mix(h00, h10, f.x);
    let h1 = mix(h01, h11, f.x);
    return mix(h0, h1, f.y);
}

fn sampleHeight(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, sampleLOD: i32, _selfLOD: i32, layer: i32) -> f32 {
    if (DEBUG_SAMPLE_FIX) {
        return sampleHeightChunkLocal(localUV, atlasOffset, atlasScale, layer);
    }
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let maxIdx = max(texSize - vec2<f32>(1.0), vec2<f32>(1.0));

    var sampleUV = remapToTexelGrid(localUV, sampleLOD);
    if (uniforms.useAtlasMode > 0.5) {
        sampleUV = atlasOffset + sampleUV * atlasScale;
    }

    sampleUV = clamp(sampleUV, vec2<f32>(0.0), vec2<f32>(1.0));

    let coord = sampleUV * maxIdx;
    let baseCoord = floor(coord);
    let f = coord - baseCoord;

    let c00 = vec2<i32>(baseCoord);
    let c10 = c00 + vec2<i32>(1, 0);
    let c01 = c00 + vec2<i32>(0, 1);
    let c11 = c00 + vec2<i32>(1, 1);

    let maxCoord = vec2<i32>(maxIdx);

    let h00 = loadHeightTex(clamp(c00, vec2<i32>(0), maxCoord), layer);
    let h10 = loadHeightTex(clamp(c10, vec2<i32>(0), maxCoord), layer);
    let h01 = loadHeightTex(clamp(c01, vec2<i32>(0), maxCoord), layer);
    let h11 = loadHeightTex(clamp(c11, vec2<i32>(0), maxCoord), layer);

    let h0 = mix(h00, h10, f.x);
    let h1 = mix(h01, h11, f.x);

    return mix(h0, h1, f.y);
}

fn sampleStitchedHeight(localUV: vec2<f32>, edgeAxis: i32, edgeValue: f32, sampleLOD: i32, selfLOD: i32, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    if (edgeAxis < 0 || sampleLOD <= selfLOD) {
        return sampleHeight(localUV, atlasOffset, atlasScale, sampleLOD, selfLOD, layer);
    }

    let segments = SEGMENTS_PER_LOD[clamp(sampleLOD, 0, 6)];
    let step = 1.0 / max(segments, 1.0);
    var t = localUV.y;
    if (edgeAxis == 1) {
        t = localUV.x;
    }

    let t0 = floor(t / step) * step;
    let t1 = min(t0 + step, 1.0);
    let denom = max(t1 - t0, 0.000001);
    let w = clamp((t - t0) / denom, 0.0, 1.0);

    var uv0 = localUV;
    var uv1 = localUV;
    if (edgeAxis == 0) {
        uv0 = vec2<f32>(edgeValue, t0);
        uv1 = vec2<f32>(edgeValue, t1);
    } else {
        uv0 = vec2<f32>(t0, edgeValue);
        uv1 = vec2<f32>(t1, edgeValue);
    }

    let h0 = sampleHeight(uv0, atlasOffset, atlasScale, sampleLOD, selfLOD, layer);
    let h1 = sampleHeight(uv1, atlasOffset, atlasScale, sampleLOD, selfLOD, layer);
    return mix(h0, h1, w);
}

fn computeStitchedPosition(
    localUV: vec2<f32>,
    edgeAxis: i32,
    edgeValue: f32,
    sampleLOD: i32,
    selfLOD: i32,
    chunkFace: i32,
    chunkLocation: vec2<f32>,
    chunkSizeUVLocal: f32,
    atlasOffset: vec2<f32>,
    atlasScale: f32,
    layer: i32,
    heightMultiplier: f32
) -> StitchedPositionResult {
    if (edgeAxis < 0 || sampleLOD <= selfLOD) {
        return StitchedPositionResult(vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0.0, 0u);
    }

    let segments = SEGMENTS_PER_LOD[clamp(sampleLOD, 0, 6)];
    let step = 1.0 / max(segments, 1.0);
    var t = localUV.y;
    if (edgeAxis == 1) {
        t = localUV.x;
    }

    let t0 = floor(t / step) * step;
    let t1 = min(t0 + step, 1.0);
    let denom = max(t1 - t0, 0.000001);
    let w = clamp((t - t0) / denom, 0.0, 1.0);

    var uv0 = localUV;
    var uv1 = localUV;
    if (edgeAxis == 0) {
        uv0 = vec2<f32>(edgeValue, t0);
        uv1 = vec2<f32>(edgeValue, t1);
    } else {
        uv0 = vec2<f32>(t0, edgeValue);
        uv1 = vec2<f32>(t1, edgeValue);
    }

    let h0 = sampleHeight(uv0, atlasOffset, atlasScale, sampleLOD, selfLOD, layer);
    let h1 = sampleHeight(uv1, atlasOffset, atlasScale, sampleLOD, selfLOD, layer);

    let faceUV0 = chunkLocation + uv0 * chunkSizeUVLocal;
    let faceUV1 = chunkLocation + uv1 * chunkSizeUVLocal;
    let dir0 = normalize(getCubePoint(chunkFace, faceUV0));
    let dir1 = normalize(getCubePoint(chunkFace, faceUV1));
    let p0 = uniforms.planetOrigin + dir0 * (uniforms.planetRadius + h0 * heightMultiplier);
    let p1 = uniforms.planetOrigin + dir1 * (uniforms.planetRadius + h1 * heightMultiplier);
    let worldPosition = mix(p0, p1, w);
    let sphereDir = normalize(worldPosition - uniforms.planetOrigin);
    let height = mix(h0, h1, w);

    return StitchedPositionResult(worldPosition, sphereDir, height, 1u);
}

@vertex
fn main(input: VertexInput${instanceParam}) -> VertexOutput {
    var output: VertexOutput;

    let useInstancing = uniforms.useInstancing > 0.5;
    var chunkFace: i32 = uniforms.chunkFace;
    var chunkOffset: vec2<f32> = uniforms.chunkOffset;
    var chunkLocation: vec2<f32> = uniforms.chunkLocation;
    var chunkSizeUVLocal: f32 = uniforms.chunkSizeUV;
    var atlasOffset: vec2<f32> = vec2<f32>(0.0);
    var atlasScale: f32 = 1.0;
    if (uniforms.useAtlasMode > 0.5) {
        atlasOffset = uniforms.atlasUVOffset;
        atlasScale = uniforms.atlasUVScale;
    }
    var neighborLODs = vec4<f32>(-1.0);
    var heightLayer: i32 = 0;
    var selfLOD: i32 = uniforms.geometryLOD;
    var edgeAxis: i32 = -1;
    var edgeValue: f32 = 0.0;
    var debugEdgeMask: f32 = 0.0;
    var debugInstanceIndex: f32 = 0.0;
    if (useInstancing) {
${instancingBlock}
    }
    let finalUV = input.uv;
    var positionUV = finalUV;
    var sampleLOD = selfLOD;
    var height: f32 = 0.0;
    var debugEdge: vec4<f32> = vec4<f32>(0.0);
    var debugSample: vec4<f32> = vec4<f32>(0.0);
    var rawNeighborLODs = neighborLODs;
    var debugAxis: f32 = 0.0;
    var debugSampleLod: f32 = f32(selfLOD);
    if (useInstancing) {
        rawNeighborLODs = neighborLODs;
        neighborLODs = sanitizeNeighborLODs(rawNeighborLODs, selfLOD);
    }

    // Stitch heights on edges when adjacent chunk uses a coarser LOD.
    if (useInstancing && !USE_TRANSITION_TOPOLOGY) {
        let snap = computeEdgeSnappedUV(finalUV, selfLOD, neighborLODs);
        sampleLOD = snap.sampleLOD;
        edgeAxis = snap.edgeAxis;
        edgeValue = snap.edgeValue;
        debugAxis = f32(edgeAxis + 1);
        debugSampleLod = f32(sampleLOD);
        height = sampleStitchedHeight(finalUV, snap.edgeAxis, snap.edgeValue, sampleLOD, selfLOD, atlasOffset, atlasScale, heightLayer);
        if (edgeAxis >= 0 && sampleLOD > selfLOD) {
            let lodNorm = clamp(f32(sampleLOD) / MAX_LOD, 0.0, 1.0);
            debugEdge = vec4<f32>(lodNorm, 0.0, 1.0 - lodNorm, 1.0);
        }
    } else {
        height = sampleHeight(finalUV, atlasOffset, atlasScale, sampleLOD, selfLOD, heightLayer);
    }
    if (DEBUG_SAMPLE_MODE) {
        let legacyHeight = sampleHeightLegacy(finalUV, atlasOffset, atlasScale, heightLayer);
        let delta = height - legacyHeight;
        let pos = clamp(delta * DEBUG_SAMPLE_SCALE, 0.0, 1.0);
        let neg = clamp(-delta * DEBUG_SAMPLE_SCALE, 0.0, 1.0);
        debugSample = vec4<f32>(pos, 0.0, neg, 1.0);
    } else {
        let edgeFade = computeLodEdgeFade(finalUV, debugEdgeMask);
        debugEdge = rawNeighborLODs;
        let maskPack = clamp(debugEdgeMask, 0.0, 4095.0) / 4096.0;
        debugEdge.w = rawNeighborLODs.w + maskPack;
        debugSample = vec4<f32>(f32(selfLOD), edgeFade, debugAxis, debugSampleLod);
    }
    var worldPosition: vec3<f32>;
    var normal: vec3<f32>;
    var sphereDirOut: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);
    var heightMultiplier = max(uniforms.heightScale, 0.0001);
    var displacement = 0.0;

    // Spherical mode
    let faceUV = chunkLocation + positionUV * chunkSizeUVLocal;
    let cubePoint = getCubePoint(chunkFace, faceUV);
    var sphereDir = normalize(cubePoint);
    sphereDirOut = sphereDir;
    
    if (DEBUG_VERTEX_MODE == 1) {
        height = 0.0;
        heightMultiplier = 0.0;
    }
    var radius = uniforms.planetRadius + (height * heightMultiplier);
    if (FORCE_HEIGHT_TEST) {
        height = FORCE_HEIGHT_VALUE;
        radius = uniforms.planetRadius + height * FORCE_HEIGHT_MULT;
    }
    worldPosition = uniforms.planetOrigin + sphereDir * radius;
    normal = sphereDir;
    displacement = height * heightMultiplier;
    if (DEBUG_VERTEX_MODE == 1) {
        displacement = 0.0;
    }

    if (useInstancing && !USE_TRANSITION_TOPOLOGY) {
        let stitched = computeStitchedPosition(
            finalUV,
            edgeAxis,
            edgeValue,
            sampleLOD,
            selfLOD,
            chunkFace,
            chunkLocation,
            chunkSizeUVLocal,
            atlasOffset,
            atlasScale,
            heightLayer,
            heightMultiplier
        );
        if (stitched.applied != 0u) {
            height = stitched.height;
            displacement = height * heightMultiplier;
            worldPosition = stitched.worldPosition;
            sphereDir = stitched.sphereDir;
            sphereDirOut = sphereDir;
            normal = sphereDir;
            if (DEBUG_VERTEX_MODE == 1) {
                displacement = 0.0;
            }
        }
    }

    output.vWorldPosition = worldPosition;

    let viewPos = uniforms.viewMatrix * vec4<f32>(worldPosition, 1.0);
    output.vViewPosition = viewPos.xyz;
    output.vDistanceToCamera = length(viewPos.xyz);
    output.clipPosition = uniforms.projectionMatrix * viewPos;

    output.vUv = finalUV;
    output.vAtlasOffset = atlasOffset;
    output.vAtlasScale = atlasScale;
    output.vLayer = f32(heightLayer);
    output.vDebugEdge = debugEdge;
    output.vDebugSample = debugSample;
    let faceSizeWorld = uniforms.planetRadius * 2.0;
    var worldPos2D = chunkOffset + positionUV * uniforms.chunkSize;
    if (chunkFace >= 0) {
        worldPos2D = faceUV * faceSizeWorld;
    }
    output.vTileUv = finalUV * uniforms.chunkSize;
    output.vWorldPos = worldPos2D;
    output.vNormal = normal;
    output.vSphereDir = sphereDirOut;
    output.vHeight = height;
    output.vDisplacement = displacement;
    output.vFaceInfo = vec4<f32>(chunkLocation.x, chunkLocation.y, chunkSizeUVLocal, debugInstanceIndex);
    return output;
}
`;
}
