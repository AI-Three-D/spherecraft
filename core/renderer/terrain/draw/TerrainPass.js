// @ts-nocheck
// Draws the terrain (terrainPass.wgsl.js): the tiles of the quadtree that are in view, sorted on the GPU by what their
// shader has to do (terrainDrawList.wgsl.js). Everything else that can draw terrain (debug views, the atlas, shadow
// cascades, clustered lights) is QuadtreeTerrainRenderer's own materials, which take over when this cannot (ready()).

import { buildTerrainPassFragmentWGSL, buildTerrainPassVertexWGSL, TERRAIN_PASS_FLOATS } from '../shaders/webgpu/terrainPass.wgsl.js';
import { buildTerrainDrawListWGSL, DRAW_BUCKETS, DRAW_LIST_FRAME_FLOATS, drawBucket, frustumPlanes, HORIZON_DIRECTIONS, HORIZON_EPOCHS, HORIZON_RINGS, HORIZON_TILES, SEA_VIEW_WORDS, TILE_KIND, TILE_KINDS } from './terrainDrawList.wgsl.js';
import { TerrainAir } from './TerrainAir.js';
import { WaterCoverage } from '../../../world/water/WaterCoverage.js';
import { WATER_BINDINGS, WATER_FIELD_BINDINGS } from '../../../world/water/waterWgsl.js';

// The planet under its deepest ground hides what lies behind it: this share of the highest land under sea level
// (heights are soft-clamped to about 1.1 of it). Nearer the surface it would hide the sea's deep floor.
const HIDING_DEPTH = 1.2;
const KIND_OPTIONS = {
    [TILE_KIND.NEAR]: { fine: true, live: true, far: false },
    [TILE_KIND.MID]: { fine: false, live: true, far: true },
    [TILE_KIND.FAR]: { fine: false, live: false, far: true },
    [TILE_KIND.ALL]: { fine: true, live: true, far: true },
};

/** The triangles of a grid of n x n cells in strips narrow enough for the GPU's vertex reuse. */
export function stripGridIndices(n, strip = 14) {
    const indices = new Uint16Array(n * n * 6);
    let at = 0;
    for (let x0 = 0; x0 < n; x0 += strip) {
        for (let y = 0; y < n; y++) {
            for (let x = x0; x < Math.min(n, x0 + strip); x++) {
                const a = y * (n + 1) + x, b = a + n + 1;
                indices.set([a, b, a + 1, a + 1, b, b + 1], at);
                at += 6;
            }
        }
    }
    return indices;
}

export class TerrainPass {
    /**
     * @param {object} o device, backend, tileManager, ground (createGroundMaterials), landLight (TerrainLightMap),
     *   planetConfig, shaderConfig (rendering.terrainShader), meshes: index arrays of the levels of detail, segments of a tile,
     *   biome: the landscape's rules when the ground follows the tiles' climate (their climate textures), else null
     */
    constructor(o) {
        Object.assign(this, o);
        this.enabled = true;
        /** For measuring: whether off-screen tiles are left out, and those behind land (terrainShader.occlusion sets it first), every tile is taken for wet, half floats are used, the air is worked out per pixel. */
        /** Where grass blades end this frame (m), 0 without: the ground under them is shaded (GrassPass.js). */
        this.grassReach = 0;
        this.options = { cull: true, occlusion: o.shaderConfig?.occlusion === true, allWet: false, half: true, exactAir: false,
            /** The ground's grass look (hue, the canopy past the blades) and the grass grain (GrassPass.js): off as before grass. */
            grass: o.grassLook === true, grain: o.grassLook === true && !!o.grain };
        this._pipelines = new Map();
        this._pending = new Map();
        this._ready = false;
        this._frame = new Float32Array(TERRAIN_PASS_FLOATS);
        this._listFrame = new Float32Array(DRAW_LIST_FRAME_FLOATS);
    }

    static supported(device, tileManager) {
        return device.features.has('indirect-first-instance') && !!tileManager?.getEdgeStitchBuffer?.() && !!tileManager?.getTileBoundsBuffer?.() && device.limits.maxStorageBuffersPerShaderStage >= 10;
    }

