// Position the review camera at a real subcritical visible rock and inspect
// the solver's local velocity/level. Runs only in the diagnostic browser.
export async function placeRock({ minRadius = 1.2 } = {}) {
    const g = window.gameEngine, field = g.riverFieldService, water = g.waterGpuData, R = water.R;
    const cam = g.camera.position, n = Math.hypot(cam.x, cam.y, cam.z), cd = [cam.x / n, cam.y / n, cam.z / n];
    const rocks = field.rocks, candidates = [];
    for (let k = 0; k < rocks.length; k += 9) {
        const d = Array.from(rocks.subarray(k, k + 3)), radius = rocks[k + 3], top = rocks[k + 4], level = rocks[k + 7];
        if (rocks[k + 8] >= .5 || radius < minRadius || top < level - .05) continue;
        const distance = Math.acos(Math.max(-1, Math.min(1, d[0] * cd[0] + d[1] * cd[1] + d[2] * cd[2]))) * R;
        candidates.push({ d, radius, top, level, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    if (!candidates.length) throw new Error('No visible non-solid rock in the baked field');
    const rock = candidates[0];
    let best = null;
    for (const [id, rec] of water._appliedRivers) {
        const P = rec.points, st = rec.stride, n = P.length / st;
        for (let k = 1; k < n - 1; k++) {
            const cosine = P[k * st] * rock.d[0] + P[k * st + 1] * rock.d[1] + P[k * st + 2] * rock.d[2];
            if (!best || cosine > best.cosine) best = { id, rec, k, cosine };
        }
    }
    if (!best) throw new Error('No traced river near the rock');
    const P = best.rec.points, st = best.rec.stride, k = best.k;
    const norm = a => { const n = Math.hypot(...a); return a.map(x => x / n); };
    const tangent = norm([0, 1, 2].map(i => P[(k + 1) * st + i] - P[(k - 1) * st + i]));
    const origin = g.planetConfig.origin ?? { x: 0, y: 0, z: 0 }, o = [origin.x, origin.y, origin.z];
    const centre = rock.d.map((v, i) => o[i] + v * (R + rock.level));
    const pos = centre.map((v, i) => v + 16 * rock.d[i] - 24 * tangent[i]);
    const look = centre.map((v, i) => v + 3 * tangent[i]);
    const v = a => ({ x: a[0], y: a[1], z: a[2] });
    window.qtDiag.regional.useCamera({ position: v(pos), target: v(look), up: v(rock.d), fov: 75 });
    window.__rockReview = { ...rock, tangent, river: best.id, pos, look };
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).settle();
    await new Promise(resolve => setTimeout(resolve, 4000));
    return window.__rockReview;
}

export async function rockState() {
    const g = window.gameEngine, w = g.whitewater, r = window.__rockReview;
    if (!r || !w?._gpuReady) throw new Error('Rock review not ready');
    const device = w.device, cells = w.N * w.N;
    const a = device.createBuffer({ size: cells * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const b = device.createBuffer({ size: cells * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(w.stateBufs[0], 0, a, 0, cells * 16);
    enc.copyBufferToBuffer(w.staticBuf, 0, b, 0, cells * 32);
    device.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    try {
        const S = new Float32Array(a.getMappedRange()), T = new Float32Array(b.getMappedRange());
        const [x, y] = w._frameXY(r.d), tx = r.tangent.reduce((v, p, i) => v + p * w.frame.e1[i], 0), ty = r.tangent.reduce((v, p, i) => v + p * w.frame.e2[i], 0);
        const len = Math.hypot(tx, ty), u = tx / len, v = ty / len, side = [-v, u];
        const wrap = k => ((k % w.N) + w.N) % w.N;
        const sample = (along, across) => {
            const i = Math.floor((x + r.radius * (along * u + across * side[0])) / w.config.dx);
            const j = Math.floor((y + r.radius * (along * v + across * side[1])) / w.config.dx), id = wrap(j) * w.N + wrap(i);
            const sx = S[id * 4 + 1], sy = S[id * 4 + 2], encoded = T[id * 8 + 1];
            return { along, across, depth: S[id * 4], speed: [sx * u + sy * v, sx * side[0] + sy * side[1]],
                baked: [T[id * 8 + 5] * u + T[id * 8 + 6] * v, T[id * 8 + 5] * side[0] + T[id * 8 + 6] * side[1]],
                steer: Math.floor(encoded * .5) / 255, foam: S[id * 4 + 3], levelError: T[id * 8] + S[id * 4] - T[id * 8 + 4] };
        };
        return { rock: r, active: w.activeCount, samples: [[-3, 0], [-1.5, 1], [-1.5, -1], [1.5, 1], [1.5, -1], [3, 0]].map(q => sample(...q)) };
    } finally { a.unmap(); b.unmap(); a.destroy(); b.destroy(); }
}

export async function compareRockSteering({ settleMs = 8000 } = {}) {
    const w = window.gameEngine.whitewater, previous = w.config.rockSteerRate;
    try {
        const enabled = await rockState();
        w.config.rockSteerRate = 0;
        await new Promise(resolve => setTimeout(resolve, settleMs));
        const disabled = await rockState();
        w.config.rockSteerRate = previous;
        await new Promise(resolve => setTimeout(resolve, settleMs));
        return { enabled, disabled, reenabled: await rockState() };
    } finally { w.config.rockSteerRate = previous; }
}
