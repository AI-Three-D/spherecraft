// js/config/grassConfig.js
import { TILE_TYPES } from '../types.js';

const BASE_GRASS = {
    color: { base: [0.2, 0.45, 0.1], tip: [0.35, 0.6, 0.15] },
    heightRange: [0.9, 2.4],  // meters (tall grass)
    widthRange: [0.02, 0.05],
    field: {
        worldScale: 0.025,   // ~40m patch size for dense fields
        densityMin: 0.1,     // mostly sparse between fields
        densityMax: 1.5,     // dense inside fields
        heightMin: 0.6,      // shorter outside fields
        heightMax: 1.2       // taller inside fields
    },
    clump: {
        worldScale: 0.05,    // lower = larger clumps (in world units)
        densityMin: 0.5,     // outside clumps
        densityMax: 1.5,     // inside clumps
        heightMin: 0.8,      // outside clumps
        heightMax: 1.3       // inside clumps
    },
    micro: {
        heightRange: [0.03, 0.1], // 3–10 cm
        widthRange: [0.006, 0.02],
        densityScale: 3.0,       // relative to blade density
        fieldMin: 0.25,          // micro still present between fields
        fieldMax: 1.0
    }
};

export const GRASS_TYPES = {
    GRASS_SHORT: {
        tileTypeId: TILE_TYPES.GRASS_SHORT_1,
        ...BASE_GRASS
    },
    GRASS_MEDIUM: {
        tileTypeId: TILE_TYPES.GRASS_MEDIUM_1,
        ...BASE_GRASS
    },
    GRASS_TALL: {
        tileTypeId: TILE_TYPES.GRASS_TALL_1,
        ...BASE_GRASS
    },
    GRASS_MEADOW: {
        tileTypeId: TILE_TYPES.GRASS_MEADOW_1,
        ...BASE_GRASS
    },
    GRASS_FLOWER_FIELD: {
        tileTypeId: TILE_TYPES.GRASS_FLOWER_FIELD_1,
        ...BASE_GRASS
    }
};

export const GRASS_QUALITY_LEVELS = {
    ultra: {
        maxBladeInstances: 220000,
        maxMidBladeInstances: 160000,
        maxLowBladeInstances: 110000,
        maxMicroInstances: 120000,
        maxClusterInstances: 80000,
        maxScatterTileWorldSize: 64,
        bladeSegments: 5,
        bladeSegmentsMid: 3,
        bladeSegmentsLow: 2,
        bladeNearDistance: 14,
        bladeMidDistance: 26,
        bladeLowDistance: 45,
        bladeDistance: 30,
        clusterDistance: 100,
        farDistance: 300,
        densityPerSquareMeter: 20,
        midDensityScale: 0.8,
        lowDensityScale: 0.5,
        clusterDensityPerSquareMeter: 16,
        farDensityPerSquareMeter: 6,
        windStrength: 1.0,
        lodBlendDistance: 6,
        windMaxDistance: 15,
        windFadeDistance: 5,
        scatterInterval: 1,
        scatterMinMove: 0.0,
    },
    high: {
        maxBladeInstances: 180000,
        maxMidBladeInstances: 130000,
        maxLowBladeInstances: 90000,
        maxMicroInstances: 90000,
        maxClusterInstances: 60000,
        maxScatterTileWorldSize: 56,
        bladeSegments: 4,
        bladeSegmentsMid: 3,
        bladeSegmentsLow: 2,
        bladeNearDistance: 12,
        bladeMidDistance: 22,
        bladeLowDistance: 40,
        bladeDistance: 25,
        clusterDistance: 80,
        farDistance: 250,
        densityPerSquareMeter: 16,
        midDensityScale: 0.75,
        lowDensityScale: 0.45,
        clusterDensityPerSquareMeter: 12,
        farDensityPerSquareMeter: 5,
        windStrength: 1.0,
        lodBlendDistance: 6,
        windMaxDistance: 15,
        windFadeDistance: 5,
        scatterInterval: 1,
        scatterMinMove: 0.0,
    },
    medium: {
        maxBladeInstances: 140000,
        maxMidBladeInstances: 110000,
        maxLowBladeInstances: 80000,
        maxMicroInstances: 80000,
        maxClusterInstances: 50000,
        maxScatterTileWorldSize: 48,
        bladeSegments: 3,
        bladeSegmentsMid: 2,
        bladeSegmentsLow: 1,
        bladeNearDistance: 12,
        bladeMidDistance: 22,
        bladeLowDistance: 40,
        bladeDistance: 20,
        clusterDistance: 60,
        farDistance: 200,
        densityPerSquareMeter: 14,
        midDensityScale: 0.7,
        lowDensityScale: 0.45,
        clusterDensityPerSquareMeter: 12,
        farDensityPerSquareMeter: 4,
        windStrength: 0.8,
        lodBlendDistance: 5,
        windMaxDistance: 15,
        windFadeDistance: 5,
        scatterInterval: 2,
        scatterMinMove: 0.25,
    },
    low: {
        maxBladeInstances: 50000,
        maxMidBladeInstances: 40000,
        maxLowBladeInstances: 25000,
        maxMicroInstances: 20000,
        maxClusterInstances: 12000,
        maxScatterTileWorldSize: 32,
        bladeSegments: 2,
        bladeSegmentsMid: 2,
        bladeSegmentsLow: 1,
        bladeNearDistance: 8,
        bladeMidDistance: 14,
        bladeLowDistance: 24,
        bladeDistance: 15,
        clusterDistance: 40,
        farDistance: 150,
        densityPerSquareMeter: 6,
        midDensityScale: 0.6,
        lowDensityScale: 0.35,
        clusterDensityPerSquareMeter: 5,
        farDensityPerSquareMeter: 2,
        windStrength: 0.6,
        lodBlendDistance: 4,
        windMaxDistance: 15,
        windFadeDistance: 5,
        scatterInterval: 3,
        scatterMinMove: 0.4,
    }
};
