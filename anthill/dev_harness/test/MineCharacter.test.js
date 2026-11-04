import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelRegion } from '../../core/voxel/VoxelRegion.js';
import { MineTerrain } from '../MineTerrain.js';
import { MineCharacter } from '../MineCharacter.js';

function playground({ height = 8, carves = [], spawn = { x: -9, y: 8.1, z: 0 }, config = {} } = {}) {
    const region = new VoxelRegion({
        heightfield: {
            frame: { origin: { x: 42567.123, y: 131072.337, z: -7364.789 }, up: { x: 0.6, y: 0.8, z: 0 }, heading: { x: 0, y: 0, z: 1 } },
            corner: { x: -16, z: -16 }, spacing: 1, countX: 33, countZ: 33,
            heights: Float32Array.from({ length: 33 * 33 }, (_, i) => typeof height === 'function' ? height(i % 33 - 16, Math.floor(i / 33) - 16) : height),
        },
        rock: { layers: [{ name: 'stone', color: [0.5, 0.5, 0.5] }] },
        voxelSize: 0.25, chunkSize: 16, depth: 24, carves,
    });
    const terrain = new MineTerrain(region);
    const character = new MineCharacter({ terrain, spawn, config });
    return { region, terrain, character };
}
function simulate(character, seconds, input = {}, hz = 60) {
    for (let i = 0; i < Math.round(seconds * hz); i++) character.update(1 / hz, input);
}
const starter = { mode: 'carve', shape: { type: 'capsule', a: [-12, 1, 0], b: [-7, 1, 0], radius: 1.05 } };

test('walks on ground, jumps, and holding jump does not repeat on landing', () => {
    const { character: a, terrain } = playground();
    simulate(a, 0.5);
    assert.ok(a.grounded);
    assert.ok(Math.abs(a.position.y - 8) < 0.03);
    const x = a.position.x;
    simulate(a, 0.5, { moveX: 1 });
    assert.ok(a.position.x > x + 1.5);
    simulate(a, 0.25, { jump: true });
    assert.ok(a.position.y > 9);
    simulate(a, 1, { jump: true });
    assert.ok(a.grounded && a.alive);
    assert.equal(terrain.bodyBlocked(a.position, a.config.radius, a.config.height), false);
});

test('solid walls and tunnel ceilings block the body, including fast falls', () => {
    const { character: a, terrain } = playground({ carves: [starter], spawn: { x: -9, y: 0, z: 0 } });
    simulate(a, 0.5);
    simulate(a, 2, { moveX: 1 });
    assert.ok(a.position.x < -5.8, `wall stopped miner at ${a.position.x}`);
    simulate(a, 0.15, { jump: true });
    assert.ok(a.position.y < 0.5, `ceiling stopped jump at ${a.position.y}`);
    assert.ok(!terrain.bodyBlocked(a.position, a.config.radius, a.config.height));
    a.position = { x: 0, y: 30, z: 0 };
    a.velocity.y = -40;
    simulate(a, 1, {}, 10);
    assert.ok(a.grounded && !a.alive);
    assert.ok(a.position.y > 7.97 && a.position.y < 8.03, 'cannot tunnel through ground at terminal speed');
});

test('digging uses real density edits and creates traversable rising and descending tunnels', () => {
    for (const degrees of [0, 25, -25]) {
        const { character: a, region, terrain } = playground({ carves: [starter], spawn: { x: -9, y: 0, z: 0 } });
        simulate(a, 0.5);
        const startY = a.position.y;
        const before = region.volume.revision;
        a.setPitch(degrees * Math.PI / 180);
        simulate(a, 6, { moveX: 1, dig: true });
        assert.ok(a.alive, `slope ${degrees} must be survivable`);
        assert.ok(a.position.x > -1, `slope ${degrees}: miner reached ${JSON.stringify(a.position)}`);
        if (degrees > 0) assert.ok(a.position.y > startY + 1, `ascending slope: ${a.position.y}`);
        if (degrees < 0) assert.ok(a.position.y < startY - 1, `descending slope: ${a.position.y}`);
        if (degrees === 0) assert.ok(Math.abs(a.position.y - startY) < 0.25, `level tunnel stays level: ${a.position.y}`);
        assert.ok(region.volume.revision > before);
        assert.ok(!terrain.bodyBlocked(a.position, a.config.radius, a.config.height));
        const after = region.volume.revision;
        simulate(a, 0.5, {});
        assert.equal(region.volume.revision, after, 'releasing D stops edits');
    }
});

