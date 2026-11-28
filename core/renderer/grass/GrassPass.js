// @ts-nocheck
// Grass blades about the camera (grassWgsl.js). Made on the GPU from the ground the terrain draws, and kept: each frame
// the patches about the camera are found; a patch alike last frame (the same tile, mesh and distance step) carries its
// tufts over, others are made anew; then the blades to draw are chosen. Nothing streams from the CPU. Drawn opaque
// without discard, so the GPU's hidden-surface removal keeps shading to about one blade fragment a pixel.

import {
    BLADES_PER_INSTANCE, CONTROL_WORDS, CTRL, CTRL_REMAP, FRAME_FLOATS, HASH_CAP, LOD_CAPACITY, LOD_SEGMENTS, MAX_PATCHES,
    PATCH_WORDS, RECORD_WORDS, STORE_CAP, WAVE_PERIOD,
    buildGrassComputeWGSL, buildGrassDrawWGSL,
} from './grassWgsl.js';
import { GroundFrame } from '../../world/ecology/GroundFrame.js';
import { WindField } from '../../world/ecology/WindField.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => a.map(x => x * k);
const unit = a => scale(a, 1 / (length(a) || 1));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Defaults of rendering.grass. */
export const GRASS_DEFAULTS = Object.freeze({
    enabled: true,
    /** Blades end here (m); the terrain's grass canopy goes on. */
    distance: 240,
    /**
     * Blades per square metre close by (grass 35 cm tall), the distance (m) from which they thin, and how fast: as 1 / d
     * the ground stays hidden at all distances (grassWgsl.js).
     */
    density: 1500,
    thinFrom: 2,
    /** Distance bands of finer and coarser blades (m). */
    bands: [9.5, 24],
    /**
     * No strip drawn thinner than this many pixels, widened at most so much; its colour mixed with the field's by the
     * share it truly covers (grassWgsl.js vsMain). Thinner, strips fell on pixels' middles or between them.
     */
    minPixels: 1.25,
    maxWiden: 32,
    /**
     * From where a typical blade (1.1 cm) is this many pixels wide, blades thin out as 1 / d^2 while they are widened
     * as d: fewer, wider blades, the same cover. Under minPixels keeps them dense further (here about 21 m).
     */
    thinPixels: 0.6,
    /**
     * The sine of the sight line's elevation from which blades stand at full density: as many as hide the ground at
     * that slant, out to where they are resolved (grassWgsl.js densityAt). 0.9 from standing height is thinFrom's 1 / d.
     */
    fullSlant: 0.9,
    /**
     * Grass blades' width over what they are made with: a little wider near, growing to `far` between `from` and `to`
     * metres (their strokes too). Thicker, a field reads as grass farther off; GrassWorks' blades (1 : 20 of their
     * height) were judged too thick, ours are made 1 : 30-50.
     */
    thickness: { near: 1.25, far: 1.25, from: 3, to: 30 },
});

/**
 * Grass blades' width, to compare live (GRASS_DEFAULTS.thickness takes one): as made, then four steps to about
 * GrassWorks' blade (0.12 wide for 2.4 tall, 1 : 20; ours are made 1 : 30 for a meadow, thinner for dry grass). The
 * same at every distance, to compare the width alone (thickness can also grow from `near` to `far`).
 */
export const GRASS_THICKNESS_TIERS = Object.freeze([
    { name: 'as made', near: 1.0, far: 1.0, from: 3, to: 30 },
    { name: 'slightly thicker', near: 1.25, far: 1.25, from: 3, to: 30 },
    { name: 'thicker', near: 1.5, far: 1.5, from: 3, to: 30 },
    { name: 'thick', near: 1.8, far: 1.8, from: 3, to: 30 },
    { name: 'about GrassWorks', near: 2.2, far: 2.2, from: 3, to: 30 },
]);
/** Which of GRASS_THICKNESS_TIERS a grass config's thickness is, or -1. */
export function grassThicknessIndex(config) {
    const t = config?.thickness;
    return GRASS_THICKNESS_TIERS.findIndex(x => t && x.near === t.near && x.far === t.far && x.from === t.from && x.to === t.to);
}
/** Sets a grass config's thickness to a tier (the next one when none is given); returns its index. */
export function setGrassThickness(config, index = (Math.max(grassThicknessIndex(config), 0) + 1) % GRASS_THICKNESS_TIERS.length) {
    const { name: _name, ...tier } = GRASS_THICKNESS_TIERS[index];
    config.thickness = tier;
    return index;
}

