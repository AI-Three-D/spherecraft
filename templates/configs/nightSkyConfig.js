// js/config/nightSkyConfig.js
import { requireInt, requireNumber, requireObject, requireBool } from '../../shared/requireUtil.js';

/**
 * Night sky configuration for game data (per-world settings).
 * These values are seeded and define the unique appearance of a world's night sky.
 */
export class NightSkyGameConfig {
    constructor(options = {}) {
        // Star field seed - determines star positions and colors
        this.starSeed = requireInt(options.starSeed ?? 12345, 'nightSky.starSeed', 0);
        
        // Galaxy configuration
        const galaxies = options.galaxies ?? {};
        this.galaxies = {
            // Number of visible galaxy bands (0 = no galaxies)
            count: requireInt(galaxies.count ?? 1, 'nightSky.galaxies.count', 0),
            // Seed for galaxy placement and appearance
            seed: requireInt(galaxies.seed ?? 54321, 'nightSky.galaxies.seed', 0),
            // Base brightness multiplier
            brightness: requireNumber(galaxies.brightness ?? 1.0, 'nightSky.galaxies.brightness'),
            // How spread out/diffuse the galaxy bands are (0.1 = tight, 0.5 = very diffuse)
            spread: requireNumber(galaxies.spread ?? 0.25, 'nightSky.galaxies.spread')
        };

      

        // Star color temperature distribution seed
        this.colorSeed = requireInt(options.colorSeed ?? 33333, 'nightSky.colorSeed', 0);
    }

    /**
     * Pack configuration into a Float32Array for GPU upload.
     * Returns 16 floats (64 bytes, aligned).
     */
    toGPUData() {
        const data = new Float32Array(16);
        data[0] = this.starSeed;
        data[1] = this.galaxies.count;
        data[2] = this.galaxies.seed;
        data[3] = this.galaxies.brightness;
        data[4] = this.galaxies.spread;
        data[5] = this.colorSeed;
        // Reserved for future use
        data[11] = 0.0;
        data[12] = 0.0;
        data[13] = 0.0;
        data[14] = 0.0;
        data[15] = 0.0;
        return data;
    }
}

/**
 * Night sky detail levels for engine configuration.
 * Controls performance vs quality tradeoffs.
 */
export const NightSkyDetailLevel = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high'
};

/**
 * Detail level parameters - these define the actual rendering settings.
 */
export const NIGHT_SKY_DETAIL_PRESETS = {
    [NightSkyDetailLevel.LOW]: {
        // Star rendering
        starLayers: 2,
        maxStarBrightness: 1.2,
        starTwinkle: false,
        starBoost: 2.0,
        starDensityMultiplier: 25.0,
        
        // Galaxies
        galaxyEnabled: false,
        galaxySamples: 0,

        // General
        ditherEnabled: false
    },
    
    [NightSkyDetailLevel.MEDIUM]: {
        // Star rendering
        starLayers: 4,
        maxStarBrightness: 2.0,
        starTwinkle: true,
        starBoost: 3.0,
        starDensityMultiplier: 50.0,
        
        // Galaxies
        galaxyEnabled: true,
        galaxySamples: 4,
        

        // General
        ditherEnabled: true
    },
    
    [NightSkyDetailLevel.HIGH]: {
        // Star rendering
        starLayers: 6,
        maxStarBrightness: 3.0,
        starTwinkle: true,
        starBoost: 4.0,
        starDensityMultiplier: 100.0,
        
        // Galaxies
        galaxyEnabled: true,
        galaxySamples: 8,
        
   
        // General
        ditherEnabled: true
    }
};

/**
 * Get detail preset, with fallback to medium if invalid.
 */
export function getNightSkyDetailPreset(level) {
    return NIGHT_SKY_DETAIL_PRESETS[level] || NIGHT_SKY_DETAIL_PRESETS[NightSkyDetailLevel.MEDIUM];
}
