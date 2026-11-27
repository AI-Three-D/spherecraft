// @ts-nocheck
// Slices of the grass field (terrainPass.wgsl.js, grassMedium.wgsl.js): the tile of our own blades (grassPortraits.js
// FIELD_BLADES_WGSL) cut into thin slabs standing on the ground, in two ways across, each slab drawn from its side at
// load. Past the blades drawn one by one, the terrain traces its sight line through a grid of these slices standing in
// the grass layer (after Habel, Wimmer and Jeschke, Instant Animated Grass, 2007; Boulanger's vertical slices): what a
// sight line meets is blades seen from the side, strands with their gaps, nearer ones hiding farther ones, at the place
// and height they stand, not a picture of the field laid flat on the ground.
//
// Each blade is drawn in one way of slices only (alternately), so a sight line crossing both meets it once. Colour is
// the blade's albedo times its height ramp, premultiplied by its cover; alpha is the cover. Mips are their box filter,
// down to the field's mean (the last level).

import { FIELD_BLADES_WGSL, FIELD_BLADE_COUNT, FIELD_MAX_HEIGHT, FIELD_SEGMENTS, PORTRAIT_PERIOD_M } from './grassPortraits.js';

/** Slabs per way across the tile (each SLICE_SPACING_M thick), texels along a slice and up it. */
export const SLICE_SPACING_M = 0.4;
export const SLICES_PER_WAY = Math.round(PORTRAIT_PERIOD_M / SLICE_SPACING_M);
export const SLICE_LAYERS = 2 * SLICES_PER_WAY;
export const SLICE_WIDTH = 512;
export const SLICE_HEIGHT = 128;
export const SLICE_PERIOD_M = PORTRAIT_PERIOD_M;
export const SLICE_HEIGHT_M = FIELD_MAX_HEIGHT;
const SAMPLES = 4;

const BAKE_WGSL = /* wgsl */`
struct Slab { way: f32, index: f32, pad0: f32, pad1: f32 };
@group(0) @binding(0) var<uniform> slab: Slab;
${FIELD_BLADES_WGSL}
const SPACING: f32 = ${SLICE_SPACING_M};
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) @interpolate(flat) colour: vec3<f32>,
    @location(1) t: f32,
};
@vertex
fn vsMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
    // Three copies along the slice: blades that cross the tile's edge show on both sides.
    let blade = instance / 3u;
    let copy = f32(instance % 3u) - 1.0;
    let b = fieldBlade(blade);
    let way = u32(slab.way);
    var out: Out;
    // In this way of slices, in this slab (by the root): else nothing drawn.
    let across = fract(select(b.root.x, b.root.y, way == 1u) / P) * P;
    let inSlab = u32(floor(across / SPACING)) == u32(slab.index) && (blade & 1u) == way;
    let level = min(vertex >> 1u, SEGS);
    let side = select(-1.0, 1.0, (vertex & 1u) == 1u);
    let t = f32(level) / f32(SEGS);
    let at = fieldBladeAt(b, t);
    // The blade's width as it shows across the slice: its face turned toward it (a blade seen edge-on is a thin line).
    let fdir = b.fdir;
    let sideways = vec2<f32>(-fdir.y, fdir.x);
    let xy = at.xy + sideways * (0.5 * at.w * side);
    let alongSlice = select(xy.y, xy.x, way == 1u) + copy * P;
    let depthAxis = select(xy.x, xy.y, way == 1u);
    out.clip = vec4<f32>(alongSlice / P * 2.0 - 1.0, at.z / MAXH * 2.0 - 1.0, saturate(fract(depthAxis / SPACING) * 0.98 + 0.01), 1.0);
    if (!inSlab) { out.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0); }
    out.colour = b.colour;
    out.t = t;
    return out;
}
@fragment
fn fsMain(in: Out) -> @location(0) vec4<f32> {
    // The blade's own ramp: darker low in it (grassWgsl.js fsMain).
    let ramp = mix(0.22, 1.0, pow(saturate(in.t), 1.15));
    return vec4<f32>(in.colour * ramp, 1.0);
}
`;

const MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var target0: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let n = vec2i(textureDimensions(source));
    let m = vec2i(textureDimensions(target0));
    if (any(vec2i(id.xy) >= m)) { return; }
    // Halved in each direction while it can be (the slices are wider than tall).
    let sx = select(1, 2, n.x > 1);
    let sy = select(1, 2, n.y > 1);
    let p = vec2i(id.xy) * vec2i(sx, sy);
    var sum = vec4f(0.0);
    for (var y = 0; y < sy; y++) { for (var x = 0; x < sx; x++) { sum += textureLoad(source, min(p + vec2i(x, y), n - 1), 0); } }
    textureStore(target0, id.xy, sum / f32(sx * sy));
}
`;

/** Renders the slices. Returns { texture, view, destroy }: a 2d-array, layer = way * SLICES_PER_WAY + slab. */
export async function createGrassSlices(device) {
    const mips = Math.log2(SLICE_WIDTH) + 1;
    const U = GPUTextureUsage;
    const texture = device.createTexture({
        label: 'Grass slices', size: [SLICE_WIDTH, SLICE_HEIGHT, SLICE_LAYERS], format: 'rgba16float', mipLevelCount: mips,
        usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.RENDER_ATTACHMENT | U.COPY_SRC,
    });
    const msaa = device.createTexture({ label: 'Grass slice samples', size: [SLICE_WIDTH, SLICE_HEIGHT], format: 'rgba16float', sampleCount: SAMPLES, usage: U.RENDER_ATTACHMENT });
    const depth = device.createTexture({ label: 'Grass slice depth', size: [SLICE_WIDTH, SLICE_HEIGHT], format: 'depth24plus', sampleCount: SAMPLES, usage: U.RENDER_ATTACHMENT });
    const module = device.createShaderModule({ label: 'Grass slices', code: BAKE_WGSL });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    const pipeline = await device.createRenderPipelineAsync({
        label: 'Grass slices', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: SAMPLES },
    });
    const mipModule = device.createShaderModule({ label: 'Grass slice mips', code: MIP_WGSL });
    const mipPipeline = await device.createComputePipelineAsync({ label: 'Grass slice mips', layout: 'auto', compute: { module: mipModule, entryPoint: 'main' } });
    const buffers = [];
    const encoder = device.createCommandEncoder({ label: 'Grass slices' });
    for (let layer = 0; layer < SLICE_LAYERS; layer++) {
        const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 0, new Float32Array([Math.floor(layer / SLICES_PER_WAY), layer % SLICES_PER_WAY, 0, 0]));
        buffers.push(uniform);
        const pass = encoder.beginRenderPass({
            label: `Grass slice ${layer}`,
            colorAttachments: [{
                view: msaa.createView(), resolveTarget: texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 }),
                clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard',
            }],
            depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] }));
        pass.draw((FIELD_SEGMENTS + 1) * 2, FIELD_BLADE_COUNT * 3);
        pass.end();
    }
    const levelView = (mip, layer) => texture.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
    const mipPass = encoder.beginComputePass({ label: 'Grass slice mips' });
    mipPass.setPipeline(mipPipeline);
    for (let layer = 0; layer < SLICE_LAYERS; layer++) {
        for (let mip = 1; mip < mips; mip++) {
            const w = Math.max(1, SLICE_WIDTH >> mip), h = Math.max(1, SLICE_HEIGHT >> mip);
            mipPass.setBindGroup(0, device.createBindGroup({ layout: mipPipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: levelView(mip - 1, layer) }, { binding: 1, resource: levelView(mip, layer) },
            ] }));
            mipPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        }
    }
    mipPass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    msaa.destroy();
    depth.destroy();
    for (const b of buffers) b.destroy();
    return { texture, view: texture.createView({ dimension: '2d-array' }), mips, destroy: () => texture.destroy() };
}
