import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { createTerrainCommon } from '../../../templates/terrain-shaders/terrainCommon.wgsl.js';
import { createRiverNoiseWgsl } from './riverShapeNoise.js';
import {
    RIVER_SECTION, createRiverSectionWgsl, riverBankParams, riverBankRim, riverBankType, riverRamp, riverSectionHeight, riverSideDepth, riverSoftCut, riverWidthFactor,
} from './riverSection.js';
import { quantile, sectionMetrics, summarizeRiver } from '../../../tools/perf/riverMetrics/sectionMetrics.js';

const P = RIVER_SECTION;
const DN = 0.25;
// A cross-section of the function at offsets -half..half (0.25 m), natural ground h0(n).
function section(args, h0, half) {
    const count = 2 * Math.round(half / DN) + 1, mid = (count - 1) / 2;
    const h = new Float64Array(count), g = new Float64Array(count);
    for (let i = 0; i < count; i++) { const n = (i - mid) * DN; g[i] = h0(n); h[i] = riverSectionHeight({ ...args, n, h0: g[i] }); }
    return { h, h0: g };
}
const channel = { hw: 12, bed: 100, depth: 2, skew: 0.15 };   // bank-full at 102, water at 101.5
const bankOf = (tau, river = 3) => riverBankParams(tau, river);

describe('river section shapes', () => {
    it('ramps from 0 to 1 with a constant middle slope and no jumps', () => {
        const a = P.rampRound, m = 1 / (1 - a);
        expect(riverRamp(0)).toBe(0);
        expect(riverRamp(1)).toBe(1);
        let prev = 0;
        for (let t = 0.001; t < 1; t += 0.001) {
            const v = riverRamp(t), slope = (riverRamp(t + 1e-6) - riverRamp(t - 1e-6)) / 2e-6;
            expect(v).toBeGreaterThanOrEqual(prev);
            expect(slope).toBeLessThanOrEqual(m + 1e-6);
            if (t > a + 0.01 && t < 1 - a - 0.01) expect(slope).toBeCloseTo(m, 4);
            prev = v;
        }
    });

    it('rounds the cut in over softM', () => {
        expect(riverSoftCut(-1, 0.5)).toBe(0);
        expect(riverSoftCut(0.25, 0.5)).toBeCloseTo(0.0625, 9);
        expect(riverSoftCut(3, 0.5)).toBeCloseTo(2.75, 9);
        expect((riverSoftCut(0.5 + 1e-7, 0.5) - riverSoftCut(0.5 - 1e-7, 0.5)) / 2e-7).toBeCloseTo(1, 4);
    });
});

describe('river section', () => {
    const flat = (H) => () => channel.bed + channel.depth + H;

    it('only cuts, keeps the design channel under high ground and leaves the far ground alone', () => {
        for (const tau of [0, 0.5, 1, 1.5, 2]) for (const H of [-2, 0.1, 1, 3, 12, 40]) {
            const { h, h0 } = section({ ...channel, left: bankOf(tau), right: bankOf(2 - tau) }, flat(H), channel.hw + P.reachM + 20);
            for (let i = 0; i < h.length; i++) expect(h[i]).toBeLessThanOrEqual(h0[i] + 1e-9);
            expect(h[0]).toBe(h0[0]);
            expect(h[h.length - 1]).toBe(h0[h.length - 1]);
            const mid = (h.length - 1) / 2;
            if (H > 1) expect(h[mid]).toBeCloseTo(riverSectionHeight({ ...channel, n: 0, h0: 1e4, left: bankOf(tau), right: bankOf(2 - tau) }), 6);
        }
        expect(riverSectionHeight({ ...channel, n: 0, h0: 1e4, left: bankOf(1), right: bankOf(1) }))
            .toBeCloseTo(channel.bed + channel.depth * (1 - Math.pow(1 - (channel.skew / (1 + channel.skew)) ** 2, 1.5)), 6);
    });

    it('is continuous across the channel edge, the bank and the end of the cut', () => {
        for (const tau of [0, 0.7, 1, 1.4, 2]) for (const H of [0.05, 0.6, 2, 3.5, 20]) {
            const { h } = section({ ...channel, left: bankOf(tau), right: bankOf(tau) }, (n) => channel.bed + channel.depth + H + 0.08 * n, 140);
            // Steepest possible change between samples: slope <= max(cut slope, H / blend) x a margin.
            for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(DN * 3);
        }
    });

    it('keeps the saw-tooth of a 1 m grid under 0.15 m (teeth), whatever the bank and the ground', () => {
        let worst = 0;
        for (let tau = 0; tau <= 2.0001; tau += 0.1) for (const H of [0.2, 0.5, 0.9, 1.5, 2.2, 3, 4.5, 8, 20]) for (const slope of [0, 0.05, 0.3]) {
            const args = { ...channel, left: bankOf(tau), right: bankOf(tau) };
            const { h, h0 } = section(args, (n) => channel.bed + channel.depth + H + slope * Math.abs(n), 140);
            const m = sectionMetrics({ h, h0, dn: DN, wl: channel.bed + 0.75 * channel.depth, extentL: 140, extentR: 140, spacing: 1 });
            worst = Math.max(worst, m.teeth);
        }
        expect(worst).toBeLessThan(0.15);
    });
});

