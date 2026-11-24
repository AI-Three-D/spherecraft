import { CLOUD_DENSITY_WGSL, CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL } from '../shaders/cloudCommon.wgsl.js';
import { CLOUD_LIGHT_PROBES } from '../shaders/cloudCaches.wgsl.js';
import { SOLAR_FEATURES, SOLAR_PACKED_ROWS, SOLAR_PACKED_VEC4S, SOLAR_SIZES, SOLAR_TARGET_SCALE } from './solarModel.js';

// The lab learns one local transport segment, matching the default six-probe horizon.
export const SOLAR_DENSITY_WGSL = /* wgsl */`
const SOLAR_PATH_KM: f32 = 3.15;

fn solarBaseDensity(p: vec3f, weather: Weather, footprint: f32) -> f32 {
    let r = length(p);
    return cloudBaseWithWeather(p, heightFraction(r), weather, footprint).density + altoDensity(p, r, weather, footprint);
}

fn solarDetailedDensity(p: vec3f, weather: Weather, footprint: f32) -> f32 {
    let r = length(p);
    let base = cloudBaseWithWeather(p, heightFraction(r), weather, footprint);
    var density = 0.0;
    if (base.density > 0.0) { density = cloudDetail(p, base, footprint); }
    return density + altoDensity(p, r, weather, footprint);
}

fn solarFeatures(p: vec3f, footprint: f32, weather: Weather, dir: vec3f) -> array<f32, ${SOLAR_FEATURES}> {
    return array<f32, ${SOLAR_FEATURES}>(
        solarDetailedDensity(p + dir * 0.05, weather, max(footprint, 0.025)),
        solarDetailedDensity(p + dir * 0.24, weather, max(footprint, 0.06)),
        solarBaseDensity(p + dir * 0.80, weather, max(footprint, 0.24)),
        solarBaseDensity(p + dir * 2.10, weather, max(footprint, 0.56)),
        heightFraction(length(p)), dot(normalize(p), dir), weather.coverage, weather.kind
    );
}

fn referenceSolarMass(p: vec3f, footprint: f32, weather: Weather, dir: vec3f, steps: u32) -> f32 {
    let dt = SOLAR_PATH_KM / f32(steps);
    var column = 0.0;
    for (var i = 0u; i < steps; i++) {
        let q = p + dir * ((f32(i) + 0.5) * dt);
        column += solarDetailedDensity(q, weather, footprint);
    }
    return column * dt;
}
`;

export const SOLAR_UNIFORM_WGSL = /* wgsl */`
struct SolarModelUniforms {
    values: array<vec4f, ${SOLAR_PACKED_VEC4S}>,
}
`;

// Emit fixed-offset vec4 loads and dot products. Both the batch evaluator and
// the viewport use this code, with the same row layout as packSolarModel.
function inferenceBody() {
    let source = Array.from({ length: SOLAR_FEATURES / 4 }, (_, i) => `x${i}`);
    const lines = source.map((name, i) => {
        const features = Array.from({ length: 4 }, (_, j) => `features[${i * 4 + j}]`).join(', ');
        return `let ${name} = (vec4f(${features}) - solarWeights.values[${i}]) * solarWeights.values[${i + source.length}];`;
    });
    let offset = SOLAR_FEATURES / 2;
    for (let layer = 0; layer < SOLAR_PACKED_ROWS.length; layer++) {
        const outputs = SOLAR_SIZES[layer + 1];
        const stride = SOLAR_PACKED_ROWS[layer];
        const neurons = Array.from({ length: outputs }, (_, neuron) => {
            const row = offset + neuron * stride;
            const terms = source.map((name, i) => `dot(${name}, solarWeights.values[${row + i}])`);
            terms.push(`solarWeights.values[${row + source.length}].x`);
            return terms.join(' + ');
        });
        if (outputs === 1) {
            lines.push(`let estimate = ${neurons[0]};`);
        } else {
            source = Array.from({ length: outputs / 4 }, (_, i) => {
                const name = `layer${layer}_${i}`;
                const terms = neurons.slice(4 * i, 4 * i + 4).join(', ');
                lines.push(`let ${name} = solarActivation(vec4f(${terms}));`);
                return name;
            });
        }
        offset += outputs * stride;
    }
    return lines.join('\n    ');
}

export const SOLAR_INFERENCE_WGSL = /* wgsl */`
fn solarActivation(x: vec4f) -> vec4f { return x / (vec4f(1.0) + abs(x)); }

fn inferSolarMass(features: array<f32, ${SOLAR_FEATURES}>) -> f32 {
    ${inferenceBody()}
    return (exp(clamp(estimate, 0.0, 5.0)) - 1.0) / ${SOLAR_TARGET_SCALE}.0;
}
`;

export const CLOUD_SOLAR_SAMPLES_WGSL = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;

struct Query {
    point: vec4f, // xyz planet-relative km, w filter footprint
    sun: vec4f, // xyz light direction, w prescribed reference steps
}
struct Record {
    features: array<f32, ${SOLAR_FEATURES}>,
    reference: f32,
    sixProbe: f32,
    localDensity: f32,
    extinction: f32,
}
@group(0) @binding(5) var<storage, read> queries: array<Query>;
@group(0) @binding(6) var<storage, read_write> labels: array<Record>;

${CLOUD_DENSITY_WGSL}${CLOUD_LIGHT_PROBES}${SOLAR_DENSITY_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= arrayLength(&queries)) { return; }
    let query = queries[i];
    let p = query.point.xyz;
    let dir = normalize(query.sun.xyz);
    let footprint = query.point.w;
    let weather = sampleWeather(p, footprint);
    labels[i] = Record(
        solarFeatures(p, footprint, weather, dir),
        referenceSolarMass(p, footprint, weather, dir, u32(query.sun.w)),
        probeLightFromStep(p, footprint, weather, dir, 0, 6, 1.0, SOLAR_PATH_KM / 63.0),
        solarBaseDensity(p, weather, footprint), u.density.x
    );
}
`;

export const CLOUD_SOLAR_INFERENCE_WGSL = /* wgsl */`
${SOLAR_UNIFORM_WGSL}
@group(0) @binding(0) var<uniform> solarWeights: SolarModelUniforms;
@group(0) @binding(1) var<storage, read> features: array<array<f32, ${SOLAR_FEATURES}>>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;
${SOLAR_INFERENCE_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < arrayLength(&features)) { result[id.x] = inferSolarMass(features[id.x]); }
}
`;
