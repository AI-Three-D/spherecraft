/* global cloudBench, gameEngine, volumetricClouds */

export async function readReferenceSkyMask({ width, height }) {
    const clouds = volumetricClouds;
    const { TeacherGpu } = await import('/neural_lab/teacherGpu.js');
    const teacher = new TeacherGpu(clouds);
    const output = clouds.device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = teacher.uniformBuffer(new Float32Array([width, height, 0, 0]));
    try {
        const pipeline = await teacher.pipeline(/* wgsl */`
@group(0) @binding(0) var scene: texture_depth_2d;
@group(0) @binding(1) var<uniform> params: vec4f;
@group(0) @binding(2) var<storage, read_write> mask: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2u(params.xy);
    if (any(id.xy >= size)) { return; }
    let depthSize = vec2f(textureDimensions(scene));
    let first = vec2i(vec2f(id.xy) * depthSize / params.xy);
    let last = vec2i(vec2f(id.xy + 1u) * depthSize / params.xy) - 1;
    for (var y = first.y; y <= last.y; y++) {
        for (var x = first.x; x <= last.x; x++) {
            if (textureLoad(scene, vec2i(x, y), 0) < 1.0) { return; }
        }
    }
    mask[id.y * size.x + id.x] = 1.0;
}
`, 'image reference sky mask');
        await teacher.run(pipeline, [clouds._sceneDepthView, { buffer: params }, { buffer: output }],
            [Math.ceil(width / 8), Math.ceil(height / 8)]);
        return Array.from(await teacher.read(output, width * height * 4));
    } finally {
        output.destroy();
        params.destroy();
    }
}

