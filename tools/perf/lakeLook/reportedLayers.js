// Diagnostic for overlapping visible lake sheets at a reported camera pose.
export async function reportedLayers({ pos, look, up = [0, 1, 0] }) {
    const g = window.gameEngine, w = g.waterGpuData, s = g.waterService, R = w.R;
    const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const forward = norm(look.map((v, i) => v - pos[i])), right = norm(cross(forward, up)), vertical = cross(right, forward);
    const origin = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 }, o = [origin.x, origin.y, origin.z];
    const cam = pos.map((v, i) => v - o[i]);
    const hits = [];
    for (const sy of [-.7, 0, .7]) for (const sx of [-.7, 0, .7]) {
        const t = Math.tan(75 * Math.PI / 360), aspect = 1440 / 900;
        const ray = norm(forward.map((v, i) => v + sx * t * aspect * right[i] + sy * t * vertical[i]));
        const b = dot(cam, ray), list = [];
        for (const [id, rec] of w._applied) {
            if (!(w._layerOf.get(id) >= 0)) continue;
            const radius = R + rec.level, c = dot(cam, cam) - radius * radius, discr = b * b - c;
            if (discr < 0) continue;
            for (const distance of [-b - Math.sqrt(discr), -b + Math.sqrt(discr)]) {
                if (distance <= 0) continue;
                const d = norm(cam.map((v, i) => v + distance * ray[i])), f = rec.frame, den = dot(d, f.c);
                if (den <= 0) continue;
                const x = dot(d, f.e1) / den * R, y = dot(d, f.e2) / den * R;
                const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
                if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && rec.mask[j * f.nx + i])
                    list.push({ id, level: rec.level, distance: Math.round(distance), mask: rec.mask[j * f.nx + i], mountain: !!s.lakes[id]?.mountain });
            }
        }
        list.sort((a, b) => a.distance - b.distance);
        hits.push({ sx, sy, lakes: list.slice(0, 12) });
    }
    const near = w.lakesNear({ x: cam[0], y: cam[1], z: cam[2] }, 5000, 30).map(id => ({ id, level: s.refined.get(id)?.level,
        mountain: !!s.lakes[id]?.mountain, size: [s.refined.get(id)?.frame?.nx, s.refined.get(id)?.frame?.ny],
        spacing: s.refined.get(id)?.frame?.spacing }));
    return { cameraHeight: Math.hypot(...cam) - R, near, hits, mountainStats: s.mountainStats, timings: s.timings, waterNear: w.near, waterLook: w.look,
        ocean: { seaLevel: s._sampler?.seaLevelM, renderer: Object.keys(g.renderer).filter(k => /ocean|water/i.test(k)) } };
}

export async function overlapDetail({ a = 2858, b = 2859, pos }) {
    const g = window.gameEngine, w = g.waterGpuData, s = g.waterService;
    const { planeToDir } = await import('/core/world/hydrology/lakeRefine.js');
    const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const sample = (r, d) => {
        const f = r.frame, den = dot(d, f.c); if (den <= 0) return 0;
        const i = Math.floor((dot(d, f.e1) / den * w.R - f.x0) / f.spacing);
        const j = Math.floor((dot(d, f.e2) / den * w.R - f.y0) / f.spacing);
        return i >= 0 && j >= 0 && i < f.nx && j < f.ny ? r.mask[j * f.nx + i] : 0;
    };
    const one = (id, other) => {
        const r = s.refined.get(id), o = s.refined.get(other), f = r.frame;
        let wet = 0, overlap = 0, band = 0;
        for (let j = 0; j < f.ny; j++) for (let i = 0; i < f.nx; i++) {
            if (r.mask[j * f.nx + i] !== 2) continue;
            wet++;
            const d = planeToDir(f.x0 + (i + .5) * f.spacing, f.y0 + (j + .5) * f.spacing, f, w.R), m = sample(o, d);
            if (m === 2) overlap++; else if (m) band++;
        }
        return { id, level: r.level, wet, overlap, band, centre: s.lakes[id].centreDir,
            cameraMask: sample(r, norm(pos)), frame: { nx: f.nx, ny: f.ny, spacing: f.spacing }, river: s.lakes[id].river };
    };
    const { removeSubmergedPonds } = await import('/core/world/hydrology/submergedPonds.js');
    const pair = [a, b].map(id => ({ id, rec: s.refined.get(id) }));
    return { a: one(a, b), b: one(b, a), kept: removeSubmergedPonds(pair, w.R).map(p => p.id) };
}

