import { describe, expect, it } from 'vitest';
import { OWNER_COLOURS, classifyOwners, ribbonContainment } from './ownership.js';
import { readPng, writePng } from './png.js';

// A capture of w x 1 pixels from rgb triples.
const row = (...rgb) => ({ w: rgb.length, h: 1, px: Uint8Array.from(rgb.flat()) });
const ON = 255, OFF = 0;

describe('classifyOwners', () => {
    it('classes each pixel by the passes that draw it', () => {
        // pixels: terrain only, ribbon only, both, gap, dry zone, lake outside a zone, background, sky
        const v6 = row([ON, OFF, OFF], [OFF, ON, OFF], [ON, ON, OFF], [OFF, OFF, OFF], [OFF, OFF, OFF], [OFF, OFF, OFF], [OFF, OFF, OFF], [120, 170, 230]);
        const v7 = row([ON, ON, OFF], [ON, ON, OFF], [ON, ON, OFF], [ON, ON, OFF], [ON, OFF, OFF], [OFF, OFF, ON], [OFF, OFF, OFF], [120, 170, 230]);
        const r = classifyOwners(v6, v7);
        expect(r.counts).toMatchObject({ terrain: 1, ribbon: 1, multi: 1, gap: 1, dry: 1, lakeOutside: 1, background: 1, other: 1 });
        expect(r.shares.area).toBe(5);
        expect(r.shares.wet).toBe(4);
        expect(r.shares.multi).toBeCloseTo(0.25, 9);
        // Every area pixel differs from its neighbours here.
        expect(r.isolated).toBe(5);
        expect([...r.image.subarray(6, 9)]).toEqual(OWNER_COLOURS.multi);
    });

    it('counts lake water inside a river zone as an owner', () => {
        const r = classifyOwners(row([OFF, ON, OFF], [OFF, OFF, OFF]), row([ON, ON, ON], [ON, ON, ON]));
        expect(r.counts.multi).toBe(1);   // ribbon over lake water
        expect(r.counts.lake).toBe(1);
    });

    it('does not count a pixel with same-class neighbours as isolated', () => {
        const r = classifyOwners(row([OFF, ON, OFF], [OFF, ON, OFF], [ON, ON, OFF]), row([ON, ON, OFF], [ON, ON, OFF], [ON, ON, OFF]));
        expect(r.counts.ribbon).toBe(2);
        expect(r.isolated).toBe(1);
    });
});

describe('ribbonContainment', () => {
    it('gives the share of changed pixels that view 6 shows green', () => {
        const a = row([10, 10, 10], [100, 100, 100], [100, 100, 100]);
        const b = row([10, 10, 10], [10, 10, 10], [10, 10, 10]);
        const v6 = row([OFF, OFF, OFF], [OFF, ON, OFF], [ON, OFF, OFF]);
        expect(ribbonContainment(a, b, v6)).toEqual({ changed: 2, green: 1, share: 0.5 });
    });
});

describe('png', () => {
    it('reads back what it writes', () => {
        const px = Uint8Array.from({ length: 3 * 5 * 3 }, (_, i) => (i * 37) & 255);
        const back = readPng(writePng(5, 3, px));
        expect(back.w).toBe(5);
        expect(back.h).toBe(3);
        expect([...back.px]).toEqual([...px]);
    });
});
