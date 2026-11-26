import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildTerrainPassFragmentWGSL, buildTerrainPassVertexWGSL } from '../shaders/webgpu/terrainPass.wgsl.js';
import { buildTerrainDrawListWGSL, DRAW_BUCKETS, drawBucket, frustumPlanes, TILE_KINDS } from './terrainDrawList.wgsl.js';
import { buildTileBoundsWGSL } from '../../../world/quadtree/tileBounds.js';
import { airFrame, AIR_HEIGHTS, airUv, buildAirTableWGSL } from './TerrainAir.js';
import { stripGridIndices } from './TerrainPass.js';
import { normalizeBiomeLandscape } from '../../../world/terrain-generator/biomeLandscapeConfig.js';

const valid = code => expect(() => validate(parseWgsl(code))).not.toThrow();

describe('terrain pass shaders', () => {
    const options = { faceSizeMeters: 262144 };
    const kinds = { near: { far: false }, mid: { fine: false }, far: { live: false }, all: {} };
    for (const [name, kind] of Object.entries(kinds)) {
        for (const water of [false, true]) for (const rain of [false, true]) for (const half of [false, true]) {
            it(`validates ${name}, water ${water}, rain ${rain}, half ${half}`, () => {
                const code = buildTerrainPassFragmentWGSL({ ...options, ...kind, water, rain, half });
                valid(code);
                // Its presence alone makes the GPU shade every hidden layer.
                expect(code).not.toMatch(/\bdiscard;/);
                expect(code.includes('applyWater(')).toBe(water);
            });
        }
    }
    const biome = normalizeBiomeLandscape({ preset: 'earth' });
    for (const [name, kind] of Object.entries(kinds)) {
        for (const half of [false, true]) {
            it(`validates ${name} of the landscape's climate, half ${half}`, () => {
                const code = buildTerrainPassFragmentWGSL({ ...options, ...kind, water: true, rain: true, half, biome });
                valid(code);
                expect(code).toContain('var climateMap');
                // The far tier is drawn from the climate, not from the tile's colour.
                expect(code.includes('tileColors, clampSampler')).toBe(false);
            });
        }
    }
    it('validates the exact air', () => valid(buildTerrainPassFragmentWGSL({ ...options, exactAir: true })));
    it('validates the rest', () => {
        valid(buildTerrainPassVertexWGSL({ segments: 128 }));
        valid(buildTerrainDrawListWGSL({ lodLevels: 7, capacity: 8192, solidLod: 5 }));
        valid(buildTileBoundsWGSL(128));
        valid(buildAirTableWGSL());
    });
});

describe('draw buckets', () => {
    it('are distinct', () => {
        const seen = new Set();
        for (let mesh = 0; mesh < 8; mesh++) for (let kind = 0; kind < TILE_KINDS; kind++) for (const wet of [false, true]) seen.add(drawBucket(mesh, kind, wet));
        expect(seen.size).toBe(DRAW_BUCKETS);
        expect(Math.max(...seen)).toBe(DRAW_BUCKETS - 1);
    });
});

describe('frustum planes', () => {
    it('hold what is in front of the camera and nothing behind it, about the planet\'s centre', () => {
        const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];       // at z = 50, looking along -z
        const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.001, -1, 0, 0, -0.1, 0];
        const origin = { x: 10, y: 0, z: 0 };
        const planes = frustumPlanes(view, projection, origin);
        const inside = p => Array.from({ length: 5 }, (_, i) => planes[i * 4] * (p[0] - origin.x) + planes[i * 4 + 1] * (p[1] - origin.y)
            + planes[i * 4 + 2] * (p[2] - origin.z) + planes[i * 4 + 3]).every(d => d >= 0);
        expect(inside([0, 0, 20])).toBe(true);
        expect(inside([25, 0, 20])).toBe(true);
        expect(inside([35, 0, 20])).toBe(false);
        expect(inside([0, 0, 60])).toBe(false);
    });
});

describe('the grid in strips', () => {
    it('draws every cell once, like the plain grid', () => {
        const indices = stripGridIndices(128);
        expect(indices.length).toBe(128 * 128 * 6);
        const triangles = new Set();
        for (let i = 0; i < indices.length; i += 3) triangles.add(`${indices[i]} ${indices[i + 1]} ${indices[i + 2]}`);
        expect(triangles.size).toBe(128 * 128 * 2);
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
            const a = y * 129 + x;
            expect(triangles.has(`${a} ${a + 129} ${a + 1}`) && triangles.has(`${a + 1} ${a + 129} ${a + 130}`)).toBe(true);
        }
    });
    it('runs a vertex little more than once', () => {
        const indices = stripGridIndices(128);
        let runs = 0;
        const cache = [];
        for (const v of indices) if (!cache.includes(v)) { runs++; cache.push(v); if (cache.length > 32) cache.shift(); }
        expect(runs / (129 * 129)).toBeLessThan(1.15);
    });
});

describe('air table', () => {
    it('keeps a row at the middle height, and all heights and distances inside', () => {
        for (const altitude of [2, 300, 3000, 60000]) {
            const f = airFrame({ altitude, radius: 131072, top: 5000 });
            expect(airUv(f, f.middle, 1000)[1] * AIR_HEIGHTS - 0.5).toBeCloseTo((AIR_HEIGHTS - 1) / 2, 6);
            for (const h of [-400, 0, 900, 5000]) for (const d of [10, 500, 20000, 500000]) for (const x of airUv(f, h, d)) {
                expect(x).toBeGreaterThan(0);
                expect(x).toBeLessThan(1);
            }
        }
    });
});
