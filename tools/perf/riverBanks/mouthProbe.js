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
    const natural = Array.from(await svc._sampler.sampleDirsNatural(Float32Array.from(dirs)));
    const lake = [];
    for (let i = 0; i < dirs.length; i += 4) lake.push(g.waterGpuData.lakeAt?.([dirs[i], dirs[i + 1], dirs[i + 2]])?.level ?? null);
    const joints = [];
    for (let k = k0; k <= k1; k++) joints.push(+arc[k].toFixed(1));
    return { id, joints, s, carved: carved.map(v => +v.toFixed(3)), natural: natural.map(v => +v.toFixed(3)), lake };
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

// Along river id between points k0 and k1, every stepM: the carved ground
// across the channel (every acrossStepM out to halfM each side, from the
// straight line between the points) and the water level there as the
// shaders blend it (riverRibbon.js riverJointValue): the wet width (ground
// below the level, contiguous around the centre) and the lowest ground.
export async function wetAlong({ id, k0, k1, stepM = 1, halfM = 20, acrossStepM = 0.25 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const { riverJointValue } = await import('/core/world/water/riverRibbon.js');
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st, arc = g.waterGpuData._arcLengths(rec);
    const wl = Float64Array.from({ length: n }, (_, k) => P[k * st + 16]);
    const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const rows = [], dirs = [], m = Math.round(2 * halfM / acrossStepM) + 1;
    for (let k = k0; k < k1; k++) {
        const a = [P[k * st], P[k * st + 1], P[k * st + 2]], b = [P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]];
        const L = arc[k + 1] - arc[k], left = norm(cross(a, norm(b.map((v, i) => v - a[i]))));
        for (let x = 0; x < L; x += stepM) {
            const t = x / L, c = norm(a.map((v, i) => v + (b[i] - v) * t));
            rows.push({ s: +(arc[k] + x).toFixed(1), level: riverJointValue(wl, arc, k, t) });
            for (let j = 0; j < m; j++) {
                const o = -halfM + j * acrossStepM, d = norm(c.map((v, i) => v + left[i] * o / R));
                dirs.push(d[0], d[1], d[2], 0);
            }
        }
    }
    const h = Array.from(await svc._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    const mid = (m - 1) / 2;
    rows.forEach((r, i) => {
        const row = h.slice(i * m, (i + 1) * m);
        let lo = 0;
        for (let j = 1; j < m; j++) if (row[j] < row[lo]) lo = j;
        let a = lo, b = lo;
        while (a > 0 && row[a - 1] < r.level) a--;
        while (b < m - 1 && row[b + 1] < r.level) b++;
        r.wet = row[lo] < r.level ? +((b - a + 1) * acrossStepM).toFixed(2) : 0;
        r.lowest = +row[lo].toFixed(3);
        r.depth = +(r.level - row[lo]).toFixed(3);
        r.offset = +((lo - mid) * acrossStepM).toFixed(2);
        r.level = +r.level.toFixed(3);
    });
    return { id, joints: arc.slice(k0, k1 + 1).map(v => +v.toFixed(1)), rows };
}

// Turn angle (degrees) at every joint of every traced river: quantiles.
export async function jointAngles() {
    const svc = window.gameEngine.waterService, a = [];
    for (const [, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        for (let k = 1; k + 1 < n; k++) {
            const d = (i, j) => [0, 1, 2].map(c => P[j * st + c] - P[i * st + c]);
            const u = d(k - 1, k), v = d(k, k + 1), lu = Math.hypot(...u), lv = Math.hypot(...v);
            if (lu < 1e-9 || lv < 1e-9) continue;
            a.push(Math.acos(Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv))) * 180 / Math.PI);
        }
    }
    a.sort((x, y) => x - y);
    const q = p => +a[Math.floor(p * (a.length - 1))].toFixed(2);
    return { joints: a.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), under1: +(a.filter(x => x < 1).length / a.length).toFixed(2) };
}

