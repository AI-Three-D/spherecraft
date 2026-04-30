// core/renderer/clouds/cloudRenderer.js
// Base class for the cirrus cloud renderer.

import { CloudNoiseGenerator } from './cloudNoiseGenerator.js';
import { Geometry } from '../resources/geometry.js';

export class CloudRenderer {
    constructor(backend, config = {}) {
        this.backend     = backend;
        this.enabled     = true;
        this.initialized = false;

        this.config = {
            cloudAnisotropy: config.cloudAnisotropy ?? 0.75,
            cirrusQuality:   config.cirrusQuality   ?? 'high',
            lowClouds:       config.lowClouds       !== false,
            midClouds:       config.midClouds       !== false,
            highClouds:      config.highClouds      !== false,
        };

        this.noiseGenerator      = null;
        this.fullscreenGeometry  = null;
        this.planetConfig        = null;
    }

    async initialize() {
        this.noiseGenerator = new CloudNoiseGenerator(this.backend);
        await this.noiseGenerator.initialize();
        this.fullscreenGeometry = this._createFullscreenTriangle();
        this.initialized = true;
    }

    setPlanetConfig(planetConfig) {
        this.planetConfig = planetConfig;
    }

    update(camera, environmentState, uniformManager) {
        if (!this.enabled || !this.initialized || !this.planetConfig) return;
        this.noiseGenerator.update(camera, environmentState, uniformManager, this.planetConfig);
    }

    dispatchCompute(commandEncoder) {
        if (!this.initialized || !this.noiseGenerator) return;
        this.noiseGenerator.dispatch(commandEncoder);
    }

    _createFullscreenTriangle() {
        const geom = new Geometry();
        geom.setAttribute('position', new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), 3);
        geom.setAttribute('normal',   new Float32Array([0,0,1, 0,0,1, 0,0,1]),     3);
        geom.setAttribute('uv',       new Float32Array([0,0, 2,0, 0,2]),            2);
        return geom;
    }

    dispose() {
        if (this.noiseGenerator) {
            this.noiseGenerator.dispose();
            this.noiseGenerator = null;
        }
        this.initialized = false;
    }
}
