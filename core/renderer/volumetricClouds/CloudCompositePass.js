// @ts-nocheck
import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL,
} from './shaders/cloudCommon.wgsl.js';
import {
    CLOUD_HAZE_LOOKUP_WGSL, CLOUD_HAZE_STRUCT_WGSL, CLOUD_MIST_LIGHT_WGSL, CLOUD_MIST_LOOKUP_WGSL, CLOUD_RAY_LOOKUP_WGSL,
    CLOUD_SURFACE_VISIBILITY_WGSL, buildCloudUpsample,
} from './shaders/cloudCompositeParts.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './shaders/cloudCompositeUniforms.wgsl.js';
import { LOCAL_MIST_LOOKUP_WGSL, LOCAL_VOLUME_UNIFORMS_WGSL } from './shaders/cloudLocalVolumes.wgsl.js';
import { CloudGodRays } from './CloudGodRays.js';
import { LOCAL_VOLUME_FLOATS } from './CloudLocalVolumes.js';
import { CloudLeanComposite } from './CloudLeanComposite.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

const HAZE_STEPS = 8;
const HAZE_GRID = [48, 30, 24];
// Ground mist along a view ray: rays that meet the ground, then rays that do not, by fraction of the path in the layer.
const MIST_GRID = [2 * 64, 32];
const GROUND_MIST_UNIFORM = 46 * 4;

/**
 * Composites VolumetricCloudsModule output into a host's HDR scene colour, after the opaque
 * scene. The host's atmosphere (Bruneton-parametrised transmittance LUT plus its scattering
 * coefficients, in world units) hazes the clouds, so they fade into the host's sky:
 *
 *   scene' = T * shadow * scene + hazeT * cloudL + (1 - T) * hazeL
 *
 * where T is cloud transmittance and haze runs from the camera to the cloud. Drawn with
 * blending (src one, dst src-alpha), so the scene colour is not read in the shader.
 * Cloud shadows darken opaque pixels by `shadowStrength`, keeping `shadowFloor` of the light
 * for the ambient part; haze in front of distant ground is left unshadowed.
 */
export class CloudCompositePass {
    constructor(clouds, { colorFormat, shadowStrength = 0.6, shadowFloor = 0.45 } = {}) {
        this.clouds = clouds;
        this.colorFormat = colorFormat;
        this.shadowStrength = shadowStrength;
        this.shadowFloor = shadowFloor;
        this.gpuTimer = null;
        this._uniforms = new Float32Array(36);
        this._groups = new Map();
        this._groupInputs = [];
    }

