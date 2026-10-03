// js/world/quadtree/tileVisibilityIndex.js
//
// Integer tile keys and a per-readback index of what the camera can see.
//
// TileStreamer asks "is this tile visible, an ancestor of a visible tile, or a
// descendant of one?" for every generation start, every dequeued refinement
// and (before this index) for every parked refinement on every frame. The old
// answer scanned the whole visible list with an ancestor walk per entry, so a
// question cost O(visible × depth) and the per-frame retry scan cost
// O(parked × visible × depth). The index is rebuilt once per visibility
// readback in O(visible + unique ancestors) and answers each question with
// at most depth + 2 set lookups.

// face < 8, depth < 32, x and y < 65536: the key stays below 2^40, so it is an
// exact integer in a double and a fast Set/Map key.
export function tileNumKey(face, depth, x, y) {
    return ((face * 32 + depth) * 65536 + y) * 65536 + x;
}

// Shared, frozen results: callers only read .relevant / .reason.
export const TILE_DEMAND_UNKNOWN = Object.freeze({ relevant: true, reason: 'unknown' });
export const TILE_DEMAND_VISIBLE = Object.freeze({ relevant: true, reason: 'visible' });
export const TILE_DEMAND_ANCESTOR = Object.freeze({ relevant: true, reason: 'ancestor' });
export const TILE_DEMAND_DESCENDANT = Object.freeze({ relevant: true, reason: 'descendant' });
export const TILE_DEMAND_STALE = Object.freeze({ relevant: false, reason: 'stale' });

export class TileVisibilityIndex {
    constructor() {
        this.visible = new Set();     // keys of the visible tiles
        this.ancestors = new Set();   // keys of every strict ancestor of a visible tile
        this.ready = false;           // false until the first readback
    }

    clear() {
        this.visible.clear();
        this.ancestors.clear();
        this.ready = false;
    }

    // tiles: [{ face, depth, x, y }] from the visibility readback.
    rebuild(tiles) {
        this.visible.clear();
        this.ancestors.clear();
        for (const tile of tiles) {
            this.visible.add(tileNumKey(tile.face, tile.depth, tile.x, tile.y));
        }
        for (const tile of tiles) {
            let depth = tile.depth;
            let x = tile.x;
            let y = tile.y;
            while (depth > 0) {
                depth--;
                x >>= 1;
                y >>= 1;
                const key = tileNumKey(tile.face, depth, x, y);
                // A chain is added up to the root the first time any of its
                // tiles is reached, so an ancestor already in the set means
                // the rest of this chain is too.
                if (this.ancestors.has(key)) break;
                this.ancestors.add(key);
            }
        }
        this.ready = true;
    }

    // Same answers as the visible-list scan it replaces
    // (TileStreamer._describeTileDemandStateScan):
    //   visible    — the tile itself is in the readback
    //   ancestor   — a visible tile lies inside it
    //   descendant — it lies inside a visible tile
    //   stale      — none of the above
    //   unknown    — no readback has arrived yet (treated as relevant)
    describe(face, depth, x, y) {
        if (!this.ready) return TILE_DEMAND_UNKNOWN;
        const key = tileNumKey(face, depth, x, y);
        if (this.visible.has(key)) return TILE_DEMAND_VISIBLE;
        if (this.ancestors.has(key)) return TILE_DEMAND_ANCESTOR;
        let d = depth;
        let px = x;
        let py = y;
        while (d > 0) {
            d--;
            px >>= 1;
            py >>= 1;
            if (this.visible.has(tileNumKey(face, d, px, py))) return TILE_DEMAND_DESCENDANT;
        }
        return TILE_DEMAND_STALE;
    }
}
