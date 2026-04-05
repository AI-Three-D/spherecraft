// js/renderer/water/globalOceanRenderer.js

import { WaterMaterialBuilder } from './waterMaterialBuilder.js';
import { Logger } from '../../../shared/Logger.js';

export class GlobalOceanRenderer {
    /**
     * @param {object} options
     * @param {object}  options.backend             WebGPUBackend
     * @param {object}  options.quadtreeGPU         QuadtreeGPU instance
     * @param {object}  options.planetConfig
     * @param {object}  options.waterConfig
     * @param {object}  options.uniformManager
     * @param {Map}     options.terrainGeometries   LOD -> Geometry (from GPUQuadtreeTerrain)
     * @param {object}  options.heightTexture       Terrain height array texture wrapper
     * @param {number}  options.maxGeomLOD
     */
    constructor(options = {}) {
        this.backend          = options.backend;
        this.quadtreeGPU      = options.quadtreeGPU;
        this.planetConfig     = options.planetConfig;
        this.waterConfig      = options.waterConfig || {};
        this.uniformManager   = options.uniformManager;
        this.terrainGeometries = options.terrainGeometries;
        this.heightTexture    = options.heightTexture || null;
        this.maxGeomLOD       = options.maxGeomLOD ?? 6;

        this._materials       = new Map();
        this._initialized     = false;
        this._time            = 0;
        this._maxDeltaTime    = 0.1;
        this.enabled          = true;

        this._diagFrameCount    = 0;
        this._diagLogInterval   = 60;
        this._diagLastTime      = null;
        this._diagTimeSamples   = [];
        this._diagDeltaSamples  = [];
        this._diagWindSamples   = [];
        this._diagCallsThisFrame = 0;
        this._diagFrameId       = -1;
    }

    /**
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this._initialized) return;
        if (!this.backend) {
            Logger.warn('[GlobalOceanRenderer] Missing backend; ocean disabled');
            this.enabled = false;
            return;
        }
        if (!this.heightTexture) {
            Logger.warn('[GlobalOceanRenderer] Missing height texture; ocean disabled');
            this.enabled = false;
            return;
        }
        if (!this.terrainGeometries || typeof this.terrainGeometries.get !== 'function') {
            Logger.warn('[GlobalOceanRenderer] Missing terrain geometries; ocean disabled');
            this.enabled = false;
            return;
        }
        if (!this.quadtreeGPU || typeof this.quadtreeGPU.getIndirectArgsOffsetBytes !== 'function') {
            Logger.warn('[GlobalOceanRenderer] Missing quadtree GPU; ocean disabled');
            this.enabled = false;
            return;
        }

        const useArrayTex = this.heightTexture?._isArray === true;

        for (let lod = 0; lod <= this.maxGeomLOD; lod++) {
            const geo = this.terrainGeometries.get(lod);
            if (!geo) continue;

            const material = WaterMaterialBuilder.create({
                backend:          this.backend,
                heightTexture:    this.heightTexture,
                planetConfig:     this.planetConfig,
                waterConfig:      this.waterConfig,
                uniformManager:   this.uniformManager,
                lod,
                useArrayTextures: useArrayTex,
            });

            this._materials.set(lod, material);
        }

        this._initialized = true;
        Logger.info(`[GlobalOceanRenderer] Initialized with ${this._materials.size} LOD materials`);
    }

    /**
     * @returns {boolean}
     */
    isReady() {
        return this._initialized && this.enabled;
    }

    /**
     * @param {object} tex
     */
    setHeightTexture(tex) {
        this.heightTexture = tex;
        for (const mat of this._materials.values()) {
            mat.uniforms.heightTexture.value = tex;
        }
    }

    /**
     * @param {object} config
     */
    setWaterConfig(config) {
        if (!config || typeof config !== 'object') return;
        if (!this.waterConfig || typeof this.waterConfig !== 'object') this.waterConfig = {};
        Object.assign(this.waterConfig, config);
        for (const mat of this._materials.values()) {
            if (mat?.uniforms?._waterConfig) {
                mat.uniforms._waterConfig.value = this.waterConfig;
            }
        }
    }