export class GrassPass {
    /**
     * @param {object} o device, backend, tileManager, ground (createGroundMaterials), landLight (TerrainLightMap),
     *   planetConfig, biome (landscape rules or null), config (rendering.grass), grain (createGrassGrain)
     */
    constructor(o) {
        Object.assign(this, o);
        this.config = { ...GRASS_DEFAULTS, ...(o.config ?? {}) };
        this.enabled = this.config.enabled !== false;
        /** For measuring: workgroups per patch made (0: by how many are made, 1-16: fixed). */
        this.splitMaking = 0;
        /** For measuring: the field as it is (no distance shortcuts in the blades' light), drawn zoomed in (grassRig.js zoomTruth). */
        this.teacher = false;
        /** For measuring: false reads every kept blade in the select, in view or not. */
        this.cullPatches = true;
        /** For measuring: the blades are made but not drawn. */
        this.drawBlades = true;
        this._frame = new ArrayBuffer(FRAME_FLOATS * 4);
        this._f = new Float32Array(this._frame);
        this._i = new Int32Array(this._frame);
        this._u = new Uint32Array(this._frame);
        this._time = 0;
        this._ready = false;
        this._drawing = false;
    }

    static supported(device, tileManager) {
        return device.features.has('indirect-first-instance') && !!tileManager?.quadtreeGPU?.getLoadedTileTableBuffer?.()
            && !!tileManager.quadtreeGPU._visibleTableBuffer && device.limits.maxStorageBuffersPerShaderStage >= 7;
    }

