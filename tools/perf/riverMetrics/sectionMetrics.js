// tools/perf/riverMetrics/sectionMetrics.js
//
// River cross-section metrics (river redesign R1(b), CLAUDE_LAKE_RIVER_HANDOFF.md
// section 10). Pure functions of sampled heights: the same code measures the
// ground the tiles draw (sampled in the browser, waterViews.mjs metrics
// views) and, from R2 on, the river cross-section function alone.
//
// A section: the ground as drawn h (valleys and carve) and the natural
// terrain h0 at offsets n_i = (i - mid) dn across the river (m, + left of the
// flow; mid = the traced line), the water level wl (m), how far each side is
// valid (riverSections.js clipExtents) and the LOD-0 vertex spacing (m).
// Per side, from the line outward:
// - wet edge: where the ground first rises above the water;
// - bank: the ground's rise above the water 2, 10 and 20 m past the wet edge
//   and the steepest 1 m slope within 10 m of it. Classes from the rise at
//   10 m: none (below noBankM, the ground grades out of the water), low
//   (below highBankM), high. (A bank top found where the ground levels off
//   flipped between a bench by the water and the whole valley side from one
//   station to the next: water-look v62, v63.)
// - blend: from the wet edge to where the ground stays within blendTolM of
//   the natural terrain for blendRunM, i.e. how far the river reshapes its
//   surroundings;
// - pockets: ground below the water within pocketM past the wet edge.
// Over the whole valid section, ledges: runs steeper than ledgeSlope over
// 0.5 m rising at least ledgeMinRiseM, with their width in LOD-0 spacings
// (the terrain grid draws a wall narrower than ~2 spacings as a saw-tooth
// where a bank crosses it at an angle: water-look v44). Over the band the
// river reshaped (ground off the natural terrain), teeth: the worst gap
// between the ground and its linear interpolation through a grid of the
// LOD-0 spacing x sqrt 2 (a triangle's diagonal), over all of the grid's
// offsets: the saw-tooth's height. A smooth slope of any steepness has
// none; a sharp corner has much (ledges also counted 45-degree slopes
// that merely hovered at the threshold: water-look R2).
// On the traced line: trench = natural ground - water level.

export const SECTION_DEFAULTS = Object.freeze({
    blendTolM: 0.1, blendRunM: 2,
    pocketM: 20,
    ledgeSlope: 1, ledgeMinRiseM: 0.3,
    // Bank classes by the rise 10 m past the wet edge.
    noBankM: 0.5, highBankM: 2,
    // A dry line: water is searched this far (m) to either side of it.
    drySearchM: 30,
});

/**
 * @param {object} x
 * @param {ArrayLike<number>} x.h   ground as drawn (m), odd length, the traced line in the middle
 * @param {ArrayLike<number>} x.h0  natural ground (m), same offsets
 * @param {number} x.dn             sample spacing across (m)
 * @param {number} x.wl             water level (m)
 * @param {number} x.extentL        valid offset on the left (m, riverSections.js clipExtents)
 * @param {number} x.extentR        valid offset on the right (m, positive)
 * @param {number} x.spacing        LOD-0 vertex spacing (m)
 */