    /**
     * @param {number} safeDelta
     * @param {number} prevTime
     */
    _recordDiagnostics(safeDelta, prevTime) {
        const now = performance.now();
        return;
        const currentFrameId = this._diagFrameCount;
        if (this._diagFrameId === currentFrameId) {
            this._diagCallsThisFrame++;
            Logger.warn(
                `[OceanDiag] MULTIPLE CALLS in frame ${currentFrameId}: ` +
                `call #${this._diagCallsThisFrame}, ` +
                `delta=${safeDelta.toFixed(6)}, ` +
                `time ${prevTime.toFixed(4)} -> ${this._time.toFixed(4)}`
            );
        } else {
            this._diagFrameId = currentFrameId;
            this._diagCallsThisFrame = 1;
        }

        this._diagTimeSamples.push(this._time);
        this._diagDeltaSamples.push(safeDelta);
        this._diagWindSamples.push(this.waterConfig?.windSpeed ?? -1);

        if (this._diagLastTime !== null) {
            const wallDelta = (now - this._diagLastTime) * 0.001;
         /*   if (wallDelta > 0.001 && safeDelta > 0.001) {
                const ratio = safeDelta / wallDelta;
                if (ratio > 2.0 || ratio < 0.3) {
                    Logger.warn(
                        `[OceanDiag] Delta/wall mismatch: ` +
                        `delta=${safeDelta.toFixed(6)}, ` +
                        `wall=${wallDelta.toFixed(6)}, ` +
                        `ratio=${ratio.toFixed(2)}, ` +
                        `time=${this._time.toFixed(4)}`
                    );
                }
            }*/
        }

        this._diagFrameCount++;
        this._diagLastTime = now;

        if (this._diagFrameCount % this._diagLogInterval === 0) {
            this._flushDiagnostics();
        }
    }

    _flushDiagnostics() {
        const n = this._diagDeltaSamples.length;
        if (n === 0) return;

        const deltas = this._diagDeltaSamples;
        const times = this._diagTimeSamples;
        const winds = this._diagWindSamples;

        let minD = Infinity, maxD = -Infinity, sumD = 0;
        for (let i = 0; i < n; i++) {
            const d = deltas[i];
            if (d < minD) minD = d;
            if (d > maxD) maxD = d;
            sumD += d;
        }

        let timeJumps = 0;
        for (let i = 1; i < times.length; i++) {
            const diff = times[i] - times[i - 1];
            if (diff > this._maxDeltaTime * 1.5 || diff < 0) {
                timeJumps++;
            }
        }

        let minW = Infinity, maxW = -Infinity;
        for (let i = 0; i < winds.length; i++) {
            if (winds[i] < minW) minW = winds[i];
            if (winds[i] > maxW) maxW = winds[i];
        }

        const vertUniform = this._materials.values().next().value
            ?.uniforms?.waterVertexUniforms?.value;
        let shaderTime = -1;
        let shaderWind = -1;
        let shaderWaveH = -1;
        let shaderWaveF = -1;
        if (vertUniform instanceof Float32Array && vertUniform.length >= 48) {
            shaderTime  = vertUniform[44];
            shaderWind  = vertUniform[45];
            shaderWaveH = vertUniform[42];
            shaderWaveF = vertUniform[43];
        }

        Logger.info(
            `[OceanDiag] frames=${n}, ` +
            `delta min=${minD.toFixed(6)} max=${maxD.toFixed(6)} avg=${(sumD / n).toFixed(6)}, ` +
            `timeJumps=${timeJumps}, ` +
            `_time=${this._time.toFixed(4)}, ` +
            `shaderTime=${shaderTime.toFixed(4)}, ` +
            `wind=[${minW.toFixed(2)},${maxW.toFixed(2)}], ` +
            `shaderWind=${shaderWind.toFixed(2)}, ` +
            `shaderWaveH=${shaderWaveH.toFixed(4)}, ` +
            `shaderWaveF=${shaderWaveF.toFixed(4)}`
        );

        this._diagDeltaSamples = [];
        this._diagTimeSamples = [];
        this._diagWindSamples = [];
    }

    render(camera, viewMatrix, projectionMatrix, instanceBuffer, indirectBuffer, deltaTime = 0) {
        if (!this.isReady()) return;
        if (!instanceBuffer || !indirectBuffer) return;

        const safeDelta = Number.isFinite(deltaTime)
            ? Math.max(0, Math.min(deltaTime, this._maxDeltaTime))
            : 0;

        const prevTime = this._time;
        this._time += safeDelta;

        this._recordDiagnostics(safeDelta, prevTime);

        for (let lod = 0; lod <= this.maxGeomLOD; lod++) {
            const geo = this.terrainGeometries.get(lod);
            const mat = this._materials.get(lod);
            if (!geo || !mat) continue;

            if (!mat.storageBuffers) mat.storageBuffers = {};
            mat.storageBuffers.chunkInstances = instanceBuffer;

            // Pass camera near/far for logarithmic depth calculation
            this._applyUniforms(mat, camera, viewMatrix, projectionMatrix, lod);

            const offset = this.quadtreeGPU.getIndirectArgsOffsetBytes(lod);
            this.backend.drawIndexedIndirect(geo, mat, indirectBuffer, offset);
        }
    }
    _applyUniforms(mat, camera, viewMatrix, projectionMatrix, lod) {
        WaterMaterialBuilder.updateUniformBuffers(mat, {
            viewMatrix,
            projectionMatrix,
            cameraPosition: camera?.position || null,
            uniformManager: this.uniformManager,
            planetConfig:   this.planetConfig,
            waterConfig:    this.waterConfig,
            time:           this._time
        });
    }

    dispose() {
        this._flushDiagnostics();
        for (const mat of this._materials.values()) {
            mat.dispose();
        }
        this._materials.clear();
        this._initialized = false;
    }
}