// Offline evidence for a frozen-camera shader A/B capture.
// Usage: node tools/perf/waterStepReview/analyze.mjs <capture-directory>
// These are screen-space comparisons, not waterline/contact or hydrology tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readPng, writePng } from '../riverMetrics/png.js';
import { classifyOwners, OWNER_ON } from '../riverMetrics/ownership.js';

const RGB_SUM_THRESHOLD = 40;
const COMPONENT_LIST_MIN_PIXELS = 8;

function sameSize(a, b) {
    if (a.w !== b.w || a.h !== b.h) throw new Error(`Image sizes differ: ${a.w}x${a.h}, ${b.w}x${b.h}`);
}

function emptyBounds() {
    return { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
}

function growBounds(bounds, x, y) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
}

function finishBounds(bounds) {
    if (bounds.maxX < 0) return null;
    return { ...bounds, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1 };
}

export function compareImages(a, b, threshold = RGB_SUM_THRESHOLD) {
    sameSize(a, b);
    let exactPixels = 0, thresholdPixels = 0, maxChannelDifference = 0, absoluteChannelDifferenceSum = 0;
    const exactBounds = emptyBounds(), thresholdBounds = emptyBounds();
    for (let i = 0; i < a.w * a.h; i++) {
        let difference = 0;
        for (let channel = 0; channel < 3; channel++) {
            const d = Math.abs(a.px[3 * i + channel] - b.px[3 * i + channel]);
            difference += d;
            maxChannelDifference = Math.max(maxChannelDifference, d);
        }
        absoluteChannelDifferenceSum += difference;
        const x = i % a.w, y = Math.floor(i / a.w);
        if (difference > 0) { exactPixels++; growBounds(exactBounds, x, y); }
        if (difference > threshold) { thresholdPixels++; growBounds(thresholdBounds, x, y); }
    }
    return {
        pixels: a.w * a.h,
        exact: { changedPixels: exactPixels, share: exactPixels / (a.w * a.h), bounds: finishBounds(exactBounds) },
        threshold: { rgbAbsoluteDifferenceSumGreaterThan: threshold, changedPixels: thresholdPixels,
            share: thresholdPixels / (a.w * a.h), bounds: finishBounds(thresholdBounds) },
        maxChannelDifference,
        meanAbsoluteChannelDifference: absoluteChannelDifferenceSum / (3 * a.w * a.h),
    };
}

export function ribbonMask(image) {
    const mask = new Uint8Array(image.w * image.h);
    for (let i = 0; i < mask.length; i++) mask[i] = Number(image.px[3 * i + 1] >= OWNER_ON);
    return mask;
}

// Flood only through pixels in this mask. Diagonal adjacency is explicitly
// selected so rasterization splits can be distinguished from persistent gaps.
export function components(mask, width, height, connectivity, previousMask = null) {
    if (connectivity !== 4 && connectivity !== 8) throw new Error('Connectivity must be 4 or 8');
    if (mask.length !== width * height || (previousMask && previousMask.length !== mask.length)) {
        throw new Error('Mask dimensions differ');
    }
    const visited = new Uint8Array(mask.length), queue = new Uint32Array(mask.length), result = [];
    const offsets = connectivity === 4 ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
        : [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || visited[start]) continue;
        let head = 0, tail = 1, overlapBeforePixels = 0, touchesImageBorder = false;
        const bounds = emptyBounds();
        queue[0] = start;
        visited[start] = 1;
        while (head < tail) {
            const i = queue[head++], x = i % width, y = Math.floor(i / width);
            growBounds(bounds, x, y);
            if (previousMask?.[i]) overlapBeforePixels++;
            if (x === 0 || x === width - 1 || y === 0 || y === height - 1) touchesImageBorder = true;
            for (const [dx, dy] of offsets) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const ni = ny * width + nx;
                if (!mask[ni] || visited[ni]) continue;
                visited[ni] = 1;
                queue[tail++] = ni;
            }
        }
        const component = { pixels: tail, bounds: finishBounds(bounds), touchesImageBorder };
        if (previousMask) {
            component.overlapBeforePixels = overlapBeforePixels;
            component.addedPixels = tail - overlapBeforePixels;
        }
        result.push(component);
    }
    return result.sort((a, b) => b.pixels - a.pixels);
}

function summarizeComponents(list) {
    return {
        count: list.length,
        pixels: list.reduce((sum, component) => sum + component.pixels, 0),
        singletonCount: list.filter(component => component.pixels === 1).length,
        smallerThanListThresholdCount: list.filter(component => component.pixels < COMPONENT_LIST_MIN_PIXELS).length,
        atLeastListThresholdCount: list.filter(component => component.pixels >= COMPONENT_LIST_MIN_PIXELS).length,
        largest: list.slice(0, 20),
    };
}