export function sectionMetrics(x, P = SECTION_DEFAULTS) {
    const { h, h0, dn, wl, spacing } = x;
    const count = h.length, mid = (count - 1) >> 1;
    const iMin = Math.max(0, mid - Math.floor(x.extentR / dn + 1e-9)), iMax = Math.min(count - 1, mid + Math.floor(x.extentL / dn + 1e-9));
    const nAt = (i) => (i - mid) * dn;
    const clamp = (i) => Math.min(iMax, Math.max(iMin, i));
    const out = { trench: h0[mid] - wl, depthLine: wl - h[mid], lineDry: !(h[mid] < wl), dry: false,
        edgeL: null, edgeR: null, left: null, right: null, ledges: [] };

    // Water: from the line, or from the nearest wet sample within drySearchM.
    let start = mid;
    if (out.lineDry) {
        start = -1;
        const lim = Math.round(P.drySearchM / dn);
        for (let k = 1; k <= lim && start < 0; k++) {
            if (mid + k <= iMax && h[mid + k] < wl) start = mid + k;
            else if (mid - k >= iMin && h[mid - k] < wl) start = mid - k;
        }
        out.dry = start < 0;
    }

    const w1 = Math.max(1, Math.round(0.5 / dn));   // half of 1 m, in samples
    const bankSide = (ie, side, edge) => {
        const end = side > 0 ? iMax : iMin;
        // Outward rise per metre over 1 m centred at i.
        const slopeOut = (i) => {
            const a = clamp(i - side * w1), b = clamp(i + side * w1);
            return a === b ? 0 : (h[b] - h[a]) / Math.abs(nAt(b) - nAt(a));
        };
        // Rise above the water d m past the wet edge (null beyond the valid section).
        const riseAt = (d) => {
            const xi = mid + (edge + side * d) / dn, i0 = Math.floor(xi);
            return i0 < iMin || i0 + 1 > iMax ? null : h[i0] + (h[i0 + 1] - h[i0]) * (xi - i0) - wl;
        };
        let steep10 = -Infinity;
        for (let j = ie; j !== end + side && Math.abs(nAt(j) - edge) <= 10; j += side) steep10 = Math.max(steep10, slopeOut(j));
        // Blend: the ground back within blendTolM of the natural terrain for blendRunM.
        const runN = Math.max(1, Math.round(P.blendRunM / dn));
        let iBlend = -1, streak = 0;
        for (let j = ie; j !== end + side; j += side) {
            if (Math.abs(h[j] - h0[j]) < P.blendTolM) {
                if (++streak >= runN) { iBlend = j - side * (runN - 1); break; }
            } else streak = 0;
        }
        const blendOpen = iBlend < 0;
        const blend = Math.abs(nAt(blendOpen ? end : iBlend) - edge);
        let pocket = 0;
        for (let j = ie; j !== end + side && Math.abs(nAt(j) - edge) <= P.pocketM; j += side) if (h[j] < wl) pocket += dn;
        const rise10 = riseAt(10);
        const cls = rise10 == null ? null : rise10 < P.noBankM ? 'none' : rise10 < P.highBankM ? 'low' : 'high';
        return { open: false, edge, wet: side * edge, rise2: riseAt(2), rise10, rise20: riseAt(20),
            steep10: Number.isFinite(steep10) ? steep10 : null, blend, blendOpen, pocket, cls };
    };

    if (!out.dry) {
        for (const side of [1, -1]) {
            const end = side > 0 ? iMax : iMin, key = side > 0 ? 'left' : 'right';
            let i = start;
            while (i !== end && h[i + side] < wl) i += side;
            if (i === end) { out[key] = { open: true }; continue; }
            // i: the last wet sample, i + side the first dry one.
            const a = h[i], b = h[i + side];
            const edge = nAt(i) + side * dn * (wl - a) / (b - a);
            out[side > 0 ? 'edgeL' : 'edgeR'] = edge;
            out[key] = bankSide(i + side, side, edge);
        }
    }

    // Ledges: runs of one sign steeper than ledgeSlope over 0.5 m.
    const w05 = Math.max(1, Math.round(0.25 / dn));
    let runStart = -1, runSign = 0;
    const flush = (last) => {
        const a = clamp(runStart - 1), b = clamp(last + 1);
        const rise = Math.abs(h[b] - h[a]), width = (last - runStart + 1) * dn;
        if (rise >= P.ledgeMinRiseM) out.ledges.push({ n: (nAt(runStart) + nAt(last)) / 2, width, rise, spacings: width / spacing });
    };
    for (let i = iMin; i <= iMax; i++) {
        const a = clamp(i - w05), b = clamp(i + w05);
        const sl = a === b ? 0 : (h[b] - h[a]) / (nAt(b) - nAt(a));
        const sign = sl >= P.ledgeSlope ? 1 : sl <= -P.ledgeSlope ? -1 : 0;
        if (sign !== runSign) {
            if (runSign !== 0) flush(i - 1);
            runStart = i;
            runSign = sign;
        }
    }
    if (runSign !== 0) flush(iMax);
    // Teeth over the reshaped band (plus the grid step on each side).
    const step = Math.max(2, Math.round(spacing * Math.SQRT2 / dn));
    let b0 = -1, b1 = -1;
    for (let i = iMin; i <= iMax; i++) if (Math.abs(h[i] - h0[i]) > 0.01) { if (b0 < 0) b0 = i; b1 = i; }
    out.teeth = 0;
    if (b0 >= 0) {
        const lo = Math.max(iMin, b0 - step), hi = Math.min(iMax, b1 + step);
        for (let phase = 0; phase < step; phase++) for (let i0 = lo + phase; i0 + step <= hi; i0 += step) {
            const a = h[i0], b = h[i0 + step];
            for (let j = 1; j < step; j++) {
                const e = Math.abs(h[i0 + j] - (a + (b - a) * j / step));
                if (e > out.teeth) { out.teeth = e; out.teethN = nAt(i0 + j); }
            }
        }
    }
    return out;
}

