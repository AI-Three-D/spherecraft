// js/renderer/streamer/archetype/GeometryFactory.js
//
// Dispatches archetype.geometryBuilder → actual builder function.
// Isolates AssetStreamer._buildGeometries from knowing every builder
// module.

import { AssetGeometryBuilder } from '../AssetGeometryBuilder.js';
import { RockGeometryBuilder } from './geometry/RockGeometryBuilder.js';
import { FernGeometryBuilder } from './geometry/FernGeometryBuilder.js';
import { SansevieriaGeometryBuilder } from './geometry/SansevieriaGeometryBuilder.js';
import { MushroomGeometryBuilder } from './geometry/MushroomGeometryBuilder.js';
import { DeadwoodGeometryBuilder } from './geometry/DeadwoodGeometryBuilder.js';
import { Logger } from '../../../../shared/Logger.js';

const TAG = '[GeometryFactory]';

// One degenerate triangle. Never actually rasterized (instance count is 0
// for inactive archetypes), but the band needs a valid index buffer for
// the indirect-args builder to write an indexCount into.
const EMPTY_MESH = Object.freeze({
    positions: new Float32Array([0, 0, 0,  0, 0, 0,  0, 0, 0]),
    normals:   new Float32Array([0, 1, 0,  0, 1, 0,  0, 1, 0]),
    uvs:       new Float32Array([0, 0,  0, 0,  0, 0]),
    indices:   new Uint16Array([0, 1, 2]),
});

export class GeometryFactory {
    /**
     * @param {string} builderKey  — archetype.geometryBuilder
     * @param {number} lod         — 0..lodCount-1
     * @param {object} [ctx]       — per-run context
     * @param {object[]} [ctx.treeLODs]
     *        Precomputed tree LODs from TreeTrunkGeometryBuilder. Tree
     *        geometry depends on the template library (seeded, per-run)
     *        so it can't be a static import — AssetStreamer builds it
     *        once in _buildGeometries and hands it in.
     * @returns {{positions, normals, uvs, indices, indexCount?}}
     */
    static build(builderKey, lod, ctx = {}) {
        switch (builderKey) {
            case 'tree':
                // Tree scatter-draw is suppressed anyway, but build it so
                // band index-count is nonzero (tree sub-systems read from
                // tree bands, not this geometry, but consistency matters).
                return ctx.treeLODs?.[lod] ?? AssetGeometryBuilder.buildTree(lod);

            case 'grass':
                // Legacy name for this is buildPlant — it IS the grass tuft.
                return AssetGeometryBuilder.buildPlant(lod);

            // ── Inc 3: new asset geometry ──────────────────────────────
            case 'rock':
                return RockGeometryBuilder.buildRock(lod);

            case 'fern':
                return FernGeometryBuilder.buildFern(lod);

            case 'sansevieria':
                return SansevieriaGeometryBuilder.buildSansevieria(lod);

            case 'mushroom':
                return MushroomGeometryBuilder.buildMushroom(lod);

            case 'log':
                return DeadwoodGeometryBuilder.buildLog(lod);

            case 'stump':
                return DeadwoodGeometryBuilder.buildStump(lod);

            default:
                Logger.warn(`${TAG} unknown builder "${builderKey}" — using empty mesh`);
                return EMPTY_MESH;
        }
    }
}
