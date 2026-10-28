// tools/perf/riverBanks/mouthDepth.js
//
// Page side (pageProbe.mjs / probeBatch.js): the ground around a river point
// seen from above, in the river's frame at point k of river id (along the
// flow +, across + left): per cell the carved ground (sampler: height
// function with carve and valley, no micro detail), the natural ground, and
// the water above it (the CPU lake mask's level, else the river's level
// within its half-width + 2 m). Rows are along (downstream at the top).
// mode 'depth': water depth (dm, '.' dry); 'cut': natural - carved (dm,
// '-' where carved is above natural: fill); 'rel': carved - ref (dm).
// River id's record at the current solve version: traced now if it is not
// yet (after a RIVER_SOLVE_VERSION bump rivers re-trace in the background),
// then a few seconds for its segments to reach the GPU (the carve).
async function ensureRiver(id) {
    const svc = window.gameEngine.waterService;
    if (svc.riverRecs?.get(id)) return svc.riverRecs.get(id);
    for (let t = 0; t < 1200 && !svc.riverRecs?.get(id); t++) { if (!svc._busy) await svc.refineRiver(id); await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 3000));
    return svc.riverRecs.get(id);
}

export async function depthMap({ id, k, alongM = [-60, 120], acrossM = 60, stepM = 4, ref = null, beyondEnd = true, mode = 'depth', withCells = false }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius;
    const rec = await ensureRiver(id), P = rec.points, st = rec.stride, n = P.length / st;
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
    const d0 = at(k), t = norm(at(k1).map((v, i) => v - at(k0)[i])), left = norm(cross(d0, t));
    const cells = [], dirs = [];
    for (let a = alongM[1]; a >= alongM[0] - 1e-9; a -= stepM) {
        for (let c = -acrossM; c <= acrossM + 1e-9; c += stepM) {
            const d = norm(d0.map((v, i) => v + (t[i] * a + left[i] * c) / R));
            cells.push({ a, c, d });
            dirs.push(...d, 0);
        }
    }
    const carved = await s._sampler.sampleDirsCarved(Float32Array.from(dirs));
    const natural = await s._sampler.sampleDirsNatural(Float32Array.from(dirs));
    // The nearest point of this river (segment-wise) for its level and half-width.
    const near = (d) => {
        let best = null;
        for (let q = 0; q + 1 < n; q++) {
            const A = at(q), B = at(q + 1), ab = B.map((v, i) => v - A[i]);
            const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
            const raw = ((d[0] - A[0]) * ab[0] + (d[1] - A[1]) * ab[1] + (d[2] - A[2]) * ab[2]) / Math.max(L2, 1e-30);
            const tt = Math.max(0, Math.min(1, raw)), dist = Math.hypot(...d.map((v, i) => v - A[i] - ab[i] * tt)) * R;
            if ((!beyondEnd && (raw > 1 && q + 2 === n)) || (best && dist >= best.dist)) continue;
            best = { dist, eta: P[q * st + 3] + (P[(q + 1) * st + 3] - P[q * st + 3]) * tt, hw: P[q * st + 4] + (P[(q + 1) * st + 4] - P[q * st + 4]) * tt, past: raw > 1 && q + 2 === n };
        }
        return best;
    };
    const lines = [], depthRows = [];
    let row = '', lastA = null, header = '      ';
    for (let c = -acrossM; c <= acrossM + 1e-9; c += stepM) header += (Math.round(c) % 20 === 0 ? String(Math.round(c)) : '').padStart(4);
    lines.push(header);
    for (let i = 0; i < cells.length; i++) {
        const { a, c, d } = cells[i];
        if (a !== lastA) { if (lastA !== null) lines.push(row); row = String(Math.round(a)).padStart(5) + ' '; lastA = a; }
        const lake = w.lakeAt(d)?.level;
        const r = near(d);
        const riverWl = r && !r.past && r.dist <= r.hw + 2 ? r.eta : -1e9;
        const wl = Math.max(lake ?? -1e9, riverWl);
        const depth = wl - carved[i];
        const v = ref != null ? (carved[i] - ref) * 10 : (natural[i] - carved[i]) * 10;
        depthRows.push({ a, c, carved: +carved[i].toFixed(2), natural: +natural[i].toFixed(2), wl: wl > -1e8 ? +wl.toFixed(2) : null, lake: lake ?? null });
        const cellStr = ref != null || mode === 'cut'
            ? (v < -0.5 ? '-' + String(Math.min(9, Math.round(-v))) : String(Math.min(99, Math.round(v))))
            : (depth > 0 ? String(Math.min(99, Math.round(depth * 10))) : '.');
        row += cellStr.padStart(4);
    }
    lines.push(row);
    return { id, k, n, eta: P[k * st + 3], hw: P[k * st + 4], waterDepth: P[k * st + 5], map: lines.join('\n'), cells: withCells ? depthRows : undefined };
}

