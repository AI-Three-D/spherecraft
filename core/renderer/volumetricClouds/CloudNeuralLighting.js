import { CloudRayPairs } from './CloudRayPairs.js';
import { buildCloudMarch } from './shaders/cloudMarch.wgsl.js';
import { CLOUD_NEURAL_LIGHT_BAKE_WGSL } from './shaders/cloudNeuralLighting.wgsl.js';

const PATCH_SIZE = [64, 64, 24];
// Eight of 64 rows keeps the bake under about 0.3 ms on any frame; a patch takes 8 frames.
const ROWS_PER_FRAME = 8;
const FADE_FRAMES = 12;
const MAX_AGE = 36;
const PATCH_EXTENT_KM = 48;
// A multiple of the texel width keeps the lattice fixed as the patch moves.
const ANCHOR_STEP_KM = 12;
const UNIFORM = { coverage: 12, wind: 14, lod: 26, weather: 44, cache: 50, deck: 54 };
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

/** Axes and centre (km) of the light patch under a position, for the uniforms cacheU, cacheV and cacheGrid. */
export function cloudPatchGrid(position, radius) {
    const axis = Math.abs(position[0]) >= Math.abs(position[1]) ? 0 : 1;
    const face = Math.abs(position[axis]) >= Math.abs(position[2]) ? axis : 2;
    const u = (face + 1) % 3;
    const v = (face + 2) % 3;
    const sign = Math.sign(position[face]) || 1;
    const axes = [0, 0, 0, 0, 0, 0, 0, 0];
    axes[u] = 1;
    axes[4 + v] = sign;
    const scale = radius / Math.max(1, Math.hypot(...position));
    const snap = coordinate => Math.round(coordinate * scale / ANCHOR_STEP_KM) * ANCHOR_STEP_KM;
    return [...axes, snap(position[u]), snap(position[v] * sign), 0, PATCH_EXTENT_KM];
}

/** The raymarch, and the light inside the clouds that a small network bakes into a patch around the camera. */
export class CloudNeuralLighting {
    constructor(host) {
        this.host = host;
        this.device = host.device;
        this.resources = [];
        this.groups = new WeakMap();
        this.compiling = new Set();
    }

    async initialize() {
        const host = this.host;
        const device = this.device;
        this.rayPairs = new CloudRayPairs(host);
        this.rayModule = device.createShaderModule({
            label: 'clouds raymarch', code: buildCloudMarch(!!device.features?.has?.('shader-f16')),
        });
        const bake = device.createShaderModule({ label: 'clouds light bake', code: CLOUD_NEURAL_LIGHT_BAKE_WGSL });
        const tier = host.tier;
        const [lightBake] = await Promise.all([
            this._compile('clouds light bake', bake, host._layouts.lightBake),
            ...['main', 'mainChecker', 'mainList'].map(entryPoint => this._build(tier, entryPoint)),
            this.rayPairs.initialize(),
        ]);
        if (this.disposed) return;
        this._readyTier = tier;
        host._pipelines.lightBake = lightBake;
        const uniform = (label, size) => {
            const buffer = device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.resources.push(buffer);
            return { buffer };
        };
        this.uniforms = uniform('cloud light bake snapshot', host._uniformData.byteLength);
        this.rowOffset = uniform('cloud light row', 16);
        this.lookup = uniform('cloud light patch pair', 128);
        this.banks = [0, 1].map(index => {
            const texture = device.createTexture({
                label: 'cloud light patch ' + index,
                dimension: '3d', size: PATCH_SIZE, format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            });
            this.resources.push(texture);
            const view = texture.createView();
            return {
                index, view,
                group: host._group('lightBake', [
                    this.uniforms, ...host._noiseResources.slice(1), host._linearSampler, ...host._weatherCube.views, view, this.rowOffset,
                ]),
            };
        });
    }

    _compile(label, module, layout, constants, entryPoint = 'main') {
        return this.device.createComputePipelineAsync({
            label, layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: { module, entryPoint, constants },
        });
    }

    async _build(tier, entryPoint) {
        const name = `raymarch_${tier.detail}_${entryPoint}`;
        const layout = this.host._layouts[entryPoint === 'mainList' ? 'raymarchList' : 'raymarch'];
        const pipeline = await this._compile(`clouds ${name}`, this.rayModule, layout, tier.march, entryPoint);
        if (!this.disposed) this.host._pipelines[name] = pipeline;
    }

    /** Pipeline of a tier's raymarch, or null while it compiles. */
    _pipeline(tier, entryPoint) {
        const name = `raymarch_${tier.detail}_${entryPoint}`;
        const pipeline = this.host._pipelines[name];
        if (!pipeline && !this.compiling.has(name)) {
            this.compiling.add(name);
            this._build(tier, entryPoint).catch(error => console.warn('[clouds] raymarch failed to compile', error));
        }
        return pipeline ?? null;
    }

