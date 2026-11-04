import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthillLighting, MAX_ANTHILL_LIGHTS, LIGHTING_HEADER_FLOATS } from '../AnthillLighting.js';
import { carriedTorchPosition } from '../../../dev_harness/torchPose.js';

test('sun moves from east to west, switches off at night, wraps and pauses its clock', () => {
    const light = new AnthillLighting({ timeOfDay: 8, dayDuration: 240 });
    const morning = Array.from(light.data.slice(0, 4));
    assert.ok(morning[0] > 0 && morning[1] > 0 && morning[3] > 0);
    light.setTimeOfDay(16); light.update();
    assert.ok(light.data[0] < 0 && light.data[1] > 0 && light.data[3] > 0);
    light.setTimeOfDay(0); light.update();
    assert.equal(light.data[3], 0);
    light.setTimeOfDay(23); light.update({ deltaTime: 20 });
    assert.equal(light.timeOfDay, 1);
    light.running = false; light.update({ deltaTime: 60 });
    assert.equal(light.timeOfDay, 1);
    assert.ok(Math.abs(Math.hypot(...light.data.slice(0, 3)) - 1) < 1e-6);
});

test('carried and installed lights pack local positions, flicker independently and support steady lanterns', () => {
    const light = new AnthillLighting();
    const torch = light.addLight({ position: [1,2,3] });
    const lantern = light.addLight({ kind: 'lantern', position: [-4,5,6] });
    light.setCarriedLight({ x: 7, y: 8, z: 9 }); light.update({ time: 0 });
    assert.equal(light.data[11], 3);
    assert.deepEqual(Array.from(light.data.slice(LIGHTING_HEADER_FLOATS, LIGHTING_HEADER_FLOATS + 3)), [7,8,9]);
    const before = light.data.slice();
    light.update({ time: 0.17 });
    assert.notEqual(light.data[31], before[31]);
    assert.notEqual(light.data[39], before[39]);
    assert.equal(light.data[47], before[47]);
    light.updateLight(torch, { flicker: 0, intensity: 2, position: [0,0,0] });
    light.setCarriedLight([0,0,0], false); light.removeLight(lantern); light.update({ time: 8 });
    assert.equal(light.data[11], 1);
    assert.equal(light.data[31], 2);
    assert.equal(light.data[12], 0);
    light.updateLight(torch, { enabled: false }); light.update();
    assert.equal(light.data[11], 0);
});

test('light limits and malformed inputs fail without losing existing lights', () => {
    const light = new AnthillLighting();
    for (let i = 0; i < MAX_ANTHILL_LIGHTS - 1; i++) light.addLight({ position: [i,0,0] });
    assert.throws(() => light.addLight({ position: [0,0,0] }), /At most/);
    light.setCarriedLight([0,0,0]); light.update();
    assert.equal(light.data[11], MAX_ANTHILL_LIGHTS);
    assert.throws(() => light.updateLight(1, { radius: 0 }), /radius/);
    assert.equal(light.lights.get(1).radius, 12);
    assert.throws(() => light.updateLight(1, { position: [NaN,0,0] }), /position/);
    assert.throws(() => light.updateLight(1, { flicker: 2 }), /flicker/);
    assert.throws(() => light.updateLight(99, {}), /Unknown/);
});

test('torch follows heading and gait; body proxy stays region local', () => {
    const actor = { position: { x: 5, y: 6, z: 7 }, heading: 0, phase: 0 };
    const first = carriedTorchPosition(actor);
    actor.heading = Math.PI / 2;
    const second = carriedTorchPosition(actor);
    assert.ok(Math.abs(first.x - actor.position.x - (second.z - actor.position.z)) < 1e-10);
    assert.equal(first.y, second.y);
    const light = new AnthillLighting();
    light.setOccluder([1,2,3], [2,4,5]); light.update();
    assert.deepEqual(Array.from(light.data.slice(16,20)), [1,2,3,1]);
    light.setOccluder(null); light.update();
    assert.equal(light.data[19], 0);
});
