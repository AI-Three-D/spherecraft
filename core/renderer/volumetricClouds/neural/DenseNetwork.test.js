import { describe, expect, it } from 'vitest';
import { AdamTrainer, DenseNetwork, seededRandom } from './DenseNetwork.js';

describe('DenseNetwork training', () => {
    it('backpropagates the weighted loss through hidden weights and biases', () => {
        const network = new DenseNetwork([2, 3, 2]).initialize(seededRandom(17));
        const initial = network.weights.slice();
        const inputs = new Float32Array([0.3, -0.4, 0.7, 0.2]);
        const targets = new Float32Array([0.2, -0.1, -0.5, 0.4]);
        const weights = new Float32Array([1, 0.35]);
        const indices = [0, 1];
        const trainer = new AdamTrainer(network);
        trainer.trainBatch(inputs, targets, indices, weights);

        const reference = new DenseNetwork(network.sizes, initial);
        const loss = () => indices.reduce((sum, row) => {
            const start = 2 * row;
            const values = reference.forward(inputs.subarray(start, start + 2));
            return sum + 0.5 * weights[row] * (
                (values[0] - targets[start]) ** 2 + (values[1] - targets[start + 1]) ** 2
            );
        }, 0);
        const epsilon = 0.001;
        for (let i = 0; i < initial.length; i++) {
            reference.weights[i] = initial[i] + epsilon;
            const plus = loss();
            reference.weights[i] = initial[i] - epsilon;
            const minus = loss();
            reference.weights[i] = initial[i];
            expect(trainer.gradient[i]).toBeCloseTo((plus - minus) / (2 * epsilon), 4);
        }
    });
});
