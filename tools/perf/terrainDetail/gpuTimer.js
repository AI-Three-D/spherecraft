// tools/perf/terrainDetail/gpuTimer.js
//
// Injected before page scripts (puppeteer evaluateOnNewDocument), after
// lakeRecovery/pageInstrument.js. Requests 'timestamp-query' and, while
// window.__gpuTimer.enabled, gives every render and compute pass begin/end
// timestamps; drain() collects them into passes [{ label, begin, end }] (ns).
// Use with fenced frames (scene.js fencedFrames): on Apple's tile-based
// GPUs render passes overlap and their begin/end include waiting, so pass
// durations summed over a running loop came to 60-130 ms in 33 ms frames
// (run ab1). One frame alone on the GPU: its span, first begin to last end.
// Measurement only: nothing the page draws changes.
(() => {
    const T = window.__gpuTimer = { enabled: false, supported: false, passes: [], pending: [] };
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (desc = {}) {
        T.supported = this.features.has('timestamp-query');
        const d = await request.call(this, T.supported
            ? { ...desc, requiredFeatures: [...(desc.requiredFeatures ?? []), 'timestamp-query'] } : desc);
        if (!T.supported) return d;
        const MAX = 128, pool = [];
        const take = () => pool.pop() ?? {
            qs: d.createQuerySet({ type: 'timestamp', count: 2 * MAX }),
            resolve: d.createBuffer({ size: 2 * MAX * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
            read: d.createBuffer({ size: 2 * MAX * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        };
        const create = d.createCommandEncoder.bind(d);
        d.createCommandEncoder = (desc) => {
            const enc = create(desc);
            if (!T.enabled) return enc;
            let slot = null, n = 0;
            const labels = [];
            for (const name of ['beginRenderPass', 'beginComputePass']) {
                const begin = enc[name].bind(enc);
                enc[name] = (pd = {}) => {
                    if (pd.timestampWrites || n >= MAX) return begin(pd);
                    slot ??= take();
                    labels.push(pd.label ?? name);
                    const i = 2 * n++;
                    return begin({ ...pd, timestampWrites: { querySet: slot.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } });
                };
            }
            const finish = enc.finish.bind(enc);
            enc.finish = (fd) => {
                if (slot) {
                    enc.resolveQuerySet(slot.qs, 0, 2 * n, slot.resolve, 0);
                    enc.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 2 * n * 8);
                    T.pending.push({ slot, n, labels });
                }
                return finish(fd);
            };
            return enc;
        };
        // Call after disabling and letting the finished encoders submit.
        T.drain = async () => {
            await d.queue.onSubmittedWorkDone();
            for (const p of T.pending.splice(0)) {
                await p.slot.read.mapAsync(GPUMapMode.READ, 0, 2 * p.n * 8);
                const t = new BigUint64Array(p.slot.read.getMappedRange(0, 2 * p.n * 8));
                for (let k = 0; k < p.n; k++) {
                    const begin = Number(t[2 * k]), end = Number(t[2 * k + 1]);
                    if (begin > 0 && end > begin && end - begin < 1e9) T.passes.push({ label: p.labels[k], begin, end });
                }
                p.slot.read.unmap();
                pool.push(p.slot);
            }
        };
        return d;
    };
})();
