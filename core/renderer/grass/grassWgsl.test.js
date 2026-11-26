import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildGrassComputeWGSL, buildGrassDrawWGSL } from './grassWgsl.js';
import { normalizeBiomeLandscape } from '../../world/terrain-generator/biomeLandscapeConfig.js';

const valid = code => expect(() => validate(parseWgsl(code))).not.toThrow();
const f = Math.fround;

describe('grass shaders', () => {
    it('validates the scatter with the landscape rules', () => {
        valid(buildGrassComputeWGSL({ faceSizeMeters: 262144, biome: normalizeBiomeLandscape({ preset: 'earth' }) }));
    });
    it('validates the scatter without them', () => valid(buildGrassComputeWGSL({ faceSizeMeters: 262144, biome: null })));
    it('validates the blades', () => valid(buildGrassDrawWGSL()));
});

// placeAbout (grassWgsl.js) in 32-bit floats, against the place worked out in 64 bits.
describe('blade places about the camera', () => {
    const R = 131072, patches = 2 ** 17;
    const axis = [0, 0, 1], u = [1, 0, 0], v = [0, 1, 0];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len = a => Math.hypot(...a);
    const cube = (x, y) => [0, 1, 2].map(i => axis[i] + (2 * x / patches - 1) * u[i] + (2 * y / patches - 1) * v[i]);
    it('are within a tenth of a millimetre over 60 m, far from the face centre', () => {
        const anchor = [97000, 23000];
        const ca = cube(...anchor), la = len(ca), na = ca.map(x => x / la);
        const camera = na.map(x => x * (R + 412.7)).map((x, i) => x + [3.1, -1.7, 0.4][i]);
        const da = na.map((x, i) => x * R - camera[i]);
        const du = u.map(x => f(2 * x / patches)), dv = v.map(x => f(2 * x / patches));
        let worst = 0;
        for (const [dx, dy, h] of [[0.37, 0.81, 401.2], [-20.13, 7.5, 399.7], [25.9, -28.4, 405.03], [3, 3, 410]]) {
            // 32 bits, as the shader does.
            const dc = [0, 1, 2].map(i => f(f(du[i] * f(dx)) + f(dv[i] * f(dy))));
            const grow = f(f(2 * f(dot(ca.map(f), dc))) + f(dot(dc, dc)));
            const l1 = f(Math.sqrt(f(f(f(la) * f(la)) + grow)));
            const k = f(grow / f(f(f(f(la) + l1) * l1) * f(la)));
            const dn = [0, 1, 2].map(i => f(f(dc[i] / l1) - f(f(ca[i]) * k)));
            const upv = [0, 1, 2].map(i => f(f(na[i]) + dn[i]));
            const rel = [0, 1, 2].map(i => f(f(f(R * dn[i]) + f(da[i])) + f(f(h) * upv[i])));
            // 64 bits.
            const c1 = cube(anchor[0] + dx, anchor[1] + dy), n1 = c1.map(x => x / len(c1));
            const exact = n1.map((x, i) => x * (R + h) - camera[i]);
            worst = Math.max(worst, len(rel.map((x, i) => x - exact[i])));
        }
        expect(worst).toBeLessThan(1e-4);
    });
});
