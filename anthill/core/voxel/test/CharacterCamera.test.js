import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterCamera } from '../CharacterCamera.js';
import { RegionFrame } from '../RegionFrame.js';
import { composeClipFromLocal } from '../cameraRelative.js';
import { Matrix4 } from '../../../shared/math/index.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
function scene(options = {}) {
    const frame = new RegionFrame({ origin: { x: 42123.123, y: 131072.337, z: -7890.123 },
        up: { x: 0.6, y: 0.8, z: 0 }, heading: { x: 0, y: 0, z: 1 } });
    const character = { position: { x: 3, y: 8, z: -2 }, heading: 0.7, pitch: 0.3,
        config: { height: 1.8 }, alive: true, setPitch(value) { this.pitch = value; } };
    const camera = new CharacterCamera({ frame, character, ...options });
    camera.update(800, 600);
    return { frame, character, camera };
}

test('first person stays at eye height in a rotated frame, following movement and look', () => {
    const { frame, character: a, camera } = scene({ mode: 'first-person' });
    assert.equal(camera.actualDistance, 0);
    assert.equal(camera.hideCharacter, true);
    for (const [axis, value] of Object.entries({ x: 3, y: 9.62, z: -2 })) near(camera.localPosition[axis], value);
    a.position.x += 4; a.position.y -= 2;
    camera.look(100, -50); camera.update(800, 600);
    near(a.heading, 1.1); near(a.pitch, 0.5);
    const local = frame.worldToLocal(camera.position.x, camera.position.y, camera.position.z);
    near(local.x, 7, 1e-9); near(local.y, 7.62, 1e-9); near(local.z, -2, 1e-9);
    camera.look(0, 1e6); near(a.pitch, -Math.PI * 0.49);
    a.alive = false; camera.look(100, 100); near(a.heading, 1.1);
});

test('third person sits behind the look direction and targets the same eye point', () => {
    const { character: a, camera } = scene();
    const delta = { x: camera.localPosition.x - a.position.x,
        y: camera.localPosition.y - a.position.y - 1.62, z: camera.localPosition.z - a.position.z };
    near(Math.hypot(...Object.values(delta)), 4.5);
    near(delta.x, -Math.cos(a.heading) * Math.cos(a.pitch) * 4.5);
    near(delta.y, -Math.sin(a.pitch) * 4.5);
    assert.equal(camera.hideCharacter, false);
    camera.zoomAt(1e6); near(camera.distance, camera.maxDistance);
    camera.zoomAt(1e-6); near(camera.distance, camera.minDistance);
    camera.setMode('first-person'); camera.zoomAt(10); near(camera.distance, camera.minDistance);
    camera.setMode('third-person'); camera.update(800, 600);
    near(camera.actualDistance, camera.minDistance);
    assert.throws(() => camera.setMode('invalid'), RangeError);
});

test('perspective projects forward to screen centre with WebGPU near/far depth and correct aspect', () => {
    const { frame, character: a, camera } = scene({ mode: 'first-person' });
    const clip = composeClipFromLocal(frame, camera, new Matrix4()).elements;
    const project = distance => {
        const pos = [a.position.x + Math.cos(a.heading) * Math.cos(a.pitch) * distance,
            a.position.y + 1.62 + Math.sin(a.pitch) * distance,
            a.position.z + Math.sin(a.heading) * Math.cos(a.pitch) * distance, 1];
        const out = [0, 1, 2, 3].map(row => pos.reduce((sum, value, col) => sum + clip[col * 4 + row] * value, 0));
        return out.slice(0, 3).map(value => value / out[3]);
    };
    const target = project(5);
    near(target[0], 0); near(target[1], 0);
    near(project(camera.near)[2], 0, 5e-5);
    near(project(camera.far)[2], 1);
    const p = camera.projectionMatrix.elements;
    near(p[5] / p[0], 800 / 600);
    camera.update(600, 800);
    near(p[5] / p[0], 600 / 800);
    a.pitch = Math.PI / 2; camera.update(800, 600);
    assert.ok(Array.from(camera.matrixWorldInverse.elements).every(Number.isFinite));
});

test('camera-relative strafing and backing up preserve the look heading', () => {
    const { character: a, camera } = scene();
    a.heading = Math.PI;
    const forward = camera.movement(0, 1), right = camera.movement(1, 0), backward = camera.movement(0, -1);
    near(forward.moveX, -1); near(forward.moveZ, 0);
    near(right.moveX, 0); near(right.moveZ, -1);
    near(backward.moveX, 1); near(backward.moveZ, 0);
    for (const intent of [forward, right, backward]) near(intent.heading, Math.PI);
});

test('boom sweeps catch thin walls, retract while blocked and restore distance after edits', () => {
    let wall = true;
    const terrain = { sweepStep: 0.05, bodyBlocked(p, radius) {
        return wall && p.x - radius < 1.5 && p.x + radius > 1.4;
    } };
    const { character: a, camera } = scene({ terrain });
    a.heading = 0; a.pitch = 0; camera.update(800, 600);
    near(camera.actualDistance, 1.34, 0.001);
    assert.ok(!terrain.bodyBlocked(camera.localPosition, camera.collisionRadius));
    assert.equal(camera.distance, 4.5, 'collision keeps the chosen boom length');
    wall = false; camera.update(800, 600); near(camera.actualDistance, 4.5);
    a.position.x = 1.8; wall = true; camera.update(800, 600);
    assert.ok(camera.actualDistance < 0.15);
    assert.equal(camera.hideCharacter, true, 'tight tunnels hide the body before it covers the camera');
});
