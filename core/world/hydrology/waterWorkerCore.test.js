import { describe, expect, it } from 'vitest';
import { cellDir, dirToCell } from './waterGraph.js';
import { dirToPlane, planeToDir, tangentBasis } from './lakeRefine.js';
import { createWaterWorkerCore } from './waterWorkerCore.js';
import { RIVER_SHAPE_DEFAULTS } from './riverRefine.js';

// Synthetic planet (metres): a continent around +Z, ocean elsewhere; a
// valley sloping to the coast with two bowls on its floor (upper at
// s = -0.3, lower at s = 0.3), as in waterGraph.test.js. Evaluated
// analytically, so the fine patches see the same terrain as the grid.
const R = 131072;
function terrain(d) {
    if (d[2] <= 0) return -200;
    const s = d[0] / d[2], t = d[1] / d[2];
    if (s > 0.8 || Math.abs(t) > 0.9) return -200;
    const bowlAt = (s0) => {
        const r2 = ((s - s0) / 0.18) ** 2 + (t / 0.18) ** 2;
        return r2 < 1 ? -90 * (1 - r2) : 0;
    };
    return 300 * (0.8 - s) + 10 + 400 * t * t + bowlAt(-0.3) + bowlAt(0.3);
}
const N = 24;
function buildCore() {
    const heights = new Float32Array(6 * N * N);
    for (let id = 0; id < heights.length; id++) heights[id] = terrain(cellDir(id, N));
    const core = createWaterWorkerCore();
    const built = core.handle({
        type: 'build', N, heights, precip: null, seaLevelM: 0, radius: R, spacing: 400,
        params: { minLakeDepthM: 3, minLakeCells: 2, minRiverQ: 1 },
    }).reply;
    return { core, built };
}
function patchHeights(frame) {
    const h = new Float32Array(frame.nx * frame.ny);
    for (let j = 0; j < frame.ny; j++) {
        for (let i = 0; i < frame.nx; i++) {
            h[j * frame.nx + i] = terrain(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, frame.y0 + (j + 0.5) * frame.spacing, frame, R));
        }
    }
    return h;
}