function componentComparison(before, after, width, height, connectivity) {
    const oldComponents = components(before, width, height, connectivity);
    const newComponents = components(after, width, height, connectivity, before);
    const entirelyNew = newComponents.filter(component => component.overlapBeforePixels === 0);
    return {
        connectivity,
        before: summarizeComponents(oldComponents),
        after: summarizeComponents(newComponents),
        newlyIsolatedScreenComponents: {
            definition: 'After-mask components containing no before-mask pixel; screen space only.',
            ...summarizeComponents(entirelyNew),
            listedMinimumPixels: COMPONENT_LIST_MIN_PIXELS,
            listed: entirelyNew.filter(component => component.pixels >= COMPONENT_LIST_MIN_PIXELS),
        },
    };
}

function ownerSummary(owners) {
    return { counts: owners.counts, shares: owners.shares, isolated: owners.isolated };
}

// A monotonic fragment-discard removal should neither remove ribbon pixels nor
// change the independent view-7 diagnostic. Failure means the A/B is not clean;
// passing these controls still says nothing about physical water correctness.
export function captureValidity(measurements, view = {}, report = {}) {
    const hasBeforeState = view.beforeState != null, hasAfterState = view.afterState != null;
    const drift = measurements.normal.beforeReplay;
    const checks = {
        baselineReplayWithinTolerance: drift.exact.changedPixels === 0 ||
            (drift.maxChannelDifference <= 1 && drift.exact.share <= 1e-5),
        noRibbonRemoval: measurements.ribbon.removedPixels === 0,
        ownershipView7Exact: measurements.ownershipDiagnostic.view7BeforeAfter.exact.changedPixels === 0,
        sourceStateStable: hasBeforeState || hasAfterState ?
            hasBeforeState && hasAfterState && isDeepStrictEqual(view.beforeState, view.afterState) : null,
        tracedCandidatesComplete: Array.isArray(view.traced) ? view.traced.every(candidate => candidate.traced === true) : null,
        captureComplete: typeof view.complete === 'boolean' ? view.complete : null,
        noCaptureErrors: !(report.failure || report.errors?.length || report.gpuErrors?.length),
    };
    const failures = Object.keys(checks).filter(key => checks[key] === false);
    return {
        valid: failures.length === 0, checks, failures,
        notVerified: Object.keys(checks).filter(key => checks[key] == null),
        scope: 'Validity of this frozen-scene A/B comparison, not approval of water geometry or connectivity.',
    };
}

function contactSheet(before, after) {
    sameSize(before, after);
    const gap = 8, width = before.w * 2 + gap, pixels = new Uint8Array(width * before.h * 3);
    pixels.fill(255);
    for (let y = 0; y < before.h; y++) {
        pixels.set(before.px.subarray(y * before.w * 3, (y + 1) * before.w * 3), y * width * 3);
        pixels.set(after.px.subarray(y * after.w * 3, (y + 1) * after.w * 3), (y * width + before.w + gap) * 3);
    }
    return { w: width, h: before.h, px: pixels };
}

