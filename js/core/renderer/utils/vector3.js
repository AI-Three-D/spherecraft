// js/renderer/utils/vector3.js
// Small stateless vec3 helpers shared by renderer systems.

export function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(v, s) {
    return [v[0] * s, v[1] * s, v[2] * s];
}

export function lerp3(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

export function length3(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function normalize3(v) {
    const len = length3(v);
    if (len < 1e-8) return [0, 1, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
}

export function rotateAxis3(v, axis, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const d = dot3(v, axis);
    const cr = cross3(axis, v);
    return [
        v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
        v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
        v[2] * c + cr[2] * s + axis[2] * d * (1 - c),
    ];
}

export function bezier3(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    return [
        uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
        uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
        uuu * p0[2] + 3 * uu * t * p1[2] + 3 * u * tt * p2[2] + ttt * p3[2],
    ];
}

export function perp3(dir) {
    const up = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    return normalize3(cross3(up, dir));
}
