import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { SHALLOW_WATER_WGSL, SWE_PARAM_FLOATS } from './shallowWaterSim.wgsl.js';

// WGSL syntax, scope and type check without a GPU (naga, as WebAssembly).
// The physics tests need a GPU: terrain-lab/swe-tests.mjs (Node + Dawn).
describe('shallow-water solver WGSL', () => {
    it('parses and validates', () => {
        const module = parseWgsl(SHALLOW_WATER_WGSL);
        expect(() => validate(module)).not.toThrow();
    });

    it('SimParams is SWE_PARAM_FLOATS words', () => {
        const body = SHALLOW_WATER_WGSL.match(/struct SimParams \{([^}]*)\}/)[1];
        const fields = body.split(',').map(s => s.trim()).filter(s => s.includes(':'));
        expect(fields.length).toBe(SWE_PARAM_FLOATS);
    });
});
