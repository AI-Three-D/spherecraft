export function buildWaterVertexShader(options = {}) {
    const useArrayTextures = options.useArrayTextures !== false;
    const heightTextureType = useArrayTextures ? 'texture_2d_array<f32>' : 'texture_2d<f32>';

    return /* wgsl */`

struct WaterVertexUniforms {
    viewMatrix:         mat4x4<f32>,
    projectionMatrix:   mat4x4<f32>,

    cameraPosition:     vec3<f32>,
    planetRadius:       f32,

    planetOrigin:       vec3<f32>,
    oceanLevel:         f32,

    windDirection:      vec2<f32>,
    waveHeight:         f32,
    waveFrequency:      f32,

    time:               f32,
    windSpeed:          f32,
    maxWaveLOD:         f32,
    maxFoamLOD:         f32,

    heightScale:        f32,
    useInstancing:      f32,
    _pad0:              vec2<f32>,
}

struct ChunkInstance {
    position:       vec3<f32>,
    face:           u32,
    chunkLocation:  vec2<f32>,
    chunkSizeUV:    f32,
    _pad:           f32,
    uvOffset:       vec2<f32>,
    uvScale:        f32,
    lod:            u32,
    neighborLODs:   vec2<u32>,
    layer:          u32,
    edgeMask:       u32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition:    vec4<f32>,
    @location(0) vWorldPosition:        vec3<f32>,
    @location(1) vViewPosition:         vec3<f32>,
    @location(2) vFaceUV:               vec2<f32>,
    @location(3) vLocalUV:              vec2<f32>,
    @location(4) vViewNormal:           vec3<f32>,
    @location(5) vWaveHeight:           f32,
    @location(6) vTerrainHeight:        f32,
    @location(7) vDistanceToCamera:     f32,
    @location(8) vAtlasOffset:          vec2<f32>,
    @location(9) vAtlasScale:           f32,
    @location(10) vLayer:               f32,
    @location(11) vWavePhase:           f32,
    @location(12) vOceanLevel:          f32,
    @location(13) vLod:                 f32,
    @location(14) vWaveCoord:           vec2<f32>,
      @location(15) vEdgeFade: f32,  // 0.0 at coarser-neighbor edges, 1.0 interior/finer edges
}

@group(0) @binding(0) var<uniform> uniforms: WaterVertexUniforms;
@group(1) @binding(0) var heightTexture: ${heightTextureType};
@group(2) @binding(0) var<storage, read> chunks: array<ChunkInstance>;

fn getCubePoint(face: i32, uv: vec2<f32>) -> vec3<f32> {
    let xy = uv * 2.0 - 1.0;
    if (face == 0) { return vec3<f32>( 1.0,  xy.y, -xy.x); }
    if (face == 1) { return vec3<f32>(-1.0,  xy.y,  xy.x); }
    if (face == 2) { return vec3<f32>( xy.x,  1.0, -xy.y); }
    if (face == 3) { return vec3<f32>( xy.x, -1.0,  xy.y); }
    if (face == 4) { return vec3<f32>( xy.x,  xy.y,  1.0); }
    return vec3<f32>(-xy.x,  xy.y, -1.0);
}

${useArrayTextures ? `
fn loadHeight(coord: vec2<i32>, layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, layer, 0).r;
}
` : `
fn loadHeight(coord: vec2<i32>, _layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, 0).r;
}
`}

fn sampleTerrainHeight(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    let texSize    = vec2<f32>(textureDimensions(heightTexture));
    let globalMax  = vec2<i32>(textureDimensions(heightTexture)) - vec2<i32>(1);
    let chunkSizeF = max(texSize * atlasScale, vec2<f32>(1.0));
    let chunkSizeI = vec2<i32>(floor(chunkSizeF + vec2<f32>(0.5)));
    let maxLocalI  = max(chunkSizeI - vec2<i32>(1), vec2<i32>(1));
    let clamped    = clamp(localUV, vec2<f32>(0.0), vec2<f32>(1.0));
    let localCoord = clamped * vec2<f32>(maxLocalI);
    let baseCoordI = vec2<i32>(floor(atlasOffset * texSize + vec2<f32>(0.5)));
    let coord      = vec2<f32>(baseCoordI) + localCoord;
    let baseCoord  = floor(coord);
    let f          = coord - baseCoord;
    let c00 = vec2<i32>(baseCoord);
    let c10 = c00 + vec2<i32>(1, 0);
    let c01 = c00 + vec2<i32>(0, 1);
    let c11 = c00 + vec2<i32>(1, 1);
    let minC = baseCoordI;
    let maxC = min(baseCoordI + maxLocalI, globalMax);
    let h00 = loadHeight(clamp(c00, minC, maxC), layer);
    let h10 = loadHeight(clamp(c10, minC, maxC), layer);
    let h01 = loadHeight(clamp(c01, minC, maxC), layer);
    let h11 = loadHeight(clamp(c11, minC, maxC), layer);
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

fn windAmplitude(octaveDir: vec2<f32>, wd: vec2<f32>) -> f32 {
    let alignment = dot(octaveDir, wd);
    return 0.3 + 0.7 * max(alignment, 0.0);
}

fn waveOffset(waveCoord: vec2<f32>, t: f32, wh: f32, wf: f32, wd: vec2<f32>, ws: f32) -> vec3<f32> {
    let dir1 = vec2<f32>(0.8, 0.6);
    let dir2 = vec2<f32>(-0.6, 0.8);
    let dir3 = vec2<f32>(0.38, 0.92);
    let windNorm = normalize(wd);
    let amp1 = windAmplitude(dir1, windNorm);
    let amp2 = windAmplitude(dir2, windNorm);
    let amp3 = windAmplitude(dir3, windNorm);
    let warpBase1 = dot(waveCoord * 0.05, vec2<f32>(0.11, 0.07)) * 0.7;
    let warpBase2 = dot(waveCoord * 0.05, vec2<f32>(-0.09, 0.13)) * 0.8;
    let w1 = sin(warpBase1 + t * 0.15);
    let w2 = sin(warpBase2 - t * 0.12);
    let warped = waveCoord + vec2<f32>(w1, w2) * 0.75;
    let p1 = dot(warped, dir1) * wf        - t * 0.8;
    let p2 = dot(warped, dir2) * wf * 0.72 - t * 0.64;
    let p3 = dot(warped, dir3) * wf * 1.33 - t * 0.96;
    let baseY = wh * amp1 * sin(p1)
              + wh * 0.6  * amp2 * sin(p2)
              + wh * 0.4  * amp3 * sin(p3);
    let chopPhase1 = dot(warped, vec2<f32>(0.01, 0.013)) + t * 3.0;
    let chopPhase2 = dot(warped, vec2<f32>(0.021, 0.009)) - t * 2.7;
    let chop = sin(chopPhase1) * 0.15 + sin(chopPhase2) * 0.08;
    return vec3<f32>(baseY + wh * chop, p1, 0.0);
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    var output: VertexOutput;

    let chunk         = chunks[instanceIdx];
    let chunkFace     = i32(chunk.face);
    let chunkLocation = chunk.chunkLocation;
    let chunkSizeUV   = chunk.chunkSizeUV;
    let atlasOffset   = chunk.uvOffset;
    let atlasScale    = chunk.uvScale;
    let layer         = i32(chunk.layer);
    let lod           = chunk.lod;

    let localUV = input.uv;
    // Decode neighbor LODs from packed format
let neighborPacked = chunk.neighborLODs.x;
let leftLOD   = (neighborPacked      ) & 0xFu;
let rightLOD  = (neighborPacked >>  4u) & 0xFu;
let bottomLOD = (neighborPacked >>  8u) & 0xFu;
let topLOD    = (neighborPacked >> 12u) & 0xFu;

let selfLOD = chunk.lod;

// Distance to edges
let distLeft   = localUV.x;
let distRight  = 1.0 - localUV.x;
let distBottom = localUV.y;
let distTop    = 1.0 - localUV.y;

// MUCH WIDER fade for visibility (30% of tile)
let fadeWidth = 0.3;

var edgeFade = 1.0;

// Check each edge - if neighbor is COARSER (higher LOD number), fade
if (leftLOD > selfLOD) {
    edgeFade = min(edgeFade, smoothstep(0.0, fadeWidth, distLeft));
}
if (rightLOD > selfLOD) {
    edgeFade = min(edgeFade, smoothstep(0.0, fadeWidth, distRight));
}
if (bottomLOD > selfLOD) {
    edgeFade = min(edgeFade, smoothstep(0.0, fadeWidth, distBottom));
}
if (topLOD > selfLOD) {
    edgeFade = min(edgeFade, smoothstep(0.0, fadeWidth, distTop));
}

output.vEdgeFade = edgeFade;

    let faceUV  = chunkLocation + localUV * chunkSizeUV;

    let cubePoint = getCubePoint(chunkFace, faceUV);
    let sphereDir = normalize(cubePoint);

    let oceanRadius = uniforms.planetRadius + uniforms.oceanLevel;
    let waveCoord   = faceUV * uniforms.planetRadius * 2.0;

    let terrainH  = sampleTerrainHeight(localUV, atlasOffset, atlasScale, layer);
    let baseDepth = max(uniforms.oceanLevel - terrainH * uniforms.heightScale, 0.0);
    var waveAtten = smoothstep(0.3, 8.0, baseDepth);
    waveAtten = mix(0.12, 1.0, waveAtten);

    var waveH:     f32 = 0.0;
    var wavePhase: f32 = 0.0;
    if (f32(lod) <= uniforms.maxWaveLOD) {
        let localWaveHeight = uniforms.waveHeight * waveAtten;
        let wOff = waveOffset(
            waveCoord, uniforms.time,
            localWaveHeight, uniforms.waveFrequency,
            uniforms.windDirection, uniforms.windSpeed
        );
        waveH     = wOff.x;
        wavePhase = wOff.y;
    }

    let worldPosition = uniforms.planetOrigin + sphereDir * (oceanRadius + waveH);
    let viewPos       = uniforms.viewMatrix * vec4<f32>(worldPosition, 1.0);
    let viewNormal    = (uniforms.viewMatrix * vec4<f32>(sphereDir, 0.0)).xyz;
    let clipPos       = uniforms.projectionMatrix * viewPos;

    output.clipPosition      = clipPos;
    output.vWorldPosition    = worldPosition;
    output.vViewPosition     = viewPos.xyz;
    output.vFaceUV           = faceUV;
    output.vLocalUV          = localUV;
    output.vViewNormal       = viewNormal;
    output.vWaveHeight       = waveH;
    output.vTerrainHeight    = terrainH;
    output.vDistanceToCamera = length(viewPos.xyz);
    output.vAtlasOffset      = atlasOffset;
    output.vAtlasScale       = atlasScale;
    output.vLayer            = f32(layer);
    output.vWavePhase        = wavePhase;
    output.vOceanLevel       = uniforms.oceanLevel;
    output.vLod              = f32(lod);
    output.vWaveCoord        = waveCoord;

    return output;
}
`;
}


