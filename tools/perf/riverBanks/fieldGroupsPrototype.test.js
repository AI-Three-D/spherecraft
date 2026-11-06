import { expect, it } from 'vitest';
import { prepareRiverFieldBake, finishRiverFieldBake, riverFieldLayout } from '../../../core/world/water/riverField.js';
import { fieldPageGroups } from './fieldGroups.js';

// Prototype only: proves equivalence for this fixture, not for arbitrary lake
// and plume interactions. Production still bakes the complete field.
it('can bake separated synthetic groups with the same field and flow values', () => {
    const R = 131000, L = riverFieldLayout(R), n = 31, stride = 20;
    const rivers = [0, 100, 2000].map((y, rid) => {
        const points = new Float32Array(n * stride);
        for (let i = 0; i < n; i++) {
            const x = -300 + i * 20, length = Math.hypot(1, y / R, x / R), level = 100 - 0.002 * x;
            points.set([-1 / length, y / R / length, x / R / length, level, 8, 1.5, 1, 1, level, 0, 0, 0, 0, level, -1e4, -1e4, level, 1.5, -1e20, 0], i * stride);
        }
        return { rec: { points, stride, mouths: [] }, arc: Float64Array.from({ length: n }, (_, i) => i * 20), rid,
            levels: Float64Array.from({ length: n }, (_, i) => points[i * stride + 16]) };
    });
    const prep = prepareRiverFieldBake({ rivers, L }), PP = L.P * L.P;
    const nat = Float32Array.from({ length: prep.dirs4.length / 4 }, (_, i) => {
        const k = -prep.dirs4[i * 4], x = prep.dirs4[i * 4 + 2] / k * R, y = prep.dirs4[i * 4 + 1] / k * R;
        return 100 - 0.002 * x + 0.05 * Math.min(Math.abs(y), Math.abs(y - 100), Math.abs(y - 2000)) + 0.5;
    });
    const lakeCand = new Float32Array(nat.length).fill(NaN);
    const full = finishRiverFieldBake({ rivers, L, ...prep, nat, lakeCand, cullPages: false });
    const culled = finishRiverFieldBake({ rivers, L, ...prep, nat, lakeCand });
    expect(culled.stats.emptyTexelPages).toBeGreaterThan(0);
    for (const key of prep.keys) expect(culled.pages.get(key)).toEqual(full.pages.get(key));
    expect(culled.flow).toEqual(full.flow);
    expect(culled.rocks).toEqual(full.rocks);
    const groups = fieldPageGroups(prep.keys, prep.pageRivers, L, { includeMembers: true });
    expect(groups.length).toBe(2);
    for (const group of groups) {
        const localRivers = group.riverIndices.map(i => rivers[i]);
        const localIndex = new Map(group.riverIndices.map((v, i) => [v, i]));
        const dirs4 = new Float32Array(group.pages * PP * 4), heights = new Float32Array(group.pages * PP), lakes = new Float32Array(group.pages * PP);
        group.slots.forEach((slot, i) => {
            dirs4.set(prep.dirs4.subarray(slot * PP * 4, (slot + 1) * PP * 4), i * PP * 4);
            heights.set(nat.subarray(slot * PP, (slot + 1) * PP), i * PP);
            lakes.set(lakeCand.subarray(slot * PP, (slot + 1) * PP), i * PP);
        });
        const keys = group.slots.map(i => prep.keys[i]);
        const pageRivers = group.slots.map(i => prep.pageRivers[i].map(r => localIndex.get(r)));
        const part = finishRiverFieldBake({ rivers: localRivers, L, keys, pageRivers, dirs4, nat: heights, lakeCand: lakes });
        group.slots.forEach((slot, i) => {
            expect(part.pages.get(keys[i])).toEqual(full.pages.get(keys[i]));
            expect(part.flow.subarray(i * L.TEX, (i + 1) * L.TEX)).toEqual(full.flow.subarray(slot * L.TEX, (slot + 1) * L.TEX));
        });
    }
});
