// tools/perf/riverBanks/transectProbe.js
//
// Page side (pageProbe.mjs): a cross-section of the drawn ground (carved
// sampler: the height function with the river carve and valley, without
// the tiles' micro detail) and the natural ground, every stepM across the
// river point nearest the pose's look target. Steps and creases in the
// height function show as jumps in the height or its slope.

export async function transectAt({ view, halfM = 30, stepM = 0.05 }) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin;
    const { riverShapeAt } = await import('/core/world/water/riverShapeNoise.js');
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const target = norm([view.look[0] - o.x, view.look[1] - o.y, view.look[2] - o.z]);
    let best = null;
    for (const [rid, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        for (let k = 1; k + 1 < n; k++) {
            const c = target[0] * P[k * st] + target[1] * P[k * st + 1] + target[2] * P[k * st + 2];
            if (!best || c > best.c) best = { c, rid, rec, k };
        }
    }
    const { rid, rec, k } = best, P = rec.points, st = rec.stride, arc = w._arcLengths(rec);
    const at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    const d = at(k), left = norm(cross(d, norm(at(k + 1).map((v, i) => v - at(k - 1)[i]))));
    const hw = P[k * st + 4], off = riverShapeAt(arc[k], rid, Math.max(hw, 0.5), { ...(w.carve ?? {}), bankDetail: 0 }).off;
    const ns = [], dirs = [];
    for (let m = -halfM - hw; m <= halfM + hw + 1e-9; m += stepM) {
        ns.push(m);
        dirs.push(...norm(d.map((v, i) => v + left[i] * (off + m) / R)), 0);
    }
    const carved = Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    const natural = Array.from(await s._sampler.sampleDirsNatural(Float32Array.from(dirs)));
    // Largest jumps in height and in slope between neighbouring samples.
    const jumps = [];
    for (let i = 2; i < carved.length; i++) {
        const s1 = (carved[i] - carved[i - 1]) / stepM, s0 = (carved[i - 1] - carved[i - 2]) / stepM;
        jumps.push({ n: +ns[i].toFixed(2), x: +(Math.abs(ns[i]) - hw).toFixed(2), dh: +(carved[i] - carved[i - 1]).toFixed(4), dSlope: +(s1 - s0).toFixed(3) });
    }
    const top = [...jumps].sort((a, b) => Math.abs(b.dSlope) - Math.abs(a.dSlope)).slice(0, 12);
    return { rid, k, s: arc[k], hw, level: P[k * st + 16], bed: P[k * st + 3] - P[k * st + 5], stepM, ns, carved, natural, top };
}

// The same cross-section with the river valleys' field switched off
// (WaterGpuData valley params, shared with the sampler), then restored.
export async function transectNoValley(args) {
    const w = window.gameEngine.waterGpuData;
    const { valleyParamsData } = await import('/core/world/water/riverValley.js');
    const q = window.gameEngine.renderer.device?.queue ?? w.device.queue;
    q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, false));
    try { return await transectAt(args); }
    finally { q.writeBuffer(w.valleyParamsBuffer, 0, valleyParamsData(w.valley ?? undefined, true)); }
}

// The same cross-section with the river carve switched off (WaterParams
// carve.x, written each frame from WaterGpuData.carve): the valley field alone.
export async function transectValleyOnly(args) {
    const w = window.gameEngine.waterGpuData, carve = w.carve;
    w.carve = { ...carve, enabled: false };
    await new Promise(r => setTimeout(r, 300));
    try { return await transectAt(args); }
    finally { w.carve = carve; }
}