export function buildWaterFragmentShader(options = {}) {
    const useArrayTextures = options.useArrayTextures !== false;
    const heightTextureType = useArrayTextures ? 'texture_2d_array<f32>' : 'texture_2d<f32>';

    return /* wgsl */`

struct WaterFragmentUniforms {
    colorShallow:       vec3<f32>,
    shallowAlpha:       f32,

    colorDeep:          vec3<f32>,
    deepAlpha:          f32,

    depthRange:         f32,
    foamIntensity:      f32,
    foamDepthStart:     f32,
    foamDepthEnd:       f32,

    sunDirection:       vec3<f32>,
    sunIntensity:       f32,

    sunColor:           vec3<f32>,
    maxWaveLOD:         f32,

    ambientColor:       vec3<f32>,
    ambientIntensity:   f32,

    fogColor:           vec3<f32>,
    fogDensity:         f32,

    weatherIntensity:   f32,
    currentWeather:     f32,
    foamTiling:         f32,
    maxFoamLOD:         f32,

    windDirection:      vec2<f32>,
    windSpeed:          f32,
    waveHeight:         f32,

    heightScale:        f32,
    oceanLevel:         f32,
    time:               f32,
    _pad1:              f32,
}

@group(0) @binding(1) var<uniform> frag: WaterFragmentUniforms;
@group(1) @binding(0) var heightTexture: ${heightTextureType};

${useArrayTextures ? `
fn loadHeight(coord: vec2<i32>, layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, layer, 0).r;
}
` : `
fn loadHeight(coord: vec2<i32>, _layer: i32) -> f32 {
    return textureLoad(heightTexture, coord, 0).r;
}
`}

fn sampleTerrainHeightFrag(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> f32 {
    let texSize    = vec2<f32>(textureDimensions(heightTexture));
    let globalMax  = vec2<i32>(textureDimensions(heightTexture)) - vec2<i32>(1);
    let chunkSizeF = max(texSize * atlasScale, vec2<f32>(1.0));
    let chunkSizeI = vec2<i32>(floor(chunkSizeF + vec2<f32>(0.5)));
    let maxLocalI  = max(chunkSizeI - vec2<i32>(1), vec2<i32>(1));
    let clamped    = clamp(localUV, vec2<f32>(0.0), vec2<f32>(1.0));
    let localCoord = clamped * vec2<f32>(maxLocalI);
    let baseCoordI = vec2<i32>(floor(atlasOffset * texSize + vec2<f32>(0.5)));
    let coord      = vec2<f32>(baseCoordI) + localCoord;
    let baseCoord  = floor(coord);
    let fr         = coord - baseCoord;
    let c00 = vec2<i32>(baseCoord);
    let c10 = c00 + vec2<i32>(1, 0);
    let c01 = c00 + vec2<i32>(0, 1);
    let c11 = c00 + vec2<i32>(1, 1);
    let minC = baseCoordI;
    let maxC = min(baseCoordI + maxLocalI, globalMax);
    let h00 = loadHeight(clamp(c00, minC, maxC), layer);
    let h10 = loadHeight(clamp(c10, minC, maxC), layer);
    let h01 = loadHeight(clamp(c01, minC, maxC), layer);
    let h11 = loadHeight(clamp(c11, minC, maxC), layer);
    return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}

fn foamNoise(p: vec2<f32>) -> f32 {
    let n1  = sin(p.x * 6.0)  * sin(p.y * 6.0);
    let n2  = sin(p.x * 13.0 + 1.57) * sin(p.y * 13.0 + 1.57);
    let n3  = sin(p.x * 26.0 + 3.14) * sin(p.y * 26.0 + 3.14);
    let raw = (n1 * 0.55 + n2 * 0.3 + n3 * 0.15) * 0.5 + 0.5;
    return smoothstep(0.2, 0.8, raw);
}

fn getShoreGradient(localUV: vec2<f32>, atlasOffset: vec2<f32>, atlasScale: f32, layer: i32) -> vec2<f32> {
    let texSize = vec2<f32>(textureDimensions(heightTexture));
    let step    = 1.0 / max(texSize.x * atlasScale, 1.0);
    let hL = sampleTerrainHeightFrag(localUV + vec2<f32>(-step, 0.0), atlasOffset, atlasScale, layer);
    let hR = sampleTerrainHeightFrag(localUV + vec2<f32>( step, 0.0), atlasOffset, atlasScale, layer);
    let hD = sampleTerrainHeightFrag(localUV + vec2<f32>(0.0, -step), atlasOffset, atlasScale, layer);
    let hU = sampleTerrainHeightFrag(localUV + vec2<f32>(0.0,  step), atlasOffset, atlasScale, layer);
    let gradient = vec2<f32>(hR - hL, hU - hD);
    let len = length(gradient);
    if (len > 0.001) { return gradient / len; }
    return vec2<f32>(0.0);
}

@fragment
fn main(
    @location(0) vWorldPosition:    vec3<f32>,
    @location(1) vViewPosition:     vec3<f32>,
    @location(2) vFaceUV:           vec2<f32>,
    @location(3) vLocalUV:          vec2<f32>,
    @location(4) vViewNormal:       vec3<f32>,
    @location(5) vWaveHeight:       f32,
    @location(6) vTerrainHeight:    f32,
    @location(7) vDistanceToCamera: f32,
    @location(8) vAtlasOffset:      vec2<f32>,
    @location(9) vAtlasScale:       f32,
    @location(10) vLayer:           f32,
    @location(11) vWavePhase:       f32,
    @location(12) vOceanLevel:      f32,
    @location(13) vLod:             f32,
    @location(14) vWaveCoord:       vec2<f32>,
      @location(15) vEdgeFade: f32, 
) -> @location(0) vec4<f32> {
  //  return vec4<f32>(1.0 - vEdgeFade, 0.0, vEdgeFade, 1.0);
    
    let layer = i32(vLayer);

    let terrainH      = sampleTerrainHeightFrag(vLocalUV, vAtlasOffset, vAtlasScale, layer);
    let surfaceH      = vOceanLevel + vWaveHeight;
    let terrainAltitude = terrainH * frag.heightScale;
    let depth         = surfaceH - terrainAltitude;

    if (depth <= 0.0) {
        discard;
    }

    var waveAtten = smoothstep(0.3, 8.0, depth);
    waveAtten = mix(0.12, 1.0, waveAtten);

    let L = normalize(frag.sunDirection);
    let V = normalize(-vViewPosition);

    var N    = normalize(vViewNormal);
    var geoN = cross(dpdx(vViewPosition), dpdy(vViewPosition));
    let invGeoLen = inverseSqrt(max(dot(geoN, geoN), 1e-12));
    geoN = geoN * invGeoLen;
    if (dot(geoN, N) < 0.0) { geoN = -geoN; }
    let waveMask = select(0.0, 1.0, vLod <= frag.maxWaveLOD);
  

    let detailMask = select(vEdgeFade, 1.0, vLod <= frag.maxWaveLOD);
    
    // Modulate wave normal strength
    let waveNormalStrength = detailMask * waveMask * waveAtten;
    N = normalize(mix(N, geoN, 0.5 * (1.0 - waveNormalStrength)));
    

    if (dot(N, V) < 0.0) { N = -N; }

    let H     = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let spec  = pow(NdotH, 96.0);

    let depthT = clamp(depth / max(frag.depthRange, 0.0001), 0.0, 1.0);
    let depthA = 1.0 - exp(-depth / max(frag.depthRange, 0.001));

    let baseColor = mix(frag.colorShallow, frag.colorDeep, depthT);

    let NdotV = clamp(dot(N, V), 0.0, 1.0);
    let F0    = 0.03;
    let fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
    var reflectionStrength = clamp(fresnel * 0.95, 0.0, 1.0);
    reflectionStrength = reflectionStrength * mix(0.35, 1.0, depthT);

    let lighting = frag.ambientColor * frag.ambientIntensity
                 + frag.sunColor * NdotL * frag.sunIntensity;
    let diffuse  = baseColor * lighting;
    let specular = frag.sunColor * spec * (0.2 + 0.3 * depthT) * frag.sunIntensity * detailMask;

    let reflectionTint = mix(baseColor, frag.fogColor, 0.35);
    let skyReflection  = reflectionTint * (0.2 + 0.45 * NdotL);

    var alpha = mix(frag.shallowAlpha, frag.deepAlpha, depthA);
    alpha = max(alpha, 0.12 + fresnel * 0.25);
    let distanceFade = smoothstep(70.0, 120.0, vDistanceToCamera);
    alpha = mix(alpha, 1.0, distanceFade);

    // Orbital LOD — flat shading, no waves
    if (vLod > frag.maxWaveLOD + 1.0) {
        let orbitalColor = mix(frag.colorDeep, frag.colorShallow, 0.3);
        let orbitalLit   = orbitalColor * (frag.ambientColor * frag.ambientIntensity
                                         + frag.sunColor * NdotL * frag.sunIntensity);
        return vec4<f32>(orbitalLit, 1.0);
    }

    // Foam
    var foam: f32 = 0.0;
    if (vLod <= frag.maxFoamLOD) {
        let shoreNormal = getShoreGradient(vLocalUV, vAtlasOffset, vAtlasScale, layer);
        let shoreLen    = length(shoreNormal);
        if (shoreLen > 0.001) {
            let normalizedWind  = normalize(frag.windDirection);
            let windToShore     = dot(normalizedWind, shoreNormal);
            let windApproaching = smoothstep(-0.3, 0.4, windToShore);
            let normalizedWH    = (vWaveHeight + frag.waveHeight) / (2.0 * max(frag.waveHeight, 0.001));
            let waveStrength    = smoothstep(0.2, 0.85, normalizedWH) * waveAtten;
            let foamDepthMask   = smoothstep(frag.foamDepthEnd, frag.foamDepthStart, depth);
            let foamUV1  = vWaveCoord * frag.foamTiling;
            let foamUV2  = vWaveCoord * frag.foamTiling * 1.7 + vec2<f32>(0.3, 0.7);
            let fNoise   = mix(foamNoise(foamUV1), foamNoise(foamUV2), 0.5);
            let localVar = sin(vWaveCoord.x * 0.3) * sin(vWaveCoord.y * 0.3) * 0.5 + 0.5;
            var noiseFinal = mix(fNoise, fNoise * localVar, 0.25);
            noiseFinal = smoothstep(0.25, 0.85, noiseFinal);
            var baseFoam = foamDepthMask * windApproaching * waveStrength * noiseFinal * frag.foamIntensity;
            if (depth < 0.8 && waveStrength > 0.3) {
                baseFoam += waveStrength * windApproaching * 0.4 * noiseFinal;
            }
            let streakNoise = fract(sin(dot(vWaveCoord, vec2<f32>(12.9898, 78.233))) * 43758.5453);
            if (depth < 2.0 && streakNoise > 0.96 && waveStrength > 0.45) {
                baseFoam += 0.15;
            }
            foam = clamp(baseFoam, 0.0, 1.0) * detailMask; 
        }
    }

    var color = mix(diffuse, skyReflection, reflectionStrength) + specular;
    color = mix(color, vec3<f32>(1.0), foam * 0.8);
    alpha = max(alpha, foam * 0.35);
    alpha = clamp(alpha, 0.0, 1.0);

    var fogF = 1.0 - exp(-frag.fogDensity * vDistanceToCamera);
    if (frag.currentWeather >= 1.0) {
        fogF = min(fogF * (1.0 + 0.5 * frag.weatherIntensity), 1.0);
    }
    if (frag.currentWeather >= 3.0) {
        fogF = min(fogF * (1.0 + 2.0 * frag.weatherIntensity), 1.0);
    }
    color = mix(color, frag.fogColor, clamp(fogF, 0.0, 1.0));

    return vec4<f32>(color, alpha);
}
`;
}