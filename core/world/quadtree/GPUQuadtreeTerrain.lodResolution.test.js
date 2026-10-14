import { describe, expect, it, vi } from 'vitest';
import { QuadtreeTileManager } from './GPUQuadtreeTerrain.js';

function fixture() {
    const canvas = { clientHeight: 720, height: 720 };
    const rendering = {
        pixelRatio: 1,
        adaptive: { enabled: true, stationaryPixelRatio: 1, motionPixelRatio: 0.85, fastMotionPixelRatio: 0.7 },
    };
    const manager = new QuadtreeTileManager({
        backend: { canvas },
        engineConfig: { rendering, gpuQuadtree: { lodErrorThreshold: 512 } },
    });
    manager._initialized = true;
    manager.quadtreeGPU = {
        isReady: () => true,
        setRegionalTerrain: vi.fn(),
        updateUniforms: vi.fn(),
        traverse: vi.fn(), buildInstances: vi.fn(), tick: vi.fn(),
    };
    manager.tileStreamer = { tickFlush: vi.fn(), tickGeneration: vi.fn(), beginFeedbackReadback: vi.fn() };
    manager._maybeReadbackVisibleTiles = vi.fn();
    manager._maybeLogLightweightDiagnostics = vi.fn();
    return { manager, canvas, rendering };
}

describe('terrain LOD reference resolution', () => {
    it('keeps the same fine-tile split when adaptive rendering drops from full resolution to 70%', () => {
        const { manager, canvas } = fixture();
        const camera = { position: { x: 0, y: 0, z: 0 } };
        const encoder = {};
        const splits = [];
        // A 1024 m tile at 900 m is near the actual SSE split threshold:
        // it splits at 720 px, but would merge at 504 px before this fix.
        manager.quadtreeGPU.updateUniforms.mockImplementation((_camera, options) => {
            const factor = options.screenHeight / (2 * Math.tan(75 * Math.PI / 360));
            splits.push(1024 * factor / 900 > options.lodErrorThreshold);
        });
        for (const height of [720, 612, 504, 720]) {
            canvas.height = height;
            manager.update(camera, encoder);
        }
        expect(splits).toEqual([true, true, true, true]);
        for (const [, options] of manager.quadtreeGPU.updateUniforms.mock.calls) {
            expect(options.screenHeight).toBe(720);
        }
    });

    it('still changes terrain detail when the display size or configured reference quality changes', () => {
        const { manager, canvas, rendering } = fixture();
        canvas.clientHeight = 900;
        expect(manager._getLodScreenHeight()).toBe(900);
        rendering.adaptive.stationaryPixelRatio = 1.25;
        expect(manager._getLodScreenHeight()).toBe(1125);
        rendering.adaptive.fastMotionPixelRatio = 1.5;
        expect(manager._getLodScreenHeight()).toBe(1350);
        rendering.adaptive.enabled = false;
        rendering.pixelRatio = 2;
        expect(manager._getLodScreenHeight()).toBe(1800);
    });

    it('supports canvases without a CSS layout size', () => {
        const { manager, canvas } = fixture();
        delete canvas.clientHeight;
        canvas.height = 800;
        expect(manager._getLodScreenHeight()).toBe(800);
        canvas.height = 0;
        expect(manager._getLodScreenHeight()).toBe(1080);
    });
});
