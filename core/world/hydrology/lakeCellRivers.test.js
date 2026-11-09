import { describe, it, expect } from 'vitest';
import { LakeCellRivers } from './lakeCellRivers.js';
import { tangentBasis, dirToPlane } from './lakeRefine.js';

// Synthetic terrain in the tangent plane at [-1, 0, 0] (metres), lakes as
// discs with a bowl, served by a fake lake table (no GPU).
const R = 131072, c0 = [-1, 0, 0], frame = { c: c0, ...tangentBasis(c0) };

function world({ ground, lakes }) {
    const at = d => { const [x, y] = dirToPlane(d, frame, R); return [x, y]; };
    const height = (x, y) => {
        let h = ground(x, y);
        for (const l of lakes) {
            const r = Math.hypot(x - l.x, y - l.y);
            if (r < l.r) h = Math.min(h, l.level - l.depth * (1 - (r / l.r) ** 2));
        }
        return h;
    };
    const table = {
        ensure() { return true; },
        async sampleWater(dirs) {
            const n = dirs.length / 4, out = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
                const [x, y] = at([dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]]);
                out[i * 3] = height(x, y);
                const l = lakes.find(l => Math.hypot(x - l.x, y - l.y) < l.r + 150);
                out[i * 3 + 1] = l ? l.level : -1e9;
                out[i * 3 + 2] = l ? 2 : -1;
            }
            return out;
        },
        async sampleHeights(dirs) {
            const n = dirs.length / 4, out = new Float32Array(n);
            for (let i = 0; i < n; i++) { const [x, y] = at([dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]]); out[i] = height(x, y); }
            return out;
        },
    };
    // The uniforms' sea level (waterParams.y = 0) and height scale.
    const scratch = new ArrayBuffer(256);
    new DataView(scratch).setFloat32(184, 1000, true);
    const gen = { lakeTable: table, planetConfig: { radius: R }, terrainConfig: {}, _terrainUniformScratch: scratch, _fillTerrainUniformScratch() {} };
    const lakeRecs = lakes.map((l, i) => {
        // Direction of plane point (x, y): c + (x e1 + y e2) / R, normalized.
        const v = c0.map((c, k) => c + (l.x * frame.e1[k] + l.y * frame.e2[k]) / R), n = Math.hypot(...v);
        const dir = v.map(x => x / n), { e1, e2 } = tangentBasis(dir);
        return { key: `lake${i}`, tier: 2, centre: dir, level: l.level, uC: 150, a1: e1, a2: e2,
            shape: { n: 1, extent: l.r, minAxis: l.r, ks: 0.1 * l.r, stretch: 1.05, rot: [0, 0, 0, 0, 0, 0],
                comp: [[0, 0, l.r, l.r], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] } };
    });
    return { gen, lakeRecs };
}

