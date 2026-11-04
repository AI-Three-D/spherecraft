import { compileShape } from './shapes.js';

/**
 * Editable 3D density field of a region.
 *
 * Samples sit on a lattice with `voxelSize` spacing; sample (i, j, k) is at
 * (minX + i * v, minY + j * v, minZ + k * v) in frame coordinates.
 * Density is in voxel units, positive = rock, clamped to +-densityRange and stored as int8.
 *
 * Untouched rock is not stored: its density is computed from the captured surface. A chunk of
 * chunkSize^3 samples is allocated the first time an edit changes one of its samples, initialised
 * with exactly the values the computed field had, so allocation never changes the field.
 *
 * Each chunk can also carry a water byte per sample (allocated on first write). Nothing here
 * simulates water; the channel is the place a simulation will write to.
 */
export class VoxelVolume {
    /**
     * @param {Object} options
     * @param {import('./CapturedHeightfield.js').CapturedHeightfield} options.surface
     * @param {number} options.minY @param {number} options.maxY vertical extent, frame metres
     * @param {number} [options.shell] samples at the sides and bottom that edits cannot touch
     */
    constructor({ surface, minY, maxY, voxelSize = 0.25, chunkSize = 32, densityRange = 2, shell = 4 }) {
        if (!(voxelSize > 0) || !(densityRange > 0)) throw new Error('VoxelVolume: voxelSize and densityRange must be positive');
        if (!Number.isInteger(chunkSize) || chunkSize < 2) throw new Error('VoxelVolume: chunkSize must be an integer >= 2');
        const cells = [(surface.maxX - surface.minX) / voxelSize, (maxY - minY) / voxelSize, (surface.maxZ - surface.minZ) / voxelSize];
        if (cells.some(n => !(n >= 1) || Math.abs(n - Math.round(n)) > 1e-6)) {
            throw new Error('VoxelVolume: the region extents must be whole multiples of voxelSize');
        }
        this.surface = surface;
        this.voxelSize = voxelSize;
        this.chunkSize = chunkSize;
        this.densityRange = densityRange;
        this.shell = shell;
        this.minX = surface.minX; this.maxX = surface.maxX;
        this.minY = minY; this.maxY = maxY;
        this.minZ = surface.minZ; this.maxZ = surface.maxZ;
        this.countX = Math.round(cells[0]) + 1;
        this.countY = Math.round(cells[1]) + 1;
        this.countZ = Math.round(cells[2]) + 1;
        this.chunksX = Math.ceil(this.countX / chunkSize);
        this.chunksY = Math.ceil(this.countY / chunkSize);
        this.chunksZ = Math.ceil(this.countZ / chunkSize);
        this.totalChunks = this.chunksX * this.chunksY * this.chunksZ;
        this.allocatedChunks = 0;
        /** Bumps on every density edit. */
        this.revision = 0;
        // Monotonic conservative flag: carving alone never raises the baseline.
        this.hasAdditions = false;
        this._scale = 127 / densityRange;
        this._chunks = new Array(this.totalChunks).fill(null);
        this._listeners = new Set();
        // Captured surface height per lattice column, in voxel units above minY.
        this._columns = new Float32Array(this.countX * this.countZ);
        for (let k = 0; k < this.countZ; k++) {
            const z = this.minZ + k * voxelSize;
            for (let i = 0; i < this.countX; i++) {
                this._columns[k * this.countX + i] = (surface.sample(this.minX + i * voxelSize, z) - minY) / voxelSize;
            }
        }
    }

