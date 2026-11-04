import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainFixture } from '../fixtures/terrainFixture.js';
import { CapturedHeightfield } from '../../core/voxel/CapturedHeightfield.js';
import { CutPlane } from '../../core/voxel/CutPlane.js';
import { GroundProfile } from '../../core/voxel/GroundProfile.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ angle = 0, offset = 10 } = {}) {
    const queue = [];
    const fixture = createTerrainFixture({ seed: 7, schedule: run => queue.push(run) });
    const heightfield = new CapturedHeightfield(fixture.captureHeightfield());
    const plane = new CutPlane({ angle, offset });
    const profile = new GroundProfile({ heightfield, plane, queryHeights: fixture.queryHeights });
    const flush = async () => { for (const run of queue.splice(0)) run(); await tick(); };
    return { fixture, heightfield, plane, profile, flush };
}

test('on a grid row the captured and queried ground lines meet exactly', async () => {
    const { profile, flush } = setup();
    profile.update(-300, 300, 0.5);
    await flush();
    const [west, east] = profile.seams;
    assert.deepEqual([west.s, east.s], [-128, 128]);
    assert.equal(west.queried, west.captured);
    assert.equal(east.queried, east.captured);

    const captured = profile.runs.find(run => run.source === 'captured');
    const [left, right] = profile.runs.filter(run => run.source === 'queried');
    assert.equal(profile.runs.length, 3);
    assert.equal(left.points.at(-2), captured.points[0]);          // same s ...
    assert.equal(left.points.at(-1), captured.points[1]);          // ... same height
    assert.equal(right.points[0], captured.points.at(-2));
    assert.equal(right.points[1], captured.points.at(-1));
    for (const run of profile.runs) {
        for (let i = 2; i < run.points.length; i += 2) assert.ok(run.points[i] > run.points[i - 2], 'runs advance in s');
    }
});

test('on oblique cuts the seam differs only by the interpolation of the 1 m capture', async () => {
    // Analytic curvature bound for this fixture is about 1 cm (h^2/8 * (|fxx| + |fzz|)); 2 cm asserted.
    for (const [angle, offset] of [[0.37, 3.3], [1.1, -41.7], [2.0, 60.2], [-0.8, 12.5], [Math.PI / 2, 0.5]]) {
        const { profile, flush } = setup({ angle, offset });
        profile.update(-400, 400, 0.5);
        await flush();
        assert.equal(profile.seams.length, 2);
        for (const residual of profile.seamResiduals) {
            assert.ok(Math.abs(residual) < 0.02, `angle ${angle}, offset ${offset}: seam step ${residual} m`);
        }
    }
});

test('a disagreement between the two height sources is not hidden', async () => {
    const { fixture, profile, flush } = setup();
    fixture.queryBias = 0.5;
    profile.update(-300, 300, 0.5);
    await flush();
    for (const residual of profile.seamResiduals) assert.ok(Math.abs(residual - 0.5) < 1e-4, `residual ${residual}`);
});