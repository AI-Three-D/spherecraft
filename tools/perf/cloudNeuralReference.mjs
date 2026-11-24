/* global volumetricClouds */

// Runs after timing. Compare the deployed cache, including its interpolation, to
// the same path tracer and the exact-feature networks at contribution-sampled points.
export async function measureNeuralReference(paths) {
    const legacy = volumetricClouds.settings.conventionalColumnLight === false;
    const base = '/core/renderer/volumetricClouds/';
    const [{ TeacherGpu }, { RECORD_FLOATS }, models, common, fields] = await Promise.all([
        import('/neural_lab/teacherGpu.js'),
        import('/neural_lab/teacher.wgsl.js'),
        import(base + 'neural/lightingModels.js'),
        import(base + 'shaders/cloudCommon.wgsl.js'),
        import(base + 'shaders/cloudViewFields.wgsl.js'),
    ]);
    const clouds = volumetricClouds;
    const modelName = Object.hasOwn(models.LIGHTING_MODEL_SETS, clouds.settings.neuralLightingModel)
        ? clouds.settings.neuralLightingModel : models.DEFAULT_LIGHTING_MODEL;
    const set = models.LIGHTING_MODEL_SETS[modelName];
    const cache = clouds._neuralLighting;
    if (!cache?.current) throw new Error('A complete neural light patch is required for the reference comparison');
    const teacher = new TeacherGpu(clouds);
    const snapshot = teacher.snapshot();
    const queries = await teacher.queries(snapshot, 32, 20, 456);
    const { values: records } = await teacher.label(snapshot, queries, paths, 975);
    const extras = await teacher.extra(snapshot.uniforms, records);
    queries.buffer.destroy();

    const code = `
        ${common.CLOUD_UNIFORMS_WGSL}${common.CLOUD_MATH_WGSL}
        @group(0) @binding(0) var<uniform> u: CloudUniforms;
        @group(0) @binding(1) var linearSampler: sampler;
        ${fields.CLOUD_NEURAL_LIGHT_LOOKUP_WGSL.replace(/@binding\((14|15|16)\)/g, (_, value) => '@binding(' + (Number(value) - 12) + ')')}
        @group(0) @binding(5) var<storage, read> records: array<array<f32, ${RECORD_FLOATS}>>;
        @group(0) @binding(6) var<storage, read_write> light: array<array<vec4f, 3>>;
        @group(0) @binding(7) var shapeTex: texture_3d<f32>;
        @group(0) @binding(8) var noiseSampler: sampler;
        @group(0) @binding(9) var shadowMap: texture_2d<f32>;
        @group(0) @binding(10) var weatherField: texture_cube<f32>;
        @group(0) @binding(11) var weatherShift: texture_cube<f32>;
        @group(0) @binding(12) var detailTex: texture_3d<f32>;
        @group(0) @binding(13) var weatherTex: texture_3d<f32>;
        ${common.CLOUD_DENSITY_WGSL}${common.CLOUD_SHADOW_LOOKUP_WGSL}
        ${fields.CLOUD_WEATHER_ATLAS_LOOKUP_WGSL}${fields.CLOUD_CONVENTIONAL_SUN_WGSL}
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3u) {
            if (id.x < arrayLength(&records) && records[id.x][3] > 0.0001) {
                let r = records[id.x];
                let p = vec3f(r[0], r[1], r[2]);
                let mu = r[27];
                let analytic = conventionalLight(p, 0.20, mu);
                let occ = analytic.xy;
                let phase = mix(henyeyGreenstein(r[26], u.phase.x), henyeyGreenstein(r[26], u.phase.y), u.phase.z);
                let legacy = ${legacy ? 'true' : 'false'};
                let bounce = select(analytic.z, conventionalBounce(occ, mu) * u.density.w, legacy);
                let sky = select(analytic.w, mix(0.27, 1.0, exp(-occ.x * 0.15)) * u.density.w, legacy);
                let single = exp(-occ.x) * occ.y * 0.38 * phase * u.density.w;
                let cached = cachedLight(p, length(p));
                let scale = bouncedSunScale(mu, u.weatherStyle.z, cached.z / max(cached.w, 0.001));
                light[id.x] = array<vec4f, 3>(cached, vec4f(bounce, sky, single, phase),
                    vec4f(scale, neuralEdgeBlend(cached.w, r[3]), 0.0, 0.0));
            }
        }
    `;
    const pipeline = await teacher.pipeline(code, 'deployed neural light comparison');
    const uniforms = teacher.uniformBuffer(snapshot.uniforms);
    const labels = teacher.uniformBuffer(records, GPUBufferUsage.STORAGE);
    const out = clouds.device.createBuffer({ size: queries.count * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const primary = cache.current.index;
    await teacher.run(pipeline, [{ buffer: uniforms }, clouds._lutSampler, cache.banks[primary].view,
        cache.banks[1 - primary].view, cache.lookup, { buffer: labels }, { buffer: out },
        clouds._shapeView, clouds._noiseSampler, clouds._shadowView, ...clouds._conventionalWeather.views],
    [Math.ceil(queries.count / 64)]);
    const deployed = await teacher.read(out, queries.count * 48);
    for (const buffer of [out, uniforms, labels]) buffer.destroy();

    const predict = (model, features) => {
        if (Array.isArray(model)) {
            return Math.exp(model.reduce((sum, member) => sum + Math.log(predict(member, features)), 0) / model.length);
        }
        let x = model.mean.map((mean, index) => (features[index] - mean) * model.scale[index]);
        for (const [layer, matrix] of model.W.entries()) {
            x = model.b[layer].map((bias, j) => {
                const h = matrix.reduce((sum, row, i) => sum + row[j] * x[i], bias);
                return layer === model.W.length - 1 ? h : h / (1 + Math.abs(h));
            });
        }
        return Math.exp(Math.min(10, Math.max(-30, x[0] + model.outBias[0])));
    };
    const metrics = {};
    const add = (name, prediction, reference, weight) => {
        const stat = metrics[name] ??= { error: 0, norm: 0, predicted: 0, reference: 0 };
        stat.error += (weight * (prediction - reference)) ** 2;
        stat.norm += (weight * reference) ** 2;
        stat.predicted += weight * prediction;
        stat.reference += weight * reference;
    };
    let valid = 0;
    let used = 0;
    for (let i = 0; i < queries.count; i++) {
        const r = i * RECORD_FLOATS;
        const weight = records[r + 3];
        if (weight <= 0.05) continue;
        valid++;
        const c = 12 * i;
        const w = deployed[c + 3];
        const albedo = records[r + 45];
        const sun = records[r + 35] / records[r + 41] * albedo;
        const sky = records[r + 37] / records[r + 41] * albedo;
        add('bouncedSunAnalyticAll', deployed[c + 4], sun, weight);
        add('skyAnalyticAll', deployed[c + 5], sky, weight);
        if (w < 0.5) continue;
        used++;
        const far = extras[20 * i + 16];
        const up = extras[20 * i + 18];
        const features = [...records.subarray(r + 8, r + 26), records[r + 27], Math.exp(-far), Math.log1p(up), Math.log1p(far)];
        add('bouncedSunExactFeatures', predict(set.ms, features), sun, weight);
        add('skyExactFeatures', predict(set.sky, features), sky, weight);
        const transmittance = set.direct ? Math.min(1, predict(set.direct, features)) : Math.exp(-(records[r + 29] * records[r + 44] + far));
        add('directSunExactFeatures', transmittance * deployed[c + 7] * albedo, records[r + 34] * albedo, weight);
        const cacheWeight = deployed[c + 9];
        const bounce = deployed[c] / w;
        const skyLight = deployed[c + 1] / w;
        const directLight = deployed[c + 2] / w * deployed[c + 7] * albedo;
        const combine = (analytic, learned, t) => analytic + (learned - analytic) * t;
        add('bouncedSunCache', bounce, sun, weight);
        add('bouncedSunAnalytic', deployed[c + 4], sun, weight);
        add('bouncedSunHybrid', combine(deployed[c + 4], bounce * deployed[c + 8], cacheWeight), sun, weight);
        add('skyCache', skyLight, sky, weight);
        add('skyAnalytic', deployed[c + 5], sky, weight);
        add('skyHybrid', combine(deployed[c + 5], skyLight, cacheWeight), sky, weight);
        const direct = records[r + 34] * albedo;
        add('directSunAnalytic', deployed[c + 6], direct, weight);
        add('directSunHybrid', combine(deployed[c + 6], directLight, cacheWeight), direct, weight);
    }
    const errors = Object.fromEntries(Object.entries(metrics).map(([name, { error, norm, predicted, reference }]) =>
        [name, { relativeRmse: Math.sqrt(error / norm), bias: predicted / reference }]));
    return { model: modelName, paths, queried: queries.count, cloudy: valid, inCache: used, errors };
}