    /** Called after every density edit with { mode, changed, min: [i, j, k], max: [i, j, k] } (inclusive). */
    subscribe(listener) {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    /** Bytes held by stored chunks. */
    get memoryBytes() {
        let bytes = 0;
        for (const chunk of this._chunks) if (chunk) bytes += chunk.density.byteLength + (chunk.water ? chunk.water.byteLength : 0);
        return bytes;
    }

    /** Stored chunk or null; for meshing and uploads. */
    chunkAt(cx, cy, cz) { return this._chunks[(cz * this.chunksY + cy) * this.chunksX + cx]; }

    /** Visit stored chunks for sparse uploads; borrowed arrays must not be modified. */
    forEachChunk(visitor) {
        for (const chunk of this._chunks) if (chunk) visitor(chunk);
    }

    /** Copy the procedural baseline in lattice units for GPU sampling. */
    copySurfaceColumns() { return this._columns.slice(); }

    /** Density the untouched ground has at a lattice sample, as int8. */
    _base(i, j, k) {
        const value = (this._columns[k * this.countX + i] - j) * this._scale;
        return value >= 127 ? 127 : value <= -127 ? -127 : Math.round(value) | 0;
    }

    /** Int8 density at a lattice sample (indices must be in range). */
    quantized(i, j, k) {
        const N = this.chunkSize;
        const cx = (i / N) | 0, cy = (j / N) | 0, cz = (k / N) | 0;
        const chunk = this._chunks[(cz * this.chunksY + cy) * this.chunksX + cx];
        if (chunk === null) return this._base(i, j, k);
        return chunk.density[((k - cz * N) * N + (j - cy * N)) * N + (i - cx * N)];
    }

    /** Density at a lattice sample in voxel units. */
    density(i, j, k) { return this.quantized(i, j, k) / this._scale; }

    /** Trilinear int8-scale density at a frame position, clamped to the volume. */
    sampleQuantized(x, y, z) {
        const inv = 1 / this.voxelSize;
        let fx = (x - this.minX) * inv, fy = (y - this.minY) * inv, fz = (z - this.minZ) * inv;
        fx = fx < 0 ? 0 : fx > this.countX - 1 ? this.countX - 1 : fx;
        fy = fy < 0 ? 0 : fy > this.countY - 1 ? this.countY - 1 : fy;
        fz = fz < 0 ? 0 : fz > this.countZ - 1 ? this.countZ - 1 : fz;
        const i = Math.min(Math.floor(fx), this.countX - 2);
        const j = Math.min(Math.floor(fy), this.countY - 2);
        const k = Math.min(Math.floor(fz), this.countZ - 2);
        const tx = fx - i, ty = fy - j, tz = fz - k;
        const a = this.quantized(i, j, k) * (1 - tx) + this.quantized(i + 1, j, k) * tx;
        const b = this.quantized(i, j + 1, k) * (1 - tx) + this.quantized(i + 1, j + 1, k) * tx;
        const c = this.quantized(i, j, k + 1) * (1 - tx) + this.quantized(i + 1, j, k + 1) * tx;
        const d = this.quantized(i, j + 1, k + 1) * (1 - tx) + this.quantized(i + 1, j + 1, k + 1) * tx;
        return (a * (1 - ty) + b * ty) * (1 - tz) + (c * (1 - ty) + d * ty) * tz;
    }

    /** Trilinear density at a frame position in voxel units; positive = rock. */
    sample(x, y, z) { return this.sampleQuantized(x, y, z) / this._scale; }

    isSolid(x, y, z) { return this.sampleQuantized(x, y, z) > 0; }

    /**
     * Apply an edit. 'carve' removes rock inside the shape, 'fill' adds it.
     * @param {{mode?: 'carve' | 'fill', shape: object}} op see shapes.js
     * @returns {{mode: string, changed: number, min: number[], max: number[]} | null} lattice bounds of changed samples
     */
    apply({ mode = 'carve', shape }) {
        if (mode !== 'carve' && mode !== 'fill') throw new Error(`VoxelVolume.apply: unknown mode ${mode}`);
        const compiled = compileShape(shape);
        const v = this.voxelSize, reach = this.densityRange * v, shell = this.shell;
        const i0 = Math.max(shell, Math.ceil((compiled.min[0] - reach - this.minX) / v));
        const i1 = Math.min(this.countX - 1 - shell, Math.floor((compiled.max[0] + reach - this.minX) / v));
        const j0 = Math.max(shell, Math.ceil((compiled.min[1] - reach - this.minY) / v));
        const j1 = Math.min(this.countY - 1, Math.floor((compiled.max[1] + reach - this.minY) / v));
        const k0 = Math.max(shell, Math.ceil((compiled.min[2] - reach - this.minZ) / v));
        const k1 = Math.min(this.countZ - 1 - shell, Math.floor((compiled.max[2] + reach - this.minZ) / v));
        const carve = mode === 'carve', sign = carve ? 1 : -1;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        let changed = 0;
        for (let k = k0; k <= k1; k++) {
            const z = this.minZ + k * v;
            for (let j = j0; j <= j1; j++) {
                const y = this.minY + j * v;
                for (let i = i0; i <= i1; i++) {
                    const value = sign * compiled.distance(this.minX + i * v, y, z) * this._scale / v;
                    const q = value >= 127 ? 127 : value <= -127 ? -127 : Math.round(value) | 0;
                    const current = this.quantized(i, j, k);
                    if (carve ? q >= current : q <= current) continue;
                    if (!carve && q > this._base(i,j,k)) this.hasAdditions = true;
                    this._store(i, j, k, q);
                    changed++;
                    if (i < min[0]) min[0] = i;
                    if (j < min[1]) min[1] = j;
                    if (k < min[2]) min[2] = k;
                    if (i > max[0]) max[0] = i;
                    if (j > max[1]) max[1] = j;
                    if (k > max[2]) max[2] = k;
                }
            }
        }
        if (!changed) return null;
        this.revision++;
        const result = { mode, changed, min, max };
        for (const listener of this._listeners) listener(result);
        return result;
    }

    /** Water level 0..255 at a lattice sample (0 where nothing was ever written). */
    water(i, j, k) {
        const N = this.chunkSize;
        const cx = (i / N) | 0, cy = (j / N) | 0, cz = (k / N) | 0;
        const chunk = this._chunks[(cz * this.chunksY + cy) * this.chunksX + cx];
        return chunk && chunk.water ? chunk.water[((k - cz * N) * N + (j - cy * N)) * N + (i - cx * N)] : 0;
    }

    setWater(i, j, k, level) {
        const N = this.chunkSize;
        const cx = (i / N) | 0, cy = (j / N) | 0, cz = (k / N) | 0;
        const index = (cz * this.chunksY + cy) * this.chunksX + cx;
        const chunk = this._chunks[index] ?? this._allocate(index, cx, cy, cz);
        if (!chunk.water) chunk.water = new Uint8Array(N * N * N);
        chunk.water[((k - cz * N) * N + (j - cy * N)) * N + (i - cx * N)] = level;
    }

    _store(i, j, k, q) {
        const N = this.chunkSize;
        const cx = (i / N) | 0, cy = (j / N) | 0, cz = (k / N) | 0;
        const index = (cz * this.chunksY + cy) * this.chunksX + cx;
        const chunk = this._chunks[index] ?? this._allocate(index, cx, cy, cz);
        chunk.density[((k - cz * N) * N + (j - cy * N)) * N + (i - cx * N)] = q;
        chunk.revision++;
    }

    _allocate(index, cx, cy, cz) {
        const N = this.chunkSize;
        const density = new Int8Array(N * N * N);
        for (let lk = 0; lk < N; lk++) {
            const k = cz * N + lk;
            if (k >= this.countZ) break;
            for (let lj = 0; lj < N; lj++) {
                const j = cy * N + lj;
                if (j >= this.countY) break;
                for (let li = 0; li < N; li++) {
                    const i = cx * N + li;
                    if (i >= this.countX) break;
                    density[(lk * N + lj) * N + li] = this._base(i, j, k);
                }
            }
        }
        const chunk = { cx, cy, cz, density, water: null, revision: 0 };
        this._chunks[index] = chunk;
        this.allocatedChunks++;
        return chunk;
    }
}
