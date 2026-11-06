// Determine which nearest mountain-lake choices are already fixed while
// discovery is still running. Unknown blocks are bounded conservatively;
// uncertainty propagates along the greedy, largest-first selection order.
const chordM = (a, b, R) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * R;
const angleM = (a, b, R) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * R;

export function settledMountainPrefix(candidates, pendingBlocks, origin, R, P) {
    if (!origin) return [];
    const eligible = candidates.filter(p => p.areaKm2 >= P.minAreaKm2 && p.enclosureM >= P.minEnclosureM && p.outflowDropM >= P.minOutflowDropM)
        .map(p => ({ p, r: Math.sqrt(p.areaKm2 * 1e6 / Math.PI) }))
        .sort((a, b) => b.p.areaKm2 - a.p.areaKm2 || a.p.dir[0] - b.p.dir[0] || a.p.dir[1] - b.p.dir[1] || a.p.dir[2] - b.p.dir[2]);
    if (!eligible.length) return [];
    const rMax = Math.max(...eligible.map(v => v.r));
    const cellM = P.minSpacingM + 2 * rMax, lattice = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    for (const entry of eligible) {
        const q = entry.p.dir.map(v => Math.floor(v * R / cellM));
        let blocked = false, uncertain = false;
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
            for (const prev of lattice.get(key(q[0] + x, q[1] + y, q[2] + z)) ?? []) {
                if (prev.state === 'rejected' || angleM(entry.p.dir, prev.p.dir, R) >= P.minSpacingM + entry.r + prev.r) continue;
                if (prev.state === 'kept') blocked = true;
                else uncertain = true;
            }
        }
        if (!blocked && !uncertain) {
            // A block can hide a larger competing pocket. Both its candidate
            // centre and area are bounded by its (margin-inclusive) frame.
            uncertain = pendingBlocks.some(b => b.maxRadiusM + 1 >= entry.r &&
                chordM(entry.p.dir, b.c, R) <= b.pointRadiusM + b.maxRadiusM + entry.r + P.minSpacingM + 1);
        }
        entry.state = blocked ? 'rejected' : uncertain ? 'uncertain' : 'kept';
        const k = key(...q);
        if (!lattice.has(k)) lattice.set(k, []);
        lattice.get(k).push(entry);
    }
    // Until every closer possible pocket is known, its eventual ID/order is
    // not fixed even if the current candidate's own selection is certain.
    const frontier = pendingBlocks.reduce((d, b) => Math.min(d, Math.max(0, chordM(origin, b.c, R) - b.pointRadiusM)), Infinity);
    eligible.sort((a, b) => angleM(origin, a.p.dir, R) - angleM(origin, b.p.dir, R) || a.p.dir[0] - b.p.dir[0] || a.p.dir[1] - b.p.dir[1]);
    const prefix = [];
    for (const entry of eligible) {
        if (angleM(origin, entry.p.dir, R) + 1 >= frontier || entry.state === 'uncertain') break;
        if (entry.state === 'kept') prefix.push(entry.p);
    }
    return prefix;
}
