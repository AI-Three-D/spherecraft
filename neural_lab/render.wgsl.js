// Deterministic comparison renderer: one fine march over the game's density field, shading every
// sample with (a) the game's analytic sun/sky terms, (b) the same formulas refit to the teacher,
// (c) trained networks. The path-traced image from teacher.wgsl.js is the reference.
import { TEACHER_HEADER } from './teacher.wgsl.js';
import { mlpWgsl } from './mlpWgsl.js';

// Feature expressions, keyed by the names used in tools/neural/experiments.py.
const FEATURE_WGSL = {
    sun0: 'g.sun[0]', sun1: 'g.sun[1]', sun2: 'g.sun[2]', sun3: 'g.sun[3]', sun4: 'g.sun[4]', sun5: 'g.sun[5]',
    skyA: 'g.sky[0]', skyB: 'g.sky[1]', side0: 'g.sky[2]', side1: 'g.sky[3]', side2: 'g.sky[4]',
    density: 'g.density', baseDensity: 'g.base.density', localH: 'g.base.localH', h: 'g.base.h',
    stratiform: 'g.base.stratiform', coverage: 'g.weather.coverage', kind: 'g.weather.kind',
    cosTheta: 'cosTheta', muSun: 'muSun', rdUp: 'rdUp', od: 'g.od', tauView: 'log(1.0 + min(tauHere, 20.0))',
};
const EXTRA = ['mip0', 'mip1', 'mip2', 'sunMip0', 'sunMip1', 'sunMip2',
    'cone0a', 'cone0b', 'cone0c', 'cone0d', 'cone1a', 'cone1b', 'cone1c', 'cone1d', 'down', 'upFar'];
EXTRA.forEach((name, i) => { FEATURE_WGSL[name] = `ex[${i}]`; });
// Map features, transformed as in tools/neural/experiments.py features().
Object.assign(FEATURE_WGSL, { farOd: 'exp(-ex[16])', nearOd: 'exp(-ex[17])', upOd: 'log(1.0 + ex[18])', farOdLog: 'log(1.0 + ex[16])' });
EXTRA.push('farOd', 'nearOd', 'upOd');

// Same descriptor as TEACHER_EXTRA_WGSL.
const DESCRIPTOR_WGSL = /* wgsl */`
fn filteredDensity(p: vec3f, fp: f32, w: Weather) -> f32 {
    let r = length(p);
    return cloudBaseWithWeather(p, heightFraction(r), w, fp).density + altoDensity(p, r, w, fp);
}
fn coarseOdR(p: vec3f, d: vec3f, t0: f32) -> f32 {
    let tEnd = shellExit(p, d);
    var od = 0.0;
    var t = t0;
    for (var i = 0; i < 400; i++) {
        if (t >= tEnd) { break; }
        let dt = min(0.2, tEnd - t);
        let q = p + d * (t + 0.5 * dt);
        od += filteredDensity(q, 0.4, sampleWeather(q, 0.4)) * dt;
        t += dt;
    }
    return od * u.density.x;
}
fn descriptor(p: vec3f) -> array<f32, 20> {
    var e: array<f32, 20>;
    let w = sampleWeather(p, 0.15);
    let s = u.sun.xyz;
    let up = normalize(p);
    e[0] = filteredDensity(p, 0.15, w); e[1] = filteredDensity(p, 0.5, w); e[2] = filteredDensity(p, 1.6, w);
    e[3] = filteredDensity(p + s * 0.3, 0.3, w); e[4] = filteredDensity(p + s * 1.0, 0.8, w); e[5] = filteredDensity(p + s * 3.0, 2.0, w);
    let t = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(s.x) > 0.9), s));
    let b = cross(s, t);
    for (var k = 0; k < 4; k++) {
        let ang = f32(k) * 1.5707963;
        let side = (t * cos(ang) + b * sin(ang)) * 0.70;
        e[6 + k] = filteredDensity(p + (s + side) * 0.4, 0.25, w);
        e[10 + k] = filteredDensity(p + (s + side) * 1.2, 0.6, w);
    }
    e[14] = filteredDensity(p - up * 0.3, 0.2, w);
    e[15] = filteredDensity(p + up * 2.0, 1.0, w);
    e[16] = coarseOdR(p, s, 2.4);
    e[18] = coarseOdR(p, up, 0.0);
    return e;
}
`;

const featureArray = (names) => `array<f32, ${names.length}>(${names.map(n => {
    if (!(n in FEATURE_WGSL)) throw new Error(`Unknown feature ${n}`);
    return FEATURE_WGSL[n];
}).join(', ')})`;

