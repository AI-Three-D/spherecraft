import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { requireNumber, requireObject } from '../util/requireUtil.js';
export class UniformManager {
    constructor() {

        this.uniforms = {
            starDirection: { value: new THREE.Vector3(0.5, 1, 0.3).normalize() },
            starColor: { value: new THREE.Color(1, 1, 1) },
            starIntensity: { value: 1.0 },
            starAngularDiameter: { value: 0.00935 },
            aerialPerspectiveEnabled: { value: 1.0 },
            planetCenter: { value: new THREE.Vector3(0, 0, 0) },
            cameraPosition: { value: new THREE.Vector3() },
            cameraNear: { value: 0.1 },
            cameraFar: { value: 1000.0 },
            clusterDimensions: { value: new THREE.Vector3(16, 8, 24) },
            clusterDataTexture: { value: null },
            lightDataTexture: { value: null },
            lightIndicesTexture: { value: null },
            numLights: { value: 0 },
            maxLightsPerCluster: { value: 32 },
            sunLightColor: { value: new THREE.Color(0xffffff) },
            sunLightIntensity: { value: 1.0 },
            sunLightDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
            moonLightColor: { value: new THREE.Color(0x4444ff) },
            moonLightIntensity: { value: 0.2 },
            moonLightDirection: { value: new THREE.Vector3(-0.5, 1.0, -0.3).normalize() },
            ambientLightColor: { value: new THREE.Color(0x404040) },
            ambientLightIntensity: { value: 50.9 },
            skyAmbientColor: { value: new THREE.Color(0x87baff) },
            groundAmbientColor: { value: new THREE.Color(0x554630) },
            thunderLightIntensity: { value: 0.0 },
            thunderLightColor: { value: new THREE.Color(0xffffff) },
            thunderLightPosition: { value: new THREE.Vector3() },
            playerLightColor: { value: new THREE.Color(0x6699ff) },
            playerLightIntensity: { value: 0.0 },
            playerLightPosition: { value: new THREE.Vector3() },
            playerLightDistance: { value: 15.0 },
            fogColor: { value: new THREE.Color(0xcccccc) },
            fogDensity: { value: 0.00005 },
            fogScaleHeight: { value: 1200 },
            weatherIntensity: { value: 0.0 },
            currentWeather: { value: 0 },
            shadowMapCascade0: { value: null },
            shadowMapCascade1: { value: null },
            shadowMapCascade2: { value: null },
            shadowMatrixCascade0: { value: new THREE.Matrix4() },
            shadowMatrixCascade1: { value: new THREE.Matrix4() },
            shadowMatrixCascade2: { value: new THREE.Matrix4() },
            cascadeSplits: { value: new THREE.Vector3(30, 90, 200) },
            numCascades: { value: 3 },
            shadowBias: { value: 0.001 },
            shadowNormalBias: { value: 0.1 },
            shadowMapSize: { value: 2048.0 },
            receiveShadow: { value: 1.0 },

            atmospherePlanetRadius: { value: 50000 },
            atmosphereRadius: { value: 55000 },
            atmosphereScaleHeightRayleigh: { value: 800 },
            atmosphereScaleHeightMie: { value: 120 },
            atmosphereRayleighScattering: { value: new THREE.Vector3(5.5e-5, 13.0e-5, 22.4e-5) },
            atmosphereMieScattering: { value: 21e-5 },
            atmosphereOzoneAbsorption: { value: new THREE.Vector3(0.65e-6, 1.881e-6, 0.085e-6) },
            atmosphereMieAnisotropy: { value: 0.8 },
            atmosphereGroundAlbedo: { value: 0.3 },
            atmosphereSunIntensity: { value: 20.0 },
            viewerAltitude: { value: 0.0 },

            transmittanceLUT: { value: null },
            multiScatterLUT: { value: null },
            skyViewLUT: { value: null }
        };

        this.materials = new Set();
        this.currentEnvironmentState = null;
        this.currentPlanetConfig = null;
        this._dirtyUniforms = new Set();
        this._needsUpdate = false;

        this.fogParams = {
            baseDensity: 0.00005,
            density: 0.00005,
            scaleHeight: 1200,
            color: { r: 0.7, g: 0.8, b: 1.0 }
        };
        this._weatherFogMultiplier = 1.0;
        this.ambientTuning = {
            intensityMultiplier: 1.0,
            minIntensity: 0.75,
            maxIntensity: 1.5,
            sunContributionScale: 0.2,
            moonContributionScale: 0.2,
            moonNormalizationIntensity: 0.15
        };

    }


    registerMaterial(material) {
        this.materials.add(material);

        if (material.uniforms) {
            for (const [key, uniform] of Object.entries(this.uniforms)) {
                if (!material.uniforms[key]) {
                    material.uniforms[key] = uniform;
                }
            }
        }
    }

