import { RegionFrame } from './RegionFrame.js';

/**
 * Ground heights captured when a region is created.
 *
 * @typedef {Object} HeightfieldDescriptor
 * @property {{origin: object, up: object, heading: object} | RegionFrame} frame
 * @property {{x: number, z: number}} corner frame coordinates of sample (0, 0)
 * @property {number} spacing metres between samples
 * @property {number} countX samples along frame x (so the footprint is (countX - 1) * spacing wide)
 * @property {number} countZ samples along frame z
 * @property {Float32Array} heights metres along up, row by row: heights[iz * countX + ix]
 */
export class CapturedHeightfield {
    /** @param {HeightfieldDescriptor} descriptor */
    constructor(descriptor) {
        const { corner, spacing, countX, countZ, heights } = descriptor ?? {};
        if (!Number.isFinite(corner?.x) || !Number.isFinite(corner?.z)) throw new Error('CapturedHeightfield: corner must be finite');
        if (!(spacing > 0) || !Number.isFinite(spacing)) throw new Error('CapturedHeightfield: spacing must be positive');
        if (![countX, countZ].every(n => Number.isInteger(n) && n >= 2)) throw new Error('CapturedHeightfield: sample counts must be integers >= 2');
        if (!(heights instanceof Float32Array) || heights.length !== countX * countZ) {
            throw new Error('CapturedHeightfield: heights must be a Float32Array of countX * countZ samples');
        }
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < heights.length; i++) {
            const h = heights[i];
            if (!Number.isFinite(h)) throw new Error(`CapturedHeightfield: non-finite height at sample ${i}`);
            if (h < min) min = h;
            if (h > max) max = h;
        }
        this.frame = descriptor.frame instanceof RegionFrame ? descriptor.frame : new RegionFrame(descriptor.frame);
        this.spacing = spacing;
        this.countX = countX;
        this.countZ = countZ;
        this.heights = heights;
        this.minX = corner.x;
        this.minZ = corner.z;
        this.maxX = corner.x + (countX - 1) * spacing;
        this.maxZ = corner.z + (countZ - 1) * spacing;
        this.minHeight = min;
        this.maxHeight = max;
        Object.freeze(this);
    }

    /** Stored sample. */
    at(ix, iz) { return this.heights[iz * this.countX + ix]; }

    /**
     * Bilinear height at a frame position, clamped to the footprint.
     * Returns stored samples exactly at grid points, including the last row and column.
     */
    sample(x, z) {
        const cx = Math.min(Math.max((x - this.minX) / this.spacing, 0), this.countX - 1);
        const cz = Math.min(Math.max((z - this.minZ) / this.spacing, 0), this.countZ - 1);
        const ix = Math.min(Math.floor(cx), this.countX - 2);
        const iz = Math.min(Math.floor(cz), this.countZ - 2);
        const tx = cx - ix, tz = cz - iz;
        const h = this.heights, i = iz * this.countX + ix, j = i + this.countX;
        // a * (1 - t) + b * t (not a + (b - a) * t) so t = 0 and t = 1 reproduce the samples bit for bit.
        const near = h[i] * (1 - tx) + h[i + 1] * tx;
        const far = h[j] * (1 - tx) + h[j + 1] * tx;
        return near * (1 - tz) + far * tz;
    }
}