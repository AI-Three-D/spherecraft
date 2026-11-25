import { CLOUD_RAY_PAIRS_WGSL } from './shaders/cloudRayPairs.wgsl.js';

const HEADER_BYTES = 16;

/**
 * Traces every second cloud ray and fills in the others from their four neighbours where they agree
 * The rest are traced from a list. Writes the same targets as the plain raymarch.
 */
export class CloudRayPairs {
    constructor(host) {
        this.host = host;
        this.device = host.device;
        this.groups = new WeakMap();
    }

    async initialize() {
        this.module = this.device.createShaderModule({ label: 'clouds ray pairs', code: CLOUD_RAY_PAIRS_WGSL });
        this.pipelines = { high: await this._compile() };
        this.empty = this._buffer('cloud ray list header', HEADER_BYTES, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        this.device.queue.writeBuffer(this.empty, 0, new Uint32Array([0, 1, 1, 0]));
    }

    _compile(constants) {
        return this.device.createComputePipelineAsync({
            label: 'clouds ray pairs',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.host._layouts.rayPairs] }),
            compute: { module: this.module, entryPoint: 'main', constants },
        });
    }

    /** The resolve pipeline of a detail tier, or null while it compiles. */
    pipelineFor(tier) {
        const key = tier?.pairs ? tier.detail : 'high';
        if (!(key in this.pipelines)) {
            this.pipelines[key] = null;
            this._compile(tier.pairs).then(pipeline => { this.pipelines[key] = pipeline; })
                .catch(error => console.warn('[clouds] ray pairs failed to compile', error));
        }
        return this.pipelines[key];
    }

    _buffer(label, size, usage) {
        return this.device.createBuffer({ label, size, usage });
    }

    _resize(width, height) {
        const key = `${width}x${height}`;
        if (this.size === key) return;
        this._release();
        this.size = key;
        this.groups = new WeakMap();
        this.textures = [['color', 'rgba16float'], ['depth', 'r32float']].map(([name, format]) => this.device.createTexture({
            label: `clouds ray pairs ${name}`, size: [Math.ceil(width / 2), height], format,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }));
        this.views = this.textures.map(texture => texture.createView());
        this.list = this._buffer('cloud ray list', HEADER_BYTES + 4 * width * height,
            GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    }

    _groupsFor(base, resources, banks, lookup) {
        let groups = this.groups.get(base);
        if (groups) return groups;
        const packed = resources.slice();
        packed.splice(8, 2, ...this.views);
        const list = { buffer: this.list };
        const perBank = (layout, inputs, ...extra) => banks.map((bank, i) =>
            this.host._group(layout, [...inputs, bank.view, banks[1 - i].view, lookup, ...extra]));
        groups = {
            check: perBank('raymarch', packed),
            list: perBank('raymarchList', resources, list),
            resolve: this.host._group('rayPairs', [resources[0], ...this.views, resources[10], resources[8], resources[9], list, resources[6]]),
        };
        this.groups.set(base, groups);
        return groups;
    }

    /** check and list are the raymarch pipelines for the two traced parts (list null: no second part), resolve fills in the rest. */
    dispatch(encoder, { check, list, resolve }, { base, resources, banks, lookup, bank, width, height }) {
        this._resize(width, height);
        const groups = this._groupsFor(base, resources, banks, lookup);
        const run = (name, pipeline, group, record) => {
            const label = `clouds ${name}`;
            const pass = encoder.beginComputePass({ label, timestampWrites: this.host.gpuTimer?.timestampWrites(label) });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            record(pass);
            pass.end();
        };
        encoder.copyBufferToBuffer(this.empty, 0, this.list, 0, HEADER_BYTES);
        run('raymarch', check, groups.check[bank],
            pass => pass.dispatchWorkgroups(Math.ceil(Math.ceil(width / 2) / 4), Math.ceil(height / 8)));
        run('ray pairs', resolve, groups.resolve,
            pass => pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16)));
        if (list) run('raymarch rest', list, groups.list[bank], pass => pass.dispatchWorkgroupsIndirect(this.list, 0));
    }

    _release() {
        for (const texture of this.textures ?? []) texture.destroy();
        this.list?.destroy();
    }

    dispose() {
        this._release();
        this.empty?.destroy();
    }
}
