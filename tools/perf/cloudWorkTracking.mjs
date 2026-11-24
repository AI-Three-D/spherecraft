// Installed only for work-count runs. The original output textures and
// bindings remain live.
export function installCloudWorkTracking() {
    const fields = ['rays', 'density', 'lighting', 'view3d', 'light3d', 'view2d', 'light2d',
        'bakeVoxels', 'bakeDensity', 'bake3d', 'bake2d'];
    const shards = 64;
    const bytes = fields.length * shards * 4;
    const states = new Map();
    const shaderModules = new WeakSet();
    const pipelineLayouts = new WeakMap();
    const pipelines = new WeakMap();

    function instrument(source, conventional, bake) {
        const declarations = `
struct WorkSample {
    rays: atomic<u32>, density: atomic<u32>, lighting: atomic<u32>,
    view3d: atomic<u32>, light3d: atomic<u32>, view2d: atomic<u32>, light2d: atomic<u32>,
    bakeVoxels: atomic<u32>, bakeDensity: atomic<u32>, bake3d: atomic<u32>, bake2d: atomic<u32>,
}

fn flushLightBake(voxel: vec3u) {
    let slot = (voxel.x + voxel.y * 19u + voxel.z * 31u) % 64u;
    atomicAdd(&cloudWorkOutput[slot].bakeVoxels, 1u);
    atomicAdd(&cloudWorkOutput[slot].bakeDensity, densityCalls);
    atomicAdd(&cloudWorkOutput[slot].bake3d, fetches.x);
    atomicAdd(&cloudWorkOutput[slot].bake2d, fetches.z);
}
@group(1) @binding(0) var<storage, read_write> cloudWorkOutput: array<WorkSample>;
var<private> densityCalls: u32;
var<private> lightingCalls: u32;
var<private> samplingLight: bool;
var<private> fetches: vec4u;

fn flushCloudWork(pixel: vec2u) {
    let slot = (pixel.x + pixel.y * 19u) % 64u;
    atomicAdd(&cloudWorkOutput[slot].rays, 1u);
    atomicAdd(&cloudWorkOutput[slot].density, densityCalls);
    atomicAdd(&cloudWorkOutput[slot].lighting, lightingCalls);
    atomicAdd(&cloudWorkOutput[slot].view3d, fetches.x);
    atomicAdd(&cloudWorkOutput[slot].light3d, fetches.y);
    atomicAdd(&cloudWorkOutput[slot].view2d, fetches.z);
    atomicAdd(&cloudWorkOutput[slot].light2d, fetches.w);
}
`;
        function changeBody(code, name, transform) {
            const signature = code.indexOf('fn ' + name + '(');
            if (signature < 0) throw new Error('Unknown shader function ' + name);
            const start = code.indexOf('{', signature);
            let end = start + 1;
            let depth = 1;
            while (depth && end < code.length) {
                if (code[end] === '{') depth++;
                else if (code[end] === '}') depth--;
                end++;
            }
            if (depth || start < 0) throw new Error('Unknown shader function ' + name);
            return code.slice(0, start + 1) + transform(code.slice(start + 1, end - 1)) + code.slice(end - 1);
        }
        const shade = body => '\n    samplingLight = true; lightingCalls++;\n'
            + body.replace(/\breturn /g, 'samplingLight = false; return ');

        let code = source;
        const taps = [
            ['shapeTex', 'noiseSampler', 3, 'x', 'y'], ['detailTex', 'noiseSampler', 3, 'x', 'y'],
            ['weatherTex', 'noiseSampler', 3, 'x', 'y'],
            ['cloudLightLut', conventional ? 'linearSampler' : 'lutSampler', 2, 'z', 'w'],
            ['ambientLut', 'lutSampler', 2, 'z', 'w'], ['shadowMap', 'linearSampler', 2, 'z', 'w'],
            ['weatherField', 'linearSampler', 3, 'z', 'w'], ['weatherShift', 'linearSampler', 3, 'z', 'w'],
        ];
        let wrappers = '';
        for (const [texture, sampler, dimensions, view, light] of taps) {
            const marker = `textureSampleLevel(${texture}, ${sampler},`;
            if (!code.includes(marker)) continue;
            code = code.replaceAll(marker, `count_${texture}(`);
            wrappers += `
fn count_${texture}(p: vec${dimensions}f, lod: f32) -> vec4f {
    if (samplingLight) { fetches.${light}++; } else { fetches.${view}++; }
    return ${marker} p, lod);
}
`;
        }
        if (bake) {
            code = changeBody(code, 'cloudBaseWithWeather', body => 'densityCalls++;\n' + body);
            code = changeBody(code, 'main', body => body + 'if (valid) { flushLightBake(voxel); }\n');
        } else if (conventional) {
            if (code.includes('fn sampleLightPatch(')) {
                code = changeBody(code, 'sampleLightPatch', body => body.replace('return textureSampleLevel(tex,',
                    'fetches.y++; return textureSampleLevel(tex,'));
            }
            code = changeBody(code, 'sunTransmittance', body => body.replace('let t = textureSampleLevel',
                'fetches.w++; let t = textureSampleLevel'));
            code = changeBody(code, 'sourceAt', shade);
            code = changeBody(code, 'densityAt', body => 'densityCalls++;\n' + body);
            code = changeBody(code, 'traceAndStore', body => body.replace('textureStore(outColor', 'flushCloudWork(pixel); textureStore(outColor'));
        } else {
            code = changeBody(code, 'viewDensity', body => 'densityCalls++;\n' + body);
            code = changeBody(code, 'viewCloudLight', shade);
            code = changeBody(code, 'marchLowClouds', body => body.replace('let density = lowStratusDensity',
                'densityCalls++; let density = lowStratusDensity').replace('let sun = cloudLightTransmittance',
                'samplingLight = true; lightingCalls++; let sun = cloudLightTransmittance')
                .replace('let footprint = ', 'samplingLight = false; let footprint = '));
            code = changeBody(code, 'proxyLayer', body => body.replace('let ti = ', 'densityCalls++; let ti = ')
                .replace('let illum = ', 'samplingLight = true; let illum = ')
                .replace('let sunMax = ', 'samplingLight = false; let sunMax = ')
                .replace('for (var i = 0; i < slabs; i++) {', 'for (var i = 0; i < slabs; i++) { densityCalls++;')
                .replace('var directL = ', 'samplingLight = true; lightingCalls++; var directL = ')
                .replace('L += T * sigmaS', 'samplingLight = false; L += T * sigmaS'));
            code = code.replace('textureStore(outColor, vec2i(id.xy), result.color);',
                'flushCloudWork(id.xy); textureStore(outColor, vec2i(id.xy), result.color);');
        }
        return code + declarations + wrappers;
    }

    const createShader = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
        const label = descriptor.label;
        const bake = !!label?.startsWith('clouds neural light column bake');
        const conventional = label === 'clouds conventional' || label === 'clouds neural lighting raymarch';
        if (!bake && !conventional && !['clouds raymarch', 'clouds proxyBlend'].includes(label)) {
            return createShader.call(this, descriptor);
        }
        const module = createShader.call(this, { ...descriptor, code: instrument(descriptor.code, conventional, bake) });
        shaderModules.add(module);
        return module;
    };

    const createLayout = GPUDevice.prototype.createPipelineLayout;
    GPUDevice.prototype.createPipelineLayout = function (descriptor) {
        const layout = createLayout.call(this, descriptor);
        pipelineLayouts.set(layout, descriptor.bindGroupLayouts);
        return layout;
    };

    const createPipeline = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = async function (descriptor) {
        if (!shaderModules.has(descriptor.compute.module)) return createPipeline.call(this, descriptor);
        if (!states.has(this)) {
            const buffer = this.createBuffer({ size: bytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
            const layout = this.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ] });
            const group = this.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] });
            states.set(this, { buffer, group, layout });
        }
        const state = states.get(this);
        const layout = createLayout.call(this, { bindGroupLayouts: [...pipelineLayouts.get(descriptor.layout), state.layout] });
        const pipeline = await createPipeline.call(this, { ...descriptor, layout });
        pipelines.set(pipeline, state.group);
        return pipeline;
    };

    const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
    GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
        setPipeline.call(this, pipeline);
        const group = pipelines.get(pipeline);
        if (group) this.setBindGroup(1, group);
    };

    window.cloudWork = {
        reset(device) {
            const encoder = device.createCommandEncoder();
            encoder.clearBuffer(states.get(device).buffer);
            device.queue.submit([encoder.finish()]);
        },
        async read(device) {
            const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
                const encoder = device.createCommandEncoder();
                encoder.copyBufferToBuffer(states.get(device).buffer, 0, readback, 0, bytes);
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                const counts = new Uint32Array(readback.getMappedRange());
                return Object.fromEntries(fields.map((name, field) => {
                    let total = 0;
                    for (let index = field; index < counts.length; index += fields.length) total += counts[index];
                    return [name, total];
                }));
            } finally {
                readback.destroy();
            }
        },
    };
}