    updateFromLightingController(lightingController) {
        const lighting = lightingController.getAll();
        
        // Primary directional light (sun)
        this.uniforms.sunLightDirection.value.copy(lighting.sunDirection);
        this.uniforms.sunLightColor.value.copy(lighting.sunColor);
        this.uniforms.sunLightIntensity.value = lighting.sunIntensity;

        // Star properties (for sky/atmosphere)
        if (this.uniforms.starDirection) {
            this.uniforms.starDirection.value.copy(lighting.sunDirection);
        }
        if (this.uniforms.starColor) {
            this.uniforms.starColor.value.copy(lighting.sunColor);
        }
        if (this.uniforms.starIntensity) {
            this.uniforms.starIntensity.value = lighting.sunIntensity;
        }
        if (this.uniforms.starAngularDiameter) {
            this.uniforms.starAngularDiameter.value = lighting.sunAngularDiameter ?? this.uniforms.starAngularDiameter.value;
        }
        
        // Ambient light derived from atmosphere (not time-of-day flags)
        this._updateAmbientFromAtmosphere(lighting);
        
        // Moon light
        if (this.uniforms.moonLightDirection) {
            this.uniforms.moonLightDirection.value.copy(lighting.moonDirection);
            this.uniforms.moonLightIntensity.value = lighting.moonIntensity;
        }
    }

    unregisterMaterial(material) {
        this.materials.delete(material);
    }

    _markUniformDirty(uniformName) {
        this._dirtyUniforms.add(uniformName);
        this._needsUpdate = true;
    }

    updateCameraParameters(camera) {
        if (camera.position) {
            if (camera.position.isVector3) {
                this.uniforms.cameraPosition.value.copy(camera.position);
            } else {
                this.uniforms.cameraPosition.value.set(
                    camera.position.x || 0,
                    camera.position.y || 0,
                    camera.position.z || 0
                );
            }
        }

        if (camera.near !== undefined) {
            this.uniforms.cameraNear.value = camera.near;
        }
        if (camera.far !== undefined) {
            this.uniforms.cameraFar.value = camera.far;
        }

        if (this.currentPlanetConfig) {
            const altitude = this._calculateAltitude(this.uniforms.cameraPosition.value);
            this.uniforms.viewerAltitude.value = altitude;
            this.updateFogParams(altitude, this.currentPlanetConfig.atmosphereSettings);
        }
    }

    _calculateAltitude(cameraPos) {
        if (!this.currentPlanetConfig) return 0;

        const origin = this.currentPlanetConfig.origin;
        const dx = cameraPos.x - origin.x;
        const dy = cameraPos.y - origin.y;
        const dz = cameraPos.z - origin.z;
        const distanceFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);

