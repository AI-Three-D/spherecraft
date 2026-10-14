// tools/perf/riverMetrics/carveSeams.js
//
// Seams in the carved ground (river redesign R3b): steps where the carve
// switches from one river's cross-section to another's, or ends on a line.
// Tested on the carve's depth (natural minus carved height), which the
// natural slope does not enter: where the cut starts on a steep slope, its
// depth grows steadily from zero, where the carve switches sections it jumps.
// A step is a jump between neighbouring samples much larger than the jumps on
// either side of it along the same row or column. The section caps its
// curvature (riverSection.js maxCurv 0.45 /m), so on a 0.5 m patch its first
// difference changes by about 0.11 m per sample: a 0.5 m jump next to
// differences under a quarter of it is not a ramp. Only where the carve
// changed the ground on either side.

/**
 * @param {Float32Array} h   carved heights, row-major nx * ny
 * @param {Float32Array} h0  natural heights, same patch
 * @param {number} nx
 * @param {number} ny
 * @param {object} [o]
 * @param {number} [o.minJumpM=0.5]  smallest step counted
 * @param {number} [o.isolation=4]   step / larger neighbouring difference
 * @param {number} [o.cutM=0.01]     carve depth that counts as carved
 * @returns {{ count: number, maxJumpM: number, pairs: Int32Array }}
 *   pairs: sample index and axis (0 along x, 1 along y) per seam pair
 */
export function carveSeams(h, h0, nx, ny, { minJumpM = 0.5, isolation = 4, cutM = 0.01 } = {}) {
    const c = new Float32Array(nx * ny);
    for (let i = 0; i < c.length; i++) c[i] = h0[i] - h[i];
    const pairs = [];
    let maxJumpM = 0;
    const test = (i, step, prev, next, axis) => {
        const j = Math.abs(c[i + step] - c[i]);
        if (j < minJumpM || (c[i] < cutM && c[i + step] < cutM)) return;
        const before = prev ? Math.abs(c[i] - c[i - step]) : 0, after = next ? Math.abs(c[i + 2 * step] - c[i + step]) : 0;
        if (j < isolation * Math.max(before, after)) return;
        pairs.push(i, axis);
        maxJumpM = Math.max(maxJumpM, j);
    };
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            if (x + 1 < nx) test(i, 1, x > 0, x + 2 < nx, 0);
            if (y + 1 < ny) test(i, nx, y > 0, y + 2 < ny, 1);
        }
    }
    return { count: pairs.length / 2, maxJumpM, pairs: Int32Array.from(pairs) };
}

/**
 * Grey hillshade of the carved patch (light from the north-west, 45 degrees
 * up), the carve's depth tinted blue (full at 5 m), seams red. Row 0 first.
 * @returns {Uint8Array} rgb, nx * ny * 3
 */
export function seamImage(h, h0, nx, ny, spacing, seams) {
    const px = new Uint8Array(nx * ny * 3);
    const L = [-0.5, 0.5, Math.SQRT1_2];
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            const dx = (h[y * nx + Math.min(nx - 1, x + 1)] - h[y * nx + Math.max(0, x - 1)]) / (2 * spacing);
            const dy = (h[Math.min(ny - 1, y + 1) * nx + x] - h[Math.max(0, y - 1) * nx + x]) / (2 * spacing);
            const shade = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) / Math.hypot(dx, dy, 1));
            const cut = Math.min(1, Math.max(0, (h0[i] - h[i]) / 5)), g = 40 + 200 * shade;
            px[3 * i] = g * (1 - 0.5 * cut); px[3 * i + 1] = g * (1 - 0.3 * cut); px[3 * i + 2] = Math.min(255, g + 60 * cut);
        }
    }
    for (let k = 0; k < seams.pairs.length; k += 2) px.set([255, 0, 0], 3 * seams.pairs[k]);
    return px;
}
