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
//   { type: 'planRiver', riverId, spacing, corridorM }
//     -> { type: 'riverPlan', riverId, status, frame, dest }   (route + corridor frame)
//   { type: 'restoreRiver', riverId, points, stride }   (a cached trace, for the valleys)
//   { type: 'bakeValley', riverIds, opts }
//     -> { type: 'valleyBaked', pageIds, texels }   (riverValley.js)
//   { type: 'solveRiver', riverId, frame, heights, shape, levels, reachM, sub }
//     -> { type: 'riverSolved', riverId, status, points, stride, segCellStart, segCells, ... }
//     points, stride 20 (riverRefine.js RIVER_POINT_STRIDE): dir.xyz, water
//     level, half-width, water depth at the thalweg (level - thalweg), speed,
//     discharge (m^3/s), spill level of the trace (uncarved terrain), pool
//     (-1 = the point lies in a lake, else 0), thalweg skew toward the outer
//     bank (-0.35..0.35, + = left of the flow), foam hint (0..1); the bend's
//     curvature, the ground the level fit saw beside the channel, lake rims
//     left and right (riverLakeRims);
//     solved surface level, depth, nearby lake level, island.
//     segCells: per segment, the sub-cells it reaches (waterGraph.js dirToCellSub).
//     The sub-cell size (msg.sub, default 4 per cell side) must match the
//     GPU lists' (waterWgsl.js RIVER_SUB).
//
// Levels and routing: a refined lake has its fine level; others keep the
// graph's. Downstream routing starts at the lake's exit (the fine sill once
// refined) and follows the graph's drainage tree; it may only end in a lake
// whose level is strictly lower (water runs downhill), otherwise it passes
// through. Levels fall strictly along every route, so there are no cycles
// (lab 2026-10-04: routing from fine exits without this rule made 11
// two-lake cycles).

import { buildWaterGraph, cellDir, dirToCell, dirToCellSub } from './waterGraph.js';
import { bakeValleyPages, RIVER_VALLEY_DEFAULTS, valleyRiverFromRecord, valleyRiverIncisionPages } from '../water/riverValley.js';
import { dirToPlane, lakeMask, lakePatchFrame, lakeSeed, planeToDir, polylinePatchFrame, solveLakePatch } from './lakeRefine.js';
import { bakeRiverWaterfalls } from './riverFeatures.js';
import { bakeRiverIncision } from './riverLandscape.js';
import { continueDrain, findPockets } from './mountainLakes.js';
import { lakeMaskSdf, lakeSdfAt } from '../water/lakeMaskSdf.js';
import { corridorMask, RIVER_LEVEL_DEFAULTS, RIVER_POINT_STRIDE, RIVER_SHAPE_DEFAULTS, riverCrestAbove, riverLakeHold, riverLakeRims, riverReachShape, riverShape, riverValleyLevels, segmentCells, smoothRiverPath, traceRiverPatch, trunkLevelAt } from './riverRefine.js';

// C2 ramp 0..1 (quintic smoothstep of a clamped value).
const ramp5 = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * One lake on its patch without the graph (precompute pool workers): seed
 * among the lake's graph cells (msg.lakeCells), solve, render mask cropped
 * to the water, the grid cells under it, and the merge candidates: other
 * lakes (msg.others: id, x, y, z of their deepest cell, by id) whose deepest
 * point lies in the water. Same results as solveLake's for one lake.
 */
export function solvePatchLake(msg) {
    const { lakeId, frame, bandM, N, R } = msg, h = msg.heights;
    let seed = -1;
    if (msg.seedDir) {
        // A pocket found at another resolution (mountainLakes.js): the
        // lowest cell within ~100 m of its deepest point.
        const [x, y] = dirToPlane(msg.seedDir, frame, R);
        const ci = Math.floor((x - frame.x0) / frame.spacing), cj = Math.floor((y - frame.y0) / frame.spacing);
        const r = Math.max(1, Math.round(100 / frame.spacing));
        for (let j = Math.max(0, cj - r); j <= Math.min(frame.ny - 1, cj + r); j++) {
            for (let i = Math.max(0, ci - r); i <= Math.min(frame.nx - 1, ci + r); i++) {
                const id = j * frame.nx + i;
                if (seed === -1 || h[id] < h[seed]) seed = id;
            }
        }
    } else {
        const own = new Set(msg.lakeCells);
        for (let j = 0; j < frame.ny; j++) {
            const y = frame.y0 + (j + 0.5) * frame.spacing;
            for (let i = 0; i < frame.nx; i++) {
                const id = j * frame.nx + i;
                if (seed !== -1 && h[id] >= h[seed]) continue;
                if (own.has(dirToCell(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, y, frame, R), N))) seed = id;
            }
        }
    }
    if (seed < 0) return { reply: { type: 'patchSolved', lakeId, status: 'noSeed' } };
    const s = solveLakePatch({ heights: h, nx: frame.nx, ny: frame.ny, seed });
    if (!s) return { reply: { type: 'patchSolved', lakeId, status: 'dry' } };
    if (s.touchesBorder) return { reply: { type: 'patchSolved', lakeId, status: 'grow' } };
    const cx = (k) => frame.x0 + ((k % frame.nx) + 0.5) * frame.spacing;
    const cy = (k) => frame.y0 + (Math.floor(k / frame.nx) + 0.5) * frame.spacing;
    const exitDir = planeToDir(cx(s.exit), cy(s.exit), frame, R);
    const step = Math.max(1, Math.round(100 / frame.spacing));
    const outflowDirs = [];
    for (let k = 0; k < s.outflow.length; k += step) outflowDirs.push(planeToDir(cx(s.outflow[k]), cy(s.outflow[k]), frame, R));
    const lastOut = s.outflow[s.outflow.length - 1];
    outflowDirs.push(planeToDir(cx(lastOut), cy(lastOut), frame, R));
    const candidates = [];
    const O = msg.others;
    for (let o = 0; o < O.length; o += 4) {
        const d = [O[o + 1], O[o + 2], O[o + 3]];
        if (O[o] === lakeId || d[0] * frame.c[0] + d[1] * frame.c[1] + d[2] * frame.c[2] < 0.5) continue;
        const [x, y] = dirToPlane(d, frame, R);
        const i = Math.floor((x - frame.x0) / frame.spacing), j = Math.floor((y - frame.y0) / frame.spacing);
        if (i >= 0 && j >= 0 && i < frame.nx && j < frame.ny && s.region[j * frame.nx + i]) candidates.push(O[o]);
    }
    const full = lakeMask(h, frame.nx, frame.ny, s.region, s.level, bandM);
    const cellSet = new Set();
    let i0 = frame.nx, i1 = -1, j0 = frame.ny, j1 = -1;
    for (let k = 0; k < full.length; k++) {
        if (!full[k]) continue;
        cellSet.add(dirToCell(planeToDir(cx(k), cy(k), frame, R), N));
        const i = k % frame.nx, j = (k - i) / frame.nx;
        if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
    }
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1); i1 = Math.min(frame.nx - 1, i1 + 1); j1 = Math.min(frame.ny - 1, j1 + 1);
    const nx = i1 - i0 + 1, ny = j1 - j0 + 1, mask = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) mask.set(full.subarray((j0 + j) * frame.nx + i0, (j0 + j) * frame.nx + i0 + nx), j * nx);
    const maskCells = Int32Array.from([...cellSet].sort((a, b) => a - b));
    return {
        reply: {
            type: 'patchSolved', lakeId, status: 'ok', patchFrame: frame,
            frame: { ...frame, x0: frame.x0 + i0 * frame.spacing, y0: frame.y0 + j0 * frame.spacing, nx, ny },
            level: s.level, maxDepth: s.maxDepth, cells: s.cells, areaM2: s.cells * frame.spacing * frame.spacing,
            exitDir, outflowDirs, mask, maskCells, candidates,
        },
        transfer: [mask.buffer, maskCells.buffer],
    };
}

