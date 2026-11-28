import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWgsl, validate } from 'naga-wasm';
import { normalizeBiomeLandscape } from '../terrain-generator/biomeLandscapeConfig.js';
import { buildEcologyWriterWGSL } from './ecologyWriter.wgsl.js';
import { buildEcologyReadWGSL } from './ecologyField.wgsl.js';
import { ECOLOGY_LATTICE_WGSL } from './ecologyLattice.wgsl.js';
import { buildDrawnGroundWGSL } from './drawnGround.wgsl.js';
import { buildWindWGSL } from './wind.wgsl.js';
import { ECO_TABLE_VEC4S, compileEcologyRegistry, standNumericId } from './ecologyRegistry.js';
import { buildGrassComputeWGSL } from '../../renderer/grass/grassWgsl.js';

const valid = code => expect(() => validate(parseWgsl(code))).not.toThrow();
const earth = normalizeBiomeLandscape({ preset: 'earth' });
const game = JSON.parse(readFileSync(new URL('../../../wizard_game/world/ecology.json', import.meta.url), 'utf8'));

describe('ecology shaders', () => {
    it('validate: the habitat writer, with the landscape rules and without', () => {
        valid(buildEcologyWriterWGSL({ biome: earth }));
        valid(buildEcologyWriterWGSL({ biome: null }));
    });
    it('validate: the readers, by layer and by patch over the drawn ground, with the wind', () => {
        valid(`${ECOLOGY_LATTICE_WGSL}${buildDrawnGroundWGSL()}${buildWindWGSL({ binding: [0, 4] })}
${buildEcologyReadWGSL({ a: [1, 0], b: [1, 1], layers: [1, 2], withPatch: true })}
@compute @workgroup_size(1) fn main() {
    let e = ecologyAtPatch(0u, vec2<u32>(5u, 7u), vec2<f32>(0.5));
    let g = groundDrawnAt(0u, vec2<u32>(5u, 7u), vec2<f32>(0.5));
    let s = groundStableAt(0u, vec2<u32>(5u, 7u), vec2<f32>(0.5));
    let l = canopyLight(e, 0.7, 0.0) * nearShadowAt(vec3<f32>(0.0)) * windGust(vec3<f32>(1.0));
    let c = ecologyDebugColour(ecologyAtLayer(3, vec2<f32>(0.2)), 4u);
    _ = g.height + s.height + l.x + c.x;
}`);
    });
    it('validate: grass with the field bound', () => {
        valid(buildGrassComputeWGSL({ faceSizeMeters: 262144, biome: earth, ecology: true }));
    });
});

describe('ecosystem registry', () => {
    it('compiles the game\'s ecology.json without errors', () => {
        const r = compileEcologyRegistry(game);
        expect(r.errors).toEqual([]);
        expect(r.ecosystems.map(e => e.id)).toEqual(['boreal', 'temperate', 'tropical']);
        expect(r.table.length).toBe(ECO_TABLE_VEC4S * 4);
        expect(r.table[0]).toBe(3);
        expect(r.table[1]).toBe(r.stands.length);
    });
    it('gives stands stable ids, apart from open ground and unknown', () => {
        const id = standNumericId('boreal', 'spruce');
        expect(id).toBe(standNumericId('boreal', 'spruce'));
        expect(id).toBeGreaterThan(0);
        expect(id).toBeLessThan(65535);
        const r = compileEcologyRegistry(game);
        expect(r.standById.get(id).id).toBe('spruce');
        // Adding a stand elsewhere leaves this one's id as it was.
        const more = structuredClone(game);
        more.ecosystems[1].stands.push({ id: 'oak-wood', share: 0.1, trees: [] });
        expect(compileEcologyRegistry(more).stands.find(s => s.ecosystem === 'boreal' && s.id === 'spruce').numericId).toBe(id);
    });
    it('reports what does not add up', () => {
        const bad = structuredClone(game);
        bad.ecosystems[0].ground.push({ type: 'fern', stands: ['nowhere'] });
        bad.ecosystems[0].stands[0].canopy.cover = [0.9, 0.2];
        const r = compileEcologyRegistry(bad, { forestSpecies: new Set(['forest:scots-pine']) });
        expect(r.errors.some(e => e.includes('nowhere'))).toBe(true);
        expect(r.errors.some(e => e.includes('canopy.cover'))).toBe(true);
        expect(r.errors.some(e => e.includes('forest:norway-spruce'))).toBe(true);
    });
    it('passes a stand\'s other fields through', () => {
        const extra = structuredClone(game);
        extra.ecosystems[0].stands[0].ageSpread = [20, 140];
        expect(compileEcologyRegistry(extra).stands[0].extra.ageSpread).toEqual([20, 140]);
    });
});
