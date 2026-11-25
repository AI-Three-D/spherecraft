import { WEATHER_CONFIG } from '../../../templates/configs/weatherConfig.js';
import { createWeatherComputeShader } from './shaders/weatherCompute.wgsl.js';

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, nested] of Object.entries(value)) out[key] = cloneValue(nested);
        return out;
    }
    return value;
}

function mergeConfig(base, override) {
    const out = cloneValue(base);
    if (!override || typeof override !== 'object') return out;
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = mergeConfig(out[key], value);
        } else {
            out[key] = cloneValue(value);
        }
    }
    return out;
}

function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
    const n = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeWaterEffect(raw = {}) {
    return {
        waveHeight: finiteNumber(raw.waveHeight, 0.2, 0, 20),
        windWaveScale: finiteNumber(raw.windWaveScale, 1.0, 0, 20),
        precipitationWaveScale: finiteNumber(raw.precipitationWaveScale, 0.0, 0, 20),
        waveFrequency: finiteNumber(raw.waveFrequency, 1.0, 0.05, 10),
        windFrequencyScale: finiteNumber(raw.windFrequencyScale, 0.4, 0, 10),
        precipitationFrequencyScale: finiteNumber(raw.precipitationFrequencyScale, 0.1, 0, 10),
        foamIntensity: finiteNumber(raw.foamIntensity, 0.3, 0, 10),
        windFoamScale: finiteNumber(raw.windFoamScale, 1.0, 0, 20),
        precipitationFoamScale: finiteNumber(raw.precipitationFoamScale, 0.0, 0, 20),
        foamDepthEnd: finiteNumber(raw.foamDepthEnd, 2.0, 0, 40),
        foamDepthWeatherScale: finiteNumber(raw.foamDepthWeatherScale, 0.0, 0, 40),
    };
}

function normalizeRainParticles(raw = {}, precipitationIntensity = 0) {
    const hasRain = precipitationIntensity > 0.01;
    return {
        enabled: raw.enabled ?? hasRain,
        spawnBudgetPerFrame: Math.max(0, Math.trunc(finiteNumber(raw.spawnBudgetPerFrame, hasRain ? 160 : 0, 0, 2048))),
        distanceCutoff: finiteNumber(raw.distanceCutoff, 100, 1, 1000),
        lodNearDistance: finiteNumber(raw.lodNearDistance, 24, 0, 1000),
        lodFarDistance: finiteNumber(raw.lodFarDistance, 90, 0, 1000),
        lodMinScale: finiteNumber(raw.lodMinScale, 0.35, 0, 1),
        maxCameraAltitude: finiteNumber(raw.maxCameraAltitude, 25000, 1, 10000000),
    };
}

function normalizeCloudEffect(raw = {}) {
    return {
        presence: finiteNumber(raw.presence, 1, 0, 1),
        deck: finiteNumber(raw.deck, 0, 0, 1),
        rainShade: finiteNumber(raw.rainShade, 0, 0, 1),
        low: finiteNumber(raw.low, 0, 0, 1),
        mist: finiteNumber(raw.mist, 0, 0, 1),
        // The sheet cloud of the deck: how thick and how opaque (1 = the full rain deck), how even (1 = no gaps), and how
        // much of it is cells instead of broad billows.
        thickness: finiteNumber(raw.thickness, 1, 0.05, 1.5),
        opacity: finiteNumber(raw.opacity, 1, 0.01, 1.5),
        evenness: finiteNumber(raw.evenness, 0, 0, 1),
        cells: finiteNumber(raw.cells, 0, 0, 1),
        alto: finiteNumber(raw.alto, 1, 0, 1), // share of the altocumulus
    };
}

// Other forms of the same weather: numbers that differ from it.
function normalizeVariants(effect, raw) {
    const number = (source, key) => finiteNumber(source[key], effect[key], 0, 1);
    return (Array.isArray(raw) ? raw : []).filter(v => v && typeof v === 'object').map(variant => ({
        name: typeof variant.name === 'string' ? variant.name : '',
        weight: finiteNumber(variant.weight, 1, 0, 1000),
        cloudCoverage: number(variant, 'cloudCoverage'),
        precipitationIntensity: number(variant, 'precipitationIntensity'),
        fogDensity: number(variant, 'fogDensity'),
        clouds: normalizeCloudEffect({ ...effect.clouds, ...variant.clouds }),
    }));
}

