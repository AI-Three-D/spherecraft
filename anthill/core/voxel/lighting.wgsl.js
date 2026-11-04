import { MAX_ANTHILL_LIGHTS } from './AnthillLighting.js';

export const lightingDeclarationsWGSL = /* wgsl */ `
struct LocalLight { positionRadius: vec4<f32>, colorIntensity: vec4<f32> }
struct Lighting {
    sunDirection: vec4<f32>, sunColor: vec4<f32>, ambientCount: vec4<f32>, settings: vec4<f32>,
    bodyMin: vec4<f32>, bodyMax: vec4<f32>, lights: array<LocalLight, ${MAX_ANTHILL_LIGHTS}>,
}
@group(0) @binding(10) var<uniform> lighting: Lighting;
`;

// Requires the density sampler and conservative volumeTraversal helpers. Neither the
// cut plane nor the camera visibility depth participates in physical light visibility.
export const lightingFunctionsWGSL = /* wgsl */ `
// Finite flame approximation, in metres. No stochastic samples or extra shadow rays.
const flameRadius = 0.12;

fn bodyVisibility(origin: vec3<f32>, direction: vec3<f32>, distance: f32) -> f32 {
    if (lighting.bodyMin.w < 0.5) { return 1.0; }
    let center = (lighting.bodyMin.xyz + lighting.bodyMax.xyz) * 0.5;
    let halfSize = (lighting.bodyMax.xyz - lighting.bodyMin.xyz) * 0.5;
    let radius = min(min(halfSize.x, halfSize.z), halfSize.y);
    // A vertical capsule avoids the broad rectangular silhouette of the body box.
    let halfHeight = halfSize.y - radius;
    let a = center - vec3<f32>(0, halfHeight, 0);
    let height = max(2.0 * halfHeight, 0.00001);
    let offset = origin - a;
    let along = dot(direction, offset);
    let denominator = max(1.0 - direction.y * direction.y, 0.000001);
    var t = clamp((direction.y * offset.y - along) / denominator, 0.0, distance);
    let y = clamp(offset.y + t * direction.y, 0.0, height);
    // Recompute at the end caps, also handling rays parallel to the capsule axis.
    t = clamp(dot(vec3<f32>(0,y,0) - offset, direction), 0.0, distance);
    let separation = length(offset + direction * t - vec3<f32>(0,y,0)) - radius;
    let source = origin + direction * distance - a;
    let sourceClearance = length(source - vec3<f32>(0,clamp(source.y,0.0,height),0)) - radius;
    // A source crossing the coarse body proxy must not black out the whole cave.
    let sourceWeight = smoothstep(0.0, flameRadius, sourceClearance);
    // Bound the transition to retain an opaque core and early rejection of rays
    // deep in shadow, even when a carried flame is very close to the proxy.
    let penumbra = max(min(0.025, radius*0.25), min(radius*0.35,
        select(flameRadius * t / max(distance - t, flameRadius), t * 0.004, distance > 100000.0)));
    return mix(1.0, smoothstep(-penumbra, penumbra, separation), sourceWeight);
}

fn lightVisibility(origin: vec3<f32>, direction: vec3<f32>, distance: f32, body: bool) -> f32 {
    var visibility = 1.0;
    if (body) { visibility = bodyVisibility(origin, direction, distance); }
    if (visibility <= 0.0) { return 0.0; }
    let boundsMin = volume.origin.xyz;
    let boundsMax = boundsMin + vec3<f32>(volume.counts.xyz - vec3<u32>(1)) * volume.origin.w;
    var near = 0.0;
    var far = distance;
    for (var axis = 0u; axis < 3u; axis++) {
        if (abs(direction[axis]) < 0.0000001) {
            if (origin[axis] < boundsMin[axis] || origin[axis] > boundsMax[axis]) { return visibility; }
        } else {
            let a = (boundsMin[axis] - origin[axis]) / direction[axis];
            let b = (boundsMax[axis] - origin[axis]) / direction[axis];
            near = max(near, min(a, b));
            far = min(far, max(a, b));
        }
    }
    if (far < near) { return visibility; }
    let stride = volume.origin.w * 0.5;
    var t = near;
    var coarseUntil = near;
    var fineUntil = near;
    var baselineUntil = near;
    for (var step = 0u; step < 8192u; step++) {
        let point = origin + direction * t;
        if (volumeDensity(point) > 0.0) { return 0.0; }
        if (t >= far) { return visibility; }
        var skip = stride;
        if (t >= coarseUntil) {
            let block = blockBounds(point, direction, false);
            coarseUntil = t + block.x;
            baselineUntil = t;
            if (block.z < 0.5) { baselineUntil = coarseUntil; }
            if (block.y <= 0.0) { skip = max(skip, block.x); }
        }
        if (t < baselineUntil) {
            skip = max(skip, min(baselineUntil - t, baselineAirStep(point, direction)));
        }
        if (skip <= stride && t >= fineUntil && view.cutOrigin.x < f32(volume.counts.w)) {
            let block = blockBounds(point, direction, true);
            fineUntil = t + block.x;
            if (block.y <= 0.0) { skip = max(skip, block.x); }
        }
        // Bounds contain all interpolation neighbours. Never coarsen dense probes
        // to meet a budget; exhaustion remains occluded rather than leaking light.
        t = min(far, t + max(stride, floor(skip / stride) * stride));
    }
    return 0.0;
}

fn anthillSurfaceIrradiance(point: vec3<f32>, normal: vec3<f32>, geometricNormal: vec3<f32>, body: bool) -> vec3<f32> {
    let bias = min(volume.origin.w * 0.2, max(volume.origin.w * 0.04, view.params.x * 0.06));
    // Keep the ray outside the physical trilinear surface when shading normals are filtered.
    let origin = point + geometricNormal * bias;
    var result = lighting.ambientCount.rgb;
    let sunCosine = max(dot(normal, lighting.sunDirection.xyz), 0.0);
    if (lighting.sunDirection.w > 0.0 && sunCosine > 0.0) {
        result += lighting.sunColor.rgb * lighting.sunDirection.w * sunCosine
            * lightVisibility(origin, lighting.sunDirection.xyz, 1e6, body);
    }
    for (var i = 0u; i < u32(lighting.ambientCount.w); i++) {
        let light = lighting.lights[i];
        let delta = light.positionRadius.xyz - point;
        let distance = length(delta);
        if (distance >= light.positionRadius.w) { continue; }
        // Finite-source normalization avoids an unstable direction at the flame.
        let cosine = max(dot(normal, delta), 0.0)
            / sqrt(dot(delta,delta) + flameRadius * flameRadius);
        if (cosine <= 0.0) { continue; }
        let relative = distance / light.positionRadius.w;
        let squared = relative * relative;
        let falloff = 1.0 - squared * squared;
        let attenuation = falloff * falloff / (1.0 + distance * distance * 0.18);
        let shadowDelta = light.positionRadius.xyz - origin;
        let shadowDistance = length(shadowDelta);
        let shadowDirection = shadowDelta / max(shadowDistance,0.0001);
        var visibility = 1.0;
        if (body) { visibility = bodyVisibility(origin,shadowDirection,shadowDistance); }
        if (visibility > 0.0) {
            // Start in the light's open space, so conservative skips do not crawl
            // along the receiver's rock surface. Still one half-voxel shadow ray.
            visibility *= lightVisibility(light.positionRadius.xyz,-shadowDirection,shadowDistance,false);
        }
        result += light.colorIntensity.rgb * light.colorIntensity.w * cosine * attenuation
            * visibility;
    }
    return result;
}

fn anthillIrradiance(point: vec3<f32>, normal: vec3<f32>, body: bool) -> vec3<f32> {
    return anthillSurfaceIrradiance(point, normal, normal, body);
}

fn displayRadiance(radiance: vec3<f32>) -> vec3<f32> {
    return pow(vec3<f32>(1) - exp(-max(radiance, vec3<f32>(0))), vec3<f32>(1.0 / 2.2));
}
`;
