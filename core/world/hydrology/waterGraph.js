// core/world/hydrology/waterGraph.js
//
// Water graph (topology) on a cube-sphere grid: lakes, and rivers that run
// from a lake outlet to the next lake or the sea. Pure JS (worker-friendly),
// deterministic.
//
// Rules (owner, 2026-10-03):
// - Lakes, rivers and the sea form networks; lakes can be chained by rivers.
// - Every river starts at a lake and ends in another lake or the sea (no
//   dead ends). Not every lake has a river.
//
// Method:
// 1. Priority-flood (Barnes et al. 2014) from the ocean cells, twice:
//    - exact (no epsilon): spill elevations, so lake levels and fill depths
//      are exact;
//    - with an epsilon so flats drain: each cell's flow parent is the cell
//      that flooded it, which gives a loop-free drainage tree in which every
//      cell drains to the sea.
//    Ties break by cell index, so the result does not depend on traversal
//    order.
// 2. Lakes: a lake is a whole water body, i.e. connected cells with fill
//    depth > lakeExtentDepthM, that holds a deep core (connected cells deeper
//    than minLakeDepthM, at least minLakeCells of them). Several cores in
//    one basin are one lake. Level = exact spill elevation; outlet = the lake
//    cell the drainage leaves through, exit = the next cell (the sill).
// 3. Q (catchment proxy): cell area x precipitation accumulated down the
//    drainage tree.
// 4. Rivers: from each lake whose outflow Q >= minRiverQ, follow the
//    drainage from the outlet until a cell of another lake, the sea, or a
//    larger river (a confluence: the tributary ends on the trunk, which goes
//    on to a lake or the sea). Larger outflow claims a shared path first.
//
// Below-sea-level cells are ocean even inland (the ocean renderer draws sea
// level there).
//
// Grid: 6 faces x N x N cells, cell id = face * N * N + j * N + i, cell
// centres at face UV ((i + 0.5) / N, (j + 0.5) / N), with the same gnomonic
// cube mapping as the terrain shader's getSpherePoint.

/** Unit direction of face UV (u, v in [0, 1], may extend past for neighbours). */
export function faceUVToDir(face, u, v) {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    let cx, cy, cz;
    switch (face) {
        case 0: cx = 1; cy = y; cz = -x; break;
        case 1: cx = -1; cy = y; cz = x; break;
        case 2: cx = x; cy = 1; cz = -y; break;
        case 3: cx = x; cy = -1; cz = y; break;
        case 4: cx = x; cy = y; cz = 1; break;
        default: cx = -x; cy = y; cz = -1; break;
    }
    const l = Math.hypot(cx, cy, cz);
    return [cx / l, cy / l, cz / l];
}

/** Face and face UV of a direction (inverse of faceUVToDir). */
export function dirToFaceUV(d) {
    const [dx, dy, dz] = d;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    let face, x, y;
    if (ax >= ay && ax >= az) {
        if (dx > 0) { face = 0; x = -dz / dx; y = dy / dx; } else { face = 1; x = dz / -dx; y = dy / -dx; }
    } else if (ay >= az) {
        if (dy > 0) { face = 2; x = dx / dy; y = -dz / dy; } else { face = 3; x = dx / -dy; y = dz / -dy; }
    } else if (dz > 0) {
        face = 4; x = dx / dz; y = dy / dz;
    } else {
        face = 5; x = -dx / -dz; y = dy / -dz;
    }
    return { face, u: (x + 1) / 2, v: (y + 1) / 2 };
}

export function cellDir(id, N) {
    const face = Math.floor(id / (N * N));
    const k = id - face * N * N;
    return faceUVToDir(face, ((k % N) + 0.5) / N, (Math.floor(k / N) + 0.5) / N);
}

export function dirToCell(d, N) {
    const { face, u, v } = dirToFaceUV(d);
    const i = Math.min(N - 1, Math.max(0, Math.floor(u * N)));
    const j = Math.min(N - 1, Math.max(0, Math.floor(v * N)));
    return face * N * N + j * N + i;
}

