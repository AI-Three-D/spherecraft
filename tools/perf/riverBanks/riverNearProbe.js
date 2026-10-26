// tools/perf/riverBanks/riverNearProbe.js
//
// The traced river point nearest a world position and its neighbours: arc
// length, level, bed, half-width, pool flag, lake guard, and the lake (id,
// level) the water data finds there (WaterGpuData.lakeAt).
export async function riverNearProbe({ pos, span = 12 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    const o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const v = [pos[0] - o.x, pos[1] - o.y, pos[2] - o.z], l = Math.hypot(...v), dir = v.map(x => x / l);
    let best = null;
    for (const [id, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride;
        for (let k = 0; k < P.length / st; k++) {
            const d = R * Math.acos(Math.min(1, P[k * st] * dir[0] + P[k * st + 1] * dir[1] + P[k * st + 2] * dir[2]));
            if (!best || d < best.d) best = { d, id, rec, k };
        }
    }
    if (!best) return null;
    const { rec, k } = best, P = rec.points, st = rec.stride, rows = [];
    for (let i = Math.max(0, k - span); i < Math.min(P.length / st, k + span); i++) {
        const a = i * st, lake = g.waterGpuData.lakeAt?.([P[a], P[a + 1], P[a + 2]]);
        rows.push({ i, eta: +P[a + 3].toFixed(2), hw: +P[a + 4].toFixed(1), depth: +P[a + 5].toFixed(2), pool: P[a + 9],
            ground: +P[a + 13].toFixed(2), wl: +P[a + 16].toFixed(2), lakeGuard: P[a + 18] < -1e10 ? null : +P[a + 18].toFixed(2),
            lake: lake ? JSON.stringify(lake).slice(0, 60) : null });
    }
    return { river: best.id, nearestM: Math.round(best.d), points: P.length / st, rows };
}

// Every river with points within radiusM of pos: its points there flagged in a
// lake (pool -1) and their fit ground (field 13) against the lake guard (18).
export async function riversNearProbe({ pos, radiusM = 400 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    const o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const v = [pos[0] - o.x, pos[1] - o.y, pos[2] - o.z], l = Math.hypot(...v), dir = v.map(x => x / l);
    const out = [];
    for (const [id, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        const near = [];
        for (let k = 0; k < n; k++) {
            const d = R * Math.acos(Math.min(1, P[k * st] * dir[0] + P[k * st + 1] * dir[1] + P[k * st + 2] * dir[2]));
            if (d < radiusM) near.push(k);
        }
        if (!near.length) continue;
        const inLake = near.filter(k => P[k * st + 9] < 0);
        out.push({ id, points: n, near: [near[0], near.at(-1)], inLake: inLake.length,
            inLakeGroundMinusGuard: inLake.map(k => +(P[k * st + 13] - P[k * st + 18]).toFixed(2)).slice(0, 12),
            hwNear: near.map(k => +P[k * st + 4].toFixed(1)).slice(0, 12),
            nearest: near.map(k => ({ k, dM: Math.round(R * Math.acos(Math.min(1, P[k * st] * dir[0] + P[k * st + 1] * dir[1] + P[k * st + 2] * dir[2]))), eta: +P[k * st + 3].toFixed(2) }))
                .sort((a, b) => a.dM - b.dM).slice(0, 4) });
    }
    return out;
}
