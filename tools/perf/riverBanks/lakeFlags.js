// tools/perf/riverBanks/lakeFlags.js
//
// Page side: the traced rivers near the camera and their reaches flagged as
// in a lake (point field 9, pool < 0), with how many of those points a drawn
// lake actually covers (WaterGpuData.lakeAt). Flagged points get no bed
// material, no containment and other lake handling.

/** lakeFlags at a pose ({ name, pos, look }), once its nearby rivers are traced and the scene settled. */
export async function lakeFlagsAt(view) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    return lakeFlags({});
}

export function lakeFlags({ rangeM = 1500 } = {}) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin;
    const p = g.camera.position, cam = [p.x - o.x, p.y - o.y, p.z - o.z];
    const out = [];
    for (const [rid, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        let near = false;
        for (let k = 0; k < n && !near; k++) {
            const r = R + P[k * st + 3];
            near = Math.hypot(P[k * st] * r - cam[0], P[k * st + 1] * r - cam[1], P[k * st + 2] * r - cam[2]) < rangeM;
        }
        if (!near) continue;
        const runs = [];
        let run = null;
        for (let k = 0; k < n; k++) {
            const flagged = P[k * st + 9] < 0;
            if (flagged && !run) run = { from: k, s0: Math.round(arc[k]), points: 0, covered: 0 };
            if (flagged) {
                run.points++;
                if (w.lakeAt([P[k * st], P[k * st + 1], P[k * st + 2]])) run.covered++;
                run.to = k; run.s1 = Math.round(arc[k]);
            }
            if (!flagged && run) { runs.push(run); run = null; }
        }
        if (run) runs.push(run);
        out.push({ rid, lengthM: Math.round(arc[n - 1]), points: n, src: rec.src, dest: rec.dest, flaggedRuns: runs });
    }
    return out;
}
