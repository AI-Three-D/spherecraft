import { cloudCacheGrid } from './CloudSampleCache.js';
import { CloudRayPairs } from './CloudRayPairs.js';
import { buildConventionalRaymarch, CONVENTIONAL_DOMES_CONSTANTS } from './shaders/cloudConventional.wgsl.js';
import { buildNeuralLightBake } from './shaders/cloudNeuralLighting.wgsl.js';
import { DEFAULT_LIGHTING_MODEL, LIGHTING_MODEL_SETS } from './neural/lightingModels.js';

const PATCH_SIZE = [64, 64, 24];
// Eight of 64 rows keeps the bake under about 0.3 ms on any frame; a patch takes 8 frames.
const ROWS_PER_FRAME = 8;
const FADE_FRAMES = 12;
const MAX_AGE = 36;
const UNIFORM = { coverage: 12, wind: 14, lod: 26, weather: 44, cache: 50 };
const RAY_VARIANTS = {
    '': {}, Domes: CONVENTIONAL_DOMES_CONSTANTS, Dense: { ...CONVENTIONAL_DOMES_CONSTANTS, CONVENTIONAL_DENSE: true },
};
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

export class CloudNeuralLighting {
    constructor(host) {
        this.host = host;
        this.device = host.device;
        this.resources = [];
        this.groups = new WeakMap();
    }

    async initialize() {
        const host = this.host;
        const device = this.device;
        const compile = (label, module, layout, constants, entryPoint = 'main') => {
            return device.createComputePipelineAsync({
                label, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                compute: { module, entryPoint, constants },
            });
        };
        this.rayPairs = new CloudRayPairs(host);
        const halfFloats = !!device.features?.has?.('shader-f16');
        const rayModule = this.rayModule = device.createShaderModule({ label: 'clouds neural lighting raymarch',
            code: buildConventionalRaymarch(true, halfFloats) });
        const rayLayout = host._layouts.conventionalNeural;
        this.compile = compile;
        this.compiling = new Set();
        // One bake per trained model set, chosen with settings.neuralLightingModel.
        this.bakePipelines = Object.fromEntries(await Promise.all(Object.keys(LIGHTING_MODEL_SETS).map(async model => {
            const code = buildNeuralLightBake(model);
            const module = device.createShaderModule({ label: `clouds neural light column bake ${model}`, code });
            const pipeline = await compile(`clouds neural light column bake ${model}`, module, host._layouts.neuralLightBake);
            host._pipelines[`neuralLightBake_${model}`] = pipeline;
            return [model, `neuralLightBake_${model}`];
        })));
        const rays = await Promise.all(Object.entries(RAY_VARIANTS).map(async ([variant, constants]) =>
            [variant, await compile(`clouds neural lighting raymarch ${variant}`, rayModule, rayLayout, constants)]));
        await this.rayPairs.initialize();
        if (this.disposed) return false;
        for (const [variant, pipeline] of rays) host._pipelines['conventionalNeural' + variant] = pipeline;
        const uniform = (label, size) => {
            const buffer = device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.resources.push(buffer);
            return { buffer };
        };
        this.uniforms = uniform('cloud neural light bake snapshot', host._uniformData.byteLength);
        this.rowOffset = uniform('cloud neural light row', 16);
        this.lookup = uniform('cloud neural light patch pair', 128);
        const weather = host._ensureConventionalWeather();
        this.banks = [0, 1].map(index => {
            const texture = device.createTexture({
                label: 'cloud neural light patch ' + index,
                dimension: '3d', size: PATCH_SIZE, format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            });
            this.resources.push(texture);
            const view = texture.createView();
            return {
                index, view,
                group: host._group('neuralLightBake', [
                    this.uniforms, ...host._noiseResources.slice(1), host._linearSampler, ...weather.views, view, this.rowOffset,
                ]),
            };
        });
        return true;
    }