function normalizeWeatherEffects(rawEffects = {}) {
    const source = rawEffects && typeof rawEffects === 'object' ? rawEffects : {};
    const effects = {};
    for (const [name, raw] of Object.entries(source)) {
        if (!raw || typeof raw !== 'object') continue;
        const precipitation = finiteNumber(raw.precipitationIntensity, 0, 0, 1);
        effects[name] = {
            name,
            label: typeof raw.label === 'string' ? raw.label : name,
            weight: finiteNumber(raw.weight, 1, 0, 1000),
            intensity: finiteNumber(raw.intensity, 0, 0, 1),
            cloudCoverage: finiteNumber(raw.cloudCoverage, 0, 0, 1),
            precipitationIntensity: precipitation,
            fogDensity: finiteNumber(raw.fogDensity, 0, 0, 1),
            fogMultiplier: finiteNumber(raw.fogMultiplier, 1, 0, 10),
            clouds: normalizeCloudEffect(raw.clouds ?? {}),
            water: normalizeWaterEffect(raw.water || {}),
            rainParticles: normalizeRainParticles(raw.rainParticles || {}, precipitation),
        };
        effects[name].variants = normalizeVariants(effects[name], raw.variants);
    }
    return effects;
}

function blendNumber(a, b, t) {
    return a + (b - a) * t;
}

function blendObjectNumbers(a = {}, b = {}, t = 1) {
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        const av = Number.isFinite(a[key]) ? a[key] : b[key];
        const bv = Number.isFinite(b[key]) ? b[key] : av;
        out[key] = blendNumber(av ?? 0, bv ?? 0, t);
    }
    return out;
}

export class WeatherController {
    constructor(backend, config = {}) {
        this.backend = backend;
        if (typeof config.cloudLayerProvider !== 'function') {
            throw new Error('WeatherController requires config.cloudLayerProvider function');
        }

        const aliasConfig = { ...config };
        if (aliasConfig.weatherStates && !aliasConfig.effects) aliasConfig.effects = aliasConfig.weatherStates;
        if (aliasConfig.states && !aliasConfig.effects) aliasConfig.effects = aliasConfig.states;
        const merged = mergeConfig(WEATHER_CONFIG, aliasConfig);

        this._cloudLayerProvider = config.cloudLayerProvider;
        this._random = typeof config.random === 'function' ? config.random : Math.random;
        this.config = {
            enabled: merged.enabled ?? true,
            resolution: merged.resolution ?? 128,
            updateHz: merged.updateHz ?? 2,
            windStrength: merged.windStrength ?? 20.0,
            advection: merged.advection ?? 1.0,
            diffusion: merged.diffusion ?? 0.15,
            precipitationRate: merged.precipitationRate ?? 0.6,
            evaporation: merged.evaporation ?? 0.2,
            noiseScale: merged.noiseScale ?? 2.0,
            initialWeather: merged.initialWeather ?? 'clear',
            transitionDurationSeconds: finiteNumber(merged.transitionDurationSeconds, 90, 0.1, 3600),
            previewTransitionSeconds: finiteNumber(merged.previewTransitionSeconds, 12, 0.1, 3600),
            rainLeadFraction: finiteNumber(merged.rainLeadFraction, 0.32, 0, 0.85),
            weatherChangeChancePerSecond: finiteNumber(merged.weatherChangeChancePerSecond, 0.06, 0, 10),
            variantChangeChancePerSecond: finiteNumber(merged.variantChangeChancePerSecond, 0.012, 0, 10),
            variantTransitionSeconds: finiteNumber(merged.variantTransitionSeconds, 45, 0.1, 3600),
            windChangeChancePerSecond: finiteNumber(merged.windChangeChancePerSecond, 0.30, 0, 10),
            windSpeedRange: Array.isArray(merged.windSpeedRange)
                ? [finiteNumber(merged.windSpeedRange[0], 2, 0, 1000), finiteNumber(merged.windSpeedRange[1], 22, 0, 1000)]
                : [2, 22],
            cloudLayerRefreshHz: finiteNumber(merged.cloudLayerRefreshHz, 1.0, 0.05, 60),
            transitions: merged.transitions,
        };
        if (this.config.windSpeedRange[0] > this.config.windSpeedRange[1]) {
            this.config.windSpeedRange.reverse();
        }

        this.effects = normalizeWeatherEffects(merged.effects);
        if (Object.keys(this.effects).length === 0) {
            this.effects = normalizeWeatherEffects(WEATHER_CONFIG.effects);
        }

        // --- Logic State ---
        this._weatherKeys = Object.keys(this.effects);
        this._targetWeather = this.effects[this.config.initialWeather]
            ? this.config.initialWeather
            : (this._weatherKeys[0] || 'clear');
        this._transitionProgress = 1.0;
        this._transitionDuration = this.config.transitionDurationSeconds;
        this._previewWeather = null;
        this._rollVariant();
        this._startEffectSnapshot = this._createEffectSnapshot(this._targetWeather);
        this._currentEffectSnapshot = this._createEffectSnapshot(this._targetWeather);
        this._startCloudLayers = null;
        this._currentCloudLayers = null;
        this._lastCloudLayerUpdateTime = -Infinity;

        // Wind Logic
        this._windAngle = 0.0;
        this._targetWindAngle = 0.0;
        this._targetWindSpeed = this.config.windSpeedRange[0] +
            (this.config.windSpeedRange[1] - this.config.windSpeedRange[0]) * 0.2;

        // GPU Compute State
        this._initialized = false;
        this._time = 0;
        this._accum = 0;
        this._blend = 0.0;
        this._currentIndex = 0;
        this._weatherTextures = [null, null];
        this._weatherViews = [null, null];
        this._bindGroups = [null, null];
        this._uniformBuffer = null;
        this._pipeline = null;
        this._sampler = null;
    }

