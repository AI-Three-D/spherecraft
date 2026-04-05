// js/renderer/clouds/cloudRenderer.js
import { Vector3, Matrix4 } from '../../../shared/math/index.js';
import { CloudNoiseGenerator } from './cloudNoiseGenerator.js';
import { Geometry } from '../resources/geometry.js';

const LOD_CONFIG = [
    { distanceFraction: 0.05, steps: 96, shadowSamples: 4 },
    { distanceFraction: 0.15, steps: 72, shadowSamples: 3 },
    { distanceFraction: 0.4, steps: 56, shadowSamples: 3 },
    { distanceFraction: 0.8, steps: 40, shadowSamples: 2 },
    { distanceFraction: Infinity, steps: 32, shadowSamples: 2 }
];

export class CloudRenderer {
    constructor(backend, config = {}) {
        this.backend = backend;
        this.enabled = true;
        this.initialized = false;

        this.config = {
            cloudAnisotropy: config.cloudAnisotropy ?? 0.75,
            volumetricLayerMode: config.volumetricLayerMode ?? 'all',
            cumulusEnabled: config.cumulusEnabled ?? true,
            cirrusQuality: config.cirrusQuality ?? 'high'
        };

        this.noiseGenerator = null;
        this.fullscreenGeometry = null;
        this.planetConfig = null;

        this._tmpInvViewProj = new Matrix4();
        this._tmpInvProj = new Matrix4();
        this._tmpViewMatrix = new Matrix4();
    }

    async initialize() {
        this.noiseGenerator = new CloudNoiseGenerator(this.backend, {
            enableVolumetric: this.config.cumulusEnabled !== false
        });
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

    getLODParams(camera) {
        if (!this.planetConfig) {
            return { steps: 64, shadowSamples: 3 };
        }
        const atmosphereRadius = this.planetConfig.atmosphereRadius;
        const origin = this.planetConfig.origin;
        const distToCenter = camera.position.distanceTo(origin);
        const distToSurface = Math.max(0, distToCenter - this.planetConfig.radius);
        const distFraction = distToSurface / atmosphereRadius;

        for (const lod of LOD_CONFIG) {
            if (distFraction <= lod.distanceFraction) {
                return { steps: lod.steps, shadowSamples: lod.shadowSamples };
            }
        }
        return { steps: 32, shadowSamples: 1 };
    }

    getCommonUniformValues(camera, environmentState, uniformManager) {
        if (!this.planetConfig) {
            console.warn('CloudRenderer: planetConfig not set');
            return null;
        }

        const sunDir = (environmentState?.sunLightDirection ||
            uniformManager?.uniforms?.sunLightDirection?.value ||
            new Vector3(0.4, 1, 0.2)).clone().normalize();

        const viewProj = new Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse
        );
        this._tmpInvViewProj.copy(viewProj).invert();
        this._tmpInvProj.copy(camera.projectionMatrix).invert();
        this._tmpViewMatrix.copy(camera.matrixWorldInverse);

        const weather = environmentState?.currentWeather || 'clear';
        const intensity = environmentState?.weatherIntensity || 0;

        // Use interpolated cloud coverage if available, otherwise compute from weather
        let coverage;
        if (environmentState?.cloudCoverage !== undefined) {
            coverage = {
                cumulus: environmentState.cloudCoverage,
                cirrus: environmentState.cloudCoverage * 0.5
            };
        } else {
            coverage = this.noiseGenerator.getCoverageForWeather(weather, intensity);
        }

        const lodParams = this.getLODParams(camera);
        const time = (performance.now() / 1000) % 10000;
        const cumulusEnabled = this.config.cumulusEnabled !== false;

        if (!cumulusEnabled) {
            coverage = {
                cumulus: 0,
                cirrus: coverage.cirrus
            };
        }

        let cumulusInnerRadius = this.planetConfig.cumulusInnerRadius;
        let cumulusOuterRadius = this.planetConfig.cumulusOuterRadius;
        if (!cumulusEnabled) {
            cumulusInnerRadius = this.planetConfig.cirrusInnerRadius;
            cumulusOuterRadius = this.planetConfig.cirrusOuterRadius;
        }

        return {
            cameraPosition: camera.position.clone(),
            viewMatrix: this._tmpViewMatrix,
            invViewProjMatrix: this._tmpInvViewProj,
            invProjMatrix: this._tmpInvProj,
            sunDirection: sunDir,
            planetCenter: this.planetConfig.origin.clone(),
            planetRadius: this.planetConfig.radius,
            atmosphereRadius: this.planetConfig.atmosphereRadius,
            atmosphereHeight: this.planetConfig.atmosphereHeight,
            cumulusInnerRadius: cumulusInnerRadius,
            cumulusOuterRadius: cumulusOuterRadius,
            cirrusInnerRadius: this.planetConfig.cirrusInnerRadius,
            cirrusOuterRadius: this.planetConfig.cirrusOuterRadius,
            cumulusCoverage: coverage.cumulus,
            cirrusCoverage: coverage.cirrus,
            numSteps: lodParams.steps,
            shadowSamples: lodParams.shadowSamples,
            cloudAnisotropy: this.config.cloudAnisotropy,
            time: time,
        };
    }

    dispatchCompute(commandEncoder) {
        if (!this.initialized || !this.noiseGenerator) return;
        this.noiseGenerator.dispatch(commandEncoder);
    }

    _createFullscreenTriangle() {
        const geom = new Geometry();
        const positions = new Float32Array([
            -1, -1, 0,
             3, -1, 0,
            -1,  3, 0,
        ]);
        const normals = new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]);
        const uvs = new Float32Array([
            0, 0,
            2, 0,
            0, 2
        ]);
        geom.setAttribute('position', positions, 3);
        geom.setAttribute('normal', normals, 3);
        geom.setAttribute('uv', uvs, 2);
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
