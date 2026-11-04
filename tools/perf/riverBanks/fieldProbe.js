// River field probes (RIVERS_AND_LAKES.md section 7): the service's state.
export function fieldSummary() {
    const s = window.gameEngine.riverFieldService;
    return s ? s.summary() : null;
}
// The field's values along a line across the view's centre (plan metres),
// for checking W against the lake level at mouths.
export function fieldLine({ pos, look, fromM = -100, toM = 100, stepM = 4, aheadM = 150 }) {
    return import('/core/world/water/riverField.js').then(({ sampleRiverField }) => {
        const g = window.gameEngine, svc = g.riverFieldService, L = svc.layout, R = L.R;
        const len = Math.hypot(...pos), up = pos.map(v => v / len);
        const f = look.map((v, i) => v - pos[i]), fu = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
        let fwd = f.map((v, i) => v - fu * up[i]); const fl = Math.hypot(...fwd) || 1; fwd = fwd.map(v => v / fl);
        const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
        const out = [];
        for (let x = fromM; x <= toM; x += stepM) {
            const d0 = up.map((v, i) => v + (fwd[i] * aheadM + right[i] * x) / R), l = Math.hypot(...d0), d = d0.map(v => v / l);
            const s = sampleRiverField(svc.pages, L, d), lake = g.waterGpuData.lakeEdgeAt(d);
            out.push([x, +s.delta.toFixed(2), +s.W.toFixed(2), +s.sdf.toFixed(1), lake ? +lake.level.toFixed(2) : null, lake ? +lake.inside.toFixed(1) : null]);
        }
        return out;
    });
}
// Where the field's water meets a lake sheet: along every wet page's edge with
// no wet neighbour, inside a lake, W minus the lake's level (m); and lake water
// on pages that are not drawn (the sheet gives way there, so it would be a hole).
export function fieldLakeEdges({ pos: near = null, radiusM = 1e9, stepTexels = 2 } = {}) {
    return import('/core/world/water/riverField.js').then(({ fieldDir, pageKey, pageOf, sampleRiverField }) => {
        const g = window.gameEngine, svc = g.riverFieldService, L = svc.layout, w = g.waterGpuData, P = L.P;
        const wet = new Set(svc.wetPages.map(p => pageKey(p.face, p.pi, p.pj, L)));
        const cosR = Math.cos(radiusM / L.R), nd = near && (l => near.map(v => v / l))(Math.hypot(...near));
        const inRange = d => !nd || d[0] * nd[0] + d[1] * nd[1] + d[2] * nd[2] > cosR;
        const deltas = [], worst = [];
        let edges = 0, closest = null;
        for (const p of svc.wetPages) {
            if (!inRange(p.dir)) continue;
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                if (wet.has(pageKey(p.face, p.pi + dx, p.pj + dy, L))) continue;
                edges++;
                for (let t = 0; t <= P; t += stepTexels) {
                    const tx = (p.pi + (dx > 0 ? 1 : 0)) * P + (dx ? 0 : t), ty = (p.pj + (dy > 0 ? 1 : 0)) * P + (dy ? 0 : t);
                    const d = fieldDir(p.face, tx, ty, L), lake = w.lakeEdgeAt(d);
                    if (!lake || lake.inside <= 0) continue;
                    const s = sampleRiverField(svc.pages, L, d);
                    if (!s.found || s.sdf <= 0) continue;
                    const e = s.W - lake.level;
                    deltas.push(Math.abs(e));
                    if (nd && lake.inside > 2 && s.sdf > 1 && s.sdf < 6) {
                        const c = d[0] * nd[0] + d[1] * nd[1] + d[2] * nd[2];
                        if (!closest || c > closest.c) closest = { c, dir: d, level: lake.level, axis: dx ? 'x' : 'y' };
                    }
                    if (Math.abs(e) > 0.02) worst.push({ page: [p.face, p.pi, p.pj], tx, ty, e: +e.toFixed(3), W: +s.W.toFixed(3), level: +lake.level.toFixed(3), lake: lake.id, inside: +lake.inside.toFixed(1), sdf: +s.sdf.toFixed(2), dir: d.map(v => +v.toFixed(6)) });
                }
            }
        }
        deltas.sort((a, b) => a - b);
        const q = f => deltas.length ? +deltas[Math.min(deltas.length - 1, Math.floor(f * deltas.length))].toFixed(4) : null;
        // Undrawn pages under lake water.
        let dryPages = 0, dryLake = 0;
        for (const key of svc.pages.keys()) {
            if (wet.has(key)) continue;
            dryPages++;
            const { face, pi, pj } = pageOf(key, L);
            const d = fieldDir(face, (pi + .5) * P, (pj + .5) * P, L);
            if (!inRange(d)) continue;
            const lake = w.lakeEdgeAt(d);
            if (lake && lake.inside > 0) dryLake++;
        }
        return { wetPages: svc.wetPages.length, pages: svc.pages.size, edges, samples: deltas.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1), over2cm: worst.length, worst: worst.slice(0, 24), dryPages, dryLake, closest };
    });
}
// Steps in the field's water level between neighbouring water texels: the level
// of connected water should be continuous. Lists the pages with steps over minM.
export function fieldWaterSteps({ minM = 1 } = {}) {
    return import('/core/world/water/riverField.js').then(({ fieldDir, pageOf, RIVER_FIELD_WORDS, riverFieldTexelSdf }) => {
        const svc = window.gameEngine.riverFieldService, L = svc.layout, R = L.R, f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
        const W = (d, t) => { u32[0] = d[t * RIVER_FIELD_WORDS]; return f32[0]; };
        const hits = [];
        let texels = 0, steps = 0;
        for (const [key, d] of svc.pages) {
            let n = 0, max = 0, at = null, levels = null;
            for (let j = L.A; j < L.A + L.P; j++) for (let i = L.A; i < L.A + L.P; i++) {
                const t = j * L.ST + i;
                if (riverFieldTexelSdf(d, t) <= 0) continue;
                texels++;
                for (const u of [t + 1, t + L.ST]) {
                    if (riverFieldTexelSdf(d, u) <= 0) continue;
                    const e = Math.abs(W(d, t) - W(d, u));
                    if (e > minM) { n++; if (e > max) { max = e; at = [i - L.A, j - L.A]; levels = [W(d, t), W(d, u)]; } }
                }
            }
            if (!n) continue;
            steps += n;
            const { face, pi, pj } = pageOf(key, L);
            hits.push({ page: [face, pi, pj], n, max: +max.toFixed(2), levels: levels.map(v => +v.toFixed(2)), dir: fieldDir(face, pi * L.P + at[0] + .5, pj * L.P + at[1] + .5, L).map(v => +v.toFixed(7)) });
        }
        hits.sort((a, b) => b.n - a.n);
        return { texels, steps, pages: hits.length, top: hits.slice(0, 16) };
    });
}
// Slope (m per m) the field itself adds to dry ground: its change in Δ between
// neighbouring texels. The natural ground is not in it, so a high value is a
// cliff the bake made. Lists the pages with the most texels over minSlope.
export function fieldCliffs({ minSlope = 1 } = {}) {
    return import('/core/world/water/riverField.js').then(({ fieldDir, pageOf, RIVER_FIELD_WORDS, riverFieldTexelSdf }) => {
        const svc = window.gameEngine.riverFieldService, L = svc.layout, texelM = 2;
        const half = h => { const e = (h >> 10) & 31, f = h & 1023, v = e === 0 ? f / 1024 * 2 ** -14 : (1 + f / 1024) * 2 ** (e - 15); return h & 0x8000 ? -v : v; };
        const delta = (d, t) => half(d[t * RIVER_FIELD_WORDS + 1] & 0xffff);
        const hits = [];
        let dry = 0, over = 0, max = 0;
        for (const [key, d] of svc.pages) {
            let n = 0, top = 0, at = null;
            for (let j = L.A; j < L.A + L.P; j++) for (let i = L.A; i < L.A + L.P; i++) {
                const t = j * L.ST + i;
                if (riverFieldTexelSdf(d, t) > 0) continue;
                dry++;
                const s = Math.max(Math.abs(delta(d, t + 1) - delta(d, t)), Math.abs(delta(d, t + L.ST) - delta(d, t))) / texelM;
                if (s > minSlope) { n++; if (s > top) { top = s; at = [i - L.A, j - L.A]; } }
            }
            if (!n) continue;
            over += n; max = Math.max(max, top);
            const { face, pi, pj } = pageOf(key, L);
            hits.push({ page: [face, pi, pj], n, top: +top.toFixed(2), dir: fieldDir(face, pi * L.P + at[0] + .5, pj * L.P + at[1] + .5, L).map(v => +v.toFixed(7)) });
        }
        const steepest = [...hits].sort((a, b) => b.top - a.top).slice(0, 6);
        hits.sort((a, b) => b.n - a.n);
        return { dry, over, max: +max.toFixed(2), pages: hits.length, top: hits.slice(0, 10), steepest };
    });
}
// A river's profile past a direction: arc, traced level, field W and Δ, natural ground.
export async function fieldAlong({ dir, spanM = 240, stepM = 4 }) {
    const { sampleRiverField } = await import('/core/world/water/riverField.js');
    const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, L = svc.layout;
    let best = null;
    for (const [id, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        for (let k = 0; k < n; k++) {
            const c = P[k * st] * dir[0] + P[k * st + 1] * dir[1] + P[k * st + 2] * dir[2];
            if (!best || c > best.c) best = { c, id, k, rec };
        }
    }
    const { rec, id, k } = best, P = rec.points, st = rec.stride, n = P.length / st, arc = g.waterGpuData._arcLengths(rec);
    const rows = [], dirs = [];
    for (let i = 0; i < n; i++) {
        if (Math.abs(arc[i] - arc[k]) > spanM) continue;
        if (rows.length && arc[i] - rows[rows.length - 1].s < stepM) continue;
        const d = [P[i * st], P[i * st + 1], P[i * st + 2]], f = sampleRiverField(svc.pages, L, d);
        rows.push({ s: arc[i], traced: P[i * st + 3], W: f.W, delta: f.delta });
        dirs.push(...d, 0);
    }
    const nat = await s._sampler.sampleDirsNatural(Float32Array.from(dirs));
    rows.forEach((r, i) => { r.nat = nat[i]; });
    const cols = 's traced W delta nat';
    return { id, offM: +(Math.acos(Math.min(1, best.c)) * L.R).toFixed(1), cols, rows: rows.map(r => [+(r.s - arc[k]).toFixed(0), +r.traced.toFixed(2), +r.W.toFixed(2), +r.delta.toFixed(2), +r.nat.toFixed(2)]) };
}
// Rivers within radiusM of a direction: where each comes closest, its level and
// half-width there, its length, and whether the field holds it.
export async function fieldRiversNear({ dir, radiusM = 250 }) {
    const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, R = svc.layout.R, out = [];
    for (const [id, rec] of s.riverRecs) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        let best = -2, k = 0;
        for (let i = 0; i < n; i++) { const c = P[i * st] * dir[0] + P[i * st + 1] * dir[1] + P[i * st + 2] * dir[2]; if (c > best) { best = c; k = i; } }
        const m = Math.acos(Math.min(1, best)) * R;
        if (m > radiusM) continue;
        const arc = g.waterGpuData._arcLengths(rec);
        out.push({ id, offM: +m.toFixed(1), k, n, lengthM: +arc[n - 1].toFixed(0), atS: +arc[k].toFixed(0), level: +P[k * st + 3].toFixed(2), hw: +P[k * st + 4].toFixed(2),
            baked: svc.rivers.has(id), from: s.rivers[id]?.fromLake ?? null, dest: rec.dest ?? null });
    }
    return out.sort((a, b) => a.offM - b.offM);
}
// The field on a grid around a direction (east-like x, north-like y in metres).
export async function fieldGrid({ dir, halfM = 100, stepM = 10 }) {
    const { sampleRiverField } = await import('/core/world/water/riverField.js');
    const g = window.gameEngine, svc = g.riverFieldService, L = svc.layout, R = L.R;
    const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], k = ref[0] * dir[0] + ref[1] * dir[1] + ref[2] * dir[2];
    const e2 = ref.map((v, i) => v - k * dir[i]), l2 = Math.hypot(...e2), n2 = e2.map(v => v / l2);
    const e1 = [n2[1] * dir[2] - n2[2] * dir[1], n2[2] * dir[0] - n2[0] * dir[2], n2[0] * dir[1] - n2[1] * dir[0]];
    const n = Math.round(2 * halfM / stepM) + 1, dirs = new Float32Array(n * n * 4), rows = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = -halfM + i * stepM, y = halfM - j * stepM, d = dir.map((v, c) => v + (x * e1[c] + y * n2[c]) / R), l = Math.hypot(...d);
        dirs.set([d[0] / l, d[1] / l, d[2] / l, 0], (j * n + i) * 4);
    }
    const nat = await g.waterService._sampler.sampleDirsNatural(dirs);
    for (let j = 0; j < n; j++) {
        const delta = [], sdf = [], natural = [], level = [];
        for (let i = 0; i < n; i++) {
            const o = (j * n + i) * 4, f = sampleRiverField(svc.pages, L, [dirs[o], dirs[o + 1], dirs[o + 2]]);
            delta.push(+f.delta.toFixed(1)); sdf.push(+f.sdf.toFixed(1)); natural.push(+nat[j * n + i].toFixed(1)); level.push(+f.W.toFixed(1));
        }
        rows.push({ y: halfM - j * stepM, delta, sdf, natural, level });
    }
    return { halfM, stepM, rows };
}
// What a re-bake costs the frame: forces one and records the gaps between
// animation frames while it runs (idle first, for comparison).
export async function fieldHitch({ idleMs = 2000 } = {}) {
    const svc = window.gameEngine.riverFieldService;
    const gaps = async (until) => {
        const out = [];
        let last = performance.now();
        while (!until()) {
            await new Promise(r => requestAnimationFrame(r));
            const t = performance.now(); out.push(t - last); last = t;
        }
        return out;
    };
    const facts = (v) => {
        const s = [...v].sort((a, b) => a - b);
        return { frames: s.length, median: +s[s.length >> 1].toFixed(1), p99: +s[Math.floor(s.length * .99)].toFixed(1), max: +s[s.length - 1].toFixed(1), over33: s.filter(x => x > 33).length, over50: s.filter(x => x > 50).length };
    };
    const t0 = performance.now(), idle = await gaps(() => performance.now() - t0 > idleMs);
    while (svc.busy) await new Promise(r => setTimeout(r, 100));
    const stamp = svc.stats, t1 = performance.now();
    let done = false;
    const dir = svc._lastDir;
    svc._bake(svc._riverInputs(svc._nearRivers(dir)), dir).finally(() => { done = true; });
    const during = await gaps(() => done);
    return { ran: svc.stats !== stamp, idle: facts(idle), during: facts(during), bakeMs: Math.round(performance.now() - t1), ms: svc.stats?.ms ?? null };
}
