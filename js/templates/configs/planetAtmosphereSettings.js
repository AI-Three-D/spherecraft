// js/planet/planetAtmosphereSettings.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

/**
 * PlanetAtmosphereSettings
 *
 * Configures atmospheric scattering for planets of any size.
 *
 * The key insight for scaling atmospheres across different planet sizes:
 * - The visual "blueness" of sky depends on optical depth along the view path
 * - Optical depth = scattering_coefficient × path_length
 * - For horizon viewing, path_length ≈ sqrt(2 × planetRadius × atmosphereThickness)
 * - To get Earth-like appearance, we scale scattering to compensate for path length
 *
 * Primary configuration:
 * - atmosphereThickness: The height of the atmosphere in meters
 * - densityFalloffRayleigh: Fraction of atmosphere where density drops to 1/e (default 0.1)
 * - densityFalloffMie: Fraction of atmosphere for Mie (default 0.015)
 * - visualDensity: 1.0 = Earth-like blue sky, higher = thicker/hazier, lower = thinner
 */
export class PlanetAtmosphereSettings {
    constructor(options = {}) {
        this.planetRadius = options.planetRadius || 6371000;
        this.atmosphereHeight = options.atmosphereHeight || 100000;
        this.atmosphereRadius = this.planetRadius + this.atmosphereHeight;

        this.rayleighScattering = new THREE.Vector3(
            options.rayleighScatteringR ?? 5.5e-6,
            options.rayleighScatteringG ?? 13.0e-6,
            options.rayleighScatteringB ?? 22.4e-6
        );

        this.mieScattering = options.mieScattering ?? 21e-6;
        this.mieAnisotropy = options.mieAnisotropy ?? 0.758;

        this.ozoneAbsorption = new THREE.Vector3(
            options.ozoneAbsorptionR ?? 0.650e-6,
            options.ozoneAbsorptionG ?? 1.881e-6,
            options.ozoneAbsorptionB ?? 0.085e-6
        );

        this.scaleHeightRayleigh = options.scaleHeightRayleigh ?? 8000;
        this.scaleHeightMie = options.scaleHeightMie ?? 1200;

        this.groundAlbedo = options.groundAlbedo ?? 0.3;
        this.sunIntensity = options.sunIntensity ?? 20.0;

        this._validateParameters();
    }

    _validateParameters() {
        // Atmosphere scaling for small planets:
        // - Minimum 10km atmosphere for planets up to 100km radius
        // - Linear interpolation from 100km radius (10km atmo) to Earth-size (normal ratio)
        const MIN_ATMOSPHERE_HEIGHT = 10000;  // 10 km minimum
        const SMALL_PLANET_THRESHOLD = 100000;  // 100 km radius
        const EARTH_RADIUS = 6371000;  // Reference Earth radius

        if (this.atmosphereHeight <= 0) {
            this.atmosphereHeight = this.planetRadius * 0.1;
        }

        // For small planets, enforce minimum atmosphere and interpolate
        if (this.planetRadius <= SMALL_PLANET_THRESHOLD) {
            // Small planetoids: minimum 10km atmosphere
            this.atmosphereHeight = Math.max(this.atmosphereHeight, MIN_ATMOSPHERE_HEIGHT);
        } else if (this.planetRadius < EARTH_RADIUS) {
            // Medium planets: interpolate between minimum and normal scaling
            const t = (this.planetRadius - SMALL_PLANET_THRESHOLD) / (EARTH_RADIUS - SMALL_PLANET_THRESHOLD);
            const normalAtmoHeight = this.planetRadius * 0.1;  // Normal 10% ratio
            const minAtmoHeight = MIN_ATMOSPHERE_HEIGHT;
            const interpolatedMin = minAtmoHeight + (normalAtmoHeight - minAtmoHeight) * t;
            this.atmosphereHeight = Math.max(this.atmosphereHeight, interpolatedMin);
        }

        this.atmosphereRadius = this.planetRadius + this.atmosphereHeight;

        if (this.scaleHeightRayleigh <= 0 || this.scaleHeightMie <= 0) {
            this.scaleHeightRayleigh = Math.max(100, this.scaleHeightRayleigh);
            this.scaleHeightMie = Math.max(100, this.scaleHeightMie);
        }
    }

    getRayleighDensity(altitude) {
        return Math.exp(-Math.max(0, altitude) / this.scaleHeightRayleigh);
    }

