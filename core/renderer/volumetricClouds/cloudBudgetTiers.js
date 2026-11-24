// These limits bound procedural density work per cloud ray, including in a full storm.
export const CLOUD_BUDGET_MAX_RAYS = 768 * 480;
const CONVENTIONAL_CLOUD_BUDGET = Object.freeze({
    focusKm: 3, steps: 64, lowSteps: 60, weatherCubeSize: 256, maxRays: 576 * 360,
    orbitStartKm: 40, orbitEndKm: 80, orbitSlabs: 24,
    cirrusVolume: false, conventional: true,
});
export const CLOUD_BUDGET_TIERS = Object.freeze({
    conventional: CONVENTIONAL_CLOUD_BUDGET,
    neural: Object.freeze({ ...CONVENTIONAL_CLOUD_BUDGET, neural: true }),
    medium: Object.freeze({ nearKm: 0.84, fairKm: 1.0, nearSteps: 6, fullLighting: false, cirrusVolume: false }),
    high: Object.freeze({ nearKm: 2.4, fairKm: 6.5, nearSteps: 22, fullLighting: false, cirrusVolume: false }),
    ultra: Object.freeze({ nearKm: 4.2, fairKm: 10.0, nearSteps: 36, fullLighting: true, cirrusVolume: true }),
});

/**
 * Detail of the Conventional and Neural lighting modes (settings.cloudDetail), merged into their budget.
 * - march, pairs: constants of the raymarch and of the ray pairs.
 * - lean: the composite of CloudLeanComposite.js. cirrusScale: size of the cirrus that the composite reads; without it the
 *   host draws it over the whole screen.
 * - godRays: their size (GOD_RAY_SIZES), or false. godRaysBelow: only below the clouds.
 * - fog, mist: fog on mountains and mist on the ground (CloudLocalVolumes.js), their amount and detail.
 * - cirrusOnly: no volumetric clouds at all.
 */
export const CLOUD_DETAIL_TIERS = Object.freeze({
    high: Object.freeze({
        cirrusScale: 0.5,
        march: Object.freeze({ BROKEN_BAND: 3, FAR_LIGHT_FILTER: 1 }),
        fog: Object.freeze({ amount: 1, ROLLING: true, grid: Object.freeze([144, 100, 112]) }),
        mist: Object.freeze({ amount: 1, grid: Object.freeze([160, 90, 40]) }),
    }),
    medium: Object.freeze({
        maxRays: 500 * 280, lean: true, cirrusScale: 0.33, godRays: 'medium', godRaysBelow: true,
        march: Object.freeze({
            PITCH_SCALE: 1.2, DECK_PITCH_SCALE: 1.45, FAR_PITCH_SCALE: 2.2, BROKEN_BAND: 3, FILTER_SCALE: 1.3,
            ALTO_DETAIL: false, FAR_LIGHT_FILTER: 1, DISTANT_BANKS: false,
        }),
        pairs: Object.freeze({ FILL_ALL: true }),
        fog: Object.freeze({ amount: 0.85, ROLLING: false, grid: Object.freeze([112, 88, 84]) }),
        mist: Object.freeze({ amount: 0.85, grid: Object.freeze([112, 63, 28]) }),
    }),
    low: Object.freeze({ maxRays: 64 * 36, lean: true, cirrusScale: 0.3, godRays: false, cirrusOnly: true }),
});