export async function submergedPondCensus() {
    const s = window.gameEngine.waterService;
    const { hashParts } = await import('/core/world/hydrology/waterCache.js');
    const { MOUNTAIN_LAKE_DEFAULTS, MOUNTAIN_LAKE_VERSION } = await import('/core/world/hydrology/mountainLakes.js');
    const { removeSubmergedPonds } = await import('/core/world/hydrology/submergedPonds.js');
    const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...s.config.refine.mountain };
    const key = `mlakes:${s._key}:${hashParts([MOUNTAIN_LAKE_VERSION, P, s.config.refine.bandM])}`;
    const solved = await s._cache.get(key);
    if (!solved) throw new Error('Mountain cache unavailable');
    const base = s.lakes.findIndex(l => l.mountain);
    const ponds = solved.map((p, k) => ({ ...p, id: base + k })).filter(p => p.pond);
    const t = performance.now(), kept = removeSubmergedPonds(ponds, s.radius), keptIds = new Set(kept.map(p => p.id));
    return { ponds: ponds.length, removed: ponds.filter(p => !keptIds.has(p.id)).map(p => ({ id: p.id, level: p.rec.level })), ms: performance.now() - t };
}

export async function pondGroupCensus() {
    const s = window.gameEngine.waterService;
    const { hashParts } = await import('/core/world/hydrology/waterCache.js');
    const { MOUNTAIN_LAKE_DEFAULTS } = await import('/core/world/hydrology/mountainLakes.js');
    const { pondOverlapGroups } = await import('/core/world/hydrology/pondOverlapGroups.js');
    const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...s.config.refine.mountain };
    const old = await s._cache.get(`mlakes:${s._key}:${hashParts([4, P, s.config.refine.bandM])}`);
    if (!old) throw new Error('Original mountain cache unavailable');
    const base = s.lakes.findIndex(l => l.mountain), ponds = old.map((p, k) => ({ ...p, id: base + k })).filter(p => p.pond);
    const t = performance.now(), groups = pondOverlapGroups(ponds, s.radius);
    return { ponds: ponds.length, groups: groups.length, members: groups.reduce((sum, g) => sum + g.length, 0),
        max: Math.max(0, ...groups.map(g => g.length)), ms: performance.now() - t,
        reported: groups.filter(g => g.some(i => ponds[i].id === 2858 || ponds[i].id === 2859)).map(g => g.map(i => ponds[i].id)) };
}

export async function currentPondCensus() {
    const s = window.gameEngine.waterService;
    const { hashParts } = await import('/core/world/hydrology/waterCache.js');
    const { MOUNTAIN_LAKE_DEFAULTS, MOUNTAIN_LAKE_VERSION } = await import('/core/world/hydrology/mountainLakes.js');
    const { pondOverlapGroups } = await import('/core/world/hydrology/pondOverlapGroups.js');
    const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...s.config.refine.mountain };
    const items = await s._cache.get(`mlakes:${s._key}:${hashParts([MOUNTAIN_LAKE_VERSION, P, s.config.refine.bandM])}`);
    if (!items) throw new Error('Current mountain cache unavailable');
    const ponds = items.filter(p => p.pond), groups = pondOverlapGroups(ponds, s.radius);
    const merged = ponds.filter(p => p.mergedPond);
    const starts = merged.filter(p => p.path?.length && p.rec.exitDir).map(p => Math.acos(Math.max(-1, Math.min(1,
        p.path[0].reduce((v, x, i) => v + x * p.rec.exitDir[i], 0)))) * s.radius);
    const allGroups = pondOverlapGroups(items, s.radius);
    return { ponds: ponds.length, overlappingGroups: groups.length, allMountainGroups: allGroups.length,
        mixedGroups: allGroups.filter(g => g.some(i => items[i].pond) && g.some(i => !items[i].pond)).length,
        merged: merged.length, withStreams: starts.length,
        maxStartDistanceM: starts.length ? Math.max(...starts) : null,
        maxGroup: Math.max(0, ...groups.map(g => g.length)), mountainStats: s.mountainStats,
        mixed: allGroups.filter(g => g.some(i => items[i].pond) && g.some(i => !items[i].pond)).map(g => ({
            mountains: g.filter(i => !items[i].pond).length, ponds: g.filter(i => items[i].pond).length,
            levels: g.map(i => +items[i].rec.level.toFixed(2)) })) };
}

