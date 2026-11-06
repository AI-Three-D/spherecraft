import { expect, it } from 'vitest';
import { rockFlowDeflection } from './rockFlow.js';

it('splits upstream flow around opposite sides and rejoins it downstream', () => {
    const left = rockFlowDeflection(-1, 1, 1), right = rockFlowDeflection(-1, -1, 1);
    expect(left.across).toBeGreaterThan(0);
    expect(right.across).toBeLessThan(0);
    expect(rockFlowDeflection(1, 1, 1).across).toBeLessThan(0);
    expect(rockFlowDeflection(1, -1, 1).across).toBeGreaterThan(0);
    expect(rockFlowDeflection(-1, 0, 1).along).toBeLessThan(1);
    expect(rockFlowDeflection(5, 0, 1)).toEqual({ along: 1, across: 0, weight: 0 });
});

it('does not perturb water for a fully submerged or disabled obstacle', () => {
    expect(rockFlowDeflection(1, 1, 2, 0)).toEqual({ along: 1, across: 0, weight: 0 });
});
