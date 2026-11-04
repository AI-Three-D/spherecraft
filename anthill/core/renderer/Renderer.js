// @ts-check
import { assertSynchronous } from './moduleHooks.js';
/** @typedef {import('./contracts.js').RenderModule} RenderModule */
/** @typedef {import('./contracts.js').RenderFrame} RenderFrame */
/** @typedef {import('./contracts.js').RendererBackend} RendererBackend */

/** Owns frame ordering and submission. Scene content is supplied exclusively by modules. */
export class Renderer {
    /** @param {import('./contracts.js').RendererOptions} [options] */
    constructor(options = {}) {
        this.canvas = options.canvas;
        /** @type {RendererBackend | null} */
        this.backend = options.backend ?? null;
        this.ownsBackend = options.ownsBackend ?? !options.backend;
        this.backendInitialized = options.backendInitialized ?? false;
        this.viewport = Object.freeze({
            width: options.width ?? options.canvas?.width ?? 1,
            height: options.height ?? options.canvas?.height ?? 1,
        });
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];
        /** @private @type {Map<string, RenderModule>} */
        this.modules = new Map();
        /** @private @type {RenderFrame | null} */
        this.activeFrame = null;
        this.phase = 'idle';
        this.ready = false;
        this.disposed = false;
        this.busy = false;
        this.frameCount = 0;
        this.time = 0;
    }

    async initialize() {
        this.assertIdle();
        if (this.ready) return;
        this.busy = true;
        try {
            this.validateSize(this.viewport.width, this.viewport.height);
            if (!this.backend) {
                if (!this.canvas) throw new Error('Renderer requires a canvas or an injected backend');
                const { WebGPUBackend } = await import('./backend/webgpuBackend.js');
                this.backend = new WebGPUBackend(this.canvas);
            }
            if (!this.backendInitialized) await this.backend.initialize();
            if (!this.backend.device) throw new Error('Renderer backend has no GPU device');
            this.backend.setViewport(0, 0, this.viewport.width, this.viewport.height);
            this.ready = true;
        } catch (error) {
            if (this.ownsBackend) this.backend?.dispose();
            throw error;
        } finally {
            this.busy = false;
        }
    }

    /** @param {RenderModule} module */
    async addModule(module) {
        this.assertReady();
        this.assertIdle();
        if (!module.id?.trim()) throw new Error('Render module requires a nonempty id');
        if (this.modules.has(module.id)) throw new Error(`Render module already installed: ${module.id}`);
        this.busy = true;
        try {
            await module.initialize?.(this.getContext());
            if (this.activeFrame) throw new Error('Module installation requires an idle frame');
            this.modules.set(module.id, module);
        } catch (error) {
            try { module.dispose?.(); } catch { /* Preserve the initialization error. */ }
            throw error;
        } finally {
            this.busy = false;
        }
    }

    /** @param {string} id */
    removeModule(id) {
        this.assertIdle();
        const module = this.modules.get(id);
        if (!module) return false;
        this.modules.delete(id);
        module.dispose?.();
        return true;
    }

    /** Render a complete frame. Returns false when the device has been lost. @param {import('./contracts.js').FrameInput} input */
    renderFrame(input) {
        this.assertReady();
        if (this.backend?.deviceLoss) return false;
        const frame = this.beginFrame(input);
        try {
            this.compute(frame);
            frame.backend.setRenderTarget(null);
            frame.backend.setClearColor(...this.clearColor);
            frame.backend.clear(true, true, false);
            this.render(frame);
            this.renderTransparent(frame);
            this.endFrame(frame);
            return true;
        } catch (error) {
            this.abortFrame();
            throw error;
        }
    }

    /** Split phases allow a composition layer to interleave sky, actors and postprocessing. @param {import('./contracts.js').FrameInput} input */
    beginFrame(input) {
        this.assertReady();
        if (this.activeFrame) throw new Error('A frame is already active');
        if (!Number.isFinite(input.deltaTime) || input.deltaTime < 0) throw new Error('deltaTime must be finite and nonnegative');
        const time = input.time ?? this.time + input.deltaTime;
        if (!Number.isFinite(time)) throw new Error('time must be finite');
        const frame = Object.freeze({ ...this.getContext(), camera: input.camera, deltaTime: input.deltaTime, time, index: this.frameCount++ });
        this.time = time;
        this.activeFrame = frame;
        this.phase = 'update';
        try {
            for (const module of this.modules.values()) assertSynchronous(module.update?.(frame));
            return frame;
        } catch (error) {
            this.abortFrame();
            throw error;
        }
    }

    /** @param {RenderFrame} frame */
    compute(frame) {
        this.assertPhase(frame, 'update');
        try {
            frame.backend.endRenderPassForCompute();
            const encoder = frame.backend.getCommandEncoder();
            for (const module of this.modules.values()) assertSynchronous(module.compute?.(frame, encoder));
            this.phase = 'compute';
        } catch (error) { this.abortFrame(); throw error; }
    }

    /** @param {RenderFrame} frame */
    render(frame) {
        this.assertPhase(frame, 'compute');
        try {
            frame.backend.resumeRenderPass();
            for (const module of this.modules.values()) assertSynchronous(module.render?.(frame));
            this.phase = 'render';
        } catch (error) { this.abortFrame(); throw error; }
    }

    /** @param {RenderFrame} frame */
    renderTransparent(frame) {
        this.assertPhase(frame, 'render');
        try {
            frame.backend.resumeRenderPass();
            for (const module of this.modules.values()) assertSynchronous(module.renderTransparent?.(frame));
            this.phase = 'transparent';
        } catch (error) { this.abortFrame(); throw error; }
    }

    /** Submit once, then start feedback/readback. @param {RenderFrame} frame */
    endFrame(frame) {
        this.assertPhase(frame, 'transparent');
        try {
            frame.backend.submitCommands();
        } catch (error) { this.abortFrame(); throw error; }
        this.activeFrame = null;
        this.phase = 'idle';
        for (const module of this.modules.values()) assertSynchronous(module.afterSubmit?.(frame));
    }

    /** Drop a failed frame without submitting partially recorded work. */
    abortFrame() {
        if (!this.activeFrame) return;
        try { this.backend?.discardCommands(); }
        finally { this.activeFrame = null; this.phase = 'idle'; }
    }

    /** @param {number} width @param {number} height */
    resize(width, height) {
        this.assertReady();
        this.assertIdle();
        this.validateSize(width, height);
        this.viewport = Object.freeze({ width, height });
        if (this.canvas) { this.canvas.width = width; this.canvas.height = height; }
        this.backend?.setViewport(0, 0, width, height);
        for (const module of this.modules.values()) module.resize?.(this.viewport);
    }

    dispose() {
        if (this.disposed) return;
        if (this.busy) throw new Error('Cannot dispose while a module is initializing');
        this.abortFrame();
        this.disposed = true;
        this.ready = false;
        const errors = [];
        for (const module of [...this.modules.values()].reverse()) {
            try { module.dispose?.(); } catch (error) { errors.push(error); }
        }
        this.modules.clear();
        if (this.ownsBackend) {
            try { this.backend?.dispose(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Renderer cleanup failed');
    }

    /** @returns {import('./contracts.js').RenderContext} */
    getContext() {
        if (!this.backend?.device) throw new Error('Renderer backend has no GPU device');
        return Object.freeze({ backend: this.backend, device: this.backend.device, viewport: this.viewport });
    }

    /** @private */
    assertReady() {
        if (!this.ready || this.disposed) throw new Error('Renderer is not initialized');
    }

    /** @private */
    assertIdle() {
        if (this.disposed) throw new Error('Renderer is disposed');
        if (this.activeFrame || this.busy) throw new Error('Renderer lifecycle changes require an idle renderer');
    }

    /** @private @param {RenderFrame} frame @param {string} phase */
    assertPhase(frame, phase) {
        if (frame !== this.activeFrame || this.phase !== phase) throw new Error(`Expected frame phase: ${phase}`);
    }

    /** @private @param {number} width @param {number} height */
    validateSize(width, height) {
        if (![width, height].every(n => Number.isInteger(n) && n > 0)) throw new Error('Viewport dimensions must be positive integers');
    }
}
