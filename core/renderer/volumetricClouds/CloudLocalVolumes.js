// @ts-nocheck
import { CloudLandMap } from './CloudLandMap.js';
import { CLOUD_LOCAL_MIST_WGSL, CLOUD_MOUNTAIN_FOG_WGSL } from './shaders/cloudLocalVolumes.wgsl.js';

/** Look of the clouds on mountains and of the mist; settings.localVolumeLook overrides single values. */
export const LOCAL_VOLUME_LOOK = Object.freeze({
    fogAmount: 1, fogExtinction: 8, fogReachKm: 18, fogFirstKm: 2.5, fogOpacity: 0.85, summits: 1,
    mistAmount: 1, mistExtinction: 7, mistReachKm: 1.8, mistFirstKm: 0.02, mistOpacity: 0.55,
    mistWetland: 1, mistForest: 0.7, mistHollow: 0.4, mistBanks: 1.6,
    windShare: 1, windMax: 0.018, lifeSeconds: 20,
});
/** Size of LocalVolumes (shaders/cloudLocalVolumes.wgsl.js). */
export const LOCAL_VOLUME_FLOATS = 24;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Small volumes that belong to places: fog on mountains, and mist on marsh, in woods and in hollows. The composite reads both.
 * Tier fields fog and mist (cloudDetailTiers.js) set their detail.
 */
export class CloudLocalVolumes {
    constructor(host, options) {
        this.host = host;
        this.device = host.device;
        this.land = new CloudLandMap(host.device, options);
        this._pipelines = {};
        this._wind = [0, 0, 0];
        this._drift = [0, 0, 0];
        this._clock = 0;
    }

