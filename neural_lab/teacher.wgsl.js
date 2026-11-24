// Neural cloud lab: a volumetric path-tracing teacher over the game's exact cloud density field,
// plus the per-sample features the game's raymarcher already computes. Everything here imports the
// engine's density WGSL read-only; nothing in core/ is modified.
//
// Units: kilometres, planet-centred positions, sun irradiance 1 (white). Radiance values are
// "per unit extinction" source terms S = albedo * integral(phase * L_in), the quantity the game's
// marcher multiplies by (1 - exp(-sigma dt)) * T. The game's own analytic sun term is recorded
// alongside so the two can be compared on identical points.
import { CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_DENSITY_WGSL } from '../core/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js';

export const RECORD_FLOATS = 48;
// Record layout (keep in sync with tools/neural/dataset.py).
export const RECORD_FIELDS = [
    'px', 'py', 'pz', 'weight', 'dx', 'dy', 'dz', 'pixel',
    'sun0', 'sun1', 'sun2', 'sun3', 'sun4', 'sun5',          // game sun-probe densities (6)
    'skyA', 'skyB', 'side0', 'side1', 'side2',               // game sky-probe densities (5)
    'density', 'baseDensity', 'localH', 'h', 'stratiform', 'coverage', 'kind',
    'cosTheta', 'muSun', 'rdUp', 'od',                       // od: game probe optical depth (km-weighted density)
    'gameMs', 'gamePowder', 'gameInScatter', 'gameSkyVis',   // game analytic pieces (sun octave sum, powder mix, HZD probability, sky visibility)
    'single', 'msSum', 'msSq', 'skySum', 'skySq', 'tauView', 'tEntry', 'paths', 'truncated', 'bounces',
    'extinction', 'albedo', 'spare46', 'spare47',
];
if (RECORD_FIELDS.length !== RECORD_FLOATS) throw new Error('RECORD_FIELDS out of sync');

export const TEACHER_HEADER = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;

struct TeacherParams {
    info: vec4u,    // x seed, y paths this dispatch, z max bounces, w item offset
    march: vec4f,   // x fine step (km), y base air step (km), z air step growth per km, w filter footprint (km)
    view: vec4f,    // x width, y height, z max optical depth for NEE, w sky radiance
    extra: vec4f,   // x max fine-mode empty steps, y max steps per march, z, w
}
@group(0) @binding(5) var<uniform> P: TeacherParams;
${CLOUD_DENSITY_WGSL}

// ---------------------------------------------------------------- random numbers
var<private> rngState: u32;
fn pcgNext() -> u32 {
    rngState = rngState * 747796405u + 2891336453u;
    let w = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
    return (w >> 22u) ^ w;
}
fn rand() -> f32 { return f32(pcgNext() >> 8u) * (1.0 / 16777216.0); }
fn seedRng(a: u32, b: u32, c: u32) {
    rngState = a * 9781u + b * 6271u + c * 26699u + 1u;
    _ = pcgNext(); _ = pcgNext();
}

// ---------------------------------------------------------------- medium
fn sigmaAt(p: vec3f) -> f32 {
    return cloudDensity(p, P.march.w, true) * u.density.x;
}

fn shellBottom() -> f32 {
    return select(u.planet.y, min(u.planet.y, u.lowCloud.x), u.weatherStyle.w > 0.001);
}

// Distance along d to leave the cloud shell (top, or bottom going down), or to the ground.
fn shellExit(o: vec3f, d: vec3f) -> f32 {
    let outer = raySphere(o, d, u.planet.z);
    var t = max(outer.y, 0.0);
    let inner = raySphere(o, d, shellBottom());
    if (inner.x < inner.y && inner.x > 0.0) { t = min(t, inner.x); }
    return t;
}

// True when the ray leaves through the top of the shell (sees the sky).
fn exitsTop(o: vec3f, d: vec3f) -> bool {
    let inner = raySphere(o, d, shellBottom());
    return !(inner.x < inner.y && inner.x > 0.0);
}

fn airStep(t: f32) -> f32 { return P.march.y + P.march.z * t; }

