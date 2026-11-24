// Runs the path-tracing teacher against a live VolumetricCloudsModule (its uniforms and noise volumes).
import { RECORD_FLOATS, TEACHER_EXTRA_WGSL, TEACHER_IMAGE_WGSL, TEACHER_LABEL_WGSL, TEACHER_QUERY_WGSL } from './teacher.wgsl.js';

export const DEFAULT_TEACHER = Object.freeze({
    fineStepKm: 0.02, airStepKm: 0.06, airGrowth: 0.015, footprintKm: 0.012,
    neeTauMax: 9, skyRadiance: 1, emptyToCoarse: 3, maxStepsPerMarch: 3000, maxBounces: 384, fineMultiplier: 4,
});

export class TeacherGpu {
    constructor(clouds, options = {}) {
        this.clouds = clouds;
        this.device = clouds.device;
        this.options = { ...DEFAULT_TEACHER, ...options };
        this.pipelines = new Map();
    }

    async pipeline(code, label) {
        if (!this.pipelines.has(label)) {
            const module = this.device.createShaderModule({ label, code });
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter(m => m.type === 'error');
            if (errors.length) throw new Error(`${label}: ${errors.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n')}`);
            this.pipelines.set(label, await this.device.createComputePipelineAsync({
                label, layout: 'auto', compute: { module, entryPoint: 'main' },
            }));
        }
        return this.pipelines.get(label);
    }

    params(seed, paths, offset, width, height) {
        const o = this.options;
        const buffer = new ArrayBuffer(64);
        new Uint32Array(buffer, 0, 4).set([seed >>> 0, paths, o.maxBounces, offset]);
        new Float32Array(buffer, 16, 12).set([
            o.fineStepKm, o.airStepKm, o.airGrowth, o.footprintKm,
            width, height, o.neeTauMax, o.skyRadiance,
            o.emptyToCoarse, o.maxStepsPerMarch, o.fineMultiplier, 0,
        ]);
        return buffer;
    }

