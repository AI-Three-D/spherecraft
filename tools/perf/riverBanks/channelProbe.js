// tools/perf/riverBanks/channelProbe.js
//
// Page side (pageProbe.mjs): along the traced rivers near a pose, the drawn
// ground (carved sampler) at the channel's centre (the traced line moved by
// the wobble) every ~2 m, against the river's water level. Runs where the
// channel's floor is above the water are dry channel: no bed material
// there, no water seen.

export async function channelAt(view) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin;
    const { riverShapeAt } = await import('/core/world/water/riverShapeNoise.js');
    const shape = { ...(w.carve ?? {}), bankDetail: 0 };
    const p = g.camera.position, cam = [p.x - o.x, p.y - o.y, p.z - o.z];
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const out = [];
    for (const [rid, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        const at = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
        if (![...Array(n).keys()].some(k => { const r = R + P[k * st + 3]; const d = at(k); return Math.hypot(d[0] * r - cam[0], d[1] * r - cam[1], d[2] * r - cam[2]) < 1500; })) continue;
        const dirs = [], meta = [];
        for (let k = 0; k + 1 < n; k++) {
            const a = at(k), b = at(k + 1), L = Math.max(1, Math.round((arc[k + 1] - arc[k]) / 2));
            const left = norm(cross(a, norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]])));
            for (let i = 0; i < L; i++) {
                const t = i / L, d = norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
                const sArc = arc[k] + (arc[k + 1] - arc[k]) * t, hw = P[k * st + 4] + (P[(k + 1) * st + 4] - P[k * st + 4]) * t;
                const off = riverShapeAt(sArc, rid, Math.max(hw, 0.5), shape).off;
                dirs.push(...norm([d[0] + left[0] * off / R, d[1] + left[1] * off / R, d[2] + left[2] * off / R]), 0);
                meta.push({ s: sArc, wl: P[k * st + 16] + (P[(k + 1) * st + 16] - P[k * st + 16]) * t, pool: P[k * st + 9] });
            }
        }
        const h = await s._sampler.sampleDirsCarved(Float32Array.from(dirs));
        const runs = [];
        let run = null;
        meta.forEach((m, i) => {
            const dry = h[i] > m.wl - 0.05;
            if (dry && !run) run = { s0: Math.round(m.s), maxAboveM: 0 };
            if (dry) { run.s1 = Math.round(m.s); run.maxAboveM = Math.max(run.maxAboveM, +(h[i] - m.wl).toFixed(2)); run.inLake = m.pool < 0; }
            if (!dry && run) { runs.push(run); run = null; }
        });
        if (run) runs.push(run);
        const depth = meta.map((m, i) => m.wl - h[i]).sort((x, y) => x - y);
        out.push({ rid, lengthM: Math.round(arc[n - 1]), samples: meta.length, dryRuns: runs,
            depthP10: +depth[Math.floor(depth.length * 0.1)].toFixed(2), depthP50: +depth[depth.length >> 1].toFixed(2) });
    }
    return out;
}
