// @ts-nocheck
import { CLOUD_UNIFORM_VEC4_COUNT } from './shaders/cloudCommon.wgsl.js';
import { CloudTowerExperiments } from './CloudTowerExperiments.js';
import { CloudSampleCache, cloudCacheGrid } from './CloudSampleCache.js';
import { CloudLocalVolumes } from './CloudLocalVolumes.js';
import { CLOUD_BUDGET_MAX_RAYS, CLOUD_BUDGET_TIERS, CLOUD_DETAIL_TIERS } from './cloudBudgetTiers.js';
import {
    SHAPE_NOISE_WGSL, DETAIL_NOISE_WGSL, WEATHER_NOISE_WGSL, DOWNSAMPLE_3D_WGSL, DOWNSAMPLE_3D_HQ_WGSL, NOISE_HQ_FORMAT,
} from './shaders/cloudNoise.wgsl.js';
import {
    TRANSMITTANCE_LUT_WGSL, AMBIENT_LUT_WGSL, CLOUD_SHADOW_WGSL, CLOUD_RAYMARCH_WGSL, CLOUD_TEMPORAL_WGSL,
    CLOUD_SPATIAL_WGSL, CLOUD_PROXY_BLEND_WGSL, CLOUD_HISTORY_RAYMARCH_WGSL,
    CLOUD_BUDGET_NEAR_WGSL, CLOUD_BUDGET_FINISH_WGSL, rayGroupHeight,
} from './shaders/cloudPasses.wgsl.js';
import {
    CLOUD_CONVENTIONAL_RAYMARCH_WGSL, CLOUD_CONVENTIONAL_SHADOW_WGSL, CLOUD_CONVENTIONAL_WEATHER_WGSL, CONVENTIONAL_DOMES_CONSTANTS,
} from './shaders/cloudConventional.wgsl.js';
import { CLOUD_CONVENTIONAL_HISTORY_WGSL } from './shaders/cloudConventionalHistory.wgsl.js';

const SHAPE_SIZE = 128;
const DETAIL_SIZE = 64;
const WEATHER_SIZE = 128;
const SHADOW_SIZE = 256;
// The budget previews redraw the shadow map in this many frames while it drifts (_nextShadowRows).
const SHADOW_SLICES = 4;
const LOW_CLOUD_UNIFORM = 45 * 4;
const towerVolumeModes = ['bounded', 'cached', 'impostor'];
// Preview lighting flags, as packed in budget.w and compiled into the neural raymarch. A setting is true, false or
// 'neural' (on in the Neural preview only).
const previewFlag = (value, neural) => (value === 'neural' ? neural : value) ? 1 : 0;
const conventionalPreviewFlags = (s, budget) => previewFlag(s.cloudFarLight, budget.neural)
    + 2 * previewFlag(s.cloudNightShaping, budget.neural)
    + 4 * previewFlag(s.cloudDensityClosure, budget.neural)
    + 8 * previewFlag(s.cloudLayeredLighting, budget.neural);
