import {
    CLOUD_LAYERED_RAYMARCH_WGSL, CLOUD_LIGHT_CACHE_RAYMARCH_WGSL, CLOUD_RAYMARCH_WGSL,
    CLOUD_TRANSPORT_RAYMARCH_WGSL,
    CLOUD_WEATHER_CACHE_RAYMARCH_WGSL,
} from './shaders/cloudPasses.wgsl.js';
import {
    CLOUD_LIGHT_BAKE_WGSL, CLOUD_TRANSPORT_BAKE_WGSL, CLOUD_WEATHER_BAKE_WGSL,
} from './shaders/cloudCaches.wgsl.js';

const WEATHER_EXTENT_KM = 96;
const LIGHT_EXTENT_KM = 32;
const TRANSPORT_EXTENT_KM = 48;
// A multiple of both texel widths keeps the overlapping lattice fixed as the patch moves.
const ANCHOR_STEP_KM = 12;
const variants = {
    phase: { ray: CLOUD_RAYMARCH_WGSL },
    weather: { ray: CLOUD_WEATHER_CACHE_RAYMARCH_WGSL, bake: CLOUD_WEATHER_BAKE_WGSL, dimensions: [512, 512], count: 2, group: 8 },
    light: { ray: CLOUD_LIGHT_CACHE_RAYMARCH_WGSL, bake: CLOUD_LIGHT_BAKE_WGSL, dimensions: [128, 128, 40], count: 1, group: 4 },
    transport: { ray: CLOUD_TRANSPORT_RAYMARCH_WGSL, bake: CLOUD_TRANSPORT_BAKE_WGSL,
        dimensions: [128, 128, 48], count: 1, group: 4 },
    layered: { ray: CLOUD_LAYERED_RAYMARCH_WGSL, bake: CLOUD_TRANSPORT_BAKE_WGSL,
        dimensions: [128, 128, 48], count: 1, group: 4 },
};

const usesTransport = mode => mode === 'transport' || mode === 'layered';

export function cloudCacheGrid(position, radius, mode) {
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
    const extent = usesTransport(mode) ? TRANSPORT_EXTENT_KM : LIGHT_EXTENT_KM;
    return [...axes, snap(position[u]), snap(position[v] * sign), WEATHER_EXTENT_KM, extent];
}

export class CloudSampleCache {
    constructor(host, layouts) {
        this.host = host;
        this.device = host.device;
        this.makeLayouts = layouts;
        this.preparing = new Map();
        this.variants = new Map();
        this.bindings = new WeakMap();
        this.textures = [];
    }

    prepare(mode) {
        if (!Object.hasOwn(variants, mode)) return Promise.resolve(false);
        if (!this.preparing.has(mode)) {
            const initialize = this.initialize(mode, variants[mode]).catch(error => {
                console.error(`Cloud ${mode} cache preview unavailable`, error);
                return false;
            });
            this.preparing.set(mode, initialize);
        }
        return this.preparing.get(mode);
    }

    async initialize(mode, description) {
        const host = this.host;
        const { dimension, raymarch, bake } = this.makeLayouts(mode, description.count);
        const create = (label, module, groupLayout, constants) => this.device.createComputePipelineAsync({
            label: `clouds ${label}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }),
            compute: { module, entryPoint: 'main', constants },
        });
        const rayModule = this.device.createShaderModule({ label: `clouds ${mode} preview`, code: description.ray });
        const pipelines = {};
        const promises = [['raymarchCut', 1, 4], ['raymarchDomes', 2, 8]].map(async ([ray, shape, height]) => {
            const key = `cloudsCache:${mode}:${ray}`;
            const constants = {
                RAY_PATH: 1, CLOUD_SHAPE: shape, RAY_GROUP_HEIGHT: height, CACHE_SCATTERING_PHASE: mode === 'phase',
            };
            if (usesTransport(mode) && mode !== 'layered') constants.INTERPOLATE_SHARED_LIGHT = host.settings.lightReuseInterpolate;
            host._pipelines[key] = await create(key, rayModule, raymarch, constants);
            pipelines[ray] = { key, height };
        });
        let bakeKey;
        if (description.bake) {
            bakeKey = `cloudsCache:${mode}:bake`;
            const bakeModule = this.device.createShaderModule({ label: `clouds ${mode} bake`, code: description.bake });
            promises.push(create(bakeKey, bakeModule, bake)
                .then(pipeline => { host._pipelines[bakeKey] = pipeline; }));
        }
        await Promise.all(promises);
        if (this.disposed) return false;

        const views = [];
        const groups = description.dimensions?.map(d => Math.ceil(d / description.group));
        for (let i = 0; i < (description.count ?? 0); i++) {
            const texture = this.device.createTexture({
                label: `clouds ${mode} cache ${i}`, size: description.dimensions, dimension,
                format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            });
            this.textures.push(texture);
            views.push(texture.createView());
        }
        const bakeGroup = bakeKey ? this.group(bake, [...host._noiseResources, ...views]) : null;
        this.variants.set(mode, { pipelines, raymarch, views, bakeKey, bakeGroup, groups });
        return true;
    }

    group(layout, resources) {
        return this.device.createBindGroup({ layout, entries: resources.map((resource, binding) => ({ binding, resource })) });
    }

    dispatch(encoder, mode, ray, target, width, height) {
        const cache = this.variants.get(mode);
        if (!cache) return false;
        const host = this.host;
        const pipeline = cache.pipelines[ray];
        if (!pipeline) return false;
        if (cache.bakeGroup) {
            const transport = usesTransport(mode);
            const light = mode === 'light' || transport;
            const key = JSON.stringify([host.settings, host.planet.radiusKm, host._cacheGrid, host._windShape,
                host._evolve, host.weather?.presence, host.weather?.deck, host.weather?.rainShade,
                light ? [host.sunDirection, host._boil, host.windDirection, host._windDetail] : null,
                transport ? [host.moonDirection, host.moonIlluminance > 0] : null]);
            if (cache.key !== key) {
                const [x, y, z] = cache.groups;
                host._dispatch(encoder, cache.bakeKey, cache.bakeGroup, x, y, `${mode} cache`, z);
                cache.key = key;
            }
        }

        let bindGroup = target.raymarch;
        if (cache.views.length) {
            const scene = host._sceneDepthView ?? host._dummyDepthView;
            const prior = this.bindings.get(target);
            if (prior?.mode === mode && prior.scene === scene) {
                bindGroup = prior.group;
            } else {
                const outputs = target.views ?? [target.colorView, target.depthView];
                bindGroup = this.group(cache.raymarch, [...host._noiseResources, host._cloudLightView, host._ambientView,
                    host._lutSampler, ...outputs, scene, ...cache.views]);
                this.bindings.set(target, { mode, scene, group: bindGroup });
            }
        }
        host._dispatch(encoder, pipeline.key, bindGroup, Math.ceil(width / 8), Math.ceil(height / pipeline.height), 'raymarch');
        return true;
    }

    dispose() {
        this.disposed = true;
        for (const texture of this.textures) texture.destroy();
        this.textures = [];
    }
}