    /** Name of the raymarch pipeline with the preview flags compiled in, or null while it compiles. */
    _specialised(variant, flags, entryPoint = 'main', tier = null) {
        const name = `conventionalNeural${variant}_${flags}_${entryPoint}${tier?.march ? `_${tier.detail}` : ''}`;
        const pipelines = this.host._pipelines;
        if (pipelines[name]) return name;
        if (!this.compiling.has(name)) {
            this.compiling.add(name);
            const layout = this.host._layouts[entryPoint === 'mainList' ? 'conventionalNeuralList' : 'conventionalNeural'];
            this.compile(name, this.rayModule, layout, { ...RAY_VARIANTS[variant], PREVIEW_FLAGS: flags, ...tier?.march }, entryPoint)
                .then(pipeline => { if (!this.disposed) pipelines[name] = pipeline; })
                .catch(error => console.warn('[clouds] specialised raymarch failed to compile', error));
        }
        return null;
    }

    rayPipeline(variant, flags, tier) {
        return this._specialised(variant, flags, 'main', tier) ?? 'conventionalNeural' + variant;
    }

    /** Traces half of the rays and the ones that cannot be filled in (CloudRayPairs). False while its pipelines compile. */
    dispatchPairs(encoder, set, variant, flags, width, height, tier) {
        const fillAll = !!tier?.pairs?.FILL_ALL;
        const check = this._specialised(variant, flags, 'mainChecker', tier);
        const list = fillAll ? null : this._specialised(variant, flags, 'mainList', tier);
        const resolve = this.rayPairs.pipelineFor(tier);
        if (!check || !(list || fillAll) || !resolve) return false;
        const pipelines = this.host._pipelines;
        this.rayPairs.dispatch(encoder, { check: pipelines[check], list: list && pipelines[list], resolve }, {
            base: set.conventional, resources: set.conventionalResources, banks: this.banks, lookup: this.lookup,
            bank: this.current?.index ?? 0, width, height,
        });
        return true;
    }

    reset() {
        this.current = this.previous = this.pending = null;
    }

