export class MipmapGenerator {
    constructor(device) {
        this.device = device;
        this._pipelines = new Map();   // format → GPURenderPipeline
        this._sampler = device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear'
        });
        this._shaderModule = device.createShaderModule({
            label: 'MipmapGenerator',
            code: `
                struct VOut {
                    @builtin(position) pos: vec4<f32>,
                    @location(0) uv: vec2<f32>,
                };
                @vertex
                fn vs(@builtin(vertex_index) vi: u32) -> VOut {
                    // Fullscreen triangle
                    var p = array<vec2<f32>, 3>(
                        vec2<f32>(-1.0, -1.0),
                        vec2<f32>( 3.0, -1.0),
                        vec2<f32>(-1.0,  3.0)
                    );
                    var out: VOut;
                    out.pos = vec4<f32>(p[vi], 0.0, 1.0);
                    // Map clip [-1,1] → uv [0,1]; no Y flip needed because
                    // both source and dest are the same texture — any flip
                    // would compound across mip levels.
                    out.uv = p[vi] * 0.5 + 0.5;
                    return out;
                }
                @group(0) @binding(0) var src: texture_2d<f32>;
                @group(0) @binding(1) var samp: sampler;
                @fragment
                fn fs(in: VOut) -> @location(0) vec4<f32> {
                    return textureSample(src, samp, in.uv);
                }
            `
        });
    }

    _getPipeline(format) {
        let p = this._pipelines.get(format);
        if (p) return p;
        p = this.device.createRenderPipeline({
            label: `MipmapGenerator-${format}`,
            layout: 'auto',
            vertex:   { module: this._shaderModule, entryPoint: 'vs' },
            fragment: { module: this._shaderModule, entryPoint: 'fs',
                        targets: [{ format }] },
            primitive: { topology: 'triangle-list' }
        });
        this._pipelines.set(format, p);
        return p;
    }

    // Generate mips for the given layers of a texture_2d_array.
    // encoder: caller-owned; this method only records passes.
    generateArrayLayers(encoder, texture, format, layers, mipLevelCount) {
        const pipeline = this._getPipeline(format);
        const bgl = pipeline.getBindGroupLayout(0);

        for (const layer of layers) {
            // Blit mip N → mip N+1 down the chain for this layer only.
            for (let mip = 1; mip < mipLevelCount; mip++) {
                const srcView = texture.createView({
                    dimension: '2d',
                    baseArrayLayer: layer, arrayLayerCount: 1,
                    baseMipLevel: mip - 1, mipLevelCount: 1
                });
                const dstView = texture.createView({
                    dimension: '2d',
                    baseArrayLayer: layer, arrayLayerCount: 1,
                    baseMipLevel: mip, mipLevelCount: 1
                });
                const bg = this.device.createBindGroup({
                    layout: bgl,
                    entries: [
                        { binding: 0, resource: srcView },
                        { binding: 1, resource: this._sampler }
                    ]
                });
                const pass = encoder.beginRenderPass({
                    colorAttachments: [{
                        view: dstView,
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: { r: 0, g: 0, b: 0, a: 0 }
                    }]
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bg);
                pass.draw(3);
                pass.end();
            }
        }
    }
}