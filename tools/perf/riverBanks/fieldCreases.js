// Page-side probe: where a junction field's solved bed has steps or creases
// that the natural ground does not, next to which rule set each cell.
// Needs the service to keep its full bake (window.__junctionDebug = true
// before the field is built; see JunctionFieldService._build).
export function fieldCreases({ every = 3, stepM = 0.25, creaseM = 0.12 } = {}) {
    const g = window.gameEngine, s = g.junctionFieldService, w = g.waterGpuData, R = w.R;
    const cam = g.camera.position, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const rel = [cam.x - o.x, cam.y - o.y, cam.z - o.z], len = Math.hypot(...rel), dir = rel.map(v => v / len);
    let best = null;
    for (const entry of s.cache.values()) {
        if (!entry.debug) continue;
        const F = entry.debug.frame, k = dir.reduce((a, v, i) => a + v * F.c[i], 0);
        const x = R * dir.reduce((a, v, i) => a + v * F.e1[i], 0) / k, y = R * dir.reduce((a, v, i) => a + v * F.e2[i], 0) / k;
        const u = (x - F.x0) / F.spacingM, v = (y - F.y0) / F.spacingM;
        const inside = u >= 0 && v >= 0 && u < F.width && v < F.height;
        if (inside && (!best || entry.debug.width * entry.debug.height < best.d.width * best.d.height)) best = { d: entry.debug, u, v, key: entry.field.key };
    }
    if (!best) return { error: 'no debug field under the camera', keys: [...s.cache.keys()] };
    const d = best.d, W = d.width, H = d.height, f = d.field, nat = d.natural;
    const bed = i => f[4 * i + 1];
    const step = [], cat = [];
    for (let y = 1; y + 1 < H; y += every) {
        let a = '', b = '';
        for (let x = 1; x + 1 < W; x += every) {
            const i = y * W + x;
            // Height step against neighbours beyond what the natural ground has,
            // and the second difference (crease) beyond the natural's.
            let jump = 0, crease = 0;
            for (const [p, q] of [[i - 1, i + 1], [i - W, i + W]]) {
                jump = Math.max(jump, Math.abs(bed(p) - bed(i)) - Math.abs(nat[p] - nat[i]), Math.abs(bed(q) - bed(i)) - Math.abs(nat[q] - nat[i]));
                crease = Math.max(crease, Math.abs(bed(p) + bed(q) - 2 * bed(i)) - Math.abs(nat[p] + nat[q] - 2 * nat[i]));
            }
            a += Math.abs(x - best.u) < every && Math.abs(y - best.v) < every ? '@' : jump > stepM ? '#' : crease > creaseM ? '+' : nat[i] - bed(i) > 0.05 ? '-' : '.';
            const wet = d.wetDistance?.[i];
            b += d.fixedBed[i] ? (Math.abs(d.bedGuide[i] - d.oldBed[i]) < 1e-3 ? 'o' : Math.abs(d.bedGuide[i] - nat[i]) < 1e-3 ? 'n' : 'F')
                : wet > 0 ? 'w' : wet > -40 ? 'c' : '?';
        }
        step.push(a); cat.push(b);
    }
    return { key: best.key, width: W, height: H, every, camera: [best.u | 0, best.v | 0],
        legend: 'step: @ camera, # step, + crease, - cut, . natural | cat: w wet, c relaxed collar, o fixed to carved, n fixed to natural, F fixed other',
        rows: step.map((r, i) => r + '   ' + cat[i]) };
}
