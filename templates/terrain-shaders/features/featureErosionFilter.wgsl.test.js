import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { createTerrainFeatureErosionFilter } from './featureErosionFilter.wgsl.js';

// The erosion filter is self-contained WGSL; validate it with naga together
// with a small entry point that calls both variants.
describe('erosion filter shader', () => {
    it('compiles', () => {
        const code = createTerrainFeatureErosionFilter() + `
@group(0) @binding(0) var<storage, read_write> outBuf: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let prm = erosionDefaultParams(1000.0, 7);
    let p = vec2<f32>(f32(gid.x), 0.5);
    let a = erosionFilter2D(p, vec3<f32>(0.0, 0.3, 0.1), 0.2, prm);
    let up = normalize(vec3<f32>(1.0, f32(gid.x) * 0.01, 0.3));
    let b = erosionFilterSphere(up * 131072.0, up, 100.0, vec3<f32>(0.1, 0.0, -0.2), 0.2, prm);
    outBuf[gid.x] = vec4<f32>(a.delta.x, a.ridgeMap, b.heightDelta, b.ridgeMap);
}`;
        let error = null;
        try {
            validate(parseWgsl(code));
        } catch (e) {
            error = e?.formatted ?? String(e);
        }
        expect(error).toBeNull();
    });
});