    async initialize() {
        const { device } = this;
        const U = GPUBufferUsage;
        const buffer = (label, size, usage) => device.createBuffer({ label: `Terrain ${label}`, size, usage });
        this.capacity = this.tileManager.quadtreeGPU.maxVisibleTiles;
        this._frameBuffer = buffer('frame', TERRAIN_PASS_FLOATS * 4, U.UNIFORM | U.COPY_DST);
        this._listFrameBuffer = buffer('draw list frame', DRAW_LIST_FRAME_FLOATS * 4, U.UNIFORM | U.COPY_DST);
        this._list = buffer('draw list', (DRAW_BUCKETS + 1) * this.capacity * 4, U.STORAGE);
        this.draws = buffer('draws', DRAW_BUCKETS * 20 + 16, U.STORAGE | U.INDIRECT | U.COPY_SRC);
        this._cells = buffer('horizon cells', HORIZON_DIRECTIONS * HORIZON_RINGS * 4, U.STORAGE | U.COPY_DST);
        this._horizon = buffer('horizon', HORIZON_DIRECTIONS * HORIZON_RINGS * 4, U.STORAGE);
        this._epoch = 0;
        this.seaView = buffer('sea view', SEA_VIEW_WORDS * 4, U.STORAGE | U.COPY_SRC);
        // Read back a few frames late: whether there is sea about (the list reaches all around the camera).
        this._seaReads = Array.from({ length: 3 }, () => ({ buffer: buffer('sea readback', SEA_VIEW_WORDS * 4, U.MAP_READ | U.COPY_DST), busy: false }));
        this.seaAbout = true;
        this._counts = buffer('mesh counts', this.meshes.length * 4, U.STORAGE | U.COPY_DST);
        device.queue.writeBuffer(this._counts, 0, new Uint32Array(this.meshes.map(m => m.length)));
        this._indices = this.meshes.map((indices, i) => {
            const data = i === 0 ? stripGridIndices(this.segments) : new Uint16Array(indices);
            const b = buffer(`mesh ${i}`, Math.ceil(data.byteLength / 4) * 4, U.INDEX | U.COPY_DST);
            device.queue.writeBuffer(b, 0, data.byteLength % 4 ? new Uint16Array([...data, 0]) : data);
            return b;
        });
        this.air = new TerrainAir(device);
        this.coverage = new WaterCoverage(device);
        this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        this._noCoverage = device.createTexture({ size: [1, 1, 6], format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING }).createView({ dimension: '2d-array' });

        const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
        const layout = (entries) => device.createBindGroupLayout({ entries });
        const at = (binding, visibility, rest) => ({ binding, visibility, ...rest });
        const uniform = { buffer: { type: 'uniform' } }, stored = { buffer: { type: 'read-only-storage' } };
        const array = { texture: { sampleType: 'float', viewDimension: '2d-array' } };
        this._layouts = {
            frame: layout([at(0, V | F, uniform)]),
            ground: layout([
                at(0, V | F, { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } }),
                ...[1, 2, 3, 4, 5, 6].map(i => at(i, F, array)),
                ...[7, 8, 9].map(i => at(i, F, { sampler: {} })),
                at(10, F, array), at(11, F, uniform), at(12, F, { texture: { sampleType: 'float' } }),
                ...(this.biome ? [at(13, F, array)] : []),
                ...(this.grain ? [at(this._grainBinding(), F, { texture: { sampleType: 'float' } })] : []),
            ]),
            none: layout([]),
            water: layout([
                at(WATER_BINDINGS.index, F, stored), at(WATER_BINDINGS.lakes, F, stored), at(WATER_BINDINGS.masks, F, array), at(WATER_BINDINGS.params, F, uniform),
                at(WATER_FIELD_BINDINGS.table, F, stored), at(WATER_FIELD_BINDINGS.texels, F, stored), at(WATER_FIELD_BINDINGS.params, F, uniform), at(WATER_FIELD_BINDINGS.flow, F, stored),
            ]),
            tiles: layout([
                at(0, V, stored), at(1, V, stored), at(2, V, stored), at(3, V, uniform),
                at(4, V, array), at(5, V, { sampler: {} }), at(6, V, uniform), at(7, V, { texture: { sampleType: 'float' } }),
            ]),
            list: layout([
                at(0, C, uniform), ...[1, 2, 3, 4].map(i => at(i, C, stored)), ...[5, 6].map(i => at(i, C, { buffer: { type: 'storage' } })),
                at(7, C, { texture: { sampleType: 'uint', viewDimension: '2d-array' } }), at(8, C, { buffer: { type: 'storage' } }),
                at(9, C, stored), ...[10, 11].map(i => at(i, C, { buffer: { type: 'storage' } })),
            ]),
        };
        const pipelineLayout = (...groups) => device.createPipelineLayout({ bindGroupLayouts: groups });
        const L = this._layouts;
        this._dryLayout = pipelineLayout(L.frame, L.ground, L.none, L.tiles);
        this._wetLayout = pipelineLayout(L.frame, L.ground, L.water, L.tiles);
        this._noGroup = device.createBindGroup({ layout: L.none, entries: [] });
        this._frameGroup = device.createBindGroup({ layout: L.frame, entries: [{ binding: 0, resource: { buffer: this._frameBuffer } }] });
        this._vertex = device.createShaderModule({ label: 'Terrain vertex', code: buildTerrainPassVertexWGSL({ segments: this.segments }) });
        const listModule = device.createShaderModule({
            label: 'Terrain draw list',
            code: buildTerrainDrawListWGSL({ lodLevels: this.meshes.length, capacity: this.capacity, solidLod: this.shaderConfig.solidColorStartLod }),
        });
        this._steps = Object.fromEntries(await Promise.all(['sift', 'raise', 'sweep', 'place'].map(async entryPoint => [entryPoint, await device.createComputePipelineAsync({
            label: `Terrain draw list ${entryPoint}`, layout: pipelineLayout(L.list), compute: { entryPoint, module: listModule },
        })])));
        const all = [];
        for (let kind = 0; kind < TILE_KINDS; kind++) for (const wet of [false, true]) all.push(this._build(kind, wet, false));
        await Promise.all(all);
        this._ready = true;
    }

    /** The grass grain's binding in the ground group (grassGrain.js): after the climate, when there is one. */
    _grainBinding() { return this.biome ? 14 : 13; }

    _key(kind, wet, rain) { return `${kind}${wet ? ' wet' : ''}${rain ? ' rain' : ''}${this.options.half ? '' : ' full'}${this.options.exactAir ? ' exact' : ''}${this.options.grass ? '' : ' plain'}${this.options.grain ? '' : ' nograin'}`; }

    _build(kind, wet, rain) {
        const key = this._key(kind, wet, rain);
        if (this._pending.has(key)) return this._pending.get(key);
        const { device } = this;
        const code = buildTerrainPassFragmentWGSL({
            faceSizeMeters: 2 * this.planetConfig.radius, ...KIND_OPTIONS[kind], water: wet, rain,
            half: this.options.half && device.features.has('shader-f16'), exactAir: this.options.exactAir,
            fineEndMeters: this.shaderConfig.groundFineEndMeters, deepEndMeters: this.shaderConfig.groundDeepEndMeters, biome: this.biome ?? null,
            grain: this.grain && this.options.grass && this.options.grain ? this._grainBinding() : null, grassLook: this.options.grass,
        });
        const made = device.createRenderPipelineAsync({
            label: `Terrain ${key}`, layout: wet ? this._wetLayout : this._dryLayout,
            vertex: { module: this._vertex, entryPoint: 'main' },
            fragment: { module: device.createShaderModule({ label: `Terrain ${key}`, code }), entryPoint: 'main', targets: [{ format: this.backend.sceneFormat || this.backend.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'front', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        }).then(pipeline => { this._pipelines.set(key, pipeline); });
        this._pending.set(key, made);
        return made;
    }

    // The pipeline for a kind of tile; one without rain until that with it has been made.
    _pipeline(kind, wet, rain) {
        const pipeline = this._pipelines.get(this._key(kind, wet, rain));
        if (pipeline) return pipeline;
        this._build(kind, wet, rain).catch(() => {});
        return rain ? this._pipeline(kind, wet, false) : null;
    }

    /** Makes the variants the options now ask for: for measuring. */
    async prepare() {
        const all = [];
        for (let kind = 0; kind < TILE_KINDS; kind++) for (const wet of [false, true]) all.push(this._build(kind, wet, false));
        await Promise.all(all);
    }

    /** Whether this can draw the frame; else the renderer's materials do. */
    ready(u) {
        return this.enabled && this._ready && !!this.landLight?.ready && u.terrainDebugMode.value === 0 && !(u._clusterBuffers?.value?.numLights > 0)
            && u.aerialPerspectiveEnabled.value > 0.5 && !!u.transmittanceLUT.value?._gpuTexture?.view;
    }

    _ensureGroups(u, water) {
        const { device } = this;
        const textures = this.tileManager.getArrayTextures();
        const view = name => textures[name]._gpuTexture.view;
        const lut = u.transmittanceLUT.value._gpuTexture.view;
        const views = ['height', 'normal', 'splatData', 'splatIndex', 'coarseColor'].map(view);
        const climate = this.biome ? [view('climate')] : [];
        const entries = resources => resources.map((resource, binding) => ({ binding, resource: resource instanceof GPUBuffer ? { buffer: resource } : resource }));
        const same = (a, b) => a && a.length === b.length && a.every((x, i) => x === b[i]);
        const ground = [...views, ...climate, lut, this.ground];
        if (!same(this._groundOf, ground)) {
            this._groundOf = ground;
            this._groundGroup = device.createBindGroup({ layout: this._layouts.ground, entries: entries([
                ...views, this.ground.albedoView, this.ground.surfaceView, this.ground.sampler, this.ground.wideSampler, this._sampler, this.air.view, this.air.frame, lut, ...climate,
                ...(this.grain ? [this.grain.view] : []),
            ]) });
        }
        const land = this.landLight.resources;
        const instances = this.tileManager.getInstanceBuffer(), stitch = this.tileManager.getEdgeStitchBuffer();
        const tiles = [instances, stitch, land.frame, land.map, lut];
        if (!same(this._tilesOf, tiles)) {
            this._tilesOf = tiles;
            this._tilesGroup = device.createBindGroup({ layout: this._layouts.tiles, entries: entries([instances, stitch, this._list, land.frame, land.map, this._sampler, this.air.frame, lut]) });
        }
        const coverage = this._covered ? this.coverage.view : this._noCoverage;
        const meta = this.tileManager.getIndirectArgsBuffer(), bounds = this.tileManager.getTileBoundsBuffer();
        const blocks = this.tileManager.getTileBlocksBuffer();
        const list = [instances, meta, bounds, coverage, blocks];
        if (!same(this._listOf, list)) {
            this._listOf = list;
            this._listGroup = device.createBindGroup({ layout: this._layouts.list, entries: entries([this._listFrameBuffer, instances, meta, bounds, this._counts, this._list, this.draws, coverage, this.seaView, blocks, this._cells, this._horizon]) });
        }
        const r = water?.resources, f = water?.riverField?.resources;
        const wet = r && f ? [r.index, r.lakes, r.masks, r.params, f.pages, f.texels, f.params, f.flow] : null;
        if (wet && !same(this._waterOf, wet)) {
            this._waterOf = wet;
            const bindings = [...['index', 'lakes', 'masks', 'params'].map(k => WATER_BINDINGS[k]), ...['table', 'texels', 'params', 'flow'].map(k => WATER_FIELD_BINDINGS[k])];
            this._waterGroup = device.createBindGroup({ layout: this._layouts.water, entries: wet.map((x, i) => ({ binding: bindings[i], resource: x instanceof GPUBuffer ? { buffer: x } : x })) });
        }
        this._hasWater = !!wet;
    }

    /**
     * Before the pass that draws. u: the terrain's uniforms, already of this frame. water: WaterGpuData or null.
     * tierFade: { start, end } or null. wetness: 0..1. air: where the air sets in (m).
     */
    compute(encoder, { u, camera, water, tierFade, wetness, airFade }) {
        this._covered = this.coverage.update(water);
        this._ensureGroups(u, water);
        const { planetConfig, shaderConfig } = this;
        const origin = u.planetOrigin.value, p = camera.position;
        const fromCentre = [p.x - origin.x, p.y - origin.y, p.z - origin.z];
        const cameraLength = Math.hypot(...fromCentre);
        const radius = planetConfig.radius;
        const altitude = Math.max(0, cameraLength - u.atmospherePlanetRadius.value);
        const view = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
        const normalFrom = Math.min(shaderConfig.normalMapDistanceMaxMeters, shaderConfig.normalMapDistanceBaseMeters * (1 + altitude / shaderConfig.normalMapDistanceAltitudeScaleMeters));
        const s = u.sunLightDirection.value, sl = Math.hypot(s.x, s.y, s.z) || 1;
        const color = (c, k) => [(c?.r ?? 0) * k, (c?.g ?? 0) * k, (c?.b ?? 0) * k];
        const f = this._frame;
        f.set(view, 0);
        f.set(projection, 16);
        f.set([
            origin.x, origin.y, origin.z, radius,
            p.x, p.y, p.z, planetConfig.heightScale,
            s.x / sl, s.y / sl, s.z / sl, wetness,
            ...color(u.sunLightColor.value, u.sunLightIntensity.value), tierFade?.start ?? 0,
            ...color(u.ambientLightColor.value, u.ambientLightIntensity.value), tierFade?.end ?? 0,
            ...color(u.fogColor.value, 1), normalFrom,
            normalFrom + shaderConfig.normalMapDistanceFadeMeters, 1, this.grassReach ?? 0, 0,
        ], 32);
        this.device.queue.writeBuffer(this._frameBuffer, 0, f);
        this._rain = wetness > 0;
        this.air.update(encoder, { u, lutView: u.transmittanceLUT.value._gpuTexture.view, altitude: cameraLength - u.atmospherePlanetRadius.value, top: planetConfig.maxTerrainHeight, fade: airFade });

        const sea = water?.sea, near = water?.near;
        const drawsWater = this._hasWater && water.enabled !== false;
        const g = this._listFrame;
        // Land hides what is behind it only for a camera over the ground and off its axis.
        const up = fromCentre.map(x => x / cameraLength);
        const pole = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const eastRaw = cross(pole, up), eastLength = Math.hypot(...eastRaw), east = eastRaw.map(x => x / eastLength), north = cross(up, east);
        this._epoch = this._epoch % HORIZON_EPOCHS + 1;
        const occlusion = this.options.cull && this.options.occlusion && cameraLength - radius < 4 * planetConfig.maxTerrainHeight;
        frustumPlanes(view, projection, origin, g, 0);
        g.set([
            ...fromCentre, cameraLength,
            radius, cameraLength - radius, altitude > 0 ? radius - HIDING_DEPTH * planetConfig.maxTerrainHeight : 0, occlusion ? 1 : 0,
            shaderConfig.groundFineEndMeters, tierFade?.start ?? 0, tierFade?.end ?? 0,
            !drawsWater ? 1.0e9 : near?.enabled && !(water.debugMode > 0) ? near.fadeStartM : 0,
            sea?.enabled ? sea.levelM + 2 : -1.0e9, this._covered ? Math.log2(water.N) : 0, this.options.allWet ? 1 : 0, this.options.cull ? 1 : 0,
            ...east, 0, ...north, 0, this._epoch, 0, 0, 0,
        ], 20);
        // Of points about the camera: the view's turn alone, then the projection.
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let sum = c === 3 ? projection[r + 12] : 0;
            if (c < 3) for (let k = 0; k < 3; k++) sum += projection[r + k * 4] * view[k + c * 4];
            g[48 + c * 4 + r] = sum;
        }
        this.device.queue.writeBuffer(this._listFrameBuffer, 0, g);
        const step = (pass, name) => {
            pass.setPipeline(this._steps[name]);
            pass.setBindGroup(0, this._listGroup);
        };
        if (occlusion && this._epoch === 1) encoder.clearBuffer(this._cells);
        const pass = encoder.beginComputePass({ label: 'Terrain draw list' });
        step(pass, 'sift');
        pass.dispatchWorkgroups(1);
        if (occlusion) {
            step(pass, 'raise');
            pass.dispatchWorkgroups(HORIZON_TILES);
            step(pass, 'sweep');
            pass.dispatchWorkgroups(HORIZON_DIRECTIONS / 64);
        }
        step(pass, 'place');
        pass.dispatchWorkgroups(1);
        pass.end();
        this._seaRead = this._seaReads.find(r => !r.busy) ?? null;
        if (this._seaRead) encoder.copyBufferToBuffer(this.seaView, 0, this._seaRead.buffer, 0, SEA_VIEW_WORDS * 4);
    }

    /** After the frame's commands have been submitted. */
    afterSubmit() {
        const read = this._seaRead;
        this._seaRead = null;
        if (!read) return;
        read.busy = true;
        read.buffer.mapAsync(GPUMapMode.READ).then(() => {
            const sea = new Int32Array(read.buffer.getMappedRange());
            this.seaAbout = sea[4] !== 0 && sea[5] === 0;
            read.buffer.unmap();
            read.busy = false;
        }).catch(() => { read.busy = false; });
    }

    draw(pass) {
        pass.setBindGroup(0, this._frameGroup);
        pass.setBindGroup(1, this._groundGroup);
        pass.setBindGroup(3, this._tilesGroup);
        for (let kind = 0; kind < TILE_KINDS; kind++) {
            for (const wet of this._hasWater ? [false, true] : [false]) {
                const pipeline = this._pipeline(kind, wet, this._rain);
                if (!pipeline) continue;
                pass.setPipeline(pipeline);
                pass.setBindGroup(2, wet ? this._waterGroup : this._noGroup);
                for (let mesh = 0; mesh < this._indices.length; mesh++) {
                    pass.setIndexBuffer(this._indices[mesh], 'uint16');
                    pass.drawIndexedIndirect(this.draws, drawBucket(mesh, kind, wet) * 20);
                }
            }
        }
    }

    destroy() {
        for (const b of [this._frameBuffer, this._listFrameBuffer, this._list, this.draws, this._cells, this._horizon, this._counts, this.seaView, ...(this._indices ?? []), ...(this._seaReads ?? []).map(r => r.buffer)]) b?.destroy();
        this.air?.destroy();
        this.coverage?.destroy();
        this._ready = false;
    }
}
