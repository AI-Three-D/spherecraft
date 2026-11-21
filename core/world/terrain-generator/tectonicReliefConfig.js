export function normalizeTectonicRelief(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('tectonicRelief must be an object');
    }
    const { enabled = false, plateCount = 18, mountainReliefM = 2400, interiorReliefM = 560 } = options;
    if (typeof enabled !== 'boolean') throw new Error('tectonicRelief.enabled must be a boolean');
    if (!Number.isInteger(plateCount) || plateCount < 8 || plateCount > 24) {
        throw new Error('tectonicRelief.plateCount must be an integer from 8 to 24');
    }
    for (const [name, value, max] of [['mountainReliefM', mountainReliefM, 4000], ['interiorReliefM', interiorReliefM, 1200]]) {
        if (!Number.isFinite(value) || value < 0 || value > max) {
            throw new Error(`tectonicRelief.${name} must be between 0 and ${max}`);
        }
    }
    return { enabled, plateCount, mountainReliefM, interiorReliefM };
}
