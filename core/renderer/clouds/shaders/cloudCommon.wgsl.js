// core/renderer/clouds/shaders/cloudCommon.wgsl.js
// Shared WGSL functions for cloud rendering (cirrus shell).

export const CLOUD_COMMON_WGSL = /* wgsl */`
const CLOUD_PI: f32 = 3.14159265359;

fn cloudRemap(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
    return newLo + (v - lo) / max(hi - lo, 0.0001) * (newHi - newLo);
}

fn cloudRayShellIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, rInner: f32, rOuter: f32) -> vec2<f32> {
    let oc = ro - center;
    let b = dot(oc, rd);

    let c_outer = dot(oc, oc) - rOuter * rOuter;
    var disc_outer = b * b - c_outer;
    if (disc_outer < 0.0) {
        if (disc_outer > -1e-4) { disc_outer = 0.0; }
        else { return vec2<f32>(-1.0, -1.0); }
    }

    let sqrt_outer = sqrt(max(disc_outer, 0.0));
    let t_outer_near = -b - sqrt_outer;
    let t_outer_far  = -b + sqrt_outer;
    if (t_outer_far < 0.0) { return vec2<f32>(-1.0, -1.0); }

    let c_inner = dot(oc, oc) - rInner * rInner;
    var disc_inner = b * b - c_inner;
    if (disc_inner < 0.0 && disc_inner > -1e-4) { disc_inner = 0.0; }

    let dist2 = dot(oc, oc);

    var tStart: f32;
    var tEnd: f32;

    if (dist2 < rInner * rInner) {
        if (disc_inner >= 0.0) {
            tStart = -b + sqrt(max(disc_inner, 0.0));
        } else {
            tStart = max(0.0, t_outer_near);
        }
        tEnd = t_outer_far;
    } else if (dist2 > rOuter * rOuter) {
        tStart = max(0.0, t_outer_near);
        if (disc_inner >= 0.0) {
            let sqrt_inner = sqrt(max(disc_inner, 0.0));
            let t_inner_near = -b - sqrt_inner;
            if (t_inner_near > tStart) {
                tEnd = t_inner_near;
            } else {
                tStart = max(tStart, -b + sqrt_inner);
                tEnd = t_outer_far;
            }
        } else {
            tEnd = t_outer_far;
        }
    } else {
        tStart = 0.0;
        if (disc_inner >= 0.0) {
            let t_inner_near = -b - sqrt(max(disc_inner, 0.0));
            if (t_inner_near > 0.0) { tEnd = t_inner_near; }
            else { tEnd = t_outer_far; }
        } else {
            tEnd = t_outer_far;
        }
    }

    if (tEnd <= tStart) { return vec2<f32>(-1.0, -1.0); }
    return vec2<f32>(tStart, tEnd);
}

fn cloudHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * CLOUD_PI * pow(max(denom, 0.0001), 1.5));
}
`;

export function getCloudCommonWGSL() {
    return CLOUD_COMMON_WGSL;
}
