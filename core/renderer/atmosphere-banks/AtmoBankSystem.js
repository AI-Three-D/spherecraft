import { Matrix4 } from '../../../shared/math/index.js';
import { AtmoBankBuffers } from './AtmoBankBuffers.js';
import { AtmoBankSimPass } from './AtmoBankSimPass.js';
import { AtmoBankRenderPass } from './AtmoBankRenderPass.js';
import { AtmoBankPlacement } from './AtmoBankPlacement.js';
import { AtmoBankScatterPass } from './AtmoBankScatterPass.js';
import { ATMO_MAX_PARTICLES } from './AtmoBankTypes.js';
import { ATMO_BANK_CONFIG, ATMO_PLACEMENT_CONFIG } from '../../../templates/configs/atmoBankConfig.js';

export class AtmoBankSystem {
    constructor({ device, backend, colorFormat, depthFormat = 'depth24plus', tileStreamer = null }) {
        this.device = device;
        this.backend = backend;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;

        this.buffers = null;
        this.simPass = null;
        this.renderPass = null;
        this.placement = null;
        this.scatterPass = null;

        this._tileStreamer = tileStreamer;
        this._useGPUScatter = false;
        this._gpuEmitters = [];
        this._elapsedTime = 0;
        this._initialized = false;
        this._viewProj = new Matrix4();
    }

    async initialize() {
        if (this._initialized) return;

        this.buffers = new AtmoBankBuffers(this.device);
        this.buffers.uploadTypeDefs(ATMO_BANK_CONFIG);

        this.simPass = new AtmoBankSimPass(this.device, this.buffers);
        this.simPass.initialize();

        this.renderPass = new AtmoBankRenderPass(this.device, this.buffers, {
            colorFormat: this.colorFormat,
            depthFormat: this.depthFormat,
        });
        this.renderPass.initialize();

        this.placement = new AtmoBankPlacement();

        if (this._tileStreamer) {
            this.scatterPass = new AtmoBankScatterPass(this.device, this._tileStreamer);
            this.scatterPass.initialize();
            this._useGPUScatter = true;
        }

        this._initialized = true;
    }

    setTileStreamer(tileStreamer) {
        if (this._tileStreamer || !tileStreamer) return;
        this._tileStreamer = tileStreamer;
        this.scatterPass = new AtmoBankScatterPass(this.device, tileStreamer);
        this.scatterPass.initialize();
        this._useGPUScatter = true;
    }

    setNoiseTextures(baseView, detailView) {
        this.renderPass?.setNoiseTextures(baseView, detailView);
    }

    setDepthTexture(depthView) {
        this.renderPass?.setDepthTexture(depthView);
    }

    update(commandEncoder, camera, deltaTime, environmentState, planetConfig) {
        if (!this._initialized || !camera) return;

        const dt = Math.max(0, Math.min(deltaTime || 0, 0.1));
        this._elapsedTime += dt;

        let emitters;

        if (this._useGPUScatter && this.scatterPass) {
            const resolved = this.scatterPass.resolveReadback();
            if (resolved) {
                this._gpuEmitters = resolved;
            }

            if (this.scatterPass.shouldDispatch(camera)) {
                this.scatterPass.dispatch(commandEncoder, camera, planetConfig, environmentState);
            }

            emitters = this._gpuEmitters;
        } else {
            this.placement.update(camera, environmentState, planetConfig);
            emitters = this.placement.getEmitters();
        }

        const totalBudget = emitters.reduce((s, e) => s + (e.spawnBudget || 0), 0);

        this.buffers.resetLiveList();
        this.buffers.uploadEmitterData(emitters);

        const te = camera.matrixWorldInverse.elements;
        const cameraRight = [te[0], te[4], te[8]];
        const cameraUp    = [te[1], te[5], te[9]];
        this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

        const origin = planetConfig?.origin;
        const po = origin ? [origin.x, origin.y, origin.z] : [0, 0, 0];
        const windDir = environmentState?.windDirection;

        this.buffers.writeGlobals({
            viewProjMatrix: this._viewProj.elements,
            cameraRight,
            cameraUp,
            cameraPos: [camera.position.x, camera.position.y, camera.position.z],
            dt,
            time: this._elapsedTime,
            planetOrigin: po,
            totalSpawnBudget: totalBudget,
            emitterCount: emitters.length,
            windDirection: [windDir?.x ?? 0, windDir?.y ?? 0],
            windSpeed: environmentState?.windSpeed ?? 0,
            maxRenderDist: ATMO_PLACEMENT_CONFIG.maxRenderDist,
            near: camera.near ?? 0.5,
            far: camera.far ?? 100000,
        });

        this.buffers.clearSpawnScratch(commandEncoder);
        this.simPass.dispatch(commandEncoder);
        this.buffers.advancePingPong();
    }

    beginPostSubmitReadback() {
        if (!this._useGPUScatter || !this.scatterPass) return;
        this.scatterPass.beginReadbackAfterSubmit();
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
