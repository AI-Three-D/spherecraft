/** Shared by the detail tiers: where the slabs take over from the raymarch, above the cloud tops (km), and how many. */
const SHARED = Object.freeze({ orbitStartKm: 40, orbitEndKm: 80, orbitSlabs: 24 });

/**
 * Detail of the clouds (settings.cloudDetail).
 * - maxRays: cloud rays per frame, at most.
 * - march, pairs: constants of the raymarch and of the ray pairs.
 * - lean: the composite of CloudLeanComposite.js. cirrusScale: size of the cirrus that the composite reads.
 * - godRays: their size (GOD_RAY_SIZES), or false. godRaysBelow: only below the clouds.
 * - fog, mist: fog on mountains and mist on the ground (CloudLocalVolumes.js), their amount and detail.
 * - cirrusOnly: no volumetric clouds at all.
 */
export const CLOUD_DETAIL_TIERS = Object.freeze({
    high: Object.freeze({
        ...SHARED, detail: 'high', maxRays: 576 * 360, cirrusScale: 0.5,
        march: Object.freeze({ BROKEN_BAND: 3, FAR_LIGHT_FILTER: 1 }),
        fog: Object.freeze({ amount: 1, FLOW_REACH: 8, grid: Object.freeze([144, 100, 112]) }),
        mist: Object.freeze({ amount: 1, grid: Object.freeze([160, 90, 40]) }),
    }),
    medium: Object.freeze({
        ...SHARED, detail: 'medium', maxRays: 500 * 280, lean: true, cirrusScale: 0.33, godRays: 'medium', godRaysBelow: true,
        march: Object.freeze({
            PITCH_SCALE: 1.2, DECK_PITCH_SCALE: 1.45, FAR_PITCH_SCALE: 2.2, BROKEN_BAND: 3, FILTER_SCALE: 1.3,
            ALTO_DETAIL: false, FAR_LIGHT_FILTER: 1, DISTANT_BANKS: false,
        }),
        pairs: Object.freeze({ FILL_ALL: true }),
        fog: Object.freeze({ amount: 0.85, FLOW_REACH: 4, grid: Object.freeze([112, 88, 84]) }),
        mist: Object.freeze({ amount: 0.85, grid: Object.freeze([112, 63, 28]) }),
    }),
    low: Object.freeze({
        ...SHARED, detail: 'low', maxRays: 64 * 36, lean: true, cirrusScale: 0.3, godRays: false, cirrusOnly: true,
    }),
});

export const DEFAULT_CLOUD_DETAIL = 'high';
