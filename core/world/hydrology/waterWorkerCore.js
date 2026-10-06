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
//     points, stride 16 (riverRefine.js RIVER_POINT_STRIDE): dir.xyz, water
//     level, half-width, water depth at the thalweg (level - thalweg), speed,
//     discharge (m^3/s), spill level of the trace (uncarved terrain), pool
//     (-1 = the point lies in a lake, else 0), thalweg skew toward the outer
//     bank (-0.35..0.35, + = left of the flow), foam hint (0..1); the valley
//     (riverValley.js): floor level, floor half-width, fill weight, wall slope;
//     the water: its level (normal depth of Q in the channel), its depth at
//     the thalweg; two unused;
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
import { bakeValleyPages, RIVER_VALLEY_DEFAULTS, valleyPagesNear, valleyRiverFromRecord } from '../water/riverValley.js';
import { dirToPlane, lakeMask, lakePatchFrame, lakeSeed, planeToDir, polylinePatchFrame, solveLakePatch } from './lakeRefine.js';
import { corridorMask, RIVER_LEVEL_DEFAULTS, RIVER_POINT_STRIDE, RIVER_SHAPE_DEFAULTS, riverCrestAbove, riverNormalDepth, riverShape, riverValleyLevels, riverValleyShape, segmentCells, smoothRiverPath, traceRiverPatch } from './riverRefine.js';

