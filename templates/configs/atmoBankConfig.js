import { ATMO_BANK_TYPES } from '../../core/renderer/atmosphere-banks/AtmoBankTypes.js';

export const ATMO_BANK_CONFIG = {
    [ATMO_BANK_TYPES.VALLEY_MIST]: {
        noiseScale: 0.008,
        noiseSpeed: 0.02,
        densityBase: 0.6,
        windResponse: 0.1,
        lifetime: { min: 60, max: 120 },
        size: { min: 40, max: 120 },
        color: [0.75, 0.78, 0.82, 0.45],
        fadeNearStart: 20.0,
        fadeFarStart: 1200.0,
        fadeFarEnd: 2000.0,
        densityThreshold: 0.35,
    },

    [ATMO_BANK_TYPES.FOG_POCKET]: {
        noiseScale: 0.02,
        noiseSpeed: 0.04,
        densityBase: 0.7,
        windResponse: 0.15,
        lifetime: { min: 30, max: 80 },
        size: { min: 15, max: 50 },
        color: [0.72, 0.75, 0.80, 0.55],
        fadeNearStart: 10.0,
        fadeFarStart: 800.0,
        fadeFarEnd: 1500.0,
        densityThreshold: 0.30,
    },

    [ATMO_BANK_TYPES.LOW_CLOUD]: {
        noiseScale: 0.006,
        noiseSpeed: 0.015,
        densityBase: 0.5,
        windResponse: 0.3,
        lifetime: { min: 90, max: 180 },
        size: { min: 60, max: 200 },
        color: [0.82, 0.84, 0.88, 0.40],
        fadeNearStart: 30.0,
        fadeFarStart: 1500.0,
        fadeFarEnd: 2500.0,
        densityThreshold: 0.40,
    },
};

export const ATMO_PLACEMENT_CONFIG = {
    cellSize: 400,
    scanRadius: 7,
    maxRenderDist: 2000,
    baseSpawnBudget: 3,
    lodNearDistance: 200,
    lodFarDistance: 1500,
    lodMinScale: 0.1,
    distanceCutoff: 2000,
    spawnProbability: 0.35,
};
