// @ts-nocheck
import { CLOUD_UNIFORM_VEC4_COUNT } from './shaders/cloudCommon.wgsl.js';
import { SHAPE_NOISE_WGSL, DETAIL_NOISE_WGSL, WEATHER_NOISE_WGSL, DOWNSAMPLE_3D_WGSL } from './shaders/cloudNoise.wgsl.js';
import {
    TRANSMITTANCE_LUT_WGSL, AMBIENT_LUT_WGSL, CLOUD_SHADOW_WGSL, CLOUD_RAYMARCH_WGSL, CLOUD_TEMPORAL_WGSL,
} from './shaders/cloudPasses.wgsl.js';

const SHAPE_SIZE = 128;
const DETAIL_SIZE = 64;
const WEATHER_SIZE = 128;
const SHADOW_SIZE = 256;
/** Order in which the pixels of a 2x2 block are refreshed (ordered dither). */
const INTERLEAVE_ORDER = [[0, 0], [1, 1], [1, 0], [0, 1]];

/** Live-tunable look parameters. Distances in km. */
export const DEFAULT_CLOUD_SETTINGS = Object.freeze({
    cloudBottomKm: 1.5,
    cloudTopKm: 6.0,
    coverage: 0.35,
    weatherContrast: 2.0,
    cloudType: 0.7,
    typeVariance: 1.4,
    systemTileKm: 3200,
    systemStrength: 1.6,
    systemWarp: 0.7,
    /** Slides the planet-scale pattern; pure seed, no physical meaning. */
    systemOffset: 1.3,
    extinction: 45,
    albedo: 0.99,
    detailErosion: 0.55,
    /** Shape-noise displacement of the detail lookup, in detail tiles; breaks up the tile lattice. */
    detailWarp: 1.0,
    shapeTileKm: 16,
    detailTileKm: 1.0,
    weatherTileKm: 110,
    largeWeatherTileKm: 420,
    windSpeedKmS: 0.025,
    windSkewKm: 0.8,
    timeScale: 1,
    phaseForward: 0.8,
    phaseBack: -0.25,
    backLobeWeight: 0.3,
    powder: 0.55,
    ambient: 1.0,
    msExtinction: 0.3,
    msScattering: 0.6,
    msPhase: 0.5,
    maxSteps: 192,
    minStepKm: 0.035,
    stepGrowth: 0.012,
    maxStepKm: 0.6,
    lightStepKm: 0.05,
    /** Sun-ray samples per lit step; each doubles in length (6 reach ~3 km). */
    lightSteps: 6,
    /**
     * false: no temporal reconstruction at all. Every pixel is marched every frame with a fixed
     * (not animated) jitter and a 3x3 tent filter; nothing to reproject, so nothing to smear or
     * shimmer from history, at about 4x the raymarch cost of interleave 2 and a static fine grain.
     */
    temporal: true,
    /** 1 marches every pixel each frame; 2 marches one pixel per 2x2 block and reconstructs the rest. */
    interleave: 2,
    /**
     * With interleave 2, march every pixel on frames where the camera moves fast (and a few after):
     * history is mostly rejected then, and quarter-rate samples show as blocks and shimmer.
     */
    fullRateOnMotion: true,
    /** Estimated cloud motion on screen (cloud-target pixels per frame) that switches to full rate. */
    motionThresholdPx: 1.5,
    /** Weight of a fresh sample in the history (per sample; interleave keeps the time constant). */
    temporalBlend: 0.08,
    /** Minimum weight of fresh samples while the camera moves fast: history is mostly stale then, and leaning on it smears and keeps interleave artefacts. */
    motionBlend: 0.5,
    /** History is clamped to the fresh neighbourhood mean ± this many standard deviations. Wider ghosts, narrower shimmers. */
    historyClip: 1.25,
    /** Weather pattern evolution (km of noise space per second): systems form and dissolve, not just drift. */
    weatherEvolveKmS: 0.02,
    /** Cloud shapes rise through the layer at this speed (km/s), so cumulus slowly boil. */
    boilKmS: 0.004,
    resolutionScale: 0.5,
    /** Side of the cloud shadow map centred under the camera (256² texels). */
    shadowExtentKm: 160,
    /** Cloud shadows fade out between these heights above the cloud tops; the shadow pass stops above. */
    shadowFadeStartKm: 1.5,
    shadowFadeEndKm: 6,
    /**
     * Width of the planet-shadow edge on the clouds at dusk, in cos(sun angle) (0.006 ≈ the sun's
     * disc). Wider spreads the lit-to-dark change over the deck instead of a sweeping front.
     */
    twilightSoftness: 0.006,
    /**
     * Far LOD: well above the layer, replace the raymarch with a 4-slab proxy (no light march, no
     * jitter), crossfading over these heights above the cloud tops.
     */
    farProxy: false,
    proxyStartKm: 25,
    proxyEndKm: 70,
    // Use the proxy below this camera altitude too (km; 0 = off), crossfading into the raymarch
    // over the next groundProxyBlendKm (0 = abrupt switch).
    groundProxyBelowKm: 0,
    groundProxyBlendKm: 0.4,
    // Without temporal reconstruction: strength of a 3x3 tent over the cloud target (0 = off, 1 = full).
    spatialFilter: 1,
    /** Cloud target scale once the far proxy has fully taken over (it is ~5x cheaper per pixel); null keeps resolutionScale. */
    orbitResolutionScale: null,
    /**
     * Noise is blurred to at least this fraction of the march step, not just the pixel: long steps
     * over sharp noise give a sum that changes with every small camera move (shimmer).
     */
    stepFootprint: 0.5,
    /**
     * When the coarse march steps from air into cloud, bisect for the surface and march quarter
     * steps from it for one coarse step, so a deck's top is not cut into terraces along the step
     * planes (they slide as the camera moves). Costs a few samples per cloud entry.
     */
    refineEntry: true,
    /**
     * Steps normally grow with distance only (stepGrowth). With layerStepFit > 0, a ray that crosses
     * the layer in a short stretch (from above, or steeply) steps no coarser than its path through
     * the layer / (maxSteps × layerStepFit), so it uses that share of the step budget there. Costs more
     * samples on those rays; 0 = off.
     */
    layerStepFit: 0,
    /**
     * Where the per-region shape-noise offset (which keeps cloud cells off a grid) comes from.
     * 'regional': fast weather channels (suspected cause of shimmering vertical curtains through
     * clouds); 'slow': a blurred planet-scale lookup, varying over 50-200 km; 'none': no offset (test).
     */
    shapeOffset: 'regional',
    /**
     * Light sharing: the lighting (light march, sky visibility, ambient; most of a cloud sample's
     * cost) is computed at the first cloud sample after clear air and then every lightReuseSteps-th
     * sample, and reused in between. Shapes and density stay per sample. 1 = every sample.
     */
    lightReuseSteps: 1,
    /** Lighting is also recomputed once it is this far (km) behind along the ray: the far band's averaged density never clears, so a count alone could reuse it for kilometres. */
    lightReuseMaxKm: 1.0,
    /**
     * Extra atmospheric depth for the sunlight reaching clouds when the sun is low (1 = physical). A
     * planet with a scaled-down atmosphere reddens a low sun much less than Earth; raise this for
     * Earth-like dawn and dusk colours on the clouds. The sun from ~30 degrees up is unaffected.
     */
    sunsetDepth: 1,
    /**
     * Clouds' sunlight colour is read at this fraction of their altitude (1 = physical). A small planet's
     * air thins within a few km, so tall clouds sat above nearly all of it and stayed white at dusk.
     */
    sunsetAltitudeScale: 1,
    /**
     * 'cut': shape times height profile, then the coverage threshold (flat tops at one height, near
     * vertical sides at low coverage). 'domes': coverage on the shape, then the profile erodes from the
     * top, so each cloud's height follows its core density (rounded tops of varied height).
     */
    cloudShape: 'cut',
    /** Height scale of 'domes' clouds (1 = the cut profile's top; taller for towering fair-weather cumulus). */
    domeHeight: 1,
    /**
     * 'domes' only. Giant cells: the shape noise at giantScale x the shape tile gives a few much wider
     * clouds, taking giantShare of the coverage (0 = off), and their cores are scaled by giantHeight so
     * they also build taller. Mixes popcorn with cauliflower towers instead of one size of cloud.
     */
    giantShare: 0,
    giantHeight: 2.5,
    giantScale: 3,
    /** 'domes' only: typical height of small clouds above the base (km), so a thick layer for giants does not make them all tall. */
    popcornTopKm: 1.6,
    /** 'domes' only: how abruptly density rises at a cloud's edge (gain on the shape core; higher = crisper, fewer billows). */
    domeEdgeSharpness: 1.5,
    /** 'domes' only: strength of the 0.5-1 km cauliflower heads on cloud surfaces (0 = off). */
    domeHeads: 0.6,
    /** Extra sky light on clouds around sunset (0 = none): shaded sides mauve and blue-grey instead of brown. */
    duskSkyBoost: 0,
    /**
     * Horizon Zero Dawn's in-scattering probability (0 = off, 1 = full): less light scattered toward the
     * eye where the cloud is thin (more so toward its top) and near its base. Dark grooves between
     * billows and dark undersides.
     */
    inScatter: 0,
    /** Brightness compensation for inScatter (the probability is well below 1 on most of the visible skin). */
    inScatterGain: 2.5,
    /** Sky-light occlusion from the sides as well as above (0 = off, 1 = on; 3 more density samples per lit sample). */
    aoSide: 0,
    /**
     * Far, grazing samples fade from individual clouds to their average density as the pixel's
     * footprint along the layer (km, footprint / sin of the grazing angle) grows from farAverageStartKm
     * to farAverageEndKm. Sub-pixel clouds there otherwise alias and flicker as the camera moves.
     * farAverageEndKm 0 turns it off; farAverageDensity scales the average.
     */
    farAverageStartKm: 1.0,
    farAverageEndKm: 4.0,
    farAverageDensity: 0.2,
    debugSteps: false,
});

