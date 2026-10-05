import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    TERRAIN_FEATURES,
    createTerrainFeatureToggleWgsl,
    describeTerrainFeatures,
    normalizeTerrainFeatures,
    terrainFeatureDisableMask,
} from './terrainFeatureToggles.js';

describe('terrain feature toggles', () => {
    it('defaults every feature on (mask 0)', () => {
        const { features, unknown } = normalizeTerrainFeatures({});
        expect(unknown).toEqual([]);
        expect(Object.values(features).every(v => v === true)).toBe(true);
        expect(terrainFeatureDisableMask(features)).toBe(0);
    });

    it('sets one bit per disabled feature, in table order', () => {
        const { features } = normalizeTerrainFeatures({ mountains: false, microDetail: false });
        const bit = (key) => 1 << TERRAIN_FEATURES.findIndex(f => f.key === key);
        expect(terrainFeatureDisableMask(features)).toBe((bit('mountains') | bit('microDetail')) >>> 0);
    });

    it('keeps earlier state for keys not given and reports unknown keys', () => {
        const first = normalizeTerrainFeatures({ highlands: false }).features;
        const { features, unknown } = normalizeTerrainFeatures({ meso3: false, volcanoes: false }, first);
        expect(features.highlands).toBe(false);
        expect(features.meso3).toBe(false);
        expect(features.mountains).toBe(true);
        expect(unknown).toEqual(['volcanoes']);
        expect(describeTerrainFeatures(features).find(r => r.feature === 'highlands').on).toBe(false);
    });

    it('fits the 32-bit uniform mask', () => {
        expect(TERRAIN_FEATURES.length).toBeLessThanOrEqual(32);
        expect(new Set(TERRAIN_FEATURES.map(f => f.wgsl)).size).toBe(TERRAIN_FEATURES.length);
    });

    it('every TF_ constant used by the terrain shaders is in the table, and every table entry is used', () => {
        const roots = ['templates/terrain-shaders', 'core/world/shaders/webgpu', 'core/world/water'];
        const used = new Set();
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) { walk(p); continue; }
                if (!name.endsWith('.wgsl.js')) continue;
                for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bTF_[A-Z0-9_]+\b/g)) used.add(m[0]);
            }
        };
        const repo = path.resolve(__dirname, '../../..');
        for (const r of roots) walk(path.join(repo, r));
        const declared = new Set(TERRAIN_FEATURES.map(f => f.wgsl));
        expect([...used].filter(u => !declared.has(u))).toEqual([]);
        expect([...declared].filter(d => !used.has(d))).toEqual([]);
        expect(createTerrainFeatureToggleWgsl()).toContain('fn terrainFeatureOn');
    });
});
