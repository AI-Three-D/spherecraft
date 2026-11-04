import { noise3 } from './noise.js';

const isPoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

/**
 * Edit shapes, described as data:
 *   { type: 'sphere',    center: [x, y, z], radius }
 *   { type: 'capsule',   a: [x, y, z], b: [x, y, z], radius }
 *   { type: 'ellipsoid', center: [x, y, z], radii: [rx, ry, rz] }
 * plus optional roughness: { amplitude (m), frequency (1/m), seed } that displaces the surface with noise.
 * Coordinates are frame-local metres.
 *
 * @returns {{distance: (x: number, y: number, z: number) => number, min: number[], max: number[]}}
 *          signed distance in metres (negative inside) and a bounding box that contains the shape
 */
export function compileShape(shape) {
    let distance, min, max;
    if (shape?.type === 'sphere') {
        const { center: c, radius: r } = shape;
        if (!isPoint(c) || !(r > 0)) throw new Error('sphere needs center [x, y, z] and a positive radius');
        distance = (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;
        min = c.map(v => v - r);
        max = c.map(v => v + r);
    } else if (shape?.type === 'capsule') {
        const { a, b, radius: r } = shape;
        if (!isPoint(a) || !isPoint(b) || !(r > 0)) throw new Error('capsule needs a, b and a positive radius');
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const length2 = ux * ux + uy * uy + uz * uz;
        distance = (x, y, z) => {
            const px = x - a[0], py = y - a[1], pz = z - a[2];
            let t = length2 > 0 ? (px * ux + py * uy + pz * uz) / length2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            return Math.hypot(px - ux * t, py - uy * t, pz - uz * t) - r;
        };
        min = a.map((v, n) => Math.min(v, b[n]) - r);
        max = a.map((v, n) => Math.max(v, b[n]) + r);
    } else if (shape?.type === 'ellipsoid') {
        const { center: c, radii } = shape;
        if (!isPoint(c) || !isPoint(radii) || !radii.every(r => r > 0)) throw new Error('ellipsoid needs center and positive radii');
        const [rx, ry, rz] = radii, smallest = Math.min(rx, ry, rz);
        distance = (x, y, z) => {
            const px = x - c[0], py = y - c[1], pz = z - c[2];
            const k0 = Math.hypot(px / rx, py / ry, pz / rz);
            const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
            return k1 < 1e-9 ? -smallest : k0 * (k0 - 1) / k1;
        };
        min = c.map((v, n) => v - radii[n]);
        max = c.map((v, n) => v + radii[n]);
    } else {
        throw new Error(`unknown edit shape: ${shape?.type}`);
    }

    const rough = shape.roughness;
    if (rough && rough.amplitude) {
        const { amplitude, frequency = 1, seed = 0 } = rough;
        if (!Number.isFinite(amplitude) || !(frequency > 0)) throw new Error('roughness needs a finite amplitude and a positive frequency');
        const smooth = distance, reach = Math.abs(amplitude);
        distance = (x, y, z) => smooth(x, y, z) + amplitude * noise3(x * frequency, y * frequency, z * frequency, seed);
        min = min.map(v => v - reach);
        max = max.map(v => v + reach);
    }
    return { distance, min, max };
}