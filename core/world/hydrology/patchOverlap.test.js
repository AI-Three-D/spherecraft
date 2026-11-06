import { expect, it } from 'vitest';
import { patchRectsMayOverlap } from './patchOverlap.js';
import { tangentBasis, planeToDir, dirToPlane } from './lakeRefine.js';

const R = 131000;
const frame = (centre, x0, y0, nx, ny, spacing = 10) => ({ c: centre, ...tangentBasis(centre), x0, y0, nx, ny, spacing });
const base = frame([0, 0, 1], -5000, -500, 1000, 100);

it('rejects a separated lake inside the old circular bound but keeps real overlaps', () => {
    expect(patchRectsMayOverlap(base, frame([0, 0, 1], -100, 3000, 20, 20), R)).toBe(false);
    expect(patchRectsMayOverlap(base, frame([0, 0, 1], -100, -100, 20, 20), R)).toBe(true);
    expect(patchRectsMayOverlap(base, frame([0, 0, 1], 4950, -100, 20, 20), R)).toBe(true);
});

it('keeps overlaps across different tangent frames, including off-centre patches', () => {
    const centre = planeToDir(4000, 100, base, R), shifted = frame(centre, -200, -200, 40, 40);
    expect(patchRectsMayOverlap(base, shifted, R)).toBe(true);
    expect(patchRectsMayOverlap(shifted, base, R)).toBe(true);
    const farCentre = planeToDir(0, 3500, base, R), far = frame(farCentre, -100, -100, 20, 20);
    expect(patchRectsMayOverlap(base, far, R)).toBe(false);
});

it('does not exclude uncertain frames', () => {
    expect(patchRectsMayOverlap({ c: [0, 0, 1] }, base, R)).toBe(true);
    expect(patchRectsMayOverlap(base, frame([0, 0, -1], -10, -10, 2, 2), R)).toBe(true);
});

it('never rejects sampled overlap for varied positions and tangent frames', () => {
    let seed = 19;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 0; n < 300; n++) {
        const centre = planeToDir((random() - 0.5) * 20000, (random() - 0.5) * 20000, base, R);
        const b = frame(centre, (random() - 0.5) * 5000, (random() - 0.5) * 5000, 20 + random() * 300, 20 + random() * 300);
        if (patchRectsMayOverlap(base, b, R)) continue;
        for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
            const dir = planeToDir(b.x0 + b.nx * b.spacing * i / 8, b.y0 + b.ny * b.spacing * j / 8, b, R);
            const [x, y] = dirToPlane(dir, base, R);
            expect(x >= base.x0 && x <= base.x0 + base.nx * base.spacing && y >= base.y0 && y <= base.y0 + base.ny * base.spacing).toBe(false);
        }
    }
});
