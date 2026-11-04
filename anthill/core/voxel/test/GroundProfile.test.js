import test from 'node:test';
import assert from 'node:assert';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { CutPlane } from '../CutPlane.js';
import { GroundProfile } from '../GroundProfile.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const height = (x, z) => 0.1 * x - 0.05 * z + 2 * Math.sin(x * 0.07) * Math.cos(z * 0.05);

/** Footprint x in [-32, 32], z in [-16, 16] (not square, to catch axis swaps); queries resolve by hand. */
function makeWorld() {
    const countX = 65, countZ = 33, corner = { x: -32, z: -16 };
    const heights = new Float32Array(countX * countZ);
    for (let iz = 0; iz < countZ; iz++) for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = height(corner.x + ix, corner.z + iz);
    const heightfield = new CapturedHeightfield({
        frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
        corner, spacing: 1, countX, countZ, heights,
    });
    const calls = [];
    const queryHeights = positions => new Promise((resolve, reject) => {
        const copy = Float64Array.from(positions);
        calls.push({
            positions: copy,
            resolve: () => resolve(Float32Array.from({ length: copy.length / 2 }, (_, i) => height(copy[2 * i], copy[2 * i + 1]))),
            resolveWith: resolve,
            reject,
        });
    });
    return { heightfield, calls, queryHeights };
}

test('captured run is available synchronously and hits stored samples exactly', () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
    const before = profile.revision;
    assert.equal(profile.update(-60, 60, 0.25), undefined);
    assert.ok(profile.revision > before);
    assert.equal(calls.length, 1);
    assert.equal(profile.runs.length, 1);
    const [run] = profile.runs;
    assert.equal(run.source, 'captured');
    assert.equal(run.points.length, 257 * 2);                      // 64 m at 0.25 m
    assert.equal(run.points[0], -32);
    assert.equal(run.points.at(-2), 32);
    for (const s of [-32, -7, 0, 19, 32]) {
        const i = (s + 32) * 4;
        assert.equal(run.points[2 * i], s);
        assert.equal(run.points[2 * i + 1], Math.fround(height(s, 4)));
    }
    assert.deepEqual(profile.seams.map(seam => seam.s), [-32, 32]);
    assert.deepEqual(profile.seamResiduals, [null, null]);
});

test('one request in flight; the window is reused while panning; samples sit on a fixed lattice', async () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
    profile.update(-60, 60, 0.25);
    profile.update(-59, 61, 0.25);
    assert.equal(calls.length, 1);
    calls[0].resolve();
    await tick();
    assert.deepEqual(profile.runs.map(run => run.source), ['captured', 'queried', 'queried']);
    profile.update(-100, 20, 0.25);                                // still inside the fetched window
    assert.equal(calls.length, 1);
    profile.update(-130, -10, 0.25);                               // beyond it
    assert.equal(calls.length, 2);
    const p = calls[1].positions;
    assert.deepEqual(Array.from(p.subarray(0, 4)), [-32, 4, 32, 4]);   // seams first
    for (let i = 4; i < p.length; i += 2) {
        assert.ok(Number.isInteger(p[i]), `x ${p[i]} is off the 1 m lattice`);
        assert.ok(p[i] < -32 || p[i] > 32, 'no samples are requested inside the region');
        assert.equal(p[i + 1], 4);
    }
});

test('sample spacing follows the zoom in powers of two', () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
    profile.update(-2000, 2000, 3);                                // 3 m/px * 4 px = 12 m -> 16 m
    const p = calls[0].positions;
    assert.equal(p[6] - p[4], 16);
    assert.equal(p[4] % 16, 0);
});

test('results for an older cut plane are dropped, whichever order they arrive in', async () => {
    for (const order of [[1, 0], [0, 1]]) {
        const { heightfield, calls, queryHeights } = makeWorld();
        const plane = new CutPlane({ angle: 0, offset: 4 });
        const profile = new GroundProfile({ heightfield, plane, queryHeights });
        profile.update(-60, 60, 0.25);
        plane.set(0, -3);
        profile.update(-60, 60, 0.25);                             // the stale request must not block this one
        assert.equal(calls.length, 2);
        for (const index of order) { calls[index].resolve(); await tick(); }
        assert.equal(profile.stats.stale, 1);
        for (const seam of profile.seams) assert.equal(seam.queried, Math.fround(height(seam.s, -3)));
        const queried = profile.runs.filter(run => run.source === 'queried');
        assert.equal(queried.length, 2);
        for (const run of queried) {
            for (let i = 0; i < run.points.length; i += 2) assert.equal(run.points[i + 1], Math.fround(height(run.points[i], -3)));
        }
    }
});

test('a failed query is reported, never thrown, and retried after the cooldown', async () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const errors = [];
    const profile = new GroundProfile({
        heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights,
        retryUpdates: 3, onError: error => errors.push(error),
    });
    profile.update(-60, 60, 0.25);
    calls[0].reject(new Error('readback failed'));
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(profile.stats.failures, 1);
    assert.equal(profile.runs.length, 1);
    profile.update(-60, 60, 0.25);
    profile.update(-60, 60, 0.25);
    assert.equal(calls.length, 1);
    profile.update(-60, 60, 0.25);
    assert.equal(calls.length, 2);
    calls[1].resolve();
    await tick();
    assert.equal(profile.runs.length, 3);
});

test('wrong-length or non-finite answers count as failures', async () => {
    for (const bad of [() => new Float32Array(3), count => new Float32Array(count).fill(NaN)]) {
        const { heightfield, calls, queryHeights } = makeWorld();
        const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
        profile.update(-60, 60, 0.25);
        calls[0].resolveWith(bad(calls[0].positions.length / 2));
        await tick();
        assert.equal(profile.stats.failures, 1);
        assert.equal(profile.runs.length, 1);
        assert.deepEqual(profile.seamResiduals, [null, null]);
    }
});

test('a plane that misses the region gives one continuous queried run', async () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 40 }), queryHeights });
    profile.update(-20, 20, 0.25);
    assert.equal(profile.runs.length, 0);
    calls[0].resolve();
    await tick();
    assert.equal(profile.seams.length, 0);
    assert.equal(profile.runs.length, 1);
    assert.equal(profile.runs[0].source, 'queried');
    assert.equal(profile.runs[0].points.length, 83 * 2);           // lattice -41..41
});

test('a view beside the region draws no chord back to the seam', async () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
    profile.update(200, 300, 0.25);
    calls[0].resolve();
    await tick();
    const queried = profile.runs.filter(run => run.source === 'queried');
    assert.equal(queried.length, 1);
    assert.equal(queried[0].points[0], 149);
});

test('invalidate refetches; dispose ignores late answers', async () => {
    const { heightfield, calls, queryHeights } = makeWorld();
    const profile = new GroundProfile({ heightfield, plane: new CutPlane({ angle: 0, offset: 4 }), queryHeights });
    profile.update(-60, 60, 0.25);
    calls[0].resolve();
    await tick();
    profile.invalidate();
    profile.update(-60, 60, 0.25);
    assert.equal(calls.length, 2);
    assert.equal(profile.runs.length, 1);
    profile.dispose();
    const revision = profile.revision;
    calls[1].resolve();
    await tick();
    assert.equal(profile.revision, revision);
});