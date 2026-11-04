import test from 'node:test';
import assert from 'node:assert/strict';
import { compileShape } from '../shapes.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('sphere', () => {
    const s = compileShape({ type: 'sphere', center: [1, 2, 3], radius: 2 });
    near(s.distance(1, 2, 3), -2);
    near(s.distance(4, 2, 3), 1);
    assert.deepEqual(s.min, [-1, 0, 1]);
    assert.deepEqual(s.max, [3, 4, 5]);
});

test('capsule', () => {
    const s = compileShape({ type: 'capsule', a: [0, 0, 0], b: [10, 0, 0], radius: 2 });
    near(s.distance(5, 3, 0), 1);
    near(s.distance(-4, 0, 0), 2);
    near(s.distance(12, 0, 0), 0);
    near(s.distance(5, 0, 0), -2);
    assert.deepEqual(s.min, [-2, -2, -2]);
    assert.deepEqual(s.max, [12, 2, 2]);
});

test('ellipsoid', () => {
    const s = compileShape({ type: 'ellipsoid', center: [0, 0, 0], radii: [4, 2, 3] });
    near(s.distance(0, 0, 0), -2);
    near(s.distance(4, 0, 0), 0);
    near(s.distance(8, 0, 0), 4);
    near(s.distance(2, 0, 0), -2);
    near(s.distance(0, 2, 0), 0);
    assert.deepEqual(s.max, [4, 2, 3]);
});

test('roughness displaces by at most its amplitude and widens the bounds', () => {
    const smooth = compileShape({ type: 'sphere', center: [0, 0, 0], radius: 3 });
    const rough = compileShape({ type: 'sphere', center: [0, 0, 0], radius: 3, roughness: { amplitude: 0.5, frequency: 0.7, seed: 3 } });
    let differs = false;
    for (let n = 0; n < 40; n++) {
        const p = [n * 0.31 - 5, n * 0.17 - 3, 4 - n * 0.23];
        const delta = rough.distance(...p) - smooth.distance(...p);
        assert.ok(Math.abs(delta) <= 0.5 + 1e-12);
        if (Math.abs(delta) > 1e-3) differs = true;
    }
    assert.ok(differs);
    assert.deepEqual(rough.min, [-3.5, -3.5, -3.5]);
});

test('malformed shapes are rejected', () => {
    assert.throws(() => compileShape({ type: 'cube' }), /unknown/);
    assert.throws(() => compileShape({ type: 'sphere', center: [0, 0, 0], radius: -1 }), /radius/);
    assert.throws(() => compileShape({ type: 'capsule', a: [0, 0, 0], radius: 1 }), /capsule/);
});