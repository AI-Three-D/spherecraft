import { expect, it } from 'vitest';
import { faceUVToDir } from '../hydrology/waterGraph.js';
import { finishRiverFieldBake, prepareRiverFieldBake, riverFieldLayout } from './riverField.js';

it('matches an uncullled bake on all cube faces and near face edges at large planet scale', () => {
    const radius = 1_000_000, L = riverFieldLayout(radius), stride = 20, count = 9;
    const rivers = Array.from({ length: 6 }, (_, face) => {
        const points = new Float32Array(count * stride), centre = face % 2 ? 0.99 : 0.01;
        for (let i = 0; i < count; i++) {
            const x = (i - 4) * 50, dir = faceUVToDir(face, centre + x / (2 * radius), 0.35 + face * 0.04), level = 100 - 0.002 * x;
            points.set([...dir, level, 8 + face, 1.5, 1, 1, level, 0, 0, 0, 0, level, -1e4, -1e4, level, 1.5, -1e20, 0], i * stride);
        }
        return { rec: { points, stride, mouths: [] }, arc: Float64Array.from({ length: count }, (_, i) => i * 50), rid: face,
            levels: Float64Array.from({ length: count }, (_, i) => points[i * stride + 16]) };
    });
    const prep = prepareRiverFieldBake({ rivers, L }), nat = new Float32Array(prep.dirs4.length / 4).fill(102);
    const lakeCand = new Float32Array(nat.length).fill(NaN), input = { rivers, L, ...prep, nat, lakeCand };
    const full = finishRiverFieldBake({ ...input, cullPages: false }), fast = finishRiverFieldBake(input);
    expect(fast.stats.culledPageRivers).toBeGreaterThan(0);
    for (const key of prep.keys) expect(fast.pages.get(key)).toEqual(full.pages.get(key));
    expect(fast.flow).toEqual(full.flow);
    expect(fast.rocks).toEqual(full.rocks);
});
