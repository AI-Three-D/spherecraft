// @ts-nocheck
import {
    TERRAIN_LIGHT_FRAME_FLOATS as FRAME_FLOATS, TERRAIN_LIGHT_HEIGHT_WGSL, TERRAIN_LIGHT_LEVEL_FLOATS as LEVEL_FLOATS, TERRAIN_LIGHT_LEVELS,
    TERRAIN_LIGHT_SKY_WGSL, TERRAIN_LIGHT_SUN_WGSL,
} from './terrainLight.wgsl.js';

const SIZE = 256;
const EXTENTS_M = [1536, 6144, 24576, 98304];
const REFRESH_FRAMES = [24, 40, 70, 110];
const MAX_TILES = 4096;
const TILE_WORDS = 8;
// Over this height (m) the maps fade out: from there the land is too far for them.
const FADE_M = [26000, 40000];
const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const faceDirection = (face, u, v) => {
    const s = 2 * u - 1;
    const t = 2 * v - 1;
    return [[1, t, -s], [-1, t, s], [s, 1, t], [s, -1, -t], [s, t, 1], [-s, t, -1]][face];
};

/**
 * Sun and sky over the land around the camera, from the heights of the terrain's loaded tiles. A map moves by whole
 * texels, and is made again when its tiles change; the sun goes over one map a frame, and the terrain blends the last two.
 */
export class TerrainLightMap {
    constructor(device) {
        this.device = device;
        this.levels = EXTENTS_M.map((extent, index) => ({
            extent, index, refresh: REFRESH_FRAMES[index], age: Infinity, anchor: null, key: null, ready: false, fresh: true, sunAge: 0, sky: -1,
        }));
        this._frame = new Float32Array(FRAME_FLOATS);
        this._turn = 0;
        this.enabled = true;
    }

