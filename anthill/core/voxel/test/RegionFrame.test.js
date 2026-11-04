import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionFrame } from '../RegionFrame.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('axes are x = heading, y = up, z = heading x up', () => {
    const frame = new RegionFrame({ origin: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } });
    near(frame.axisX.x, 1); near(frame.axisY.y, 1); near(frame.axisZ.z, 1);
    near(frame.axisZ.x, 0); near(frame.axisZ.y, 0);
});

test('heading is flattened against up and the basis is orthonormal', () => {
    const frame = new RegionFrame({ origin: { x: 1, y: 2, z: 3 }, up: { x: 0, y: 3, z: 0 }, heading: { x: 2, y: 0.3, z: 1 } });
    const { axisX: x, axisY: y, axisZ: z } = frame;
    near(x.y, 0);
    near(x.x, 2 / Math.sqrt(5)); near(x.z, 1 / Math.sqrt(5));
    for (const a of [x, y, z]) near(dot(a, a), 1);
    near(dot(x, y), 0); near(dot(x, z), 0); near(dot(y, z), 0);
    near(z.x, -1 / Math.sqrt(5)); near(z.z, 2 / Math.sqrt(5));
});

test('local <-> world round trip stays below a nanometre 131 km out', () => {
    const length = Math.hypot(0.3, 1, -0.2);
    const up = { x: 0.3 / length, y: 1 / length, z: -0.2 / length };
    const radius = 131072.337;
    const frame = new RegionFrame({ origin: { x: up.x * radius, y: up.y * radius, z: up.z * radius }, up, heading: { x: 1, y: 0, z: 0 } });
    for (const [x, y, z] of [[0, 0, 0], [127.123456789, -99.87654321, -64.5], [-128, 61.000001, 128], [0.1, 0.2, 0.3]]) {
        const world = frame.localToWorld(x, y, z);
        const local = frame.worldToLocal(world.x, world.y, world.z);
        near(local.x, x, 1e-9); near(local.y, y, 1e-9); near(local.z, z, 1e-9);
    }
    const lifted = frame.localToWorld(0, 5, 0);
    near(lifted.x - frame.origin.x, 5 * up.x, 1e-9);
    near(lifted.y - frame.origin.y, 5 * up.y, 1e-9);
});

test('camera-relative translation is subtracted in doubles', () => {
    const frame = new RegionFrame({ origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } });
    const out = frame.writeLocalToCameraRelative({ x: 1, y: 131072.337 + 2.0004, z: 3 }, new Float64Array(16));
    near(out[12], -1, 1e-9); near(out[13], -2.0004, 1e-9); near(out[14], -3, 1e-9);
    assert.equal(out[15], 1);
    assert.deepEqual([out[0], out[5], out[10]], [1, 1, 1]);
});

test('degenerate input is rejected', () => {
    const origin = { x: 0, y: 0, z: 0 };
    assert.throws(() => new RegionFrame({ origin, up: { x: 0, y: 1, z: 0 }, heading: { x: 0, y: 2, z: 0 } }), /parallel/);
    assert.throws(() => new RegionFrame({ origin, up: { x: 0, y: 0, z: 0 }, heading: { x: 1, y: 0, z: 0 } }), /up/);
    assert.throws(() => new RegionFrame({ origin: { x: NaN, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } }), /origin/);
});