// C2 ramp 0..1 (quintic smoothstep of a clamped value).
const ramp5 = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

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
        const { riverId, spacing = 16, corridorM = 1000, join = false } = msg;
        const src = g.rivers[riverId].fromLake;
        if (rep(src) !== src) return { reply: { type: 'riverPlan', riverId, status: 'merged' } };
        const { dest, cells, outflowCells } = routeFrom(src, { join, ownRiver: riverId });
        const r = refined.get(src);
        const sourceDir = r ? r.exitDir : cellDir(g.lakes[src].exitCell, N);
        // Polyline: the fine outflow out of the sill, then the graph's route,
        // then into the destination lake's deepest cell (its water).
        const dirs = r?.outflowDirs
            ? [sourceDir, ...r.outflowDirs, ...cells.slice(outflowCells).map(c => cellDir(c, N))]
            : [sourceDir, ...cells.slice(1).map(c => cellDir(c, N))];
        if (dest.type === 'lake') dirs.push(cellDir(g.lakes[dest.id].deepestCell, N));
        const frame = polylinePatchFrame(dirs, { R, spacing, marginM: corridorM + 200 });
        // A river destination's level comes with solveRiver (msg.trunk.eta).
        const destLevel = dest.type === 'lake' ? levelOf(dest.id) : dest.type === 'sea' ? seaLevelM : -Infinity;
        plans.set(riverId, { src, dest, destLevel, dirs, cells, sourceDir, corridorM });
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
        // dirs xyz per point, half-widths, its level at the junction).
        let trunkMask = null;
        if (plan.dest.type === 'river') {
            const T = msg.trunk, tn = T.hw.length;
            plan.destLevel = T.eta;
            trunkMask = new Uint8Array(nx * ny);
            const pts = [];
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
        const n = sm.x.length, total = sm.s[n - 1] || 1;
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
        const patchR = 0.5 * Math.hypot(nx, ny) * spacing;
        const near = [];
        for (const [id, rr] of refined) {
            if (!rr.region || rep(id) !== id) continue;
            const f = rr.frame, fr = 0.5 * Math.hypot(f.nx, f.ny) * f.spacing;
            const cosA = f.c[0] * frame.c[0] + f.c[1] * frame.c[1] + f.c[2] * frame.c[2];
            if (Math.acos(Math.max(-1, Math.min(1, cosA))) * R < patchR + fr) near.push(rr);
        }
        for (let k = 0; k < nx * ny; k++) {
            if (h[k] <= seaLevelM) { lakeMask[k] = 1; lakeLevel[k] = seaLevelM; continue; }
            const d = planeToDir(cx(k), cy(k), frame, R);
            for (const rr of near) {
                if (!(h[k] < rr.level)) continue;
                const f = rr.frame;
                const [x, y] = dirToPlane(d, f, R);
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && rr.region[j * f.nx + i] === 1) { lakeMask[k] = 1; lakeLevel[k] = rr.level; break; }
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
        // Per point: the floor's half-width, its height above the water (ramped
        // in from the source), the lowest dry ground beside the line within the
        // floor (lake water is not ground; where all of it is water, the
        // water's level), and the ground wallProbeM past the floor's edge.
        const hwArr = shapes.map(sh => sh.width / 2);
        const wc = hwArr.map(hw => levelP.floorScale * hw + levelP.floorExtraM);
        const free = shapes.map((sh, k) => riverCrestAbove(sh.depth, levelP) * ramp5(sm.s[k] / levelP.outletRampM));
        const ground = new Float64Array(n), rise = new Float64Array(n), inLake = new Array(n);
        for (let k = 0; k < n; k++) {
            const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
            const tx = sm.x[k1] - sm.x[k0], ty = sm.y[k1] - sm.y[k0], tl = Math.hypot(tx, ty) || 1;
            const nxv = -ty / tl, nyv = tx / tl;
            let lo = Infinity, wet = Infinity;
            for (let o = -wc[k]; o <= wc[k] + 1e-6; o += 0.5 * spacing) {
                const x = sm.x[k] + nxv * o, y = sm.y[k] + nyv * o, c = cellOf(x, y);
                if (c >= 0 && lakeMask[c]) { wet = Math.min(wet, lakeLevel[c]); continue; }
                lo = Math.min(lo, groundAt(x, y));
            }
            const c0 = pointCell(k);
            inLake[k] = c0 >= 0 && lakeMask[c0] === 1;
            ground[k] = Number.isFinite(lo) ? lo : (Number.isFinite(wet) ? wet + free[k] + levelP.marginM : groundAt(sm.x[k], sm.y[k]));
            // The higher side, wallProbeM past the floor's edge (or as far as the patch reaches).
            let r = -Infinity;
            for (const side of [-1, 1]) {
                for (let o = wc[k] + levelP.wallProbeM; o > wc[k]; o -= 50) {
                    const x = sm.x[k] + nxv * o * side, y = sm.y[k] + nyv * o * side;
                    if (cellOf(x, y) < 0) continue;
                    r = Math.max(r, groundAt(x, y));
                    break;
                }
            }
            rise[k] = Number.isFinite(r) ? r : ground[k];
        }
        const destLevel = plan.destLevel;
        const { eta } = riverValleyLevels({ s: sm.s, ground, free, srcLevel, destLevel }, levelP);
        const vs = riverValleyShape({ s: sm.s, eta, free, wc, rise, inLake }, levelP);
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
        // The water: normal depth of Q in the channel on that slope
        // (Whitewater derives its inflow the same way), so the simulation's
        // steady flow carries the river's discharge at the drawn level. At the
        // source it meets the lake's level; never below the destination's;
        // never rising.
        const wl = new Float64Array(n), wDepth = new Float64Array(n), speedArr = new Float64Array(n);
        for (let k = 0, run = Infinity; k < n; k++) {
            const { width, depth, Qm3s } = shapes[k];
            const T = eta[k] - levelP.waterFrac * depth;
            const nd = riverNormalDepth(Qm3s, etaSlope(k), width / 2, depth, shapeP.manning);
            const a = ramp5(sm.s[k] / levelP.outletRampM);
            let level = eta[k] + (T + nd.h - eta[k]) * a;
            level = Math.max(level, destLevel);
            run = Math.min(run, level);
            wl[k] = run; wDepth[k] = Math.max(0, run - T);
            speedArr[k] = Math.max(0.05, Math.min(6, Qm3s / Math.max(nd.A, 0.1)));
        }
        const stride = RIVER_POINT_STRIDE;
        const points = new Float32Array(n * stride);
        for (let k = 0; k < n; k++) {
            const { width, depth, Qm3s } = shapes[k];
            const slope = etaSlope(k);
            const speed = speedArr[k];
            const d = dirs[k], hw = width / 2;
            let kappa = 0, m = 0;
            for (let q = Math.max(0, k - 3); q <= Math.min(n - 1, k + 3); q++) { kappa += kappaRaw[q]; m++; }
            kappa /= m;
            // The thalweg moves toward the outer bank of bends (Whitewater's d0).
            const skew = Math.max(-0.35, Math.min(0.35, -0.7 * kappa * hw));
            // Foam hint for the medium-distance water: steeper reaches are rougher.
            const foam = Math.max(0, Math.min(1, (slope - 0.004) / 0.03));
            points.set([d[0], d[1], d[2], eta[k], hw, levelP.waterFrac * depth, speed, Qm3s, sm.fill[k], inLake[k] ? -1 : 0, skew, foam,
                vs.F[k], wc[k], vs.wFill[k], vs.sWall[k], wl[k], wDepth[k], 0, 0], k * stride);
        }
        // Sub-cells each segment reaches: channel, banks and their blend into
        // the terrain (the carve), or its filled hollow, whichever is wider.
        const reachExtra = Math.max(40, msg.reachM ?? 0), reachScale = msg.reachScale ?? 1;
        const sub = msg.sub ?? 4;
        const cellAt = (x, y) => dirToCellSub(planeToDir(x, y, frame, R), N, sub);
        const segCellStart = new Int32Array(n);
        const segCellList = [];
        for (let k = 0; k + 1 < n; k++) {
            segCellStart[k] = segCellList.length;
            const a = k * stride, b = (k + 1) * stride;
            const reach = Math.max(points[a + 4], points[b + 4]) * reachScale + reachExtra;
            for (const c of segmentCells(sm.x[k], sm.y[k], sm.x[k + 1], sm.y[k + 1], reach, cellAt)) segCellList.push(c);
        }
        segCellStart[n - 1] = segCellList.length;
        const segCells = Int32Array.from(segCellList);
        valleyRivers.set(riverId, valleyRiverFromRecord({ points, stride }, R));
        return {
            reply: {
                type: 'riverSolved', riverId, status: 'ok', dest: plan.dest, src: plan.src,
                lengthM: total, points, stride, segCellStart, segCells,
                startLevel: sm.fill[0], endLevel: sm.fill[n - 1], destLevel: plan.destLevel,
            },
            transfer: [points.buffer, segCellStart.buffer, segCells.buffer],
        };
    }

    // ---- River valleys (riverValley.js) ----
    function restoreRiver(msg) {
        valleyRivers.set(msg.riverId, valleyRiverFromRecord({ points: msg.points, stride: msg.stride }, R));
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
            if (rv) for (const p of valleyPagesNear(rv.dirs, rv.s, R, opts)) pages.add(p);
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
            if (msg.type === 'planRiver') return planRiver(msg);
            if (msg.type === 'solveRiver') return solveRiver(msg);
            throw new Error(`waterWorkerCore: unknown message ${msg.type}`);
        },
    };
}
