// Reproducible CPU-only synthetic field bake. Run: node tools/perf/riverBanks/fieldCpuBench.mjs
// This does not measure GPU sampling, rendering or the main-thread lake pass.
import { createHash } from 'node:crypto';
import { bakeRiverField, riverFieldLayout, RIVER_FIELD } from '../../../core/world/water/riverField.js';

const radius = 131000, layout = riverFieldLayout(radius), stride = 20, count = 201;
const at = (x, y) => { const length = Math.hypot(1, y / radius, x / radius); return [-1 / length, y / radius / length, x / radius / length]; };
const points = new Float32Array(count * stride);
for (let i = 0; i < count; i++) {
    const x = -2000 + 20 * i, level = 100 - 0.002 * x;
    points.set([...at(x, 0), level, 8, 1.5, 1, 1, level, 0, 0, 0, 0, level, -1e4, -1e4, level, 1.5, -1e20, 0], i * stride);
}
const river = { rec: { points, stride, mouths: [] }, arc: Float64Array.from({ length: count }, (_, i) => 20 * i), rid: 7,
    levels: Float64Array.from({ length: count }, (_, i) => points[i * stride + 16]) };
const sampleNatural = async dirs => {
    const heights = new Float32Array(dirs.length / 4);
    for (let i = 0; i < heights.length; i++) {
        const k = -dirs[i * 4], x = dirs[i * 4 + 2] / k * radius, y = dirs[i * 4 + 1] / k * radius;
        heights[i] = 100 - 0.002 * x + 0.05 * Math.abs(y) + 0.5;
    }
    return heights;
};
for (const lake of [false, true]) {
    const times = [];
    let result;
    for (let run = 0; run < 4; run++) {
        result = await bakeRiverField({ rivers: [{ ...river, ...(lake ? { destLevel: 99 } : {}) }], L: layout, sampleNatural,
            lakeAt: d => lake && d[2] / -d[0] * radius > 1600 ? { level: 99, inside: 20 } : null, o: RIVER_FIELD });
        if (run) times.push(result.stats.ms);
    }
    const hash = createHash('sha256');
    for (const [key, page] of result.pages) { hash.update(String(key)); hash.update(new Uint8Array(page.buffer, page.byteOffset, page.byteLength)); }
    hash.update(new Uint8Array(result.flow.buffer));
    hash.update(new Uint8Array(result.rocks.buffer));
    console.log(JSON.stringify({ lake, pages: result.pages.size, drySdfPages: result.stats.drySdfPages,
        emptyBlurPages: result.stats.emptyBlurPages, times, digest: hash.digest('hex') }));
}
