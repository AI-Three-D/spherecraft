import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { VoxelVolume } from '../VoxelVolume.js';
import { CutPlane } from '../CutPlane.js';
import { PlaneSlice } from '../PlaneSlice.js';

function makeVolume() {
    const countX = 33, countZ = 33;
    const heights = new Float32Array(countX * countZ);
    for (let iz = 0; iz < countZ; iz++) for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = 4 + 0.25 * (-16 + ix);
    const surface = new CapturedHeightfield({
        frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
        corner: { x: -16, z: -16 }, spacing: 1, countX, countZ, heights,
    });
    const volume = new VoxelVolume({ surface, minY: -16, maxY: 12, voxelSize: 0.25, chunkSize: 16 });
    volume.apply({ shape: { type: 'sphere', center: [2, 0, 1], radius: 1.5 } });
    return volume;
}
const everything = (slice, level) => slice.ensure(level, -100, 100, -100, 100);

test('grid covers the plane rectangle and holds the volume density at each texel', () => {
    const volume = makeVolume();
    const plane = new CutPlane({ angle: 0, offset: 1 });
    const slice = new PlaneSlice({ volume, plane });
    const cut = everything(slice, 0);
    assert.deepEqual(slice.span, [-16, 16]);
    assert.deepEqual([cut.texel, cut.s0, cut.y0, cut.width, cut.height], [0.25, -16, -16, 129, 113]);
    assert.equal(cut.tilesBuilt, 6);
    for (let b = 0; b < cut.height; b++) {
        for (let a = 0; a < cut.width; a++) assert.equal(cut.data[b * cut.width + a], volume.quantized(a, b, 68) + 128, `texel ${a},${b}`);
    }
    assert.equal(cut.data[64 * cut.width + 78], 128);                 // the carved sphere's surface at s = 3.5, y = 0
    assert.equal(cut.data[64 * cut.width + 72], 1);                   // its centre: air
});

test('tiles are sampled only where the view needs them', () => {
    const slice = new PlaneSlice({ volume: makeVolume(), plane: new CutPlane({ angle: 0, offset: 1 }) });
    const cut = slice.ensure(0, -16, -10, -16, -10);
    assert.equal(cut.tilesBuilt, 1);
    const revision = cut.revision;
    assert.equal(slice.ensure(0, -16, -10, -16, -10), cut);
    assert.equal(cut.revision, revision);                             // nothing new to do
    everything(slice, 0);
    assert.equal(cut.tilesBuilt, 6);
    assert.ok(cut.revision > revision);
});

test('coarser levels double the texel size', () => {
    const slice = new PlaneSlice({ volume: makeVolume(), plane: new CutPlane({ angle: 0, offset: 1 }) });
    const cut = everything(slice, 1);
    assert.deepEqual([cut.texel, cut.width, cut.height], [0.5, 65, 57]);
    assert.equal(slice.levelFor(0.02), 0);
    assert.equal(slice.levelFor(0.125), 0);
    assert.equal(slice.levelFor(0.25), 1);
    assert.equal(slice.levelFor(0.4), 1);
    assert.equal(slice.levelFor(1), 3);
    assert.equal(slice.levelFor(50), 3);
    assert.throws(() => slice.ensure(7, 0, 1, 0, 1), /level/);
});

test('detail thresholds tolerate float32 projection rounding while preserving zoom changes', () => {
    const slice = new PlaneSlice({ volume: makeVolume(), plane: new CutPlane() });
    for (let level = 1; level <= slice.maxLevel; level++) {
        const threshold = slice.volume.voxelSize * 2 ** level / 2;
        for (const height of [600, 768, 1080, 1440]) {
            const projectionScale = Math.fround(2 / (height * threshold));
            const metersPerPixel = 2 / (projectionScale * height);
            assert.equal(slice.levelFor(metersPerPixel), level, `level ${level}, height ${height}`);
        }
        assert.equal(slice.levelFor(threshold * (1 - 1e-6)), level - 1);
        assert.equal(slice.levelFor(threshold), level);
        assert.equal(slice.levelFor(threshold * (1 + 1e-6)), level);
    }
    slice.dispose();
});

test('invalid zoom is rejected instead of yielding a NaN grid level', () => {
    const slice = new PlaneSlice({ volume: makeVolume(), plane: new CutPlane() });
    for (const value of [0, -1, NaN, Infinity]) assert.throws(() => slice.levelFor(value), /zoom/);
    slice.dispose();
});

test('after an edit the incrementally updated grid equals a fresh one', () => {
    for (const [angle, offset] of [[0, 1], [0.6, -2.3], [Math.PI / 2, 4]]) {
        const volume = makeVolume();
        const plane = new CutPlane({ angle, offset });
        const slice = new PlaneSlice({ volume, plane });
        const cut = everything(slice, 0);
        const coarse = everything(slice, 1);
        const before = cut.revision;
        volume.apply({ shape: { type: 'capsule', a: [-6, -3, -4], b: [5, 2, 6], radius: 1 } });
        volume.apply({ mode: 'fill', shape: { type: 'sphere', center: [2, 0.5, 1], radius: 0.75 } });
        assert.ok(cut.revision > before, `angle ${angle}: the edit crosses the plane`);
        const fresh = new PlaneSlice({ volume, plane });
        assert.deepEqual(cut.data, everything(fresh, 0).data);
        assert.deepEqual(coarse.data, everything(fresh, 1).data);
    }
});

test('an edit that does not reach the plane leaves the grid alone', () => {
    const volume = makeVolume();
    const slice = new PlaneSlice({ volume, plane: new CutPlane({ angle: 0, offset: 1 }) });
    const cut = everything(slice, 0);
    const before = cut.revision;
    assert.ok(volume.apply({ shape: { type: 'sphere', center: [0, -5, -10], radius: 1 } }));
    assert.equal(cut.revision, before);
});

test('moving the plane starts a new epoch; a plane outside the region has no grid', () => {
    const volume = makeVolume();
    const plane = new CutPlane({ angle: 0, offset: 1 });
    const slice = new PlaneSlice({ volume, plane });
    const first = everything(slice, 0);
    const epoch = slice.epoch;
    plane.set(0, 2);
    const second = everything(slice, 0);
    assert.notEqual(second, first);
    assert.equal(slice.epoch, epoch + 1);
    plane.set(0, 40);
    assert.equal(everything(slice, 0), null);
    assert.equal(slice.span, null);
    slice.dispose();
});
