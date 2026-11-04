import { describe, expect, it } from 'vitest';
import { packFlowTexel, riverFlowDesign, riverRocks, RIVER_FLOW, unpackFlowTexel } from './riverFlow.js';

// Stations of a straight river: falling by slope(s), of half-width hw(s), depth D(s).
function stations({ L = 1200, ds = 2, slope = () => 0.05, hw = () => 8, D = () => 1.4, fade = () => 0 }) {
    const m = Math.round(L / ds) + 1, f = () => new Float64Array(m);
    const S = { m, ds, s: f(), x: f(), y: f(), tx: f(), ty: f(), W: f(), D: f(), hwL: f(), hwR: f(), fade: f(), mouth: f() };
    let W = 800;
    for (let i = 0; i < m; i++) {
        const s = i * ds;
        S.s[i] = s; S.x[i] = s; S.tx[i] = 1;
        S.W[i] = W; W -= slope(s) * ds;
        S.D[i] = D(s); S.hwL[i] = S.hwR[i] = hw(s); S.fade[i] = fade(s);
    }
    return S;
}
const mid = (S) => S.m >> 1;

describe('design flow', () => {
    it('stays a river at any slope: Manning with a constant n would pass 15 m/s', () => {
        for (const slope of [0.001, 0.03, 0.17, 0.6]) {
            const S = stations({ slope: () => slope });
            riverFlowDesign(S, 3);
            expect(S.V[mid(S)]).toBeGreaterThan(0.8);
            expect(S.V[mid(S)]).toBeLessThanOrEqual(RIVER_FLOW.speedM[1]);
        }
    });

    it('friction balances the fall at the baked level: gravity = n^2 V^2 / R^(4/3)', () => {
        const S = stations({ slope: (s) => 0.02 + 0.1 * (s > 600 ? 1 : 0), hw: (s) => 8 + 3 * Math.sin(s / 90) });
        riverFlowDesign(S, 3);
        for (let i = 40; i < S.m - 40; i += 37) {
            if (S.n[i] <= RIVER_FLOW.manning[0] || S.n[i] >= RIVER_FLOW.manning[1]) continue;
            const friction = S.n[i] ** 2 * S.V[i] ** 2 / S.Rh[i] ** (4 / 3);
            expect(friction / S.slope[i]).toBeCloseTo(1, 5);
        }
    });

    it('holds one discharge: a pool runs slower than a pinch', () => {
        const S = stations({ hw: (s) => (s > 500 && s < 700 ? 16 : 6) });
        riverFlowDesign(S, 3);
        const wide = S.V[300], narrow = S.V[100];
        expect(wide).toBeLessThan(narrow * 0.6);
        // Discharge at the two sections agrees (the smoothing window is far from either).
        const q = (i) => S.V[i] * S.Rh[i] * (S.hwL[i] + S.hwR[i]);
        expect(q(300) / q(100)).toBeCloseTo(1, 1);
    });

    it('foams where the water falls, not on a flat reach', () => {
        const calm = stations({ slope: () => 0.002, D: () => 2 }), steep = stations({ slope: () => 0.15 });
        riverFlowDesign(calm, 3); riverFlowDesign(steep, 3);
        expect(calm.foam[mid(calm)]).toBeLessThan(0.05);
        expect(steep.foam[mid(steep)]).toBeGreaterThan(0.6);
    });

    it('stills into a lake', () => {
        const S = stations({ fade: (s) => (s > 1000 ? 1 : 0) });
        riverFlowDesign(S, 3);
        expect(S.V[S.m - 20]).toBe(0);
        expect(S.foam[S.m - 20]).toBe(0);
    });
});

describe('rocks', () => {
    it('stand only where the river falls, inside the channel, the same every time', () => {
        const S = stations({ slope: (s) => (s < 600 ? 0.001 : 0.08) });
        riverFlowDesign(S, 7);
        const rocks = riverRocks(S, 7);
        expect(rocks.length).toBeGreaterThan(20);
        expect(riverRocks(S, 7)).toEqual(rocks);
        expect(riverRocks(S, 8)).not.toEqual(rocks);
        for (const r of rocks) {
            expect(r.x).toBeGreaterThan(560);
            expect(Math.abs(r.y)).toBeLessThanOrEqual(8);
            expect(r.top).toBeGreaterThan(r.base);
        }
    });

    it('come in all sizes: mostly small, a few large, none a pillar', () => {
        const S = stations({ L: 4000, slope: () => 0.08, hw: () => 12 });
        riverFlowDesign(S, 7);
        const rocks = riverRocks(S, 7).filter(r => r.kind === 0), radii = rocks.map(r => r.r).sort((a, b) => a - b);
        const q = (f) => radii[Math.floor(f * (radii.length - 1))];
        expect(q(0.5)).toBeLessThan(1);
        expect(q(0.9) / q(0.1)).toBeGreaterThan(3.5);
        expect(q(1)).toBeGreaterThan(3);
        for (const r of rocks) expect(r.top - (r.base + 1.2 * 0.08 * r.r)).toBeLessThanOrEqual(Math.max(RIVER_FLOW.rockTallest * r.r, 0.25) + 1e-6);
    });

    it('are sparse: a rock to every 100 m2 of steep channel, ledges aside', () => {
        const S = stations({ L: 4000, slope: () => 0.08, hw: () => 12 });
        riverFlowDesign(S, 7);
        const count = riverRocks(S, 7).filter(r => r.kind === 0).length, area = 4000 * 24;
        expect(count / area).toBeGreaterThan(0.006);
        expect(count / area).toBeLessThan(0.0105);
    });

    it('some break the surface, some stay under it', () => {
        const S = stations({ slope: () => 0.08 });
        riverFlowDesign(S, 7);
        const rocks = riverRocks(S, 7), out = rocks.filter(r => r.top > r.W).length;
        expect(out / rocks.length).toBeGreaterThan(0.2);
        expect(out / rocks.length).toBeLessThan(0.8);
    });
});

it('rocks on a cascade reach down to the bed on their downhill side', () => {
    const S = stations({ slope: () => 0.6 });
    riverFlowDesign(S, 7);
    for (const r of riverRocks(S, 7).slice(0, 40)) {
        const i = Math.min(S.m - 1, Math.round(r.x / S.ds));
        expect(r.base).toBeLessThanOrEqual(S.W[i] - S.D[i] * (1 - (r.y / 8) ** 2) - 0.5 * r.r + 1e-3 + 0.3 * S.D[i]);
    }
});

it('packs a flow texel', () => {
    for (const [a, b, foam, n] of [[3.2, -1.5, 0.7, 0.12], [-7.9, 7.9, 0, 0.02], [0, 0, 1, 0.8]]) {
        const q = unpackFlowTexel(packFlowTexel(a, b, foam, n));
        expect(q.a).toBeCloseTo(a, 0);
        expect(q.b).toBeCloseTo(b, 0);
        expect(q.foam).toBeCloseTo(foam, 2);
        expect(q.n / n).toBeCloseTo(1, 1);
    }
});
