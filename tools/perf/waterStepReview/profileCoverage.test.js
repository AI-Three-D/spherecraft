import { describe, expect, it } from 'vitest';
import { PROFILE_FIXTURE, naturalGround, profileCoverageFixture } from './profileCoverage.js';

// These acceptance counterexamples exercise both sides of the proposed
// coverage-rule change. Passing means the fixtures expose the tradeoff;
// it does not mean production water passes a shoreline/connectivity check.
describe('analytic river profile removal acceptance counterexamples', () => {
    it('recovers connected naturally low bank that the analytic profile rejects', () => {
        const f = profileCoverageFixture('connectedLowBank');
        expect(f.connectivity[4]).toEqual(f.connectivity[8]);
        expect(f.connectivity[4].addedWetSamples).toBe(1377);
        expect(f.connectivity[4].addedConnectedSamples).toBe(1377);
        expect(f.connectivity[4].addedDisconnectedSamples).toBe(0);
        expect(f.connectivity[4].beforeDisconnectedSamples).toBe(0);
        const i = 40 * f.nx + 76; // s = 0, n = 19 m.
        expect(f.heights[i]).toBe(1);
        expect(f.profiles[i]).toBeCloseTo(1.9391112695156156, 12);
        expect(f.before[i]).toBe(0);
        expect(f.after[i]).toBe(1);
    });

    it('also floods a closed submerged pocket disconnected from the river', () => {
        const f = profileCoverageFixture('closedPocket');
        expect(f.connectivity[4]).toEqual(f.connectivity[8]);
        expect(f.connectivity[4].addedWetSamples).toBe(45);
        expect(f.connectivity[4].addedConnectedSamples).toBe(0);
        expect(f.connectivity[4].addedDisconnectedSamples).toBe(45);
        expect(f.connectivity[4].beforeDisconnectedSamples).toBe(0);
    });

    it('surrounds the pocket with a continuous dry belt wider than a grid diagonal', () => {
        const f = profileCoverageFixture('closedPocket'), P = PROFILE_FIXTURE, belt = f.dryBelt;
        expect(belt.widthM).toBeGreaterThan(belt.maximumGridEdgeM);
        expect(belt.continuousGroundLowerBoundM).toBeGreaterThan(P.waterLevelM + 0.3);
        expect(belt.minimumSampleGroundM).toBeCloseTo(belt.continuousGroundLowerBoundM, 12);
        // Check the complete belt, including points between terrain samples.
        // Its analytic lower bound is explained beside the production-math
        // evaluation in profileCoverage.js; this dense check guards the fixture.
        for (let n = 17.75; n <= 20.25; n += 0.0625) for (let s = -1.75; s <= 1.75; s += 0.0625) {
            if (n >= 18.25 && n <= 19.75 && s >= -1.25 && s <= 1.25) continue;
            expect(naturalGround('closedPocket', n, s)).toBe(3);
        }
        expect(naturalGround('closedPocket', 19, 0)).toBe(1);
    });
});