/** Linear-interpolated quantile of numbers (null when empty). */
export function quantile(values, p) {
    const v = Float64Array.from(values).sort();
    if (!v.length) return null;
    const x = p * (v.length - 1), i = Math.floor(x), f = x - i;
    return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * f : v[i];
}
const q3 = (v) => ({ p10: quantile(v, 0.1), p50: quantile(v, 0.5), p90: quantile(v, 0.9) });
const share = (k, n) => (n ? k / n : null);
const CLASSES = ['high', 'low', 'none'];

/**
 * Summary of one river's sections, in station order.
 * @param {Array<object>} rows  sectionMetrics results with { s, inLake, spacing }; inLake rows are skipped
 * @param {object} o
 * @param {number} o.stepM  station spacing (m)
 */
export function summarizeRiver(rows, { stepM }, P = SECTION_DEFAULTS) {
    const use = rows.filter(r => r && !r.inLake);
    const wet = use.filter(r => !r.dry);
    const closed = wet.filter(r => !r.left.open && !r.right.open);
    const widths = closed.map(r => r.edgeL - r.edgeR);
    const w = q3(widths);
    const sideSummary = (key) => {
        const rs = wet.filter(r => !r[key].open).map(r => r[key]);
        const num = (k) => rs.map(b => b[k]).filter(v => v != null);
        const classed = rs.filter(b => b.cls);
        // Runs of one class along the river; a station without a class on this side ends a run.
        const runs = Object.fromEntries(CLASSES.map(k => [k, []]));
        let cls = null, len = 0;
        for (const r of rows) {
            const c = r && !r.inLake && !r.dry && !r[key].open ? r[key].cls : null;
            if (c && c === cls) { len += stepM; continue; }
            if (cls) runs[cls].push(len);
            cls = c;
            len = c ? stepM : 0;
        }
        if (cls) runs[cls].push(len);
        return {
            n: rs.length,
            rise2: q3(num('rise2')), rise10: q3(num('rise10')), rise20: q3(num('rise20')), steep10: q3(num('steep10')),
            blend: q3(rs.map(b => b.blend)),
            blendOpen: share(rs.filter(b => b.blendOpen).length, rs.length),
            blend50: share(rs.filter(b => b.blend >= 50).length, rs.length),
            pockets: share(rs.filter(b => b.pocket >= 1).length, rs.length),
            classes: Object.fromEntries(CLASSES.map(k => [k, share(classed.filter(b => b.cls === k).length, classed.length)])),
            classRunMedianM: Object.fromEntries(CLASSES.map(k => [k, quantile(runs[k], 0.5)])),
        };
    };
    const both = closed.filter(r => r.left.cls && r.right.cls);
    const ledges = use.flatMap(r => r.ledges);
    const under2 = ledges.filter(l => l.spacings < 2);
    const bankKm = 2 * use.length * stepM / 1000;
    return {
        stations: rows.length, measured: use.length, inLake: rows.filter(r => r?.inLake).length,
        dry: share(use.length - wet.length, use.length),
        lineDry: share(use.filter(r => r.lineDry).length, use.length),
        open: { left: share(wet.filter(r => r.left.open).length, wet.length), right: share(wet.filter(r => r.right.open).length, wet.length) },
        width: { ...w, ratio9010: w.p10 > 0 ? w.p90 / w.p10 : null, n: widths.length },
        trench: q3(use.map(r => r.trench)),
        sides: { left: sideSummary('left'), right: sideSummary('right') },
        sidesDiffer: share(both.filter(r => r.left.cls !== r.right.cls).length, both.length),
        ledges: {
            count: ledges.length, under2: under2.length,
            under2PerKm: bankKm ? under2.length / bankKm : null,
            narrowestSpacings: ledges.length ? ledges.reduce((m, l) => Math.min(m, l.spacings), Infinity) : null,
            under2Rise: q3(under2.map(l => l.rise)),
        },
        teeth: { ...q3(use.map(r => r.teeth ?? 0)), p99: quantile(use.map(r => r.teeth ?? 0), 0.99),
            max: use.reduce((m, r) => Math.max(m, r.teeth ?? 0), 0), over15cm: share(use.filter(r => (r.teeth ?? 0) > 0.15).length, use.length) },
        spacing: q3(use.map(r => r.spacing)),
        params: P,
    };
}
