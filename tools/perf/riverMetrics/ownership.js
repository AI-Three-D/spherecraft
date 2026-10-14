// tools/perf/riverMetrics/ownership.js
//
// Who draws the water at a camera pose (river redesign R1(a),
// CLAUDE_LAKE_RIVER_HANDOFF.md section 10), from two captures in the water
// debug views 6 and 7 (waterWgsl.js applyWater), taken with post-processing,
// sky and overlays off (waterViews.mjs owner views). Every pass writes a
// flat colour, summed where passes overlap; tone mapping saturates a channel
// that is on.
//   view 6: red the terrain shading draws river water, green a river ribbon,
//           blue the simulated surface;
//   view 7: red within a river's zone, green the ground below that river's
//           water, blue lake water (terrain shading or lake sheet).
// The river area is the zone plus any river water. Its pixels are classed
// by their owners (terrain shading, ribbon, simulated surface, lake water):
// one, two or more ('multi'), none where the ground is below the water
// ('gap'), or none over dry ground ('dry'). Shares are of the wet pixels
// (owned or gap). A channel neither on nor off (anything not hidden) makes
// a pixel 'other'.

export const OWNER_ON = 200, OWNER_OFF = 55;
export const OWNER_CLASSES = ['background', 'terrain', 'ribbon', 'sim', 'lake', 'multi', 'gap', 'dry', 'other', 'lakeOutside'];
const C = Object.fromEntries(OWNER_CLASSES.map((k, i) => [k, i]));
const AREA = new Set([C.terrain, C.ribbon, C.sim, C.lake, C.multi, C.gap, C.dry]);
export const OWNER_COLOURS = {
    terrain: [0, 170, 255], ribbon: [60, 200, 60], sim: [255, 200, 0], lake: [0, 60, 150],
    multi: [255, 0, 200], gap: [255, 40, 0], dry: [130, 130, 130], other: [0, 0, 0], lakeOutside: [0, 35, 90],
};

/**
 * @param {{w,h,px}} a  view 6 capture (rgb)
 * @param {{w,h,px}} b  view 7 capture
 * @param {{w,h,px}} [base]  the normal capture, dimmed as the image's background
 * @returns {{ w, h, counts, shares, isolated, image: Uint8Array }}
 */
export function classifyOwners(a, b, base = null) {
    if (a.w !== b.w || a.h !== b.h) throw new Error('capture sizes differ');
    const { w, h } = a, n = w * h, cls = new Uint8Array(n);
    const bit = (v) => (v >= OWNER_ON ? 1 : v <= OWNER_OFF ? 0 : -1);
    for (let i = 0; i < n; i++) {
        const T = bit(a.px[3 * i]), Rb = bit(a.px[3 * i + 1]), S = bit(a.px[3 * i + 2]);
        const Z = bit(b.px[3 * i]), B = bit(b.px[3 * i + 1]), L = bit(b.px[3 * i + 2]);
        if (T < 0 || Rb < 0 || S < 0 || Z < 0 || B < 0 || L < 0) { cls[i] = C.other; continue; }
        if (!(Z || T || Rb || S)) { cls[i] = L ? C.lakeOutside : C.background; continue; }
        const owners = T + Rb + S + L;
        cls[i] = owners >= 2 ? C.multi : owners === 1 ? (T ? C.terrain : Rb ? C.ribbon : S ? C.sim : C.lake) : B ? C.gap : C.dry;
    }
    // Isolated: a river-area pixel with no 4-neighbour of its class (speckle).
    let isolated = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, c = cls[i];
        if (!AREA.has(c)) continue;
        if (!((x > 0 && cls[i - 1] === c) || (x + 1 < w && cls[i + 1] === c) || (y > 0 && cls[i - w] === c) || (y + 1 < h && cls[i + w] === c))) isolated++;
    }
    const counts = Object.fromEntries(OWNER_CLASSES.map(k => [k, 0]));
    for (let i = 0; i < n; i++) counts[OWNER_CLASSES[cls[i]]]++;
    // Shares of the wet pixels (owned or gap); the zone's dry ground only in counts.
    const WET = ['terrain', 'ribbon', 'sim', 'lake', 'multi', 'gap'];
    const area = [...AREA].reduce((s, c) => s + counts[OWNER_CLASSES[c]], 0), wet = WET.reduce((s, k) => s + counts[k], 0);
    const shares = { area, wet };
    for (const k of WET) shares[k] = wet ? counts[k] / wet : null;
    shares.isolated = wet ? isolated / wet : null;
    const image = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
        const k = OWNER_CLASSES[cls[i]];
        if (k === 'background') {
            for (let j = 0; j < 3; j++) image[3 * i + j] = base ? Math.round(base.px[3 * i + j] * 0.3) : 16;
        } else image.set(OWNER_COLOURS[k], 3 * i);
    }
    return { w, h, counts, shares, isolated, image };
}

/**
 * Cross-check against the earlier method (water-look v61): of the pixels a
 * capture changes when the ribbons are not drawn, the share view 6 shows
 * green. Pixels change where |a - b| summed over rgb exceeds threshold.
 */
export function ribbonContainment(withRibbons, withoutRibbons, view6, threshold = 40) {
    let changed = 0, green = 0;
    for (let i = 0; i < view6.w * view6.h; i++) {
        const d = Math.abs(withRibbons.px[3 * i] - withoutRibbons.px[3 * i]) + Math.abs(withRibbons.px[3 * i + 1] - withoutRibbons.px[3 * i + 1])
            + Math.abs(withRibbons.px[3 * i + 2] - withoutRibbons.px[3 * i + 2]);
        if (d <= threshold) continue;
        changed++;
        if (view6.px[3 * i + 1] >= OWNER_ON) green++;
    }
    return { changed, green, share: changed ? green / changed : null };
}
