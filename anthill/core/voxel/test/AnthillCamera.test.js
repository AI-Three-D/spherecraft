import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionFrame } from '../RegionFrame.js';
import { CutPlane } from '../CutPlane.js';
import { AnthillCamera } from '../AnthillCamera.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

function make() {
    const frame = new RegionFrame({ origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: Math.cos(0.6), y: 0, z: Math.sin(0.6) } });
    const plane = new CutPlane({ angle: 0.3, offset: 5 });
    const camera = new AnthillCamera({ frame, plane, center: { s: 12, y: 30 }, metersPerPixel: 0.5 });
    camera.update(800, 600);
    return { frame, plane, camera };
}

test('sits eyeDistance in front of the view centre, in world space', () => {
    const { frame, plane, camera } = make();
    const local = frame.worldToLocal(camera.position.x, camera.position.y, camera.position.z);
    const hit = plane.project(local.x, local.z);
    near(hit.s, 12); near(hit.distance, 100); near(local.y, 30);
    assert.ok(Math.hypot(camera.position.x, camera.position.y, camera.position.z) > 130e3);
});

test('view rotation looks straight at the plane; projection is orthographic with square pixels', () => {
    const { frame, plane, camera } = make();
    const v = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
    const target = frame.localToWorld(plane.x(12), 30, plane.z(12));
    const rel = [target.x - camera.position.x, target.y - camera.position.y, target.z - camera.position.z];
    const viewSpace = [0, 1, 2].map(row => v[row] * rel[0] + v[4 + row] * rel[1] + v[8 + row] * rel[2]);
    near(viewSpace[0], 0, 1e-4); near(viewSpace[1], 0, 1e-4); near(viewSpace[2], -100, 1e-4);
    near(p[0], 2 / (800 * 0.5), 1e-9); near(p[5], 2 / (600 * 0.5), 1e-9);
    assert.equal(p[15], 1); assert.equal(p[11], 0);
    near(-viewSpace[2] * -p[10], 100 / 500, 1e-6);                  // depth of the plane in [0, 1]
});

test('screen <-> plane mapping, pan and cursor-anchored zoom', () => {
    const { camera } = make();
    assert.deepEqual(camera.screenToPlane(400, 300), { s: 12, y: 30 });
    const back = camera.planeToScreen(...Object.values(camera.screenToPlane(123, 456)));
    near(back.x, 123); near(back.y, 456);

    const anchor = camera.screenToPlane(100, 500);
    camera.zoomAt(0.25, 100, 500);
    near(camera.metersPerPixel, 0.125);
    const after = camera.screenToPlane(100, 500);
    near(after.s, anchor.s); near(after.y, anchor.y);

    const center = { ...camera.center };
    camera.pan(10, 0);
    near(camera.center.s, center.s - 10 * 0.125);
    camera.pan(0, 10);
    near(camera.center.y, center.y + 10 * 0.125);

    camera.zoomAt(1e-9, 0, 0);
    assert.equal(camera.metersPerPixel, camera.minMetersPerPixel);
});

test('fit shows the whole rectangle', () => {
    const { camera } = make();
    camera.fit(-200, 200, -30, 80);
    for (const [s, y] of [[-200, -30], [200, 80]]) {
        const pixel = camera.planeToScreen(s, y);
        assert.ok(pixel.x >= -1e-6 && pixel.x <= 800 + 1e-6 && pixel.y >= -1e-6 && pixel.y <= 600 + 1e-6);
    }
});

test('quarter turns keep the inspected world point, height and zoom at screen centre', () => {
    const { frame, plane, camera } = make();
    const target = frame.localToWorld(plane.x(camera.center.s), camera.center.y, plane.z(camera.center.s));
    const original = { ...camera.center };
    for (let i = 0; i < 4; i++) {
        camera.rotateQuarterTurns(-1);
        camera.update(800, 600);
        const center = frame.localToWorld(plane.x(camera.center.s), camera.center.y, plane.z(camera.center.s));
        near(center.x, target.x); near(center.y, target.y); near(center.z, target.z);
        assert.equal(camera.center.y, original.y);
        assert.equal(camera.metersPerPixel, 0.5);
    }
    near(camera.center.s, original.s);
});

test('animated turns preserve pivot, pass intermediate planes and accumulate requests continuously', () => {
    const { camera, plane } = make();
    const pivot = [plane.x(camera.center.s),plane.z(camera.center.s)], start = plane.angle;
    camera.startTurn(1);
    near(plane.angle,start);
    camera.advanceTurn(0.175);
    near(plane.angle,start+Math.PI/4);
    near(plane.x(camera.center.s),pivot[0]); near(plane.z(camera.center.s),pivot[1]);
    const angle = plane.angle, velocity = camera.turn.currentVelocity;
    camera.startTurn(1);
    near(plane.angle,angle); near(camera.turn.velocity,velocity);
    near(camera.turn.to,start+Math.PI);
    camera.advanceTurn(0.000001);
    near((plane.angle-angle)/0.000001,velocity,0.001);
    camera.finishTurn();
    near(plane.angle,start+Math.PI); assert.equal(camera.turn,null);
    near(camera.center.y,30); near(camera.metersPerPixel,0.5);
    near(plane.x(camera.center.s),pivot[0]); near(plane.z(camera.center.s),pivot[1]);
});