export async function unresolvedPondDetails() {
    const s = window.gameEngine.waterService;
    const { hashParts } = await import('/core/world/hydrology/waterCache.js');
    const { MOUNTAIN_LAKE_DEFAULTS, MOUNTAIN_LAKE_VERSION } = await import('/core/world/hydrology/mountainLakes.js');
    const { pondOverlapGroups, sharedPondFrame } = await import('/core/world/hydrology/pondOverlapGroups.js');
    const { dirToPlane, planeToDir, growPatchFrame } = await import('/core/world/hydrology/lakeRefine.js');
    const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...s.config.refine.mountain }, R = s.radius;
    const items = await s._cache.get(`mlakes:${s._key}:${hashParts([MOUNTAIN_LAKE_VERSION, P, s.config.refine.bandM])}`);
    const ponds = items.filter(p => p.pond), groups = pondOverlapGroups(ponds, R), result = [];
    for (const group of groups.slice(0, 8)) {
        const members = group.map(i => ponds[i]), anchor = members.reduce((a, b) => a.rec.mask.length >= b.rec.mask.length ? a : b);
        let frame = sharedPondFrame(members, R, P.solveSpacingM), attempts = [];
        for (let i = 0; i <= s.config.refine.maxGrows; i++) {
            const cells = frame.nx * frame.ny;
            if (cells > s.config.refine.maxCells) { attempts.push({ cells, status: 'too large' }); break; }
            const heights = await s._sampler.samplePatch(frame, R);
            const rec = await s._client.call({ type: 'solvePatchLake', lakeId: -1, frame, heights, bandM: s.config.refine.bandM, N: s.N, R, seedDir: anchor.dir, others: new Float64Array(0) }, [heights.buffer]);
            const a = { cells, status: rec.status, level: rec.level }; attempts.push(a);
            if (rec.status === 'grow') { frame = growPatchFrame(frame, 1.6); continue; }
            if (rec.status === 'ok') a.coverage = members.map(p => {
                const f = p.rec.frame; let wet = 0, covered = 0;
                for (let k = 0; k < p.rec.mask.length; k++) if (p.rec.mask[k] === 2) {
                    wet++; const d = planeToDir(f.x0 + (k % f.nx + .5) * f.spacing, f.y0 + (Math.floor(k / f.nx) + .5) * f.spacing, f, R);
                    const [x, y] = dirToPlane(d, rec.frame, R), ix = Math.floor((x - rec.frame.x0) / rec.frame.spacing), iy = Math.floor((y - rec.frame.y0) / rec.frame.spacing);
                    if (ix >= 0 && iy >= 0 && ix < rec.frame.nx && iy < rec.frame.ny && rec.mask[iy * rec.frame.nx + ix] === 2) covered++;
                }
                return { wet, covered, oldLevel: p.rec.level, merged: !!p.mergedPond };
            });
            break;
        }
        result.push({ members: members.length, attempts });
    }
    return { total: groups.length, result };
}

export async function graphMountainCensus() {
    const s = window.gameEngine.waterService, { pondOverlapGroups } = await import('/core/world/hydrology/pondOverlapGroups.js');
    const { patchRectsMayOverlap } = await import('/core/world/hydrology/patchOverlap.js');
    const { planeToDir, dirToPlane } = await import('/core/world/hydrology/lakeRefine.js');
    const all = [...s.refined].filter(([id, r]) => r.frame && r.mask && s.rep(id) === id)
        .map(([id, rec]) => ({ id, rec, mountain: !!s.lakes[id]?.mountain }));
    const graphs = all.filter(p => !p.mountain), mountains = all.filter(p => p.mountain), overlaps = [];
    const extent = f => Math.hypot(Math.max(Math.abs(f.x0), Math.abs(f.x0 + f.nx * f.spacing)),
        Math.max(Math.abs(f.y0), Math.abs(f.y0 + f.ny * f.spacing)));
    for (const graph of graphs) {
        const a = graph.rec.frame, ar = extent(a);
        for (const mountain of mountains) {
            const b = mountain.rec.frame, br = extent(b);
            if (Math.hypot(...a.c.map((v, i) => v - b.c[i])) * s.radius > ar + br + 1) continue;
            if (patchRectsMayOverlap(a, b, s.radius) && pondOverlapGroups([graph, mountain], s.radius).length) {
                let wet = 0, covered = 0, boundary = 0;
                for (let k = 0; k < mountain.rec.mask.length; k++) if (mountain.rec.mask[k] === 2) {
                    wet++; const d = planeToDir(b.x0 + (k % b.nx + .5) * b.spacing, b.y0 + (Math.floor(k / b.nx) + .5) * b.spacing, b, s.radius);
                    const [x, y] = dirToPlane(d, a, s.radius), i = Math.floor((x - a.x0) / a.spacing), j = Math.floor((y - a.y0) / a.spacing);
                    if (i >= 0 && j >= 0 && i < a.nx && j < a.ny && graph.rec.mask[j * a.nx + i] === 2) covered++;
                    else {
                        let near = false;
                        for (let yy = -2; yy <= 2 && !near; yy++) for (let xx = -2; xx <= 2; xx++) {
                            if (i + xx >= 0 && j + yy >= 0 && i + xx < a.nx && j + yy < a.ny && graph.rec.mask[(j + yy) * a.nx + i + xx] === 2) { near = true; break; }
                        }
                        if (near) boundary++;
                    }
                }
                overlaps.push({ graph: graph.id, mountain: mountain.id, levels: [graph.rec.level, mountain.rec.level], wet, covered, boundary });
            }
        }
    }
    return { graph: graphs.length, mountains: mountains.length, overlaps };
}