    getMieDensity(altitude) {
        return Math.exp(-Math.max(0, altitude) / this.scaleHeightMie);
    }

    getOzoneDensity(altitude) {
        const ozoneLayerCenter = 25000;
        const ozoneLayerWidth = 15000;
        const x = (altitude - ozoneLayerCenter) / ozoneLayerWidth;
        return Math.max(0, 1.0 - x * x);
    }

    toUniforms() {
        return {
            planetRadius: { value: this.planetRadius },
            atmosphereRadius: { value: this.atmosphereRadius },
            rayleighScattering: { value: this.rayleighScattering.clone() },
            mieScattering: { value: this.mieScattering },
            mieAnisotropy: { value: this.mieAnisotropy },
            ozoneAbsorption: { value: this.ozoneAbsorption.clone() },
            scaleHeightRayleigh: { value: this.scaleHeightRayleigh },
            scaleHeightMie: { value: this.scaleHeightMie },
            groundAlbedo: { value: this.groundAlbedo },
            sunIntensity: { value: this.sunIntensity }
        };
    }

    toUniformBuffer() {
        return new Float32Array([
            this.planetRadius,
            this.atmosphereRadius,
            this.scaleHeightRayleigh,
            this.scaleHeightMie,

            this.rayleighScattering.x,
            this.rayleighScattering.y,
            this.rayleighScattering.z,
            this.mieScattering,

            this.ozoneAbsorption.x,
            this.ozoneAbsorption.y,
            this.ozoneAbsorption.z,
            this.mieAnisotropy,

            this.groundAlbedo,
            this.sunIntensity,
            0.0,
            0.0
        ]);
    }

    /**
     * Create atmosphere settings for a planet of any size.
     *
     * Scaling approach: Scattering coefficients are scaled to preserve Earth-like
     * optical depth (τ = β × H). Since τ must match Earth's for similar appearance,
     * and scale height H varies with atmosphere thickness, we scale β inversely:
     *   β_planet = β_earth × (H_earth / H_planet)
     *
     * @param {number} planetRadius - Planet radius in meters
     * @param {object} options - Configuration options
     * @param {number} options.atmosphereThickness - Atmosphere height in meters (required or use atmosphereThicknessRatio)
     * @param {number} options.atmosphereThicknessRatio - Atmosphere height as fraction of planet radius (default 0.2)
     * @param {number} options.densityFalloffRayleigh - Scale height as fraction of atmosphere thickness (default 0.1)
     * @param {number} options.densityFalloffMie - Scale height for Mie as fraction of atmosphere (default 0.015)
     * @param {number} options.visualDensity - 1.0 = Earth-like, >1 = thicker/hazier, <1 = thinner (default 1.0)
     * @param {number} options.mieAnisotropy - Forward scattering preference (default 0.76)
     * @param {number} options.sunIntensity - Sun brightness multiplier (default 20.0)
     */
    static createForPlanet(planetRadius, options = {}) {
        // Atmosphere thickness - can be absolute or ratio-based
        const atmosphereThicknessRatio = options.atmosphereThicknessRatio ?? 0.2;
        const atmosphereThickness = options.atmosphereThickness ??
            (options.atmosphereHeight ?? (planetRadius * atmosphereThicknessRatio));

        // Scale heights as fractions of atmosphere thickness
        // Earth: scale height ~8000m out of ~100000m atmosphere = 0.08
        const densityFalloffRayleigh = options.densityFalloffRayleigh ?? 0.1;
        const densityFalloffMie = options.densityFalloffMie ?? 0.015;

        const scaleHeightRayleigh = options.scaleHeightRayleigh ??
            (atmosphereThickness * densityFalloffRayleigh);
        const scaleHeightMie = options.scaleHeightMie ??
            (atmosphereThickness * densityFalloffMie);

        // Visual density scaling - artistic control (1.0 = Earth-like)
        const visualDensity = options.visualDensity ?? 1.0;

        // Earth reference values
        const earthScaleHeightRayleigh = 8000;  // meters
        const earthScaleHeightMie = 1200;       // meters
        const earthRayleighR = 5.5e-6;
        const earthRayleighG = 13.0e-6;
        const earthRayleighB = 22.4e-6;
        const earthMie = 21e-6;

        // Scaling approach: Use sqrt of scale height ratio for gentler scaling
        // Full ratio (H_earth / H_planet) causes too much extinction on small planets
        // Square root gives a balance between visibility and color saturation
        const rayleighScale = Math.sqrt(earthScaleHeightRayleigh / scaleHeightRayleigh);
        const mieScale = Math.sqrt(earthScaleHeightMie / scaleHeightMie);

        // Apply scaling with visual density adjustment
        // visualDensity 1.0 = Earth-like appearance
        const rayleighR = options.rayleighScatteringR ?? (earthRayleighR * rayleighScale * visualDensity);
        const rayleighG = options.rayleighScatteringG ?? (earthRayleighG * rayleighScale * visualDensity);
        const rayleighB = options.rayleighScatteringB ?? (earthRayleighB * rayleighScale * visualDensity);
        const mieCoeff = options.mieScattering ?? (earthMie * mieScale * visualDensity);

        return new PlanetAtmosphereSettings({
            planetRadius: planetRadius,
            atmosphereHeight: atmosphereThickness,
            rayleighScatteringR: rayleighR,
            rayleighScatteringG: rayleighG,
            rayleighScatteringB: rayleighB,
            mieScattering: mieCoeff,
            mieAnisotropy: options.mieAnisotropy ?? 0.76,
            scaleHeightRayleigh: scaleHeightRayleigh,
            scaleHeightMie: scaleHeightMie,
            groundAlbedo: options.groundAlbedo ?? 0.3,
            sunIntensity: options.sunIntensity ?? 20.0
        });
    }

