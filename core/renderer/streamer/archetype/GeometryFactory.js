// js/renderer/streamer/archetype/GeometryFactory.js
//
// Dispatches archetype.geometryBuilder → actual builder function.
// Isolates AssetStreamer._buildGeometries from knowing every builder
// module.

import { AssetGeometryBuilder } from '../AssetGeometryBuilder.js';
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
     * @param {object} [ctx.builders]
     *        Template-provided geometry builder classes:
     *        { RockGeometryBuilder, FernGeometryBuilder,
     *          SansevieriaGeometryBuilder, MushroomGeometryBuilder,
     *          DeadwoodGeometryBuilder }
     * @returns {{positions, normals, uvs, indices, indexCount?}}
     */
    static build(builderKey, lod, ctx = {}) {
        const builders = ctx.builders || {};
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
                return builders.RockGeometryBuilder.buildRock(lod);

            case 'fern':
                return builders.FernGeometryBuilder.buildFern(lod);

            case 'sansevieria':
                return builders.SansevieriaGeometryBuilder.buildSansevieria(lod);

            case 'mushroom':
                return builders.MushroomGeometryBuilder.buildMushroom(lod);

            case 'log':
                return builders.DeadwoodGeometryBuilder.buildLog(lod);

            case 'stump':
                return builders.DeadwoodGeometryBuilder.buildStump(lod);

            default:
                Logger.warn(`${TAG} unknown builder "${builderKey}" — using empty mesh`);
                return EMPTY_MESH;
        }
    }
}