// Past river id's last point into its lake along the last segment's line,
// every stepM for metres: carved and natural ground and the lake level.
export async function bedBeyond({ id, metres = 120, stepM = 4 }) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const a = [0, 1, 2].map(c => P[(n - 2) * st + c]), b = [0, 1, 2].map(c => P[(n - 1) * st + c]);
    const d = b.map((v, i) => v - a[i]), L = Math.hypot(...d) * R, dirs = [], xs = [];
    for (let x = -20; x <= metres; x += stepM) {
        const p = b.map((v, i) => v + d[i] * x / L), l = Math.hypot(...p);
        dirs.push(p[0] / l, p[1] / l, p[2] / l, 0); xs.push(x);
    }
    const carved = Array.from(await svc._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    const natural = Array.from(await svc._sampler.sampleDirsNatural(Float32Array.from(dirs)));
    const lake = [];
    for (let i = 0; i < dirs.length; i += 4) lake.push(g.waterGpuData.lakeAt([dirs[i], dirs[i + 1], dirs[i + 2]])?.level ?? null);
    return { id, endLevel: +P[(n - 1) * st + 16].toFixed(3), rows: xs.map((x, i) => [x, +carved[i].toFixed(2), +natural[i].toFixed(2), lake[i] == null ? null : +lake[i].toFixed(2)]) };
}

// River id's first count points: arc length, water level (16), design level
// (3), pool (9), lake guard (18), half-width (4).
export async function riverHead({ id, count = 18 }) {
    const g = window.gameEngine, svc = g.waterService;
    for (let t = 0; t < 240 && !svc.riverRecs?.get(id); t++) await new Promise(r => setTimeout(r, 500));
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, arc = g.waterGpuData._arcLengths(rec), rows = [];
    for (let k = 0; k < Math.min(count, P.length / st); k++) {
        const a = k * st;
        rows.push([k, +arc[k].toFixed(1), +P[a + 16].toFixed(3), +P[a + 3].toFixed(3), P[a + 9], P[a + 18] < -1e10 ? null : +P[a + 18].toFixed(3), +P[a + 4].toFixed(1)]);
    }
    return { cols: 'k s wl eta pool lakeGuard hw', rows };
}

// Rivers running along their lake: at each end of every traced river the run
// of points beside lake water (lake guard set: water within 2 hw + 25 m of
// the line) but not in it (pool 0), as arc length (m). A river meeting the
// shore at an angle has a short run (~ that band / sin angle); one running
// along the shore a long one (owner 2026-10-27: no rivers parallel to lakes).
export async function lakeSideRuns({ minM = 80 } = {}) {
    const svc = window.gameEngine.waterService, R = window.gameEngine.planetConfig.radius, rows = [];
    for (const [id, rec] of svc.riverRecs ?? []) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        if (n < 3) continue;
        const s = [0];
        for (let k = 1; k < n; k++) {
            const a = (k - 1) * st, b = k * st;
            s.push(s[k - 1] + R * Math.acos(Math.min(1, P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2])));
        }
        const beside = k => P[k * st + 9] >= 0 && P[k * st + 18] > -1e10, inLake = k => P[k * st + 9] < 0;
        let k = 0;
        while (k < n && inLake(k)) k++;
        const a0 = k;
        while (k < n && beside(k)) k++;
        const start = k > a0 ? s[Math.min(k, n - 1)] - s[a0] : 0;
        k = n - 1;
        while (k >= 0 && inLake(k)) k--;
        const b0 = k;
        while (k >= 0 && beside(k)) k--;
        const end = k < b0 ? s[b0] - s[Math.max(k, 0)] : 0;
        const p = P.subarray(Math.min(a0, n - 1) * st), q = P.subarray(Math.max(b0, 0) * st);
        rows.push({ id, start: Math.round(start), end: Math.round(end), startInLake: a0 > 0, endInLake: b0 < n - 1,
            at: [p[0], p[1], p[2], p[3]].map(v => +v.toFixed(5)), endAt: [q[0], q[1], q[2], q[3]].map(v => +v.toFixed(5)) });
    }
    const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(f * (b.length - 1))]; };
    const starts = rows.filter(r => r.startInLake).map(r => r.start), ends = rows.filter(r => r.endInLake).map(r => r.end);
    return { rivers: rows.length,
        start: { n: starts.length, p50: q(starts, .5), p90: q(starts, .9), max: q(starts, 1), over: starts.filter(v => v > minM).length },
        end: { n: ends.length, p50: q(ends, .5), p90: q(ends, .9), max: q(ends, 1), over: ends.filter(v => v > minM).length },
        worst: [...rows].sort((a, b) => Math.max(b.start, b.end) - Math.max(a.start, a.end)).slice(0, 12), all: rows.map(r => [r.id, r.start, r.end, r.at, r.endAt]) };
}

