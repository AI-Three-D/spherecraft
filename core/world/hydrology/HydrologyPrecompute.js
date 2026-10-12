// core/world/hydrology/HydrologyPrecompute.js
//
// One-time GPU precompute that finds a real valley within a region of the
// planet to carve a river channel along, instead of an authored fixed
// straight line.
//
// Two GPU passes:
//   1. Sample the terrain's own broad landform noise (getRegionalCharacter's
//      baseElevation — the same low-frequency signal mountains/hills/
//      micro-detail all get layered on top of) over a grid covering the
//      region. Cheaper than sampling full detailed height (skips every
//      other feature's noise octaves) and smooth enough that genuine
//      large-scale basins are directly findable — no simulation needed.
//   2. Steepest-descent flow direction per cell on that same smooth field,
//      used only to trace a path once a real valley point is found below.
//
// (An earlier version of this also ran a 250-iteration flow-accumulation
// simulation over the *full* detailed height to find channels. That found
// technically-real but visually-wrong placements — high flow-accumulation
// convergence points that sit on an open hillside, not in anything a human
// would call a valley — because raw accumulation isn't the same signal as
// "this is a valley". It was also needlessly expensive for what it bought.
// Direct valley detection on the coarse landform field is both cheaper and
// more directly correct.)
//
// CPU-side (after reading the two buffers back): find where the landform
// sits clearly below a wide ring of surrounding samples (a direct "is this
// a basin" check), then trace a path both upstream and downstream from
// there via the flow-direction field. The result is fed into the existing
// river-uniform mechanism (TerrainGenerationConfig.river.path, packed by
// WebGPUTerrainGenerator._writeRiverUniforms) as a polyline instead of a
// single straight line — see templates/terrain-shaders/features/
// featureRivers.wgsl.js for how the terrain carve consumes it.
//
// Rivers-only scope: no lake/basin *rendering* (just channel placement), no
// whole-planet coverage (one bounded region), no multi-river placement.

