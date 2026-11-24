// Training data for a density closure: what the budget march samples in one interval against the
// true extinction of the same density field over that pixel and interval (fine march, 8 sub-rays).
import { mlpWgsl } from './mlpWgsl.js';
import { TEACHER_HEADER } from './teacher.wgsl.js';
import { CLOUD_VIEW_FIELDS_WGSL, CLOUD_WEATHER_ATLAS_LOOKUP_WGSL } from '../core/renderer/volumetricClouds/shaders/cloudViewFields.wgsl.js';

export const CLOSURE_FIELDS = [
    't', 'width', 'footprint', 'dRt', 'base', 'localH', 'h', 'stratiform',
    'variety', 'coverage', 'kind', 'transmittance', 'dMean', 'dEff', 'alto', 'ray',
];
export const CLOSURE_FLOATS = CLOSURE_FIELDS.length;

// model: optional trained closure (tools/neural/closure_fit.py). Its inputs are named in model.features.
export const closureWgsl = (model = null) => /* wgsl */`${TEACHER_HEADER}
${model ? mlpWgsl('closureNet', model) : ''}
@group(0) @binding(6) var linearSampler: sampler;
@group(0) @binding(7) var weatherField: texture_cube<f32>;
@group(0) @binding(8) var weatherShift: texture_cube<f32>;
@group(0) @binding(9) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(10) var<storage, read_write> records: array<array<f32, ${CLOSURE_FLOATS}>>;
@group(0) @binding(11) var<storage, read_write> rays: array<vec4f>;
${CLOUD_VIEW_FIELDS_WGSL}${CLOUD_WEATHER_ATLAS_LOOKUP_WGSL}

fn fineDensity(p: vec3f) -> f32 {
    let r = length(p);
    let w = atlasWeather(p);
    var b = cloudBaseWithWeather(p, heightFraction(r), w, 0.012);
    var d = b.density;
    if (d > 0.0) { d = cloudDetail(p, b, 0.012); }
    return d + altoDensity(p, r, w, 0.012);
}

const SUB = 8;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    _ = textureDimensions(weatherTex);   // keep the binding in the automatic layout
    let size = vec2u(P.view.xy);
    let py = id.y + P.info.w;
    if (id.x >= size.x || py >= size.y) { return; }
    let index = py * size.x + id.x;
    seedRng(index, P.info.x, 77u);
    let ro = u.camPos.xyz;
    let pix = vec2f(f32(id.x), f32(py)) + vec2f(rand(), rand());
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let side = normalize(cross(rd, u.camUp.xyz));
    let lift = cross(side, rd);
    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { rays[index] = vec4f(1.0, 1.0, 0.0, 0.0); return; }
    var t0 = max(outer.x, 0.0);
    var t1 = outer.y;
    let ground = raySphere(ro, rd, u.planet.x);
    if (ground.x < ground.y && ground.x > 0.0) { t1 = min(t1, ground.x); }
    let inner = raySphere(ro, rd, u.planet.y);
    if (length(ro) < u.planet.y && inner.y > 0.0) { t0 = max(t0, inner.y); }
    else if (inner.x < inner.y && inner.x > 0.0) { t1 = min(t1, inner.x); }
    let pitchStops = array<f32, 7>(3.0, 10.0, 22.0, 38.0, 62.0, 90.0, 1.0e6);
    let pitches = array<f32, 7>(0.105, 0.135, 0.185, 0.26, 0.42, 0.80, 1.30);
    let f = abs(rd);
    let axisRate = max(max(f.x, max(f.y, f.z)), 0.40);
    var Trt = 1.0;
    var truth: array<f32, SUB>;
    for (var s = 0; s < SUB; s++) { truth[s] = 1.0; }
    var offsets: array<vec2f, SUB>;
    for (var s = 0; s < SUB; s++) { offsets[s] = (vec2f(rand(), rand()) - 0.5) * u.march2.y; }
    var a = t0;
    for (var n = 0; n < 420; n++) {
        if (a >= t1) { break; }
        var band = 0;
        while (a >= pitchStops[band]) { band++; }
        let width = pitches[band] / axisRate;
        let b = min(min(a + width, t1), pitchStops[band] + 0.001);
        let t = 0.5 * (a + b);
        let p = ro + rd * t;
        let r = length(p);
        let fp = max(t * u.march2.y, 0.06 + 0.012 * t);
        let w = atlasWeather(p);
        var base = cloudBaseWithWeather(p, heightFraction(r), w, fp);
        var d = base.density;
        let alto = altoDensity(p, r, w, fp);
        if (d > 0.0) { d = cloudDetail(p, base, max(fp, t * u.march2.y * u.look3.y)); }
        ${model ? `if (base.density > 0.0) {
            let z = array<f32, ${model.features.length}>(${model.features.map(f => ({
        d: 'd', base: 'base.density', lf: 'log2(fp / 0.06)', localH: 'base.localH', h: 'base.h', stratiform: 'base.stratiform',
        coverage: 'w.coverage', kind: 'w.kind', variety: 'base.variety' })[f]).join(', ')});
            d = min(closureNet(z), 1.0);
        }` : ''}
        d += alto;
        var meanD = 0.0;
        var meanT = 0.0;
        let steps = clamp(i32(ceil((b - a) / 0.03)), 3, 14);
        let dt = (b - a) / f32(steps);
        for (var s = 0; s < SUB; s++) {
            let dir = normalize(rd + side * offsets[s].x + lift * offsets[s].y);
            var sum = 0.0;
            let j = rand();
            for (var k = 0; k < steps; k++) { sum += fineDensity(ro + dir * (a + (f32(k) + j) * dt)); }
            let mean = sum / f32(steps);
            let Ts = exp(-mean * u.density.x * (b - a));
            meanD += mean / f32(SUB);
            meanT += Ts / f32(SUB);
            truth[s] *= Ts;
        }
        if ((d > 0.0 || meanD > 0.0) && Trt > 0.05 && rand() < P.extra.w) {
            let slot = atomicAdd(&counter, 1u);
            if (slot < arrayLength(&records)) {
                let eff = -log(max(meanT, 1.0e-6)) / (u.density.x * (b - a));
                records[slot] = array<f32, ${CLOSURE_FLOATS}>(t, b - a, fp, d, base.density, base.localH, base.h, base.stratiform,
                    base.variety, w.coverage, w.kind, Trt, meanD, eff, alto, f32(index));
            }
        }
        Trt *= exp(-d * u.density.x * (b - a));
        a = b;
        var best = 0.0;
        for (var s = 0; s < SUB; s++) { best = max(best, truth[s]); }
        if (Trt < 0.01 && best < 0.01) { break; }
    }
    var mean = 0.0;
    for (var s = 0; s < SUB; s++) { mean += truth[s] / f32(SUB); }
    rays[index] = vec4f(Trt, mean, t0, t1);
}
`;
