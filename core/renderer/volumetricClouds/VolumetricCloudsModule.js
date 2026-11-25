// @ts-nocheck
import { CLOUD_UNIFORM_VEC4_COUNT } from './shaders/cloudCommon.wgsl.js';
import { SHADE_SIZE } from './CloudLandMap.js';
import { CloudLocalVolumes } from './CloudLocalVolumes.js';
import { CloudNeuralLighting } from './CloudNeuralLighting.js';
import { CLOUD_DETAIL_TIERS, DEFAULT_CLOUD_DETAIL } from './cloudDetailTiers.js';
import {
    SHAPE_NOISE_WGSL, DETAIL_NOISE_WGSL, WEATHER_NOISE_WGSL, DOWNSAMPLE_3D_WGSL, DOWNSAMPLE_3D_HQ_WGSL, NOISE_HQ_FORMAT,
} from './shaders/cloudNoise.wgsl.js';
import { AMBIENT_LUT_WGSL, TRANSMITTANCE_LUT_WGSL } from './shaders/cloudLuts.wgsl.js';
import { CLOUD_SHADOW_WGSL, CLOUD_WEATHER_CUBE_WGSL } from './shaders/cloudMarch.wgsl.js';
import { CLOUD_HISTORY_WGSL } from './shaders/cloudHistory.wgsl.js';
import { CLOUD_ORBIT_BLEND_WGSL, CLOUD_ORBIT_WGSL } from './shaders/cloudOrbit.wgsl.js';