// Trace the lab's exact density and scattering at the game camera, then run
// the regular HDR composite and tone mapping with those cloud buffers.
export async function prepareCloudImageReference({ width, height, spp }) {
    const [{ TeacherGpu }, { TEACHER_HEADER }, common] = await Promise.all([
        import('/neural_lab/teacherGpu.js'),
        import('/neural_lab/teacher.wgsl.js'),
        import('/core/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js'),
    ]);
    const clouds = volumetricClouds;
    const composite = gameEngine.renderer.cloudComposite;
    const teacher = new TeacherGpu(clouds);
    const { uniforms, noise } = teacher.snapshot();
    const uniform = teacher.uniformBuffer(uniforms);
    const size = width * height * 32;
    const accum = clouds.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const sceneSource = /* wgsl */`
@group(0) @binding(6) var<storage, read_write> accum: array<mat2x4f>;
@group(0) @binding(7) var scene: texture_depth_2d;

fn sceneLimit(uv: vec2f, rd: vec3f) -> f32 {
    let size = textureDimensions(scene);
    let z = textureLoad(scene, min(vec2u(uv * vec2f(size)), size - 1u), 0);
    if (z >= 1.0) { return 1.0e6; }
    return u.sceneDepth.y * u.sceneDepth.z / ((z + u.sceneDepth.x) * max(-dot(rd, u.camBack.xyz), 1.0e-4));
}
`;
    const source = /* wgsl */`
${TEACHER_HEADER}
${common.CLOUD_ATMOSPHERE_WGSL.replace(/\bsunTransmittance\b/g, 'atmosphericSunTransmittance')}
${sceneSource}
@group(0) @binding(8) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(9) var linearSampler: sampler;

fn transportToColor(p: vec3f, single: f32, path: PathResult) -> vec3f {
    let radius = length(p);
    let up = p / radius;
    let mu = dot(up, u.sun.xyz);
    let sun = atmosphericSunTransmittance(cloudLightLut, linearSampler, radius, mu, u.planet.x, u.planet.w) * u.sun.w;
    var ambient = u.ambientFloor.rgb;
    if (u.moon.w > 0.0) {
        ambient += atmosphericSunTransmittance(cloudLightLut, linearSampler, radius, dot(up, u.moon.xyz),
            u.planet.x, u.planet.w) * (0.06 * u.moon.w);
    }
    let sky = vec3f(0.61, 0.75, 1.0) * (u.look5.z * u.sun.w * smoothstep(-0.25, 0.35, mu));
    let rain = 1.0 - u.weatherStyle.z * mix(0.44, 0.12, saturate(heightFraction(radius)));
    return (sun * (single + path.sun) + ambient + sky * path.sky) * (rain * u.density.w);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2u(P.view.xy);
    let py = id.y + P.info.w;
    if (id.x >= size.x || py >= size.y) { return; }
    let index = py * size.x + id.x;
    var sum = accum[index];
    let ro = u.camPos.xyz;
    for (var n = 0u; n < P.info.y; n++) {
        seedRng(index, P.info.x, 7u + n * 131u);
        let pix = vec2f(f32(id.x), f32(py)) + vec2f(rand(), rand());
        let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
        let outer = raySphere(ro, rd, u.planet.z);
        let ground = raySphere(ro, rd, u.planet.x);
        let inner = raySphere(ro, rd, shellBottom());
        let sceneEnd = sceneLimit(pix / vec2f(size), rd);
        sum[1].y += 1.0;
        if (outer.x > outer.y || outer.y <= 0.0) { sum[0].w += 1.0; continue; }
        let stop = select(sceneEnd, min(sceneEnd, ground.x), ground.x < ground.y && ground.x > 0.0);
        let t0 = max(max(outer.x, 0.0), select(0.0, inner.y, length(ro) < shellBottom()));
        let t1 = min(outer.y, stop);
        if (t1 <= t0) { sum[0].w += 1.0; continue; }
        let start = ro + rd * t0;
        let t = freeFlight(start, rd, t1 - t0, -log(max(1.0 - rand(), 1.0e-7)));
        if (t < 0.0) { sum[0].w += 1.0; continue; }
        let point = start + rd * t;
        let single = cloudPhaseExact(dot(rd, u.sun.xyz)) * sunTransmittance(point);
        sum[0] += vec4f(transportToColor(point, single, tracePath(point, rd)), 0.0);
        sum[1].x += t0 + t;
    }
    accum[index] = sum;
}
`;
    const pipeline = await teacher.pipeline(source, 'game image reference');
    const scene = clouds._sceneDepthView;
    const out = clouds.getOutputs();
    let rows = 8;
    for (let sample = 0; sample < spp; sample++) {
        for (let y = 0; y < height;) {
            const count = Math.min(rows, height - y);
            const params = teacher.uniformBuffer(teacher.params(51367 + sample * 104729 + y, 1, y, width, height));
            const ms = await teacher.run(pipeline, [{ buffer: uniform }, ...noise, { buffer: params },
                { buffer: accum }, scene, clouds._cloudLightView, out.linearSampler], [Math.ceil(width / 8), Math.ceil(count / 8)]);
            params.destroy();
            y += count;
            rows = Math.max(8, Math.min(height, 8 * Math.floor((rows + count * 120 / Math.max(ms, 1)) / 16)));
        }
    }

    const textures = ['rgba16float', 'r32float'].map(format => clouds.device.createTexture({
        label: 'cloud teacher target', size: [width, height], format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    }));
    const views = textures.map(texture => texture.createView());
    // Reuse the same scene depth function and dispatch directly into compositor textures.
    const resolve = /* wgsl */`
${common.CLOUD_UNIFORMS_WGSL}${common.CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
${sceneSource}
@group(0) @binding(8) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outColor);
    if (any(id.xy >= size)) { return; }
    let sum = accum[id.y * size.x + id.x];
    let pix = vec2f(id.xy) + 0.5;
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let stop = sceneLimit(pix / vec2f(size), rd);
    let hits = sum[1].y - sum[0].w;
    let distance = select(stop, sum[1].x / max(1.0, hits), hits > 0.0);
    textureStore(outColor, id.xy, sum[0] / max(1.0, sum[1].y));
    textureStore(outDepth, id.xy, vec4f(select(distance, -max(0.001, distance), stop < 1.0e6)));
}
`;
    const resolveModule = clouds.device.createShaderModule({ code: resolve });
    const resolvePipeline = await clouds.device.createComputePipelineAsync({
        label: 'resolve game image reference', layout: 'auto', compute: { module: resolveModule, entryPoint: 'main' },
    });
    const resolveGroup = clouds.device.createBindGroup({
        layout: resolvePipeline.getBindGroupLayout(0),
        entries: [uniform, accum, scene, ...views].map((resource, i) => ({
            binding: [0, 6, 7, 8, 9][i], resource: i < 2 ? { buffer: resource } : resource,
        })),
    });
    const encoder = clouds.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(resolvePipeline);
    pass.setBindGroup(0, resolveGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    clouds.device.queue.submit([encoder.finish()]);
    const values = await teacher.read(accum, size);
    accum.destroy();
    uniform.destroy();

    const opacity = Array.from({ length: width * height }, (_, i) => {
        const count = values[i * 8 + 5];
        return count > 0 ? 1 - values[i * 8 + 3] / count : 0;
    });
    const getOutputs = clouds.getOutputs;
    const version = out.version + ':teacher';
    clouds.getOutputs = function () {
        const actual = getOutputs.call(this);
        return { ...actual, version, colorView: views[0], depthView: views[1], size: [width, height] };
    };
    cloudBench.releaseImageReference = () => {
        delete clouds.getOutputs;
        composite._groups.delete(version);
        for (const texture of textures) texture.destroy();
        delete cloudBench.releaseImageReference;
    };
    return opacity;
}
