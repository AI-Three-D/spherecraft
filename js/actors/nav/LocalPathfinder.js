// js/actors/nav/LocalPathfinder.js
//
// GPU-based local pathfinding using a 2D occupancy grid + jump-flood
// distance field in the actor's tangent plane.
//
// Grid: GRID_SIZE×GRID_SIZE cells at 1m each, centered on actor.
// Pass A: Clear grid + rasterize tree cylinder obstacles
// Pass B: Jump-flood from goal cell (log2 passes)
// Pass C: Read gradient at actor cell → steering direction
//
// Recomputed at configurable interval (default 1s) or when destination changes.

import { Logger } from '../../config/Logger.js';

const GRID_SIZE = 32;
const GRID_CELLS = GRID_SIZE * GRID_SIZE;
const JFA_PASSES = 5; // log2(32) = 5

function buildPathfinderShader() {
    return /* wgsl */`

const GRID_SIZE: u32 = ${GRID_SIZE}u;
const GRID_CELLS: u32 = ${GRID_CELLS}u;
const CLOSE_TREE_STRIDE: u32 = 32u;
const INF: f32 = 1e10;

struct Params {
    actorPos:     vec3<f32>, cellSize:     f32,  // 0-3
    planetOrigin: vec3<f32>, planetRadius: f32,  // 4-7
    goalLocal:    vec2<f32>,                      // 8-9
    maxColliders: u32,                            // 10
    trunkScale:   f32,                            // 11
    trunkMin:     f32,                            // 12
    actorRadius:  f32,                            // 13
    // tangent frame (right, forward vectors in world space)
    rightX: f32, rightY: f32, rightZ: f32, _p0: f32, // 14-17
    fwdX:   f32, fwdY:   f32, fwdZ:   f32, _p1: f32, // 18-21
    upX:    f32, upY:    f32, upZ:    f32, _p2: f32,  // 22-25
    jfaStep: u32, _p3: u32, _p4: u32, _p5: u32,      // 26-29
}

@group(0) @binding(0) var<uniform>             params:         Params;
@group(0) @binding(1) var<storage, read>       closeTrees:     array<f32>;
@group(0) @binding(2) var<storage, read>       closeTreeCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> grid:           array<f32>;
// grid: 2 floats per cell = [seedX, seedY]. INF means no seed.
@group(0) @binding(4) var<storage, read_write> gridB:          array<f32>;
// Ping-pong buffer for JFA
@group(0) @binding(5) var<storage, read_write> result:         array<f32>;
// result: [dirX, dirY, dist, valid]

fn cellIdx(x: u32, y: u32) -> u32 { return (y * GRID_SIZE + x) * 2u; }

fn worldToLocal(wp: vec3<f32>) -> vec2<f32> {
    let d = wp - params.actorPos;
    return vec2(
        d.x * params.rightX + d.y * params.rightY + d.z * params.rightZ,
        d.x * params.fwdX   + d.y * params.fwdY   + d.z * params.fwdZ
    );
}

fn localToCell(lp: vec2<f32>) -> vec2<i32> {
    let half = f32(GRID_SIZE) * params.cellSize * 0.5;
    return vec2<i32>(
        i32(floor((lp.x + half) / params.cellSize)),
        i32(floor((lp.y + half) / params.cellSize))
    );
}

fn inBounds(c: vec2<i32>) -> bool {
    return c.x >= 0 && c.x < i32(GRID_SIZE) && c.y >= 0 && c.y < i32(GRID_SIZE);
}

// ── Pass A: Clear + obstacle rasterization ──────────────────────────
// One thread per grid cell.
@compute @workgroup_size(64)
fn clearAndRasterize(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= GRID_CELLS) { return; }

    let cx = idx % GRID_SIZE;
    let cy = idx / GRID_SIZE;
    let b = idx * 2u;

    // Default: no seed
    grid[b]     = INF;
    grid[b + 1u] = INF;

    // Cell center in local coords
    let half = f32(GRID_SIZE) * params.cellSize * 0.5;
    let cellX = (f32(cx) + 0.5) * params.cellSize - half;
    let cellY = (f32(cy) + 0.5) * params.cellSize - half;

    // Check tree obstacles
    let n = min(closeTreeCount[0], params.maxColliders);
    var blocked = false;
    for (var i = 0u; i < n; i++) {
        let tb = i * CLOSE_TREE_STRIDE;
        let treeWorld = vec3(closeTrees[tb], closeTrees[tb+1u], closeTrees[tb+2u]);
        let treeW = closeTrees[tb + 4u];
        let trunkR = max(treeW * params.trunkScale, params.trunkMin) + params.actorRadius;

        let treeLocal = worldToLocal(treeWorld);
        let dx = cellX - treeLocal.x;
        let dy = cellY - treeLocal.y;
        if (dx * dx + dy * dy < trunkR * trunkR) {
            blocked = true;
            break;
        }
    }

    // Mark blocked cells with special value (negative INF)
    if (blocked) {
        grid[b]     = -INF;
        grid[b + 1u] = -INF;
        return;
    }

    // Seed the goal cell
    let goalCell = localToCell(params.goalLocal);
    if (i32(cx) == goalCell.x && i32(cy) == goalCell.y) {
        grid[b]     = f32(cx);
        grid[b + 1u] = f32(cy);
    }
}

// ── Pass B: Jump Flood step ─────────────────────────────────────────
// Read from grid, write to gridB. Caller ping-pongs by swapping.
@compute @workgroup_size(64)
fn jfaStep(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= GRID_CELLS) { return; }

    let cx = i32(idx % GRID_SIZE);
    let cy = i32(idx / GRID_SIZE);
    let step = i32(params.jfaStep);

    let b = idx * 2u;
    var bestSX = grid[b];
    var bestSY = grid[b + 1u];

    // If blocked, stay blocked
    if (bestSX <= -1e9) {
        gridB[b]     = -INF;
        gridB[b + 1u] = -INF;
        return;
    }

    var bestD = INF;
    if (bestSX < 1e9) {
        let dx = f32(cx) - bestSX;
        let dy = f32(cy) - bestSY;
        bestD = dx * dx + dy * dy;
    }

    // Check 8 neighbors at current step size
    for (var dy2 = -1; dy2 <= 1; dy2++) {
        for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (dx2 == 0 && dy2 == 0) { continue; }
            let nx = cx + dx2 * step;
            let ny = cy + dy2 * step;
            if (nx < 0 || nx >= i32(GRID_SIZE) || ny < 0 || ny >= i32(GRID_SIZE)) { continue; }
            let nb = u32(ny * i32(GRID_SIZE) + nx) * 2u;
            let sx = grid[nb];
            let sy = grid[nb + 1u];
            if (sx >= 1e9 || sx <= -1e9) { continue; }
            let ddx = f32(cx) - sx;
            let ddy = f32(cy) - sy;
            let d = ddx * ddx + ddy * ddy;
            if (d < bestD) {
                bestD = d;
                bestSX = sx;
                bestSY = sy;
            }
        }
    }

    gridB[b]     = bestSX;
    gridB[b + 1u] = bestSY;
}

// ── Pass C: Read gradient at actor cell ─────────────────────────────
@compute @workgroup_size(1)
fn readGradient() {
    // Actor is at grid center
    let half = GRID_SIZE / 2u;
    let b = cellIdx(half, half);
    let sx = grid[b];
    let sy = grid[b + 1u];

    if (sx >= 1e9 || sx <= -1e9) {
        result[0] = 0.0;
        result[1] = 0.0;
        result[2] = INF;
        result[3] = 0.0;
        return;
    }

    let dx = sx - f32(half);
    let dy = sy - f32(half);
    let dist = sqrt(dx * dx + dy * dy) * params.cellSize;
    let len = sqrt(dx * dx + dy * dy);

    if (len < 0.001) {
        result[0] = 0.0;
        result[1] = 0.0;
        result[2] = dist;
        result[3] = 1.0;
    } else {
        result[0] = dx / len;
        result[1] = dy / len;
        result[2] = dist;
        result[3] = 1.0;
    }
}
`;
}

