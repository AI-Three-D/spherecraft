// Poll the river field and water service at a pose without settling (diagnostics).
export async function watchPose({ pos, look, seconds = 180, everyS = 10 }) {
    const g = window.gameEngine, s = g.waterService, f = g.riverFieldService;
    const v = a => ({ x: a[0], y: a[1], z: a[2] });
    const len = Math.hypot(...pos), up = pos.map(x => x / len);
    window.qtDiag.regional.useCamera({ position: v(pos), target: v(look), up: v(up), fov: 75 });
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
        await new Promise(r => setTimeout(r, everyS * 1000));
        const ts = g.renderer.quadtreeTileManager.tileStreamer;
        out.push({ t: Math.round((performance.now() - t0) / 1000), svcBusy: s._busy, pendingCalls: s._client?._pending.size, traced: s.riverRecs.size,
            failed: s._failedRivers.size, applied: g.waterGpuData._appliedRivers.size, version: g.waterGpuData._appliedVersion,
            worker: (f.workerLog ?? []).slice(-6), field: { stage: f.stage, error: f.lastError, busy: f.busy, idle: f.isIdle, pending: f._pending, revision: f.revision, rivers: f.rivers.size, pages: f.pages.size,
                lastBake: f.history?.at(-1), bakes: f.history?.length, near: f._nearRivers(f._lastDir).length },
            regen: ts.getRegenerationStats() });
    }
    return out;
}
// The near rivers in the order the field bakes them, with their record's size and ranges.
export async function nearRiverInfo({ pos, look }) {
    const g = window.gameEngine, f = g.riverFieldService, w = g.waterGpuData;
    const v = a => ({ x: a[0], y: a[1], z: a[2] });
    const len = Math.hypot(...pos), up = pos.map(x => x / len);
    window.qtDiag.regional.useCamera({ position: v(pos), target: v(look), up: v(up), fov: 75 });
    await new Promise(r => setTimeout(r, 3000));
    return f._nearRivers(up).map(([rid, rec], ri) => {
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        let hwMin = Infinity, hwMax = -Infinity, bad = 0;
        for (let k = 0; k < n; k++) { const hw = P[k * st + 4]; hwMin = Math.min(hwMin, hw); hwMax = Math.max(hwMax, hw); for (let q = 0; q < st; q++) if (!Number.isFinite(P[k * st + q])) bad++; }
        return { ri, rid, n, len: Math.round(arc[n - 1]), hwMin, hwMax, bad, structured: rec.structured === true, mouths: (rec.mouths ?? []).map(m => [Math.round(m.s), m.sign]), dest: rec.dest?.type };
    });
}
