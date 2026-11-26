const PRESETS = {
    earth: {},
    arid: { temperatureOffsetC: 7, humidityOffset: -0.24, duneHeightM: 22, sandstoneBias: 0.20 },
    boreal: { temperatureOffsetC: -10, humidityOffset: 0.10, graniteBias: 0.14 },
    maritime: { temperatureOffsetC: -2, humidityOffset: 0.18, erosion: 1.12 },
    alpine: { temperatureOffsetC: -6, graniteBias: 0.28, rockReliefM: 22, erosion: 1.12 },
    legacy: { enabled: false },
};

export const BIOME_LANDSCAPE_PRESETS = Object.freeze(Object.keys(PRESETS));

const LIMITS = {
    temperatureOffsetC: [0, -25, 25],
    temperatureContrastC: [48, 0, 80],
    temperatureNoiseC: [6, 0, 20],
    humidityOffset: [0, -0.5, 0.5],
    humidityContrast: [0.38, 0, 0.8],
    humidityRegionM: [23000, 2000, 200000],
    humidityLocalM: [3100, 300, 30000],
    elevationDrying: [0.09, 0, 0.3],
    desertHumidity: [0.35, 0.12, 0.65],
    forestHumidity: [0.64, 0.35, 0.9],
    marshHumidity: [0.69, 0.50, 0.90],
    transitionWidth: [0.095, 0.025, 0.18],
    snowTemperatureC: [-1, -20, 12],
    glacierTemperatureC: [-10, -25, 0],
    treelineTemperatureC: [9, -10, 22],
    erosion: [1, 0, 2],
    weatheringContrast: [0.16, 0, 0.8],
    bedrockRegionM: [19000, 1000, 180000],
    bedrockContrast: [1, 0.1, 2],
    graniteBias: [0, -0.4, 0.4],
    sandstoneBias: [0, -0.4, 0.4],
    rockReliefM: [12, 0, 95],
    beddingThicknessM: [125, 20, 400],
    duneHeightM: [0, 0, 60],
    duneSpacingM: [205, 80, 650],
    duneFieldM: [4600, 1000, 24000],
    duneWindDegrees: [32, 0, 360],
};

export function usesBiomeLandscape(terrain, baseGenerator = terrain?.baseGenerator ?? 'earthLike') {
    return terrain?.biomeLandscape?.enabled === true && ['earthLike', 'lakeLand'].includes(baseGenerator);
}

export function normalizeBiomeLandscape(options = { preset: 'legacy' }) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('biomeLandscape must be an object');
    }
    const preset = options.preset ?? 'earth';
    if (!Object.hasOwn(PRESETS, preset)) {
        throw new Error(`biomeLandscape.preset must be ${BIOME_LANDSCAPE_PRESETS.join(', ')}`);
    }
    const authored = { ...PRESETS[preset], ...options };
    const result = { preset, enabled: preset !== 'legacy' && authored.enabled !== false };
    for (const [name, [fallback, min, max]] of Object.entries(LIMITS)) {
        const value = authored[name] ?? fallback;
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`biomeLandscape.${name} must be between ${min} and ${max}`);
        }
        result[name] = value;
    }
    if (result.treelineTemperatureC - result.snowTemperatureC < 3) {
        throw new Error('biomeLandscape.treelineTemperatureC must be at least 3 °C above snowTemperatureC');
    }
    if (result.forestHumidity - result.desertHumidity < 0.1) {
        throw new Error('biomeLandscape.forestHumidity must be at least 0.1 above desertHumidity');
    }
    return result;
}
