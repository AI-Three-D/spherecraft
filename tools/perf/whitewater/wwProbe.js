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
            wet++; dz += e; dz2 += e * e; hs += h; sp += s; spMax = Math.max(spMax, s); fo += f; hMax = Math.max(hMax, h); fr += s / Math.sqrt(9.81 * h); base += Math.hypot(T[id * 8 + 5], T[id * 8 + 6]); fb += T[id * 8 + 7];
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
