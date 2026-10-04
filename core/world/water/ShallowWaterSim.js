// core/world/water/ShallowWaterSim.js
//
// GPU shallow-water simulation on a W x L grid (IMPLEMENTATION_PLAN 8.1);
// numerics in shallowWaterSim.wgsl.js (Whitewater's solver, rebuilt with
// configurable boundaries). Renderer-independent: a simulation site
// (camera-centred, 8.2) owns one and feeds it a bed and boundary targets.
//
// Buffers (all W * L cells, row-major j * W + i):
// - bed: f32 metres (same vertical datum as the targets' eta);
// - state: vec4 (h, u, v, foam), three of them: a substep runs
//   advect 0 -> 1, height 1 -> 2, momentum 2 -> 0, so state 0 always holds
//   the current state between substeps;
// - k: turbulence, ping-pongs with the state;
// - relax: vec4 (targetEta, targetU, targetV, rate 1/s), rate 0 = none.

import { SHALLOW_WATER_WGSL, SWE_PARAM_FLOATS, SWE_WORKGROUP } from './shallowWaterSim.wgsl.js';

export const SWE_DEFAULTS = Object.freeze({
    dx: 1.0,            // cell size (m)
    dt: 1 / 120,        // substep (s); Whitewater's value
    g: 9.81,
    manning: 0.035,
    hmin: 0.02,         // below this a cell counts as dry (m)
    umax: 12.0,         // velocity clamp (m/s)
    macCormack: true,
    turbA: 0.6, turbL: 3.0, turbT: 0.8,
    foamDecay: 0.35, kDecay: 0.8, kGen: 1.0, foamGen: 1.0,
    maxRise: 0, maxFall: 0,   // optional depth-change cap (m/s), 0 = off
    outLimit: 0.8,      // a cell sends at most this fraction of dx/dt outflow per substep
    kRelax: 0.12,       // turbulence that relaxed (inflow) cells carry
    openMask: 0,        // SWE_OPEN_* bits; closed edges by default
});

