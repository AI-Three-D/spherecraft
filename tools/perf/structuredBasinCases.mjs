// Review cases configure the same production basin planner and carve model.
// These are diagnostics, not separate lowland/alpine terrain implementations.
export const HIGHLAND_BASIN_CASE={radiusM:60,minLevelM:900,maxRoughness:1,maxCentreCutM:16};
export const VALLEY_FEATURE_CASE={...HIGHLAND_BASIN_CASE,radiusM:120};
