import test from 'node:test';
import assert from 'node:assert/strict';
import { CutPlane } from '../CutPlane.js';
import { RibbonBuilder } from '../lineRibbon.js';

function close(actual, expected, eps = 1e-6) {
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= eps, `index ${i}: ${actual[i]} vs ${expected[i]}`);
}
const flat = new CutPlane({ angle: 0, offset: 0 });

test('a segment becomes one quad with attributes for locations 0-3', () => {
    const a = new RibbonBuilder().addPolyline([0, 0, 2, 0], flat, [1, 0.5, 0.25, 1], 3).toArrays();
    close(a.position, [0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0]);
    close(a.normal, [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    close(a.uv, [-1, 1.5, 1, 1.5, -1, 1.5, 1, 1.5]);
    close(a.color, [1, 0.5, 0.25, 1, 1, 0.5, 0.25, 1, 1, 0.5, 0.25, 1, 1, 0.5, 0.25, 1]);
    assert.ok(a.index instanceof Uint32Array);
    assert.deepEqual(Array.from(a.index), [0, 1, 2, 1, 3, 2]);
});

test('joints are mitered', () => {
    const a = new RibbonBuilder().addPolyline([0, 0, 1, 0, 1, 1], flat, [1, 1, 1, 1], 2).toArrays();
    close(Array.from(a.normal.subarray(6, 9)), [-1, 1, 0]);          // corner vertex: length sqrt(2) along the bisector
    assert.equal(a.index.length, 12);
});

test('repeated points, hairpins and needle-sharp corners stay finite and bounded', () => {
    const builder = new RibbonBuilder({ miterLimit: 4 });
    builder.addPolyline([0, 0, 0, 0, 1, 0], flat, [1, 1, 1, 1], 2);
    assert.equal(builder.vertexCount, 4);
    builder.addPolyline([0, 0, 1, 0, 0, 0], flat, [1, 1, 1, 1], 2);
    builder.addPolyline([0, 0, 1, 0, 0, 0.001], flat, [1, 1, 1, 1], 2);
    builder.addPolyline([5, 5], flat, [1, 1, 1, 1], 2);              // single point: nothing
    const a = builder.toArrays();
    assert.equal(a.position.length / 3, 4 + 6 + 6);
    for (const value of a.normal) assert.ok(Number.isFinite(value));
    for (let i = 0; i < a.normal.length; i += 3) assert.ok(Math.hypot(a.normal[i], a.normal[i + 1], a.normal[i + 2]) <= 4 + 1e-5);
    for (const index of a.index) assert.ok(index < a.position.length / 3);
    assert.equal(a.index[6], 4);                                     // second polyline indexes its own vertices
});

test('positions and offsets follow the cut plane orientation', () => {
    const plane = new CutPlane({ angle: Math.PI / 2, offset: 3 });   // s runs along frame z at x = -3
    const a = new RibbonBuilder().addPolyline([0, 1, 0, 2], plane, [1, 1, 1, 1], 2).toArrays();
    close(Array.from(a.position.subarray(0, 3)), [-3, 1, 0]);
    close(Array.from(a.normal.subarray(0, 3)), [0, 0, -1]);          // vertical line: offset along -s = -z
});