    async initialize() {
        const device = this.device;
        const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
        const U = GPUTextureUsage;
        const layout = (visibility, ...entries) => device.createBindGroupLayout({ entries: entries.map((e, binding) => ({ binding, visibility, ...e })) });
        const uniform = { buffer: { type: 'uniform' } };
        const array = { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } };
        const state = { buffer: { type: 'storage' } };
        this._heightLayout = layout(V | F, uniform, { buffer: { type: 'read-only-storage' } }, array);
        this._skyLayout = layout(C, uniform, array, state);
        this._sunLayout = layout(C, uniform, array, state, { storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } });
        const module = (label, code) => device.createShaderModule({ label, code });
        const pipelineLayout = l => device.createPipelineLayout({ bindGroupLayouts: [l] });
        const compute = (label, code, l) => device.createComputePipelineAsync({ label, layout: pipelineLayout(l), compute: { module: module(label, code), entryPoint: 'main' } });
        const height = module('terrain light height', TERRAIN_LIGHT_HEIGHT_WGSL);
        [this._heightPipeline, this._skyPipeline, this._sunPipeline] = await Promise.all([
            device.createRenderPipelineAsync({
                label: 'terrain light height', layout: pipelineLayout(this._heightLayout),
                vertex: { module: height, entryPoint: 'vsMain' }, fragment: { module: height, entryPoint: 'fsMain', targets: [{ format: 'r32float' }] },
            }),
            compute('terrain light sky', TERRAIN_LIGHT_SKY_WGSL, this._skyLayout),
            compute('terrain light sun', TERRAIN_LIGHT_SUN_WGSL, this._sunLayout),
        ]);
        this._heights = device.createTexture({
            label: 'terrain light heights', size: [SIZE, SIZE, TERRAIN_LIGHT_LEVELS], format: 'r32float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING,
        });
        this._light = device.createTexture({
            label: 'terrain light', size: [SIZE, SIZE, TERRAIN_LIGHT_LEVELS], format: 'rgba8unorm', usage: U.STORAGE_BINDING | U.TEXTURE_BINDING,
        });
        this._state = device.createBuffer({ label: 'terrain light state', size: TERRAIN_LIGHT_LEVELS * SIZE * SIZE * 16, usage: GPUBufferUsage.STORAGE });
        // One for what the terrain reads and one for each kind of pass: a frame's passes see different levels.
        const frame = label => device.createBuffer({ label: `terrain light ${label}`, size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._frames = { terrain: frame('terrain'), bake: frame('bake'), sun: frame('sun') };
        this._tiles = device.createBuffer({ label: 'terrain light tiles', size: MAX_TILES * TILE_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this._tileBytes = new ArrayBuffer(MAX_TILES * TILE_WORDS * 4);
        const heights = this._heights.createView();
        const bind = (l, ...resources) => device.createBindGroup({ layout: l, entries: resources.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })) });
        this._skyGroup = bind(this._skyLayout, this._frames.bake, heights, this._state);
        this._sunGroup = bind(this._sunLayout, this._frames.sun, heights, this._state, this._light.createView());
        /** For the terrain's bindings. */
        this.resources = { frame: this._frames.terrain, map: this._light.createView({ dimension: '2d-array' }) };
        this.ready = true;
    }

    /** camera, sun: planet-relative position (m) and direction. Encodes the work that is due. */
    update(encoder, { tileStreamer, camera, radius, heightScale, sun }) {
        if (!this.ready) return;
        const up = normalize(camera);
        const altitude = Math.hypot(...camera) - radius;
        const share = this.enabled ? 1 - Math.min(1, Math.max(0, (altitude - FADE_M[0]) / (FADE_M[1] - FADE_M[0]))) : 0;
        const heightView = tileStreamer?.getArrayTextures?.()?.height?._gpuTexture?.view;
        if (share > 0 && heightView && tileStreamer._tileInfo?.size) {
            this._bake(encoder, { tileStreamer, up, radius, heightScale, sun, heightView });
            this._sunOver(encoder, sun, heightScale);
        }
        this._write(this._frames.terrain, sun, heightScale, 0, share);
    }

    _bake(encoder, { tileStreamer, up, radius, heightScale, sun, heightView }) {
        const ground = up.map(x => x * radius);
        for (const level of this.levels) level.age++;
        for (const level of this.levels) {
            const moved = level.anchor ? Math.hypot(...ground.map((x, i) => x - level.anchor[i])) : Infinity;
            const move = moved >= level.extent * 0.06;
            if (!move && level.age < level.refresh) continue;
            level.age = 0;
            const place = move ? this._placed(level, up, moved, radius) : level;
            const { count, hash } = this._collectTiles(place, level.extent, tileStreamer, radius);
            const key = `${place.anchor}:${hash}`;
            if (key === level.key) continue;
            level.key = key;
            Object.assign(level, { up: place.up, e1: place.e1, e2: place.e2, anchor: place.anchor, radius, ready: true, fresh: true });
            this.device.queue.writeBuffer(this._tiles, 0, this._tileBytes, 0, Math.max(1, count) * TILE_WORDS * 4);
            this._write(this._frames.bake, sun, heightScale, level.index, 1);
            const render = encoder.beginRenderPass({
                label: 'terrain light height',
                colorAttachments: [{
                    view: this._heights.createView({ dimension: '2d', baseArrayLayer: level.index, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
                }],
            });
            render.setPipeline(this._heightPipeline);
            render.setBindGroup(0, this.device.createBindGroup({
                layout: this._heightLayout,
                entries: [{ buffer: this._frames.bake }, { buffer: this._tiles }, heightView].map((resource, binding) => ({ binding, resource })),
            }));
            render.draw(6, count);
            render.end();
            const pass = encoder.beginComputePass({ label: 'terrain light sky' });
            pass.setPipeline(this._skyPipeline);
            pass.setBindGroup(0, this._skyGroup);
            pass.dispatchWorkgroups(SIZE / 8, SIZE / 8);
            pass.end();
            this._next = level;
            return; // one map a frame
        }
    }

    // The sun over one map: the one just made, or the next in turn.
    _sunOver(encoder, sun, heightScale) {
        const ready = this.levels.filter(l => l.ready);
        if (!ready.length) return;
        for (const level of ready) level.sunAge++;
        const level = this._next ?? ready.reduce((a, b) => (b.sunAge > a.sunAge ? b : a));
        this._next = null;
        level.sunPeriod = Math.max(1, Math.min(8, level.sunAge));
        level.sunAge = 0;
        this._write(this._frames.sun, sun, heightScale, level.index, 1);
        level.fresh = false;
        const pass = encoder.beginComputePass({ label: 'terrain light sun' });
        pass.setPipeline(this._sunPipeline);
        pass.setBindGroup(0, this._sunGroup);
        pass.dispatchWorkgroups(SIZE / 8, SIZE / 8);
        pass.end();
    }

    _write(buffer, sun, heightScale, current, share) {
        const f = this._frame;
        f.fill(0);
        for (const l of this.levels) {
            if (!l.ready) continue;
            const blend = Math.min(1, (l.sunAge + 1) / (l.sunPeriod ?? 1));
            f.set([...l.e1, l.extent, ...l.e2, 1, ...l.up, l.radius, blend, l.fresh ? 1 : 0, 0, 0], l.index * LEVEL_FLOATS);
        }
        f.set([...sun, 0.016, SIZE, heightScale, current, share], TERRAIN_LIGHT_LEVELS * LEVEL_FLOATS);
        this.device.queue.writeBuffer(buffer, 0, f);
    }

    // Moves a map by whole texels and without turning it, so that the same places keep the same texels.
    _placed(level, up, moved, radius) {
        let place;
        if (moved < level.extent) {
            const texel = level.extent / SIZE;
            const k = radius / dot(up, level.up);
            const [a, b] = [level.e1, level.e2].map(axis => Math.round(dot(up, axis) * k / texel) * texel);
            const middle = normalize(level.up.map((x, i) => x * radius + level.e1[i] * a + level.e2[i] * b));
            place = { up: middle, e1: normalize(level.e1.map((x, i) => x - middle[i] * dot(level.e1, middle))) };
        } else {
            place = { up, e1: normalize(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])) };
        }
        place.e2 = cross(place.up, place.e1);
        place.anchor = place.up.map(x => x * radius);
        return place;
    }

    // The loaded tiles that may touch the map, coarse ones first, so that finer ones are drawn over them.
    _collectTiles({ up, e1, e2 }, extent, tileStreamer, radius) {
        const found = [];
        for (const info of tileStreamer._tileInfo.values()) {
            if (info.layer == null) continue;
            const grid = 2 ** info.depth;
            const width = 2 * radius / grid;
            let bounds = [0, 0, 1, 1];
            const centre = normalize(faceDirection(info.face, (info.x + 0.5) / grid, (info.y + 0.5) / grid));
            const away = radius * Math.acos(Math.min(1, Math.max(-1, dot(centre, up))));
            if (away > 0.75 * extent + 1.2 * width) continue;
            if (width < 0.25 * radius && away < 0.5 * radius) {
                bounds = [Infinity, Infinity, -Infinity, -Infinity];
                for (let i = 0; i < 9; i++) {
                    const d = faceDirection(info.face, (info.x + (i % 3) / 2) / grid, (info.y + Math.floor(i / 3) / 2) / grid);
                    const k = radius / dot(d, up);
                    const a = dot(d, e1) * k / extent + 0.5;
                    const b = dot(d, e2) * k / extent + 0.5;
                    bounds = [Math.min(bounds[0], a), Math.min(bounds[1], b), Math.max(bounds[2], a), Math.max(bounds[3], b)];
                }
                const margin = 0.03 * Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) + 1 / SIZE;
                bounds = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
                if (bounds[0] > 1 || bounds[1] > 1 || bounds[2] < 0 || bounds[3] < 0) continue;
            }
            found.push({ info, bounds });
        }
        found.sort((a, b) => a.info.depth - b.info.depth);
        const count = Math.min(found.length, MAX_TILES);
        const words = new Uint32Array(this._tileBytes);
        const floats = new Float32Array(this._tileBytes);
        let hash = count;
        for (let i = 0; i < count; i++) {
            const { info, bounds } = found[i];
            words.set([info.layer, info.face | (info.depth << 8), info.x, info.y], i * TILE_WORDS);
            floats.set(bounds, i * TILE_WORDS + 4);
            const tile = Math.imul(info.x * 73856093 ^ info.y * 19349663, 1 + 2 * info.depth) ^ Math.imul(info.layer + 1, 83492791) ^ info.face;
            hash = (hash + Math.imul(tile, 0x9e3779b1)) | 0;
        }
        return { count, hash };
    }

    dispose() {
        for (const r of [this._heights, this._light, this._state, this._tiles, ...Object.values(this._frames ?? {})]) r?.destroy();
        this.ready = false;
    }
}
