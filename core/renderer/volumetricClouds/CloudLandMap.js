// @ts-nocheck
import {
    CLOUD_LAND_GROUND_WGSL, CLOUD_LAND_RELIEF_WGSL, CLOUD_LAND_SHADE_WGSL, CLOUD_LAND_SLOPES_WGSL, buildLandMapShader,
} from './shaders/cloudLandMap.wgsl.js';

/** Wide and middle: mountains that can carry fog, far and near. Near: the ground itself, wetland and forest. */
const MAPS = Object.freeze({
    wide: Object.freeze({ extentKm: 64, size: 128, refreshFrames: 90 }),
    middle: Object.freeze({ extentKm: 16, size: 256, refreshFrames: 75 }),
    near: Object.freeze({ extentKm: 3.2, size: 256, refreshFrames: 60 }),
});
const FRAME_FLOATS = 16;
/** Texels across the map of the land's shadow, over the wide map's extent. */
export const SHADE_SIZE = 128;
/** The land's shadow is made anew when the sun has moved this far (rad). */
const SHADE_TURN = 0.001;
const MAX_TILES = 4096;
/** Bytes per tile for the GPU: layer, face, depth, x, y and the part of the map it may cover. */
const TILE_WORDS = 8;
const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const faceDirection = (face, u, v) => {
    const s = 2 * u - 1;
    const t = 2 * v - 1;
    return [[1, t, -s], [-1, t, s], [s, 1, t], [s, -1, -t], [s, t, 1], [-s, t, -1]][face];
};

/**
 * Maps of the land around the camera, read from the terrain's loaded tiles, for clouds and mist that belong to a place.
 * Refreshed now and then: when the camera has moved a tenth of a map, and while tiles load.
 */
export class CloudLandMap {
    /** shade: texture view (rgba16float) for the land's shadow. */
    constructor(device, { tileCategories = [], shade } = {}) {
        this.device = device;
        this._shadeView = shade;
        const named = name => tileCategories.filter(c => c?.name === name).flatMap(c => c.ranges ?? []);
        this._categories = { wet: [...named('SWAMP'), ...named('MUD')], forest: named('FOREST') };
        this.maps = {};
    }

