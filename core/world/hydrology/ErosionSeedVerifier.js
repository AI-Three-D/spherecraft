// core/world/hydrology/ErosionSeedVerifier.js
//
// Stage 2 of the river/lake design: verifies the level-1 nudge candidates
// (featureErosionSeeds.wgsl.js) near a reference point, and reports which
// ones would actually retain water once carved, upgrading those into
// lakes.
//
// Retention model: a pit carved into flat ground holds water by
// construction (closed rim on all sides) — it only fails when the natural
// terrain tilts enough across the pit's footprint that the pit's own rim
// gets breached on the low side. So the achievable water depth is
// (lowest natural elevation on a ring around the candidate) minus (the
// pit's own floor elevation) = (ringMin - candidateBase) + nudgeDepth. The
// *minimum* ring sample matters, not the average — a lake spills at its
// single lowest rim point regardless of how high the rest of the rim is.
//
// That achievable depth has to clear a margin scaled by the candidate's
// own local humidity (climate.precipitation), not a separate hard cutoff:
// a low margin in wet areas means even a barely-retaining pit counts as a
// lake, while a high margin in dry areas makes it require a genuinely deep
// natural depression — the same "humidity is a shared knob driving both
// biome and hydrology" idea the rest of this design follows, rather than a
// bolted-on precipitation gate.
//
// Deliberately narrow: checks only the ~9 candidates the shader itself
// would consider near the reference point (same hash, same region math —
// see _computeCandidates below, which must stay in exact lockstep with
// featureErosionSeedsHeight()'s WGSL), not a dense search over an area.
// That's the whole point of the seed+attrition design from the plan: most
// candidates are expected to fail this check, cheaply, rather than
// exhaustively searching for the best one.

