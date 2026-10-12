// @ts-check
/** @typedef {import('../../renderer/terrain/contracts.js').HeightGrid} HeightGrid */

/** A finite terrain source with one draw, no planet, generator, streaming, or quadtree. */
export class HeightGridSource {
    /** @param {GPUDevice} device @param {HeightGrid} grid */
    constructor(device, grid) {
        this.device = device;
        this.grid = grid;
        this.maxGeomLOD = 0;
        this.indices = new Uint32Array(0);
        /** @type {GPUBuffer | null} */
        this.vertices = null;
        /** @type {GPUBuffer | null} */
        this.indirect = null;
        this.disposed = false;
    }

    initialize() {
        if (this.disposed) throw new Error('Height grid source is disposed');
        if (this.isReady()) return;
        const { width, height, spacing, origin, heights } = this.grid;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new Error('Height grid needs at least 2 x 2 samples');
        if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('Height grid spacing must be positive');
        if (heights.length !== width * height || !heights.every(Number.isFinite)) throw new Error('Height grid sample count and values must match its dimensions');
        if (![origin.x, origin.y, origin.z].every(Number.isFinite)) throw new Error('Height grid origin must be finite');

        const positions = new Float32Array(width * height * 3);
        for (let z = 0; z < height; z++) {
            for (let x = 0; x < width; x++) {
                const index = z * width + x;
                positions.set([origin.x + x * spacing, origin.y + heights[index], origin.z + z * spacing], index * 3);
            }
        }
        this.indices = new Uint32Array((width - 1) * (height - 1) * 6);
        let offset = 0;
        for (let z = 0; z < height - 1; z++) {
            for (let x = 0; x < width - 1; x++) {
                const a = z * width + x, b = a + 1, c = a + width, d = c + 1;
                this.indices.set([a, c, b, b, c, d], offset);
                offset += 6;
            }
        }
        this.vertices = this.device.createBuffer({ label: 'HeightGrid-Vertices', size: positions.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(this.vertices, 0, positions);
        this.indirect = this.device.createBuffer({ label: 'HeightGrid-Draw', size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([this.indices.length, 1, 0, 0, 0]));
    }

    isReady() { return !!this.vertices && !!this.indirect && !this.disposed; }

    /** The fixture's single vertex stream; a production source supplies chunk instances here. */
    getInstanceBuffer() {
        if (!this.vertices) throw new Error('Height grid source is not initialized');
        return this.vertices;
    }

    getIndirectArgsBuffer() {
        if (!this.indirect) throw new Error('Height grid source is not initialized');
        return this.indirect;
    }

    /** @param {number} lod */
    getIndirectArgsOffsetBytes(lod) {
        if (lod !== 0) throw new Error('Height grid source has only LOD 0');
        return 0;
    }

    getArrayTextures() { return {}; }

    /** @param {readonly number[]} counts */
    updateLodIndexCounts(counts) {
        if (counts.length !== 1 || counts[0] !== this.indices.length) throw new Error('Height grid index count must match its mesh');
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.vertices?.destroy();
        this.indirect?.destroy();
        this.vertices = null;
        this.indirect = null;
    }
}
