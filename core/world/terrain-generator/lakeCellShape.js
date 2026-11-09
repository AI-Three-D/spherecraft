// core/world/terrain-generator/lakeCellShape.js
//
// The lake cells' shape distance in JS (featureLakeCells.wgsl.js,
// lakeShapeU_d, value only): the smooth union of up to six ellipses'
// scaled distances. shape: { n, comp: [[x, y, a, b]...], rot: [...], ks }.

function smin(a, b, k) {
    const h = Math.min(1, Math.max(0, 0.5 + 0.5 * (b - a) / k));
    return b + (a - b) * h - k * h * (1 - h);
}

export function lakeShapeU(shape, x, y) {
    let u = 0;
    for (let j = 0; j < shape.n; j++) {
        const [cx, cy, ax, ay] = shape.comp[j], ca = Math.cos(shape.rot[j]), sa = Math.sin(shape.rot[j]);
        const dx = x - cx, dy = y - cy, qx = ca * dx + sa * dy, qy = -sa * dx + ca * dy;
        const k0 = Math.max(Math.hypot(qx / ax, qy / ay), 1e-6), d = (k0 - 1) * Math.sqrt(ax * ay);
        u = j === 0 ? d : smin(u, d, shape.ks);
    }
    return u;
}

// Water mask of a lake on an nx x ny grid of its tangent frame: 2 (water may
// lie here) where the whole cell is inside the containment curve, else 0.
// The terrain's depth decides where the water shows inside it.
export function lakeCellMask(lake, n = 64) {
    // Past the curve in every direction (the smooth union lies up to ks / 4
    // under its parts: featureLakeCells.wgsl.js lakeCurveRadius).
    const reach = lake.shape.extent * 1.05 + (lake.uC + 0.25 * lake.shape.ks) * lake.shape.stretch;
    const spacing = 2 * reach / n, x0 = -reach, y0 = -reach;
    const mask = new Uint8Array(n * n), inset = 0.75 * spacing * lake.shape.stretch;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        if (lakeShapeU(lake.shape, x0 + (i + 0.5) * spacing, y0 + (j + 0.5) * spacing) < lake.uC - inset) mask[j * n + i] = 2;
    }
    return { mask, frame: { c: lake.centre, e1: lake.a1, e2: lake.a2, x0, y0, spacing, nx: n, ny: n }, radiusM: reach };
}
