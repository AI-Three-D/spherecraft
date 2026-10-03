// templates/terrain-shaders/features/featureRivers.wgsl.js
//
// Carves a river channel directly into the REAL terrain height, at
// terrain-generation time — not a separate overlay mesh. This is the fix
// for the walking-skeleton river's "floating/underground water, no visible
// channel" problem: a separate overlay mesh drawn on top of the real
// terrain can never look like real integrated terrain (z-fighting, visible
// seams, "pasted on top"). See RIVER_WALKING_SKELETON_LOG.md, Session 4.
//
// Unlike every other feature in this directory, there is no existing
// "apply only near one authored place" idiom in this codebase to copy —
// Mountains/Highlands/LoneHills/Canyons all place themselves via noise
// evaluated everywhere on the planet. This feature introduces that pattern:
// a straight channel gated by distance from a fixed anchor point + tangent
// direction (both real-world unit vectors, read from uniforms.riverAnchor/
// riverChannelDir), using the same real-world-meters recovery
// (`unitDir * noiseReferenceRadiusM()`) the rest of this file already
// relies on via noiseReferenceRadiusM() — no new coordinate convention.
//
// The channel's "right" axis is `cross(anchorDir, channelDir)`, which is
// provably identical to core/planet/surfaceFrame.js's
// computeSurfaceTangentFrame() `right` vector for this same anchor/forward
// pair (both reduce to the same vector-triple-product identity for an
// orthonormal up/right/forward frame) — so this carve's width axis lines up
// exactly with RiverSystem's simulated water patch, without needing to
// duplicate or import that JS-side frame computation here.
//
// Walking-skeleton scope: ONE straight, fixed channel (anchor + direction +
// half-width + depth + length, all uniform-driven, see
// wizard_game/runtimeConfigs.js's TerrainGenerationConfig `river` option).
// No meander, no multiple rivers, no authoring format yet — that's a later
// increment (see "Longer-term plan" in RIVER_WALKING_SKELETON_LOG.md).

