// tools/perf/riverMetrics/lakeSpill.js
//
// Bank spill (river redesign, carve near lakes): ground beside a river's
// channel that the carve lowered below an adjacent lake's level. The lake
// draws water wherever the ground is below its level near its solved water
// (lakeMaskSdf.js), so such ground floods in fragments at outlets and
// inlets (owner 2026-10-13, water-look v76, v81). Only within nearM of the
// lake's natural water (its shore band reaches 16 m); inside a channel the
// water is meant to be there and is not counted.

/**
 * @param {Float32Array} h   carved heights, row-major nx * ny
 * @param {Float32Array} h0  natural heights
 * @param {number} level     the lake's level (m)
 * @param {(i: number) => boolean} inChannel  whether sample i lies in a river's channel
 * @param {number} cellM2    area of one sample
 * @param {{ nx: number, spacing: number, nearM?: number }} grid
 * @returns {{ spillM2: number, channelM2: number, naturalM2: number }}
 *   spill: banks lowered below the level that were above it; channel: the
 *   same inside channels; natural: ground below the level before the carve
 */
export function lakeSpill(h, h0, level, inChannel, cellM2, { nx, spacing, nearM = 20 }) {
    const near = distanceTo(h0.map(v => (v < level ? 1 : 0)), nx, h.length / nx, spacing);
    let spill = 0, channel = 0, natural = 0;
    for (let i = 0; i < h.length; i++) {
        if (h0[i] < level) { natural++; continue; }
        if (h[i] >= level || near[i] > nearM) continue;
        if (inChannel(i)) channel++; else spill++;
    }
    return { spillM2: spill * cellM2, channelM2: channel * cellM2, naturalM2: natural * cellM2 };
}

/**
 * Whether plane points lie within a river's half-width of its traced line
 * (the channel), for river records given as plane polylines with half-widths.
 * @param {Array<{ xy: Float64Array, hw: Float64Array }>} rivers
 * @returns {(x: number, y: number) => boolean}
 */
export function channelTest(rivers) {
    return (x, y) => {
        for (const { xy, hw } of rivers) {
            for (let k = 0; k + 1 < hw.length; k++) {
                const ax = xy[2 * k], ay = xy[2 * k + 1], ux = xy[2 * k + 2] - ax, uy = xy[2 * k + 3] - ay;
                const t = Math.max(0, Math.min(1, ((x - ax) * ux + (y - ay) * uy) / (ux * ux + uy * uy || 1e-9)));
                const r = hw[k] + (hw[k + 1] - hw[k]) * t;
                if (Math.hypot(x - ax - t * ux, y - ay - t * uy) <= r) return true;
            }
        }
        return false;
    };
}

/** Chamfer distance (m, within 8 %) of each sample to the nearest set one. */
export function distanceTo(set, nx, ny, spacing) {
    const d = new Float64Array(nx * ny).fill(Infinity), a = spacing, b = spacing * Math.SQRT2;
    for (let i = 0; i < d.length; i++) if (set[i]) d[i] = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + a);
        if (y > 0) {
            d[i] = Math.min(d[i], d[i - nx] + a);
            if (x > 0) d[i] = Math.min(d[i], d[i - nx - 1] + b);
            if (x + 1 < nx) d[i] = Math.min(d[i], d[i - nx + 1] + b);
        }
    }
    for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
        const i = y * nx + x;
        if (x + 1 < nx) d[i] = Math.min(d[i], d[i + 1] + a);
        if (y + 1 < ny) {
            d[i] = Math.min(d[i], d[i + nx] + a);
            if (x + 1 < nx) d[i] = Math.min(d[i], d[i + nx + 1] + b);
            if (x > 0) d[i] = Math.min(d[i], d[i + nx - 1] + b);
        }
    }
    return d;
}