    /** Refreshes the light patch. False when this frame has none; with `analytic` the raymarch then runs without one. */
    dispatch(encoder, analytic = false) {
        if (!this.banks) return false;
        const host = this.host;
        const data = host._uniformData;
        const altitude = Math.hypot(data[0], data[1], data[2]) - host.planet.radiusKm;
        const above = altitude - host.settings.cloudTopKm;
        if (data[UNIFORM.weather * 4] <= 0.001 || host.sunIlluminance <= 0.0 || above >= 24) {
            this.reset();
            return analytic && data[UNIFORM.weather * 4] > 0.001 && this._withoutCache();
        }

        const grid = cloudCacheGrid([...data.subarray(0, 3)], host.planet.radiusKm, 'transport');
        const weatherStyle = Array.from(data.subarray(UNIFORM.weather * 4, UNIFORM.weather * 4 + 3));
        const coverage = data[UNIFORM.coverage * 4];
        const boil = data[UNIFORM.lod * 4 + 2];
        const sun = host.sunDirection;
        const wind = Array.from(data.subarray(UNIFORM.wind * 4, UNIFORM.wind * 4 + 3));
        const s = host.settings;
        const model = Object.hasOwn(this.bakePipelines, s.neuralLightingModel) ? s.neuralLightingModel : DEFAULT_LIGHTING_MODEL;
        const key = JSON.stringify([model, s.cloudFarLight, host._conventionalWeather.key, s.cloudTopKm, s.cloudShape, s.giantShare,
            s.giantHeight, s.giantScale, s.popcornTopKm, s.domeHeight, s.domeEdgeSharpness, s.domeHeads,
            s.densityVariation, s.isolatedPuffSuppression, s.detailErosion, s.detailWarp, s.edgeWisps,
            s.shapeTileKm, s.detailTileKm, s.windSkewKm, s.extinction, s.albedo, s.lightSteps, s.lightStepKm,
            s.cloudType, s.typeVariance, s.weatherContrast, s.altoClouds, s.altoBottomKm, s.altoTopKm, s.altoTileKm]);
        const stale = bank => bank && (bank.key !== key || distance(bank.sun, sun) > 0.13
            || distance(bank.weatherStyle, weatherStyle) > 0.22 || Math.abs(bank.coverage - coverage) > 0.19
            || distance(bank.wind, wind) > 3);
        if (stale(this.current) || this.current?.readyFrame > host._frame) this.reset();
        if (stale(this.pending)) this.pending = null;
        if (this.previous && host._frame - this.current.readyFrame >= FADE_FRAMES) this.previous = null;
        const current = this.current;
        const elapsed = host._frame - (current?.readyFrame ?? 0);
        const windChange = current ? distance(current.wind, wind) : 0;
        const weatherChange = current ? distance(current.weatherStyle, weatherStyle) : 0;
        const sunChange = current ? distance(current.sun, sun) : 0;
        const coverageChange = Math.abs((current?.coverage ?? coverage) - coverage);
        const boilChange = Math.abs((current?.boil ?? boil) - boil);
        // A frozen, stationary scene can reuse the patch indefinitely.
        const changed = windChange + weatherChange + sunChange + coverageChange + boilChange > 0.001;
        const refresh = !current || distance(grid, current.grid) > 0 || (elapsed >= MAX_AGE && changed)
            || windChange > 0.2 || weatherChange > 0.025 || coverageChange > 0.03 || sunChange > 0.025;

        if (!this.pending && !this.previous && refresh) {
            const bank = this.banks[current ? 1 - current.index : 0];
            Object.assign(bank, { grid, key, model, coverage, boil, sun: [...sun], weatherStyle, wind, row: 0 });
            const snapshot = data.slice();
            snapshot.set(grid, UNIFORM.cache * 4);
            this.device.queue.writeBuffer(this.uniforms.buffer, 0, snapshot);
            this.pending = bank;
        }
        if (this.pending) {
            const bank = this.pending;
            this.device.queue.writeBuffer(this.rowOffset.buffer, 0, new Uint32Array([bank.row, 0, 0, 0]));
            const rows = Math.min(PATCH_SIZE[1] - bank.row, ROWS_PER_FRAME);
            host._dispatch(encoder, this.bakePipelines[bank.model], bank.group, PATCH_SIZE[0] / 4, rows, 'neural light bake');
            bank.row += rows;
            if (bank.row >= PATCH_SIZE[1]) {
                bank.readyFrame = host._frame;
                this.pending = null;
                this.previous = this.current;
                this.current = bank;
            }
        }

        if (!this.current) return analytic && this._withoutCache();
        const fade = Math.min(1, (host._frame - this.current.readyFrame + 1) / FADE_FRAMES);
        const altitudeWeight = Math.min(1, (24 - above) / 8);
        const lookup = new Float32Array(32);
        const pack = (bank, weight, offset) => {
            if (bank) lookup.set([...bank.grid.slice(0, 10), bank.grid[11], weight * altitudeWeight, ...bank.wind, 0], offset);
        };
        pack(this.current, fade, 0);
        pack(this.previous, 1 - fade, 16);
        this.device.queue.writeBuffer(this.lookup.buffer, 0, lookup);
        return true;
    }

    // Analytic light only, from the same pipelines: the plain raymarch has no constants for the lower detail tiers.
    _withoutCache() {
        this.device.queue.writeBuffer(this.lookup.buffer, 0, new Float32Array(32));
        return true;
    }

    rayGroup(base, resources) {
        let groups = this.groups.get(base);
        if (!groups) {
            groups = this.banks.map((bank, index) => this.host._group('conventionalNeural', [
                ...resources, bank.view, this.banks[1 - index].view, this.lookup,
            ]));
            this.groups.set(base, groups);
        }
        return groups[this.current?.index ?? 0];
    }

    dispose() {
        this.disposed = true;
        this.rayPairs?.dispose();
        for (const resource of this.resources) resource.destroy();
    }
}
