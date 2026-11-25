// @ts-nocheck
// The air between the camera and the ground, as a table made every frame. For one camera altitude the transmittance of a
// path, and the Rayleigh share of what it scatters, depend on the ground's height and its distance alone; the sun's
// light on the path changes so slowly that the terrain's vertices carry it.

import { getAerialPerspectiveWGSL } from '../../atmosphere/shaders/aerialPerspectiveCommon.js';

export const AIR_DISTANCES = 128;
export const AIR_HEIGHTS = 65;
export const AIR_FRAME_FLOATS = 20;
const LOWEST = -400;
// Over this the camera's own altitude no longer needs the fine rows: the ground's does.
const LOW_CAMERA_M = 700;

/** The frame's numbers for the table and for reading it. atmosphere: uniforms of the terrain; altitude, top: m. */
export function airFrame({ altitude, radius, top, nearest = 380 }) {
    const high = Math.max(top, 1000);
    const r = radius + altitude;
    const from = Math.max(nearest, altitude - high);
    const horizon = h => Math.sqrt(Math.max(0, h * h - (radius - 300) ** 2));
    const to = Math.max(1.5 * from, 1.02 * (horizon(r) + horizon(radius + high)));
    const middle = Math.min(high - 10, Math.max(LOWEST + 10, altitude < LOW_CAMERA_M ? altitude : 0));
    return { log0: Math.log2(from), log1: Math.log2(to), middle, below: middle - LOWEST, above: high - middle };
}

/** Table coordinates of a height (m over the planet's radius) and a distance: the shader's airUv, for tests. */
export function airUv(f, height, distance) {
    const d = height - f.middle;
    const v = 0.5 + 0.5 * Math.sign(d) * Math.sqrt(Math.min(1, Math.abs(d) / (d < 0 ? f.below : f.above)));
    const u = Math.min(1, Math.max(0, (Math.log2(distance) - f.log0) / (f.log1 - f.log0)));
    return [(u * (AIR_DISTANCES - 1) + 0.5) / AIR_DISTANCES, (v * (AIR_HEIGHTS - 1) + 0.5) / AIR_HEIGHTS];
}

export const AIR_FRAME_WGSL = /* wgsl */`
struct AirFrame {
    range: vec4<f32>,    // log2 of the nearest distance and of the farthest, height of the middle row, height of the camera (m)
    heights: vec4<f32>,  // metres below and above the middle row, 1 over both
    planet: vec4<f32>,   // radius, the air's top (radius), scale heights
    rayleigh: vec4<f32>, // scattering, Mie's
    sun: vec4<f32>,      // from, to: where the air sets in (m), Mie's anisotropy, sun
};
`;

/** For the terrain's fragment shader: the colour behind the air. */
export const AIR_READ_WGSL = /* wgsl */`
fn throughAir(color: vec3<f32>, height: f32, distance: f32, toEye: vec3<f32>, sunDir: vec3<f32>, sunlight: vec3<f32>) -> vec3<f32> {
    let d = height - air.range.z;
    let v = 0.5 + 0.5 * sign(d) * sqrt(min(abs(d) * select(air.heights.w, air.heights.z, d < 0.0), 1.0));
    let u = saturate((log2(distance) - air.range.x) / (air.range.y - air.range.x));
    let at = (vec2<f32>(u, v) * ${`vec2<f32>(${AIR_DISTANCES - 1}.0, ${AIR_HEIGHTS - 1}.0)`} + 0.5) / vec2<f32>(${AIR_DISTANCES}.0, ${AIR_HEIGHTS}.0);
    let through = textureSampleLevel(airTable, clampSampler, at, 0, 0.0).rgb;
    let share = textureSampleLevel(airTable, clampSampler, at, 1, 0.0).rgb;
    let c = -dot(toEye, sunDir);
    let g = air.sun.z;
    let x = 1.0 + g * g - 2.0 * g * c;
    let rayleigh = 0.0596831 * (1.0 + c * c);
    let mie = 0.0795775 * (1.0 - g * g) / max(x * sqrt(x), 0.0001);
    let reach = smoothstep(air.sun.x, air.sun.y, distance);
    let scattered = (share * rayleigh + (1.0 - share) * mie) * (1.0 - through) * sunlight;
    return color * mix(vec3<f32>(1.0), through, reach) + scattered * reach;
}
`;

/** For the terrain's vertex shader: the sun's light along the path to a point (from the planet's centre). */
export const AIR_SUN_WGSL = /* wgsl */`
fn sunOnPath(p: vec3<f32>, camera: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
    let along = p - camera;
    let distance = length(along);
    let dir = along / max(distance, 0.001);
    let b = dot(camera, dir);
    let disc = b * b - (dot(camera, camera) - air.planet.y * air.planet.y);
    var enter = 0.0;
    if (disc > 0.0) { enter = clamp(-b - sqrt(disc), 0.0, distance); }
    let middle = camera + dir * (0.5 * (enter + distance));
    let r = length(middle);
    let up = normalize(p);
    let facing = dot(sunDir, up);
    let light = ap_sampleTransmittance(transmittanceLUT, landSampler, clamp(r - air.planet.x, 0.0, air.planet.y - air.planet.x), dot(sunDir, middle / r), air.planet.x, air.planet.y);
    // Fades across the terminator with the ground's own up, as its daylight does.
    return light * (smoothstep(-0.08, 0.08, facing) * mix(0.2, 1.0, smoothstep(-0.10, 0.10, facing)) * air.sun.w);
}
`;

