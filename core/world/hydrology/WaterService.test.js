import {describe,it,expect,vi} from 'vitest';
import {WaterService} from './WaterService.js';
import {dirToCell} from './waterGraph.js';

function service() {
    const s=Object.create(WaterService.prototype);
    Object.assign(s,{refined:new Map(),mergedInto:new Map(),riverRecs:new Map(),rivers:[],lakes:[],
        _failedRivers:new Set(),version:0,config:{},terrainGenerator:{},
        _client:{call:vi.fn(async()=>({type:'riversRemoved'}))}});
    return s;
}

describe('lake changes invalidate dependent rivers',()=>{
    it('keeps an unrelated river and its tributary when a lake is outside their narrow solve patch',async()=>{
        const s=service();s.radius=131000;
        const basis={c:[0,0,1],e1:[1,0,0],e2:[0,1,0]};
        const riverFrame={...basis,x0:-5000,y0:-500,nx:1000,ny:100,spacing:10};
        const lakeFrame={...basis,x0:-100,y0:3000,nx:20,ny:20,spacing:10};
        const previousIdentity=s._riverLakeIdentity(riverFrame);
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3},dependencyFrame:riverFrame}],
            [11,{src:4,dest:{type:'river',id:10},dependencyFrame:riverFrame}]]);
        await s._apply(5,{level:40,frame:lakeFrame,mask:new Uint8Array([2])});
        expect([...s.riverRecs.keys()]).toEqual([10,11]);
        expect(s._client.call).not.toHaveBeenCalled();
        // Keep existing cache identity rules conservative across restarts.
        expect(s._riverLakeIdentity(riverFrame)).not.toBe(previousIdentity);
    });
    it('still invalidates a river when a refined lake intersects its solve patch',async()=>{
        const s=service();s.radius=131000;
        const basis={c:[0,0,1],e1:[1,0,0],e2:[0,1,0]};
        const riverFrame={...basis,x0:-5000,y0:-500,nx:1000,ny:100,spacing:10};
        const lakeFrame={...basis,x0:-100,y0:-100,nx:20,ny:20,spacing:10};
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3},dependencyFrame:riverFrame}]]);
        await s._apply(5,{level:40,frame:lakeFrame,mask:new Uint8Array([2])});
        expect(s.riverRecs.has(10)).toBe(false);
        expect(s._client.call).toHaveBeenCalledWith({type:'removeRivers',riverIds:[10]});
    });
    it('invalidates a reach when a newly refined intermediate lake enters its solve patch',async()=>{
        const s=service();s.radius=131072;
        const frame={c:[0,0,1],nx:100,ny:40,spacing:16};
        const distant={...frame,c:[1,0,0]};
        s.refined.set(0,{level:50,frame});
        const identity=s._riverLakeIdentity(frame);
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3},dependencyFrame:frame}],
            [11,{src:8,dest:{type:'lake',id:9},dependencyFrame:distant}]]);
        await s._apply(5,{level:40,frame,mask:new Uint8Array([2])});
        expect([...s.riverRecs.keys()]).toEqual([11]);
        expect(s._riverLakeIdentity(frame)).not.toBe(identity);
        const current=s._riverLakeIdentity(frame);
        await s._apply(7,{level:20,frame:distant});
        expect(s._riverLakeIdentity(frame)).toBe(current);
    });
    it('removes incoming, absorbed-source and dependent tributary traces, preserving unrelated rivers',async()=>{
        const s=service();
        s.refined.set(3,{level:551});s.refined.set(6,{level:538});
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3}}],[11,{src:3,dest:{type:'lake',id:6}}],
            [12,{src:2,dest:{type:'river',id:10}}],[13,{src:8,dest:{type:'lake',id:9}}]]);
        s.rivers=[{id:10,fromLake:0,to:{type:'lake',id:3}},{id:11,fromLake:3},{id:14,fromLake:6}];
        s._failedRivers=new Set([10,11,14,99]);
        await s._apply(6,{level:548,merged:[3]});
        expect([...s.riverRecs.keys()]).toEqual([13]);
        expect(s.rep(3)).toBe(6);expect(s.refined.has(3)).toBe(false);
        expect([...s._failedRivers]).toEqual([99]);
        expect(s._client.call).toHaveBeenCalledWith({type:'removeRivers',riverIds:[10,11,12]});
    });
    it('changes cache identity when level, shoreline or representative changes, including after restart',async()=>{
        const s=service(),rec={level:10,frame:{nx:2,ny:2},mask:new Uint8Array([2,0,0,0]),exitDir:[0,0,1]};
        s.refined.set(1,rec);const a=s._lakeIdentity(1);
        const restarted=service();restarted.refined.set(1,structuredClone(rec));
        expect(restarted._lakeIdentity(1)).toBe(a);
        s.refined.set(1,{...rec,level:11});expect(s._lakeIdentity(1)).not.toBe(a);
        s.refined.set(1,{...rec,mask:new Uint8Array([2,2,0,0])});expect(s._lakeIdentity(1)).not.toBe(a);
        s.refined.set(2,rec);s.mergedInto.set(1,2);expect(s._lakeIdentity(1)).not.toBe(a);
    });
});

