import test from 'node:test';
import assert from 'node:assert/strict';
import { hash3, noise3, noiseWGSL } from '../noise.js';

test('hash3 is deterministic, seeded and within [-1, 1)', () => {
    assert.equal(hash3(1, 2, 3, 4), hash3(1, 2, 3, 4));
    assert.notEqual(hash3(1, 2, 3, 4), hash3(1, 2, 3, 5));
    assert.notEqual(hash3(1, 2, 3, 4), hash3(2, 1, 3, 4));
    for (let i = -20; i < 20; i++) {
        const value = hash3(i, i * 7 - 3, 11 - i, 99);
        assert.ok(value >= -1 && value < 1);
    }
});

test('noise3 passes through the lattice hash and is continuous across cells', () => {
    assert.equal(noise3(3, -2, 7, 9), hash3(3, -2, 7, 9));
    assert.ok(Math.abs(noise3(2 - 1e-7, 0.3, 0.6, 1) - noise3(2 + 1e-7, 0.3, 0.6, 1)) < 1e-5);
    assert.ok(Math.abs(noise3(0.4, -1 - 1e-7, 0.6, 1) - noise3(0.4, -1 + 1e-7, 0.6, 1)) < 1e-5);
    for (let n = 0; n < 50; n++) {
        const value = noise3(n * 0.37, n * -0.21, n * 0.53, 5);
        assert.ok(value >= -1 && value <= 1);
    }
});

test('the WGSL twin carries the same hash constants', () => {
    for (const constant of ['0x27d4eb2du', '0x165667b1u', '0x9e3779b1u', '0x85ebca6bu', '0xc2b2ae35u', '15u', '13u', '16u']) {
        assert.ok(noiseWGSL.includes(constant), constant);
    }
});