// core/renderer/rivers/riverSystem.js
//
// Walking-skeleton river/shallow-water system: a single fixed patch, anchored
// on the planet surface, whose bed heightfield is sampled from spherecraft's
// real terrain (see riverBedBake.js) and whose flow is simulated with a port
// of whitewater's GPU shallow-water solver (see shaders/riverSimShader.wgsl.js).
//
// Scope (see the river-sim-walking-skeleton plan): one hardcoded demo patch,
// full grid simulated every frame (no scrolling window), visual only.

import { Vector3 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';
import { Geometry } from '../resources/geometry.js';
import { computeSurfaceTangentFrame } from '../../planet/surfaceFrame.js';
import { RiverBedBake } from './riverBedBake.js';
import { RiverMaterialBuilder } from './riverMaterialBuilder.js';
import { RIVER_WGSL_SIM } from './shaders/riverSimShader.wgsl.js';

const SIM_UNIFORM_BYTES = 96; // 24 x f32/u32 fields, see RiverSimUniforms

function buildGridIndices(W, L) {
    const idx = new Uint32Array((W - 1) * (L - 1) * 6);
    let qi = 0;
    for (let j = 0; j < L - 1; j++) {
        for (let i = 0; i < W - 1; i++) {
            const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
            idx[qi++] = a; idx[qi++] = c; idx[qi++] = b;
            idx[qi++] = b; idx[qi++] = c; idx[qi++] = d;
        }
    }
    return idx;
}

export class RiverSystem {
    constructor({ backend, device, quadtreeGPU, tileStreamer, planetConfig, uniformManager, riverConfig }) {
        this.backend = backend;
        this.device = device;
        this.quadtreeGPU = quadtreeGPU;
        this.tileStreamer = tileStreamer;
        this.planetConfig = planetConfig;
        this.uniformManager = uniformManager;
        this.config = riverConfig;
        this.enabled = true;

        this._initialized = false;
        this._state = 'idle'; // idle | pending | baking | ready | failed
        this._anchor = null;
        this._framesSincePending = 0;
        this._retryCount = 0;
        this._time = 0;
        this._inEta = 0;
        this._fillEta = 0;
        this._lastBakeValidCount = null;

        this._bedBake = null;
        this._sim = null;
        this._geometry = null;
        this._material = null;
    }

    async initialize() {
        const { W, L } = this.config.grid;

        this._bedBake = new RiverBedBake(this.device, { gridW: W, gridL: L });
        this._bedBake.initialize({ tileStreamer: this.tileStreamer });

        this._createSimResources();
        this._createRenderResources();

        this._initialized = true;
    }

    isReady() {
        return this._initialized && this.enabled && this._state === 'ready';
    }

    setAnchor(worldPos) {
        if (!this._initialized) return;
        const originCfg = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const origin = new Vector3(originCfg.x, originCfg.y, originCfg.z);
        const pos = worldPos instanceof Vector3
            ? worldPos.clone()
            : new Vector3(worldPos.x, worldPos.y, worldPos.z);
        const frame = computeSurfaceTangentFrame(pos, origin);

        this._anchor = { position: pos, up: frame.up, right: frame.right, forward: frame.forward };
        this._state = 'pending';
        this._framesSincePending = 0;
        this._retryCount = 0;
        Logger.info('[River] anchor set');
    }

    update(encoder, dt) {
        if (!this._initialized || !this.enabled || !this._anchor) return;
        this._time += Math.min(Math.max(dt || 0, 0), 0.1);

        if (this._state === 'pending') {
            this._framesSincePending++;
            if (this._framesSincePending >= this.config.bake.readyDelayFrames) {
                this._dispatchBake();
            }
            return;
        }

        if (this._state === 'ready') {
            this._writeSimUniforms();
            this._dispatchSimSubsteps(encoder);
        }
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this.isReady()) return;
        RiverMaterialBuilder.updateUniformBuffers(this._material, {
            viewMatrix,
            projectionMatrix,
            cameraPosition: camera?.position || null,
            uniformManager: this.uniformManager,
            anchor: this._anchor,
            grid: this.config.grid,
            time: this._time,
            hmin: this.config.sim.hmin,
            waveAmp: this.config.render?.waveAmp ?? 0.06,
            waterTint: this.config.waterTint,
            clarity: this.config.waterClarity,
        });
        this.backend.draw(this._geometry, this._material);
    }

    getDebugInfo() {
        const { W, L } = this.config.grid;
        return {
            state: this._state,
            ready: this.isReady(),
            inEta: this._state === 'ready' ? this._inEta : null,
            fillEta: this._state === 'ready' ? this._fillEta : null,
            anchor: this._anchor
                ? { x: this._anchor.position.x, y: this._anchor.position.y, z: this._anchor.position.z }
                : null,
            cellsValid: this._lastBakeValidCount,
            cellsTotal: W * L,
        };
    }

    /**
     * Synchronous bed-height inspection from the last-resolved bake (no GPU
     * round-trip — reuses the CPU-side array already returned by
     * RiverBedBake.resolve()). For console diagnostics: reports the bed
     * height + reconstructed world point at the patch's center cell, so it
     * can be compared directly against a real terrain query (e.g.
     * window.qtDiag's terrain pick) at the same spot.
     */
    debugBedInfo() {
        const bed = this._lastBedArray;
        if (!bed || !this._anchor) return null;
        const { W, L, dx } = this.config.grid;

        let min = Infinity, max = -Infinity, sum = 0;
        for (let i = 0; i < bed.length; i++) {
            const v = bed[i];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }

        const ci = Math.floor(W / 2), cj = Math.floor(L / 2);
        const centerBed = bed[cj * W + ci];
        const localX = (ci + 0.5) * dx - 0.5 * W * dx;
        const localZ = (cj + 0.5) * dx - 0.5 * L * dx;
        const { position: anchor, right, up, forward } = this._anchor;
        const centerWorld = {
            x: anchor.x + right.x * localX + forward.x * localZ + up.x * centerBed,
            y: anchor.y + right.y * localX + forward.y * localZ + up.y * centerBed,
            z: anchor.z + right.z * localX + forward.z * localZ + up.z * centerBed,
        };
        const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const centerRadius = Math.hypot(
            centerWorld.x - origin.x, centerWorld.y - origin.y, centerWorld.z - origin.z
        );

        return {
            minBed: min, maxBed: max, avgBed: sum / bed.length,
            centerBed, centerWorld, centerRadius,
            planetRadius: this.planetConfig?.radius ?? null,
            heightScaleUsed: this._lastHeightScale ?? null,
            heightScaleLiveNow: this.planetConfig?.heightScale ?? null,
            // What the bake's own lookup loop actually matched for this same
            // center cell: depth 999 means "never found" (fell through to
            // d==0 with no hash hit at all). Compare against a real tile
            // identity from window.qtDiag.pickTerrainAtCenter().
            matchedAtCenter: this._lastBakeDebug ?? null,
        };
    }

    /**
     * One-off GPU->CPU readback of the live sim state (slot 0), for console
     * diagnostics (window.riverState() in standalone.html). Submits its own
     * command buffer independent of the per-frame encoder passed to update().
     * @returns {Promise<{total:number, wetCount:number, maxH:number, avgWetH:number, wetRowRange:[number,number]|null}|null>}
     */
    async debugReadState() {
        if (!this._initialized || !this._sim || this._stateReadbackBusy) return null;
        this._stateReadbackBusy = true;
        try {
            const { W, L } = this.config.grid;
            const byteLength = W * L * 16;
            const encoder = this.device.createCommandEncoder({ label: 'River-DebugReadState' });
            encoder.copyBufferToBuffer(this._sim.stateBufs[0], 0, this._stateReadback, 0, byteLength);
            this.device.queue.submit([encoder.finish()]);

            await this._stateReadback.mapAsync(GPUMapMode.READ);
            const data = new Float32Array(this._stateReadback.getMappedRange(0, byteLength).slice(0));
            this._stateReadback.unmap();

            let wetCount = 0, maxH = 0, sumH = 0, minRow = Infinity, maxRow = -Infinity;
            const hmin = this.config.sim.hmin;
            for (let idx = 0; idx < W * L; idx++) {
                const h = data[idx * 4];
                if (h > hmin) {
                    wetCount++;
                    sumH += h;
                    if (h > maxH) maxH = h;
                    const row = Math.floor(idx / W);
                    if (row < minRow) minRow = row;
                    if (row > maxRow) maxRow = row;
                }
            }
            return {
                total: W * L,
                wetCount,
                maxH,
                avgWetH: wetCount ? sumH / wetCount : 0,
                wetRowRange: wetCount ? [minRow, maxRow] : null,
            };
        } finally {
            this._stateReadbackBusy = false;
        }
    }

    dispose() {
        this._stateReadback?.destroy?.();
        this._sim?.bedBuf?.destroy?.();
        this._sim?.stateBufs?.forEach((b) => b.destroy?.());
        this._sim?.kBufs?.forEach((b) => b.destroy?.());
        this._sim?.uniformBuf?.destroy?.();
        this._bedBake?.dispose?.();
        this._geometry?.dispose?.();
        this._material?.dispose?.();
        this._initialized = false;
        this._state = 'idle';
    }

    // ---- bed bake -----------------------------------------------------

    _dispatchBake() {
        const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const heightScale = Number.isFinite(this.planetConfig?.heightScale) ? this.planetConfig.heightScale : 2000;
        this._lastHeightScale = heightScale; // recorded for window.riverBed() diagnostics
        const { dx } = this.config.grid;

        // Deliberately NOT using the per-frame shared encoder (Frontend
        // passes one into update()): dispatching the bake on it produced
        // silently-empty results (compute pass appeared to run — the copy
        // commands executed — but never actually wrote real data; verified
        // by comparing against a manually-issued, independently-submitted
        // dispatch from the console, which worked correctly every time).
        // The bake is a one-time preprocessing step with its own async
        // resolve() already, so it doesn't need to share the frame's
        // encoder — a small, independent command buffer is simpler and,
        // per this debugging session, actually correct. See
        // RIVER_WALKING_SKELETON_LOG.md, Session 3 resolution.
        const bakeEncoder = this.device.createCommandEncoder({ label: 'River-BedBake-Dispatch' });
        const ok = this._bedBake.dispatch(bakeEncoder, {
            origin,
            radius: this.planetConfig?.radius,
            heightScale,
            dx,
            patchAnchor: this._anchor.position,
            patchRight: this._anchor.right,
            patchForward: this._anchor.forward,
            quadtreeGPU: this.quadtreeGPU,
            tileStreamer: this.tileStreamer,
        });

        if (!ok) {
            // resources (tile textures / hash table) not resident yet; try again
            // after another readyDelayFrames window.
            this._framesSincePending = 0;
            this._retryCount++;
            if (this._retryCount > this.config.bake.maxRetries) {
                Logger.warn('[River] bed bake resources never became available; giving up');
                this._state = 'failed';
            }
            return;
        }

        this.device.queue.submit([bakeEncoder.finish()]);
        this._state = 'baking';
        Logger.info('[River] bed bake dispatched');
        this._bedBake.resolve().then((result) => this._onBedResolved(result));
    }

    _onBedResolved(result) {
        const total = this.config.grid.W * this.config.grid.L;
        const validCount = result?.validCount ?? 0;
        this._lastBakeValidCount = validCount;
        if (result?.bed) this._lastBedArray = result.bed;
        if (result?.debug) this._lastBakeDebug = result.debug;

        const enoughValid = result && validCount >= this.config.bake.minValidFraction * total;
        if (!enoughValid) {
            this._retryCount++;
            if (this._retryCount > this.config.bake.maxRetries) {
                Logger.warn(`[River] bed bake proceeding with partial data (${validCount}/${total} cells valid)`);
                this._seedFromBed(result?.bed || new Float32Array(total));
                this._state = 'ready';
                Logger.info('[River] ready');
                return;
            }
            if (this._retryCount === 1 || this._retryCount % 10 === 0) {
                Logger.warn(`[River] bed bake mostly unresolved (${validCount}/${total}), retrying (attempt ${this._retryCount}/${this.config.bake.maxRetries})`);
            }
            this._state = 'pending';
            this._framesSincePending = 0;
            return;
        }

        Logger.info(`[River] bed bake resolved (${validCount}/${total} cells valid)`);
        this._seedFromBed(result.bed);
        this._state = 'ready';
        Logger.info('[River] ready');
    }

    _seedFromBed(bedArray) {
        const { W, L } = this.config.grid;
        this.device.queue.writeBuffer(this._sim.bedBuf, 0, bedArray);

        const { edgeRowCount, depthAboveMin: inflowDepth } = this.config.inflow;
        let minEdgeBed = Infinity;
        for (let j = 0; j < edgeRowCount; j++) {
            for (let i = 0; i < W; i++) {
                const b = bedArray[j * W + i];
                if (b < minEdgeBed) minEdgeBed = b;
            }
        }
        if (!Number.isFinite(minEdgeBed)) minEdgeBed = 0;
        this._inEta = minEdgeBed + inflowDepth;

        const { startRow, rowCount, depthAboveMin: fillDepth } = this.config.initialFill;
        const endRow = Math.min(L, startRow + rowCount);
        let minFillBed = Infinity;
        for (let j = startRow; j < endRow; j++) {
            for (let i = 0; i < W; i++) {
                const b = bedArray[j * W + i];
                if (b < minFillBed) minFillBed = b;
            }
        }
        if (!Number.isFinite(minFillBed)) minFillBed = 0;
        this._fillEta = minFillBed + fillDepth;

        const state = new Float32Array(W * L * 4);
        for (let j = startRow; j < endRow; j++) {
            for (let i = 0; i < W; i++) {
                const idx = j * W + i;
                const h = Math.max(0, this._fillEta - bedArray[idx]);
                state[idx * 4] = h;
            }
        }
        this.device.queue.writeBuffer(this._sim.stateBufs[0], 0, state);
    }

    // ---- simulation -----------------------------------------------------

    _createSimResources() {
        const { W, L } = this.config.grid;
        const N = W * L;
        const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
        const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

        const bedBuf = this.device.createBuffer({ label: 'River-Bed', size: N * 4, usage: STORAGE });
        // stateBufs also need COPY_SRC: debugReadState() reads slot 0 back for
        // console diagnostics (see window.riverState() in standalone.html).
        const stateBufs = [0, 1, 2].map((i) =>
            this.device.createBuffer({
                label: `River-State${i}`, size: N * 16,
                usage: STORAGE | GPUBufferUsage.COPY_SRC,
            }));
        const kBufs = [0, 1, 2].map((i) =>
            this.device.createBuffer({ label: `River-K${i}`, size: N * 4, usage: STORAGE }));
        const uniformBuf = this.device.createBuffer({
            label: 'River-SimUniforms', size: SIM_UNIFORM_BYTES, usage: UNIFORM,
        });

        this._stateReadback = this.device.createBuffer({
            label: 'River-StateReadback', size: N * 16,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this._stateReadbackBusy = false;

        const C = GPUShaderStage.COMPUTE;
        const bgl = this.device.createBindGroupLayout({
            label: 'River-SimBGL',
            entries: [
                { binding: 0, visibility: C, buffer: { type: 'uniform' } },
                { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: C, buffer: { type: 'storage' } },
                { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: C, buffer: { type: 'storage' } },
            ],
        });
        const module = this.device.createShaderModule({ label: 'River-Sim-SM', code: RIVER_WGSL_SIM });
        const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bgl] });
        const pipelines = ['advect', 'height', 'momentum'].map((entryPoint) =>
            this.device.createComputePipeline({ layout, compute: { module, entryPoint } }));

        // three ping-pong bind groups: after any whole number of substeps,
        // the latest state always ends up back in slot 0 (see riverSimShader).
        const bindGroups = [[0, 1], [1, 2], [2, 0]].map(([a, b]) => this.device.createBindGroup({
            label: 'River-SimBG',
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: uniformBuf } },
                { binding: 1, resource: { buffer: bedBuf } },
                { binding: 2, resource: { buffer: stateBufs[a] } },
                { binding: 3, resource: { buffer: stateBufs[b] } },
                { binding: 4, resource: { buffer: kBufs[a] } },
                { binding: 5, resource: { buffer: kBufs[b] } },
            ],
        }));

        this._sim = { bedBuf, stateBufs, kBufs, uniformBuf, pipelines, bindGroups };

        const ab = new ArrayBuffer(SIM_UNIFORM_BYTES);
        this._simUniformArrayBuffer = ab;
        this._simUniformF32 = new Float32Array(ab);
        this._simUniformU32 = new Uint32Array(ab);
    }

    _writeSimUniforms() {
        const { W, L, dx } = this.config.grid;
        const s = this.config.sim;
        const f32 = this._simUniformF32; const u32 = this._simUniformU32;
        u32[0] = W; u32[1] = L;
        f32[2] = dx; f32[3] = s.dt;
        f32[4] = s.g; f32[5] = s.manning; f32[6] = s.hmin; f32[7] = s.umax;
        f32[8] = this._time; f32[9] = this._inEta; f32[10] = this.config.inflow.inQ; f32[11] = this.config.inflow.inVelScale;
        f32[12] = s.turbA; f32[13] = s.turbL; f32[14] = s.turbT; f32[15] = s.foamDecay;
        f32[16] = s.kDecay; f32[17] = s.macCormack; f32[18] = s.kGen; f32[19] = s.foamGen;
        f32[20] = s.maxRise; f32[21] = s.maxFall; f32[22] = 0; f32[23] = 0;
        this.device.queue.writeBuffer(this._sim.uniformBuf, 0, this._simUniformArrayBuffer);
    }

    _dispatchSimSubsteps(encoder) {
        const { W, L } = this.config.grid;
        const wgX = Math.ceil(W / 8); const wgY = Math.ceil(L / 8);
        for (let s = 0; s < this.config.sim.substeps; s++) {
            const pass = encoder.beginComputePass({ label: 'River-Substep' });
            for (let k = 0; k < 3; k++) {
                pass.setPipeline(this._sim.pipelines[k]);
                pass.setBindGroup(0, this._sim.bindGroups[k]);
                pass.dispatchWorkgroups(wgX, wgY);
            }
            pass.end();
        }
    }

    // ---- rendering -----------------------------------------------------

    _createRenderResources() {
        const { W, L } = this.config.grid;
        const geometry = new Geometry();
        geometry.setIndex(buildGridIndices(W, L));
        this._geometry = geometry;

        this._material = RiverMaterialBuilder.create({ grid: this.config.grid });
        this._material.storageBuffers = {
            bed: this._sim.bedBuf,
            state: this._sim.stateBufs[0],
            turbulence: this._sim.kBufs[0],
        };
    }
}
