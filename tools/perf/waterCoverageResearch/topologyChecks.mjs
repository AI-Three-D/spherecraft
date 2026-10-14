// Correctness counterexamples for a camera-centred raster flood-fill.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function flood(mask, width, seed, diagonal = false) {
    const height = mask.length / width, seen = new Uint8Array(mask.length), queue = new Uint32Array(mask.length);
    if (!mask[seed]) return seen;
    let head = 0, tail = 1; queue[0] = seed; seen[seed] = 1;
    while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        for (const [dx, dy] of diagonal ? [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1]]) {
            const a = x + dx, b = y + dy, k = b * width + a;
            if (a < 0 || b < 0 || a >= width || b >= height || seen[k] || !mask[k]) continue;
            seen[k] = 1; queue[tail++] = k;
        }
    }
    return seen;
}

export function correctnessChecks() {
    // A U-shaped connected lake: the connecting section is outside the camera window.
    const W = 12, H = 12, u = new Uint32Array(W * H);
    for (let y = 1; y <= 10; y++) { u[y * W + 2] = 1; u[y * W + 9] = 1; }
    for (let x = 2; x <= 9; x++) u[10 * W + x] = 1;
    const global = flood(u, W, W + 2);
    const cropped = u.slice(0, W * 8), local = flood(cropped, W, W + 2);
    assert.equal(global[4 * W + 9], 1); assert.equal(local[4 * W + 9], 0);

    // Standard production grid diagonal is v10--v01. Identical height texels
    // do not give identical bilinear and drawn-triangle surfaces.
    const corners = { h00: 2, h10: 0, h01: 0, h11: 2 }, level = 0.75;
    const bilinearCentre = Object.values(corners).reduce((a,b) => a+b, 0) / 4;
    const triangleCentre = (corners.h10 + corners.h01) / 2;
    assert(bilinearCentre > level && triangleCentre < level);
    const raster = Uint32Array.of(0, 1, 1, 0);
    assert.equal(flood(raster, 2, 1)[2], 0); // 4-neighbour fill misses the wet diagonal.
    // Reverse the saddle: 8-neighbour fill connects two wet corners through dry diagonal.
    const reverse = Uint32Array.of(1, 0, 0, 1);
    assert.equal(flood(reverse, 2, 0, true)[3], 1);

    // An actual piecewise-linear ridge with vertices at x=0,1,2 has a dry
    // crest narrower than 10 cm at level 1. Offset 1 m samples miss that sill.
    const ridgeHeight = x => 1.05 * Math.max(0, 1 - Math.abs(x - 1));
    const samples = [0.5, 1.5, 2.5].map(ridgeHeight);
    assert(samples.every(h => h < 1));

    return {
        outsideWindowConnection: { globalConnected: true, localConnected: false, conclusion: 'local seeds alone cannot preserve global connectivity' },
        heightTextureVsTriangles: { corners, level, bilinearCentre, triangleCentre, heightDifferenceM: bilinearCentre-triangleCentre },
        saddleConnectivity: { fourNeighboursMissWetDrawDiagonal: true, eightNeighboursJoinAcrossDryDrawDiagonal: true },
        subMetreBarrier: { sampledHeights: samples, drawnRidgePeakM: 1.05, waterLevelM: 1, barrierWidthM: 2*(1-1/1.05), conclusion: 'offset 1 m raster samples miss a dry sill present in piecewise-linear drawn terrain' },
    };
}

if (process.argv[1]?.endsWith('topologyChecks.mjs')) {
    const result = correctnessChecks(); console.log(JSON.stringify(result, null, 2));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
}
