// Sparse bank incision, baked once from the existing terrain in the water worker.
// Bank retreat solves a local talus constraint. It only removes material.
import { MinHeap } from './waterGraph.js';
import { dirToPlane } from './lakeRefine.js';
import { riverNoise, riverShapeAt } from '../water/riverShapeNoise.js';

export const RIVER_LANDSCAPE_DEFAULTS = Object.freeze({
    enabled: true,
    bankSlope: 0.28,
    canyonSlope: 0.75,
    bankReachM: 900,
    bankVariation: 0.8,
});

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
/** Local bank failure, using a heap to visit only cells affected by excavation. */
export function bakeRiverIncision({ frame, heights, points, stride, arc, R, river, shape, options = {} }) {
    const P = { ...RIVER_LANDSCAPE_DEFAULTS, ...options, ...options.perRiver?.[river] }, { nx, ny, spacing, x0, y0 } = frame;
    if (!P.enabled) return { frame, cells: new Uint32Array(), cuts: new Float32Array() };
    // One sparse index, with compact numeric storage. Six independent Maps
    // allocated many entries per bank cell and caused avoidable GC spikes.
    const index = new Map();
    let count = 0, capacity = 16384;
    const F = { cell: new Int32Array(capacity), settled: new Uint8Array(capacity), near: new Uint8Array(capacity), original: new Float64Array(capacity),
        goal: new Float64Array(capacity).fill(Infinity), distance: new Float64Array(capacity), slope: new Float64Array(capacity),
    };
    const heap = new MinHeap(8192);
    const enqueue = (h, k) => {
        if (heap.size === heap.keys.length) {
            const keys = new Float64Array(heap.size * 2), ids = new Int32Array(heap.size * 2);
            keys.set(heap.keys); ids.set(heap.ids); heap.keys = keys; heap.ids = ids;
        }
        heap.push(h, k);
    };
    const slot = k => {
        const found = index.get(k);
        if (found !== undefined) return found;
        if (count === capacity) {
            capacity *= 2;
            for (const [name, old] of Object.entries(F)) {
                const grown = new old.constructor(capacity);
                if (name === 'goal') grown.fill(Infinity);
                grown.set(old); F[name] = grown;
            }
        }
        const z = count++;
        F.original[z] = heights[k]; F.cell[z] = k; index.set(k, z);
        return z;
    };
    const n = points.length / stride;
    for (let a = 0; a + 1 < n; a++) {
        const o = a * stride, z = o + stride;
        const A = dirToPlane(Array.from(points.subarray(o, o + 3)), frame, R), B = dirToPlane(Array.from(points.subarray(z, z + 3)), frame, R);
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const samples = Math.max(1, Math.ceil(len / (spacing * 0.5)));
        for (let m = 0; m <= samples; m++) {
            const t = m / samples, x = A[0] + (B[0] - A[0]) * t, y = A[1] + (B[1] - A[1]) * t;
            const hw = points[o + 4] + (points[z + 4] - points[o + 4]) * t;
            const sh = riverShapeAt(arc[a] + (arc[a + 1] - arc[a]) * t, river, hw, shape);
            // A channel narrower than a cell is not resolved here: only cells
            // whose centres fell inside it became channel, and every other
            // cell along it took a lower one's limit from up to 32 m
            // downstream (a 5 m mountain stream cut 25-30 m on 16 m cells,
            // water-look v28). The carve shapes such channels alone.
            if (2 * sh.hw < spacing) continue;
            const cx = x - (B[1] - A[1]) / Math.max(len, 1e-6) * sh.off, cy = y + (B[0] - A[0]) / Math.max(len, 1e-6) * sh.off;
            const r = sh.hw + spacing;
            for (let j = Math.max(0, Math.floor((cy - r - y0) / spacing)); j <= Math.min(ny - 1, Math.ceil((cy + r - y0) / spacing)); j++) {
                for (let i = Math.max(0, Math.floor((cx - r - x0) / spacing)); i <= Math.min(nx - 1, Math.ceil((cx + r - x0) / spacing)); i++) {
                    const dx = x0 + (i + 0.5) * spacing - cx, dy = y0 + (j + 0.5) * spacing - cy;
                    // Distance to the traced segment, not a union of round row stamps.
                    const u = Math.abs(-(B[1] - A[1]) * dx + (B[0] - A[0]) * dy) / Math.max(len * sh.hw, 1e-6);
                    const along = ((B[0] - A[0]) * dx + (B[1] - A[1]) * dy) / Math.max(len, 1e-6);
                    if (u >= 1 || Math.abs(along) > spacing) continue;
                    // The level and depth at the cell's own place along the
                    // segment: the sample's, up to a cell downstream, over-cut
                    // steep streams by slope x spacing (5-10 m at 16 m cells).
                    // Cells before or past the segment belong to its neighbour.
                    const tc = t + along / Math.max(len, 1e-6);
                    if ((tc < 0 && a > 0) || (tc > 1 && a + 2 < n)) continue;
                    const tt = Math.max(0, Math.min(1, tc));
                    const eta = points[o + 16] + (points[z + 16] - points[o + 16]) * tt, depth = points[o + 5] + (points[z + 5] - points[o + 5]) * tt;
                    const q = Math.max(0, 1 - u * u), goal = eta - depth + depth / shape.waterFrac * (1 - q ** 1.5);
                    const k = slot(j * nx + i);
                    if (goal >= F.original[k] - 0.001 || goal >= F.goal[k]) continue;
                    F.goal[k] = goal; F.distance[k] = 0; F.near[k] = 1;
                    const material = riverBankErodibility(arc[a] + (arc[a + 1] - arc[a]) * t, river, P.bankVariation);
                    // Loose banks retreat more gently; resistant deep cuts
                    // retain canyon walls. A shallow cut must not immediately
                    // become the same steep wall on both sides of every reach.
                    const deep = smooth((F.original[k] - goal) / 100);
                    const resistance = 1 - 0.55 * material;
                    F.slope[k] = P.bankSlope + (P.canyonSlope - P.bankSlope) * deep * resistance;
                }
            }
        }
    }
    // Each bank cell takes its limit from its nearest channel cell (cells in
    // order of distance; the first path to reach a cell keeps it), and the
    // channel cells keep their own profile. Visiting cells lowest goal first
    // let any lower channel point limit them: on a steep stream the points
    // downstream pulled the channel and its banks upstream down to bankSlope
    // from the lowest point, a slot growing to ~30 m deep at the source lake
    // (owner 2026-10-12: "man-made dam", toothed banks; water-look v25).
    for (let k = 0; k < count; k++) if (Number.isFinite(F.goal[k])) enqueue(0, k);
    while (heap.size) {
        const k = heap.pop();
        if (F.settled[k]) continue;
        F.settled[k] = 1;
        const cell = F.cell[k], i = cell % nx, j = Math.floor(cell / nx), h = F.goal[k];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || i + dx < 0 || j + dy < 0 || i + dx >= nx || j + dy >= ny) continue;
            const step = spacing * (dx && dy ? Math.SQRT2 : 1), d = F.distance[k] + step;
            if (d > P.bankReachM) continue;
            const q = slot((j + dy) * nx + i + dx);
            if (F.settled[q] || (F.near[q] && d >= F.distance[q])) continue;
            const raw = h + F.slope[k] * step;
            // A finite work budget must not end in a cut wall. Bank retreat
            // loses influence smoothly, and usually stops on natural ground.
            const goal = F.original[q] - Math.max(0, F.original[q] - raw) * (1 - smooth(d / P.bankReachM));
            // Nearer than any path so far: this channel cell rules q, and
            // where it needs no cut, q is not cut (nor beyond it).
            F.near[q] = 1; F.distance[q] = d; F.slope[q] = F.slope[k];
            F.goal[q] = goal < F.original[q] - 0.001 ? goal : Infinity;
            if (Number.isFinite(F.goal[q])) enqueue(d, q);
        }
    }
    const cells = Uint32Array.from(F.cell.subarray(0, count).filter((_, k) => Number.isFinite(F.goal[k]))).sort();
    const cuts = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
        const k = index.get(cells[i]);
        cuts[i] = Math.max(0, F.original[k] - F.goal[k]);
    }
    return { frame, cells, cuts, bankReachM: P.bankReachM };
}

