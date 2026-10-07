// Sparse river landforms and incision, baked once in the water worker.
// Bank retreat solves a local talus constraint on the sampled terrain. It
// removes material; it never builds a levee. Hills have independent finite
// footprints, so their placement range does not become a terrain border.
import { dirToFaceUV, faceUVToDir, MinHeap } from './waterGraph.js';
import { dirToPlane, planeToDir, tangentBasis } from './lakeRefine.js';
import { riverNoise, riverShapeAt } from '../water/riverShapeNoise.js';

export const RIVER_LANDSCAPE_DEFAULTS = Object.freeze({
    enabled: true,
    hillRangeM: 1000,
    hillCellM: 800,
    hillDensity: 0.55,
    hillMinRadiusM: 100,
    hillMaxRadiusM: 1400,
    hillMaxHeightM: 600,
    hillHeightScale: 1.5,
    maxHills: 96,
    hillErosion: 0.65,
    bankSlope: 0.22,
    canyonSlope: 1.2,
    bankReachM: 500,
    erosionVariation: 0.8,
});

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
function random(id, salt = 0) {
    let x = (id ^ salt) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** World-cell placement with river-dependent density/relief, biased toward the line. */
export function riverHills(dirs, R, river, overrides = {}, lakeAt = null) {
    const P = { ...RIVER_LANDSCAPE_DEFAULTS, ...overrides, ...overrides.perRiver?.[river] };
    if (!P.enabled || P.hillDensity <= 0) return [];
    const N = Math.max(1, Math.ceil(2 * R / P.hillCellM));
    const ids = new Set(), cells = new Map();
    const profile = random(river + 1, 4919), density = P.hillDensity * (0.8 + 0.4 * profile);
    const relief = 0.5 + 0.5 * random(river + 1, 7919);
    for (let k = 0; k < dirs.length; k += 20) {
        const d = dirs[k], { e1, e2 } = tangentBasis(d);
        const span = P.hillRangeM + P.hillCellM;
        for (let x = -span; x <= span; x += P.hillCellM * 0.7) for (let y = -span; y <= span; y += P.hillCellM * 0.7) {
            const q = d.map((v, i) => v + (e1[i] * x + e2[i] * y) / R), l = Math.hypot(...q);
            const { face, u, v } = dirToFaceUV(q.map(v => v / l));
            const i = Math.min(N - 1, Math.max(0, Math.floor(u * N))), j = Math.min(N - 1, Math.max(0, Math.floor(v * N)));
            const id = face * N * N + j * N + i;
            if (ids.has(id)) continue;
            ids.add(id);
            cells.set(id, { face, i, j });
        }
    }
    const hills = [];
    for (const [id, { face, i, j }] of cells) {
        if (random(id, 65491) > density) continue;
        const c = faceUVToDir(face, (i + 0.15 + 0.7 * random(id, 17)) / N, (j + 0.15 + 0.7 * random(id, 31)) / N);
        let dist = Infinity;
        for (let k = 0; k < dirs.length; k += 10) dist = Math.min(dist, Math.hypot(...c.map((v, a) => v - dirs[k][a])) * R);
        const bias = 1 - 0.7 * smooth(dist / Math.max(P.hillRangeM, 1));
        if (dist > P.hillRangeM || random(id, 65491) > density * bias) continue;
        const r = P.hillMinRadiusM + (P.hillMaxRadiusM - P.hillMinRadiusM) * random(id, 53) ** 0.9;
        const a = r, b = r * (0.45 + 0.65 * random(id, 71));
        // Most formations have hill relief; occasional gentle and high-relief
        // cells break it up. This is baked placement, with no per-vertex noise.
        const kind = random(id, 179), scale = kind < 0.17 ? 0.25 : kind > 0.87 ? 4 : 1;
        const angle = random(id, 97) * Math.PI * 2;
        const hill = { id, c, ...tangentBasis(c), a, b, angle, cs: Math.cos(angle), sn: Math.sin(angle),
            boundCos: Math.cos(1.2 * Math.max(a, b) / R),
            height: Math.min(P.hillMaxHeightM, r * 0.12 * P.hillHeightScale * scale) * relief * (0.5 + 0.5 * random(id, 113)),
            erosion: random(id, 131) < 0.25 ? 0 : P.hillErosion * random(id, 149) };
        // Never clip a large hill to a lake mask: that creates a steep wall
        // along the shoreline. Leave space for existing lakes at placement.
        let wet = lakeAt && Number.isFinite(lakeAt(c));
        if (lakeAt) for (const ring of [0.35, 0.7, 1.1]) {
            for (let m = 0; m < 16 && !wet; m++) {
                const angle = m * Math.PI / 8, radius = Math.max(a, b) * ring;
                const d = planeToDir(Math.cos(angle) * radius, Math.sin(angle) * radius, hill, R);
                wet = Number.isFinite(lakeAt(d));
            }
        }
        if (!wet) hills.push(hill);
    }
    return hills.sort((a, b) => random(a.id, 163) - random(b.id, 163)).slice(0, Math.max(0, P.maxHills));
}

/** Each hill dies out on its own boundary, independent of distance to the river. */
export function riverHillAt(dir, hill, R) {
    const k = dir[0] * hill.c[0] + dir[1] * hill.c[1] + dir[2] * hill.c[2];
    if (k <= (hill.boundCos ?? 0)) return 0;
    const x = (dir[0] * hill.e1[0] + dir[1] * hill.e1[1] + dir[2] * hill.e1[2]) / k * R;
    const y = (dir[0] * hill.e2[0] + dir[1] * hill.e2[1] + dir[2] * hill.e2[2]) / k * R;
    const cs = hill.cs ?? Math.cos(hill.angle), sn = hill.sn ?? Math.sin(hill.angle);
    const u = (x * cs + y * sn) / hill.a, v = (y * cs - x * sn) / hill.b;
    // Two lobes give each formation an irregular footprint without GPU noise.
    const q = Math.max(0, 1 - u * u - v * v);
    const lobe = Math.max(0, 1 - ((u - 0.28) / 0.8) ** 2 - ((v + 0.15) / 0.8) ** 2);
    return hill.height * (0.7 * q ** 2 + 0.3 * lobe ** 2);
}

/** The same hill projected once into a river's sampled patch. */
export function riverHillPlaneSampler(hill, frame, R) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const c = [dot(hill.c, frame.c), dot(hill.c, frame.e1), dot(hill.c, frame.e2)];
    const ex = [dot(hill.e1, frame.c), dot(hill.e1, frame.e1), dot(hill.e1, frame.e2)];
    const ey = [dot(hill.e2, frame.c), dot(hill.e2, frame.e1), dot(hill.e2, frame.e2)];
    const cs = hill.cs ?? Math.cos(hill.angle), sn = hill.sn ?? Math.sin(hill.angle);
    const bound = (hill.boundCos ?? 0) ** 2;
    return (x, y) => {
        const px = x / R, py = y / R, k = c[0] + c[1] * px + c[2] * py;
        if (k <= 0 || k * k <= bound * (1 + px * px + py * py)) return 0;
        const hx = (ex[0] + ex[1] * px + ex[2] * py) * R / k;
        const hy = (ey[0] + ey[1] * px + ey[2] * py) * R / k;
        const u = (hx * cs + hy * sn) / hill.a, v = (hy * cs - hx * sn) / hill.b;
        const q = Math.max(0, 1 - u * u - v * v);
        const lobe = Math.max(0, 1 - ((u - 0.28) / 0.8) ** 2 - ((v + 0.15) / 0.8) ** 2);
        return hill.height * (0.7 * q * q + 0.3 * lobe * lobe);
    };
}

