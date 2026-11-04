import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelRegion } from '../VoxelRegion.js';
import { CutPlane } from '../CutPlane.js';
import { AnthillCamera } from '../AnthillCamera.js';
import { AnthillViewModule } from '../AnthillViewModule.js';
import { ROCK_UNIFORM_FLOATS } from '../RockModel.js';
import { fakeDevice } from './fakeDevice.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function makeScene() {
    const countX = 33, countZ = 33;
    const heights = new Float32Array(countX * countZ);
    for (let i = 0; i < heights.length; i++) heights[i] = 4 + 0.125 * (i % countX);          // 4 .. 8 m
    const region = new VoxelRegion({
        heightfield: {
            frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
            corner: { x: -16, z: -16 }, spacing: 1, countX, countZ, heights,
        },
        rock: { layers: [{ name: 'soil', thickness: 2, color: [0.4, 0.3, 0.2] }, { name: 'stone', color: [0.5, 0.5, 0.5] }] },
        depth: 8,
    });
    const calls = [];
    const queryHeights = positions => new Promise(resolve => {
        const count = positions.length / 2;
        calls.push(() => resolve(new Float32Array(count).fill(1)));
    });
    const plane = new CutPlane({ angle: 0, offset: 0 });
    const camera = new AnthillCamera({ frame: region.frame, plane, metersPerPixel: 0.25 });
    camera.update(800, 600);
    const log = { draws: [], updated: [], deleted: [] };
    const backend = {
        device: fakeDevice(),
        draw: (geometry, material) => log.draws.push([geometry, material]),
        updateTexture: texture => log.updated.push(texture),
        deleteTexture: texture => log.deleted.push(texture),
        destroyMaterial() {},
    };
    const module = new AnthillViewModule({ region, plane, queryHeights });
    return { region, plane, module, camera, backend, log, calls, frame: { camera, backend, viewport: { width: 800, height: 600 } } };
}

test('volume box follows the captured heights', () => {
    const { region } = makeScene();
    assert.deepEqual([region.volume.minY, region.volume.maxY], [-8, 16]);
    assert.equal(region.frame, region.surface.frame);
});

test('draws the cut face, then the ground line, once each per frame', async () => {
    const { module, backend, log, calls, frame } = makeScene();
    module.initialize({ backend });
    assert.equal(module.update(frame), undefined);
    module.render(frame);
    module.renderTransparent(frame);
    assert.equal(log.draws.length, 2);
    assert.deepEqual(log.draws[0], [module.faceGeometry, module.faceMaterial]);
    assert.deepEqual(log.draws[1], [module.lineGeometry, module.lineMaterial]);

    // Cut face: one quad, attributes for locations 0-2, uniforms matching the shader structs.
    const face = module.faceGeometry;
    assert.equal(face.getAttribute('position').count, 4);
    assert.equal(face.getAttribute('normal').count, 4);
    assert.equal(face.getAttribute('uv').count, 4);
    assert.deepEqual(Array.from(face.getAttribute('uv').data), [-16, -8, 16, -8, 16, 16, -16, 16]);
    assert.ok(face.index.data instanceof Uint32Array);
    assert.equal(module.faceData.length, 28);
    assert.equal(module.rockData.length, ROCK_UNIFORM_FLOATS);
    assert.ok(Math.abs(module.faceData[16] - 0.25) < 1e-6);
    assert.deepEqual(Array.from(module.faceData.subarray(20, 28)), [-16, -8, 0.5, 0, 65, 49, 2, 0.25]);   // level 1 at 0.25 m/px
    const texture = module.faceMaterial.uniforms.cut.value;
    assert.deepEqual([texture.width, texture.height, texture.format], [65, 49, 'r8']);
    assert.equal(texture.data, module.cut.data);
    assert.deepEqual([module.heightTexture.width, module.heightTexture.height, module.heightTexture.format], [33, 33, 'r32f']);

    // Ground line ribbons: locations 0-3.
    const lines = module.lineGeometry;
    const vertices = lines.getAttribute('position').count;
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 4]]) {
        assert.equal(lines.getAttribute(name).itemSize, size);
        assert.equal(lines.getAttribute(name).count, vertices);
    }
    for (const index of lines.index.data) assert.ok(index < vertices);
    const capturedOnly = lines.index.count;
    calls[0]();
    await tick();
    module.update(frame);
    assert.ok(module.lineGeometry.index.count > capturedOnly);
    module.dispose();
});

test('edits re-upload the cut texture; moving the plane replaces it', () => {
    const { region, plane, module, backend, log, frame } = makeScene();
    module.initialize({ backend });
    module.update(frame);
    const texture = module.faceMaterial.uniforms.cut.value;
    module.update(frame);
    assert.equal(log.updated.length, 0);                              // nothing changed, nothing uploaded

    assert.ok(region.apply({ shape: { type: 'sphere', center: [0, 2, 0], radius: 1 } }));
    module.update(frame);
    assert.deepEqual(log.updated, [texture]);

    plane.set(0, 3);
    module.update(frame);
    assert.deepEqual(log.deleted, [texture]);
    assert.notEqual(module.faceMaterial.uniforms.cut.value, texture);

    plane.set(0, 40);                                                 // off the region: no face drawn
    module.update(frame);
    module.render(frame);
    assert.equal(log.draws.length, 0);
});

test('a perspective camera is refused', () => {
    const { module, backend, frame, camera } = makeScene();
    module.initialize({ backend });
    camera.projectionMatrix.elements[15] = 0;
    camera.projectionMatrix.elements[11] = -1;
    assert.throws(() => module.update(frame), /orthographic/);
});

test('edits behind the cut update the 3D GPU field without changing the cut-face texture', () => {
    const { region, module, backend, frame } = makeScene();
    module.initialize({ backend });
    module.update(frame);
    const cutRevision = module.cut.revision;
    const oldWrites = backend.device.writes.length;
    assert.ok(region.apply({ shape: { type: 'sphere', center: [0, 0, -5], radius: 1 } }));
    module.update(frame);
    assert.equal(module.cut.revision, cutRevision);
    assert.equal(module.volumeGPU.revision, region.volume.revision);
    assert.ok(backend.device.writes.length > oldWrites);
    assert.equal(module.faceMaterial.storageBuffers.densities, module.volumeGPU.density);
    assert.deepEqual(Array.from(module.volumeData.subarray(12)), [0, 0, 1, 24]);
    module.dispose();
    assert.ok(backend.device.buffers.every(buffer => buffer.destroyed));
});
