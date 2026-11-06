import { describe, expect, it } from 'vitest';
import { bakeRiverField, extendRiverEnds, riverWidthFactor, fieldCoords, fieldDir, pageKey, pageOf, riverFieldLayout, riverFieldPageDirections, riverFieldTexelSdf, sampleRiverField, RIVER_FIELD } from './riverField.js';
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

it('generates the same directions on every face, including cube edges', () => {
    const L = riverFieldLayout(R), keys = [];
    for (let face = 0; face < 6; face++) {
        for (const [x, y] of [[0, 0], [L.PE - 1, L.PE - 1], [L.PE >> 1, L.PE >> 1]]) keys.push(pageKey(face, x, y, L));
    }
    const dirs = riverFieldPageDirections(keys, L);
    for (let p = 0; p < keys.length; p++) {
        const { face, pi, pj } = pageOf(keys[p], L);
        for (let j = 0; j < L.P; j++) for (let i = 0; i < L.P; i++) {
            const expected = fieldDir(face, pi * L.P + i + 0.5, pj * L.P + j + 0.5, L);
            const offset = (p * L.P * L.P + j * L.P + i) * 4;
            for (let k = 0; k < 3; k++) expect(dirs[offset + k]).toBe(Math.fround(expected[k]));
        }
    }
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
        o: { ...RIVER_FIELD, meanderAmp: 0, widenRiver: 1, widenReach: 1 } });
    expect(r.stats.pages).toBeGreaterThan(10);
    expect(r.stats.drySdfPages).toBeGreaterThan(0);
    expect(r.pages.packed.length).toBe(r.pages.size * L.TEX * 2);
    for (const page of r.pages.values()) expect(page.buffer).toBe(r.pages.packed.buffer);
    // Independently check distances on both sides of page boundaries. Dry
    // pages can skip the transform only when their entire halo is dry.
    const PP = L.P * L.P, halo = Math.ceil(RIVER_FIELD.sdfM / RIVER_FIELD.texelM);
    const slots = new Map(r.keys.map((key, i) => [key, i]));
    for (let p = 0; p < r.keys.length; p++) {
        const { face, pi, pj } = r.pageInfo[p];
        const wetAt = (i, j) => {
            const x = pi * L.P + i, y = pj * L.P + j;
            if (x < 0 || y < 0 || x >= L.T || y >= L.T) return 0;
            const px = Math.floor(x / L.P), py = Math.floor(y / L.P);
            const slot = slots.get(pageKey(face, px, py, L));
            return slot === undefined ? 0 : r.wet[slot * PP + (y - py * L.P) * L.P + x - px * L.P];
        };
        for (const [i, j] of [[0, 0], [L.P - 1, 0], [0, L.P - 1], [L.P - 1, L.P - 1], [L.P >> 1, L.P >> 1]]) {
            const wet = wetAt(i, j);
            let nearest2 = 1e12;
            for (let y = -halo; y < L.P + halo; y++) for (let x = -halo; x < L.P + halo; x++) {
                if (wetAt(x, y) !== wet) nearest2 = Math.min(nearest2, (x - i) ** 2 + (y - j) ** 2);
            }
            const signed = (Math.sqrt(nearest2) - 0.5) * RIVER_FIELD.texelM * (wet ? 1 : -1);
            const expected = Math.max(-RIVER_FIELD.sdfM, Math.min(RIVER_FIELD.sdfM, signed));
            expect(r.sdf[p * PP + j * L.P + i]).toBeCloseTo(expected, 4);
        }
    }
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

it('keeps a steep stream its full width under the lake mask, up to where it reaches the lake', async () => {
    // A hillside falling 30 % into a lake, the 32 m mask reaching 12 m up it. At the lake's
    // level only the tip of the cut is under water: a neck across the river.
    const L = riverFieldLayout(R);
    const lakeLevel = 100, hill = (x) => 130 - 0.3 * x, ground = (x, y) => hill(x) + 0.05 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = Math.max(hill(x) - 1.2, lakeLevel);
        points.set([d[0], d[1], d[2], wl, 8, 1.2, 1, 1, wl, x > 130 ? -1 : 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.2, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [{ s: 400, level: lakeLevel, hw: 8, sign: 1, landM: 64 }] }, arc, rid: 4, levels, destLevel: lakeLevel }],
        L, sampleNatural, lakeAt: (d) => (planeXY(d)[0] > 88 ? { level: lakeLevel } : null), debug: true,
        o: { ...RIVER_FIELD, meanderAmp: 0, shoreAmp: 0, widenRiver: 1, widenReach: 1 } });
    const wetAt = (x, y) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        return r.wet[r.keys.indexOf(key) * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    for (let x = 40; x <= 104; x += 2) {
        let width = 0;
        for (let y = -30; y <= 30; y += 2) width += wetAt(x, y) ? 2 : 0;
        expect(width, `at ${x} m`).toBeGreaterThanOrEqual(12);
    }
});

