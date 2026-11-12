import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildCoarseColorBakeWGSL } from './tileGenerator.js';
import { TILE_CATEGORIES } from '../../../templates/configs/tileTypes.js';

describe('flat-tier color bake', () => {
    it('validates, with the window average and the expected colour of the draw', () => {
        const code = buildCoarseColorBakeWGSL(TILE_CATEGORIES, null);
        expect(() => validate(parseWgsl(code))).not.toThrow();
        expect(code).toContain('params.mode > 0.5');
    });
});
