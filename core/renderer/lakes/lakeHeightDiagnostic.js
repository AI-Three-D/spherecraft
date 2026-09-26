// core/renderer/lakes/lakeHeightDiagnostic.js
//
// Checkpoint-1 diagnostic (see CODEX_RIVER_LAKE_HANDOFF.md): for one
// confirmed lake, samples the resident final height texture (via
// LakeHeightProbe, which reuses RiverBedBake's hash-table walk) at the
// lake's center and around its planned water outline, and reports those
// values alongside the old standalone naturalElevationNorm probe so the two
// can be compared before any water-level or shoreline logic changes.
//
// Read-only: does not touch LakeWaterSystem's rendering state. Exposed as
// window.lakeHeightDiag() in wizard_game/standalone.html.

import { Vector3 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';
import { computeSurfaceTangentFrame } from '../../planet/surfaceFrame.js';
import { erosionBlobRadiusAt } from '../../world/hydrology/erosionSeedShared.js';
import { LakeHeightProbe } from './lakeHeightProbe.js';
import { FILL_FRACTION, BLOB_SEGMENTS } from './lakeWaterSystem.js';

/**
 * @returns {Promise<object>} diagnostic report, or {error} if it couldn't run.
 */
export async function runLakeHeightDiagnostic({
    device, quadtreeGPU, tileStreamer, quadtreeTileManager,
    planetConfig, confirmedLakes, lakeIndex = 0,
    maxAttempts = 40, retryDelayMs = 250,
}) {
    const lake = Array.isArray(confirmedLakes) ? confirmedLakes[lakeIndex] : null;
    if (!lake?.pos) {
        return { error: `no confirmed lake at index ${lakeIndex} (confirmedLakes.length=${confirmedLakes?.length ?? 0})` };
    }
    const origin = planetConfig?.origin;
    if (!origin || !device) {
        return { error: 'missing origin/device' };
    }

    // Same normalization ErosionSeedVerifier used for naturalElevationNorm —
    // kept separate from heightScale (used below for the resident sample)
    // so a scale mismatch between the two shows up in the report instead of
    // being silently absorbed into one shared constant.
    const maxTerrainHeightM = Math.max(planetConfig?.maxTerrainHeight ?? 2000, 1);
    const heightScale = Number.isFinite(planetConfig?.heightScale) ? planetConfig.heightScale : 2000;

    const originV = new Vector3(origin.x, origin.y, origin.z);
    const posV = new Vector3(lake.pos.x, lake.pos.y, lake.pos.z);
    const frame = computeSurfaceTangentFrame(posV, originV);

    // Query points: lake center + the same 29-vertex ring LakeWaterSystem's
    // own blob mesh uses (BLOB_SEGMENTS+1, first/last coincide at angle 0),
    // at the real intended water radius — FILL_FRACTION only, deliberately
    // excluding DEBUG_RADIUS_MULTIPLIER (the oversized debug disc), per the
    // handoff's non-negotiable contract.
    const queryWorldPositions = [posV];
    const plannedRadiusM = [null];
    for (let i = 0; i <= BLOB_SEGMENTS; i++) {
        const angle = (i / BLOB_SEGMENTS) * Math.PI * 2;
        const r = erosionBlobRadiusAt(lake, angle, lake.radiusScale) * FILL_FRACTION;
        plannedRadiusM.push(r);
        queryWorldPositions.push(
            posV.clone()
                .add(frame.right.clone().multiplyScalar(Math.cos(angle) * r))
                .add(frame.forward.clone().multiplyScalar(Math.sin(angle) * r))
        );
    }

    // Prewarm every queried position individually, not just the center.
    // prewarmWorldPosition()'s own neighbor-radius margin at max depth is
    // only ±1 tile around whichever point it's given (see
    // GPUQuadtreeTerrain.js's _queueDepthRangeAtFaceUV), and a rim point can
    // legitimately land in a different tile than the center (a depth-11
    // tile is ~128m on this planet's config, comparable to the ~80-90m rim
    // radius) — relying on the center's prewarm alone doesn't guarantee
    // coverage. Each call is cheap: already-resident tiles are skipped.
    for (const q of queryWorldPositions) {
        quadtreeTileManager?.prewarmWorldPosition?.(q);
    }

    const probe = new LakeHeightProbe(device, { maxQueries: queryWorldPositions.length });
    probe.initialize({ tileStreamer });

    // WebGPU shader/pipeline creation errors are async and silent (see
    // RIVER_WALKING_SKELETON_LOG.md gotcha #2) — a broken shader would
    // otherwise just look like "never became resident" below. Check and
    // fail explicitly first.
    const compilation = await probe.getShaderCompilationInfo();
    if (compilation.hasErrors) {
        probe.dispose();
        Logger.error(`[LakeHeightProbe] shader compilation failed: ${JSON.stringify(compilation.messages)}`);
        return { error: 'lake height probe shader failed to compile', compilationMessages: compilation.messages };
    }

    // Same depth-adequacy bar RiverBedBake uses to decide whether a match is
    // "deep enough to stop retrying for" (MIN_DEPTH_BELOW_MAX, see
    // riverBedBakeShader.wgsl.js) — applied here to the center AND every rim
    // sample, not just "did any dispatch succeed at all". A dispatch can
    // succeed while still resolving through a coarse ancestor tile (real,
    // but not what's visibly rendered at fine LOD), so accepting the first
    // successful dispatch without this check risks comparing the old probe
    // against a coarse fallback instead of the fine-LOD terrain.
    const MIN_DEPTH_BELOW_MAX = 3;
    const maxDepth = quadtreeGPU?.maxDepth ?? 12;
    const isAdequate = (rec) => rec.found && rec.depth != null && (rec.depth + MIN_DEPTH_BELOW_MAX >= maxDepth);

    let results = null;
    let lastResults = null;
    let depthAdequate = false;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptsUsed = attempt + 1;
        const encoder = device.createCommandEncoder({ label: 'LakeHeightProbe-Diag-Dispatch' });
        const ok = probe.dispatch(encoder, { queryWorldPositions, origin, heightScale, quadtreeGPU, tileStreamer });
        if (!ok) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
        }
        device.queue.submit([encoder.finish()]);
        const r = await probe.resolve();
        if (!r) {
            await new Promise((r2) => setTimeout(r2, retryDelayMs));
            continue;
        }
        lastResults = r;
        if (r.every(isAdequate)) {
            results = r;
            depthAdequate = true;
            break;
        }
        // Not deep enough yet at every sample — residency is likely still
        // streaming in finer tiles for at least one query point. Retry
        // rather than accepting a coarse-ancestor result.
        await new Promise((r2) => setTimeout(r2, retryDelayMs));
    }
    probe.dispose();

    if (!lastResults) {
        return {
            error: 'lake tile never became resident (height texture / hash table not ready) within retry budget',
            attemptsUsed, maxAttempts,
        };
    }
    if (!results) {
        // Budget exhausted without every sample reaching full depth — report
        // the best available result (mirrors RiverBedBake's own "proceed
        // with partial precision" fallback) but flag it clearly rather than
        // silently presenting a coarse sample as the final answer.
        Logger.warn(
            `[LakeHeightProbe] lake ${lakeIndex}: gave up waiting for full depth after ${attemptsUsed}/${maxAttempts} ` +
            `attempts — reporting best-available (possibly coarse) result. Depths found: ` +
            `${lastResults.map((r) => (r.found ? r.depth : 'miss')).join(',')} (maxDepth=${maxDepth}, ` +
            `need >= ${maxDepth - MIN_DEPTH_BELOW_MAX})`
        );
        results = lastResults;
    }

    const center = results[0];
    const rim = results.slice(1).map((r, i) => ({
        ...r,
        angle: (i / BLOB_SEGMENTS) * Math.PI * 2,
        plannedRadiusM: plannedRadiusM[i + 1],
    }));

    const oldNaturalElevationNorm = lake.naturalElevationNorm;
    const oldNaturalElevationM = Number.isFinite(oldNaturalElevationNorm)
        ? oldNaturalElevationNorm * maxTerrainHeightM : null;

    const foundRim = rim.filter((r) => r.found);
    const centerBelowLowestRim = (center.found && foundRim.length > 0)
        ? (() => {
            const lowestRimM = Math.min(...foundRim.map((r) => r.bilinearHeightM));
            return { lowestRimM, centerM: center.bilinearHeightM, centerIsBelow: center.bilinearHeightM < lowestRimM };
        })()
        : null;

    const report = {
        lakeIndex,
        regionId: { regionX: lake.regionX, regionY: lake.regionY },
        worldPos: lake.pos,
        attemptsUsed,
        maxAttempts,
        compilationMessages: compilation.messages,
        depthAdequate,
        maxDepth,
        minDepthRequired: maxDepth - MIN_DEPTH_BELOW_MAX,
        depthsFound: results.map((r) => (r.found ? r.depth : null)),
        // Face/depth/tile/layer uniquely identifies which resident tile
        // backed the center sample — the closest available stand-in for
        // "visible terrain-instance identity" without adding new coupling
        // to the standalone-only qtDiag/instance-pick debug harness; cross
        // -check against window.qtDiag.pickTerrainAtCenter() manually if
        // needed.
        residentTileIdentity: center.found
            ? { face: center.face, depth: center.depth, tileX: center.tileX, tileY: center.tileY, layer: center.layer }
            : null,
        center,
        rim,
        rimNotFoundCount: rim.length - foundRim.length,
        oldNaturalElevationNorm,
        oldNaturalElevationM,
        residentCenterHeightNorm: center.bilinearHeightNorm,
        residentCenterHeightM: center.bilinearHeightM,
        diffM: (Number.isFinite(oldNaturalElevationM) && center.found)
            ? center.bilinearHeightM - oldNaturalElevationM : null,
        normalizationNote:
            'oldNaturalElevationNorm is normalized by planetConfig.maxTerrainHeight (ErosionSeedVerifier\'s ' +
            'convention); residentCenterHeightNorm is scaled to meters by planetConfig.heightScale ' +
            '(RiverBedBake/terrain-renderer\'s convention). Reported separately, not assumed equal.',
        maxTerrainHeightM,
        heightScaleUsed: heightScale,
        centerBelowLowestRim,
    };

    Logger.info(
        `[LakeHeightProbe] lake ${lakeIndex} (region ${lake.regionX},${lake.regionY}): ` +
        `resident center height ${center.found ? center.bilinearHeightM.toFixed(2) + 'm' : 'NOT FOUND'} ` +
        `(norm ${center.found ? center.bilinearHeightNorm.toFixed(5) : 'n/a'}, depth ${center.depth}/${maxDepth}) ` +
        `vs old naturalElevationNorm ${Number.isFinite(oldNaturalElevationNorm) ? oldNaturalElevationNorm.toFixed(5) : 'n/a'} ` +
        `(${Number.isFinite(oldNaturalElevationM) ? oldNaturalElevationM.toFixed(2) + 'm' : 'n/a'}) — ` +
        `diff ${Number.isFinite(report.diffM) ? report.diffM.toFixed(2) + 'm' : 'n/a'}; ` +
        `rim: ${foundRim.length}/${rim.length} resolved; depthAdequate=${depthAdequate} (attempts=${attemptsUsed}/${maxAttempts})`
    );

    return report;
}
