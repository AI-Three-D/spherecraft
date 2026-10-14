import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameLoop, waitForVisibleFrame } from './FrameLoop.js';
import { GameInputManager } from './GameInputManager.js';

describe('frame pacing and tab suspension', () => {
    let documentStub, requests, visibilityListeners, loop, onFrame, maxFps;

    beforeEach(() => {
        requests = new Map();
        visibilityListeners = new Set();
        let nextId = 0;
        documentStub = {
            hidden: false,
            addEventListener: (_event, callback) => visibilityListeners.add(callback),
            removeEventListener: (_event, callback) => visibilityListeners.delete(callback),
        };
        vi.stubGlobal('document', documentStub);
        vi.stubGlobal('requestAnimationFrame', callback => {
            const id = ++nextId;
            requests.set(id, callback);
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', id => requests.delete(id));
        maxFps = 60;
        onFrame = vi.fn();
        loop = new FrameLoop({ onFrame, getMaxFps: () => maxFps });
    });

    afterEach(() => {
        loop.stop();
        vi.unstubAllGlobals();
    });

    function refresh(time) {
        const callbacks = [...requests.values()];
        requests.clear();
        callbacks.forEach(callback => callback(time));
    }

    function setHidden(hidden) {
        documentStub.hidden = hidden;
        [...visibilityListeners].forEach(callback => callback());
    }

    it.each([[120, 60], [144, 60], [60, 30]])('paces a %i Hz display at %i FPS without slowing simulation time', (hz, cap) => {
        maxFps = cap;
        loop.start();
        for (let i = 0; i < hz * 2; i++) refresh(i * 1000 / hz);
        expect(onFrame).toHaveBeenCalledTimes(cap * 2);
        const calls = onFrame.mock.calls;
        const elapsed = calls.reduce((sum, [, delta]) => sum + delta, 0);
        expect(elapsed).toBeCloseTo(calls.at(-1)[0] / 1000, 6);
    });

    it('follows every refresh when the cap is disabled or higher than the display rate', () => {
        loop.start();
        for (const cap of [0, 120]) {
            maxFps = cap;
            for (let i = 0; i < 60; i++) refresh((onFrame.mock.calls.length + 1) * 1000 / 60);
        }
        expect(onFrame).toHaveBeenCalledTimes(120);
    });

    it('applies a changed cap on the next refresh', () => {
        maxFps = 30;
        loop.start();
        refresh(0);
        refresh(1000 / 120);
        expect(onFrame).toHaveBeenCalledTimes(1);
        maxFps = 120;
        refresh(2000 / 120);
        expect(onFrame).toHaveBeenCalledTimes(2);
        expect(onFrame.mock.calls[1][1]).toBeCloseTo(1 / 60);
    });

    it('checks for movement before deciding to skip a capped frame', () => {
        maxFps = 30;
        loop.start();
        refresh(0);
        loop.beforeFrame = () => { maxFps = 120; };
        refresh(1000 / 120);
        expect(onFrame).toHaveBeenCalledTimes(2);
    });

    it('cancels all requests while hidden and resumes without counting the hidden time', () => {
        const input = new GameInputManager({});
        loop.onPause = () => input.reset();
        loop.start();
        refresh(0);
        input._onKeyDown({ code: 'KeyW' });
        input.isLeftMouseDown = true;
        input.mouseDelta.x = 15;
        setHidden(true);
        expect(requests.size).toBe(0);
        expect(input.getKeys()).toEqual({});
        expect(input.consumeKeyPress('KeyW')).toBe(false);
        expect(input.isDragging()).toBe(false);
        expect(input.getMouseDelta()).toEqual({ x: 0, y: 0 });
        refresh(60000);
        expect(onFrame).toHaveBeenCalledTimes(1);
        setHidden(false);
        expect(requests.size).toBe(1);
        refresh(60001);
        expect(onFrame.mock.calls[1][1]).toBe(0);
        refresh(60001 + 1000 / 60);
        expect(onFrame.mock.calls[2][1]).toBeCloseTo(1 / 60);
    });

    it('does no work when started in a hidden tab', () => {
        documentStub.hidden = true;
        loop.start();
        expect(requests.size).toBe(0);
        setHidden(false);
        refresh(90000);
        expect(onFrame).toHaveBeenCalledWith(90000, 0);
    });

    it('does not render a catch-up burst after a slow frame', () => {
        loop.start();
        refresh(0);
        refresh(500);
        refresh(501);
        refresh(502);
        expect(onFrame).toHaveBeenCalledTimes(2);
        refresh(500 + 1000 / 60);
        expect(onFrame).toHaveBeenCalledTimes(3);
    });

    it('removes its listener and cannot restart from a tab switch after stop', () => {
        loop.start();
        loop.start();
        expect(requests.size).toBe(1);
        expect(visibilityListeners.size).toBe(1);
        loop.stop();
        expect(requests.size).toBe(0);
        expect(visibilityListeners.size).toBe(0);
        setHidden(true);
        setHidden(false);
        expect(requests.size).toBe(0);
    });

    it('holds a background sampling yield until the tab is visible', async () => {
        const done = vi.fn();
        const pending = waitForVisibleFrame().then(done);
        setHidden(true);
        expect(requests.size).toBe(0);
        refresh(60000);
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        setHidden(false);
        refresh(60001);
        await pending;
        expect(done).toHaveBeenCalledOnce();
        expect(visibilityListeners.size).toBe(0);
    });
});
