import { evaluateSolarModel, solarMetrics, solarModelFromJSON, SOLAR_ROW } from 'engine/renderer/volumetricClouds/neural/solarModel.js';
import { SolarGpuLab } from './solarGpu.js';

export function attachSolarLab(root, clouds) {
    const field = name => root.querySelector(`[data-solar="${name}"]`);
    const samples = field('samples');
    const steps = field('steps');
    const epochs = field('epochs');
    const seed = field('seed');
    const mode = field('mode');
    const status = field('status');
    const scores = field('scores');
    const generateButton = field('generate');
    const trainButton = field('train');
    const stopButton = field('stop');
    const evaluateButton = field('evaluate');
    const exportButton = field('export');
    const importInput = field('import');

    const gpu = new SolarGpuLab(clouds);
    let dataset = null;
    let model = null;
    let running = false;
    let worker;
    let rejectTraining;

    function refresh() {
        generateButton.disabled = running;
        trainButton.disabled = running || !dataset;
        stopButton.disabled = !worker;
        evaluateButton.disabled = running || !dataset || !model;
        exportButton.disabled = running || !model;
        importInput.disabled = running;
        mode.disabled = running;
        mode.querySelector('option[value="neural-solar"]').disabled = !model;
        mode.value = ['solar-reference', 'neural-solar'].includes(clouds.settings.cloudCacheMode)
            ? clouds.settings.cloudCacheMode : 'off';
        steps.value = clouds.settings.solarReferenceSteps;
    }

    function showScores(metrics, extra = []) {
        scores.replaceChildren();
        const items = [
            ['Six-probe transmittance RMSE', metrics.coarseRmse.toFixed(4)],
            ['Network transmittance RMSE', metrics.modelRmse.toFixed(4)],
            ['Optical column RMSE (km)', metrics.opticalRmse.toFixed(4)],
            ...extra,
        ];
        for (const [name, value] of items) {
            const label = document.createElement('dt');
            const result = document.createElement('dd');
            label.textContent = name;
            result.textContent = value;
            scores.append(label, result);
        }
    }

    async function perform(action) {
        if (running) return;
        running = true;
        refresh();
        try {
            return await action();
        } finally {
            running = false;
            refresh();
        }
    }

    function run(action) {
        action().catch(error => { status.textContent = error.message ?? String(error); });
    }

    function generate({ count = samples.valueAsNumber, referenceSteps = steps.valueAsNumber, randomSeed = seed.valueAsNumber } = {}) {
        if (!Number.isInteger(randomSeed)) return Promise.reject(new Error('Use an integer seed'));
        return perform(async () => {
            status.textContent = 'Generating reference samples…';
            const next = await gpu.generate(count, referenceSteps, randomSeed);
            dataset = next;
            clouds.settings.solarReferenceSteps = referenceSteps;
            scores.replaceChildren();
            status.textContent = `${next.train.length / SOLAR_ROW} training samples, ${next.test.length / SOLAR_ROW} test samples.`;
            return next;
        });
    }

    function train({ count = epochs.valueAsNumber, randomSeed = seed.valueAsNumber } = {}) {
        if (!dataset) return Promise.reject(new Error('Generate a dataset first'));
        if (!Number.isInteger(count) || count < 1 || count > 200) return Promise.reject(new Error('Use 1–200 epochs'));
        if (!Number.isInteger(randomSeed)) return Promise.reject(new Error('Use an integer seed'));
        return perform(async () => {
            status.textContent = 'Training…';
            worker = new Worker(new URL('./solarTrainingWorker.js', import.meta.url), { type: 'module' });
            refresh();
            try {
                const result = await new Promise((resolve, reject) => {
                    rejectTraining = reject;
                    worker.addEventListener('error', event => reject(new Error(event.message)));
                    worker.addEventListener('message', ({ data }) => {
                        if (data.error) reject(new Error(data.error));
                        else if (data.model) resolve(data.model);
                        else {
                            status.textContent = `Epoch ${data.epoch}/${count} · validation RMSE ${data.metrics.modelRmse.toFixed(4)}`;
                        }
                    });
                    worker.postMessage({
                        train: dataset.train, validation: dataset.validation, extinction: dataset.extinction,
                        epochs: count, seed: randomSeed,
                    });
                });
                clouds.setSolarModel(result);
                model = result;
                scores.replaceChildren();
                status.textContent = 'Training complete. Evaluate the held-out region or select Neural solar in the viewport.';
                return model;
            } finally {
                worker?.terminate();
                worker = null;
                rejectTraining = null;
            }
        });
    }

    function evaluate() {
        if (!dataset || !model) return Promise.reject(new Error('A dataset and model are required'));
        return perform(async () => {
            status.textContent = 'Evaluating held-out samples on WebGPU…';
            const { test, extinction } = dataset;
            const gpuResult = await gpu.evaluate(model, test);
            const cpu = evaluateSolarModel(model, test);
            let parity = 0;
            for (let i = 0; i < cpu.length; i++) parity = Math.max(parity, Math.abs(cpu[i] - gpuResult.values[i]));
            const metrics = solarMetrics(test, gpuResult.values, extinction);
            showScores(metrics, [
                ['CPU ↔ GPU maximum error', parity.toExponential(2)],
                ['GPU inference batch', gpuResult.gpuMs == null ? 'unavailable' : `${gpuResult.gpuMs.toFixed(3)} ms`],
            ]);
            status.textContent = `Held-out spatial region · ${metrics.count} samples.`;
            return { ...metrics, parity, gpuMs: gpuResult.gpuMs };
        });
    }

    async function setMode(next) {
        if (!['off', 'solar-reference', 'neural-solar'].includes(next)) throw new Error('Unknown solar preview');
        return perform(async () => {
            if (next === 'neural-solar' && !model) throw new Error('Train or load a solar model first');
            if (next !== 'off' && !await clouds.prepareSampleCache(next)) throw new Error('Solar preview pipeline unavailable');
            clouds.settings.cloudCacheMode = next;
            clouds.resetHistory();
        });
    }

    function loadModel(artifact) {
        const next = solarModelFromJSON(artifact);
        clouds.setSolarModel(next);
        model = next;
        scores.replaceChildren();
        status.textContent = 'Solar model loaded.';
        refresh();
    }

    generateButton.addEventListener('click', () => run(() => generate()));
    trainButton.addEventListener('click', () => run(() => train()));
    evaluateButton.addEventListener('click', () => run(evaluate));
    stopButton.addEventListener('click', () => rejectTraining?.(new Error('Training stopped.')));
    mode.addEventListener('change', () => run(() => setMode(mode.value)));
    steps.addEventListener('change', () => {
        const value = steps.valueAsNumber;
        if (Number.isInteger(value) && value >= 16 && value <= 512) clouds.settings.solarReferenceSteps = value;
        refresh();
    });
    exportButton.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'cloud-solar-weights.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    importInput.addEventListener('change', () => run(async () => {
        const file = importInput.files[0];
        try {
            if (file) loadModel(JSON.parse(await file.text()));
        } finally {
            importInput.value = '';
        }
    }));
    status.textContent = 'Generate samples from the current cloud field.';
    refresh();
    return { generate, train, evaluate, setMode, loadModel, refresh, dispose: () => worker?.terminate() };
}
