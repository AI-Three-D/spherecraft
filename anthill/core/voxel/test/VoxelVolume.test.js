import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { VoxelVolume } from '../VoxelVolume.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const SCALE = 127 / 2;
const quantize = value => (value >= 127 ? 127 : value <= -127 ? -127 : Math.round(value) | 0);
const ground = x => 4 + 0.25 * x;                                     // tilted plane: 0 m at x = -16, 8 m at x = 16

/** 32 m footprint, y from -16 to 12, 0.25 m voxels, 4 m chunks (16 samples) so edits cross chunk borders. */
function makeVolume(options = {}) {
    const countX = 33, countZ = 33;
    const heights = new Float32Array(countX * countZ);
    for (let iz = 0; iz < countZ; iz++) for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = ground(-16 + ix);
    const surface = new CapturedHeightfield({
        frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
        corner: { x: -16, z: -16 }, spacing: 1, countX, countZ, heights,
    });
    return new VoxelVolume({ surface, minY: -16, maxY: 12, voxelSize: 0.25, chunkSize: 16, ...options });
}
const position = (i, j, k) => [-16 + i * 0.25, -16 + j * 0.25, -16 + k * 0.25];
const baseAt = (i, j) => quantize((ground(-16 + i * 0.25) - (-16 + j * 0.25)) / 0.25 * SCALE);
const SPHERE = { type: 'sphere', center: [2, 0, 1], radius: 1.5 };
const sphereAt = (i, j, k) => {
    const [x, y, z] = position(i, j, k);
    return quantize((Math.hypot(x - 2, y - 0, z - 1) - 1.5) * SCALE / 0.25);
};

test('untouched ground: rock below the captured surface, air above, nothing stored', () => {
    const volume = makeVolume();
    assert.deepEqual([volume.countX, volume.countY, volume.countZ], [129, 113, 129]);
    assert.equal(volume.allocatedChunks, 0);
    for (const x of [-10, 0, 7.5]) {
        near(volume.sample(x, ground(x), 3), 0);
        near(volume.sample(x, ground(x) - 1, 3), 2);
        near(volume.sample(x, ground(x) + 1, 3), -2);
        near(volume.sample(x, ground(x) - 0.125, 3), 0.5, 0.01);
        assert.equal(volume.isSolid(x, ground(x) - 0.1, 3), true);
        assert.equal(volume.isSolid(x, ground(x) + 0.1, 3), false);
    }
    assert.equal(volume.allocatedChunks, 0);
    near(volume.sample(100, 0, 0), volume.sample(16, 0, 0));          // clamped outside
});

test('carving stores only the touched chunks and matches min(ground, brush) at every sample', () => {
    const volume = makeVolume();
    const result = volume.apply({ mode: 'carve', shape: SPHERE });
    assert.ok(result.changed > 0);
    assert.equal(volume.revision, 1);
    assert.equal(volume.allocatedChunks, 4);                          // 1 x 2 x 2 chunks around the sphere
    assert.ok(volume.memoryBytes === 4 * 16 ** 3);

    let changed = 0;
    for (let k = 52; k <= 84; k++) {
        for (let j = 48; j <= 80; j++) {
            for (let i = 56; i <= 88; i++) {
                const expected = Math.min(baseAt(i, j), sphereAt(i, j, k));
                assert.equal(volume.quantized(i, j, k), expected, `sample ${i},${j},${k}`);
                if (expected !== baseAt(i, j)) {
                    changed++;
                    for (const [axis, index] of [[0, i], [1, j], [2, k]]) {
                        assert.ok(index >= result.min[axis] && index <= result.max[axis], 'reported bounds contain every change');
                    }
                }
            }
        }
    }
    assert.equal(changed, result.changed);

    near(volume.sample(2, 0, 1), -2);                                 // centre is air
    near(volume.sample(3.5, 0, 1), 0);                                // surface exactly at the radius
    near(volume.sample(3.25, 0, 1), -1, 0.02);                        // one voxel inside
    near(volume.sample(3.75, 0, 1), 1, 0.02);                         // one voxel outside
    near(volume.sample(8, 0, 1), 2);                                  // far rock untouched
});

test('edits are idempotent, fill restores rock, listeners hear about changes', () => {
    const volume = makeVolume();
    const heard = [];
    const stop = volume.subscribe(edit => heard.push(edit));
    volume.apply({ shape: SPHERE });
    assert.equal(volume.apply({ shape: SPHERE }), null);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].mode, 'carve');

    const filled = volume.apply({ mode: 'fill', shape: { type: 'sphere', center: [2, 0, 1], radius: 3 } });
    assert.ok(filled.changed > 0);
    near(volume.sample(2, 0, 1), 2);
    assert.equal(heard.length, 2);
    assert.equal(volume.revision, 2);

    stop();
    volume.apply({ shape: SPHERE });
    assert.equal(heard.length, 2);
    assert.throws(() => volume.apply({ mode: 'paint', shape: SPHERE }), /mode/);
});

test('carves and underground restoration preserve the baseline upper bound; additive fills disable it', () => {
    const v=makeVolume();
    v.apply({shape:SPHERE});
    assert.equal(v.hasAdditions,false);
    v.apply({mode:'fill',shape:{type:'sphere',center:[2,0,1],radius:3}});
    assert.equal(v.hasAdditions,false,'restoring rock below the saturated baseline is safe');
    v.apply({mode:'fill',shape:{type:'sphere',center:[2,7,1],radius:1}});
    assert.equal(v.hasAdditions,true);
    v.apply({shape:{type:'sphere',center:[2,7,1],radius:2}});
    assert.equal(v.hasAdditions,true,'the conservative flag survives subsequent carving');
});

test('the outer shell at the sides and bottom cannot be edited', () => {
    const volume = makeVolume();
    volume.apply({ shape: { type: 'sphere', center: [-16, 0, 0], radius: 2 } });
    assert.equal(volume.quantized(3, 64, 64), 48);                    // still the ground value
    assert.equal(volume.quantized(4, 64, 64), -127);                  // first editable sample is dug out
    volume.apply({ shape: { type: 'sphere', center: [0, -16, 0], radius: 2 } });
    assert.equal(volume.quantized(64, 3, 64), 127);
    assert.equal(volume.quantized(64, 4, 64), -127);
});

test('water channel is carried per sample and allocated on first write', () => {
    const volume = makeVolume();
    assert.equal(volume.water(70, 64, 64), 0);
    const before = volume.quantized(70, 64, 64);
    volume.setWater(70, 64, 64, 200);
    assert.equal(volume.water(70, 64, 64), 200);
    assert.equal(volume.water(71, 64, 64), 0);
    assert.equal(volume.allocatedChunks, 1);
    assert.equal(volume.quantized(70, 64, 64), before);
    assert.equal(volume.chunkAt(4, 4, 4).water.length, 16 ** 3);
});

test('finer voxels work; extents must be whole voxels', () => {
    const fine = makeVolume({ voxelSize: 0.125 });
    assert.equal(fine.countX, 257);
    fine.apply({ shape: { type: 'sphere', center: [2, 0, 1], radius: 0.5 } });
    near(fine.sample(2.5, 0, 1), 0);
    near(fine.sample(2, 0, 1), -2);
    assert.throws(() => makeVolume({ voxelSize: 0.3 }), /whole multiples/);
});
