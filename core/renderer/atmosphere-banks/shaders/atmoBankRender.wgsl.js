import { buildAtmoBankCommonWGSL } from './atmoBankCommon.wgsl.js';

export function buildAtmoBankRenderWGSL({ typeCapacity = 4 } = {}) {
    const common = buildAtmoBankCommonWGSL({ typeCapacity });

    return /* wgsl */`
${common}

@group(0) @binding(0) var<uniform>       globals   : AtmoGlobals;
@group(0) @binding(1) var<storage, read> particles : array<AtmoParticle>;
@group(0) @binding(2) var<storage, read> liveList  : array<u32>;
@group(0) @binding(3) var<uniform>       typeDefs  : array<AtmoTypeDef, ATMO_TYPE_CAPACITY>;

@group(1) @binding(0) var noiseBase:   texture_3d<f32>;
@group(1) @binding(1) var noiseDetail: texture_3d<f32>;
@group(1) @binding(2) var noiseSampler: sampler;
@group(1) @binding(3) var depthTexture: texture_depth_2d;

struct VsOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldPos: vec3<f32>,
    @location(3) particleCenter: vec3<f32>,
    @location(4) noisePhase: vec3<f32>,
    @location(5) @interpolate(flat) noiseScale: f32,
    @location(6) @interpolate(flat) noiseSpeed: f32,
    @location(7) @interpolate(flat) opacity: f32,
    @location(8) @interpolate(flat) particleSize: f32,
    @location(9) @interpolate(flat) densityThreshold: f32,
};

fn quadCorner(vid: u32) -> vec2<f32> {
    switch (vid) {
        case 0u: { return vec2<f32>(-1.0, -1.0); }
        case 1u: { return vec2<f32>( 1.0, -1.0); }
        case 2u: { return vec2<f32>(-1.0,  1.0); }
        case 3u: { return vec2<f32>(-1.0,  1.0); }
        case 4u: { return vec2<f32>( 1.0, -1.0); }
        default: { return vec2<f32>( 1.0,  1.0); }
    }
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32,
           @builtin(instance_index) iid: u32) -> VsOut {
    let slot = liveList[iid];
    let p = particles[slot];
    let td = typeDefs[p.ptype];
    let corner = quadCorner(vid);

    let axisX = globals.cameraRight * (corner.x * p.size);
    let axisY = globals.cameraUp    * (corner.y * p.size);
    let wp = p.position + axisX + axisY;

    var out: VsOut;
    out.clipPos         = globals.viewProj * vec4<f32>(wp, 1.0);
    out.uv              = corner * 0.5 + vec2<f32>(0.5, 0.5);
    out.color           = p.color;
    out.worldPos        = wp;
    out.particleCenter  = p.position;
    out.noisePhase      = p.noisePhase;
    out.noiseScale      = td.noiseScale;
    out.noiseSpeed      = td.noiseSpeed;
    out.opacity         = p.opacity;
    out.particleSize    = p.size;
    out.densityThreshold = td.densityThreshold;
    return out;
}

fn linearizeDepth(d: f32, near: f32, far: f32) -> f32 {
    return (near * far) / (far - d * (far - near));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let center = in.uv - vec2<f32>(0.5, 0.5);
    let radialDist = length(center) * 2.0;
    if (radialDist >= 1.0) { discard; }

    let noiseCoord = in.worldPos * in.noiseScale + in.noisePhase +
                     vec3<f32>(globals.time * in.noiseSpeed, 0.0, globals.time * in.noiseSpeed * 0.7);

    let n1 = textureSampleLevel(noiseBase, noiseSampler, fract(noiseCoord), 0.0).r;
    let n2 = textureSampleLevel(noiseDetail, noiseSampler, fract(noiseCoord * 2.7 + vec3<f32>(0.3, 0.7, 0.1)), 1.0).r;
    let noise = n1 * 0.7 + n2 * 0.3;

    let density = smoothstep(in.densityThreshold, 1.0, noise);

    let radialFade = smoothstep(1.0, 0.3, radialDist);

    let depthDims = textureDimensions(depthTexture);
    let depthUV = vec2<i32>(in.clipPos.xy);
    let clampedCoord = clamp(depthUV, vec2<i32>(0), vec2<i32>(depthDims) - vec2<i32>(1));
    let sceneDepthRaw = textureLoad(depthTexture, clampedCoord, 0);
    let linearScene = linearizeDepth(sceneDepthRaw, globals.nearPlane, globals.farPlane);
    let linearFrag  = linearizeDepth(in.clipPos.z, globals.nearPlane, globals.farPlane);
    let softDist = max(in.particleSize * 0.15, 8.0);
    let depthFade = saturate((linearScene - linearFrag) / softDist);

    let alpha = density * radialFade * depthFade * in.opacity * in.color.a;
    if (alpha < 0.003) { discard; }
    return vec4<f32>(in.color.rgb * alpha, alpha);
}
`;
}