/** Earth's single-scattering atmosphere; hosts pass their own to match their sky. Per km. */
export const DEFAULT_CLOUD_ATMOSPHERE = Object.freeze({
    rayleighPerKm: [5.802e-3, 13.558e-3, 33.1e-3],
    rayleighScaleHeightKm: 8,
    miePerKm: 3.996e-3,
    mieExtinctionPerKm: 4.4e-3,
    mieScaleHeightKm: 1.2,
    mieG: 0.8,
    ozonePerKm: [0.65e-3, 1.881e-3, 0.085e-3],
    ozonePeakKm: 25,
    ozoneHalfWidthKm: 15,
    groundAlbedo: 0.25,
});

export const DEFAULT_CLOUD_PLANET = Object.freeze({
    radiusKm: 6360,
    atmosphereHeightKm: 100,
    /** World units per kilometre (1000 for a metre-based world). */
    unitsPerKm: 1,
    center: [0, 0, 0],
    atmosphere: DEFAULT_CLOUD_ATMOSPHERE,
});

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const smoothstep = (lo, hi, x) => {
    const t = Math.min(1, Math.max(0, (x - lo) / Math.max(hi - lo, 1e-6)));
    return t * t * (3 - 2 * t);
};

/**
 * Raymarched volumetric clouds on a spherical shell around a planet.
 * The module renders into its own reduced-resolution target; a compositor
 * samples getOutputs() (premultiplied cloud radiance, transmittance, depth,
 * cloud shadow map and the atmosphere LUTs it lights with).
 */
