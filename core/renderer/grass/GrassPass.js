// @ts-nocheck
// Grass blades about the camera (grassWgsl.js). Made each frame on the GPU from the ground the terrain draws: no blade
// is stored between frames, so there is nothing to stream, evict or pop. Drawn opaque without discard, so the GPU's
// hidden-surface removal keeps shading to about one blade fragment a pixel.

import {
    BLADE_WORDS, COUNTER_WORDS, FRAME_FLOATS, GRID_MAX, LOD_CAPACITY, MAX_FACES, MAX_PATCHES, PATCH_LEVELS, PATCH_WORDS,
    buildGrassComputeWGSL, buildGrassDrawWGSL,
} from './grassWgsl.js';

// The cube the planet is made of (terrainChunkVertexShaderBuilder.js getCubePoint): each face's axis, and its point's
// change per unit of x and y (x, y = 2 uv - 1).
const FACES = [
    { axis: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { axis: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { axis: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { axis: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { axis: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => a.map(x => x * k);
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const unit = a => scale(a, 1 / (length(a) || 1));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Defaults of rendering.grass. */
export const GRASS_DEFAULTS = Object.freeze({
    enabled: true,
    /** Blades end here (m); the terrain's ground goes on. */
    distance: 46,
    /**
     * Blades per square metre close by (grass 35 cm tall), the distance (m) from which they thin, and how fast: as 1 / d
     * the ground stays hidden at all distances (grassWgsl.js).
     */
    density: 1500,
    thinFrom: 2,
    thinPower: 1,
    /** Distance bands of finer and coarser blades (m). */
    bands: [7, 18],
    /** No blade drawn thinner than this many pixels (fewer, wider blades far off), widened at most so much. */
    minPixels: 0.7,
    maxWiden: 3,
});

export class GrassPass {
    /**
     * @param {object} o device, backend, tileManager, ground (createGroundMaterials), landLight (TerrainLightMap),
     *   planetConfig, biome (landscape rules or null), config (rendering.grass)
     */
    constructor(o) {
        Object.assign(this, o);
        this.config = { ...GRASS_DEFAULTS, ...(o.config ?? {}) };
        this.enabled = this.config.enabled !== false;
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
            && device.limits.maxStorageBuffersPerShaderStage >= 6;
    }

    async initialize() {
        const { device } = this;
        const U = GPUBufferUsage;
        const buffer = (label, size, usage) => device.createBuffer({ label: `Grass ${label}`, size, usage });
        const bladeCount = LOD_CAPACITY.reduce((a, b) => a + b, 0);
        this._frameBuffer = buffer('frame', FRAME_FLOATS * 4, U.UNIFORM | U.COPY_DST);
        this._patches = buffer('patches', MAX_PATCHES * PATCH_WORDS * 4, U.STORAGE);
        this._counters = buffer('counters', COUNTER_WORDS * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC);
        this._blades = buffer('blades', bladeCount * BLADE_WORDS * 4, U.STORAGE);
        // The blades' dispatch, and the bands' draws: two buffers, as one is read while the other is written.
        this._dispatchArgs = buffer('dispatch', 16 * 4, U.STORAGE | U.INDIRECT);
        this._args = buffer('draws', 16 * 4, U.STORAGE | U.INDIRECT | U.COPY_SRC);
        this._clamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

        const C = GPUShaderStage.COMPUTE, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
        const at = (binding, visibility, rest) => ({ binding, visibility, ...rest });
        const storage = { buffer: { type: 'storage' } };
        const array = { texture: { sampleType: 'float', viewDimension: '2d-array' } };
        this._layouts = {
            work: device.createBindGroupLayout({ entries: [
                at(0, C, { buffer: { type: 'uniform' } }), at(1, C, { buffer: { type: 'read-only-storage' } }),
                at(2, C, storage), at(3, C, storage), at(4, C, storage), at(5, C, storage),
            ] }),
            ground: device.createBindGroupLayout({ entries: [
                at(0, C, { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } }),
                at(1, C, array), at(2, C, array), at(3, C, array), at(4, C, { sampler: {} }), at(5, C, { sampler: {} }),
                at(6, C, { buffer: { type: 'uniform' } }), at(7, C, array), at(8, C, array),
            ] }),
            draw: device.createBindGroupLayout({ entries: [
                at(0, V | F, { buffer: { type: 'uniform' } }), at(1, V, { buffer: { type: 'read-only-storage' } }),
            ] }),
        };
        const faceSizeMeters = 2 * this.planetConfig.radius;
        const work = device.createShaderModule({ label: 'Grass scatter', code: buildGrassComputeWGSL({ faceSizeMeters, biome: this.biome ?? null }) });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this._layouts.work, this._layouts.ground] });
        const step = entryPoint => device.createComputePipelineAsync({ label: `Grass ${entryPoint}`, layout, compute: { module: work, entryPoint } });
        const draw = device.createShaderModule({ label: 'Grass blades', code: buildGrassDrawWGSL() });
        const [patches, dispatch, blades, finish, render] = await Promise.all([
            step('patchesMain'), step('dispatchMain'), step('bladesMain'), step('finishMain'),
            device.createRenderPipelineAsync({
                label: 'Grass blades',
                layout: device.createPipelineLayout({ bindGroupLayouts: [this._layouts.draw] }),
                vertex: { module: draw, entryPoint: 'vsMain' },
                fragment: { module: draw, entryPoint: 'fsMain', targets: [{ format: this.backend.sceneFormat || this.backend.format }] },
                primitive: { topology: 'triangle-strip', cullMode: 'none' },
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
            }),
        ]);
        this._steps = { patches, dispatch, blades, finish };
        this._render = render;
        const workGroup = args => device.createBindGroup({ layout: this._layouts.work, entries: [
            this._frameBuffer, this.tileManager.quadtreeGPU.getLoadedTileTableBuffer(), this._patches, this._counters, this._blades, args,
        ].map((b, binding) => ({ binding, resource: { buffer: b } })) });
        this._dispatchGroup = workGroup(this._dispatchArgs);
        this._drawArgsGroup = workGroup(this._args);
        this._drawGroup = device.createBindGroup({ layout: this._layouts.draw, entries: [
            { binding: 0, resource: { buffer: this._frameBuffer } }, { binding: 1, resource: { buffer: this._blades } },
        ] });
        this._ready = true;
    }

    _ensureGroundGroup() {
        const textures = this.tileManager.getArrayTextures();
        const view = name => textures[name]?._gpuTexture?.view;
        const land = this.landLight.resources;
        const parts = [view('height'), view('normal'), (this.biome && view('climate')) || view('normal'), this.ground.surfaceView,
            this.ground.wideSampler, this._clamp, land.frame, land.map, view('splatIndex')];
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
        this._time += Math.min(Math.max(deltaTime || 0, 0), 0.1);
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
        const f = this._f, I = this._i, W = this._u;
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
        const windSpeed = Number.isFinite(environment?.windSpeed) ? environment.windSpeed : 3;
        const wd = environment?.windDirection;
        let wind = wd ? [wd.x, 0, wd.y] : [1, 0, 0];
        wind = sub(wind, scale(up, dot(wind, up)));
        wind = length(wind) > 1e-6 ? unit(wind) : east;
        const fov = (camera.fov ?? 60) * Math.PI / 180;
        const pixelAngle = 2 * Math.tan(fov / 2) / Math.max(1, viewportHeight || 900);

        f.set([...up, R], 36);
        f.set([...east, this.planetConfig.heightScale], 40);
        f.set([...north, 2 * R], 44);
        f.set([s.x / sl, s.y / sl, s.z / sl, this._time], 48);
        f.set([sunColor.r * sunI, sunColor.g * sunI, sunColor.b * sunI, windSpeed], 52);
        f.set([amb.r * ambI, amb.g * ambI, amb.b * ambI, pixelAngle], 56);
        f.set([dot(wind, east), dot(wind, north), clamp(windSpeed / 16, 0, 1.2), 0.03 + 0.05 * clamp(windSpeed / 8, 0, 1)], 60);
        f.set([c.distance, c.density, c.thinFrom, c.thinPower], 64);
        f.set([c.bands[0], c.bands[1], c.minPixels, c.maxWiden], 68);
        f.set([...camRel, seaLevel ?? -1.0e9], 72);

        // The faces near enough, each with an anchor patch about the camera.
        const quadtree = this.tileManager.quadtreeGPU;
        const depth = quadtree.maxDepth;
        const patchesPerFace = 2 ** (depth + PATCH_LEVELS);
        let faces = 0, widest = 0;
        for (let face = 0; face < 6 && faces < MAX_FACES; face++) {
            const F = FACES[face];
            const m = dot(up, F.axis);
            if (m < 0.3) continue;
            const uv = [(dot(up, F.u) / m + 1) / 2, (dot(up, F.v) / m + 1) / 2];
            // How far the face is: from the camera's place to the nearest point of it.
            const nearestUv = uv.map(t => clamp(t, 0, 1));
            const onFace = unit(add(F.axis, add(scale(F.u, 2 * nearestUv[0] - 1), scale(F.v, 2 * nearestUv[1] - 1))));
            const away = 2 * Math.asin(Math.min(1, length(sub(onFace, up)) / 2)) * R;
            if (away > c.distance + 8) continue;
            const anchor = uv.map(t => Math.floor(t * patchesPerFace));
            const ca = add(F.axis, add(scale(F.u, 2 * anchor[0] / patchesPerFace - 1), scale(F.v, 2 * anchor[1] / patchesPerFace - 1)));
            const la = length(ca), na = scale(ca, 1 / la);
            const da = sub(scale(na, R), camRel);
            const du = scale(F.u, 2 / patchesPerFace), dv = scale(F.v, 2 / patchesPerFace);
            // The sphere's metres per patch about the anchor.
            const jx = scale(sub(du, scale(na, dot(na, du))), R / la), jy = scale(sub(dv, scale(na, dot(na, dv))), R / la);
            const mx = length(jx), my = length(jy);
            const area = length(cross(jx, jy));
            const half = Math.min(GRID_MAX, Math.ceil(c.distance / Math.min(mx, my)) + 1);
            widest = Math.max(widest, half);
            const ex = unit(jx), ey = unit(jy);
            const windFace = unit([dot(wind, ex), dot(wind, ey), 0]);
            const o = 80 + faces * 28;
            f.set([...ca, la], o);
            f.set([...du, face], o + 4);
            f.set([...dv, Math.max(mx, my)], o + 8);
            f.set([...da, 0], o + 12);
            f.set([...na, area], o + 16);
            I.set([anchor[0], anchor[1], face, half], o + 20);
            f.set([windFace[0], windFace[1], -windFace[1], windFace[0]], o + 24);
            faces++;
        }
        const tableCapacity = quadtree.getLoadedTileTableCapacity();
        W.set([faces, depth, tableCapacity - 1, tableCapacity], 76);
        if (!faces) return;
        this.device.queue.writeBuffer(this._frameBuffer, 0, this._frame);

        encoder.clearBuffer(this._counters);
        const pass = encoder.beginComputePass({ label: 'Grass scatter' });
        const run = (name, group) => { pass.setPipeline(this._steps[name]); pass.setBindGroup(0, group); pass.setBindGroup(1, this._groundGroup); };
        run('patches', this._dispatchGroup);
        pass.dispatchWorkgroups(Math.ceil((2 * widest) ** 2 / 64), 1, faces);
        run('dispatch', this._dispatchGroup);
        pass.dispatchWorkgroups(1);
        run('blades', this._drawArgsGroup);
        pass.dispatchWorkgroupsIndirect(this._dispatchArgs, 0);
        run('finish', this._drawArgsGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        this._drawing = true;
    }

    /** Whether blades are drawn this frame. */
    get drawing() { return this._drawing; }

    draw(pass) {
        if (!this._drawing) return;
        pass.setPipeline(this._render);
        pass.setBindGroup(0, this._drawGroup);
        for (let band = 0; band < LOD_CAPACITY.length; band++) pass.drawIndirect(this._args, 16 + band * 16);
    }

    /** For measuring: patches and blades per band of the last frame (reads back, slow). */
    async counts() {
        const read = this.device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const readCounters = this.device.createBuffer({ size: COUNTER_WORDS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const e = this.device.createCommandEncoder();
        e.copyBufferToBuffer(this._args, 0, read, 0, 64);
        e.copyBufferToBuffer(this._counters, 0, readCounters, 0, COUNTER_WORDS * 4);
        this.device.queue.submit([e.finish()]);
        await Promise.all([read.mapAsync(GPUMapMode.READ), readCounters.mapAsync(GPUMapMode.READ)]);
        const a = new Uint32Array(read.getMappedRange().slice(0)), k = new Uint32Array(readCounters.getMappedRange().slice(0));
        read.destroy();
        readCounters.destroy();
        return { patches: k[0], blades: [k[1], k[2], k[3]], drawn: [a[5], a[9], a[13]], vertices: [a[4], a[8], a[12]] };
    }

    destroy() {
        for (const b of [this._frameBuffer, this._patches, this._counters, this._blades, this._dispatchArgs, this._args]) b?.destroy();
        this._ready = false;
    }
}
