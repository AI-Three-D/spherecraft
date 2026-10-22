// Acceptance fixtures for removing the near-river analytic-profile discard.
// This models one level, one straight river, its production section, and
// final-terrain depth clipping inside its existing half-width. It does not
// reconstruct a current camera image, GPU rounding, lake masks, or confluences.
import {
    riverBankParams, riverChannel, riverSectionHeight, riverSideDepth,
} from '../../../core/world/water/riverSection.js';

export const PROFILE_FIXTURE = Object.freeze({
    spacingM: 0.25, nMinM: 0, nMaxM: 21, sMinM: -10, sMaxM: 10,
    halfWidthM: 20, bedM: 0, depthM: 2, waterLevelM: 1.5,
    // The depression is surrounded on every side by this continuous belt.
    dryBeltWidthM: 0.5,
    dryBeltOuter: Object.freeze({ nLo: 17.75, nHi: 20.25, sLo: -1.75, sHi: 1.75 }),
    dryBeltInner: Object.freeze({ nLo: 18.25, nHi: 19.75, sLo: -1.25, sHi: 1.25 }),
});

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const plateau = (x, lo, fullLo, fullHi, hi) => smooth((x - lo) / (fullLo - lo)) * smooth((hi - x) / (hi - fullHi));
const inside = (n, s, r) => n >= r.nLo && n <= r.nHi && s >= r.sLo && s <= r.sHi;

export function naturalGround(kind, n, s) {
    if (kind === 'connectedLowBank') {
        // Descend while the designed section is already below water, then
        // stay low across the bank. The new coverage connects to the core.
        return 3 - 2 * smooth(n - 14);
    }
    if (kind === 'closedPocket') {
        // C1-continuous depression: flat bottom, smooth sides, closed ends.
        return 3 - 2 * plateau(n, 18.25, 18.5, 19.5, 19.75)
            * plateau(s, -1.25, -1, 1, 1.25);
    }
    throw new Error(`Unknown profile fixture: ${kind}`);
}

export function connectedToRiver(mask, nx, ny, neighbours) {
    if (neighbours !== 4 && neighbours !== 8) throw new Error('Expected 4 or 8 neighbours');
    const reached = new Uint8Array(mask.length), queue = [];
    for (let y = 0; y < ny; y++) {
        const i = y * nx; // n = 0: known river centre.
        if (mask[i]) { reached[i] = 1; queue.push(i); }
    }
    for (let head = 0; head < queue.length; head++) {
        const i = queue[head], x = i % nx, y = Math.floor(i / nx);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || (neighbours === 4 && dx && dy)) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= nx || yy < 0 || yy >= ny) continue;
            const j = yy * nx + xx;
            if (mask[j] && !reached[j]) { reached[j] = 1; queue.push(j); }
        }
    }
    return reached;
}

export function profileCoverageFixture(kind) {
    const P = PROFILE_FIXTURE, bank = riverBankParams(1, 1);
    const nx = Math.round((P.nMaxM - P.nMinM) / P.spacingM) + 1;
    const ny = Math.round((P.sMaxM - P.sMinM) / P.spacingM) + 1;
    const before = new Uint8Array(nx * ny), after = new Uint8Array(nx * ny);
    const heights = new Float64Array(nx * ny), profiles = new Float64Array(nx * ny);
    const depth = riverSideDepth(P.depthM, bank.freeboard);
    const sectionAt = (n, h0) => riverSectionHeight({
        n, hw: P.halfWidthM, bed: P.bedM, depth: P.depthM, skew: 0, h0, left: bank, right: bank,
    });
    let dryBeltSamples = 0, dryBeltMinGroundM = Infinity;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const n = P.nMinM + x * P.spacingM, s = P.sMinM + y * P.spacingM, i = y * nx + x;
        const h0 = naturalGround(kind, n, s);
        const h = heights[i] = sectionAt(n, h0);
        const profile = profiles[i] = riverChannel(n, P.halfWidthM, P.bedM, depth, depth, 0);
        after[i] = +(n < P.halfWidthM && h < P.waterLevelM);
        before[i] = +(after[i] && profile < P.waterLevelM);
        if (kind === 'closedPocket' && inside(n, s, P.dryBeltOuter) && !inside(n, s, P.dryBeltInner)) {
            dryBeltSamples++;
            dryBeltMinGroundM = Math.min(dryBeltMinGroundM, h);
        }
    }
    const connectivity = {};
    for (const neighbours of [4, 8]) {
        const reached = connectedToRiver(after, nx, ny, neighbours);
        const reachedBefore = connectedToRiver(before, nx, ny, neighbours);
        const counts = { beforeWetSamples: 0, afterWetSamples: 0, addedWetSamples: 0,
            addedConnectedSamples: 0, addedDisconnectedSamples: 0, beforeDisconnectedSamples: 0 };
        for (let i = 0; i < after.length; i++) {
            counts.beforeWetSamples += before[i];
            counts.afterWetSamples += after[i];
            if (before[i] && !reachedBefore[i]) counts.beforeDisconnectedSamples++;
            if (after[i] && !before[i]) {
                counts.addedWetSamples++;
                if (reached[i]) counts.addedConnectedSamples++;
                else counts.addedDisconnectedSamples++;
            }
        }
        connectivity[neighbours] = counts;
    }
    // The belt has h0 = 3 everywhere. On its inward edge n = 17.75 the
    // production section gives this lower bound. The profile increases for
    // 17.75 <= n <= hw; beyond hw its non-negative bank ramps increase from
    // bank-full height. Thus this bounds the continuous belt, not only samples.
    const dryBelt = kind === 'closedPocket' ? {
        widthM: P.dryBeltWidthM,
        maximumGridEdgeM: P.spacingM * Math.SQRT2,
        samples: dryBeltSamples,
        minimumSampleGroundM: dryBeltMinGroundM,
        continuousGroundLowerBoundM: sectionAt(P.dryBeltOuter.nLo, 3),
        waterLevelM: P.waterLevelM,
    } : null;
    return { kind, nx, ny, spacingM: P.spacingM, connectivity, dryBelt, before, after, heights, profiles };
}

export function profileCoverageSummary() {
    return ['connectedLowBank', 'closedPocket'].map(kind => {
        const { nx, ny, spacingM, connectivity, dryBelt } = profileCoverageFixture(kind);
        return { kind, nx, ny, spacingM, connectivity, dryBelt };
    });
}
