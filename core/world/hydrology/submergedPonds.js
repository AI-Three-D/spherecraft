import { planeToDir } from './lakeRefine.js';

// A fully submerged lower pond cannot have a second visible water surface.
// Only remove it when every solved water texel is covered by a higher pond;
// a partial overlap can be a real pair of neighbouring basins.
export function removeSubmergedPonds(ponds, radius) {
    if (ponds.length < 2) return ponds;
    const frameRadius = f => Math.hypot(Math.max(Math.abs(f.x0), Math.abs(f.x0 + f.nx * f.spacing)),
        Math.max(Math.abs(f.y0), Math.abs(f.y0 + f.ny * f.spacing)));
    const cellM = Math.max(1, ...ponds.map(p => frameRadius(p.rec.frame))) + 1;
    const cell = d => d.map(v => Math.floor(v * radius / cellM));
    const key = q => q.join(',');
    const bins = new Map(), keep = new Set();
    const maskAt = (rec, d) => {
        const f = rec.frame, den = d[0] * f.c[0] + d[1] * f.c[1] + d[2] * f.c[2];
        if (den <= 0) return 0;
        const x = (d[0] * f.e1[0] + d[1] * f.e1[1] + d[2] * f.e1[2]) / den * radius;
        const y = (d[0] * f.e2[0] + d[1] * f.e2[1] + d[2] * f.e2[2]) / den * radius;
        const i = Math.floor((x - f.x0) / f.spacing), j = Math.floor((y - f.y0) / f.spacing);
        return i >= 0 && j >= 0 && i < f.nx && j < f.ny ? rec.mask[j * f.nx + i] : 0;
    };
    for (const pond of [...ponds].sort((a, b) => b.rec.level - a.rec.level)) {
        const rec = pond.rec, f = rec.frame, first = rec.mask.indexOf(2);
        const dirAt = k => planeToDir(f.x0 + (k % f.nx + .5) * f.spacing,
            f.y0 + (Math.floor(k / f.nx) + .5) * f.spacing, f, radius);
        let submerged = false;
        if (first >= 0) {
            const d = dirAt(first), q = cell(d);
            for (let x = -1; x <= 1 && !submerged; x++) for (let y = -1; y <= 1 && !submerged; y++) for (let z = -1; z <= 1 && !submerged; z++) {
                for (const higher of bins.get(key([q[0] + x, q[1] + y, q[2] + z])) ?? []) {
                    if (higher.rec.level <= rec.level + .01 || maskAt(higher.rec, d) !== 2) continue;
                    let covered = true;
                    for (let k = first + 1; k < rec.mask.length; k++) {
                        if (rec.mask[k] === 2 && maskAt(higher.rec, dirAt(k)) !== 2) { covered = false; break; }
                    }
                    if (covered) { submerged = true; break; }
                }
            }
        }
        if (!submerged) {
            keep.add(pond);
            const k = key(cell(f.c));
            if (!bins.has(k)) bins.set(k, []);
            bins.get(k).push(pond);
        }
    }
    return ponds.filter(p => keep.has(p));
}