/** Relative cell area (solid angle) of the gnomonic cell, mean 1. */
function cellAreaWeights(N) {
    const w = new Float32Array(N * N);
    let sum = 0;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1;
            const a = Math.pow(1 + x * x + y * y, -1.5);
            w[j * N + i] = a; sum += a;
        }
    }
    const scale = (N * N) / sum;
    for (let k = 0; k < w.length; k++) w[k] *= scale;
    return w;
}

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * Neighbour lookup for the cube grid. Interior cells: index arithmetic.
 * Edge cells: geometric (step past the edge on the face plane, map the
 * direction back); cached. Returns up to 8 distinct neighbour ids.
 */
export function makeNeighbors(N) {
    const NN = N * N;
    const edgeCache = new Map();
    const out = new Int32Array(8);
    return function neighbors(id) {
        const face = Math.floor(id / NN);
        const k = id - face * NN;
        const i = k % N, j = Math.floor(k / N);
        if (i > 0 && j > 0 && i < N - 1 && j < N - 1) {
            for (let n = 0; n < 8; n++) out[n] = face * NN + (j + D8[n][1]) * N + (i + D8[n][0]);
            return { list: out, count: 8 };
        }
        let cached = edgeCache.get(id);
        if (!cached) {
            const set = [];
            for (const [di, dj] of D8) {
                const ii = i + di, jj = j + dj;
                let nid;
                if (ii >= 0 && jj >= 0 && ii < N && jj < N) {
                    nid = face * NN + jj * N + ii;
                } else {
                    nid = dirToCell(faceUVToDir(face, (ii + 0.5) / N, (jj + 0.5) / N), N);
                }
                if (nid !== id && !set.includes(nid)) set.push(nid);
            }
            cached = Int32Array.from(set);
            edgeCache.set(id, cached);
        }
        return { list: cached, count: cached.length };
    };
}

/** Binary min-heap on (key, id), ties broken by id (determinism). */
export class MinHeap {
    constructor(capacity) {
        this.keys = new Float64Array(capacity);
        this.ids = new Int32Array(capacity);
        this.size = 0;
    }
    _less(a, b) {
        return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.ids[a] < this.ids[b]);
    }
    _swap(a, b) {
        const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
        const i = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = i;
    }
    push(key, id) {
        let n = this.size++;
        this.keys[n] = key; this.ids[n] = id;
        while (n > 0) {
            const p = (n - 1) >> 1;
            if (!this._less(n, p)) break;
            this._swap(n, p); n = p;
        }
    }
    pop() {
        const id = this.ids[0];
        const last = --this.size;
        if (last > 0) {
            this.keys[0] = this.keys[last]; this.ids[0] = this.ids[last];
            let n = 0;
            for (;;) {
                const l = 2 * n + 1, r = l + 1;
                let m = n;
                if (l < last && this._less(l, m)) m = l;
                if (r < last && this._less(r, m)) m = r;
                if (m === n) break;
                this._swap(n, m); n = m;
            }
        }
        return id;
    }
}

export const WATER_GRAPH_DEFAULTS = Object.freeze({
    // A lake needs a deep core: connected cells whose fill depth exceeds
    // minLakeDepthM, at least minLakeCells of them (12 cells ~ 1.6 km^2 at
    // N 512). Shallower or smaller depressions get no lake.
    // Planet survey (2026-10-04, N 512, counted as whole water bodies):
    // 4 m / 6 cells 4054 lakes (18 % of land), 8 m / 12 cells 1699 (15.6 %),
    // 15 m / 30 cells 495 (12 %), 25 m / 60 cells 145 (7 %). Owner: 8 / 12.
    minLakeDepthM: 8.0,
    minLakeCells: 12,
    // The lake is the whole water body around its core(s): connected cells
    // with fill depth above this (metres).
    lakeExtentDepthM: 0.5,
    // Outflow Q (cells x precipitation, area-weighted) needed for a lake to
    // have a river.
    minRiverQ: 400,
    // Fill epsilon per flooded step (metres) for the drainage tree: flats drain.
    epsilonM: 1e-3,
});