    async initialize() {
        if (this._initialized || !this.config.enabled) return;
        const device = this.backend?.device;
        if (!device) return;

        const size = this.config.resolution;
        const layers = 6;

        for (let i = 0; i < 2; i++) {
            const tex = device.createTexture({
                label: `WeatherSim_${i}`,
                size: [size, size, layers],
                dimension: '2d',
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
            });
            this._weatherTextures[i] = tex;
            this._weatherViews[i] = tex.createView({ dimension: '2d-array' });
        }

        this._uniformBuffer = device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });

        const shaderModule = device.createShaderModule({ code: createWeatherComputeShader() });
        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } }
            ]
        });

        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
        this._pipeline = device.createComputePipeline({
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        for (let i = 0; i < 2; i++) {
            this._bindGroups[i] = device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this._uniformBuffer } },
                    { binding: 1, resource: this._weatherViews[i] },
                    { binding: 2, resource: this._sampler },
                    { binding: 3, resource: this._weatherViews[1 - i] }
                ]
            });
        }

        this._initialized = true;
    }

    /**
     * Main update loop. Updates both GPU simulation and modifies EnvironmentState.
     */
    update(deltaTime, environmentState) {
        if (!this.config.enabled) return;
        if (this._initialized) this._updateGPUSimulation(deltaTime);
        else this._time += deltaTime;

        if (environmentState) {
            this._updateWeatherLogic(deltaTime, environmentState);
        }
    }

    _updateGPUSimulation(deltaTime) {
        if (!this.config.enabled) return;

        this._time += deltaTime;
        this._accum += deltaTime;
        const interval = 1.0 / Math.max(this.config.updateHz, 0.1);

        let steps = 0;
        while (this._accum >= interval && steps < 4) {
            this._accum -= interval;
            this._dispatch(interval);
            this._currentIndex = 1 - this._currentIndex;
            steps++;
        }
        this._blend = Math.max(0.0, Math.min(1.0, this._accum / interval));
    }

    _updateWeatherLogic(deltaTime, envState) {
        if (this._previewWeather === null && this._transitionProgress >= 1.0 &&
            Math.random() < this.config.weatherChangeChancePerSecond * deltaTime) {
            this._pickNewWeatherTarget();
        }
        // The same weather takes other forms as it goes on.
        if (this._transitionProgress >= 1.0 && this._random() < this.config.variantChangeChancePerSecond * deltaTime) {
            this.nextVariant();
        }
        if (Math.random() < this.config.windChangeChancePerSecond * deltaTime) {
            this._pickNewWindTarget();
        }

        this._updateWind(deltaTime, envState);

        if (this._transitionProgress < 1.0) {
            this._transitionProgress = Math.min(
                1.0,
                this._transitionProgress + deltaTime / this._transitionDuration
            );
        }

        const targetEffect = this._createEffectSnapshot(this._targetWeather);
        const blendT = this._smoothstep(this._transitionProgress);
        const lead = this.config.rainLeadFraction;
        const arrivingRain = targetEffect.precipitationIntensity > this._startEffectSnapshot.precipitationIntensity;
        const rainProgress = arrivingRain
            ? (this._transitionProgress - lead) / (1 - lead)
            : this._transitionProgress / (1 - lead);
        const shadeProgress = targetEffect.clouds.rainShade > this._startEffectSnapshot.clouds.rainShade
            ? this._transitionProgress / (1 - lead)
            : this._transitionProgress;
        const blendedEffect = this._blendEffectSnapshots(
            this._startEffectSnapshot,
            targetEffect,
            blendT,
            this._smoothstep(finiteNumber(rainProgress, 0, 0, 1)),
            this._smoothstep(finiteNumber(shadeProgress, 0, 0, 1))
        );
        this._currentEffectSnapshot = blendedEffect;

        envState.weatherIntensity = blendedEffect.intensity;
        envState.cloudCoverage = blendedEffect.cloudCoverage;
        envState.precipitationIntensity = blendedEffect.precipitationIntensity;
        envState.fogDensity = blendedEffect.fogDensity;
        envState.weatherFogMultiplier = blendedEffect.fogMultiplier;
        envState.weatherEffect = blendedEffect;
        envState.rainParticles = this._resolveRainParticles(
            blendedEffect.rainParticles,
            blendedEffect.precipitationIntensity
        );

        if (this._transitionProgress > 0.5 || envState.currentWeather == null) {
            envState.currentWeather = this._targetWeather;
        }

        this._updateWaterState(envState, deltaTime, blendedEffect);

        const layerInterval = 1.0 / this.config.cloudLayerRefreshHz;
        if (
            envState.forceCirrusOnly ||
            this._time - this._lastCloudLayerUpdateTime >= layerInterval ||
            this._transitionProgress < 1.0 ||
            !Array.isArray(envState.cloudLayers) ||
            envState.cloudLayers.length === 0
        ) {
            envState.cloudLayers = this._computeCloudLayers(envState, targetEffect, blendT);
            this._lastCloudLayerUpdateTime = this._time;
        }
    }

    _updateWind(deltaTime, envState) {
        let angDiff = this._targetWindAngle - this._windAngle;
        angDiff = ((angDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
        const maxAngStep = 0.1 * deltaTime;
        if (Math.abs(angDiff) <= maxAngStep) this._windAngle = this._targetWindAngle;
        else this._windAngle += Math.sign(angDiff) * maxAngStep;

        const speedDiff = this._targetWindSpeed - envState.windSpeed;
        const maxSpeedStep = 2.0 * deltaTime;
        if (Math.abs(speedDiff) <= maxSpeedStep) envState.windSpeed = this._targetWindSpeed;
        else envState.windSpeed += Math.sign(speedDiff) * maxSpeedStep;

        envState.windDirection.set(Math.cos(this._windAngle), Math.sin(this._windAngle));
    }

    _updateWaterState(envState, dt, effect) {
        const water = effect?.water || normalizeWaterEffect();
        const timeVar = Math.sin(this._time * 0.5);
        const windFactor = Math.max(0, (envState.windSpeed - 2.0) / 25.0);
        const rainFactor = Math.max(0, effect?.precipitationIntensity ?? 0);

        let targetHeight =
            water.waveHeight +
            windFactor * water.windWaveScale +
            rainFactor * water.precipitationWaveScale;
        targetHeight += timeVar * 0.1;

        let targetFreq =
            water.waveFrequency -
            windFactor * water.windFrequencyScale -
            rainFactor * water.precipitationFrequencyScale;
        targetFreq += timeVar * 0.05;

        const targetFoam =
            water.foamIntensity +
            windFactor * water.windFoamScale +
            rainFactor * water.precipitationFoamScale;

        envState.water.waveHeight = Math.max(0, targetHeight);
        envState.water.waveFrequency = Math.max(0.05, targetFreq);
        envState.water.foamIntensity = Math.max(0, targetFoam);
        envState.water.foamDepthEnd =
            water.foamDepthEnd + rainFactor * water.foamDepthWeatherScale + Math.max(0, targetHeight - 0.2) * 0.5;
    }

    _pickNewWeatherTarget() {
        const next = this._pickWeightedWeather();
        if (!next || next === this._targetWeather) return;

        this.setWeather(next);
    }

    _pickWeightedWeather() {
        const neighbors = this.config.transitions?.[this._targetWeather];
        let candidates = (Array.isArray(neighbors) ? neighbors : this._weatherKeys)
            .map((name) => this.effects[name])
            .filter((effect) => effect && effect.weight > 0);
        if (candidates.length === 0 && Array.isArray(neighbors)) {
            candidates = Object.values(this.effects).filter(effect => effect.weight > 0);
        }
        if (candidates.length === 0) return this._targetWeather;

        const total = candidates.reduce((sum, effect) => sum + effect.weight, 0);
        let r = Math.random() * total;
        for (const effect of candidates) {
            r -= effect.weight;
            if (r <= 0) return effect.name;
        }
        return candidates[candidates.length - 1].name;
    }

    _pickNewWindTarget() {
        const [minSpeed, maxSpeed] = this.config.windSpeedRange;
        this._targetWindAngle = Math.random() * Math.PI * 2;
        this._targetWindSpeed = minSpeed + Math.random() * (maxSpeed - minSpeed);
    }

    _computeCloudLayers(envState, targetEffect, t) {
        const atmosphereHeight = envState.planetConfig?.atmosphereHeight || 100000;

        if (envState.forceCirrusOnly) {
            return [{
                name: 'high', altMin: atmosphereHeight * 0.38, altMax: atmosphereHeight * 0.72,
                coverage: 0.45, densityMultiplier: 0.16, noiseScale: 2.2,
                verticalStretch: 2.6, worleyInfluence: 0.25, edgeSoftness: 0.95,
                extinction: 0.012, albedo: 0.95, precipitation: 0.0, darkness: 0.0
            }];
        }
        const target = this._cloudLayerProvider(targetEffect.name, targetEffect.intensity, atmosphereHeight);
        if (t >= 1) {
            this._currentCloudLayers = target;
            return target;
        }
        const sourceEffect = this._startEffectSnapshot;
        const sourceLayers = this._startCloudLayers
            ?? this._cloudLayerProvider(sourceEffect.name, sourceEffect.intensity, atmosphereHeight);
        const sources = new Map(sourceLayers.map(layer => [layer.name, layer]));
        const destinations = new Map(target.map(layer => [layer.name, layer]));
        const names = new Set([...sources.keys(), ...destinations.keys()]);
        this._currentCloudLayers = Array.from(names, name => {
            const a = sources.get(name);
            const b = destinations.get(name);
            const start = a ?? { ...b, coverage: 0 };
            const end = b ?? { ...a, coverage: 0 };
            return { ...start, ...blendObjectNumbers(start, end, t), name };
        });
        return this._currentCloudLayers;
    }

    _createEffectSnapshot(weather) {
        const effect = this.effects[weather] || this.effects.clear || Object.values(this.effects)[0] || {
            name: 'clear',
            intensity: 0,
            cloudCoverage: 0,
            precipitationIntensity: 0,
            fogDensity: 0,
            fogMultiplier: 1,
            clouds: normalizeCloudEffect(),
            water: normalizeWaterEffect(),
            rainParticles: normalizeRainParticles({}, 0),
        };
        return {
            name: effect.name,
            intensity: effect.intensity,
            cloudCoverage: effect.cloudCoverage,
            precipitationIntensity: effect.precipitationIntensity,
            fogDensity: effect.fogDensity,
            fogMultiplier: effect.fogMultiplier,
            ...this._variantOf(effect),
            water: { ...effect.water },
            rainParticles: { ...effect.rainParticles },
        };
    }

    // Between two forms of the target weather, so that no two spells of it are the same.
    _rollVariant() {
        const effect = this.effects[this._targetWeather];
        const forms = effect ? [effect, ...effect.variants] : [];
        const pick = () => {
            let r = this._random() * forms.reduce((sum, form) => sum + (form === effect ? 1 : form.weight), 0);
            return forms.find(form => (r -= form === effect ? 1 : form.weight) <= 0) ?? forms[0];
        };
        const last = this._variant?.form;
        let form = pick();
        if (form === last) form = pick();
        this._variant = { effect, form, other: pick(), share: 0.5 * this._random() };
    }

    _variantOf(effect) {
        const variant = this._variant?.effect === effect ? this._variant : null;
        const { form = effect, other = effect, share = 0 } = variant ?? {};
        const blend = key => blendNumber(form[key], other[key], share);
        return {
            cloudCoverage: blend('cloudCoverage'),
            precipitationIntensity: blend('precipitationIntensity'),
            fogDensity: blend('fogDensity'),
            clouds: blendObjectNumbers(form.clouds, other.clouds, share),
        };
    }

    /** Lets the present weather turn into another form of itself. */
    nextVariant(duration = this.config.variantTransitionSeconds) {
        if (!this.effects[this._targetWeather]?.variants.length) return false;
        return this.setWeather(this._targetWeather, false, duration);
    }

    _blendEffectSnapshots(a, b, t, precipitationT, shadeT) {
        const rainParticles = (b.rainParticles?.enabled || t >= 0.98)
            ? b.rainParticles
            : (a.rainParticles?.enabled ? a.rainParticles : b.rainParticles);
        return {
            name: b.name,
            intensity: blendNumber(a.intensity, b.intensity, t),
            cloudCoverage: blendNumber(a.cloudCoverage, b.cloudCoverage, t),
            precipitationIntensity: blendNumber(a.precipitationIntensity, b.precipitationIntensity, precipitationT),
            fogDensity: blendNumber(a.fogDensity, b.fogDensity, t),
            fogMultiplier: blendNumber(a.fogMultiplier, b.fogMultiplier, t),
            clouds: {
                ...blendObjectNumbers(a.clouds, b.clouds, t),
                rainShade: blendNumber(a.clouds.rainShade, b.clouds.rainShade, shadeT),
            },
            water: blendObjectNumbers(a.water, b.water, t),
            rainParticles: { ...rainParticles },
        };
    }

    _resolveRainParticles(config, precipitationIntensity) {
        const base = normalizeRainParticles(config || {}, precipitationIntensity);
        const intensity = Math.max(0, Math.min(1, precipitationIntensity));
        return {
            ...base,
            intensity,
            enabled: base.enabled && intensity > 0.02 && base.spawnBudgetPerFrame > 0,
            spawnBudgetPerFrame: Math.max(0, Math.round(base.spawnBudgetPerFrame * intensity)),
        };
    }

    _smoothstep(t) {
        return t * t * (3 - 2 * t);
    }

    _dispatch(dt) {
        const device = this.backend.device;
        const size = this.config.resolution;
        const data = new ArrayBuffer(80);
        const view = new DataView(data);

        view.setUint32(0, size, true);
        view.setUint32(4, 6, true);
        view.setUint32(8, 0, true);
        view.setUint32(12, 0, true);
        view.setFloat32(16, this._time, true);
        view.setFloat32(20, dt, true);
        view.setFloat32(24, this.config.advection, true);
        view.setFloat32(28, this.config.diffusion, true);
        view.setFloat32(32, this.config.windStrength, true);
        view.setFloat32(36, this.config.precipitationRate, true);
        view.setFloat32(40, this.config.evaporation, true);
        view.setFloat32(44, this.config.noiseScale, true);
        view.setInt32(48, 1337, true);
        view.setFloat32(64, 0, true);

        device.queue.writeBuffer(this._uniformBuffer, 0, data);

        const commandEncoder = this.backend.getCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroups[this._currentIndex]);
        const workgroups = Math.ceil(size / 8);
        pass.dispatchWorkgroups(workgroups, workgroups, 6);
        pass.end();
    }

    setWeather(weatherName, immediate = false, duration = this.config.transitionDurationSeconds) {
        if (!Object.hasOwn(this.effects, weatherName)) return false;
        this._startEffectSnapshot = this._currentEffectSnapshot;
        this._startCloudLayers = this._currentCloudLayers;
        this._targetWeather = weatherName;
        this._rollVariant();
        this._transitionDuration = finiteNumber(duration, this.config.transitionDurationSeconds, 0.1, 3600);
        this._transitionProgress = immediate ? 1.0 : 0.0;
        this._lastCloudLayerUpdateTime = -Infinity;
        if (immediate) {
            this._currentEffectSnapshot = this._createEffectSnapshot(weatherName);
            this._startEffectSnapshot = this._currentEffectSnapshot;
        }
        return true;
    }

    setWeatherPreview(name) {
        if (name === 'auto') {
            this._previewWeather = null;
            return true;
        }
        if (!Object.hasOwn(this.effects, name)) return false;
        this._previewWeather = name;
        if (this._targetWeather !== name) this.setWeather(name, false, this.config.previewTransitionSeconds);
        return true;
    }

    /** Name of the present form of the weather, or '' for its usual form. */
    get variantName() {
        const { effect, form } = this._variant ?? {};
        return form && form !== effect ? form.name : '';
    }

    getWeatherPreview() {
        return { selected: this._previewWeather ?? 'auto', target: this._targetWeather, progress: this._transitionProgress };
    }

    getCurrentView() { return this._weatherViews[this._currentIndex]; }
    getPreviousView() { return this._weatherViews[1 - this._currentIndex]; }
    getBlend() { return this._blend; }
    getResolution() { return this.config.resolution; }
}