    /**
     * Create a thin, wispy atmosphere (like Mars or a small moon)
     */
    static createThinAtmosphere(planetRadius, options = {}) {
        return PlanetAtmosphereSettings.createForPlanet(planetRadius, {
            atmosphereThicknessRatio: options.atmosphereThicknessRatio ?? 0.1,
            visualDensity: options.visualDensity ?? 0.3,
            mieAnisotropy: options.mieAnisotropy ?? 0.85,
            sunIntensity: options.sunIntensity ?? 25.0,
            ...options
        });
    }

    /**
     * Create a thick, hazy atmosphere (like Venus or Titan)
     */
    static createThickAtmosphere(planetRadius, options = {}) {
        return PlanetAtmosphereSettings.createForPlanet(planetRadius, {
            atmosphereThicknessRatio: options.atmosphereThicknessRatio ?? 0.4,
            visualDensity: options.visualDensity ?? 2.5,
            mieAnisotropy: options.mieAnisotropy ?? 0.65,
            sunIntensity: options.sunIntensity ?? 15.0,
            ...options
        });
    }

    static createPreset(presetName) {
        switch (presetName.toLowerCase()) {
            case 'earth':
                return new PlanetAtmosphereSettings({
                    planetRadius: 6371000,
                    atmosphereHeight: 100000,
                    rayleighScatteringR: 5.5e-6,
                    rayleighScatteringG: 13.0e-6,
                    rayleighScatteringB: 22.4e-6,
                    mieScattering: 21e-6,
                    mieAnisotropy: 0.758,
                    scaleHeightRayleigh: 8000,
                    scaleHeightMie: 1200,
                    groundAlbedo: 0.3,
                    sunIntensity: 20.0
                });

            case 'mars':
                return new PlanetAtmosphereSettings({
                    planetRadius: 3389500,
                    atmosphereHeight: 125000,
                    rayleighScatteringR: 19.9e-6,
                    rayleighScatteringG: 13.6e-6,
                    rayleighScatteringB: 5.8e-6,
                    mieScattering: 4e-6,
                    mieAnisotropy: 0.76,
                    scaleHeightRayleigh: 11100,
                    scaleHeightMie: 2500,
                    groundAlbedo: 0.25,
                    sunIntensity: 18.0
                });

            case 'venus':
                return new PlanetAtmosphereSettings({
                    planetRadius: 6051800,
                    atmosphereHeight: 250000,
                    rayleighScatteringR: 4.5e-6,
                    rayleighScatteringG: 11.0e-6,
                    rayleighScatteringB: 20.0e-6,
                    mieScattering: 30e-6,
                    mieAnisotropy: 0.85,
                    scaleHeightRayleigh: 15900,
                    scaleHeightMie: 3000,
                    groundAlbedo: 0.75,
                    sunIntensity: 25.0
                });

            default:
                return PlanetAtmosphereSettings.createPreset('earth');
        }
    }
}