/** sunModel.target 'msTarget' renders the hybrid: exact single scattering (probe optical depth x shadow map) + neural MS. */
/** directModel (target 'T'): learned sun transmittance for the hybrid's single scattering, as baked by the game. */
export function renderShader(sunModel, skyModel, directModel = null) {
    const hybrid = sunModel.target === 'msTarget';
    const transmittance = directModel ? `min(directNet(${featureArray(directModel.features)}), 1.0)` : 'exp(-(g.od * u.density.x + ex[16]))';
    const needsDescriptor = true; // the conventional columns use the shadow / column maps too
    return /* wgsl */`${TEACHER_HEADER}
${needsDescriptor ? DESCRIPTOR_WGSL : ''}
struct RenderParams {
    sunFit: vec4f,   // a, b, c, gain
    sunFit2: vec4f,  // powder, game sky scale, game sky offset, -
    skyFitA: vec4f,  // wa, wb, wl, k
    skyFitB: vec4f,  // floor, scale, offset, -
}
@group(0) @binding(6) var<uniform> R: RenderParams;
@group(0) @binding(7) var<storage, read_write> outImg: array<array<f32, 16>>;

${mlpWgsl('sunNet', sunModel)}
${mlpWgsl('skyNet', skyModel)}
${directModel ? mlpWgsl('directNet', directModel) : ''}
// Learned sun and sky source at one point, as the runtime shades its single point per ray.
fn shadeNn(p: vec3f, rd: vec3f) -> vec2f {
    let g = gameInputs(p, P.march.w);
    let ex = descriptor(p);
    let up = normalize(p);
    let cosTheta = dot(rd, u.sun.xyz);
    let muSun = dot(up, u.sun.xyz);
    let rdUp = dot(rd, up);
    let tauHere = 0.0;
    let albedo = u.density.w;
    let sun = sunNet(${featureArray(sunModel.features)})${hybrid ? ` + albedo * cloudPhaseExact(cosTheta) * ${transmittance}` : ''};
    return vec2f(sun, skyNet(${featureArray(skyModel.features)}));
}

fn octavesWith(od: f32, cosTheta: f32, ea: f32, eb: f32, ec: f32) -> f32 {
    let odx = od * u.density.x;
    var a = 1.0; var b = 1.0; var c = 1.0; var ms = 0.0;
    for (var k = 0; k < 4; k++) {
        ms += b * mix(henyeyGreenstein(cosTheta, u.phase.x * c), henyeyGreenstein(cosTheta, u.phase.y * c), u.phase.z) * exp(-odx * a);
        a *= ea; b *= eb; c *= ec;
    }
    return ms;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2u(P.view.xy);
    let py = id.y + P.info.w;
    if (id.x >= size.x || py >= size.y) { return; }
    let index = py * size.x + id.x;
    var acc = outImg[index];
    let ro = u.camPos.xyz;
    for (var n = 0u; n < P.info.y; n++) {
        seedRng(index, P.info.x, 3u + n * 977u);
        let pix = vec2f(f32(id.x), f32(py)) + vec2f(rand(), rand());
        let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
        acc[7] += 1.0;
        let outer = raySphere(ro, rd, u.planet.z);
        if (outer.x > outer.y || outer.y <= 0.0) { acc[6] += 1.0; continue; }
        var t0 = max(outer.x, 0.0);
        var t1 = outer.y;
        let ground = raySphere(ro, rd, u.planet.x);
        if (ground.x < ground.y && ground.x > 0.0) { t1 = min(t1, ground.x); }
        let inner = raySphere(ro, rd, shellBottom());
        if (length(ro) < shellBottom() && inner.y > 0.0) { t0 = max(t0, inner.y); }
        var T = 1.0;
        var tau = 0.0;
        var moment = 0.0;
        var frontMoment = 0.0;
        var frontOpacity = 0.0;
        var quarterMoment = vec4f(0.0);
        var quarterOpacity = vec4f(0.0);
        var t = t0;
        var empty = 1000;
        var sPrev = 1.0e3;
        for (var i = 0; i < 6000; i++) {
            if (t >= t1 || T < 1.0e-3) { break; }
            if (empty >= i32(P.extra.x)) {
                let dt = min(airStep(t - t0), t1 - t);
                let sc = sigmaAt(ro + rd * (t + 0.5 * dt));
                if (sc <= 0.0) { t += dt; continue; }
                empty = 0;
                sPrev = sc;
            }
            let dt = min(fineStep(sPrev), t1 - t);
            let tm = t + (0.25 + 0.5 * rand()) * dt;
            let p = ro + rd * tm;
            let s = sigmaAt(p);
            sPrev = s;
            if (s > 0.0) { empty = 0; } else { empty++; }
            if (s > 0.0) {
                let a = 1.0 - exp(-s * dt);
                let tauHere = tau + s * (tm - t);
                let g = gameInputs(p, P.march.w);
                ${needsDescriptor ? 'let ex = descriptor(p);' : ''}
                let up = normalize(p);
                let cosTheta = dot(rd, u.sun.xyz);
                let muSun = dot(up, u.sun.xyz);
                let rdUp = dot(rd, up);
                let powderW = saturate(0.6 - 0.6 * cosTheta);
                let powderGame = mix(1.0, 1.0 - exp(-g.density * u.density.x * 0.12), u.phase.w * powderW);
                let powderFit = mix(1.0, 1.0 - exp(-g.density * u.density.x * 0.12), R.sunFit2.x * powderW);
                let inScatter = gameInScatter(g.base.localH, g.density, g.weather.coverage);
                let gain = 1.0 + (u.look5.w - 1.0) * smoothstep(-0.1, 0.35, muSun) * (1.0 - 0.55 * smoothstep(0.7, 0.98, cosTheta));
                let albedo = u.density.w;
                let sunGame = albedo * gain * gameOctaves(g.od, cosTheta) * powderGame * inScatter;
                let sunFit = albedo * R.sunFit.w * octavesWith(g.od, cosTheta, R.sunFit.x, R.sunFit.y, R.sunFit.z) * powderFit * inScatter
                    * select(1.0, exp(-ex[16]), R.sunFit2.w > 0.5);
                let sunNn = sunNet(${featureArray(sunModel.features)})${sunModel.shadowPrior ? ` * exp(-${Number(sunModel.shadowPrior).toFixed(3)} * min(ex[16], 60.0))` : ''}${hybrid ? ` + albedo * cloudPhaseExact(cosTheta) * ${transmittance}` : ''};
                let skyGame = max(R.sunFit2.y * g.skyVis + R.sunFit2.z, 0.0);
                let skyOd = (R.skyFitA.x * g.sky[0] + R.skyFitA.y * g.sky[1] + R.skyFitA.z * (g.sky[2] + g.sky[3] + g.sky[4])) * u.density.x
                    + R.skyFitB.w * ex[18];
                let skyFit = max(R.skyFitB.y * mix(R.skyFitB.x, 1.0, exp(-skyOd * R.skyFitA.w)) + R.skyFitB.z, 0.0);
                let skyNn = skyNet(${featureArray(skyModel.features)});
                let w = T * a;
                acc[0] += w * sunGame; acc[1] += w * sunFit; acc[2] += w * sunNn;
                acc[3] += w * skyGame; acc[4] += w * skyFit; acc[5] += w * skyNn;
                moment += w * tm;
                if (T > 0.5) { frontMoment += w * tm; frontOpacity += w; }
                let quarter = select(select(select(3, 2, T > 0.25), 1, T > 0.5), 0, T > 0.75);
                quarterMoment[quarter] += w * tm;
                quarterOpacity[quarter] += w;
                T *= 1.0 - a;
            }
            tau += s * dt;
            t += dt;
        }
        acc[6] += T;
        // Runtime structure: one shading point at the opacity centroid (8, 9), or two points,
        // at the centroids of the first and second half of the opacity (10, 11).
        let opacity = 1.0 - T;
        if (opacity > 1.0e-4) {
            let one = shadeNn(ro + rd * (moment / opacity), rd) * opacity;
            acc[8] += one.x; acc[9] += one.y;
            let backOpacity = opacity - frontOpacity;
            var two = vec2f(0.0);
            if (frontOpacity > 1.0e-4) { two += shadeNn(ro + rd * (frontMoment / frontOpacity), rd) * frontOpacity; }
            if (backOpacity > 1.0e-4) { two += shadeNn(ro + rd * ((moment - frontMoment) / backOpacity), rd) * backOpacity; }
            acc[10] += two.x; acc[11] += two.y;
            // Four points: centroids of each quarter of the ray's opacity (12, 13).
            for (var k = 0; k < 4; k++) {
                if (quarterOpacity[k] > 1.0e-4) {
                    let four = shadeNn(ro + rd * (quarterMoment[k] / quarterOpacity[k]), rd) * quarterOpacity[k];
                    acc[12] += four.x; acc[13] += four.y;
                }
            }
        }
    }
    outImg[index] = acc;
}
`;
}
