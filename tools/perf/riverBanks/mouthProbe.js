// tools/perf/riverBanks/mouthProbe.js
//
// Where each traced river's mouth flare sits relative to its lake entry:
// from the record (field 4 half-width, 9 pool: -1 in the lake), the arc
// length (m) from the first point of the final in-lake run (the entry) to
// the widest point within 400 m of it, + inside the lake; and how far the
// trace runs on into the lake.
export async function mouthProbe() {
    const svc = window.gameEngine.waterService, R = window.gameEngine.planetConfig.radius, rows = [];
    for (const [id, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        if (n < 4 || P[(n - 1) * st + 9] >= 0) continue;
        const s = [0];
        for (let k = 1; k < n; k++) {
            const a = (k - 1) * st, b = k * st;
            s.push(s[k - 1] + R * Math.acos(Math.min(1, P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2])));
        }
        let entry = n - 1;
        while (entry > 0 && P[(entry - 1) * st + 9] < 0) entry--;
        let widest = entry, hwMax = 0;
        for (let k = 0; k < n; k++) if (Math.abs(s[k] - s[entry]) < 400 && P[k * st + 4] > hwMax) { hwMax = P[k * st + 4]; widest = k; }
        rows.push({ id, entryToWidestM: Math.round(s[widest] - s[entry]), intoLakeM: Math.round(s[n - 1] - s[entry]),
            hwEntry: +P[entry * st + 4].toFixed(1), hwWidest: +hwMax.toFixed(1), hwUp200: +P[s.findIndex(x => x >= s[entry] - 200) * st + 4].toFixed(1) });
    }
    const q = (a, p) => a.sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
    const off = rows.map(r => r.entryToWidestM), into = rows.map(r => r.intoLakeM);
    return { rivers: rows.length, entryToWidestM: { p10: q(off, .1), p50: q(off, .5), p90: q(off, .9) },
        intoLakeM: { p10: q(into, .1), p50: q(into, .5), p90: q(into, .9) }, sample: rows.slice(0, 8) };
}

// The last count points of river id: arc length from the end (m), half-width,
// in-lake flag, level.
export async function riverTail({ id, count = 14 }) {
    const svc = window.gameEngine.waterService, R = window.gameEngine.planetConfig.radius;
    // Rivers are traced progressively after loading: wait up to 2 min.
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs?.get(id);
    if (!rec) return null;
    const P = rec.points, st = rec.stride, n = P.length / st, s = [0];
    for (let k = 1; k < n; k++) {
        const a = (k - 1) * st, b = k * st;
        s.push(s[k - 1] + R * Math.acos(Math.min(1, P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2])));
    }
    const rows = [];
    for (let k = Math.max(0, n - count); k < n; k++) rows.push([Math.round(s[k] - s[n - 1]), +P[k * st + 4].toFixed(1), P[k * st + 9], +P[k * st + 3].toFixed(2)]);
    return { id, n, rows };
}

// The GPU's river segments (WaterGpuData._segs) starting at river id's last
// count points: their half-widths, against the record's.
export async function gpuTail({ id, count = 8 }) {
    const g = window.gameEngine, svc = g.waterService, wg = g.waterGpuData;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 3000));
    const rec = svc.riverRecs?.get(id);
    if (!rec) return null;
    const P = rec.points, st = rec.stride, n = P.length / st, F = 36, S = wg._segs, rows = [];
    const applied = wg._appliedRivers?.get(id);
    for (let k = Math.max(0, n - count); k < n - 1; k++) {
        const a = k * st;
        let hit = null;
        for (let o = 0; o + F <= S.length; o += F) {
            if (Math.abs(S[o] - P[a]) < 1e-7 && Math.abs(S[o + 1] - P[a + 1]) < 1e-7 && Math.abs(S[o + 2] - P[a + 2]) < 1e-7) { hit = [+S[o + 8].toFixed(1), +S[o + 9].toFixed(1)]; break; }
        }
        rows.push({ k, recHw: +P[a + 4].toFixed(1), gpuHw: hit });
    }
    return { id, appliedIsCurrent: applied === rec, appliedHwEnd: applied ? +applied.points[(applied.points.length / applied.stride - 1) * applied.stride + 4].toFixed(1) : null, rows };
}