/** Local bank failure, using a heap to visit only cells affected by excavation. */
export function bakeRiverIncision({ frame, heights, points, stride, arc, R, river, shape, hills = [], options = {} }) {
    const P = { ...RIVER_LANDSCAPE_DEFAULTS, ...options, ...options.perRiver?.[river] }, { nx, ny, spacing, x0, y0 } = frame;
    if (!P.enabled) return { frame, cells: new Uint32Array(), cuts: new Float32Array(), erosionCuts: new Float32Array(), hills: [] };
    // One sparse index, with compact numeric storage. Six independent Maps
    // allocated many entries per bank cell and caused avoidable GC spikes.
    const index = new Map();
    let count = 0, capacity = 16384;
    const F = { cell: new Int32Array(capacity), settled: new Uint8Array(capacity), original: new Float64Array(capacity),
        goal: new Float64Array(capacity).fill(Infinity), distance: new Float64Array(capacity), slope: new Float64Array(capacity),
        material: new Float64Array(capacity), water: new Float64Array(capacity) };
    const hillSamplers = hills.map(h => riverHillPlaneSampler(h, frame, R));
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
        let h = heights[k];
        const x = x0 + (k % nx + 0.5) * spacing, y = y0 + (Math.floor(k / nx) + 0.5) * spacing;
        for (const sample of hillSamplers) h += sample(x, y);
        F.original[z] = h; F.cell[z] = k; index.set(k, z);
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
            const cx = x - (B[1] - A[1]) / Math.max(len, 1e-6) * sh.off, cy = y + (B[0] - A[0]) / Math.max(len, 1e-6) * sh.off;
            const eta = points[o + 16] + (points[z + 16] - points[o + 16]) * t, depth = points[o + 5] + (points[z + 5] - points[o + 5]) * t;
            const r = sh.hw + spacing;
            for (let j = Math.max(0, Math.floor((cy - r - y0) / spacing)); j <= Math.min(ny - 1, Math.ceil((cy + r - y0) / spacing)); j++) {
                for (let i = Math.max(0, Math.floor((cx - r - x0) / spacing)); i <= Math.min(nx - 1, Math.ceil((cx + r - x0) / spacing)); i++) {
                    const dx = x0 + (i + 0.5) * spacing - cx, dy = y0 + (j + 0.5) * spacing - cy;
                    // Distance to the traced segment, not a union of round row stamps.
                    const u = Math.abs(-(B[1] - A[1]) * dx + (B[0] - A[0]) * dy) / Math.max(len * sh.hw, 1e-6);
                    const along = ((B[0] - A[0]) * dx + (B[1] - A[1]) * dy) / Math.max(len, 1e-6);
                    if (u >= 1 || Math.abs(along) > spacing) continue;
                    const q = Math.max(0, 1 - u * u), goal = eta - depth + depth / shape.waterFrac * (1 - q ** 1.5);
                    const k = slot(j * nx + i);
                    if (goal >= F.original[k] - 0.001 || goal >= F.goal[k]) continue;
                    F.goal[k] = goal; F.distance[k] = 0;
                    F.slope[k] = P.bankSlope + (P.canyonSlope - P.bankSlope) * smooth((F.original[k] - goal) / 30);
                    F.material[k] = riverBankErodibility(arc[a] + (arc[a + 1] - arc[a]) * t, river, P.erosionVariation);
                    F.water[k] = eta;
                }
            }
        }
    }
    for (let k = 0; k < count; k++) if (Number.isFinite(F.goal[k])) enqueue(F.goal[k], k);
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
            if (F.settled[q]) continue;
            const raw = h + F.slope[k] * step;
            // A finite work budget must not end in a cut wall. Bank retreat
            // loses influence smoothly, and usually stops on natural ground.
            const goal = F.original[q] - Math.max(0, F.original[q] - raw) * (1 - smooth(d / P.bankReachM));
            if (goal >= F.original[q] - 0.001 || goal >= F.goal[q]) continue;
            F.goal[q] = goal; F.distance[q] = d; F.slope[q] = F.slope[k]; F.material[q] = F.material[k]; F.water[q] = F.water[k];
            enqueue(goal, q);
        }
    }
    const cells = Uint32Array.from(F.cell.subarray(0, count).filter((_, k) => Number.isFinite(F.goal[k]))).sort();
    const cuts = new Float32Array(cells.length), erosionCuts = new Float32Array(cells.length);
    const bankReferences = new Float32Array(cells.length), bankClearances = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
        const k = index.get(cells[i]);
        cuts[i] = Math.max(0, F.original[k] - F.goal[k]); erosionCuts[i] = cuts[i] * F.material[k];
        bankReferences[i] = F.goal[k]; bankClearances[i] = Math.max(0, F.goal[k] - F.water[k]);
    }
    return { frame, cells, cuts, erosionCuts, bankReferences, bankClearances, hills, bankReachM: P.bankReachM };
}

