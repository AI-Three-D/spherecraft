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
// 1. Priority-flood (Barnes et al. 2014) from the ocean cells, with an
//    epsilon so flats drain. Each cell's flow parent is the cell that flooded
//    it, which gives a loop-free drainage tree in which every cell drains to
//    the sea. Ties break by cell index, so the result does not depend on
//    traversal order.
// 2. Lakes: connected cells whose fill depth exceeds minLakeDepthM, at least
//    minLakeCells cells. Level = spill elevation; outlet = where the
//    drainage leaves the lake.
// 3. Q (catchment proxy): cell area x precipitation accumulated down the
//    drainage tree.
// 4. Rivers: from each lake whose outflow Q >= minRiverQ, follow the
//    drainage from the outlet until a cell of another lake or the sea.
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
class MinHeap {
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
    // A cell's fill depth must exceed this to count as lake (metres).
    // Planet survey (512^2 per face, eroded terrain): 3 m / 4 cells gave
    // ~7000 lakes (12 % of the planet); 8 m / 12 cells ~2300 (8.5 %).
    minLakeDepthM: 8.0,
    // Smaller depressions are breached (no lake). 12 cells ~ 3 km^2 at N 512.
    minLakeCells: 12,
    // Outflow Q (cells x precipitation, area-weighted) needed for a lake to
    // have a river.
    minRiverQ: 400,
    // Fill epsilon per flooded step (metres): flats drain.
    epsilonM: 1e-3,
});

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

    // ---- 1. Priority-flood from the ocean ----
    const filled = new Float64Array(total);
    const parent = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const order = new Int32Array(total);   // pop order (sea first)
    let orderCount = 0;
    const heap = new MinHeap(total);
    let oceanCells = 0;
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
        order[orderCount++] = c;
        const { list, count } = neighbors(c);
        for (let n = 0; n < count; n++) {
            const nb = list[n];
            if (closed[nb]) continue;
            closed[nb] = 1;
            filled[nb] = Math.max(heights[nb], filled[c] + P.epsilonM);
            parent[nb] = c;
            heap.push(filled[nb], nb);
        }
    }

    const isOcean = (id) => heights[id] <= seaLevelM && parent[id] === -1;

    // ---- 2. Lakes ----
    const depth = (id) => filled[id] - heights[id];
    const lakeOf = new Int32Array(total).fill(-1);
    const lakes = [];
    const stack = [];
    for (let id = 0; id < total; id++) {
        if (lakeOf[id] !== -1 || isOcean(id) || depth(id) <= P.minLakeDepthM) continue;
        // Flood-fill the connected component of deep cells.
        const cells = [];
        lakeOf[id] = -2; stack.push(id);
        while (stack.length) {
            const c = stack.pop();
            cells.push(c);
            const { list, count } = neighbors(c);
            for (let n = 0; n < count; n++) {
                const nb = list[n];
                if (lakeOf[nb] !== -1 || isOcean(nb) || depth(nb) <= P.minLakeDepthM) continue;
                lakeOf[nb] = -2; stack.push(nb);
            }
        }
        if (cells.length < P.minLakeCells) {
            for (const c of cells) lakeOf[c] = -3; // breached depression
            continue;
        }
        cells.sort((a, b) => a - b);
        const lakeId = lakes.length;
        let level = -Infinity, maxDepth = 0;
        for (const c of cells) {
            lakeOf[c] = lakeId;
            level = Math.max(level, filled[c]);
            maxDepth = Math.max(maxDepth, depth(c));
        }
        lakes.push({ id: lakeId, cells, level, maxDepth, outletCell: -1, exitCell: -1, outflowQ: 0, river: -1, downstream: null });
    }
    for (let id = 0; id < total; id++) if (lakeOf[id] < -1) lakeOf[id] = -1;

    // Outlet: the lake cell whose parent leaves the lake (the spill point).
    // All lake cells drain through it (they were flooded from it).
    for (const lake of lakes) {
        let c = lake.cells[0];
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

    // ---- 4. Rivers: lake outlet -> next lake or sea ----
    const rivers = [];
    for (const lake of lakes) {
        let c = lake.exitCell;
        if (c === -1) { lake.downstream = { type: 'sea' }; continue; }
        const path = [lake.outletCell];
        let end = null;
        while (c !== -1) {
            if (lakeOf[c] !== -1 && lakeOf[c] !== lake.id) { end = { type: 'lake', id: lakeOf[c] }; path.push(c); break; }
            if (isOcean(c)) { end = { type: 'sea' }; path.push(c); break; }
            path.push(c);
            c = parent[c];
        }
        if (!end) end = { type: 'sea' };
        lake.downstream = end;
        if (lake.outflowQ >= P.minRiverQ) {
            lake.river = rivers.length;
            rivers.push({ id: rivers.length, fromLake: lake.id, to: end, cells: path, q: path.map(p => Q[p]) });
        }
    }

    return {
        N, params: P, seaLevelM,
        lakes, rivers,
        // Per-cell arrays for overlays, carving and queries.
        lakeOf, parent, filled: Float32Array.from(filled), Q: Float32Array.from(Q),
        stats: { oceanCells, lakeCount: lakes.length, riverCount: rivers.length },
    };
}