// Wet width (m: carved ground under the water level, transectProbe.js) of
// river id at points ks, against its traced width (2 hw).
export async function wetWidths({ id, ks }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const { transectAt } = await import('/tools/perf/riverBanks/transectProbe.js');
    const rows = [];
    for (const kk of ks) {
        const k = kk < 0 ? n + kk : kk, a = k * st, level = P[a + 16];
        const at = (h) => [o.x + P[a] * (R + h), o.y + P[a + 1] * (R + h), o.z + P[a + 2] * (R + h)];
        const t = await transectAt({ view: { pos: at(level + 60), look: at(level) }, halfM: 60, stepM: 0.5 });
        if (t.rid !== id || t.k !== k) { rows.push({ k, skipped: `nearest ${t.rid}/${t.k}` }); continue; }
        const wet = t.ns.filter((_, i) => t.carved[i] < t.level - 0.05);
        rows.push({ k, tracedWidth: +(2 * t.hw).toFixed(1), wetWidth: wet.length ? +(wet.at(-1) - wet[0]).toFixed(1) : 0, level: +t.level.toFixed(2) });
    }
    return rows;
}

// Points of the river passing nearest pos within radiusM: arc length (m),
// design level eta (3), water level (16), depth at the thalweg (5), bed,
// half-width (4), pool flag (9).
export async function riverProfileNear({ pos, radiusM = 300 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const v = [pos[0] - o.x, pos[1] - o.y, pos[2] - o.z], l = Math.hypot(...v), dir = v.map(x => x / l);
    for (let t = 0; t < 120; t++) {
        let best = null;
        for (const [id, rec] of svc.riverRecs ?? []) {
            const P = rec.points, st = rec.stride;
            for (let k = 0; k < P.length / st; k++) {
                const d = R * Math.acos(Math.min(1, P[k * st] * dir[0] + P[k * st + 1] * dir[1] + P[k * st + 2] * dir[2]));
                if (d < radiusM && (!best || d < best.d)) best = { d, id, rec };
            }
        }
        if (best) {
            const P = best.rec.points, st = best.rec.stride, n = P.length / st, s = [0], rows = [];
            for (let k = 1; k < n; k++) {
                const a = (k - 1) * st, b = k * st;
                s.push(s[k - 1] + R * Math.acos(Math.min(1, P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2])));
            }
            for (let k = 0; k < n; k++) {
                const a = k * st, d = R * Math.acos(Math.min(1, P[a] * dir[0] + P[a + 1] * dir[1] + P[a + 2] * dir[2]));
                if (d < radiusM) rows.push([Math.round(s[k]), +P[a + 3].toFixed(2), +P[a + 16].toFixed(2), +P[a + 5].toFixed(2), +(P[a + 3] - P[a + 5]).toFixed(2), +P[a + 4].toFixed(1), P[a + 9]]);
            }
            return { id: best.id, n, cols: 's eta wl depth bed hw pool', rows };
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

// Carved ground (the height function with carve and valley) every stepM
// along river id's centreline between points k0 and k1, against the
// record's bed (eta - depth / waterFrac... here eta - depth field 5).
export async function bedAlong({ id, k0, k1, stepM = 1 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, arc = g.waterGpuData._arcLengths(rec);
    const dirs = [], s = [];
    for (let k = k0; k < k1; k++) {
        const a = k * st, b = (k + 1) * st, L = arc[k + 1] - arc[k];
        for (let x = 0; x < L; x += stepM) {
            const t = x / L, d = [0, 1, 2].map(i => P[a + i] + (P[b + i] - P[a + i]) * t), l = Math.hypot(...d);
            dirs.push(d[0] / l, d[1] / l, d[2] / l, 0);
            s.push(+(arc[k] + x).toFixed(1));
        }
    }
    const carved = Array.from(await svc._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    const joints = [];
    for (let k = k0; k <= k1; k++) joints.push(+arc[k].toFixed(1));
    return { id, joints, s, carved: carved.map(v => +v.toFixed(3)) };
}

// Lake rims (fields 14 left, 15 right), level (16), bank-full estimate and
// lake guard (18) of river id's points k0..k1.
export async function rimsOf({ id, k0 = 0, k1 = 1e9 }) {
    const svc = window.gameEngine.waterService;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st, rows = [];
    for (let k = Math.max(0, k0); k < Math.min(n, k1); k++) {
        const a = k * st;
        rows.push([k, +P[a + 16].toFixed(2), +P[a + 14].toFixed(2), +P[a + 15].toFixed(2), P[a + 18] < -1e10 ? null : +P[a + 18].toFixed(2), +P[a + 4].toFixed(1)]);
    }
    return { id, cols: 'k wl rimL rimR lakeGuard hw', rows };
}
