import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainFixture } from '../fixtures/terrainFixture.js';
import { createRockDescription, createCarves } from '../fixtures/regionFixture.js';
import { VoxelRegion } from '../../core/voxel/VoxelRegion.js';

const fixture = createTerrainFixture({ seed: 7 });
const region = new VoxelRegion({
    heightfield: fixture.captureHeightfield(),
    rock: createRockDescription(),
    voxelSize: 0.25,
    depth: 100,
    carves: createCarves(),
});
const { volume, rock } = region;
const STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Flood through air from `start`, confined to `box` (frame metres, on the lattice). */
function flood(start, box) {
    const v = volume.voxelSize;
    const toIndex = ([x, y, z]) => [Math.round((x - volume.minX) / v), Math.round((y - volume.minY) / v), Math.round((z - volume.minZ) / v)];
    const lo = toIndex(box.min), hi = toIndex(box.max);
    const nx = hi[0] - lo[0] + 1, ny = hi[1] - lo[1] + 1, nz = hi[2] - lo[2] + 1;
    const seen = new Uint8Array(nx * ny * nz);
    const at = (i, j, k) => ((k - lo[2]) * ny + (j - lo[1])) * nx + (i - lo[0]);
    const first = toIndex(start);
    assert.ok(volume.quantized(...first) < 0, 'flood must start in air');
    seen[at(...first)] = 1;
    const stack = [first];
    let count = 0, touchesBox = false;
    while (stack.length) {
        const [i, j, k] = stack.pop();
        count++;
        if (i === lo[0] || i === hi[0] || j === lo[1] || j === hi[1] || k === lo[2] || k === hi[2]) {
            touchesBox = true;
            continue;
        }
        for (const [di, dj, dk] of STEPS) {
            const a = i + di, b = j + dj, c = k + dk, index = at(a, b, c);
            if (seen[index] || volume.quantized(a, b, c) >= 0) continue;
            seen[index] = 1;
            stack.push([a, b, c]);
        }
    }
    return { count, touchesBox, reached: point => seen[at(...toIndex(point))] === 1 };
}

test('the region is about 256 m across and reaches at least 100 m below the surface', () => {
    assert.equal(volume.maxX - volume.minX, 256);
    assert.equal(volume.maxZ - volume.minZ, 256);
    assert.ok(volume.minY <= region.surface.minHeight - 100);
    assert.ok(volume.maxY > region.surface.maxHeight);
    assert.equal(volume.voxelSize, 0.25);
});

test('only the edits are stored', () => {
    assert.ok(volume.allocatedChunks > 0);
    assert.ok(volume.allocatedChunks < 500, `${volume.allocatedChunks} of ${volume.totalChunks} chunks stored`);
    assert.equal(volume.isSolid(0, -10, 10), true);                   // plain rock between the workings
    assert.equal(volume.isSolid(110, 5, 10), false);                  // air above the valley
});

test('the tunnel opens on the hillside and leads to the upper chamber', () => {
    const air = flood([40, 10.5, 10], { min: [-26, 4, 4], max: [56, 16, 16] });
    assert.ok(air.reached([52, 12.5, 10]), 'tunnel mouth is open to the sky');
    assert.ok(air.reached([-18, 8.5, 10]), 'tunnel reaches the upper chamber');
    assert.ok(air.reached([20.5, 9, 5]), 'side gallery branches off');
});

test('the shaft runs from the surface down to the deep chamber', () => {
    const air = flood([-40, 63, 10], { min: [-46, -30, 2], max: [-22, 66, 18] });
    assert.ok(air.reached([-40, 20, 10]), 'shaft is open half way down');
    assert.ok(air.reached([-34, -24, 10]), 'shaft reaches the deep chamber');
    assert.equal(volume.isSolid(-18, 8.5, 10), false);
    assert.ok(8.5 - -24 > 30, 'chambers are at different depths');
});

test('the cave pocket is closed', () => {
    const air = flood([38, -28, 9], { min: [22, -40, -4], max: [52, -16, 24] });
    assert.equal(air.touchesBox, false);
    assert.ok(air.count > 5000, `pocket holds ${air.count} samples of air`);
});

test('all six layers appear in order with depth, and both veins exist somewhere', () => {
    const seen = [];
    let previous = -1;
    const ground = region.surface.sample(110, 10);
    for (let depth = 0.5; depth < 100; depth += 1) {
        const { layer, layerName } = rock.describe(110, ground - depth, 10);
        assert.ok(layer >= previous, `layer order broken at ${depth} m`);
        if (layer !== previous) seen.push(layerName);
        previous = layer;
    }
    assert.deepEqual(seen, ['topsoil', 'clay', 'sandstone', 'limestone', 'shale', 'granite']);

    const veins = new Set();
    for (let x = -120; x <= 120; x += 1.5) {
        for (let y = -95; y <= 40; y += 1.5) {
            const { vein } = rock.describe(x, y, 10);
            if (vein >= 0) veins.add(rock.veins[vein].name);
        }
    }
    assert.deepEqual([...veins].sort(), ['copper', 'quartz']);
});