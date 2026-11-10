// js/world/quadtree/TileAddress.js
// Core spatial addressing for the GPU quadtree tile system.
//
// A TileAddress identifies a single node in the implicit quadtree over a cube face.
// At depth D, the face is divided into a (2^D × 2^D) grid of tiles.
// Depth 0 = the entire face. Increasing depth = finer subdivision.
//
// One quadtree leaf = one tile = one generated texture.
// The texture resolution is constant (e.g. 1024×1024); the tile's world-space
// footprint shrinks with depth, so texel density increases.
//
// Design notes (for downstream traversal shader):
//   - Parallel traversal will use cooperative workgroups sharing a BFS work queue
//     via atomic counters + a global node buffer, rather than per-workgroup stacks.
//     TileAddress itself is agnostic to traversal strategy.
//   - Camera-relative math for distance/culling decisions should be applied in the
//     shader, not here. This class is pure geometry on the cube face.

export class TileAddress {
    /**
     * @param {number} face  Cube face index 0–5
     * @param {number} depth Quadtree depth (0 = full face, higher = finer)
     * @param {number} x     Tile X within the (2^depth × 2^depth) grid
     * @param {number} y     Tile Y within the (2^depth × 2^depth) grid
     */
    constructor(face, depth, x, y) {
        if (!Number.isInteger(face) || face < 0 || face > 5) {
            throw new Error(`TileAddress: face must be integer 0–5, got ${face}`);
        }
        if (!Number.isInteger(depth) || depth < 0) {
            throw new Error(`TileAddress: depth must be non-negative integer, got ${depth}`);
        }
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            throw new Error(`TileAddress: x and y must be integers, got x=${x} y=${y}`);
        }

        const gs = 1 << depth;
        if (x < 0 || x >= gs || y < 0 || y >= gs) {
            throw new RangeError(
                `TileAddress: (${x},${y}) out of range [0,${gs}) for depth ${depth}`
            );
        }

