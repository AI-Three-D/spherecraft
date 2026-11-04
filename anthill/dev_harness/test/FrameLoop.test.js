import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameLoop } from '../FrameLoop.js';

let requests, documentStub, now, active, frames, pauses, loop, globals;

beforeEach(t => {
    requests = new Map();
    documentStub = new EventTarget();
    documentStub.hidden = false;
    now = 0;
    active = false;
    frames = [];
    pauses = 0;
    let nextId = 0;
    globals = ['document', 'requestAnimationFrame', 'cancelAnimationFrame']
        .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.document = documentStub;
    globalThis.requestAnimationFrame = callback => {
        const id = ++nextId;
        requests.set(id, callback);
        return id;
    };
    globalThis.cancelAnimationFrame = id => requests.delete(id);
    t.mock.method(performance, 'now', () => now);
    loop = new FrameLoop({ onFrame: (time, dt) => frames.push({ time, dt }),
        isActive: () => active, onPause: () => { pauses++; } });
});

afterEach(() => {
    loop?.stop();
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});

function refresh(time) {
    now = time;
    const callbacks = [...requests.values()];
    requests.clear();
    callbacks.forEach(callback => callback(time));
}

function setHidden(hidden) {
    documentStub.hidden = hidden;
    documentStub.dispatchEvent(new Event('visibilitychange'));
}

for (const hz of [60, 120, 144]) {
    test(`idle rendering caps at 30 FPS on a ${hz} Hz display without losing simulation time`, () => {
        loop.start();
        for (let i = 0; i < hz * 3; i++) refresh(i * 1000 / hz);
        assert.equal(frames.filter(frame => frame.time >= 1000 && frame.time < 2000).length, 30);
        assert.ok(Math.abs(frames.reduce((sum, frame) => sum + frame.dt, 0) - frames.at(-1).time / 1000) < 1e-9);
        assert.equal(requests.size, 1);
    });
}

test('active animation follows every display refresh', () => {
    active = true;
    loop.start();
    for (let i = 0; i < 144; i++) refresh(i * 1000 / 144);
    assert.equal(frames.length, 144);
});

test('input and simulation activity wake the very next refresh, then settle again', () => {
    loop.start();
    refresh(0);
    refresh(1000);
    const idleCount = frames.length;
    refresh(1008);
    assert.equal(frames.length, idleCount);
    loop.wake();
    refresh(1016);
    assert.equal(frames.length, idleCount + 1);
    refresh(2000);
    refresh(2008);
    assert.equal(frames.length, idleCount + 2, 'returns to idle after the grace period');
    active = true;
    refresh(2016);
    assert.equal(frames.length, idleCount + 3, 'falling, digging or turns wake without an input event');
});

test('hiding cancels all work and returning excludes hidden time from the clock', () => {
    active = true;
    loop.start();
    refresh(0);
    refresh(16);
    setHidden(true);
    assert.equal(pauses, 1);
    assert.equal(requests.size, 0);
    refresh(60000);
    assert.equal(frames.length, 2);
    setHidden(false);
    assert.equal(requests.size, 1);
    refresh(60001);
    assert.equal(frames.at(-1).dt, 0);
    refresh(60017);
    assert.equal(frames.at(-1).dt, 0.016);
});

test('starting hidden schedules no animation or updates', () => {
    documentStub.hidden = true;
    loop.start();
    assert.equal(requests.size, 0);
    assert.equal(pauses, 1);
    refresh(60000);
    assert.deepEqual(frames, []);
    setHidden(false);
    refresh(60001);
    assert.deepEqual(frames, [{ time: 60001, dt: 0 }]);
});

test('a delayed idle frame does not cause a catch-up burst', () => {
    loop.start();
    refresh(0);
    refresh(1000);
    refresh(2000);
    refresh(2001);
    refresh(2002);
    assert.equal(frames.length, 3);
    refresh(2000 + 1000 / 30);
    assert.equal(frames.length, 4);
});

test('stop removes visibility handling and supports one clean restart', () => {
    loop.start();
    loop.start();
    assert.equal(requests.size, 1);
    refresh(0);
    loop.stop();
    setHidden(true);
    setHidden(false);
    assert.equal(pauses, 0);
    assert.equal(requests.size, 0);
    loop.start();
    assert.equal(requests.size, 1);
    refresh(60000);
    assert.equal(frames.at(-1).dt, 0);
});

test('stopping from a frame callback cannot leave another request behind', () => {
    loop.onFrame = () => loop.stop();
    loop.start();
    refresh(0);
    assert.equal(requests.size, 0);
    setHidden(true);
    setHidden(false);
    assert.equal(requests.size, 0);
});
