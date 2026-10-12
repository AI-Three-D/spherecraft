import { describe, it, expect, vi } from 'vitest';
import { TileStreamer } from './tileStreamer.js';

describe('terrain world ownership', () => {
    it('stops admission and readback, releases owned resources, and preserves attached textures', () => {
        const destroy = () => ({ destroy: vi.fn() });
        const external = destroy(), array = destroy(), zero = destroy(), sentinel = destroy();
        const pending = { _gpuTexture: { texture: destroy() }, dispose: vi.fn() };
        const queued = { _gpuTexture: { texture: destroy() }, dispose: vi.fn() };
        const slot = { feedbackStaging: destroy(), metaStaging: destroy() };
        const queue = { clearPending: vi.fn() };
        const source = Object.create(TileStreamer.prototype);
        Object.assign(source, {
            _generationEpoch: 0, _generationQueue: queue, _refinementQueue: queue, _regenQueue: queue,
            _tileInfo: new Map(), _tileState: new Map(), tileCache: { clear: vi.fn() },
            _pendingCopyTextures: [[pending]], _pendingDestructions: [{ textures: [queued] }],
            _feedbackRing: [slot], _externalArrayTextures: { terrainAO: external },
            arrayPool: { _pendingCopies: [], textures: new Map([['height', array]]), wrappers: new Map(),
                _zeroTextures: new Map([['r32float', zero]]), _splatIndexSentinel: sentinel },
        });
        source.dispose(); source.dispose();
        expect(queue.clearPending).toHaveBeenCalledTimes(3);
        for (const resource of [array, zero, sentinel, pending._gpuTexture.texture, queued._gpuTexture.texture, slot.feedbackStaging, slot.metaStaging]) {
            expect(resource.destroy).toHaveBeenCalledTimes(1);
        }
        expect(external.destroy).not.toHaveBeenCalled();
        expect(() => { source.tickFlush(); source.tickGeneration(); source.resolveFeedbackReadback(); }).not.toThrow();
        expect(source._generationEpoch).toBe(1);
    });

    it('retains resident inputs until an already running refinement finishes', async () => {
        let finish;
        const promise = new Promise(resolve => { finish = resolve; });
        const texture = { destroy: vi.fn() };
        const pool = { _pendingCopies: [], textures: new Map([['height', texture]]), wrappers: new Map(), _zeroTextures: new Map() };
        const source = Object.create(TileStreamer.prototype);
        Object.assign(source, { _generationEpoch: 0, _generationQueue: { clearPending() {}, pending: new Map([['job', { started: true, promise }]]) },
            _tileInfo: new Map(), _tileState: new Map(), _pendingCopyTextures: [], _pendingDestructions: [], arrayPool: pool });
        source.dispose();
        expect(source.arrayPool).toBeNull();
        expect(texture.destroy).not.toHaveBeenCalled();
        finish();
        await promise;
        await Promise.resolve();
        expect(texture.destroy).toHaveBeenCalledTimes(1);
    });
});