/** Sparse field sampling for the page bake (no dense terrain retained). */
export function riverIncisionSampler(landscape, R) {
    const { frame: f, cells, cuts, erosionCuts = cuts, bankReferences, bankClearances } = landscape;
    const values = new Map();
    for (let i = 0; i < cells.length; i++) values.set(cells[i], i);
    const sample = (dir, out) => {
        out.fill(0);
        const dot = dir[0] * f.c[0] + dir[1] * f.c[1] + dir[2] * f.c[2];
        if (dot <= 0) return;
        const x = (dir[0] * f.e1[0] + dir[1] * f.e1[1] + dir[2] * f.e1[2]) / dot * R;
        const y = (dir[0] * f.e2[0] + dir[1] * f.e2[1] + dir[2] * f.e2[2]) / dot * R;
        const u = (x - f.x0) / f.spacing - 0.5, v = (y - f.y0) / f.spacing - 0.5;
        const i = Math.floor(u), j = Math.floor(v), tx = u - i, ty = v - j;
        if (i < 0 || j < 0 || i + 1 >= f.nx || j + 1 >= f.ny) return;
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
            const k = values.get((j + dy) * f.nx + i + dx);
            if (k === undefined) continue;
            const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
            out[0] += cuts[k] * w; out[1] += erosionCuts[k] * w;
            if (bankReferences) {
                out[2] += bankReferences[k] * w; out[3] += bankClearances[k] * w; out[4] += w;
            }
        }
    };
    const scratch = new Float64Array(5);
    const field = (dir, erosion = false) => { sample(dir, scratch); return scratch[erosion ? 1 : 0]; };
    field.all = sample;
    return field;
}

/** Stable erodibility along a river; some reaches receive no extra erosion. */
export function riverBankErodibility(s, river, variation = 0.8) {
    return clamp01(1 - variation + variation * smooth((riverNoise(s, river, 'valley').v + 0.35) / 0.7));
}
