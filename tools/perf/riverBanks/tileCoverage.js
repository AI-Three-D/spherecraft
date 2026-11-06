// Compare resident tiles selected by current cell-based regeneration and the
// conservative field-page predicate, treating the current field as all changed.
import { tilesTouchingCells } from '../../../core/world/water/WaterGpuData.js';
import { tilesTouchingRiverFieldPages } from '../../../core/world/water/riverFieldTiles.js';
export function fieldTileCoverage() {
    const g = window.gameEngine, f = g.riverFieldService, streamer = g.renderer.quadtreeTileManager.tileStreamer;
    const keys = [...f.pages.keys()], cells = f._cellsOf(keys), size = streamer.tileGenerator.textureSize;
    const padding = f.generator._computeSplatPaddingTexels();
    const old = tilesTouchingCells(cells, g.waterGpuData.N), candidate = tilesTouchingRiverFieldPages(keys, f.layout, size, padding, old);
    let both = 0, oldOnly = 0, newOnly = 0, neither = 0;
    const added = [];
    for (const info of streamer._tileInfo.values()) {
        const args = [info.face, info.depth, info.x, info.y], a = old(...args), b = candidate(...args);
        if (a && b) both++; else if (a) oldOnly++; else if (b) { newOnly++; if (added.length < 10) added.push(args); } else neither++;
    }
    return { fieldPages: keys.length, residentTiles: streamer._tileInfo.size, textureSize: size, padding, both, oldOnly, newOnly, neither, added };
}
