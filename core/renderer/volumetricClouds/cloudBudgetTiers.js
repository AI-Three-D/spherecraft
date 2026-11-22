// These limits bound procedural density work per cloud ray, including in a full storm.
export const CLOUD_BUDGET_MAX_RAYS = 768 * 480;
export const CLOUD_BUDGET_TIERS = Object.freeze({
    medium: Object.freeze({ nearKm: 0.84, fairKm: 1.0, nearSteps: 6, fullLighting: false, cirrusVolume: false }),
    high: Object.freeze({ nearKm: 2.4, fairKm: 6.5, nearSteps: 22, fullLighting: false, cirrusVolume: false }),
    ultra: Object.freeze({ nearKm: 4.2, fairKm: 10.0, nearSteps: 36, fullLighting: true, cirrusVolume: true }),
});
