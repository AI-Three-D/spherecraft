import { AERIAL_PERSPECTIVE_WGSL } from '../../atmosphere/shaders/aerialPerspectiveCommon.js';
import { CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';
import {
    CLOUD_HAZE_LOOKUP_WGSL, CLOUD_HAZE_STRUCT_WGSL, CLOUD_MIST_LIGHT_WGSL, CLOUD_MIST_LOOKUP_WGSL, CLOUD_RAY_LOOKUP_WGSL,
    CLOUD_SURFACE_VISIBILITY_WGSL, CLOUD_UPSAMPLE_WGSL,
} from './cloudCompositeParts.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './cloudCompositeUniforms.wgsl.js';
import { LOCAL_MIST_LOOKUP_WGSL, LOCAL_VOLUME_UNIFORMS_WGSL } from './cloudLocalVolumes.wgsl.js';

const COMMON_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_COMPOSITE_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> cu: CompositeUniforms;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(10) var mistTable: texture_2d<f32>;
${CLOUD_MIST_LOOKUP_WGSL}${CLOUD_MIST_LIGHT_WGSL}

// Mist in front of and behind a premultiplied cloud colour (rgb, a transmittance).
fn addMist(cloud: vec4f, ro: vec3f, rd: vec3f, sceneKm: f32, cloudKm: f32) -> vec4f {
    if (cu.mistRay.z <= 0.0) { return cloud; }
    let T = exp(-mistDepths(ro, rd, sceneKm, cloudKm));
    let veil = mix(1.0 - T.x, 1.0 - T.y, cloud.a);
    return vec4f(cloud.rgb * T.x + groundMistLight(ro, rd) * veil, cloud.a * T.y);
}
`;

// The air in front of the clouds, at cloud resolution: haze, the fade of distant clouds and, for rays to the sky, god rays and
// mist. The full composite does this per screen pixel.
export function buildLeanAirShader(godRays = false) {
    return /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(2) var colorIn: texture_2d<f32>;
@group(0) @binding(3) var depthIn: texture_2d<f32>;
@group(0) @binding(8) var hazeRadiance: texture_3d<f32>;
@group(0) @binding(9) var hazeTransmittance: texture_3d<f32>;
@group(0) @binding(12) var outColor: texture_storage_2d<rgba16float, write>;
${godRays ? `@group(0) @binding(16) var rayVolume: texture_3d<f32>;${CLOUD_RAY_LOOKUP_WGSL}` : ''}
${CLOUD_HAZE_STRUCT_WGSL}${CLOUD_HAZE_LOOKUP_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(colorIn);
    if (any(id.xy >= size)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let c = textureLoad(colorIn, id.xy, 0);
    let depth = textureLoad(depthIn, id.xy, 0).r;
    var cloud = vec4f(max(c.rgb, vec3f(0.0)), saturate(c.a));
    let cloudKm = abs(depth);
    if (cloud.a < 0.999) {
        let haze = lookupHaze(uv, cloudKm);
        let below = 0.35 * (1.0 - u.lod.x);
        let distant = smoothstep(u.banks.z * 0.64, u.banks.z * 1.8, cloudKm);
        let visible = 1.0 - 0.78 * u.banks.x * below * distant * (1.0 - 0.84 * u.weatherStyle.y);
        ${godRays ? /* wgsl */`let front = lookupRays(uv, cloudKm);
        let air = haze.L * front.a + front.rgb;` : 'let air = haze.L;'}
        cloud = vec4f((haze.T * cloud.rgb + (1.0 - cloud.a) * air) * visible, 1.0 - (1.0 - cloud.a) * visible);
    }
    // Rays to the ground get their mist per screen pixel, from its own distance.
    if (depth >= 0.0) {
        ${godRays ? /* wgsl */`let behind = lookupRays(uv, 1.0e30);
        cloud = vec4f(cloud.rgb + behind.rgb * cloud.a, cloud.a * behind.a);` : ''}
        let rd = cameraRay(uv, vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
        cloud = addMist(cloud, u.camPos.xyz, rd, 1.0e30, cloudKm);
    }
    textureStore(outColor, id.xy, cloud);
}
`;
}


