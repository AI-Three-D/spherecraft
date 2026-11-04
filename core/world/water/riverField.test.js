import { expect, it } from 'vitest';
import { bakeRiverField, fieldCoords, fieldDir, pageKey, pageOf, riverFieldLayout, riverFieldTexelSdf, sampleRiverField, RIVER_FIELD } from './riverField.js';
import { buildRiverFieldTable, riverFieldHash } from './riverField.wgsl.js';

const R = 131000;
const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
// A point (x, y) metres from the face 1 centre (-X), x along -z... in a local tangent frame.
const C = [-1, 0, 0], E1 = [0, 0, 1], E2 = [0, 1, 0];
const at = (x, y) => norm([C[0] + (x * E1[0] + y * E2[0]) / R, C[1] + (x * E1[1] + y * E2[1]) / R, C[2] + (x * E1[2] + y * E2[2]) / R]);
const planeXY = (d) => { const k = -d[0]; return [d[2] / k * R, d[1] / k * R]; };

it('maps texel coordinates and directions both ways', () => {
    const L = riverFieldLayout(R);
    expect(L.T % L.P).toBe(0);
    for (const d of [at(0, 0), at(1234.5, -987.25), norm([0.3, -0.9, 0.2])]) {
        const q = fieldCoords(d, L), back = fieldDir(q.face, q.x, q.y, L);
        expect(Math.acos(Math.min(1, back[0] * d[0] + back[1] * d[1] + back[2] * d[2])) * R).toBeLessThan(1e-3);
    }
    // Texels are about texelM wide near a face's centre.
    const a = fieldCoords(at(0, 0), L), b = fieldCoords(at(100, 0), L);
    expect(Math.hypot(b.x - a.x, b.y - a.y) * RIVER_FIELD.texelM).toBeGreaterThan(95);
    expect(Math.hypot(b.x - a.x, b.y - a.y) * RIVER_FIELD.texelM).toBeLessThan(105);
    const key = pageKey(1, 17, L.PE - 3, L);
    expect(pageOf(key, L)).toEqual({ face: 1, pi: 17, pj: L.PE - 3 });
});

it('finds every page through the hash table', () => {
    const keys = Array.from({ length: 500 }, (_, i) => i * 7919 + 13);
    const { table, size } = buildRiverFieldTable(keys);
    keys.forEach((key, slot) => {
        let h = riverFieldHash(key) & (size - 1);
        while (table[h * 2] !== key + 1) { expect(table[h * 2]).not.toBe(0); h = (h + 1) & (size - 1); }
        expect(table[h * 2 + 1]).toBe(slot);
    });
});

it('cuts a channel under its level, keeps the water connected and only cuts', async () => {
    const L = riverFieldLayout(R);
    // A river along x from -300 to 300 m on ground sloping across (y) and
    // down along x; water 1 m under the banks, 6 m half-width.
    const ground = (x, y) => 100 - 0.01 * x + 0.05 * Math.abs(y) + 0.5;
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = 100 - 0.01 * x;
        points.set([d[0], d[1], d[2], wl, 6, 1.5, 1, 1, wl, 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.5, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc, rid: 7, levels }], L, sampleNatural, lakeAt: () => null, debug: true,
        o: { ...RIVER_FIELD, meanderAmp: 0 } });
    expect(r.stats.pages).toBeGreaterThan(10);
    // Sample the debug arrays at plane points.
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    for (const x of [-200, 0, 150]) {
        const centre = valueAt(x, 0, r.ground), wl = 100 - 0.01 * x;
        expect(centre).toBeLessThan(wl - 1.0);              // bed well under the water
        expect(valueAt(x, 0, r.wet)).toBe(1);
        expect(valueAt(x, 0, r.sdf)).toBeGreaterThan(3);
        expect(valueAt(x, 30, r.wet)).toBe(0);              // banks dry
        expect(valueAt(x, 30, r.ground)).toBeLessThanOrEqual(valueAt(x, 30, r.nat) + 1e-3);   // cut only
        expect(Math.abs(valueAt(x, 80, r.delta))).toBeLessThan(0.05);                 // natural beyond reach
    }
    // Packed pages decode to the bake's values (f16 for the distance).
    for (const [k, data] of r.pages) {
        const p = r.keys.indexOf(k);
        for (let j = 0; j < L.P; j += 7) for (let i = 0; i < L.P; i += 5) {
            const v = riverFieldTexelSdf(data, (j + L.A) * L.ST + i + L.A), want = r.sdf[p * L.P * L.P + j * L.P + i];
            expect(Math.abs(v - want)).toBeLessThan(0.02);
        }
    }
    const c = sampleRiverField(r.pages, L, at(0, 0));
    expect(c.found).toBe(true);
    expect(Math.abs(c.W - 100)).toBeLessThan(0.05);
    expect(c.delta).toBeLessThan(-1);
    // The water's edge lies near the half-width (6 m).
    let edge = 0;
    for (let y = 0; y < 20; y += 0.5) if (valueAt(0, y, r.wet)) edge = y;
    expect(edge).toBeGreaterThan(4);
    expect(edge).toBeLessThan(9);
});