/**
 * Priority flood from the ocean (cells at or below sea level; the lowest
 * cell if there is none). Returns the filled surface and, with withTree, the
 * drainage tree (parent = the cell that flooded it) and the pop order; give
 * the tree an epsilonM > 0 so flats drain.
 */
function priorityFlood(heights, seaLevelM, neighbors, epsilonM, withTree) {
    const total = heights.length;
    const filled = new Float64Array(total);
    const parent = withTree ? new Int32Array(total).fill(-1) : null;
    const order = withTree ? new Int32Array(total) : null;
    const closed = new Uint8Array(total);
    const heap = new MinHeap(total);
    let orderCount = 0, oceanCells = 0;
    for (let id = 0; id < total; id++) {
        if (heights[id] <= seaLevelM) {
            closed[id] = 1;
            filled[id] = heights[id];
            heap.push(heights[id], id);
            oceanCells++;
        }
    }
    if (oceanCells === 0) {
        // No sea: seed from the lowest cell so the graph is still defined.
        let lowest = 0;
        for (let id = 1; id < total; id++) if (heights[id] < heights[lowest]) lowest = id;
        closed[lowest] = 1; filled[lowest] = heights[lowest]; heap.push(heights[lowest], lowest);
    }
    while (heap.size > 0) {
        const c = heap.pop();
        if (withTree) order[orderCount++] = c;
        const { list, count } = neighbors(c);
        for (let n = 0; n < count; n++) {
            const nb = list[n];
            if (closed[nb]) continue;
            closed[nb] = 1;
            filled[nb] = Math.max(heights[nb], filled[c] + epsilonM);
            if (withTree) parent[nb] = c;
            heap.push(filled[nb], nb);
        }
    }
    return { filled, parent, order, orderCount, oceanCells };
}

/**
 * Connected components (cube-grid neighbours) of the cells where keep(id)
 * holds. Components come out in order of their smallest cell id, each with
 * its cells sorted ascending. compOf[id] = component index or -1.
 */
function components(total, neighbors, keep) {
    const compOf = new Int32Array(total).fill(-1);
    const comps = [];
    const stack = [];
    for (let id = 0; id < total; id++) {
        if (compOf[id] !== -1 || !keep(id)) continue;
        const k = comps.length, cells = [];
        compOf[id] = k; stack.push(id);
        while (stack.length) {
            const c = stack.pop();
            cells.push(c);
            const { list, count } = neighbors(c);
            for (let n = 0; n < count; n++) {
                const nb = list[n];
                if (compOf[nb] !== -1 || !keep(nb)) continue;
                compOf[nb] = k; stack.push(nb);
            }
        }
        cells.sort((a, b) => a - b);
        comps.push(cells);
    }
    return { compOf, comps };
}

/**
 * @param {object} p
 * @param {number} p.N              cells per face side
 * @param {Float32Array} p.heights  6*N*N heights in metres
 * @param {number} p.seaLevelM      cells at or below are ocean
 * @param {Float32Array} [p.precip] 6*N*N precipitation weights (default 1)
 * @param {object} [p.params]       WATER_GRAPH_DEFAULTS overrides
 */