import { Vector3 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';
import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import {
    buildHydroHeightEntryPoint,
    buildFlowDirectionShader,
} from './hydrologyCompute.wgsl.js';

// Must match advancedTerrainCompute.wgsl.js's Uniforms.riverPath array size
// and webgpuTerrainGeneratorBatching.js's _writeRiverPathUniforms MAX_POINTS.
const MAX_PATH_POINTS = 16;

// Ring-sample radius (in cells) for the valley-ness check — wide enough to
// tell "sits in a real valley" from "sits at a small local dip on an open
// hillside". At cellSize=16m and the default 0.04*gridW, that's ~160m.
const RING_RADIUS_FRACTION = 0.04;
const RING_SAMPLES = 16;
const MIN_RING_RADIUS_CELLS = 6;

export class HydrologyPrecompute {
    constructor(device) {
        this.device = device;
    }

    /**
     * @returns {Promise<{path: Array<{along:number,across:number,widthScale:number,depthScale:number}>,
     *                     anchorDir: {x,y,z}, channelDir: {x,y,z}} | null>}
     *          null if no plausible valley was found in the region.
     */
    async run({
        terrainGenerator,
        origin,
        regionAnchor,
        regionRight,
        regionForward,
        gridW = 256,
        gridL = 256,
        cellSize = 16.0,
        radius,
    }) {
        const device = this.device;
        const N = gridW * gridL;

        // ---- Pass A: broad landform elevation sample -----------------------
        const baseOptions = terrainGenerator._getAdvancedTerrainShaderOptions({ waterCarve: false });
        const baseSource = createAdvancedTerrainComputeShader(baseOptions);

        const used = new Set();
        for (const m of baseSource.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)) used.add(Number(m[1]));
        let paramsBinding = 0; while (used.has(paramsBinding)) paramsBinding++;
        let outBinding = paramsBinding + 1; while (used.has(outBinding)) outBinding++;

        const heightSrc = baseSource + buildHydroHeightEntryPoint({ paramsBinding, outBinding });
        const heightModule = device.createShaderModule({ label: 'HydrologyHeight', code: heightSrc });
        const heightPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: heightModule, entryPoint: 'hydroHeightMain' },
        });

        // Dedicated uniform buffer, NOT the live shared one: real packed
        // uniforms (so noise/continent/etc params match production exactly),
        // built by reusing the real packing function (no reimplementation
        // risk). Rivers don't need disabling here — this entry point never
        // calls featureRiverHeight() to begin with, only getRegionalCharacter().
        // face 0, not -1: any face >= 0 selects the sphere noise path (the
        // entry point passes its own unit direction). face -1 selected the
        // flat-world path, which sampled noise at the unit vector's x/z as if
        // they were metres, i.e. not the planet's terrain.
        const scratchView = terrainGenerator._fillTerrainUniformScratch(0, 0, gridW, 1, 0);
        scratchView.setInt32(48, 0, true); // outputType — unused by our entry point, harmless
        const uniformBytes = terrainGenerator._terrainUniformScratch.slice(0);
        const hydroUniformBuffer = device.createBuffer({
            label: 'Hydro-Uniforms',
            size: uniformBytes.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(hydroUniformBuffer, 0, uniformBytes);

        const hydroParamsBuf = device.createBuffer({
            label: 'Hydro-HeightParams', size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const hp = new Float32Array(16);
        hp[0] = origin.x; hp[1] = origin.y; hp[2] = origin.z; hp[3] = cellSize;
        hp[4] = regionAnchor.x; hp[5] = regionAnchor.y; hp[6] = regionAnchor.z; hp[7] = gridW;
        hp[8] = regionRight.x; hp[9] = regionRight.y; hp[10] = regionRight.z; hp[11] = gridL;
        hp[12] = regionForward.x; hp[13] = regionForward.y; hp[14] = regionForward.z; hp[15] = 0;
        device.queue.writeBuffer(hydroParamsBuf, 0, hp);

        const heightBuf = device.createBuffer({
            label: 'Hydro-Height', size: N * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        const heightBindGroup = device.createBindGroup({
            layout: heightPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: hydroUniformBuffer } },
                { binding: paramsBinding, resource: { buffer: hydroParamsBuf } },
                { binding: outBinding, resource: { buffer: heightBuf } },
            ],
        });

        // ---- Pass B: flow direction (for path tracing only) ----------------
        const flowModule = device.createShaderModule({ label: 'HydrologyFlowDir', code: buildFlowDirectionShader() });
        const flowPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: flowModule, entryPoint: 'flowDirectionMain' },
        });
        const flowParamsBuf = device.createBuffer({
            label: 'Hydro-FlowParams', size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(flowParamsBuf, 0, new Uint32Array([gridW, gridL, 0, 0]));
        device.queue.writeBuffer(flowParamsBuf, 8, new Float32Array([cellSize, 0]));

        const flowDirBuf = device.createBuffer({
            label: 'Hydro-FlowDir', size: N * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const flowBindGroup = device.createBindGroup({
            layout: flowPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: flowParamsBuf } },
                { binding: 1, resource: { buffer: heightBuf } },
                { binding: 2, resource: { buffer: flowDirBuf } },
            ],
        });

        // ---- Dispatch (just 2 passes now — no accumulation loop) -----------
        const wgX = Math.ceil(gridW / 8);
        const wgY = Math.ceil(gridL / 8);
        const encoder = device.createCommandEncoder({ label: 'Hydrology-Precompute' });

        let pass = encoder.beginComputePass();
        pass.setPipeline(heightPipeline);
        pass.setBindGroup(0, heightBindGroup);
        pass.dispatchWorkgroups(wgX, wgY);
        pass.end();

        pass = encoder.beginComputePass();
        pass.setPipeline(flowPipeline);
        pass.setBindGroup(0, flowBindGroup);
        pass.dispatchWorkgroups(wgX, wgY);
        pass.end();

        const flowDirReadback = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const heightReadback = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        encoder.copyBufferToBuffer(flowDirBuf, 0, flowDirReadback, 0, N * 4);
        encoder.copyBufferToBuffer(heightBuf, 0, heightReadback, 0, N * 4);

        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();

        await Promise.all([
            flowDirReadback.mapAsync(GPUMapMode.READ),
            heightReadback.mapAsync(GPUMapMode.READ),
        ]);
        const flowDir = new Int32Array(flowDirReadback.getMappedRange().slice(0));
        const height = new Float32Array(heightReadback.getMappedRange().slice(0));
        flowDirReadback.unmap();
        heightReadback.unmap();

        [hydroUniformBuffer, hydroParamsBuf, heightBuf, flowParamsBuf, flowDirBuf,
            flowDirReadback, heightReadback]
            .forEach((b) => b.destroy());

        return this._tracePath({
            flowDir, height, gridW, gridL, cellSize,
            origin, regionAnchor, regionRight, regionForward, radius,
        });
    }

    // ---- CPU-side: find a real valley, then walk the flow-direction field --
    _tracePath(ctx) {
        const { height, gridW, gridL } = ctx;
        const idxOf = (x, y) => y * gridW + x;

        const ringRadius = Math.max(MIN_RING_RADIUS_CELLS, Math.floor(gridW * RING_RADIUS_FRACTION));
        const ringOffsets = [];
        for (let i = 0; i < RING_SAMPLES; i++) {
            const a = (i / RING_SAMPLES) * Math.PI * 2;
            ringOffsets.push([Math.round(Math.cos(a) * ringRadius), Math.round(Math.sin(a) * ringRadius)]);
        }
        const valleyDepthAt = (x, y) => {
            let sum = 0, n = 0;
            for (const [ox, oy] of ringOffsets) {
                const rx = x + ox, ry = y + oy;
                if (rx < 0 || ry < 0 || rx >= gridW || ry >= gridL) continue;
                sum += height[idxOf(rx, ry)];
                n++;
            }
            if (n === 0) return 0;
            return (sum / n) - height[idxOf(x, y)]; // positive = below surroundings
        };

        // Cheap enough to just check every candidate cell directly — no
        // accumulation-based pre-filter needed now that this is a direct
        // "is this a basin" check on a smooth field, not a simulation.
        const marginX = Math.floor(gridW * 0.25);
        const marginY = Math.floor(gridL * 0.25);
        const candidates = [];
        for (let y = marginY; y < gridL - marginY; y++) {
            for (let x = marginX; x < gridW - marginX; x++) {
                candidates.push({ x, y, valleyDepth: valleyDepthAt(x, y) });
            }
        }
        candidates.sort((a, b) => b.valleyDepth - a.valleyDepth);

        const MIN_SEPARATION_CELLS = Math.max(4, Math.floor(gridW * 0.1));
        const chosen = [];
        for (const c of candidates) {
            if (chosen.length >= 6) break;
            if (c.valleyDepth <= 0) break; // must actually sit below its surroundings
            const tooClose = chosen.some((p) => Math.abs(p.x - c.x) < MIN_SEPARATION_CELLS && Math.abs(p.y - c.y) < MIN_SEPARATION_CELLS);
            if (!tooClose) chosen.push(c);
        }
        if (chosen.length === 0) {
            Logger.warn(
                `[Hydrology] no real valley found in this region (best valley-depth=${candidates[0]?.valleyDepth?.toExponential(2) ?? 'n/a'}, ` +
                `essentially flat) — some areas genuinely don't have one nearby`
            );
            return null;
        }

        let best = null;
        for (const seed of chosen) {
            const attempt = this._traceFromSeed(ctx, seed, valleyDepthAt);
            if (attempt && (!best || attempt.span > best.span)) best = attempt;
        }
        if (!best) {
            Logger.warn(`[Hydrology] ${chosen.length} candidate valley point(s) tried, all produced a degenerate (too-short) trace`);
            return null;
        }

        Logger.info(
            `[Hydrology] traced path: ${best.path.length} points, span=${best.span.toFixed(0)}m, ` +
            `seed valley-depth=${best.seedValleyDepth.toExponential(2)} (best of ${chosen.length} candidates)`
        );
        return { path: best.path, anchorDir: best.anchorDir, channelDir: best.channelDir };
    }

    // Trace upstream+downstream from one seed cell (both directions via
    // steepest gradient on the smooth landform field — no accumulation
    // buffer needed) and build a path in the (along, across) frame, or
    // return null if the resulting span is too short to be worth carving.
    _traceFromSeed({ flowDir, height, gridW, gridL, cellSize, origin, regionAnchor, regionRight, regionForward, radius }, seed, valleyDepthAt) {
        const OFFSETS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
        const idxOf = (x, y) => y * gridW + x;
        const { x: seedX, y: seedY, valleyDepth: seedValleyDepth } = seed;
        const maxSteps = Math.min(gridW, gridL) - 2; // never chase past the region edge

        // Downstream: follow this cell's own flow-direction pointer. Seeds
        // are chosen because they're a local basin bottom (lower than a
        // wide ring around them) — which is also exactly the condition for
        // being a D8 sink (flowDir = -1, no single steepest-neighbor
        // direction was ever assigned there). Strictly requiring flowDir at
        // every step meant the trace dead-ended at step 0 right at the
        // seed itself for most/all candidates (confirmed live: 6/6 seeds
        // produced a degenerate trace in one run). Falling back to a manual
        // steepest-descent step among all 8 neighbors whenever the
        // precomputed field has no answer — not just at the seed, at any
        // small dip the chain runs into, since this terrain has plenty of
        // small-scale bumps — lets the walk continue past that one cell;
        // the field resumes giving real directions past it. If even the
        // lowest neighbor isn't lower than here, that's a genuine regional
        // minimum and the channel really does end there.
        const stepDownhill = (x, y) => {
            const d = flowDir[idxOf(x, y)];
            if (d >= 0) {
                const [ox, oy] = OFFSETS[d];
                return [x + ox, y + oy];
            }
            const here = height[idxOf(x, y)];
            let bestH = here, bestX = -1, bestY = -1;
            for (let i = 0; i < 8; i++) {
                const [ox, oy] = OFFSETS[i];
                const cx = x + ox, cy = y + oy;
                if (cx <= 0 || cy <= 0 || cx >= gridW - 1 || cy >= gridL - 1) continue;
                const ch = height[idxOf(cx, cy)];
                if (ch < bestH) { bestH = ch; bestX = cx; bestY = cy; }
            }
            return [bestX, bestY];
        };
        const downstream = [];
        {
            let x = seedX, y = seedY;
            for (let s = 0; s < maxSteps; s++) {
                const [nx, ny] = stepDownhill(x, y);
                if (nx < 0 || nx <= 0 || ny <= 0 || nx >= gridW - 1 || ny >= gridL - 1) break;
                x = nx; y = ny;
                downstream.push([x, y]);
            }
        }

        // Upstream: at each step, prefer whichever neighbor genuinely flows
        // into the current cell (its own flowDir points here) and climbs
        // the steepest among those. Since D8 assigns each cell only one
        // outgoing direction, plenty of cells end up with zero inflow by
        // chance even away from any seed-specific pit issue — when that
        // happens, fall back to the steepest uphill neighbor directly,
        // same reasoning as the downstream fallback above.
        const upstream = [];
        {
            let x = seedX, y = seedY;
            for (let s = 0; s < maxSteps; s++) {
                let bestNx = -1, bestNy = -1, bestSlope = -Infinity;
                const here = height[idxOf(x, y)];
                for (let i = 0; i < 8; i++) {
                    const [ox, oy] = OFFSETS[i];
                    const nx = x - ox, ny = y - oy;
                    if (nx <= 0 || ny <= 0 || nx >= gridW - 1 || ny >= gridL - 1) continue;
                    if (flowDir[idxOf(nx, ny)] !== i) continue; // must actually flow into (x,y)
                    const slope = height[idxOf(nx, ny)] - here;
                    if (slope > bestSlope) { bestSlope = slope; bestNx = nx; bestNy = ny; }
                }
                if (bestNx < 0) {
                    for (let i = 0; i < 8; i++) {
                        const [ox, oy] = OFFSETS[i];
                        const nx = x - ox, ny = y - oy;
                        if (nx <= 0 || ny <= 0 || nx >= gridW - 1 || ny >= gridL - 1) continue;
                        const slope = height[idxOf(nx, ny)] - here;
                        if (slope > bestSlope) { bestSlope = slope; bestNx = nx; bestNy = ny; }
                    }
                }
                if (bestNx < 0 || bestSlope <= 0) break; // no uphill neighbor at all — real ridge/edge
                upstream.push([bestNx, bestNy]);
                x = bestNx; y = bestNy;
            }
        }
        upstream.reverse();

        const cellsPath = [...upstream, [seedX, seedY], ...downstream];
        if (cellsPath.length < 2) return null;

        // Subsample to MAX_PATH_POINTS, always keeping the first and last cell.
        const sampled = [];
        const step = Math.max(1, (cellsPath.length - 1) / (MAX_PATH_POINTS - 1));
        for (let i = 0; i < MAX_PATH_POINTS; i++) {
            const srcIdx = Math.min(cellsPath.length - 1, Math.round(i * step));
            sampled.push(cellsPath[srcIdx]);
        }
        // Anchor at the middle of the *subsampled* path array, not the seed
        // cell itself: the seed can land close to either extreme if upstream
        // or downstream tracing happened to be short, and the water
        // simulation patch is a fixed ~128m square centered on the anchor —
        // it needs real path data on both sides. Confirmed live: anchoring
        // at the seed left the path entirely on one side of the anchor.
        const seedSampledIdx = Math.floor((sampled.length - 1) / 2);

        // Grid cell -> world position -> unit direction (same tangent-frame
        // convention as the rest of the river system).
        const toWorldDir = ([cx, cy]) => {
            const localX = (cx + 0.5) * cellSize - 0.5 * gridW * cellSize;
            const localZ = (cy + 0.5) * cellSize - 0.5 * gridL * cellSize;
            const worldPos = new Vector3(regionAnchor.x, regionAnchor.y, regionAnchor.z)
                .add(new Vector3(regionRight.x, regionRight.y, regionRight.z).multiplyScalar(localX))
                .add(new Vector3(regionForward.x, regionForward.y, regionForward.z).multiplyScalar(localZ));
            return new Vector3().subVectors(worldPos, origin).normalize();
        };

        const startDir = toWorldDir(sampled[0]);
        const endDir = toWorldDir(sampled[sampled.length - 1]);
        const anchorDir = toWorldDir(sampled[seedSampledIdx]);
        const anchorPos = anchorDir.clone().multiplyScalar(radius);

        // channelDir: overall path direction, from the FULL start-to-end
        // span (not anchor-to-end) — the anchor sits at the seed cell, which
        // can land close to either extreme, so anchor-to-end alone isn't a
        // reliable direction even when the path overall is long. Projected
        // onto the tangent plane at the anchor so it stays perpendicular to
        // anchorDir (same invariant the old fixed-line version relied on).
        const startPos = startDir.clone().multiplyScalar(radius);
        const endPos = endDir.clone().multiplyScalar(radius);
        const rawTangent = new Vector3().subVectors(endPos, startPos);
        const span = rawTangent.length();
        if (span < 40) return null; // not worth carving — shorter than the channel's own width

        const alongAnchor = rawTangent.dot(anchorDir);
        const channelDir = new Vector3().subVectors(rawTangent, anchorDir.clone().multiplyScalar(alongAnchor));
        if (channelDir.lengthSq() < 1e-6) return null;
        channelDir.normalize();
        const rightAxis = new Vector3().crossVectors(anchorDir, channelDir);

        // Width/depth per point scaled by that point's OWN valley-depth
        // (clearly-a-basin points carve more than shallow, marginal ones),
        // not flow accumulation — this is a placement system now, not a
        // drainage simulation, so there's no accumulated-flow signal to use.
        let maxValleyDepthInPath = 1e-9;
        const pointValleyDepths = sampled.map((c) => valleyDepthAt(c[0], c[1]));
        for (const vd of pointValleyDepths) maxValleyDepthInPath = Math.max(maxValleyDepthInPath, vd);

        const path = sampled.map((c, i) => {
            const dir = toWorldDir(c);
            const pos = dir.clone().multiplyScalar(radius);
            const delta = new Vector3().subVectors(pos, anchorPos);
            const along = delta.dot(channelDir);
            const across = delta.dot(rightAxis);
            const vd = Math.max(0, pointValleyDepths[i]);
            const scale = Math.max(0.35, Math.min(1.5, vd / maxValleyDepthInPath));
            return { along, across, widthScale: scale, depthScale: scale };
        });

        return {
            path, span, seedValleyDepth,
            anchorDir: { x: anchorDir.x, y: anchorDir.y, z: anchorDir.z },
            channelDir: { x: channelDir.x, y: channelDir.y, z: channelDir.z },
        };
    }
}
