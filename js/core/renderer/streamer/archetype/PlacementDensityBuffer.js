// js/renderer/streamer/archetype/PlacementDensityBuffer.js
//
// Dense family × tile-type density multiplier LUT. Expands each
// PlacementFamily.perTileDensityScale (sparse {tileId → mul}) into a
// flat f32 storage buffer the scatter shader indexes directly:
//
//     mul = densityLUT[familyIndex * tileTypeCount + tileId]
//
// Absent entries default to 1.0 — so an empty/missing perTileDensityScale
// is a multiplicative no-op and keepProb is unchanged.
//
// STRIDE INVARIANT: tileTypeCount here == DENSITY_LUT_TILE_COUNT in the
// scatter shader. Both come from assetSelectionBuffer.maxTileType + 1, so
// they stay in lockstep. If a family's perTileDensityScale references a
// tile ID ≥ tileTypeCount, that entry is logged and dropped — it would
// never fire anyway (selectAsset rejects tile IDs > maxTileType before
// the LUT is ever reached).

import { Logger } from '../../../../shared/Logger.js';

export class PlacementDensityBuffer {
    /**
     * @param {GPUDevice} device
     * @param {import('./PlacementFamily.js').PlacementFamily[]} families
     *        Dense by index — registry validation guarantees no gaps.
     * @param {number} tileTypeCount
     *        maxTileType + 1. Row stride in the flat buffer.
     */
    constructor(device, families, tileTypeCount) {
        this.device        = device;
        this.tileTypeCount = tileTypeCount;
        // Row count from max index, not length — belt-and-suspenders in
        // case the registry ever allows sparse family indices.
        this.familyCount = families.length > 0
            ? Math.max(...families.map(f => f.index)) + 1
            : 1;  // never zero — keeps the buffer non-empty

        this._cpuData = this._build(families);
        this._buffer  = null;
    }

    _build(families) {
        const stride = this.tileTypeCount;
        const data   = new Float32Array(this.familyCount * stride).fill(1.0);

        let written = 0;
        for (const fam of families) {
            const scale = fam.perTileDensityScale;
            if (!scale) continue;                    // null or absent: all 1.0

            const rowBase = fam.index * stride;
            for (const key of Object.keys(scale)) {
                const tileId = Number(key);
                const mul    = Number(scale[key]);

                if (!Number.isInteger(tileId) || tileId < 0 || tileId >= stride) {
                    Logger.warn(
                        `[PlacementDensityBuffer] "${fam.name}" tile ${key} ` +
                        `out of range [0, ${stride}) — dropped`
                    );
                    continue;
                }
                if (!Number.isFinite(mul) || mul < 0) {
                    Logger.warn(
                        `[PlacementDensityBuffer] "${fam.name}" tile ${tileId} ` +
                        `multiplier ${scale[key]} invalid — dropped`
                    );
                    continue;
                }

                data[rowBase + tileId] = mul;
                written++;
            }
        }

        Logger.info(
            `[PlacementDensityBuffer] ${this.familyCount}×${stride} LUT ` +
            `(${(data.byteLength / 1024).toFixed(1)} KiB, ${written} overrides)`
        );
        return data;
    }

    upload() {
        this._buffer = this.device.createBuffer({
            label: 'PlacementDensityLUT',
            size:  Math.max(16, this._cpuData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._buffer, 0, this._cpuData);
    }

    getBuffer() { return this._buffer; }

    dispose() {
        this._buffer?.destroy();
        this._buffer = null;
    }
}