// @ts-check
import { assertSynchronous } from '../moduleHooks.js';
/** @typedef {import('../contracts.js').RenderFrame} RenderFrame */

/** The optional bridge between a terrain world/data source and its draw and water layers. */
export class TerrainModule {
    /** @param {import('./contracts.js').TerrainModuleOptions} options */
    constructor(options) {
        this.id = options.id ?? 'terrain';
        this.source = options.source;
        this.renderer = options.renderer;
        this.waterLayers = [...(options.waterLayers ?? [])];
        this.ownsSource = options.ownsSource ?? false;
        this.initializeSource = options.initializeSource ?? false;
        this.initialized = false;
        this.disposed = false;
        /** @type {import('./contracts.js').TerrainWaterData | null} */
        this.waterData = null;
    }

    /** @param {import('../contracts.js').RenderContext} context */
    async initialize(context) {
        if (this.disposed || this.initialized) throw new Error('Terrain module cannot be initialized twice');
        if (this.initializeSource) await this.source.initialize?.();
        this.renderer.setWaterData?.(this.waterData);
        await this.renderer.initialize();
        for (const layer of this.waterLayers) {
            await layer.initialize?.(context);
            layer.setWaterData?.(this.waterData);
        }
        this.initialized = true;
    }

    /** @param {RenderFrame} frame */
    update(frame) {
        for (const layer of this.waterLayers) assertSynchronous(layer.update?.(frame));
    }

    /** @param {RenderFrame} frame @param {GPUCommandEncoder} encoder */
    compute(frame, encoder) {
        if (!this.source.isReady()) return;
        assertSynchronous(this.source.update?.(frame.camera, encoder));
        for (const layer of this.waterLayers) assertSynchronous(layer.compute?.(frame, encoder));
    }

    /** @param {RenderFrame} frame */
    render(frame) {
        if (!this.source.isReady()) return;
        const camera = frame.camera;
        assertSynchronous(this.renderer.render(camera, camera.matrixWorldInverse, camera.projectionMatrix));
    }

    /** All blended water follows opaque geometry from every installed module. @param {RenderFrame} frame */
    renderTransparent(frame) {
        if (!this.source.isReady()) return;
        for (const layer of this.waterLayers) assertSynchronous(layer.render(frame));
    }

    /** @param {import('./contracts.js').TerrainWaterData | null} data */
    setWaterData(data) {
        this.waterData = data;
        this.renderer.setWaterData?.(data);
        for (const layer of this.waterLayers) layer.setWaterData?.(data);
    }

    afterSubmit() { assertSynchronous(this.source.resolveFeedbackReadback?.()); }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.initialized = false;
        const errors = [];
        for (const layer of [...this.waterLayers].reverse()) {
            try { layer.dispose?.(); } catch (error) { errors.push(error); }
        }
        try { this.renderer.dispose(); } catch (error) { errors.push(error); }
        if (this.ownsSource) {
            try { this.source.dispose?.(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Terrain cleanup failed');
    }
}