export class VolumetricCloudsModule {
    id = 'volumetric-clouds';

    constructor({ settings = {}, planet = {}, sunDirection = [0, 1, 0], sunIlluminance = 1, windDirection = [1, 0, 0] } = {}) {
        this.settings = { ...DEFAULT_CLOUD_SETTINGS, ...settings };
        this.planet = { ...DEFAULT_CLOUD_PLANET, ...planet };
        this.planet.atmosphere = { ...DEFAULT_CLOUD_ATMOSPHERE, ...planet.atmosphere };
        this.sunDirection = normalize(sunDirection);
        this.sunIlluminance = sunIlluminance;
        this.windDirection = normalize(windDirection);
        this.enabled = true;
        /** Optional GpuPassTimer (core/renderer/profiling) for per-pass GPU timings. */
        this.gpuTimer = null;
        this.outputVersion = 0;
        /** Current cloud-shadow strength (0..1) from camera height; also in the uniforms. */
        this.shadowFade = 1;
        /** Current far-proxy weight (0 raymarch .. 1 proxy). */
        this.proxyWeight = 0;
        this.farProxyWeight = 0;
        /** Radiance added to the clouds' ambient light (e.g. night sky and moonlight), linear RGB. */
        this.ambientFloor = [0, 0, 0];
        /** Moon as a second directional light (used while the sun is dim); illuminance 0 = off. */
        this.moonDirection = [0, -1, 0];
        this.moonIlluminance = 0;
        this._shadowFrame = null;
        this._evolve = 0;
        this._boil = 0;
        this._fullRateFrames = 0;
        this._activeK = 1;
        this._orbitRes = false;
        this._uniformData = new Float32Array(CLOUD_UNIFORM_VEC4_COUNT * 4);
        this._windShape = [0, 0, 0];
        this._windDetail = [0, 0, 0];
        this._prev = null;
        this._resetHistory = true;
        this._historyIndex = 0;
        this._frame = 0;
        this._lutKey = '';
        this._targetSize = [0, 0];
        this._sceneDepthView = null;
    }

