import { faceUVToDir, dirToFaceUV } from '../../../core/world/hydrology/waterGraph.js';
import { TileAddress } from '../../../core/world/quadtree/tileAddress.js';
import { decodeBiomeSurface } from '../../../templates/terrain-shaders/biomeLandscape.wgsl.js';

const g = () => window.gameEngine;
const generator = () => g().renderer.quadtreeTileManager.tileStreamer.tileGenerator;
const gpu = tex => tex._gpuTexture.texture;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unit = v => v.map(x => x / Math.hypot(...v));
const vec = ([x, y, z]) => ({ x, y, z });
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export async function survey() {
    g().frameLoop.stop();
    const tg = generator(), gen = g().terrainGenerator, size = tg.textureSize;
    const leads = { desert: [], grassland: [], forest: [], marsh: [], tundra: [], snow: [], glacier: [], granite: [], sediment: [], basalt: [] };
    for (let face = 0; face < 6; face++) {
        const result = await tg._generateTileInternal(new TileAddress(face, 0, 0, 0), {
            requiredTypes: ['tile', 'climate'], includeBaseHeight: true, trackStats: false,
        });
        try {
            const climate = await gen.readTextureWindowRGBA8Unorm(gpu(result.climate), 0, 0, size, size);
            const rows = await gen.readTextureSubregion(gpu(result.baseHeight), 0, 0, size, size, size);
            for (let y = 2; y < size - 2; y += 2) for (let x = 2; x < size - 2; x += 2) {
                const i = (y * size + x) * 4;
                const height = rows[i] * g().planetConfig.maxTerrainHeight;
                const slope = rows[i + 1];
                if (height < 70) continue;
                const [t, m, blue, p] = climate.subarray(i, i + 4);
                const { glacierIce } = decodeBiomeSurface(blue / 255);
                const dir = faceUVToDir(face, x / (size - 1), y / (size - 1));
                const add = (key, score) => leads[key].push({ dir, height, slope, temperature: t / 255, humidity: m / 255, province: p / 255, glacierIce, score });
                if (t > 160 && m < 93 && height < 720 && slope < 0.22) add('desert', (93 - m) / 60 - slope);
                if (t > 141 && m > 96 && m < 144 && slope < 0.19 && height < 850) add('grassland', 1 - Math.abs(m - 124) / 100 - slope);
                if (t > 148 && m > 164 && slope < 0.25) add('forest', m / 255 - slope * 0.42);
                if (t > 145 && m > 175 && height < 500 && slope < 0.09) add('marsh', m / 255 - slope * 1.8 - height / 5000);
                if (t > 103 && t < 133 && m > 96 && slope < 0.31) add('tundra', 1 - Math.abs(t - 116) / 100 - slope * 0.5);
                if (t < 93 && height > 1500 && slope < 0.32) add('snow', height / 7000 - t / 255 + slope * 0.2);
                if (glacierIce > 0.25) add('glacier', glacierIce);
                if (slope > 0.42 && height > 630) {
                    if (p > 107 && p < 151) add('granite', slope + height / 10000);
                    if (p > 171) add('sediment', slope * 0.7 + p / 255);
                    if (p < 79) add('basalt', slope * 0.7 + (255 - p) / 255);
                }
            }
        } finally { Object.values(result).forEach(tex => gpu(tex).destroy()); }
    }
    return Object.fromEntries(Object.entries(leads).map(([key, rows]) => {
        const selected = [];
        for (const site of rows.sort((a, b) => b.score - a.score)) {
            if (selected.length === 8) break;
            if (selected.every(other => dot(other.dir, site.dir) < 0.996)) selected.push(site);
        }
        return [key, selected];
    }));
}

