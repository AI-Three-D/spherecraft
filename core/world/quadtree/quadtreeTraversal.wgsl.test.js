import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildTraversalShaderSource } from './quadtreeTraversal.wgsl.js';

describe('quadtree traversal shader', () => {
    for (const [regionalFoundation, groundLodHeight] of [[false, false], [true, false], [false, true]]) for (const disableCulling of [false, true]) {
        it(`parses traversal and validates selection helpers, regional=${regionalFoundation}, ground=${groundLodHeight}, culling=${!disableCulling}`, () => {
            const code = buildTraversalShaderSource({ regionalFoundation, groundLodHeight, heightScale: 5000, disableCulling });
            if (groundLodHeight) expect(code).toContain('shouldSubdivideWithCenter(depth, getTileLodCenter(tile, worldCenter))');
            expect(() => parseWgsl(code)).not.toThrow();
            // Naga-wasm rejects the existing reserveQueue storage-pointer
            // argument accepted by Tint/Dawn. Validate the new selection
            // helpers here; the native diagnostic compiles/runs the full pass.
            expect(() => validate(parseWgsl(code.split('fn reserveQueue(')[0]))).not.toThrow();
        });
    }
});
