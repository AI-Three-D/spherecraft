import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedHeightfield } from '../CapturedHeightfield.js';

const frame = { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } };

function descriptor(overrides = {}) {
    const countX = 4, countZ = 3;
    const heights = new Float32Array(countX * countZ);
    for (let iz = 0; iz < countZ; iz++) for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = 10 * iz + ix;
    return { frame, corner: { x: 5, z: -2 }, spacing: 1, countX, countZ, heights, ...overrides };
}

test('footprint and height range', () => {
    const hf = new CapturedHeightfield(descriptor());
    assert.deepEqual([hf.minX, hf.maxX, hf.minZ, hf.maxZ], [5, 8, -2, 0]);
    assert.deepEqual([hf.minHeight, hf.maxHeight], [0, 23]);
});

test('returns stored samples exactly, rows along x, including the last row and column', () => {
    const hf = new CapturedHeightfield(descriptor());
    for (let iz = 0; iz < 3; iz++) for (let ix = 0; ix < 4; ix++) assert.equal(hf.sample(5 + ix, -2 + iz), 10 * iz + ix);
    assert.equal(hf.at(3, 0), 3);
    assert.equal(hf.at(0, 2), 20);
});

test('interpolates bilinearly and clamps outside the footprint', () => {
    const hf = new CapturedHeightfield(descriptor());
    assert.equal(hf.sample(5.5, -1.5), 5.5);
    assert.equal(hf.sample(6.25, -2), 1.25);
    assert.equal(hf.sample(-100, -2), 0);
    assert.equal(hf.sample(100, 100), 23);
});

test('honours spacing', () => {
    const hf = new CapturedHeightfield(descriptor({ spacing: 0.5 }));
    assert.equal(hf.maxX, 6.5);
    assert.equal(hf.sample(5.5, -2), 1);
    assert.equal(hf.sample(5, -1.5), 10);
});

test('rejects malformed descriptors', () => {
    assert.throws(() => new CapturedHeightfield(descriptor({ heights: new Float32Array(11) })), /countX \* countZ/);
    assert.throws(() => new CapturedHeightfield(descriptor({ heights: new Array(12).fill(0) })), /Float32Array/);
    assert.throws(() => new CapturedHeightfield(descriptor({ countX: 1, heights: new Float32Array(3) })), /counts/);
    assert.throws(() => new CapturedHeightfield(descriptor({ spacing: 0 })), /spacing/);
    const poisoned = descriptor();
    poisoned.heights[7] = NaN;
    assert.throws(() => new CapturedHeightfield(poisoned), /non-finite/);
});