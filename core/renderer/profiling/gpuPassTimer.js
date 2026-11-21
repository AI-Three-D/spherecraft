// @ts-nocheck
// Per-pass GPU timing with timestamp queries ('timestamp-query' device feature).
// Passes opt in with `timestampWrites(name)`. A frame is bracketed by marker
// passes recorded into the frame's own command encoder (timestamps from
// different command buffers are not comparable on every backend), resolved
// there, and read back asynchronously after submit.

const HISTORY = 120;
/** Passes not seen for this many frames (skipped, or one-off like LUT bakes) drop out of stats(). */
const STALE_FRAMES = 30;

export class GpuPassTimer {
    constructor(device, { capacity = 64, readbackSlots = 4 } = {}) {
        this.device = device;
        this.supported = !!device.features?.has?.('timestamp-query');
        this.enabled = this.supported;
        this.capacity = capacity;
        this.samples = new Map();
        this.frames = 0;
        this._lastSeen = new Map();
        this._passes = [];
        this._cursor = 0;
        this._pending = null;
        if (!this.supported) return;
        this.querySet = device.createQuerySet({ label: 'gpu pass timer', type: 'timestamp', count: capacity });
        this.resolveBuffer = device.createBuffer({
            label: 'gpu pass timer resolve', size: capacity * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this.slots = Array.from({ length: readbackSlots }, (_, i) => ({
            busy: false,
            buffer: device.createBuffer({
                label: `gpu pass timer readback ${i}`, size: capacity * 8,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            }),
        }));
        // Empty passes can be elided (Metal reports zero); markers do one no-op dispatch.
        this.markerPipeline = device.createComputePipeline({
            label: 'gpu pass timer marker',
            layout: 'auto',
            compute: { module: device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' }), entryPoint: 'main' },
        });
    }

    beginFrame() {
        this._passes = [];
        this._cursor = 0;
        this._pending = null;
    }

    /** Fragment for a pass descriptor's `timestampWrites`, or undefined when not timing. */
    timestampWrites(name) {
        if (!this.enabled || this._cursor + 2 > this.capacity) return undefined;
        const begin = this._cursor;
        this._cursor += 2;
        this._passes.push({ name, begin, end: begin + 1 });
        return { querySet: this.querySet, beginningOfPassWriteIndex: begin, endOfPassWriteIndex: begin + 1 };
    }

    /** Timestamp a point in queue order. */
    mark(encoder, name) {
        const timestampWrites = this.timestampWrites(name);
        if (!timestampWrites) return;
        const pass = encoder.beginComputePass({ label: name, timestampWrites });
        pass.setPipeline(this.markerPipeline);
        pass.dispatchWorkgroups(1);
        pass.end();
    }

    /** Encode the resolve into the frame's encoder, after its last timed pass. */
    resolve(encoder) {
        if (!this.enabled || this._cursor === 0) return;
        const slot = this.slots.find(s => !s.busy);
        if (!slot) return;
        encoder.resolveQuerySet(this.querySet, 0, this._cursor, this.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, this._cursor * 8);
        slot.busy = true;
        this._pending = { slot, passes: this._passes, count: this._cursor };
    }

    /** Call after the frame was submitted. */
    collect() {
        const pending = this._pending;
        this._pending = null;
        if (!pending) return;
        const { slot, passes, count } = pending;
        slot.buffer.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
            const stamps = new BigUint64Array(slot.buffer.getMappedRange(0, count * 8).slice(0));
            slot.buffer.unmap();
            slot.busy = false;
            this._ingest(passes, stamps);
        }).catch(() => { slot.busy = false; });
    }

    /** Drop collected samples (e.g. when a profiling window starts). */
    reset() {
        this.samples.clear();
        this._lastSeen.clear();
        this.frames = 0;
    }

    /** [{ name, avg, p95, last }] in first-seen order; 'total' is marker to marker. */
    stats() {
        return [...this.samples].filter(([name]) => this.frames - this._lastSeen.get(name) <= STALE_FRAMES).map(([name, values]) => {
            const sorted = [...values].sort((a, b) => a - b);
            return {
                name,
                avg: values.reduce((s, v) => s + v, 0) / values.length,
                p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
                last: values[values.length - 1],
            };
        });
    }

    // Passes without dependencies may overlap (tile-based GPUs), so a pass's span can
    // include waiting and spans can sum past the frame. 'total' = latest end - start.
    _ingest(passes, stamps) {
        const frame = new Map();
        let start = null, end = 0n;
        for (const pass of passes) {
            if (pass.name === '__start') { start = stamps[pass.end]; continue; }
            if (stamps[pass.end] > end) end = stamps[pass.end];
            if (pass.name === '__end') continue;
            const ms = Number(stamps[pass.end] - stamps[pass.begin]) / 1e6;
            if (ms >= 0 && ms < 1000) frame.set(pass.name, (frame.get(pass.name) ?? 0) + ms);
        }
        if (start !== null && start > 0n && end > start) {
            frame.set('total', Number(end - start) / 1e6);
        }
        for (const [name, ms] of frame) {
            let values = this.samples.get(name);
            if (!values) this.samples.set(name, values = []);
            values.push(ms);
            if (values.length > HISTORY) values.shift();
            this._lastSeen.set(name, this.frames);
        }
        this.frames++;
    }

    dispose() {
        this.querySet?.destroy();
        this.resolveBuffer?.destroy();
        for (const slot of this.slots ?? []) slot.buffer.destroy();
    }
}

/**
 * Brackets each frame. Install this module first and `module.endModule` last:
 * the end module closes the main render pass in renderTransparent so the end
 * marker and the resolve land in the same command buffer as the frame.
 */
export class GpuTimerModule {
    id = 'gpu-pass-timer';

    constructor() {
        this.endModule = {
            id: 'gpu-pass-timer-end',
            renderTransparent: ({ backend }) => {
                if (!this.timer?.enabled) return;
                backend.endRenderPassForCompute();
                const encoder = backend.getCommandEncoder();
                this.timer.mark(encoder, '__end');
                this.timer.resolve(encoder);
            },
        };
    }

    initialize({ device }) {
        this.timer = new GpuPassTimer(device);
    }

    update() { this.timer.beginFrame(); }

    compute(frame, encoder) { this.timer.mark(encoder, '__start'); }

    afterSubmit() { this.timer.collect(); }

    dispose() { this.timer?.dispose(); }
}