    async initialize({ device, viewport }) {
        this.device = device;
        this.viewport = viewport;
        device.pushErrorScope('validation');
        this._createSamplersAndBuffers();
        this._createVolumes();
        await this._createPipelines();
        this._createStaticBindGroups();
        this._ensureTargets();
        this._generateNoise();
        const error = await device.popErrorScope();
        if (error) throw new Error(`Volumetric clouds initialisation failed: ${error.message}`);
    }

    resize(viewport) {
        this.viewport = viewport;
        this._ensureTargets();
    }

    /** Dropping history avoids smearing across teleports or large edits. */
    resetHistory() { this._resetHistory = true; }

    /**
     * Opaque scene depth (a depth texture view rendered with frame.camera's projection, [0, 1]
     * range, cleared to 1 for sky) at which the raymarch stops, so terrain hides the clouds
     * behind it. Bind it before compute() each frame; null marches to the planet sphere.
     */
    setSceneDepth(view) {
        if (view === this._sceneDepthView) return;
        this._sceneDepthView = view ?? null;
        if (this._sets) this._buildRaymarchGroup();
    }

    /** The shape and detail noise volumes (3D, rgba8unorm, R = Perlin-Worley / Worley fBm), for reuse by other effects. */
    getNoiseViews() {
        return { shape: this._shapeView, detail: this._detailView };
    }

    update(frame) {
        this.viewport = frame.viewport ?? this.viewport;
        this._ensureTargets();
        const s = this.settings;
        const dt = frame.deltaTime * s.timeScale;
        const wind = this.windDirection;
        // Sampling at p - wind*t moves features along +wind.
        for (let i = 0; i < 3; i++) {
            this._windShape[i] -= wind[i] * s.windSpeedKmS * dt;
            this._windDetail[i] -= wind[i] * s.windSpeedKmS * 1.6 * dt;
        }
        this._evolve += s.weatherEvolveKmS * dt;
        this._boil += s.boilKmS * dt;
        this._writeUniforms(frame);
    }

    compute(frame, encoder) {
        if (!this.enabled) return;
        const lutKey = JSON.stringify([this.planet.radiusKm, this.planet.atmosphereHeightKm, this.planet.atmosphere,
            this.settings.cloudBottomKm, this.settings.cloudTopKm, this.settings.twilightSoftness, this.settings.sunsetDepth]);
        if (lutKey !== this._lutKey) {
            this._lutKey = lutKey;
            this._dispatch(encoder, 'transmittance', this._bindGroups.transmittance, 256 / 8, 64 / 8);
            this._dispatch(encoder, 'ambient', this._bindGroups.ambient, 1, 3);
        }
        const [w, h] = this._targetSize;
        const set = this._sets[this._activeK];
        const [bw, bh] = set.blocks;
        const write = this._historyIndex;
        if (this.shadowFade > 0) this._dispatch(encoder, 'shadow', this._bindGroups.shadow, SHADOW_SIZE / 8, SHADOW_SIZE / 8);
        this._dispatch(encoder, 'raymarch', set.raymarch, Math.ceil(bw / 8), Math.ceil(bh / 8));
        this._dispatch(encoder, 'temporal', set.temporal[write], Math.ceil(w / 8), Math.ceil(h / 8));
        this._outputIndex = write;
        this._historyIndex = 1 - write;
        this._resetHistory = false;
        this._frame++;
    }

    /** Views for a compositor; `version` changes whenever views are recreated. */
    getOutputs() {
        const k = this._activeK;
        return {
            version: `${this.outputVersion}:${this._outputIndex ?? 0}:${k}`,
            /** Changes when depthView changes (resize, or switching between interleaved and full rate). */
            depthVersion: `${this.outputVersion}:${k}`,
            uniformBuffer: this._uniformBuffer,
            colorView: this._historyViews[this._outputIndex ?? 0],
            /** Raymarch-resolution cloud distance (km, r32float): one texel per interleave block. */
            depthView: this._sets[k].depthView,
            blockFactor: k,
            shadowView: this._shadowView,
            /** Scale cloud shadows by this; at 0 the shadow map is stale and must not be used. */
            shadowFade: this.shadowFade,
            transmittanceView: this._transmittanceView,
            ambientView: this._ambientView,
            lutSampler: this._lutSampler,
            linearSampler: this._linearSampler,
            size: [...this._targetSize],
        };
    }

    dispose() {
        const textures = [
            this._shape, this._detail, this._weather, this._transmittance, this._ambient, this._shadow,
            this._dummyDepth, ...this._setTextures(), ...(this._history ?? []),
        ];
        for (const texture of textures) texture?.destroy();
        this._uniformBuffer?.destroy();
    }

    // ---------------------------------------------------------------- setup

