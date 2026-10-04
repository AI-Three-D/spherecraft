// core/world/hydrology/waterWorkerCore.js
//
// The water system's CPU side: holds the water graph, solves lakes on fine
// patches, merges basins that turn out to be one lake, and routes each lake
// downstream. Pure logic; waterWorker.js runs it in a module worker, and the
// Node lab (or a browser without workers) calls it in-process.
//
// Messages (handle(msg) -> { reply, transfer }):
//   { type: 'build', N, heights, precip, seaLevelM, radius, params, spacing }
//     -> { type: 'built', lakes, rivers, stats, lakeOf, riverOf }
//   { type: 'solveLake', lakeId, frame, heights, bandM }
//     -> { type: 'solved', lakeId, status, ... }  status: 'ok' | 'grow' | 'dry' | 'noSeed' | 'merged'
//   { type: 'restoreLake', lakeId, level, exitDir, merged }   (a cached solve)
//     -> { type: 'restored', lakeId, downstream }
//
// Levels and routing: a refined lake has its fine level; others keep the
// graph's. Downstream routing starts at the lake's exit (the fine sill once
// refined) and follows the graph's drainage tree; it may only end in a lake
// whose level is strictly lower (water runs downhill), otherwise it passes
// through. Levels fall strictly along every route, so there are no cycles
// (lab 2026-10-04: routing from fine exits without this rule made 11
// two-lake cycles).

import { buildWaterGraph, cellDir, dirToCell } from './waterGraph.js';
import { dirToPlane, lakeMask, lakePatchFrame, lakeSeed, planeToDir, solveLakePatch } from './lakeRefine.js';

