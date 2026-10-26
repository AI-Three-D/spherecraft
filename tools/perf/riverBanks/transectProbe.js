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