import { Vector3 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';
import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { buildErosionSeedVerifyEntryPoint } from './erosionSeedVerify.wgsl.js';
import { computeErosionCandidateGeometry, drawErosionSizeClassScale } from './erosionSeedShared.js';

// Wider than the nudge's own base radius. Independent size-class draws can
// now propose candidates several times bigger than level-1 (see
// EROSION_SIZE_LARGE_MAX in erosionSeedShared.js); this ring isn't scaled
// per-candidate to match (that would need a per-candidate GPU uniform, not
// just a shared one) so it's a fixed, moderately generous compromise rather
// than a precise footprint match for every possible drawn size.
const RING_RADIUS_M = 90.0;
const RING_SAMPLES = 8;

// Retention margin, as a fraction of the candidate's own nudge depth,
// required for the achievable water depth to clear before it's confirmed
// as a lake. Humid areas need barely any natural help (low fraction); arid
// areas need the natural depression to dwarf the nudge itself (fraction
// > 1), making desert lakes possible only in genuinely exceptional terrain
// rather than impossible outright. Rough, early proof-of-concept numbers.
const MARGIN_FRACTION_HUMID = 0.1;
const MARGIN_FRACTION_ARID = 1.5;

export class ErosionSeedVerifier {
    constructor(device) {
        this.device = device;
    }

    /**
     * @returns {Promise<Array<{
     *   regionX:number, regionY:number, radiusScale:number, depthScale:number,
     *   sizeClass:'small'|'medium'|'large',
     *   pos:{x:number,y:number,z:number}, naturalElevationNorm:number,
     *   nudgeRadiusM:number, nudgeDepthM:number, blobAmpFactor:number,
     *   jx:number, jy:number,
     * }>>}
     */
    async run({ terrainGenerator, refDir, refForward, radius }) {
        const device = this.device;
        const refRight = new Vector3().crossVectors(refDir, refForward);
        const refPos = refDir.clone().multiplyScalar(radius);

        const candidates = this._computeCandidates({ refPos, refRight, refForward, seed: terrainGenerator.seed });

        const baseOptions = terrainGenerator._getAdvancedTerrainShaderOptions();
        const baseSource = createAdvancedTerrainComputeShader(baseOptions);
        const used = new Set();
        for (const m of baseSource.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)) used.add(Number(m[1]));
        let paramsBinding = 0; while (used.has(paramsBinding)) paramsBinding++;
        let outBinding = paramsBinding + 1; while (used.has(outBinding)) outBinding++;

        const src = baseSource + buildErosionSeedVerifyEntryPoint({ paramsBinding, outBinding });
        const module = device.createShaderModule({ label: 'ErosionSeedVerify', code: src });
        const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'erosionVerifyBasinsMain' },
        });
        const naturalHeightPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'erosionVerifyNaturalHeightMain' },
        });

        // Real, fully-populated uniforms (real seed + noise config) — not
        // the live shared buffer, which this session confirmed is stale/
        // unused by this demo's batched generation path.
        terrainGenerator._fillTerrainUniformScratch(0, 0, 128, 1, -1);
        const uniformBytes = terrainGenerator._terrainUniformScratch.slice(0);
        const uniformBuffer = device.createBuffer({
            label: 'ErosionVerify-Uniforms',
            size: uniformBytes.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(uniformBuffer, 0, uniformBytes);

        const paramsBuf = device.createBuffer({
            label: 'ErosionVerify-Params', size: 160,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const p = new Float32Array(40);
        for (let i = 0; i < 9; i++) {
            p[i * 4] = candidates[i].pos.x;
            p[i * 4 + 1] = candidates[i].pos.y;
            p[i * 4 + 2] = candidates[i].pos.z;
            p[i * 4 + 3] = candidates[i].nudgeDepthM;
        }
        p[36] = RING_RADIUS_M;
        device.queue.writeBuffer(paramsBuf, 0, p);

        // 81 elevation samples (9 candidates x 9 ring points) + 9
        // precipitation values + 9 natural full-height values (one per
        // candidate) — see erosionSeedVerify.wgsl.js's output layout comment.
        const OUT_FLOATS = 99;
        const outBuf = device.createBuffer({
            label: 'ErosionVerify-Out', size: OUT_FLOATS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
            size: OUT_FLOATS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: paramsBinding, resource: { buffer: paramsBuf } },
                { binding: outBinding, resource: { buffer: outBuf } },
            ],
        });
        const naturalHeightBindGroup = device.createBindGroup({
            layout: naturalHeightPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: paramsBinding, resource: { buffer: paramsBuf } },
                { binding: outBinding, resource: { buffer: outBuf } },
            ],
        });

        const encoder = device.createCommandEncoder({ label: 'ErosionSeedVerify' });
        let pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1);
        pass.end();
        pass = encoder.beginComputePass();
        pass.setPipeline(naturalHeightPipeline);
        pass.setBindGroup(0, naturalHeightBindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(outBuf, 0, readback, 0, OUT_FLOATS * 4);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const samples = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();

        [uniformBuffer, paramsBuf, outBuf, readback].forEach((b) => b.destroy());

        // Same normalization Stage 1's own carve uses (EROSION_NUDGE_DEPTH_M
        // * scale, divided by maxTerrainHeightM) — needed so the achievable
        // depth and the required margin are compared in the same units as
        // the raw baseElevation samples.
        const maxTerrainHeightM = Math.max(terrainGenerator.planetConfig?.maxTerrainHeight ?? 2000.0, 1.0);

        const confirmed = [];
        const clearances = [];
        for (let i = 0; i < 9; i++) {
            const self = samples[i * 9];
            let ringMin = Infinity;
            for (let r = 1; r <= RING_SAMPLES; r++) ringMin = Math.min(ringMin, samples[i * 9 + r]);
            const precipitation = samples[81 + i];
            const naturalFullHeightNorm = samples[90 + i];

            // Independent size-class proposal (see erosionSeedShared.js):
            // decided before the retention check even runs, not derived
            // from it. targetDepthNorm is the depth THIS proposal actually
            // needs — a "large" draw needs proportionally more natural
            // (ringMin - self) headroom to clear the same margin fraction,
            // so bigger proposals are naturally harder to admit without any
            // separate size-based rejection rule.
            const c = candidates[i];
            const { scale: targetScale, sizeClass } = drawErosionSizeClassScale(c.regionX, c.regionY, terrainGenerator.seed);
            const targetDepthNorm = (c.nudgeDepthM * targetScale) / maxTerrainHeightM;
            const achievableDepthNorm = (ringMin - self) + targetDepthNorm;

            const wetness = Math.max(0, Math.min(1, precipitation));
            const marginFraction = MARGIN_FRACTION_HUMID + (MARGIN_FRACTION_ARID - MARGIN_FRACTION_HUMID) * (1 - wetness);
            const requiredDepthNorm = marginFraction * targetDepthNorm;

            const clearance = (achievableDepthNorm - requiredDepthNorm) / targetDepthNorm;
            clearances.push(clearance);

            if (achievableDepthNorm < requiredDepthNorm) continue;
            confirmed.push({
                regionX: c.regionX,
                regionY: c.regionY,
                radiusScale: targetScale,
                depthScale: targetScale,
                sizeClass,
                // Everything a renderer needs to build a matching water
                // mesh without redoing this whole verification pass: exact
                // world position, the pit's own (pre-upgrade) size/shape,
                // and the natural full-detail (pre-carve) elevation so the
                // water surface can sit at the real ground height instead
                // of the coarse baseElevation signal the retention check
                // above uses — that signal skips mountains/hills/micro-
                // detail entirely, which buried the water underground when
                // it was used for this (confirmed live).
                pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z },
                naturalElevationNorm: naturalFullHeightNorm,
                nudgeRadiusM: c.nudgeRadiusM,
                nudgeDepthM: c.nudgeDepthM,
                blobAmpFactor: c.blobAmpFactor,
                // erosionBlobRadiusAt() needs these to reproduce the same
                // per-candidate noise offset the WGSL carve used — omitting
                // them here made LakeWaterSystem's geom.jx/jy undefined,
                // silently producing NaN vertex positions (confirmed live:
                // WebGPU just drops NaN geometry, rendering nothing, with
                // no validation error at all).
                jx: c.jx,
                jy: c.jy,
            });
        }

        Logger.info(
            `[ErosionSeedVerify] checked 9 candidates near reference point, ${confirmed.length} confirmed as real basins ` +
            `(retention clearance, +ve = confirmed: ${clearances.map((v) => v.toFixed(3)).join(', ')}) ` +
            `[sizes: ${confirmed.map((c) => `${c.sizeClass}(${c.radiusScale.toFixed(2)}x)`).join(', ') || 'none'}]`
        );
        return confirmed;
    }

    // Computes the same 9 candidate positions/sizes/shapes the shader
    // itself will independently derive, via the single shared geometry
    // function in erosionSeedShared.js (region (0,0) is centered on the
    // reference point itself, same as the shader's own
    // regionX/regionY = floor(0/EROSION_REGION_SIZE_M) at the reference
    // point).
    _computeCandidates({ refPos, refRight, refForward, seed }) {
        const candidates = [];
        for (let ry = -1; ry <= 1; ry++) {
            for (let rx = -1; rx <= 1; rx++) {
                candidates.push(computeErosionCandidateGeometry({
                    regionX: rx, regionY: ry, seed, refPos, refRight, refForward,
                }));
            }
        }
        return candidates;
    }
}