// Where world positions lie in lake id's solved frame (its mask's bounds,
// as waterLakeHitIn reads them): u, v (0..1 inside) and the mask texel.
export async function lakeFrameUv({ id, pos }) {
    const g = window.gameEngine, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const rec = g.waterService.refined.get(id), f = rec?.frame;
    if (!f) return null;
    const rows = pos.map(p => {
        const v = [p[0] - o.x, p[1] - o.y, p[2] - o.z], l = Math.hypot(...v), d = v.map(x => x / l);
        const k = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
        const px = (d[0] * f.e1[0] + d[1] * f.e1[1] + d[2] * f.e1[2]) / k * R, py = (d[0] * f.e2[0] + d[1] * f.e2[1] + d[2] * f.e2[2]) / k * R;
        const u = (px - f.x0) / (f.nx * f.spacing), w = (py - f.y0) / (f.ny * f.spacing);
        const i = Math.floor((px - f.x0) / f.spacing), j = Math.floor((py - f.y0) / f.spacing);
        const m = i >= 0 && j >= 0 && i < f.nx && j < f.ny ? rec.mask?.[j * f.nx + i] : null;
        return { u: +u.toFixed(4), v: +w.toFixed(4), mask: m };
    });
    return { level: rec.level, spacing: f.spacing, nx: f.nx, ny: f.ny, rows };
}

// After posing view: down pixel column px from py0 to py1 (1440 x 900, fov
// 75) the ground hit (carved sampler), lake id's signed distance F (m, +
// inside its solved water; waterLakeHitIn draws water where F > -spacing/2
// and the ground is below the level) and the nearest point of river rid
// (distance from its line, level, half-width): what a straight edge across
// a junction lines up with.
export async function junctionColumn({ view, px, py0, py1, lake, rid, row = null }) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const g = window.gameEngine, s = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const { lakeMaskSdf, lakeSdfAt } = await import('/core/world/water/lakeMaskSdf.js');
    const { dirToPlane } = await import('/core/world/hydrology/lakeRefine.js');
    const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
    const norm = a => mul(a, 1 / Math.hypot(...a)), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const O = [o.x, o.y, o.z], fwd = norm(sub(view.look, view.pos)), right = norm(cross(fwd, norm(sub(view.pos, O)))), up = cross(right, fwd);
    const th = Math.tan(75 * Math.PI / 360), hAt = async d => (await s._sampler.sampleDirsCarved(Float32Array.from([...d, 0])))[0];
    const rec = s.refined.get(lake), F = lakeMaskSdf(rec.mask, rec.frame.nx, rec.frame.ny, rec.frame.spacing);
    const rr = s.riverRecs.get(rid), P = rr.points, st = rr.stride, n = P.length / st;
    const rows = [];
    // row: { y, x0, x1 } walks a pixel row instead of the column.
    const pix = row ? Array.from({ length: row.x1 - row.x0 + 1 }, (_, q) => [row.x0 + q, row.y]) : Array.from({ length: py1 - py0 + 1 }, (_, q) => [px, py0 + q]);
    for (const [qx, py] of pix) {
        const ray = norm(add(fwd, add(mul(right, (2 * (qx + 0.5) / 1440 - 1) * th * 1.6), mul(up, (1 - 2 * (py + 0.5) / 900) * th))));
        let t0 = 0, hit = null;
        for (let t = 2; t < 3000; t += 2) { const p = sub(add(view.pos, mul(ray, t)), O); if (Math.hypot(...p) - R <= await hAt(norm(p))) { hit = t; break; } t0 = t; }
        if (hit == null) continue;
        for (let i = 0; i < 14; i++) { const m = (t0 + hit) / 2, p = sub(add(view.pos, mul(ray, m)), O); if (Math.hypot(...p) - R <= await hAt(norm(p))) hit = m; else t0 = m; }
        const d = norm(sub(add(view.pos, mul(ray, hit)), O)), h = await hAt(d);
        const [x, y] = dirToPlane(d, rec.frame, R);
        let best = null;
        for (let k = 0; k + 1 < n; k++) {
            const a = [P[k * st], P[k * st + 1], P[k * st + 2]], b = [P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]];
            const ab = sub(b, a), t = Math.max(0, Math.min(1, (d[0] - a[0]) * ab[0] + (d[1] - a[1]) * ab[1] + (d[2] - a[2]) * ab[2]) / Math.max(1e-30, ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2));
            const q = add(a, mul(ab, t)), dist = Math.hypot(...sub(d, q)) * R;
            if (!best || dist < best.dist) best = { dist, k: k + t, eta: P[k * st + 3] + (P[(k + 1) * st + 3] - P[k * st + 3]) * t, hw: P[k * st + 4] + (P[(k + 1) * st + 4] - P[k * st + 4]) * t };
        }
        const nat = (await s._sampler.sampleDirsNatural(Float32Array.from([...d, 0])))[0];
        rows.push({ px: qx, py, h: +h.toFixed(3), nat: +nat.toFixed(3), F: +lakeSdfAt(F, rec.frame, x, y).toFixed(2), below: +(rec.level - h).toFixed(3),
            k: +best.k.toFixed(2), dist: +best.dist.toFixed(1), eta: +best.eta.toFixed(3), hw: +best.hw.toFixed(1) });
    }
    return { level: rec.level, band: -0.5 * rec.frame.spacing, rows };
}

