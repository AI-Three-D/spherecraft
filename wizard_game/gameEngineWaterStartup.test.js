import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/world/hydrology/WaterService.js', () => ({
    WaterService: class {
        constructor(options) { this.options = options; this.start = vi.fn(); }
    },
}));
vi.stubGlobal('window', {});
const { GameEngine } = await import('./gameEngine.js');
const { fieldCoords, pageKey, riverFieldLayout } = await import('../core/world/water/riverField.js');
const { faceUVToDir } = await import('../core/world/hydrology/waterGraph.js');

const engine = waterGraph => {
    const e = Object.create(GameEngine.prototype), terrainGenerator = {};
    Object.assign(e, { planetConfig: { terrainGeneration: { waterGraph } }, terrainGenerator,
        renderer: { backend: { device: {} }, quadtreeTileManager: { tileStreamer: { terrainGenerator } } },
        isInitialLoadComplete: () => false, _createWaterGpuData: vi.fn() });
    return e;
};

describe('water startup', () => {
    it('starts terrain-sampled discovery while initial loading is still active', () => {
        const e = engine({ enabled: true });
        e._tickWater();
        expect(e.waterService.start).toHaveBeenCalledOnce();
        expect(e._createWaterGpuData).toHaveBeenCalledOnce();
        expect(e.waterService.options.loading()).toBe(true);
    });
    it('starts precompute without publishing its water data before the graph is ready', () => {
        const e = engine({ enabled: true, refine: { precompute: true } });
        e._tickWater();
        expect(e.waterService.start).toHaveBeenCalledOnce();
        expect(e._createWaterGpuData).not.toHaveBeenCalled();
    });
    it('does not start water when disabled', () => {
        const e = engine({ enabled: false });
        e._tickWater();
        expect(e.waterService).toBeUndefined();
        expect(e._createWaterGpuData).not.toHaveBeenCalled();
    });
    it('reveals stable terrain while nearby water is still being prepared', () => {
        const e = engine({ enabled: true });
        e.engineConfig = { ui: { initialLoad: {} } };
        e.waterService = { state: 'ready' };
        e.riverFieldService = { readyForReveal: () => false };
        e.renderer.quadtreeTileManager.tileStreamer.terrainGenerator.waterCarve = true;
        e.renderer.getInitialLoadStatus = () => ({ hasVisibleReadback: true, visibleTiles: 48, residentVisibleTiles: 48,
            residentVisibleRatio: 1, exactVisibleRatio: 1, pendingGenerations: 0, activeGenerations: 0, pendingCopies: 0 });
        e._initialLoadState = { active: true, complete: false, startedAt: performance.now(), progress: 0,
            stableFrames: 0, stableFramesRequired: 1 };
        e._tickInitialLoadState();
        expect(e._initialLoadState.complete).toBe(true);
        expect(e._initialLoadState.waterPending).toBe(true);
    });
    it('lets a ready river batch start baking before scheduling more discovery', () => {
        const e = engine({ enabled: true }), order = [];
        e.camera = { position: { x: 10, y: 0, z: 0 } };
        e.waterService = { update: vi.fn(() => order.push('discover')) };
        e.waterGpuData = { update: vi.fn(() => order.push('publish')) };
        e.riverFieldService = { busy: false, update: vi.fn(function () { order.push('bake'); this.busy = true; }) };
        e._tickWhitewater = vi.fn(() => order.push('simulate'));
        e._tickWaterFrame();
        expect(order).toEqual(['publish', 'bake', 'simulate']);
        expect(e.waterService.update).not.toHaveBeenCalled();
        e.riverFieldService.busy = false;
        e.riverFieldService.update.mockImplementation(() => order.push('check'));
        e._tickWaterFrame();
        expect(e.waterService.update).toHaveBeenCalledOnce();
    });
    it('lets precomputed rivers bake before starting another trace', () => {
        const e = engine({ enabled: true }), order = [];
        e.camera = { position: { x: 10, y: 0, z: 0 } };
        e.waterService = { config: { refine: { precompute: true } }, update: vi.fn(() => order.push('discover')) };
        e.waterGpuData = { update: vi.fn(() => order.push('publish')) };
        e.riverFieldService = { busy: false, update: vi.fn(function () { order.push('bake'); this.busy = true; }) };
        e._tickWhitewater = vi.fn(() => order.push('simulate'));
        e._tickWaterFrame();
        expect(order).toEqual(['simulate', 'publish', 'bake']);
        expect(e.waterService.update).not.toHaveBeenCalled();
    });
    it('schedules regeneration against the changed field pages when tile dimensions are available', () => {
        const e = engine({ enabled: true }), L = riverFieldLayout(131000), depth = 11, grid = 2 ** depth, x = grid >> 1, y = grid >> 1;
        const q = fieldCoords(faceUVToDir(1, (x + 0.5) / grid, (y + 0.5) / grid), L);
        const page = pageKey(1, Math.floor(q.x / L.P), Math.floor(q.y / L.P), L);
        const mark = vi.fn(), regenerate = vi.fn(() => 1);
        e._waterCarveGenerator = { markWaterCarveChanged: vi.fn(), _computeSplatPaddingTexels: () => 4 };
        e.riverFieldService = { layout: L };
        e.waterGpuData = { N: 512 };
        e.renderer.quadtreeTileManager = { tileStreamer: { tileGenerator: { textureSize: 128 } }, markTerrainRegionsChanged: mark, regenerateTiles: regenerate };
        e._regenerateWaterCells(new Set([0]), [page]);
        const predicate = mark.mock.calls[0][0];
        expect(regenerate).toHaveBeenCalledWith(predicate);
        expect(predicate(1, depth, x, y)).toBe(true);
        expect(predicate(1, depth, x + 100, y)).toBe(false);
    });
});
