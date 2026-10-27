// tools/perf/riverBanks/facetProbe.js
//
// Page side (pageProbe.mjs). The ground point under a screen pixel of a
// pose (ray marched against the carved height, fov 75, 1440 x 900), then a
// grid of halfM around it every stepM: per grid point the nearest traced
// river (within 140 m), its nearest segment and second-nearest segment and
// the carved height. Lines where the nearest segment jumps by more than one
// (inside tight bends) are hard switches the carve's joint blend does not
// cover.
export async function facetAt({ view, px, py, halfM = 60, stepM = 3 }) {
    const g = window.gameEngine, s = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
    const norm = a => mul(a, 1 / Math.hypot(...a)), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const pos = view.pos, fwd = norm(sub(view.look, pos)), up0 = norm(sub(pos, [o.x, o.y, o.z]));
    const right = norm(cross(fwd, up0)), up = cross(right, fwd);
    const th = Math.tan(75 * Math.PI / 360), asp = 1440 / 900;
    const ray = norm(add(fwd, add(mul(right, (2 * (px + 0.5) / 1440 - 1) * th * asp), mul(up, (1 - 2 * (py + 0.5) / 900) * th))));
    const heightAt = async (pts) => {
        const dirs = [];
        for (const p of pts) { const d = norm(sub(p, [o.x, o.y, o.z])); dirs.push(d[0], d[1], d[2], 0); }
        return Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    };
    // March: 2 m steps up to 3 km, then bisect.
    let t0 = 0, hit = null;
    for (let t = 2; t < 3000; t += 2) {
        const p = add(pos, mul(ray, t)), [h] = await heightAt([p]);
        if (Math.hypot(...sub(p, [o.x, o.y, o.z])) - R <= h) { hit = t; break; }
        t0 = t;
    }
    if (hit == null) return { error: 'no hit' };
    for (let i = 0; i < 12; i++) {
        const m = (t0 + hit) / 2, p = add(pos, mul(ray, m)), [h] = await heightAt([p]);
        if (Math.hypot(...sub(p, [o.x, o.y, o.z])) - R <= h) hit = m; else t0 = m;
    }
    const at = add(pos, mul(ray, hit)), atDir = norm(sub(at, [o.x, o.y, o.z]));
    // Grid in the tangent plane.
    const e1 = norm(cross(atDir, [0, 1, 0.0001])), e2 = cross(atDir, e1);
    const n = Math.round(2 * halfM / stepM) + 1, dirs = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const u = -halfM + i * stepM, v = -halfM + j * stepM;
        dirs.push(norm(add(atDir, add(mul(e1, u / R), mul(e2, v / R)))));
    }
    const flat = [];
    for (const d of dirs) flat.push(d[0], d[1], d[2], 0);
    const h = Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(flat)));
    const nearest = dirs.map(d => {
        let best = null;
        for (const [id, rec] of s.riverRecs) {
            const P = rec.points, st = rec.stride, m = P.length / st;
            for (let k = 0; k + 1 < m; k++) {
                const a = [P[k * st], P[k * st + 1], P[k * st + 2]], b = [P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]];
                const ab = sub(b, a), tt = Math.min(1, Math.max(0, (sub(d, a).reduce((x, v, i) => x + v * ab[i], 0)) / ab.reduce((x, v) => x + v * v, 1e-30)));
                const dist = Math.hypot(...sub(d, add(a, mul(ab, tt)))) * R;
                if (dist < 140 && (!best || dist < best.dist)) best = { id, k, dist, t: tt };
            }
        }
        return best;
    });
    // Neighbouring grid points whose nearest segment jumps by more than one.
    const jumps = [];
    for (let j = 0; j < n; j++) for (let i = 0; i + 1 < n; i++) {
        const a = nearest[j * n + i], b = nearest[j * n + i + 1];
        if (a && b && a.id === b.id && Math.abs(a.k - b.k) > 1) jumps.push([i, j, a.k, b.k, Math.round(a.dist)]);
    }
    return { hitM: +hit.toFixed(1), at: at.map(v => +v.toFixed(1)), n, stepM,
        segment: nearest.map(x => x ? x.k : -1), dist: nearest.map(x => x ? Math.round(x.dist) : -1), height: h.map(v => +v.toFixed(2)), jumps: jumps.slice(0, 40), jumpCount: jumps.length };
}

