// @ts-nocheck
import { buildLeanAirShader, buildLeanCompositeShader } from './shaders/cloudLeanComposite.wgsl.js';

/**
 * The composite of the lower detail tiers (cloudDetailTiers.js): the air in front of the clouds is added at cloud
 * resolution, and the cirrus is read from a smaller texture instead of being drawn over the whole screen.
 * Shares the uniforms and the haze and mist lookups of the CloudCompositePass it belongs to.
 */
export class CloudLeanComposite {
    constructor(device, colorFormat) {
        this.device = device;
        this.colorFormat = colorFormat;
        this._pipelines = {};
        this._groups = new Map();
        const texture = (sampleType, viewDimension = '2d') => ({ texture: { sampleType, viewDimension } });
        const uniform = { buffer: { type: 'uniform' } };
        const linear = { sampler: { type: 'filtering' } };
        const F = GPUShaderStage.FRAGMENT;
        const layout = (entries, visibility) => device.createBindGroupLayout({
            entries: Object.entries(entries).map(([binding, entry]) => ({ binding: Number(binding), visibility, ...entry })),
        });
        const rays = { 16: texture('float', '3d') };
        const air = {
            0: uniform, 1: uniform, 2: texture('float'), 3: texture('unfilterable-float'), 7: linear, 8: texture('float', '3d'),
            9: texture('float', '3d'), 10: texture('float'), 12: { storageTexture: { access: 'write-only', format: 'rgba16float' } },
        };
        const screen = {
            0: { ...uniform, visibility: F | GPUShaderStage.VERTEX }, 1: uniform, 4: texture('depth'), 6: texture('float'), 7: linear,
            8: texture('float'), 10: texture('float'),
        };
        const clouds = {
            ...screen, 2: texture('float'), 3: texture('unfilterable-float'), 5: texture('float'), 11: { sampler: { type: 'non-filtering' } },
            13: texture('float', '3d'), 14: uniform, 15: texture('float', '3d'),
        };
        // With and without god rays.
        this._airLayouts = [layout(air, GPUShaderStage.COMPUTE), layout({ ...air, ...rays }, GPUShaderStage.COMPUTE)];
        this._layouts = { cirrus: layout(screen, F), clouds: layout(clouds, F), cloudsWithRays: layout({ ...clouds, ...rays }, F) };
        this._pointSampler = device.createSampler();
        this._empty = device.createTexture({ label: 'no cirrus', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
        this._emptyView = this._empty.createView();
    }

    _airPipeline(rays) {
        return this._compile(`air${rays}`, () => this.device.createComputePipelineAsync({
            label: 'clouds air', layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._airLayouts[Number(rays)]] }),
            compute: { module: this.device.createShaderModule({ label: 'clouds air', code: buildLeanAirShader(rays) }), entryPoint: 'main' },
        }));
    }

    _compile(name, create) {
        if (name in this._pipelines) return this._pipelines[name];
        this._pipelines[name] = null;
        create().then(pipeline => { this._pipelines[name] = pipeline; })
            .catch(error => console.error('Lean cloud composite is unavailable', error));
        return null;
    }

    _screenPipeline(clouds, near, rays) {
        const kind = clouds ? rays ? 'cloudsWithRays' : 'clouds' : 'cirrus';
        return this._compile(`${kind}${near}`, () => {
            const module = this.device.createShaderModule({ label: `clouds lean composite ${kind}`, code: buildLeanCompositeShader(clouds, rays) });
            return this.device.createRenderPipelineAsync({
                label: `clouds lean composite ${kind}`,
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._layouts[kind]] }),
                vertex: { module, entryPoint: 'vsMain' },
                fragment: {
                    module, entryPoint: 'fsMain', constants: { CIRRUS_NEAR: near },
                    targets: [{
                        format: this.colorFormat,
                        blend: {
                            color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
                            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                        },
                    }],
                },
                primitive: { topology: 'triangle-list' },
            });
        });
    }

    /** The pipelines this frame needs, or null while they compile (the full composite then draws the frame). */
    ready(clouds, near, rays) {
        const screen = this._screenPipeline(clouds, near, rays);
        // The others come into use as the camera climbs.
        if (clouds) {
            for (const [otherNear, otherRays] of [[true, rays], [false, rays], [near, !rays], [!near, !rays]]) {
                this._screenPipeline(clouds, otherNear, otherRays);
                this._airPipeline(otherRays);
            }
        }
        return screen && (!clouds || this._airPipeline(rays)) ? screen : null;
    }

    _ensureTarget([width, height]) {
        if (this._target?.width === width && this._target.height === height) return;
        this._target?.destroy();
        this._target = this.device.createTexture({
            label: 'clouds with air', size: [width, height], format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._targetView = this._target.createView();
        this._groups.clear();
    }

    _group(key, layout, resources) {
        // Cloud history and cirrus targets alternate; a resize or a new scene target starts over.
        if (this._groups.size > 24) this._groups.clear();
        let entry = this._groups.get(key);
        const values = Object.values(resources);
        if (!entry || entry.values.some((value, i) => (value.buffer ?? value) !== (values[i].buffer ?? values[i]))) {
            entry = { values, group: this.device.createBindGroup({
                layout, entries: Object.entries(resources).map(([binding, resource]) => ({ binding: Number(binding), resource })),
            }) };
            this._groups.set(key, entry);
        }
        return entry.group;
    }

    /** local: mist and fog views and uniforms (CloudLocalVolumes). rayView: the volume of CloudGodRays, or null. lookups: compositeBuffer, hazeViews [radiance, transmittance, mist]. cirrus: far and near views, or null. */
    encode(encoder, screen, { out, clouds, colorView, depthView, width, height, compositeBuffer, hazeViews, cirrus, gpuTimer, local, rayView }) {
        const rays = rayView ? { 16: rayView } : {};
        const name = `${rayView ? 'rays' : ''}:${out.version}`;
        const common = { 0: { buffer: out.uniformBuffer }, 1: { buffer: compositeBuffer }, 7: out.linearSampler, 10: hazeViews[2] };
        if (clouds) {
            this._ensureTarget(out.size);
            const pass = encoder.beginComputePass({ label: 'clouds air', timestampWrites: gpuTimer?.timestampWrites('clouds air') });
            pass.setPipeline(this._airPipeline(!!rayView));
            pass.setBindGroup(0, this._group(`air${name}`, this._airLayouts[rayView ? 1 : 0], {
                ...common, ...rays, 2: out.colorView, 3: out.depthView, 8: hazeViews[0], 9: hazeViews[1], 12: this._targetView,
            }));
            pass.dispatchWorkgroups(Math.ceil(out.size[0] / 8), Math.ceil(out.size[1] / 8));
            pass.end();
        }
        const resources = {
            ...common, 4: depthView, 6: cirrus?.far ?? this._emptyView, 8: cirrus?.near ?? this._emptyView,
            ...(clouds ? { 2: this._targetView, 3: out.depthView, 5: out.shadowView, 11: this._pointSampler, 13: local.view, 14: { buffer: local.buffer }, 15: local.fogView, ...rays } : {}),
        };
        const pass = encoder.beginRenderPass({
            label: 'clouds composite',
            colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
            timestampWrites: gpuTimer?.timestampWrites('clouds composite'),
        });
        pass.setViewport(0, 0, width, height, 0, 1);
        pass.setPipeline(screen);
        pass.setBindGroup(0, this._group(`screen${name}`, this._layouts[clouds ? rayView ? 'cloudsWithRays' : 'clouds' : 'cirrus'], resources));
        pass.draw(3);
        pass.end();
    }

    dispose() {
        this._target?.destroy();
        this._empty.destroy();
        this._groups.clear();
    }
}
