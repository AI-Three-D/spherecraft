// Conservative overlap of two tangent-plane patch rectangles on a sphere.
// A false result proves separation; true includes uncertain or malformed cases.
export function patchRectsMayOverlap(a, b, radius) {
    const valid = f => f && [f.c, f.e1, f.e2].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
        && [f.x0, f.y0, f.spacing, f.nx, f.ny].every(Number.isFinite) && f.spacing > 0 && f.nx > 0 && f.ny > 0;
    if (!valid(a) || !valid(b) || !Number.isFinite(radius) || radius <= 0) return true;
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    // A gnomonic-to-gnomonic mapping is projective: if the denominator
    // stays positive, each projected coordinate reaches its extrema at a
    // corner. Otherwise retain the conservative overlap.
    for (const y of [b.y0, b.y0 + b.ny * b.spacing]) for (const x of [b.x0, b.x0 + b.nx * b.spacing]) {
        const v = [0, 1, 2].map(i => b.c[i] + (x * b.e1[i] + y * b.e2[i]) / radius), den = dot(v, a.c);
        if (!(den > 1e-6)) return true;
        const px = radius * dot(v, a.e1) / den, py = radius * dot(v, a.e2) / den;
        xMin = Math.min(xMin, px); xMax = Math.max(xMax, px); yMin = Math.min(yMin, py); yMax = Math.max(yMax, py);
    }
    // Retain a margin for sampling at patch edges and floating-point error.
    const margin = 2 * Math.max(a.spacing, b.spacing) + radius * 1e-6;
    return xMax + margin >= a.x0 && xMin - margin <= a.x0 + a.nx * a.spacing
        && yMax + margin >= a.y0 && yMin - margin <= a.y0 + a.ny * a.spacing;
}
