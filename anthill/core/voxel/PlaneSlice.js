const clampInt = (value, min, max) => (value < min ? min : value > max ? max : value);

/**
 * Density of a VoxelVolume sampled on the cut plane, for drawing the cut face.
 *
 * This is a view product derived from the 3D volume; nothing is stored or edited here.
 * One grid per detail level: texel size = voxelSize * 2^level, texel (a, b) sits at plane
 * coordinates (s0 + a * texel, y0 + b * texel), and covers the whole rectangle where the plane
 * crosses the region. Tiles are sampled the first time the view needs them; edits re-sample only
 * the texels they can affect. Values are uint8: int8 density + 128.
 *
 * `epoch` bumps when the plane moves (all grids are dropped); each grid's `revision` bumps when
 * its data changes.
 */
export class PlaneSlice {
    constructor({ volume, plane, maxLevel = 3, tileSize = 64 }) {
        this.volume = volume;
        this.plane = plane;
        this.maxLevel = maxLevel;
        this.tileSize = tileSize;
        this.epoch = 0;
        /** [s0, s1] where the plane crosses the region, or null. Valid after ensure(). */
        this.span = null;
        this._planeRevision = -1;
        this._levels = [];
        this._unsubscribe = volume.subscribe(edit => this._onEdit(edit));
    }

    dispose() { this._unsubscribe(); }

    /** Detail level for a zoom: the coarsest grid whose texels stay within about two pixels. */
    levelFor(metersPerPixel) {
        if (!(metersPerPixel > 0) || !Number.isFinite(metersPerPixel)) throw new RangeError('PlaneSlice: zoom must be finite and positive');
        // The projection scale is float32. Its rounding can move the recovered zoom
        // by up to 2^-24 relative to a threshold; a double-precision epsilon is too small.
        const ratio = 2 * metersPerPixel / this.volume.voxelSize;
        const level = Math.floor(Math.log2(ratio * (1 + 2 ** -23)));
        return clampInt(level, 0, this.maxLevel);
    }

    /**
     * Grid for `level` with every tile touching the given plane rectangle sampled.
     * @returns {{level: number, texel: number, s0: number, y0: number, width: number, height: number,
     *            data: Uint8Array, revision: number, tilesBuilt: number} | null} null if the plane misses the region
     */
    ensure(level, sMin, sMax, yLow, yHigh) {
        this._sync();
        if (!this.span) return null;
        if (!Number.isInteger(level) || level <= -1 || level > this.maxLevel) throw new RangeError(`PlaneSlice: no level ${level}`);
        const cut = this._levels[level] ?? (this._levels[level] = this._create(level));
        const T = this.tileSize;
        const a0 = clampInt(Math.floor((sMin - cut.s0) / cut.texel) - 1, 0, cut.width - 1);
        const a1 = clampInt(Math.ceil((sMax - cut.s0) / cut.texel) + 1, 0, cut.width - 1);
        const b0 = clampInt(Math.floor((yLow - cut.y0) / cut.texel) - 1, 0, cut.height - 1);
        const b1 = clampInt(Math.ceil((yHigh - cut.y0) / cut.texel) + 1, 0, cut.height - 1);
        for (let ty = Math.floor(b0 / T); ty <= Math.floor(b1 / T); ty++) {
            for (let tx = Math.floor(a0 / T); tx <= Math.floor(a1 / T); tx++) {
                const index = ty * cut.tilesX + tx;
                if (cut.built[index]) continue;
                this._fill(cut, tx * T, Math.min(cut.width - 1, tx * T + T - 1), ty * T, Math.min(cut.height - 1, ty * T + T - 1));
                cut.built[index] = 1;
                cut.tilesBuilt++;
                cut.revision++;
            }
        }
        return cut;
    }

    _sync() {
        if (this._planeRevision === this.plane.revision) return;
        const v = this.volume;
        this._planeRevision = this.plane.revision;
        this.epoch++;
        this._levels = [];
        this.span = this.plane.clipToRect(v.minX, v.minZ, v.maxX, v.maxZ);
    }

    _create(level) {
        const v = this.volume, texel = v.voxelSize * 2 ** level, T = this.tileSize;
        const [s0, s1] = this.span;
        const width = Math.max(2, Math.ceil((s1 - s0) / texel - 1e-9) + 1);
        const height = Math.max(2, Math.ceil((v.maxY - v.minY) / texel - 1e-9) + 1);
        const tilesX = Math.ceil(width / T), tilesY = Math.ceil(height / T);
        return {
            level, texel, s0, s1, y0: v.minY, y1: v.maxY, width, height,
            data: new Uint8Array(width * height),
            tilesX, tilesY, built: new Uint8Array(tilesX * tilesY), tilesBuilt: 0, revision: 0,
        };
    }

    _fill(cut, a0, a1, b0, b1) {
        const { volume, plane } = this;
        for (let b = b0; b <= b1; b++) {
            const y = Math.min(cut.y0 + b * cut.texel, cut.y1);
            for (let a = a0; a <= a1; a++) {
                const s = Math.min(cut.s0 + a * cut.texel, cut.s1);
                cut.data[b * cut.width + a] = Math.round(volume.sampleQuantized(plane.x(s), y, plane.z(s))) + 128;
            }
        }
    }

    _onEdit(edit) {
        if (this._planeRevision !== this.plane.revision || !this.span) return;      // next ensure() rebuilds anyway
        const { volume: vol, plane } = this;
        const v = vol.voxelSize;
        // A changed sample influences trilinear lookups one voxel to either side.
        const x0 = vol.minX + (edit.min[0] - 1) * v, x1 = vol.minX + (edit.max[0] + 1) * v;
        const y0 = vol.minY + (edit.min[1] - 1) * v, y1 = vol.minY + (edit.max[1] + 1) * v;
        const z0 = vol.minZ + (edit.min[2] - 1) * v, z1 = vol.minZ + (edit.max[2] + 1) * v;
        let sLow = Infinity, sHigh = -Infinity, dLow = Infinity, dHigh = -Infinity;
        for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
            const hit = plane.project(x, z);
            sLow = Math.min(sLow, hit.s);
            sHigh = Math.max(sHigh, hit.s);
            dLow = Math.min(dLow, hit.distance);
            dHigh = Math.max(dHigh, hit.distance);
        }
        if (dLow > 0 || dHigh < 0) return;                                          // the edit does not reach the plane
        for (const cut of this._levels) {
            if (!cut) continue;
            const a0 = clampInt(Math.floor((sLow - cut.s0) / cut.texel) - 1, 0, cut.width - 1);
            const a1 = clampInt(Math.ceil((sHigh - cut.s0) / cut.texel) + 1, 0, cut.width - 1);
            const b0 = clampInt(Math.floor((y0 - cut.y0) / cut.texel) - 1, 0, cut.height - 1);
            const b1 = clampInt(Math.ceil((y1 - cut.y0) / cut.texel) + 1, 0, cut.height - 1);
            this._fill(cut, a0, a1, b0, b1);
            cut.revision++;
        }
    }
}
