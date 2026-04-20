import { Matrix4 } from '../../../shared/math/index.js';
import { AtmoBankBuffers } from './AtmoBankBuffers.js';
import { AtmoBankSimPass } from './AtmoBankSimPass.js';
import { AtmoBankRenderPass } from './AtmoBankRenderPass.js';
import { AtmoBankPlacement } from './AtmoBankPlacement.js';
import { AtmoBankScatterPass } from './AtmoBankScatterPass.js';
import { ATMO_EMITTER_CAPACITY } from './AtmoBankTypes.js';
import {
    buildAtmoBankAuthoringRuntime,
    DEFAULT_ATMO_PLACEMENT_CONFIG,
} from './AtmoBankAuthoringRuntime.js';

export class AtmoBankSystem {
    constructor({
        device,
        backend,
        colorFormat,
        depthFormat = 'depth24plus',
        tileStreamer = null,
        atmoBankAuthoring = null,
        tileCategories = null,
        biomeDefinitions = null,
    }) {
        this.device = device;
        this.backend = backend;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;
        this.authoringRuntime = buildAtmoBankAuthoringRuntime(atmoBankAuthoring ?? {});
        this._tileCategories = Array.isArray(tileCategories) ? tileCategories : [];
        this._biomeDefinitions = Array.isArray(biomeDefinitions) ? biomeDefinitions : [];

        this.buffers = null;
        this.simPass = null;
        this.renderPass = null;
        this.placement = null;
        this.scatterPass = null;

        this._tileStreamer = tileStreamer;
        this._useGPUScatter = false;
        this._elapsedTime = 0;
        this._initialized = false;
        this._viewProj = new Matrix4();
        this._diagFrame = 0;
        this._lastUpdateInfo = {
            updated: false,
            reason: 'not-initialized',
        };
    }

    _scatterAuthoringOptions() {
        return {
            placement: this.authoringRuntime.placement,
            scatterRules: this.authoringRuntime.scatterRules,
            tileCategories: this._tileCategories,
            biomeDefinitions: this._biomeDefinitions,
        };
    }

    setAuthoringRuntime(atmoBankAuthoring = null, options = {}) {
        this.authoringRuntime = buildAtmoBankAuthoringRuntime(atmoBankAuthoring ?? {});
        if (Array.isArray(options.tileCategories)) {
            this._tileCategories = options.tileCategories;
        }
        if (Array.isArray(options.biomeDefinitions)) {
            this._biomeDefinitions = options.biomeDefinitions;
        }
        if (this.buffers) {
            this.buffers.uploadTypeDefs(this.authoringRuntime.typeDefs);
        }
        this.placement = new AtmoBankPlacement(this.authoringRuntime.placement);
        this.scatterPass?.setAuthoringConfig?.(this._scatterAuthoringOptions());
    }

    async initialize() {
        if (this._initialized) return;

        this.buffers = new AtmoBankBuffers(this.device);
        this.buffers.uploadTypeDefs(this.authoringRuntime.typeDefs);

        this.simPass = new AtmoBankSimPass(this.device, this.buffers);
        this.simPass.initialize();

        this.renderPass = new AtmoBankRenderPass(this.device, this.buffers, {
            colorFormat: this.colorFormat,
            depthFormat: this.depthFormat,
        });
        this.renderPass.initialize();

        this.placement = new AtmoBankPlacement(this.authoringRuntime.placement);

        if (this._tileStreamer) {
            this.scatterPass = new AtmoBankScatterPass(
                this.device,
                this._tileStreamer,
                this._scatterAuthoringOptions()
            );
            this.scatterPass.initialize();
            this._useGPUScatter = true;
        }

        this._initialized = true;
    }

    setTileStreamer(tileStreamer) {
        if (this._tileStreamer || !tileStreamer) return;
        this._tileStreamer = tileStreamer;
        this.scatterPass = new AtmoBankScatterPass(this.device, tileStreamer, this._scatterAuthoringOptions());
        this.scatterPass.initialize();
        this._useGPUScatter = true;
    }

    setNoiseTextures(baseView, detailView) {
        this.renderPass?.setNoiseTextures(baseView, detailView);
    }

    setDepthTexture(depthView) {
        this.renderPass?.setDepthTexture(depthView);
    }

    getDiagnostics() {
        return {
            initialized: this._initialized,
            mode: this._useGPUScatter ? 'gpu-scatter' : 'cpu-placement',
            authoring: this.authoringRuntime.summary,
            hasTileStreamer: !!this._tileStreamer,
            maxParticles: this.buffers?.maxParticles ?? 0,
            frameIndex: this.buffers?.frameIndex ?? 0,
            lastUpdate: this._lastUpdateInfo,
            scatter: this.scatterPass?.getDiagnostics?.() ?? null,
            render: this.renderPass?.getDiagnostics?.() ?? null,
        };
    }

    _diagnosticsEnabled() {
        if (typeof window === 'undefined') return false;
        if (window.atmoBankDiagEnabled === true) return true;
        try {
            return window.localStorage?.getItem?.('atmoBankDiag') === '1';
        } catch (_) {
            return false;
        }
    }