// Composites the result: upsampling, and for the ground cloud shadows and mist. Draws the cirrus as well, rendered at a
// lower resolution. Without clouds (the low tier): cirrus, mist and an even shade on the ground under a deck.
export function buildLeanCompositeShader(clouds, godRays = false) {
    return /* wgsl */`${COMMON_WGSL}${AERIAL_PERSPECTIVE_WGSL}
@group(0) @binding(4) var sceneDepth: texture_depth_2d;
@group(0) @binding(6) var cirrusFar: texture_2d<f32>;
@group(0) @binding(8) var cirrusNear: texture_2d<f32>;
${clouds ? /* wgsl */`
@group(0) @binding(2) var cloudColor: texture_2d<f32>;
@group(0) @binding(3) var cloudDepth: texture_2d<f32>;
@group(0) @binding(5) var shadowMap: texture_2d<f32>;
@group(0) @binding(11) var pointSampler: sampler;
${CLOUD_SHADOW_LOOKUP_WGSL}${CLOUD_UPSAMPLE_WGSL}
@group(0) @binding(13) var localMist: texture_3d<f32>;
@group(0) @binding(14) var<uniform> local: LocalVolumes;
@group(0) @binding(15) var mountainFog: texture_3d<f32>;
${LOCAL_VOLUME_UNIFORMS_WGSL}${LOCAL_MIST_LOOKUP_WGSL}
${godRays ? `@group(0) @binding(16) var rayVolume: texture_3d<f32>;${CLOUD_RAY_LOOKUP_WGSL}` : ''}
` : ''}
${CLOUD_SURFACE_VISIBILITY_WGSL}
override CIRRUS_NEAR: bool = false;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) ray: vec3f, // view ray of view depth 1
}

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
    var o: VsOut;
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
    o.ray = u.camRight.xyz * ((o.pos.x + u.camBack.w) / u.camRight.w)
        + u.camUp.xyz * ((o.pos.y + u.frameInfo.x) / u.camUp.w) - u.camBack.xyz;
    return o;
}

// Premultiplied layers: 'over' in front of 'under'.
fn inFront(over: vec4f, under: vec4f) -> vec4f {
    return vec4f(over.rgb + over.a * under.rgb, over.a * under.a);
}

fn cirrus(layer: texture_2d<f32>, uv: vec2f) -> vec4f {
    let c = textureSampleLevel(layer, linearSampler, uv, 0.0);
    return vec4f(c.rgb, 1.0 - c.a);
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4f {
    let pix = input.pos.xy;
    let uv = pix / cu.viewport.xy;
    let ro = u.camPos.xyz;
    let z = textureLoad(sceneDepth, vec2i(pix), 0);
    let opaque = z < 1.0;
    var cloud = vec4f(0.0, 0.0, 0.0, 1.0);
    var cloudKm = 1.0e30;
    var seenKm = 1.0e30;
    ${clouds ? /* wgsl */`
    let size = vec2i(textureDimensions(cloudColor));
    let upsampled = upsampleCloud(uv, size, opaque);
    cloud = vec4f(max(upsampled.color.rgb, vec3f(0.0)), saturate(upsampled.color.a));
    cloudKm = upsampled.depth;
    ` : ''}
    if (opaque) {
        let rayLength = length(input.ray);
        let rd = input.ray / rayLength;
        let sceneKm = u.sceneDepth.y / (z + u.sceneDepth.x) * u.sceneDepth.z * rayLength;
        seenKm = sceneKm;
        ${godRays ? /* wgsl */`
        let behind = lookupRays(uv, sceneKm);
        cloud = vec4f(cloud.rgb + behind.rgb * cloud.a, cloud.a * (1.0 - (1.0 - behind.a) * (1.0 - surfaceVisibility(ro, rd, sceneKm))));
        ` : ''}
        ${clouds ? 'if (max(local.fog.x, local.drift.w) > 0.0) { cloud = addMountainFog(cloud, uv, sceneKm, min(sceneKm, cloudKm)); }' : ''}
        cloud = addMist(cloud, ro, rd, sceneKm, min(sceneKm, cloudKm));
        // The shadow darkens the surface only, after the mist has used the transmittance.
        ${clouds ? /* wgsl */`
        if (cu.viewport.z > 0.0 && u.shadowInfo.z > 0.0) {
            let lit = cloudShadowSmoothAt(ro + rd * sceneKm, cu.viewport.z);
            if (lit < 1.0) { cloud.a *= mix(1.0, mix(cu.atmo2.z, 1.0, lit), surfaceVisibility(ro, rd, sceneKm)); }
        }
        ` : /* wgsl */`
        let shade = cu.viewport.z * smoothstep(0.3, 0.95, u.weatherStyle.y) * u.weatherStyle.x;
        if (shade > 0.0) { cloud.a *= mix(1.0, 1.0 - shade * (1.0 - cu.atmo2.z), surfaceVisibility(ro, rd, sceneKm)); }
        `}
    } else {
        ${clouds ? /* wgsl */`if (max(local.fog.x, local.drift.w) > 0.0) { cloud = addMountainFog(cloud, uv, 1.0e30, cloudKm); }
        cloud = inFront(cloud, cirrus(cirrusFar, uv));` : /* wgsl */`
        let rd = normalize(input.ray);
        // A grey sky stands in for the deck, behind the cirrus, which gives it some structure. It clears from above.
        let below = 1.0 - smoothstep(u.planet.y, u.planet.z, length(ro));
        let veil = 0.92 * below * smoothstep(0.25, 0.9, u.weatherStyle.y) * u.weatherStyle.x;
        let grey = groundMistLight(ro, rd) * (1.15 - 0.55 * u.weatherStyle.z);
        cloud = inFront(cirrus(cirrusFar, uv), vec4f(grey * veil, 1.0 - veil));
        cloud = addMist(cloud, ro, rd, 1.0e30, 1.0e30);
        `}
    }
    ${clouds ? /* wgsl */`if (local.mist.x > 0.0) {
        let near = localMistTo(uv, seenKm);
        cloud = vec4f(near.rgb + near.a * cloud.rgb, near.a * cloud.a);
    }` : ''}
    if (CIRRUS_NEAR) { cloud = inFront(cirrus(cirrusNear, uv), cloud); }
    return cloud;
}
`;
}