export function createTerrainFeatureRivers() {
  return `
// ==================== Feature: Rivers (carved channel) ====================

fn featureRiverHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    if (uniforms.riverAnchor.w < 0.5) { return 0.0; }

    let R = noiseReferenceRadiusM();
    let anchorDir = normalize(uniforms.riverAnchor.xyz);
    let channelDir = normalize(uniforms.riverChannelDir.xyz);
    let halfWidth = max(uniforms.riverParams.x, 0.1);
    let depthM = max(uniforms.riverParams.y, 0.0);
    let lengthM = max(uniforms.riverParams.z, 1.0);

    let realPos = unitDir * R;
    let anchorPos = anchorDir * R;
    let delta = realPos - anchorPos;

    let rightAxis = cross(anchorDir, channelDir);
    let along = dot(delta, channelDir);
    let across = dot(delta, rightAxis);

    let pathCount = uniforms.riverPathCount;

    // Preferred path: HydrologyPrecompute.js found a real valley (the
    // terrain's own broad landform noise sitting below its surroundings)
    // and traced a steepest-descent channel through it — a polyline in this
    // same along/across space, not a straight line. Shape the carve by
    // distance to the nearest segment of it, with width/depth scaled per
    // segment by how pronounced a basin that specific point actually is.
    if (pathCount >= 2) {
        let here = vec2<f32>(along, across);
        var bestDistSq: f32 = 1e18;
        var bestWidthScale: f32 = 1.0;
        var bestDepthScale: f32 = 1.0;
        for (var i = 0; i < pathCount - 1; i = i + 1) {
            let p0 = uniforms.riverPath[i];
            let p1 = uniforms.riverPath[i + 1];
            let seg = vec2<f32>(p1.x - p0.x, p1.y - p0.y);
            let segLenSq = max(dot(seg, seg), 1e-6);
            let t = clamp(dot(here - vec2<f32>(p0.x, p0.y), seg) / segLenSq, 0.0, 1.0);
            let closest = vec2<f32>(p0.x, p0.y) + seg * t;
            let d = here - closest;
            let distSq = dot(d, d);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestWidthScale = mix(p0.z, p1.z, t);
                bestDepthScale = mix(p0.w, p1.w, t);
            }
        }
        let dist = sqrt(bestDistSq);
        let effHalfWidth = halfWidth * bestWidthScale;
        // Flat-bottomed valley, not a narrow V-groove: full depth out to the
        // bed's own half-width, then a much wider taper (3.5x) up to the
        // undisturbed banks. A single-stage smoothstep close to the
        // centerline reads as a scratch across the terrain rather than a
        // valley the ground itself was shaped by — confirmed live (a
        // technically-correct channel that still looked "ugly", ran across
        // a hillside with no sense of a valley carved around it).
        let bankHalfWidth = effHalfWidth * 3.5;
        let widthShape = 1.0 - smoothstep(effHalfWidth, bankHalfWidth, dist);
        let normalizedDepth = (depthM * bestDepthScale) / max(maxTerrainHeightM(), 1.0);
        return -normalizedDepth * widthShape;
    }

    // Fallback: no traced path (precompute hasn't run, or found nothing
    // plausible) — the original fixed straight channel, so the demo still
    // shows *something* rather than silently carving nothing.
    let bankHalfWidth = halfWidth * 3.5;
    let widthShape = 1.0 - smoothstep(halfWidth, bankHalfWidth, abs(across));
    let halfLen = lengthM * 0.5;
    let lengthShape = 1.0 - smoothstep(halfLen * 0.85, halfLen, abs(along));
    let shape = widthShape * clamp(lengthShape, 0.0, 1.0);
    let normalizedDepth = depthM / max(maxTerrainHeightM(), 1.0);
    return -normalizedDepth * shape;
}

// Analytic-derivative twin of featureRiverHeight (sphere). Values use the
// plain function's expressions; the gradient follows the distance to the
// nearest path segment, including width/depth varying along it.
fn featureRiverHeight_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> vec4<f32> {
    if (uniforms.riverAnchor.w < 0.5) { return dConst(0.0); }

    let R = noiseReferenceRadiusM();
    let anchorDir = normalize(uniforms.riverAnchor.xyz);
    let channelDir = normalize(uniforms.riverChannelDir.xyz);
    let halfWidth = max(uniforms.riverParams.x, 0.1);
    let depthM = max(uniforms.riverParams.y, 0.0);
    let lengthM = max(uniforms.riverParams.z, 1.0);

    let realPos = unitDir * R;
    let anchorPos = anchorDir * R;
    let delta = realPos - anchorPos;

    let rightAxis = cross(anchorDir, channelDir);
    let along = dot(delta, channelDir);
    let across = dot(delta, rightAxis);
    // d(along)/d(unitDir), d(across)/d(unitDir)
    let gAlong = channelDir * R;
    let gAcross = rightAxis * R;

    let pathCount = uniforms.riverPathCount;

    if (pathCount >= 2) {
        let here = vec2<f32>(along, across);
        var bestDistSq: f32 = 1e18;
        var bestWidthScale: f32 = 1.0;
        var bestDepthScale: f32 = 1.0;
        var bestD = vec2<f32>(0.0);
        var bestSeg = vec2<f32>(1.0, 0.0);
        var bestSegLenSq: f32 = 1.0;
        var bestInterior = false;
        var bestWidthSlope: f32 = 0.0;
        var bestDepthSlope: f32 = 0.0;
        for (var i = 0; i < pathCount - 1; i = i + 1) {
            let p0 = uniforms.riverPath[i];
            let p1 = uniforms.riverPath[i + 1];
            let seg = vec2<f32>(p1.x - p0.x, p1.y - p0.y);
            let segLenSq = max(dot(seg, seg), 1e-6);
            let tRaw = dot(here - vec2<f32>(p0.x, p0.y), seg) / segLenSq;
            let t = clamp(tRaw, 0.0, 1.0);
            let closest = vec2<f32>(p0.x, p0.y) + seg * t;
            let d = here - closest;
            let distSq = dot(d, d);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestWidthScale = mix(p0.z, p1.z, t);
                bestDepthScale = mix(p0.w, p1.w, t);
                bestD = d;
                bestSeg = seg;
                bestSegLenSq = segLenSq;
                bestInterior = tRaw > 0.0 && tRaw < 1.0;
                bestWidthSlope = p1.z - p0.z;
                bestDepthSlope = p1.w - p0.w;
            }
        }
        let dist = sqrt(bestDistSq);
        let effHalfWidth = halfWidth * bestWidthScale;
        let bankHalfWidth = effHalfWidth * 3.5;
        let normalizedDepth = (depthM * bestDepthScale) / max(maxTerrainHeightM(), 1.0);

        // Gradients: distance to the closest point; t moves along the
        // segment only when the closest point is interior.
        let distGrad = (bestD.x * gAlong + bestD.y * gAcross) / max(dist, 1e-6);
        let tGrad = select(vec3<f32>(0.0), (bestSeg.x * gAlong + bestSeg.y * gAcross) / bestSegLenSq, bestInterior);
        let effHalfWidthGrad = tGrad * (halfWidth * bestWidthSlope);
        let widthShape = dConst(1.0) - dSmoothstepDual(
            vec4<f32>(effHalfWidth, effHalfWidthGrad),
            vec4<f32>(bankHalfWidth, effHalfWidthGrad * 3.5),
            vec4<f32>(dist, distGrad)
        );
        let depthGrad = tGrad * (depthM * bestDepthSlope / max(maxTerrainHeightM(), 1.0));
        return dMul(vec4<f32>(-normalizedDepth, -depthGrad), widthShape);
    }

    let bankHalfWidth = halfWidth * 3.5;
    let widthShape = dConst(1.0) - dSmoothstep(halfWidth, bankHalfWidth, dAbs(vec4<f32>(across, gAcross)));
    let halfLen = lengthM * 0.5;
    let lengthShape = dConst(1.0) - dSmoothstep(halfLen * 0.85, halfLen, dAbs(vec4<f32>(along, gAlong)));
    let shape = dMul(widthShape, dClamp(lengthShape, 0.0, 1.0));
    let normalizedDepth = depthM / max(maxTerrainHeightM(), 1.0);
    return shape * (-normalizedDepth);
}
`;
}
