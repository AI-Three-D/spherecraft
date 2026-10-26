// tools/perf/riverBanks/bankAudit.js
//
// Page side: do the banks hold the river's water? For every traced river
// point within rangeM of the camera, on both sides of the channel's centre
// (the traced line moved by the wobble, as waterWgsl.js waterRiverPoint),
// the drawn ground (hydrology sampler, carved: the terrain height function
// with the river carve, without the tiles' micro detail) and the natural
// ground at offsets beyond the channel's edge (hw + offset).
//
// Per sample: deficit = level + marginM - carved (> 0: the bank is lower
// than the containment target; > marginM: lower than the water), fill =
// carved - natural (> 0: ground raised); exposed: within the river
// surface's reach (offset <= surfaceM) the ground is below the river's
// water and no lake's water covers it there (WaterGpuData.lakeAt): the
// surface's edge would float. Points in a lake (pool < 0) or beside a lake
// at the river's level (lake guard >= level - 0.5 m) are junctions,
// counted apart: the lake's rim decides there.

const R_OFFSETS = [0, 1, 2, 3];

export async function bankAudit({ rangeM = 900, marginM = 0.3, offsets = R_OFFSETS, surfaceM = 2 } = {}) {
    const g = window.gameEngine, s = g.waterService, w = g.waterGpuData, R = w.R, o = g.planetConfig.origin;
    const { riverShapeAt } = await import('/core/world/water/riverShapeNoise.js');
    const shape = { ...(w.carve ?? {}), bankDetail: 0 };
    const p = g.camera.position, cam = [p.x - o.x, p.y - o.y, p.z - o.z];
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const samples = [], dirs = [];
    for (const [rid, rec] of s.riverRecs) {
        if (rec.stride < 20) continue;
        const P = rec.points, st = rec.stride, n = P.length / st, arc = w._arcLengths(rec);
        for (let k = 0; k < n; k++) {
            const d = [P[k * st], P[k * st + 1], P[k * st + 2]], level = P[k * st + 16];
            if (Math.hypot(d[0] * (R + level) - cam[0], d[1] * (R + level) - cam[1], d[2] * (R + level) - cam[2]) > rangeM) continue;
            const a = [P[Math.max(0, k - 1) * st], P[Math.max(0, k - 1) * st + 1], P[Math.max(0, k - 1) * st + 2]];
            const b = [P[Math.min(n - 1, k + 1) * st], P[Math.min(n - 1, k + 1) * st + 1], P[Math.min(n - 1, k + 1) * st + 2]];
            const left = norm(cross(d, norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]])));
            const hw = Math.max(P[k * st + 4], 0.5), off = riverShapeAt(arc[k], rid, hw, shape).off;
            const junction = P[k * st + 9] < 0 || P[k * st + 18] >= level - 0.5;
            for (const side of [1, -1]) for (const x of offsets) {
                const m = off + side * (hw + x);
                const dir = norm([d[0] + left[0] * m / R, d[1] + left[1] * m / R, d[2] + left[2] * m / R]);
                dirs.push(...dir, 0);
                samples.push({ rid, k, s: arc[k], side, x, hw, level, junction, lake: w.lakeAt(dir)?.level ?? -Infinity });
            }
        }
    }
    if (!samples.length) return { rangeM, rivers: 0, samples: 0 };
    const sampler = s._sampler;
    const carved = await sampler.sampleDirsCarved(Float32Array.from(dirs));
    const natural = await sampler.sampleDirsNatural(Float32Array.from(dirs));
    if (!carved) throw new Error('Carved sampler not ready');
    samples.forEach((q, i) => {
        q.carved = carved[i]; q.natural = natural[i]; q.deficit = q.level + marginM - q.carved; q.fill = q.carved - q.natural;
        q.exposed = q.x <= surfaceM && q.carved < q.level && !(q.lake > q.carved);
    });

    // Summaries: open river (not junctions) and junctions; river length
    // counted as the points (each ~ the point spacing) with any failing side.
    const summary = (list) => {
        const by = new Map();
        for (const q of list) {
            const key = `${q.rid}:${q.k}`;
            const e = by.get(key) ?? { s: q.s, rid: q.rid, wetAt2: false, exposed: false, maxDeficit: -Infinity, maxFill: -Infinity };
            if (q.x === 2 && q.carved < q.level) e.wetAt2 = true;
            if (q.exposed) e.exposed = true;
            e.maxDeficit = Math.max(e.maxDeficit, q.deficit);
            e.maxFill = Math.max(e.maxFill, q.fill);
            by.set(key, e);
        }
        const pts = [...by.values()], spacing = (rid) => { const r = s.riverRecs.get(rid); return r.lengthM / Math.max(1, r.points.length / r.stride - 1); };
        const len = f => pts.filter(f).reduce((t, e) => t + spacing(e.rid), 0);
        const d = list.map(q => q.deficit).sort((x, y) => x - y), f = list.map(q => q.fill).sort((x, y) => x - y);
        const q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
        const worst = [...list].sort((x, y) => y.deficit - x.deficit).slice(0, 5).map(e => ({ rid: e.rid, k: e.k, side: e.side, x: e.x, deficit: +e.deficit.toFixed(2) }));
        return {
            points: pts.length, samples: list.length, lengthM: Math.round(len(() => true)),
            // Ground below the water 2 m beyond the edge (water would stand on it).
            wetBeyondEdgeM: Math.round(len(e => e.wetAt2)),
            // ... and not under a lake's water, within the surface's reach.
            exposedM: Math.round(len(e => e.exposed)),
            exposedWorst: list.filter(e => e.exposed).sort((x, y) => (y.level - y.carved) - (x.level - x.carved)).slice(0, 5)
                .map(e => ({ rid: e.rid, k: e.k, side: e.side, x: e.x, belowM: +(e.level - e.carved).toFixed(2) })),
            belowWaterShare: +(list.filter(e => e.carved < e.level).length / list.length).toFixed(3),
            belowTargetShare: +(list.filter(e => e.deficit > 0.02).length / list.length).toFixed(3),
            deficitP95: +q(d, 0.95).toFixed(2), deficitMax: +d[d.length - 1].toFixed(2),
            // Ground raised above the natural terrain (the containment fill).
            raisedShare: +(list.filter(e => e.fill > 0.05).length / list.length).toFixed(3),
            raisedOver1mM: Math.round(len(e => e.maxFill > 1)), fillP95: +q(f, 0.95).toFixed(2), fillMax: +f[f.length - 1].toFixed(2),
            worst,
        };
    };
    const open = samples.filter(q => !q.junction), junction = samples.filter(q => q.junction);
    return { rangeM, marginM, offsets, rivers: new Set(samples.map(q => q.rid)).size, open: open.length ? summary(open) : null,
        junction: junction.length ? summary(junction) : null };
}
