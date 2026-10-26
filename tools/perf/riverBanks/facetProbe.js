// tools/perf/riverBanks/facetProbe.js
//
// Page side (pageProbe.mjs). The ground point under a screen pixel of a
// pose (ray marched against the carved height, fov 75, 1440 x 900), then a
// grid of halfM around it every stepM: per grid point the nearest traced
// river (within 140 m), its nearest segment and second-nearest segment and
// the carved height. Lines where the nearest segment jumps by more than one
// (inside tight bends) are hard switches the carve's joint blend does not
// cover.
export async function facetAt({ view, px, py, halfM = 60, stepM = 3 }) {
    const g = window.gameEngine, s = g.waterService, R = g.planetConfig.radius, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
    const norm = a => mul(a, 1 / Math.hypot(...a)), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const pos = view.pos, fwd = norm(sub(view.look, pos)), up0 = norm(sub(pos, [o.x, o.y, o.z]));
    const right = norm(cross(fwd, up0)), up = cross(right, fwd);
    const th = Math.tan(75 * Math.PI / 360), asp = 1440 / 900;
    const ray = norm(add(fwd, add(mul(right, (2 * (px + 0.5) / 1440 - 1) * th * asp), mul(up, (1 - 2 * (py + 0.5) / 900) * th))));
    const heightAt = async (pts) => {
        const dirs = [];
        for (const p of pts) { const d = norm(sub(p, [o.x, o.y, o.z])); dirs.push(d[0], d[1], d[2], 0); }
        return Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(dirs)));
    };
    // March: 2 m steps up to 3 km, then bisect.
    let t0 = 0, hit = null;
    for (let t = 2; t < 3000; t += 2) {
        const p = add(pos, mul(ray, t)), [h] = await heightAt([p]);
        if (Math.hypot(...sub(p, [o.x, o.y, o.z])) - R <= h) { hit = t; break; }
        t0 = t;
    }
    if (hit == null) return { error: 'no hit' };
    for (let i = 0; i < 12; i++) {
        const m = (t0 + hit) / 2, p = add(pos, mul(ray, m)), [h] = await heightAt([p]);
        if (Math.hypot(...sub(p, [o.x, o.y, o.z])) - R <= h) hit = m; else t0 = m;
    }
    const at = add(pos, mul(ray, hit)), atDir = norm(sub(at, [o.x, o.y, o.z]));
    // Grid in the tangent plane.
    const e1 = norm(cross(atDir, [0, 1, 0.0001])), e2 = cross(atDir, e1);
    const n = Math.round(2 * halfM / stepM) + 1, dirs = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const u = -halfM + i * stepM, v = -halfM + j * stepM;
        dirs.push(norm(add(atDir, add(mul(e1, u / R), mul(e2, v / R)))));
    }
    const flat = [];
    for (const d of dirs) flat.push(d[0], d[1], d[2], 0);
    const h = Array.from(await s._sampler.sampleDirsCarved(Float32Array.from(flat)));
    const nearest = dirs.map(d => {
        let best = null;
        for (const [id, rec] of s.riverRecs) {
            const P = rec.points, st = rec.stride, m = P.length / st;
            for (let k = 0; k + 1 < m; k++) {
                const a = [P[k * st], P[k * st + 1], P[k * st + 2]], b = [P[(k + 1) * st], P[(k + 1) * st + 1], P[(k + 1) * st + 2]];
                const ab = sub(b, a), tt = Math.min(1, Math.max(0, (sub(d, a).reduce((x, v, i) => x + v * ab[i], 0)) / ab.reduce((x, v) => x + v * v, 1e-30)));
                const dist = Math.hypot(...sub(d, add(a, mul(ab, tt)))) * R;
                if (dist < 140 && (!best || dist < best.dist)) best = { id, k, dist, t: tt };
            }
        }
        return best;
    });
    // Neighbouring grid points whose nearest segment jumps by more than one.
    const jumps = [];
    for (let j = 0; j < n; j++) for (let i = 0; i + 1 < n; i++) {
        const a = nearest[j * n + i], b = nearest[j * n + i + 1];
        if (a && b && a.id === b.id && Math.abs(a.k - b.k) > 1) jumps.push([i, j, a.k, b.k, Math.round(a.dist)]);
    }
    return { hitM: +hit.toFixed(1), at: at.map(v => +v.toFixed(1)), n, stepM,
        segment: nearest.map(x => x ? x.k : -1), dist: nearest.map(x => x ? Math.round(x.dist) : -1), height: h.map(v => +v.toFixed(2)), jumps: jumps.slice(0, 40), jumpCount: jumps.length };
}
