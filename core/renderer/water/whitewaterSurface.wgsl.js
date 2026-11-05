// core/renderer/water/whitewaterSurface.wgsl.js
//
// The simulated water's surface (WhitewaterSim.js): one grid per stepped block,
// a vertex per cell, moving with the solver: the height, its slope for the
// normal, a chop that follows the turbulence. Mixed by the block weights toward
// the baked level, flow and foam, where the middle tier takes over in the same
// look (whitewaterLook.wgsl.js).
//
// Whitewater drops its dry vertices under the bed, which draws its sawtooth
// waterline. Here a dry cell beside water keeps that water's height, and the
// terrain's depth draws the shoreline wherever the surface meets the ground.

import { commonWgsl, shadeWgsl } from './nearWaterSurface.wgsl.js';
import { WHITE_UNIFORMS_WGSL, whitewaterLookWgsl } from './whitewaterLook.wgsl.js';
import { WHITE_BAKED_WORD_WGSL, WHITE_BLOCK } from '../../world/water/whitewaterSim.wgsl.js';

export const WHITE_GRID = WHITE_BLOCK + 1;
// Baked water is kept this far (m) beyond the field's water, as the middle tier's.
const KEEP_M = 1.5;

const VOUT = /* wgsl */`
struct WhiteVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) xy: vec2<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) flow: vec4<f32>,   // velocity, foam, turbulence
    @location(4) wet: vec3<f32>,    // depth (m), signed distance (m), simulated share
};
@group(2) @binding(0) var<uniform> W: WhiteU;
@group(2) @binding(1) var<storage, read> BLOCKS: array<vec4<i32>>;
@group(2) @binding(2) var<storage, read> GRID: array<vec2<f32>>;
${WHITE_UNIFORMS_WGSL}
`;

