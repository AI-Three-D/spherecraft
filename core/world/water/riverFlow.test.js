import { describe, expect, it } from 'vitest';
import { packFlowTexel, plumeAt, riverFlowDesign, riverPlumes, riverRocks, RIVER_FLOW, unpackFlowTexel } from './riverFlow.js';

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
            const friction = S.n[i] ** 2 * S.V[i] ** 2 / (S.Rh[i] / RIVER_FLOW.areaShape) ** (4 / 3);
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

    it('runs a wide steep reach shallow and fast, the discharge unchanged', () => {
        // River 453: 15 m wide on a 44 % fall ran at 1.9 m/s, 5.6 m wide at 5.3 m/s.
        const S = stations({ slope: (s) => (s > 500 && s < 700 ? 0.44 : 0.15), hw: (s) => (s > 500 && s < 700 ? 7.5 : 2.8), D: () => 2.6 });
        riverFlowDesign(S, 3);
        expect(S.V[300]).toBeGreaterThan(3);
        expect(S.D[300]).toBeLessThan(2.6);
        const q = (i) => S.V[i] * S.Rh[i] * (S.hwL[i] + S.hwR[i]);
        expect(q(300) / q(100)).toBeGreaterThan(0.85);
        expect(q(300) / q(100)).toBeLessThan(1.15);
    });

    it('leaves a gentle reach as deep as it was', () => {
        const S = stations({ slope: () => 0.004, D: () => 2.6 });
        riverFlowDesign(S, 3);
        expect(S.D[mid(S)]).toBe(2.6);
    });

    it('does not speed up as its channel fades out into a lake', () => {
        // By the faded depth's area: 2.6 m/s up to 5.4 on flat lake water (river 2557).
        const S = stations({ slope: (s) => (s < 1000 ? 0.002 : 0), hw: () => 30, D: () => 2.5, fade: (s) => Math.min(Math.max((s - 1000) / 100, 0), 1) });
        riverFlowDesign(S, 3);
        const river = S.V[400];
        for (let i = 500; i < S.m; i++) expect(S.V[i]).toBeLessThanOrEqual(river * 1.001);
    });

    it('has only its fall to speed up with leaving a lake', () => {
        // River 2557: 5.4 m/s out of a lake with 0.1 m of fall.
        const S = stations({ L: 600, slope: (s) => (s < 100 ? 0.001 : 0.05), hw: (s) => (s < 100 ? 3 : 20), D: () => 2 });
        S.ends = [{ s: 2, sign: -1, level: S.W[0] }];
        riverFlowDesign(S, 3);
        for (let i = 0; i < S.m; i++) expect(S.V[i]).toBeLessThanOrEqual(0.3 + Math.sqrt(2 * 9.81 * Math.max(S.W[0] - S.W[i], 0)) + 1e-9);
    });

    it('carries no more than its outlet can pass', () => {
        const wide = stations({ L: 800, slope: () => 0.002, hw: () => 30, D: () => 3 });
        riverFlowDesign(wide, 3);
        const S = stations({ L: 800, slope: () => 0.002, hw: (s) => (s < 300 ? 3 : 30), D: () => 3 });
        S.ends = [{ s: 2, sign: -1, level: S.W[0] }];
        riverFlowDesign(S, 3);
        expect(S.Q).toBeLessThan(wide.Q * 0.5);
    });

    it('fades on water still at its lake\'s level', () => {
        const S = stations({ L: 600, slope: (s) => (s < 300 ? 0 : 0.05), hw: () => 3, D: () => 1.5 });
        S.ends = [{ s: 2, sign: -1, level: S.W[0] }];
        riverFlowDesign(S, 3);
        expect(S.V[Math.round(150 / S.ds)]).toBe(0);
    });

    it('is gone past a shore even where the channel does not fade', () => {
        const S = stations({ L: 600, slope: (s) => (s < 400 ? 0.002 : 0), hw: () => 6, D: () => 2 });
        S.ends = [{ s: 400, sign: 1, level: 700 }];
        riverFlowDesign(S, 3);
        expect(S.V[Math.round(450 / S.ds)]).toBe(0);
    });

    it('carries a river on into its lake as a plume that spreads, slows and ends', () => {
        const S = stations({ L: 400, slope: () => 0.1, hw: () => 8, D: () => 1.4 });
        riverFlowDesign(S, 3);
        S.ends = [{ s: 300, sign: 1, level: 700 }, { s: 20, sign: -1, level: 900 }];
        const plumes = riverPlumes(S, 3).filter(q => !q.intake);
        expect(plumes.length).toBe(1);
        const p = plumes[0], at = (a, r = 0) => plumeAt(p, a, r);
        expect(p.length).toBeGreaterThanOrEqual(RIVER_FLOW.plumeRangeM[0]);
        expect(p.length).toBeLessThanOrEqual(RIVER_FLOW.plumeRangeM[1]);
        expect(at(0).speed).toBeCloseTo(p.V, 5);
        expect(at(p.length / 2).speed).toBeLessThan(at(10).speed);
        expect(at(p.length).speed).toBe(0);
        expect(at(p.length / 2).width).toBeGreaterThan(at(0).width);
        // Sideways it fades out, no edge to it.
        expect(at(20, 3 * at(20).width).speed).toBeLessThan(0.001 * at(20).speed);
    });

    it('draws on the lake it leaves: water closes in on the outlet, slowing gradually up the lake', () => {
        const S = stations({ L: 400, slope: () => 0.1, hw: () => 8, D: () => 1.4 });
        riverFlowDesign(S, 3);
        S.ends = [{ s: 20, sign: -1, level: 900 }];
        const [p] = riverPlumes(S, 3), at = (a, r = 0) => plumeAt(p, a, r);
        expect(p.intake).toBe(true);
        expect(p.foam).toBe(0);
        // It points up the lake, against the river's flow.
        expect(p.tx * S.tx[20] + p.ty * S.ty[20]).toBeLessThan(0);
        expect(at(0).speed).toBeCloseTo(p.V, 5);
        expect(at(p.length).speed).toBe(0);
        // No line anywhere along it: never more than a sixth of the speed in 8 m.
        let last = at(0).speed;
        for (let a = 8; a <= p.length; a += 8) {
            expect(at(a).speed).toBeLessThanOrEqual(last);
            expect(last - at(a).speed).toBeLessThan(p.V / 6);
            last = at(a).speed;
        }
        expect(at(20, 3 * at(20).width).speed).toBeLessThan(0.001 * at(20).speed);
    });

    it('makes no plume from a river too slow to carry one', () => {
        const S = stations({ L: 400, slope: () => 0.0005, hw: () => 40, D: () => 3 });
        riverFlowDesign(S, 3);
        S.V.fill(0.3);
        S.ends = [{ s: 300, sign: 1, level: 700 }, { s: 20, sign: -1, level: 900 }];
        expect(riverPlumes(S, 3).length).toBe(0);
    });

    it('stills into a lake', () => {
        const S = stations({ fade: (s) => (s > 1000 ? 1 : 0) });
        riverFlowDesign(S, 3);
        expect(S.V[S.m - 20]).toBe(0);
        expect(S.foam[S.m - 20]).toBe(0);
    });
});

describe('rocks', () => {
    it('are in the solver\'s bed only in supercritical water, where they cannot dam a river', () => {
        const fast = stations({ slope: () => 0.2, hw: () => 6, D: () => 0.8 }), slow = stations({ slope: () => 0.02, hw: () => 40, D: () => 3 });
        riverFlowDesign(fast, 5); riverFlowDesign(slow, 5);
        const froude = (S, r) => { const i = Math.round(r.x / S.ds); return S.V[i] / Math.sqrt(9.81 * S.D[i]); };
        for (const [S, rocks] of [[fast, riverRocks(fast, 5)], [slow, riverRocks(slow, 5)]]) for (const r of rocks) expect(r.solid).toBe(froude(S, r) >= RIVER_FLOW.rockSolidFroude);
    });

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

it('tells lake water in a flow texel from any river', () => {
    expect(unpackFlowTexel(packFlowTexel(0, 0, 0, 0)).n).toBe(0);
    expect(unpackFlowTexel(packFlowTexel(1, 0, 0, RIVER_FLOW.manning[0])).n).toBeCloseTo(RIVER_FLOW.manning[0], 5);
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
