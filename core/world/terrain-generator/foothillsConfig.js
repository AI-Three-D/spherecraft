// Shared startup configuration for the optional regional foothill model.
// All lengths are kilometres; the shader converts them to metres.
export function normalizeFoothillsConfig(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('foothills must be an object');
    }
    const model = options.model ?? 'legacy';
    if (!['legacy', 'regional'].includes(model)) throw new Error(`Unknown foothill model: ${model}`);
    const number = (key, fallback, min, max) => {
        const value = options[key] ?? fallback;
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`foothills.${key} must be between ${min} and ${max}`);
        }
        return value;
    };
    const config = {
        model,
        coverageStart: number('coverageStart', 0.36, 0, 1),
        coverageFull: number('coverageFull', 0.50, 0, 1),
        changeStart: number('changeStart', 0.40, 0, 1),
        changeFull: number('changeFull', 0.50, 0, 1),
        broadScaleKm: number('broadScaleKm', 7.0, 0.1, 1000),
        tightScaleKm: number('tightScaleKm', 2.7, 0.1, 1000),
        regionScaleKm: number('regionScaleKm', 28.0, 0.1, 1000),
        broadStretch: number('broadStretch', 0.48, 0.05, 1),
        tightStretch: number('tightStretch', 0.65, 0.05, 1),
        regionBias: number('regionBias', 0.18, 0, 2),
        strength: number('strength', 1.8, 0, 10),
    };
    // The expanded band must cover the legacy band and the new transition.
    if (config.coverageStart > 0.45 || config.coverageStart > config.changeStart ||
        config.coverageStart >= config.coverageFull || config.changeStart >= config.changeFull) {
        throw new Error('Invalid foothill coverage or change transition');
    }
    return config;
}
