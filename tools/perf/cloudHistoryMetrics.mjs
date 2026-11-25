import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PNG } from 'pngjs';

const [directory, ...names] = process.argv.slice(2);
if (!directory || !names.length) {
    throw new Error('Usage: node tools/perf/cloudHistoryMetrics.mjs CAPTURE_DIRECTORY CASE ...');
}

const timings = JSON.parse(fs.readFileSync(path.join(directory, 'timings.json')));
const minDepthKm = Number(process.env.CLOUD_METRIC_MIN_DEPTH_KM ?? 0);
const maxDepthKm = Number(process.env.CLOUD_METRIC_MAX_DEPTH_KM ?? Infinity);
const compareDisplay = process.env.CLOUD_METRIC_DISPLAY === '1';
const heatmap = process.env.CLOUD_METRIC_HEATMAP === '1';
if (!(minDepthKm >= 0 && maxDepthKm > minDepthKm)) throw new Error('Invalid cloud motion depth range');
const inDepthRange = depth => depth > 0 && depth >= minDepthKm && depth <= maxDepthKm;
const half = Array.from({ length: 65536 }, (_, bits) => {
    const exponent = (bits >> 10) & 31;
    const mantissa = bits & 1023;
    if (exponent === 31) return mantissa ? NaN : bits & 32768 ? -Infinity : Infinity;
    const magnitude = exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24;
    return bits & 32768 ? -magnitude : magnitude;
});

function readFrame(folder, i) {
    const base = path.join(folder, String(i).padStart(3, '0'));
    const rgb = fs.readFileSync(base + '.rgba16');
    const depth = fs.readFileSync(base + '.r32');
    return {
        rgba: new Uint16Array(rgb.buffer, rgb.byteOffset, rgb.length / 2),
        sky: new Float32Array(depth.buffer, depth.byteOffset, depth.length / 4),
    };
}

function histogram(scale = 255, binCount = 8193) {
    // Measure error in units of 1/255, with sub-unit resolution.
    const bins = new Uint32Array(binCount);
    let count = 0;
    let sum = 0;
    let max = 0;
    return {
        add(value) {
            if (!Number.isFinite(value)) throw new Error('Non-finite value in resolved clouds');
            const magnitude = Math.abs(value) * scale;
            bins[Math.min(bins.length - 1, Math.round(magnitude * 16))]++;
            sum += magnitude;
            max = Math.max(max, magnitude);
            count++;
        },
        summary() {
            if (!count) return { count, mean: null, p99: null, p999: null, max: null };
            const percentile = p => {
                let cumulative = 0;
                return bins.findIndex(n => (cumulative += n) >= count * p) / 16;
            };
            return { count, mean: sum / count, p99: percentile(0.99), p999: percentile(0.999), max };
        },
    };
}

function opacityEdge(frame, pixel, width) {
    const { rgba, sky } = frame;
    const value = half[rgba[pixel * 4 + 3]];
    const edge = neighbor => sky[neighbor] > 0 && Math.abs(value - half[rgba[neighbor * 4 + 3]]) >= 0.08;
    return edge(pixel - 1) || edge(pixel + 1) || edge(pixel - width) || edge(pixel + width);
}

function reprojectCloud(prior, here, camera, previous, width, height, pixel, depth) {
    if (!camera || !previous || depth >= 5e5) return;
    const { proj, right, up, back, pos } = camera;
    const ix = pixel % width;
    const iy = Math.floor(pixel / width);
    const x = ((ix + 0.5) * 2 / width - 1 + proj[2]) / proj[0];
    const y = (1 - (iy + 0.5) * 2 / height + proj[3]) / proj[1];
    const dx = right[0] * x + up[0] * y - back[0];
    const dy = right[1] * x + up[1] * y - back[1];
    const dz = right[2] * x + up[2] * y - back[2];
    const scale = depth / Math.hypot(dx, dy, dz);
    const vx = pos[0] - previous.pos[0] + dx * scale;
    const vy = pos[1] - previous.pos[1] + dy * scale;
    const vz = pos[2] - previous.pos[2] + dz * scale;
    const project = axis => axis[0] * vx + axis[1] * vy + axis[2] * vz;
    const eye = -project(previous.back);
    if (eye <= 0) return;
    const px = ((previous.proj[0] * project(previous.right) / eye - previous.proj[2]) + 1) * width * 0.5 - 0.5;
    const py = (1 - (previous.proj[1] * project(previous.up) / eye - previous.proj[3])) * height * 0.5 - 0.5;
    const floorX = Math.floor(px);
    const floorY = Math.floor(py);
    if (floorX < 0 || floorX >= width - 1 || floorY < 0 || floorY >= height - 1) return;
    const offset = floorY * width + floorX;
    if (prior.sky[offset] <= 0 || prior.sky[offset + 1] <= 0 || prior.sky[offset + width] <= 0 || prior.sky[offset + width + 1] <= 0) return;
    const fx = px - floorX;
    const fy = py - floorY;
    const residual = channel => {
        const sample = p => half[prior.rgba[p * 4 + channel]];
        const upper = sample(offset) * (1 - fx) + sample(offset + 1) * fx;
        const lower = sample(offset + width) * (1 - fx) + sample(offset + width + 1) * fx;
        return half[here.rgba[pixel * 4 + channel]] - (upper * (1 - fy) + lower * fy);
    };
    return { opacity: residual(3), radiance: Math.max(Math.abs(residual(0)), Math.abs(residual(1)), Math.abs(residual(2))) };
}

