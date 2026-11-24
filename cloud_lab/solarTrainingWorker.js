import { AdamTrainer, DenseNetwork, seededRandom } from '../core/renderer/volumetricClouds/neural/DenseNetwork.js';
import {
    evaluateSolarModel, fitSolarNormalization, serializeSolarModel, shuffledIndices, solarMetrics, solarTrainingArrays,
    SOLAR_ROW, SOLAR_SIZES,
} from '../core/renderer/volumetricClouds/neural/solarModel.js';

self.addEventListener('message', ({ data: { train, validation, extinction, epochs, seed } }) => {
    try {
        const random = seededRandom(seed);
        const normalization = fitSolarNormalization(train);
        const { inputs, targets, weights } = solarTrainingArrays(train, normalization);
        const network = new DenseNetwork(SOLAR_SIZES).initialize(random);
        const trainer = new AdamTrainer(network);
        const count = train.length / SOLAR_ROW;
        let bestError = Infinity;
        let best;
        for (let epoch = 1; epoch <= epochs; epoch++) {
            const indices = shuffledIndices(count, random);
            let loss = 0;
            for (let i = 0; i < count; i += 128) {
                const batch = indices.subarray(i, i + 128);
                loss += trainer.trainBatch(inputs, targets, batch, weights) * batch.length;
            }
            const model = serializeSolarModel(network, normalization);
            const metrics = solarMetrics(validation, evaluateSolarModel(model, validation), extinction);
            if (metrics.modelRmse < bestError) {
                bestError = metrics.modelRmse;
                best = model;
            }
            self.postMessage({ epoch, loss: loss / count, metrics });
        }
        self.postMessage({ model: best });
    } catch (error) {
        self.postMessage({ error: String(error.message ?? error) });
    }
});