it('meanders on flat ground within its amplitude, not on a cross slope', async () => {
    const L = riverFieldLayout(R);
    const n = 61, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -600 + 20 * k, d = at(x, 0), wl = 100 - 0.002 * x;
        points.set([d[0], d[1], d[2], wl, 5, 1.5, 1, 1, wl, 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.5, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const centres = async (ground) => {
        const sampleNatural = async (dirs4) => {
            const out = new Float32Array(dirs4.length / 4);
            for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
            return out;
        };
        const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc, rid: 11, levels }], L, sampleNatural, lakeAt: () => null, debug: true });
        const S = r.prepared[0].S, planeOf = r.prepared[0].plane;
        // Offsets of the stations from the traced line (y = 0 in this frame).
        let maxOff = 0;
        for (let i = 0; i < S.m; i++) {
            const d = [planeOf.frame.c[0] + (S.x[i] * planeOf.frame.e1[0] + S.y[i] * planeOf.frame.e2[0]) / R,
                planeOf.frame.c[1] + (S.x[i] * planeOf.frame.e1[1] + S.y[i] * planeOf.frame.e2[1]) / R,
                planeOf.frame.c[2] + (S.x[i] * planeOf.frame.e1[2] + S.y[i] * planeOf.frame.e2[2]) / R];
            maxOff = Math.max(maxOff, Math.abs(planeXY(norm(d))[1]));
        }
        return maxOff;
    };
    const flat = await centres((x, y) => 101 + 0.02 * Math.abs(y));
    const slope = await centres((x, y) => 101 + 0.3 * y + 0.02 * Math.abs(y));
    expect(flat).toBeGreaterThan(2);
    expect(flat).toBeLessThanOrEqual(RIVER_FIELD.meanderAmp * 10 + 0.5);
    expect(slope).toBeLessThan(0.5);
});

it('meets its lake at the lake level: no step where river and lake water touch', async () => {
    const L = riverFieldLayout(R);
    // River along x into a lake at x > 150 (level 99.0); the river's own
    // level stays 0.4 m higher until its trace's mouth at x = 250.
    const lakeLevel = 99.0, ground = (x, y) => (x > 150 ? 97 - 0.02 * (x - 150) : 100.2 - 0.002 * x) + 0.04 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = x < 250 ? 99.4 : lakeLevel;
        points.set([d[0], d[1], d[2], wl, 5, 1.2, 1, 1, wl, x > 250 ? -1 : 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.2, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const lakeAt = (d) => (planeXY(d)[0] > 150 ? { level: lakeLevel } : null);
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [{ s: 550, level: lakeLevel, hw: 5, sign: 1, landM: 64 }] }, arc, rid: 3, levels,
        destLevel: lakeLevel }], L, sampleNatural, lakeAt, debug: true, o: { ...RIVER_FIELD, meanderAmp: 0 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    // Along the centre line, the level never steps by more than 0.05 m per texel.
    let worst = 0, prev = valueAt(100, 0, r.level);
    for (let x = 102; x < 200; x += 2) { const v = valueAt(x, 0, r.level); worst = Math.max(worst, Math.abs(v - prev)); prev = v; }
    expect(worst).toBeLessThan(0.1);   // a ramp (0.4 m over lakeEaseM), not a step
    expect(Math.abs(valueAt(152, 0, r.level) - lakeLevel)).toBeLessThan(0.05);
});

