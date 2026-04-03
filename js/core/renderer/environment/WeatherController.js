import { createWeatherComputeShader } from './shaders/weatherCompute.wgsl.js';
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class WeatherController {
    constructor(backend, config = {}) {
        this.backend = backend;
        if (typeof config.cloudLayerProvider !== 'function') {
            throw new Error('WeatherController requires config.cloudLayerProvider function');
        }
        this._cloudLayerProvider = config.cloudLayerProvider;
        this.config = {
            enabled: config.enabled ?? true,
            resolution: config.resolution ?? 128,
            updateHz: config.updateHz ?? 2,
            windStrength: config.windStrength ?? 20.0,
            advection: config.advection ?? 1.0,
            diffusion: config.diffusion ?? 0.15,
            precipitationRate: config.precipitationRate ?? 0.6,
            evaporation: config.evaporation ?? 0.2,
            noiseScale: config.noiseScale ?? 2.0
        };

        // --- Logic State ---
        this._targetWeather = 'clear';
        this._targetIntensity = 0.0;
        this._targetCloudCoverage = 0.0;
        this._startIntensity = 0.0;
        this._startCloudCoverage = 0.0;
        this._transitionProgress = 1.0;
        this._transitionSpeed = 0.000185; // ~90 seconds at 60fps

        // Wind Logic
        this._windAngle = 0.0;
        this._targetWindAngle = 0.0;
        this._targetWindSpeed = 5.0;

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

        // 1. Run GPU Weather Simulation
        this._updateGPUSimulation(deltaTime);

        // 2. Run Weather Logic (Transitions, Wind) and write to snapshot
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
        // --- A. Random Weather Events ---
        if (Math.random() < 0.001) { // Chance to change weather
            this._pickNewWeatherTarget(envState);
        }
        if (Math.random() < 0.005) { // Chance to change wind
            this._pickNewWindTarget();
        }

        // --- B. Interpolate Wind ---
        const dtSec = 1.0 / 60.0; // Assume fixed step for stability
        
        // Smoothly rotate wind angle
        let angDiff = this._targetWindAngle - this._windAngle;
        angDiff = ((angDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
        const maxAngStep = 0.1 * deltaTime;
        if (Math.abs(angDiff) <= maxAngStep) this._windAngle = this._targetWindAngle;
        else this._windAngle += Math.sign(angDiff) * maxAngStep;
        
        // Smoothly change wind speed
        const speedDiff = this._targetWindSpeed - envState.windSpeed;
        const maxSpeedStep = 2.0 * deltaTime;
        if (Math.abs(speedDiff) <= maxSpeedStep) envState.windSpeed = this._targetWindSpeed;
        else envState.windSpeed += Math.sign(speedDiff) * maxSpeedStep;
        envState.windSpeed = 1.0;
        envState.windDirection.set(1.0, 0.0);//Math.cos(this._windAngle), Math.sin(this._windAngle));

        // --- C. Interpolate Weather State ---
        if (this._transitionProgress < 1.0) {
            this._transitionProgress += this._transitionSpeed * (deltaTime * 60);
            if (this._transitionProgress > 1.0) this._transitionProgress = 1.0;

            const t = this._smoothstep(this._transitionProgress);

            // Proper start→target lerp (not exponential smoothing)
            envState.weatherIntensity = this._startIntensity + (this._targetIntensity - this._startIntensity) * t;
            envState.cloudCoverage = this._startCloudCoverage + (this._targetCloudCoverage - this._startCloudCoverage) * t;

            // Commit State Switch at 50%
            if (this._transitionProgress > 0.5 && envState.currentWeather !== this._targetWeather) {
                envState.currentWeather = this._targetWeather;
            }
        }

        // --- D. Update Derived Visuals (Water, Layers) ---
        this._updateWaterState(envState, deltaTime);
        
        // Only rebuild cloud layers occasionally to save CPU, unless forced
        if (envState.forceCirrusOnly || Math.floor(this._time * 60) % 60 === 0) {
            envState.cloudLayers = this._computeCloudLayers(envState);
        }
    }

    _updateWaterState(envState, dt) {
        // Break regularity by mixing wind speed with a slow sine wave
        const timeVar = Math.sin(this._time * 0.5);
        
        const windFactor = Math.max(0, (envState.windSpeed - 2.0) / 25.0);
        const stormFactor = envState.weatherIntensity;

        // Base Wave Height: 0.2m -> 2.5m (Storm)
        let targetHeight = 0.2 + (windFactor * 1.0) + (stormFactor * 1.5);
        targetHeight += timeVar * 0.1; // Breathing effect
        
        // Frequency: Lower in storms (big swells), Higher in light wind
        // 1.2 (calm) -> 0.4 (storm)
        let targetFreq = 1.2 - (windFactor * 0.5) - (stormFactor * 0.3);
        targetFreq += timeVar * 0.05;

        // Foam: Relies heavily on wind
        let targetFoam = 0.3 + (windFactor * 1.5) + (stormFactor * 0.5);

        // Apply to state
        envState.water.waveHeight = targetHeight;
        envState.water.waveFrequency = targetFreq;
        envState.water.foamIntensity = targetFoam;
        
        // Adjust color based on sky/weather (simple approximation)
        // Darker in storms
        if (envState.currentWeather === 'storm' || envState.currentWeather === 'rain') {
             // Darken colors slightly by mixing? 
             // For now, we rely on the Frontend setting the base "Deep" color
             // and just adjusting the 'foamDepthEnd' to make water look more agitated
             envState.water.foamDepthEnd = 2.0 + (targetHeight * 1.5);
        } else {
             envState.water.foamDepthEnd = 2.0;
        }
    }

    _pickNewWeatherTarget(envState) {
        const weathers = ['clear', 'partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm', 'foggy'];
        const next = weathers[Math.floor(Math.random() * weathers.length)];

        if (next !== this._targetWeather) {
            // Snapshot current values as transition starting point
            this._startIntensity = envState.weatherIntensity;
            this._startCloudCoverage = envState.cloudCoverage;
            this._targetWeather = next;
            this._targetIntensity = this._getIntensityForWeather(next);
            this._targetCloudCoverage = this._getCoverageForWeather(next, this._targetIntensity);
            this._transitionProgress = 0.0;
        }
    }

    _pickNewWindTarget() {
        this._targetWindAngle = Math.random() * Math.PI * 2;
        this._targetWindSpeed = 2.0 + Math.random() * 20.0; // 2m/s to 22m/s
    }

    _computeCloudLayers(envState) {
        const atmosphereHeight = envState.planetConfig?.atmosphereHeight || 100000;
        
        if (envState.forceCirrusOnly) {
            // Simplified return for menu/special modes
            return [{
                name: 'high', altMin: atmosphereHeight * 0.35, altMax: atmosphereHeight * 0.8,
                coverage: 0.45, densityMultiplier: 0.16, noiseScale: 2.2, 
                verticalStretch: 2.6, worleyInfluence: 0.25, edgeSoftness: 0.95, extinction: 0.012, albedo: 0.95
            }];
        }
        return this._cloudLayerProvider(envState.currentWeather, envState.weatherIntensity, atmosphereHeight);
    }

    _getIntensityForWeather(weather) {
        switch (weather) {
            case 'clear': return 0.0;
            case 'partly_cloudy': return 0.3;
            case 'cloudy': return 0.5;
            case 'overcast': return 0.7;
            case 'rain': return 0.7;
            case 'storm': return 0.9;
            case 'foggy': return 0.4;
            default: return 0.0;
        }
    }

    _getCoverageForWeather(weather, intensity) {
        switch (weather) {
            case 'clear': return 0.1;
            case 'partly_cloudy': return 0.4;
            case 'cloudy': return 0.6;
            case 'overcast': return 0.9;
            case 'storm': return 0.95;
            default: return 0.3;
        }
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
        view.setFloat32(64, 0, true); // padding

        device.queue.writeBuffer(this._uniformBuffer, 0, data);

        const commandEncoder = this.backend.getCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroups[this._currentIndex]);
        const workgroups = Math.ceil(size / 8);
        pass.dispatchWorkgroups(workgroups, workgroups, 6);
        pass.end();
    }

    getCurrentView() { return this._weatherViews[this._currentIndex]; }
    getPreviousView() { return this._weatherViews[1 - this._currentIndex]; }
    getBlend() { return this._blend; }
    getResolution() { return this.config.resolution; }
}