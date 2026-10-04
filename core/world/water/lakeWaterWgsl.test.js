import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { createLakeWaterWgsl, LAKE_PARAMS_FLOATS, LAKE_RECORD_FLOATS } from './lakeWaterWgsl.js';
import { cellDir, dirToCell } from '../hydrology/waterGraph.js';

describe('lake water WGSL', () => {
    it('validates inside a fragment shader', () => {
        const src = createLakeWaterWgsl({ group: 3 }) + `
@group(3) @binding(8) var linearSampler: sampler;
@fragment
fn main(@location(0) wp: vec3<f32>) -> @location(0) vec4<f32> {
    let c = applyLakeWater(vec3<f32>(0.3, 0.4, 0.2), wp, vec3<f32>(0.0, 140000.0, 0.0), vec3<f32>(0.0),
        vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0), vec3<f32>(0.3, 0.4, 0.6), linearSampler);
    return vec4<f32>(c, 1.0);
}`;
        expect(() => validate(parseWgsl(src))).not.toThrow();
    });

    it('struct sizes match the JS packing', () => {
        const src = createLakeWaterWgsl();
        const count = (name) => {
            const body = src.match(new RegExp(`struct ${name} \\{([^}]*)\\}`))[1];
            return body.split(/[,;]/).map(s => s.trim()).filter(s => s.includes(':'))
                .reduce((n, f) => n + (f.includes('vec4') ? 4 : f.includes('vec3') ? 3 : 1), 0);
        };
        expect(count('WaterLake')).toBe(LAKE_RECORD_FLOATS);
        expect(count('WaterParams')).toBe(LAKE_PARAMS_FLOATS);
    });

    it('waterDirToCell matches waterGraph.dirToCell (CPU mirror of the WGSL)', () => {
        // Same arithmetic as the WGSL function, in JS.
        const wgslCell = (d, n) => {
            const a = d.map(Math.abs);
            let face, x, y;
            if (a[0] >= a[1] && a[0] >= a[2]) { if (d[0] > 0) { face = 0; x = -d[2] / d[0]; y = d[1] / d[0]; } else { face = 1; x = d[2] / -d[0]; y = d[1] / -d[0]; } }
            else if (a[1] >= a[2]) { if (d[1] > 0) { face = 2; x = d[0] / d[1]; y = -d[2] / d[1]; } else { face = 3; x = d[0] / -d[1]; y = d[2] / -d[1]; } }
            else if (d[2] > 0) { face = 4; x = d[0] / d[2]; y = d[1] / d[2]; } else { face = 5; x = -d[0] / -d[2]; y = d[1] / -d[2]; }
            const i = Math.min(n - 1, Math.max(0, Math.floor((x + 1) * 0.5 * n)));
            const j = Math.min(n - 1, Math.max(0, Math.floor((y + 1) * 0.5 * n)));
            return face * n * n + j * n + i;
        };
        const N = 64;
        for (let id = 0; id < 6 * N * N; id += 7) {
            const d = cellDir(id, N);
            expect(wgslCell(d, N)).toBe(dirToCell(d, N));
        }
    });
});