/** Sparse field sampling for the page bake (no dense terrain retained). */
export function riverIncisionSampler(landscape, R) {
    const { frame: f, cells, cuts } = landscape;
    const values = new Map();
    for (let i = 0; i < cells.length; i++) values.set(cells[i], cuts[i]);
    return dir => {
        const dot = dir[0] * f.c[0] + dir[1] * f.c[1] + dir[2] * f.c[2];
        if (dot <= 0) return 0;
        const x = (dir[0] * f.e1[0] + dir[1] * f.e1[1] + dir[2] * f.e1[2]) / dot * R;
        const y = (dir[0] * f.e2[0] + dir[1] * f.e2[1] + dir[2] * f.e2[2]) / dot * R;
        const u = (x - f.x0) / f.spacing - 0.5, v = (y - f.y0) / f.spacing - 0.5;
        const i = Math.floor(u), j = Math.floor(v), tx = u - i, ty = v - j;
        if (i < 0 || j < 0 || i + 1 >= f.nx || j + 1 >= f.ny) return 0;
        let cut = 0;
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
            const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
            cut += (values.get((j + dy) * f.nx + i + dx) ?? 0) * w;
        }
        return cut;
    };
}

/** Stable material variation sets how far banks retreat along a river. */
export function riverBankErodibility(s, river, variation = 0.8) {
    return clamp01(1 - variation + variation * smooth((riverNoise(s, river, 'valley').v + 0.35) / 0.7));
}