describe('water worker core', () => {
    it('ends a fine stream in the first lower lake it enters, before its obsolete graph destination', () => {
        const {core}=buildCore(),frame={c:[0,0,1],e1:[1,0,0],e2:[0,1,0],x0:-256,y0:-128,spacing:8,nx:192,ny:32};
        const dir=x=>planeToDir(x,0,frame,R);
        const lake=(lo,hi,level)=>{
            const mask=new Uint8Array(frame.nx*frame.ny);
            for(let j=0;j<frame.ny;j++)for(let i=0;i<frame.nx;i++){
                const x=frame.x0+(i+.5)*8,y=frame.y0+(j+.5)*8;
                if(x>=lo&&x<=hi&&Math.abs(y)<100)mask[j*frame.nx+i]=2;
            }
            return {frame,mask,maskCells:Int32Array.of(dirToCell(dir((lo+hi)/2),N)),deepestDir:dir((lo+hi)/2),
                level,maxDepth:2,exitDir:dir(hi),outflowDirs:[dir(hi+32)]};
        };
        const base=core.handle({type:'addLakes',lakes:[lake(-180,0,500),lake(400,560,495),lake(900,1100,490)],streams:[]}).reply.base;
        // Add another source whose prescribed route crosses the middle lake.
        const added=core.handle({type:'addLakes',lakes:[lake(-180,0,500)],streams:[{
            lake:0,to:{type:'lake',id:base+2},dirs:[dir(-100),dir(1000)],lengthM:1100,
        }],streamCorridorM:128}).reply;
        const riverId=added.rivers[0].id,plan=core.handle({type:'planRiver',riverId,spacing:8,corridorM:128}).reply;
        expect(plan.dest.id).toBe(base+2);
        const heights=new Float32Array(plan.frame.nx*plan.frame.ny);
        for(let j=0;j<plan.frame.ny;j++)for(let i=0;i<plan.frame.nx;i++){
            const d=planeToDir(plan.frame.x0+(i+.5)*8,plan.frame.y0+(j+.5)*8,plan.frame,R);
            const [x,y]=dirToPlane(d,frame,R);
            heights[j*plan.frame.nx+i]=499-.01*Math.max(0,x)+.002*y*y;
        }
        const rec=core.handle({type:'solveRiver',riverId,frame:plan.frame,heights,stepM:8}).reply;
        expect(rec.status).toBe('ok');expect(rec.dest).toEqual({type:'lake',id:base+1});
        expect(rec.destLevel).toBe(495);
        const last=rec.points.subarray(rec.points.length-rec.stride),[endX]=dirToPlane(Array.from(last.subarray(0,3)),frame,R);
        expect(endX).toBeGreaterThanOrEqual(400);expect(endX).toBeLessThan(560);
        expect(last[16]).toBeCloseTo(495,3);
        for(let k=0;k<rec.points.length;k+=rec.stride)expect(rec.points[k+16]).toBeGreaterThanOrEqual(495);
    });
    it('keeps two fine basins in one coarse cell separate when either lake is re-solved', () => {
        const {core}=buildCore(),c=cellDir(4*N*N+12*N+12,N);
        const frame={c,...tangentBasis(c),x0:-100,y0:-100,spacing:4,nx:80,ny:50};
        const heights=new Float32Array(frame.nx*frame.ny),maskA=new Uint8Array(heights.length),maskB=maskA.slice();
        for(let j=0;j<frame.ny;j++)for(let i=0;i<frame.nx;i++){
            const x=frame.x0+(i+.5)*4,y=frame.y0+(j+.5)*4,a=Math.hypot(x,y),b=Math.hypot(x-100,y),k=j*frame.nx+i;
            heights[k]=a<30?.02*a*a:a<40?20:b<20?10+.02*b*b:b<30?30:0;
            if(a<30)maskA[k]=2;if(b<20)maskB[k]=2;
        }
        const seeds=[planeToDir(0,0,frame,R),planeToDir(100,0,frame,R)];
        expect(dirToCell(seeds[0],N)).toBe(dirToCell(seeds[1],N));
        const lake=(mask,k)=>({frame,mask,maskCells:Int32Array.of(dirToCell(seeds[k],N)),deepestDir:seeds[k],
            level:k===0?20:30,maxDepth:20,exitDir:seeds[k],outflowDirs:[]});
        const {base}=core.handle({type:'addLakes',lakes:[lake(maskA,0),lake(maskB,1)],streams:[]}).reply;
        const a=core.handle({type:'solveLake',lakeId:base,frame,heights,bandM:0,skipDownstream:true}).reply;
        expect(a.status).toBe('ok');expect(a.level).toBe(20);expect(a.merged).not.toContain(base+1);
        const b=core.handle({type:'solveLake',lakeId:base+1,frame,heights,bandM:0,skipDownstream:true}).reply;
        expect(b.status).toBe('ok');expect(b.level).toBe(30);expect(b.merged).not.toContain(base);
    });
    it('routes a fine mountain stream to the surviving lake after its destination is merged', () => {
        const {core,built}=buildCore();
        const upper=built.lakes.reduce((a,b)=>a.level>b.level?a:b),lower=built.lakes.find(l=>l!==upper);
        const solve=lake=>core.handle({type:'solveLake',lakeId:lake.id,frame:lake.frame,heights:patchHeights(lake.frame),bandM:6}).reply;
        const u=solve(upper),l=solve(lower);
        const seedDir=lake=>lake.frame.c;
        const added=core.handle({type:'addLakes',lakes:[{...u,deepestDir:seedDir(upper)},{...l,deepestDir:seedDir(lower)}],
            streams:[{lake:0,to:{type:'lake',id:lower.id},dirs:[u.exitDir,l.exitDir],lengthM:1000}],streamCorridorM:1800}).reply;
        const representative=added.base+1;
        core.handle({...l,type:'restoreLake',lakeId:representative,merged:[lower.id],skipDownstream:true});
        const riverId=added.rivers[0].id;
        const plan=core.handle({type:'planRiver',riverId,spacing:128,corridorM:1800}).reply;
        expect(plan.dest).toEqual({type:'lake',id:representative});
        const traced=core.handle({type:'solveRiver',riverId,frame:plan.frame,heights:patchHeights(plan.frame),stepM:20}).reply;
        expect(traced.status).toBe('ok');expect(traced.dest.id).toBe(representative);
    });
    it('clears removed river excavation while keeping overlapping surviving excavation', () => {
        const {core}=buildCore(),frame={c:[0,0,1],e1:[1,0,0],e2:[0,1,0],x0:-128,y0:-128,spacing:16,nx:16,ny:16};
        const points=new Float32Array([0,0,1,50,4,1,0,0,0,0,0,0,.001,0,1,49,4,1,0,0,0,0,0,0]);
        const landscape=cut=>({frame,cells:Uint32Array.from({length:256},(_,i)=>i),cuts:new Float32Array(256).fill(cut)});
        for(const [riverId,cut] of [[0,8],[1,3]])core.handle({type:'restoreRiver',riverId,points,stride:12,landscape:landscape(cut)});
        const opts={texels:4096,page:32};
        const before=core.handle({type:'bakeValley',riverIds:[0,1],opts}).reply;
        const after=core.handle({type:'removeRivers',riverIds:[0],opts}).reply;
        const cuts=r=>new Float32Array(r.texels.buffer).filter((_,i)=>i%4===0);
        expect(Math.max(...cuts(before))).toBeCloseTo(8);
        expect(Math.max(...cuts(after))).toBeCloseTo(3);
        const empty=core.handle({type:'removeRivers',riverIds:[1],opts}).reply;
        expect(empty.pageIds.length).toBeGreaterThan(0);expect(cuts(empty).every(v=>v===0)).toBe(true);
    });
    it('traces from inside source water with a descending surface and varying depth', () => {
        const { core, built } = buildCore();
        const upper = built.lakes.reduce((a, b) => a.level > b.level ? a : b);
        const lakes = new Map();
        for (const lake of built.lakes) lakes.set(lake.id, core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply);
        const plan = core.handle({ type: 'planRiver', riverId: upper.river, spacing: 128, corridorM: 1800 }).reply;
        expect(plan.status).toBe('ok');
        const rec = core.handle({ type: 'solveRiver', riverId: upper.river, frame: plan.frame, heights: patchHeights(plan.frame), stepM: 20 }).reply;
        expect(rec.status).toBe('ok');
        const lake = lakes.get(upper.id), P = rec.points, st = rec.stride;
        const [x, y] = dirToPlane(Array.from(P.slice(0, 3)), lake.frame, R);
        const i = Math.floor((x - lake.frame.x0) / lake.frame.spacing), j = Math.floor((y - lake.frame.y0) / lake.frame.spacing);
        expect(lake.mask[j * lake.frame.nx + i]).toBe(2);
        expect(P[16]).toBeCloseTo(lake.level, 3);
        let bedRises = 0;
        for (let o = st; o < P.length; o += st) {
            expect(P[o + 16]).toBeLessThanOrEqual(P[o - st + 16]);
            expect(P[o + 16] - (P[o + 3] - P[o + 5])).toBeGreaterThan(0);
            if (P[o + 3] - P[o + 5] > P[o - st + 3] - P[o - st + 5]) bedRises++;
        }
        expect(bedRises).toBeGreaterThan(0);
        // Held at the lake's level, with the lake's water on both banks, the
        // river is part of the lake: its water no deeper than the lake within
        // 24 m (no groove along a shallow arm); its channel deepens where
        // the level falls.
        let o = 0, inLake = 0;
        for (; o < P.length && P[o + 3] >= lake.level - 1e-3; o += st) {
            const d = [P[o], P[o + 1], P[o + 2]], next = o + st < P.length ? [P[o + st], P[o + st + 1], P[o + st + 2]] : d;
            const t = next.map((v, i) => v - d[i]), side = [t[1] * d[2] - t[2] * d[1], t[2] * d[0] - t[0] * d[2], t[0] * d[1] - t[1] * d[0]];
            const sl = Math.hypot(...side) || 1, tl = Math.hypot(...t) || 1, hw = P[o + 4];
            const at = (u, v) => terrain(d.map((x, i) => x + (side[i] / sl * u + t[i] / tl * v) / R));
            const banks = [-1, 1].flatMap(sg => [0, 2, 4].map(e => at(sg * (hw + e), 0)));
            if (!banks.every(b => b < lake.level - 0.5)) continue;
            inLake++;
            let deep = 0;
            for (const r of [8, 16, 24]) for (let q = 0; q < 8; q++) deep = Math.max(deep, lake.level - at(r * Math.cos(q * Math.PI / 4), r * Math.sin(q * Math.PI / 4)));
            expect(P[o + 5]).toBeLessThanOrEqual(Math.max(0.02, deep) + 0.1);
        }
        expect(inLake).toBeGreaterThan(0);
        // Leaving the lake it deepens gradually.
        for (let q = st; q <= Math.min(o + 3 * st, P.length - st); q += st) expect(P[q + 5] - P[q - st + 5]).toBeLessThanOrEqual(RIVER_SHAPE_DEFAULTS.outletDeepenM + 1e-4);
        expect(Math.max(...Array.from({ length: (P.length - o) / st }, (_, q) => P[o + q * st + 5]))).toBeGreaterThan(0.5);
    });
    it('builds the graph and solves both lakes; the upper drains into the lower', () => {
        const { core, built } = buildCore();
        expect(built.lakes.length).toBe(2);
        const upper = built.lakes.reduce((a, b) => (a.level > b.level ? a : b));
        const lower = built.lakes.find(l => l !== upper);
        const solved = {};
        for (const lake of [lower, upper]) {
            const r = core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply;
            expect(r.status).toBe('ok');
            // Fine level within the grid's sampling error of the graph level.
            expect(Math.abs(r.level - lake.level)).toBeLessThan(40);
            expect(r.mask.includes(2)).toBe(true);
            expect(r.mask.includes(1)).toBe(true);
            solved[lake.id] = r;
        }
        const last = solved[upper.id];
        expect(last.downstream[upper.id]).toEqual({ type: 'lake', id: lower.id });
        expect(last.downstream[lower.id]).toEqual({ type: 'sea' });
    });

    it('never routes into a lake that is not lower (passes through instead)', () => {
        const { core, built } = buildCore();
        const upper = built.lakes.reduce((a, b) => (a.level > b.level ? a : b));
        const lower = built.lakes.find(l => l !== upper);
        const solved = core.handle({ type: 'solveLake', lakeId: upper.id, frame: upper.frame, heights: patchHeights(upper.frame), bandM: 6 }).reply;
        // Pretend the lower lake's fine level came out above the upper one's.
        const r = core.handle({ type: 'restoreLake', lakeId: lower.id, level: solved.level + 1, exitDir: cellDir(0, N) }).reply;
        expect(r.downstream[upper.id]).toEqual({ type: 'sea' });
    });

    it('restoring a cached solve gives the same routes as solving', () => {
        const a = buildCore(), b = buildCore();
        const lake = a.built.lakes[0];
        const solved = a.core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply;
        const restored = b.core.handle({ type: 'restoreLake', lakeId: lake.id, level: solved.level, exitDir: solved.exitDir, merged: solved.merged }).reply;
        expect(restored.downstream).toEqual(solved.downstream);
    });
});