// Along river id's centre line (record points, no shape offset) from point
// k0 to the end and on past it (beyondM): carved, natural, the lake mask's
// level and the river's level; water = max(lake, river) - carved.
export async function alongEnd({ id, k0 = 0, beyondM = 80, stepM = 2 }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData;
    const rec = await ensureRiver(id), P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const samples = [];
    for (let a = arc[k0]; a <= arc[n - 1] + beyondM + 1e-9; a += stepM) {
        let q = k0;
        while (q + 2 < n && arc[q + 1] < a) q++;
        const tt = (a - arc[q]) / Math.max(arc[q + 1] - arc[q], 1e-6);
        const d = norm(at(q).map((v, i) => v + (at(q + 1)[i] - v) * tt));
        const c = Math.min(1, tt);
        samples.push({ s: a - arc[n - 1], d, eta: P[q * st + 3] + (P[(q + 1) * st + 3] - P[q * st + 3]) * c, hw: P[q * st + 4] + (P[(q + 1) * st + 4] - P[q * st + 4]) * c,
            depth: P[q * st + 5] + (P[(q + 1) * st + 5] - P[q * st + 5]) * c, pool: P[(tt < 0.5 ? q : q + 1) * st + 9] });
    }
    const dirs = samples.flatMap(x => [...x.d, 0]);
    const carved = await s._sampler.sampleDirsCarved(Float32Array.from(dirs));
    const natural = await s._sampler.sampleDirsNatural(Float32Array.from(dirs));
    return samples.map((x, i) => {
        const lake = w.lakeAt(x.d)?.level ?? null;
        const wl = Math.max(lake ?? -1e9, x.s <= 0 ? x.eta : -1e9);
        return { s: +x.s.toFixed(1), carved: +carved[i].toFixed(2), natural: +natural[i].toFixed(2), lake: lake == null ? null : +lake.toFixed(2),
            eta: +x.eta.toFixed(2), hw: +x.hw.toFixed(1), recDepth: +x.depth.toFixed(2), pool: x.pool, water: +(wl - carved[i]).toFixed(2) };
    });
}

// Cross-sections at river id's points ks (every stepM over +-halfM, + left
// of the flow, along the record's line without the shape's offset): the
// carved ground minus the point's water level, with the terms switched:
// both, the valley field off, the carve off (the valley alone), natural.
export async function crossAt({ id, ks, halfM = 120, stepM = 4 }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius;
    const rec0 = await ensureRiver(id), n0 = rec0.points.length / rec0.stride;
    // The camera over the river: only rivers near it reach the GPU (the carve).
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).riverView(id, ks[Math.floor(ks.length / 2)] / (n0 - 1), { height: 200, back: 150 });
    const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dirs = [], meta = [];
    for (const k of ks) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1), d0 = at(k);
        const left = norm(cross(d0, norm(at(k1).map((v, i) => v - at(k0)[i]))));
        for (let m = -halfM; m <= halfM + 1e-9; m += stepM) dirs.push(...norm(d0.map((v, i) => v + left[i] * m / R)), 0);
        meta.push({ k, wl: P[k * st + 16], hw: P[k * st + 4], wd: P[k * st + 5] });
    }
    const D = Float32Array.from(dirs), q = g.renderer.device?.queue ?? w.device.queue;
    const { valleyParamsData } = await import('/core/world/water/riverValley.js');
    const both = await s._sampler.sampleDirsCarved(D), natural = await s._sampler.sampleDirsNatural(D);
    q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, false));
    let noValley;
    try { noValley = await s._sampler.sampleDirsCarved(D); } finally { q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, true)); }
    const carve = w.carve;
    w.carve = { ...carve, enabled: false };
    await new Promise(r => setTimeout(r, 300));
    let noCarve;
    try { noCarve = await s._sampler.sampleDirsCarved(D); } finally { w.carve = carve; }
    const per = Math.round(2 * halfM / stepM) + 1;
    return meta.map((m, j) => {
        const row = (A) => Array.from({ length: per }, (_, i) => +(A[j * per + i] - m.wl).toFixed(2));
        return { ...m, offsets: Array.from({ length: per }, (_, i) => -halfM + i * stepM), both: row(both), noValley: row(noValley), noCarve: row(noCarve), natural: row(natural) };
    });
}

