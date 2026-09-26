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

import { Vector3 } from '../../../shared/math/index.js';
import { computeSurfaceTangentFrame } from '../../planet/surfaceFrame.js';
import { erosionBlobRadiusAt } from '../../world/hydrology/erosionSeedShared.js';
import { Geometry } from '../resources/geometry.js';
import { LakeWaterMaterialBuilder } from './lakeWaterMaterialBuilder.js';

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

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

export class LakeWaterSystem {
    constructor({ backend, planetConfig, uniformManager }) {
        this.backend = backend;
        this.planetConfig = planetConfig;
        this.uniformManager = uniformManager;
        this._lakes = [];
        this._time = 0;
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
            const center = originV.clone().add(unitDir.clone().multiplyScalar(R + waterHeightM));

            const geometry = this._buildBlobGeometry(lake);
            const material = LakeWaterMaterialBuilder.create();
            this._lakes.push({ geometry, material, center, up: frame.up, right: frame.right, forward: frame.forward });
        }
    }

    _buildBlobGeometry(lake) {
        const positions = new Float32Array((BLOB_SEGMENTS + 2) * 3);
        positions[0] = 0; positions[1] = 0; positions[2] = 0; // center
        for (let i = 0; i <= BLOB_SEGMENTS; i++) {
            const angle = (i / BLOB_SEGMENTS) * Math.PI * 2;
            const r = erosionBlobRadiusAt(lake, angle, lake.radiusScale) * FILL_FRACTION * DEBUG_RADIUS_MULTIPLIER;
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

    update(deltaTime) {
        this._time += Number.isFinite(deltaTime) ? Math.min(deltaTime, 0.1) : 0;
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
    }
}
