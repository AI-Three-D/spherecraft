import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainFixture } from '../fixtures/terrainFixture.js';

test('same seed gives identical heights, another seed does not', () => {
    const a = createTerrainFixture({ seed: 7 }).captureHeightfield();
    const b = createTerrainFixture({ seed: 7 }).captureHeightfield();
    const c = createTerrainFixture({ seed: 8 }).captureHeightfield();
    assert.deepEqual(a.heights, b.heights);
    assert.ok(a.heights.some((h, i) => h !== c.heights[i]));
});

test('frame sits about 131 km from the planet centre with up along +Y', () => {
    const { frame } = createTerrainFixture();
    const distance = Math.hypot(frame.origin.x, frame.origin.y, frame.origin.z);
    assert.ok(distance > 130e3 && distance < 132e3);
    assert.deepEqual(frame.up, { x: 0, y: 1, z: 0 });
    assert.equal(frame.heading.y, 0);
    assert.ok(Math.abs(Math.hypot(frame.heading.x, frame.heading.z) - 1) < 1e-12);
});

test('captured heightfield: 256 m across at 1 m spacing, row by row', () => {
    const fixture = createTerrainFixture({ seed: 7 });
    const hf = fixture.captureHeightfield();
    assert.equal(hf.spacing, 1);
    assert.equal((hf.countX - 1) * hf.spacing, 256);
    assert.equal((hf.countZ - 1) * hf.spacing, 256);
    assert.deepEqual(hf.corner, { x: -128, z: -128 });
    assert.ok(hf.heights instanceof Float32Array);
    assert.equal(hf.heights.length, hf.countX * hf.countZ);
    for (const [ix, iz] of [[0, 0], [256, 0], [0, 256], [256, 256], [40, 200], [199, 3]]) {
        assert.equal(hf.heights[iz * hf.countX + ix], Math.fround(fixture.heightAt(hf.corner.x + ix, hf.corner.z + iz)));
    }
});

test('a hill about 60 m high slopes down into a flat valley with gentle noise', () => {
    const fixture = createTerrainFixture({ seed: 7 });
    const hf = fixture.captureHeightfield();
    let peak = -Infinity, peakIndex = 0;
    hf.heights.forEach((h, i) => { if (h > peak) { peak = h; peakIndex = i; } });
    assert.ok(peak > 55 && peak < 65, `peak ${peak}`);
    const px = hf.corner.x + peakIndex % hf.countX, pz = hf.corner.z + Math.floor(peakIndex / hf.countX);
    const d = Math.hypot((px - fixture.hill.x) / fixture.hill.radiusX, (pz - fixture.hill.z) / fixture.hill.radiusZ);
    assert.ok(d < 0.25, `peak at (${px}, ${pz}) is not on the hilltop`);

    const profile = [-70, -10, 40, 100].map(x => fixture.heightAt(x, 10));
    for (let i = 1; i < profile.length; i++) assert.ok(profile[i - 1] > profile[i] + 5, `not sloping down: ${profile}`);

    let low = Infinity, high = -Infinity;                      // x > 100 m is beyond the foot of the hill for every z
    for (let iz = 0; iz < hf.countZ; iz++) {
        for (let ix = 229; ix < hf.countX; ix++) {
            const h = hf.heights[iz * hf.countX + ix];
            low = Math.min(low, h);
            high = Math.max(high, h);
        }
    }
    assert.ok(low > -1 && high < 1, `valley is not flat: ${low}..${high}`);
    assert.ok(high - low > 0.05, 'valley has no noise at all');
});

test('queried heights equal the captured samples bit for bit on the grid', async () => {
    const fixture = createTerrainFixture({ seed: 11 });
    const hf = fixture.captureHeightfield();
    const rows = [0, 117, 256];
    const positions = new Float64Array(rows.length * hf.countX * 2);
    let o = 0;
    for (const iz of rows) for (let ix = 0; ix < hf.countX; ix++) { positions[o++] = hf.corner.x + ix; positions[o++] = hf.corner.z + iz; }
    const heights = await fixture.queryHeights(positions);
    assert.ok(heights instanceof Float32Array);
    assert.equal(heights.length, rows.length * hf.countX);
    rows.forEach((iz, r) => {
        for (let ix = 0; ix < hf.countX; ix++) assert.equal(heights[r * hf.countX + ix], hf.heights[iz * hf.countX + ix]);
    });
});

test('query is asynchronous, reads positions at call time and may resolve out of order', async () => {
    const queue = [];
    const fixture = createTerrainFixture({ seed: 7, schedule: run => queue.push(run) });
    const positions = new Float64Array([10, 20]);
    const log = [];
    const first = fixture.queryHeights(positions).then(h => { log.push('first'); return h; });
    positions[0] = -50;                                        // caller reuses its buffer
    const second = fixture.queryHeights(positions).then(h => { log.push('second'); return h; });
    await Promise.resolve();
    assert.deepEqual(log, []);
    assert.equal(fixture.stats.pending, 2);
    queue[1]();
    queue[0]();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(log, ['second', 'first']);
    assert.equal(a[0], Math.fround(fixture.heightAt(10, 20)));
    assert.equal(b[0], Math.fround(fixture.heightAt(-50, 20)));
    assert.equal(fixture.stats.pending, 0);
});

test('malformed input rejects; queryBias offsets only the query', async () => {
    const fixture = createTerrainFixture({ seed: 7 });
    await assert.rejects(fixture.queryHeights([1, 2, 3]), RangeError);
    fixture.queryBias = 0.5;
    const [h] = await fixture.queryHeights([3, 4]);
    assert.equal(h, Math.fround(fixture.heightAt(3, 4) + 0.5));
});