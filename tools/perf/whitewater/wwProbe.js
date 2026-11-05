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
            if (Math.hypot(x - cx, y - cy) < rangeM) {
                const ci = Math.floor(x / dx), cj = Math.floor(y / dx);
                let dev = 0, sp = 0, c = 0;
                for (let v = -half; v <= half; v++) for (let u = -half; u <= half; u++) {
                    const e = id(ci + u, cj + v), h = S[e * 4];
                    if (!(h > 0.1)) continue;
                    dev += T[e * 8] + h - T[e * 8 + 4]; sp += Math.hypot(S[e * 4 + 1], S[e * 4 + 2]); c++;
                }
                if (c > 4) out.push({ s: Math.round(next), dev: Math.round(100 * dev / c), v: +(sp / c).toFixed(1) });
            }
            next += stepM;
        }
        acc += seg; k = k1;
    }
    a.unmap(); b.unmap(); a.destroy(); b.destroy();
    return out;
}
