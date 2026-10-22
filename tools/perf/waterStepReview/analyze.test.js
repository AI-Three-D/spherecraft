import { describe, expect, it } from 'vitest';
import { captureValidity, compareImages, components } from './analyze.mjs';

const row = (...pixels) => ({ w: pixels.length, h: 1, px: Uint8Array.from(pixels.flat()) });
const cleanMeasurement = () => ({
    normal: { beforeReplay: { exact: { changedPixels: 0 } } },
    ribbon: { removedPixels: 0 },
    ownershipDiagnostic: { view7BeforeAfter: { exact: { changedPixels: 0 } } },
});

describe('screen-space ribbon components', () => {
    it('distinguishes diagonal adjacency without wrapping across image rows', () => {
        const diagonal = Uint8Array.from([1, 0, 0, 1]);
        expect(components(diagonal, 2, 2, 4).map(component => component.pixels)).toEqual([1, 1]);
        expect(components(diagonal, 2, 2, 8).map(component => component.pixels)).toEqual([2]);
        const oppositeDiagonal = Uint8Array.from([0, 1, 1, 0]);
        expect(components(oppositeDiagonal, 2, 2, 4)).toHaveLength(2);
    });

    it('distinguishes an extension of old water from a wholly new screen component', () => {
        const before = Uint8Array.from([1, 0, 0, 0, 0, 0]);
        const after = Uint8Array.from([1, 1, 0, 0, 1, 1]);
        const found = components(after, 6, 1, 4, before);
        expect(found.map(component => ({ pixels: component.pixels, old: component.overlapBeforePixels, added: component.addedPixels })))
            .toEqual([{ pixels: 2, old: 1, added: 1 }, { pixels: 2, old: 0, added: 2 }]);
        expect(found[1].bounds).toEqual({ minX: 4, minY: 0, maxX: 5, maxY: 0, width: 2, height: 1 });
    });
});

describe('image evidence controls', () => {
    it('counts exact differences separately from strict RGB-sum threshold differences', () => {
        const before = row([0, 0, 0], [1, 1, 1], [3, 4, 5]);
        const after = row([40, 0, 0], [16, 16, 16], [3, 4, 5]);
        const difference = compareImages(before, after, 40);
        expect(difference.exact.changedPixels).toBe(2);
        expect(difference.threshold.changedPixels).toBe(1);
        expect(difference.threshold.bounds).toEqual({ minX: 1, minY: 0, maxX: 1, maxY: 0, width: 1, height: 1 });
        expect(compareImages(before, before).exact).toEqual({ changedPixels: 0, share: 0, bounds: null });
    });

    it('invalidates an A/B if supposedly independent ownership view 7 changes', () => {
        const measurement = cleanMeasurement();
        expect(captureValidity(measurement).valid).toBe(true);
        measurement.ownershipDiagnostic.view7BeforeAfter.exact.changedPixels = 1;
        expect(captureValidity(measurement)).toMatchObject({ valid: false, failures: ['ownershipView7Exact'] });
    });

    it('rejects replay drift, removed pixels and changed source data independently', () => {
        const measurement = cleanMeasurement();
        measurement.normal.beforeReplay.exact.changedPixels = 1;
        measurement.ribbon.removedPixels = 1;
        const validity = captureValidity(measurement, { beforeState: { version: 1 }, afterState: { version: 2 } });
        expect(validity.valid).toBe(false);
        expect(validity.failures).toEqual(['baselineReplayWithinTolerance', 'noRibbonRemoval', 'sourceStateStable']);
    });

    it('accepts bounded one-value replay drift but retains exact geometry-mask checks', () => {
        const m=cleanMeasurement();
        m.normal.beforeReplay={exact:{changedPixels:5,share:5/5184000},maxChannelDifference:1};
        expect(captureValidity(m).valid).toBe(true);
        m.normal.beforeReplay.maxChannelDifference=2;
        expect(captureValidity(m).failures).toContain('baselineReplayWithinTolerance');
        m.normal.beforeReplay.maxChannelDifference=1;m.normal.beforeReplay.exact.share=.0001;
        expect(captureValidity(m).failures).toContain('baselineReplayWithinTolerance');
    });

    it('reports missing metadata and rejects failed trace or capture flags when present', () => {
        expect(captureValidity(cleanMeasurement()).notVerified).toEqual(['sourceStateStable', 'tracedCandidatesComplete', 'captureComplete']);
        const view = { complete: true, traced: [{ id: 1, traced: false }], beforeState: { x: 1 }, afterState: { x: 1 } };
        expect(captureValidity(cleanMeasurement(), view).failures).toEqual(['tracedCandidatesComplete']);
        expect(captureValidity(cleanMeasurement(), {}, { gpuErrors: ['validation failed'] }).failures).toEqual(['noCaptureErrors']);
    });
});
