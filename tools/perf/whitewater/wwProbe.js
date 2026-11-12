// Probes for the whitewater work (run in the page by armReview.mjs).

// Per baked river: slope, half-width, depth, speed, discharge over its stations,
// and the steepest and calmest 200 m reaches.
export function wwRiverStats({ reachM = 200 } = {}) {
    const g = window.gameEngine, s = g.waterService, svc = g.riverFieldService, w = g.waterGpuData, out = [];
    const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return b.length ? +b[Math.min(b.length - 1, Math.floor(f * b.length))].toFixed(3) : 0; };
    for (const [id, rec] of s.riverRecs) {
        if (!svc.rivers.has(id)) continue;
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        if (n < 8) continue;
        const slope = [], hw = [], depth = [], speed = [], Q = [];
        let best = { slope: -1 }, k0 = 0;
        for (let k = 0; k < n; k++) {
            while (k0 < k && arc[k] - arc[k0] > reachM) k0++;
            const L = arc[k] - arc[k0];
            hw.push(P[k * st + 4]); depth.push(P[k * st + 5]); speed.push(P[k * st + 6]); Q.push(P[k * st + 7]);
            if (L < reachM * 0.8 || P[k * st + 9] < -0.5) continue;
            const S = (P[k0 * st + 3] - P[k * st + 3]) / L;
            slope.push(S);
            if (S > best.slope) best = { slope: +S.toFixed(4), fraction: +((arc[k] + arc[k0]) / 2 / arc[n - 1]).toFixed(3), hw: +P[k * st + 4].toFixed(1), level: +P[k * st + 3].toFixed(1) };
        }
        out.push({ id, n, lengthM: Math.round(arc[n - 1]), slope: [q(slope, .1), q(slope, .5), q(slope, .9)], hw: [q(hw, .1), q(hw, .5), q(hw, .9)],
            depth: [q(depth, .1), q(depth, .5), q(depth, .9)], speed: [q(speed, .1), q(speed, .5), q(speed, .9)], Q: [q(Q, .1), q(Q, .5), q(Q, .9)], steepest: best });
    }
    const cam = g.camera?.position;
    return { R: w.R, cam: cam ? [cam.x, cam.y, cam.z] : null, pages: svc.pages.size, wetPages: svc.wetPages.length, bytes: svc.bytes, rivers: out.sort((a, b) => b.steepest.slope - a.steepest.slope) };
}

// The near simulation's state: blocks, cost, and what the water is doing.
export async function wwStatus({ settleMs = 0 } = {}) {
    if (settleMs) await new Promise(r => setTimeout(r, settleMs));
    const g = window.gameEngine, w = g.whitewater;
    if (!w) return { none: true };
    return { ...w.summary(), camH: w._camH, known: w.known.size, field: g.riverFieldService?.summary?.()?.stats?.rocks };
}

