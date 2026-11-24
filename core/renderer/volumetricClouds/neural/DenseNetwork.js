// Each neuron stores its incoming weights followed by its bias.
export class DenseNetwork {
    constructor(sizes, weights) {
        if (!Array.isArray(sizes) || sizes.length < 2 || sizes.some(n => !Number.isInteger(n) || n < 1)) {
            throw new Error('Expected positive layer widths');
        }
        this.sizes = [...sizes];
        this.offsets = [];
        let count = 0;
        for (let i = 1; i < sizes.length; i++) {
            this.offsets.push(count);
            count += (sizes[i - 1] + 1) * sizes[i];
        }
        if (weights !== undefined && (weights.length !== count || !Array.from(weights).every(Number.isFinite))) {
            throw new Error('Invalid network weights');
        }
        this.weights = weights === undefined ? new Float32Array(count) : Float32Array.from(weights);
    }

    initialize(random = Math.random) {
        for (let layer = 0; layer < this.offsets.length; layer++) {
            const inputs = this.sizes[layer];
            const outputs = this.sizes[layer + 1];
            const limit = Math.sqrt(6 / (inputs + outputs));
            let position = this.offsets[layer];
            for (let neuron = 0; neuron < outputs; neuron++) {
                for (let i = 0; i < inputs; i++) this.weights[position++] = (2 * random() - 1) * limit;
                this.weights[position++] = 0;
            }
        }
        return this;
    }

    workspace() {
        return this.sizes.map(size => new Float32Array(size));
    }

    forward(input, activations = this.workspace(), derivatives = null) {
        if (input.length !== this.sizes[0]) throw new Error('Invalid network input width');
        activations[0].set(input);
        for (let layer = 0; layer < this.offsets.length; layer++) {
            const source = activations[layer];
            const target = activations[layer + 1];
            let position = this.offsets[layer];
            const hidden = layer + 1 < this.offsets.length;
            for (let neuron = 0; neuron < target.length; neuron++) {
                let sum = this.weights[position + source.length];
                for (let i = 0; i < source.length; i++) sum += source[i] * this.weights[position++];
                position++;
                if (hidden) {
                    const inverse = 1 / (1 + Math.abs(sum));
                    target[neuron] = sum * inverse;
                    if (derivatives) derivatives[layer + 1][neuron] = inverse * inverse;
                } else {
                    target[neuron] = sum;
                }
            }
        }
        return activations.at(-1);
    }
}

export class AdamTrainer {
    constructor(network, learningRate = 0.002) {
        this.network = network;
        this.learningRate = learningRate;
        this.activations = network.workspace();
        this.derivatives = network.workspace();
        this.deltas = network.workspace();
        this.gradient = new Float32Array(network.weights.length);
        this.first = new Float32Array(network.weights.length);
        this.second = new Float32Array(network.weights.length);
        this.step = 0;
    }

    trainBatch(inputs, targets, indices, sampleWeights) {
        const { network, gradient, activations, derivatives, deltas } = this;
        const [inputSize, outputSize] = [network.sizes[0], network.sizes.at(-1)];
        const weights = network.weights;
        gradient.fill(0);
        let loss = 0;
        let totalWeight = 0;
        for (const index of indices) {
            const weight = sampleWeights?.[index] ?? 1;
            totalWeight += weight;
            const prediction = network.forward(inputs.subarray(index * inputSize, (index + 1) * inputSize), activations, derivatives);
            const finalDelta = deltas.at(-1);
            for (let i = 0; i < outputSize; i++) {
                const error = prediction[i] - targets[index * outputSize + i];
                finalDelta[i] = error * weight;
                loss += error * error * weight;
            }
            for (let layer = network.offsets.length - 1; layer >= 0; layer--) {
                const source = activations[layer];
                const previous = deltas[layer];
                const current = deltas[layer + 1];
                previous.fill(0);
                let position = network.offsets[layer];
                for (let neuron = 0; neuron < current.length; neuron++) {
                    const delta = current[neuron];
                    for (let i = 0; i < source.length; i++) {
                        gradient[position] += source[i] * delta;
                        previous[i] += weights[position++] * delta;
                    }
                    gradient[position++] += delta;
                }
                if (layer > 0) {
                    for (let i = 0; i < previous.length; i++) previous[i] *= derivatives[layer][i];
                }
            }
        }
        if (totalWeight === 0) return 0;
        const step = ++this.step;
        const firstBias = 1 - 0.9 ** step;
        const secondBias = 1 - 0.999 ** step;
        for (let i = 0; i < gradient.length; i++) {
            const g = gradient[i] / totalWeight;
            this.first[i] = 0.9 * this.first[i] + 0.1 * g;
            this.second[i] = 0.999 * this.second[i] + 0.001 * g * g;
            weights[i] -= this.learningRate * (this.first[i] / firstBias) / (Math.sqrt(this.second[i] / secondBias) + 1e-8);
        }
        return loss / (totalWeight * outputSize);
    }
}

export function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value + 0x6D2B79F5) >>> 0;
        let mixed = Math.imul(value ^ (value >>> 15), value | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}
