import { describe, expect, it } from 'vitest';
import { buildWaterGraph, cellDir, dirToCell, dirToFaceUV, faceUVToDir, makeNeighbors } from './waterGraph.js';

// Synthetic planets: height(dir) sampled at the cube-grid cell centres. The
// grid is coarse, so the tests set their own lake thresholds (SMALL).
const N = 24;
const SMALL = { minLakeDepthM: 3, minLakeCells: 4 };
function heightsFrom(fn) {
    const h = new Float32Array(6 * N * N);
    for (let id = 0; id < h.length; id++) h[id] = fn(cellDir(id, N));
    return h;
}
// Heights set per cell (face, i, j), for exact control over drainage.
function gridHeights(M, fn) {
    const h = new Float32Array(6 * M * M);
    for (let face = 0; face < 6; face++) {
        for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) h[face * M * M + j * M + i] = fn(face, i, j);
    }
    return h;
}
// Every river starts at a lake and, following its end links (a confluence
// hands over to the trunk), reaches a lake or the sea.
function expectNoDeadEnds(g, h) {
    for (const r of g.rivers) {
        expect(g.lakes[r.fromLake]).toBeDefined();
        expect(g.lakeOf[r.cells[0]]).toBe(r.fromLake);
        let cur = r, hops = 0;
        while (cur.to.type === 'river') {
            const trunk = g.rivers[cur.to.id];
            expect(trunk.cells).toContain(cur.to.cell);
            cur = trunk;
            expect(++hops).toBeLessThan(g.rivers.length + 1);
        }
        const last = cur.cells[cur.cells.length - 1];
        if (cur.to.type === 'sea') expect(h[last]).toBeLessThanOrEqual(0);
        else expect(g.lakeOf[last]).toBe(cur.to.id);
    }
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };

// A continent around +Z: ocean beyond ~70 degrees, land rising toward +Z.
const continent = (d) => (angle(d, [0, 0, 1]) < 1.2 ? 400 * (1.2 - angle(d, [0, 0, 1])) + 10 : -200);
// A bowl (depression) of given depth and radius centred on c.
const bowl = (d, c, depthM, radius) => {
    const a = angle(d, c);
    return a < radius ? -depthM * (1 - (a / radius) ** 2) : 0;
};

