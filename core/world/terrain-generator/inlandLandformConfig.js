export function normalizeInlandLandforms(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('inlandLandforms must be an object');
    }
    const config = {};
    for (const key of ['mesas', 'cuestas', 'fells']) {
        if (options[key] !== undefined && typeof options[key] !== 'boolean') {
            throw new Error(`inlandLandforms.${key} must be a boolean`);
        }
        config[key] = options[key] ?? false;
    }
    return config;
}