const SHAPE_SIZE = 128;
const DETAIL_SIZE = 64;
const WEATHER_SIZE = 128;
const WEATHER_CUBE_SIZE = 256;
const SHADOW_SIZE = 256;
// The shadow map is redrawn in this many frames while it drifts (_nextShadowRows).
const SHADOW_SLICES = 4;
const LOW_CLOUD_UNIFORM = 45 * 4;
const HISTORY_STATE_UNIFORM = 49 * 4 + 2;

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
    /** Additional sky radiance per unit of sunlight, attenuated by cloud occlusion. */
    daylightSkyFill: 0,
    /** Gain on direct sunlight in clouds, adding slightly warm daylight. Fades toward 1 near the terminator. */
    daylightSunGain: 1,
    /** Softens and restores the energy of sunset light on clouds in the scaled atmosphere. */
    twilightCloudLight: 0,
    /** Fraction of distant cumulus replaced by a filtered, broken bank field. */
    distantBanks: 0,
    distantBanksStartKm: 15,
    distantBanksEndKm: 42,
    distantBanksTileKm: 18,
    /** Strength, heights, and horizontal scale of the broken altocumulus layer. */
    altoClouds: 0,
    altoBottomKm: 7.2,
    altoTopKm: 9,
    altoTileKm: 19,
    /** Separate stratus volume for low-cloud weather, measured above sea level. */
    lowCloudBottomKm: 0.78,
    lowCloudTopKm: 2.05,
    lowCloudTileKm: 11,
    /** Ground haze uses a thinner exponential profile than the main atmosphere. */
    groundMistTopKm: 1.35,
    groundMistScaleKm: 0.36,
    groundMistExtinction: 1.6,
    msExtinction: 0.3,
    msScattering: 0.6,
    msPhase: 0.5,
    lightStepKm: 0.05,
    /** Sun-ray samples per lit step; each doubles in length (6 reach ~3 km). */
    lightSteps: 6,
    /** 'high', 'medium' or 'low' (cirrus only): cloudDetailTiers.js. */
    cloudDetail: DEFAULT_CLOUD_DETAIL,
    /** Crepuscular rays below the clouds (CloudGodRays.js); godRayLook overrides its GOD_RAY_LOOK. */
    godRays: true,
    godRayLook: null,
    /** Clouds on mountain tops and mist on marsh, in woods and hollows (CloudLocalVolumes.js), where the host gives a land source. */
    mountainClouds: true,
    localMist: true,
    localVolumeLook: null,
    /** Depth-validated accumulation of jittered rays over frames. */
    reprojection: true,
    /** Weather pattern evolution (km of noise space per second): systems form and dissolve, not just drift. */
    weatherEvolveKmS: 0.02,
    /** Cloud shapes rise through the layer at this speed (km/s), so cumulus slowly boil. */
    boilKmS: 0.004,
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
    /** Well above the layer, a few slabs replace the raymarch (cloudOrbit.wgsl.js), between the tiers' orbit heights. */
    farProxy: false,
    /** Width of the transition of the detail erosion. */
    edgeSoftness: 0.045,
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
    /** Height scale of the cumulus (taller for towering fair-weather ones). */
    domeHeight: 1,
    /** Typical height of small clouds above the base (km). */
    popcornTopKm: 1.6,
    /** How abruptly density rises at a cloud's edge (gain on the shape core; higher = crisper, fewer billows). */
    domeEdgeSharpness: 1.5,
    /** Strength of the 0.5-1 km cauliflower heads on cloud surfaces (0 = off). */
    domeHeads: 0.6,
    /** Extra sky light on clouds around sunset (0 = none): shaded sides mauve and blue-grey instead of brown. */
    duskSkyBoost: 0,
    /** Detail noise is blurred to at least this many pixels (0 = off): sharper, thin fringes sparkle. */
    detailPixelFootprint: 0,
    /** The outer shell of each cloud is eroded with wispy noise (0 = off, 1 = full) instead of round billows. */
    edgeWisps: 0,
    /**
     * Multiplier on the coverage the host sets (weather). A soft, translucent look (low extinction,
     * strong erosion) moves each cloud's visible outline inward; this restores their apparent size.
     */
    coverageGain: 1,
    /** Density thins between puffs inside clouds (0 = uniform body, 1 = see-through pockets). */
    densityVariation: 0,
    /** Suppresses small puffs without nearby support from the broader shape field (0 = off). */
    isolatedPuffSuppression: 0,
    /**
     * Far, grazing samples fade from individual clouds to their average density as the pixel's
     * footprint along the layer (km, footprint / sin of the grazing angle) grows from farAverageStartKm
     * to farAverageEndKm. Sub-pixel clouds there otherwise alias and flicker as the camera moves.
     * farAverageEndKm 0 turns it off; farAverageDensity scales the average.
     */
    farAverageStartKm: 1.0,
    farAverageEndKm: 4.0,
    farAverageDensity: 0.2,
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
 * Volumetric clouds on a spherical shell around a planet, lit by small networks (CloudNeuralLighting.js).
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
        this.weather = null;
        this.sunDirection = normalize(sunDirection);
        this.sunIlluminance = sunIlluminance;
        this.windDirection = normalize(windDirection);
        this.enabled = true;
        /** Optional GpuPassTimer (core/renderer/profiling) for per-pass GPU timings. */
        this.gpuTimer = null;
        this.outputVersion = 0;
        /** Current cloud-shadow strength (0..1) from camera height; also in the uniforms. */
        this.shadowFade = 1;
        /** Current weight of the slabs seen from orbit (0 raymarch .. 1 slabs). */
        this.farProxyWeight = 0;
        /** Radiance added to the clouds' ambient light (e.g. night sky and moonlight), linear RGB. */
        this.ambientFloor = [0, 0, 0];
        /** Moon as a second directional light; illuminance 0 = off. */
        this.moonDirection = [0, -1, 0];
        this.moonIlluminance = 0;
        this._shadowFrame = null;
        /** Counts redraws of the shadow map. */
        this.shadowVersion = 0;
        this._evolve = 0;
        this._boil = 0;
        this._uniformData = new Float32Array(CLOUD_UNIFORM_VEC4_COUNT * 4);
        this._windShape = [0, 0, 0];
        this._windDetail = [0, 0, 0];
        this._prev = null;
        this._resetHistory = true;
        this._historyIndex = 0;
        this._frame = 0;
        this._lutKey = '';
        this._lastShadowInputs = null;
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
        this._neuralLighting = new CloudNeuralLighting(this);
        await this._neuralLighting.initialize();
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
        if (this._target) this._bindTarget();
    }

    /** The shape and detail noise volumes (3D, rgba16float, R = Perlin-Worley / Worley fBm), for reuse by other effects. */
    getNoiseViews() {
        return { shape: this._shapeView, detail: this._detailView };
    }

    update(frame) {
        this.viewport = frame.viewport ?? this.viewport;
        this._ensureTargets();
        const s = this.settings;
        /** Real seconds since the last frame. */
        this.frameSeconds = frame.deltaTime;
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

    /** The detail tier in use (cloudDetailTiers.js). */
    get tier() {
        const { cloudDetail } = this.settings;
        return CLOUD_DETAIL_TIERS[Object.hasOwn(CLOUD_DETAIL_TIERS, cloudDetail) ? cloudDetail : DEFAULT_CLOUD_DETAIL];
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
        const tier = this.tier;
        const lighting = this._neuralLighting;
        if (tier.cirrusOnly) {
            lighting.reset();
            this._frame++;
            return;
        }
        this._localVolumes?.land.encodeShade(encoder);
        const [width, height] = this._targetSize;
        const target = this._target;
        const orbit = this.farProxyWeight >= 0.999;
        const reconstruct = this._historyActive;
        const write = reconstruct ? this._historyIndex : 0;
        if (orbit) lighting.reset();
        else this._bakeWeatherCube(encoder);
        const shadowRows = this.shadowFade > 0 && !orbit ? this._nextShadowRows() : 0;
        if (shadowRows > 0) {
            this._dispatch(encoder, 'shadow', this._weatherCube.shadowGroup, SHADOW_SIZE / 8, shadowRows / 8);
            this.shadowVersion++;
        }
        const groups = [Math.ceil(width / 8), Math.ceil(height / 8)];
        if (orbit) {
            this._dispatch(encoder, 'orbit', target.orbit, ...groups);
        } else {
            lighting.dispatch(encoder);
            if (this._crossfade) {
                const blend = this._ensureBlend(target, width, height);
                lighting.dispatchMain(encoder, blend.raymarch, blend.resources, width, height, tier);
                this._dispatch(encoder, 'orbitBlend', blend.orbit, ...groups, 'orbit');
            } else {
                lighting.dispatchPairs(encoder, target, width, height, tier);
            }
        }
        if (reconstruct) {
            const history = this._ensureHistory(target, width, height);
            this._dispatch(encoder, 'history', history.groups[write], ...groups);
        }
        this._outputIndex = write;
        this._historyIndex = 1 - write;
        this._encodeLocalVolumes(encoder);
        this._resetHistory = false;
        this._frame++;
    }

    // How many rows of the cloud shadow map to redraw this frame. While the sun and the clouds drift slowly, a
    // quarter of it is redrawn each frame. Above 0.01 texels of movement a frame, which a day of about five minutes
    // reaches, the quarters would step visibly, so all of it is redrawn.
    _nextShadowRows() {
        const inputs = this._shadowInputs;
        const drift = this._shadowDrift;
        const state = this._lastShadowInputs === inputs ? this._shadowState : null;
        const step = state ? Math.max(...drift.map((value, i) => Math.abs(value - state.drift[i]))) : Infinity;
        this._lastShadowInputs = inputs;
        if (step > 0.01 * this.settings.shadowExtentKm / SHADOW_SIZE) {
            this._shadowState = { drift, stale: 0, next: 0 };
            if (step > 0) this._writeShadowRow(0);
            return step > 0 ? SHADOW_SIZE : 0;
        }
        if (step > 0) Object.assign(state, { drift, stale: SHADOW_SLICES });
        if (state.stale === 0) return 0;
        const rows = SHADOW_SIZE / SHADOW_SLICES;
        this._writeShadowRow(state.next * rows);
        state.stale--;
        state.next = (state.next + 1) % SHADOW_SLICES;
        return rows;
    }

    _writeShadowRow(row) {
        const index = LOW_CLOUD_UNIFORM + 3;
        this._uniformData[index] = row;
        this.device.queue.writeBuffer(this._uniformBuffer, index * 4, this._uniformData, index, 1);
    }

    /**
     * Terrain for the clouds and mist that belong to places: { tileStreamer(): the loaded terrain tiles, heightScaleKm,
     * tileCategories }. Without it there are none.
     */
    setLandSource(source) {
        this._landSource = source;
    }

    _encodeLocalVolumes(encoder) {
        const tier = this.tier;
        const tileStreamer = this._landSource?.tileStreamer();
        if (!tileStreamer || !(tier.fog || tier.mist)) return;
        if (!this._localVolumes) {
            this._localVolumes = new CloudLocalVolumes(this, { tileCategories: this._landSource.tileCategories, shade: this.landShadeView });
            this._localVolumes.initialize().catch(error => console.error('Local cloud volumes are unavailable', error));
        }
        this._localVolumes.update(encoder, { tileStreamer, heightScaleKm: this._landSource.heightScaleKm });
    }

    /** Views for a compositor; `version` changes whenever views are recreated. */
    getOutputs() {
        const resolved = this._historyActive;
        return {
            version: `${this.outputVersion}:${this._outputIndex ?? 0}:${resolved}`,
            uniformBuffer: this._uniformBuffer,
            colorView: resolved ? this._historyViews[this._outputIndex ?? 0] : this._target.colorView,
            /** Cloud distance (km, r32float), negative where the scene ended the ray. */
            depthView: this._target.depthView,
            shadowView: this._shadowView,
            /** Scale cloud shadows by this; at 0 the shadow map is stale and must not be used. */
            shadowFade: this.shadowFade,
            transmittanceView: this._transmittanceView,
            cloudLightView: this._cloudLightView,
            ambientView: this._ambientView,
            lutSampler: this._linearSampler,
            linearSampler: this._linearSampler,
            size: [...this._targetSize],
        };
    }

    dispose() {
        this._neuralLighting?.dispose();
        this._localVolumes?.dispose();
        const textures = [
            this._shape, this._detail, this._weather, this._transmittance, this._cloudLight, this._ambient, this._shadow,
            this._landShade, this._dummyDepth, ...this._targetTextures(), ...(this._weatherCube?.textures ?? []),
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
        this._linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this._pointSampler = device.createSampler();
        this._uniformBuffer = device.createBuffer({
            label: 'clouds uniforms',
            size: this._uniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    _createVolumes() {
        const device = this.device;
        const volume = (label, size, mips, format = 'rgba8unorm') => device.createTexture({
            label, size: [size, size, size], dimension: '3d', format, mipLevelCount: mips,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        this._shape = volume('clouds shape noise', SHAPE_SIZE, Math.log2(SHAPE_SIZE) + 1, NOISE_HQ_FORMAT);
        this._detail = volume('clouds detail noise', DETAIL_SIZE, Math.log2(DETAIL_SIZE) + 1, NOISE_HQ_FORMAT);
        this._weather = volume('clouds weather noise', WEATHER_SIZE, Math.log2(WEATHER_SIZE) + 1);
        const lut = (label, width, height) => device.createTexture({
            label, size: [width, height], format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        this._transmittance = lut('clouds transmittance LUT', 256, 64);
        this._cloudLight = lut('clouds direct light LUT', 256, 64);
        this._ambient = lut('clouds ambient LUT', 64, 3);
        this._shadow = lut('clouds shadow map', SHADOW_SIZE, SHADOW_SIZE);
        this._transmittanceView = this._transmittance.createView();
        this._cloudLightView = this._cloudLight.createView();
        this._ambientView = this._ambient.createView();
        this._shadowView = this._shadow.createView();
        this._landShade = lut('clouds land shade', SHADE_SIZE, SHADE_SIZE);
        /** How high the land's shadow reaches (CloudLandMap.js), for the light on the low clouds. */
        this.landShadeView = this._landShade.createView();
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
        const cube = { texture: { sampleType: 'float', viewDimension: 'cube' } };
        const tex2d = { texture: { sampleType: 'float' } };
        const texUnfilterable = { texture: { sampleType: 'unfilterable-float' } };
        const texDepth = { texture: { sampleType: 'depth' } };
        const sampler = { sampler: { type: 'filtering' } };
        const pointSampler = { sampler: { type: 'non-filtering' } };
        const store = (format, viewDimension = '2d') => ({ storageTexture: { access: 'write-only', format, viewDimension } });
        const layout = (entries) => device.createBindGroupLayout({
            entries: entries.map((entry, binding) => ({ binding, visibility: C, ...entry })),
        });
        const noise = [uniform, tex3d, tex3d, tex3d, sampler];
        const targets = [store('rgba16float'), store('r32float')];
        const orbit = [...noise, tex2d, tex2d, sampler, ...targets, texDepth];
        // Last the light patches, current and previous, where they lie, and the land's shadow.
        const raymarch = [...noise, tex2d, pointSampler, sampler, ...targets, texDepth, tex2d, cube, cube, tex3d, tex3d, uniform, tex2d];
        this._layouts = {
            volume: layout([store('rgba8unorm', '3d')]),
            downsample: layout([tex3d, store('rgba8unorm', '3d')]),
            volumeHQ: layout([store(NOISE_HQ_FORMAT, '3d')]),
            downsampleHQ: layout([tex3d, store(NOISE_HQ_FORMAT, '3d')]),
            transmittance: layout([uniform, store('rgba16float'), store('rgba16float')]),
            ambient: layout([uniform, tex2d, sampler, store('rgba16float')]),
            shadow: layout([...noise, store('rgba16float'), sampler, cube, cube]),
            raymarch: layout(raymarch),
            raymarchList: layout([...raymarch, { buffer: { type: 'read-only-storage' } }]),
            rayPairs: layout([uniform, tex2d, texUnfilterable, texDepth, ...targets, { buffer: { type: 'storage' } }, pointSampler]),
            lightBake: layout([...noise, sampler, cube, cube, store('rgba16float', '3d'), uniform]),
            weatherCube: layout([...noise, store('rgba16float', '2d-array'), store('rgba16float', '2d-array')]),
            history: layout([uniform, tex2d, texUnfilterable, tex2d, texUnfilterable, ...targets]),
            orbit: layout(orbit),
            orbitBlend: layout([...orbit, tex2d, texUnfilterable]),
        };
        const sources = {
            shapeNoise: [SHAPE_NOISE_WGSL, 'volumeHQ'],
            detailNoise: [DETAIL_NOISE_WGSL, 'volumeHQ'],
            weatherNoise: [WEATHER_NOISE_WGSL, 'volume'],
            downsample: [DOWNSAMPLE_3D_WGSL, 'downsample'],
            downsampleHQ: [DOWNSAMPLE_3D_HQ_WGSL, 'downsampleHQ'],
            transmittance: [TRANSMITTANCE_LUT_WGSL, 'transmittance'],
            ambient: [AMBIENT_LUT_WGSL, 'ambient'],
            shadow: [CLOUD_SHADOW_WGSL, 'shadow'],
            weatherCube: [CLOUD_WEATHER_CUBE_WGSL, 'weatherCube'],
            history: [CLOUD_HISTORY_WGSL, 'history'],
            orbit: [CLOUD_ORBIT_WGSL, 'orbit'],
            orbitBlend: [CLOUD_ORBIT_BLEND_WGSL, 'orbitBlend'],
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
                label: `clouds ${name}`, layout: device.createPipelineLayout({ bindGroupLayouts: [this._layouts[layoutName]] }),
                compute: { module, entryPoint: 'main' },
            });
        }));
    }

    _createStaticBindGroups() {
        const device = this.device;
        const group = this._group = (layout, resources) => device.createBindGroup({
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
            transmittance: group('transmittance', [
                { buffer: this._uniformBuffer }, this._transmittanceView, this._cloudLightView,
            ]),
            ambient: group('ambient', [{ buffer: this._uniformBuffer }, this._transmittanceView, this._linearSampler, this._ambientView]),
        };
        this._weatherCube = this._createWeatherCube();
    }

    // The weather over the whole planet, without wind and evolution, which the lookups add.
    _createWeatherCube() {
        const textures = ['field', 'shape offset'].map(name => this.device.createTexture({
            label: `clouds weather cube ${name}`, size: [WEATHER_CUBE_SIZE, WEATHER_CUBE_SIZE, 6], format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }));
        const views = textures.map(texture => texture.createView({ dimension: 'cube' }));
        const storage = textures.map(texture => texture.createView({ dimension: '2d-array' }));
        const group = this._group('weatherCube', [...this._noiseResources, ...storage]);
        const shadowGroup = this._group('shadow', [...this._noiseResources, this._shadowView, this._linearSampler, ...views]);
        return { textures, views, group, shadowGroup, key: null };
    }

    _bakeWeatherCube(encoder) {
        const cube = this._weatherCube;
        const s = this.settings;
        const key = JSON.stringify([this.planet.radiusKm, s.cloudBottomKm, s.systemTileKm, s.systemOffset,
            s.systemStrength, s.systemWarp, s.weatherTileKm, s.largeWeatherTileKm]);
        if (cube.key === key) return;
        cube.key = key;
        const groups = Math.ceil(WEATHER_CUBE_SIZE / 8);
        this._dispatch(encoder, 'weatherCube', cube.group, groups, groups, 'weather cube', 6);
    }

    _targetTextures() {
        const target = this._target;
        return target ? [target.color, target.depth, ...(target.blend?.textures ?? []), ...this._history, ...(this._historyDepths?.textures ?? [])] : [];
    }

    _createTarget(label, format, width, height) {
        return this.device.createTexture({
            label, size: [width, height], format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
    }

    _ensureTargets() {
        const scale = Math.min(0.5, Math.sqrt(this.tier.maxRays / (this.viewport.width * this.viewport.height)));
        const width = Math.max(1, Math.floor(this.viewport.width * scale));
        const height = Math.max(1, Math.floor(this.viewport.height * scale));
        if (width === this._targetSize[0] && height === this._targetSize[1]) return;
        for (const texture of this._targetTextures()) texture.destroy();
        this._historyDepths = null;
        this._history = ['A', 'B'].map(name => this._createTarget(`clouds history ${name}`, 'rgba16float', width, height));
        this._historyViews = this._history.map(texture => texture.createView());
        const color = this._createTarget('clouds raymarch color', 'rgba16float', width, height);
        const depth = this._createTarget('clouds raymarch depth', 'r32float', width, height);
        this._target = { color, depth, colorView: color.createView(), depthView: depth.createView() };
        this._bindTarget();
        this._targetSize = [width, height];
        this._outputIndex = 0;
        this.outputVersion++;
        this._resetHistory = true;
    }

    /** Resources of the raymarch (up to its light patches) that writes to these views. */
    _raymarchResources(views) {
        return [...this._noiseResources, this._cloudLightView, this._pointSampler, this._linearSampler, ...views,
            this._sceneDepthView ?? this._dummyDepthView, this._shadowView, ...this._weatherCube.views];
    }

    _orbitResources(views) {
        return [...this._noiseResources, this._cloudLightView, this._ambientView, this._linearSampler, ...views,
            this._sceneDepthView ?? this._dummyDepthView];
    }

    _bindTarget() {
        const target = this._target;
        const views = [target.colorView, target.depthView];
        target.resources = this._raymarchResources(views);
        // Stands for these resources in the caches of bind groups.
        target.raymarch = {};
        target.orbit = this._group('orbit', this._orbitResources(views));
        if (target.blend) this._bindBlend(target);
    }

    _bindBlend(target) {
        const { blend } = target;
        blend.resources = this._raymarchResources(blend.views);
        blend.raymarch = {};
        blend.orbit = this._group('orbitBlend', [...this._orbitResources([target.colorView, target.depthView]), ...blend.views]);
    }

    _ensureBlend(target, width, height) {
        if (!target.blend) {
            const textures = [
                this._createTarget('clouds crossfade color', 'rgba16float', width, height),
                this._createTarget('clouds crossfade depth', 'r32float', width, height),
            ];
            target.blend = { textures, views: textures.map(texture => texture.createView()) };
            this._bindBlend(target);
        }
        return target.blend;
    }

    _ensureHistory(target, width, height) {
        if (!this._historyDepths) {
            const textures = ['A', 'B'].map(name => this._createTarget(`clouds history depth ${name}`, 'r32float', width, height));
            const views = textures.map(texture => texture.createView());
            const groups = [0, 1].map(write => this._group('history', [
                { buffer: this._uniformBuffer }, target.colorView, target.depthView,
                this._historyViews[1 - write], views[1 - write], this._historyViews[write], views[write],
            ]));
            this._historyDepths = { textures, groups };
        }
        return this._historyDepths;
    }

    _generateNoise() {
        const device = this.device;
        const encoder = device.createCommandEncoder({ label: 'clouds noise generation' });
        const pass = encoder.beginComputePass();
        const hq = (texture) => texture.format === NOISE_HQ_FORMAT;
        const generate = (pipeline, texture, size) => {
            pass.setPipeline(this._pipelines[pipeline]);
            pass.setBindGroup(0, this._group(hq(texture) ? 'volumeHQ' : 'volume',
                [texture.createView({ dimension: '3d', baseMipLevel: 0, mipLevelCount: 1 })]));
            pass.dispatchWorkgroups(size / 4, size / 4, size / 4);
        };
        const mips = (texture, size) => {
            pass.setPipeline(this._pipelines[hq(texture) ? 'downsampleHQ' : 'downsample']);
            for (let level = 1; level < texture.mipLevelCount; level++) {
                const view = (mip) => texture.createView({ dimension: '3d', baseMipLevel: mip, mipLevelCount: 1 });
                pass.setBindGroup(0, this._group(hq(texture) ? 'downsampleHQ' : 'downsample', [view(level - 1), view(level)]));
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

    _beginPass(encoder, name) {
        const label = `clouds ${name}`;
        return encoder.beginComputePass({ label, timestampWrites: this.gpuTimer?.timestampWrites(label) });
    }

    _dispatch(encoder, pipeline, bindGroup, x, y, name = pipeline, z = 1) {
        const pass = this._beginPass(encoder, name);
        pass.setPipeline(this._pipelines[pipeline]);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(x, y, z);
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

    _updateHistory(active, camera, weatherStyle) {
        this._historyActive = active;
        const prior = this._historyFrame;
        this._historyFrame = null;
        const data = this._uniformData;
        data[HISTORY_STATE_UNIFORM] = 0;
        if (!active) return;
        const { coverage, ...look } = this.settings;
        const key = JSON.stringify(look);
        const state = this._historyFrame = {
            frame: this._frame, camera, key, coverage, weatherStyle, wind: this._windShape.slice(),
            sun: [...this.sunDirection, this.sunIlluminance, ...this.moonDirection, this.moonIlluminance],
        };
        data[HISTORY_STATE_UNIFORM] = 1;
        if (!prior || this._resetHistory || prior.frame !== state.frame - 1 || prior.key !== key
            || Math.abs(prior.coverage - coverage) > 0.015
            || prior.weatherStyle.some((x, i) => Math.abs(x - weatherStyle[i]) > 0.035)
            || dot(prior.camera.back, camera.back) < 0.94
            // Perspective depth coefficients change with altitude. Cloud reprojection uses only XY.
            || prior.camera.proj.slice(0, 4).some((x, i) => x !== camera.proj[i])
            || prior.sun.some((x, i) => Math.abs(x - state.sun[i]) > 0.025)) return;
        data.set(sub(state.wind, prior.wind), 48 * 4);
        data[HISTORY_STATE_UNIFORM] = 2;
    }

    _writeUniforms(frame) {
        const s = this.settings;
        const weather = this.weather;
        const tier = this.tier;
        const presence = weather?.presence ?? 1;
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
        this.farProxyWeight = s.farProxy ? smoothstep(tier.orbitStartKm, tier.orbitEndKm, aboveTops) : 0;
        this._crossfade = this.farProxyWeight > 0.001 && this.farProxyWeight < 0.999;
        // In the handoff, spend most samples on the layer carrying most of the opacity.
        const orbitSlabs = 8 + (tier.orbitSlabs - 8) * this.farProxyWeight;
        const marchSteps = Math.max(1, Math.round(64 - 2 * this.farProxyWeight * tier.orbitSlabs));
        const ground = normalize(cam.pos).map(x => x * R);
        let sf = this._shadowFrame;
        if (!sf || sf.extent !== extent || sf.R !== R || Math.hypot(...sub(ground, sf.anchor)) > extent * 0.15) {
            const n = normalize(cam.pos);
            const e1 = normalize(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
            sf = this._shadowFrame = { anchor: ground, e1, e2: cross(n, e1), extent, R };
        }
        const { e1, e2 } = sf;
        if (dot(sun, cross(e1, e2)) < 0.0199) this.shadowFade = 0;
        if (tier.cirrusOnly || (presence <= 0.001 && (weather?.low ?? 0) <= 0.001)) this.shadowFade = 0;
        const weatherStyle = [presence, weather?.deck ?? 0, weather?.rainShade ?? 0, weather?.low ?? 0];
        // While hills can hide the sun.
        const sunHeight = dot(sun, normalize(cam.pos));
        const landShade = sunHeight > -0.2 && sunHeight < 0.75 ? this._localVolumes?.land.nextShade(sun) : null;
        const deckStyle = [weather?.thickness ?? 1, weather?.opacity ?? 1, weather?.evenness ?? 0, weather?.cells ?? 0];
        // Only the shadow plane, sun, and base density field affect this texture. Reuse it
        // when the camera, moon, exposure, or reconstruction are the only things changing.
        if (this.shadowFade > 0) {
            const n = cross(e1, e2);
            const slope = [e1, e2].map(axis => dot(sun, axis) / dot(sun, n) * s.cloudTopKm);
            const share = extent / SHADOW_SIZE * 10;
            // What drifts every frame, in kilometres of shadow movement: the sun, the wind, the boil, then weather
            // (a tenth of its range counts as a texel).
            this._shadowDrift = [...slope, ...this._windShape, this._boil,
                ...[...this.windDirection, s.coverage, ...weatherStyle, ...deckStyle, weather?.alto ?? 1].map(value => value * share)];
            this._shadowInputs = JSON.stringify([
                R, bottom, s.cloudTopKm, e1, e2, extent, s.windSkewKm,
                s.systemTileKm, s.systemStrength, s.systemWarp, s.systemOffset,
                s.weatherTileKm, s.largeWeatherTileKm, s.coverageGain, s.weatherContrast, s.cloudType, s.typeVariance,
                s.shapeTileKm, s.domeHeight, s.domeHeads, s.domeEdgeSharpness, s.popcornTopKm, s.densityVariation,
                s.isolatedPuffSuppression, s.altoClouds, s.altoBottomKm, s.altoTopKm, s.altoTileKm,
                s.lowCloudBottomKm, s.lowCloudTopKm, s.lowCloudTileKm,
            ]);
        }

        const d = sub(cam.pos, prev.pos);
        const pixelAngle = 2 / (cam.proj[1] * height);
        const data = this._uniformData;
        const moon = normalize(this.moonDirection);
        // In the order of CloudUniforms (cloudCommon.wgsl.js); zeros fill what nothing reads any more.
        data.set([
            ...cam.pos, frame.time,
            ...cam.right, cam.proj[0],
            ...cam.up, cam.proj[1],
            ...cam.back, cam.proj[2],
            cam.proj[3], s.reprojection ? this._frame : 0, width, height,
            ...prev.right, prev.proj[0],
            ...prev.up, prev.proj[1],
            ...prev.back, prev.proj[2],
            prev.proj[3], ...d,
            ...sun, this.sunIlluminance,
            R, R + bottom, R + s.cloudTopKm, R + this.planet.atmosphereHeightKm,
            1 / s.shapeTileKm, 1 / s.detailTileKm, 1 / s.weatherTileKm, 1 / s.largeWeatherTileKm,
            Math.min(1, s.coverage * (s.coverageGain ?? 1)), s.weatherContrast, s.cloudType, s.typeVariance,
            s.extinction, s.detailErosion, s.detailWarp, s.albedo,
            ...this._windShape, 0,
            ...this._windDetail, s.windSkewKm,
            s.phaseForward, s.phaseBack, s.backLobeWeight, s.powder,
            s.ambient, s.msExtinction, s.msScattering, s.msPhase,
            0, 0, 0, 0,
            s.lightStepKm, pixelAngle, this._resetHistory ? 1 : 0, 0,
            ...e1, extent,
            ...e2, 0,
            0, R, this.shadowFade, 0,
            ...this.windDirection, 0,
            1 / s.systemTileKm, s.systemStrength, s.systemWarp, s.systemOffset,
            0, 0, 0, Math.max(1, Math.round(s.lightSteps)),
            this.farProxyWeight, this._evolve, this._boil, 0,
            ...atmo.rayleighPerKm, atmo.rayleighScaleHeightKm,
            atmo.miePerKm, atmo.mieExtinctionPerKm, atmo.mieScaleHeightKm, atmo.mieG,
            ...atmo.ozonePerKm, atmo.ozonePeakKm,
            atmo.ozoneHalfWidthKm, atmo.groundAlbedo, s.twilightSoftness, 0,
            cam.proj[4], cam.proj[5], 1 / this.planet.unitsPerKm, this._sceneDepthView ? 1 : 0,
            ...this.ambientFloor, 0,
            Math.max(0, s.edgeSoftness), s.farAverageStartKm, s.farAverageEndKm, s.farAverageDensity,
            ...moon, this.moonIlluminance,
            0, 0, Math.max(0.6, s.domeHeight ?? 1), Math.max(0.1, s.sunsetDepth ?? 1),
            0, 0, 0, Math.min(0.92, Math.max(0.05, (s.popcornTopKm ?? 1.6) / Math.max(0.1, s.cloudTopKm - s.cloudBottomKm))),
            0, 0, 0, Math.max(0.05, s.sunsetAltitudeScale ?? 1),
            Math.max(0.5, s.domeEdgeSharpness ?? 1.5), Math.max(0, s.domeHeads ?? 0.6), Math.max(0, s.duskSkyBoost ?? 0), 0,
            0, Math.max(0, s.detailPixelFootprint ?? 0), Math.max(1, Math.min(32, Math.round(orbitSlabs))), 0,
            Math.min(1, Math.max(0, s.twilightCloudLight)), 0, 0, Math.max(0, s.edgeWisps ?? 0),
            Math.max(0, Math.min(1, s.densityVariation ?? 0)),
            Math.max(0, Math.min(1, s.isolatedPuffSuppression ?? 0)),
            Math.max(0, s.daylightSkyFill ?? 0), Math.max(1, s.daylightSunGain ?? 1),
            Math.min(1, Math.max(0, s.distantBanks)),
            Math.max(0, s.distantBanksStartKm),
            Math.max(s.distantBanksStartKm + 0.01, s.distantBanksEndKm),
            1 / Math.max(1, s.distantBanksTileKm),
            // An even sheet below hides or replaces them, and not every weather has them.
            Math.max(0, s.altoClouds) * (weather?.alto ?? 1) * (1 - (weather?.deck ?? 0) * (weather?.evenness ?? 0)),
            R + s.altoBottomKm, R + Math.max(s.altoBottomKm + 0.01, s.altoTopKm), 1 / Math.max(1, s.altoTileKm),
            ...weatherStyle,
            R + s.lowCloudBottomKm, R + Math.max(s.lowCloudBottomKm + 0.01, s.lowCloudTopKm),
            1 / Math.max(1, s.lowCloudTileKm), 0,
            weather?.mist ?? 0, R + Math.max(0.01, s.groundMistTopKm),
            Math.max(0.01, s.groundMistScaleKm), Math.max(0, s.groundMistExtinction),
            0, this._crossfade ? 1 : 0, 0, 0,
        ]);
        this._updateHistory(!tier.cirrusOnly && s.reprojection === true && this.farProxyWeight <= 0.001, cam, [...weatherStyle, ...deckStyle]);
        data.set([0, marchSteps, 0, 0, ...deckStyle, ...(landShade ?? Array(12).fill(0))], 53 * 4);
        this.device.queue.writeBuffer(this._uniformBuffer, 0, data);
        this._prev = cam;
    }
}