test('removing the floor causes a fatal fall into a shaft; respawn preserves edits', () => {
    const { character: a, region, terrain } = playground({ spawn: { x: 0, y: 8.1, z: 0 } });
    simulate(a, 0.5);
    assert.ok(a.grounded);
    region.apply({ shape: { type: 'capsule', a: [0, 10, 0], b: [0, -11, 0], radius: 1.3 } });
    const revision = region.volume.revision;
    simulate(a, 3);
    assert.equal(a.alive, false);
    assert.equal(a.deaths, 1);
    assert.match(a.deathReason, /Fatal fall/);
    assert.ok(a.position.y < -10);
    const position = { ...a.position };
    simulate(a, 0.5, { dig: true, jump: true, moveX: 1 });
    assert.deepEqual(a.position, position, 'dead characters cannot move or dig');
    a.spawn = terrain.surfaceSpawn(0, 0, a.config.radius, a.config.height);
    assert.ok(Math.hypot(a.spawn.x, a.spawn.z) > 1.3, 'respawn finds support beside a mined-out entrance');
    a.respawn();
    simulate(a, 0.5);
    assert.ok(a.alive);
    assert.ok(a.grounded);
    assert.equal(a.deaths, 1);
    assert.equal(region.volume.revision, revision);
});

test('vertical digging opens a shaft and 3D movement stays independent of the cut plane', () => {
    const { character: a, region } = playground({ spawn: { x: 0, y: 8.1, z: 0 } });
    simulate(a, 0.5);
    simulate(a, 0.5, { moveZ: 1 });
    assert.ok(a.position.z > 1.5);
    assert.ok(Math.abs(a.heading - Math.PI / 2) < 1e-6);
    a.setPitch(-Math.PI / 2);
    simulate(a, 0.6, { dig: true });
    assert.ok(a.position.y < 7, `floor removed at ${a.position.y}`);
    assert.ok(!region.volume.isSolid(0, 7.5, a.position.z));
});

test('collision detects interior lattice rock, and above-volume sky does not clamp into a ceiling', () => {
    const { terrain, region } = playground();
    assert.equal(terrain.bodyBlocked({ x: 0, y: 30, z: 0 }, 0.28, 1.8), false);
    assert.equal(terrain.bodyBlocked({ x: 16, y: 30, z: 0 }, 0.28, 1.8), true);
    region.apply({ mode: 'fill', shape: { type: 'sphere', center: [0, 10, 0], radius: 0.15 } });
    assert.equal(terrain.bodyBlocked({ x: 0, y: 9, z: 0 }, 0.28, 1.8), true);
});

test('fixed stepping matches at different frame rates, including mining cadence', () => {
    const make = () => playground({ carves: [starter], spawn: { x: -9, y: 0, z: 0 } });
    const a = make(), b = make();
    simulate(a.character, 2, { moveX: 1, dig: true }, 120);
    simulate(b.character, 2, { moveX: 1, dig: true }, 20);
    assert.deepEqual(a.character.position, b.character.position);
    assert.equal(a.region.volume.revision, b.region.volume.revision);
    const world = a.character.worldPosition, local = a.region.frame.worldToLocal(world.x, world.y, world.z);
    for (const axis of ['x','y','z']) assert.ok(Math.abs(local[axis] - a.character.position[axis]) < 1e-9);
});

test('explicit look heading survives strafing/backing up and controls the mining direction', () => {
    const { character: a, terrain } = playground();
    const edits = [];
    terrain.carve = shape => edits.push(shape);
    simulate(a, 0.5);
    simulate(a, 0.5, { moveZ: 1, heading: Math.PI, dig: true });
    assert.ok(a.position.z > 0.5);
    assert.equal(a.heading, Math.PI);
    assert.ok(edits.every(shape => shape.b[0] < shape.a[0] && Math.abs(shape.b[2] - shape.a[2]) < 1e-9));
    simulate(a, 0.2, { moveX: 1, heading: Math.PI });
    assert.equal(a.heading, Math.PI, 'walking backwards does not turn the camera');
});
