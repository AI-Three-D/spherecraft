// core/renderer/lakes/lakeWaterSystem.js
//
// Renders water for the confirmed erosion-seed lakes (see
// core/world/hydrology/ErosionSeedVerifier.js) — several small, sparse,
// irregularly-shaped patches, structurally different from RiverSystem's
// single flowing channel: N independent static meshes instead of one
// continuously-simulated grid tied to a single fixed anchor.
//
// First increment (mid/far tier only, from the 3-tier plan): every
// confirmed lake gets a static blob-shaped water mesh, matching the
// terrain carve's own outline (erosionBlobRadiusAt — same shared geometry
// featureErosionSeeds.wgsl.js uses), with a cheap per-frame ripple whose
// strength fades to 0 with camera distance — a far lake ends up reading as
// a flat textured plane without needing a second shader/material.
//
// Deliberately NOT reusing RiverBedBake/the shallow-water sim here: that
// pipeline is a continuous per-frame cost (confirmed via investigation —
// 6 full-grid compute passes/frame for a single 128x128 grid, running
// unconditionally whenever the river is 'ready', not throttled by distance
// or visibility). Running that per lake, or even for several at once,
// would be a real added cost for no benefit to the lakes sitting far from
// the camera. A genuinely simulated near-field tier — reusing that same
// bed-bake+sim machinery for whichever single lake is currently closest to
// the camera, swapped in/out as the player moves — is a separate, later
// increment once this static tier is confirmed to look right.
//
// Checkpoint 2 (see CODEX_RIVER_LAKE_HANDOFF.md): each lake now also runs a
// pending/residency/retry lifecycle (modeled on RiverSystem's) that samples
// the resident final height texture (LakeHeightProbe — same hash-table walk
// RiverBedBake uses, bilinearly sampled) at the center and the planned
// water outline, and derives a real water level as (lowest resident rim
// sample) - epsilon. USE_DEBUG_LAKE_PLACEHOLDER gates whether that real
// result actually drives what's rendered — it stays true (preserving the
// existing 2000m-float / magenta / oversized-disc debug behavior) until a
// reviewer authorizes flipping it, per the handoff's checkpoint sequencing.
// The real computation and its invariant checks run and are reportable
// (getDebugPlacementReport()) regardless of the flag.

