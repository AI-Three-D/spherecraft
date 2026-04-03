// Texture level definitions
export const TEXTURE_LEVELS = {
    MICRO: 'micro',         // Per-tile textures
    MACRO: 'macro',
    PROP: 'prop',
};

export const SEASONS = {
    SPRING: 'Spring',   
    SUMMER: 'Summer',  
    AUTUMN: 'Autumn',  
    WINTER: 'Winter'   
};

// Main tile configuration
export const TILE_CONFIG = [

];

// Texture atlas configurations
// - atlasSize: size in pixels of a canvas atlas (used by non-procedural path)
// - textureSize: logical size of individual textures in the atlas (used by non-procedural path and as a default for procedural)
// - proceduralTextureSize: optional override used only by the procedural texture generator (texture arrays). If unset, textureSize is used.
export const ATLAS_CONFIG = {
    [TEXTURE_LEVELS.MICRO]: {
        atlasSize: 2048,
        textureSize: 256,
        proceduralTextureSize: 256,
        // Procedural tile seam handling (edge blending for rotation-safe tiling).
        seamless: {
            enabled: true,
            method: 'quad-symmetric',
            blendRadius: 4,
            blendStrength: 1.0,
            cornerBlend: true,
        },
    },
    [TEXTURE_LEVELS.MACRO]: {
        atlasSize: 4096,
        textureSize: 2048,
        proceduralTextureSize: 2048,
        // Macro tiles can opt in/out independently.
        seamless: {
            enabled: true,
            method: 'quad-symmetric',
            blendRadius: 4,
            blendStrength: 1.0,
            cornerBlend: true,
        },
    },
    [TEXTURE_LEVELS.PROP]: {
        atlasSize: 8192,
        textureSize: 1024,
        proceduralTextureSize: 1024,
        seamless: {
            enabled: true,
            method: 'quad-symmetric',
            blendRadius: 4,
            blendStrength: 1.0,
            cornerBlend: true,
        },
    },
};

export class TextureConfigHelper {
    static getTileConfig(tileType) {
        return TILE_CONFIG.find(config => config.id === tileType);
    }

    static getTexturesForSeason(tileType, season, level) {
        const config = this.getTileConfig(tileType);
        if (!config) return [];

        // Get textures for the specific season and level
        return config.textures.base[season]?.[level] || [];
    }

    static getSeasonTint(tileType, season) {
        const config = this.getTileConfig(tileType);
        return config?.seasonTint?.[season] || [1, 1, 1];
    }

    static getTransitionFactor(currentSeason, nextSeason, daysUntilNextSeason) {
        // Transition starts 10 days before season change
        const transitionDays = 10;
        if (daysUntilNextSeason > transitionDays) return 0;
        return 1 - (daysUntilNextSeason / transitionDays);
    }

    static getAllTexturesForLevel(level) {
        const textures = new Set();
        // Add all tile textures for all seasons
        TILE_CONFIG.forEach(config => {
            Object.values(SEASONS).forEach(season => {
                const seasonTextures = config.textures.base[season]?.[level];
                if (seasonTextures) {
                    seasonTextures.forEach(tex => textures.add(tex));
                }
            });
        });
        return Array.from(textures);
    }

    // Prop textures are currently unused in the procedural pipeline.
    static getAllPropTextures()     { return []; }
    static getPropTexturePath(_t)   { return null; }
    static getPropTypes()           { return []; }
}
