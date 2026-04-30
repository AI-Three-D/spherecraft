import { Matrix4 } from '../../../shared/math/index.js';
import { AtmoBankBuffers } from './AtmoBankBuffers.js';
import { AtmoBankSimPass } from './AtmoBankSimPass.js';
import { AtmoBankRenderPass } from './AtmoBankRenderPass.js';
import { AtmoBankPlacement } from './AtmoBankPlacement.js';
import { AtmoBankScatterPass } from './AtmoBankScatterPass.js';
import {
    ATMO_BANK_TYPES,
    ATMO_BANK_ALL_TYPE_MASK,
    ATMO_BANK_CLOUD_TYPE_MASK,
    ATMO_BANK_FOG_TYPE_MASK,
    ATMO_EMITTER_CAPACITY,
} from './AtmoBankTypes.js';
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
        featureFlags = {},
        renderConfig = {},
    }) {
        this.device = device;
        this.backend = backend;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;
        this.renderConfig = renderConfig && typeof renderConfig === 'object' ? renderConfig : {};
        this.authoringRuntime = buildAtmoBankAuthoringRuntime(atmoBankAuthoring ?? {});
        this._tileCategories = Array.isArray(tileCategories) ? tileCategories : [];
        this._biomeDefinitions = Array.isArray(biomeDefinitions) ? biomeDefinitions : [];
        this._enabledTypeMask = this._resolveEnabledTypeMask(featureFlags);

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
            enabledTypeMask: this._enabledTypeMask,
        };
    }

    _resolveEnabledTypeMask(featureFlags = {}) {
        let mask = 0;
        if (featureFlags?.fogParticles !== false) {
            mask |= ATMO_BANK_FOG_TYPE_MASK;
        }
        if (featureFlags?.cloudParticles !== false) {
            mask |= ATMO_BANK_CLOUD_TYPE_MASK;
        }
        return mask & ATMO_BANK_ALL_TYPE_MASK;
    }

    _featureDiagnostics() {
        return {
            cloudParticles: (this._enabledTypeMask & ATMO_BANK_CLOUD_TYPE_MASK) !== 0,
            fogParticles: (this._enabledTypeMask & ATMO_BANK_FOG_TYPE_MASK) !== 0,
            enabledTypeMask: this._enabledTypeMask,
        };
    }

    setFeatureFlags(featureFlags = {}) {
        this._enabledTypeMask = this._resolveEnabledTypeMask(featureFlags);
        this.placement?.setEnabledTypeMask?.(this._enabledTypeMask);
        this.scatterPass?.setEnabledTypeMask?.(this._enabledTypeMask);
        this.scatterPass?.setAuthoringConfig?.(this._scatterAuthoringOptions());
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
        this.placement = new AtmoBankPlacement(this.authoringRuntime.placement, {
            enabledTypeMask: this._enabledTypeMask,
        });
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
            renderConfig: this.renderConfig,
        });
        this.renderPass.initialize();

        this.placement = new AtmoBankPlacement(this.authoringRuntime.placement, {
            enabledTypeMask: this._enabledTypeMask,
        });

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
            features: this._featureDiagnostics(),
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

    estimateLocalDistanceFogBoost(camera, environmentState, planetConfig) {
        if (!camera || !planetConfig || !this.placement) return 0;
        if ((this._enabledTypeMask & ATMO_BANK_FOG_TYPE_MASK) === 0) return 0;

        this.placement.update(camera, environmentState, planetConfig);
        const emitters = this.placement.getEmitters();
        const typeDefs = this.authoringRuntime?.typeDefs ?? {};
        const localFog = this.authoringRuntime?.placement?.localDistanceFog ?? {};
        if (localFog.enabled === false) return 0;
        const largeEmitterMinSize = localFog.largeEmitterMinSize ?? 160;
        const densityBoost = localFog.densityBoost ?? 0.00016;
        const radiusScale = localFog.radiusScale ?? 0.92;
        const heightScale = localFog.heightScale ?? 0.34;
        const cam = camera.position;
        let strongest = 0;

        for (const emitter of emitters) {
            const typeDef = typeDefs[emitter.typeId];
            const maxSize = typeDef?.size?.max ?? 0;
            if (maxSize < largeEmitterMinSize || emitter.typeId === ATMO_BANK_TYPES.LOW_CLOUD || emitter.typeId === ATMO_BANK_TYPES.PEAK_CLOUD) continue;

            const ex = emitter.position[0] ?? 0;
            const ey = emitter.position[1] ?? 0;
            const ez = emitter.position[2] ?? 0;
            const ux = emitter.localUp[0] ?? 0;
            const uy = emitter.localUp[1] ?? 1;
            const uz = emitter.localUp[2] ?? 0;

            const dx = cam.x - ex;
            const dy = cam.y - ey;
            const dz = cam.z - ez;
            const vertical = dx * ux + dy * uy + dz * uz;
            const horizontalSq = Math.max(0, dx * dx + dy * dy + dz * dz - vertical * vertical);
            const horizontal = Math.sqrt(horizontalSq);

            const radius = maxSize * radiusScale;
            const height = Math.max(45, maxSize * heightScale);
            if (horizontal > radius || vertical < -18 || vertical > height) continue;

            const radial = 1 - this._smoothstep(radius * 0.45, radius, horizontal);
            const verticalWeight = 1 - this._smoothstep(height * 0.55, height, Math.max(0, vertical));
            strongest = Math.max(strongest, radial * verticalWeight);
        }

        return strongest * densityBoost;
    }

    _smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    update(commandEncoder, camera, deltaTime, environmentState, planetConfig, lightingController = null, uniformManager = null) {
        if (!this._initialized || !camera) {
            this._lastUpdateInfo = {
                updated: false,
                reason: !this._initialized ? 'not-initialized' : 'missing-camera',
            };
            return;
        }
        if ((this._enabledTypeMask & ATMO_BANK_ALL_TYPE_MASK) === 0) {
            this._lastUpdateInfo = {
                updated: false,
                reason: 'all-bank-types-disabled',
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

    render(renderPassEncoder, options = {}) {
        if (!this._initialized) return;
        const { read } = this.buffers.getPingPong();
        this.renderPass.render(renderPassEncoder, read, options);
    }

    renderOffscreen(commandEncoder, options = {}) {
        if (!this._initialized) return false;
        const { read } = this.buffers.getPingPong();
        return this.renderPass.renderOffscreen(commandEncoder, read, options);
    }

    dispose() {
        this.simPass?.dispose();
        this.renderPass?.dispose();
        this.buffers?.dispose();
        this.scatterPass?.dispose();
        this._initialized = false;
    }
}