    _createSamplersAndBuffers() {
        const device = this.device;
        this._noiseSampler = device.createSampler({
            addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
            magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
        });
        this._lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this._linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this._uniformBuffer = device.createBuffer({
            label: 'clouds uniforms',
            size: this._uniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    _createVolumes() {
        const device = this.device;
        const volume = (label, size, mips) => device.createTexture({
            label, size: [size, size, size], dimension: '3d', format: 'rgba8unorm', mipLevelCount: mips,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        this._shape = volume('clouds shape noise', SHAPE_SIZE, Math.log2(SHAPE_SIZE) + 1);
        this._detail = volume('clouds detail noise', DETAIL_SIZE, Math.log2(DETAIL_SIZE) + 1);
        this._weather = volume('clouds weather noise', WEATHER_SIZE, Math.log2(WEATHER_SIZE) + 1);
        const lut = (label, width, height) => device.createTexture({
            label, size: [width, height], format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        this._transmittance = lut('clouds transmittance LUT', 256, 64);
        this._ambient = lut('clouds ambient LUT', 64, 3);
        this._shadow = lut('clouds shadow map', SHADOW_SIZE, SHADOW_SIZE);
        this._transmittanceView = this._transmittance.createView();
        this._ambientView = this._ambient.createView();
        this._shadowView = this._shadow.createView();
        this._shapeView = this._shape.createView({ dimension: '3d' });
        this._detailView = this._detail.createView({ dimension: '3d' });
        // Bound when no scene depth is set; the uniforms then tell the shader to ignore it.
        this._dummyDepth = device.createTexture({
            label: 'clouds no scene depth', size: [1, 1], format: 'depth24plus', usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        this._dummyDepthView = this._dummyDepth.createView();
    }

    async _createPipelines() {
        const device = this.device;
        const C = GPUShaderStage.COMPUTE;
        const uniform = { buffer: { type: 'uniform' } };
        const tex3d = { texture: { sampleType: 'float', viewDimension: '3d' } };
        const tex2d = { texture: { sampleType: 'float' } };
        const texUnfilterable = { texture: { sampleType: 'unfilterable-float' } };
        const texDepth = { texture: { sampleType: 'depth' } };
        const sampler = { sampler: { type: 'filtering' } };
        const store = (format, viewDimension = '2d') => ({ storageTexture: { access: 'write-only', format, viewDimension } });
        const layout = (entries) => device.createBindGroupLayout({
            entries: entries.map((entry, binding) => ({ binding, visibility: C, ...entry })),
        });
        const noise = [uniform, tex3d, tex3d, tex3d, sampler];
        this._layouts = {
            volume: layout([store('rgba8unorm', '3d')]),
            downsample: layout([tex3d, store('rgba8unorm', '3d')]),
            transmittance: layout([uniform, store('rgba16float')]),
            ambient: layout([uniform, tex2d, sampler, store('rgba16float')]),
            shadow: layout([...noise, store('rgba16float')]),
            raymarch: layout([...noise, tex2d, tex2d, sampler, store('rgba16float'), store('r32float'), texDepth]),
            temporal: layout([uniform, tex2d, texUnfilterable, tex2d, sampler, store('rgba16float')]),
        };
        const sources = {
            shapeNoise: [SHAPE_NOISE_WGSL, 'volume'],
            detailNoise: [DETAIL_NOISE_WGSL, 'volume'],
            weatherNoise: [WEATHER_NOISE_WGSL, 'volume'],
            downsample: [DOWNSAMPLE_3D_WGSL, 'downsample'],
            transmittance: [TRANSMITTANCE_LUT_WGSL, 'transmittance'],
            ambient: [AMBIENT_LUT_WGSL, 'ambient'],
            shadow: [CLOUD_SHADOW_WGSL, 'shadow'],
            raymarch: [CLOUD_RAYMARCH_WGSL, 'raymarch'],
            temporal: [CLOUD_TEMPORAL_WGSL, 'temporal'],
        };
        this._pipelines = {};
        await Promise.all(Object.entries(sources).map(async ([name, [code, layoutName]]) => {
            const module = device.createShaderModule({ label: `clouds ${name}`, code });
            const info = await module.getCompilationInfo?.();
            const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
            if (errors.length) {
                throw new Error(`clouds ${name} WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
            }
            this._pipelines[name] = await device.createComputePipelineAsync({
                label: `clouds ${name}`,
                layout: device.createPipelineLayout({ bindGroupLayouts: [this._layouts[layoutName]] }),
                compute: { module, entryPoint: 'main' },
            });
        }));
    }

    _createStaticBindGroups() {
        const device = this.device;
        const group = (layout, resources) => device.createBindGroup({
            layout: this._layouts[layout],
            entries: resources.map((resource, binding) => ({ binding, resource })),
        });
        this._noiseResources = [
            { buffer: this._uniformBuffer },
            this._shapeView,
            this._detailView,
            this._weather.createView({ dimension: '3d' }),
            this._noiseSampler,
        ];
        this._bindGroups = {
            transmittance: group('transmittance', [{ buffer: this._uniformBuffer }, this._transmittanceView]),
            ambient: group('ambient', [{ buffer: this._uniformBuffer }, this._transmittanceView, this._lutSampler, this._ambientView]),
            shadow: group('shadow', [...this._noiseResources, this._shadowView]),
        };
        this._group = group;
    }

    _setTextures() {
        return Object.values(this._sets ?? {}).flatMap(set => [set.color, set.depth]);
    }

    _ensureTargets() {
        const s = this.settings;
        // Switch resolution with hysteresis once the cheap far proxy has fully taken over. Only the
        // far (orbital) proxy: the near-ground proxy keeps resolutionScale, so it is as sharp as the
        // raymarch it crossfades into (at the orbit scale it was visibly crisper).
        if (s.farProxy && Number.isFinite(s.orbitResolutionScale)) {
            if (this.farProxyWeight >= 0.999) this._orbitRes = true;
            else if (this.farProxyWeight < 0.95) this._orbitRes = false;
        } else {
            this._orbitRes = false;
        }
        const wanted = this._orbitRes ? s.orbitResolutionScale : s.resolutionScale;
        const scale = Math.min(1, Math.max(0.2, wanted));
        const width = Math.max(1, Math.round(this.viewport.width * scale));
        const height = Math.max(1, Math.round(this.viewport.height * scale));
        const k = this._interleave();
        if (width === this._targetSize[0] && height === this._targetSize[1] && k === this._blockFactor) return;
        for (const texture of [...this._setTextures(), ...(this._history ?? [])]) texture?.destroy();
        const target = (label, format, w = width, h = height) => this.device.createTexture({
            label, size: [w, h], format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        this._history = [target('clouds history A', 'rgba16float'), target('clouds history B', 'rgba16float')];
        const historyViews = this._historyViews = this._history.map(texture => texture.createView());
        // The raymarch writes one sample per k x k block of the cloud target. With interleave 2 a
        // full-rate set (k = 1) is kept as well, for frames with fast camera motion.
        this._sets = {};
        for (const sk of k === 2 ? [1, 2] : [1]) {
            const blocks = [Math.ceil(width / sk), Math.ceil(height / sk)];
            const color = target(`clouds raymarch color k${sk}`, 'rgba16float', ...blocks);
            const depth = target(`clouds raymarch depth k${sk}`, 'r32float', ...blocks);
            const set = { k: sk, blocks, color, depth, colorView: color.createView(), depthView: depth.createView() };
            set.temporal = [0, 1].map(write => this._group('temporal', [
                { buffer: this._uniformBuffer }, set.colorView, set.depthView, historyViews[1 - write], this._linearSampler,
                historyViews[write],
            ]));
            this._sets[sk] = set;
        }
        this._buildRaymarchGroup();
        this._blockFactor = k;
        this._activeK = k;
        this._targetSize = [width, height];
        this._outputIndex = 0;
        this.outputVersion++;
        this._resetHistory = true;
    }

    _buildRaymarchGroup() {
        for (const set of Object.values(this._sets ?? {})) {
            set.raymarch = this._group('raymarch', [
                ...this._noiseResources, this._transmittanceView, this._ambientView, this._lutSampler,
                set.colorView, set.depthView, this._sceneDepthView ?? this._dummyDepthView,
            ]);
        }
    }

    // Rough screen motion of the cloud layer since last frame, in cloud-target pixels.
    _motionPixels(cam, prev, altitude, height) {
        const s = this.settings;
        const pxPerRadian = cam.proj[1] * height * 0.5;
        const rotation = Math.acos(Math.min(1, Math.max(-1, dot(cam.back, prev.back))));
        const mid = 0.5 * (s.cloudBottomKm + s.cloudTopKm);
        const distance = Math.max(Math.abs(altitude - mid), 0.5 * (s.cloudTopKm - s.cloudBottomKm), 0.3);
        return (rotation + Math.hypot(...sub(cam.pos, prev.pos)) / distance) * pxPerRadian;
    }

    _generateNoise() {
        const device = this.device;
        const encoder = device.createCommandEncoder({ label: 'clouds noise generation' });
        const pass = encoder.beginComputePass();
        const generate = (pipeline, texture, size) => {
            pass.setPipeline(this._pipelines[pipeline]);
            pass.setBindGroup(0, this._group('volume', [texture.createView({ dimension: '3d', baseMipLevel: 0, mipLevelCount: 1 })]));
            pass.dispatchWorkgroups(size / 4, size / 4, size / 4);
        };
        const mips = (texture, size) => {
            pass.setPipeline(this._pipelines.downsample);
            for (let level = 1; level < texture.mipLevelCount; level++) {
                const view = (mip) => texture.createView({ dimension: '3d', baseMipLevel: mip, mipLevelCount: 1 });
                pass.setBindGroup(0, this._group('downsample', [view(level - 1), view(level)]));
                const n = Math.max(1, Math.ceil((size >> level) / 4));
                pass.dispatchWorkgroups(n, n, n);
            }
        };
        generate('shapeNoise', this._shape, SHAPE_SIZE);
        generate('detailNoise', this._detail, DETAIL_SIZE);
        generate('weatherNoise', this._weather, WEATHER_SIZE);
        mips(this._shape, SHAPE_SIZE);
        mips(this._detail, DETAIL_SIZE);
        mips(this._weather, WEATHER_SIZE);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    _interleave() { return this.settings.interleave >= 2 ? 2 : 1; }

    _dispatch(encoder, pipeline, bindGroup, x, y) {
        const label = `clouds ${pipeline}`;
        const pass = encoder.beginComputePass({ label, timestampWrites: this.gpuTimer?.timestampWrites(label) });
        pass.setPipeline(this._pipelines[pipeline]);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(x, y);
        pass.end();
    }

    // ------------------------------------------------------------- uniforms

    _cameraState(camera) {
        const k = 1 / this.planet.unitsPerKm;
        const c = this.planet.center;
        const v = camera.matrixWorldInverse.elements;
        const p = camera.projectionMatrix.elements;
        return {
            pos: [(camera.position.x - c[0]) * k, (camera.position.y - c[1]) * k, (camera.position.z - c[2]) * k],
            right: [v[0], v[4], v[8]],
            up: [v[1], v[5], v[9]],
            back: [v[2], v[6], v[10]],
            proj: [p[0], p[5], p[8], p[9], p[10], p[14]],
        };
    }

    _writeUniforms(frame) {
        const s = this.settings;
        const R = this.planet.radiusKm;
        const atmo = this.planet.atmosphere;
        const cam = this._cameraState(frame.camera);
        const altitude = Math.hypot(...cam.pos) - R;
        let prev = this._prev ?? cam;
        // Teleports and big jumps would reproject garbage; start the history over.
        if (Math.hypot(...sub(cam.pos, prev.pos)) > Math.max(5, Math.abs(altitude) * 0.5)) {
            this._resetHistory = true;
            prev = cam;
        }
        const [width, height] = this._targetSize;
        const sun = this.sunDirection;
        const bottom = Math.min(s.cloudBottomKm, s.cloudTopKm - 0.1);

        // Cloud shadow map: the ground's tangent plane at an anchor under the camera, holding optical
        // depth along the sun. The plane stays fixed in the world while the sun moves and until the
        // camera has travelled a fair part of the extent; a sun-facing plane re-gridded every frame
        // made the shadows shimmer. Fixed extent: growing it with altitude coarsened shadows into
        // blocks. From above the layer the shadows fade out instead.
        const extent = s.shadowExtentKm;
        const aboveTops = altitude - s.cloudTopKm;
        this.shadowFade = 1 - smoothstep(s.shadowFadeStartKm, s.shadowFadeEndKm, aboveTops);
        this.farProxyWeight = s.farProxy ? smoothstep(s.proxyStartKm, s.proxyEndKm, aboveTops) : 0;
        this.proxyWeight = this.farProxyWeight;
        if (s.groundProxyBelowKm > 0) {
            const ground = s.groundProxyBlendKm > 0
                ? 1 - smoothstep(s.groundProxyBelowKm, s.groundProxyBelowKm + s.groundProxyBlendKm, altitude)
                : (altitude < s.groundProxyBelowKm ? 1 : 0);
            this.proxyWeight = Math.max(this.proxyWeight, ground);
        }
        const ground = normalize(cam.pos).map(x => x * R);
        let sf = this._shadowFrame;
        if (!sf || sf.extent !== extent || sf.R !== R || Math.hypot(...sub(ground, sf.anchor)) > extent * 0.15) {
            const n = normalize(cam.pos);
            const e1 = normalize(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
            sf = this._shadowFrame = { anchor: ground, e1, e2: cross(n, e1), extent, R };
        }
        const { e1, e2 } = sf;

        const d = sub(cam.pos, prev.pos);
        const baseK = this._blockFactor;
        let k = baseK;
        if (this._motionPixels(cam, prev, altitude, height) > s.motionThresholdPx) this._fullRateFrames = 8;
        const moving = this._fullRateFrames > 0;
        if (moving) {
            this._fullRateFrames--;
            if (s.fullRateOnMotion) k = 1;
        }
        if (!s.temporal) k = 1;
        this._activeK = k;
        const [ox, oy] = k === 2 ? INTERLEAVE_ORDER[this._frame % 4] : [0, 0];
        // At rest each pixel gets a fresh sample every baseK² frames, weighted to keep the history time
        // constant; while moving, fresh samples weigh at least motionBlend.
        const restBlend = Math.min(1, s.temporalBlend * baseK * baseK);
        const blend = this._resetHistory || !s.temporal ? 1 : (moving ? Math.max(restBlend, s.motionBlend) : restBlend);
        const data = this._uniformData;
        data.set([
            ...cam.pos, frame.time,
            ...cam.right, cam.proj[0],
            ...cam.up, cam.proj[1],
            ...cam.back, cam.proj[2],
            cam.proj[3], s.temporal ? this._frame : 0, width, height,
            ...prev.right, prev.proj[0],
            ...prev.up, prev.proj[1],
            ...prev.back, prev.proj[2],
            prev.proj[3], ...d,
            ...sun, this.sunIlluminance,
            R, R + bottom, R + s.cloudTopKm, R + this.planet.atmosphereHeightKm,
            1 / s.shapeTileKm, 1 / s.detailTileKm, 1 / s.weatherTileKm, 1 / s.largeWeatherTileKm,
            s.coverage, s.weatherContrast, s.cloudType, s.typeVariance,
            s.extinction, s.detailErosion, s.detailWarp, s.albedo,
            ...this._windShape, s.spatialFilter,
            ...this._windDetail, s.windSkewKm,
            s.phaseForward, s.phaseBack, s.backLobeWeight, s.powder,
            s.ambient, s.msExtinction, s.msScattering, s.msPhase,
            s.maxSteps, s.minStepKm, s.stepGrowth, s.maxStepKm,
            s.lightStepKm, 2 / (cam.proj[1] * height), blend, s.debugSteps ? 1 : 0,
            ...e1, extent,
            ...e2, 0,
            0, R, this.shadowFade, Math.max(0, s.layerStepFit || 0),
            ...this.windDirection, { slow: 1, none: 2 }[s.shapeOffset] ?? 0,
            1 / s.systemTileKm, s.systemStrength, s.systemWarp, s.systemOffset,
            k, ox, oy, Math.max(1, Math.round(s.lightSteps)),
            this.proxyWeight, this._evolve, this._boil, s.historyClip,
            ...atmo.rayleighPerKm, atmo.rayleighScaleHeightKm,
            atmo.miePerKm, atmo.mieExtinctionPerKm, atmo.mieScaleHeightKm, atmo.mieG,
            ...atmo.ozonePerKm, atmo.ozonePeakKm,
            atmo.ozoneHalfWidthKm, atmo.groundAlbedo, s.twilightSoftness, s.temporal ? 0 : 1,
            cam.proj[4], cam.proj[5], 1 / this.planet.unitsPerKm, this._sceneDepthView ? 1 : 0,
            ...this.ambientFloor, s.stepFootprint,
            s.refineEntry ? 1 : 0, s.farAverageStartKm, s.farAverageEndKm, s.farAverageDensity,
            ...normalize(this.moonDirection), this.moonIlluminance,
            Math.max(1, Math.round(s.lightReuseSteps || 1)), Math.max(0, s.lightReuseMaxKm ?? 1), s.cloudShape === 'domes' ? Math.max(0.6, s.domeHeight ?? 1) : 0, Math.max(0.1, s.sunsetDepth ?? 1),
            Math.max(0, s.giantShare ?? 0), Math.max(1, s.giantHeight ?? 2.5), Math.max(1, s.giantScale ?? 3),
            Math.min(0.92, Math.max(0.05, (s.popcornTopKm ?? 1.6) / Math.max(0.1, s.cloudTopKm - s.cloudBottomKm))),
            Math.max(0, s.inScatter ?? 0), Math.max(0, s.aoSide ?? 0), Math.max(0, s.inScatterGain ?? 2.5), Math.max(0.05, s.sunsetAltitudeScale ?? 1),
            Math.max(0.5, s.domeEdgeSharpness ?? 1.5), Math.max(0, s.domeHeads ?? 0.6), Math.max(0, s.duskSkyBoost ?? 0), 0,
        ]);
        this.device.queue.writeBuffer(this._uniformBuffer, 0, data);
        this._prev = cam;
    }
}