    /** The whole raymarch in one pass, for targets that the slabs then blend into. */
    dispatchMain(encoder, base, resources, width, height, tier) {
        const pipeline = this._pipeline(tier, 'main') ?? this.host._pipelines[`raymarch_${this._readyTier.detail}_main`];
        const pass = this.host._beginPass(encoder, 'raymarch');
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._group(base, resources));
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 4));
        pass.end();
    }

    /** Traces half of the rays and the ones that cannot be filled in (CloudRayPairs). */
    dispatchPairs(encoder, target, width, height, tier) {
        const fillAll = !!tier.pairs?.FILL_ALL;
        let check = this._pipeline(tier, 'mainChecker');
        let list = fillAll ? null : this._pipeline(tier, 'mainList');
        let resolve = this.rayPairs.pipelineFor(tier);
        // While a tier compiles, the first one draws.
        if (!check || !(list || fillAll) || !resolve) {
            const ready = this._readyTier;
            check = this._pipeline(ready, 'mainChecker');
            list = this._pipeline(ready, 'mainList');
            resolve = this.rayPairs.pipelines.high;
        }
        this.rayPairs.dispatch(encoder, { check, list, resolve }, {
            base: target.raymarch, resources: target.resources, banks: this.banks, lookup: this.lookup,
            bank: this.current?.index ?? 0, width, height,
        });
    }

    reset() {
        this.current = this.previous = this.pending = null;
    }

    /** Refreshes the light patch. Without one, the fitted light stands in everywhere. */
    dispatch(encoder) {
        const host = this.host;
        const data = host._uniformData;
        const altitude = Math.hypot(data[0], data[1], data[2]) - host.planet.radiusKm;
        const above = altitude - host.settings.cloudTopKm;
        if (data[UNIFORM.weather * 4] <= 0.001 || host.sunIlluminance <= 0.0 || above >= 24) {
            this.reset();
            this._clearLookup();
            return;
        }

        const grid = cloudPatchGrid([...data.subarray(0, 3)], host.planet.radiusKm);
        const weatherStyle = [...data.subarray(UNIFORM.weather * 4, UNIFORM.weather * 4 + 3), ...data.subarray(UNIFORM.deck * 4, UNIFORM.deck * 4 + 4)];
        const coverage = data[UNIFORM.coverage * 4];
        const boil = data[UNIFORM.lod * 4 + 2];
        const sun = host.sunDirection;
        const wind = Array.from(data.subarray(UNIFORM.wind * 4, UNIFORM.wind * 4 + 3));
        const s = host.settings;
        const key = JSON.stringify([host._weatherCube.key, s.cloudTopKm, s.popcornTopKm, s.domeHeight, s.domeEdgeSharpness, s.domeHeads,
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
            Object.assign(bank, { grid, key, coverage, boil, sun: [...sun], weatherStyle, wind, row: 0 });
            const snapshot = data.slice();
            snapshot.set(grid, UNIFORM.cache * 4);
            this.device.queue.writeBuffer(this.uniforms.buffer, 0, snapshot);
            this.pending = bank;
        }
        if (this.pending) {
            const bank = this.pending;
            this.device.queue.writeBuffer(this.rowOffset.buffer, 0, new Uint32Array([bank.row, 0, 0, 0]));
            const rows = Math.min(PATCH_SIZE[1] - bank.row, ROWS_PER_FRAME);
            host._dispatch(encoder, 'lightBake', bank.group, PATCH_SIZE[0] / 4, rows, 'light bake');
            bank.row += rows;
            if (bank.row >= PATCH_SIZE[1]) {
                bank.readyFrame = host._frame;
                this.pending = null;
                this.previous = this.current;
                this.current = bank;
            }
        }

        if (!this.current) {
            this._clearLookup();
            return;
        }
        const fade = Math.min(1, (host._frame - this.current.readyFrame + 1) / FADE_FRAMES);
        const altitudeWeight = Math.min(1, (24 - above) / 8);
        const lookup = new Float32Array(32);
        const pack = (bank, weight, offset) => {
            if (bank) lookup.set([...bank.grid.slice(0, 10), bank.grid[11], weight * altitudeWeight, ...bank.wind, 0], offset);
        };
        pack(this.current, fade, 0);
        pack(this.previous, 1 - fade, 16);
        this.device.queue.writeBuffer(this.lookup.buffer, 0, lookup);
    }

    _clearLookup() {
        this.device.queue.writeBuffer(this.lookup.buffer, 0, new Float32Array(32));
    }

    _group(base, resources) {
        let groups = this.groups.get(base);
        if (!groups) {
            groups = this.banks.map((bank, index) => this.host._group('raymarch', [
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