// How rivers meet their lakes (owner 2026-10-27: at an angle, never along the
// shore): per river end in a solved lake, along the trace from where it
// leaves the lake's solved water (signed distance F < 0, lakeMaskSdf) the
// rate it moves away from the water over its first 60 m (sine of the angle
// it meets the shore at: 1 head-on, 0 along it) and how much of its first
// 120 m stays within 30 m of the water.
export async function lakeApproach({ awayM = 60, spanM = 120, nearM = 30, settleS = 8 } = {}) {
    const g = window.gameEngine, svc = g.waterService, R = g.planetConfig.radius;
    // Rivers are traced in the background after loading: wait until the
    // count has not changed for settleS (at most 10 min).
    for (let t = 0, last = -1, still = 0; t < 6000 && still < settleS * 10; t++) {
        await new Promise(r => setTimeout(r, 100));
        const n = svc.riverRecs.size;
        still = n === last && !svc._busy ? still + 1 : 0; last = n;
    }
    const { lakeMaskSdf, lakeSdfAt } = await import('/core/world/water/lakeMaskSdf.js');
    const { dirToPlane } = await import('/core/world/hydrology/lakeRefine.js');
    const sdf = new Map(), lakeOf = id => { let r = svc.refined.get(id), k = 0; while (!r && svc.mergedInto?.has(id) && k++ < 8) { id = svc.mergedInto.get(id); r = svc.refined.get(id); } return r; };
    const Fof = rec => { if (!sdf.has(rec)) sdf.set(rec, rec.mask ? lakeMaskSdf(rec.mask, rec.frame.nx, rec.frame.ny, rec.frame.spacing) : null); return sdf.get(rec); };
    const rows = [];
    for (const [id, rr] of svc.riverRecs ?? []) {
        const P = rr.points, st = rr.stride, n = P.length / st;
        if (n < 4) continue;
        const s = [0];
        for (let k = 1; k < n; k++) {
            const a = (k - 1) * st, b = k * st;
            s.push(s[k - 1] + R * Math.acos(Math.min(1, P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2])));
        }
        for (const [end, lake] of [['start', lakeOf(rr.src)], ['end', rr.dest?.type === 'lake' ? lakeOf(rr.dest.id) : null]]) {
            const F = lake && Fof(lake);
            if (!F) continue;
            const order = end === 'start' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
            const f = order.map(k => { const [x, y] = dirToPlane([P[k * st], P[k * st + 1], P[k * st + 2]], lake.frame, R); return lakeSdfAt(F, lake.frame, x, y); });
            const arc = order.map(k => Math.abs(s[k] - s[order[0]]));
            const i0 = f.findIndex(v => v < 0);
            if (i0 < 1) continue;
            const at = m => { let i = i0; while (i + 1 < f.length && arc[i] - arc[i0] < m) i++; return i; };
            const ia = at(awayM), sin = (f[i0] - f[ia]) / Math.max(1, arc[ia] - arc[i0]);
            let near = 0;
            for (let i = i0; i + 1 < f.length && arc[i] - arc[i0] < spanM; i++) if (f[i] > -nearM) near += arc[i + 1] - arc[i];
            const k0 = order[i0];
            rows.push({ id, end, sin: +sin.toFixed(2), nearM: Math.round(near), why: rr.approach?.[end === 'start' ? 0 : 1] ?? null,
                at: [P[k0 * st], P[k0 * st + 1], P[k0 * st + 2], P[k0 * st + 3]].map(v => +v.toFixed(5)) });
        }
    }
    const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(p * (b.length - 1))] : null; };
    const sins = rows.map(r => r.sin), nears = rows.map(r => r.nearM);
    return { ends: rows.length, sin: { p10: q(sins, .1), p25: q(sins, .25), p50: q(sins, .5) }, under05: sins.filter(v => v < 0.5).length,
        nearM: { p50: q(nears, .5), p90: q(nears, .9), max: q(nears, 1) }, over60: nears.filter(v => v > 60).length,
        why: rows.reduce((t, r) => ({ ...t, [r.why]: (t[r.why] ?? 0) + 1 }), {}),
        worst: [...rows].sort((a, b) => a.sin - b.sin).slice(0, 10), all: rows.map(r => [r.id, r.end, r.sin, r.nearM, r.why]) };
}

