// @ts-nocheck
// Height range of every tile layer in the pool, for culling (terrainDrawList.wgsl.js). Made on the GPU in the command
// buffer that copies a tile's heights, so it is never behind them.

export const TILE_BOUNDS_FLOATS = 4;
/** Blocks along a tile whose lowest ground is kept too: what surely hides things behind it. */
export const TILE_BLOCKS = 8;
const UNKNOWN = '1.0e9';

/** One workgroup a layer: 128 rows, then their smallest and largest, then the blocks'. */
export function buildTileBoundsWGSL(tileSize) {
    const rows = 128;
    const B = TILE_BLOCKS;
    return /* wgsl */`
struct Info { heightScale: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> layers: array<u32>;
@group(0) @binding(2) var heights: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> bounds: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> blocks: array<f32>;
var<workgroup> rowRange: array<vec2<f32>, ${rows}>;
var<workgroup> rowLow: array<f32, ${rows * B}>;
const SIZE: i32 = ${tileSize};
const BLOCK: i32 = ${tileSize / B};
@compute @workgroup_size(${rows})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) thread: u32) {
    let layer = i32(layers[group.x]);
    var range = vec2<f32>(${UNKNOWN}, -${UNKNOWN});
    for (var b = 0u; b < ${B}u; b++) { rowLow[thread * ${B}u + b] = ${UNKNOWN}; }
    for (var y = i32(thread); y < SIZE; y += ${rows}) {
        for (var x = 0; x < SIZE; x++) {
            let h = textureLoad(heights, vec2<i32>(x, y), layer, 0).r;
            range = vec2<f32>(min(range.x, h), max(range.y, h));
            // A mesh's vertices lie between texels: each counts for the block beside it as well.
            for (var b = max((x - 1) / BLOCK, 0); b <= min((x + 1) / BLOCK, ${B - 1}); b++) {
                let at = thread * ${B}u + u32(b);
                rowLow[at] = min(rowLow[at], h);
            }
        }
    }
    rowRange[thread] = range;
    workgroupBarrier();
    if (thread == 0u) {
        for (var i = 1; i < ${rows}; i++) {
            range = vec2<f32>(min(range.x, rowRange[i].x), max(range.y, rowRange[i].y));
        }
        bounds[layer] = vec4<f32>(range * info.heightScale, 0.0, 1.0);
    }
    if (thread < ${B * B}u) {
        let column = thread % ${B}u;
        let first = i32(thread / ${B}u) * BLOCK;
        var low = ${UNKNOWN};
        for (var y = max(first - 1, 0); y <= min(first + BLOCK, SIZE - 1); y++) { low = min(low, rowLow[(u32(y) % ${rows}u) * ${B}u + column]); }
        blocks[u32(layer) * ${B * B}u + thread] = low * info.heightScale;
    }
}
`;
}

export class TileBounds {
    /** heights: the pool's height texture array. heightScale: metres per unit of it. */
    constructor(device, { heights, tileSize, capacity, heightScale }) {
        this.device = device;
        /** vec4 a layer: lowest, highest (m), unused, 1 when known. */
        this.buffer = device.createBuffer({
            label: 'Tile bounds', size: capacity * TILE_BOUNDS_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        /** Lowest ground (m) of the blocks of a layer, row by row. */
        this.blocks = device.createBuffer({ label: 'Tile blocks', size: capacity * TILE_BLOCKS * TILE_BLOCKS * 4, usage: GPUBufferUsage.STORAGE });
        this._info = device.createBuffer({ label: 'Tile bounds info', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(this._info, 0, new Float32Array([heightScale, 0, 0, 0]));
        const module = device.createShaderModule({ label: 'Tile bounds', code: buildTileBoundsWGSL(tileSize) });
        const C = GPUShaderStage.COMPUTE;
        this._layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: C, buffer: { type: 'uniform' } },
            { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
            { binding: 3, visibility: C, buffer: { type: 'storage' } },
            { binding: 4, visibility: C, buffer: { type: 'storage' } },
        ] });
        this._pipeline = device.createComputePipeline({
            label: 'Tile bounds', layout: device.createPipelineLayout({ bindGroupLayouts: [this._layout] }), compute: { module, entryPoint: 'main' },
        });
        this._view = heights.createView({ dimension: '2d-array' });
        this._lists = [];
        this._next = 0;
    }

    /** After the copies of these layers' heights, in the same encoder. */
    encode(encoder, layers) {
        if (!layers.length) return;
        const list = new Uint32Array(layers);
        // A list is read when its command buffer runs, so each has a buffer of its own.
        const buffer = this.device.createBuffer({ label: 'Tile bounds layers', size: list.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
        new Uint32Array(buffer.getMappedRange()).set(list);
        buffer.unmap();
        const group = this.device.createBindGroup({ layout: this._layout, entries: [
            { binding: 0, resource: { buffer: this._info } }, { binding: 1, resource: { buffer } },
            { binding: 2, resource: this._view }, { binding: 3, resource: { buffer: this.buffer } },
            { binding: 4, resource: { buffer: this.blocks } },
        ] });
        const pass = encoder.beginComputePass({ label: 'Tile bounds' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(layers.length);
        pass.end();
        this._lists.push(buffer);
    }

    /** Once the encoder of the last encode() has been submitted. */
    submitted() {
        for (const buffer of this._lists) buffer.destroy();
        this._lists.length = 0;
    }

    destroy() {
        this.buffer.destroy();
        this.blocks.destroy();
        this._info.destroy();
        this.submitted();
    }
}
