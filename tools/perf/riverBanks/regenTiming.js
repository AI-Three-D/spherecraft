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

// Generate exactly the same tile addresses in successive shader arms. This
// avoids comparing different resident-map insertion orders after a camera
// sweep. Generation uses the streamer's normal geometry/refinement outputs.
export async function fixedTilesGpu({ view, tiles = 80, tileKeys = null }) {
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    const { TileAddress } = await import('/core/world/quadtree/tileAddress.js');
    await q.poseView(view);
    const g = window.gameEngine, ts = g.renderer.quadtreeTileManager.tileStreamer;
    const T = window.__gpuTimer, queue = g.waterGpuData.device.queue;
    if (!T?.supported) throw new Error('Fixed tile timing requires timestamp-query');
    const keys = tileKeys ?? [...new Map((ts._lastVisibleTilesList ?? []).map(t => {
        const a = [t.face ?? t[0], t.depth ?? t[1], t.x ?? t[2], t.y ?? t[3]];
        return [a.join('/'), a];
    })).values()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]||a[2]-b[2]||a[3]-b[3]).slice(0,tiles);
    if (keys.length !== tiles) throw new Error(`Expected ${tiles} fixed tiles, got ${keys.length}`);
    const render = g.render;
    g.render = async () => {};
    T.passes.length = 0;
    try {
        while (g._renderInFlight) await new Promise(r=>setTimeout(r,5));
        await queue.onSubmittedWorkDone();
        T.enabled = true;
        for (const [face,depth,x,y] of keys) {
            const addr = new TileAddress(face,depth,x,y);
            const types = [...new Set([...ts._geometryTypes,...ts._refinementTypesFor(addr)])];
            const textures = await ts.tileGenerator.generateTile(addr,null,types);
            await queue.onSubmittedWorkDone();
            ts._destroyGeneratedTextures(textures);
        }
    } finally {
        T.enabled = false;
        g.render = render;
    }
    await T.drain();
    const by = {};
    for (const p of T.passes) {
        if (!/^Gen|Compute|Splat|Resolved/i.test(p.label)) continue;
        by[p.label] = (by[p.label] ?? 0) + (p.end-p.begin)/1e6;
    }
    return {tiles:keys.length,tileKeys:keys,totalMs:+Object.values(by).reduce((a,b)=>a+b,0).toFixed(2),perLabel:by};
}