// A map of the natural ground around pos (every stepM over +-halfM, rows
// north-up in the tangent plane's e1/e2) relative to level (dm), with the
// CPU lake mask (~) and the traced rivers' points (#): how the land beside
// a lake lies where a river leaves or reaches it.
export async function heightMap({ pos, halfM = 300, stepM = 20, level, mark = null, lake = null, regionOnly = false }) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const { tangentBasis, planeToDir, dirToPlane } = await import('/core/world/hydrology/lakeRefine.js');
    const norm3 = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
    const c = norm3([pos[0] - o.x, pos[1] - o.y, pos[2] - o.z]);
    const f = { c, ...tangentBasis(c) }, n = Math.round(2 * halfM / stepM) + 1, dirs = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) dirs.push(...planeToDir(-halfM + i * stepM, halfM - j * stepM, f, R), 0);
    const hs = await s._sampler.sampleDirsNatural(Float32Array.from(dirs));
    const river = new Set();
    for (const [, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride;
        for (let k = 0; k < P.length / st; k++) {
            const [x, y] = dirToPlane([P[k * st], P[k * st + 1], P[k * st + 2]], f, R);
            const i = Math.round((x + halfM) / stepM), j = Math.round((halfM - y) / stepM);
            if (i >= 0 && j >= 0 && i < n && j < n && Math.abs(x) < halfM * 1.1) river.add(j * n + i);
        }
    }
    // mark: a world position drawn as @ (e.g. the camera); lake: a solved
    // lake's id, its water as drawn (signed distance > -spacing/2, ground below
    // its level) instead of the CPU mask.
    let markK = -1;
    if (mark) {
        const [x, y] = dirToPlane(norm3([mark[0] - o.x, mark[1] - o.y, mark[2] - o.z]), f, R);
        const i = Math.round((x + halfM) / stepM), j = Math.round((halfM - y) / stepM);
        if (i >= 0 && j >= 0 && i < n && j < n) markK = j * n + i;
    }
    let F = null, lr = null;
    if (lake != null) {
        const { lakeMaskSdf } = await import('/core/world/water/lakeMaskSdf.js');
        lr = s.refined.get(lake);
        F = lakeMaskSdf(lr.mask, lr.frame.nx, lr.frame.ny, lr.frame.spacing);
    }
    const { lakeSdfAt } = await import('/core/world/water/lakeMaskSdf.js');
    const rows = [];
    for (let j = 0; j < n; j++) {
        let r = '';
        for (let i = 0; i < n; i++) {
            const k = j * n + i, d = dirs.slice(4 * k, 4 * k + 3), dh = (hs[k] - level) * 10;
            let wet;
            if (F) { const [x, y] = dirToPlane(d, lr.frame, R); wet = hs[k] < lr.level && lakeSdfAt(F, lr.frame, x, y) > (regionOnly ? 0 : -0.5 * lr.frame.spacing); }
            else wet = !!w.lakeAt(d);
            r += k === markK ? '  @' : river.has(k) ? '  #' : wet ? '  ~' : (Math.max(-99, Math.min(99, Math.round(dh)))).toString().padStart(3);
        }
        rows.push(r);
    }
    return rows.join('\n');
}