// Reads the first stepped blocks' state back: depth, speed, foam, and how far
// the level has moved from the baked W (the warm-up's measure).
export async function wwReadback({ blocks = 8 } = {}) {
    const g = window.gameEngine, w = g.whitewater, d = w.device, n = Math.min(blocks, w.activeCount), B = 32;
    if (!n) return { blocks: 0 };
    const cells = w.N * w.N, st = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bk = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, st, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, bk, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([st.mapAsync(GPUMapMode.READ), bk.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(st.getMappedRange()), T = new Float32Array(bk.getMappedRange());
    let wet = 0, dz2 = 0, dz = 0, hs = 0, sp = 0, spMax = 0, fo = 0, nan = 0, hMax = 0, fr = 0, base = 0, fb = 0;
    for (let b = 0; b < n; b++) {
        const rx = w._blockData[b * 4 + 2], ry = w._blockData[b * 4 + 3];
        for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
            const id = (ry * B + j) * w.N + rx * B + i, h = S[id * 4], u = S[id * 4 + 1], v = S[id * 4 + 2], f = S[id * 4 + 3];
            if (!Number.isFinite(h + u + v + f)) { nan++; continue; }
            if (h <= 0.02) continue;
            const level = T[id * 8 + 4], bed = T[id * 8], e = bed + h - level, s = Math.hypot(u, v);
            wet++; dz += e; dz2 += e * e; hs += h; sp += s; spMax = Math.max(spMax, s); fo += f; hMax = Math.max(hMax, h); fr += s / Math.sqrt(9.81 * h); base += Math.hypot(T[id * 8 + 5], T[id * 8 + 6]); fb += Math.max(T[id * 8 + 7], 0);
        }
    }
    st.unmap(); bk.unmap(); st.destroy(); bk.destroy();
    const m = (x) => +(x / Math.max(wet, 1)).toFixed(3);
    return { blocks: n, wet, nan, etaMean: m(dz), etaRms: +Math.sqrt(dz2 / Math.max(wet, 1)).toFixed(3), depth: m(hs), depthMax: +hMax.toFixed(2), speed: m(sp), speedBaked: m(base), speedMax: +spMax.toFixed(2), froude: m(fr), foam: m(fo), foamBaked: m(fb) };
}

// Warm-up: forget every block and watch what the water does from the first
// frame, against the baked level and speed. samples: seconds after the reset.
export async function wwWarmup({ samples = [0.1, 0.25, 0.5, 1, 2, 4, 8] } = {}) {
    const w = window.gameEngine.whitewater, out = [];
    w._reset();
    const t0 = performance.now();
    for (const s of samples) {
        while ((performance.now() - t0) / 1000 < s) await new Promise(r => setTimeout(r, 15));
        const r = await wwReadback({ blocks: 60 });
        out.push({ s, active: w.activeCount, steps: w.stats.steps, ...r });
    }
    return out;
}

// Frame gaps while the camera flies along a river at speed, and how the
// simulation copes: frames over 25 ms, fills, drawn blocks.
export async function wwFlight({ river, speed = 60, seconds = 8, height = 25 }) {
    const g = window.gameEngine, s = g.waterService, rec = s.riverRecs.get(river), P = rec.points, st = rec.stride, n = P.length / st;
    const arc = g.waterGpuData._arcLengths(rec), R = g.waterGpuData.R, o = g.planetConfig.origin, w = g.whitewater ?? { stats: { fills: 0 }, activeCount: 0 };
    const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
    const at = (m) => { let k = 0; while (k < n - 2 && arc[k + 1] < m) k++; const f = (m - arc[k]) / Math.max(arc[k + 1] - arc[k], 1e-3), d = norm([0, 1, 2].map(j => P[k * st + j] + (P[(k + 1) * st + j] - P[k * st + j]) * f)); return { d, level: P[k * st + 16] }; };
    const frames = [], fills0 = w.stats.fills, t0 = performance.now();
    let last = t0, minActive = 1e9, maxActive = 0;
    await new Promise(done => {
        const tick = (now) => {
            const t = (now - t0) / 1000;
            frames.push(now - last); last = now;
            minActive = Math.min(minActive, w.activeCount); maxActive = Math.max(maxActive, w.activeCount);
            if (t >= seconds) return done();
            const m = Math.min(arc[n - 1] - 40, 40 + t * speed), a = at(m), b = at(m + 30);
            const p = a.d.map((v, j) => v * (R + a.level + height) + [o.x, o.y, o.z][j]), q = b.d.map((v, j) => v * (R + b.level) + [o.x, o.y, o.z][j]);
            const v3 = x => ({ x: x[0], y: x[1], z: x[2] });
            window.qtDiag.regional.useCamera({ position: v3(p), target: v3(q), up: v3(a.d), fov: 75 });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const sorted = frames.slice(5).sort((a, b) => a - b), q = f => +sorted[Math.floor(f * (sorted.length - 1))].toFixed(1);
    return { frames: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1), over25: sorted.filter(x => x > 25).length, fills: w.stats.fills - fills0, minActive, maxActive };
}

export const wwFlightOff = wwFlight;

// Where the frame goes: fenced GPU span with one part off at a time, at this pose.
export async function wwCost({ settleMs = 3000 } = {}) {
    const { fencedFrames } = await import('/tools/perf/terrainDetail/scene.js');
    const g = window.gameEngine, w = g.whitewater, out = {};
    const span = async () => { await new Promise(r => setTimeout(r, 900)); return +(await fencedFrames(30, 5)).gpuSpanMs.median.toFixed(2); };
    await new Promise(r => setTimeout(r, settleMs));
    w.debugOff = {};
    out.all = await span();
    for (const part of ['rocks', 'spray', 'surface', 'solver']) { w.debugOff = { [part]: true }; out[part] = await span(); }
    w.debugOff = { rocks: true, spray: true, surface: true, solver: true }; out.allOff = await span();
    w.enabled = false; out.switchOff = await span();
    w.enabled = true; w.debugOff = {};
    return { ...out, active: w.activeCount, rocks: w.rockDrawCount };
}

// Which foam sources act where. Reads the solver's state and evaluates its source
// terms per cell over the stepped blocks, in two zones by the baked speed: lake-like
// (still in the bake) and river. eta: how far the surface stands off the baked level.
export async function wwFoamSources({ stillSpeed = 0.3, g = 9.81 } = {}) {
    const w = window.gameEngine.whitewater, d = w.device, N = w.N, B = 32, dx = w.config.dx, hmin = w.config.hmin, cells = N * N;
    const st = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bk = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, st, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, bk, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([st.mapAsync(GPUMapMode.READ), bk.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(st.getMappedRange()), T = new Float32Array(bk.getMappedRange());
    const wrap = (a) => (a + N) % N, id = (i, j) => wrap(j) * N + wrap(i);
    const zone = () => ({ cells: 0, foamCells: 0, Fr: 0, div: 0, slope: 0, rock: 0, rockCells: 0, eta2: 0, etaMax: 0, foamH: [], foamSdf: [], speed: 0 });
    const Z = { lake: zone(), river: zone() };
    for (let b = 0; b < w.activeCount; b++) {
        const rx = w._blockData[b * 4 + 2], ry = w._blockData[b * 4 + 3];
        for (let lj = 0; lj < B; lj++) for (let li = 0; li < B; li++) {
            const i = rx * B + li, j = ry * B + lj, c = id(i, j), h = S[c * 4];
            if (!(h > hmin)) continue;
            const R = id(i + 1, j), Lf = id(i - 1, j), Tp = id(i, j + 1), Bt = id(i, j - 1);
            const bed = T[c * 8], bR = T[R * 8], bL = T[Lf * 8], bT = T[Tp * 8], bB = T[Bt * 8];
            const hR = S[R * 4], hL = S[Lf * 4], hT = S[Tp * 4], hB = S[Bt * 4];
            const uc = 0.5 * (S[c * 4 + 1] + S[R * 4 + 1]), vc = 0.5 * (S[c * 4 + 2] + S[Tp * 4 + 2]), spd = Math.hypot(uc, vc);
            const Fr = spd / Math.sqrt(g * h), div = (S[R * 4 + 1] - S[c * 4 + 1] + S[Tp * 4 + 2] - S[c * 4 + 2]) / dx, eta = bed + h;
            const rock = (hR <= hmin && bR > eta) || (hL <= hmin && bL > eta) || (hT <= hmin && bT > eta) || (hB <= hmin && bB > eta) ? 1 : 0;
            const eR = hR > hmin ? bR + hR : eta, eL = hL > hmin ? bL + hL : eta, eT = hT > hmin ? bT + hT : eta, eB = hB > hmin ? bB + hB : eta;
            const slope = Math.hypot(eR - eL, eT - eB) / (2 * dx), baked = Math.hypot(T[c * 8 + 5], T[c * 8 + 6]), foam0 = Math.max(T[c * 8 + 7], 0);
            const z = baked < stillSpeed ? Z.lake : Z.river, e = eta - T[c * 8 + 4], foam = S[c * 4 + 3];
            z.cells++; z.speed += spd; z.eta2 += e * e; z.etaMax = Math.max(z.etaMax, Math.abs(e));
            z.Fr += Math.max(0, Fr - 0.8) * 1.2; z.div += Math.max(0, -div) * 0.6; z.slope += Math.max(0, slope - (0.15 + 0.5 * foam0)) * 3; z.rock += rock * 0.8 * Math.min(spd, 3) / 3; z.rockCells += rock;
            if (foam > 0.3) { z.foamCells++; if (z.foamH.length < 40000) { z.foamH.push(h); z.foamSdf.push(T[c * 8 + 3]); } }
        }
    }
    st.unmap(); bk.unmap(); st.destroy(); bk.destroy();
    const pct = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(f * (s.length - 1))].toFixed(2) : null; };
    const out = {};
    for (const [k, z] of Object.entries(Z)) {
        const n = Math.max(z.cells, 1), r = (x) => +x.toFixed(4);
        out[k] = { cells: z.cells, speed: r(z.speed / n), etaRms: r(Math.sqrt(z.eta2 / n)), etaMax: r(z.etaMax), foamCells: z.foamCells, rockCells: z.rockCells,
            source: { Fr: r(z.Fr / n), div: r(z.div / n), slope: r(z.slope / n), rock: r(z.rock / n) }, foamDepth: [pct(z.foamH, .1), pct(z.foamH, .5), pct(z.foamH, .9)], foamSdf: [pct(z.foamSdf, .1), pct(z.foamSdf, .5), pct(z.foamSdf, .9)] };
    }
    return out;
}

// The foam sources a few times over, a second apart: does anything travel?
export async function wwLakeWave({ samples = 6 } = {}) {
    const out = [];
    for (let k = 0; k < samples; k++) { const s = await wwFoamSources({}); out.push({ etaRms: s.lake.etaRms, etaMax: s.lake.etaMax, speed: s.lake.speed, foamCells: s.lake.foamCells }); await new Promise(r => setTimeout(r, 1000)); }
    return out;
}

// The surface against the baked level, in still water (baked speed under stillSpeed,
// deep enough to float: not banks) and in the river. A surge shows as a rising level
// and a steep surface in the still zone.
export async function wwSurge({ stillSpeed = 0.3, deep = 0.3 } = {}) {
    const w = window.gameEngine.whitewater, d = w.device, N = w.N, B = 32, dx = w.config.dx, cells = N * N;
    if (!w.activeCount) return { active: 0 };
    const st = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bk = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, st, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, bk, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([st.mapAsync(GPUMapMode.READ), bk.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(st.getMappedRange()), T = new Float32Array(bk.getMappedRange());
    const wrap = (a) => (a + N) % N, id = (i, j) => wrap(j) * N + wrap(i);
    const zones = { still: { e: [], s: [], v: 0, vb: 0, m: [] }, river: { e: [], s: [], v: 0, vb: 0, m: [] } };
    // Where the level is changing: the centre of the cells that moved since the last
    // call, and the baked flow there. Its travel against that flow is a wave going upstream.
    const front = { w: 0, x: 0, y: 0, u: 0, v: 0 };
    // How far each cell's level has moved since the last call: a surge moves, a level
    // that merely stands off the baked one does not.
    const before = wwSurge.last, now = new Map();
    for (let b = 0; b < w.activeCount; b++) {
        const rx = w._blockData[b * 4 + 2], ry = w._blockData[b * 4 + 3];
        for (let lj = 0; lj < B; lj += 2) for (let li = 0; li < B; li += 2) {
            const i = rx * B + li, j = ry * B + lj, c = id(i, j), h = S[c * 4];
            if (!(h > deep)) continue;
            const R = id(i + 1, j), U = id(i, j + 1), eta = T[c * 8] + h;
            if (!(S[R * 4] > deep && S[U * 4] > deep)) continue;
            const z = Math.hypot(T[c * 8 + 5], T[c * 8 + 6]) < stillSpeed ? zones.still : zones.river;
            z.e.push(eta - T[c * 8 + 4]);
            now.set(c, eta);
            if (before?.has(c)) {
                const moved = Math.abs(eta - before.get(c));
                z.m.push(moved);
                if (moved > 0.05) {
                    const x = (w._blockData[b * 4] * B + li) * dx, y = (w._blockData[b * 4 + 1] * B + lj) * dx;
                    front.w += moved; front.x += moved * x; front.y += moved * y; front.u += moved * T[c * 8 + 5]; front.v += moved * T[c * 8 + 6];
                }
            }
            z.s.push(Math.hypot(T[R * 8] + S[R * 4] - eta, T[U * 8] + S[U * 4] - eta) / dx);
            z.v += Math.hypot(S[c * 4 + 1], S[c * 4 + 2]);
            z.vb += Math.hypot(T[c * 8 + 5], T[c * 8 + 6]);
        }
    }
    st.unmap(); bk.unmap(); st.destroy(); bk.destroy();
    wwSurge.last = now;
    const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(f * (s.length - 1))].toFixed(3) : 0; };
    const out = { active: w.activeCount };
    if (front.w > 0) out.front = { x: +(front.x / front.w).toFixed(1), y: +(front.y / front.w).toFixed(1), u: +(front.u / front.w).toFixed(2), v: +(front.v / front.w).toFixed(2), weight: +front.w.toFixed(1) };
    for (const [k, z] of Object.entries(zones)) {
        const n = Math.max(z.e.length, 1), m = z.e.reduce((a, x) => a + x, 0) / n;
        out[k] = { n: z.e.length, mean: +m.toFixed(3), rms: +Math.sqrt(z.e.reduce((a, x) => a + x * x, 0) / n).toFixed(3), p1: q(z.e, .01), p99: q(z.e, .99), slope99: q(z.s, .99), speed: +(z.v / n).toFixed(3), baked: +(z.vb / n).toFixed(3), moved99: q(z.m, .99) };
    }
    return out;
}

// The level along a river now, against its baked level, for a distance-time map: each
// sample a mean over a few cells, stepM (m) apart along the trace, within rangeM of the
// camera. A wave going upstream is a stripe moving toward lower s. dev in cm.
export async function wwAlong({ river, stepM = 8, rangeM = 170, half = 3 }) {
    const g = window.gameEngine, w = g.whitewater, s = g.waterService, d = w.device, N = w.N, dx = w.config.dx, cells = N * N;
    const rec = s.riverRecs.get(river), P = rec.points, st = rec.stride, n = P.length / st, R = g.planetConfig.radius;
    const cam = g.camera.position, l = Math.hypot(cam.x, cam.y, cam.z), [cx, cy] = w._frameXY([cam.x / l, cam.y / l, cam.z / l]);
    const a = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), b = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, a, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, b, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(a.getMappedRange()), T = new Float32Array(b.getMappedRange());
    const wrap = (q) => ((q % N) + N) % N, id = (i, j) => wrap(j) * N + wrap(i);
    const down = P[3] > P[(n - 1) * st + 3] ? 1 : -1, out = [];
    let acc = 0, next = 0, k = down > 0 ? 0 : n - 1;
    while (k + down >= 0 && k + down < n) {
        const p0 = [P[k * st], P[k * st + 1], P[k * st + 2]], k1 = k + down, p1 = [P[k1 * st], P[k1 * st + 1], P[k1 * st + 2]];
        const seg = Math.acos(Math.min(1, p0[0] * p1[0] + p0[1] * p1[1] + p0[2] * p1[2])) * R;
        while (next <= acc + seg) {
            const f = seg > 0 ? (next - acc) / seg : 0, q = p0.map((v, i) => v + (p1[i] - v) * f), m = Math.hypot(...q), [x, y] = w._frameXY(q.map(v => v / m));
            // Only where the ring slot holds this place's block (else it holds another block's
            // cells, 384 m away: a 1.6 m "rise" at the end of the range, 2026-11-10).
            const ci = Math.floor(x / dx), cj = Math.floor(y / dx), bx = Math.floor(ci / 32), by = Math.floor(cj / 32);
            const slot = w.slots[(((by % w.G) + w.G) % w.G) * w.G + (((bx % w.G) + w.G) % w.G)];
            if (Math.hypot(x - cx, y - cy) < rangeM && slot?.filled && slot.bx === bx && slot.by === by) {
                let dev = 0, sp = 0, c = 0, bk = 0, hs = 0, hb = 0;
                for (let v = -half; v <= half; v++) for (let u = -half; u <= half; u++) {
                    const e = id(ci + u, cj + v), h = S[e * 4];
                    if (!(h > 0.1)) continue;
                    dev += T[e * 8] + h - T[e * 8 + 4]; sp += Math.hypot(S[e * 4 + 1], S[e * 4 + 2]); bk += Math.hypot(T[e * 8 + 5], T[e * 8 + 6]); hs += h; hb += T[e * 8 + 4] - T[e * 8]; c++;
                }
                if (c > 4) out.push({ s: Math.round(next), dev: Math.round(100 * dev / c), v: +(sp / c).toFixed(1), vb: +(bk / c).toFixed(1), h: +(hs / c).toFixed(2), hb: +(hb / c).toFixed(2), W: +(T[id(ci, cj) * 8 + 4]).toFixed(2) });
            }
            next += stepM;
        }
        acc += seg; k = k1;
    }
    a.unmap(); b.unmap(); a.destroy(); b.destroy();
    return out;
}

// Where still water stands off its baked level: the cells of wwSurge's still zone with the
// largest rise, grouped by 8 m, each with its place (metres from the camera, along the
// frame), solver and baked depth, speed, and whether the baked state calls it lake.
export async function wwRiseCells({ stillSpeed = 0.3, deep = 0.3, top = 8 } = {}) {
    const g = window.gameEngine, w = g.whitewater, d = w.device, N = w.N, B = 32, dx = w.config.dx, cells = N * N;
    const st = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bk = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, st, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, bk, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([st.mapAsync(GPUMapMode.READ), bk.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(st.getMappedRange()), T = new Float32Array(bk.getMappedRange());
    const wrap = (a) => (a + N) % N, id = (i, j) => wrap(j) * N + wrap(i);
    const cam = g.camera.position, l = Math.hypot(cam.x, cam.y, cam.z), [cx, cy] = w._frameXY([cam.x / l, cam.y / l, cam.z / l]);
    const groups = new Map();
    for (let b = 0; b < w.activeCount; b++) {
        const rx = w._blockData[b * 4 + 2], ry = w._blockData[b * 4 + 3], gx = w._blockData[b * 4] * B, gy = w._blockData[b * 4 + 1] * B;
        for (let lj = 0; lj < B; lj += 2) for (let li = 0; li < B; li += 2) {
            const c = id(rx * B + li, ry * B + lj), h = S[c * 4];
            if (!(h > deep) || Math.hypot(T[c * 8 + 5], T[c * 8 + 6]) >= stillSpeed) continue;
            const rise = T[c * 8] + h - T[c * 8 + 4];
            const x = (gx + li) * dx, y = (gy + lj) * dx, key = Math.round(x / 8) * 100000 + Math.round(y / 8);
            const q = groups.get(key);
            if (!q || rise > q.rise) groups.set(key, { rise: +rise.toFixed(2), x: Math.round(x - cx), y: Math.round(y - cy), h: +h.toFixed(2), hb: +(T[c * 8 + 4] - T[c * 8]).toFixed(2), W: +T[c * 8 + 4].toFixed(2), bed: +T[c * 8].toFixed(2), bakedV: +Math.hypot(T[c * 8 + 5], T[c * 8 + 6]).toFixed(2), v: +Math.hypot(S[c * 4 + 1], S[c * 4 + 2]).toFixed(2), w7: +T[c * 8 + 7].toFixed(2) });
        }
    }
    st.unmap(); bk.unmap(); st.destroy(); bk.destroy();
    return [...groups.values()].sort((a, b) => b.rise - a.rise).slice(0, top);
}

// Containment (2026-11-10, owner: water spills over the banks and the river's surface has
// pits since the solver runs in lake-cell mode). Over every stepped cell, against the baked
// state the block started from: spill (wet now, dry baked: h0 = 0), how far the level stands
// over or under the baked W, water outside the field's pages (sdf -16), and the volume
// against the baked volume. map: a top-down PNG (data URL), 1 px per cell: grey dry,
// blue baked water within 10 cm, red over W (full at +0.5 m), magenta under W (full at
// -1 m), yellow spill (full at 0.5 m deep), black baked water now dry, white the camera.
export async function wwContain({ map = false } = {}) {
    const g = window.gameEngine, w = g.whitewater, d = w.device, N = w.N, B = 32, dx = w.config.dx, cells = N * N;
    if (!w.activeCount) return { active: 0 };
    const st = d.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bk = d.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, st, 0, cells * 16); enc.copyBufferToBuffer(w.staticBuf, 0, bk, 0, cells * 32);
    d.queue.submit([enc.finish()]);
    await Promise.all([st.mapAsync(GPUMapMode.READ), bk.mapAsync(GPUMapMode.READ)]);
    const S = new Float32Array(st.getMappedRange()), T = new Float32Array(bk.getMappedRange());
    const cam = g.camera.position, l = Math.hypot(cam.x, cam.y, cam.z), [cx, cy] = w._frameXY([cam.x / l, cam.y / l, cam.z / l]);
    const lakeOf = (word) => (word < 0 ? -word - 2 * Math.floor(-word * 0.5) : 0);
    const q = (a, f) => { const s = Float64Array.from(a).sort(); return s.length ? +s[Math.floor(f * (s.length - 1))].toFixed(3) : 0; };
    const spill = [], over = [], under = [], spillGroups = new Map(), pitGroups = new Map(), beyondShore = [];
    let beyondDry = 0;
    let vol = 0, vol0 = 0, wet = 0, wet0 = 0, dried = 0, noField = 0, lakeCells = 0, lakeOver = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const blocks = [];
    for (let b = 0; b < w.activeCount; b++) {
        const gx = w._blockData[b * 4], gy = w._blockData[b * 4 + 1], rx = w._blockData[b * 4 + 2], ry = w._blockData[b * 4 + 3];
        blocks.push([gx, gy, rx, ry]);
        minX = Math.min(minX, gx); minY = Math.min(minY, gy); maxX = Math.max(maxX, gx); maxY = Math.max(maxY, gy);
        for (let lj = 0; lj < B; lj++) for (let li = 0; li < B; li++) {
            const c = (ry * B + lj) * N + rx * B + li, h = S[c * 4], bed = T[c * 8], h0 = T[c * 8 + 2], sdf = T[c * 8 + 3], W = T[c * 8 + 4], lake = lakeOf(T[c * 8 + 7]);
            vol += h > 0.02 ? h : 0; vol0 += h0;
            if (h0 > 0) wet0++;
            if (sdf === -16) noField++;
            if (lake > 0) lakeCells++;
            if (!(h > 0.02)) { if (h0 > 0.1) dried++; continue; }
            wet++;
            // Water past the baked shore (sdf < 0) and past where the solver starts dry.
            if (sdf < 0) { beyondShore.push(h); if (sdf < -1.5) beyondDry++; }
            const eta = bed + h, x = (gx * B + li) * dx - cx, y = (gy * B + lj) * dx - cy, key = Math.round(x / 8) * 100000 + Math.round(y / 8);
            if (h0 <= 0) {
                spill.push(h);
                const s = spillGroups.get(key);
                if (!s || h > s.h) spillGroups.set(key, { h: +h.toFixed(2), x: Math.round(x), y: Math.round(y), eta: +eta.toFixed(2), bed: +bed.toFixed(2), W: +W.toFixed(2), sdf: +sdf.toFixed(1), lake: +lake.toFixed(2), n: (s?.n ?? 0) + 1 });
                else s.n++;
                continue;
            }
            const e = eta - W;
            if (lake > 0) lakeOver.push(e);
            if (e > 0) over.push(e); else under.push(-e);
            if (e < -0.2) {
                const s = pitGroups.get(key);
                if (!s || e < s.e) pitGroups.set(key, { e: +e.toFixed(2), x: Math.round(x), y: Math.round(y), h: +h.toFixed(2), h0: +h0.toFixed(2), W: +W.toFixed(2), bed: +bed.toFixed(2), lake: +lake.toFixed(2), v: +Math.hypot(S[c * 4 + 1], S[c * 4 + 2]).toFixed(2), vb: +Math.hypot(T[c * 8 + 5], T[c * 8 + 6]).toFixed(2), n: (s?.n ?? 0) + 1 });
                else s.n++;
            }
        }
    }
    // Along the flow: each wet river cell's level against the level 2 m upstream along the baked
    // flow (bilinear over wet cells), and its velocity against the baked direction.
    const wrapN = (a) => ((a % N) + N) % N, cid = (i, j) => wrapN(j) * N + wrapN(i);
    // baked: the baked level W instead (monotone by construction): the measure's own floor.
    const etaAt = (x, y, baked = false) => {
        const gx = x - 0.5, gy = y - 0.5, i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
        let sum = 0, wsum = 0;
        for (let k = 0; k < 4; k++) {
            const di = k & 1, dj = k >> 1, w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy), c = cid(i0 + di, j0 + dj), h = S[c * 4];
            if (h > 0.02 && w > 0) { sum += w * (baked ? T[c * 8 + 4] : T[c * 8] + h); wsum += w; }
        }
        return wsum > 0.5 ? sum / wsum : NaN;
    };
    const rises = [], back = [], wRises = [], uphillCells = new Set();
    let riverCells = 0;
    for (const [gx, gy, rx, ry] of blocks) for (let lj = 0; lj < B; lj++) for (let li = 0; li < B; li++) {
        const i = rx * B + li, j = ry * B + lj, c = cid(i, j), h = S[c * 4], ub = T[c * 8 + 5], vb = T[c * 8 + 6], bs = Math.hypot(ub, vb);
        if (!(h > 0.02) || bs < 0.05) continue;
        riverCells++;
        const up = etaAt(i + 0.5 - 4 * ub / bs, j + 0.5 - 4 * vb / bs), eta = T[c * 8] + h;
        if (Number.isFinite(up)) { rises.push(eta - up); if (eta - up > 0.01) uphillCells.add(c); }
        const wUp = etaAt(i + 0.5 - 4 * ub / bs, j + 0.5 - 4 * vb / bs, true);
        if (Number.isFinite(wUp)) wRises.push(T[c * 8 + 4] - wUp);
        const uc = 0.5 * (S[c * 4 + 1] + S[cid(i + 1, j) * 4 + 1]), vc = 0.5 * (S[c * 4 + 2] + S[cid(i, j + 1) * 4 + 2]);
        back.push((uc * ub + vc * vb) / bs);
    }
    // Local life (what the solver is for): foam, the level's and the speed's spread around the
    // baked state over wet river cells, and the blocks' mean level against the baked (the drift).
    const foamV = [], devV = [], spdV = [], blockMeans = [];
    for (const [gx, gy, rx, ry] of blocks) {
        let bs = 0, bn = 0;
        for (let lj = 0; lj < B; lj++) for (let li = 0; li < B; li++) {
            const c = cid(rx * B + li, ry * B + lj), h = S[c * 4];
            if (!(h > 0.02) || !(T[c * 8 + 2] > 0)) continue;
            const dev = T[c * 8] + h - T[c * 8 + 4];
            bs += dev; bn++;
            if (Math.hypot(T[c * 8 + 5], T[c * 8 + 6]) < 0.05) continue;
            foamV.push(S[c * 4 + 3]); devV.push(dev);
            spdV.push(Math.hypot(S[c * 4 + 1], S[c * 4 + 2]) - Math.hypot(T[c * 8 + 5], T[c * 8 + 6]));
        }
        if (bn > 64) blockMeans.push(bs / bn);
    }
    const rms = (a) => +Math.sqrt(a.reduce((x, y) => x + y * y, 0) / Math.max(a.length, 1)).toFixed(3);
    const mean = (a) => +(a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)).toFixed(3);
    const life = { foamMean: mean(foamV), foamP90: q(foamV, 0.9), devRms: rms(devV), dev5cm: +(devV.filter(x => Math.abs(x) > 0.05).length / Math.max(devV.length, 1)).toFixed(3),
        speedDevRms: rms(spdV), blockMeanRms: rms(blockMeans), blockMeanMax: q(blockMeans.map(Math.abs), 1) };
    const uphill = rises.filter(x => x > 0.01), backward = back.filter(x => x < -0.05);
    const along = { riverCells, uphill1cm: uphill.length, uphillP99: q(rises, 0.99), uphillMax: q(rises, 1), backward5cm: backward.length, backwardMin: q(back, 0),
        bakedUphill1cm: wRises.filter(x => x > 0.01).length, bakedUphillMax: q(wRises, 1) };
    let png = null;
    if (map) {
        const Wd = (maxX - minX + 1) * B, Ht = (maxY - minY + 1) * B, cv = document.createElement('canvas');
        cv.width = Wd; cv.height = Ht;
        const cx2 = cv.getContext('2d'), img = cx2.createImageData(Wd, Ht), px = img.data;
        for (let k = 0; k < px.length; k += 4) { px[k] = 20; px[k + 1] = 20; px[k + 2] = 24; px[k + 3] = 255; }
        for (const [gx, gy, rx, ry] of blocks) for (let lj = 0; lj < B; lj++) for (let li = 0; li < B; li++) {
            const c = (ry * B + lj) * N + rx * B + li, h = S[c * 4], bed = T[c * 8], h0 = T[c * 8 + 2], W = T[c * 8 + 4];
            // North up: frame y grows upward on the image.
            const X = (gx - minX) * B + li, Y = Ht - 1 - ((gy - minY) * B + lj), o = (Y * Wd + X) * 4;
            let r = 110, gg = 110, bb = 100;
            if (h > 0.02 && h0 <= 0) { const t = Math.min(1, h / 0.5); r = 255; gg = 220; bb = 40 * (1 - t); }
            else if (h > 0.02) {
                const e = bed + h - W;
                if (e > 0.1) { const t = Math.min(1, e / 0.5); r = 120 + 135 * t; gg = 60 * (1 - t); bb = 160 * (1 - t); }
                else if (e < -0.2) { const t = Math.min(1, -e / 1); r = 150 + 105 * t; gg = 40; bb = 200 + 55 * t; }
                else { r = 40; gg = 90; bb = 200; }
            } else if (h0 > 0.1) { r = 0; gg = 0; bb = 0; }
            // Bright green: the level more than 1 cm over the level 2 m upstream along the flow.
            if (uphillCells.has(c)) { r = 0; gg = 255; bb = 0; }
            px[o] = r; px[o + 1] = gg; px[o + 2] = bb;
        }
        cx2.putImageData(img, 0, 0);
        const X = Math.round(cx / dx - minX * B), Y = Ht - 1 - Math.round(cy / dx - minY * B);
        cx2.fillStyle = '#fff'; cx2.fillRect(X - 3, Y - 3, 7, 7);
        png = { url: cv.toDataURL('image/png'), originM: [minX * B * dx - cx, minY * B * dx - cy], size: [Wd, Ht] };
    }
    st.unmap(); bk.unmap(); st.destroy(); bk.destroy();
    const top = (m, k, by) => [...m.values()].sort(by).slice(0, k);
    return { active: w.activeCount, cells: w.activeCount * B * B, wet, wet0, dried, noField, lakeCells,
        volume: +vol.toFixed(1), volume0: +vol0.toFixed(1),
        spill: { n: spill.length, p50: q(spill, 0.5), p90: q(spill, 0.9), max: q(spill, 1) },
        beyondShore: { n: beyondShore.length, p90: q(beyondShore, 0.9), max: q(beyondShore, 1), pastDry: beyondDry },
        over: { n: over.length, p50: q(over, 0.5), p90: q(over, 0.9), p99: q(over, 0.99), max: q(over, 1) },
        under: { n: under.length, p50: q(under, 0.5), p90: q(under, 0.9), p99: q(under, 0.99), max: q(under, 1) },
        lake: { n: lakeOver.length, p1: q(lakeOver, 0.01), p50: q(lakeOver, 0.5), p99: q(lakeOver, 0.99) },
        along, life, spillAt: top(spillGroups, 10, (a, b) => b.h - a.h), pitAt: top(pitGroups, 10, (a, b) => a.e - b.e), map: png };
}
