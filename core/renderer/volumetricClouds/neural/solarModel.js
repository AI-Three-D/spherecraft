import { DenseNetwork, seededRandom } from './DenseNetwork.js';

export const SOLAR_FEATURES = 8;
export const SOLAR_SIZES = Object.freeze([SOLAR_FEATURES, 16, 16, 1]);
export const SOLAR_ROW = 12;
export const SOLAR_WEIGHTS = new DenseNetwork(SOLAR_SIZES).weights.length;
export const SOLAR_TARGET_SCALE = 8;
export const SOLAR_MODEL_FORMAT = 'spherecraft-solar-optical-depth-v2';
export const SOLAR_PACKED_ROWS = SOLAR_SIZES.slice(0, -1).map(inputs => Math.ceil((inputs + 1) / 4));
export const SOLAR_PACKED_VEC4S = SOLAR_FEATURES / 2 +
    SOLAR_PACKED_ROWS.reduce((sum, rows, layer) => sum + rows * SOLAR_SIZES[layer + 1], 0);

export function solarModelFromJSON(artifact) {
    const validVector = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);
    if (artifact?.format !== SOLAR_MODEL_FORMAT ||
        !validVector(artifact.mean, SOLAR_FEATURES) ||
        !validVector(artifact.scale, SOLAR_FEATURES) || artifact.scale.some(v => v <= 0) ||
        !validVector(artifact.weights, SOLAR_WEIGHTS)) {
        throw new Error('Invalid solar network artifact');
    }
    return { format: SOLAR_MODEL_FORMAT, mean: [...artifact.mean], scale: [...artifact.scale], weights: [...artifact.weights] };
}

export function packSolarModel(artifact) {
    const model = solarModelFromJSON(artifact);
    const buffer = new Float32Array(4 * SOLAR_PACKED_VEC4S);
    buffer.set(model.mean);
    buffer.set(model.scale, SOLAR_FEATURES);
    let source = 0;
    let destination = 2 * SOLAR_FEATURES;
    for (let layer = 0; layer < SOLAR_PACKED_ROWS.length; layer++) {
        const width = SOLAR_SIZES[layer] + 1;
        for (let neuron = 0; neuron < SOLAR_SIZES[layer + 1]; neuron++) {
            buffer.set(model.weights.slice(source, source + width), destination);
            source += width;
            destination += 4 * SOLAR_PACKED_ROWS[layer];
        }
    }
    if (!buffer.every(Number.isFinite)) throw new Error('Solar model values exceed f32 range');
    return buffer;
}

export function fitSolarNormalization(rows) {
    const count = rows.length / SOLAR_ROW;
    const mean = new Float64Array(SOLAR_FEATURES);
    const square = new Float64Array(SOLAR_FEATURES);
    for (let offset = 0; offset < rows.length; offset += SOLAR_ROW) {
        for (let i = 0; i < SOLAR_FEATURES; i++) {
            const x = rows[offset + i];
            mean[i] += x;
            square[i] += x * x;
        }
    }
    const scale = new Float64Array(SOLAR_FEATURES);
    for (let i = 0; i < SOLAR_FEATURES; i++) {
        mean[i] /= count;
        scale[i] = 1 / Math.sqrt(Math.max(1e-5, square[i] / count - mean[i] * mean[i]));
    }
    return { mean, scale };
}

export function solarTrainingArrays(rows, { mean, scale }) {
    const count = rows.length / SOLAR_ROW;
    const inputs = new Float32Array(count * SOLAR_FEATURES);
    const targets = new Float32Array(count);
    const weights = new Float32Array(count);
    for (let n = 0; n < count; n++) {
        for (let i = 0; i < SOLAR_FEATURES; i++) {
            inputs[n * SOLAR_FEATURES + i] = (rows[n * SOLAR_ROW + i] - mean[i]) * scale[i];
        }
        targets[n] = Math.log1p(SOLAR_TARGET_SCALE * rows[n * SOLAR_ROW + SOLAR_FEATURES]);
        // Prioritize points that can contribute light to the camera, while
        // keeping clear points in the training distribution.
        const localDensity = rows[n * SOLAR_ROW + SOLAR_FEATURES + 2];
        weights[n] = 0.35 + 0.65 * Math.min(1, localDensity / 0.08);
    }
    return { inputs, targets, weights };
}

export function serializeSolarModel(network, { mean, scale }) {
    return solarModelFromJSON({
        format: SOLAR_MODEL_FORMAT,
        mean: Array.from(mean), scale: Array.from(scale), weights: Array.from(network.weights),
    });
}

export function evaluateSolarModel(artifact, rows) {
    const network = new DenseNetwork(SOLAR_SIZES, artifact.weights);
    const workspace = network.workspace();
    const x = new Float32Array(SOLAR_FEATURES);
    const output = new Float32Array(rows.length / SOLAR_ROW);
    for (let n = 0; n < output.length; n++) {
        const row = n * SOLAR_ROW;
        for (let i = 0; i < SOLAR_FEATURES; i++) x[i] = (rows[row + i] - artifact.mean[i]) * artifact.scale[i];
        const value = network.forward(x, workspace)[0];
        output[n] = Math.expm1(Math.max(0, Math.min(5, value))) / SOLAR_TARGET_SCALE;
    }
    return output;
}

export function solarMetrics(rows, predictions, extinction) {
    let modelError = 0;
    let coarseError = 0;
    let opticalError = 0;
    for (let n = 0; n < predictions.length; n++) {
        const offset = n * SOLAR_ROW + SOLAR_FEATURES;
        const optical = rows[offset];
        const target = Math.exp(-extinction * optical);
        modelError += (Math.exp(-extinction * predictions[n]) - target) ** 2;
        coarseError += (Math.exp(-extinction * rows[offset + 1]) - target) ** 2;
        opticalError += (predictions[n] - optical) ** 2;
    }
    return {
        modelRmse: Math.sqrt(modelError / predictions.length),
        coarseRmse: Math.sqrt(coarseError / predictions.length),
        opticalRmse: Math.sqrt(opticalError / predictions.length),
        count: predictions.length,
    };
}

export function shuffledIndices(count, random = seededRandom(1)) {
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
}
