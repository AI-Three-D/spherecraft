export function buildTerrainChunkHoverOverlayFragmentShader() {
    return /* wgsl */`
struct FragmentUniforms {
    cameraPosition: vec3<f32>,
    time: f32,

    chunkOffset: vec2<f32>,
    chunkWidth: f32,
    chunkHeight: f32,

    lightDirection: vec3<f32>,
    sunLightIntensity: f32,

    lightColor: vec3<f32>,
    terrainAODirectStrength: f32,

    ambientColor: vec3<f32>,
    ambientLightIntensity: f32,

    enableSplatLayer: f32,
    enableMacroLayer: f32,
    geometryLOD: i32,
    currentSeason: i32,

    nextSeason: i32,
    seasonTransition: f32,
    atlasTextureSize: f32,
    terrainAOStrength: f32,

    atlasUVOffset: vec2<f32>,
    atlasUVScale: f32,
    useAtlasMode: i32,

    isFeature: f32,
    aerialPerspectiveEnabled: f32,
    macroScale: f32,
    macroMaxLOD: i32,

    planetCenter: vec3<f32>,
    atmospherePlanetRadius: f32,

    atmosphereRadius: f32,
    atmosphereScaleHeightRayleigh: f32,
    atmosphereScaleHeightMie: f32,
    atmosphereMieAnisotropy: f32,

    atmosphereRayleighScattering: vec3<f32>,
    atmosphereMieScattering: f32,

    atmosphereSunIntensity: f32,
    fogDensity: f32,
    fogScaleHeight: f32,
    level2Blend: f32,

    fogColor: vec3<f32>,
    macroNoiseWeight: f32,
    terrainDebugMode: i32,
    terrainLayerViewMode: i32,
    _debugPad1: i32,
    _debugPad2: i32,

    terrainHoverFace: i32,
    terrainHoverFlags: i32,
    _hoverPad0: f32,
    _hoverPad1: f32,

    terrainHoverMicroRect: vec4<f32>,
    terrainHoverMacroRect: vec4<f32>,
    terrainHoverMicroColor: vec4<f32>,
    terrainHoverMacroColor: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fragUniforms: FragmentUniforms;

struct FragmentInput {
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
};

fn resolveCubeFace(dir: vec3<f32>) -> i32 {
    let absDir = abs(dir);
    if (absDir.x >= absDir.y && absDir.x >= absDir.z) {
        if (dir.x >= 0.0) {
            return 0;
        }
        return 1;
    }
    if (absDir.y >= absDir.z) {
        if (dir.y >= 0.0) {
            return 2;
        }
        return 3;
    }
    if (dir.z >= 0.0) {
        return 4;
    }
    return 5;
}

fn rectBorderMask(coord: vec2<f32>, rect: vec4<f32>, widthScale: f32) -> f32 {
    let distLeft = coord.x - rect.x;
    let distRight = rect.z - coord.x;
    let distBottom = coord.y - rect.y;
    let distTop = rect.w - coord.y;
    let edgeDist = min(min(distLeft, distRight), min(distBottom, distTop));

    let deriv = max(abs(fwidth(coord.x)), abs(fwidth(coord.y)));
    let lineWidth = max(deriv * max(widthScale, 1.0), 0.02);
    let insideMask =
        step(rect.x, coord.x) *
        step(coord.x, rect.z) *
        step(rect.y, coord.y) *
        step(coord.y, rect.w);
    return (1.0 - smoothstep(lineWidth, lineWidth * 2.0, edgeDist)) * insideMask;
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    if (fragUniforms.terrainHoverFace < 0 || fragUniforms.terrainHoverFlags == 0) {
        discard;
    }

    let face = resolveCubeFace(normalize(input.vSphereDir));
    if (face != fragUniforms.terrainHoverFace) {
        discard;
    }

    let coord = input.vWorldPos;
    var color = vec3<f32>(0.0, 0.0, 0.0);
    var alpha = 0.0;

    if ((fragUniforms.terrainHoverFlags & 2) != 0) {
        let macroMask = rectBorderMask(
            coord,
            fragUniforms.terrainHoverMacroRect,
            fragUniforms.terrainHoverMacroColor.w
        );
        color = mix(color, fragUniforms.terrainHoverMacroColor.rgb, macroMask);
        alpha = max(alpha, macroMask);
    }

    if ((fragUniforms.terrainHoverFlags & 1) != 0) {
        let microMask = rectBorderMask(
            coord,
            fragUniforms.terrainHoverMicroRect,
            fragUniforms.terrainHoverMicroColor.w
        );
        color = mix(color, fragUniforms.terrainHoverMicroColor.rgb, microMask);
        alpha = max(alpha, microMask);
    }

    if (alpha <= 0.001) {
        discard;
    }

    return vec4<f32>(color, clamp(alpha, 0.0, 1.0));
}
`;
}
