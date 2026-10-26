// tools/perf/terrainDetail/scene.js
//
// Page side of abDetail.mjs (imported from the page): the detail switch,
// visible tile depths, GPU time per frame (gpuTimer.js) and test cases
// beyond the owner's gentle-terrain poses: mountain streams (steep, from
// alpine lakes) and flat ones from high lakes (plateaus).

const sleep = ms => new Promise(r => setTimeout(r, ms));
const engine = () => window.gameEngine;
const tileManager = () => engine().renderer.quadtreeTileManager;

/** 'sea' or 'ground' (QuadtreeGPU.setLodHeightSource). */
export function setLodHeight(source) {
    tileManager().quadtreeGPU.setLodHeightSource(source);
    return tileManager().quadtreeGPU.lodHeightSource;
}

/** Visible tiles per quadtree depth (last visibility readback). */
export function visibleDepths() {
    const tiles = tileManager().tileStreamer._lastVisibleTilesList ?? [];
    const depths = {};
    for (const t of tiles) { const d = t.depth ?? t[1]; depths[d] = (depths[d] ?? 0) + 1; }
    return { count: tiles.length, depths };
}

/**
 * Frames rendered one at a time with the GPU idle before and after each
 * (the engine's loop paused): per frame the wall time (render call to work
 * done, CPU encoding included) and the GPU span (first pass begin to last
 * pass end, gpuTimer.js). Medians and p90 over `frames` after `warm`.
 */
export async function fencedFrames(frames = 40, warm = 5) {
    const T = window.__gpuTimer, g = engine(), queue = g.renderer.backend.device.queue;
    const render = g.render;
    g.render = async () => {};
    const wall = [], span = [], passes = [];
    try {
        while (g._renderInFlight) await sleep(5);
        await queue.onSubmittedWorkDone();
        for (let i = 0; i < warm + frames; i++) {
            T.passes = [];
            T.enabled = T.supported;
            const t0 = performance.now();
            await render.call(g, 1 / 60);
            await queue.onSubmittedWorkDone();
            const ms = performance.now() - t0;
            T.enabled = false;
            if (T.supported) await T.drain();
            if (i < warm) continue;
            wall.push(ms);
            if (T.passes.length) {
                span.push((Math.max(...T.passes.map(p => p.end)) - Math.min(...T.passes.map(p => p.begin))) / 1e6);
                passes.push(T.passes.length);
            }
        }
    } finally { T.enabled = false; g.render = render; }
    const stat = a => { const s = [...a].sort((x, y) => x - y); return s.length ? { median: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)] } : null; };
    return { frames, wallMs: stat(wall), gpuSpanMs: stat(span), passes: stat(passes) };
}

/**
 * Mountain streams within withinM of the camera, traced, with their level
 * profile: { id, distanceM, lengthM, srcLevel, endLevel, slope (mean),
 * steepest (over 100 m), hwMedian, src, dest }.
 */
export async function riverCases({ withinM = 40000, count = 16 } = {}) {
    const g = engine(), s = g.waterService, o = g.planetConfig.origin, p = g.camera.position, R = g.waterGpuData.R;
    const rel = [p.x - o.x, p.y - o.y, p.z - o.z], l = Math.hypot(...rel), dir = rel.map(x => x / l);
    const near = s.rivers.filter(r => r.mountain).map(r => ({ id: r.id, m: s._riverDistance(r.id, dir) }))
        .filter(r => r.m < withinM).sort((a, b) => a.m - b.m).slice(0, count);
    for (const r of near) {
        for (let i = 0; i < 900 && !s.riverRecs.has(r.id) && !s._failedRivers.has(r.id); i++) {
            if (i % 20 === 0 && !s._busy) s.refineRiver(r.id);
            await sleep(100);
        }
    }
    const out = [];
    for (const r of near) {
        const rec = s.riverRecs.get(r.id);
        if (!rec || rec.stride < 20) continue;
        const P = rec.points, st = rec.stride, n = P.length / st;
        const arc = [0];
        for (let k = 1; k < n; k++) {
            const c = P[(k - 1) * st] * P[k * st] + P[(k - 1) * st + 1] * P[k * st + 1] + P[(k - 1) * st + 2] * P[k * st + 2];
            arc.push(arc[k - 1] + R * Math.acos(Math.min(1, c)));
        }
        const level = k => P[k * st + 16];
        let steepest = 0;
        for (let a = 0, b = 0; a < n; a++) {
            while (b < n - 1 && arc[b] - arc[a] < 100) b++;
            if (arc[b] - arc[a] >= 100) steepest = Math.max(steepest, (level(a) - level(b)) / (arc[b] - arc[a]));
        }
        const hw = Array.from({ length: n }, (_, k) => P[k * st + 4]).sort((x, y) => x - y);
        out.push({ id: r.id, distanceM: r.m, lengthM: arc[n - 1], srcLevel: level(0), endLevel: level(n - 1),
            slope: (level(0) - level(n - 1)) / Math.max(1, arc[n - 1]), steepest, hwMedian: hw[n >> 1], src: rec.src, dest: rec.dest });
    }
    return out;
}