it('bakes a degenerate trace (two identical points) without hanging', async () => {
    const L = riverFieldLayout(R), st = 20, points = new Float32Array(2 * st), d = at(0, 0);
    for (let k = 0; k < 2; k++) points.set([d[0], d[1], d[2], 100, 23, 1.5, 1, 1, 100, 0, 0, 0, 0, 100, -1e4, -1e4, 100, 1.5, -1e20, 0], k * st);
    const sampleNatural = async (dirs4) => new Float32Array(dirs4.length / 4).fill(101);
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc: Float64Array.from([0, 0]), rid: 2587, levels: Float64Array.from([100, 100]) }],
        L, sampleNatural, lakeAt: () => null });
    expect(r.stats.pages).toBeGreaterThan(0);
});

it('does not flood low ground beyond a river\'s reach', async () => {
    const L = riverFieldLayout(R);
    // A channel along x with a hollow far off to the side, joined to it by a
    // low strip: all of it under the river's level.
    const ground = (x, y) => (y > 60 ? 98 : 100.5) - (Math.abs(x) < 20 && y > 0 ? 2.5 : 0);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0);
        points.set([d[0], d[1], d[2], 100, 6, 1.5, 1, 1, 100, 0, 0, 0, 0, 100, -1e4, -1e4, 100, 1.5, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc, rid: 9, levels }], L, sampleNatural, lakeAt: () => null, debug: true,
        o: { ...RIVER_FIELD, meanderAmp: 0, containM: -10 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return p < 0 ? 0 : arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    expect(valueAt(150, 0, r.wet)).toBe(1);
    expect(valueAt(0, 80, r.wet)).toBe(0);
});

it('keeps a steep stream wet down to its lake: the bed follows the eased level', async () => {
    const L = riverFieldLayout(R);
    const lakeLevel = 99.0, ground = (x, y) => (x > 150 ? 96 : 103.2 - 0.002 * x) + 0.05 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = x < 250 ? 102 : lakeLevel;
        points.set([d[0], d[1], d[2], wl, 5, 1.2, 1, 1, wl, x > 250 ? -1 : 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.2, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [{ s: 550, level: lakeLevel, hw: 5, sign: 1, landM: 64 }] }, arc, rid: 4, levels, destLevel: lakeLevel }],
        L, sampleNatural, lakeAt: (d) => (planeXY(d)[0] > 150 ? { level: lakeLevel } : null), debug: true, o: { ...RIVER_FIELD, meanderAmp: 0 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    for (let x = 40; x < 170; x += 2) expect(valueAt(x, 0, r.wet)).toBe(1);
});

it('leaves no bar across the channel when the mouth station lies on land before the lake', async () => {
    const L = riverFieldLayout(R);
    // The river's mouth station is at x = 100, the lake's water begins at x = 170.
    const lakeLevel = 99.0, ground = (x, y) => (x > 170 ? 96.5 : 100.5) + 0.05 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0);
        points.set([d[0], d[1], d[2], lakeLevel, 5, 1.2, 1, 1, lakeLevel, 0, 0, 0, 0, lakeLevel, -1e4, -1e4, lakeLevel, 1.2, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [{ s: 400, level: lakeLevel, hw: 5, sign: 1, landM: 64 }] }, arc, rid: 6, levels, destLevel: lakeLevel }],
        L, sampleNatural, lakeAt: (d) => (planeXY(d)[0] > 170 ? { level: lakeLevel } : null), debug: true, o: { ...RIVER_FIELD, meanderAmp: 0 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    for (let x = 80; x < 180; x += 2) expect(valueAt(x, 0, r.ground)).toBeLessThan(lakeLevel - 0.3);
});

it('continues the water\'s level on the dry ground beside it', async () => {
    const L = riverFieldLayout(R);
    // A lake at x > 150, 3 m under the river that passes its shore far upstream.
    const lakeLevel = 97.0, ground = (x, y) => (x > 150 ? 95 : 100.5) + 0.04 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = x < 100 ? 100 : lakeLevel;
        points.set([d[0], d[1], d[2], wl, 5, 1.2, 1, 1, wl, 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.2, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc, rid: 8, levels, destLevel: lakeLevel }],
        L, sampleNatural, lakeAt: (d) => (planeXY(d)[0] > 150 ? { level: lakeLevel } : null), debug: true, o: { ...RIVER_FIELD, meanderAmp: 0 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const p = r.keys.indexOf(key);
        return arr[p * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    // Just outside the lake's shore, far from the channel: the lake's level.
    expect(valueAt(146, 60, r.wet)).toBe(0);
    expect(Math.abs(valueAt(146, 60, r.level) - lakeLevel)).toBeLessThan(0.1);
});