// The valley field's two stages across river id at points ks (relative to
// each point's water level): natural - the 16 m cut field as baked
// (riverLandscape.js, bilinear, max over the traced rivers), and the
// shader's valley field alone (64 m texels, C2 B-spline; carve off).
export async function valleyStages({ id, ks, halfM = 120, stepM = 4 }) {
    const g = window.gameEngine, s = g.waterService, R = g.planetConfig.radius;
    const cross = await crossAt({ id, ks, halfM, stepM });
    const { riverIncisionSampler } = await import('/core/world/hydrology/riverLandscape.js');
    const fields = [...s.riverRecs.values()].filter(r => r.landscape?.cells?.length).map(r => riverIncisionSampler(r.landscape, R));
    const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return cross.map(c => {
        const k = c.k, k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1), d0 = at(k);
        const left = norm(crs(d0, norm(at(k1).map((v, i) => v - at(k0)[i]))));
        const raw = c.offsets.map((m, i) => {
            const d = norm(d0.map((v, j) => v + left[j] * m / R));
            let cut = 0;
            for (const f of fields) cut = Math.max(cut, f(d));
            return +(c.natural[i] - cut).toFixed(2);
        });
        return { k, wl: c.wl, hw: c.hw, offsets: c.offsets, natural: c.natural, raw16: raw, shaderValley: c.noCarve, carveOnly: c.noValley, both: c.both };
    });
}

// Along river id from point k0 to k1 at fixed offsets from its traced line
// (+ left of the flow), every stepM of arc: the carved ground, the carve
// alone (valley field off) and the natural ground, minus a straight line
// fitted through each row's ends (periodic bumps show as wiggles).
export async function alongOffsets({ id, k0, k1, offsets = [-20, -35, -50], stepM = 2 }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius;
    const rec0 = await ensureRiver(id), n0 = rec0.points.length / rec0.stride;
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).riverView(id, ((k0 + k1) / 2) / (n0 - 1), { height: 200, back: 150 });
    const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, arc = w._arcLengths(rec);
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dirs = [], rows = [];
    for (const o of offsets) {
        const row = [];
        for (let a = arc[k0]; a <= arc[k1]; a += stepM) {
            let q = k0;
            while (q + 1 < k1 && arc[q + 1] < a) q++;
            const t = (a - arc[q]) / Math.max(arc[q + 1] - arc[q], 1e-6);
            const d = norm(at(q).map((v, i) => v + (at(q + 1)[i] - v) * t));
            const left = norm(crs(d, norm(at(q + 1).map((v, i) => v - at(q)[i]))));
            dirs.push(...norm(d.map((v, i) => v + left[i] * o / R)), 0);
            row.push(+(a - arc[k0]).toFixed(0));
        }
        rows.push({ o, s: row });
    }
    const D = Float32Array.from(dirs), q = g.renderer.device?.queue ?? w.device.queue;
    const { valleyParamsData } = await import('/core/world/water/riverValley.js');
    const both = await s._sampler.sampleDirsCarved(D), natural = await s._sampler.sampleDirsNatural(D);
    q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, false));
    let carveOnly;
    try { carveOnly = await s._sampler.sampleDirsCarved(D); } finally { q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, true)); }
    let i0 = 0;
    const detrend = (A, m) => { const a = A[i0], b = A[i0 + m - 1]; return Array.from({ length: m }, (_, i) => +(A[i0 + i] - (a + (b - a) * i / (m - 1))).toFixed(2)); };
    return rows.map(r => { const m = r.s.length, out = { o: r.o, s: r.s, both: detrend(both, m), carveOnly: detrend(carveOnly, m), natural: detrend(natural, m) }; i0 += m; return out; });
}

