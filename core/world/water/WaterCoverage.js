// @ts-nocheck
// Which land can have lake or river water, as bits on the water index's own cube grid (N a face): the quadtree tile of
// depth log2 N is one cell, coarser tiles are its mips. For the terrain's draw list (terrainDrawList.wgsl.js), which
// draws the rest without the water shading. The sea is not in it: a tile's lowest ground tells.


const RIVER_BIT = 1 << 30;
const THIRD_LAKE_SHIFT = 17;
export const WATER_COVERAGE_LEVELS = 6;

/** Cells of a page of the river field, and 2 texels around it: [face, i0, j0, i1, j1]. */
export function riverPageCells(page, L, N) {
    const cell = t => {
        const u = (Math.tan((Math.min(1, Math.max(0, t / L.T)) * 2 - 1) * Math.PI / 4) + 1) * 0.5;
        return Math.min(N - 1, Math.max(0, Math.floor(u * N)));
    };
    return [page.face, cell(page.pi * L.P - 2), cell(page.pj * L.P - 2), cell((page.pi + 1) * L.P + 2), cell((page.pj + 1) * L.P + 2)];
}

/** One byte a cell, 1 where a lake is listed. index: WaterGpuData.index, cells: cells in all. */
export function lakeCellListed(index, cells, c) {
    return (index[c] & ~RIVER_BIT) !== 0 || (index[cells + c] >>> THIRD_LAKE_SHIFT) !== 0;
}

/** Halves a square of n x n bytes: set where any of four is. */
export function coarser(bytes, n) {
    const m = n >> 1, out = new Uint8Array(m * m);
    for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
            const a = 2 * j * n + 2 * i;
            out[j * m + i] = bytes[a] | bytes[a + 1] | bytes[a + n] | bytes[a + n + 1];
        }
    }
    return out;
}

export class WaterCoverage {
    constructor(device) {
        this.device = device;
        this.texture = null;
        this._lakes = null;
        this._pages = null;
    }

    /** Brings the texture up to date; true when there is something to read. water: WaterGpuData. */
    update(water) {
        if (!water?._ready || !Number.isInteger(Math.log2(water.N))) return false;
        const pages = water.riverField?.wetPages ?? null;
        if (this._water === water && this._version === water.coverageVersion && this._pages === pages) return !!this.texture;
        const N = water.N, cells = N * N;
        if (this._water !== water) {
            this.texture?.destroy();
            this.texture = this.device.createTexture({
                label: 'Water coverage', size: [N, N, 6], mipLevelCount: WATER_COVERAGE_LEVELS, format: 'r8uint',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.view = this.texture.createView({ dimension: '2d-array' });
            this._lakes = null;
        }
        const marks = new Map();
        for (const page of pages ?? []) {
            const [face, i0, j0, i1, j1] = riverPageCells(page, water.riverField.layout, N);
            if (!marks.has(face)) marks.set(face, []);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) marks.get(face).push(j * N + i);
        }
        const lakesChanged = !this._lakes || this._version !== water.coverageVersion;
        this._lakes ??= Array.from({ length: 6 }, () => new Uint8Array(cells));
        for (let face = 0; face < 6; face++) {
            const lakes = this._lakes[face];
            let changed = lakesChanged && this._readLakes(water, face);
            changed ||= marks.has(face) || this._marked?.has(face) || this._fresh !== water;
            if (!changed) continue;
            const bytes = lakes.slice();
            for (const c of marks.get(face) ?? []) bytes[c] = 1;
            this._write(face, bytes, N);
        }
        this._marked = marks;
        Object.assign(this, { _water: water, _version: water.coverageVersion, _pages: pages, _fresh: water });
        return true;
    }

    _readLakes(water, face) {
        const N = water.N, at = face * N * N, lakes = this._lakes[face];
        let changed = false;
        for (let c = 0; c < N * N; c++) {
            const bit = lakeCellListed(water.index, water.cells, at + c) ? 1 : 0;
            if (lakes[c] !== bit) { lakes[c] = bit; changed = true; }
        }
        return changed;
    }

    _write(face, bytes, N) {
        for (let level = 0, n = N; level < WATER_COVERAGE_LEVELS; level++, n >>= 1) {
            this.device.queue.writeTexture({ texture: this.texture, mipLevel: level, origin: [0, 0, face] }, bytes, { bytesPerRow: n, rowsPerImage: n }, [n, n, 1]);
            if (level + 1 < WATER_COVERAGE_LEVELS) bytes = coarser(bytes, n);
        }
    }

    destroy() {
        this.texture?.destroy();
        this.texture = null;
    }
}