describe('river section next to a lake', () => {
    // The water at 101.5; a lake rim at 101.5 + rise on both banks.
    const rimmed = (n, h0, tau, rim) => {
        const b = bankOf(tau), full = channel.bed + riverSideDepth(channel.depth, b.freeboard), r = riverBankRim(b, rim, full);
        return riverSectionHeight({ ...channel, n, h0, left: r, right: r });
    };

    it('keeps the banks up to the rim, never above the ground, the channel as it was', () => {
        for (const tau of [0, 1, 2]) for (const rise of [0.3, 2, 6]) for (const H of [0.6, 3, 12]) {
            const rim = 101.5 + rise;
            for (let n = -140; n <= 140; n += 0.25) {
                const g = channel.bed + channel.depth + H + 0.02 * n, h = rimmed(n, g, tau, rim);
                expect(h).toBeLessThanOrEqual(g + 1e-9);
                if (Math.abs(n) <= channel.hw) expect(h).toBe(riverSectionHeight({ ...channel, n, h0: g, left: bankOf(tau), right: bankOf(tau) }));
                // Beyond the step's ramp (its width for this height, 3 m per m of rise at most): at least the rim.
                if (Math.abs(n) >= channel.hw + 3 * (rim - 101) + 3) expect(h).toBeGreaterThanOrEqual(Math.min(g, rim) - 0.3);
            }
        }
    });

    it('stays continuous and free of teeth', () => {
        let worst = 0;
        for (let tau = 0; tau <= 2.0001; tau += 0.25) for (const rise of [0.5, 2.5, 6]) for (const H of [0.3, 2.2, 20]) {
            const count = 1121, h = new Float64Array(count), g = new Float64Array(count);
            for (let i = 0; i < count; i++) { const n = (i - 560) * DN; g[i] = channel.bed + channel.depth + H + 0.05 * Math.abs(n); h[i] = rimmed(n, g[i], tau, 101.5 + rise); }
            for (let i = 1; i < count; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(DN * 3);
            worst = Math.max(worst, sectionMetrics({ h, h0: g, dn: DN, wl: 101.5, extentL: 140, extentR: 140, spacing: 1 }).teeth);
        }
        expect(worst).toBeLessThan(0.15);
    });
});

describe('river width along a river', () => {
    it('varies 2-3x within a river (p90/p10), more in some rivers than in others', () => {
        const ratios = [];
        for (let river = 0; river < 200; river++) {
            const f = [];
            for (let s = 0; s < 20000; s += 20) f.push(riverWidthFactor(s, river).f);
            ratios.push(quantile(f, 0.9) / quantile(f, 0.1));
        }
        const med = quantile(ratios, 0.5);
        expect(med).toBeGreaterThan(2);
        expect(med).toBeLessThan(3);
        expect(quantile(ratios, 0.1)).toBeLessThan(med * 0.85);
        expect(quantile(ratios, 0.9)).toBeGreaterThan(med * 1.15);
        // A big river stays big: never below ~0.45 of its base width.
        for (let s = 0; s < 20000; s += 7) expect(riverWidthFactor(s, 7).f).toBeGreaterThan(Math.exp(-P.sigmaMax));
    });
});

describe('bank variety along a meandering river', () => {
    it('gives each side cut banks, ledges and no bank, in reaches of 100-400 m, sides differing', () => {
        const rows = [], river = 11, L = 12000, step = 4, hw0 = 10, H = 3;
        for (let s = 0; s <= L; s += step) {
            const kappa = Math.sin(2 * Math.PI * s / 900) / 180;   // bends of ~180 m radius every 450 m
            const hw = hw0 * riverWidthFactor(s, river).f;
            const left = riverBankParams(riverBankType(s, river, true, kappa), river), right = riverBankParams(riverBankType(s, river, false, kappa), river);
            const ch = { hw, bed: 100, depth: 1.6, skew: 0, left, right };
            const { h, h0 } = section(ch, () => 100 + 1.6 + H, hw + P.reachM + 10);
            const m = sectionMetrics({ h, h0, dn: DN, wl: 100 + 0.75 * 1.6, extentL: 1e9, extentR: 1e9, spacing: 1 });
            rows.push({ ...m, s, inLake: false, spacing: 1 });
        }
        const sum = summarizeRiver(rows, { stepM: step });
        for (const side of ['left', 'right']) {
            const c = sum.sides[side].classes;
            expect([c.high, c.low, c.none].filter(x => x >= 0.15).length).toBeGreaterThanOrEqual(2);
            const runs = Object.values(sum.sides[side].classRunMedianM).filter(x => x != null);
            expect(quantile(runs, 0.5)).toBeGreaterThanOrEqual(60);
            expect(sum.sides[side].blend50).toBeGreaterThanOrEqual(0.2);
        }
        expect(sum.sidesDiffer).toBeGreaterThanOrEqual(0.3);
        expect(sum.width.ratio9010).toBeGreaterThan(1.6);
        expect(sum.teeth.max).toBeLessThan(0.15);
    });
});

describe('river section WGSL', () => {
    const helpers = createTerrainCommon().match(/fn dConst[\s\S]*?(?=\nfn fbmAuto_d)/)[0];
    it('validates (scalar and dual)', () => {
        const code = helpers + createRiverNoiseWgsl() + createRiverSectionWgsl({ scalar: true, dual: true });
        expect(() => validate(parseWgsl(code))).not.toThrow();
    });
});