// Fine steps hold optical thickness near 0.3 in thin cloud (decks), never coarser than 4x the base step.
fn fineStep(sigmaPrev: f32) -> f32 {
    return clamp(0.3 / max(sigmaPrev, 1.0e-3), P.march.x, P.extra.z * P.march.x);
}

// Two-mode tracking: coarse steps through clear air, fine midpoint steps once density appears.
// Returns the collision distance for optical depth "target", or -1 when the ray leaves first.
fn freeFlight(o: vec3f, d: vec3f, tMax: f32, goal: f32) -> f32 {
    var t = 0.0;
    var tau = 0.0;
    var empty = 1000;
    var sPrev = 1.0e3;
    let maxSteps = i32(P.extra.y);
    for (var i = 0; i < maxSteps; i++) {
        if (t >= tMax) { return -1.0; }
        if (empty >= i32(P.extra.x)) {
            let dt = min(airStep(t), tMax - t);
            let s = sigmaAt(o + d * (t + 0.5 * dt));
            if (s <= 0.0) { t += dt; continue; }
            empty = 0;
            sPrev = s;
        }
        let dt = min(fineStep(sPrev), tMax - t);
        let s = sigmaAt(o + d * (t + (0.25 + 0.5 * rand()) * dt));
        sPrev = s;
        if (s > 0.0) { empty = 0; } else { empty++; }
        let dtau = s * dt;
        if (tau + dtau >= goal) { return t + (goal - tau) / max(s, 1.0e-6); }
        tau += dtau;
        t += dt;
    }
    return -1.0;
}

fn opticalDepth(o: vec3f, d: vec3f, tMax: f32) -> f32 {
    var t = 0.0;
    var tau = 0.0;
    var empty = 1000;
    var sPrev = 1.0e3;
    let maxSteps = i32(P.extra.y);
    for (var i = 0; i < maxSteps; i++) {
        if (t >= tMax || tau > P.view.z) { break; }
        if (empty >= i32(P.extra.x)) {
            let dt = min(airStep(t), tMax - t);
            let s = sigmaAt(o + d * (t + 0.5 * dt));
            if (s <= 0.0) { t += dt; continue; }
            empty = 0;
            sPrev = s;
        }
        let dt = min(fineStep(sPrev), tMax - t);
        let s = sigmaAt(o + d * (t + (0.25 + 0.5 * rand()) * dt));
        sPrev = s;
        if (s > 0.0) { empty = 0; } else { empty++; }
        tau += s * dt;
        t += dt;
    }
    return tau;
}

fn sunTransmittance(p: vec3f) -> f32 {
    return exp(-opticalDepth(p, u.sun.xyz, shellExit(p, u.sun.xyz)));
}

// ---------------------------------------------------------------- phase function (the game's)
fn cloudPhaseExact(cosTheta: f32) -> f32 {
    return mix(henyeyGreenstein(cosTheta, u.phase.x), henyeyGreenstein(cosTheta, u.phase.y), u.phase.z);
}

fn sampleHgCos(g: f32, xi: f32) -> f32 {
    if (abs(g) < 1.0e-3) { return 1.0 - 2.0 * xi; }
    let s = (1.0 - g * g) / (1.0 - g + 2.0 * g * xi);
    return clamp((1.0 + g * g - s * s) / (2.0 * g), -1.0, 1.0);
}

fn basisAround(n: vec3f, cosT: f32, phi: f32) -> vec3f {
    let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
    let t = normalize(cross(a, n));
    let b = cross(n, t);
    let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    return normalize(n * cosT + (t * cos(phi) + b * sin(phi)) * sinT);
}

// Direction towards the incoming light, distributed as the phase function around axis d.
fn samplePhase(d: vec3f) -> vec3f {
    let g = select(u.phase.x, u.phase.y, rand() < u.phase.z);
    return basisAround(d, sampleHgCos(g, rand()), 2.0 * PI * rand());
}

// ---------------------------------------------------------------- paths
struct PathResult {
    sun: f32,       // sum over scattering vertices after the first of albedo^j * phase * T_sun
    sky: f32,       // sky radiance reaching the start point through any number of scatterings
    bounces: f32,
    truncated: f32,
}