// Along the river nearest the pose's look target (or the ground under pixel
// px, py of a 1440 x 900 capture, fov 75), through the end that lies
// in a lake (pool -1; the start for an outlet, the end for an inlet): every
// stepM on the centre line the carved and natural ground and the lake's
// level (WaterGpuData.lakeAt, the CPU mask). m is the distance from the
// trace's last point outside the lake, + into the lake. How far the
// cut (natural - carved) reaches past the shore is how far the channel runs
// on as a groove in the lake bed.
export async function profileAlong({ view, px = null, py = null, fromM = -60, toM = 60, stepM = 1 }) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin;
    const { riverShapeAt } = await import('/core/world/water/riverShapeNoise.js');
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
    let target = norm(sub(view.look, [o.x, o.y, o.z]));
    if (px != null) {
        const fwd = norm(sub(view.look, view.pos)), right = norm(cross(fwd, norm(sub(view.pos, [o.x, o.y, o.z])))), up = cross(right, fwd);
        const th = Math.tan(75 * Math.PI / 360), ray = norm(add(fwd, add(mul(right, (2 * (px + 0.5) / 1440 - 1) * th * 1.6), mul(up, (1 - 2 * (py + 0.5) / 900) * th))));
        for (let t = 2; t < 3000; t += 1) {
            const p = sub(add(view.pos, mul(ray, t)), [o.x, o.y, o.z]), d = norm(p);
            if (Math.hypot(...p) - R <= (await s._sampler.sampleDirsCarved(Float32Array.from([...d, 0])))[0]) { target = d; break; }
        }
    }
    let best = null;
    for (const [rid, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        for (let k = 0; k < n; k++) {
            const c = target[0] * P[k * st] + target[1] * P[k * st + 1] + target[2] * P[k * st + 2];
            if (!best || c > best.c) best = { c, rid, rec, k };
        }
    }
    const { rid, rec } = best, P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
    const outlet = P[9] < 0, at = q => [P[q * st], P[q * st + 1], P[q * st + 2]];
    // Centre line at arc length a (clamped to the trace), with the shape's offset.
    const centre = a => {
        let k = 0;
        while (k + 2 < n && arc[k + 1] < a) k++;
        const t = Math.max(0, Math.min(1, (a - arc[k]) / Math.max(arc[k + 1] - arc[k], 1e-6)));
        const d = norm(at(k).map((v, i) => v + (at(k + 1)[i] - v) * t));
        const left = norm(cross(d, norm(at(k + 1).map((v, i) => v - at(k)[i]))));
        const hw = P[k * st + 4] + (P[(k + 1) * st + 4] - P[k * st + 4]) * t;
        const off = riverShapeAt(a, rid, Math.max(hw, 0.5), { ...(w.carve ?? {}), bankDetail: 0 }).off;
        return { d: norm(d.map((v, i) => v + left[i] * off / R)), hw, eta: P[k * st + 3] + (P[(k + 1) * st + 3] - P[k * st + 3]) * t };
    };
    // The lake's end of the in-lake run: the trace's first (outlet) or last (inlet) dry point.
    let kShore = outlet ? 0 : n - 1;
    if (outlet) while (kShore + 1 < n && P[kShore * st + 9] < 0) kShore++;
    else while (kShore > 0 && P[kShore * st + 9] < 0) kShore--;
    const aShore0 = arc[kShore], sign = outlet ? -1 : 1, samples = [];
    for (let m = fromM; m <= toM; m += stepM) samples.push({ a: aShore0 + sign * m, m, ...centre(aShore0 + sign * m) });
    const dirs = samples.flatMap(q => [...q.d, 0]);
    const carved = Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    const natural = Array.from(await s._sampler.sampleDirsNatural(Float32Array.from(dirs)));
    const lake = samples.map(q => w.lakeAt(q.d)?.level ?? null);
    const rows = samples.map((q, i) => ({ m: +q.m.toFixed(1), natural: +natural[i].toFixed(2), carved: +carved[i].toFixed(2),
        cut: +(natural[i] - carved[i]).toFixed(2), lake: lake[i] == null ? null : +lake[i].toFixed(2), eta: +q.eta.toFixed(2), hw: +q.hw.toFixed(1),
        pos: q.d.map((v, j) => +(v * (R + carved[i]) + [o.x, o.y, o.z][j]).toFixed(1)) }));
    const groove = rows.filter(r => r.m > 0 && r.cut > 0.1);
    return { rid, outlet, kShore, grooveEndM: groove.length ? groove[groove.length - 1].m : 0, rows };
}
