import { dirToPlane, planeToDir } from './lakeRefine.js';
import { patchRectsMayOverlap } from './patchOverlap.js';

// Connected components of ponds whose solved water overlaps. Candidate frames
// use a conservative 3-D spatial index; the actual decision samples water,
// not just the bounding boxes or pond seeds.
export function pondOverlapGroups(ponds, radius) {
    const count = ponds.length;
    if (count < 2) return [];
    const extent = f => Math.hypot(Math.max(Math.abs(f.x0), Math.abs(f.x0 + f.nx * f.spacing)),
        Math.max(Math.abs(f.y0), Math.abs(f.y0 + f.ny * f.spacing)));
    const bounds = ponds.map(p => extent(p.rec.frame));
    let maxExtent = 1;
    for (const bound of bounds) maxExtent = Math.max(maxExtent, bound);
    const cellM = maxExtent * 2 + 1;
    const cell = d => d.map(v => Math.floor(v * radius / cellM));
    const bins = new Map(), parent = Int32Array.from({ length: count }, (_, i) => i);
    const wetCounts = ponds.map(p => p.rec.mask.reduce((n, v) => n + (v === 2 ? 1 : 0), 0));
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const maskAt = (rec, d) => {
        const f = rec.frame, den = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
        if (den <= 0) return 0;
        const x = (d[0] * f.e1[0] + d[1] * f.e1[1] + d[2] * f.e1[2]) / den * radius;
        const y = (d[0] * f.e2[0] + d[1] * f.e2[1] + d[2] * f.e2[2]) / den * radius;
        const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
        return i >= 0 && j >= 0 && i < f.nx && j < f.ny ? rec.mask[j * f.nx + i] : 0;
    };
    const intersects = (a, b, wet) => {
        const f = a.rec.frame, mask = a.rec.mask;
        let matches = 0;
        const needed = Math.min(4, Math.max(1, Math.ceil(wet / 4)));
        for (let k = 0; k < mask.length; k++) {
            if (mask[k] !== 2) continue;
            const d = planeToDir(f.x0 + (k % f.nx + .5) * f.spacing,
                f.y0 + (Math.floor(k / f.nx) + .5) * f.spacing, f, radius);
            if (maskAt(b.rec, d) === 2 && ++matches >= needed) return true;
        }
        return false;
    };
    for (let i = 0; i < count; i++) {
        const a = ponds[i], f = a.rec.frame, q = cell(f.c);
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
            for (const j of bins.get([q[0] + x, q[1] + y, q[2] + z].join(',')) ?? []) {
                if (root(i) === root(j)) continue;
                const b = ponds[j], c = b.rec.frame.c;
                if (Math.hypot(f.c[0] - c[0], f.c[1] - c[1], f.c[2] - c[2]) * radius > bounds[i] + bounds[j] + 1) continue;
                if (!patchRectsMayOverlap(f, b.rec.frame, radius)) continue;
                const hit = wetCounts[i] <= wetCounts[j]
                    ? intersects(a, b, wetCounts[i]) || intersects(b, a, wetCounts[j])
                    : intersects(b, a, wetCounts[j]) || intersects(a, b, wetCounts[i]);
                if (hit) parent[root(i)] = root(j);
            }
        }
        const k = q.join(',');
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k).push(i);
    }
    const groups = new Map();
    for (let i = 0; i < count; i++) { const k = root(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    return [...groups.values()].filter(g => g.length > 1);
}

// A common sample grid around all masks, with room for the shared spillway.
export function sharedPondFrame(ponds, radius, spacing, marginM = 1500) {
    const basis = ponds.reduce((best, p) => p.rec.mask.length > best.rec.mask.length ? p : best).rec.frame;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const p of ponds) {
        const f = p.rec.frame;
        for (const x of [f.x0, f.x0 + f.nx * f.spacing]) for (const y of [f.y0, f.y0 + f.ny * f.spacing]) {
            const d = planeToDir(x, y, f, radius);
            if (d[0] * basis.c[0] + d[1] * basis.c[1] + d[2] * basis.c[2] <= 0) throw new Error('Pond group spans incompatible tangent frames');
            const [u, v] = dirToPlane(d, basis, radius);
            xmin = Math.min(xmin, u); xmax = Math.max(xmax, u); ymin = Math.min(ymin, v); ymax = Math.max(ymax, v);
        }
    }
    return { c: basis.c, e1: basis.e1, e2: basis.e2, spacing, x0: xmin - marginM, y0: ymin - marginM,
        nx: Math.ceil((xmax - xmin + 2 * marginM) / spacing), ny: Math.ceil((ymax - ymin + 2 * marginM) / spacing) };
}