function analyse(name) {
    const dirs = ['before', 'after'].map(side => path.join(directory, name, side));
    const poses = dirs.map(dir => JSON.parse(fs.readFileSync(path.join(dir, 'poses.json'))));
    const [width, height] = timings.cases[name].before[0].conditions.cloudSize;
    if (poses[0].length !== poses[1].length ||
        timings.cases[name].after[0].conditions.cloudSize.some((size, axis) => size !== [width, height][axis])) {
        throw new Error(`Capture dimensions or frame counts differ for ${name}`);
    }
    const rgbaError = histogram();
    const opacityError = histogram();
    const displayError = histogram(1);
    const displayMotionError = histogram(1);
    const radianceMotionError = histogram();
    const opacityMotionError = histogram();
    const edgeOpacityMotionError = histogram();
    const edgeOpacityChange = [histogram(), histogram()];
    const edgeReprojection = [histogram(), histogram()];
    const edgeRadianceReprojection = [histogram(), histogram()];
    const worstReprojection = [null, null];
    const edgeHeat = heatmap ? new Float32Array(width * height) : null;
    const visibleDepthErrorMeters = histogram(1000, 1_600_001);
    const peakMotion = { radiance: { p99: 0, frame: null }, opacity: { p99: 0, frame: null } };
    const edgeEnergy = [0, 0];
    let changedDepths = 0;
    let changedFiniteDepths = 0;
    let maxDepthShiftMeters = 0;
    let last;
    let lastDisplay;
    for (let i = 0; i < poses[0].length; i++) {
        if (JSON.stringify(poses[0][i].view) !== JSON.stringify(poses[1][i].view) ||
            JSON.stringify(poses[0][i].projection) !== JSON.stringify(poses[1][i].projection)) {
            throw new Error(`View mismatch at ${name} frame ${i}`);
        }
        const frames = dirs.map(dir => readFrame(dir, i));
        const [before, after] = frames;
        const display = compareDisplay ? dirs.map(dir =>
            PNG.sync.read(fs.readFileSync(path.join(dir, String(i).padStart(3, '0') + '.png')))) : null;
        if (display && (display[0].width !== display[1].width || display[0].height !== display[1].height)) {
            throw new Error(`Display dimensions differ for ${name} frame ${i}`);
        }
        const frameRadiance = histogram();
        const frameOpacity = histogram();
        for (let p = 0; p < width * height; p++) {
            if (!frames.every(frame => inDepthRange(frame.sky[p]))) continue;
            const deltaDepth = Math.abs(before.sky[p] - after.sky[p]);
            if (deltaDepth > 0) {
                changedDepths++;
                // The no-hit sentinel is not a physical cloud distance.
                if (before.sky[p] < 5e5 && after.sky[p] < 5e5) {
                    changedFiniteDepths++;
                    maxDepthShiftMeters = Math.max(maxDepthShiftMeters, deltaDepth * 1000);
                }
            }
            const offset = 4 * p;
            let maxError = 0;
            for (let channel = 0; channel < 4; channel++) {
                maxError = Math.max(maxError, Math.abs(half[before.rgba[offset + channel]] - half[after.rgba[offset + channel]]));
            }
            rgbaError.add(maxError);
            const alpha = offset + 3;
            opacityError.add(half[before.rgba[alpha]] - half[after.rgba[alpha]]);
            if (display) {
                const x = p % width;
                const y = Math.floor(p / width);
                // Take a display sample at each cloud-pixel centre away from terrain edges.
                const sky = x > 0 && x < width - 1 && y > 0 && y < height - 1 &&
                    frames.every(frame => frame.sky[p - 1] > 0 && frame.sky[p + 1] > 0 &&
                        frame.sky[p - width] > 0 && frame.sky[p + width] > 0);
                if (sky) {
                    const [a, b] = display;
                    const sx = Math.floor((x + 0.5) * a.width / width);
                    const sy = Math.floor((y + 0.5) * a.height / height);
                    const pixel = 4 * (sy * a.width + sx);
                    displayError.add(Math.max(
                        Math.abs(a.data[pixel] - b.data[pixel]),
                        Math.abs(a.data[pixel + 1] - b.data[pixel + 1]),
                        Math.abs(a.data[pixel + 2] - b.data[pixel + 2]),
                    ));
                    if (lastDisplay && last.every(frame => inDepthRange(frame.sky[p]))) {
                        const [priorA, priorB] = lastDisplay;
                        let difference = 0;
                        for (let c = pixel; c < pixel + 3; c++) {
                            const changeA = a.data[c] - priorA.data[c];
                            const changeB = b.data[c] - priorB.data[c];
                            difference = Math.max(difference, Math.abs(changeA - changeB));
                        }
                        displayMotionError.add(difference);
                    }
                }
            }
            if (before.sky[p] < 5e5 && after.sky[p] < 5e5 && Math.max(half[before.rgba[alpha]], half[after.rgba[alpha]]) < 0.95) {
                visibleDepthErrorMeters.add(deltaDepth);
            }
            if (last && last.every(frame => inDepthRange(frame.sky[p]))) {
                let rgbError = 0;
                for (let channel = 0; channel < 3; channel++) {
                    const q = offset + channel;
                    const beforeDelta = half[before.rgba[q]] - half[last[0].rgba[q]];
                    const afterDelta = half[after.rgba[q]] - half[last[1].rgba[q]];
                    rgbError = Math.max(rgbError, Math.abs(afterDelta - beforeDelta));
                }
                radianceMotionError.add(rgbError);
                frameRadiance.add(rgbError);
                const beforeChange = half[before.rgba[alpha]] - half[last[0].rgba[alpha]];
                const afterChange = half[after.rgba[alpha]] - half[last[1].rgba[alpha]];
                const opacityError = afterChange - beforeChange;
                opacityMotionError.add(opacityError);
                frameOpacity.add(opacityError);
                const x = p % width;
                if (x > 0 && x < width - 1 && p >= width && p < width * (height - 1) &&
                    (opacityEdge(before, p, width) || opacityEdge(after, p, width) ||
                        opacityEdge(last[0], p, width) || opacityEdge(last[1], p, width))) {
                    edgeOpacityMotionError.add(opacityError);
                    edgeOpacityChange[0].add(beforeChange);
                    edgeOpacityChange[1].add(afterChange);
                    for (let side = 0; side < 2; side++) {
                        const error = reprojectCloud(last[side], frames[side], poses[side][i].cloudCamera,
                            poses[side][i - 1].cloudCamera, width, height, p, frames[side].sky[p]);
                        if (error) {
                            edgeReprojection[side].add(error.opacity);
                            edgeRadianceReprojection[side].add(error.radiance);
                            const magnitude = Math.abs(error.opacity) * 255;
                            if (magnitude > (worstReprojection[side]?.magnitude ?? -1)) {
                                worstReprojection[side] = { frame: i, x, y: Math.floor(p / width),
                                    depthKm: frames[side].sky[p], magnitude };
                            }
                        }
                    }
                    if (edgeHeat) edgeHeat[p] = Math.max(edgeHeat[p], Math.abs(opacityError));
                }
            }
            if (p % width < width - 1 && frames.every(frame => inDepthRange(frame.sky[p + 1]))) {
                for (const [j, { rgba }] of frames.entries()) edgeEnergy[j] += Math.abs(half[rgba[alpha]] - half[rgba[alpha + 4]]);
            }
        }
        if (last) {
            for (const [kind, errors] of [['radiance', frameRadiance], ['opacity', frameOpacity]]) {
                const { p99 } = errors.summary();
                if (p99 > peakMotion[kind].p99) peakMotion[kind] = { p99, frame: i };
            }
        }
        last = frames;
        lastDisplay = display;
    }
    if (edgeHeat) {
        const image = new PNG({ width, height });
        for (let p = 0; p < edgeHeat.length; p++) {
            const magnitude = edgeHeat[p] * 255;
            image.data[p * 4] = Math.min(255, magnitude * 4);
            image.data[p * 4 + 1] = Math.min(255, Math.max(0, magnitude - 24) * 3);
            image.data[p * 4 + 3] = 255;
        }
        fs.writeFileSync(path.join(directory, name, 'opacity-edge-motion.png'), PNG.sync.write(image));
    }
    return {
        frames: poses[0].length,
        reuseFrames: poses[1].filter(p => p.historyValid).length,
        rgbaError: rgbaError.summary(),
        opacityError: opacityError.summary(),
        displayError: compareDisplay ? displayError.summary() : undefined,
        displayMotionError: compareDisplay ? displayMotionError.summary() : undefined,
        radianceMotionError: radianceMotionError.summary(),
        opacityMotionError: opacityMotionError.summary(),
        edgeOpacityMotionError: edgeOpacityMotionError.summary(),
        edgeOpacityChange: { before: edgeOpacityChange[0].summary(), after: edgeOpacityChange[1].summary() },
        edgeReprojection: { before: edgeReprojection[0].summary(), after: edgeReprojection[1].summary() },
        worstReprojection: { before: worstReprojection[0], after: worstReprojection[1] },
        edgeRadianceReprojection: { before: edgeRadianceReprojection[0].summary(), after: edgeRadianceReprojection[1].summary() },
        peakFrameMotionError: peakMotion,
        changedDepths,
        changedFiniteDepths,
        maxDepthShiftMeters,
        visibleDepthErrorMeters: visibleDepthErrorMeters.summary(),
        horizontalOpacityEdgeEnergyRatio: edgeEnergy[1] / edgeEnergy[0],
    };
}

console.log(JSON.stringify(Object.fromEntries(names.map(name => [name, analyse(name)])), null, 2));
