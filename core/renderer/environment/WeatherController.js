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

function normalizeWeatherEffects(rawEffects = {}) {
    const source = rawEffects && typeof rawEffects === 'object' ? rawEffects : {};
    const effects = {};
    for (const [name, raw] of Object.entries(source)) {
        if (!raw || typeof raw !== 'object') continue;
        const precipitation = finiteNumber(raw.precipitationIntensity, 0, 0, 1);
        effects[name] = {
            name,
            weight: finiteNumber(raw.weight, 1, 0, 1000),
            intensity: finiteNumber(raw.intensity, 0, 0, 1),
            cloudCoverage: finiteNumber(raw.cloudCoverage, 0, 0, 1),
            precipitationIntensity: precipitation,
            fogDensity: finiteNumber(raw.fogDensity, 0, 0, 1),
            fogMultiplier: finiteNumber(raw.fogMultiplier, 1, 0, 10),
            water: normalizeWaterEffect(raw.water || {}),
            rainParticles: normalizeRainParticles(raw.rainParticles || {}, precipitation),
        };
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
            weatherChangeChancePerSecond: finiteNumber(merged.weatherChangeChancePerSecond, 0.06, 0, 10),
            windChangeChancePerSecond: finiteNumber(merged.windChangeChancePerSecond, 0.30, 0, 10),
            windSpeedRange: Array.isArray(merged.windSpeedRange)
                ? [finiteNumber(merged.windSpeedRange[0], 2, 0, 1000), finiteNumber(merged.windSpeedRange[1], 22, 0, 1000)]
                : [2, 22],
            cloudLayerRefreshHz: finiteNumber(merged.cloudLayerRefreshHz, 1.0, 0.05, 60),
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
        this._startEffectSnapshot = this._createEffectSnapshot(this._targetWeather);
        this._currentEffectSnapshot = this._createEffectSnapshot(this._targetWeather);
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
        if (!this._initialized) return;

        this._updateGPUSimulation(deltaTime);

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
        if (this._transitionProgress >= 1.0 &&
            Math.random() < this.config.weatherChangeChancePerSecond * deltaTime) {
            this._pickNewWeatherTarget(envState);
        }
        if (Math.random() < this.config.windChangeChancePerSecond * deltaTime) {
            this._pickNewWindTarget();
        }

        this._updateWind(deltaTime, envState);

        if (this._transitionProgress < 1.0) {
            this._transitionProgress = Math.min(
                1.0,
                this._transitionProgress + deltaTime / this.config.transitionDurationSeconds
            );
        }

        const targetEffect = this._createEffectSnapshot(this._targetWeather);
        const blendT = this._smoothstep(this._transitionProgress);
        const blendedEffect = this._blendEffectSnapshots(
            this._startEffectSnapshot || targetEffect,
            targetEffect,
            blendT
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
            !Array.isArray(envState.cloudLayers) ||
            envState.cloudLayers.length === 0
        ) {
            envState.cloudLayers = this._computeCloudLayers(envState);
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

    _pickNewWeatherTarget(envState) {
        const next = this._pickWeightedWeather();
        if (!next || next === this._targetWeather) return;

        this._startEffectSnapshot = this._currentEffectSnapshot || this._snapshotEnvironment(envState);
        this._targetWeather = next;
        this._transitionProgress = 0.0;
    }

    _pickWeightedWeather() {
        const candidates = this._weatherKeys
            .map((name) => this.effects[name])
            .filter((effect) => effect && effect.weight > 0);
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

    _computeCloudLayers(envState) {
        const atmosphereHeight = envState.planetConfig?.atmosphereHeight || 100000;

        if (envState.forceCirrusOnly) {
            return [{
                name: 'high', altMin: atmosphereHeight * 0.35, altMax: atmosphereHeight * 0.8,
                coverage: 0.45, densityMultiplier: 0.16, noiseScale: 2.2,
                verticalStretch: 2.6, worleyInfluence: 0.25, edgeSoftness: 0.95,
                extinction: 0.012, albedo: 0.95, precipitation: 0.0, darkness: 0.0
            }];
        }
        return this._cloudLayerProvider(envState.currentWeather, envState.weatherIntensity, atmosphereHeight);
    }

    _createEffectSnapshot(weather) {
        const effect = this.effects[weather] || this.effects.clear || Object.values(this.effects)[0] || {
            name: 'clear',
            intensity: 0,
            cloudCoverage: 0,
            precipitationIntensity: 0,
            fogDensity: 0,
            fogMultiplier: 1,
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
            water: { ...effect.water },
            rainParticles: { ...effect.rainParticles },
        };
    }

    _snapshotEnvironment(envState) {
        return {
            name: envState.currentWeather || this._targetWeather,
            intensity: envState.weatherIntensity ?? 0,
            cloudCoverage: envState.cloudCoverage ?? 0,
            precipitationIntensity: envState.precipitationIntensity ?? 0,
            fogDensity: envState.fogDensity ?? 0,
            fogMultiplier: envState.weatherFogMultiplier ?? 1,
            water: { ...(this._currentEffectSnapshot?.water || normalizeWaterEffect()) },
            rainParticles: { ...(envState.rainParticles || normalizeRainParticles({}, 0)) },
        };
    }

    _blendEffectSnapshots(a, b, t) {
        const rainParticles = (b.rainParticles?.enabled || t >= 0.98)
            ? b.rainParticles
            : (a.rainParticles?.enabled ? a.rainParticles : b.rainParticles);
        return {
            name: b.name,
            intensity: blendNumber(a.intensity, b.intensity, t),
            cloudCoverage: blendNumber(a.cloudCoverage, b.cloudCoverage, t),
            precipitationIntensity: blendNumber(a.precipitationIntensity, b.precipitationIntensity, t),
            fogDensity: blendNumber(a.fogDensity, b.fogDensity, t),
            fogMultiplier: blendNumber(a.fogMultiplier, b.fogMultiplier, t),
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

    setWeather(weatherName, immediate = false) {
        if (!this.effects[weatherName]) return false;
        this._startEffectSnapshot = this._currentEffectSnapshot || this._createEffectSnapshot(this._targetWeather);
        this._targetWeather = weatherName;
        this._transitionProgress = immediate ? 1.0 : 0.0;
        if (immediate) {
            this._currentEffectSnapshot = this._createEffectSnapshot(weatherName);
            this._startEffectSnapshot = this._currentEffectSnapshot;
        }
        return true;
    }

    getCurrentView() { return this._weatherViews[this._currentIndex]; }
    getPreviousView() { return this._weatherViews[1 - this._currentIndex]; }
    getBlend() { return this._blend; }
    getResolution() { return this.config.resolution; }
}