export class ShallowWaterSim {
    /**
     * @param {GPUDevice} device
     * @param {object} opts  W, L and any SWE_DEFAULTS override
     */
    constructor(device, opts) {
        this.device = device;
        this.W = opts.W | 0;
        this.L = opts.L | 0;
        if (!(this.W > 1 && this.L > 1)) throw new Error('ShallowWaterSim: W and L must be > 1');
        this.params = { ...SWE_DEFAULTS, ...opts };
        this.time = 0;
        const n = this.W * this.L;
        const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
        this.bedBuffer = device.createBuffer({ label: 'SWE-bed', size: n * 4, usage: S });
        this.stateBuffers = [0, 1, 2].map(k => device.createBuffer({ label: `SWE-state${k}`, size: n * 16, usage: S }));
        this.kBuffers = [0, 1, 2].map(k => device.createBuffer({ label: `SWE-k${k}`, size: n * 4, usage: S }));
        this.relaxBuffer = device.createBuffer({ label: 'SWE-relax', size: n * 16, usage: S });
        this.uniformBuffer = device.createBuffer({ label: 'SWE-params', size: SWE_PARAM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._uniforms = new ArrayBuffer(SWE_PARAM_FLOATS * 4);

        const module = device.createShaderModule({ label: 'ShallowWaterSim', code: SHALLOW_WATER_WGSL });
        const C = GPUShaderStage.COMPUTE;
        const layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: C, buffer: { type: 'uniform' } },
            { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: C, buffer: { type: 'storage' } },
            { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
            { binding: 5, visibility: C, buffer: { type: 'storage' } },
            { binding: 6, visibility: C, buffer: { type: 'read-only-storage' } },
        ] });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        this._pipelines = ['advect', 'height', 'momentum'].map(entryPoint =>
            device.createComputePipeline({ label: `SWE-${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } }));
        this._bindGroups = [[0, 1], [1, 2], [2, 0]].map(([a, b]) => device.createBindGroup({ layout, entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: { buffer: this.bedBuffer } },
            { binding: 2, resource: { buffer: this.stateBuffers[a] } },
            { binding: 3, resource: { buffer: this.stateBuffers[b] } },
            { binding: 4, resource: { buffer: this.kBuffers[a] } },
            { binding: 5, resource: { buffer: this.kBuffers[b] } },
            { binding: 6, resource: { buffer: this.relaxBuffer } },
        ] }));
        // Zero relax and k by default (buffers are zero-initialised).
    }

    /** Current state (h, u, v, foam) buffer, e.g. for rendering. */
    get stateBuffer() { return this.stateBuffers[0]; }

    setParams(p) { Object.assign(this.params, p); }

    /** @param {Float32Array} bed  W * L metres */
    setBed(bed) { this.device.queue.writeBuffer(this.bedBuffer, 0, bed); }

    /** @param {Float32Array} state  W * L * 4: (h, u, v, foam) */
    setState(state) {
        this.device.queue.writeBuffer(this.stateBuffers[0], 0, state);
    }

    /** @param {Float32Array} k  W * L turbulence */
    setTurbulence(k) { this.device.queue.writeBuffer(this.kBuffers[0], 0, k); }

    /** @param {Float32Array} relax  W * L * 4: (targetEta, targetU, targetV, rate) */
    setRelax(relax) { this.device.queue.writeBuffer(this.relaxBuffer, 0, relax); }

    _writeUniforms(jOffset) {
        const p = this.params;
        const u32 = new Uint32Array(this._uniforms), f32 = new Float32Array(this._uniforms);
        u32[0] = this.W; u32[1] = this.L; u32[2] = jOffset >>> 0; u32[3] = p.openMask >>> 0;
        f32.set([p.dx, p.dt, p.g, p.manning, p.hmin, p.umax, this.time, p.macCormack ? 1 : 0,
            p.turbA, p.turbL, p.turbT, p.foamDecay, p.kDecay, p.kGen, p.foamGen, p.maxRise,
            p.maxFall, p.outLimit, p.kRelax, 0], 4);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniforms);
    }

    /**
     * Encodes `substeps` substeps into `encoder`, over rows
     * [jOffset, jOffset + rows) (default: the whole grid). All substeps of
     * one call share the uniforms (the time advances once per call).
     */
    encode(encoder, substeps = 1, { jOffset = 0, rows = this.L } = {}) {
        this._writeUniforms(jOffset);
        const pass = encoder.beginComputePass({ label: 'SWE' });
        const gx = Math.ceil(this.W / SWE_WORKGROUP), gy = Math.ceil(rows / SWE_WORKGROUP);
        for (let s = 0; s < substeps; s++) {
            for (let k = 0; k < 3; k++) {
                pass.setPipeline(this._pipelines[k]);
                pass.setBindGroup(0, this._bindGroups[k]);
                pass.dispatchWorkgroups(gx, gy);
            }
        }
        pass.end();
        this.time += substeps * this.params.dt;
    }

    /** Runs `substeps` substeps now (own submit). */
    step(substeps = 1, window = undefined) {
        const enc = this.device.createCommandEncoder({ label: 'SWE-step' });
        this.encode(enc, substeps, window);
        this.device.queue.submit([enc.finish()]);
    }

    /** Reads the current state back: Float32Array W * L * 4 (h, u, v, foam). */
    async readState() {
        const bytes = this.W * this.L * 16;
        const rb = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = this.device.createCommandEncoder({ label: 'SWE-read' });
        enc.copyBufferToBuffer(this.stateBuffers[0], 0, rb, 0, bytes);
        this.device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(rb.getMappedRange().slice(0));
        rb.unmap();
        rb.destroy();
        return out;
    }

    destroy() {
        for (const b of [this.bedBuffer, ...this.stateBuffers, ...this.kBuffers, this.relaxBuffer, this.uniformBuffer]) b.destroy();
    }
}
