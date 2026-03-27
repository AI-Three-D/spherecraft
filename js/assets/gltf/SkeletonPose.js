// js/assets/gltf/SkeletonPose.js

export class SkeletonPose {
    /**
     * @param {GLTFAsset} asset
     * @param {GLTFSkeleton} skeleton
     * @param {number} meshNodeIndex  — node that carries the skin
     * @param {Map|null} overrides    — from AnimationSampler.sample()
     * @returns {Float32Array}  jointCount × 16 floats (column‑major mat4 per joint)
     */
    static compute(asset, skeleton, meshNodeIndex, overrides) {
        const nc = asset.nodes.length;
        const globals = new Array(nc);
        const I = _identity();

        const walk = (idx, parent) => {
            const local = _localMat(asset.nodes[idx], overrides?.get(idx));
            const g = _mul(parent, local);
            globals[idx] = g;
            for (const c of asset.nodes[idx].childIndices) walk(c, g);
        };
        for (const r of asset.rootNodes) walk(r, I);
        for (let i = 0; i < nc; i++) if (!globals[i]) walk(i, I);

        const invMesh = _invert(globals[meshNodeIndex] || I);
        const jc = skeleton.jointCount;
        const out = new Float32Array(jc * 16);

        for (let j = 0; j < jc; j++) {
            const jg = globals[skeleton.jointNodeIndices[j]] || I;
            const ibm = skeleton.inverseBindMatrices.subarray(j * 16, j * 16 + 16);
            const m = _mul(_mul(invMesh, jg), ibm);
            out.set(m, j * 16);
        }
        return out;
    }
}

/* ── column‑major mat4 helpers ─────────────────────────────────── */

function _identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function _localMat(node, ov) {
    if (node.hasMatrix && !ov) {
        const m = new Float32Array(16);
        m.set(node.matrix);
        return m;
    }
    const t = ov?.translation ?? node.translation;
    const r = ov?.rotation ?? node.rotation;
    const s = ov?.scale ?? node.scale;
    return _composeTRS(t, r, s);
}

function _composeTRS(t, r, s) {
    const x = r[0], y = r[1], z = r[2], w = r[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];
    const o = new Float32Array(16);
    o[0]  = (1 - (yy + zz)) * sx; o[1]  = (xy + wz) * sx;       o[2]  = (xz - wy) * sx;       o[3]  = 0;
    o[4]  = (xy - wz) * sy;       o[5]  = (1 - (xx + zz)) * sy;  o[6]  = (yz + wx) * sy;       o[7]  = 0;
    o[8]  = (xz + wy) * sz;       o[9]  = (yz - wx) * sz;        o[10] = (1 - (xx + yy)) * sz; o[11] = 0;
    o[12] = t[0];                  o[13] = t[1];                   o[14] = t[2];                  o[15] = 1;
    return o;
}

function _mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            o[c * 4 + r] =
                a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
}

function _invert(m) {
    const o = new Float32Array(16);
    const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
    const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
    const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
    const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];
    const b00 = m00 * m11 - m01 * m10, b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10, b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11, b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30, b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30, b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31, b11 = m22 * m33 - m23 * m32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-10) return _identity();
    det = 1 / det;
    o[0]  = ( m11 * b11 - m12 * b10 + m13 * b09) * det;
    o[1]  = (-m01 * b11 + m02 * b10 - m03 * b09) * det;
    o[2]  = ( m31 * b05 - m32 * b04 + m33 * b03) * det;
    o[3]  = (-m21 * b05 + m22 * b04 - m23 * b03) * det;
    o[4]  = (-m10 * b11 + m12 * b08 - m13 * b07) * det;
    o[5]  = ( m00 * b11 - m02 * b08 + m03 * b07) * det;
    o[6]  = (-m30 * b05 + m32 * b02 - m33 * b01) * det;
    o[7]  = ( m20 * b05 - m22 * b02 + m23 * b01) * det;
    o[8]  = ( m10 * b10 - m11 * b08 + m13 * b06) * det;
    o[9]  = (-m00 * b10 + m01 * b08 - m03 * b06) * det;
    o[10] = ( m30 * b04 - m31 * b02 + m33 * b00) * det;
    o[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * det;
    o[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * det;
    o[13] = ( m00 * b09 - m01 * b07 + m02 * b06) * det;
    o[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * det;
    o[15] = ( m20 * b03 - m21 * b01 + m22 * b00) * det;
    return o;
}