// Injected before page scripts (puppeteer evaluateOnNewDocument). Read-only
// timing wrappers around the original (non-regional) water service; nothing
// here changes what the service computes or in which order.
(() => {
    const LR = window.__lr = {
        t0: performance.now(), compiles: [], events: [], states: [], summaries: [], regen: [], gpuErrors: [], frames: [],
    };
    const now = () => performance.now();

    // GPU errors, device loss and pipeline compile durations.
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
        const d = await request.apply(this, args);
        d.addEventListener('uncapturederror', e => LR.gpuErrors.push({ t: now(), message: e.error.message }));
        d.lost.then(e => LR.gpuErrors.push({ t: now(), lost: true, reason: e.reason, message: e.message }));
        for (const kind of ['createComputePipelineAsync', 'createRenderPipelineAsync']) {
            const orig = d[kind].bind(d);
            d[kind] = async (desc) => {
                const start = now();
                const mod = desc?.compute?.module ?? desc?.vertex?.module;
                const rec = { kind, label: desc?.label ?? mod?.label ?? null, entry: desc?.compute?.entryPoint ?? desc?.vertex?.entryPoint ?? null, start };
                try { return await orig(desc); } finally { rec.ms = now() - start; LR.compiles.push(rec); }
            };
        }
        // Synchronous pipelines block the main thread while the driver
        // compiles (run 24: one 12.5 s stall after a shader change); the
        // slow ones (> 20 ms) are recorded with their fragment entry.
        for (const kind of ['createRenderPipeline', 'createComputePipeline']) {
            const orig = d[kind].bind(d);
            d[kind] = (desc) => {
                const start = now();
                try { return orig(desc); } finally {
                    const ms = now() - start;
                    if (ms > 20) LR.compiles.push({ kind, label: desc?.label ?? desc?.fragment?.module?.label ?? desc?.vertex?.module?.label ?? null,
                        entry: desc?.fragment?.entryPoint ?? desc?.compute?.entryPoint ?? null, start, ms });
                }
            };
        }
        return d;
    };

    const frameOf = (f) => f && { nx: f.nx, ny: f.ny, spacing: f.spacing, cells: f.nx * f.ny };
    function wrapAsync(obj, name, tag, describe = () => null) {
        const orig = obj[name];
        obj[name] = async function (...a) {
            const ev = { tag, start: now(), args: describe(a) };
            try {
                const r = await orig.apply(this, a);
                ev.ok = r != null && r !== false;
                if (r && typeof r === 'object' && 'status' in r) ev.status = r.status;
                return r;
            } catch (e) { ev.err = String(e); throw e; } finally { ev.ms = now() - ev.start; LR.events.push(ev); }
        };
    }

    let lastState = null, lastFrame = now();
    function frameLoop() {
        const t = now();
        LR.frames.push(t - lastFrame);
        if (LR.frames.length > 20000) LR.frames.splice(0, 10000);
        lastFrame = t;
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);

    setInterval(() => {
        const g = window.gameEngine, s = g?.waterService;
        if (!s) return;
        if (s.state !== lastState) { LR.states.push({ t: now(), state: s.state }); lastState = s.state; }
        if (!s.__lr) {
            s.__lr = true;
            LR.serviceCreatedAt = now();
            wrapAsync(s, '_refineLake', 'lake', a => ({ id: a[0] }));
            wrapAsync(s, '_refineRiver', 'river', a => ({ id: a[0], depth: a[1] }));
            wrapAsync(s, '_bakeValley', 'valley', a => ({ id: a[0], fromCache: a[2] }));
            wrapAsync(s, '_resolveLakeIncluding', 'regrow', a => ({ id: a[0] }));
        }
        if (s._sampler && !s._sampler.__lr) {
            s._sampler.__lr = true;
            LR.samplerReadyAt = now();
            wrapAsync(s._sampler, 'samplePatch', 'samplePatch', a => ({ ...frameOf(a[0]), carved: !!a[2]?.carved }));
            wrapAsync(s._sampler, 'sampleGrid', 'sampleGrid', a => ({ N: a[0] }));
        }
        if (s._client && !s._client.__lr) {
            s._client.__lr = true;
            wrapAsync(s._client, 'call', 'worker', a => ({ type: a[0]?.type, id: a[0]?.lakeId ?? a[0]?.riverId, frame: frameOf(a[0]?.frame) }));
        }
        const tm = g.renderer?.quadtreeTileManager;
        if (tm && !tm.__lr && tm.regenerateTiles) {
            tm.__lr = true;
            const orig = tm.regenerateTiles.bind(tm);
            tm.regenerateTiles = (pred) => { const start = now(); const n = orig(pred); LR.regen.push({ t: start, queued: n, ms: now() - start }); return n; };
        }
    }, 20);

    setInterval(() => {
        const s = window.gameEngine?.waterService;
        if (s?.state === 'ready') {
            const m = s.summary();
            LR.summaries.push({ t: now(), refined: m.refined, merged: m.merged, failed: m.failed, riversTraced: m.riversTraced, riversFailed: m.riversFailed, busy: !!s._busy });
        }
    }, 1000);

    // Helpers called from the harness.
    LR.b64 = (typed) => {
        const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
    };
    // Pause the day cycle with the sun at a fixed height over dir (sun.up = target).
    LR.daylightAt = (dir, target = 0.75) => {
        const st = window.gameEngine?.starSystem, body = st?.currentBody;
        if (!body) return null;
        st.paused = true; st.useGameTimeRotation = false;
        let best = Infinity, rotation = 0, dot = 0;
        for (let i = 0; i < 1440; i++) {
            body.currentRotation = i * Math.PI * 2 / 1440;
            const d = body.getStarDirection(st.primaryStar).direction;
            const h = d.x * dir[0] + d.y * dir[1] + d.z * dir[2];
            if (Math.abs(h - target) < best) { best = Math.abs(h - target); rotation = body.currentRotation; dot = h; }
        }
        body.currentRotation = rotation;
        return { rotation, sunUpDot: dot };
    };
    LR.pose = () => {
        const c = window.gameEngine?.camera;
        return c ? { position: { ...c.position }, target: { ...c.target }, up: { ...c.up }, fov: c.fov } : null;
    };
    LR.residency = () => {
        const tm = window.gameEngine?.renderer?.quadtreeTileManager;
        return tm?.getInitialLoadStatus?.() ?? null;
    };
})();