// Light arriving at x from all directions, scattered toward -rd. The x vertex itself is excluded
// (the caller adds single scattering), so the result is the multiple-scattering part.
fn tracePath(x: vec3f, rd: vec3f) -> PathResult {
    var r = PathResult(0.0, 0.0, 0.0, 0.0);
    var pos = x;
    var axis = rd;
    var w = 1.0;
    let maxBounces = i32(P.info.z);
    for (var b = 0; b < maxBounces; b++) {
        let dir = samplePhase(axis);
        let tMax = shellExit(pos, dir);
        let t = freeFlight(pos, dir, tMax, -log(max(1.0 - rand(), 1.0e-7)));
        if (t < 0.0) {
            if (exitsTop(pos, dir)) { r.sky += w * P.view.w; }
            r.bounces = f32(b);
            return r;
        }
        pos += dir * t;
        w *= u.density.w;
        r.sun += w * cloudPhaseExact(dot(u.sun.xyz, dir)) * sunTransmittance(pos);
        axis = dir;
        // Russian roulette once the path weight is small.
        if (w < 0.25) {
            if (rand() > 0.75) { r.bounces = f32(b + 1); return r; }
            w /= 0.75;
        }
    }
    r.bounces = f32(maxBounces);
    r.truncated = 1.0;
    return r;
}

// ---------------------------------------------------------------- the game's per-sample inputs
struct GameInputs {
    sun: array<f32, 6>,
    sky: array<f32, 5>,
    od: f32,
    skyVis: f32,
    base: CloudBase,
    weather: Weather,
    density: f32,
}

fn gameInputs(p: vec3f, footprint: f32) -> GameInputs {
    var g: GameInputs;
    let r = length(p);
    g.weather = sampleWeather(p, footprint);
    g.base = cloudBaseWithWeather(p, heightFraction(r), g.weather, footprint);
    g.density = 0.0;
    if (g.base.density > 0.0) { g.density = cloudDetail(p, g.base, footprint); }
    g.density += altoDensity(p, r, g.weather, footprint);
    // probeLightFromStep(p, footprint, weather, sun, 0, lightSteps, 1, u.march2.x)
    var stepLen = u.march2.x;
    var t = 0.0;
    g.od = 0.0;
    for (var i = 0; i < 6; i++) {
        var d = 0.0;
        if (i < i32(u.quality.w)) {
            let lp = p + u.sun.xyz * (t + stepLen * 0.5);
            let fp = max(footprint, stepLen * 0.5);
            let lr = length(lp);
            let b = cloudBaseWithWeather(lp, heightFraction(lr), g.weather, fp);
            d = b.density;
            if (i < 2 && d > 0.0) { d = cloudDetail(lp, b, fp); }
            d += altoDensity(lp, lr, g.weather, fp);
            g.od += d * stepLen;
        }
        g.sun[i] = d;
        t += stepLen;
        stepLen *= 2.0;
    }
    // probeSkyVisibility(p, weather, footprint)
    let up = p / r;
    let a = p + up * 0.25;
    let bb = p + up * 0.8;
    g.sky[0] = cloudBaseWithWeather(a, heightFraction(length(a)), g.weather, max(footprint, 0.125)).density;
    g.sky[1] = cloudBaseWithWeather(bb, heightFraction(length(bb)), g.weather, max(footprint, 0.4)).density;
    let east = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9), up));
    let north = cross(up, east);
    var dl = 0.0;
    for (var k = 0; k < 3; k++) {
        let ang = f32(k) * 2.0943951;
        let q = p + (east * cos(ang) * 0.87 + north * sin(ang) * 0.87 + up * 0.5) * 0.35;
        g.sky[2 + k] = cloudBaseWithWeather(q, heightFraction(length(q)), g.weather, max(footprint, 0.15)).density;
        dl += g.sky[2 + k];
    }
    let skyOd = (g.sky[0] * 0.4 + g.sky[1] * 0.6 + dl * 0.45 * u.look.y) * u.density.x;
    g.skyVis = mix(select(0.25, 0.15, u.look.y > 0.0), 1.0, exp(-skyOd * 0.35));
    return g;
}