describe('cube grid', () => {
    it('maps face UV to direction and back', () => {
        for (let face = 0; face < 6; face++) {
            for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.07]]) {
                const r = dirToFaceUV(faceUVToDir(face, u, v));
                expect(r.face).toBe(face);
                expect(r.u).toBeCloseTo(u, 9);
                expect(r.v).toBeCloseTo(v, 9);
            }
        }
    });

    it('neighbours are symmetric, including across face edges', () => {
        const neighbors = makeNeighbors(N);
        const sets = new Map();
        for (let id = 0; id < 6 * N * N; id++) {
            const { list, count } = neighbors(id);
            sets.set(id, new Set(Array.from(list.slice(0, count))));
        }
        let checked = 0;
        for (const [id, s] of sets) {
            for (const nb of s) {
                // Cube corners have 7 neighbours, so a diagonal may be one-way;
                // edge-adjacent (4-neighbour) relations must be symmetric.
                const a = cellDir(id, N), b = cellDir(nb, N);
                if (angle(a, b) < 1.2 * (Math.PI / 2) / N) {
                    expect(sets.get(nb).has(id)).toBe(true);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(6 * N * N * 3);
        expect(dirToCell(cellDir(1234, N), N)).toBe(1234);
    });
});

describe('water graph', () => {
    it('a bowl on land gives a lake', () => {
        const c = norm([0.2, 0.1, 1]);
        const h = heightsFrom(d => continent(d) + bowl(d, c, 120, 0.25));
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: { ...SMALL, minRiverQ: 1e9 } });
        expect(g.lakes.length).toBe(1);
        const lake = g.lakes[0];
        expect(lake.maxDepth).toBeGreaterThan(20);
        expect(lake.downstream.type).toBe('sea');
        expect(g.rivers.length).toBe(0); // outflow below the (huge) threshold
    });

    it('two bowls in one valley chain: lake -> river -> lake -> river -> sea', () => {
        // On the +Z face: a valley along s (= x/z) sloping down to the coast
        // at s = 0.8, with two bowls on its floor (upper at s = -0.3, lower
        // at s = 0.3). The upper lake must spill down the valley into the
        // lower one.
        const valley = (d) => {
            if (d[2] <= 0) return -200;
            const s = d[0] / d[2], t = d[1] / d[2];
            if (s > 0.8 || Math.abs(t) > 0.9) return -200;
            const along = 300 * (0.8 - s) + 10;
            const across = 400 * t * t;
            const bowlAt = (s0) => {
                const r2 = ((s - s0) / 0.18) ** 2 + (t / 0.18) ** 2;
                return r2 < 1 ? -90 * (1 - r2) : 0;
            };
            return along + across + bowlAt(-0.3) + bowlAt(0.3);
        };
        const h = heightsFrom(valley);
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: { ...SMALL, minRiverQ: 1, minLakeCells: 2 } });
        expect(g.lakes.length).toBe(2);
        const upper = g.lakes.reduce((a, b) => (a.level > b.level ? a : b));
        const lower = g.lakes.find(l => l !== upper);
        expect(upper.downstream).toEqual({ type: 'lake', id: lower.id });
        expect(lower.downstream).toEqual({ type: 'sea' });
        expect(g.rivers.length).toBe(2);
        expect(g.rivers[upper.river].to).toEqual({ type: 'lake', id: lower.id });
        expect(g.rivers[lower.river].to).toEqual({ type: 'sea' });
        // The lower lake receives the upper lake's water.
        expect(lower.outflowQ).toBeGreaterThan(upper.outflowQ);
    });

    it('a plain slope gives no lakes and no rivers (rivers start only at lakes)', () => {
        const h = heightsFrom(continent);
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: { ...SMALL, minRiverQ: 1 } });
        expect(g.lakes.length).toBe(0);
        expect(g.rivers.length).toBe(0);
    });

    it('a flat plateau drains without loops', () => {
        const h = heightsFrom(d => (angle(d, [0, 0, 1]) < 1.0 ? 50 : -100));
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: SMALL });
        // Every land cell reaches an ocean cell by following parents.
        for (let id = 0; id < h.length; id++) {
            if (h[id] <= 0) continue;
            let c = id, steps = 0;
            while (g.parent[c] !== -1) { c = g.parent[c]; steps++; expect(steps).toBeLessThan(h.length); }
            expect(h[c]).toBeLessThanOrEqual(0);
        }
    });

    it('rivers never dead-end and every river starts at a lake', () => {
        const centres = [[0.1, 0.1, 1], [0.4, -0.2, 1], [-0.3, 0.35, 1], [0.6, 0.4, 1]].map(norm);
        const h = heightsFrom(d => continent(d) + centres.reduce((s, c, k) => s + bowl(d, c, 60 + 30 * k, 0.15), 0));
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: { ...SMALL, minRiverQ: 1 } });
        expect(g.lakes.length).toBeGreaterThan(0);
        expectNoDeadEnds(g, h);
    });

    it('deep cores in one basin are one lake, with no river between them', () => {
        // Flat plateau (100 m) in the middle of face 4, ocean around it. A
        // shallow basin 5 m deep (body, not core) holds two pits 40 m deep.
        const M = 32;
        const h = gridHeights(M, (face, i, j) => {
            if (face !== 4 || i < 2 || j < 2 || i > M - 3 || j > M - 3) return -100;
            const inBasin = i >= 8 && i <= 23 && j >= 12 && j <= 18;
            const pit = (i >= 10 && i <= 11 && j >= 14 && j <= 15) || (i >= 20 && i <= 21 && j >= 14 && j <= 15);
            return pit ? 60 : inBasin ? 95 : 100;
        });
        const g = buildWaterGraph({ N: M, heights: h, seaLevelM: 0, params: { minLakeDepthM: 8, minLakeCells: 4, minRiverQ: 1 } });
        expect(g.lakes.length).toBe(1);
        const lake = g.lakes[0];
        expect(lake.coreCells).toBe(8);
        expect(lake.cells.length).toBe(16 * 7);
        expect(lake.level).toBe(100);
        expect(lake.maxDepth).toBe(40);
        expect(g.rivers.length).toBe(1);
        expect(g.rivers[0].to).toEqual({ type: 'sea' });
        expectNoDeadEnds(g, h);
    });

    it('a tributary ends on the larger river (confluence); both lakes reach the sea', () => {
        // Face 4 continent sloping down toward i = 2 (the coast), a trench
        // along j = 16 to the sea, the land sloping toward the trench. Two
        // pits on either side drain into the trench, where their rivers meet.
        const M = 32;
        const h = gridHeights(M, (face, i, j) => {
            if (face !== 4 || i < 2 || j < 2 || i > M - 3 || j > M - 3) return -100;
            let z = 10 + 5 * i + 4 * Math.abs(j - 16) - (j === 16 ? 30 : 0);
            if (i >= 22 && i <= 23 && j >= 8 && j <= 9) z -= 60;
            if (i >= 21 && i <= 23 && j >= 23 && j <= 25) z -= 60;
            return z;
        });
        const g = buildWaterGraph({ N: M, heights: h, seaLevelM: 0, params: { minLakeDepthM: 8, minLakeCells: 4, minRiverQ: 1 } });
        expect(g.lakes.length).toBe(2);
        expect(g.rivers.length).toBe(2);
        const [big, small] = [...g.rivers].sort((a, b) => b.q[0] - a.q[0]);
        expect(big.to).toEqual({ type: 'sea' });
        expect(small.to.type).toBe('river');
        expect(small.to.id).toBe(big.id);
        expect(big.cells).toContain(small.to.cell);
        expect(g.stats.confluences).toBe(1);
        for (const lake of g.lakes) expect(lake.downstream).toEqual({ type: 'sea' });
        expectNoDeadEnds(g, h);
    });

    it('lake level is the exact spill elevation (no epsilon drift)', () => {
        const c = norm([0.2, 0.1, 1]);
        const h = heightsFrom(d => continent(d) + bowl(d, c, 120, 0.25));
        const g = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: { ...SMALL, minRiverQ: 1e9 } });
        const lake = g.lakes[0];
        // The exit cell is the sill: its height is the spill level.
        expect(lake.level).toBe(h[lake.exitCell]);
        for (const cell of lake.cells) expect(g.fillExact[cell]).toBe(lake.level);
    });

    it('is deterministic (independent of evaluation order)', () => {
        const c = norm([0.2, -0.1, 1]);
        const h = heightsFrom(d => continent(d) + bowl(d, c, 80, 0.2));
        const a = buildWaterGraph({ N, heights: h, seaLevelM: 0, params: SMALL });
        const b = buildWaterGraph({ N, heights: Float32Array.from(h), seaLevelM: 0, params: SMALL });
        expect(Array.from(b.parent)).toEqual(Array.from(a.parent));
        expect(JSON.stringify(b.lakes)).toBe(JSON.stringify(a.lakes));
    });
});
