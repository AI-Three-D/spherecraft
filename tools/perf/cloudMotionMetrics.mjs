import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [capture, ...cases] = process.argv.slice(2);
if (!capture || !cases.length) {
    throw new Error('Usage: node tools/perf/cloudMotionMetrics.mjs CAPTURE_DIRECTORY ROTATION_CASE ...');
}

const load = (directory, frame) =>
    PNG.sync.read(fs.readFileSync(path.join(directory, `${String(frame).padStart(3, '0')}.png`)));

function rotation(view) {
    return Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 3 }, (_, col) => view[col * 4 + row]));
}

function compare(directory) {
    const poses = JSON.parse(fs.readFileSync(path.join(directory, 'poses.json')));
    const count = new Uint32Array(256);
    let previous = load(directory, 0);
    let pixels = 0;
    let sum = 0;
    let over4 = 0;
    for (let frame = 1; frame < poses.length; frame++) {
        const current = load(directory, frame);
        const { width, height, data } = current;
        const prior = poses[frame - 1];
        const pose = poses[frame];
        const before = rotation(prior.view);
        const after = rotation(pose.view);
        const transform = before.map(row => after.map(axis => row.reduce((dot, value, i) => dot + value * axis[i], 0)));
        const cameraDelta = before.map((_, axis) =>
            before.reduce((s, row, i) => s - row[axis] * prior.view[12 + i] + after[i][axis] * pose.view[12 + i], 0));
        if (Math.hypot(...cameraDelta) > 0.025) throw new Error(`Expected a stationary camera position in ${directory}`);
        const [a, b, c] = transform;
        const p = prior.projection;
        const q = pose.projection;
        for (let y = Math.floor(height * 0.05); y < height * 0.8; y++) {
            const v = (1 - (y + 0.5) * 2 / height + q[9]) / q[5];
            for (let x = Math.floor(width * 0.05); x < width * 0.95; x++) {
                const u = ((x + 0.5) * 2 / width - 1 + q[8]) / q[0];
                const depth = -(c[0] * u + c[1] * v - c[2]);
                if (depth <= 0) continue;
                const nx = p[0] * (a[0] * u + a[1] * v - a[2]) / depth - p[8];
                const ny = p[5] * (b[0] * u + b[1] * v - b[2]) / depth - p[9];
                const px = (nx + 1) * 0.5 * width - 0.5;
                const py = (1 - ny) * 0.5 * height - 0.5;
                const ix = Math.floor(px);
                const iy = Math.floor(py);
                if (ix < 0 || iy < 0 || ix >= width - 1 || iy >= height - 1) continue;
                const fx = px - ix;
                const fy = py - iy;
                const src = (iy * width + ix) * 4;
                const dst = (y * width + x) * 4;
                const bottom = src + width * 4;
                let error = 0;
                for (let channel = 0; channel < 3; channel++) {
                    const s = previous.data;
                    const top = s[src + channel] * (1 - fx) + s[src + channel + 4] * fx;
                    const low = s[bottom + channel] * (1 - fx) + s[bottom + channel + 4] * fx;
                    error = Math.max(error, Math.abs(data[dst + channel] - top * (1 - fy) - low * fy));
                }
                pixels++;
                sum += error;
                if (error > 4) over4++;
                count[Math.round(error)]++;
            }
        }
        previous = current;
    }
    const percentile = fraction => {
        let cumulative = 0;
        return count.findIndex(n => (cumulative += n) >= pixels * fraction);
    };
    return { frames: poses.length, pixels, meanMaxRgb: sum / pixels, p95: percentile(0.95),
        p99: percentile(0.99), fractionOver4: over4 / pixels };
}

const result = {};
for (const name of cases) {
    result[name] = Object.fromEntries(['before', 'after'].map(side => [side, compare(path.join(capture, name, side))]));
}
console.log(JSON.stringify(result, null, 2));
