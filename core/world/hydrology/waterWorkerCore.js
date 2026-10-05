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
//   { type: 'solveRiver', riverId, frame, heights, shape, levels, reachM }
//     -> { type: 'riverSolved', riverId, status, points, stride, segCellStart, segCells, ... }
//     points, stride 9: dir.xyz, water level, half-width, depth (level - bed),
//     speed, discharge (m^3/s), spill level of the trace (uncarved terrain);
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
import { dirToPlane, lakeMask, lakePatchFrame, lakeSeed, planeToDir, polylinePatchFrame, solveLakePatch } from './lakeRefine.js';
import { corridorMask, RIVER_LEVEL_DEFAULTS, RIVER_SHAPE_DEFAULTS, riverLevels, riverShape, segmentCells, smoothRiverPath, traceRiverPatch } from './riverRefine.js';

export function createWaterWorkerCore() {
    let g = null;
    let N = 0, R = 0, seaLevelM = 0;
    let heights = null;
    const refined = new Map();   // lakeId -> { level, exitDir, frame, region }
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
    function routeFrom(id) {
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
                exitDir, outflowDirs, mask, maskCells, merged, downstream,
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
        const { lakeId, level, exitDir, outflowDirs = null, merged = [], frame = null, mask = null } = msg;
        const region = mask ? Uint8Array.from(mask, v => (v === 2 ? 1 : 0)) : null;
        refined.set(lakeId, { level, exitDir, outflowDirs, frame, region });
        for (const m of merged) {
            const r = rep(m);
            if (r === lakeId) continue;
            mergedInto.set(r, lakeId);
            refined.delete(r);
        }
        return { reply: { type: 'restored', lakeId, downstream: allDownstream() } };
    }

    // ---- Rivers (riverRefine.js) ----
    const plans = new Map();   // riverId -> plan from planRiver

    function planRiver(msg) {
        const { riverId, spacing = 16, corridorM = 1000 } = msg;
        const src = g.rivers[riverId].fromLake;
        if (rep(src) !== src) return { reply: { type: 'riverPlan', riverId, status: 'merged' } };
        const { dest, cells, outflowCells } = routeFrom(src);
        const r = refined.get(src);
        const sourceDir = r ? r.exitDir : cellDir(g.lakes[src].exitCell, N);
        // Polyline: the fine outflow out of the sill, then the graph's route,
        // then into the destination lake's deepest cell (its water).
        const dirs = r?.outflowDirs
            ? [sourceDir, ...r.outflowDirs, ...cells.slice(outflowCells).map(c => cellDir(c, N))]
            : [sourceDir, ...cells.slice(1).map(c => cellDir(c, N))];
        if (dest.type === 'lake') dirs.push(cellDir(g.lakes[dest.id].deepestCell, N));
        const frame = polylinePatchFrame(dirs, { R, spacing, marginM: corridorM + 200 });
        const destLevel = dest.type === 'lake' ? levelOf(dest.id) : seaLevelM;
        plans.set(riverId, { src, dest, destLevel, dirs, cells, sourceDir, corridorM });
        return { reply: { type: 'riverPlan', riverId, status: 'ok', frame, dest, sourceRefined: !!r } };
    }

    function solveRiver(msg) {
        const { riverId, frame } = msg;
        const shapeP = { ...RIVER_SHAPE_DEFAULTS, ...(msg.shape ?? {}) };
        const levelP = { ...RIVER_LEVEL_DEFAULTS, ...(msg.levels ?? {}) };
        const plan = plans.get(riverId);
        if (!plan) return { reply: { type: 'riverSolved', riverId, status: 'noPlan' } };
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
        const seeds = new Uint8Array(nx * ny);
        let seedCount = 0;
        for (let k = 0; k < nx * ny; k++) {
            if (!corridor[k]) continue;
            if (plan.dest.type === 'sea') { if (!(h[k] <= seaLevelM)) continue; }
            else if (!(h[k] < plan.destLevel) || !inDest(k)) continue;
            seeds[k] = 1; seedCount++;
        }
        let weakEnd = false;
        if (!seedCount) {
            // No destination water inside the corridor: end where the route ends.
            weakEnd = true;
            const [ex, ey] = poly[poly.length - 1];
            for (let k = 0; k < nx * ny; k++) if (corridor[k] && Math.hypot(cx(k) - ex, cy(k) - ey) < 300) seeds[k] = 1;
        }
        const [sx, sy] = poly[0];
        const si = Math.max(0, Math.min(nx - 1, Math.floor((sx - frame.x0) / spacing)));
        const sj = Math.max(0, Math.min(ny - 1, Math.floor((sy - frame.y0) / spacing)));
        const tr = traceRiverPatch({ heights: h, nx, ny, corridor, seeds, source: sj * nx + si });
        if (!tr) return { reply: { type: 'riverSolved', riverId, status: 'noPath' } };

        const xs = Float64Array.from(tr.path, cx), ys = Float64Array.from(tr.path, cy);
        const sm = smoothRiverPath(xs, ys, tr.fill, { window: 4, stepM: Math.max(40, spacing * 2.5) });
        const n = sm.x.length, total = sm.s[n - 1] || 1;
        const cellKm2 = 4 * Math.PI * R * R / (6 * N * N) / 1e6;
        // The water never stands above the source lake: where the trace had
        // to cross higher ground (the graph's route and the 16 m terrain
        // disagree over long distances), the carve cuts a channel through the rise.
        const srcLevel = levelOf(plan.src);
        const shapes = [];
        for (let k = 0; k < n; k++) {
            const ci = plan.cells[Math.min(plan.cells.length - 1, Math.round((sm.s[k] / total) * (plan.cells.length - 1)))];
            const Qm3s = shapeP.runoffM3sPerKm2 * g.Q[ci] * cellKm2;
            const k0 = Math.max(0, k - 4), k1 = Math.min(n - 1, k + 4);
            const slope = (sm.fill[k0] - sm.fill[k1]) / Math.max(1, sm.s[k1] - sm.s[k0]);
            shapes.push({ ...riverShape(Qm3s, slope, shapeP), Qm3s });
        }
        const lv = riverLevels(sm.fill, sm.s, shapes.map(sh => sh.depth), { srcLevel, destLevel: plan.destLevel }, levelP);
        const stride = 9;   // dir.xyz, eta, halfWidth, depth (eta - bed), speed, Q, fill
        const points = new Float32Array(n * stride);
        for (let k = 0; k < n; k++) {
            const { width, speed, Qm3s } = shapes[k];
            const d = planeToDir(sm.x[k], sm.y[k], frame, R);
            points.set([d[0], d[1], d[2], lv.eta[k], width / 2, lv.eta[k] - lv.bed[k], speed, Qm3s, sm.fill[k]], k * stride);
        }
        // Sub-cells each segment reaches: its channel and banks (the carve)
        // or the water's spread beside it, whichever is wider.
        const reachExtra = Math.max(40, msg.reachM ?? 0);
        const sub = msg.sub ?? 4;
        const cellAt = (x, y) => dirToCellSub(planeToDir(x, y, frame, R), N, sub);
        const segCellStart = new Int32Array(n);
        const segCellList = [];
        for (let k = 0; k + 1 < n; k++) {
            segCellStart[k] = segCellList.length;
            const reach = Math.max(points[k * stride + 4], points[(k + 1) * stride + 4]) + reachExtra;
            for (const c of segmentCells(sm.x[k], sm.y[k], sm.x[k + 1], sm.y[k + 1], reach, cellAt)) segCellList.push(c);
        }
        segCellStart[n - 1] = segCellList.length;
        const segCells = Int32Array.from(segCellList);
        return {
            reply: {
                type: 'riverSolved', riverId, status: 'ok', dest: plan.dest, src: plan.src, weakEnd,
                lengthM: total, points, stride, segCellStart, segCells,
                startLevel: sm.fill[0], endLevel: sm.fill[n - 1], destLevel: plan.destLevel,
            },
            transfer: [points.buffer, segCellStart.buffer, segCells.buffer],
        };
    }

    return {
        handle(msg) {
            if (msg.type === 'build') return build(msg);
            if (msg.type === 'solveLake') return solveLake(msg);
            if (msg.type === 'restoreLake') return restoreLake(msg);
            if (msg.type === 'planRiver') return planRiver(msg);
            if (msg.type === 'solveRiver') return solveRiver(msg);
            throw new Error(`waterWorkerCore: unknown message ${msg.type}`);
        },
    };
}
