import { CLOUD_ATMOSPHERE_WGSL, CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';

const HEADER = `${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}`;

export const TRANSMITTANCE_LUT_WGSL = /* wgsl */`${HEADER}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var outLut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var outCloudLight: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= 256u || id.y >= 64u) { return; }
    let R = u.planet.x;
    let Rt = u.planet.w;
    let x = vec2f(id.xy) / (TRANSMITTANCE_LUT_SIZE - 1.0);
    let H = sqrt((Rt - R) * (Rt + R));
    let rho = H * x.y;
    let r = sqrt(rho * rho + R * R);
    let dMin = Rt - r;
    let dMax = rho + H;
    let d = dMin + x.x * (dMax - dMin);
    var mu = 1.0;
    if (d > 1.0e-4) { mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0); }
    let steps = 48;
    let dt = d / f32(steps);
    var od = vec3f(0.0);
    for (var i = 0; i < steps; i++) {
        let t = (f32(i) + 0.5) * dt;
        let ri = sqrt(r * r + t * t + 2.0 * r * mu * t);
        od += atmoMedium(ri - R).extinction * dt;
    }
    // Sunset depth (march3.w; 1 = physical). Scaled down to this planet, the air reddens a low sun far
    // less than Earth's (horizon optical depth ~0.6 in blue, Earth ~7), so clouds stayed pale at dusk
    // while the sky drew an orange twilight. Extra depth for a low sun only; from ~12 deg up unchanged (from 30 deg clouds turned pink at mid-afternoon).
    let k = select(1.0, u.march3.w, u.march3.w > 0.0);
    let lowSun = 1.0 - smoothstep(0.0, 0.2, mu);
    let depthScale = mix(1.0, k, lowSun);
    let transmittance = exp(-od * depthScale);
    let physical = exp(-od);
    textureStore(outLut, vec2i(id.xy), vec4f(physical, 1.0));
    // Recover most of the brightness lost to deeper dusk tint, keeping the hue. Bake
    // this once per atmosphere edit instead of applying the power curve at every lit sample.
    var cloudLight = transmittance;
    if (depthScale > 1.001) {
        let lumW = vec3f(0.2126, 0.7152, 0.0722);
        cloudLight *= pow(dot(physical, lumW) / max(dot(transmittance, lumW), 1.0e-6), 0.8);
    }
    textureStore(outCloudLight, vec2i(id.xy), vec4f(cloudLight, dot(physical, vec3f(0.2126, 0.7152, 0.0722))));
}
`;

// Average incoming radiance per unit sun illuminance, as a function of sun zenith.
export const AMBIENT_LUT_WGSL = /* wgsl */`${HEADER}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var transLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var outLut: texture_storage_2d<rgba16float, write>;

fn skyRadiance(ro: vec3f, rd: vec3f, sunDir: vec3f) -> vec3f {
    let R = u.planet.x;
    let Rt = u.planet.w;
    let atmo = raySphere(ro, rd, Rt);
    let ground = raySphere(ro, rd, R);
    let hitGround = ground.x < ground.y && ground.x > 0.0;
    var tEnd = atmo.y;
    if (hitGround) { tEnd = ground.x; }
    let steps = 24;
    let dt = tEnd / f32(steps);
    let cosTheta = dot(rd, sunDir);
    let pr = rayleighPhase(cosTheta);
    let pm = henyeyGreenstein(cosTheta, u.atmoMie.w);
    var L = vec3f(0.0);
    var T = vec3f(1.0);
    for (var i = 0; i < steps; i++) {
        let p = ro + rd * ((f32(i) + 0.5) * dt);
        let r = length(p);
        let m = atmoMedium(r - R);
        let sunT = sunTransmittance(transLut, lutSampler, r, dot(p / r, sunDir), R, Rt);
        let S = sunT * (m.rayleigh * pr + m.mie * pm);
        let stepT = exp(-m.extinction * dt);
        L += T * (S - S * stepT) / max(m.extinction, vec3f(1.0e-7));
        T *= stepT;
    }
    if (hitGround) {
        let n = normalize(ro + rd * tEnd);
        let muS = dot(n, sunDir);
        let sunT = sunTransmittance(transLut, lutSampler, R, muS, R, Rt);
        L += T * (u.atmoExtra.y / PI) * sunT * max(muS, 0.0);
    }
    return L;
}

@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= 64u || id.y >= 3u) { return; }
    let R = u.planet.x;
    let mu = mix(AMBIENT_MU_MIN, 1.0, f32(id.x) / (AMBIENT_LUT_WIDTH - 1.0));
    let sunDir = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
    var altitude = 0.5 * (u.planet.y + u.planet.z) - R;
    if (id.y == 2u) { altitude = 0.002; }
    let ro = vec3f(0.0, R + altitude, 0.0);
    let downward = id.y == 1u;
    var sum = vec3f(0.0);
    let nTheta = 8;
    let nPhi = 16;
    for (var i = 0; i < nTheta; i++) {
        let z = (f32(i) + 0.5) / f32(nTheta);
        let s = sqrt(1.0 - z * z);
        for (var j = 0; j < nPhi; j++) {
            let phi = (f32(j) + 0.5) / f32(nPhi) * 2.0 * PI;
            var dir = vec3f(s * cos(phi), z, s * sin(phi));
            if (downward) { dir.y = -dir.y; }
            sum += skyRadiance(ro, dir, sunDir);
        }
    }
    textureStore(outLut, vec2i(id.xy), vec4f(sum / f32(nTheta * nPhi), 1.0));
}
`;
