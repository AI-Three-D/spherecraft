import { GpuPassTimer } from 'engine/renderer/profiling/gpuPassTimer.js';
import {
    CLOUD_SOLAR_INFERENCE_WGSL, CLOUD_SOLAR_SAMPLES_WGSL,
} from 'engine/renderer/volumetricClouds/neural/solar.wgsl.js';
import { seededRandom } from 'engine/renderer/volumetricClouds/neural/DenseNetwork.js';
import { packSolarModel, SOLAR_FEATURES, SOLAR_ROW } from 'engine/renderer/volumetricClouds/neural/solarModel.js';

const normalize = v => {
    const length = Math.hypot(...v);
    return v.map(x => x / length);
};
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

function sampleQueries(clouds, count, steps, seed, region) {
    const random = seededRandom(seed);
    const up = normalize(clouds._prev.pos);
    const east = normalize(cross(Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], up));
    const north = cross(up, east);
    const radius = clouds.planet.radiusKm;
    const top = clouds.settings.cloudTopKm;
    const base = Math.min(clouds.settings.cloudBottomKm, top - 0.1);
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
        // Hold out a spatial region, so nearby training and evaluation rays do not share clouds.
        const x = (random() - 0.5) * 20 + region * 26;
        const z = (random() - 0.5) * 20;
        const localUp = normalize(up.map((v, axis) => v * radius + east[axis] * x + north[axis] * z));
        const altitude = base + (top - base) * random();
        const point = localUp.map(v => v * (radius + altitude));
        const mu = -0.23 + 1.23 * random();
        const azimuth = 2 * Math.PI * random();
        const tangent = normalize(cross(Math.abs(localUp[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], localUp));
        const bitangent = cross(localUp, tangent);
        const side = Math.sqrt(1 - mu * mu);
        const direction = localUp.map((v, axis) => v * mu + side *
            (tangent[axis] * Math.cos(azimuth) + bitangent[axis] * Math.sin(azimuth)));
        const footprint = 0.012 + 0.16 * random() ** 2;
        data.set([...point, footprint, ...direction, steps], i * 8);
    }
    return data;
}

export class SolarGpuLab {
    constructor(clouds) {
        this.clouds = clouds;
        this.device = clouds.device;
        this.pipelines = new Map();
    }

    pipeline(code, label) {
        if (!this.pipelines.has(label)) {
            const module = this.device.createShaderModule({ label, code });
            this.pipelines.set(label, this.device.createComputePipelineAsync({
                label, layout: 'auto', compute: { module, entryPoint: 'main' },
            }));
        }
        return this.pipelines.get(label);
    }

    buffer(data, usage) {
        const buffer = this.device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    async dispatch(pipeline, resources, rows, width, timed = false) {
        const device = this.device;
        const size = rows * width * Float32Array.BYTES_PER_ELEMENT;
        const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const timer = timed ? new GpuPassTimer(device, { capacity: 32 }) : null;
        try {
            const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [...resources, { buffer: output }].map((resource, binding) => ({ binding, resource })),
            });
            const encoder = device.createCommandEncoder();
            timer?.beginFrame();
            const repeats = timer?.supported ? 11 : 1;
            for (let i = 0; i < repeats; i++) {
                const pass = encoder.beginComputePass({ timestampWrites: i > 0 ? timer.timestampWrites('solar inference') : undefined });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.ceil(rows / 64));
                pass.end();
            }
            encoder.copyBufferToBuffer(output, 0, readback, 0, size);
            timer?.resolve(encoder);
            device.queue.submit([encoder.finish()]);
            timer?.collect();
            await readback.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(readback.getMappedRange().slice(0));
            readback.unmap();
            // The timer's mapped readback was requested before the output readback.
            const aggregate = timer?.stats()[0]?.avg;
            return { values, gpuMs: aggregate == null ? null : aggregate / (repeats - 1) };
        } finally {
            timer?.dispose();
            output.destroy();
            readback.destroy();
        }
    }

    async generate(count, steps, seed) {
        if (!this.clouds._prev) throw new Error('Wait for the first rendered cloud frame');
        if (!Number.isInteger(count) || count < 256 || count > 65536 ||
            !Number.isInteger(steps) || steps < 16 || steps > 512) {
            throw new Error('Use 256–65,536 training samples and 16–512 reference steps');
        }
        const clouds = this.clouds;
        const data = clouds._uniformData.slice();
        const noise = clouds._noiseResources.slice(1);
        const validationCount = Math.max(256, Math.floor(count / 4));
        const total = count + 2 * validationCount;
        const queries = new Float32Array(total * 8);
        queries.set(sampleQueries(clouds, count, steps, seed, 0));
        queries.set(sampleQueries(clouds, validationCount, steps, seed + 1, 1), count * 8);
        queries.set(sampleQueries(clouds, validationCount, steps, seed + 2, -1), (count + validationCount) * 8);
        const pipeline = await this.pipeline(CLOUD_SOLAR_SAMPLES_WGSL, 'solar reference labels');
        const uniform = this.buffer(data, GPUBufferUsage.UNIFORM);
        const points = this.buffer(queries, GPUBufferUsage.STORAGE);
        try {
            const { values } = await this.dispatch(pipeline,
                [{ buffer: uniform }, ...noise, { buffer: points }], total, SOLAR_ROW);
            if (!values.every(Number.isFinite)) throw new Error('Non-finite labels from GPU reference');
            return {
                train: values.slice(0, count * SOLAR_ROW),
                validation: values.slice(count * SOLAR_ROW, (count + validationCount) * SOLAR_ROW),
                test: values.slice((count + validationCount) * SOLAR_ROW),
                extinction: values[SOLAR_ROW - 1],
                steps,
            };
        } finally {
            uniform.destroy();
            points.destroy();
        }
    }

    async evaluate(model, rows) {
        const count = rows.length / SOLAR_ROW;
        const features = new Float32Array(count * SOLAR_FEATURES);
        for (let i = 0; i < count; i++) {
            features.set(rows.subarray(i * SOLAR_ROW, i * SOLAR_ROW + SOLAR_FEATURES), i * SOLAR_FEATURES);
        }
        const pipeline = await this.pipeline(CLOUD_SOLAR_INFERENCE_WGSL, 'solar network evaluation');
        const weights = this.buffer(packSolarModel(model), GPUBufferUsage.UNIFORM);
        const input = this.buffer(features, GPUBufferUsage.STORAGE);
        try {
            return await this.dispatch(pipeline, [{ buffer: weights }, { buffer: input }], count, 1, true);
        } finally {
            weights.destroy();
            input.destroy();
        }
    }
}