import { Vector3 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';
import { computeSurfaceTangentFrame } from '../../planet/surfaceFrame.js';
import { erosionBlobRadiusAt } from '../../world/hydrology/erosionSeedShared.js';
import { Geometry } from '../resources/geometry.js';
import { LakeWaterMaterialBuilder } from './lakeWaterMaterialBuilder.js';
import { LakeHeightProbe } from './lakeHeightProbe.js';

export const BLOB_SEGMENTS = 28;
// Water fills inside the carved rim, not out to its very (tapering) edge —
// avoids the visible mismatch of a flat water plane poking out past where
// the terrain has actually finished sloping back up to the natural rim.
export const FILL_FRACTION = 0.82;
// Water surface sits this far below the natural (pre-carve) elevation, as
// a fraction of the pit's own full carve depth — keeps it visibly "in" the
// bowl rather than floating right at the rim's edge.
const RIM_MARGIN_FRACTION = 0.22;
// Ripple strength is 1.0 inside RIPPLE_NEAR_M, fades linearly to 0.0 by
// RIPPLE_FAR_M — the mid/far tiering from the 3-tier plan, expressed as a
// continuous fade within one shader rather than two separate materials.
const RIPPLE_NEAR_M = 120;
const RIPPLE_FAR_M = 500;
const RIPPLE_FREQ = 0.35;

// TEMP DEBUG VISIBILITY: makes confirmed lakes impossible to miss while
// confirming the water system actually renders — float well above the
// ground (removes any dependency on the water-height calc being exactly
// right) and a much bigger disc. Revert (both here and the material's
// forced bright color below) once confirmed visually.
const DEBUG_FLOAT_HEIGHT_M = 300;
const DEBUG_RADIUS_MULTIPLIER = 2.5;

// Explicit temporary override (checkpoint 2 of CODEX_RIVER_LAKE_HANDOFF.md):
// true keeps every lake rendered exactly as before (2000m float, magenta
// tint via render()'s own hardcoded waterTint, DEBUG_RADIUS_MULTIPLIER)
// regardless of what the resident-height pipeline below computes, so the
// real calculation can be built and proven numerically without changing
// anything visible yet. Flip only after a reviewer has seen
// getDebugPlacementReport()'s numbers and explicitly authorizes it — this
// is checkpoint 3's job, done together with removing the debug scaffolding
// entirely, not before.
const USE_DEBUG_LAKE_PLACEHOLDER = true;

// Same depth-adequacy bar RiverBedBake uses (see riverBedBakeShader.wgsl.js)
// to decide a resident match is deep/precise enough to stop retrying for.
const MIN_DEPTH_BELOW_MAX = 3;
// Bounded retry budget per lake, mirroring RiverSystem's config.bake.maxRetries.
const MAX_RESIDENT_RETRIES = 40;
const RESIDENT_RETRY_DELAY_S = 0.25;
// Small, documented margin the water level sits below the lowest resident
// rim sample (the "spillway ceiling") — clears bilinear/micro-detail noise
// between adjacent rim texels without eating meaningfully into a lake's
// depth (rim spans observed in practice are tens of meters).
const WATER_LEVEL_EPSILON_M = 0.5;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

export class LakeWaterSystem {
    constructor({ backend, planetConfig, uniformManager, device, quadtreeGPU, tileStreamer, quadtreeTileManager }) {
        this.backend = backend;
        this.planetConfig = planetConfig;
        this.uniformManager = uniformManager;
        this.device = device || null;
        this.quadtreeGPU = quadtreeGPU || null;
        this.tileStreamer = tileStreamer || null;
        this.quadtreeTileManager = quadtreeTileManager || null;
        this._lakes = [];
        this._time = 0;

        this._probe = null;
        this._probeBusy = false;
        this._probeCompilationFailed = false;
        this._probeCompilationMessages = null;
    }

    /**
     * @param {Array} confirmedLakes - ErosionSeedVerifier's confirmed list:
     *   {regionX, regionY, radiusScale, depthScale, pos, naturalElevationNorm,
     *    nudgeRadiusM, nudgeDepthM, blobPhase1, blobAmp1, blobPhase2, blobAmp2}
     */
    setLakes(confirmedLakes) {
        this._disposeLakes();
        const origin = this.planetConfig?.origin;
        const R = this.planetConfig?.radius;
        const maxTerrainHeightM = Math.max(this.planetConfig?.maxTerrainHeight ?? 2000, 1);
        if (!origin || !Number.isFinite(R) || !Array.isArray(confirmedLakes)) return;
        const originV = new Vector3(origin.x, origin.y, origin.z);

        for (const lake of confirmedLakes) {
            if (!lake?.pos) continue;
            const posV = new Vector3(lake.pos.x, lake.pos.y, lake.pos.z);
            const unitDir = new Vector3().subVectors(posV, originV).normalize();
            const frame = computeSurfaceTangentFrame(posV, originV);

            const totalDepthM = lake.nudgeDepthM * lake.depthScale;
            // TEMP DIAGNOSTIC: bypass the natural-elevation calc entirely and
            // use a flat, enormous height (planet radius + 2000m) — decisive
            // test for whether the bug is in the elevation math specifically,
            // or something more fundamental in the coordinate/transform.
            const waterHeightM = 2000;
            void RIM_MARGIN_FRACTION; void totalDepthM; void maxTerrainHeightM;
            const debugCenter = originV.clone().add(unitDir.clone().multiplyScalar(R + waterHeightM));

            const geometry = this._buildBlobGeometry(lake, DEBUG_RADIUS_MULTIPLIER);
            const material = LakeWaterMaterialBuilder.create();

            // Resident-height query points: center + the same 29-vertex ring
            // the blob mesh uses, at the real intended radius (FILL_FRACTION
            // only — deliberately excluding DEBUG_RADIUS_MULTIPLIER, per the
            // handoff's non-negotiable contract) computed once here and
            // reused across every retry attempt.
            const queryWorldPositions = [posV.clone()];
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
            // Prewarm every queried position individually, not just the
            // center — a rim point can land in a different tile than the
            // center (prewarmWorldPosition()'s own neighbor margin at max
            // depth is only ±1 tile). Each call is cheap: already-resident
            // tiles are skipped.
            for (const q of queryWorldPositions) {
                this.quadtreeTileManager?.prewarmWorldPosition?.(q);
            }

            this._lakes.push({
                regionX: lake.regionX, regionY: lake.regionY,
                naturalElevationNorm: lake.naturalElevationNorm,
                posV, originV, frame,
                geometry, material,
                center: debugCenter, up: frame.up, right: frame.right, forward: frame.forward,
                queryWorldPositions, plannedRadiusM,
                _resident: { state: 'pending', secondsSincePending: 0, retryCount: 0, result: null, error: null },
            });
        }
    }

    _buildBlobGeometry(lake, radiusMultiplier) {
        const positions = new Float32Array((BLOB_SEGMENTS + 2) * 3);
        positions[0] = 0; positions[1] = 0; positions[2] = 0; // center
        for (let i = 0; i <= BLOB_SEGMENTS; i++) {
            const angle = (i / BLOB_SEGMENTS) * Math.PI * 2;
            const r = erosionBlobRadiusAt(lake, angle, lake.radiusScale) * FILL_FRACTION * radiusMultiplier;
            const idx = (i + 1) * 3;
            positions[idx] = Math.cos(angle) * r;
            positions[idx + 1] = Math.sin(angle) * r;
            positions[idx + 2] = 0;
        }
        const indices = new Uint32Array(BLOB_SEGMENTS * 3);
        for (let i = 0; i < BLOB_SEGMENTS; i++) {
            indices[i * 3] = 0;
            indices[i * 3 + 1] = i + 1;
            indices[i * 3 + 2] = i + 2;
        }
        const geometry = new Geometry();
        geometry.setAttribute('position', positions, 3);
        geometry.setIndex(indices);
        return geometry;
    }

    _heightScale() {
        return Number.isFinite(this.planetConfig?.heightScale) ? this.planetConfig.heightScale : 2000;
    }

    // ---- resident-height pending/retry lifecycle (checkpoint 2) ---------

    _ensureProbe() {
        if (this._probe || this._probeCompilationFailed) return;
        if (!this.device || !this.tileStreamer) return;
        const probe = new LakeHeightProbe(this.device, { maxQueries: BLOB_SEGMENTS + 2 });
        probe.initialize({ tileStreamer: this.tileStreamer });
        this._probe = probe;
        // WebGPU shader/pipeline creation errors are async and silent (see
        // RIVER_WALKING_SKELETON_LOG.md gotcha #2) — check explicitly so a
        // broken shader fails clearly instead of every lake just looking
        // like a residency timeout forever.
        probe.getShaderCompilationInfo().then((info) => {
            this._probeCompilationMessages = info.messages;
            if (info.hasErrors) {
                this._probeCompilationFailed = true;
                Logger.error(`[LakeWaterSystem] resident-height probe shader failed to compile: ${JSON.stringify(info.messages)}`);
            }
        });
    }

    _updateResidentPlacement(lake, dt) {
        const r = lake._resident;
        if (r.state !== 'pending') return;
        if (this._probeCompilationFailed) {
            r.state = 'failed';
            r.error = 'resident-height probe shader failed to compile';
            return;
        }
        if (!this._probe || this._probeBusy) return;
        r.secondsSincePending += Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
        if (r.secondsSincePending < RESIDENT_RETRY_DELAY_S) return;
        this._dispatchResidentQuery(lake);
    }

    _dispatchResidentQuery(lake) {
        const r = lake._resident;
        this._probeBusy = true;
        r.state = 'baking';
        const encoder = this.device.createCommandEncoder({ label: 'LakeWaterSystem-Probe-Dispatch' });
        const ok = this._probe.dispatch(encoder, {
            queryWorldPositions: lake.queryWorldPositions,
            origin: this.planetConfig.origin,
            heightScale: this._heightScale(),
            quadtreeGPU: this.quadtreeGPU,
            tileStreamer: this.tileStreamer,
        });
        if (!ok) {
            this._probeBusy = false;
            r.retryCount++;
            if (r.retryCount > MAX_RESIDENT_RETRIES) {
                r.state = 'failed';
                r.error = 'tile/hash table never became resident within retry budget';
                Logger.warn(`[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}): ${r.error}`);
                return;
            }
            r.state = 'pending';
            r.secondsSincePending = 0;
            return;
        }
        this.device.queue.submit([encoder.finish()]);
        this._probe.resolve().then((results) => {
            this._probeBusy = false;
            this._onResidentQueryResolved(lake, results);
        });
    }

    _onResidentQueryResolved(lake, results) {
        const r = lake._resident;
        if (!results) {
            r.retryCount++;
            if (r.retryCount > MAX_RESIDENT_RETRIES) {
                r.state = 'failed';
                r.error = 'probe resolve failed repeatedly';
                Logger.warn(`[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}): ${r.error}`);
                return;
            }
            r.state = 'pending';
            r.secondsSincePending = 0;
            return;
        }

        const maxDepth = this.quadtreeGPU?.maxDepth ?? 12;
        const isAdequate = (rec) => rec.found && rec.depth != null && (rec.depth + MIN_DEPTH_BELOW_MAX >= maxDepth);
        const allAdequate = results.every(isAdequate);
        if (!allAdequate) {
            r.retryCount++;
            if (r.retryCount <= MAX_RESIDENT_RETRIES) {
                r.state = 'pending';
                r.secondsSincePending = 0;
                return;
            }
            Logger.warn(
                `[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}): gave up waiting for full ` +
                `resident depth after ${r.retryCount} retries — proceeding with best-available (possibly ` +
                `coarse) data. Depths found: ${results.map((x) => (x.found ? x.depth : 'miss')).join(',')} ` +
                `(maxDepth=${maxDepth}, need >= ${maxDepth - MIN_DEPTH_BELOW_MAX})`
            );
            // fall through: proceed with whatever resolved, same as
            // RiverBedBake's own "proceed with partial precision" fallback.
        }

        const center = results[0];
        const rim = results.slice(1);
        const foundRim = rim.filter((x) => x.found);
        if (!center.found || foundRim.length === 0) {
            r.state = 'rejected';
            r.error = 'no resident height data resolved at center or anywhere on the rim';
            Logger.warn(`[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}): ${r.error}`);
            return;
        }

        // Spillway-derived water level: lowest resident rim sample, minus a
        // small epsilon. This is the physical invariant for a lake — it's
        // stronger than reconstructing an alleged pre-carve elevation (see
        // CODEX_RIVER_LAKE_HANDOFF.md's "minimal robust implementation
        // shape", step 4). "Interior" here is the single center sample —
        // this increment only queries center + rim (per the handoff's own
        // step 3), not a separate interior ring.
        const lowestRimM = Math.min(...foundRim.map((x) => x.bilinearHeightM));
        const waterLevelM = lowestRimM - WATER_LEVEL_EPSILON_M;
        const centerIsBelow = center.bilinearHeightM < waterLevelM;
        if (!centerIsBelow) {
            r.state = 'rejected';
            r.error =
                `center (${center.bilinearHeightM.toFixed(2)}m) is not below the spillway-derived water level ` +
                `(${waterLevelM.toFixed(2)}m, from lowest rim ${lowestRimM.toFixed(2)}m) — real resident data ` +
                `does not confirm this candidate as a basin; no fabricated water height is produced`;
            Logger.warn(`[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}): ${r.error}`);
            return;
        }

        r.state = 'ready';
        r.result = {
            waterLevelM,
            waterLevelNorm: waterLevelM / this._heightScale(),
            centerHeightM: center.bilinearHeightM,
            lowestRimM,
            rimFoundCount: foundRim.length,
            rimTotal: rim.length,
            depthAdequate: allAdequate,
            depthsFound: results.map((x) => (x.found ? x.depth : null)),
            maxDepth,
            residentTileIdentity: { face: center.face, depth: center.depth, tileX: center.tileX, tileY: center.tileY, layer: center.layer },
        };
        Logger.info(
            `[LakeWaterSystem] lake region (${lake.regionX},${lake.regionY}) resident placement ready: ` +
            `waterLevel=${waterLevelM.toFixed(2)}m center=${center.bilinearHeightM.toFixed(2)}m ` +
            `lowestRim=${lowestRimM.toFixed(2)}m depthAdequate=${allAdequate} ` +
            `rim=${foundRim.length}/${rim.length}`
        );

        if (!USE_DEBUG_LAKE_PLACEHOLDER) {
            const unitDir = new Vector3().subVectors(lake.posV, lake.originV).normalize();
            const R = this.planetConfig?.radius;
            lake.center = lake.originV.clone().add(unitDir.multiplyScalar(R + waterLevelM));
            lake.geometry?.dispose?.();
            lake.geometry = this._buildBlobGeometry(lake, 1.0);
        }
    }

    /**
     * Checkpoint-2 numeric proof (see CODEX_RIVER_LAKE_HANDOFF.md): the
     * pending/residency/retry state and derived water level for every lake,
     * sourced from the real setLakes()/update() pipeline — not a side
     * diagnostic. window.lakeReport() in standalone.html.
     */
    getDebugPlacementReport() {
        return {
            usingDebugPlaceholder: USE_DEBUG_LAKE_PLACEHOLDER,
            probeCompilation: {
                checked: !!this._probe,
                hasErrors: this._probeCompilationFailed,
                messages: this._probeCompilationMessages,
            },
            lakes: this._lakes.map((lake) => ({
                regionX: lake.regionX, regionY: lake.regionY,
                naturalElevationNorm: lake.naturalElevationNorm,
                state: lake._resident.state,
                retryCount: lake._resident.retryCount,
                error: lake._resident.error,
                result: lake._resident.result,
                renderedCenter: { x: lake.center.x, y: lake.center.y, z: lake.center.z },
            })),
        };
    }

    update(deltaTime) {
        this._time += Number.isFinite(deltaTime) ? Math.min(deltaTime, 0.1) : 0;
        this._ensureProbe();
        for (const lake of this._lakes) {
            this._updateResidentPlacement(lake, deltaTime);
        }
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!window.__lakeRenderCallCount) window.__lakeRenderCallCount = 0;
        window.__lakeRenderCallCount++;
        if (!this._lakes.length || !camera || !this.backend) {
            if (!window.__lakeRenderSkipLogged) {
                window.__lakeRenderSkipLogged = true;
                console.warn('[LakeWaterSystem DIAG] render() early-return', {
                    lakeCount: this._lakes.length, hasCamera: !!camera, hasBackend: !!this.backend,
                });
            }
            return;
        }
        const camPos = camera.position || {};

        for (const lake of this._lakes) {
            const dx = (camPos.x ?? 0) - lake.center.x;
            const dy = (camPos.y ?? 0) - lake.center.y;
            const dz = (camPos.z ?? 0) - lake.center.z;
            const dist = Math.hypot(dx, dy, dz);
            const rippleStrength = 1.0 - clamp01((dist - RIPPLE_NEAR_M) / Math.max(RIPPLE_FAR_M - RIPPLE_NEAR_M, 1));

            LakeWaterMaterialBuilder.updateUniformBuffers(lake.material, {
                viewMatrix, projectionMatrix,
                center: lake.center, right: lake.right, forward: lake.forward, up: lake.up,
                time: this._time, rippleStrength, rippleFreq: RIPPLE_FREQ,
                cameraPosition: camPos,
                uniformManager: this.uniformManager,
                // TEMP DEBUG VISIBILITY: hot magenta, ignores lighting/fog
                // dimming — see lakeWaterShader.wgsl.js's fragment shader.
                waterTint: [3.0, 0.0, 3.0],
                clarity: 1.0,
            });
            try {
                this.backend.draw(lake.geometry, lake.material);
                if (!window.__lakeDrawOkLogged) {
                    window.__lakeDrawOkLogged = true;
                    console.warn('[LakeWaterSystem DIAG] draw() succeeded, no exception', {
                        callCount: window.__lakeRenderCallCount, center: lake.center, dist,
                    });
                }
            } catch (e) {
                if (!window.__lakeDrawErrLogged) {
                    window.__lakeDrawErrLogged = true;
                    console.error('[LakeWaterSystem DIAG] draw() threw', e?.message || e, e?.stack);
                }
            }
        }
    }

    _disposeLakes() {
        for (const lake of this._lakes) {
            lake.geometry?.dispose?.();
            lake.material?.dispose?.();
        }
        this._lakes = [];
    }

    dispose() {
        this._disposeLakes();
        this._probe?.dispose?.();
        this._probe = null;
    }
}