    uniformBuffer(data, usage = GPUBufferUsage.UNIFORM) {
        const buffer = this.device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    /** Snapshot the module's current uniforms (camera, sun, weather) so later passes are consistent. */
    snapshot() {
        if (!this.clouds._prev) throw new Error('Render a cloud frame first');
        return {
            uniforms: this.clouds._uniformData.slice(),
            noise: this.clouds._noiseResources.slice(1, 5),
        };
    }

    async read(buffer, size) {
        const readback = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        readback.destroy();
        return values;
    }

    async run(pipeline, entries, groups) {
        this.device.pushErrorScope('validation');
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: entries.map((resource, binding) => ({ binding, resource })),
        }));
        pass.dispatchWorkgroups(...groups);
        pass.end();
        const start = performance.now();
        this.device.queue.submit([encoder.finish()]);
        const error = await this.device.popErrorScope();
        if (error) throw new Error(`${pipeline.label}: ${error.message}`);
        await this.device.queue.onSubmittedWorkDone();
        return performance.now() - start;
    }

    /** Queries for one view: width x height pixels, one contribution-sampled point each. */
    async queries(snap, width, height, seed) {
        const pipeline = await this.pipeline(TEACHER_QUERY_WGSL, 'teacher queries');
        const count = width * height;
        const queries = this.device.createBuffer({ size: count * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const uniforms = this.uniformBuffer(snap.uniforms);
        let ms = 0;
        let rows = 8;
        for (let row = 0; row < height;) {
            const count = Math.min(rows, height - row);
            const params = this.uniformBuffer(this.params(seed, 0, row, width, height));
            const t = await this.run(pipeline, [{ buffer: uniforms }, ...snap.noise, { buffer: params }, { buffer: queries }],
                [Math.ceil(width / 8), Math.ceil(count / 8)]);
            params.destroy();
            ms += t;
            row += count;
            rows = Math.max(8, Math.min(height, 8 * Math.floor((0.5 * rows + 0.5 * count * 150 / Math.max(t, 1)) / 8)));
        }
        uniforms.destroy();
        return { buffer: queries, count, ms };
    }

    /** Path-trace every query up to totalPaths paths, adapting chunk size to keep dispatches short. */
    async label(snap, queries, totalPaths, seed, { budgetMs = 200, log = () => {} } = {}) {
        const pipeline = await this.pipeline(TEACHER_LABEL_WGSL, 'teacher labels');
        const size = queries.count * RECORD_FLOATS * 4;
        const records = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const uniforms = this.uniformBuffer(snap.uniforms);
        let range = 1024;
        const paths = 4;
        let gpuMs = 0;
        for (let done = 0; done < totalPaths;) {
            const step = Math.min(paths, totalPaths - done);
            for (let offset = 0; offset < queries.count;) {
                const count = Math.min(range, queries.count - offset);
                const params = this.uniformBuffer(this.params(seed + done * 7919 + offset, step, offset, 0, 0));
                const ms = await this.run(pipeline, [{ buffer: uniforms }, ...snap.noise, { buffer: params },
                    { buffer: queries.buffer }, { buffer: records }], [Math.ceil(count / 64)]);
                params.destroy();
                gpuMs += ms;
                offset += count;
                // Aim for budgetMs per dispatch.
                const rate = ms / (count * step);
                range = Math.max(128, Math.min(queries.count, Math.floor(0.5 * range + 0.5 * budgetMs / Math.max(rate * paths, 1e-6))));
            }
            done += step;
            log(`paths ${done}/${totalPaths}, ${(gpuMs / 1000).toFixed(1)} s`);
        }
        const values = await this.read(records, size);
        uniforms.destroy();
        records.destroy();
        return { values, gpuMs };
    }

    /** Path-traced reference image (sun, sky, transmittance, samples) per pixel. */
    async image(snap, width, height, spp, seed, { budgetMs = 200, log = () => {} } = {}) {
        const pipeline = await this.pipeline(TEACHER_IMAGE_WGSL, 'teacher image');
        const size = width * height * 16;
        const accum = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const uniforms = this.uniformBuffer(snap.uniforms);
        let rows = 8;
        let gpuMs = 0;
        for (let done = 0; done < spp; done++) {
            for (let row = 0; row < height;) {
                const count = Math.min(rows, height - row);
                const params = this.uniformBuffer(this.params(seed + done * 104729 + row, 1, row, width, height));
                const ms = await this.run(pipeline, [{ buffer: uniforms }, ...snap.noise, { buffer: params }, { buffer: accum }],
                    [Math.ceil(width / 8), Math.ceil(count / 8)]);
                params.destroy();
                gpuMs += ms;
                row += count;
                rows = Math.max(8, Math.min(height, 8 * Math.floor((0.5 * rows + 0.5 * count * budgetMs / Math.max(ms, 1)) / 8)));
            }
            if (done % 32 === 31) log(`spp ${done + 1}/${spp}, ${(gpuMs / 1000).toFixed(1)} s`);
        }
        const values = await this.read(accum, size);
        uniforms.destroy();
        accum.destroy();
        return { values, gpuMs };
    }

    /** Descriptor features for stored records, using the scene's stored uniform snapshot. */
    async extra(uniformValues, records) {
        const pipeline = await this.pipeline(TEACHER_EXTRA_WGSL, 'teacher extra');
        const count = records.length / RECORD_FLOATS;
        const uniforms = this.uniformBuffer(new Float32Array(uniformValues));
        const input = this.uniformBuffer(records, GPUBufferUsage.STORAGE);
        const out = this.device.createBuffer({ size: count * 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const params = this.uniformBuffer(this.params(1, 0, 0, 0, 0));
        const noise = this.clouds._noiseResources.slice(1, 5);
        for (let offset = 0; offset < count; offset += 65536 * 64) {
            await this.run(pipeline, [{ buffer: uniforms }, ...noise, { buffer: params }, { buffer: input }, { buffer: out }],
                [Math.ceil(Math.min(count - offset, 65535 * 64) / 64)]);
        }
        const values = await this.read(out, count * 80);
        uniforms.destroy(); input.destroy(); out.destroy(); params.destroy();
        return values;
    }
}
