// tools/perf/riverMetrics/riverCoverage.js
//
// How common rivers are (owner 2026-10-13: "it's still very hard to find
// rivers. They should be more common"): the distance (m) from every cell of
// the water graph's cube-sphere grid (waterGraph.js) to the nearest river
// cell, by Dijkstra over the grid's neighbours with centre-to-centre
// distances, and the land's share within given distances. Pure JavaScript.

import { MinHeap, cellDir, makeNeighbors } from '../../../core/world/hydrology/waterGraph.js';

/**
 * @param {number} N  cells per face side
 * @param {number} R  planet radius (m)
 * @param {Iterable<number>} sources  river cells
 * @returns {Float32Array} distance (m) per cell (Infinity where unreachable)
 */
export function distanceToCells(N, R, sources) {
    const total = 6 * N * N, dist = new Float32Array(total).fill(Infinity), closed = new Uint8Array(total);
    const neighbors = makeNeighbors(N), heap = new MinHeap(total);
    const push = (key, id) => {
        if (heap.size === heap.keys.length) {
            const keys = new Float64Array(2 * heap.size), ids = new Int32Array(2 * heap.size);
            keys.set(heap.keys); ids.set(heap.ids); heap.keys = keys; heap.ids = ids;
        }
        heap.push(key, id);
    };
    const dir = new Float64Array(3 * total);
    for (let c = 0; c < total; c++) dir.set(cellDir(c, N), 3 * c);
    for (const c of sources) if (dist[c] !== 0) { dist[c] = 0; push(0, c); }
    while (heap.size) {
        const c = heap.pop();
        if (closed[c]) continue;
        closed[c] = 1;
        const d = dist[c], { list, count } = neighbors(c);
        for (let m = 0; m < count; m++) {
            const e = list[m];
            if (closed[e]) continue;
            const step = Math.hypot(dir[3 * c] - dir[3 * e], dir[3 * c + 1] - dir[3 * e + 1], dir[3 * c + 2] - dir[3 * e + 2]) * R;
            if (d + step < dist[e]) { dist[e] = d + step; push(d + step, e); }
        }
    }
    return dist;
}

/** Quantiles of the distance over the cells where mask is set, and the share within each of withinM. */
export function coverage(dist, mask, withinM = [2000, 5000, 10000]) {
    const v = [];
    for (let c = 0; c < dist.length; c++) if (mask[c]) v.push(dist[c]);
    const s = Float64Array.from(v).sort(), q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null);
    return {
        cells: s.length, p50: q(0.5), p90: q(0.9),
        within: Object.fromEntries(withinM.map(w => [w, s.length ? v.filter(x => x <= w).length / s.length : null])),
    };
}