// After posing views in order (as a capture run does), the ground point under
// pixel (px, py) of the last one and every traced river with a point within
// radiusM of it: nearest distance (m), its level there, half-width, and
// whether the water data draws it (WaterGpuData.isRiverDrawn).
export async function riversUnderPixel({ views, px, py, radiusM = 80 }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    for (const v of views) await q.poseView(v);
    const view = views.at(-1);
    const g = window.gameEngine, s = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
    const norm = a => mul(a, 1 / Math.hypot(...a)), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const pos = view.pos, fwd = norm(sub(view.look, pos)), up0 = norm(sub(pos, [o.x, o.y, o.z]));
    const right = norm(cross(fwd, up0)), up = cross(right, fwd), th = Math.tan(75 * Math.PI / 360), asp = 1440 / 900;
    const ray = norm(add(fwd, add(mul(right, (2 * (px + 0.5) / 1440 - 1) * th * asp), mul(up, (1 - 2 * (py + 0.5) / 900) * th))));
    const hAt = async (p) => { const d = norm(sub(p, [o.x, o.y, o.z])); return (await s._sampler.sampleDirsCarved(Float32Array.from([d[0], d[1], d[2], 0])))[0]; };
    let t0 = 0, hit = null;
    for (let t = 2; t < 3000; t += 2) { const p = add(pos, mul(ray, t)); if (Math.hypot(...sub(p, [o.x, o.y, o.z])) - R <= await hAt(p)) { hit = t; break; } t0 = t; }
    if (hit == null) return { error: 'no hit' };
    const at = norm(sub(add(pos, mul(ray, hit)), [o.x, o.y, o.z]));
    const rows = [];
    for (const [id, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        let best = null;
        for (let k = 0; k < n; k++) {
            const d = R * Math.acos(Math.min(1, P[k * st] * at[0] + P[k * st + 1] * at[1] + P[k * st + 2] * at[2]));
            if (!best || d < best.d) best = { d, k };
        }
        if (best.d < radiusM) rows.push({ id, k: best.k, n, dM: Math.round(best.d), wl: +P[best.k * st + 16].toFixed(2), hw: +P[best.k * st + 4].toFixed(1),
            drawn: g.waterGpuData.isRiverDrawn(id), src: rec.src, dest: rec.dest });
    }
    // Lakes whose mask covers points along the ray's hit, 0-40 m up and down the view.
    const lakes = [];
    for (let dy = -40; dy <= 40; dy += 4) {
        const p = norm(add(at, mul(fwd, dy / R)));
        const l = g.waterGpuData.lakeAt(p);
        if (l) lakes.push({ dy, ...l });
    }
    return { hitM: Math.round(hit), rows, lakes };
}

// After posing views in order: the water data's river lists along river id
// (points k0..k1, every stepM): per sample the sub-cell, how many segments
// its list holds and which of the river's segments (first..last index into
// the GPU list, and the river's segment numbers found there).
export async function riverListsAlong({ views, id, k0, k1, stepM = 4 }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    for (const v of views) await q.poseView(v);
    const { dirToCellSub } = await import('/core/world/hydrology/waterGraph.js');
    const g = window.gameEngine, w = g.waterGpuData, s = g.waterService, R = g.planetConfig.radius;
    const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, arc = w._arcLengths(rec);
    const SS = w.subPerCell, cells = w.cells, F = 36, rows = [];
    const stats = { riverCells: w._riverCells?.size, maxRiverCells: w.maxRiverCells, segs: w.riverSegCount, maxSegs: w.maxRiverSegs, dropped: w._droppedRivers };
    for (let k = k0; k < k1; k++) {
        const L = arc[k + 1] - arc[k];
        for (let x = 0; x < L; x += stepM) {
            const t = x / L, d = [0, 1, 2].map(i => P[k * st + i] + (P[(k + 1) * st + i] - P[k * st + i]) * t), l = Math.hypot(...d);
            const cs = dirToCellSub(d.map(v => v / l), w.N, Math.round(Math.sqrt(SS)));
            const c = Math.floor(cs / SS), sub = cs % SS;
            const block = w.index[cells + c] & 0x1ffff;
            const e = block ? w.index[2 * cells + (block - 1) * SS + sub] : 0;
            const first = e >>> 8, count = e & 0xff, segs = [];
            for (let m = 0; m < count; m++) {
                const o = (first + m) * F;
                segs.push(+w._segs[o + 20].toFixed(0));
            }
            rows.push({ s: +(arc[k] + x).toFixed(0), k, c, sub, count, arcs: segs.slice(0, 12) });
        }
    }
    return { stats, rows };
}

// After posing views in order: the near river ribbon as the renderer lists it
// (buildRiverRibbons at its listed camera) for river id: per row its level,
// centre's distance from the given point (m) and the rows' order along the
// river; and how many ribbon quads contain the point's direction.
export async function ribbonRowsNear({ views, id, near, count = 30 }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    for (const v of views) await q.poseView(v);
    await new Promise(r => setTimeout(r, 1500));
    const g = window.gameEngine, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const nw = (g.renderer?.terrainModule ?? g.renderer?.frontend?.terrainModule ?? window.frontend?.terrainModule)?.nearWater;
    const { buildRiverRibbons, RIBBON_POINT_FLOATS } = await import('/core/world/water/riverRibbon.js');
    const rel = nw?._listedAt;
    const rec = w._appliedRivers.get(id);
    const { points, quads } = buildRiverRibbons({ rivers: [[id, rec]], arcOf: (r) => w._arcLengths(r), camera: rel, rangeM: w.near.fadeEndM + 10,
        R, origin: o, shape: w.carve ?? {}, lakeAt: (d) => w.lakeAt(d) });
    const F = RIBBON_POINT_FLOATS, n = points.length / F, rows = [];
    const p = Array.isArray(near) ? near.map((v, i) => v - [o.x, o.y, o.z][i])
        : [0, 1, 2].map(j => rec.points[near.k * rec.stride + j] * (R + rec.points[near.k * rec.stride + 16]));
    for (let i = 0; i < n; i++) {
        const c = [0, 1, 2].map(j => (points[i * F + j] + points[i * F + 4 + j]) / 2 - [o.x, o.y, o.z][j]);
        rows.push({ i, level: +points[i * F + 7].toFixed(3), dM: +Math.hypot(...c.map((v, j) => v - p[j])).toFixed(1), width: +Math.hypot(...[0, 1, 2].map(j => points[i * F + j] - points[i * F + 4 + j])).toFixed(1) });
    }
    rows.sort((a, b) => a.dM - b.dM);
    return { listedAt: rel ? [rel.x, rel.y, rel.z].map(v => +v.toFixed(1)) : null, rendererFound: !!nw, quadCount: nw?._quadCount, rows: rows.slice(0, count).sort((a, b) => a.i - b.i) };
}