export function buildAirTableWGSL() {
    return /* wgsl */`${AIR_FRAME_WGSL}${getAerialPerspectiveWGSL()}
@group(0) @binding(0) var<uniform> air: AirFrame;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var table: texture_storage_2d_array<rgba16float, write>;
// ap_computeSimple's transmittance and mix, for a path given by its ends' heights and its length.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.y >= ${AIR_HEIGHTS}u) { return; }
    let distance = exp2(mix(air.range.x, air.range.y, f32(id.x) / ${AIR_DISTANCES - 1}.0));
    let v = f32(id.y) / ${AIR_HEIGHTS - 1}.0 * 2.0 - 1.0;
    let ground = air.range.z + v * abs(v) * select(air.heights.y, air.heights.x, v < 0.0);
    let camera = air.range.w;
    let radius = air.planet.x;
    let top = air.planet.y - radius;
    let rc = radius + camera;
    let rg = radius + ground;
    // Cosines of the path to the vertical at both ends, away from the camera.
    let rise = (ground - camera) * (rg + rc);
    let atCamera = clamp((rise - distance * distance) / (2.0 * rc * distance), -1.0, 1.0);
    let atGround = clamp((rise + distance * distance) / (2.0 * rg * distance), -1.0, 1.0);
    var low = ground; var high = camera; var upLow = -atGround; var upHigh = -atCamera;
    if (camera < ground) { low = camera; high = ground; upLow = atCamera; upHigh = atGround; }
    let tLow = ap_sampleTransmittance(lut, lutSampler, clamp(low, 0.0, top), upLow, radius, air.planet.y);
    var tHigh = vec3<f32>(1.0);
    if (high < top) { tHigh = ap_sampleTransmittance(lut, lutSampler, max(high, 0.0), upHigh, radius, air.planet.y); }
    let through = clamp(tLow / max(tHigh, vec3<f32>(1.0e-4)), vec3<f32>(0.0), vec3<f32>(1.0));
    let steep = max(abs(upLow), 0.02);
    let density = ap_getDensity(max(low, 0.0), air.planet.z, air.planet.w);
    let wR = air.rayleigh.xyz * density.x * min(distance, air.planet.z / steep);
    let wM = vec3<f32>(air.rayleigh.w * density.y * min(distance, air.planet.w / steep));
    textureStore(table, id.xy, 0, vec4<f32>(through, 1.0));
    textureStore(table, id.xy, 1, vec4<f32>(wR / max(wR + wM, vec3<f32>(1.0e-12)), 1.0));
}
`;
}

export class TerrainAir {
    constructor(device) {
        this.device = device;
        this.frame = device.createBuffer({ label: 'Terrain air', size: AIR_FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._data = new Float32Array(AIR_FRAME_FLOATS);
        this.table = device.createTexture({
            label: 'Terrain air', size: [AIR_DISTANCES, AIR_HEIGHTS, 2], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.view = this.table.createView({ dimension: '2d-array' });
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        const C = GPUShaderStage.COMPUTE;
        this._layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: C, buffer: { type: 'uniform' } },
            { binding: 1, visibility: C, texture: { sampleType: 'float' } },
            { binding: 2, visibility: C, sampler: {} },
            { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
        ] });
        this._pipeline = device.createComputePipeline({
            label: 'Terrain air', layout: device.createPipelineLayout({ bindGroupLayouts: [this._layout] }),
            compute: { module: device.createShaderModule({ label: 'Terrain air', code: buildAirTableWGSL() }), entryPoint: 'main' },
        });
    }

    /** u: the terrain's uniforms. lutView: the atmosphere's transmittance. fade: where the air sets in (m). */
    update(encoder, { u, lutView, altitude, top, fade }) {
        const radius = u.atmospherePlanetRadius.value;
        const f = airFrame({ altitude, radius, top });
        const r = u.atmosphereRayleighScattering.value;
        this._data.set([
            f.log0, f.log1, f.middle, altitude,
            f.below, f.above, 1 / f.below, 1 / f.above,
            radius, u.atmosphereRadius.value, u.atmosphereScaleHeightRayleigh.value, u.atmosphereScaleHeightMie.value,
            r.x, r.y, r.z, u.atmosphereMieScattering.value,
            fade.start, fade.end, u.atmosphereMieAnisotropy.value, u.atmosphereSunIntensity.value,
        ]);
        this.device.queue.writeBuffer(this.frame, 0, this._data);
        if (this._lutView !== lutView) {
            this._lutView = lutView;
            this._group = this.device.createBindGroup({ layout: this._layout, entries: [{ buffer: this.frame }, lutView, this.sampler, this.view].map((resource, binding) => ({ binding, resource })) });
        }
        const pass = encoder.beginComputePass({ label: 'Terrain air' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._group);
        pass.dispatchWorkgroups(AIR_DISTANCES / 8, Math.ceil(AIR_HEIGHTS / 8));
        pass.end();
    }

    destroy() {
        this.frame.destroy();
        this.table.destroy();
    }
}