export async function setPose({ dir, position, target, eye = 180, down = 0.34, bearing = 70, sun = 0.68, fov = 68 }) {
    const game = g();
    const { x, y, z } = game.planetConfig.origin;
    const origin = [x, y, z];
    const up = unit(position ? position.map((v, i) => v - origin[i]) : dir);
    const sampler = game.waterService._sampler;
    const [height] = await sampler.sampleDirsNatural(new Float32Array([...up, 0]));
    if (!position) {
        const east = unit(cross([0, 1, 0], up));
        const north = cross(up, east);
        const radians = bearing * Math.PI / 180;
        const tangent = east.map((x, i) => x * Math.sin(radians) + north[i] * Math.cos(radians));
        position = up.map((axis, i) => origin[i] + axis * (game.planetConfig.radius + height + eye));
        target = position.map((x, i) => x + 100 * (tangent[i] - up[i] * down));
    }
    window.qtDiag.regional.useCamera({ position: vec(position), target: vec(target), up: vec(up), fov });
    window.__lr.daylightAt(up, sun);
    let stable = 0, resident;
    const until = performance.now() + 45000;
    do {
        await sleep(250);
        resident = window.__lr.residency();
        const idle = resident?.exactVisibleRatio === 1 && !resident.pendingGenerations && !resident.activeGenerations && !resident.pendingCopies;
        stable = idle ? stable + 1 : 0;
    } while (stable < 5 && performance.now() < until);
    return { height, position, target, settled: stable >= 5, resident };
}

export async function tiles(poses, geometryOnly = false) {
    const game = g(), tg = generator(), timer = window.__gpuTimer;
    const streamer = game.renderer.quadtreeTileManager.tileStreamer;
    const { device } = game.renderer.backend;
    game.frameLoop.stop();
    while (game._renderInFlight) await sleep(10);
    await device.queue.onSubmittedWorkDone();
    const { x, y, z } = game.planetConfig.origin;
    const origin = [x, y, z];
    const directions = poses.map(pose => ({ ...pose, dir: pose.dir ?? unit(pose.position.map((v, i) => v - origin[i])) }));
    const samples = directions.filter((pose, i) => directions.findIndex(p => dot(p.dir, pose.dir) > 0.99999) === i);
    const addresses = samples.flatMap(({ dir, name }) => [8, 11].map(depth => {
        const { face, u, v } = dirToFaceUV(unit(dir));
        const n = 1 << depth;
        return { name, address: new TileAddress(face, depth, Math.min(n - 1, Math.floor(u * n)), Math.min(n - 1, Math.floor(v * n))) };
    }));
    const stat = values => {
        const s = values.toSorted((a, b) => a - b);
        return { count: s.length, median: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)] };
    };
    const bins = {};
    for (let round = 0; round < 6; round++) {
        for (const { name, address } of round % 2 ? addresses.toReversed() : addresses) {
            const types = geometryOnly ? streamer._geometryTypes
                : [...streamer._geometryTypes, ...streamer._refinementTypesFor(address)];
            timer.passes = [];
            timer.enabled = timer.supported;
            const begin = performance.now();
            const textures = await tg._generateTileInternal(address, { requiredTypes: types, trackStats: false });
            await device.queue.onSubmittedWorkDone();
            const wallMs = performance.now() - begin;
            timer.enabled = false;
            await timer.drain();
            Object.values(textures).forEach(tex => gpu(tex).destroy());
            if (round === 0) continue;
            const passTimes = timer.passes.map(p => (p.end - p.begin) / 1e6);
            for (const key of [`${name}/${address.depth}`, 'all']) {
                const bin = bins[key] ??= { gpuPassMs: [], fencedMs: [], baseSplatHeightMs: [] };
                bin.gpuPassMs.push(passTimes.reduce((a, t) => a + t, 0));
                bin.fencedMs.push(wallMs);
                const base = timer.passes.find(p => p.label === 'GenPaddedHeightBase');
                if (base) bin.baseSplatHeightMs.push((base.end - base.begin) / 1e6);
            }
        }
    }
    return Object.fromEntries(Object.entries(bins).map(([key, bin]) => [key,
        Object.fromEntries(Object.entries(bin).map(([metric, values]) => [metric, stat(values)]))]));
}