        this.face  = face;
        this.depth = depth;
        this.x     = x;
        this.y     = y;
    }

    // ─── Grid geometry ────────────────────────────────────────────────────────

    /** Number of tiles per face side at this depth: 2^depth */
    get gridSize() {
        return 1 << this.depth;
    }

    /** Minimum face-UV corner (inclusive) as { x, y } in [0,1] */
    get faceUVMin() {
        const gs = this.gridSize;
        return { x: this.x / gs, y: this.y / gs };
    }

    /** Maximum face-UV corner (exclusive) as { x, y } in [0,1] */
    get faceUVMax() {
        const gs = this.gridSize;
        return { x: (this.x + 1) / gs, y: (this.y + 1) / gs };
    }

    /**
     * World-space side length of this tile.
     * @param {number} faceSize  Side length of one cube face in world units
     *                            (typically 2 × planetRadius)
     * @returns {number} Tile side in the same units
     */
    worldSize(faceSize) {
        return faceSize / this.gridSize;
    }

    // ─── Hierarchy ────────────────────────────────────────────────────────────

    /**
     * Four children at depth + 1, ordered (even-x,even-y), (odd-x,even-y),
     * (even-x,odd-y), (odd-x,odd-y).
     * @returns {TileAddress[]}
     */
    get children() {
        const d  = this.depth + 1;
        const x2 = this.x << 1;
        const y2 = this.y << 1;
        return [
            new TileAddress(this.face, d, x2,     y2),
            new TileAddress(this.face, d, x2 + 1, y2),
            new TileAddress(this.face, d, x2,     y2 + 1),
            new TileAddress(this.face, d, x2 + 1, y2 + 1)
        ];
    }

    /**
     * Parent tile at depth − 1, or null when already at the root.
     * @returns {TileAddress|null}
     */
    get parent() {
        if (this.depth === 0) return null;
        return new TileAddress(this.face, this.depth - 1, this.x >> 1, this.y >> 1);
    }

    // ─── Spatial queries ──────────────────────────────────────────────────────

    /**
     * Does this tile contain the given face-UV point?
     * @param {{ x: number, y: number }} faceUV  Point in [0,1]²
     * @returns {boolean}
     */
    containsPoint(faceUV) {
        const min = this.faceUVMin;
        const max = this.faceUVMax;
        return faceUV.x >= min.x && faceUV.x < max.x &&
               faceUV.y >= min.y && faceUV.y < max.y;
    }

    /**
     * Four cardinal neighbors at the same depth, wrapping across cube-face
     * edges when necessary.
     * @returns {TileAddress[]}  Length 4 (some entries may be absent if wrapping
     *                            fails at a corner — extremely rare with valid cubes)
     */
    getNeighbors() {
        const gs = this.gridSize;
        const offsets = [
            { dx: -1, dy:  0 },  // left
            { dx:  1, dy:  0 },  // right
            { dx:  0, dy: -1 },  // down
            { dx:  0, dy:  1 }   // up
        ];

        const neighbors = [];
        for (const { dx, dy } of offsets) {
            const nx = this.x + dx;
            const ny = this.y + dy;

            if (nx >= 0 && nx < gs && ny >= 0 && ny < gs) {
                neighbors.push(new TileAddress(this.face, this.depth, nx, ny));
            } else {
                const wrapped = TileAddress._wrapFaceEdge(this.face, nx, ny, this.depth);
                if (wrapped) neighbors.push(wrapped);
            }
        }
        return neighbors;
    }

    // ─── Backward compatibility bridge ────────────────────────────────────────

    /**
     * Map this tile's coverage to leaf-resolution chunk coordinates.
     * Useful for interop with legacy atlas / chunk-key APIs.
     *
     * @param {number} maxDepth  The planet's finest quadtree depth
     *                            (determines the "leaf chunk" grid size)
     * @returns {{ chunkX: number, chunkY: number, chunkSpan: number }}
     *   chunkX / chunkY = top-left chunk at maxDepth
     *   chunkSpan = number of maxDepth-chunks this tile covers per axis
     */
    toChunkCoords(maxDepth) {
        const span = 1 << (maxDepth - this.depth);
        return {
            chunkX:    this.x * span,
            chunkY:    this.y * span,
            chunkSpan: span
        };
    }

    // ─── Serialisation ────────────────────────────────────────────────────────

    /** Canonical string key: "f{face}:d{depth}:{x},{y}" */
    toString() {
        return `f${this.face}:d${this.depth}:${this.x},${this.y}`;
    }

    /**
     * Parse a string produced by toString().
     * @param {string} s
     * @returns {TileAddress}
     */
    static fromString(s) {
        const m = s.match(/^f(\d+):d(\d+):(\d+),(\d+)$/);
        if (!m) throw new Error(`TileAddress.fromString: unrecognised format "${s}"`);
        return new TileAddress(+m[1], +m[2], +m[3], +m[4]);
    }

    // ─── Equality ─────────────────────────────────────────────────────────────

    equals(other) {
        return other instanceof TileAddress &&
               this.face  === other.face  &&
               this.depth === other.depth &&
               this.x     === other.x     &&
               this.y     === other.y;
    }

    // ─── Static helpers ───────────────────────────────────────────────────────

    /**
     * Compute the maximum quadtree depth for a planet.
     *
     * At depth D, tile world size = faceSize / 2^D.
     * We stop when tile world size ≤ minTileSizeMeters.
     *
     * @param {number} planetRadius      Sphere radius in world units
     * @param {number} minTileSizeMeters Smallest acceptable tile side (e.g. 1024)
     * @returns {number} Integer depth
     */
    static computeMaxDepth(planetRadius, minTileSizeMeters) {
        const faceSize = 2.0 * planetRadius;
        return Math.ceil(Math.log2(faceSize / minTileSizeMeters));
    }

    /**
     * Construct a TileAddress that contains the given face-UV point at the
     * specified depth.
     *
     * @param {number} face
     * @param {number} u  [0,1]
     * @param {number} v  [0,1]
     * @param {number} depth
     * @returns {TileAddress}
     */
    static fromFaceUV(face, u, v, depth) {
        const gs = 1 << depth;
        const x = Math.max(0, Math.min(gs - 1, Math.floor(u * gs)));
        const y = Math.max(0, Math.min(gs - 1, Math.floor(v * gs)));
        return new TileAddress(face, depth, x, y);
    }

    // ─── Internal: face-edge wrapping ─────────────────────────────────────────
    //
    // Transition table derived from the cube-sphere face adjacency used by
    // PlanetaryChunkAddress and ChunkManager._wrapFaceCoord.
    //
    // Convention (matches existing codebase):
    //   Face 0 = +X,  Face 1 = −X,  Face 2 = +Y,
    //   Face 3 = −Y,  Face 4 = +Z,  Face 5 = −Z
    //
    // Direction indices: 0=left (x<0), 1=right (x≥gs), 2=down (y<0), 3=up (y≥gs)
    //
    // Each entry: [targetFace, fnIndex]
    //   fnIndex selects one of the 8 transform variants below, parameterised by
    //   (cx, cy, max) where cx/cy are the clamped edge coordinates.
    // ──────────────────────────────────────────────────────────────────────────

    static _wrapFaceEdge(face, x, y, depth) {
        const gs  = 1 << depth;
        const max = gs - 1;

        // Determine which edge was crossed
        let dir;                          // 0=L 1=R 2=D 3=U
        if      (x < 0)   dir = 0;
        else if (x >= gs) dir = 1;
        else if (y < 0)   dir = 2;
        else if (y >= gs) dir = 3;
        else return null;                 // still in bounds — shouldn't happen

        // Clamp to the boundary row/column
        const cx = Math.max(0, Math.min(max, x));
        const cy = Math.max(0, Math.min(max, y));

        // Adjacency table.  Each row = source face.
        // Each column = direction [left, right, down, up].
        // Value = [targetFace, targetX, targetY] evaluated with current cx/cy/max.
        //
        // This is the same winding used by ChunkManager._wrapFaceCoord.
        const table = [
            // Face 0 (+X)
            [[4, max, cy],       [5, 0,       cy],       [3, max,     cx],       [2, max,     max - cx]],
            // Face 1 (−X)
            [[5, max, cy],       [4, 0,       cy],       [3, 0,       max - cx], [2, 0,       cx      ]],
            // Face 2 (+Y)
            [[1, cy,  0  ],      [0, max - cy, max],     [4, cx,      max],      [5, max - cx, 0     ]],
            // Face 3 (−Y)
            [[1, max - cy, max], [0, cy,       0  ],     [5, max - cx, max],     [4, cx,       0     ]],
            // Face 4 (+Z)
            [[1, max, cy],       [0, 0,       cy],       [3, cx,      max],      [2, cx,       0     ]],
            // Face 5 (−Z)
            [[0, max, cy],       [1, 0,       cy],       [3, max - cx, max],     [2, max - cx, 0     ]]
        ];

        const entry = table[face]?.[dir];
        if (!entry) return null;

        const [tf, nx, ny] = entry;
        if (nx < 0 || nx > max || ny < 0 || ny > max) return null;

        return new TileAddress(tf, depth, nx, ny);
    }
}