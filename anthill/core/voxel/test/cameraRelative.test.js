import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from '../../../shared/math/index.js';
import { RegionFrame } from '../RegionFrame.js';
import { CutPlane } from '../CutPlane.js';
import { AnthillCamera } from '../AnthillCamera.js';
import { composeClipFromLocal } from '../cameraRelative.js';

/** What the vertex shader does: float32 position times float32 matrix, rounding every operation. */
function shaderClip(m, x, y, z) {
    const f = Math.fround;
    x = f(x); y = f(y); z = f(z);
    return [0, 1].map(row => f(f(f(m[row] * x) + f(m[4 + row] * y)) + f(f(m[8 + row] * z) + m[12 + row])));
}

test('camera-relative rendering stays sub-pixel at 131 km; float32 world positions do not', () => {
    const frame = new RegionFrame({ origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: Math.cos(0.6), y: 0, z: Math.sin(0.6) } });
    const plane = new CutPlane({ angle: 0, offset: 10 });
    const width = 1920, height = 1080, metersPerPixel = 0.002;      // 500 px per metre, at the region edge
    const camera = new AnthillCamera({ frame, plane, center: { s: 128, y: 0.4 }, metersPerPixel });
    camera.update(width, height);
    const clip = composeClipFromLocal(frame, camera, new Matrix4()).elements;

    const right = frame.directionToWorld(plane.dirX, 0, plane.dirZ), up = frame.axisY;
    const exactClip = world => {
        const dx = world.x - camera.position.x, dy = world.y - camera.position.y, dz = world.z - camera.position.z;
        return [
            (dx * right.x + dy * right.y + dz * right.z) * 2 / (width * metersPerPixel),
            (dx * up.x + dy * up.y + dz * up.z) * 2 / (height * metersPerPixel),
        ];
    };
    const pixels = (a, b) => Math.hypot((a[0] - b[0]) * width / 2, (a[1] - b[1]) * height / 2);

    const centre = exactClip(frame.localToWorld(plane.x(128), 0.4, plane.z(128)));
    assert.ok(Math.hypot(...centre) < 1e-6, 'reference maps the view centre to the clip origin');

    let worst = 0, worstNaive = 0;
    for (let j = 0; j < 60; j++) {
        const s = 126.6 + j * 0.047, y = -0.35 + j * 0.0237;
        const local = { x: plane.x(s), y, z: plane.z(s) };
        const world = frame.localToWorld(local.x, local.y, local.z);
        const exact = exactClip(world);
        worst = Math.max(worst, pixels(shaderClip(clip, local.x, local.y, local.z), exact));
        // Negative control: merely storing the world position as float32, all later math exact.
        const rounded = { x: Math.fround(world.x), y: Math.fround(world.y), z: Math.fround(world.z) };
        worstNaive = Math.max(worstNaive, pixels(exactClip(rounded), exact));
    }
    assert.ok(worst < 0.25, `camera-relative error ${worst} px`);
    assert.ok(worstNaive > 1, `float32 world positions should visibly fail here, got ${worstNaive} px`);
});