export function createWaterWorkerCore() {
    let g = null;
    let N = 0, R = 0, seaLevelM = 0;
    let heights = null;
    const refined = new Map();   // lakeId -> { level, exitDir }
    const mergedInto = new Map(); // lakeId -> lakeId it is part of

    const rep = (id) => { while (mergedInto.has(id)) id = mergedInto.get(id); return id; };
    const levelOf = (id) => refined.get(id)?.level ?? g.lakes[id].level;
    const isOcean = (c) => heights[c] <= seaLevelM && g.parent[c] === -1;

    function downstreamOf(id) {
        const self = rep(id);
        const r = refined.get(self);
        let c = r ? dirToCell(r.exitDir, N) : g.lakes[self].exitCell;
        const L = levelOf(self);
        for (let guard = 0; c !== -1 && guard < heights.length; guard++) {
            if (isOcean(c)) return { type: 'sea' };
            const x = g.lakeOf[c];
            if (x !== -1) {
                const xr = rep(x);
                if (xr !== self && levelOf(xr) < L) return { type: 'lake', id: xr };
            }
            c = g.parent[c];
        }
        return { type: 'sea' };
    }

    function build(msg) {
        N = msg.N; R = msg.radius; seaLevelM = msg.seaLevelM; heights = msg.heights;
        refined.clear(); mergedInto.clear();
        g = buildWaterGraph({ N, heights, seaLevelM, precip: msg.precip, params: msg.params ?? {} });
        const lakes = g.lakes.map((l) => ({
            id: l.id, level: l.level, maxDepth: l.maxDepth, coreCells: l.coreCells, cellCount: l.cells.length,
            outflowQ: l.outflowQ, river: l.river, downstream: l.downstream,
            centreDir: cellDir(l.deepestCell, N),
            frame: lakePatchFrame(l, N, { R, spacing: msg.spacing ?? 16 }),
        }));
        const rivers = g.rivers.map((r) => ({ id: r.id, fromLake: r.fromLake, to: r.to, cells: Int32Array.from(r.cells) }));
        const lakeOf = g.lakeOf.slice(), riverOf = g.riverOf.slice();
        // Every lake's grid cells, concatenated: lake k owns
        // lakeCells[lakeCellStart[k] .. lakeCellStart[k + 1]).
        const lakeCellStart = new Int32Array(g.lakes.length + 1);
        for (let k = 0; k < g.lakes.length; k++) lakeCellStart[k + 1] = lakeCellStart[k] + g.lakes[k].cells.length;
        const lakeCells = new Int32Array(lakeCellStart[g.lakes.length]);
        for (let k = 0; k < g.lakes.length; k++) lakeCells.set(g.lakes[k].cells, lakeCellStart[k]);
        return {
            reply: { type: 'built', N, lakes, rivers, stats: g.stats, lakeOf, riverOf, lakeCells, lakeCellStart },
            transfer: [lakeOf.buffer, riverOf.buffer, lakeCells.buffer, lakeCellStart.buffer, ...rivers.map(r => r.cells.buffer)],
        };
    }

    function solveLake(msg) {
        const { lakeId, frame, bandM } = msg;
        if (mergedInto.has(lakeId)) return { reply: { type: 'solved', lakeId, status: 'merged', into: rep(lakeId) } };
        const lake = g.lakes[lakeId];
        const h = msg.heights;
        const seed = lakeSeed(h, frame, lake, g.lakeOf, N, R);
        if (seed < 0) return { reply: { type: 'solved', lakeId, status: 'noSeed' } };
        const s = solveLakePatch({ heights: h, nx: frame.nx, ny: frame.ny, seed });
        if (!s) return { reply: { type: 'solved', lakeId, status: 'dry' } };
        if (s.touchesBorder) return { reply: { type: 'solved', lakeId, status: 'grow' } };

        const cx = (k) => frame.x0 + ((k % frame.nx) + 0.5) * frame.spacing;
        const cy = (k) => frame.y0 + (Math.floor(k / frame.nx) + 0.5) * frame.spacing;
        const exitDir = planeToDir(cx(s.exit), cy(s.exit), frame, R);
        refined.set(lakeId, { level: s.level, exitDir });

        // Other lakes whose deepest point lies in this lake are part of it.
        const merged = [];
        for (const other of g.lakes) {
            if (other.id === lakeId || rep(other.id) === lakeId) continue;
            const d = cellDir(other.deepestCell, N);
            if (d[0] * frame.c[0] + d[1] * frame.c[1] + d[2] * frame.c[2] < 0.5) continue;
            const [x, y] = dirToPlane(d, frame, R);
            const i = Math.floor((x - frame.x0) / frame.spacing), j = Math.floor((y - frame.y0) / frame.spacing);
            if (i < 0 || j < 0 || i >= frame.nx || j >= frame.ny || !s.region[j * frame.nx + i]) continue;
            const r = rep(other.id);
            if (r === lakeId) continue;
            mergedInto.set(r, lakeId);
            refined.delete(r);
            merged.push(r);
        }

        const mask = lakeMask(h, frame.nx, frame.ny, s.region, s.level, bandM);
        // Grid cells under the mask: the GPU lake index points them here.
        const cellSet = new Set();
        for (let k = 0; k < mask.length; k++) {
            if (mask[k]) cellSet.add(dirToCell(planeToDir(cx(k), cy(k), frame, R), N));
        }
        const maskCells = Int32Array.from([...cellSet].sort((a, b) => a - b));
        const downstream = allDownstream();
        return {
            reply: {
                type: 'solved', lakeId, status: 'ok', frame,
                level: s.level, maxDepth: s.maxDepth, cells: s.cells, areaM2: s.cells * frame.spacing * frame.spacing,
                exitDir, mask, maskCells, merged, downstream,
            },
            transfer: [mask.buffer, maskCells.buffer],
        };
    }

    // Every refined lake's route (routes change whenever a level changes).
    function allDownstream() {
        const downstream = {};
        for (const id of refined.keys()) downstream[id] = downstreamOf(id);
        return downstream;
    }

    function restoreLake(msg) {
        const { lakeId, level, exitDir, merged = [] } = msg;
        refined.set(lakeId, { level, exitDir });
        for (const m of merged) {
            const r = rep(m);
            if (r === lakeId) continue;
            mergedInto.set(r, lakeId);
            refined.delete(r);
        }
        return { reply: { type: 'restored', lakeId, downstream: allDownstream() } };
    }

    return {
        handle(msg) {
            if (msg.type === 'build') return build(msg);
            if (msg.type === 'solveLake') return solveLake(msg);
            if (msg.type === 'restoreLake') return restoreLake(msg);
            throw new Error(`waterWorkerCore: unknown message ${msg.type}`);
        },
    };
}
