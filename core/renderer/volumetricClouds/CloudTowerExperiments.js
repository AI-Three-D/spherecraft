import {
    CLOUD_TOWER_DENSITY_WGSL, CLOUD_TOWER_CACHE_WGSL, CLOUD_TOWER_IMPOSTOR_WGSL, CLOUD_TOWER_RENDER_WGSL,
    TOWER_COUNT, TOWER_DENSITY_SIZE, TOWER_CACHE_SIZE, TOWER_IMPOSTOR_SIZE, TOWER_IMPOSTOR_VIEWS,
} from './shaders/cloudTowerExperiments.wgsl.js';

const RADIANS = Math.PI / 180;
const CACHE_UPDATE_COS = Math.cos(0.7 * RADIANS);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function towerSite(site, planetRadius, bottom, top) {
    const latitude = site.latDeg * RADIANS;
    const longitude = site.lonDeg * RADIANS;
    const rotation = (site.rotationDeg ?? 0) * RADIANS;
    const up = [-Math.cos(longitude) * Math.cos(latitude), Math.sin(latitude), Math.sin(longitude) * Math.cos(latitude)];
    const east = [Math.sin(longitude), 0, Math.cos(longitude)];
    const north = [Math.cos(longitude) * Math.sin(latitude), Math.cos(latitude), -Math.sin(longitude) * Math.sin(latitude)];
    const radius = Math.max(0.2, site.radiusKm);
    const height = Math.max(0.2, Math.min(site.heightKm, top - bottom)) * 0.5;
    // Account for the small radial bulge of the tangent-plane envelope.
    const center = up.map(v => v * (planetRadius + bottom + height));
    const yawCos = Math.cos(rotation);
    const yawSin = Math.sin(rotation);
    return [
        ...center, 0,
        ...east.map((v, i) => (v * yawCos + north[i] * yawSin) / radius), 0,
        ...up.map(v => v / height), 0,
        ...north.map((v, i) => (v * yawCos - east[i] * yawSin) / radius), 0,
    ];
}

/** GPU resources for the optional, planet-fixed tower previews. */
export class CloudTowerExperiments {
    constructor(host) {
        this.host = host;
        this.device = host.device;
        this.ready = false;
        this.disposed = false;
        this.resources = [];
        this.towerData = new Float32Array(4 + TOWER_COUNT * 16);
        this.geometryKey = '';
        this.cachedLight = null;
        this.densityBaked = false;
        this.impostorsBaked = false;
        this.targetGroups = new WeakMap();
        this.initialized = this.initialize().then(() => this.ready).catch(error => {
            if (!this.disposed) {
                console.error('[Cloud tower experiments]', error);
            }
            return false;
        });
    }

    async initialize() {
        const { device, host } = this;
        const buffer = this.uniforms = device.createBuffer({
            label: 'cloud tower sites', size: this.towerData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const makeTexture = (label, dimension, size) => {
            const texture = device.createTexture({
                label, dimension, size, format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            });
            this.resources.push(texture);
            return texture;
        };
        this.resources.push(buffer);
        const densitySize = TOWER_DENSITY_SIZE;
        const density = makeTexture('cloud tower density', '3d', [densitySize, densitySize, densitySize]);
        const densityView = density.createView({ dimension: '3d' });
        const cacheSize = TOWER_CACHE_SIZE;
        const cache = makeTexture('cloud tower optical depths', '3d', [cacheSize, cacheSize, cacheSize * TOWER_COUNT]);
        const atlas = makeTexture('cloud tower impostor atlas', '2d', [TOWER_IMPOSTOR_SIZE, TOWER_IMPOSTOR_SIZE, TOWER_IMPOSTOR_VIEWS]);
        const cacheView = cache.createView({ dimension: '3d' });
        const atlasView = atlas.createView({ dimension: '2d-array' });

        const uniform = { buffer: { type: 'uniform' } };
        const floatTexture = (viewDimension = '2d') => ({ texture: { sampleType: 'float', viewDimension } });
        const sampler = { sampler: { type: 'filtering' } };
        const storage = (format, viewDimension = '2d') => ({ storageTexture: { format, viewDimension, access: 'write-only' } });
        const layout = (entries) => device.createBindGroupLayout({
            entries: entries.map((entry, binding) => ({ ...entry, binding, visibility: GPUShaderStage.COMPUTE })),
        });
        const bind = (groupLayout, resources) => device.createBindGroup({
            layout: groupLayout, entries: resources.map((resource, binding) => ({ binding, resource })),
        });
        const compile = (label, shader, groupLayout, constants = {}) => device.createComputePipelineAsync({
            label, layout: device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }),
            compute: { module: shader, entryPoint: 'main', constants },
        });
        const shape = floatTexture('3d');
        const densityLayout = layout([shape, sampler, storage('rgba16float', '3d')]);
        const cacheLayout = layout([uniform, uniform, shape, sampler, storage('rgba16float', '3d')]);
        const atlasLayout = layout([shape, sampler, storage('rgba16float', '2d-array')]);
        this.renderLayout = layout([
            uniform, uniform, shape, sampler, floatTexture(), sampler, shape, floatTexture('2d-array'),
            floatTexture(), { texture: { sampleType: 'unfilterable-float' } }, { texture: { sampleType: 'depth' } },
            storage('rgba16float'), storage('r32float'),
        ]);
        const bindings = [{ buffer: host._uniformBuffer }, { buffer }, densityView, host._linearSampler];
        this.renderInputs = [...bindings, host._transmittanceView, host._linearSampler, cacheView, atlasView];
        this.cacheGroup = bind(cacheLayout, [...bindings, cacheView]);
        this.atlasGroup = bind(atlasLayout, [densityView, host._linearSampler, atlasView]);
        this.densityGroup = bind(densityLayout, [host._shapeView, host._noiseSampler, densityView]);
        const module = (label, code) => device.createShaderModule({ label, code });
        const render = module('cloud tower render', CLOUD_TOWER_RENDER_WGSL);
        const specifications = [
            ['density bake', module('cloud tower density', CLOUD_TOWER_DENSITY_WGSL), densityLayout],
            ['light cache', module('cloud tower cache', CLOUD_TOWER_CACHE_WGSL), cacheLayout],
            ['impostor bake', module('cloud tower impostor', CLOUD_TOWER_IMPOSTOR_WGSL), atlasLayout],
            ['volume', render, this.renderLayout, { TOWER_MODE: 0, TOWER_WORK: 0 }],
            ['cached volume', render, this.renderLayout, { TOWER_MODE: 1, TOWER_WORK: 0 }],
            ['impostor rays', render, this.renderLayout, { TOWER_MODE: 2, TOWER_WORK: 0 }],
            ['density only', render, this.renderLayout, { TOWER_MODE: 0, TOWER_WORK: 1 }],
            ['bounds only', render, this.renderLayout, { TOWER_MODE: 0, TOWER_WORK: 2 }],
        ];
        const pipelines = await Promise.all(specifications.map(async ([name, shader, groupLayout, constants]) =>
            [name, await compile(`cloud towers ${name}`, shader, groupLayout, constants)]));
        this.pipelines = Object.fromEntries(pipelines);
        this.ready = !this.disposed;
    }

