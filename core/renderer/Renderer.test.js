import { describe, it, expect, vi } from 'vitest';
import { Renderer } from './Renderer.js';
import { recordingBackend, camera } from '../../tests/helpers/recordingBackend.js';

describe('scene-independent renderer', () => {
    it('renders an empty scene without textures, terrain, environment or game configuration', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend, width: 32, height: 16 });
        await renderer.initialize();
        expect(renderer.renderFrame({ camera, deltaTime: 0 })).toBe(true);
        expect(backend.clear).toHaveBeenCalledTimes(1);
        expect(backend.submitCommands).toHaveBeenCalledTimes(1);
        expect(backend.draw).not.toHaveBeenCalled();
        renderer.dispose();
        expect(backend.dispose).not.toHaveBeenCalled();
    });

    it('computes all modules before opaque draws, then water, then readback after submission', async () => {
        const { backend, encoder, events } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        for (const id of ['mesh', 'terrain']) {
            await renderer.addModule({
                id, initialize: () => events.push(`${id}.initialize`),
                update: frame => { expect(frame.time).toBe(4); events.push(`${id}.update`); },
                compute: (frame, commandEncoder) => { expect(commandEncoder).toBe(encoder); events.push(`${id}.compute`); },
                render: () => events.push(`${id}.render`),
                renderTransparent: () => events.push(`${id}.water`),
                afterSubmit: () => events.push(`${id}.feedback`),
            });
        }
        events.length = 0;
        renderer.renderFrame({ camera, deltaTime: 0.02, time: 4 });
        expect(events).toEqual(['mesh.update', 'terrain.update', 'endPass', 'mesh.compute', 'terrain.compute',
            'target', 'clear', 'resume', 'mesh.render', 'terrain.render', 'resume', 'mesh.water', 'terrain.water',
            'submit', 'mesh.feedback', 'terrain.feedback']);
    });

    it('rolls back initialization failures and does not register partial modules', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        const dispose = vi.fn();
        await expect(renderer.addModule({ id: 'broken', initialize: () => { throw new Error('loading failed'); }, dispose })).rejects.toThrow('loading failed');
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(renderer.removeModule('broken')).toBe(false);
        await renderer.addModule({ id: 'broken' });
        expect(renderer.removeModule('broken')).toBe(true);
    });

    it('keeps installed modules rendering while another module loads', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        const existingDraw = vi.fn(), newDraw = vi.fn();
        await renderer.addModule({ id: 'existing', render: existingDraw });
        let loaded;
        const loading = renderer.addModule({ id: 'loading', initialize: () => new Promise(resolve => { loaded = resolve; }), render: newDraw });
        renderer.renderFrame({ camera, deltaTime: 0 });
        expect(existingDraw).toHaveBeenCalledTimes(1);
        expect(newDraw).not.toHaveBeenCalled();
        loaded(); await loading;
        renderer.renderFrame({ camera, deltaTime: 0 });
        expect(newDraw).toHaveBeenCalledTimes(1);
    });

    it('rejects overlapping initialization, duplicate ids and changes during a frame', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        let resolve;
        const pending = renderer.addModule({ id: 'a', initialize: () => new Promise(done => { resolve = done; }) });
        await expect(renderer.addModule({ id: 'b' })).rejects.toThrow('idle');
        resolve(); await pending;
        await expect(renderer.addModule({ id: 'a' })).rejects.toThrow('already installed');
        const frame = renderer.beginFrame({ camera, deltaTime: 0 });
        expect(() => renderer.resize(8, 8)).toThrow('idle');
        expect(() => renderer.render(frame)).toThrow('phase');
        renderer.abortFrame();
        expect(backend.submitCommands).not.toHaveBeenCalled();
    });

    it('discards a failed draw without submitting and permits the next frame', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        await renderer.addModule({ id: 'broken', render: () => { throw new Error('draw failed'); } });
        expect(() => renderer.renderFrame({ camera, deltaTime: 0 })).toThrow('draw failed');
        expect(backend.discardCommands).toHaveBeenCalledTimes(1);
        expect(backend.submitCommands).not.toHaveBeenCalled();
        renderer.removeModule('broken');
        expect(renderer.renderFrame({ camera, deltaTime: 0 })).toBe(true);
    });

    it('rejects asynchronous frame hooks before submission', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        await renderer.addModule({ id: 'async', compute: async () => {} });
        expect(() => renderer.renderFrame({ camera, deltaTime: 0 })).toThrow('must be synchronous');
        expect(backend.submitCommands).not.toHaveBeenCalled();
        expect(backend.discardCommands).toHaveBeenCalledTimes(1);
    });

    it('cleans up modules in reverse order and releases its owned backend despite cleanup failures', async () => {
        const { backend, events } = recordingBackend();
        const renderer = new Renderer({ backend, ownsBackend: true });
        await renderer.initialize();
        await renderer.addModule({ id: 'a', dispose: () => events.push('a.dispose') });
        await renderer.addModule({ id: 'b', dispose: () => { events.push('b.dispose'); throw new Error('cleanup failed'); } });
        events.length = 0;
        expect(() => renderer.dispose()).toThrow('cleanup failed');
        expect(events).toEqual(['b.dispose', 'a.dispose', 'backend.dispose']);
        renderer.dispose();
        expect(backend.dispose).toHaveBeenCalledTimes(1);
    });

    it('propagates resize, rejects invalid timing, and stops when its device is lost', async () => {
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        const resize = vi.fn();
        await renderer.addModule({ id: 'view', resize });
        renderer.resize(320, 200);
        expect(resize).toHaveBeenCalledWith({ width: 320, height: 200 });
        expect(() => renderer.resize(0, 200)).toThrow('dimensions');
        expect(() => renderer.renderFrame({ camera, deltaTime: -1 })).toThrow('deltaTime');
        expect(() => renderer.renderFrame({ camera, deltaTime: 0, time: NaN })).toThrow('time');
        backend.deviceLoss = { reason: 'unknown', message: 'lost' };
        expect(renderer.renderFrame({ camera, deltaTime: 0 })).toBe(false);
        expect(backend.submitCommands).not.toHaveBeenCalled();
    });
});