describe('lake-cell rivers', () => {
    it('drain a lake on a slope downhill to the sea, out of the low side of its rim', async () => {
        // Land falls 1 % toward +x and meets the sea (0 m) at x = 15 km.
        const { gen, lakeRecs } = world({ ground: (x) => 150 - 0.01 * x, lakes: [{ x: 0, y: 0, r: 500, level: 140, depth: 8 }] });
        const rivers = new LakeCellRivers({ device: null, gen, table: gen.lakeTable, options: { lengthPerSqrtQ: 1e6 } });
        await rivers.plan(lakeRecs, 6, lakeRecs[0].centre);
        const v = rivers.byKey.get('lake0');
        expect(rivers.stats.lastError).toBe(null);
        expect(v.dest.kind).toBe('sea');
        const P = v.river.points, st = v.river.stride, first = dirToPlane([P[0], P[1], P[2]], frame, R);
        const last = dirToPlane([P[P.length - st], P[P.length - st + 1], P[P.length - st + 2]], frame, R);
        expect(first[0]).toBeGreaterThan(200);          // leaves on the downhill side
        expect(last[0]).toBeGreaterThan(14000);         // reaches the sea
        // Its water level never rises downstream.
        for (let k = st; k < P.length; k += st) expect(P[k + 3]).toBeLessThanOrEqual(P[k - st + 3] + 1e-3);
    });

    it('reach no farther than the lake size allows: a small lake drains to a lake nearby, not to the far sea', async () => {
        // Land falling 1 % toward +x, the sea at x = 15 km; a 500 m lake drains at most 1.75 km.
        const ground = (x) => 150 - 0.01 * x;
        const far = world({ ground, lakes: [{ x: 0, y: 0, r: 500, level: 140, depth: 8 }] });
        const a = new LakeCellRivers({ device: null, gen: far.gen, table: far.gen.lakeTable });
        await a.plan(far.lakeRecs, 6, far.lakeRecs[0].centre);
        expect(a.byKey.get('lake0').none).toBe('enclosed');
        const near = world({ ground, lakes: [{ x: 0, y: 0, r: 500, level: 140, depth: 8 }, { x: 1800, y: 0, r: 700, level: 124, depth: 6 }] });
        const b = new LakeCellRivers({ device: null, gen: near.gen, table: near.gen.lakeTable });
        await b.plan(near.lakeRecs, 6, near.lakeRecs[0].centre);
        expect(b.byKey.get('lake0').dest).toMatchObject({ kind: 'lake', key: 'lake1' });
        expect(b.byKey.get('lake0').river.lengthM).toBeLessThan(3000);
    });

    it('end no river in a lake too small for it that cannot drain, and narrow the rivers of small lakes', async () => {
        // A 500 m lake drains to a 300 m lake 1.5 km down a 1 % slope; the sea is 15 km off.
        const ground = (x) => 150 - 0.01 * x;
        const w = world({ ground, lakes: [{ x: 0, y: 0, r: 500, level: 140, depth: 8 }, { x: 1500, y: 0, r: 300, level: 127, depth: 5 }] });
        const r = new LakeCellRivers({ device: null, gen: w.gen, table: w.gen.lakeTable });
        await r.plan(w.lakeRecs, 6, w.lakeRecs[0].centre);
        // The small lake cannot reach the sea with what flows into it: the river into it goes.
        expect(r.byKey.get('lake1').none).toBeTruthy();
        expect(r.byKey.get('lake0').none).toBe('smallSink');
        expect(r.recordsFor(new Map([['lake0', 0], ['lake1', 1]]))).toEqual([]);
        // Width by discharge, the same for every lake from medium size up.
        expect(r._halfWidth(r._ownQ({ shape: { extent: 300 } }))).toBeLessThan(4);
        expect(r._halfWidth(r._ownQ({ shape: { extent: 1500 } }))).toBe(r._halfWidth(r._ownQ({ shape: { extent: 6000 } })));
    });

    it('leave a lake in a bowl walled higher than the cut budget without a river', async () => {
        const { gen, lakeRecs } = world({ ground: (x, y) => 140 + Math.min(60, Math.max(0, Math.hypot(x, y) - 400) * 0.2),
            lakes: [{ x: 0, y: 0, r: 450, level: 141, depth: 6 }] });
        const rivers = new LakeCellRivers({ device: null, gen, table: gen.lakeTable, options: { maxVisited: 20000 } });
        await rivers.plan(lakeRecs, 6, lakeRecs[0].centre);
        expect(rivers.byKey.get('lake0').none).toBe('enclosed');
    });

    it('join a later river to an earlier one in the same valley', async () => {
        // A valley along y = 0 falling toward +x, the sea at x = 20 km.
        const ground = (x, y) => 200 - 0.01 * x + 0.02 * Math.abs(y);
        const { gen, lakeRecs } = world({ ground, lakes: [{ x: 0, y: 0, r: 500, level: 190, depth: 8 }, { x: 4000, y: 2500, r: 400, level: 200, depth: 6 }] });
        const rivers = new LakeCellRivers({ device: null, gen, table: gen.lakeTable, options: { lengthPerSqrtQ: 1e6 } });
        await rivers.plan([lakeRecs[0]], 6, lakeRecs[0].centre);
        await rivers.plan(lakeRecs, 6, lakeRecs[0].centre);
        expect(rivers.byKey.get('lake0').dest.kind).toBe('sea');
        expect(rivers.byKey.get('lake1').dest).toEqual({ kind: 'river', key: 'lake0' });
        const recs = rivers.recordsFor(new Map([['lake0', 0], ['lake1', 1]]));
        expect(recs.find(r => r.fromLake === 1).dest).toEqual({ kind: 'river', id: recs.find(r => r.fromLake === 0).id });
        // The same objects while nothing changed (WaterGpuData applies a record once).
        expect(rivers.recordsFor(new Map([['lake0', 0], ['lake1', 1]]))).toEqual(recs);
        expect(rivers.recordsFor(new Map([['lake0', 0], ['lake1', 1]]))[0]).toBe(recs[0]);
    });
});