        return Math.max(0, distanceFromCenter - this.currentPlanetConfig.radius);
    }

    updateFogParams(altitude, atmosphereSettings) {
        const atmo = requireObject(atmosphereSettings, 'atmosphereSettings');
        const scaleHeight = requireNumber(atmo.scaleHeightMie, 'atmosphereSettings.scaleHeightMie');
        this.fogParams.scaleHeight = scaleHeight;
        this.fogParams.density = this.fogParams.baseDensity * this._weatherFogMultiplier * Math.exp(-altitude / scaleHeight);

        this.uniforms.fogDensity.value = this.fogParams.density;
        this.uniforms.fogScaleHeight.value = this.fogParams.scaleHeight;
        const baseColor = new THREE.Color(
            this.fogParams.color.r,
            this.fogParams.color.g,
            this.fogParams.color.b
        );
        const atmoHeight = Math.max(
            1.0,
            requireNumber(atmo.atmosphereRadius, 'atmosphereSettings.atmosphereRadius') -
                requireNumber(atmo.planetRadius, 'atmosphereSettings.planetRadius')
        );
        const fade = Math.min(1, altitude / atmoHeight);
        baseColor.lerp(new THREE.Color(0, 0, 0), fade);
        this.uniforms.fogColor.value.copy(baseColor);
    }

    updateFromPlanetConfig(planetConfig) {
        if (!planetConfig) return;

        this.currentPlanetConfig = planetConfig;

        const atmo = requireObject(planetConfig.atmosphereSettings, 'planetConfig.atmosphereSettings');
        this.uniforms.planetCenter.value.copy(planetConfig.origin);
        this.uniforms.aerialPerspectiveEnabled.value = planetConfig.hasAtmosphere ? 1.0 : 0.0;
        
        this.uniforms.atmospherePlanetRadius.value = atmo.planetRadius;
        this.uniforms.atmosphereRadius.value = atmo.atmosphereRadius;
        this.uniforms.atmosphereScaleHeightRayleigh.value = atmo.scaleHeightRayleigh;
        this.uniforms.atmosphereScaleHeightMie.value = atmo.scaleHeightMie;
        this.uniforms.atmosphereRayleighScattering.value.copy(atmo.rayleighScattering);
        this.uniforms.atmosphereMieScattering.value = atmo.mieScattering;
        this.uniforms.atmosphereOzoneAbsorption.value.copy(atmo.ozoneAbsorption);
        this.uniforms.atmosphereMieAnisotropy.value = atmo.mieAnisotropy;
        this.uniforms.atmosphereGroundAlbedo.value = atmo.groundAlbedo;
        this.uniforms.atmosphereSunIntensity.value = atmo.sunIntensity;

        const mieBase = Math.max(2e-5, atmo.mieScattering * 2.0);
        this.fogParams.baseDensity = Math.min(0.002, mieBase);
        this.fogParams.scaleHeight = atmo.scaleHeightMie;
        const rayleigh = atmo.rayleighScattering.clone();
        const maxR = Math.max(rayleigh.x, rayleigh.y, rayleigh.z, 1e-6);
        const rayleighColor = new THREE.Color(rayleigh.x / maxR, rayleigh.y / maxR, rayleigh.z / maxR);
        rayleighColor.lerp(new THREE.Color(1, 1, 1), 0.2);
        this.fogParams.color = { r: rayleighColor.r, g: rayleighColor.g, b: rayleighColor.b };

        this._markUniformDirty('atmosphere');

    }

    setAtmosphereLUTs(transmittance, multiScatter, skyView) {
        if (transmittance) {
            this.uniforms.transmittanceLUT.value = transmittance;
            this._markUniformDirty('transmittanceLUT');
        }
        if (multiScatter) {
            this.uniforms.multiScatterLUT.value = multiScatter;
            this._markUniformDirty('multiScatterLUT');
        }
        if (skyView) {
            this.uniforms.skyViewLUT.value = skyView;
            this._markUniformDirty('skyViewLUT');
        }
    }

    getAtmosphereUniformBuffer() {
        const data = new Float32Array(16);

        data[0] = this.uniforms.atmospherePlanetRadius.value;
        data[1] = this.uniforms.atmosphereRadius.value;
        data[2] = this.uniforms.atmosphereScaleHeightRayleigh.value;
        data[3] = this.uniforms.atmosphereScaleHeightMie.value;

        const rayleigh = this.uniforms.atmosphereRayleighScattering.value;
        data[4] = rayleigh.x;
        data[5] = rayleigh.y;
        data[6] = rayleigh.z;
        data[7] = this.uniforms.atmosphereMieScattering.value;

        const ozone = this.uniforms.atmosphereOzoneAbsorption.value;
        data[8] = ozone.x;
        data[9] = ozone.y;
        data[10] = ozone.z;
        data[11] = this.uniforms.atmosphereMieAnisotropy.value;

        data[12] = this.uniforms.atmosphereGroundAlbedo.value;
        data[13] = this.uniforms.atmosphereSunIntensity.value;
        data[14] = this.uniforms.viewerAltitude.value;
        data[15] = 0.0;

        return data;
    }

    updateFromEnvironmentState(environmentState) {
        if (!environmentState) return;
       
        const u = this.uniforms;

        if (environmentState.thunderLightIntensity !== undefined) {
            u.thunderLightIntensity.value = environmentState.thunderLightIntensity;
        }
        if (environmentState.thunderLightColor) {
            u.thunderLightColor.value.copy(environmentState.thunderLightColor);
        }
        if (environmentState.thunderLightPosition) {
            u.thunderLightPosition.value.copy(environmentState.thunderLightPosition);
        }

        if (environmentState.playerLight) {
            u.playerLightColor.value.copy(environmentState.playerLight.color);
            u.playerLightIntensity.value = environmentState.playerLight.intensity;
            u.playerLightPosition.value.copy(environmentState.playerLight.position);
            u.playerLightDistance.value = environmentState.playerLight.distance;
        }

        if (environmentState.weatherIntensity !== undefined) {
            u.weatherIntensity.value = environmentState.weatherIntensity;
        }
        if (environmentState.currentWeather !== undefined) {
            u.currentWeather.value = this._encodeWeather(environmentState.currentWeather);
        }

        this._weatherFogMultiplier = this._getWeatherFogMultiplier(
            environmentState.currentWeather,
            environmentState.weatherIntensity
        );
    }

    updateFromShadowRenderer(shadowData) {
        if (!shadowData) return;

        if (shadowData.cascades) {
            this.uniforms.numCascades.value = shadowData.numCascades;

            for (let i = 0; i < Math.min(3, shadowData.cascades.length); i++) {
                const cascade = shadowData.cascades[i];
                this.uniforms[`shadowMapCascade${i}`].value = cascade.renderTarget.texture;
                this.uniforms[`shadowMatrixCascade${i}`].value.copy(cascade.shadowMatrix);
            }

            if (shadowData.cascades.length >= 3) {
                this.uniforms.cascadeSplits.value.set(
                    shadowData.cascades[0].split.far,
                    shadowData.cascades[1].split.far,
                    shadowData.cascades[2].split.far
                );
            }
        }
    }

    updateFromClusteredLights(clusterGrid, clusteredLightManager, textures) {
        this.uniforms.clusterDimensions.value.copy(clusterGrid.clusterDimensions);
        this.uniforms.clusterDataTexture.value = textures.clusterData;
        this.uniforms.lightDataTexture.value = textures.lightData;
        this.uniforms.lightIndicesTexture.value = textures.lightIndices;
        this.uniforms.numLights.value = clusteredLightManager.lights.length;
    }

    updateFromLightManager(lightManager) {
    }

    getLightingUniforms() {
        return this.uniforms;
    }

    applyAmbientConfig(config) {
        if (!config || typeof config !== 'object') return;
        const next = this.ambientTuning;
        if (Number.isFinite(config.intensityMultiplier)) {
            next.intensityMultiplier = Math.max(0, config.intensityMultiplier);
        }
        if (Number.isFinite(config.minIntensity)) {
            next.minIntensity = Math.max(0, config.minIntensity);
        }
        if (Number.isFinite(config.maxIntensity)) {
            next.maxIntensity = Math.max(next.minIntensity, config.maxIntensity);
        }
        if (Number.isFinite(config.sunContributionScale)) {
            next.sunContributionScale = Math.max(0, config.sunContributionScale);
        }
        if (Number.isFinite(config.moonContributionScale)) {
            next.moonContributionScale = Math.max(0, config.moonContributionScale);
        }
        if (Number.isFinite(config.moonNormalizationIntensity)) {
            next.moonNormalizationIntensity = Math.max(1e-4, config.moonNormalizationIntensity);
        }
    }

    setShadowsEnabled(enabled) {
        this.uniforms.receiveShadow.value = enabled ? 1.0 : 0.0;
        this._markUniformDirty('receiveShadow');
        this._markMaterialsForUpdate();
    }

    _markMaterialsForUpdate() {
        if (!this._needsUpdate) return;

        for (const material of this.materials) {
            if (material.uniforms) {
                material.uniformsNeedUpdate = true;
            }
        }

        this._dirtyUniforms.clear();
        this._needsUpdate = false;
    }

    _encodeWeather(weatherString) {
        const weatherMap = {
            'clear': 0,
            'rain': 1,
            'storm': 2,
            'foggy': 3,
            'snow': 4
        };
        return weatherMap[weatherString] || 0;
    }

    _getWeatherFogMultiplier(weather, intensity = 0) {
        switch (weather) {
            case 'foggy':
                return 1.0 + Math.min(1, intensity) * 1.5;
            case 'rain':
            case 'storm':
                return 1.0 + Math.min(1, intensity) * 0.7;
            case 'snow':
                return 1.0 + Math.min(1, intensity) * 0.4;
            default:
                return 1.0;
        }
    }

    _updateAmbientFromAtmosphere(lighting) {
        const rayleigh = this.uniforms.atmosphereRayleighScattering?.value;
        const baseColor = rayleigh
            ? new THREE.Color(
                rayleigh.x,
                rayleigh.y,
                rayleigh.z
            )
            : new THREE.Color(0.4, 0.4, 0.5);
        const maxC = Math.max(baseColor.r, baseColor.g, baseColor.b, 1e-6);
        baseColor.multiplyScalar(1 / maxC);
    
        const sunTint = lighting?.sunColor || new THREE.Color(1, 1, 1);
        baseColor.lerp(sunTint, 0.15);

        const tuning = this.ambientTuning;
        const sunFactor = Math.min(1, (lighting?.sunIntensity ?? 1.0) / 3.0);
        const moonFactor = Math.min(
            1,
            (lighting?.moonIntensity ?? 0.0) / Math.max(1e-4, tuning.moonNormalizationIntensity)
        );
        const rawIntensity =
            tuning.minIntensity +
            tuning.sunContributionScale * sunFactor +
            tuning.moonContributionScale * moonFactor;
        const intensity = Math.min(
            tuning.maxIntensity,
            Math.max(0, rawIntensity * tuning.intensityMultiplier)
        );
    
        this.uniforms.ambientLightColor.value.copy(baseColor);
        this.uniforms.ambientLightIntensity.value = intensity;
        this.uniforms.skyAmbientColor.value.copy(baseColor).multiplyScalar(1.2);
        this.uniforms.groundAmbientColor.value.copy(baseColor).multiplyScalar(0.8);
    }
}
