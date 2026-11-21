export function normalizeLandformDetails(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('landformDetails must be an object');
    }
    const details = {};
    for (const key of ['rangeValleys', 'regionalRollingHills', 'coastalHills', 'coves']) {
        if (options[key] !== undefined && typeof options[key] !== 'boolean') {
            throw new Error(`landformDetails.${key} must be a boolean`);
        }
        details[key] = options[key] ?? false;
    }
    return details;
}