export function buildWaterGraph({ N, heights, seaLevelM, precip = null, params = {} }) {
    const P = { ...WATER_GRAPH_DEFAULTS, ...params };
    const NN = N * N, total = 6 * NN;
    const neighbors = makeNeighbors(N);
    const area = cellAreaWeights(N);

    // ---- 1. Priority floods from the ocean ----
    const exact = priorityFlood(heights, seaLevelM, neighbors, 0, false).filled;
    const { filled, parent, order, orderCount, oceanCells } = priorityFlood(heights, seaLevelM, neighbors, P.epsilonM, true);
    const isOcean = (id) => heights[id] <= seaLevelM && parent[id] === -1;
    const depth = (id) => exact[id] - heights[id];

    // ---- 2. Lakes: water bodies that hold a deep core ----
    const extentDepth = Math.min(P.lakeExtentDepthM, P.minLakeDepthM);
    const bodies = components(total, neighbors, (id) => !isOcean(id) && depth(id) > extentDepth);
    const cores = components(total, neighbors, (id) => !isOcean(id) && depth(id) > P.minLakeDepthM);
    const coreCells = new Int32Array(bodies.comps.length);
    for (const cells of cores.comps) {
        if (cells.length < P.minLakeCells) continue;
        coreCells[bodies.compOf[cells[0]]] += cells.length;
    }
    const lakeOf = new Int32Array(total).fill(-1);
    const lakes = [];
    for (let b = 0; b < bodies.comps.length; b++) {
        if (coreCells[b] === 0) continue;
        const cells = bodies.comps[b];
        const lakeId = lakes.length;
        let deepest = cells[0];
        for (const c of cells) {
            lakeOf[c] = lakeId;
            if (depth(c) > depth(deepest)) deepest = c;
        }
        lakes.push({
            id: lakeId, cells, coreCells: coreCells[b],
            level: exact[deepest], maxDepth: depth(deepest), deepestCell: deepest,
            outletCell: -1, exitCell: -1, outflowQ: 0, river: -1, downstream: null,
        });
    }
    // Outlet: follow the drainage from the deepest cell to the last lake
    // cell; every lake cell drains through it (they were flooded from it).
    for (const lake of lakes) {
        let c = lake.deepestCell;
        while (parent[c] !== -1 && lakeOf[parent[c]] === lake.id) c = parent[c];
        lake.outletCell = c;
        lake.exitCell = parent[c];
    }

    // ---- 3. Q: area x precipitation down the drainage tree ----
    const Q = new Float64Array(total);
    for (let id = 0; id < total; id++) Q[id] = area[id % NN] * (precip ? precip[id] : 1);
    for (let k = orderCount - 1; k >= 0; k--) {
        const c = order[k];
        if (parent[c] !== -1) Q[parent[c]] += Q[c];
    }
    for (const lake of lakes) lake.outflowQ = Q[lake.outletCell];

    // ---- 4. Downstream lake or sea, and rivers ----
    // End of a lake's drainage: the first cell of another lake, or the sea.
    const endOf = (lake, c) => {
        while (c !== -1) {
            if (lakeOf[c] !== -1 && lakeOf[c] !== lake.id) return { type: 'lake', id: lakeOf[c] };
            if (isOcean(c)) return { type: 'sea' };
            c = parent[c];
        }
        return { type: 'sea' };
    };
    for (const lake of lakes) lake.downstream = endOf(lake, lake.exitCell);

    const sources = lakes.filter(l => l.outflowQ >= P.minRiverQ && l.exitCell !== -1)
        .sort((a, b) => b.outflowQ - a.outflowQ || a.id - b.id);
    const riverOf = new Int32Array(total).fill(-1);
    const rivers = [];
    let confluences = 0;
    for (const lake of sources) {
        const id = rivers.length;
        const path = [lake.outletCell];
        let to = null;
        for (let c = lake.exitCell; c !== -1; c = parent[c]) {
            path.push(c);
            if (lakeOf[c] !== -1 && lakeOf[c] !== lake.id) { to = { type: 'lake', id: lakeOf[c] }; break; }
            if (isOcean(c)) { to = { type: 'sea' }; break; }
            if (riverOf[c] !== -1) { to = { type: 'river', id: riverOf[c], cell: c }; confluences++; break; }
            riverOf[c] = id;
        }
        lake.river = id;
        rivers.push({ id, fromLake: lake.id, to: to ?? { type: 'sea' }, cells: path, q: path.map(p => Q[p]) });
    }

    return {
        N, params: P, seaLevelM,
        lakes, rivers,
        // Per-cell arrays for overlays, refinement and queries.
        lakeOf, riverOf, parent,
        filled: Float32Array.from(filled), fillExact: Float32Array.from(exact), Q: Float32Array.from(Q),
        stats: {
            oceanCells, waterBodies: bodies.comps.length,
            lakeCount: lakes.length, riverCount: rivers.length, confluences,
        },
    };
}
