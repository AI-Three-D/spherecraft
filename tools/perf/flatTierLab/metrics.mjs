// Image metrics for the flat-tier lab (flatTierLab.mjs). Pure functions over
// RGBA byte images { width, height, data } (pngjs layout), so they can be
// unit-tested without a browser.

// Terrain debug mode 90 colours, LOD0..LOD7+ (terrainChunkFragmentShaderBuilder).
export const LOD_COLORS = [
    [255, 0, 0], [255, 128, 0], [255, 255, 0], [0, 255, 0],
    [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255],
];

const px = (img, x, y) => (y * img.width + x) * 4;

/**
 * Per-pixel LOD (0..7) from a mode-90 image, -1 where it is not terrain.
 * Post-processing scales the debug colours (magenta arrives as 220,0,220),
 * so pixels are matched by their colour normalized to the brightest channel.
 */
export function lodMap(img90, tolerance = 0.3) {
    const out = new Int8Array(img90.width * img90.height).fill(-1);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        const r = img90.data[p], g = img90.data[p + 1], b = img90.data[p + 2];
        const m = Math.max(r, g, b);
        if (m < 80) continue;
        for (let l = 0; l < LOD_COLORS.length; l++) {
            const c = LOD_COLORS[l];
            const d = Math.abs(r / m - c[0] / 255) + Math.abs(g / m - c[1] / 255) + Math.abs(b / m - c[2] / 255);
            if (d <= tolerance && (l !== 7 || Math.min(r, g, b) > 0.85 * m)) { out[i] = l; break; }
        }
    }
    return out;
}

/** Fraction of terrain pixels per LOD. */
export function lodHistogram(lods) {
    const counts = new Array(LOD_COLORS.length).fill(0);
    let n = 0;
    for (const l of lods) if (l >= 0) { counts[l]++; n++; }
    return counts.map(c => (n ? c / n : 0));
}

/**
 * Tile edges: pixel pairs (p, right neighbour) and (p, lower neighbour) whose
 * mode-107 tile colours differ. Returns { right, down } Uint8Arrays (1 =
 * an edge lies between p and that neighbour), both pixels terrain.
 */
export function tileEdges(img13, lods, tolerance = 12) {
    const { width: w, height: h } = img13;
    const right = new Uint8Array(w * h), down = new Uint8Array(w * h);
    const differs = (a, b) =>
        Math.abs(img13.data[a] - img13.data[b]) + Math.abs(img13.data[a + 1] - img13.data[b + 1]) +
        Math.abs(img13.data[a + 2] - img13.data[b + 2]) > tolerance;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (lods[i] < 0) continue;
        if (x + 1 < w && lods[i + 1] >= 0 && differs(px(img13, x, y), px(img13, x + 1, y))) right[i] = 1;
        if (y + 1 < h && lods[i + w] >= 0 && differs(px(img13, x, y), px(img13, x, y + 1))) down[i] = 1;
    }
    return { right, down };
}

const step = (img, a, b) =>
    (Math.abs(img.data[a] - img.data[b]) + Math.abs(img.data[a + 1] - img.data[b + 1]) + Math.abs(img.data[a + 2] - img.data[b + 2])) / 3;

/**
 * Seam score of image `img` at the tile edges: for each edge pair, its colour
 * step minus the mean step of the pairs 2-3 px before and after it along the
 * same line (the local texture's own variation). Positive mean excess = the
 * image steps at tile edges more than elsewhere. Also split into edges
 * between tiles of the same LOD and of different LOD.
 */
export function seamScore(img, edges, lods) {
    const { width: w, height: h } = img;
    const acc = { all: [0, 0, 0], sameLod: [0, 0, 0], crossLod: [0, 0, 0] }; // [sum excess, sum step, count]
    const add = (key, s, base) => { acc[key][0] += s - base; acc[key][1] += s; acc[key][2]++; };
    for (let y = 3; y < h - 4; y++) for (let x = 3; x < w - 4; x++) {
        const i = y * w + x;
        if (edges.right[i]) {
            const ok = [-3, -2, 3, 4].every(d => lods[i + d] >= 0);
            if (ok) {
                const s = step(img, px(img, x, y), px(img, x + 1, y));
                const base = (step(img, px(img, x - 3, y), px(img, x - 2, y)) + step(img, px(img, x + 3, y), px(img, x + 4, y))) / 2;
                add('all', s, base); add(lods[i] === lods[i + 1] ? 'sameLod' : 'crossLod', s, base);
            }
        }
        if (edges.down[i]) {
            const ok = [-3, -2, 3, 4].every(d => lods[i + d * w] >= 0);
            if (ok) {
                const s = step(img, px(img, x, y), px(img, x, y + 1));
                const base = (step(img, px(img, x, y - 3), px(img, x, y - 2)) + step(img, px(img, x, y + 3), px(img, x, y + 4))) / 2;
                add('all', s, base); add(lods[i] === lods[i + w] ? 'sameLod' : 'crossLod', s, base);
            }
        }
    }
    const out = {};
    for (const [k, [ex, st, n]] of Object.entries(acc)) {
        out[k] = { pairs: n, meanStep: n ? st / n : 0, meanExcess: n ? ex / n : 0 };
    }
    return out;
}

/**
 * How much image `a` and `b` (same pose, different LOD selection) differ over
 * pixels that are terrain in both: mean absolute difference (0-255) and the
 * share of pixels differing by more than `threshold`. Restricted to pixels
 * whose LOD changed between the two when both LOD maps are given.
 */
export function lodChangeDiff(a, b, lodsA, lodsB, threshold = 12) {
    let sum = 0, n = 0, big = 0, sumChanged = 0, nChanged = 0, bigChanged = 0;
    for (let i = 0, p = 0; i < lodsA.length; i++, p += 4) {
        if (lodsA[i] < 0 || lodsB[i] < 0) continue;
        const d = (Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2])) / 3;
        sum += d; n++; if (d > threshold) big++;
        if (lodsA[i] !== lodsB[i]) { sumChanged += d; nChanged++; if (d > threshold) bigChanged++; }
    }
    return {
        pixels: n,
        meanDiff: n ? sum / n : 0,
        shareOver: n ? big / n : 0,
        lodChangedPixels: nChanged,
        meanDiffWhereLodChanged: nChanged ? sumChanged / nChanged : 0,
        shareOverWhereLodChanged: nChanged ? bigChanged / nChanged : 0,
    };
}