    async initialize() {
        const device = this.device;
        const C = GPUShaderStage.COMPUTE;
        const layout = (entries, visibility = C) => device.createBindGroupLayout({
            entries: entries.map((e, binding) => ({ binding, visibility, ...e })),
        });
        const uniform = { buffer: { type: 'uniform' } };
        const float = { texture: { sampleType: 'float' } };
        const linear = { sampler: { type: 'filtering' } };
        const store = { storageTexture: { access: 'write-only', format: 'rgba16float' } };
        const array = { texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } };
        const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this._bakeLayout = layout([uniform, { buffer: { type: 'read-only-storage' } }, array, array], both);
        const bakeModule = device.createShaderModule({ label: 'clouds land map', code: buildLandMapShader(this._categories) });
        const compute = (label, code, bindGroupLayout) => device.createComputePipelineAsync({
            label, layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
        }).then(pipeline => ({ pipeline, layout: bindGroupLayout }));
        const filter = layout([uniform, float, store]);
        [this._bakePipeline, this._groundPipeline, this._reliefPipeline, this._slopesPipeline] = await Promise.all([
            device.createRenderPipelineAsync({
                label: 'clouds land map', layout: device.createPipelineLayout({ bindGroupLayouts: [this._bakeLayout] }),
                vertex: { module: bakeModule, entryPoint: 'vsMain' },
                fragment: { module: bakeModule, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
            }),
            compute('clouds land ground', CLOUD_LAND_GROUND_WGSL, filter),
            compute('clouds land relief', CLOUD_LAND_RELIEF_WGSL, filter),
            compute('clouds land slopes', CLOUD_LAND_SLOPES_WGSL, layout([uniform, float, store, uniform, float, linear])),
        ]);
        this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        const texture = (label, size) => device.createTexture({
            label: `cloud land ${label}`, size: [size, size], format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const buffer = (label, size, usage) => device.createBuffer({ label: `cloud land ${label}`, size, usage: usage | GPUBufferUsage.COPY_DST });
        this._tiles = buffer('tiles', MAX_TILES * TILE_WORDS * 4, GPUBufferUsage.STORAGE);
        this._tileBytes = new ArrayBuffer(MAX_TILES * TILE_WORDS * 4);
        for (const [name, spec] of Object.entries(MAPS)) {
            const raw = texture(`${name} raw`, spec.size);
            const map = texture(`${name} map`, spec.size);
            this.maps[name] = {
                name, spec, raw, map, rawView: raw.createView(), view: map.createView(),
                frame: buffer(`${name} frame`, FRAME_FLOATS * 4, GPUBufferUsage.UNIFORM), age: Infinity, anchor: null, version: 0,
            };
        }
        this._shadePipeline = await compute('clouds land shade', CLOUD_LAND_SHADE_WGSL, layout([uniform, float, store, linear]));
        this._shadeFrame = buffer('shade frame', (FRAME_FLOATS + 4) * 4, GPUBufferUsage.UNIFORM);
        const { wide, middle, near } = this.maps;
        this._reliefTexture = texture('relief', MAPS.wide.size);
        /** Peaks and surroundings, on the wide map. */
        this.reliefView = this._reliefTexture.createView();
        const step = ({ pipeline, layout: groupLayout }, size, resources) => ({
            pipeline, groups: size / 8,
            bindGroup: device.createBindGroup({ layout: groupLayout, entries: resources.map((resource, binding) => ({ binding, resource })) }),
        });
        const frame = entry => ({ buffer: entry.frame });
        this._shadeStep = step(this._shadePipeline, SHADE_SIZE, [{ buffer: this._shadeFrame }, wide.rawView, this._shadeView, this._sampler]);
        near.steps = [step(this._groundPipeline, near.spec.size, [frame(near), near.rawView, near.view])];
        // The relief is the wide map's: a middle map does not reach far enough to tell a mountain from a hill.
        wide.steps = [step(this._reliefPipeline, wide.spec.size, [frame(wide), wide.rawView, this.reliefView])];
        for (const entry of [wide, middle]) {
            (entry.steps ??= []).push(step(this._slopesPipeline, entry.spec.size,
                [frame(entry), entry.rawView, entry.view, frame(wide), this.reliefView, this._sampler]));
        }
        this.ready = true;
    }

    /** cameraKm: planet-relative position. Encodes the refreshes that are due; true when a map changed. */
    update(encoder, { tileStreamer, cameraKm, planetRadiusKm, heightScaleKm }) {
        if (!this.ready) return false;
        const textures = tileStreamer?.getArrayTextures?.();
        const heightView = textures?.height?._gpuTexture?.view;
        const tileView = textures?.tile?._gpuTexture?.view;
        if (!heightView || !tileView || !tileStreamer._tileInfo?.size) return false;
        const up = normalize(cameraKm);
        const ground = up.map(x => x * planetRadiusKm);
        for (const entry of Object.values(this.maps)) {
            const { spec } = entry;
            entry.age++;
            if (entry === this.maps.middle && !this.maps.wide.version) continue;
            const moved = entry.anchor ? Math.hypot(...ground.map((x, i) => x - entry.anchor[i])) : Infinity;
            const move = moved >= spec.extentKm * 0.1;
            if (!move && entry.age < spec.refreshFrames) continue;
            entry.age = 0;
            if (move) {
                this._place(entry, up, moved, planetRadiusKm);
                entry.zeroKm = Math.hypot(...cameraKm) - planetRadiusKm;
            }
            const { count, hash } = this._collectTiles(entry, tileStreamer, planetRadiusKm);
            // Nothing new was loaded since: the map would come out the same.
            const key = `${entry.anchor}:${hash}:${entry === this.maps.middle ? this.maps.wide.version : ''}`;
            if (key === entry.key) continue;
            entry.key = key;
            this.device.queue.writeBuffer(entry.frame, 0, new Float32Array([
                ...entry.e1, spec.extentKm, ...entry.e2, entry.zeroKm, ...entry.up, planetRadiusKm,
                heightScaleKm, spec.size, 0, 1,
            ]));
            this.device.queue.writeBuffer(this._tiles, 0, this._tileBytes, 0, Math.max(1, count) * TILE_WORDS * 4);
            this._encode(encoder, entry, count, heightView, tileView);
            entry.version++;
            // One map a frame.
            return true;
        }
        return false;
    }

    /**
     * Where the land's shadow (CLOUD_LAND_SHADE_WGSL) lies, as the last three vectors of CloudUniforms: axis and extent, axis
     * and radius of the stored zero, middle and planet radius. null before there is a map. encodeShade() then draws it.
     */
    nextShade(sun) {
        const { wide } = this.maps;
        if (!this.ready || !wide.version) return null;
        const last = this._shade;
        if (!last || last.version !== wide.version || Math.hypot(...sun.map((x, i) => x - last.sun[i])) > SHADE_TURN) {
            const { e1, e2, up, zeroKm, spec } = wide;
            const radius = Math.hypot(...wide.anchor);
            this._shade = {
                version: wide.version, sun: [...sun], due: true,
                frame: [...e1, spec.extentKm, ...e2, radius + zeroKm, ...up, radius],
            };
            this.device.queue.writeBuffer(this._shadeFrame, 0,
                new Float32Array([...e1, spec.extentKm, ...e2, zeroKm, ...up, radius, 0, 0, 0, 0, ...sun, 0]));
        }
        return this._shade.frame;
    }

    /** Before anything reads the land's shadow, and before update() moves the map it is made from. */
    encodeShade(encoder) {
        if (!this._shade?.due) return;
        this._shade.due = false;
        this._run(encoder, 'clouds land shade', [this._shadeStep]);
    }

    _run(encoder, label, steps) {
        const pass = encoder.beginComputePass({ label });
        for (const { pipeline, bindGroup, groups } of steps) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(groups, groups);
        }
        pass.end();
    }

    // Moves a map by whole texels and without turning it, so that the same places keep the same texels: a map sampled in
    // other places comes out a little different, and what lies on it would jump.
    _place(entry, up, moved, radius) {
        const { spec } = entry;
        if (moved < spec.extentKm) {
            const texel = spec.extentKm / spec.size;
            const k = radius / dot(up, entry.up);
            const [a, b] = [entry.e1, entry.e2].map(axis => Math.round(dot(up, axis) * k / texel) * texel);
            const e1 = entry.e1;
            entry.up = normalize(entry.up.map((x, i) => x * radius + e1[i] * a + entry.e2[i] * b));
            entry.e1 = normalize(e1.map((x, i) => x - entry.up[i] * dot(e1, entry.up)));
        } else {
            entry.up = up;
            entry.e1 = normalize(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        }
        entry.e2 = cross(entry.up, entry.e1);
        entry.anchor = entry.up.map(x => x * radius);
    }

    _encode(encoder, entry, count, heightView, tileView) {
        const render = encoder.beginRenderPass({
            label: 'clouds land map',
            colorAttachments: [{ view: entry.rawView, loadOp: 'clear', storeOp: 'store', clearValue: [-entry.zeroKm, 0, 0, 0] }],
        });
        render.setPipeline(this._bakePipeline);
        render.setBindGroup(0, this.device.createBindGroup({
            layout: this._bakeLayout,
            entries: [{ buffer: entry.frame }, { buffer: this._tiles }, heightView, tileView].map((resource, binding) => ({ binding, resource })),
        }));
        render.draw(6, count);
        render.end();
        this._run(encoder, 'clouds land filter', entry.steps);
    }

    // The loaded tiles that may touch the map, coarse ones first, so that finer ones are drawn over them.
    _collectTiles(entry, tileStreamer, radius) {
        const { spec, up, e1, e2 } = entry;
        const found = [];
        for (const info of tileStreamer._tileInfo.values()) {
            if (info.layer == null) continue;
            const grid = 2 ** info.depth;
            const widthKm = 2 * radius / grid;
            let bounds = [0, 0, 1, 1];
            const centre = normalize(faceDirection(info.face, (info.x + 0.5) / grid, (info.y + 0.5) / grid));
            const away = radius * Math.acos(Math.min(1, Math.max(-1, dot(centre, up))));
            if (away > 0.75 * spec.extentKm + 1.2 * widthKm) continue;
            if (widthKm < 0.25 * radius && away < 0.5 * radius) {
                bounds = [Infinity, Infinity, -Infinity, -Infinity];
                for (let i = 0; i < 9; i++) {
                    const d = faceDirection(info.face, (info.x + (i % 3) / 2) / grid, (info.y + Math.floor(i / 3) / 2) / grid);
                    const k = radius / dot(d, up);
                    const a = dot(d, e1) * k / spec.extentKm + 0.5;
                    const b = dot(d, e2) * k / spec.extentKm + 0.5;
                    bounds = [Math.min(bounds[0], a), Math.min(bounds[1], b), Math.max(bounds[2], a), Math.max(bounds[3], b)];
                }
                // The edges between the points bulge a little.
                const margin = 0.03 * Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) + 1 / spec.size;
                bounds = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
                if (bounds[0] > 1 || bounds[1] > 1 || bounds[2] < 0 || bounds[3] < 0) continue;
            }
            found.push({ info, bounds });
        }
        found.sort((a, b) => a.info.depth - b.info.depth);
        // Past the limit leave the finest out: they are the smallest on the map.
        const count = Math.min(found.length, MAX_TILES);
        const words = new Uint32Array(this._tileBytes);
        const floats = new Float32Array(this._tileBytes);
        // Order independent: the list is not sorted within a depth.
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
        for (const { raw, map, frame } of Object.values(this.maps)) for (const r of [raw, map, frame]) r.destroy();
        this._reliefTexture?.destroy();
        this._tiles?.destroy();
        this._shadeFrame?.destroy();
    }
}
