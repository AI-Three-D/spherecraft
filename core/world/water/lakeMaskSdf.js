// core/world/water/lakeMaskSdf.js
//
// Lake masks as a signed distance to the solved water (the lake's region,
// mask value 2): positive inside, negative outside, in metres, so that
// water is allowed only where the rendered ground is below the level AND
// within shoreWidthM of the solved water (waterWgsl.js waterLakeHitIn,
// near meshes). The binary mask with its shore band (up to 3 cells where
// the 32 m ground is less than 6 m above the level) let water into every
// dip of a 96 m wide rim: pockets on the rim and flat sheets over the
// ground beyond a sill (owner 2026-10-12, water-look v7). Next to the
// region the 32 m ground is at or above the level, so a sheet cut at
// -spacing/2 ends under the ground. A distance field also interpolates
// across coarse atlas texels without dilating the mask.
// Encoding (r8): 128 + F metres, clamped to +-127.

export const LAKE_SDF_RANGE_M = 127;
// Distances are exact out to this; farther cells get +-LAKE_SDF_RANGE_M (only
// values near the -spacing/2 contour matter, also under max-downsampling).
export const LAKE_SDF_EXACT_M = 64;

/**
 * Signed distance (m) of each cell centre to the region's boundary: inside
 * cells + (distance to the nearest outside centre - spacing / 2), outside
 * cells - (distance to the nearest region centre - spacing / 2), exact
 * (Euclidean between centres) within LAKE_SDF_EXACT_M, +-LAKE_SDF_RANGE_M beyond.
 * The nearest centre of the other class is always a boundary cell of that
 * class, so only boundary cells splat their distance over a window of the
 * clamp radius (cost ~ perimeter, not area: 36 M cells over 2,830 lakes).
 * @param {Uint8Array} mask  2 = region (lake water at the solve)
 * @returns {Float32Array}
 */
export function lakeMaskSdf(mask, nx, ny, spacing) {
    const n = nx * ny, BIG = 0x7fffffff;
    const r = Math.ceil(LAKE_SDF_EXACT_M / spacing + 0.5), d2 = new Int32Array(n).fill(BIG);
    // Boundary cells: an 8-neighbour of the other class (each pair once).
    const edge = new Uint8Array(n);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i, a = mask[k] === 2;
            if (i + 1 < nx && (mask[k + 1] === 2) !== a) { edge[k] = 1; edge[k + 1] = 1; }
            if (j + 1 < ny) {
                const q = k + nx;
                if ((mask[q] === 2) !== a) { edge[k] = 1; edge[q] = 1; }
                if (i + 1 < nx && (mask[q + 1] === 2) !== a) { edge[k] = 1; edge[q + 1] = 1; }
                if (i > 0 && (mask[q - 1] === 2) !== a) { edge[k] = 1; edge[q - 1] = 1; }
            }
        }
    }
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (!edge[k]) continue;
            const a = mask[k] === 2;
            const j0 = Math.max(0, j - r), j1 = Math.min(ny - 1, j + r), i0 = Math.max(0, i - r), i1 = Math.min(nx - 1, i + r);
            for (let jj = j0; jj <= j1; jj++) {
                const dy = jj - j, row = jj * nx;
                for (let ii = i0; ii <= i1; ii++) {
                    const q = row + ii;
                    if ((mask[q] === 2) === a) continue;
                    const dx = ii - i, dd = dx * dx + dy * dy;
                    if (dd < d2[q]) d2[q] = dd;
                }
            }
        }
    }
    const F = new Float32Array(n), half = spacing / 2;
    for (let k = 0; k < n; k++) {
        const m = d2[k] === BIG ? LAKE_SDF_RANGE_M : Math.min(LAKE_SDF_RANGE_M, Math.sqrt(d2[k]) * spacing - half);
        F[k] = mask[k] === 2 ? m : -m;
    }
    return F;
}

/**
 * The field at point (x, y) m of the lake's frame, bilinear between cell
 * centres (the shader samples its atlas tile smoothed, waterWgsl.js);
 * -LAKE_SDF_RANGE_M outside the patch (no water there).
 * @param {Float32Array} F  lakeMaskSdf
 * @param {{ nx, ny, spacing, x0, y0 }} frame
 */
export function lakeSdfAt(F, frame, x, y) {
    const { nx, ny, spacing, x0, y0 } = frame;
    const u = (x - x0) / spacing, v = (y - y0) / spacing;
    if (!(u >= 0 && v >= 0 && u <= nx && v <= ny)) return -LAKE_SDF_RANGE_M;
    const at = (i, j) => F[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
    const i = Math.floor(u - 0.5), j = Math.floor(v - 0.5), a = u - 0.5 - i, b = v - 0.5 - j;
    return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
}

/**
 * The field on an S x S atlas tile over the same extent: bilinear where
 * the tile is as fine as the mask or finer; where it is coarser, the
 * largest value of the cells under each texel (keeps narrow water, as the
 * binary upload's "any water" did). Encoded 128 + F.
 * @returns {Uint8Array}
 */
export function resampleLakeMaskSdf(F, nx, ny, S) {
    const out = new Uint8Array(S * S), enc = (v) => Math.max(1, Math.min(255, Math.round(128 + Math.max(-LAKE_SDF_RANGE_M, Math.min(LAKE_SDF_RANGE_M, v)))));
    const at = (i, j) => F[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
    for (let b = 0; b < S; b++) {
        for (let a = 0; a < S; a++) {
            let v;
            if (nx <= S && ny <= S) {
                const x = (a + 0.5) * nx / S - 0.5, y = (b + 0.5) * ny / S - 0.5;
                const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
                v = (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
            } else {
                const i0 = Math.floor(a * nx / S), i1 = Math.max(i0 + 1, Math.floor((a + 1) * nx / S));
                const j0 = Math.floor(b * ny / S), j1 = Math.max(j0 + 1, Math.floor((b + 1) * ny / S));
                v = -Infinity;
                for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) v = Math.max(v, at(i, j));
            }
            out[b * S + a] = enc(v);
        }
    }
    return out;
}
