// @ts-nocheck
import { CLOUD_RAY_VOLUME_WGSL, GOD_RAY_LEVELS, GOD_RAY_SIZES, buildRayFilterShader, buildRayTableShader } from './shaders/cloudGodRays.wgsl.js';

/** Look of the god rays; settings.godRayLook overrides single values. */
export const GOD_RAY_LOOK = Object.freeze({
    beam: 0.45, // light scattered by the thin haze that shows the beams (1/km)
    gaps: 3, // darkening between the beams
    shadow: 0.7, // share of the host's haze that cloud shadows take away; the rest is light scattered more than once
    extinction: 0.2, // share of the cloud extinction that blocks a beam (clouds scatter mostly forward)
    forward: 0.78, // phase of the beams: they are brightest towards the sun
    isotropic: 0.08,
    fade: 0.03, // how quickly the beams fade over distance (1/km)
    heightKm: 5, // height scale of the beam haze
    reachKm: 120,
});

// How long the beams take to follow. Under a low sun they sweep across the land within seconds in a short day: slower there.
const BLEND_SECONDS = Object.freeze({ high: 0.35, low: 1.4 });

/**
 * Crepuscular rays below the clouds, from the cloud shadow map (shaders/cloudGodRays.wgsl.js). Writes a volume over
 * screen and distance: rgb light to add up to that distance, a the share of the host's haze that the sun reaches.
 */
export class CloudGodRays {
    constructor(device, detail = 'high') {
        this.device = device;
        this._sizes = GOD_RAY_SIZES[detail];
        this._key = null;
    }

    async initialize() {
        const device = this.device;
        const build = async (label, code) => {
            const module = device.createShaderModule({ label, code });
            const info = await module.getCompilationInfo?.();
            const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
            if (errors.length) throw new Error(`${label} WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
            return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
        };
        const { table, volume } = this._sizes;
        [this._tablePipeline, this._filterPipeline, this._volumePipeline] = await Promise.all([
            build('clouds god ray table', buildRayTableShader(table[0])), build('clouds god ray filter', buildRayFilterShader(table[1])),
            build('clouds god rays', CLOUD_RAY_VOLUME_WGSL),
        ]);
        const texture = (label, size, dimension, format) => device.createTexture({
            label, size, dimension, format,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._textures = [texture('cloud ray table', table, '2d', 'r32float'),
            texture('cloud ray filtered table', [table[0] / 2, table[1] / 2, GOD_RAY_LEVELS], '3d', 'rgba16float'),
            texture('cloud ray volume', volume, '3d', 'rgba16float')];
        [this._tableView, this._filteredView, this.view] = this._textures.map(t => t.createView());
        this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeV: 'repeat' });
        this.ready = true;
    }

    /** Values for CompositeUniforms.rays and rays2. */
    static uniforms(settings, blend = 1, share = 1) {
        const look = { ...GOD_RAY_LOOK, ...settings.godRayLook };
        return [look.beam * share, look.shadow * share, look.reachKm, look.extinction, look.forward, look.isotropic, look.heightKm, look.gaps,
            look.fade, blend, 0, 0];
    }

    /** Share of this frame's table in the blended one: all of it after a jump of the camera or the sun. */
    nextBlend(cameraKm, sun, deltaTime) {
        const last = this._last;
        this._last = { cameraKm: [...cameraKm], sun: [...sun] };
        const jump = !last || Math.hypot(...cameraKm.map((x, i) => x - last.cameraKm[i])) > 2
            || sun.reduce((sum, x, i) => sum + x * last.sun[i], 0) < 0.998;
        const elevation = sun.reduce((sum, x, i) => sum + x * cameraKm[i], 0) / Math.hypot(...cameraKm);
        const share = Math.min(1, Math.max(0, (elevation - 0.1) / 0.2));
        const seconds = BLEND_SECONDS.low + (BLEND_SECONDS.high - BLEND_SECONDS.low) * share;
        return jump ? 1 : 1 - Math.exp(-Math.min(0.1, deltaTime || 0) / seconds);
    }

    encode(encoder, { uniformBuffer, shadowView, cloudLightView, linearSampler }, compositeBuffer, transmittanceView, key, gpuTimer) {
        if (key !== this._key) this._settled = 0;
        this._key = key;
        // Nothing has changed for long enough that the blend has arrived.
        if (++this._settled > 60) return;
        const inputs = [uniformBuffer, shadowView, compositeBuffer, transmittanceView];
        if (!this._inputs || inputs.some((input, i) => input !== this._inputs[i])) {
            this._inputs = inputs;
            const group = (pipeline, resources) => this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: Object.entries(resources).map(([binding, resource]) => ({ binding: Number(binding), resource })),
            });
            const u = { 0: { buffer: uniformBuffer } };
            const cu = { 1: { buffer: compositeBuffer } };
            this._groups = [
                group(this._tablePipeline, { ...u, ...cu, 2: shadowView, 3: this._tableView, 4: linearSampler }),
                group(this._filterPipeline, { 0: this._tableView, 1: this._filteredView }),
                group(this._volumePipeline, {
                    ...u, ...cu, 2: this._filteredView, 3: this.view, 4: linearSampler, 5: this._sampler, 6: transmittanceView,
                    7: cloudLightView,
                }),
            ];
        }
        const pass = encoder.beginComputePass({ label: 'clouds god rays', timestampWrites: gpuTimer?.timestampWrites('clouds god rays') });
        const run = (pipeline, group, ...size) => {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(...size);
        };
        const { table, volume } = this._sizes;
        run(this._tablePipeline, this._groups[0], table[1]);
        run(this._filterPipeline, this._groups[1], table[0] / 2);
        run(this._volumePipeline, this._groups[2], Math.ceil(volume[0] / 8), Math.ceil(volume[1] / 8));
        pass.end();
    }

    dispose() {
        for (const texture of this._textures ?? []) texture.destroy();
    }
}
