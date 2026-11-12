import { expect, it } from 'vitest';
import { RIVER_BANK_PREVIEWS } from './RiverFieldService.js';
import { bakeRiverField, fieldCoords, pageKey, riverFieldLayout, RIVER_FIELD } from './riverField.js';

const R = 131000;
const dir = (x, y) => { const d = [-1, y / R, x / R], n = Math.hypot(...d); return d.map(v => v / n); };
const xy = d => [R * d[2] / -d[0], R * d[1] / -d[0]];

it('supports a low riverbed and fades a wide bank without raising lake ground', async () => {
    const L = riverFieldLayout(R), stride = 20, n = 21, points = new Float32Array(n * stride);
    for (let k = 0; k < n; k++) {
        const d = dir(-200 + k * 20, 0);
        points.set([...d, 100, 6, 1.5, 1, 1, 100, 0, 0, 0, 0, 100, -1e4, -1e4, 100, 1.5, -1e20, 0], k * stride);
    }
    const river = { rec: { points, stride, mouths: [] }, arc: Float64Array.from({ length: n }, (_, i) => i * 20),
        levels: new Float64Array(n).fill(100), rid: 3, destLevel: 100 };
    const sampleNatural = async dirs => Float32Array.from({ length: dirs.length / 4 }, (_, i) => {
        const [, y] = xy(dirs.subarray(i * 4, i * 4 + 3));
        return 97 - 0.15 * y;
    });
    const opts = { ...RIVER_FIELD, meanderAmp: 0, widenRiver: 1, widenReach: 1 };
    const bake = (o, lakeAt = () => null) => bakeRiverField({ rivers: [river], L, sampleNatural, lakeAt, o, debug: true });
    const normal = await bake(opts);
    const wide = await bake({ ...opts, reachM: RIVER_BANK_PREVIEWS.wide.reachM, bankPreview: RIVER_BANK_PREVIEWS.wide });
    const sample = (b, x, y, key) => {
        const q = fieldCoords(dir(x, y), L), px = Math.floor(q.x / L.P), py = Math.floor(q.y / L.P);
        const slot = b.keys.indexOf(pageKey(q.face, px, py, L));
        expect(slot).toBeGreaterThanOrEqual(0);
        return b[key][slot * L.P * L.P + (Math.floor(q.y) - py * L.P) * L.P + Math.floor(q.x) - px * L.P];
    };
    expect(sample(wide, 0, 0, 'ground')).toBeGreaterThan(sample(normal, 0, 0, 'ground') + 0.5);
    expect(sample(wide, 0, 80, 'ground')).toBeGreaterThan(sample(normal, 0, 80, 'ground') + 1);
    // On falling natural ground the filled bank should rise away from the
    // water rather than form a raised lip followed by a downhill slope.
    expect(sample(wide, 0, 30, 'ground')).toBeGreaterThan(sample(wide, 0, 12, 'ground'));
    expect(sample(wide, 0, 60, 'ground')).toBeGreaterThan(sample(wide, 0, 30, 'ground'));
    expect(sample(wide, 0, 330, 'ground')).toBeCloseTo(sample(wide, 0, 330, 'nat'), 3);
    const even = await bake({ ...opts, reachM: RIVER_BANK_PREVIEWS.wide.reachM,
        bankPreview: { ...RIVER_BANK_PREVIEWS.wide, riseVariationM: 0 } });
    const extra = [-140, -100, -60, -20, 20, 60, 100, 140]
        .map(x => sample(wide, x, 80, 'ground') - sample(even, x, 80, 'ground'));
    expect(Math.max(...extra)).toBeGreaterThan(0.1);
    expect(Math.max(...extra) - Math.min(...extra)).toBeGreaterThan(0.1);
    const lake = await bake({ ...opts, reachM: RIVER_BANK_PREVIEWS.wide.reachM, bankPreview: RIVER_BANK_PREVIEWS.wide },
        d => xy(d)[1] > 50 ? { level: 100 } : null);
    expect(sample(lake, 0, 80, 'ground')).toBeCloseTo(sample(lake, 0, 80, 'nat'), 3);
    expect(sample(lake, 0, 52, 'ground')).toBeCloseTo(sample(lake, 0, 52, 'nat'), 1);
}, 30000);