    _maybeLogDiagnostics() {
        if (!this._diagnosticsEnabled()) return;
        this._diagFrame++;
        if ((this._diagFrame % 120) !== 0) return;
        console.info('[AtmoBankDiag]', this.getDiagnostics());
    }

    update(commandEncoder, camera, deltaTime, environmentState, planetConfig, lightingController = null, uniformManager = null) {
        if (!this._initialized || !camera) {
            this._lastUpdateInfo = {
                updated: false,
                reason: !this._initialized ? 'not-initialized' : 'missing-camera',
            };
            return;
        }

        const dt = Math.max(0, Math.min(deltaTime || 0, 0.1));
        this._elapsedTime += dt;

        let emitters = [];
        let totalBudget = 0;
        let emitterCount = 0;
        let scatterShouldDispatch = false;
        let scatterDispatched = false;

        if (this._useGPUScatter && this.scatterPass) {
            scatterShouldDispatch = this.scatterPass.shouldDispatch(camera);
            if (scatterShouldDispatch) {
                scatterDispatched = this.scatterPass.dispatch(commandEncoder, camera, planetConfig, environmentState);
            }

            this.simPass.setEmitterSource(
                this.scatterPass.getEmitterBuffer(),
                this.scatterPass.getCounterBuffer()
            );
            emitterCount = ATMO_EMITTER_CAPACITY;
        } else {
            this.placement.update(camera, environmentState, planetConfig);
            emitters = this.placement.getEmitters();
            totalBudget = emitters.reduce((s, e) => s + (e.spawnBudget || 0), 0);
            emitterCount = emitters.length;
            this.simPass.setEmitterSource(null, null);
            this.buffers.uploadEmitterData(emitters);
        }

        this.buffers.resetLiveList();

        const te = camera.matrixWorldInverse.elements;
        const cameraRight = [te[0], te[4], te[8]];
        const cameraUp    = [te[1], te[5], te[9]];
        this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

        const origin = planetConfig?.origin;
        const po = origin ? [origin.x, origin.y, origin.z] : [0, 0, 0];
        const windDir = environmentState?.windDirection;
        const lighting = lightingController?.getAll?.() || uniformManager?._currentLighting || null;
        const uniforms = uniformManager?.uniforms || {};
        const sunDir = lighting?.sunDirection || environmentState?.sunLightDirection ||
            uniforms.sunLightDirection?.value;
        const sunColor = lighting?.sunColor || uniforms.sunLightColor?.value;
        const ambientColor = uniforms.ambientLightColor?.value;

        this.buffers.writeGlobals({
            viewProjMatrix: this._viewProj.elements,
            cameraRight,
            cameraUp,
            cameraPos: [camera.position.x, camera.position.y, camera.position.z],
            dt,
            time: this._elapsedTime,
            planetOrigin: po,
            totalSpawnBudget: totalBudget,
            emitterCount,
            windDirection: [windDir?.x ?? 0, windDir?.y ?? 0],
            windSpeed: environmentState?.windSpeed ?? 0,
            maxRenderDist: this.authoringRuntime?.placement?.maxRenderDist ?? DEFAULT_ATMO_PLACEMENT_CONFIG.maxRenderDist,
            near: camera.near ?? 0.5,
            far: camera.far ?? 100000,
            sunDirection: [sunDir?.x ?? 0.5, sunDir?.y ?? 1.0, sunDir?.z ?? 0.3],
            sunVisibility: lighting?.sunVisibility ?? Math.min(1, Math.max(0, uniforms.sunLightIntensity?.value ?? 1)),
            sunColor: [sunColor?.r ?? 1.0, sunColor?.g ?? 1.0, sunColor?.b ?? 1.0],
            ambientColor: [ambientColor?.r ?? 0.35, ambientColor?.g ?? 0.38, ambientColor?.b ?? 0.45],
            ambientIntensity: uniforms.ambientLightIntensity?.value ?? 0.12,
            moonIntensity: lighting?.moonIntensity ?? uniforms.moonLightIntensity?.value ?? 0.0,
        });

        this.buffers.clearSpawnScratch(commandEncoder);
        this.simPass.dispatch(commandEncoder);
        this.buffers.advancePingPong();
        this._lastUpdateInfo = {
            updated: true,
            mode: this._useGPUScatter ? 'gpu-scatter' : 'cpu-placement',
            emitterCount,
            totalBudget,
            dt,
            elapsedTime: this._elapsedTime,
            scatterShouldDispatch,
            scatterDispatched,
            hasNoiseBase: !!this.renderPass?._noiseBaseView,
            hasNoiseDetail: !!this.renderPass?._noiseDetailView,
            hasDepth: !!this.renderPass?._depthView,
        };
        this._maybeLogDiagnostics();
    }

    render(renderPassEncoder) {
        if (!this._initialized) return;
        const { read } = this.buffers.getPingPong();
        this.renderPass.render(renderPassEncoder, read);
    }

    dispose() {
        this.simPass?.dispose();
        this.renderPass?.dispose();
        this.buffers?.dispose();
        this.scatterPass?.dispose();
        this._initialized = false;
    }
}