    async initialize() {
        const { device } = this;
        const U = GPUBufferUsage;
        const buffer = (label, size, usage) => device.createBuffer({ label: `Grass ${label}`, size, usage });
        const bladeCount = LOD_CAPACITY.reduce((a, b) => a + b, 0);
        this._frameBuffer = buffer('frame', FRAME_FLOATS * 4, U.UNIFORM | U.COPY_DST);
        this._patches = buffer('patches', MAX_PATCHES * PATCH_WORDS * 4, U.STORAGE | U.COPY_SRC);
        this._control = buffer('control', CONTROL_WORDS * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC);
        // The kept tufts' blades, two halves: this frame's, made from last frame's.
        this._store = buffer('store', 2 * STORE_CAP * RECORD_WORDS * 4, U.STORAGE);
        // The blades drawn this frame, as the vertex shader takes them (selectMain).
        this._bandIndex = buffer('drawn', bladeCount * 48, U.STORAGE);
        this._patchHash = buffer('patch table', 2 * HASH_CAP * 8 * 4, U.STORAGE | U.COPY_DST);
        this._parity = 0;
        // The blades' dispatch, and the bands' draws: two buffers, as one is read while the other is written.
        this._dispatchArgs = buffer('dispatch', 16 * 4, U.STORAGE | U.INDIRECT);
        this._args = buffer('draws', 20 * 4, U.STORAGE | U.INDIRECT | U.COPY_SRC);
        this._clamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

        const C = GPUShaderStage.COMPUTE, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
        const at = (binding, visibility, rest) => ({ binding, visibility, ...rest });
        const storage = { buffer: { type: 'storage' } };
        const array = { texture: { sampleType: 'float', viewDimension: '2d-array' } };
        this._layouts = {
            work: device.createBindGroupLayout({ entries: [
                at(0, C, { buffer: { type: 'uniform' } }), at(1, C, { buffer: { type: 'read-only-storage' } }),
                at(2, C, storage), at(3, C, storage), at(4, C, storage), at(5, C, storage), at(6, C, { buffer: { type: 'read-only-storage' } }),
                at(7, C, storage), at(8, C, storage),
                // The shared ground frame (drawnGround.wgsl.js) and wind (wind.wgsl.js).
                at(9, C, { buffer: { type: 'uniform' } }), at(10, C, { buffer: { type: 'uniform' } }),
            ] }),
            ground: device.createBindGroupLayout({ entries: [
                at(0, C, { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } }),
                at(1, C, array), at(2, C, array), at(3, C, array), at(4, C, { sampler: {} }), at(5, C, { sampler: {} }),
                at(6, C, { buffer: { type: 'uniform' } }), at(7, C, array), at(8, C, array), at(9, C, { texture: { sampleType: 'float' } }), at(10, C, array),
            ] }),
            draw: device.createBindGroupLayout({ entries: [
                at(0, V | F, { buffer: { type: 'uniform' } }), at(1, V, { buffer: { type: 'read-only-storage' } }),
            ] }),
        };
        const faceSizeMeters = 2 * this.planetConfig.radius;
        const skip = this.skip ?? {};
        const segments = this.segments ?? LOD_SEGMENTS;
        const work = device.createShaderModule({ label: 'Grass scatter', code: buildGrassComputeWGSL({ faceSizeMeters, biome: this.biome ?? null, skip, segments, fullSlant: this.config.fullSlant }) });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this._layouts.work, this._layouts.ground] });
        const step = entryPoint => device.createComputePipelineAsync({ label: `Grass ${entryPoint}`, layout, compute: { module: work, entryPoint } });
        const blade = (label, perVertex) => {
            const module = device.createShaderModule({ label, code: buildGrassDrawWGSL({ skip, segments, perVertex }) });
            return device.createRenderPipelineAsync({
                label,
                layout: device.createPipelineLayout({ bindGroupLayouts: [this._layouts.draw] }),
                vertex: { module, entryPoint: 'vsMain' },
                fragment: { module, entryPoint: 'fsMain', targets: [{ format: this.backend.sceneFormat || this.backend.format }] },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
            });
        };
        // The far bands' blades are a few pixels wide: lit at their vertices (perVertexFar), the fragment is flat.
        const perVertexFar = this.perVertexFar ?? this.config.perVertexFar ?? false;
        // Each band's strips as triangles, BLADES_PER_INSTANCE blades an instance.
        this._indexBuffers?.forEach(b => b.destroy());
        this._indexBuffers = segments.map(rows => {
            const n = 2 * rows + 1, triangles = n - 2, index = new Uint16Array(BLADES_PER_INSTANCE * triangles * 3);
            for (let k = 0; k < BLADES_PER_INSTANCE; k++) for (let i = 0; i < triangles; i++) index.set([k * n + i, k * n + i + 1, k * n + i + 2], (k * triangles + i) * 3);
            const b = device.createBuffer({ label: 'Grass strips', size: index.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(b, 0, index);
            return b;
        });
        const names = ['patches', 'dispatch', 'copy', 'generate', 'selectDispatch', 'select', 'finish'];
        const made = await Promise.all([
            ...names.map(name => step(`${name}Main`)),
            blade('Grass blades', false), perVertexFar ? blade('Grass blades, far', true) : null,
        ]);
        this._steps = Object.fromEntries(names.map((name, i) => [name, made[i]]));
        const [render, renderFar] = made.slice(names.length);
        this._render = render;
        this._renderFar = renderFar ?? render;
        const quadtree = this.tileManager.quadtreeGPU;
        this._groundFrame = new GroundFrame(device, { label: 'Grass ground frame' });
        this._wind = new WindField(device, { label: 'Grass wind' });
        const workGroup = args => device.createBindGroup({ layout: this._layouts.work, entries: [
            this._frameBuffer, quadtree.getLoadedTileTableBuffer(), this._patches, this._control, this._store, args, quadtree._visibleTableBuffer,
            this._bandIndex, this._patchHash, this._groundFrame.buffer, this._wind.buffer,
        ].map((b, binding) => ({ binding, resource: { buffer: b } })) });
        this._dispatchGroup = workGroup(this._dispatchArgs);
        this._drawArgsGroup = workGroup(this._args);
        this._drawGroup = device.createBindGroup({ layout: this._layouts.draw, entries: [
            this._frameBuffer, this._bandIndex,
        ].map((b, binding) => ({ binding, resource: { buffer: b } })) });
        this._ready = true;
    }

    _ensureGroundGroup() {
        const textures = this.tileManager.getArrayTextures();
        const view = name => textures[name]?._gpuTexture?.view;
        const land = this.landLight.resources;
        const parts = [view('height'), view('normal'), (this.biome && view('climate')) || view('normal'), this.ground.surfaceView,
            this.ground.wideSampler, this._clamp, land.frame, land.map, view('splatIndex'), this.grain.view, this.portraits.view];
        if (parts.some(p => !p)) return false;
        if (this._groundOf && this._groundOf.every((x, i) => x === parts[i])) return true;
        this._groundOf = parts;
        this._groundGroup = this.device.createBindGroup({ layout: this._layouts.ground, entries: parts.map((resource, binding) => ({
            binding, resource: resource instanceof GPUBuffer ? { buffer: resource } : resource,
        })) });
        return true;
    }

    /**
     * Before the scene pass. u: the terrain's uniforms of this frame. environment: wind. seaLevel: m, or null.
     */
    compute(encoder, { u, camera, environment, seaLevel = null, deltaTime = 1 / 60, viewportHeight }) {
        this._drawing = false;
        if (!this.enabled || !this._ready || !this.landLight?.ready || !this._ensureGroundGroup()) return;
        const dt = Math.min(Math.max(deltaTime || 0, 0), 0.1);
        // Every sway repeats in WAVE_PERIOD (grassWgsl.js wave), so time wraps there without a jump.
        this._time = (this._time + dt) % WAVE_PERIOD;
        const c = this.config;
        const R = this.planetConfig.radius;
        const origin = u.planetOrigin.value, p = camera.position;
        const camRel = [p.x - origin.x, p.y - origin.y, p.z - origin.z];
        const up = unit(camRel);
        const altitude = length(camRel) - R;
        // Over the highest land by more than the blades reach, there is nothing to draw.
        if (altitude > this.planetConfig.maxTerrainHeight + c.distance) return;
        const pole = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const east = unit(cross(pole, up)), north = cross(up, east);
        const f = this._f, W = this._u;
        f.fill(0);

        // The view's turn alone, then the projection: for points about the camera.
        const view = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
        for (let col = 0; col < 4; col++) for (let r = 0; r < 4; r++) {
            let sum = col === 3 ? projection[r + 12] : 0;
            if (col < 3) for (let k = 0; k < 3; k++) sum += projection[r + k * 4] * view[k + col * 4];
            f[col * 4 + r] = sum;
        }
        const row = r => [f[r], f[r + 4], f[r + 8], f[r + 12]];
        const [x, y, z, w] = [0, 1, 2, 3].map(row);
        [w.map((v, i) => v + x[i]), w.map((v, i) => v - x[i]), w.map((v, i) => v + y[i]), w.map((v, i) => v - y[i]), z].forEach((plane, i) => {
            const l = Math.hypot(plane[0], plane[1], plane[2]) || 1;
            f.set(plane.map(v => v / l), 16 + i * 4);
        });

        const s = u.sunLightDirection.value, sl = Math.hypot(s.x, s.y, s.z) || 1;
        const sunColor = u.sunLightColor.value, sunI = u.sunLightIntensity.value;
        const amb = u.ambientLightColor.value, ambI = u.ambientLightIntensity.value;
        // The shared wind (WindField.js): its way, speed and the gusts carried with it, summed frame by frame.
        const { direction: wind, speed: windSpeed } = this._wind.update({ dt, environment, camRel, up, east });
        const fov = (camera.fov ?? 60) * Math.PI / 180;
        const pixelAngle = 2 * Math.tan(fov / 2) / Math.max(1, viewportHeight || 900);

        f.set([...up, R], 36);
        f.set([...east, this.planetConfig.heightScale], 40);
        f.set([...north, 2 * R], 44);
        f.set([s.x / sl, s.y / sl, s.z / sl, this._time], 48);
        f.set([sunColor.r * sunI, sunColor.g * sunI, sunColor.b * sunI, windSpeed], 52);
        f.set([amb.r * ambI, amb.g * ambI, amb.b * ambI, pixelAngle], 56);
        // What every blade pixel shares this frame (grassWgsl.js shadeBlade): the sky's light and the day, the ground's
        // bounce, how deep the sun reaches into the canopy for its height.
        {
            const sunRgb = [sunColor.r * sunI, sunColor.g * sunI, sunColor.b * sunI], ambRgb = [amb.r * ambI, amb.g * ambI, amb.b * ambI];
            const sunUp = dot(up, [s.x / sl, s.y / sl, s.z / sl]);
            const t = Math.min(1, Math.max(0, (sunUp + 0.10) / 0.30)), day = t * t * (3 - 2 * t);
            const ambMean = Math.max(dot(ambRgb, [0.333, 0.333, 0.333]), 1e-4), sunMean = dot(sunRgb, [0.333, 0.333, 0.333]);
            f.set([0, 1, 2].map(i => sunMean * 0.34 * day * (0.2 + 0.8 * ambRgb[i] / ambMean)).concat(day), 88);
            const bounceRgb = [0.115, 0.105, 0.070];
            f.set([0, 1, 2].map(i => sunRgb[i] * Math.max(sunUp, 0) * bounceRgb[i]).concat(1.6 + (0.6 - 1.6) * Math.min(1, Math.max(0, sunUp))), 92);
        }
        // Grass blades' width over what they are made with: near, far, and the distances between (grassWgsl.js vsMain).
        const t = c.thickness ?? GRASS_DEFAULTS.thickness;
        f.set([t.near, t.far, t.from, t.to], 96);
        // Bend at the tip per metre of height (gusts on top), and the sway's size: grass leans well over in a gale but
        // never lies flat, and sways a little even in still air.
        f.set([dot(wind, east), dot(wind, north), 0.75 * clamp(windSpeed / 22, 0, 1), 0.015 + 0.03 * clamp(windSpeed / 12, 0, 1)], 60);
        // Past 1440 pixels high the far tufts are not made more (the store holds about 1440's): they widen instead.
        const pixelFrom = 0.011 / ((c.thinPixels ?? c.minPixels) * Math.max(pixelAngle, 2 * Math.tan(fov / 2) / 1440));
        f.set([c.distance, c.density, c.thinFrom, pixelFrom], 64);
        // What the kept tufts were made for (how many a patch holds): other settings, or pixels 15 % another size (a
        // resize, a zoom), and they are all made again.
        const madeFor = `${c.distance}|${c.density}|${c.thinFrom}|${c.fullSlant}|${Math.round(Math.log(pixelFrom) / Math.log(1.15))}`;
        f.set([c.bands[0], c.bands[1], c.minPixels, c.maxWiden], 68);
        f.set([...camRel, seaLevel ?? -1.0e9], 72);

        // The faces near enough, each with an anchor patch about the camera, and the tiles' tables: the shared ground
        // frame (GroundFrame.js), for the blades' reach.
        const quadtree = this.tileManager.quadtreeGPU;
        const { faces, widest } = this._groundFrame.update({ camRel, radius: R, heightScale: this.planetConfig.heightScale, quadtree, reach: c.distance });
        if (!faces) return;
        // This frame's half of the cache and of the patch table; the other half is last frame's.
        this._parity ^= 1;
        W.set([this._parity, this.splitMaking ?? 0, this.cullPatches === false ? 1 : 0, this.teacher === 2 ? 2 : this.teacher ? 1 : 0], 84);
        this.device.queue.writeBuffer(this._frameBuffer, 0, this._frame);

        // This frame's counts, where last frame's patches are now, this frame's half of the patch table.
        encoder.clearBuffer(this._control, 0, CTRL.PERSIST * 4);
        encoder.clearBuffer(this._control, CTRL_REMAP * 4, MAX_PATCHES * 4);
        if (madeFor !== this._madeFor) {
            encoder.clearBuffer(this._patchHash);
            this._madeFor = madeFor;
        } else {
            encoder.clearBuffer(this._patchHash, this._parity * HASH_CAP * 32, HASH_CAP * 32);
        }
        // For measuring the steps apart (splitPasses): each its own pass, timed by its label.
        let pass = encoder.beginComputePass({ label: this.splitPasses ? 'Grass patches' : 'Grass scatter' });
        const run = (name, group) => { pass.setPipeline(this._steps[name]); pass.setBindGroup(0, group); pass.setBindGroup(1, this._groundGroup); };
        const split = label => { if (this.splitPasses) { pass.end(); pass = encoder.beginComputePass({ label }); } };
        run('patches', this._dispatchGroup);
        pass.dispatchWorkgroups(Math.ceil((2 * widest) ** 2 / 64), 1, faces);
        run('dispatch', this._dispatchGroup);
        pass.dispatchWorkgroups(1);
        split('Grass copy');
        run('copy', this._drawArgsGroup);
        pass.dispatchWorkgroupsIndirect(this._dispatchArgs, 0);
        split('Grass blades');
        run('generate', this._drawArgsGroup);
        pass.dispatchWorkgroupsIndirect(this._dispatchArgs, 12);
        split('Grass select');
        run('selectDispatch', this._dispatchGroup);
        pass.dispatchWorkgroups(1);
        run('select', this._drawArgsGroup);
        pass.dispatchWorkgroupsIndirect(this._dispatchArgs, 24);
        run('finish', this._drawArgsGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        this._drawing = true;
    }

    /** For measuring: shaders made again with parts left out (grassWgsl.js skip). */
    async rebuild(skip = {}, { segments = LOD_SEGMENTS, perVertexFar = undefined } = {}) {
        this.destroy();
        this.skip = skip;
        this.segments = segments;
        this.perVertexFar = perVertexFar;
        this._groundOf = null;
        await this.initialize();
    }

    /** Whether blades are drawn this frame. */
    get drawing() { return this._drawing; }

    draw(pass) {
        if (!this._drawing || !this.drawBlades) return;
        pass.setBindGroup(0, this._drawGroup);
        // drawBlades: true, or for measuring a mask of the bands drawn (1 near, 2 middle, 4 far).
        const bands = this.drawBlades === true ? 7 : this.drawBlades;
        for (let band = 0; band < LOD_CAPACITY.length; band++) {
            if (!(bands & (1 << band))) continue;
            pass.setPipeline(band === 0 ? this._render : this._renderFar);
            pass.setIndexBuffer(this._indexBuffers[band], 'uint16');
            pass.drawIndexedIndirect(this._args, 16 + band * 20);
        }
    }

    /** For measuring: patches and blades per band of the last frame (reads back, slow). */
    async counts() {
        const read = this.device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const readCounters = this.device.createBuffer({ size: CTRL.GENLIST * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const e = this.device.createCommandEncoder();
        e.copyBufferToBuffer(this._args, 0, read, 0, 64);
        const segments = this.segments ?? LOD_SEGMENTS;
        e.copyBufferToBuffer(this._control, 0, readCounters, 0, CTRL.GENLIST * 4);
        this.device.queue.submit([e.finish()]);
        await Promise.all([read.mapAsync(GPUMapMode.READ), readCounters.mapAsync(GPUMapMode.READ)]);
        const a = new Uint32Array(read.getMappedRange().slice(0)), k = new Uint32Array(readCounters.getMappedRange().slice(0));
        read.destroy();
        readCounters.destroy();
        return { patches: k[0], blades: [k[1], k[2], k[3]], drawn: [0, 1, 2].map(b => Math.min(k[1 + b], LOD_CAPACITY[b])), instances: [a[5], a[10], a[15]], vertices: segments.map(r => 2 * r + 1), kept: k[CTRL.STORE], made: k[CTRL.GEN], copied: k[CTRL.COPIED], why: { new: k[CTRL.WHY], nearer: k[CTRL.WHY + 1], farther: k[CTRL.WHY + 2], ground: k[CTRL.WHY + 3] } };
    }

    destroy() {
        this._groundFrame?.destroy();
        this._wind?.destroy();
        for (const b of [this._frameBuffer, this._patches, this._control, this._store, this._bandIndex, this._patchHash, this._dispatchArgs, this._args, ...(this._indexBuffers ?? [])]) b?.destroy();
        this._ready = false;
    }
}
