/* global volumetricClouds */

// Runs after timing. Compare the deployed cache, including its interpolation, to
// the same path tracer and the exact-feature networks at contribution-sampled points.
export async function measureNeuralReference(paths) {
    const base = '/core/renderer/volumetricClouds/';
    const [{ TeacherGpu }, { RECORD_FLOATS }, models, common, fields] = await Promise.all([
        import('/neural_lab/teacherGpu.js'),
        import('/neural_lab/teacher.wgsl.js'),
        import(base + 'neural/lightingModels.js'),
        import(base + 'shaders/cloudCommon.wgsl.js'),
        import(base + 'shaders/cloudViewFields.wgsl.js'),
    ]);
    const clouds = volumetricClouds;
    const set = models.LIGHTING_MODELS;
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
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3u) {
            if (id.x < arrayLength(&records) && records[id.x][3] > 0.0001) {
                let r = records[id.x];
                let p = vec3f(r[0], r[1], r[2]);
                let mu = r[27];
                let phase = mix(henyeyGreenstein(r[26], u.phase.x), henyeyGreenstein(r[26], u.phase.y), u.phase.z);
                let cached = cachedLight(p, length(p));
                let scale = bouncedSunScale(mu, u.weatherStyle.z, cached.z / max(cached.w, 0.001));
                light[id.x] = array<vec4f, 3>(cached, vec4f(0.0, 0.0, 0.0, phase),
                    vec4f(scale, neuralEdgeBlend(cached.w, r[3]), 0.0, 0.0));
            }
        }
    `;
    const pipeline = await teacher.pipeline(code, 'deployed neural light comparison');
    const uniforms = teacher.uniformBuffer(snapshot.uniforms);
    const labels = teacher.uniformBuffer(records, GPUBufferUsage.STORAGE);
    const out = clouds.device.createBuffer({ size: queries.count * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const primary = cache.current.index;
    await teacher.run(pipeline, [{ buffer: uniforms }, clouds._linearSampler, cache.banks[primary].view,
        cache.banks[1 - primary].view, cache.lookup, { buffer: labels }, { buffer: out }],
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
        if (w < 0.5) continue;
        used++;
        const far = extras[20 * i + 16];
        const up = extras[20 * i + 18];
        const features = [...records.subarray(r + 8, r + 26), records[r + 27], Math.exp(-far), Math.log1p(up), Math.log1p(far)];
        add('bouncedSunExactFeatures', predict(set.ms, features), sun, weight);
        add('skyExactFeatures', predict(set.sky, features), sky, weight);
        const transmittance = Math.min(1, predict(set.direct, features));
        add('directSunExactFeatures', transmittance * deployed[c + 7] * albedo, records[r + 34] * albedo, weight);
        const bounce = deployed[c] / w;
        const skyLight = deployed[c + 1] / w;
        const directLight = deployed[c + 2] / w * deployed[c + 7] * albedo;
        add('bouncedSunCache', bounce, sun, weight);
        add('bouncedSunScaled', bounce * deployed[c + 8], sun, weight);
        add('skyCache', skyLight, sky, weight);
        const direct = records[r + 34] * albedo;
        add('directSunCache', directLight, direct, weight);
    }
    const errors = Object.fromEntries(Object.entries(metrics).map(([name, { error, norm, predicted, reference }]) =>
        [name, { relativeRmse: Math.sqrt(error / norm), bias: predicted / reference }]));
    return { paths, queried: queries.count, cloudy: valid, inCache: used, errors };
}
