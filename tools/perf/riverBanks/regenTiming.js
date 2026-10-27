// tools/perf/riverBanks/regenTiming.js
//
// Page side (pageProbe.mjs): pose a view, then regenerate every resident tile
// `rounds` times and time each until the streamer is idle again (wall ms).
export async function regenTiming({ view, rounds = 3 }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    await q.poseView(view);
    const ts = window.gameEngine.renderer.quadtreeTileManager.tileStreamer, out = [];
    for (let r = 0; r < rounds; r++) {
        const t0 = performance.now();
        const n = ts.regenerateTiles(() => true);
        await new Promise(res => setTimeout(res, 50));
        await q.settle(300000);
        out.push({ n, ms: Math.round(performance.now() - t0) });
    }
    return out;
}

// GPU time of tile generation: regenerate every resident tile with the
// timestamp timer on (terrainDetail/gpuTimer.js, injected by capture.mjs /
// pageProbe.mjs --gpu-timer), summed per compute pass label (ms). Compute
// passes within one generation encoder run one after another.
export async function regenGpu({ view, tiles = 80 }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    await q.poseView(view);
    const T = window.__gpuTimer;
    if (!T?.supported) return { error: 'no timestamp-query' };
    const ts = window.gameEngine.renderer.quadtreeTileManager.tileStreamer;
    T.passes.length = 0;
    T.enabled = true;
    // A fixed sample: the timer keeps every encoder's query buffers until
    // drain, and all resident tiles' encoders exhausted the page.
    let left = tiles;
    const n = ts.regenerateTiles(() => left-- > 0);
    await new Promise(res => setTimeout(res, 50));
    await q.settle(300000);
    T.enabled = false;
    await new Promise(res => setTimeout(res, 200));
    await T.drain();
    const by = {};
    for (const p of T.passes) {
        if (!/^Gen|Compute|Splat|Resolved/i.test(p.label)) continue;
        by[p.label] = (by[p.label] ?? 0) + (p.end - p.begin) / 1e6;
    }
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { tiles: n, totalMs: +total.toFixed(1), perLabel: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +v.toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 10)) };
}