// Solve both original pond seeds in one shared, larger terrain patch. This
// distinguishes a nested sub-basin from inconsistent patch spill levels.
export async function comparePondSeeds() {
    const s = window.gameEngine.waterService, R = s.radius;
    const { hashParts } = await import('/core/world/hydrology/waterCache.js');
    const { MOUNTAIN_LAKE_DEFAULTS } = await import('/core/world/hydrology/mountainLakes.js');
    const { planeToDir, dirToPlane, growPatchFrame } = await import('/core/world/hydrology/lakeRefine.js');
    const P = { ...MOUNTAIN_LAKE_DEFAULTS, ...s.config.refine.mountain };
    const key = `mlakes:${s._key}:${hashParts([4, P, s.config.refine.bandM])}`;
    const old = await s._cache.get(key);
    if (!old) throw new Error('Original mountain cache unavailable');
    const base = s.lakes.findIndex(l => l.mountain), pair = [old[2858 - base], old[2859 - base]];
    if (pair.some(p => !p?.pond)) throw new Error('Original pond IDs changed');
    const basis = pair[1].rec.frame;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const p of pair) {
        const f = p.rec.frame;
        for (const x of [f.x0, f.x0 + f.nx * f.spacing]) for (const y of [f.y0, f.y0 + f.ny * f.spacing]) {
            const xy = dirToPlane(planeToDir(x, y, f, R), basis, R);
            xmin = Math.min(xmin, xy[0]); xmax = Math.max(xmax, xy[0]);
            ymin = Math.min(ymin, xy[1]); ymax = Math.max(ymax, xy[1]);
        }
    }
    const spacing = 32, margin = 1500;
    let frame = { c: basis.c, e1: basis.e1, e2: basis.e2, spacing,
        x0: xmin - margin, y0: ymin - margin, nx: Math.ceil((xmax - xmin + 2 * margin) / spacing), ny: Math.ceil((ymax - ymin + 2 * margin) / spacing) };
    const attempts = [];
    let found = false;
    for (let grow = 0; grow <= 3; grow++) {
        const heights = await s._sampler.samplePatch(frame, R), results = [];
        for (const p of pair) {
            const h = heights.slice();
            const result = await s._client.call({ type: 'solvePatchLake', lakeId: -1, frame, heights: h, bandM: s.config.refine.bandM,
                N: s.N, R, seedDir: p.dir, others: new Float64Array(0) }, [h.buffer]);
            const oldStart = p.path?.[0];
            const exitM = oldStart && result.exitDir ? Math.acos(Math.max(-1, Math.min(1, oldStart.reduce((v, x, i) => v + x * result.exitDir[i], 0)))) * R : null;
            results.push({ oldLevel: p.rec.level, status: result.status, level: result.level, areaM2: result.areaM2, cells: result.cells,
                distanceToOldPathM: exitM, outflowPoints: result.outflowDirs?.length, oldPathPoints: p.path?.length });
        }
        attempts.push({ frame: { nx: frame.nx, ny: frame.ny, spacing }, results });
        if (results.every(r => r.status !== 'grow')) { if (found) break; found = true; }
        frame = growPatchFrame(frame, 1.6);
    }
    return { attempts };
}
