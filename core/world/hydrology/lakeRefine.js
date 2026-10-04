// core/world/hydrology/lakeRefine.js
//
// Fine lake solve: the true level, extent and outlet of one lake on a local
// height patch. Pure JS (worker-friendly), deterministic.
//
// Why: the water graph's 512 m grid gives the topology, but its lake levels
// don't hold water at full detail (lab 2026-10-04: 15 of 30 lakes leak
// through a rim gap; the fine spill level differs by -23..+15 m). A 16 m
// patch is converged (16 m and 4 m agree within 0.2 m). The owner chose
// natural shores: the water fills the real basin, terrain unchanged.
//
// Patch frame: a gnomonic tangent plane around a centre direction, so lakes
// across cube-face edges need no special case. Point (x, y) metres maps to
// normalize(c + (x * e1 + y * e2) / R). Cell (i, j) centre:
// x = x0 + (i + 0.5) * spacing, y = y0 + (j + 0.5) * spacing.
//
// Solve: priority flood from the patch border (border cells drain away), so
// every cell gets its spill level. The lake is the connected region below
// the seed's spill level. The outlet is the last lake cell on the seed's
// drainage path; the exit is the next cell (the sill, at the level).

import { MinHeap, cellDir, dirToCell } from './waterGraph.js';

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

/** Deterministic tangent basis at unit direction c. */
export function tangentBasis(c) {
    const ref = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = normalize(cross(ref, c));
    const e2 = cross(c, e1);
    return { e1, e2 };
}

/** Tangent-plane coordinates (metres) of unit direction d in frame (c, e1, e2). */
export function dirToPlane(d, frame, R) {
    const k = dot(d, frame.c);
    return [dot(d, frame.e1) / k * R, dot(d, frame.e2) / k * R];
}

/** Unit direction of tangent-plane point (x, y) metres. */
export function planeToDir(x, y, frame, R) {
    const { c, e1, e2 } = frame;
    return normalize([c[0] + (x * e1[0] + y * e2[0]) / R, c[1] + (x * e1[1] + y * e2[1]) / R, c[2] + (x * e1[2] + y * e2[2]) / R]);
}

/**
 * Patch frame for a graph lake: centred on the lake, covering its coarse
 * extent plus a margin, at the given spacing.
 * @returns {{ c, e1, e2, x0, y0, spacing, nx, ny }}
 */
export function lakePatchFrame(lake, N, { R, spacing = 16, marginM = 1500, marginFrac = 0.3 }) {
    let sx = 0, sy = 0, sz = 0;
    for (const cell of lake.cells) { const d = cellDir(cell, N); sx += d[0]; sy += d[1]; sz += d[2]; }
    const c = normalize([sx, sy, sz]);
    const frame = { c, ...tangentBasis(c) };
    // Cell half-size (largest, at the face centre) pads the cell centres.
    const half = (Math.PI / 2) * R / N * 0.75;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const cell of lake.cells) {
        const [x, y] = dirToPlane(cellDir(cell, N), frame, R);
        xMin = Math.min(xMin, x - half); xMax = Math.max(xMax, x + half);
        yMin = Math.min(yMin, y - half); yMax = Math.max(yMax, y + half);
    }
    const m = Math.max(marginM, marginFrac * Math.max(xMax - xMin, yMax - yMin));
    xMin -= m; xMax += m; yMin -= m; yMax += m;
    const nx = Math.ceil((xMax - xMin) / spacing), ny = Math.ceil((yMax - yMin) / spacing);
    return { ...frame, x0: xMin, y0: yMin, spacing, nx, ny };
}

/** Grows a frame by `factor` around its centre (same spacing). */
export function growPatchFrame(f, factor) {
    const cx = f.x0 + f.nx * f.spacing / 2, cy = f.y0 + f.ny * f.spacing / 2;
    const nx = Math.ceil(f.nx * factor), ny = Math.ceil(f.ny * factor);
    return { ...f, nx, ny, x0: cx - nx * f.spacing / 2, y0: cy - ny * f.spacing / 2 };
}

/**
 * Same extent, coarser spacing if the patch has more than maxCells cells
 * (very large lakes; memory and time of the solve grow with the cell count).
 */
export function limitPatchCells(f, maxCells) {
    if (f.nx * f.ny <= maxCells) return f;
    const spacing = f.spacing * Math.sqrt(f.nx * f.ny / maxCells) * 1.0001;
    const w = f.nx * f.spacing, h = f.ny * f.spacing;
    return { ...f, spacing, nx: Math.ceil(w / spacing), ny: Math.ceil(h / spacing) };
}