export async function analyzeDirectory(directory) {
    const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
    if (!Array.isArray(report.views) || !report.views.length) throw new Error('report.views must contain named captures');
    if (report.failure) throw new Error(`Capture failed; refusing incomplete evidence: ${report.failure}`);
    for (const view of report.views) {
        if (view.complete === false) throw new Error(`Capture ${view.name} is incomplete`);
        if (Object.hasOwn(view, 'beforeState') && !Object.hasOwn(view, 'afterState')) {
            throw new Error(`Capture ${view.name} has no final source state and may still be running`);
        }
    }
    const analysis = {
        scope: 'Screen-space image and debug-mask comparisons only. Neither connected hydrology nor actual shoreline contact is measured.',
        ownershipDiagnosticLimit: 'classifyOwners measures the existing river-zone diagnostic. Terrain water colour counts as ownership and pure lake edges are excluded from its gap share.',
        maskDefinition: `Debug view 6 green channel >= ${OWNER_ON}; includes overlapping ribbon owners.`,
        imageBounds: 'Pixel coordinates, both minimum and maximum inclusive.',
        views: [],
    };
    for (const view of report.views) {
        const { name } = view;
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Unsafe/missing capture name: ${name}`);
        const labels = ['before', 'after', 'replay', 'before-own6', 'before-own7', 'after-own6', 'after-own7'];
        const loaded = await Promise.all(labels.map(async label => readPng(await fs.readFile(path.join(directory, `${name}-${label}.png`)))));
        const captures = Object.fromEntries(labels.map((label, index) => [label, loaded[index]]));
        const { before, after, replay } = captures;
        for (const capture of loaded) sameSize(before, capture);
        const beforeMask = ribbonMask(captures['before-own6']), afterMask = ribbonMask(captures['after-own6']);
        let beforePixels = 0, afterPixels = 0, addedPixels = 0, removedPixels = 0;
        const addedBounds = emptyBounds(), removedBounds = emptyBounds();
        const highlight = new Uint8Array(after.px.length);
        for (let i = 0; i < beforeMask.length; i++) {
            beforePixels += beforeMask[i];
            afterPixels += afterMask[i];
            for (let channel = 0; channel < 3; channel++) highlight[i * 3 + channel] = Math.round(after.px[i * 3 + channel] * 0.35);
            if (afterMask[i] && !beforeMask[i]) {
                addedPixels++;
                growBounds(addedBounds, i % before.w, Math.floor(i / before.w));
                highlight.set([255, 0, 255], i * 3);
            } else if (beforeMask[i] && !afterMask[i]) {
                removedPixels++;
                growBounds(removedBounds, i % before.w, Math.floor(i / before.w));
                highlight.set([255, 170, 0], i * 3);
            }
        }
        const beforeOwners = classifyOwners(captures['before-own6'], captures['before-own7'], before);
        const afterOwners = classifyOwners(captures['after-own6'], captures['after-own7'], after);
        const sheet = contactSheet(before, after);
        const artifactNames = {
            ribbonChanges: `${name}-ribbon-changes.png`,
            beforeAfter: `${name}-before-after.png`,
            ownersBefore: `${name}-owners-before.png`,
            ownersAfter: `${name}-owners-after.png`,
        };
        const artifacts = [
            [artifactNames.ribbonChanges, writePng(before.w, before.h, highlight)],
            [artifactNames.beforeAfter, writePng(sheet.w, sheet.h, sheet.px)],
            [artifactNames.ownersBefore, writePng(before.w, before.h, beforeOwners.image)],
            [artifactNames.ownersAfter, writePng(before.w, before.h, afterOwners.image)],
        ];
        for (const [filename, bytes] of artifacts) await fs.writeFile(path.join(directory, filename), bytes);
        const measurement = {
            name, width: before.w, height: before.h,
            normal: { beforeAfter: compareImages(before, after), beforeReplay: compareImages(before, replay) },
            ribbon: {
                beforePixels, afterPixels, addedPixels, removedPixels,
                addedBounds: finishBounds(addedBounds), removedBounds: finishBounds(removedBounds),
                components4: componentComparison(beforeMask, afterMask, before.w, before.h, 4),
                components8: componentComparison(beforeMask, afterMask, before.w, before.h, 8),
            },
            ownershipDiagnostic: { before: ownerSummary(beforeOwners), after: ownerSummary(afterOwners),
                view7BeforeAfter: compareImages(captures['before-own7'], captures['after-own7']) },
            artifacts: artifactNames,
            artifactLegend: { ribbonChanges: 'Magenta = added ribbon pixels, orange = removed; normal after image dimmed to 35%.',
                beforeAfter: 'Before at left, after at right, separated by an 8-pixel white gutter.' },
        };
        measurement.validity = captureValidity(measurement, view, report);
        analysis.views.push(measurement);
    }
    analysis.baselineReplayExact = analysis.views.every(view => view.normal.beforeReplay.exact.changedPixels === 0);
    analysis.valid = analysis.views.every(view => view.validity.valid);
    await fs.writeFile(path.join(directory, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    return analysis;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const directory = process.argv[2];
    if (!directory) throw new Error('Usage: node tools/perf/waterStepReview/analyze.mjs <capture-directory>');
    const analysis = await analyzeDirectory(path.resolve(directory));
    console.log(JSON.stringify({ valid: analysis.valid, baselineReplayExact: analysis.baselineReplayExact,
        views: analysis.views.map(view => ({ name: view.name, changedPixels: view.normal.beforeAfter.exact.changedPixels,
            replayChangedPixels: view.normal.beforeReplay.exact.changedPixels, addedRibbonPixels: view.ribbon.addedPixels,
            removedRibbonPixels: view.ribbon.removedPixels,
            isolatedNewComponents8: view.ribbon.components8.newlyIsolatedScreenComponents.count,
            isolatedNewPixels8: view.ribbon.components8.newlyIsolatedScreenComponents.pixels,
            view7ChangedPixels: view.ownershipDiagnostic.view7BeforeAfter.exact.changedPixels,
            validity: view.validity })) }, null, 2));
    if (!analysis.valid) process.exitCode = 1;
}