it('keeps its banks off rising ground: a wide channel in a valley does not cut walls', async () => {
    // A valley rising 25 % either way from the river, the trace 20 m to each side.
    const L = riverFieldLayout(R);
    const ground = (x, y) => 100.5 - 0.002 * x + 0.25 * Math.abs(y);
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = 100 - 0.002 * x;
        points.set([d[0], d[1], d[2], wl, 20, 1.5, 1, 1, wl, 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.5, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = ground(x, y); }
        return out;
    };
    const wetHalf = async (bankCutM) => {
        const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [] }, arc, rid: 7, levels }], L, sampleNatural, lakeAt: () => null, debug: true,
            o: { ...RIVER_FIELD, meanderAmp: 0, shoreAmp: 0, widenRiver: 1, widenReach: 1, bankCutM } });
        const wetAt = (x, y) => {
            const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
            return r.wet[r.keys.indexOf(key) * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
        };
        let y = 0;
        while (wetAt(0, y + 2)) y += 2;
        return y;
    };
    // Natural ground at 20 m stands 5.5 m over the water; 3 m over it comes at 10 m, and
    // the blur at the water's edge takes a little more on a slope like this.
    expect(await wetHalf(100)).toBeGreaterThanOrEqual(18);
    const held = await wetHalf(3);
    expect(held).toBeLessThanOrEqual(12);
    expect(held).toBeGreaterThanOrEqual(5);
});

it('cuts no land past a lake shore: a wide end stays out of the ground beside it', async () => {
    // A shore at an angle to the river: on the river's -y side land goes on past where its
    // centre enters the lake.
    const L = riverFieldLayout(R);
    const lakeLevel = 100, nat = (x, y) => 100 + 0.25 * (150 - x - 0.9 * y), hw = 40;
    const n = 31, st = 20, points = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const x = -300 + 20 * k, d = at(x, 0), wl = Math.max(nat(x, 0) - 1, lakeLevel);
        points.set([d[0], d[1], d[2], wl, hw, 1.5, 1, 1, wl, x > 170 ? -1 : 0, 0, 0, 0, wl, -1e4, -1e4, wl, 1.5, -1e20, 0], k * st);
    }
    const arc = Float64Array.from({ length: n }, (_, k) => 20 * k);
    const levels = Float64Array.from({ length: n }, (_, k) => points[k * st + 16]);
    const sampleNatural = async (dirs4) => {
        const out = new Float32Array(dirs4.length / 4);
        for (let i = 0; i < out.length; i++) { const [x, y] = planeXY([dirs4[i * 4], dirs4[i * 4 + 1], dirs4[i * 4 + 2]]); out[i] = nat(x, y); }
        return out;
    };
    const r = await bakeRiverField({ rivers: [{ rec: { points, stride: st, mouths: [{ s: 450, level: lakeLevel, hw, sign: 1, landM: 64 }] }, arc, rid: 4, levels, destLevel: lakeLevel }],
        L, sampleNatural, lakeAt: (d) => { const [x, y] = planeXY(d); return nat(x, y) < lakeLevel ? { level: lakeLevel } : null; }, debug: true, o: { ...RIVER_FIELD, meanderAmp: 0, shoreAmp: 0, widenRiver: 1, widenReach: 1 } });
    const valueAt = (x, y, arr) => {
        const q = fieldCoords(at(x, y), L), key = pageKey(q.face, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        return arr[r.keys.indexOf(key) * L.P * L.P + (Math.floor(q.y) % L.P) * L.P + (Math.floor(q.x) % L.P)];
    };
    // Land past the shore's crossing of the centre, inside the channel's half-width: left alone, dry.
    for (const [x, y] of [[172, -34], [176, -36], [174, -38], [178, -38]]) {
        expect(nat(x, y)).toBeGreaterThan(lakeLevel + 1);
        expect(valueAt(x, y, r.ground), `ground at ${x}, ${y}`).toBeCloseTo(nat(x, y), 1);
        expect(valueAt(x, y, r.wet)).toBe(0);
    }
    // The river still reaches its lake.
    for (let x = 100; x < 190; x += 4) expect(valueAt(x, 0, r.wet), `wet at ${x}`).toBe(1);
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

describe('river ends in lakes', () => {
    const R = 131072, st = 12;
    const river = (extra) => {
        const points = new Float32Array(3 * st);
        [[0, 0, 1], [100 / R, 0, 1], [200 / R, 0, 1]].forEach((d, k) => {
            const l = Math.hypot(...d);
            points.set([d[0] / l, d[1] / l, d[2] / l, 50 - k, 8], k * st);
        });
        return { rec: { points, stride: st, mouths: [{ s: 200, sign: 1 }] }, arc: [0, 100, 200], levels: [50, 49, 48], rid: 1, ...extra };
    };
    it('carries only the ends that have a lake, straight on, at its level', () => {
        expect(extendRiverEnds(river({}), R)).toEqual(river({}));
        const e = extendRiverEnds(river({ destLevel: 47 }), R), n = e.rec.points.length / st;
        expect(n).toBe(4);
        expect(e.levels[3]).toBe(47);
        expect(e.arc[3] - e.arc[2]).toBeCloseTo(60 + 2 * 8);
        expect(e.rec.points[3 * st] * R).toBeCloseTo(276, 0);
    });
    it('shifts arc lengths and mouths past a carried source', () => {
        const e = extendRiverEnds(river({ srcLevel: 51 }), R);
        expect(e.arc[1]).toBeCloseTo(76);
        expect(e.rec.mouths[0].s).toBeCloseTo(276);
        expect(e.levels[0]).toBe(51);
    });
});

describe('river width', () => {
    it('is never narrower than traced, varies along a river and stays within widenMax', () => {
        const seen = [];
        for (let rid = 0; rid < 40; rid++) for (let x = 0; x <= 4000; x += 25) seen.push(riverWidthFactor(rid, x, 4000));
        expect(Math.min(...seen)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...seen)).toBeLessThanOrEqual(RIVER_FIELD.widenMax);
        expect(Math.max(...seen)).toBeGreaterThan(1.7);
    });
    it('comes back to the river\'s own width at its ends', () => {
        expect(riverWidthFactor(3, 0, 4000)).toBeCloseTo(riverWidthFactor(3, 4000, 4000), 6);
    });
});