// Trace river id now (or take it from the cache) and report the service's
// traced and failed counts, the river's status and its ends' re-route (approach).
export async function riverSolveStatus({ id, more = [] }) {
    const svc = window.gameEngine.waterService, warn = [];
    const orig = console.warn;
    console.warn = (...a) => { warn.push(a.map(String).join(' ').slice(0, 300)); orig(...a); };
    try {
        // refineRiver does nothing while the service is busy.
        const idle = async () => { for (let t = 0; t < 1200 && svc._busy; t++) await new Promise(r => setTimeout(r, 100)); };
        await idle();
        const rec = await svc.refineRiver(id), ms = [];
        for (const m of more) {
            await idle();
            const t = performance.now(), r = await svc.refineRiver(m);
            ms.push([m, r ? Math.round(r.ms ?? -1) : null, Math.round(performance.now() - t), r?.lengthM ? Math.round(r.lengthM) : null]);
        }
        return { id, ok: !!rec, ms: rec?.ms, approach: rec?.approach ?? null, points: rec ? rec.points.length / rec.stride : 0, more: ms,
            traced: svc.riverRecs.size, failed: svc._failedRivers.size, failedIds: [...svc._failedRivers].slice(0, 20), warn: warn.slice(0, 10) };
    } finally { console.warn = orig; }
}

// The turn at each of river id's points (degrees between the segments in and
// out) with the arc length, half-width, in-lake flag and level: sharp corners
// (a re-routed end joining the old path) show as large turns.
export async function riverTurns({ id, from = 0, count = 30 }) {
    const svc = window.gameEngine.waterService, R = window.gameEngine.planetConfig.radius;
    for (let t = 0; t < 1200 && !svc.riverRecs?.get(id); t++) { if (!svc._busy) await svc.refineRiver(id); await new Promise(r => setTimeout(r, 100)); }
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st, rows = [];
    const at = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
    let s = 0;
    for (let k = Math.max(1, from); k < Math.min(n - 1, from + count); k++) {
        const a = at(k - 1), b = at(k), c = at(k + 1);
        const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - b[i]);
        const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
        s += Math.hypot(...u) * R;
        rows.push({ k, s: Math.round(s), turn: +(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toFixed(1),
            seg: +(Math.hypot(...w) * R).toFixed(1), hw: +P[k * st + 4].toFixed(1), pool: P[k * st + 9], eta: +P[k * st + 3].toFixed(2) });
    }
    return { id, n, approach: rec.approach, rows };
}

// The page's captured WebGPU errors (pageInstrument.js), first lines, after
// posing view if given.
export async function gpuErrors({ view = null } = {}) {
    if (view) await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    return (window.__lr?.gpuErrors ?? []).map(e => String(e?.message ?? e).slice(0, 1200)).slice(0, 4);
}

// River id's points k0..k1 as world positions, level, half-width and depth
// (for comparing traces between solve versions).
export async function riverPoints({ id, k0 = 0, k1 = 1e9 }) {
    const svc = window.gameEngine.waterService, R = window.gameEngine.planetConfig.radius, o = window.gameEngine.planetConfig.origin || { x: 0, y: 0, z: 0 };
    for (let t = 0; t < 1200 && !svc.riverRecs?.get(id); t++) { if (!svc._busy) await svc.refineRiver(id); await new Promise(r => setTimeout(r, 100)); }
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st, rows = [];
    for (let k = k0; k <= Math.min(k1, n - 1); k++) {
        const d = [P[k * st], P[k * st + 1], P[k * st + 2]];
        rows.push({ k, pos: d.map((v, i) => +(v * R + [o.x, o.y, o.z][i]).toFixed(1)), eta: +P[k * st + 3].toFixed(2), hw: +P[k * st + 4].toFixed(1), depth: +P[k * st + 5].toFixed(2) });
    }
    return { id, n, approach: rec.approach ?? null, rows };
}
