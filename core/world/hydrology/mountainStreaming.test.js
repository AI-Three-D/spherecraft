import { expect, it } from 'vitest';
import { chooseMountainLakes, MOUNTAIN_LAKE_DEFAULTS as P } from './mountainLakes.js';
import { settledMountainPrefix } from './mountainStreaming.js';

const R = 131000, origin = [1, 0, 0];
const dir = (x, y) => { const n = Math.hypot(R, x, y); return [R / n, x / n, y / n]; };
const distance = d => Math.acos(Math.min(1, d[0])) * R;
const byDistance = (a, b) => distance(a.dir) - distance(b.dir) || a.dir[0] - b.dir[0] || a.dir[1] - b.dir[1];

it('only releases a prefix of the complete greedy choice across varied unfinished blocks', () => {
    let seed = 1947;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 250; run++) {
        const all = Array.from({ length: 40 }, (_, id) => ({ id, dir: dir((random() - .5) * 16000, (random() - .5) * 16000),
            areaKm2: .03 + random() * 1.5, enclosureM: 30, outflowDropM: 30 }));
        const known = [], pending = [];
        for (const p of all) {
            if (random() < .65) known.push(p);
            else pending.push({ c: p.dir, pointRadiusM: 0, maxRadiusM: Math.sqrt(p.areaKm2 * 1e6 / Math.PI) });
        }
        const expected = chooseMountainLakes(all, R, P).sort(byDistance).map(p => p.id);
        const prefix = settledMountainPrefix(known, pending, origin, R, P).map(p => p.id);
        expect(prefix).toEqual(expected.slice(0, prefix.length));
        const complete = settledMountainPrefix(all, [], origin, R, P).map(p => p.id);
        expect(complete).toEqual(expected);
    }
});

it('does not wait for a distant unfinished block to select a nearby isolated lake', () => {
    const near = { id: 1, dir: dir(100, 0), areaKm2: .1, enclosureM: 30, outflowDropM: 30 };
    const pending = [{ c: dir(20000, 0), pointRadiusM: 3000, maxRadiusM: 3000 }];
    expect(settledMountainPrefix([near], pending, origin, R, P)).toEqual([near]);
});

it('preserves the full selection with multiple candidates per bounded block', () => {
    let seed = 81031;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let run = 0; run < 150; run++) {
        const blocks = Array.from({ length: 24 }, (_, b) => {
            const x = (random() - .5) * 30000, y = (random() - .5) * 30000, c = dir(x, y);
            const candidates = Array.from({ length: 5 }, (_, k) => ({ id: b * 5 + k, dir: dir(x + (random() - .5) * 2000, y + (random() - .5) * 2000),
                areaKm2: .03 + random() * 2, enclosureM: 30, outflowDropM: 30 }));
            const pointRadiusM = Math.max(...candidates.map(p => Math.acos(Math.min(1, c[0] * p.dir[0] + c[1] * p.dir[1] + c[2] * p.dir[2])) * R)) + 1;
            const maxRadiusM = Math.max(...candidates.map(p => Math.sqrt(p.areaKm2 * 1e6 / Math.PI))) + 1;
            return { candidates, c, pointRadiusM, maxRadiusM };
        });
        const known = [], pending = [];
        for (const b of blocks) {
            if (random() < .6) known.push(...b.candidates);
            else pending.push(b);
        }
        const all = blocks.flatMap(b => b.candidates);
        const expected = chooseMountainLakes(all, R, P).sort(byDistance).map(p => p.id);
        const prefix = settledMountainPrefix(known, pending, origin, R, P).map(p => p.id);
        expect(prefix).toEqual(expected.slice(0, prefix.length));
    }
});