export function buildWhitewaterVertexShader() {
    return commonWgsl() + VOUT + /* wgsl */`
@group(2) @binding(3) var<storage, read> ST: array<vec4<f32>>;
@group(2) @binding(4) var<storage, read> S: array<vec4<f32>>;
@group(2) @binding(5) var<storage, read> K: array<f32>;
${WHITE_BAKED_WORD_WGSL}

fn whiteBakedFoam(foam: f32, xy: vec2<f32>) -> f32 {
    return foam * W.foamGain * (0.45 + 1.1 * waterNoise(xy * 0.085 + 3.1));
}
fn wrapC(a: i32) -> i32 { let n = i32(W.N); return select(select(a, a - n, a >= n), a + n, a < 0); }
fn ci(i: i32, j: i32) -> u32 { return u32(wrapC(j)) * W.N + u32(wrapC(i)); }
fn etaOr(i: i32, j: i32, fallback: f32) -> f32 {
    let id = ci(i, j);
    let h = S[id].x;
    return select(fallback, ST[id * 2u].x + h, h > W.hmin);
}
// Drawn weight of a cell: the blocks' weights, bilinear between block centres.
fn drawnAt(i: i32, j: i32) -> f32 {
    let B = f32(W.blockCells);
    let gx = (f32(i) + 0.5) / B - 0.5; let gy = (f32(j) + 0.5) / B - 0.5;
    let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
    let G = i32(W.gridBlocks);
    let a = i32(x0); let b = i32(y0);
    let ax = select(select(a, a - G, a >= G), a + G, a < 0); let ax1 = select(ax + 1, 0, ax + 1 >= G);
    let by = select(select(b, b - G, b >= G), b + G, b < 0); let by1 = select(by + 1, 0, by + 1 >= G);
    return mix(mix(GRID[by * G + ax].y, GRID[by * G + ax1].y, fx), mix(GRID[by1 * G + ax].y, GRID[by1 * G + ax1].y, fx), fy);
}

@vertex
fn main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> WhiteVOut {
    let blk = BLOCKS[ii];
    let n = ${WHITE_GRID}u;
    let lx = i32(vi % n); let ly = i32(vi / n);
    let i = blk.z * i32(W.blockCells) + lx; let j = blk.w * i32(W.blockCells) + ly;
    let xy = (vec2<f32>(vec2<i32>(blk.x * i32(W.blockCells) + lx, blk.y * i32(W.blockCells) + ly)) + 0.5) * W.dx;
    let id = ci(i, j);
    let s = S[id];
    let st = ST[id * 2u]; let baked = ST[id * 2u + 1u];
    let bed = st.x; let h = s.x; let dx = W.dx;
    let wet = h > W.hmin;

    // A dry cell takes the height of the water next to it, or stays out of sight.
    var eta = bed + h;
    if (!wet) {
        var sum = 0.0; var cnt = 0.0;
        for (var v = -1; v <= 1; v++) { for (var u = -1; u <= 1; u++) {
            let q = ci(i + u, j + v);
            if (S[q].x > W.hmin) { sum += ST[q * 2u].x + S[q].x; cnt += 1.0; }
        } }
        eta = select(bed - 0.4, sum / max(cnt, 1.0), cnt > 0.0);
    }
    let eL = etaOr(i - 1, j, eta); let eR = etaOr(i + 1, j, eta);
    let eD = etaOr(i, j - 1, eta); let eU = etaOr(i, j + 1, eta);
    // The pattern's velocity, averaged over a few cells for the same reason.
    let sE = S[ci(i + 2, j)]; let sW = S[ci(i - 2, j)]; let sN = S[ci(i, j + 2)]; let sS = S[ci(i, j - 2)];
    let uc = 0.2 * (s.y + sE.y + sW.y + sN.y + sS.y); let vc = 0.2 * (s.z + sE.z + sW.z + sN.z + sS.z);
    let k = K[id];
    let draw = drawnAt(i, j);

    // Chop on the surface where the water is turbulent (Whitewater's vsWater).
    let camD = distance(xy, W.cameraXY);
    let amp = W.waveAmp * k * smoothstep(0.08, 0.45, k) * smoothstep(0.0, 0.35, h) * draw * (1.0 - smoothstep(0.6 * W.nearFadeM.x, W.nearFadeM.x, camD));
    let a1 = dot(xy, vec2<f32>(2.3, 0.9)) - W.time * 6.0;
    let a2 = dot(xy, vec2<f32>(-1.1, 2.4)) - W.time * 4.7;
    let a3 = dot(xy, vec2<f32>(3.9, 3.3)) - W.time * 8.1;
    let chop = amp * (sin(a1) + sin(a2) + 0.6 * sin(a3));
    let gx = (eR - eL) / (2.0 * dx) + amp * (2.3 * cos(a1) - 1.1 * cos(a2) + 2.34 * cos(a3));
    let gy = (eU - eD) / (2.0 * dx) + amp * (0.9 * cos(a1) + 2.4 * cos(a2) + 1.98 * cos(a3));

    let dir = whiteFrameDir(xy);
    let height = mix(baked.x, eta + chop, draw);
    let foam0 = bakedFoam(baked.w);
    let foamBaked = whiteBakedFoam(foam0, xy);
    let wp = U.origin + dir * (U.R + height);
    var o: WhiteVOut;
    o.pos = nearWaterRasterPosition(wp);
    o.wp = wp;
    o.xy = xy;
    o.normal = normalize(dir - (W.e1 * gx + W.e2 * gy) * draw);
    // The solver's foam comes from the Froude number, the far tier's from the fall: on a wide deep
    // reach that fell fast the far tier was white and this one calm, four times less foam on the same
    // spot, with block edges between them (owner 2026-11-05, green star). So the far tier's is a floor.
    o.flow = vec4<f32>(mix(baked.yz, vec2<f32>(uc, vc), draw), mix(foamBaked, max(s.w, foamBaked), draw), mix(foam0 * 0.6, max(k, foam0 * 0.6), draw));
    o.wet = vec3<f32>(h, mix(st.w, select(-16.0, 16.0, wet), draw), draw);
    return o;
}
`;
}

export function buildWhitewaterFragmentShader() {
    return commonWgsl() + VOUT + shadeWgsl() + whitewaterLookWgsl() + /* wgsl */`
@fragment
fn main(in: WhiteVOut) -> @location(0) vec4<f32> {
    if (nearWaterBehind(in.wp, in.pos.xy) <= 0.0) { discard; }
    if (in.wet.y < -${KEEP_M.toFixed(2)}) { discard; }
    if (waterParams.debugMode == 6u) { return vec4<f32>(WATER_OWNER_ON, 0.0, WATER_OWNER_ON, 0.0); }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    if (waterParams.debugMode >= 11u && waterParams.debugMode <= 15u) {
        return whiteDebug(waterParams.debugMode, in.flow.xy, in.flow.z, in.flow.w, max(in.wet.x, 0.02), vec3<f32>(1.0, 0.2, 0.85));
    }
    let dir = normalize(in.wp - U.origin);
    let N = normalize(in.normal);
    // Shallow water at the edges carries little foam.
    let foam = in.flow.z * smoothstep(0.03, 0.4, in.wet.x);
    let c = nearWaterCompose(in.wp, dir, whiteSurface(in.wp, N, in.xy, in.flow.xy, foam, in.flow.w, in.pos.xy), in.pos.xy, N);
    if (c.a <= 0.0) { discard; }
    // Thin water fades by its own depth, as Whitewater's does: the solver's bed
    // is not the rendered ground to the centimetre, and without this the surface
    // ended on a hard, stepped line along the banks.
    return c * mix(1.0, smoothstep(0.0, 0.14, in.wet.x), in.wet.z);
}
`;
}