// Octave sum exactly as directLight() computes it (without the light colour).
fn gameOctaves(od: f32, cosTheta: f32) -> f32 {
    let odx = od * u.density.x;
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    var ms = 0.0;
    for (var k = 0; k < 4; k++) {
        ms += b * mix(henyeyGreenstein(cosTheta, u.phase.x * c), henyeyGreenstein(cosTheta, u.phase.y * c), u.phase.z) * exp(-odx * a);
        a *= u.light.y;
        b *= u.light.z;
        c *= u.light.w;
    }
    return ms;
}

fn gameInScatter(localH: f32, density: f32, coverage: f32) -> f32 {
    if (u.look.x <= 0.0) { return 1.0; }
    let d = density / mix(0.6, 1.0, coverage);
    let depthP = 0.05 + pow(saturate(d), remapSat(localH, 0.3, 0.85, 0.5, 2.0));
    let vertP = pow(remapSat(localH, 0.07, 0.14, 0.1, 1.0), 0.8);
    return mix(1.0, depthP * vertP * u.look.z, u.look.x);
}
`;

// One query per pixel of a view: march the camera ray and pick one point with probability
// proportional to its contribution T * (1 - exp(-sigma dt)). weight = 1 - T_end (ray opacity).
export const TEACHER_QUERY_WGSL = /* wgsl */`${TEACHER_HEADER}
struct Query { point: vec4f, dir: vec4f, extra: vec4f }
@group(0) @binding(6) var<storage, read_write> queries: array<Query>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2u(P.view.xy);
    let py = id.y + P.info.w;
    if (id.x >= size.x || py >= size.y) { return; }
    let index = py * size.x + id.x;
    seedRng(index, P.info.x, 17u);
    let pix = vec2f(f32(id.x), f32(py)) + vec2f(rand(), rand());
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let ro = u.camPos.xyz;
    var out = Query(vec4f(0.0), vec4f(rd, f32(index)), vec4f(0.0));
    var tau = 0.0;
    var tFirst = -1.0;
    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { queries[index] = out; return; }
    var t0 = max(outer.x, 0.0);
    var t1 = outer.y;
    let ground = raySphere(ro, rd, u.planet.x);
    if (ground.x < ground.y && ground.x > 0.0) { t1 = min(t1, ground.x); }
    let inner = raySphere(ro, rd, shellBottom());
    // Camera below the shell: start where the ray enters it.
    if (length(ro) < shellBottom() && inner.y > 0.0) { t0 = max(t0, inner.y); }
    var T = 1.0;
    var total = 0.0;
    var t = t0;
    var empty = 1000;
    for (var i = 0; i < 4096; i++) {
        if (t >= t1 || T < 1.0e-3) { break; }
        if (empty >= i32(P.extra.x)) {
            let dt = min(airStep(t - t0), t1 - t);
            if (sigmaAt(ro + rd * (t + 0.5 * dt)) <= 0.0) { t += dt; continue; }
            empty = 0;
        }
        let dt = min(P.march.x, t1 - t);
        let tm = t + (0.25 + 0.5 * rand()) * dt;
        let s = sigmaAt(ro + rd * tm);
        if (s > 0.0) { empty = 0; } else { empty++; }
        let a = 1.0 - exp(-s * dt);
        let w = T * a;
        if (w > 0.0) {
            if (tFirst < 0.0) { tFirst = tm; }
            total += w;
            if (rand() * total < w) {
                out.point = vec4f(ro + rd * tm, 0.0);
                // View-ray optical depth since the camera (what a marcher's T already encodes).
                out.extra = vec4f(tau + s * (tm - t), tm - tFirst, 0.0, 0.0);
            }
        }
        tau += s * dt;
        T *= 1.0 - a;
        t += dt;
    }
    out.point.w = total;
    queries[index] = out;
}
`;

// Path-trace the queries (accumulating over dispatches) and record the game's features once.
export const TEACHER_LABEL_WGSL = /* wgsl */`${TEACHER_HEADER}
struct Query { point: vec4f, dir: vec4f, extra: vec4f }
@group(0) @binding(6) var<storage, read> queries: array<Query>;
@group(0) @binding(7) var<storage, read_write> records: array<array<f32, ${RECORD_FLOATS}>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x + P.info.w;
    if (i >= arrayLength(&queries)) { return; }
    let q = queries[i];
    if (q.point.w <= 1.0e-4) { return; }
    let x = q.point.xyz;
    let rd = q.dir.xyz;
    var rec = records[i];
    seedRng(i, P.info.x, 91u);
    if (rec[41] == 0.0) {
        // First visit: features, the game's analytic terms and exact single scattering.
        let g = gameInputs(x, P.march.w);
        let up = normalize(x);
        rec[0] = x.x; rec[1] = x.y; rec[2] = x.z; rec[3] = q.point.w;
        rec[4] = rd.x; rec[5] = rd.y; rec[6] = rd.z; rec[7] = q.dir.w;
        for (var k = 0; k < 6; k++) { rec[8 + k] = g.sun[k]; }
        for (var k = 0; k < 5; k++) { rec[14 + k] = g.sky[k]; }
        let cosTheta = dot(rd, u.sun.xyz);
        rec[19] = g.density; rec[20] = g.base.density; rec[21] = g.base.localH; rec[22] = g.base.h;
        rec[23] = g.base.stratiform; rec[24] = g.weather.coverage; rec[25] = g.weather.kind;
        rec[26] = cosTheta; rec[27] = dot(up, u.sun.xyz); rec[28] = dot(rd, up); rec[29] = g.od;
        rec[30] = gameOctaves(g.od, cosTheta);
        let powderWeight = u.phase.w * saturate(0.6 - 0.6 * cosTheta);
        rec[31] = mix(1.0, 1.0 - exp(-g.density * u.density.x * 0.12), powderWeight);
        rec[32] = gameInScatter(g.base.localH, g.density, g.weather.coverage);
        rec[33] = g.skyVis;
        var single = 0.0;
        for (var k = 0; k < 4; k++) { single += sunTransmittance(x); }
        rec[34] = 0.25 * single * cloudPhaseExact(cosTheta);
        rec[39] = q.extra.x; rec[40] = q.extra.y;
        rec[44] = u.density.x; rec[45] = u.density.w;
    }
    let paths = i32(P.info.y);
    for (var n = 0; n < paths; n++) {
        let r = tracePath(x, rd);
        rec[35] += r.sun; rec[36] += r.sun * r.sun;
        rec[37] += r.sky; rec[38] += r.sky * r.sky;
        rec[42] += r.truncated; rec[43] += r.bounces;
    }
    rec[41] += f32(paths);
    records[i] = rec;
}
`;

// Reference image: sun-lit and sky-lit radiance by path tracing from the camera, accumulated.
// out[pixel] = (sun sum, sky sum, transmittance sum, samples)
export const TEACHER_IMAGE_WGSL = /* wgsl */`${TEACHER_HEADER}
@group(0) @binding(6) var<storage, read_write> accum: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2u(P.view.xy);
    let py = id.y + P.info.w;
    if (id.x >= size.x || py >= size.y) { return; }
    let index = py * size.x + id.x;
    var acc = accum[index];
    let ro = u.camPos.xyz;
    for (var n = 0u; n < P.info.y; n++) {
        seedRng(index, P.info.x, 7u + n * 131u);
        let pix = vec2f(f32(id.x), f32(py)) + vec2f(rand(), rand());
        let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
        let outer = raySphere(ro, rd, u.planet.z);
        acc.w += 1.0;
        if (outer.x > outer.y || outer.y <= 0.0) { acc.z += 1.0; continue; }
        var t0 = max(outer.x, 0.0);
        var t1 = outer.y;
        let ground = raySphere(ro, rd, u.planet.x);
        let hitsGround = ground.x < ground.y && ground.x > 0.0;
        if (hitsGround) { t1 = min(t1, ground.x); }
        let inner = raySphere(ro, rd, shellBottom());
        if (length(ro) < shellBottom() && inner.y > 0.0) { t0 = max(t0, inner.y); }
        if (t1 <= t0) { acc.z += 1.0; continue; }
        let start = ro + rd * t0;
        let t = freeFlight(start, rd, t1 - t0, -log(max(1.0 - rand(), 1.0e-7)));
        if (t < 0.0) { acc.z += 1.0; continue; }
        let x = start + rd * t;
        // Collision: single scattering at x plus the rest of the path.
        let single = cloudPhaseExact(dot(rd, u.sun.xyz)) * sunTransmittance(x);
        let r = tracePath(x, rd);
        acc.x += u.density.w * (single + r.sun);
        acc.y += u.density.w * r.sky;
    }
    accum[index] = acc;
}
`;

// Extra descriptor features for existing records (no path tracing). A cheap stand-in for Deep
// Scattering's hierarchical density stencil: mip-filtered base density (neighbourhood averages at
// growing footprints) around the point and along a cone towards the sun, plus a downward probe.
export const EXTRA_FIELDS = [
    'mip0', 'mip1', 'mip2',                                  // base density at p, footprints 0.15, 0.5, 1.6 km
    'sunMip0', 'sunMip1', 'sunMip2',                         // filtered density 0.3, 1.0, 3.0 km toward the sun
    'cone0a', 'cone0b', 'cone0c', 'cone0d',                  // 0.4 km out, 35 deg around the sun direction
    'cone1a', 'cone1b', 'cone1c', 'cone1d',                  // 1.2 km out
    'down', 'upFar',                                         // 0.3 km below, 2 km above (filtered)
    'farOd', 'nearOd', 'upOd', 'spareX',                     // coarse sun optical depth beyond / within the probe reach (shadow-map proxy), column above
];
export const TEACHER_EXTRA_WGSL = /* wgsl */`${TEACHER_HEADER}
@group(0) @binding(6) var<storage, read> records: array<array<f32, ${RECORD_FLOATS}>>;
@group(0) @binding(7) var<storage, read_write> extra: array<array<f32, 20>>;

