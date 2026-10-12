// js/world/quadtree/solidTierFade.js
//
// Where detail LODs blend into the flat solid-color tier, shared by the
// terrain renderer (shader uniforms tierFadeStart/tierFadeEnd) and the tile
// streamer (which skips refining tiles drawn entirely past the fade end,
// where the flat color fully replaces their material).

// Camera-distance ramp into the solid-color tier (see
// solidColorTierDistanceFade* in the terrain shader config). Derived from the
// same LOD metric the GPU traversal uses, so the ramp sits at the same place
// relative to the LOD bands on any canvas size:
//   split distance of the solid tier's tiles  D = tileSize * lodFactor / T
//   farthest a tile's pixel can be from its centre  R = sqrt(halfDiag^2 + h^2)
//   end   = D - safety * R   (nearest point a solid-tier pixel can appear)
//   start = end - bandFraction * D
// T mirrors the traversal's 4-px quantization of the screen error:
// round(e / 4) * 4 > threshold  <=>  e >= 4 * floor(threshold / 4) + 2.
// Returns null (ramp off) when disabled or the inputs aren't ready.
export function computeSolidTierFadeDistances({
    lodFactor,
    faceSize,
    maxDepth,
    lodErrorThreshold,
    shaderConfig
} = {}) {
    const cfg = shaderConfig;
    if (!cfg?.solidColorTierEnabled || !cfg?.solidColorTierDistanceFadeEnabled) return null;
    const solidLod = cfg.solidColorStartLod;
    if (![lodFactor, faceSize, maxDepth, lodErrorThreshold, solidLod].every(Number.isFinite)) return null;

    const tileSize = faceSize / Math.pow(2, Math.max(0, maxDepth - solidLod));
    const effectiveThreshold = Math.max(1, 4 * Math.floor(lodErrorThreshold / 4) + 2);
    const splitDistance = tileSize * lodFactor / effectiveThreshold;
    const halfDiagonal = tileSize * Math.SQRT1_2;
    const heightMargin = Math.max(0, cfg.solidColorTierDistanceFadeHeightMarginMeters ?? 1000);
    const reach = Math.sqrt(halfDiagonal * halfDiagonal + heightMargin * heightMargin);
    const safety = Math.max(0, cfg.solidColorTierDistanceFadeEndSafety ?? 1.0);
    const bandFraction = Math.max(0.01, cfg.solidColorTierDistanceFadeBandFraction ?? 0.3);

    const end = Math.max(1.0, splitDistance - safety * reach);
    const start = Math.max(0.0, end - bandFraction * splitDistance);
    return { start, end, splitDistance, reach };
}

// Unit direction of face UV (u, v) in [0, 1]: same cube layout and plain
// normalization as the GPU traversal's getCubePoint (gnomonic), so tile edges
// are great-circle arcs.
function unitCubeDirection(face, u, v, out) {
    const s = u * 2 - 1;
    const t = v * 2 - 1;
    let cx = 0, cy = 1, cz = 0;
    switch (face) {
        case 0: cx = 1;  cy = t;  cz = -s; break;
        case 1: cx = -1; cy = t;  cz = s;  break;
        case 2: cx = s;  cy = 1;  cz = -t; break;
        case 3: cx = s;  cy = -1; cz = t;  break;
        case 4: cx = s;  cy = t;  cz = 1;  break;
        case 5: cx = -s; cy = t;  cz = -1; break;
        default: break;
    }
    const len = Math.hypot(cx, cy, cz) || 1;
    out[0] = cx / len;
    out[1] = cy / len;
    out[2] = cz / len;
    return out;
}

const _center = [0, 0, 0];
const _corner = [0, 0, 0];

// A distance that no pixel of the tile can be nearer than, whatever its
// terrain height. A pixel sits at radius r >= minSurfaceRadius in a direction
// at angle theta from the camera's direction (camera at radius rc), so
//   d^2 = (rc - r)^2 + 4 rc r sin^2(theta / 2) >= 4 rc minSurfaceRadius sin^2(theta / 2).
// The tile is a convex spherical quad (great-circle edges), so every point is
// within its largest centre-to-corner angle of the centre direction, and
// theta >= centreAngle - cornerAngle.
export function tileNearestDistanceLowerBound(tile, cameraPosition, planetOrigin, minSurfaceRadius) {
    if (!tile || !cameraPosition || !(minSurfaceRadius > 0)) return 0;
    const ox = planetOrigin?.x ?? 0;
    const oy = planetOrigin?.y ?? 0;
    const oz = planetOrigin?.z ?? 0;
    const px = cameraPosition.x - ox;
    const py = cameraPosition.y - oy;
    const pz = cameraPosition.z - oz;
    const rc = Math.hypot(px, py, pz);
    if (!(rc > 0)) return 0;

    const grid = 1 << Math.max(0, tile.depth);
    unitCubeDirection(tile.face, (tile.x + 0.5) / grid, (tile.y + 0.5) / grid, _center);
    let minCornerCos = 1;
    for (let corner = 0; corner < 4; corner++) {
        const u = (tile.x + (corner & 1)) / grid;
        const v = (tile.y + (corner >> 1)) / grid;
        unitCubeDirection(tile.face, u, v, _corner);
        const cos = _center[0] * _corner[0] + _center[1] * _corner[1] + _center[2] * _corner[2];
        if (cos < minCornerCos) minCornerCos = cos;
    }
    const cornerAngle = Math.acos(Math.max(-1, Math.min(1, minCornerCos)));
    const centerCos = (_center[0] * px + _center[1] * py + _center[2] * pz) / rc;
    const centerAngle = Math.acos(Math.max(-1, Math.min(1, centerCos)));
    const theta = Math.max(0, centerAngle - cornerAngle);
    return 2 * Math.sin(theta * 0.5) * Math.sqrt(rc * minSurfaceRadius);
}