    async initialize() {
        const device = this.device;
        const C = GPUShaderStage.COMPUTE;
        const uniform = { buffer: { type: 'uniform' } };
        const tex = (sampleType, viewDimension = '2d') => ({ texture: { sampleType, viewDimension } });
        const linear = { sampler: { type: 'filtering' } };
        const store = { storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } };
        const layout = entries => device.createBindGroupLayout({ entries: entries.map((e, binding) => ({ binding, visibility: C, ...e })) });
        const f = tex('float');
        const f3 = tex('float', '3d');
        this._fogLayout = layout([uniform, f3, linear, linear, f, f, f, uniform, uniform, store, f, uniform, f, uniform, f3, f3, f]);
        this._mistLayout = layout([uniform, f3, linear, linear, f, f, f, uniform, uniform, store, f]);
        this._fogModule = device.createShaderModule({ label: 'clouds mountain fog', code: CLOUD_MOUNTAIN_FOG_WGSL });
        this._mistModule = device.createShaderModule({ label: 'clouds local mist', code: CLOUD_LOCAL_MIST_WGSL });
        this.uniformBuffer = device.createBuffer({
            label: 'cloud local volumes', size: LOCAL_VOLUME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.uniforms = new Float32Array(LOCAL_VOLUME_FLOATS);
        await this.land.initialize();
        this.ready = true;
    }

    _compile(name, module, layout, constants) {
        if (name in this._pipelines) return this._pipelines[name];
        this._pipelines[name] = null;
        this.device.createComputePipelineAsync({
            label: `clouds ${name}`, layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: { module, entryPoint: 'main', constants },
        }).then(pipeline => { this._pipelines[name] = pipeline; })
            .catch(error => console.error('Local cloud volumes are unavailable', error));
        return null;
    }

    _group(key, layout, resources) {
        this._groups ??= new Map();
        const entry = this._groups.get(key);
        if (entry && entry.resources.every((r, i) => (r.buffer ?? r) === (resources[i].buffer ?? resources[i]))) return entry.group;
        if (this._groups.size > 16) this._groups.clear();
        const group = this.device.createBindGroup({ layout, entries: resources.map((resource, binding) => ({ binding, resource })) });
        this._groups.set(key, { resources, group });
        return group;
    }

    // The wind near the ground, level at the camera, follows the host's slowly, so that nothing it carries jerks.
    _updateWind(look, cameraKm) {
        const host = this.host;
        const dt = Math.min(0.25, Math.max(0, host.frameSeconds || 0));
        const l = Math.hypot(...cameraKm);
        const along = host.windDirection.reduce((sum, x, i) => sum + x * cameraKm[i] / l, 0);
        const level = host.windDirection.map((x, i) => x - along * cameraKm[i] / l);
        const speed = Math.min(look.windMax, look.windShare * Math.max(2, host.windSpeed ?? 10) / 1000) / Math.max(0.25, Math.hypot(...level));
        const share = this._windSet ? 1 - Math.exp(-dt / 6) : 1;
        this._windSet = true;
        for (let i = 0; i < 3; i++) {
            this._wind[i] += (level[i] * speed - this._wind[i]) * share;
            this._drift[i] += this._wind[i] * dt;
        }
        this._clock += dt / look.lifeSeconds;
    }

    /** Refreshes the land maps and the uniforms for this frame. */
    update(encoder, { tileStreamer, heightScaleKm }) {
        this.active = { fog: false, mist: false };
        if (!this.ready) return;
        const host = this.host;
        const cameraKm = host._prev.pos;
        const planetRadiusKm = host.planet.radiusKm;
        this.land.update(encoder, { tileStreamer, cameraKm, planetRadiusKm, heightScaleKm });
        const tier = host.tier;
        const s = host.settings;
        const look = { ...LOCAL_VOLUME_LOOK, ...s.localVolumeLook };
        const weather = host.weather;
        const altitude = Math.hypot(...cameraKm) - planetRadiusKm;
        const { wide, near } = this.land.maps;
        const mu = host.sunDirection.reduce((sum, x, i) => sum + x * cameraKm[i], 0) / Math.hypot(...cameraKm);
        this._updateWind(look, cameraKm);
        // Fog only in weather that is wet down here. In fair weather, at most a small cloud on a summit.
        const misty = weather?.mist ?? 0;
        const wet = Math.min(1, 1.1 * Math.max(0, misty - 0.18) + 0.4 * (weather?.rainShade ?? 0) * (weather?.deck ?? 0) + 0.3 * (weather?.low ?? 0));
        const low = s.mountainClouds && tier.fog && altitude < 16;
        const fog = low && wet > 0.02 ? wet * look.fogAmount * tier.fog.amount : 0;
        const summits = low ? (1 - smoothstep(0.1, 0.5, wet)) * (0.35 + 0.5 * (weather?.presence ?? 1)) * look.summits * tier.fog.amount : 0;
        // Mist gathers at night and burns off in the sun; wet weather keeps it.
        const hour = 1 - 0.72 * smoothstep(0.05, 0.45, mu);
        const damp = Math.min(1, hour + 0.6 * (weather?.mist ?? 0));
        const mist = s.localMist && tier.mist && altitude < 7 ? look.mistAmount * tier.mist.amount : 0;
        this.active = { fog: (fog > 0 || summits > 0) && wide?.version > 0, mist: mist > 0 && near?.version > 0 };
        this.uniforms.set([
            this.active.fog ? fog : 0, look.fogExtinction, look.fogReachKm, look.fogOpacity,
            this.active.mist ? mist : 0, look.mistExtinction, look.mistReachKm, look.mistFirstKm,
            look.mistWetland, look.mistForest, look.mistHollow, damp,
            look.mistOpacity, look.fogFirstKm, look.mistBanks * smoothstep(0.2, 0.75, misty), look.lifeSeconds,
            ...this._wind, this._clock, ...this._drift, this.active.fog ? summits : 0,
        ]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms);
    }

    _volume(name, grid) {
        this._volumes ??= {};
        const volume = this._volumes[name];
        if (volume?.grid === grid) return volume.view;
        volume?.texture.destroy();
        const texture = this.device.createTexture({
            label: `cloud local ${name}`, size: [...grid], dimension: '3d', format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._volumes[name] = { grid, texture, view: texture.createView() };
        return this._volumes[name].view;
    }

    _fill(encoder, name, pipeline, layout, grid, resources, gpuTimer) {
        const label = `clouds ${name}`;
        const pass = encoder.beginComputePass({ label, timestampWrites: gpuTimer?.timestampWrites(label) });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._group(name, layout, resources));
        pass.dispatchWorkgroups(Math.ceil(grid[0] / 8), Math.ceil(grid[1] / 8));
        pass.end();
    }

    /** Fills the volume of fog on mountains. haze: radiance and transmittance views. Returns its view, or null without fog. */
    encodeFog(encoder, haze, compositeBuffer, gpuTimer) {
        if (!this.active?.fog) return null;
        const host = this.host;
        const tier = host.tier;
        const { grid, FLOW_REACH } = tier.fog;
        const pipeline = this._compile(`mountain fog ${FLOW_REACH}`, this._fogModule, this._fogLayout, { FLOW_REACH });
        if (!pipeline) return null;
        const view = this._volume('fog', grid);
        const { wide, middle } = this.land.maps;
        const [u, shape, , , noiseSampler] = host._noiseResources;
        this._fill(encoder, 'mountain fog', pipeline, this._fogLayout, grid, [
            u, shape, noiseSampler, host._linearSampler, host._cloudLightView, host._shadowView, wide.view, { buffer: wide.frame },
            { buffer: this.uniformBuffer }, view, middle.view, { buffer: middle.frame }, this.land.reliefView, { buffer: compositeBuffer }, ...haze,
            host.landShadeView,
        ], gpuTimer);
        return view;
    }

    /** Fills the mist volume. Returns its view, or null without mist. */
    encodeMist(encoder, gpuTimer) {
        if (!this.active?.mist) return null;
        const host = this.host;
        const { grid } = host.tier.mist;
        const pipeline = this._compile('local mist', this._mistModule, this._mistLayout);
        if (!pipeline) return null;
        const view = this._volume('mist', grid);
        const { near } = this.land.maps;
        const [u, shape, , , noiseSampler] = host._noiseResources;
        this._fill(encoder, 'local mist', pipeline, this._mistLayout, grid, [
            u, shape, noiseSampler, host._linearSampler, host._cloudLightView, host._shadowView, near.view, { buffer: near.frame },
            { buffer: this.uniformBuffer }, view, host.landShadeView,
        ], gpuTimer);
        return view;
    }

    dispose() {
        this.land.dispose();
        for (const { texture } of Object.values(this._volumes ?? {})) texture.destroy();
        this.uniformBuffer?.destroy();
    }
}
