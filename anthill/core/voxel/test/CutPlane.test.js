import test from 'node:test';
import assert from 'node:assert/strict';
import { CutPlane } from '../CutPlane.js';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('angle 0 runs along frame x at z = offset, exactly', () => {
    const plane = new CutPlane({ angle: 0, offset: 10 });
    for (const s of [-128, -1, 0, 5, 128]) {
        assert.ok(plane.x(s) === s);
        assert.ok(plane.z(s) === 10);
    }
    assert.deepEqual(plane.clipToRect(-128, -128, 128, 128), [-128, 128]);
});

test('normal is unit, horizontal-perpendicular, and points at the viewer (dir x up)', () => {
    const plane = new CutPlane({ angle: 0.7, offset: -3 });
    near(plane.dirX * plane.normalX + plane.dirZ * plane.normalZ, 0);
    near(Math.hypot(plane.normalX, plane.normalZ), 1);
    near(plane.normalX, -Math.sin(0.7));
    near(plane.normalZ, Math.cos(0.7));
});

test('project inverts x/z', () => {
    const plane = new CutPlane({ angle: 0.7, offset: -3 });
    const hit = plane.project(plane.x(12.5), plane.z(12.5));
    near(hit.s, 12.5); near(hit.distance, 0);
    const off = plane.project(plane.x(4) + 2 * plane.normalX, plane.z(4) + 2 * plane.normalZ);
    near(off.s, 4); near(off.distance, 2);
});

test('clipToRect handles oblique, axis-parallel and missing planes', () => {
    const diagonal = new CutPlane({ angle: Math.PI / 4, offset: 0 }).clipToRect(-128, -128, 128, 128);
    near(diagonal[0], -128 * Math.SQRT2, 1e-9); near(diagonal[1], 128 * Math.SQRT2, 1e-9);
    assert.deepEqual(new CutPlane({ angle: Math.PI / 2, offset: 0 }).clipToRect(-32, -16, 32, 16), [-16, 16]);
    assert.deepEqual(new CutPlane({ angle: 0, offset: 3 }).clipToRect(-32, -16, 32, 16), [-32, 32]);
    assert.equal(new CutPlane({ angle: 0, offset: 200 }).clipToRect(-128, -128, 128, 128), null);
    assert.equal(new CutPlane({ angle: 0.3, offset: 400 }).clipToRect(-128, -128, 128, 128), null);
});

test('revision bumps on change; non-finite input is rejected', () => {
    const plane = new CutPlane();
    const before = plane.revision;
    plane.set(0.1, 2);
    assert.equal(plane.revision, before + 1);
    assert.throws(() => plane.set(NaN, 0), /finite/);
});

test('quarter turns have exact axis directions and preserve their pivot', () => {
    const plane = new CutPlane({ offset: 10 });
    const x = 17, z = 10;
    for (const direction of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
        plane.rotateQuarterTurns(1, x, z);
        assert.deepEqual([plane.dirX, plane.dirZ], direction);
        assert.equal(plane.project(x, z).distance, 0);
        const { s } = plane.project(x, z);
        assert.equal(plane.x(s), x);
        assert.equal(plane.z(s), z);
    }
    assert.throws(() => plane.rotateQuarterTurns(0.5), /integer/);
});