/**
 * Where lake water may show, for rendering: 2 = lake (below the level),
 * 1 = shore band (rim cells with level <= h < level + bandM, connected to
 * the lake), 0 = never. The band covers sub-patch terrain detail: the
 * renderer decides the exact shoreline per pixel from the real terrain
 * height, the mask only stops water outside the basin (the outlet valley
 * and neighbouring basins below the level stay 0).
 */
export function lakeMask(heights, nx, ny, region, level, bandM) {
    const mask = new Uint8Array(nx * ny);
    const stack = [];
    for (let k = 0; k < nx * ny; k++) if (region[k]) { mask[k] = 2; stack.push(k); }
    while (stack.length) {
        const id = stack.pop(), i = id % nx, j = (id - i) / nx;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const nb = jj * nx + ii;
            if (mask[nb]) continue;
            const h = heights[nb];
            if (h < level || h >= level + bandM) continue;
            mask[nb] = 1; stack.push(nb);
        }
    }
    return mask;
}

/**
 * Seed for a graph lake on its patch: the lowest patch cell whose coarse
 * cell belongs to the lake. -1 if no patch cell falls on the lake.
 */
export function lakeSeed(heights, frame, lake, lakeOf, N, R) {
    let seed = -1;
    for (let j = 0; j < frame.ny; j++) {
        const y = frame.y0 + (j + 0.5) * frame.spacing;
        for (let i = 0; i < frame.nx; i++) {
            const id = j * frame.nx + i;
            if (seed !== -1 && heights[id] >= heights[seed]) continue;
            const x = frame.x0 + (i + 0.5) * frame.spacing;
            if (lakeOf[dirToCell(planeToDir(x, y, frame, R), N)] === lake.id) seed = id;
        }
    }
    return seed;
}

/**
 * Solves one lake on a height patch.
 * @param {object} p
 * @param {Float32Array} p.heights  nx * ny heights (metres), row-major (j * nx + i)
 * @param {number} p.nx
 * @param {number} p.ny
 * @param {number} p.seed           a cell inside the lake's basin (its lowest, ideally)
 * @returns {{ level, region: Uint8Array, cells, maxDepth, outlet, exit, touchesBorder } | null}
 *   null when the seed is not in a basin (no water at fine scale).
 *   touchesBorder: the lake reaches the patch border or spills over it, so
 *   the level is not trustworthy; solve again on a larger patch.
 */
export function solveLakePatch({ heights, nx, ny, seed }) {
    const n = nx * ny;
    const fill = new Float64Array(n);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap(n);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            if (i !== 0 && j !== 0 && i !== nx - 1 && j !== ny - 1) continue;
            const id = j * nx + i;
            closed[id] = 1; fill[id] = heights[id]; heap.push(heights[id], id);
        }
    }
    while (heap.size > 0) {
        const id = heap.pop(), i = id % nx, j = (id - i) / nx;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const nb = jj * nx + ii;
            if (closed[nb]) continue;
            closed[nb] = 1;
            fill[nb] = Math.max(heights[nb], fill[id]);
            parent[nb] = id;
            heap.push(fill[nb], nb);
        }
    }
    const level = fill[seed];
    if (!(level > heights[seed])) return null;

    // The lake: connected cells below the level, from the seed.
    const region = new Uint8Array(n);
    const stack = [seed];
    region[seed] = 1;
    let cells = 0, minH = Infinity, touchesBorder = false;
    while (stack.length) {
        const id = stack.pop(), i = id % nx, j = (id - i) / nx;
        cells++;
        minH = Math.min(minH, heights[id]);
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) touchesBorder = true;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const nb = jj * nx + ii;
            if (region[nb] || !(heights[nb] < level)) continue;
            region[nb] = 1; stack.push(nb);
        }
    }
    // Outlet: follow the drainage from the seed out of the lake.
    let outlet = seed;
    while (parent[outlet] !== -1 && region[parent[outlet]]) outlet = parent[outlet];
    const exit = parent[outlet];
    // A real spill drops below the level before the drainage leaves the
    // patch. If it never does, a border cell set the level (the sill may sit
    // on a flat ring at the level, not on the border itself).
    let root = exit;
    while (root !== -1 && parent[root] !== -1) root = parent[root];
    if (root === -1 || fill[root] >= level) touchesBorder = true;
    return { level, region, cells, maxDepth: level - minH, outlet, exit, touchesBorder };
}