    syncSites() {
        const { settings, planet } = this.host;
        const sites = settings.towerDebugSites;
        const count = Math.min(TOWER_COUNT, sites.length);
        const top = settings.cloudTopKm;
        const bottom = Math.min(settings.cloudBottomKm, top - 0.1);
        const start = Math.max(1, settings.towerImpostorStartKm);
        const end = Math.max(start + 1, settings.towerImpostorEndKm);
        const key = JSON.stringify([planet.radiusKm, top, bottom, start, end, sites]);
        if (key !== this.geometryKey) {
            this.geometryKey = key;
            this.towerData.set([count, start, end, 0]);
            for (let i = 0; i < count; i++) this.towerData.set(towerSite(sites[i], planet.radiusKm, bottom, top), 4 + i * 16);
            this.device.queue.writeBuffer(this.uniforms, 0, this.towerData);
            this.cachedLight = null;
        }
        return count;
    }

    invalidateBakes() {
        this.densityBaked = false;
        this.cachedLight = null;
        this.impostorsBaked = false;
    }

    prepare(encoder, mode, count) {
        const { host } = this;
        if (!this.densityBaked) {
            const groups = Math.ceil(TOWER_DENSITY_SIZE / 4);
            this.dispatch(encoder, 'density bake', this.densityGroup, groups, groups, groups);
            this.densityBaked = true;
        }
        if (mode === 'cached' || mode === 'impostor') {
            const moon = host.moonIlluminance > 0 ? host.moonDirection : null;
            const staleMoon = Boolean(moon) !== Boolean(this.cachedLight?.moon)
                || (moon && dot(moon, this.cachedLight?.moon ?? [0, 0, 0]) < CACHE_UPDATE_COS);
            const sun = host.sunDirection;
            if (!this.cachedLight || staleMoon || dot(sun, this.cachedLight.sun) < CACHE_UPDATE_COS) {
                const groups = Math.ceil(TOWER_CACHE_SIZE / 4);
                this.dispatch(encoder, 'light cache', this.cacheGroup, groups, groups, Math.ceil(TOWER_CACHE_SIZE * count / 4));
                this.cachedLight = { sun: [...sun], moon: moon && [...moon] };
            }
        }
        if (mode === 'impostor' && !this.impostorsBaked) {
            const groups = Math.ceil(TOWER_IMPOSTOR_SIZE / 8);
            this.dispatch(encoder, 'impostor bake', this.atlasGroup, groups, groups, TOWER_IMPOSTOR_VIEWS);
            this.impostorsBaked = true;
        }
    }

    render(encoder, mode, intermediate, target, sceneDepth, width, height) {
        const outputs = target.views ?? [target.colorView, target.depthView];
        let entry = this.targetGroups.get(target);
        if (entry?.sceneDepth !== sceneDepth) {
            const resources = [...this.renderInputs, ...intermediate.views, sceneDepth, ...outputs];
            const group = this.device.createBindGroup({
                layout: this.renderLayout,
                entries: resources.map((resource, binding) => ({ binding, resource })),
            });
            entry = { sceneDepth, group };
            this.targetGroups.set(target, entry);
        }
        const name = { bounded: 'volume', cached: 'cached volume', impostor: 'impostor rays' }[mode];
        const work = this.host.settings.towerDebugWork;
        const profile = work === 'density' ? 'density only' : work === 'bounds' ? 'bounds only' : name;
        this.dispatch(encoder, profile, entry.group, Math.ceil(width / 8), Math.ceil(height / 8));
    }

    dispatch(encoder, name, group, x, y, z = 1) {
        const label = `cloud towers ${name}`;
        const pass = encoder.beginComputePass({ label, timestampWrites: this.host.gpuTimer?.timestampWrites(label) });
        pass.setPipeline(this.pipelines[name]);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(x, y, z);
        pass.end();
    }

    dispose() {
        this.disposed = true;
        this.ready = false;
        for (const resource of this.resources) resource.destroy();
    }
}
