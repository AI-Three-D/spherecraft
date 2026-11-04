import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { RockModel, ROCK_UNIFORM_FLOATS } from '../RockModel.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

/** 32 m footprint sampled every 8 m; height = base + slope * x. */
function makeSurface(base, slope) {
    const heights = new Float32Array(25);
    for (let iz = 0; iz < 5; iz++) for (let ix = 0; ix < 5; ix++) heights[iz * 5 + ix] = base + slope * (-16 + ix * 8);
    return new CapturedHeightfield({
        frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
        corner: { x: -16, z: -16 }, spacing: 8, countX: 5, countZ: 5, heights,
    });
}
const grey = [0.5, 0.5, 0.5];

test('layers stack by thickness under a flat surface', () => {
    const rock = new RockModel({ layers: [
        { name: 'A', thickness: 2, color: grey }, { name: 'B', thickness: 5, color: grey }, { name: 'C', color: grey },
    ] }, makeSurface(10, 0));
    assert.equal(rock.describe(0, 9, 0).layerName, 'A');
    assert.equal(rock.describe(0, 7.9, 0).layerName, 'B');
    assert.equal(rock.describe(0, 3.1, 0).layerName, 'B');
    assert.equal(rock.describe(0, 2.9, 0).layerName, 'C');
    near(rock.describe(0, 2.9, 0).depth, 7.1);
    assert.equal(rock.describe(0, 2.9, 0).vein, -1);
});

test('follow drapes a layer under the surface, follow 0 keeps it level, dip tilts it', () => {
    const surface = makeSurface(10, 0.5);                             // 2 m at x = -16, 18 m at x = 16
    const rock = new RockModel({ layers: [
        { name: 'A', thickness: 2, follow: 1, color: grey },
        { name: 'B', thickness: 5, follow: 0, dip: [0.1, 0], color: grey },
        { name: 'C', color: grey },
    ] }, surface);
    assert.equal(rock.datum, 2);
    near(rock.layerBottom(0, 8, 0, 14), 12);                          // 2 m under the surface
    near(rock.layerBottom(1, 0, 0, 10), -5);                          // datum - 7
    near(rock.layerBottom(1, 10, 0, 15), -4);                         // + 0.1 * 10
    assert.equal(rock.describe(8, 12.5, 0).layerName, 'A');
    assert.equal(rock.describe(8, 11.5, 0).layerName, 'B');
    assert.equal(rock.describe(10, -4.5, 0).layerName, 'C');
});

test('a layer pinches out instead of crossing the one above', () => {
    const rock = new RockModel({ layers: [
        { name: 'A', thickness: 12, follow: 1, color: grey },         // bottom at -10 (x = -16) .. 6 (x = 16)
        { name: 'B', thickness: 1, follow: 0, color: grey },          // level at datum - 13 = -11
        { name: 'C', color: grey },
    ] }, makeSurface(10, 0.5));
    assert.equal(rock.describe(16, 0, 0).layerName, 'B');
    assert.equal(rock.describe(16, -12, 0).layerName, 'C');
    const shallow = new RockModel({ layers: [
        { name: 'A', thickness: 12, follow: 1, color: grey },
        { name: 'B', thickness: 1, follow: 0, color: grey, seed: 1 },
        { name: 'C', color: grey },
    ], datum: 15 }, makeSurface(10, 0.5));                            // B's bottom (2) lies above A's bottom at x = -16 (-10)
    assert.equal(shallow.describe(-16, -9, 0).layerName, 'A');
    assert.equal(shallow.describe(-16, -10.5, 0).layerName, 'C');
});

test('veins appear only inside their depth range', () => {
    const rock = new RockModel({
        layers: [{ name: 'A', color: grey }],
        veins: [{ name: 'ore', color: [1, 0, 0], frequency: 0.5, threshold: 0.5, depthRange: [3, 6] }],
    }, makeSurface(10, 0));
    let hits = 0, misses = 0;
    for (let n = 0; n < 200; n++) {
        const x = -15 + n * 0.15;
        if (rock.describe(x, 5.5, 0.3).vein === 0) hits++; else misses++;
        assert.equal(rock.describe(x, 8.5, 0.3).vein, -1);           // 1.5 m deep: above the range
        assert.equal(rock.describe(x, 1, 0.3).vein, -1);             // 9 m deep: below it
    }
    assert.ok(hits > 0 && misses > 0, `${hits} vein samples, ${misses} plain`);
    assert.equal(rock.describe(0, 5.5, 0.3).veinName === null || rock.describe(0, 5.5, 0.3).veinName === 'ore', true);
});

test('pack lays the data out for the shader', () => {
    const rock = new RockModel({
        layers: [
            { name: 'A', thickness: 2, color: [0.1, 0.2, 0.3], banding: 0.7, follow: 0.4, dip: [0.05, -0.02], warp: { amplitude: 1.5, wavelength: 50 } },
            { name: 'B', color: [0.6, 0.7, 0.8], accent: [0.9, 0.8, 0.7], mottle: 0.25, mottleScale: 3 },
        ],
        veins: [{ name: 'ore', color: [1, 0.5, 0], frequency: 0.1, stretch: [1, 2, 3], threshold: 0.9, depthRange: [5, 40], fade: 3, seed: 77 }],
    }, makeSurface(10, 0));
    const data = rock.pack();
    assert.equal(data.length, ROCK_UNIFORM_FLOATS);
    assert.deepEqual(Array.from(data.subarray(0, 3)), [2, 1, 10]);
    near(data[4], -16); near(data[5], -16); near(data[6], 1 / 8);
    near(data[8], 0.1); near(data[10], 0.3); near(data[11], 0.7);    // layer 0 colour + banding
    near(data[16], 2); near(data[17], 0.4); near(data[18], 0.05); near(data[19], -0.02);
    near(data[20], 1.5); near(data[21], 1 / 50); near(data[22], 101);
    near(data[24], 0.6); near(data[28], 0.9); near(data[31], 0.25); near(data[32], 0); near(data[39], 3);
    near(data[136], 1); near(data[139], 0.9);                         // vein 0 colour + threshold
    near(data[140], 0.1); near(data[141], 0.2); near(data[142], 0.3); near(data[143], 77);
    near(data[144], 5); near(data[145], 40); near(data[146], 3);
});

test('bad descriptions are rejected', () => {
    const surface = makeSurface(10, 0);
    assert.throws(() => new RockModel({ layers: [] }, surface), /layers/);
    assert.throws(() => new RockModel({ layers: new Array(9).fill({ thickness: 1, color: grey }) }, surface), /layers/);
    assert.throws(() => new RockModel({ layers: [{ color: grey }, { color: grey }] }, surface), /thickness/);
    assert.throws(() => new RockModel({ layers: [{ color: grey }], veins: [{ color: grey, frequency: 1, threshold: 2, depthRange: [0, 1] }] }, surface), /threshold/);
});