// Startup configuration shared by terrain tiles, lake tables and hydrology.
// Lengths are metres; density is candidate sites per square kilometre.
export function normalizeCalderaConfig(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('calderas must be an object');
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('calderas.enabled must be a boolean');
    const number = (key, fallback, min, max) => {
        const value = options[key] ?? fallback;
        if (!Number.isFinite(value) || value < min || value > max) throw new Error(`calderas.${key} must be between ${min} and ${max}`);
        return value;
    };
    const config = {
        enabled: options.enabled ?? false,
        cellSizeM: number('cellSizeM', 60000, 30000, 200000),
        densityPerKm2: number('densityPerKm2', 0.00018, 0, 0.01),
        minRadiusM: number('minRadiusM', 8000, 3000, 30000),
        maxRadiusM: number('maxRadiusM', 10500, 3000, 30000),
        minHeightM: number('minHeightM', 1200, 100, 4000),
        maxHeightM: number('maxHeightM', 1600, 100, 4000),
        craterDepth: number('craterDepth', 0.72, 0.35, 0.75),
    };
    if (config.minRadiusM > config.maxRadiusM || config.minHeightM > config.maxHeightM) throw new Error('Invalid caldera radius or height range');
    if (config.maxHeightM / config.minRadiusM > 0.2) throw new Error('calderas height/radius must not exceed 0.2 for the terrain grid');
    if (config.cellSizeM < config.maxRadiusM * 4) throw new Error('calderas.cellSizeM must be at least four times maxRadiusM');
    return config;
}