    async initialize(device) {
        this.device = device;
        const module = device.createShaderModule({ label: 'clouds composite', code: buildCloudCompositeShader() });
        const info = await module.getCompilationInfo?.();
        const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
        if (errors.length) throw new Error(`clouds composite WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
        const F = GPUShaderStage.FRAGMENT;
        const entries = [
            { buffer: { type: 'uniform' }, visibility: F | GPUShaderStage.VERTEX },
            { buffer: { type: 'uniform' } },
            { texture: { sampleType: 'float' } },
            { texture: { sampleType: 'unfilterable-float' } },
            { texture: { sampleType: 'depth' } },
            { texture: { sampleType: 'float' } },
            { texture: { sampleType: 'float' } },
            { sampler: { type: 'filtering' } },
        ];
        const layout = bindings => device.createBindGroupLayout({
            entries: bindings.map((entry, binding) => ({ binding, visibility: F, ...entry })),
        });
        this._layout = layout(entries);
        const render = (module, bindGroupLayout) => device.createRenderPipelineAsync({
            label: 'clouds composite',
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module, entryPoint: 'vsMain' },
            fragment: {
                module, entryPoint: 'fsMain',
                targets: [{
                    format: this.colorFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
        const budget = device.createShaderModule({ label: 'clouds composite with haze lookup', code: buildCloudCompositeShader(true) });
        const hazeTexture = { texture: { sampleType: 'float', viewDimension: '3d' } };
        const budgetEntries = [...entries, hazeTexture, hazeTexture, { texture: { sampleType: 'float' } }, { sampler: { type: 'non-filtering' } }];
        budgetEntries.push({ binding: 16, ...hazeTexture }, { binding: 17, buffer: { type: 'uniform' } },
            { binding: 18, texture: { sampleType: 'float' } }, { binding: 19, texture: { sampleType: 'float' } }, { binding: 20, ...hazeTexture });
        this._budgetLayout = layout(budgetEntries);
        this._raysLayout = layout([...budgetEntries, { binding: 15, ...hazeTexture }]);
        // Stand-ins where there is no mist on the ground.
        this._noMist = device.createTexture({
            label: 'no cloud local mist', size: [1, 1, 1], dimension: '3d', format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: this._noMist }, new Uint16Array([0, 0, 0, 0x3c00]), { bytesPerRow: 8 }, [1, 1, 1]);
        this._noMistView = this._noMist.createView();
        this._noLocal = device.createBuffer({ label: 'no cloud local volumes', size: LOCAL_VOLUME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM });
        this._noCirrus = device.createTexture({ label: 'no cirrus', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
        this._noCirrusView = this._noCirrus.createView();
        this._renderPipeline = render;
        this._pointSampler = device.createSampler();
        const bake = entryPoint => device.createComputePipelineAsync({
            label: `clouds ${entryPoint}`, layout: 'auto', compute: { module: budget, entryPoint },
        });
        [this._pipeline, this._budgetPipeline, this._hazePipeline, this._mistPipeline] = await Promise.all([
            render(module, this._layout), render(budget, this._budgetLayout), bake('bakeHaze'), bake('bakeMist'),
        ]);
        this._uniformBuffer = device.createBuffer({
            label: 'clouds composite uniforms', size: this._uniforms.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    /** The god rays of this frame, or null. Compiles them the first time they are wanted. */
    _wantedGodRays() {
        const clouds = this.clouds;
        const tier = clouds.budgetTier;
        if (!clouds.settings.godRays || tier.godRays === false || tier.cirrusOnly || !(clouds.shadowFade > 0)) return null;
        this._rayShare = 1;
        if (tier.godRaysBelow) {
            // Fades out from a little below the clouds' base up.
            const x = Math.min(1, Math.max(0, Math.hypot(...clouds._prev.pos) - clouds.planet.radiusKm - clouds.settings.cloudBottomKm + 0.3));
            this._rayShare = 1 - x * x * (3 - 2 * x);
            if (this._rayShare <= 0) return null;
        }
        this._godRays ??= {};
        const detail = tier.godRays ?? 'high';
        if (!this._godRays[detail]) {
            const rays = this._godRays[detail] = new CloudGodRays(this.device, detail);
            rays.initialize().catch(error => console.error('God rays are unavailable', error));
        }
        if (!tier.lean && !this._raysCompiling) {
            const module = this.device.createShaderModule({ label: 'clouds composite with god rays', code: buildCloudCompositeShader(true, true) });
            this._raysCompiling = this._renderPipeline(module, this._raysLayout).then(pipeline => { this._raysPipeline = pipeline; })
                .catch(error => console.error('God rays are unavailable', error));
        }
        return this._godRays[detail].ready && (tier.lean || this._raysPipeline) ? this._godRays[detail] : null;
    }

    _bakeHaze(encoder, out, a) {
        if (!this._hazeTextures) {
            this._hazeTextures = ['radiance', 'transmittance'].map(label => this.device.createTexture({
                label: `cloud haze ${label}`, size: HAZE_GRID, dimension: '3d', format: 'rgba16float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            }));
            this._hazeTextures.push(this.device.createTexture({
                label: 'cloud ground mist', size: MIST_GRID, format: 'rgba16float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            }));
            this._hazeViews = this._hazeTextures.map(texture => texture.createView());
        }
        const inputs = [out.uniformBuffer, a.transmittanceView, out.linearSampler];
        if (!this._hazeGroup || inputs.some((input, i) => input !== this._hazeInputs[i])) {
            this._hazeInputs = inputs;
            this._hazeKey = null;
            this._hazeGroup = this.device.createBindGroup({
                layout: this._hazePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: out.uniformBuffer } },
                    { binding: 1, resource: { buffer: this._uniformBuffer } },
                    { binding: 6, resource: a.transmittanceView },
                    { binding: 7, resource: out.linearSampler },
                    { binding: 12, resource: this._hazeViews[0] },
                    { binding: 13, resource: this._hazeViews[1] },
                ],
            });
            this._mistGroup = this.device.createBindGroup({
                layout: this._mistPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: out.uniformBuffer } },
                    { binding: 1, resource: { buffer: this._uniformBuffer } },
                    { binding: 14, resource: this._hazeViews[2] },
                ],
            });
        }
        const c = this.clouds;
        const mist = c._uniformData.subarray(GROUND_MIST_UNIFORM, GROUND_MIST_UNIFORM + 4);
        // Without clouds only the mist table is read, and it depends on the camera's height alone.
        const mistOnly = !!c.budgetTier?.cirrusOnly;
        const key = JSON.stringify(mistOnly ? ['mist', ...this._uniforms.subarray(16, 24), ...mist]
            : [c._prev, c.sunDirection, c.sunIlluminance, c.moonDirection, c.moonIlluminance,
                a.planetRadius, a.atmosphereRadius, a.scaleHeightRayleigh, a.scaleHeightMie, a.rayleighScattering,
                a.mieScattering, a.mieAnisotropy, a.sunIntensity, ...mist]);
        if (key === this._hazeKey) return;
        this._hazeKey = key;
        if (mistOnly && !(this._uniforms[18] > 0)) return;
        const pass = encoder.beginComputePass({ label: 'clouds haze lookup', timestampWrites: this.gpuTimer?.timestampWrites('clouds haze lookup') });
        if (!mistOnly) {
            pass.setPipeline(this._hazePipeline);
            pass.setBindGroup(0, this._hazeGroup);
            pass.dispatchWorkgroups(Math.ceil(HAZE_GRID[0] / 8), Math.ceil(HAZE_GRID[1] / 4), HAZE_GRID[2]);
        }
        if (this._uniforms[18] > 0) {
            pass.setPipeline(this._mistPipeline);
            pass.setBindGroup(0, this._mistGroup);
            pass.dispatchWorkgroups(MIST_GRID[0] / 32);
        }
        pass.end();
    }

    // Constants of the mist table for this camera height: where rays meet the layer and the ground, and the shortest and
    // longest path through the layer for rays that meet the ground and for rays that do not.
    _mistUniforms() {
        const clouds = this.clouds;
        const [strength, top, , extinction] = clouds._uniformData.subarray(GROUND_MIST_UNIFORM, GROUND_MIST_UNIFORM + 4);
        const R = clouds.planet.radiusKm;
        const r = Math.hypot(...clouds._prev.pos);
        const inside = r < top;
        const reach = Math.sqrt((top - R) * (top + R));
        const horizon = Math.sqrt(Math.max(0, (r - R) * (r + R)));
        const ground = inside ? [r - R, horizon] : [top - R, reach];
        const sky = inside ? [top - r, horizon + reach] : [0, 2 * reach];
        const range = ([lo, hi]) => [lo, 1 / Math.max(hi - lo, 1e-4)];
        return [(r - top) * (r + top), (r - R) * (r + R), strength > 0.001 && r > R ? strength * extinction : 0, 0,
            ...range(ground), ...range(sky)];
    }

    /**
     * Encode the composite into `encoder` (outside any render pass). The cloud module must have
     * run compute() for this frame with the same scene depth.
     * @param {GPUCommandEncoder} encoder
     * @param {object} target colorView (load/store), depthView (scene depth), width, height
     * @param {object} atmosphere transmittanceView, planetRadius, atmosphereRadius, scaleHeightRayleigh,
     *   scaleHeightMie, rayleighScattering [r, g, b], mieScattering, mieAnisotropy, sunIntensity (world units)
     * @param {object} cirrus far and near views (premultiplied) for the tiers whose composite draws the cirrus
     */
    render(encoder, { colorView, depthView, width, height }, atmosphere, cirrus = null) {
        const out = this.clouds.getOutputs();
        const a = atmosphere;
        const budget = !!this.clouds.budgetTier;
        const unitsPerKm = this.clouds.planet.unitsPerKm;
        const rays = budget ? this._wantedGodRays() : null;
        this._uniforms.set([
            width, height, this.shadowStrength, unitsPerKm,
            a.planetRadius, a.atmosphereRadius, a.scaleHeightRayleigh, a.scaleHeightMie,
            ...a.rayleighScattering, a.mieScattering,
            a.mieAnisotropy, a.sunIntensity, this.shadowFloor,
            budget ? Math.max(64, a.atmosphereRadius / unitsPerKm + Math.hypot(...this.clouds._prev.pos)) : 0,
            ...this._mistUniforms(), ...CloudGodRays.uniforms(this.clouds.settings,
                rays ? rays.nextBlend(this.clouds._prev.pos, this.clouds.sunDirection, this.clouds.frameSeconds) : 1, this._rayShare),
        ]);
        this.device.queue.writeBuffer(this._uniformBuffer, 0, this._uniforms);
        if (budget) this._bakeHaze(encoder, out, a);
        if (rays) {
            rays.encode(encoder, out, this._uniformBuffer, a.transmittanceView,
                `${this._hazeKey}${this.clouds.shadowVersion}${this._uniforms.subarray(24, 33)}`, this.gpuTimer);
        }
        const tier = this.clouds.budgetTier;
        const volumes = this.clouds._localVolumes;
        const mistView = budget && tier.mist ? volumes?.encodeMist(encoder, this.gpuTimer) : null;
        const fogView = budget && tier.fog ? volumes?.encodeFog(encoder, this._hazeViews.slice(0, 2), this._uniformBuffer, this.gpuTimer) : null;
        const local = {
            view: mistView ?? this._noMistView, fogView: fogView ?? this._noMistView,
            buffer: mistView || fogView ? volumes.uniformBuffer : this._noLocal,
        };
        if (tier?.lean) {
            this._lean ??= new CloudLeanComposite(this.device, this.colorFormat);
            const screen = this._lean.ready(!tier.cirrusOnly, !!cirrus?.near, !!rays);
            if (screen) {
                this._lean.encode(encoder, screen, {
                    out, clouds: !tier.cirrusOnly, colorView, depthView, width, height, cirrus,
                    compositeBuffer: this._uniformBuffer, hazeViews: this._hazeViews, gpuTimer: this.gpuTimer, local, rayView: rays?.view ?? null,
                });
            }
            // Without clouds there is nothing for the full composite to draw while the pipeline compiles.
            if (screen || tier.cirrusOnly) return;
        }
        // The cloud history ping-pongs (and may switch interleave), so a few groups are kept per input set.
        const inputs = [depthView, a.transmittanceView, local.view, local.fogView, local.buffer, cirrus?.far, cirrus?.near];
        if (inputs.some((v, i) => v !== this._groupInputs[i]) || this._groups.size > 8) {
            this._groupInputs = inputs;
            this._groups.clear();
        }
        // While the lean composite compiles, the full one draws the frame without god rays.
        const withRays = rays && !tier.lean;
        const version = `${out.version}:${!!withRays}`;
        let group = this._groups.get(version);
        if (!group) {
            const resources = [
                { buffer: out.uniformBuffer }, { buffer: this._uniformBuffer },
                out.colorView, out.depthView, depthView, out.shadowView, a.transmittanceView, out.linearSampler,
            ];
            if (budget) resources.push(...this._hazeViews, this._pointSampler);
            const entries = resources.map((resource, binding) => ({ binding, resource }));
            if (budget) {
                entries.push({ binding: 16, resource: local.view }, { binding: 17, resource: { buffer: local.buffer } },
                    { binding: 18, resource: cirrus?.far ?? this._noCirrusView }, { binding: 19, resource: cirrus?.near ?? this._noCirrusView }, { binding: 20, resource: local.fogView });
            }
            if (withRays) entries.push({ binding: 15, resource: rays.view });
            group = this.device.createBindGroup({
                label: 'clouds composite', layout: withRays ? this._raysLayout : budget ? this._budgetLayout : this._layout, entries,
            });
            this._groups.set(version, group);
        }
        const pass = encoder.beginRenderPass({
            label: 'clouds composite',
            colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
            timestampWrites: this.gpuTimer?.timestampWrites('clouds composite'),
        });
        pass.setViewport(0, 0, width, height, 0, 1);
        pass.setPipeline(withRays ? this._raysPipeline : budget ? this._budgetPipeline : this._pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
    }

    dispose() {
        this._uniformBuffer?.destroy();
        for (const rays of Object.values(this._godRays ?? {})) rays.dispose();
        this._lean?.dispose();
        this._noMist?.destroy();
        this._noLocal?.destroy();
        this._noCirrus?.destroy();
        for (const texture of this._hazeTextures ?? []) texture.destroy();
        this._groups.clear();
    }
}

/** budget: with the haze and mist lookups of the fast previews; godRays (needs budget): with the volume of CloudGodRays. */
export function buildCloudCompositeShader(budget = false, godRays = false) {
    return /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_COMPOSITE_UNIFORMS_WGSL}${AERIAL_PERSPECTIVE_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> cu: CompositeUniforms;
@group(0) @binding(2) var cloudColor: texture_2d<f32>;
@group(0) @binding(3) var cloudDepth: texture_2d<f32>;
@group(0) @binding(4) var sceneDepth: texture_depth_2d;
@group(0) @binding(5) var shadowMap: texture_2d<f32>;
@group(0) @binding(6) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
${budget ? /* wgsl */`
@group(0) @binding(8) var hazeRadiance: texture_3d<f32>;
@group(0) @binding(9) var hazeTransmittance: texture_3d<f32>;
@group(0) @binding(10) var mistTable: texture_2d<f32>;
@group(0) @binding(11) var pointSampler: sampler;
@group(0) @binding(12) var outHazeL: texture_storage_3d<rgba16float, write>;
@group(0) @binding(13) var outHazeT: texture_storage_3d<rgba16float, write>;
@group(0) @binding(14) var outMist: texture_storage_2d<rgba16float, write>;
${godRays ? '@group(0) @binding(15) var rayVolume: texture_3d<f32>;' : ''}
@group(0) @binding(16) var localMist: texture_3d<f32>;
@group(0) @binding(17) var<uniform> local: LocalVolumes;
@group(0) @binding(18) var cirrusFar: texture_2d<f32>;
@group(0) @binding(19) var cirrusNear: texture_2d<f32>;
@group(0) @binding(20) var mountainFog: texture_3d<f32>;
${LOCAL_VOLUME_UNIFORMS_WGSL}${LOCAL_MIST_LOOKUP_WGSL}
` : ''}
${CLOUD_SHADOW_LOOKUP_WGSL}

struct VsOut {
    @builtin(position) pos: vec4f,
    ${budget ? '@location(0) ray: vec3f, // view ray of view depth 1' : ''}
}

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
    var o: VsOut;
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
    ${budget ? `o.ray = u.camRight.xyz * ((o.pos.x + u.camBack.w) / u.camRight.w)
        + u.camUp.xyz * ((o.pos.y + u.frameInfo.x) / u.camUp.w) - u.camBack.xyz;` : ''}
    return o;
}

${CLOUD_HAZE_STRUCT_WGSL}
// Single scattering and transmittance from the camera to distKm along rd, in the host's
// atmosphere (world units). Positions are planet-relative.
fn hazeTo(roKm: vec3f, rd: vec3f, distKm: f32) -> Haze {
    var h: Haze;
    h.T = vec3f(1.0);
    h.L = vec3f(0.0);
    let R = cu.atmo0.x;
    let Ra = cu.atmo0.y;
    let ro = roKm * cu.viewport.w;
    let atmo = raySphere(ro, rd, Ra);
    let t0 = max(atmo.x, 0.0);
    let t1 = min(atmo.y, distKm * cu.viewport.w);
    if (atmo.x > atmo.y || t1 <= t0) { return h; }
    let dt = (t1 - t0) / f32(${HAZE_STEPS});
    let cosSun = dot(rd, u.sun.xyz);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, cu.atmo2.x);
    // Moonlit air: the moon's share of the haze, relative to the sun (u.moon.w / u.sun.w). Sun-only
    // haze went to black at night, so far clouds kept full contrast and read as cut-outs.
    let moonScale = select(0.0, u.moon.w / max(u.sun.w, 1.0e-6), u.moon.w > 0.0 && u.sun.w > 1.0e-3);
    let cosMoon = dot(rd, u.moon.xyz);
    let phaseRMoon = ap_rayleighPhase(cosMoon);
    let phaseMMoon = ap_miePhase(cosMoon, cu.atmo2.x);
    let H = Ra - R;
    for (var i = 0; i < ${HAZE_STEPS}; i++) {
        let p = ro + rd * (t0 + (f32(i) + 0.5) * dt);
        let r = length(p);
        let alt = clamp(r - R, 0.0, H);
        let d = ap_getDensity(alt, cu.atmo0.z, cu.atmo0.w);
        let scatR = cu.atmo1.xyz * d.x;
        let scatM = cu.atmo1.w * d.y;
        let ext = scatR + vec3f(scatM);
        // The LUT has no planet shadow; fade the sun across the terminator like the host's terrain haze.
        let cosSun = dot(p / r, u.sun.xyz);
        let sunT = ap_sampleTransmittance(transmittanceLut, linearSampler, alt, cosSun, R, Ra)
            * smoothstep(-0.08, 0.08, cosSun);
        var S = (scatR * phaseR + vec3f(scatM * phaseM)) * sunT;
        if (moonScale > 0.0) {
            let cosMoonZ = dot(p / r, u.moon.xyz);
            let moonT = ap_sampleTransmittance(transmittanceLut, linearSampler, alt, cosMoonZ, R, Ra)
                * smoothstep(-0.08, 0.08, cosMoonZ) * moonScale;
            S += (scatR * phaseRMoon + vec3f(scatM * phaseMMoon)) * moonT;
        }
        let stepT = exp(-ext * dt);
        h.L += h.T * S * (1.0 - stepT) / max(ext, vec3f(1.0e-12));
        h.T *= stepT;
    }
    h.L *= cu.atmo2.y;
    return h;
}

${budget ? /* wgsl */`
@compute @workgroup_size(8, 4)
fn bakeHaze(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outHazeL);
    if (any(id >= size)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
    let rd = cameraRay(uv, vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let slice = f32(id.z) / f32(size.z - 1u);
    let depth = exp2(slice * log2(1.0 + cu.atmo2.w)) - 1.0;
    let haze = hazeTo(u.camPos.xyz, rd, depth);
    textureStore(outHazeL, id, vec4f(haze.L, 0.0));
    textureStore(outHazeT, id, vec4f(haze.T, 0.0));
}

fn mistDensity(altitude: f32) -> f32 {
    let height = u.groundMist.y - u.planet.x;
    return exp(-altitude / u.groundMist.z) * (1.0 - smoothstep(0.65 * height, height, altitude));
}

// Mist along the part of a ray inside its layer, for the camera's height. Only the ray's elevation matters, so one row per
// path length covers every pixel (see _mistUniforms; b is the ray's height gain, camera radius times the elevation's sine).
@compute @workgroup_size(32)
fn bakeMist(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outMist);
    if (id.x >= size.x) { return; }
    let half = size.x / 2u;
    let meetsGround = id.x < half;
    let range = select(cu.mistPath.zw, cu.mistPath.xy, meetsGround);
    let path = max(range.x + f32(id.x % half) / f32(half - 1u) / range.y, 1.0e-4);
    let top = cu.mistRay.x;
    let ground = cu.mistRay.y;
    var b: f32;
    var start = 0.0;
    if (top < 0.0) {
        b = -(select(top, ground, meetsGround) + path * path) / (2.0 * path);
    } else {
        let halfChord = select(0.5 * path, 0.5 * (path + (ground - top) / path), meetsGround);
        b = -sqrt(top + halfChord * halfChord);
        start = -b - halfChord;
    }
    let r2 = ground + u.planet.x * u.planet.x;
    let step = path / f32(4u * (size.y - 1u));
    var depth = 0.0;
    for (var row = 0u; row < size.y; row++) {
        textureStore(outMist, vec2u(id.x, row), vec4f(depth, 0.0, 0.0, 0.0));
        for (var i = 0u; i < 4u; i++) {
            let t = start + (f32(4u * row + i) + 0.5) * step;
            depth += step * mistDensity(max(0.0, sqrt(r2 + t * (2.0 * b + t)) - u.planet.x));
        }
    }
}

${CLOUD_MIST_LOOKUP_WGSL}
${CLOUD_HAZE_LOOKUP_WGSL}` : ''}

${godRays ? CLOUD_RAY_LOOKUP_WGSL : ''}

${CLOUD_SURFACE_VISIBILITY_WGSL}
// Optical depth up to the cloud and up to the camera's opaque scene hit.
// Integrating the curved boundary layer makes nearby hills break through the
// haze while longer rays through the low country accumulate more of it.
fn groundMistDepths(ro: vec3f, rd: vec3f, sceneKm: f32, cloudKm: f32) -> vec2f {
    let layer = raySphere(ro, rd, u.groundMist.y);
    let ground = raySphere(ro, rd, u.planet.x);
    let start = max(layer.x, 0.0);
    var end = min(layer.y, sceneKm);
    if (ground.x < ground.y && ground.y > 0.0) { end = min(end, max(0.0, ground.x)); }
    if (start >= end) { return vec2f(0.0); }
    let step = (end - start) / 8.0;
    let height = u.groundMist.y - u.planet.x;
    var path = vec2f(0.0);
    for (var i = 0; i < 8; i++) {
        let a = start + f32(i) * step;
        let altitude = max(0.0, length(ro + rd * (a + 0.5 * step)) - u.planet.x);
        let density = exp(-altitude / u.groundMist.z) * (1.0 - smoothstep(0.65 * height, height, altitude));
        path += density * vec2f(clamp(cloudKm - a, 0.0, step), step);
    }
    return path * (u.groundMist.x * u.groundMist.w);
}

${CLOUD_MIST_LIGHT_WGSL}
${buildCloudUpsample(budget)}
@fragment
fn fsMain(input: VsOut) -> @location(0) vec4f {
    let pix = input.pos.xy;
    let size = cu.viewport.xy;
    let uv = pix / size;
    let ro = u.camPos.xyz;

    let z = textureLoad(sceneDepth, vec2i(pix), 0);
    let opaque = z < 1.0;
    let cloudSize = vec2i(textureDimensions(cloudColor));
    let blocks = ${budget ? 'cloudSize' : 'vec2i(textureDimensions(cloudDepth))'};
    let k = ${budget ? '1' : 'max(i32(u.quality.x), 1)'};
    var cloudSample: UpsampledCloud;
    if (all(cloudSize == vec2i(size))) {
        // Pixel centres coincide. Only the centre tap has nonzero weight.
        let tp = vec2i(pix);
        cloudSample = UpsampledCloud(textureLoad(cloudColor, tp, 0), abs(cloudDepthAt(tp, blocks, k)));
    } else {
        cloudSample = upsampleCloud(uv, cloudSize, blocks, k, opaque);
    }
    let c = cloudSample.color;
    let cloud = vec4f(max(c.rgb, vec3f(0.0)), saturate(c.a));

    let shadowsOn = opaque && cu.viewport.z > 0.0 && u.shadowInfo.z > 0.0;
    let mistOn = ${budget ? 'cu.mistRay.z > 0.0' : 'u.groundMist.x > 0.001 && u.groundMist.w > 0.0'};
    let localOn = ${budget ? 'local.mist.x > 0.0' : 'false'};
    let fogOn = ${budget ? 'max(local.fog.x, local.drift.w) > 0.0' : 'false'};
    // One texel stands for no cirrus, or cirrus drawn by the host.
    let cirrusOn = ${budget ? 'textureDimensions(cirrusFar).x > 1u || textureDimensions(cirrusNear).x > 1u' : 'false'};
    ${godRays ? '' : 'if (cloud.a > 0.999 && !shadowsOn && !mistOn && !localOn && !fogOn && !cirrusOn) { discard; }'}
    ${budget ? /* wgsl */`
    let rayLength = length(input.ray);
    let rd = input.ray / rayLength;
    ` : /* wgsl */`
    let rd = cameraRay(pix, size, u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    `}
    var sceneKm = 1.0e30;
    if (opaque) {
        let viewDepth = u.sceneDepth.y / (z + u.sceneDepth.x);
        sceneKm = viewDepth * u.sceneDepth.z ${budget ? '* rayLength' : '/ max(-dot(rd, u.camBack.xyz), 1.0e-4)'};
    }

    var shadow = 1.0;
    if (shadowsOn) {
        let lit = cloudShadowSmoothAt(ro + rd * sceneKm, cu.viewport.z);
        if (lit < 1.0) { shadow = mix(1.0, mix(cu.atmo2.z, 1.0, lit), surfaceVisibility(ro, rd, sceneKm)); }
    }
    ${godRays ? '' : 'if (cloud.a > 0.999 && shadow > 0.999 && !mistOn && !localOn && !fogOn && !cirrusOn) { discard; }'}

    var color = vec3f(0.0);
    var transmittance = cloud.a;
    var cloudKm = sceneKm;
    if (cloud.a < 0.999) {
        cloudKm = min(sceneKm, cloudSample.depth);
        let haze = ${budget ? 'lookupHaze(uv, cloudKm)' : 'hazeTo(ro, rd, cloudKm)'};
        // Toward the horizon the distant cloud field loses contrast into the
        // host sky. Fade its premultiplied colour and opacity together.
        let cloudHeight = (length(ro) - u.planet.y) / (u.planet.z - u.planet.y);
        // Fast previews keep the distant fade independent of eye height within the atmosphere.
        let below = select(1.0 - smoothstep(0.0, 0.45, cloudHeight), 0.35 * (1.0 - u.lod.x), u.budget.w >= 1.5);
        let distant = smoothstep(u.banks.z * 0.64, u.banks.z * 1.8, cloudKm);
        let visible = 1.0 - 0.78 * u.banks.x * below * distant * (1.0 - 0.84 * u.weatherStyle.y);
        ${godRays ? /* wgsl */`let front = lookupRays(uv, cloudKm);
        color = (haze.T * cloud.rgb + (1.0 - cloud.a) * (haze.L * front.a + front.rgb)) * visible;` : /* wgsl */`
        color = (haze.T * cloud.rgb + (1.0 - cloud.a) * haze.L) * visible;`}
        transmittance = 1.0 - (1.0 - cloud.a) * visible;
    }
    ${godRays ? /* wgsl */`
    if (transmittance > 0.001) {
        // The scene behind holds the host's unshadowed haze: all of the sky, and what the ground loses to the air before it.
        let behind = lookupRays(uv, sceneKm);
        var hazy = 1.0;
        if (opaque) { hazy = 1.0 - surfaceVisibility(ro, rd, sceneKm); }
        color += behind.rgb * transmittance;
        transmittance *= 1.0 - (1.0 - behind.a) * hazy;
    }
    ` : ''}
    ${budget ? /* wgsl */`if (fogOn) {
        let foggy = addMountainFog(vec4f(color, transmittance), uv, sceneKm, cloudKm);
        color = foggy.rgb;
        transmittance = foggy.a;
    }` : ''}
    if (mistOn) {
        let depths = ${budget ? 'mistDepths' : 'groundMistDepths'}(ro, rd, sceneKm, cloudKm);
        if (depths.y > 0.001) {
            let T = exp(-depths);
            // Part of the mist lies behind the clouds and is masked by their opacity.
            let veil = mix(1.0 - T.x, 1.0 - T.y, transmittance);
            color = color * T.x + groundMistLight(ro, rd) * veil;
            transmittance *= T.y;
        }
    }
    ${budget ? /* wgsl */`
    if (localOn) {
        let near = localMistTo(uv, sceneKm);
        color = near.rgb + near.a * color;
        transmittance *= near.a;
    }
    if (cirrusOn) {
        if (!opaque) {
            let far = textureSampleLevel(cirrusFar, linearSampler, uv, 0.0);
            color += transmittance * far.rgb;
            transmittance *= 1.0 - far.a;
        }
        let over = textureSampleLevel(cirrusNear, linearSampler, uv, 0.0);
        color = over.rgb + (1.0 - over.a) * color;
        transmittance *= 1.0 - over.a;
    }
    ` : ''}
    return vec4f(color, transmittance * shadow);
}
`;
}
