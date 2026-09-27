// core/renderer/lakes/lakeWaterSystem.js
//
// Renders water for the confirmed erosion-seed lakes (see
// core/world/hydrology/ErosionSeedVerifier.js) — several small, sparse,
// irregularly-shaped patches, structurally different from RiverSystem's
// single flowing channel: N independent static meshes instead of one
// continuously-simulated grid tied to a single fixed anchor.
//
// First increment (mid/far tier only, from the 3-tier plan): every
// confirmed lake gets a static blob-shaped water mesh, with a cheap
// per-frame ripple whose strength fades to 0 with camera distance — a far
// lake ends up reading as a flat textured plane without needing a second
// shader/material. erosionBlobRadiusAt (the terrain carve's own outline
// function, shared with featureErosionSeeds.wgsl.js) gives each vertex's
// nominal/upper-bound radius; the actual per-vertex radius is inset from
// that to wherever real resident terrain crosses the water level (see
// _onResidentQueryResolved), so the visible shoreline follows the real
// basin shape instead of a uniform circle.
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
// Water placement (see CODEX_RIVER_LAKE_HANDOFF.md): each lake runs a
// pending/residency/retry lifecycle (modeled on RiverSystem's) that samples
// the resident final height texture (LakeHeightProbe — same hash-table walk
// RiverBedBake uses, bilinearly sampled, per the terrain renderer's own
// chunk-local convention) at the center and the planned water outline, and
// derives the water level as (lowest resident rim sample) - a small
// epsilon. A lake is only added to the render list once that real placement
// resolves and confirms the center sits below that level; a candidate that
// doesn't clear this against real resident data is rejected rather than
// rendered at a fabricated height. The mesh's own per-vertex radius is then
// separately inset to where each sampled ray actually crosses that water
// level, so relief that varies around the rim doesn't leave most of the
// disc buried under higher ground on one side.

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
// Ripple strength is 1.0 inside RIPPLE_NEAR_M, fades linearly to 0.0 by
// RIPPLE_FAR_M — the mid/far tiering from the 3-tier plan, expressed as a
// continuous fade within one shader rather than two separate materials.
const RIPPLE_NEAR_M = 120;
const RIPPLE_FAR_M = 500;
const RIPPLE_FREQ = 0.35;

// Same depth-adequacy bar RiverBedBake uses (see riverBedBakeShader.wgsl.js)
// to decide a resident match is deep/precise enough to stop retrying for.
const MIN_DEPTH_BELOW_MAX = 3;
// Bounded retry budget per lake, mirroring RiverSystem's config.bake.maxRetries.
const MAX_RESIDENT_RETRIES = 40;
const RESIDENT_RETRY_DELAY_S = 0.25;
// Small, documented margin the water level sits below the lowest resident
// rim sample (the "spillway ceiling") — clears bilinear/micro-detail noise
// between adjacent rim texels without eating meaningfully into a lake's
// depth (measured basin depth at real scale is on the order of 1-3m).
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
        if (!origin || !Number.isFinite(R) || !Array.isArray(confirmedLakes)) return;
        const originV = new Vector3(origin.x, origin.y, origin.z);

        for (const lake of confirmedLakes) {
            if (!lake?.pos) continue;
            const posV = new Vector3(lake.pos.x, lake.pos.y, lake.pos.z);
            const frame = computeSurfaceTangentFrame(posV, originV);
            const material = LakeWaterMaterialBuilder.create();

            // Resident-height query points: center + a 29-vertex ring
            // (BLOB_SEGMENTS+1, first/last coincide at angle 0 — same count
            // the blob mesh below uses) at the real intended water radius,
            // computed once here and reused across every retry attempt.
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
                geometry: null, material,
                center: null, up: frame.up, right: frame.right, forward: frame.forward,
                queryWorldPositions, plannedRadiusM,
                _resident: { state: 'pending', secondsSincePending: 0, retryCount: 0, result: null, error: null },
            });
        }
    }

    _buildBlobGeometry(lake) {
        const positions = new Float32Array((BLOB_SEGMENTS + 2) * 3);
        positions[0] = 0; positions[1] = 0; positions[2] = 0; // center
        for (let i = 0; i <= BLOB_SEGMENTS; i++) {
            const angle = (i / BLOB_SEGMENTS) * Math.PI * 2;
            const r = lake.shorelineRadiusM[i];
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

    // ---- resident-height pending/retry lifecycle -------------------------

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

        const unitDir = new Vector3().subVectors(lake.posV, lake.originV).normalize();
        const R = this.planetConfig?.radius;
        lake.center = lake.originV.clone().add(unitDir.multiplyScalar(R + waterLevelM));

        // Per-vertex shoreline radius, inset from the nominal outline
        // (lake.plannedRadiusM) to where the REAL sampled terrain actually
        // crosses the water level along that ray, not a uniform circle. A
        // flat disc sized to the full nominal radius would sit buried under
        // terrain almost everywhere except right at the single lowest
        // (spillway) direction, since relief varies meaningfully around the
        // rim now — this follows the actual per-direction waterline instead
        // (the "sampled-inset" approach from CODEX_RIVER_LAKE_HANDOFF.md's
        // minimal robust implementation shape, step 5).
        const centerH = center.bilinearHeightM;
        lake.shorelineRadiusM = rim.map((rec, i) => {
            const nominalR = lake.plannedRadiusM[i + 1];
            let t = 1.0;
            if (rec.found && Number.isFinite(rec.bilinearHeightM)) {
                const denom = rec.bilinearHeightM - centerH;
                if (denom > 0.01) t = (waterLevelM - centerH) / denom;
            }
            // Small inward safety margin so the edge sits just inside the
            // real crossing point, not exactly on it (avoids z-fighting/
            // flicker against the terrain right at the shoreline).
            t = Math.min(1, Math.max(0.05, t)) * 0.95;
            return nominalR * t;
        });

        lake.geometry = this._buildBlobGeometry(lake);
    }

    /**
     * Numeric placement report for every lake, sourced from the real
     * setLakes()/update() pipeline — not a side diagnostic.
     * window.lakeReport() in standalone.html.
     */
    getDebugPlacementReport() {
        return {
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
                renderedCenter: lake.center ? { x: lake.center.x, y: lake.center.y, z: lake.center.z } : null,
            })),
        };
    }

    /**
     * World-space centers of every lake whose real resident placement has
     * resolved and is currently rendered — for wayfinding tools (e.g.
     * window.flyToLake() in standalone.html). Not used by rendering itself.
     */
    getReadyLakeCenters() {
        return this._lakes
            .filter((lake) => lake._resident.state === 'ready' && lake.center)
            .map((lake) => ({ regionX: lake.regionX, regionY: lake.regionY, center: { x: lake.center.x, y: lake.center.y, z: lake.center.z } }));
    }

    update(deltaTime) {
        this._time += Number.isFinite(deltaTime) ? Math.min(deltaTime, 0.1) : 0;
        this._ensureProbe();
        for (const lake of this._lakes) {
            this._updateResidentPlacement(lake, deltaTime);
        }
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._lakes.length || !camera || !this.backend) return;
        const camPos = camera.position || {};

        for (const lake of this._lakes) {
            // Not resolved (or rejected) yet — no fabricated placement is
            // rendered; the lake simply doesn't draw until real resident
            // data confirms it.
            if (!lake.geometry || !lake.center) continue;

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
                // No waterTint/clarity override — LakeWaterMaterialBuilder's
                // own defaults (a blue-teal tint, full clarity) apply.
            });
            this.backend.draw(lake.geometry, lake.material);
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