describe('mountain lake precompute', () => {
    it('re-solves overlapping ponds together and uses the new spillway for their drainage', async () => {
        const s = service(), frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -80, y0: -80, spacing: 20, nx: 8, ny: 8 };
        const pond = level => ({ dir: [1, 0, 0], rec: { level, frame, mask: new Uint8Array(64).fill(2) }, path: [[0, 1, 0]], pathH: [1], pond: true });
        const calls = [], worker = { call: vi.fn(async msg => {
            calls.push(msg.type);
            if (msg.type === 'continueDrain') return { path: [[1, .001, 0]], pathH: [8], pits: [] };
            return { status: 'ok', level: 12, exitDir: [1, 0, 0], frame: msg.frame,
                mask: new Uint8Array(msg.frame.nx * msg.frame.ny).fill(2), maskCells: new Int32Array([0]) };
        }) };
        s.N = 8; s.radius = 131000; s.mountainStats = {};
        s.config = { refine: { maxCells: 4e6, maxGrows: 2, bandM: 6 } };
        s._sampler = { samplePatch: vi.fn(async f => new Float32Array(f.nx * f.ny).fill(10)) };
        const result = await s._resolvePondOverlaps([pond(10), pond(11)], { solveSpacingM: 32 },
            { takeWorker: async () => worker, releaseWorker: vi.fn() });
        expect(result).toHaveLength(1);
        expect(result[0].rec.level).toBe(12);
        expect(result[0].path).toEqual([[1, 0, 0], [1, .001, 0]]);
        expect(result[0].pathH).toEqual([10, 8]);
        expect(calls).toEqual(['solvePatchLake', 'continueDrain']);
        expect(s.mountainStats.unresolvedPondGroups).toBe(0);
    });

    it('keeps distinct basins when a common terrain grid separates originally overlapping ponds', async () => {
        const s = service(), frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -80, y0: -80, spacing: 20, nx: 8, ny: 8 };
        const pond = dir => ({ dir, rec: { level: 10, frame, mask: new Uint8Array(64).fill(2) }, pond: true });
        let calls = 0;
        const worker = { call: vi.fn(async msg => {
            if (msg.type === 'continueDrain') return { path: [], pathH: [], pits: [] };
            const mask = new Uint8Array(64), start = calls++ ? 32 : 0;
            mask.fill(2, start, start + 32);
            return { status: 'ok', level: start ? 9 : 10, exitDir: [1, 0, 0], frame, mask, maskCells: new Int32Array([0]) };
        }) };
        Object.assign(s, { N: 8, radius: 131000, mountainStats: {}, config: { refine: { maxCells: 4e6, maxGrows: 2, bandM: 6 } },
            _sampler: { samplePatch: vi.fn(async f => new Float32Array(f.nx * f.ny).fill(10)) } });
        const result = await s._resolvePondOverlaps([pond([1, 0, 0]), pond([1, .0001, 0])], { solveSpacingM: 20 },
            { takeWorker: async () => worker, releaseWorker: vi.fn() });
        expect(result).toHaveLength(2);
        expect(result.map(p => p.rec.level)).toEqual([10, 9]);
        expect(s.mountainStats.unresolvedPondGroups).toBe(0);
    });

    it('publishes cached lakes before graph refinement finishes, but waits to route streams', async () => {
        const s = service(), record = { dir: [0, 0, 1], rec: {} };
        s.config = { cache: true, refine: { mountain: {}, bandM: 10 } };
        s.N = 8; s.radius = 131000; s._key = 'test'; s._sampler = { seaLevelM: 0 }; s.timings = {};
        s._cache = { get: vi.fn(async () => [record]) };
        s._addLakes = vi.fn();
        s._mountainDrainWalk = vi.fn(() => () => ({}));
        s._joinMountainStreams = vi.fn(() => []);
        s._client.call = vi.fn(async () => ({ rivers: [] }));
        let release;
        const graphReady = new Promise(resolve => { release = resolve; });
        const job = s._mountainLakes({ takeWorker: vi.fn(), releaseWorker: vi.fn(), poolSize: 1, graphReady });
        await vi.waitFor(() => expect(s._addLakes).toHaveBeenCalledOnce());
        expect(s._mountainDrainWalk).not.toHaveBeenCalled();
        expect(s._client.call).not.toHaveBeenCalled();
        release();
        await job;
        expect(s._mountainDrainWalk).toHaveBeenCalledOnce();
        expect(s._client.call).toHaveBeenCalledOnce();
    });

    it('restores absorbed mountain IDs from the precomputed cache', async () => {
        const s = service(), record = { dir: [0, 0, 1], rec: {} }, absorbed = { ...record, rec: {}, aliasOf: 0 },
            absorbedByGraph = { ...record, rec: {}, aliasLakeId: 0 };
        s.config = { cache: true, refine: { mountain: {}, bandM: 10 } };
        s.N = 8; s.radius = 131000; s._key = 'test'; s._sampler = { seaLevelM: 0 }; s.timings = {};
        s._cache = { get: vi.fn(async () => [record, absorbed, absorbedByGraph]) };
        s._addLakes = vi.fn(items => items.forEach(({ rec }, id) => { s.lakes.push({ id, mountain: true }); s.refined.set(id, rec); }));
        s._mountainDrainWalk = vi.fn(() => () => ({}));
        s._joinMountainStreams = vi.fn(() => []);
        s._client.call = vi.fn(async () => ({ rivers: [] }));
        await s._mountainLakes({ takeWorker: vi.fn(), releaseWorker: vi.fn(), poolSize: 1, graphReady: Promise.resolve() });
        expect(s.rep(1)).toBe(0);
        expect(s.rep(2)).toBe(0);
        expect([...s.refined.keys()]).toEqual([0]);
    });

    it('checks graph masks before mountain masks even when mountains arrived first', () => {
        const s = service(), dir = [0, 0, 1], N = 8, cell = dirToCell(dir, N);
        const frame = { c: dir, e1: [1, 0, 0], e2: [0, 1, 0], x0: -1, y0: -1, spacing: 2, nx: 1, ny: 1 };
        const rec = level => ({ level, frame, mask: new Uint8Array([2]), maskCells: new Int32Array([cell]) });
        Object.assign(s, { N, radius: 131000, _sampler: { seaLevelM: 0 }, riverOf: new Int32Array(6 * N * N).fill(-1),
            lakes: [{}, { mountain: true }, { mountain: true }], refined: new Map([[1, rec(40)], [0, rec(30)]]) });
        const walk = s._mountainDrainWalk([{ rec: { level: 50 }, path: [dir], pathH: [50] }], 2, { maxStreamM: 8000 });
        expect(walk(0).stream.to).toEqual({ type: 'lake', id: 0 });
    });

    it('lets a rebuilt outlet find an unpublished pond without publishing overlapping water', () => {
        const s = service(), dir = [0, 0, 1], N = 8, cell = dirToCell(dir, N);
        const frame = { c: dir, e1: [1, 0, 0], e2: [0, 1, 0], x0: -1, y0: -1, spacing: 2, nx: 1, ny: 1 };
        const pond = { rec: { level: 30, frame, mask: new Uint8Array([2]), maskCells: new Int32Array([cell]) } };
        Object.assign(s, { N, radius: 131000, _sampler: { seaLevelM: 0 }, riverOf: new Int32Array(6 * N * N).fill(-1), lakes: [] });
        const source = { rec: { level: 50 }, path: [dir], pathH: [50] };
        const walk = s._mountainDrainWalk([source, pond], 10, { maxStreamM: 8000 }, [pond]);
        expect(walk(0).stream.to).toEqual({ type: 'lake', id: 11 });
        expect(s.refined.size).toBe(0);
    });

    it('continues a merged spillway and checks its new drainage for ponds', async () => {
        const s = service(), dir = [0, 0, 1], end = [0.001, 0, 0.9999995];
        const p = { dir, rec: { level: 50 }, path: [dir], pathH: [50], pits: [], pond: true, mergedPond: true };
        s.radius = 131000; s.mountainStats = {}; s._sampler = { samplePatch: vi.fn(async f => new Float32Array(f.nx * f.ny)) };
        s._mountainDrainWalk = vi.fn(all => k => ({ open: all[k].path.length === 1, end: all[k].path.length }));
        s._mountainPonds = vi.fn(async () => []);
        const worker = { call: vi.fn(async () => ({ path: [end], pathH: [40], pits: [{ entry: 0, exit: 1, depth: 3 }] })) };
        const runBounded = async (items, fn) => { for (const item of items) await fn(item); };
        const result = await s._finishMergedPonds([], [p], 3, { drainRounds: 2, discoverySpacingM: 64, maxStreamM: 8000 },
            { runBounded, takeWorker: async () => worker, releaseWorker: vi.fn() });
        expect(result).toEqual([p]);
        expect(p.path).toEqual([dir, end]);
        expect(p.pits[0].entry).toBe(1);
        expect(s._mountainPonds.mock.calls[0][3].only).toEqual(new Set([0]));
        expect(s.mountainStats.pendingMergedDrains).toBe(0);
    });

    it('preserves mountain IDs and removes absorbed layers when ponds overlap mountains', async () => {
        const s = service(), frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -64, y0: -64, spacing: 16, nx: 8, ny: 8 };
        const make = level => ({ dir: [1, 0, 0], rec: { level, maxDepth: 4, frame, mask: new Uint8Array(64).fill(2),
            maskCells: new Int32Array([1]), exitDir: [1, 0, 0] }, path: [], pathH: [] });
        const solved = [make(10), make(11)], pond = { ...make(12), pond: true };
        Object.assign(s, { radius: 131000, N: 8, mountainStats: {}, lakeCells: new Int32Array([1, 1]),
            lakeCellStart: new Int32Array([0, 1, 2]), lakes: [{ id: 0, mountain: true }, { id: 1, mountain: true }],
            config: { refine: { precompute: true, maxCells: 4e6, maxGrows: 2, bandM: 6 } },
            _sampler: { samplePatch: vi.fn(async f => new Float32Array(f.nx * f.ny).fill(10)) } });
        s.refined = new Map(solved.map((p, i) => [i, p.rec]));
        const worker = { call: vi.fn(async msg => msg.type === 'continueDrain'
            ? { path: [], pathH: [], pits: [] }
            : { status: 'ok', level: 13, maxDepth: 4, exitDir: [1, 0, 0], frame: msg.frame,
                mask: new Uint8Array(msg.frame.nx * msg.frame.ny).fill(2), maskCells: new Int32Array([2, 3]) }) };
        const ponds = await s._mergeMountainPonds(solved, [pond], 0, { solveSpacingM: 32 },
            { takeWorker: async () => worker, releaseWorker: vi.fn() });
        expect(ponds).toEqual([]);
        expect(s.refined.get(0).level).toBe(13);
        expect(s.refined.has(1)).toBe(false);
        expect(s.rep(1)).toBe(0);
        expect(solved[1].aliasOf).toBe(0);
        expect([...s.lakeCells]).toEqual([2, 3]);
        expect([...s.lakeCellStart]).toEqual([0, 2, 2]);
    });

    it('absorbs a lower mountain lake inside graph water but keeps a partially overlapping one', () => {
        const s = service(), frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -64, y0: -64, spacing: 16, nx: 8, ny: 8 };
        const graph = { level: 20, frame, mask: new Uint8Array(64).fill(2), maskCells: new Int32Array([1]) };
        const mountain = { dir: [1, 0, 0], rec: { level: 10, frame, mask: new Uint8Array(64).fill(2), maskCells: new Int32Array([1]) } };
        Object.assign(s, { radius: 131000, mountainStats: {}, lakeCells: new Int32Array([1, 1]),
            lakeCellStart: new Int32Array([0, 1, 2]), lakes: [{ id: 0 }, { id: 1, mountain: true }], refined: new Map([[0, graph], [1, mountain.rec]]) });
        let solved = [structuredClone(mountain)];
        s._absorbGraphSubmergedMountains(solved, 1);
        expect(solved[0].aliasLakeId).toBe(0);
        expect(s.rep(1)).toBe(0);
        expect([...s.lakeCellStart]).toEqual([0, 1, 1]);
        const partial = structuredClone(mountain); graph.mask.fill(0, 0, 32);
        s.refined.set(1, partial.rec); s.mergedInto.clear(); solved = [partial];
        s._absorbGraphSubmergedMountains(solved, 1);
        expect(solved[0].aliasLakeId).toBeUndefined();
        expect(s.refined.has(1)).toBe(true);
    });
});