const historyRayPipelines = {
    cut: ['raymarchHistoryCut', 1, 1, 'raymarchCut'],
    domes: ['raymarchHistoryDomes', 1, 2, 'raymarchDomes'],
    proxy: ['raymarchHistoryProxy', 2, 0, 'raymarchProxy'],
};
const targetIntermediates = target => [
    ...(target?.blend?.textures ?? []), ...(target?.towerInput?.textures ?? []), ...(target?.towerInput?.blend?.textures ?? []),
    ...(target?.history?.textures ?? []),
    ...(target?.budgetInput?.textures ?? []),
];
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
    maxSteps: 192,
    minStepKm: 0.035,
    stepGrowth: 0.012,
    maxStepKm: 0.6,
    lightStepKm: 0.05,
    /** Sun-ray samples per lit step; each doubles in length (6 reach ~3 km). */
    lightSteps: 6,
    /** The original interleaved temporal resolve. False uses spatial reconstruction by default. */
    temporal: true,
    /** Experimental reuse of fresh raw rays during very small camera and cloud motion. */
    conservativeTemporal: false,
    /** Debug preview for per-ray scattering, baked weather, or cached sun optical depth. */
    cloudCacheMode: 'off',
    solarReferenceSteps: 128,
    orbitalProxySlabs: 8,
    orbitalPreview: null,
    cloudBudgetMode: 'off',
    /** 'high', 'medium' or 'low' (cirrus only), for the conventional and neural budget modes (cloudBudgetTiers.js). */
    cloudDetail: 'high',
    conventionalSunShadowStrength: 0.35,
    // The next four are 'neural' (Neural preview only), true (Conventional preview too) or false.
    /** Learned density average for filtered samples (thins distant clouds). */
    cloudDensityClosure: 'neural',
    /** Shades up to three depth groups per ray instead of one mean depth. */
    cloudLayeredLighting: 'neural',
    /** Directional moonlight and occluded night fill, as in the detailed renderer. */
    cloudNightShaping: 'neural',
    /** Fitted light outside the neural cache, and no light/dark front when the sun sets. */
    cloudFarLight: 'neural',
    /** Traces every second ray and fills in the others where their neighbours agree (Neural preview). */
    cloudRayPairs: true,
    /** Crepuscular rays below the clouds in the budget previews (CloudGodRays.js); godRayLook overrides its GOD_RAY_LOOK. */
    godRays: true,
    godRayLook: null,
    /** Clouds on mountain tops and mist on marsh, in woods and hollows (CloudLocalVolumes.js), where the host gives a land source. */
    mountainClouds: true,
    localMist: true,
    localVolumeLook: null,
    conventionalColumnLight: true,
    /** Depth-validated jitter accumulation for the Conventional and Neural previews. */
    conventionalTemporal: true,
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
    /** Reconstruct the full-size spatially filtered cloud target from a sparser ray grid. */
    spatialSampling: true,
    /** Largest angular spacing of the square ray grid. Coarser targets use a checkerboard. */
    spatialMaxRayAngle: 0.00325,
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
    edgeSoftness: 0.045,
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
    /** Keep fresh lighting while the view transmittance exceeds this threshold. */
    lightReuseBelowTransmittance: 0.4,
    /** Interpolate shared source lighting between the two evaluated samples. */
    lightReuseInterpolate: false,
    /** Optional weather-dependent lighting reuse for broad stratiform decks. */
    denseDeckLighting: null,
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
    towerDebugMode: 'off',
    towerDebugSites: Object.freeze([]),
    towerImpostorStartKm: 24,
    towerImpostorEndKm: 38,
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
     * Without temporal reconstruction: give neighbouring pixels four different step phases (2x2 ordered
     * pattern). With spatialFilter 1 the 3x3 tent averages them exactly, so surfaces stop snapping to
     * step positions. Use with spatialFilter 1.
     */
    stepStratify: false,
    /**
     * Step planes anchored at the camera snapped to a lattice this wide (km); 0 = planet centre. The
     * planet-centre anchor draws fingerprint rings in thin cloud near the camera (the step phase aliases
     * across pixels). Use with stepStratify; the planes jump once when the camera crosses a cell.
     */
    stepAnchorKm: 0,
    /** Detail noise is blurred to at least this many pixels (0 = off): sharper, thin fringes sparkle. */
    detailPixelFootprint: 0,
    /** Cross-cutting cost savings (every tier). Weather re-sampled along a ray only every this many km (0 = every sample). */
    /** 'domes': the outer shell of each cloud is eroded with wispy noise (0 = off, 1 = full) instead of round billows. */
    edgeWisps: 0,
    /**
     * Multiplier on the coverage the host sets (weather). A soft, translucent look (low extinction,
     * strong erosion) moves each cloud's visible outline inward; this restores their apparent size.
     */
    coverageGain: 1,
    /** 'domes': density thins between puffs inside clouds (0 = uniform body, 1 = see-through pockets). */
    densityVariation: 0,
    /** 'domes': suppress small puffs without nearby support from the broader shape field (0 = off). */
    isolatedPuffSuppression: 0,
    weatherReuseKm: 0.3,
    /**
     * Detail noise skipped once less than this fraction of light reaches the camera from the sample (0 = never
     * skip). Off: measured -3 % at ground views but +8 % from above (uneroded density lights more samples).
     */
    detailMinTransmittance: 0,
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
        /** Current far-proxy weight (0 raymarch .. 1 proxy). */
        this.proxyWeight = 0;
        this.farProxyWeight = 0;
        /** Radiance added to the clouds' ambient light (e.g. night sky and moonlight), linear RGB. */
        this.ambientFloor = [0, 0, 0];
        /** Moon as a second directional light (used while the sun is dim); illuminance 0 = off. */
        this.moonDirection = [0, -1, 0];
        this.moonIlluminance = 0;
        this._shadowFrame = null;
        /** Counts redraws of the shadow map. */
        this.shadowVersion = 0;
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

    /** The shape and detail noise volumes (3D, rgba16float, R = Perlin-Worley / Worley fBm), for reuse by other effects. */
    getNoiseViews() {
        return { shape: this._shapeView, detail: this._detailView };
    }

    update(frame) {
        this.viewport = frame.viewport ?? this.viewport;
        this._ensureTargets();
        const s = this.settings;
        if (s.towerDebugMode !== this._lastTowerDebugMode) {
            this._lastTowerDebugMode = s.towerDebugMode;
            this.resetHistory();
        }
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

    prepareTowerExperiments() {
        if (!this._towerExperiments) {
            this._towerExperiments = new CloudTowerExperiments(this);
            this._towerExperiments.initialized.then(() => this.resetHistory());
        }
        return this._towerExperiments.initialized;
    }

    prepareConservativeHistory() {
        return this._historyPipelines ??= this._createHistoryPipelines();
    }

    prepareSampleCache(mode) {
        this._sampleCache ??= new CloudSampleCache(this, this._makeSampleCacheLayouts);
        return this._sampleCache.prepare(mode);
    }

    prepareNeuralLighting() {
        return this._prepareNeuralLighting ??= import('./CloudNeuralLighting.js').then(({ CloudNeuralLighting }) => {
            if (this._disposed) return false;
            this._neuralLighting = new CloudNeuralLighting(this);
            return this._neuralLighting.initialize();
        }).catch(error => {
            console.error('Neural cloud lighting is unavailable', error);
            return false;
        });
    }

    setSolarModel(model) {
        this._sampleCache ??= new CloudSampleCache(this, this._makeSampleCacheLayouts);
        this._sampleCache.setSolarModel(model);
        this.resetHistory();
    }

    get budgetTier() {
        const { cloudBudgetMode: mode, cloudDetail } = this.settings;
        if (!Object.hasOwn(CLOUD_BUDGET_TIERS, mode)) return null;
        const tier = CLOUD_BUDGET_TIERS[mode];
        const detail = Object.hasOwn(CLOUD_DETAIL_TIERS, cloudDetail) ? cloudDetail : 'high';
        if (!tier.conventional) return tier;
        const key = `${mode}:${detail}`;
        this._detailTiers ??= {};
        return this._detailTiers[key] ??= Object.freeze({ ...tier, ...CLOUD_DETAIL_TIERS[detail], detail });
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
        const budget = this.budgetTier;
        if (budget?.cirrusOnly) {
            this._neuralLighting?.reset();
            this._frame++;
            return;
        }
        const [w, h] = this._targetSize;
        const set = this._sets[this._activeK];
        const [bw, bh] = set.blocks;
        const conventional = !!budget?.conventional;
        const reconstructConventional = this._conventionalHistoryActive;
        const write = reconstructConventional || (!budget && this.settings.temporal) ? this._historyIndex : 0;
        if (!budget?.neural || this.farProxyWeight >= 0.999) this._neuralLighting?.reset();
        if (conventional && this.farProxyWeight < 0.999) this._bakeConventionalWeather(encoder);
        const atlas = conventional && this.farProxyWeight < 0.999 ? this._conventionalWeather : null;
        const shadowRows = this.shadowFade > 0 ? this._nextShadowRows(!!atlas) : 0;
        if (shadowRows > 0) {
            const domes = this.settings.cloudShape === 'domes' && this.settings.giantShare <= 0 ? 'Domes' : '';
            this._dispatch(encoder, atlas ? 'conventionalShadow' + domes : 'shadow', atlas?.shadowGroup ?? this._bindGroups.shadow,
                SHADOW_SIZE / 8, shadowRows / 8, 'shadow');
            this.shadowVersion++;
        }
        let ray = 'raymarchCut';
        const mode = this.settings.towerDebugMode;
        if (this.settings.cloudShape === 'domes') {
            ray = this.settings.giantShare > 0 ? 'raymarchGiants' : 'raymarchDomes';
        }
        if (mode === 'stretched' && this._pipelines.raymarchStretched) ray = 'raymarchStretched';
        const sparse = this._spatialStride ? this._spatialTargets : null;
        const target = sparse ?? set;
        const width = sparse?.width ?? bw;
        const groupsX = Math.ceil(width / 8);
        const height = sparse?.height ?? bh;
        const dispatchRay = (pipeline, bindGroup, label = 'raymarch', groupHeight = rayGroupHeight(pipeline)) =>
            this._dispatch(encoder, pipeline, bindGroup, groupsX, Math.ceil(height / groupHeight), label);
        const history = this._nextRayHistory;
        const reuse = history?.canReuse && this._pipelines[history.pipeline];
        let reconstruct = sparse?.reconstruct;
        let rayTarget = target;
        const hasTowers = !budget && towerVolumeModes.includes(mode) && this.settings.towerDebugSites.length > 0 && !this.settings.debugSteps;
        if (hasTowers) {
            this.prepareTowerExperiments();
            if (this._towerExperiments.ready) {
                rayTarget = this._ensureTowerInput(target, width, height);
                const count = this._towerExperiments.syncSites();
                this._towerExperiments.prepare(encoder, mode, count);
            }
        }
        const cacheMode = this.settings.cloudCacheMode;
        this._activeCacheMode = 'off';
        const canCache = !budget && cacheMode !== 'off' && mode === 'off' && !this._proxyCrossfade
            && this.proxyWeight < 0.001 && !this.settings.debugSteps;
        if (canCache) this.prepareSampleCache(cacheMode);
        const cached = canCache && this._sampleCache.dispatch(encoder, cacheMode, ray, rayTarget, width, height);
        if (ray === 'raymarchDomes' && this.settings.lightReuseInterpolate
            && (this.weather?.deck ?? 0) > (this.settings.denseDeckLighting?.startDeck ?? 1)) {
            ray = 'raymarchDomesRain';
        }
        if (budget) {
            const dense = (this.weather?.deck ?? 0) >= 0.9;
            const pipeline = dense ? 'raymarchBudgetRain' : 'raymarchBudget';
            if (conventional) {
                const domes = this.settings.cloudShape === 'domes' && this.settings.giantShare <= 0;
                const denseDeck = (this.weather?.deck ?? 0) >= 0.62;
                const variant = domes ? (denseDeck ? 'Dense' : 'Domes') : '';
                const groupHeight = domes ? CONVENTIONAL_DOMES_CONSTANTS.CONVENTIONAL_GROUP_HEIGHT : 8;
                let neural = false;
                if (budget.neural && this.farProxyWeight < 0.999) {
                    this.prepareNeuralLighting();
                    neural = this._neuralLighting?.dispatch(encoder, !!budget.march);
                }
                if (this.farProxyWeight >= 0.999) {
                    dispatchRay('raymarchProxy', set.raymarch, 'budget volume');
                } else if (this._proxyCrossfade) {
                    const blend = this._ensureProxyBlend(set, width, height);
                    dispatchRay('conventional' + variant, blend.conventional, 'budget near', groupHeight);
                    dispatchRay('proxyBlend', blend.proxy, 'budget volume');
                } else {
                    const group = neural ? this._neuralLighting.rayGroup(set.conventional, set.conventionalResources) : set.conventional;
                    const flags = conventionalPreviewFlags(this.settings, budget);
                    const ray = neural ? this._neuralLighting.rayPipeline(variant, flags, budget) : 'conventional' + variant;
                    const paired = neural && this.settings.cloudRayPairs
                        && this._neuralLighting.dispatchPairs(encoder, set, variant, flags, width, height, budget);
                    if (!paired) dispatchRay(ray, group, 'budget volume', groupHeight);
                }
            } else if (this._budgetBulkOnly) {
                dispatchRay(`${pipeline}Bulk`, target.raymarch, 'budget volume');
            } else {
                const input = this._ensureBudgetSplit(target, width, height);
                const lighting = budget.fullLighting ? 'Ultra' : '';
                dispatchRay(`${pipeline}${lighting}Near`, input.near, 'budget near');
                dispatchRay(`${pipeline}Finish`, input.finish, 'budget volume');
            }
        } else if (cached) {
            this._activeCacheMode = cacheMode;
        } else if (reuse) {
            const targets = this._ensureRayHistory(sparse);
            history.index = 1 - this._rawRayHistory.index;
            this._dispatch(encoder, history.pipeline, targets.groups[history.index], groupsX,
                Math.ceil(height / history.groupHeight), 'raymarch');
            reconstruct = targets.reconstruct[history.index];
        } else if (mode === 'deck') {
            dispatchRay('raymarchBroadDeck', rayTarget.raymarch, 'deck geometry');
        } else if (this.proxyWeight >= 0.999) {
            dispatchRay('raymarchProxy', rayTarget.raymarch);
        } else if (this._proxyCrossfade) {
            const blend = this._ensureProxyBlend(rayTarget, width, height);
            dispatchRay(ray, blend.detailed);
            dispatchRay('proxyBlend', blend.proxy);
        } else {
            dispatchRay(ray, rayTarget.raymarch);
        }
        if (rayTarget !== target) {
            this._towerExperiments.render(encoder, mode, rayTarget, target, this._sceneDepthView ?? this._dummyDepthView, width, height);
        }
        if (sparse) {
            this._dispatch(encoder, 'spatial', reconstruct, Math.ceil(w / 8), Math.ceil(h / 8));
        } else if (reconstructConventional) {
            const history = this._ensureConventionalHistory(set, w, h);
            this._dispatch(encoder, 'conventionalHistory', history.groups[write], groupsX, Math.ceil(h / 8), 'budget history');
        } else if (!budget) {
            this._dispatch(encoder, 'temporal', set.temporal[write], Math.ceil(w / 8), Math.ceil(h / 8));
        }
        this._outputIndex = write;
        this._historyIndex = 1 - write;
        this._encodeLocalVolumes(encoder);
        this._rawRayHistory = cached ? null : history;
        this._historyReuseActive = !!reuse && !cached;
        this._resetHistory = false;
        this._frame++;
    }

    // How many rows of the cloud shadow map to redraw this frame. While the sun and the clouds drift slowly, the budget
    // previews redraw a quarter of it each frame. Above 0.01 texels of movement a frame, which a day of about five minutes
    // reaches, the quarters would step visibly, so all of it is redrawn.
    _nextShadowRows(sliced) {
        const inputs = `${sliced}${this._shadowInputs}`;
        // The weather cube is baked without evolution, the last entry.
        const drift = sliced ? this._shadowDrift.slice(0, -1) : this._shadowDrift;
        const state = this._lastShadowInputs === inputs ? this._shadowState : null;
        const step = state ? Math.max(...drift.map((value, i) => Math.abs(value - state.drift[i]))) : Infinity;
        this._lastShadowInputs = inputs;
        if (!sliced || step > 0.01 * this.settings.shadowExtentKm / SHADOW_SIZE) {
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
        const budget = this.budgetTier;
        const tileStreamer = this._landSource?.tileStreamer();
        if (!tileStreamer || !(budget?.fog || budget?.mist)) return;
        if (!this._localVolumes) {
            this._localVolumes = new CloudLocalVolumes(this, { tileCategories: this._landSource.tileCategories });
            this._localVolumes.initialize().catch(error => console.error('Local cloud volumes are unavailable', error));
        }
        this._localVolumes.update(encoder, { tileStreamer, heightScaleKm: this._landSource.heightScaleKm });
    }

    /** Views for a compositor; `version` changes whenever views are recreated. */
    getOutputs() {
        const k = this._activeK;
        const budget = !!this.budgetTier;
        const resolved = !budget || this._conventionalHistoryActive;
        return {
            version: `${this.outputVersion}:${this._outputIndex ?? 0}:${k}:${budget}:${resolved}`,
            /** Changes when depthView changes (resize, or switching between interleaved and full rate). */
            depthVersion: `${this.outputVersion}:${k}`,
            uniformBuffer: this._uniformBuffer,
            colorView: resolved ? this._historyViews[this._outputIndex ?? 0] : this._sets[k].colorView,
            /** Raymarch-resolution cloud distance (km, r32float): one texel per interleave block. */
            depthView: this._sets[k].depthView,
            blockFactor: k,
            shadowView: this._shadowView,
            /** Scale cloud shadows by this; at 0 the shadow map is stale and must not be used. */
            shadowFade: this.shadowFade,
            transmittanceView: this._transmittanceView,
            cloudLightView: this._cloudLightView,
            ambientView: this._ambientView,
            lutSampler: this._lutSampler,
            linearSampler: this._linearSampler,
            size: [...this._targetSize],
        };
    }

    dispose() {
        this._disposed = true;
        this._towerExperiments?.dispose();
        this._sampleCache?.dispose();
        this._neuralLighting?.dispose();
        this._localVolumes?.dispose();
        const textures = [
            this._shape, this._detail, this._weather, this._transmittance, this._cloudLight, this._ambient, this._shadow,
            this._dummyDepth, ...this._setTextures(), ...(this._history ?? []),
            ...(this._conventionalWeather?.textures ?? []),
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
        const store = (format, viewDimension = '2d') => ({ storageTexture: { access: 'write-only', format, viewDimension } });
        const layout = (entries) => device.createBindGroupLayout({
            entries: entries.map((entry, binding) => ({ binding, visibility: C, ...entry })),
        });
        const noise = [uniform, tex3d, tex3d, tex3d, sampler];
        const raymarch = [...noise, tex2d, tex2d, sampler, store('rgba16float'), store('r32float'), texDepth];
        const pointSampler = { sampler: { type: 'non-filtering' } };
        const conventional = [...noise, tex2d, pointSampler, ...raymarch.slice(7), tex2d, cube, cube];
        this._layouts = {
            volume: layout([store('rgba8unorm', '3d')]),
            downsample: layout([tex3d, store('rgba8unorm', '3d')]),
            volumeHQ: layout([store(NOISE_HQ_FORMAT, '3d')]),
            downsampleHQ: layout([tex3d, store(NOISE_HQ_FORMAT, '3d')]),
            transmittance: layout([uniform, store('rgba16float'), store('rgba16float')]),
            ambient: layout([uniform, tex2d, sampler, store('rgba16float')]),
            shadow: layout([...noise, store('rgba16float')]),
            conventionalShadow: layout([...noise, store('rgba16float'), sampler, cube, cube]),
            raymarch: layout(raymarch),
            conventional: layout(conventional),
            conventionalNeural: layout([...conventional, tex3d, tex3d, uniform]),
            conventionalNeuralList: layout([...conventional, tex3d, tex3d, uniform, { buffer: { type: 'read-only-storage' } }]),
            rayPairs: layout([uniform, tex2d, texUnfilterable, texDepth, store('rgba16float'), store('r32float'),
                { buffer: { type: 'storage' } }, pointSampler]),
            neuralLightBake: layout([...noise, sampler, cube, cube, store('rgba16float', '3d'), uniform]),
            conventionalWeather: layout([...noise, store('rgba16float', '2d-array'), store('rgba16float', '2d-array')]),
            conventionalHistory: layout([uniform, tex2d, texUnfilterable, tex2d, texUnfilterable,
                store('rgba16float'), store('r32float')]),
            budgetNear: layout([...raymarch.slice(0, 8), store('rgba32float'), store('rg32float'), texDepth]),
            budgetFinish: layout([...raymarch, texUnfilterable, texUnfilterable]),
            proxyBlend: layout([...raymarch, tex2d, texUnfilterable]),
            rayHistory: layout([...raymarch, tex2d, texUnfilterable]),
            temporal: layout([uniform, tex2d, texUnfilterable, tex2d, sampler, store('rgba16float')]),
            spatial: layout([uniform, tex2d, texUnfilterable, texDepth, store('rgba16float'), store('r32float')]),
        };
        this._makeSampleCacheLayouts = (mode, count) => {
            if (mode === 'phase' || mode === 'solar-reference') return { raymarch: this._layouts.raymarch };
            if (mode === 'neural-solar') return { raymarch: layout([...raymarch, uniform]) };
            const dimension = mode === 'weather' ? '2d' : '3d';
            const sampled = Array(count).fill(dimension === '3d' ? tex3d : tex2d);
            const storage = Array(count).fill(store('rgba16float', dimension));
            return { dimension, raymarch: layout([...raymarch, ...sampled]), bake: layout([...noise, ...storage]) };
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
            raymarch: [CLOUD_RAYMARCH_WGSL, 'raymarch'],
            conventional: [CLOUD_CONVENTIONAL_RAYMARCH_WGSL, 'conventional'],
            conventionalShadow: [CLOUD_CONVENTIONAL_SHADOW_WGSL, 'conventionalShadow'],
            conventionalWeather: [CLOUD_CONVENTIONAL_WEATHER_WGSL, 'conventionalWeather'],
            conventionalHistory: [CLOUD_CONVENTIONAL_HISTORY_WGSL, 'conventionalHistory'],
            budgetNear: [CLOUD_BUDGET_NEAR_WGSL, 'budgetNear'],
            budgetFinish: [CLOUD_BUDGET_FINISH_WGSL, 'budgetFinish'],
            proxyBlend: [CLOUD_PROXY_BLEND_WGSL, 'proxyBlend'],
            temporal: [CLOUD_TEMPORAL_WGSL, 'temporal'],
            spatial: [CLOUD_SPATIAL_WGSL, 'spatial'],
        };
        this._pipelines = {};
        await Promise.all(Object.entries(sources).map(async ([name, [code, layoutName]]) => {
            const module = device.createShaderModule({ label: `clouds ${name}`, code });
            const info = await module.getCompilationInfo?.();
            const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
            if (errors.length) {
                throw new Error(`clouds ${name} WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
            }
            const layout = device.createPipelineLayout({ bindGroupLayouts: [this._layouts[layoutName]] });
            const build = async (key, constants) => {
                this._pipelines[key] = await device.createComputePipelineAsync({
                    label: `clouds ${key}`, layout, compute: { module, entryPoint: 'main', constants },
                });
            };
            if (name === 'budgetNear' || name === 'budgetFinish') {
                const variants = name === 'budgetNear'
                    ? [['Near', false, false], ['UltraNear', true, false], ['RainNear', false, true], ['RainUltraNear', true, true]]
                    : [['Finish', false, false], ['RainFinish', false, true]];
                await Promise.all(variants.map(([suffix, fullLighting, denseDeck]) => {
                    const key = `raymarchBudget${suffix}`;
                    return build(key, {
                        RAY_PATH: 4, CLOUD_SHAPE: 2, RAY_GROUP_HEIGHT: rayGroupHeight(key),
                        BUDGET_FULL_LIGHT: fullLighting, BUDGET_DENSE_DECK: denseDeck,
                    });
                }));
                return;
            }
            if (name === 'conventional') {
                const domes = CONVENTIONAL_DOMES_CONSTANTS;
                await Promise.all([build(name), build('conventionalDomes', domes),
                    build('conventionalDense', { ...domes, CONVENTIONAL_DENSE: true })]);
                return;
            }
            if (name === 'conventionalShadow') {
                await Promise.all([build(name), build('conventionalShadowDomes', { CLOUD_SHAPE: 2, SKIP_UNUSED_DENSITY: true })]);
                return;
            }
            if (name !== 'raymarch') {
                await build(name);
                return;
            }
            // The retired in-game stretch mode is still available to the benchmark.
            this.prepareStretchedCumulus = () => (this._stretchedPipeline ??= build('raymarchStretched', {
                RAY_PATH: 1, CLOUD_SHAPE: 4, RAY_GROUP_HEIGHT: rayGroupHeight('raymarchStretched'),
            }));
            await Promise.all([
                ['raymarchCut', 1, 1], ['raymarchDomes', 1, 2],
                ['raymarchDomesRain', 1, 2, false, true],
                ['raymarchGiants', 1, 3], ['raymarchProxy', 2, 0],
                ['raymarchBroadDeck', 3, 2],
                ['raymarchBudgetBulk', 4, 2],
                ['raymarchBudgetRainBulk', 4, 2, true],
            ].map(([key, path, shape, denseDeck = false, interpolateLight = false]) => build(key, {
                RAY_PATH: path, CLOUD_SHAPE: shape, RAY_GROUP_HEIGHT: rayGroupHeight(key), BUDGET_DENSE_DECK: denseDeck,
                INTERPOLATE_SHARED_LIGHT: interpolateLight,
                SKIP_UNUSED_DENSITY: key === 'raymarchDomes' || key === 'raymarchProxy',
            })));
        }));
    }

    async _createHistoryPipelines() {
        const device = this.device;
        const module = device.createShaderModule({ label: 'clouds conservative history', code: CLOUD_HISTORY_RAYMARCH_WGSL });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this._layouts.rayHistory] });
        try {
            await Promise.all(Object.values(historyRayPipelines).map(async ([key, path, shape, base]) => {
                this._pipelines[key] = await device.createComputePipelineAsync({
                    label: `clouds ${key}`, layout, compute: { module, entryPoint: 'main',
                        constants: { RAY_PATH: path, CLOUD_SHAPE: shape, RAY_GROUP_HEIGHT: rayGroupHeight(base) } },
                });
            }));
        } catch (error) {
            console.error('Cloud history preview pipeline failed', error);
            return false;
        }
        return true;
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
            transmittance: group('transmittance', [
                { buffer: this._uniformBuffer }, this._transmittanceView, this._cloudLightView,
            ]),
            ambient: group('ambient', [{ buffer: this._uniformBuffer }, this._transmittanceView, this._lutSampler, this._ambientView]),
            shadow: group('shadow', [...this._noiseResources, this._shadowView]),
        };
        this._group = group;
    }

    _setTextures() {
        return [...Object.values(this._sets ?? {}).flatMap(set => [set.color, set.depth, ...targetIntermediates(set)]),
            ...(this._spatialTargets?.textures ?? []), ...targetIntermediates(this._spatialTargets),
            ...(this._conventionalHistory?.depths ?? [])];
    }

    _createTarget(label, format, width, height) {
        return this.device.createTexture({
            label, size: [width, height], format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
    }

    _ensureTargets() {
        const s = this.settings;
        // Switch resolution with hysteresis once the cheap far proxy has fully taken over. Only the
        // far (orbital) proxy: the near-ground proxy keeps resolutionScale, so it is as sharp as the
        // raymarch it crossfades into (at the orbit scale it was visibly crisper).
        const orbitScale = s.orbitalPreview?.orbitResolutionScale ?? s.orbitResolutionScale;
        if (s.farProxy && Number.isFinite(orbitScale)) {
            if (this.farProxyWeight >= 0.999) this._orbitRes = true;
            else if (this.farProxyWeight < 0.95) this._orbitRes = false;
        } else {
            this._orbitRes = false;
        }
        const wanted = this._orbitRes ? orbitScale : s.resolutionScale;
        const budget = this.budgetTier;
        let scale = Math.min(1, Math.max(0.2, wanted));
        if (budget) {
            const maxRays = budget.maxRays ?? CLOUD_BUDGET_MAX_RAYS;
            scale = Math.min(scale, 0.5, Math.sqrt(maxRays / (this.viewport.width * this.viewport.height)));
        }
        const round = budget ? Math.floor : Math.round;
        const width = Math.max(1, round(this.viewport.width * scale));
        const height = Math.max(1, round(this.viewport.height * scale));
        const k = this._interleave();
        const conventional = !!budget?.conventional;
        if (width === this._targetSize[0] && height === this._targetSize[1] && k === this._blockFactor
            && conventional === this._conventionalTargets) return;
        for (const texture of [...this._setTextures(), ...(this._history ?? [])]) texture?.destroy();
        this._spatialTargets = null;
        this._conventionalHistory = null;
        this._conventionalTargets = conventional;
        this._history = ['A', 'B'].map(name => this._createTarget(`clouds history ${name}`, 'rgba16float', width, height));
        const historyViews = this._historyViews = this._history.map(texture => texture.createView());
        // The raymarch writes one sample per k x k block of the cloud target. With interleave 2 a
        // full-rate set (k = 1) is kept as well, for frames with fast camera motion.
        this._sets = {};
        for (const sk of k === 2 ? [1, 2] : [1]) {
            const blocks = [Math.ceil(width / sk), Math.ceil(height / sk)];
            const color = this._createTarget(`clouds raymarch color k${sk}`, 'rgba16float', ...blocks);
            const depth = this._createTarget(`clouds raymarch depth k${sk}`, 'r32float', ...blocks);
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
        const scene = this._sceneDepthView ?? this._dummyDepthView;
        const common = [...this._noiseResources, this._cloudLightView, this._ambientView, this._lutSampler];
        const weather = this._conventionalTargets ? this._ensureConventionalWeather() : null;
        for (const set of Object.values(this._sets ?? {})) {
            set.raymarch = this._group('raymarch', [...common, set.colorView, set.depthView, scene]);
            if (weather) {
                set.conventionalResources = [...this._conventionalCommon(), set.colorView, set.depthView, scene,
                    this._shadowView, ...weather.views];
                set.conventional = this._group('conventional', set.conventionalResources);
            }
            if (set.blend) this._bindProxyBlend(set, scene);
            if (set.towerInput) this._bindTowerInput(set.towerInput, scene);
            if (set.budgetInput) this._bindBudgetSplit(set, scene);
        }
        const sparse = this._spatialTargets;
        if (sparse) {
            sparse.raymarch = this._group('raymarch', [...common, ...sparse.views, scene]);
            if (sparse.blend) this._bindProxyBlend(sparse, scene);
            if (sparse.towerInput) this._bindTowerInput(sparse.towerInput, scene);
            sparse.reconstruct = this._group('spatial', [
                { buffer: this._uniformBuffer }, ...sparse.views, scene, this._historyViews[0], this._sets[1].depthView,
            ]);
            if (sparse.history) this._bindRayHistory(sparse, scene);
        }
    }

    // The first resources of the conventional raymarch: no ambient table, and a sampler for depth gathers in its place.
    _conventionalCommon() {
        return [...this._noiseResources, this._cloudLightView, this._pointSampler, this._lutSampler];
    }

    _ensureConventionalHistory(set, width, height) {
        if (!this._conventionalHistory) {
            const depths = ['A', 'B'].map(name => this._createTarget(`clouds history depth ${name}`, 'r32float', width, height));
            const views = depths.map(texture => texture.createView());
            const groups = [0, 1].map(write => this._group('conventionalHistory', [
                { buffer: this._uniformBuffer }, set.colorView, set.depthView,
                this._historyViews[1 - write], views[1 - write], this._historyViews[write], views[write],
            ]));
            this._conventionalHistory = { depths, groups };
        }
        return this._conventionalHistory;
    }

    _ensureConventionalWeather() {
        if (this._conventionalWeather) return this._conventionalWeather;
        const size = CLOUD_BUDGET_TIERS.conventional.weatherCubeSize;
        const textures = ['field', 'shape offset'].map(name => this.device.createTexture({
            label: `clouds weather cube ${name}`, size: [size, size, 6], format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }));
        const views = textures.map(texture => texture.createView({ dimension: 'cube' }));
        const storage = textures.map(texture => texture.createView({ dimension: '2d-array' }));
        const group = this._group('conventionalWeather', [...this._noiseResources, ...storage]);
        const shadowGroup = this._group('conventionalShadow', [...this._noiseResources, this._shadowView, this._linearSampler, ...views]);
        return this._conventionalWeather = { textures, views, group, shadowGroup, size, key: null };
    }

    _bakeConventionalWeather(encoder) {
        const atlas = this._conventionalWeather;
        const s = this.settings;
        const key = JSON.stringify([this.planet.radiusKm, s.cloudBottomKm, s.systemTileKm, s.systemOffset,
            s.systemStrength, s.systemWarp, s.weatherTileKm, s.largeWeatherTileKm, s.shapeOffset]);
        if (atlas.key === key) return;
        atlas.key = key;
        const groups = Math.ceil(atlas.size / 8);
        this._dispatch(encoder, 'conventionalWeather', atlas.group, groups, groups, 'weather cube', 6);
    }

    _bindBudgetSplit(target, scene) {
        const input = target.budgetInput;
        const common = [...this._noiseResources, this._cloudLightView, this._ambientView, this._lutSampler];
        input.near = this._group('budgetNear', [...common, ...input.views, scene]);
        input.finish = this._group('budgetFinish', [...common, target.colorView, target.depthView, scene, ...input.views]);
    }

    _ensureBudgetSplit(target, width, height) {
        if (!target.budgetInput) {
            const textures = [
                this._createTarget('clouds budget near color', 'rgba32float', width, height),
                this._createTarget('clouds budget near ray', 'rg32float', width, height),
            ];
            target.budgetInput = { textures, views: textures.map(texture => texture.createView()) };
            this._bindBudgetSplit(target, this._sceneDepthView ?? this._dummyDepthView);
        }
        return target.budgetInput;
    }

    _bindRayHistory(target, scene) {
        const history = target.history;
        const pairs = [target.views, history.views];
        const common = [...this._noiseResources, this._cloudLightView, this._ambientView, this._lutSampler];
        history.groups = pairs.map((pair, i) => this._group('rayHistory', [...common, ...pair, scene, ...pairs[1 - i]]));
        history.reconstruct = [target.reconstruct, this._group('spatial', [
            { buffer: this._uniformBuffer }, ...history.views, scene, this._historyViews[0], this._sets[1].depthView,
        ])];
    }

    _ensureRayHistory(target) {
        if (!target.history) {
            const { width, height } = target;
            const textures = [
                this._createTarget('clouds history raw color', 'rgba16float', width, height),
                this._createTarget('clouds history raw depth', 'r32float', width, height),
            ];
            target.history = { textures, views: textures.map(texture => texture.createView()) };
            this._bindRayHistory(target, this._sceneDepthView ?? this._dummyDepthView);
        }
        return target.history;
    }

    _bindProxyBlend(target, scene) {
        const blend = target.blend;
        const common = [...this._noiseResources, this._cloudLightView, this._ambientView, this._lutSampler];
        const outputs = target.views ?? [target.colorView, target.depthView];
        blend.detailed = this._group('raymarch', [...common, ...blend.views, scene]);
        blend.proxy = this._group('proxyBlend', [...common, ...outputs, scene, ...blend.views]);
        if (this._conventionalTargets) {
            blend.conventional = this._group('conventional', [
                ...this._conventionalCommon(), ...blend.views, scene, this._shadowView, ...this._conventionalWeather.views,
            ]);
        }
    }

    _ensureProxyBlend(target, width, height) {
        if (!target.blend) {
            const textures = [
                this._createTarget('clouds crossfade color', 'rgba16float', width, height),
                this._createTarget('clouds crossfade depth', 'r32float', width, height),
            ];
            target.blend = { textures, views: textures.map(texture => texture.createView()) };
            this._bindProxyBlend(target, this._sceneDepthView ?? this._dummyDepthView);
        }
        return target.blend;
    }

    _bindTowerInput(input, scene) {
        input.raymarch = this._group('raymarch', [...this._noiseResources, this._cloudLightView, this._ambientView,
            this._lutSampler, ...input.views, scene]);
        if (input.blend) this._bindProxyBlend(input, scene);
    }

    _ensureTowerInput(target, width, height) {
        if (!target.towerInput) {
            const textures = [this._createTarget('clouds tower input color', 'rgba16float', width, height),
                this._createTarget('clouds tower input depth', 'r32float', width, height)];
            target.towerInput = { textures, views: textures.map(texture => texture.createView()) };
            this._bindTowerInput(target.towerInput, this._sceneDepthView ?? this._dummyDepthView);
        }
        return target.towerInput;
    }

    _ensureSpatialTargets(stride) {
        if (this._spatialTargets?.stride === stride) return;
        for (const texture of [...(this._spatialTargets?.textures ?? []), ...targetIntermediates(this._spatialTargets)]) {
            texture.destroy();
        }
        const width = Math.ceil(this._targetSize[0] / Math.max(2, stride));
        const height = Math.ceil(this._targetSize[1] / stride);
        const textures = [
            this._createTarget('clouds spatial ray color', 'rgba16float', width, height),
            this._createTarget('clouds spatial ray depth', 'r32float', width, height),
        ];
        this._spatialTargets = { stride, width, height, textures, views: textures.map(texture => texture.createView()) };
        this._buildRaymarchGroup();
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

    _interleave() { return !this.budgetTier && this.settings.interleave >= 2 ? 2 : 1; }

    _dispatch(encoder, pipeline, bindGroup, x, y, name = pipeline, z = 1) {
        const label = `clouds ${name}`;
        const pass = encoder.beginComputePass({ label, timestampWrites: this.gpuTimer?.timestampWrites(label) });
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

    _updateRayHistory(cam, prev, altitude, moon, weatherStyle) {
        const s = this.settings;
        const target = this._spatialStride ? this._spatialTargets : null;
        this._nextRayHistory = null;
        if (!s.conservativeTemporal || !target || this._proxyCrossfade || s.towerDebugMode !== 'off' || s.giantShare > 0) return;
        this.prepareConservativeHistory();
        const variant = this.proxyWeight >= 0.999 ? 'proxy' : s.cloudShape === 'domes' ? 'domes' : 'cut';
        const [pipeline, , , base] = historyRayPipelines[variant];
        const { coverage, ...settings } = s;
        const key = JSON.stringify([settings, this.planet.radiusKm, this.planet.atmosphereHeightKm,
            this.planet.atmosphere, this.windDirection, variant]);
        const light = [...this.sunDirection, this.sunIlluminance, ...moon, this.moonIlluminance, ...this.ambientFloor];
        const state = this._nextRayHistory = {
            pipeline, groupHeight: rayGroupHeight(base), cam, target, key, frame: this._frame, index: 0,
            shape: this._windShape.slice(), detail: this._windDetail.slice(), boil: this._boil, evolve: this._evolve,
            coverage, light, weatherStyle, motion: [0, 0],
        };
        const old = this._rawRayHistory;
        if (!old || this._resetHistory || old.frame !== this._frame - 1 || old.target !== target || old.cam !== prev) return;

        // Predict centre-of-view flow from camera translation and rotation. Each candidate ray
        // also checks the previous projection at its own pixel and cloud depth.
        const [width, height] = this._targetSize;
        let nearest = Math.max(0.3, s.cloudBottomKm - altitude, altitude - s.cloudTopKm);
        if (s.altoClouds > 0) nearest = Math.min(nearest, Math.max(0.3, s.altoBottomKm - altitude, altitude - s.altoTopKm));
        if (weatherStyle[3] > 0) nearest = Math.min(nearest, Math.max(0.3, s.lowCloudBottomKm - altitude, altitude - s.lowCloudTopKm));
        const translation = sub(cam.pos, prev.pos);
        const centre = cam.back.map((axis, i) => -axis * nearest + translation[i]);
        const z = -dot(centre, prev.back);
        if (z <= 0.001) return;
        const motion = state.motion = [
            (prev.proj[0] * dot(centre, prev.right) / z - prev.proj[2] + cam.proj[2]) * width * 0.5,
            (prev.proj[1] * dot(centre, prev.up) / z - prev.proj[3] + cam.proj[3]) * height * -0.5,
        ];
        const prediction = motion.map((v, i) => v + 0.5 * (v - old.motion[i]));
        if (Math.max(Math.hypot(...motion), Math.hypot(...prediction)) > 0.25) return;
        if (key !== old.key || cam.proj.slice(0, 4).some((v, i) => v !== prev.proj[i])) return;
        if (Math.abs(coverage - old.coverage) > 1e-4 || weatherStyle.some((v, i) => Math.abs(v - old.weatherStyle[i]) > 1e-4)) return;
        if (light.some((v, i) => Math.abs(v - old.light[i]) > 2e-4)) return;

        const wind = sub(state.shape, old.shape);
        const detail = sub(sub(state.detail, old.detail), wind);
        const residual = Math.hypot(...detail) + Math.abs(state.boil - old.boil) + Math.abs(state.evolve - old.evolve);
        // At long frame intervals the detail, shape and weather no longer move together.
        // If most candidates will fail the pixel check, dispatch the regular raymarch directly.
        if (residual > 0.0025) return;
        this._uniformData.set([...wind, residual, this._frame % 2, nearest], 48 * 4);
        state.canReuse = true;
    }

    _updateConventionalHistory(active, camera, weatherStyle) {
        this._conventionalHistoryActive = active;
        const prior = this._conventionalFrame;
        this._conventionalFrame = null;
        const data = this._uniformData;
        data[49 * 4 + 2] = 0;
        if (!active) return;
        const { coverage, ...look } = this.settings;
        const key = JSON.stringify(look);
        const state = this._conventionalFrame = {
            frame: this._frame, camera, key, coverage, weatherStyle, wind: this._windShape.slice(),
            sun: [...this.sunDirection, this.sunIlluminance, ...this.moonDirection, this.moonIlluminance],
        };
        data[49 * 4 + 2] = 1;
        if (!prior || this._resetHistory || prior.frame !== state.frame - 1 || prior.key !== key
            || Math.abs(prior.coverage - coverage) > 0.015
            || prior.weatherStyle.some((x, i) => Math.abs(x - weatherStyle[i]) > 0.035)
            || dot(prior.camera.back, camera.back) < 0.94
            // Perspective depth coefficients change with altitude. Cloud reprojection uses only XY.
            || prior.camera.proj.slice(0, 4).some((x, i) => x !== camera.proj[i])
            || prior.sun.some((x, i) => Math.abs(x - state.sun[i]) > 0.025)) return;
        data.set(sub(state.wind, prior.wind), 48 * 4);
        data[49 * 4 + 2] = 2;
    }

    _writeUniforms(frame) {
        const s = this.settings;
        const weather = this.weather;
        const budget = this.budgetTier;
        const conventional = !!budget?.conventional;
        const stretchMode = !budget && s.towerDebugMode === 'stretched';
        const deckMode = !budget && s.towerDebugMode === 'deck';
        const preview = stretchMode || deckMode;
        const presence = preview ? 1 : (weather?.presence ?? 1);
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
        const orbitStart = conventional ? budget.orbitStartKm : s.orbitalPreview?.proxyStartKm ?? s.proxyStartKm;
        const orbitEnd = conventional ? budget.orbitEndKm : s.orbitalPreview?.proxyEndKm ?? s.proxyEndKm;
        this.farProxyWeight = s.farProxy ? smoothstep(orbitStart, orbitEnd, aboveTops) : 0;
        // In the handoff, spend most samples on the layer carrying most of the opacity.
        const orbitSlabs = conventional ? 8 + (budget.orbitSlabs - 8) * this.farProxyWeight
            : s.orbitalPreview?.orbitalProxySlabs ?? s.orbitalProxySlabs;
        this.proxyWeight = this.farProxyWeight;
        if (!conventional && s.groundProxyBelowKm > 0) {
            const ground = s.groundProxyBlendKm > 0
                ? 1 - smoothstep(s.groundProxyBelowKm, s.groundProxyBelowKm + s.groundProxyBlendKm, altitude)
                : (altitude < s.groundProxyBelowKm ? 1 : 0);
            this.proxyWeight = Math.max(this.proxyWeight, ground);
        }
        this._proxyCrossfade = this.proxyWeight > 0.001 && this.proxyWeight < 0.999;
        const ground = normalize(cam.pos).map(x => x * R);
        let sf = this._shadowFrame;
        if (!sf || sf.extent !== extent || sf.R !== R || Math.hypot(...sub(ground, sf.anchor)) > extent * 0.15) {
            const n = normalize(cam.pos);
            const e1 = normalize(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
            sf = this._shadowFrame = { anchor: ground, e1, e2: cross(n, e1), extent, R };
        }
        const { e1, e2 } = sf;
        if (dot(sun, cross(e1, e2)) < 0.0199) this.shadowFade = 0;
        if (budget?.cirrusOnly || (presence <= 0.001 && (weather?.low ?? 0) <= 0.001)) this.shadowFade = 0;
        // Only the shadow plane, sun, and base density field affect this texture. Reuse it
        // when the camera, moon, exposure, or reconstruction are the only things changing.
        if (this.shadowFade > 0) {
            const n = cross(e1, e2);
            const slope = [e1, e2].map(axis => dot(sun, axis) / dot(sun, n) * s.cloudTopKm);
            const share = extent / SHADOW_SIZE * 10;
            // What drifts every frame, in kilometres of shadow movement: the sun, the wind, the boil, then weather
            // (a tenth of its range counts as a texel), and the evolution.
            this._shadowDrift = [...slope, ...this._windShape, this._boil, ...[...this.windDirection, s.coverage, presence,
                weather?.deck ?? 0, weather?.rainShade ?? 0, weather?.low ?? 0].map(value => value * share), this._evolve];
            this._shadowInputs = JSON.stringify([
                R, bottom, s.cloudTopKm, e1, e2, extent, s.windSkewKm,
                s.systemTileKm, s.systemStrength, s.systemWarp, s.systemOffset,
                s.weatherTileKm, s.largeWeatherTileKm, s.coverageGain, s.weatherContrast, s.cloudType, s.typeVariance,
                s.shapeTileKm, s.shapeOffset, s.cloudShape, s.domeHeight, s.domeHeads, s.domeEdgeSharpness,
                s.giantShare, s.giantHeight, s.giantScale, s.popcornTopKm, s.densityVariation,
                s.isolatedPuffSuppression, s.altoClouds, s.altoBottomKm, s.altoTopKm, s.altoTileKm,
                stretchMode, deckMode, s.cloudBudgetMode, s.lowCloudBottomKm, s.lowCloudTopKm, s.lowCloudTileKm,
            ]);
        }

        const d = sub(cam.pos, prev.pos);
        const baseK = this._blockFactor;
        let k = baseK;
        if (this._motionPixels(cam, prev, altitude, height) > s.motionThresholdPx) this._fullRateFrames = 8;
        const moving = this._fullRateFrames > 0;
        if (moving) {
            this._fullRateFrames--;
            if (s.fullRateOnMotion) k = 1;
        }
        if (!s.temporal || budget) k = 1;
        this._activeK = k;
        const [ox, oy] = k === 2 ? INTERLEAVE_ORDER[this._frame % 4] : [0, 0];
        // At rest each pixel gets a fresh sample every baseK² frames, weighted to keep the history time
        // constant; while moving, fresh samples weigh at least motionBlend.
        const restBlend = Math.min(1, s.temporalBlend * baseK * baseK);
        const blend = this._resetHistory || !s.temporal ? 1 : (moving ? Math.max(restBlend, s.motionBlend) : restBlend);
        const pixelAngle = 2 / (cam.proj[1] * height);
        this._spatialStride = 0;
        const useSparseRays = s.spatialSampling && !deckMode && !budget;
        if (useSparseRays && !s.temporal && s.spatialFilter >= 0.999 && !s.debugSteps && this.farProxyWeight <= 0.001) {
            this._spatialStride = Math.max(1, Math.min(3, Math.floor(s.spatialMaxRayAngle / pixelAngle)));
            this._ensureSpatialTargets(this._spatialStride);
        }
        const rayFootprint = pixelAngle * Math.max(1, this._spatialStride * 0.9);
        const lighting = s.denseDeckLighting;
        const deckWeight = lighting ? smoothstep(lighting.startDeck, lighting.fullDeck, weather?.deck ?? 0) : 0;
        const reuseSteps = Math.max(1, Math.round(s.lightReuseSteps || 1));
        const reuseMaxKm = Math.max(0, s.lightReuseMaxKm ?? 1);
        const baseReuseBelow = reuseSteps > 1 ? s.lightReuseBelowTransmittance : 0;
        const reuseBelow = lighting ? baseReuseBelow + (lighting.reuseBelow - baseReuseBelow) * deckWeight : baseReuseBelow;
        const deckReuseSteps = deckWeight > 0 ? Math.max(reuseSteps, lighting.steps) : reuseSteps;
        const deckReuseMaxKm = lighting ? reuseMaxKm + (Math.min(reuseMaxKm, lighting.maxKm) - reuseMaxKm) * deckWeight : reuseMaxKm;
        const data = this._uniformData;
        const moon = normalize(this.moonDirection);
        const weatherStyle = [presence, weather?.deck ?? 0, weather?.rainShade ?? 0, weather?.low ?? 0];
        data.set([
            ...cam.pos, frame.time,
            ...cam.right, cam.proj[0],
            ...cam.up, cam.proj[1],
            ...cam.back, cam.proj[2],
            cam.proj[3], s.temporal || (conventional && s.conventionalTemporal) ? this._frame : 0, width, height,
            ...prev.right, prev.proj[0],
            ...prev.up, prev.proj[1],
            ...prev.back, prev.proj[2],
            prev.proj[3], ...d,
            ...sun, this.sunIlluminance,
            R, R + bottom, R + s.cloudTopKm, R + this.planet.atmosphereHeightKm,
            1 / s.shapeTileKm, 1 / s.detailTileKm, 1 / s.weatherTileKm, 1 / s.largeWeatherTileKm,
            Math.min(1, (preview ? Math.max(0.17, s.coverage) : s.coverage) * (s.coverageGain ?? 1)),
            s.weatherContrast, s.cloudType, s.typeVariance,
            s.extinction, s.detailErosion, s.detailWarp, s.albedo,
            ...this._windShape, s.spatialFilter,
            ...this._windDetail, s.windSkewKm,
            s.phaseForward, s.phaseBack, s.backLobeWeight, s.powder,
            s.ambient, s.msExtinction, s.msScattering, s.msPhase,
            s.maxSteps, s.minStepKm, s.stepGrowth, s.maxStepKm,
            s.lightStepKm, rayFootprint, blend, s.debugSteps ? 1 : 0,
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
            Math.max(0, s.edgeSoftness), s.farAverageStartKm, s.farAverageEndKm, s.farAverageDensity,
            ...moon, this.moonIlluminance,
            deckReuseSteps, deckReuseMaxKm, s.cloudShape === 'domes' ? Math.max(0.6, s.domeHeight ?? 1) : 0, Math.max(0.1, s.sunsetDepth ?? 1),
            Math.max(0, s.giantShare ?? 0), Math.max(1, s.giantHeight ?? 2.5), Math.max(1, s.giantScale ?? 3),
            Math.min(0.92, Math.max(0.05, (s.popcornTopKm ?? 1.6) / Math.max(0.1, s.cloudTopKm - s.cloudBottomKm))),
            Math.max(0, s.inScatter ?? 0), Math.max(0, s.aoSide ?? 0), Math.max(0, s.inScatterGain ?? 2.5), Math.max(0.05, s.sunsetAltitudeScale ?? 1),
            Math.max(0.5, s.domeEdgeSharpness ?? 1.5), Math.max(0, s.domeHeads ?? 0.6), Math.max(0, s.duskSkyBoost ?? 0), s.stepStratify === 'ign' ? 2 : s.stepStratify ? 1 : 0,
            Math.max(0, s.stepAnchorKm ?? 0), Math.max(0, s.detailPixelFootprint ?? 0),
            Math.max(1, Math.min(32, Math.round(orbitSlabs))), Math.max(16, Math.min(512, Math.round(s.solarReferenceSteps))),
            Math.min(1, Math.max(0, s.twilightCloudLight)), Math.max(0, s.detailMinTransmittance ?? 0), this._spatialStride, Math.max(0, s.edgeWisps ?? 0),
            Math.max(0, Math.min(1, s.densityVariation ?? 0)),
            Math.max(0, Math.min(1, s.isolatedPuffSuppression ?? 0)),
            Math.max(0, s.daylightSkyFill ?? 0), Math.max(1, s.daylightSunGain ?? 1),
            Math.min(1, Math.max(0, s.distantBanks)),
            Math.max(0, s.distantBanksStartKm),
            Math.max(s.distantBanksStartKm + 0.01, s.distantBanksEndKm),
            1 / Math.max(1, s.distantBanksTileKm),
            Math.max(0, s.altoClouds), R + s.altoBottomKm, R + Math.max(s.altoBottomKm + 0.01, s.altoTopKm),
            1 / Math.max(1, s.altoTileKm),
            ...weatherStyle,
            R + s.lowCloudBottomKm, R + Math.max(s.lowCloudBottomKm + 0.01, s.lowCloudTopKm),
            1 / Math.max(1, s.lowCloudTileKm), 0,
            weather?.mist ?? 0, R + Math.max(0.01, s.groundMistTopKm),
            Math.max(0.01, s.groundMistScaleKm), Math.max(0, s.groundMistExtinction),
            Math.min(1, Math.max(0, reuseBelow)), this._proxyCrossfade ? 1 : 0, stretchMode ? 1 : 0, deckMode ? 1 : 0,
        ]);
        this._updateRayHistory(cam, prev, altitude, moon, weatherStyle);
        this._updateConventionalHistory(conventional && !budget.cirrusOnly && s.conventionalTemporal === true && this.farProxyWeight <= 0.001,
            cam, weatherStyle);
        if (['weather', 'light', 'transport', 'layered'].includes(s.cloudCacheMode)) {
            this._cacheGrid = cloudCacheGrid(cam.pos, R, s.cloudCacheMode);
            data.set(this._cacheGrid, 50 * 4);
        }
        if (conventional) {
            this._budgetBulkOnly = false;
            const steps = Math.max(1, Math.round(budget.steps - 2 * this.farProxyWeight * budget.orbitSlabs));
            data[49 * 4 + 3] = Math.max(0, s.conventionalSunShadowStrength);
            data.set([budget.focusKm, steps, budget.lowSteps, (s.conventionalColumnLight === false ? 3 : 2) + conventionalPreviewFlags(s, budget) / 16], 53 * 4);
        } else if (budget) {
            const wet = smoothstep(0.25, 0.9, weather?.deck ?? 0);
            const limit = budget.fairKm + (budget.nearKm - budget.fairKm) * wet;
            this._budgetBulkOnly = Math.max(bottom - altitude, altitude - s.cloudTopKm) > limit + 0.01;
            data.set([limit, budget.nearSteps, wet, 1], 53 * 4);
        } else {
            this._budgetBulkOnly = false;
            data.fill(0, 53 * 4);
        }
        this.device.queue.writeBuffer(this._uniformBuffer, 0, data);
        this._prev = cam;
    }
}