fn filtered(p: vec3f, fp: f32, w: Weather) -> f32 {
    let r = length(p);
    return cloudBaseWithWeather(p, heightFraction(r), w, fp).density + altoDensity(p, r, w, fp);
}

// What a shadow-map / column-map lookup provides: coarse optical depth (filtered base density,
// live weather) along d from distance t0 to the shell exit, in units of extinction.
fn coarseOd(p: vec3f, d: vec3f, t0: f32) -> f32 {
    let tEnd = shellExit(p, d);
    var od = 0.0;
    var t = t0;
    for (var i = 0; i < 400; i++) {
        if (t >= tEnd) { break; }
        let dt = min(0.2, tEnd - t);
        let q = p + d * (t + 0.5 * dt);
        od += filtered(q, 0.4, sampleWeather(q, 0.4)) * dt;
        t += dt;
    }
    return od * u.density.x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= arrayLength(&records)) { return; }
    let rec = records[i];
    _ = detailTex;
    _ = P.info.x;
    var e: array<f32, 20>;
    if (rec[41] > 0.0) {
        let p = vec3f(rec[0], rec[1], rec[2]);
        let w = sampleWeather(p, 0.15);
        let s = u.sun.xyz;
        let up = normalize(p);
        e[0] = filtered(p, 0.15, w); e[1] = filtered(p, 0.5, w); e[2] = filtered(p, 1.6, w);
        e[3] = filtered(p + s * 0.3, 0.3, w); e[4] = filtered(p + s * 1.0, 0.8, w); e[5] = filtered(p + s * 3.0, 2.0, w);
        let t = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(s.x) > 0.9), s));
        let b = cross(s, t);
        let spread = 0.70; // tan(35 deg)
        for (var k = 0; k < 4; k++) {
            let ang = f32(k) * 1.5707963;
            let side = (t * cos(ang) + b * sin(ang)) * spread;
            e[6 + k] = filtered(p + (s + side) * 0.4, 0.25, w);
            e[10 + k] = filtered(p + (s + side) * 1.2, 0.6, w);
        }
        e[14] = filtered(p - up * 0.3, 0.2, w);
        e[15] = filtered(p + up * 2.0, 1.0, w);
        e[16] = coarseOd(p, s, 2.4);
        e[17] = coarseOd(p, s, 0.0) - e[16];
        e[18] = coarseOd(p, up, 0.0);
    }
    extra[i] = e;
}
`;