export class LocalPathfinder {
    constructor(device) {
        this.device = device;

        this._clearPipeline = null;
        this._jfaPipeline = null;
        this._gradPipeline = null;
        this._bgl = null;

        this._paramsBuffer = null;
        this._gridA = null; // ping
        this._gridB = null; // pong
        this._resultBuffer = null;
        this._readbackBuffer = null;
        this._readbackState = 'idle';

        this._bindGroupA = null; // read A, write B
        this._bindGroupB = null; // read B, write A
        this._clearBG = null;
        this._gradBG = null;
        this._bgDirty = true;

        this._initialized = false;
    }

    initialize() {
        const code = buildPathfinderShader();
        const mod = this.device.createShaderModule({
            label: 'LocalPathfinder-SM', code,
        });

        this._bgl = this.device.createBindGroupLayout({
            label: 'LocalPathfinder-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] });

        this._clearPipeline = this.device.createComputePipeline({
            label: 'LocalPathfinder-Clear', layout,
            compute: { module: mod, entryPoint: 'clearAndRasterize' },
        });
        this._jfaPipeline = this.device.createComputePipeline({
            label: 'LocalPathfinder-JFA', layout,
            compute: { module: mod, entryPoint: 'jfaStep' },
        });
        this._gradPipeline = this.device.createComputePipeline({
            label: 'LocalPathfinder-Grad', layout,
            compute: { module: mod, entryPoint: 'readGradient' },
        });

        const gridBytes = GRID_CELLS * 2 * 4; // 2 f32 per cell
        this._paramsBuffer = this.device.createBuffer({
            label: 'Pathfinder-Params', size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._gridA = this.device.createBuffer({
            label: 'Pathfinder-GridA', size: Math.max(256, gridBytes),
            usage: GPUBufferUsage.STORAGE,
        });
        this._gridB = this.device.createBuffer({
            label: 'Pathfinder-GridB', size: Math.max(256, gridBytes),
            usage: GPUBufferUsage.STORAGE,
        });
        this._resultBuffer = this.device.createBuffer({
            label: 'Pathfinder-Result', size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        this._readbackBuffer = this.device.createBuffer({
            label: 'Pathfinder-Readback', size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
    }

    /**
     * @param {GPUCommandEncoder} encoder
     * @param {object} actorPos {x,y,z}
     * @param {object} goalWorld {x,y,z}
     * @param {object} planetConfig
     * @param {GPUBuffer} closeTreeBuf
     * @param {GPUBuffer} closeTreeCountBuf
     * @param {number} maxColliders
     * @param {number} actorRadius
     */
    dispatch(encoder, actorPos, goalWorld, planetConfig, closeTreeBuf, closeTreeCountBuf, maxColliders, actorRadius) {
        if (!this._initialized || this._readbackState !== 'idle') return;
        if (!closeTreeBuf || !closeTreeCountBuf) return;

        const o = planetConfig.origin || { x: 0, y: 0, z: 0 };
        const cellSize = 1.0;

        // Compute tangent frame at actor position
        const upX = actorPos.x - o.x, upY = actorPos.y - o.y, upZ = actorPos.z - o.z;
        const upLen = Math.hypot(upX, upY, upZ) || 1;
        const ux = upX / upLen, uy = upY / upLen, uz = upZ / upLen;

        const refAbs = Math.abs(uy) > 0.99;
        const refX = refAbs ? 0 : 0, refY = refAbs ? 0 : 1, refZ = refAbs ? 1 : 0;
        let rx = uy * refZ - uz * refY;
        let ry = uz * refX - ux * refZ;
        let rz = ux * refY - uy * refX;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        let fx = ry * uz - rz * uy;
        let fy = rz * ux - rx * uz;
        let fz = rx * uy - ry * ux;

        // Goal in local 2D
        const gdx = goalWorld.x - actorPos.x;
        const gdy = goalWorld.y - actorPos.y;
        const gdz = goalWorld.z - actorPos.z;
        const goalLocalX = gdx * rx + gdy * ry + gdz * rz;
        const goalLocalY = gdx * fx + gdy * fy + gdz * fz;

        // Write params
        const buf = new ArrayBuffer(256);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        f32[0] = actorPos.x; f32[1] = actorPos.y; f32[2] = actorPos.z; f32[3] = cellSize;
        f32[4] = o.x; f32[5] = o.y; f32[6] = o.z; f32[7] = planetConfig.radius;
        f32[8] = goalLocalX; f32[9] = goalLocalY;
        u32[10] = maxColliders; f32[11] = 0.08; f32[12] = 0.35; f32[13] = actorRadius;
        f32[14] = rx; f32[15] = ry; f32[16] = rz; f32[17] = 0;
        f32[18] = fx; f32[19] = fy; f32[20] = fz; f32[21] = 0;
        f32[22] = ux; f32[23] = uy; f32[24] = uz; f32[25] = 0;
        u32[26] = 0; // jfaStep placeholder, overwritten per pass

        this.device.queue.writeBuffer(this._paramsBuffer, 0, buf);

        // Rebuild bind groups
        this._rebuildBGs(closeTreeBuf, closeTreeCountBuf);
        if (!this._clearBG) return;

        const wgCount = Math.ceil(GRID_CELLS / 64);

        // Pass A: clear + rasterize obstacles
        {
            const pass = encoder.beginComputePass({ label: 'Pathfinder-Clear' });
            pass.setPipeline(this._clearPipeline);
            pass.setBindGroup(0, this._clearBG);
            pass.dispatchWorkgroups(wgCount);
            pass.end();
        }

        // Pass B: JFA iterations (ping-pong between gridA and gridB)
        let readFromA = true;
        for (let i = 0; i < JFA_PASSES; i++) {
            const step = 1 << (JFA_PASSES - 1 - i);
            // Update jfaStep in params
            const stepBuf = new Uint32Array([step]);
            this.device.queue.writeBuffer(this._paramsBuffer, 26 * 4, stepBuf);

            const pass = encoder.beginComputePass({ label: `Pathfinder-JFA-${i}` });
            pass.setPipeline(this._jfaPipeline);
            pass.setBindGroup(0, readFromA ? this._bindGroupA : this._bindGroupB);
            pass.dispatchWorkgroups(wgCount);
            pass.end();
            readFromA = !readFromA;
        }

        // Pass C: read gradient (reads from whichever grid is current)
        {
            const pass = encoder.beginComputePass({ label: 'Pathfinder-Grad' });
            pass.setPipeline(this._gradPipeline);
            // After JFA, result is in gridB if readFromA, gridA if !readFromA
            // gradBG reads from grid (binding 3). We need the one that was last written to.
            pass.setBindGroup(0, readFromA ? this._gradBGA : this._gradBGB);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        encoder.copyBufferToBuffer(this._resultBuffer, 0, this._readbackBuffer, 0, 16);
        this._readbackState = 'copied';
    }

    /**
     * @returns {Promise<{dirX:number, dirY:number, dist:number, valid:boolean}|null>}
     * Direction is in local tangent-plane coords (right, forward).
     */
    resolveResult() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);
        this._readbackState = 'mapping';
        return this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const f = new Float32Array(this._readbackBuffer.getMappedRange(0, 16));
            const result = {
                dirX: f[0], dirY: f[1], dist: f[2], valid: f[3] > 0.5,
            };
            this._readbackBuffer.unmap();
            this._readbackState = 'idle';
            return result;
        }).catch(() => { this._readbackState = 'idle'; return null; });
    }

    _rebuildBGs(ctBuf, ctcBuf) {
        // clearBG: reads from grid (A), writes obstacles into grid (A)
        // Actually clear+rasterize only writes grid, no ping-pong needed
        this._clearBG = this.device.createBindGroup({
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: { buffer: ctBuf } },
                { binding: 2, resource: { buffer: ctcBuf } },
                { binding: 3, resource: { buffer: this._gridA } },
                { binding: 4, resource: { buffer: this._gridB } },
                { binding: 5, resource: { buffer: this._resultBuffer } },
            ],
        });

        // JFA A→B: grid=A (read), gridB=B (write)
        this._bindGroupA = this._clearBG; // same layout, A as primary

        // JFA B→A: grid=B (read), gridB=A (write)
        this._bindGroupB = this.device.createBindGroup({
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: { buffer: ctBuf } },
                { binding: 2, resource: { buffer: ctcBuf } },
                { binding: 3, resource: { buffer: this._gridB } },
                { binding: 4, resource: { buffer: this._gridA } },
                { binding: 5, resource: { buffer: this._resultBuffer } },
            ],
        });

        // Gradient: reads from A (final if even # passes)
        this._gradBGA = this._clearBG;
        this._gradBGB = this._bindGroupB;
    }

    dispose() {
        this._paramsBuffer?.destroy();
        this._gridA?.destroy();
        this._gridB?.destroy();
        this._resultBuffer?.destroy();
        this._readbackBuffer?.destroy();
    }
}