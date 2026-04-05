import { Texture, TextureFormat, TextureFilter } from '../resources/texture.js';

export class AtmosphericScatteringLUT {
    constructor(backend, uniformManager) {
        this.backend = backend;
        this.uniformManager = uniformManager;

        this.transmittanceLUT = null;
        this.multiScatterLUT = null;

        this.transmittanceSize = { width: 256, height: 64 };
        this.multiScatterSize = { width: 32, height: 32 };

        this._isDirty = true;
        this._isInitialized = false;

        this.isComputed = false;
        this.currentSettings = null;
        this.lastComputeTime = 0;
    }
    
    async initialize() {
        this._createTextures();
        await this._initializeResources();
        this._isInitialized = true;
    }
    
    _createTextures() {
        this.transmittanceLUT = new Texture({
            width: this.transmittanceSize.width,
            height: this.transmittanceSize.height,
            format: TextureFormat.RGBA16F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
            generateMipmaps: false
        });
        
        this.multiScatterLUT = new Texture({
            width: this.multiScatterSize.width,
            height: this.multiScatterSize.height,
            format: TextureFormat.RGBA16F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
            generateMipmaps: false
        });
    }
    
    async _initializeResources() {
        throw new Error('AtmosphericScatteringLUT._initializeResources() must be implemented');
    }
    
    _getAtmosphereUniformData() {
        const uniforms = this.uniformManager.uniforms;
        
        const data = new Float32Array(16);
        data[0] = uniforms.atmospherePlanetRadius.value;
        data[1] = uniforms.atmosphereRadius.value;
        data[2] = uniforms.atmosphereScaleHeightRayleigh.value;
        data[3] = uniforms.atmosphereScaleHeightMie.value;
        
        const rayleigh = uniforms.atmosphereRayleighScattering.value;
        data[4] = rayleigh.x;
        data[5] = rayleigh.y;
        data[6] = rayleigh.z;
        data[7] = uniforms.atmosphereMieScattering.value;
        
        const ozone = uniforms.atmosphereOzoneAbsorption.value;
        data[8] = ozone.x;
        data[9] = ozone.y;
        data[10] = ozone.z;
        data[11] = 0.0;
        
        data[12] = this.transmittanceSize.width;
        data[13] = this.transmittanceSize.height;
        data[14] = 0.0;
        data[15] = 0.0;
        
        return data;
    }
    
    markDirty() {
        this._isDirty = true;
    }

    invalidate() {
        this._isDirty = true;
    }

    needsRecompute(atmosphereSettings) {
        if (this._isDirty) return true;
        if (!this.isComputed) return true;
        if (!this.currentSettings) return true;
        if (!this.settingsEqual(this.currentSettings, atmosphereSettings)) return true;
        return false;
    }

    settingsEqual(a, b) {
        if (!a || !b) return false;
        const epsilon = 1e-10;

        if (Math.abs(a.planetRadius - b.planetRadius) > epsilon) return false;
        if (Math.abs(a.atmosphereRadius - b.atmosphereRadius) > epsilon) return false;
        if (Math.abs(a.scaleHeightRayleigh - b.scaleHeightRayleigh) > epsilon) return false;
        if (Math.abs(a.scaleHeightMie - b.scaleHeightMie) > epsilon) return false;
        if (Math.abs(a.mieScattering - b.mieScattering) > epsilon) return false;
        if (Math.abs(a.mieAnisotropy - b.mieAnisotropy) > epsilon) return false;

        if (Math.abs(a.rayleighScattering.x - b.rayleighScattering.x) > epsilon) return false;
        if (Math.abs(a.rayleighScattering.y - b.rayleighScattering.y) > epsilon) return false;
        if (Math.abs(a.rayleighScattering.z - b.rayleighScattering.z) > epsilon) return false;

        return true;
    }

    cloneSettings(settings) {
        if (!settings) return null;
        return {
            planetRadius: settings.planetRadius,
            atmosphereRadius: settings.atmosphereRadius,
            atmosphereHeight: settings.atmosphereHeight,
            rayleighScattering: {
                x: settings.rayleighScattering.x,
                y: settings.rayleighScattering.y,
                z: settings.rayleighScattering.z
            },
            mieScattering: settings.mieScattering,
            mieAnisotropy: settings.mieAnisotropy,
            scaleHeightRayleigh: settings.scaleHeightRayleigh,
            scaleHeightMie: settings.scaleHeightMie,
            groundAlbedo: settings.groundAlbedo,
            sunIntensity: settings.sunIntensity
        };
    }

    update() {
        if (!this._isInitialized || !this._isDirty) return;

        const startTime = performance.now();
        this._generateTransmittanceLUT();
        const elapsed = performance.now() - startTime;


        this._isDirty = false;

        this.uniformManager.setAtmosphereLUTs(
            this.transmittanceLUT,
            this.multiScatterLUT,
            null
        );
    }

    async compute(atmosphereSettings) {
        if (!this._isInitialized) {
            
            return;
        }

        if (!this.needsRecompute(atmosphereSettings)) {
            return;
        }

        

        const startTime = performance.now();
        this._generateTransmittanceLUT();
        const elapsed = performance.now() - startTime;

        this.isComputed = true;
        this._isDirty = false;
        this.currentSettings = this.cloneSettings(atmosphereSettings);
        this.lastComputeTime = elapsed;


        this.uniformManager.setAtmosphereLUTs(
            this.transmittanceLUT,
            this.multiScatterLUT,
            null
        );
    }
    
    _generateTransmittanceLUT() {
        throw new Error('AtmosphericScatteringLUT._generateTransmittanceLUT() must be implemented');
    }
    
    getTransmittanceLUT() {
        return this.transmittanceLUT;
    }
    
    getMultiScatterLUT() {
        return this.multiScatterLUT;
    }
    
    dispose() {
        throw new Error('AtmosphericScatteringLUT.dispose() must be implemented');
    }
    
    static async create(backend, uniformManager) {
        const { WebGPUAtmosphericScatteringLUT } = await import('./webGPUAtmosphericScatteringLUT.js');
        const instance = new WebGPUAtmosphericScatteringLUT(backend, uniformManager);
        await instance.initialize();
        return instance;
    }
}