// Creases in the carved ground around river id's point k, seen from above in
// the river's frame (rows along the flow, downstream on top; columns across,
// + left): per cell the largest second difference of the height over stepM
// in four directions (cm per stepM^2), river points marked '#'. withValley
// false: the valley field switched off.
export async function creaseMap({ id, k, alongM = [-80, 80], acrossM = 80, stepM = 2, withValley = true }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius;
    const rec0 = await ensureRiver(id), n0 = rec0.points.length / rec0.stride;
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).riverView(id, k / (n0 - 1), { height: 200, back: 150 });
    const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const d0 = at(k), t = norm(at(Math.min(n - 1, k + 1)).map((v, i) => v - at(Math.max(0, k - 1))[i])), left = norm(crs(d0, t));
    const A = [], C = [];
    for (let a = alongM[1]; a >= alongM[0] - 1e-9; a -= stepM) A.push(a);
    for (let c = -acrossM; c <= acrossM + 1e-9; c += stepM) C.push(c);
    const dirs = [];
    for (const a of A) for (const c of C) dirs.push(...norm(d0.map((v, i) => v + (t[i] * a + left[i] * c) / R)), 0);
    const q = g.renderer.device?.queue ?? w.device.queue;
    const { valleyParamsData } = await import('/core/world/water/riverValley.js');
    if (!withValley) q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, false));
    let h;
    try { h = await s._sampler.sampleDirsCarved(Float32Array.from(dirs)); }
    finally { if (!withValley) q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, true)); }
    const W = C.length, H = A.length, v = (i, j) => h[i * W + j];
    const mark = new Set();
    for (let q2 = 0; q2 < n; q2++) {
        const p = at(q2), dv = p.map((x, i) => x - d0[i]);
        const a = Math.round((dv[0] * t[0] + dv[1] * t[1] + dv[2] * t[2]) * R / stepM), c = Math.round((dv[0] * left[0] + dv[1] * left[1] + dv[2] * left[2]) * R / stepM);
        const i = Math.round((alongM[1] / stepM) - a), j = c + Math.round(acrossM / stepM);
        if (i >= 0 && i < H && j >= 0 && j < W) mark.add(i * W + j);
    }
    const rows = [];
    for (let i = 1; i < H - 1; i++) {
        let r = String(A[i]).padStart(5) + ' ';
        for (let j = 1; j < W - 1; j++) {
            if (mark.has(i * W + j)) { r += '#'; continue; }
            const c0 = v(i, j);
            const dd = Math.max(Math.abs(v(i - 1, j) + v(i + 1, j) - 2 * c0), Math.abs(v(i, j - 1) + v(i, j + 1) - 2 * c0),
                Math.abs(v(i - 1, j - 1) + v(i + 1, j + 1) - 2 * c0) / 2, Math.abs(v(i - 1, j + 1) + v(i + 1, j - 1) - 2 * c0) / 2) * 100;
            r += dd < 2 ? ' ' : dd < 5 ? '.' : dd < 10 ? ':' : dd < 20 ? '+' : '*';
        }
        rows.push(r);
    }
    return { id, k, kappa: P[k * st + 12], hw: P[k * st + 4], legend: "second difference cm: ' '<2 '.'<5 ':'<10 '+'<20 '*'>=20, '#' river point", map: rows.join('\n') };
}

// Rivers ending in a lake (their last point in it): the half-width at the
// widest point within 120 m of the entry against 200 m upstream (the delta's
// flare), the water depth there, and a pose looking down at the mouth from
// the land side (height, back m). Waits until tracing has settled (at most
// waitS); sorted by flare.
export async function deltaCensus({ waitS = 120, height = 120, back = 160 } = {}) {
    const g = window.gameEngine, svc = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius, o = g.planetConfig.origin;
    for (let t = 0, last = -1, still = 0; t < waitS * 10 && still < 80; t++) {
        await new Promise(r => setTimeout(r, 100));
        const n = svc.riverRecs.size;
        still = n === last && !svc._busy ? still + 1 : 0; last = n;
    }
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
    const rows = [];
    for (const [id, rec] of svc.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        if (n < 6 || P[(n - 1) * st + 9] >= 0) continue;
        const arc = w._arcLengths(rec);
        let entry = n - 1;
        while (entry > 0 && P[(entry - 1) * st + 9] < 0) entry--;
        let kw = entry, hwMax = 0;
        for (let k = 0; k < n; k++) if (Math.abs(arc[k] - arc[entry]) < 120 && P[k * st + 4] > hwMax) { hwMax = P[k * st + 4]; kw = k; }
        let ku = entry;
        while (ku > 0 && arc[entry] - arc[ku] < 200) ku--;
        const up = at => [P[at * st], P[at * st + 1], P[at * st + 2]];
        const d = up(entry), u = norm(up(ku).map((v, i) => v - d[i])), lvl = P[entry * st + 16];
        const target = d.map((v, i) => v * (R + lvl) + [o.x, o.y, o.z][i]);
        const pos = target.map((v, i) => v + d[i] * height + u[i] * back);
        rows.push({ id, flare: +(hwMax / Math.max(P[ku * st + 4], 0.5)).toFixed(2), hwMouth: +hwMax.toFixed(1), hwUp: +P[ku * st + 4].toFixed(1),
            waterAtMouth: +P[kw * st + 5].toFixed(2), pos: pos.map(v => +v.toFixed(1)), look: target.map(v => +v.toFixed(1)) });
    }
    rows.sort((a, b) => b.flare - a.flare);
    return { rivers: rows.length, flares: rows.map(r => r.flare), top: rows.slice(0, 8) };
}