// Signed distance to a solved lake's water, as its mask is drawn
// (lakeMaskSdf.js, WaterGpuData.js), per record.
const regionSdf = new WeakMap();
function lakeRegionSdf(rr) {
    let F = regionSdf.get(rr);
    if (!F) {
        const m = new Uint8Array(rr.region.length);
        for (let c = 0; c < m.length; c++) if (rr.region[c] === 1) m[c] = 2;
        regionSdf.set(rr, F = lakeMaskSdf(m, rr.frame.nx, rr.frame.ny, rr.frame.spacing));
    }
    return F;
}

export function createWaterWorkerCore() {
    let g = null;
    let N = 0, R = 0, seaLevelM = 0;
    let heights = null;
    const refined = new Map();   // lakeId -> { level, exitDir, frame, region }
    const valleyRivers = new Map();   // riverId -> valley line (riverValley.js valleyRiverFromRecord)
    const mergedInto = new Map(); // lakeId -> lakeId it is part of

    const rep = (id) => { while (mergedInto.has(id)) id = mergedInto.get(id); return id; };
    const levelOf = (id) => refined.get(id)?.level ?? g.lakes[id].level;
    const isOcean = (c) => heights[c] <= seaLevelM && g.parent[c] === -1;

    // Route of a lake's outflow to the first strictly lower lake or the sea.
    // A refined lake's route first follows its fine outflow out of the sill
    // (the graph's drainage can point across the lake to another side),
    // then the graph's drainage. Returns the destination, the graph cells on
    // the way (destination's cell last) and how many leading cells came
    // from the fine outflow.
    // join: the route also ends where it reaches another river's graph path
    // (a confluence: that river carries the water on; lab 2026-10-05: routes
    // passing through a lake that is not lower followed that lake's own
    // river, and the two were traced side by side down one valley).
    function routeFrom(id, { join = false, ownRiver = -1 } = {}) {
        const self = rep(id);
        const r = refined.get(self);
        const L = levelOf(self);
        const cells = [];
        const visit = (c) => {
            if (cells[cells.length - 1] !== c) cells.push(c);
            if (isOcean(c)) return { type: 'sea' };
            const x = g.lakeOf[c];
            if (x !== -1) {
                const xr = rep(x);
                if (xr !== self && levelOf(xr) < L) return { type: 'lake', id: xr };
            }
            if (join && x === -1) {
                const rv = g.riverOf[c];
                if (rv !== -1 && rv !== ownRiver && rep(g.rivers[rv].fromLake) !== self) return { type: 'river', id: rv, cell: c };
            }
            return null;
        };
        let outflowCells = 0;
        if (r?.outflowDirs) {
            for (const d of r.outflowDirs) {
                const dest = visit(dirToCell(d, N));
                outflowCells = cells.length;
                if (dest) return { dest, cells, outflowCells };
            }
        }
        let c = r?.outflowDirs ? g.parent[cells[cells.length - 1]] : (r ? dirToCell(r.exitDir, N) : g.lakes[self].exitCell);
        for (let guard = 0; c !== -1 && guard < heights.length; guard++) {
            const dest = visit(c);
            if (dest) return { dest, cells, outflowCells };
            c = g.parent[c];
        }
        return { dest: { type: 'sea' }, cells, outflowCells };
    }
    const downstreamOf = (id) => routeFrom(id).dest;

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
        // Outflow path out of the sill (every ~100 m): routes and rivers start along it.
        const step = Math.max(1, Math.round(100 / frame.spacing));
        const outflowDirs = [];
        for (let k = 0; k < s.outflow.length; k += step) outflowDirs.push(planeToDir(cx(s.outflow[k]), cy(s.outflow[k]), frame, R));
        const lastOut = s.outflow[s.outflow.length - 1];
        outflowDirs.push(planeToDir(cx(lastOut), cy(lastOut), frame, R));
        // The region is kept: rivers into this lake end inside its water.
        refined.set(lakeId, { level: s.level, exitDir, outflowDirs, frame, region: s.region });

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

        let mask = lakeMask(h, frame.nx, frame.ny, s.region, s.level, bandM);
        // Grid cells under the mask: the GPU lake index points them here.
        const cellSet = new Set();
        let i0 = frame.nx, i1 = -1, j0 = frame.ny, j1 = -1;
        for (let k = 0; k < mask.length; k++) {
            if (!mask[k]) continue;
            cellSet.add(dirToCell(planeToDir(cx(k), cy(k), frame, R), N));
            const i = k % frame.nx, j = (k - i) / frame.nx;
            if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
        }
        const maskCells = Int32Array.from([...cellSet].sort((a, b) => a - b));
        // msg.crop: the mask and its frame shrink to the water and shore band
        // (plus a dry cell); the solved patch stays in patchFrame. Same
        // tangent plane, so (frame, mask) pairs index alike.
        let maskFrame = frame;
        if (msg.crop && i1 >= 0) {
            i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1); i1 = Math.min(frame.nx - 1, i1 + 1); j1 = Math.min(frame.ny - 1, j1 + 1);
            const nx = i1 - i0 + 1, ny = j1 - j0 + 1, cropped = new Uint8Array(nx * ny);
            for (let j = 0; j < ny; j++) cropped.set(mask.subarray((j0 + j) * frame.nx + i0, (j0 + j) * frame.nx + i0 + nx), j * nx);
            maskFrame = { ...frame, x0: frame.x0 + i0 * frame.spacing, y0: frame.y0 + j0 * frame.spacing, nx, ny };
            mask = cropped;
        }
        // skipDownstream: a precompute asks for every route once at the end
        // (each solve here would recompute all refined lakes' routes again).
        const downstream = msg.skipDownstream ? null : allDownstream();
        return {
            reply: {
                type: 'solved', lakeId, status: 'ok', frame: maskFrame, ...(msg.crop ? { patchFrame: frame } : {}),
                level: s.level, maxDepth: s.maxDepth, cells: s.cells, areaM2: s.cells * frame.spacing * frame.spacing,
                exitDir, outflowDirs, mask, maskCells, merged, downstream,
            },
            transfer: [mask.buffer, maskCells.buffer],
        };
    }

    // Precompute pool (WaterService refine.precompute): the graph worker
    // adopts results solved elsewhere (solvePatchLake), in dispatch order,
    // merging as solveLake does. msg.candidates: other lakes whose deepest
    // point lies in this lake's water, by id.
    function adoptLake(msg) {
        const { lakeId, level, exitDir, outflowDirs, frame, mask, candidates } = msg;
        if (mergedInto.has(lakeId)) return { reply: { type: 'adopted', lakeId, status: 'merged', into: rep(lakeId) } };
        refined.set(lakeId, { level, exitDir, outflowDirs, frame, region: Uint8Array.from(mask, v => (v === 2 ? 1 : 0)) });
        const merged = [];
        for (const other of candidates) {
            if (other === lakeId || rep(other) === lakeId) continue;
            const r = rep(other);
            mergedInto.set(r, lakeId);
            refined.delete(r);
            merged.push(r);
        }
        return { reply: { type: 'adopted', lakeId, status: 'ok', merged } };
    }

    // Lakes the graph does not hold (mountainLakes.js), already solved:
    // appended to the graph with ids from g.lakes.length, their grid cells
    // marked where no graph lake holds them. Then a river each whose route
    // reaches strictly lower water (lake, sea or a graph river) within
    // maxRouteM; routes come after all are known, as a stream may end in
    // another new lake. Reply: the new rivers ({ id, fromLake, to, cells }).
    function addLakes(msg) {
        const ids = [];
        for (const L of msg.lakes) {
            const id = g.lakes.length, cells = Array.from(L.maskCells), exitCell = dirToCell(L.exitDir, N);
            g.lakes.push({ id, cells, coreCells: 0, level: L.level, maxDepth: L.maxDepth, deepestCell: dirToCell(L.deepestDir, N),
                outletCell: exitCell, exitCell, outflowQ: g.Q[exitCell], river: -1, downstream: null });
            for (const c of cells) if (g.lakeOf[c] === -1) g.lakeOf[c] = id;
            refined.set(id, { level: L.level, exitDir: L.exitDir, outflowDirs: L.outflowDirs, frame: L.frame,
                region: Uint8Array.from(L.mask, v => (v === 2 ? 1 : 0)) });
            ids.push(id);
        }
        const rivers = [];
        // Streams with fine routes given (msg.streams: { lake: index in
        // msg.lakes, dirs, to }); otherwise the graph's routes below.
        if (msg.streams) {
            for (const st of msg.streams) {
                const id = ids[st.lake], cells = [];
                for (const d of st.dirs) { const c = dirToCell(d, N); if (cells[cells.length - 1] !== c) cells.push(c); }
                const rid = g.rivers.length;
                g.rivers.push({ id: rid, fromLake: id, to: st.to, cells, q: cells.map(c => g.Q[c]), fineDirs: st.dirs, corridorM: msg.streamCorridorM });
                g.lakes[id].river = rid;
                rivers.push({ id: rid, fromLake: id, to: st.to, cells: Int32Array.from(cells), lengthM: st.lengthM });
            }
            return { reply: { type: 'lakesAdded', base: ids[0] ?? g.lakes.length, rivers } };
        }
        for (const id of ids) {
            const { dest, cells } = routeFrom(id, { join: true });
            let lengthM = 0;
            for (let k = 1; k < cells.length; k++) {
                const a = cellDir(cells[k - 1], N), b = cellDir(cells[k], N);
                lengthM += Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * R;
            }
            if (!(lengthM <= msg.maxRouteM)) continue;
            const rid = g.rivers.length;
            g.rivers.push({ id: rid, fromLake: id, to: dest, cells, q: cells.map(c => g.Q[c]) });
            g.lakes[id].river = rid;
            rivers.push({ id: rid, fromLake: id, to: dest, cells: Int32Array.from(cells), lengthM });
        }
        return { reply: { type: 'lakesAdded', base: ids[0] ?? g.lakes.length, rivers } };
    }

    // Every refined lake's route (routes change whenever a level changes).
    function allDownstream() {
        const downstream = {};
        for (const id of refined.keys()) downstream[id] = downstreamOf(id);
        return downstream;
    }

    function restoreLake(msg) {
        const { lakeId, level, exitDir, outflowDirs = null, merged = [], frame = null, mask = null } = msg;
        const region = mask ? Uint8Array.from(mask, v => (v === 2 ? 1 : 0)) : null;
        refined.set(lakeId, { level, exitDir, outflowDirs, frame, region });
        for (const m of merged) {
            const r = rep(m);
            if (r === lakeId) continue;
            mergedInto.set(r, lakeId);
            refined.delete(r);
        }
        return { reply: { type: 'restored', lakeId, downstream: msg.skipDownstream ? null : allDownstream() } };
    }

    // ---- Rivers (riverRefine.js) ----
    const plans = new Map();   // riverId -> plan from planRiver

    function planRiver(msg) {
        const { riverId, spacing = 16, corridorM = 1000, join = false } = msg;
        const rv = g.rivers[riverId], src = rv.fromLake;
        if (rep(src) !== src) return { reply: { type: 'riverPlan', riverId, status: 'merged' } };
        // A stream with a fine route (mountain lakes: the 64 m drainage to
        // its destination, addLakes) follows it in a narrow corridor.
        const { dest, cells, outflowCells } = rv.fineDirs
            ? { dest: rv.to, cells: rv.cells, outflowCells: 0 } : routeFrom(src, { join, ownRiver: riverId });
        const corridor = rv.fineDirs ? rv.corridorM * corridorM / (msg.baseCorridorM ?? corridorM) : corridorM;
        const r = refined.get(src);
        const sillDir = r ? r.exitDir : cellDir(g.lakes[src].exitCell, N);
        let sourceDir = sillDir;
        // Overlap open lake water by several channel widths. A rounded cap
        // centred on the dry spill cell can leave a grass plug at the mouth.
        if (r?.region) {
            const P = { ...RIVER_SHAPE_DEFAULTS, ...(msg.shape ?? {}) };
            const cellKm2 = 4 * Math.PI * R * R / (6 * N * N) / 1e6;
            const width = riverShape(P.runoffM3sPerKm2 * g.lakes[src].outflowQ * cellKm2, 0.001, P).width;
            const mouthRadius = width * P.junctionWidthScale * 0.85;
            const inset = Math.max(P.sourceInsetM, mouthRadius + 2 * r.frame.spacing);
            const f = r.frame, [ex, ey] = dirToPlane(sillDir, f, R);
            const out = r.outflowDirs?.find(d => Math.hypot(...dirToPlane(d, f, R).map((v, i) => v - [ex, ey][i])) > f.spacing);
            const [ox, oy] = out ? dirToPlane(out, f, R) : [ex * 2, ey * 2];
            const len = Math.hypot(ox - ex, oy - ey) || 1;
            const ax = ex - inset * (ox - ex) / len, ay = ey - inset * (oy - ey) / len;
            const reach = inset * 3 + 2 * f.spacing;
            const i0 = Math.max(0, Math.floor((ex - reach - f.x0) / f.spacing)), i1 = Math.min(f.nx - 1, Math.ceil((ex + reach - f.x0) / f.spacing));
            const j0 = Math.max(0, Math.floor((ey - reach - f.y0) / f.spacing)), j1 = Math.min(f.ny - 1, Math.ceil((ey + reach - f.y0) / f.spacing));
            // Put the whole mouth in open lake water, rather than merely its
            // centre. A cap intersecting the shore carved a horseshoe/wedge.
            const shore = [];
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const k = j * f.nx + i;
                if (r.region[k] && (i === 0 || j === 0 || i === f.nx - 1 || j === f.ny - 1 ||
                    !r.region[k - 1] || !r.region[k + 1] || !r.region[k - f.nx] || !r.region[k + f.nx])) {
                    shore.push([f.x0 + (i + 0.5) * f.spacing, f.y0 + (j + 0.5) * f.spacing]);
                }
            }
            let best = Infinity;
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                if (!r.region[j * f.nx + i]) continue;
                const x = f.x0 + (i + 0.5) * f.spacing, y = f.y0 + (j + 0.5) * f.spacing;
                let clearance = Infinity;
                for (const [sx, sy] of shore) clearance = Math.min(clearance, Math.hypot(sx - x, sy - y));
                const deficit = Math.max(0, mouthRadius + f.spacing - clearance);
                const d2 = (x - ax) ** 2 + (y - ay) ** 2 + 25 * deficit * deficit;
                if (d2 < best) { best = d2; sourceDir = planeToDir(x, y, f, R); }
            }
        }
        // Polyline: the fine outflow out of the sill, then the graph's route,
        // then into the destination lake's deepest cell (its water). A fine
        // route already ends inside its destination's water.
        const dirs = rv.fineDirs ? [sourceDir, sillDir, ...rv.fineDirs]
            : r?.outflowDirs
                ? [sourceDir, sillDir, ...r.outflowDirs, ...cells.slice(outflowCells).map(c => cellDir(c, N))]
                : [sourceDir, sillDir, ...cells.slice(1).map(c => cellDir(c, N))];
        if (dest.type === 'lake' && !rv.fineDirs) dirs.push(cellDir(g.lakes[dest.id].deepestCell, N));
        const frame = polylinePatchFrame(dirs, { R, spacing, marginM: corridor + 200 });
        // A river destination's level comes with solveRiver (msg.trunk.eta).
        const destLevel = dest.type === 'lake' ? levelOf(dest.id) : dest.type === 'sea' ? seaLevelM : -Infinity;
        plans.set(riverId, { src, dest, destLevel, dirs, cells, sourceDir, corridorM: corridor });
        return { reply: { type: 'riverPlan', riverId, status: 'ok', frame, dest, sourceRefined: !!r } };
    }

    function solveRiver(msg) {
        const { riverId, frame } = msg;
        const shapeP = { ...RIVER_SHAPE_DEFAULTS, ...(msg.shape ?? {}) };
        const levelP = { ...RIVER_LEVEL_DEFAULTS, ...(msg.levels ?? {}) };
        const plan = plans.get(riverId);
        if (!plan) return { reply: { type: 'riverSolved', riverId, status: 'noPlan' } };
        if (plan.dest.type === 'river' && !msg.trunk) return { reply: { type: 'riverSolved', riverId, status: 'noTrunk' } };
        const h = msg.heights, { nx, ny, spacing } = frame;
        const cx = (k) => frame.x0 + ((k % nx) + 0.5) * spacing;
        const cy = (k) => frame.y0 + (Math.floor(k / nx) + 0.5) * spacing;
        const poly = plan.dirs.map(d => dirToPlane(d, frame, R));
        const corridor = corridorMask(frame, poly, plan.corridorM);

        // Seeds: corridor cells under the destination's water, as drawn: a
        // refined lake's region (below its level, inside its basin), an
        // unrefined lake's graph cells below its level, or the sea.
        const destRec = plan.dest.type === 'lake' ? refined.get(plan.dest.id) : null;
        const inDest = (k) => {
            const d = planeToDir(cx(k), cy(k), frame, R);
            if (destRec?.region) {
                const f = destRec.frame;
                const [x, y] = dirToPlane(d, f, R);
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                return i >= 0 && j >= 0 && i < f.nx && j < f.ny && destRec.region[j * f.nx + i] === 1;
            }
            const l = g.lakeOf[dirToCell(d, N)];
            return l !== -1 && rep(l) === plan.dest.id;
        };
        // A trunk river: the wet middle of its traced channel (msg.trunk:
        // dirs xyz per point, half-widths, its level at the graph's
        // junction, its levels per point).
        let trunkMask = null;
        const pts = [];
        if (plan.dest.type === 'river') {
            const T = msg.trunk, tn = T.hw.length;
            plan.destLevel = T.eta;
            trunkMask = new Uint8Array(nx * ny);
            for (let k = 0; k < tn; k++) pts.push(dirToPlane([T.dirs[3 * k], T.dirs[3 * k + 1], T.dirs[3 * k + 2]], frame, R));
            const x1 = frame.x0 + nx * spacing, y1 = frame.y0 + ny * spacing;
            for (let k = 0; k + 1 < tn; k++) {
                const [ax, ay] = pts[k], [bx, by] = pts[k + 1], r = 0.6 * Math.min(T.hw[k], T.hw[k + 1]);
                if (Math.max(ax, bx) + r < frame.x0 || Math.min(ax, bx) - r > x1 || Math.max(ay, by) + r < frame.y0 || Math.min(ay, by) - r > y1) continue;
                const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - frame.x0) / spacing)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + r - frame.x0) / spacing));
                const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - frame.y0) / spacing)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + r - frame.y0) / spacing));
                const ux = bx - ax, uy = by - ay, L2 = ux * ux + uy * uy || 1e-9;
                for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                    const px = frame.x0 + (i + 0.5) * spacing - ax, py = frame.y0 + (j + 0.5) * spacing - ay;
                    const t = Math.max(0, Math.min(1, (px * ux + py * uy) / L2));
                    if (Math.hypot(px - t * ux, py - t * uy) <= r) trunkMask[j * nx + i] = 1;
                }
            }
        }
        const seeds = new Uint8Array(nx * ny);
        let seedCount = 0;
        for (let k = 0; k < nx * ny; k++) {
            if (!corridor[k]) continue;
            if (plan.dest.type === 'sea') { if (!(h[k] <= seaLevelM)) continue; }
            else if (plan.dest.type === 'river') { if (!trunkMask[k]) continue; }
            else if (!(h[k] < plan.destLevel) || !inDest(k)) continue;
            seeds[k] = 1; seedCount++;
        }
        // No destination water inside the corridor: no river (the service
        // retries with a wider corridor). A river must end in water
        // (owner 2026-10-03: no dead ends).
        if (!seedCount) return { reply: { type: 'riverSolved', riverId, status: 'noDest' } };
        const [sx, sy] = poly[0];
        const si = Math.max(0, Math.min(nx - 1, Math.floor((sx - frame.x0) / spacing)));
        const sj = Math.max(0, Math.min(ny - 1, Math.floor((sy - frame.y0) / spacing)));
        const tr = traceRiverPatch({ heights: h, nx, ny, corridor, seeds, source: sj * nx + si });
        if (!tr) return { reply: { type: 'riverSolved', riverId, status: 'noPath' } };

        const xs = Float64Array.from(tr.path, cx), ys = Float64Array.from(tr.path, cy);
        const cellKm2 = 4 * Math.PI * R * R / (6 * N * N) / 1e6;
        const qAt = (ci) => shapeP.runoffM3sPerKm2 * g.Q[ci] * cellKm2;
        // Wider rivers bend more gently: smoothing window ~1.5 widths.
        let qMax = 0;
        for (const ci of plan.cells) qMax = Math.max(qMax, qAt(ci));
        const widthMax = riverShape(qMax, 0.001, shapeP, levelP.waterFrac).width;
        const window = Math.max(4, Math.min(16, Math.round((1.5 * widthMax) / spacing)));
        const sm = smoothRiverPath(xs, ys, tr.fill, { window, stepM: msg.stepM ?? 20, passes: msg.smoothPasses ?? 8 });
        let n = sm.x.length;
        const total = sm.s[n - 1] || 1;
        // The water never stands above the source lake: where the trace had
        // to cross higher ground (the graph's route and the 16 m terrain
        // disagree over long distances), the carve cuts a channel through the rise.
        const srcLevel = levelOf(plan.src);
        // Discharge: the route cell at the same arc fraction, but never less
        // than the source lake's outflow and never falling downstream (the
        // cells along a lake's fine outflow are off the graph's drainage
        // tree and hold almost none: lab 2026-10-06, river 17 dry there).
        const shapes = [];
        let qRun = g.lakes[plan.src].outflowQ ?? 0;
        for (let k = 0; k < n; k++) {
            const ci = plan.cells[Math.min(plan.cells.length - 1, Math.round((sm.s[k] / total) * (plan.cells.length - 1)))];
            qRun = Math.max(qRun, g.Q[ci]);
            const Qm3s = shapeP.runoffM3sPerKm2 * qRun * cellKm2;
            const k0 = Math.max(0, k - 4), k1 = Math.min(n - 1, k + 4);
            const slope = (sm.fill[k0] - sm.fill[k1]) / Math.max(1, sm.s[k1] - sm.s[k0]);
            shapes.push({ ...riverShape(Qm3s, slope, shapeP, levelP.waterFrac), Qm3s, slope });
        }
        // Lake water on the patch: the sea; refined lakes by their solved
        // region, which can reach beyond the graph's cells; other lakes below
        // their level in their graph cells. The valley neither fills nor
        // counts as ground there, and the river's points in it are lake points.
        const lakeMask = new Uint8Array(nx * ny), lakeLevel = new Float32Array(nx * ny);
        // Water as drawn (the sea, solved lakes' regions; not the graph's
        // cells of unsolved ones): the banks keep its rim (riverLakeRims).
        const lakeDrawn = new Uint8Array(nx * ny);
        const patchR = 0.5 * Math.hypot(nx, ny) * spacing;
        const near = [];
        for (const [id, rr] of refined) {
            if (!rr.region || rep(id) !== id) continue;
            const f = rr.frame, fr = 0.5 * Math.hypot(f.nx, f.ny) * f.spacing;
            const cosA = f.c[0] * frame.c[0] + f.c[1] * frame.c[1] + f.c[2] * frame.c[2];
            if (Math.acos(Math.max(-1, Math.min(1, cosA))) * R < patchR + fr) near.push(rr);
        }
        for (let k = 0; k < nx * ny; k++) {
            if (h[k] <= seaLevelM) { lakeMask[k] = 1; lakeDrawn[k] = 1; lakeLevel[k] = seaLevelM; continue; }
            const d = planeToDir(cx(k), cy(k), frame, R);
            for (const rr of near) {
                if (!(h[k] < rr.level)) continue;
                const f = rr.frame;
                const [x, y] = dirToPlane(d, f, R);
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && rr.region[j * f.nx + i] === 1) { lakeMask[k] = 1; lakeDrawn[k] = 1; lakeLevel[k] = rr.level; break; }
            }
            if (lakeMask[k]) continue;
            const l0 = g.lakeOf[dirToCell(d, N)];
            if (l0 === -1) continue;
            const l = rep(l0);
            if (!refined.get(l)?.region && h[k] < levelOf(l)) { lakeMask[k] = 1; lakeLevel[k] = levelOf(l); }
        }
        const pointCell = (k) => {
            const i = Math.floor((sm.x[k] - frame.x0) / spacing), j = Math.floor((sm.y[k] - frame.y0) / spacing);
            return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
        };
        // A trunk: its level where this river's path meets it. At the graph's
        // junction, 110-390 m along the trunk from there, it was up to 19 m
        // above or 10 m below the trunk's water (water-look v73): the stream
        // hung over the trunk or cut a trench beside it.
        if (trunkMask && msg.trunk.etas) {
            const at = trunkLevelAt(pts, msg.trunk.etas, sm.x[n - 1], sm.y[n - 1]);
            if (at.level <= srcLevel) plan.destLevel = at.level;
        }
        const destLevel = plan.destLevel;
        if (destLevel > srcLevel) return { reply: { type: 'riverSolved', riverId, status: 'uphill' } };
        let sourceEnd = 0, destStart = n - 1, sourceMouth = 0, destMouth = n - 1;
        const centreInLake = (k, level) => { const c = pointCell(k); return c >= 0 && lakeMask[c] && Math.abs(lakeLevel[c] - level) < 0.01; };
        for (let k = 0; k < n - 1; k++) if (centreInLake(k, srcLevel)) sourceMouth = k;
        for (let k = n - 1; k > sourceMouth; k--) if (centreInLake(k, destLevel)) destMouth = k;
        const touchesLake = (k, level) => {
            const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
            const dx = sm.x[b] - sm.x[a], dy = sm.y[b] - sm.y[a], len = Math.hypot(dx, dy) || 1;
            const radius = shapes[k].width * shapeP.junctionWidthScale * 0.85;
            for (let o = -radius; o <= radius; o += spacing * 0.5) {
                const i = Math.floor((sm.x[k] - dy / len * o - frame.x0) / spacing);
                const j = Math.floor((sm.y[k] + dx / len * o - frame.y0) / spacing);
                if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
                const c = j * nx + i;
                if (lakeMask[c] && Math.abs(lakeLevel[c] - level) < 0.01) return true;
            }
            return false;
        };
        // The whole outlet must clear the lake before its surface descends.
        // Centre-only anchors left a high lake sheet over the lower ribbon.
        // Only the runs at the river's ends count (gaps of up to two points
        // for shore wiggles): a stream passing near an arm of its lake far
        // from its end was held at the lake's level from there on, up to
        // 13 m under the ground, and cut a slot (owner 2026-10-12, v30).
        const GAP = 2;
        for (let k = 0, miss = 0; k < n - 1 && miss <= GAP; k++) {
            if (touchesLake(k, srcLevel)) { sourceEnd = k; miss = 0; } else if (k > 0) miss++;
        }
        for (let k = n - 1, miss = 0; k > sourceEnd && miss <= GAP; k--) {
            if (touchesLake(k, destLevel)) { destStart = k; miss = 0; } else if (k < n - 1) miss++;
        }
        // Mouths belong at the actual lake boundaries, which can be far
        // from the record's endpoints inside open water.
        // The river's typical width (median) scales its width noise (riverSection.js).
        const typicalWidthM = shapes.map(sh => sh.width).sort((a, b) => a - b)[shapes.length >> 1];
        const reachP = { ...shapeP, junctionStartM: sm.s[sourceMouth], junctionEndM: sm.s[destMouth], typicalWidthM };
        for (let k = 0; k < n; k++) shapes[k] = riverReachShape(shapes[k], sm.s[k], total, riverId, reachP);
        // Natural ground (bilinear on the patch).
        const groundAt = (x, y) => {
            const fx = (x - frame.x0) / spacing - 0.5, fy = (y - frame.y0) / spacing - 0.5;
            const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
            const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), c = j * nx + i;
            return (h[c] * (1 - tx) + h[c + 1] * tx) * (1 - ty) + (h[c + nx] * (1 - tx) + h[c + nx + 1] * tx) * ty;
        };
        const cellOf = (x, y) => {
            const i = Math.floor((x - frame.x0) / spacing), j = Math.floor((y - frame.y0) / spacing);
            return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
        };
        // Fit the surface below the dry ground at the channel's edges (within
        // bankBandM of them). Lake water within the wider wc is an anchor,
        // and pool-bed depth is independent of this fit.
        const hwArr = shapes.map(sh => sh.width / 2);
        const wc = hwArr.map(hw => levelP.floorScale * hw + levelP.floorExtraM);
        const free = shapes.map((sh, k) => riverCrestAbove(sh.depth, levelP) * ramp5(sm.s[k] / levelP.outletRampM));
        const ground = new Float64Array(n), inLake = new Array(n);
        const lakeGuard = new Float64Array(n).fill(-1e20);
        // The source lake's drawn water: within half a solve cell of its
        // solved water where the ground is below its level (waterWgsl.js
        // waterLakeHitIn). held[k]: ground beside the channel below the
        // level, all within that (riverLakeHold).
        const src = refined.get(rep(plan.src));
        const srcSdf = src?.region && (touchesLake(0, srcLevel) || sourceEnd > 0) ? lakeRegionSdf(src) : null;
        const held = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
            const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
            const tx = sm.x[k1] - sm.x[k0], ty = sm.y[k1] - sm.y[k0], tl = Math.hypot(tx, ty) || 1;
            const nxv = -ty / tl, nyv = tx / tl;
            let lo = Infinity, wet = Infinity;
            for (let o = -wc[k]; o <= wc[k] + 1e-6; o += 0.5 * spacing) {
                const c = cellOf(sm.x[k] + nxv * o, sm.y[k] + nyv * o);
                if (c >= 0 && lakeMask[c]) {
                    wet = Math.min(wet, lakeLevel[c]);
                    lakeGuard[k] = Math.max(lakeGuard[k], lakeLevel[c]);
                }
            }
            for (const side of [-1, 1]) {
                for (const d of [hwArr[k], hwArr[k] + 0.5 * levelP.bankBandM, hwArr[k] + levelP.bankBandM]) {
                    const x = sm.x[k] + nxv * side * d, y = sm.y[k] + nyv * side * d, c = cellOf(x, y);
                    if (c >= 0 && lakeMask[c]) continue;
                    lo = Math.min(lo, groundAt(x, y));
                }
            }
            if (srcSdf && k > sourceEnd) {
                let wet = false, dry = false;
                for (const side of [-1, 1]) {
                    for (const d of [hwArr[k], hwArr[k] + 0.5 * levelP.bankBandM, hwArr[k] + levelP.bankBandM]) {
                        const x = sm.x[k] + nxv * side * d, y = sm.y[k] + nyv * side * d;
                        if (!(groundAt(x, y) < srcLevel)) continue;
                        const [px, py] = dirToPlane(planeToDir(x, y, frame, R), src.frame, R);
                        if (lakeSdfAt(srcSdf, src.frame, px, py) > -0.5 * src.frame.spacing) wet = true; else dry = true;
                    }
                }
                held[k] = wet && !dry ? 1 : 0;
            }
            const c0 = pointCell(k);
            inLake[k] = c0 >= 0 && lakeMask[c0] === 1;
            ground[k] = Number.isFinite(lo) ? lo : (Number.isFinite(wet) ? wet + free[k] + levelP.marginM : groundAt(sm.x[k], sm.y[k]));
        }
        const { eta } = riverValleyLevels({ s: sm.s, ground, free, srcLevel, destLevel, sourceEnd, destStart }, levelP);
        // A river leaving its lake keeps the lake's level while the lake's
        // water still lies beside it.
        riverLakeHold({ eta, held, srcLevel, sourceEnd, destStart });
        const dirs = [];
        for (let k = 0; k < n; k++) dirs.push(planeToDir(sm.x[k], sm.y[k], frame, R));
        // Bends: signed curvature (1/m, + = turning left seen from above),
        // averaged over +-3 points so small wiggles don't flip it.
        const kappaRaw = new Float64Array(n);
        for (let k = 1; k + 1 < n; k++) {
            const a = dirs[k - 1], d = dirs[k], b = dirs[k + 1];
            const f0 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]], f1 = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
            const l0 = Math.hypot(...f0), l1 = Math.hypot(...f1);
            if (!(l0 > 0 && l1 > 0)) continue;
            const cr = [f0[1] * f1[2] - f0[2] * f1[1], f0[2] * f1[0] - f0[0] * f1[2], f0[0] * f1[1] - f0[1] * f1[0]];
            kappaRaw[k] = ((cr[0] * d[0] + cr[1] * d[1] + cr[2] * d[2]) / (l0 * l1)) / (0.5 * (l0 + l1) * R);
        }
        // The bed's slope (the design level's, over +-100 m).
        const etaSlope = (k) => {
            let k0 = k, k1 = k;
            while (k0 > 0 && sm.s[k] - sm.s[k0] < 100) k0--;
            while (k1 < n - 1 && sm.s[k1] - sm.s[k] < 100) k1++;
            return Math.max(levelP.minSlope * 0.5, (eta[k0] - eta[k1]) / Math.max(1, sm.s[k1] - sm.s[k0]));
        };
        // The fitted surface is authoritative. Computing another surface
        // from normal depth and clamping it with a running minimum produced
        // flat runs and dry pools. Vary the bed independently underneath it.
        const stride = RIVER_POINT_STRIDE;
        // How far each point's carve reaches (channel, banks, blend), and the
        // lake rims its banks keep (14, 15).
        const reachExtra = Math.max(40, msg.reachM ?? 0), reachScale = msg.reachScale ?? 1;
        const rims = riverLakeRims({ x: sm.x, y: sm.y, s: sm.s, hw: hwArr, reach: hwArr.map(hw => hw * reachScale + reachExtra),
            water: lakeDrawn, level: lakeLevel, nx, ny, x0: frame.x0, y0: frame.y0, spacing });
        let points = new Float32Array(n * stride);
        for (let k = 0; k < n; k++) {
            const { width, depth, Qm3s } = shapes[k];
            const slope = etaSlope(k);
            const waterDepth = levelP.waterFrac * depth;
            const speed = Math.max(0.05, Math.min(6, Qm3s / Math.max(0.65 * width * waterDepth, 0.1)));
            const d = dirs[k], hw = width / 2;
            let kappa = 0, m = 0;
            for (let q = Math.max(0, k - 3); q <= Math.min(n - 1, k + 3); q++) { kappa += kappaRaw[q]; m++; }
            kappa /= m;
            // The thalweg moves toward the outer bank of bends (Whitewater's d0).
            const skew = Math.max(-0.35, Math.min(0.35, -0.7 * kappa * hw));
            // Foam hint for the medium-distance water: steeper reaches are rougher.
            const foam = Math.max(0, Math.min(1, (slope - 0.004) / 0.03));
            // 12: the bends' curvature (riverSection.js bank types: cut banks outside, bars inside).
            points.set([d[0], d[1], d[2], eta[k], hw, levelP.waterFrac * depth, speed, Qm3s, sm.fill[k], inLake[k] ? -1 : 0, skew, foam,
                kappa, ground[k], rims.left[k], rims.right[k], eta[k], waterDepth, lakeGuard[k], inLake[k] ? 0 : shapes[k].island], k * stride);
        }
        const features = bakeRiverWaterfalls(points, stride, sm.s, shapeP.waterfalls);
        points = features.points; n = points.length / stride;
        // Fine lip samples share the existing channel indexing and valley bake.
        const line = Array.from({ length: n }, (_, k) => dirToPlane([points[k * stride], points[k * stride + 1], points[k * stride + 2]], frame, R));
        // Sub-cells each segment reaches: channel, banks and their blend into
        // the terrain (the carve), or its filled hollow, whichever is wider.
        const sub = msg.sub ?? 4;
        const cellAt = (x, y) => dirToCellSub(planeToDir(x, y, frame, R), N, sub);
        const segCellStart = new Int32Array(n);
        const segCellList = [];
        for (let k = 0; k + 1 < n; k++) {
            segCellStart[k] = segCellList.length;
            const a = k * stride, b = (k + 1) * stride;
            const reach = Math.max(points[a + 4], points[b + 4]) * reachScale + reachExtra;
            for (const c of segmentCells(line[k][0], line[k][1], line[k + 1][0], line[k + 1][1], reach, cellAt, { stepM: 20, marginM: 20 })) segCellList.push(c);
        }
        segCellStart[n - 1] = segCellList.length;
        const segCells = Int32Array.from(segCellList);
        const tLandscape = performance.now();
        const landscape = bakeRiverIncision({ frame, heights: h, points, stride, arc: features.arc, R, river: riverId,
            shape: { waterFrac: levelP.waterFrac, widthVar: 0.4, wobble: 0.3, bankVar: 0.55, ...msg.shapeNoise }, options: msg.landscape });
        // The worker retains the sparse field; reply buffers are independent.
        valleyRivers.set(riverId, valleyRiverFromRecord({ points, stride, riverId, landscape }, R));
        const replyLandscape = { ...landscape, cells: landscape.cells.slice(), cuts: landscape.cuts.slice() };
        const landscapeMs = performance.now() - tLandscape;
        return {
            reply: {
                type: 'riverSolved', riverId, status: 'ok', dest: plan.dest, src: plan.src,
                lengthM: total, points, stride, segCellStart, segCells,
                waterfalls: features.waterfalls, landscape: replyLandscape, landscapeMs,
                startLevel: sm.fill[0], endLevel: sm.fill[n - 1], destLevel: plan.destLevel,
            },
            transfer: [points.buffer, segCellStart.buffer, segCells.buffer, replyLandscape.cells.buffer, replyLandscape.cuts.buffer],
        };
    }

    // ---- River valleys (riverValley.js) ----
    function restoreRiver(msg) {
        valleyRivers.set(msg.riverId, valleyRiverFromRecord({ points: msg.points, stride: msg.stride, riverId: msg.riverId, landscape: msg.landscape }, R));
        return { reply: { type: 'riverRestored', riverId: msg.riverId } };
    }

    // Level of lake or sea water at a unit direction on the natural terrain,
    // NaN where dry: refined lakes by their solved region (lakes: candidate
    // records), others by their graph cells, the sea by the grid.
    function lakeLevelAtFor(lakes) {
        return (dir) => {
            const c = dirToCell(dir, N);
            if (isOcean(c)) return seaLevelM;
            for (const { rr, cosR } of lakes) {
                const f = rr.frame, k = dir[0] * f.c[0] + dir[1] * f.c[1] + dir[2] * f.c[2];
                if (k < cosR) continue;
                const [x, y] = dirToPlane(dir, f, R);
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && rr.region[j * f.nx + i] === 1) return rr.level;
            }
            const l0 = g.lakeOf[c];
            if (l0 === -1) return NaN;
            const l = rep(l0);
            return refined.get(l)?.region ? NaN : levelOf(l);
        };
    }

    function bakeValley(msg) {
        const opts = { ...RIVER_VALLEY_DEFAULTS, ...(msg.opts ?? {}) };
        const pages = new Set();
        for (const rid of msg.riverIds) {
            const rv = valleyRivers.get(rid);
            if (!rv) continue;
            if (rv.landscape) for (const p of valleyRiverIncisionPages(rv, R, opts)) pages.add(p);
        }
        const pageIds = Int32Array.from([...pages].sort((a, b) => a - b));
        // Every known river can reach these pages (the bake keeps the nearest).
        const rivers = [...valleyRivers.values()];
        // Refined lakes near the baked rivers (their frames within reach).
        const lakes = [];
        const reachM = opts.dBig + 3000;
        for (const rr of refined.values()) {
            if (!rr.region) continue;
            const f = rr.frame, half = 0.5 * Math.hypot(f.nx, f.ny) * f.spacing;
            let near = false;
            for (const rid of msg.riverIds) {
                const rv = valleyRivers.get(rid);
                if (!rv) continue;
                for (let k = 0; k < rv.dirs.length && !near; k += 25) {
                    const d = rv.dirs[k], cosA = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
                    if (Math.acos(Math.max(-1, Math.min(1, cosA))) * R < half + reachM) near = true;
                }
                if (near) break;
            }
            if (near) lakes.push({ rr, cosR: Math.cos(Math.min(Math.PI / 2, (half + 200) / R)) });
        }
        const { texels } = bakeValleyPages(Array.from(pageIds), rivers, { R, lakeLevelAt: lakeLevelAtFor(lakes) }, opts);
        return {
            reply: { type: 'valleyBaked', pageIds, texels },
            transfer: [pageIds.buffer, texels.buffer],
        };
    }

    return {
        handle(msg) {
            if (msg.type === 'build') return build(msg);
            if (msg.type === 'restoreRiver') return restoreRiver(msg);
            if (msg.type === 'bakeValley') return bakeValley(msg);
            if (msg.type === 'solveLake') return solveLake(msg);
            if (msg.type === 'restoreLake') return restoreLake(msg);
            if (msg.type === 'downstream') return { reply: { type: 'downstream', downstream: allDownstream() } };
            if (msg.type === 'adoptLake') return adoptLake(msg);
            if (msg.type === 'addLakes') return addLakes(msg);
            if (msg.type === 'solvePatchLake') return solvePatchLake(msg);
            if (msg.type === 'findPockets') {
                return { reply: { type: 'pockets', pockets: findPockets({ heights: msg.heights, frame: msg.frame, R: msg.R, seaLevelM: msg.seaLevelM, P: msg.params }) } };
            }
            if (msg.type === 'continueDrain') {
                return { reply: { type: 'drain', ...continueDrain({ heights: msg.heights, frame: msg.frame, R: msg.R, start: msg.start, P: msg.params }) } };
            }
            if (msg.type === 'planRiver') return planRiver(msg);
            if (msg.type === 'solveRiver') return solveRiver(msg);
            throw new Error(`waterWorkerCore: unknown message ${msg.type}`);
        },
    };
}
