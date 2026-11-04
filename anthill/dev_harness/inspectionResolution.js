// Harness policy, in physical pixels. Dragging gets a smaller ray workload, then
// settles to the inspection budget. This can be removed with the inspection controls.
export const INSPECTION_PIXELS = { moving: 360_000, settled: 1_000_000, settleMs: 180 };

export function inspectionPixelRatio(width, height, devicePixelRatio, moving) {
    const budget = moving ? INSPECTION_PIXELS.moving : INSPECTION_PIXELS.settled;
    return Math.min(devicePixelRatio, Math.sqrt(budget / Math.max(1, width * height)));
}
