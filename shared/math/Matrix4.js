// js/shared/math/Matrix4.js
// 4x4 matrix in column-major order. Elements are stored in a
// Float32Array(16) so the buffer can be uploaded to GPU buffers without
// conversion. Layout (column-major):
//   elements[0..3]   = column 0 (m11, m21, m31, m41)
//   elements[4..7]   = column 1 (m12, m22, m32, m42)
//   elements[8..11]  = column 2 (m13, m23, m33, m43)
//   elements[12..15] = column 3 (m14, m24, m34, m44)

export class Matrix4 {
    constructor() {
        this.elements = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
        this.isMatrix4 = true;
    }

    // Set from row-major arguments.
    set(n11, n12, n13, n14,
        n21, n22, n23, n24,
        n31, n32, n33, n34,
        n41, n42, n43, n44) {
        const e = this.elements;
        e[0] = n11; e[4] = n12; e[8]  = n13; e[12] = n14;
        e[1] = n21; e[5] = n22; e[9]  = n23; e[13] = n24;
        e[2] = n31; e[6] = n32; e[10] = n33; e[14] = n34;
        e[3] = n41; e[7] = n42; e[11] = n43; e[15] = n44;
        return this;
    }

    identity() {
        return this.set(
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        );
    }

    copy(m) {
        this.elements.set(m.elements);
        return this;
    }

    clone() {
        const out = new Matrix4();
        out.elements.set(this.elements);
        return out;
    }

    fromArray(arr, offset = 0) {
        for (let i = 0; i < 16; i++) {
            this.elements[i] = arr[offset + i];
        }
        return this;
    }

    toArray(arr = [], offset = 0) {
        const e = this.elements;
        for (let i = 0; i < 16; i++) {
            arr[offset + i] = e[i];
        }
        return arr;
    }

    multiplyMatrices(a, b) {
        const ae = a.elements;
        const be = b.elements;
        const te = this.elements;

        const a11 = ae[0], a12 = ae[4], a13 = ae[8],  a14 = ae[12];
        const a21 = ae[1], a22 = ae[5], a23 = ae[9],  a24 = ae[13];
        const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
        const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];

        const b11 = be[0], b12 = be[4], b13 = be[8],  b14 = be[12];
        const b21 = be[1], b22 = be[5], b23 = be[9],  b24 = be[13];
        const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
        const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];

        te[0]  = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
        te[4]  = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
        te[8]  = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
        te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

        te[1]  = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
        te[5]  = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
        te[9]  = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
        te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

        te[2]  = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
        te[6]  = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
        te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
        te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

        te[3]  = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
        te[7]  = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
        te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
        te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;

        return this;
    }

    multiply(m) {
        return this.multiplyMatrices(this, m);
    }

    premultiply(m) {
        return this.multiplyMatrices(m, this);
    }

    invert() {
        const te = this.elements;
        const n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
        const n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
        const n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
        const n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];

        const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
        const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
        const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
        const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

        const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
        if (det === 0) {
            return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
        const detInv = 1 / det;

        te[0] = t11 * detInv;
        te[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
        te[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
        te[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;

        te[4] = t12 * detInv;
        te[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
        te[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
        te[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;

        te[8]  = t13 * detInv;
        te[9]  = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
        te[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
        te[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;

        te[12] = t14 * detInv;
        te[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
        te[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
        te[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;

        return this;
    }

    makeTranslation(x, y, z) {
        return this.set(
            1, 0, 0, x,
            0, 1, 0, y,
            0, 0, 1, z,
            0, 0, 0, 1,
        );
    }

    makeRotationX(angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return this.set(
            1, 0,  0, 0,
            0, c, -s, 0,
            0, s,  c, 0,
            0, 0,  0, 1,
        );
    }

    makeRotationY(angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return this.set(
             c, 0, s, 0,
             0, 1, 0, 0,
            -s, 0, c, 0,
             0, 0, 0, 1,
        );
    }

    makeRotationZ(angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return this.set(
            c, -s, 0, 0,
            s,  c, 0, 0,
            0,  0, 1, 0,
            0,  0, 0, 1,
        );
    }

    makeRotationAxis(axis, angle) {
        // Rodrigues' rotation formula. axis must be normalized.
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1 - c;
        const x = axis.x, y = axis.y, z = axis.z;
        const tx = t * x, ty = t * y;
        return this.set(
            tx * x + c,     tx * y - s * z, tx * z + s * y, 0,
            tx * y + s * z, ty * y + c,     ty * z - s * x, 0,
            tx * z - s * y, ty * z + s * x, t * z * z + c,  0,
            0, 0, 0, 1,
        );
    }

    scale(v) {
        // Postmultiply by a non-uniform scale.
        const te = this.elements;
        const x = v.x, y = v.y, z = v.z;
        te[0] *= x; te[4] *= y; te[8]  *= z;
        te[1] *= x; te[5] *= y; te[9]  *= z;
        te[2] *= x; te[6] *= y; te[10] *= z;
        te[3] *= x; te[7] *= y; te[11] *= z;
        return this;
    }

    compose(position, quaternion, scale) {
        const te = this.elements;
        const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;

        const sx = scale.x, sy = scale.y, sz = scale.z;

        te[0]  = (1 - (yy + zz)) * sx;
        te[1]  = (xy + wz) * sx;
        te[2]  = (xz - wy) * sx;
        te[3]  = 0;

        te[4]  = (xy - wz) * sy;
        te[5]  = (1 - (xx + zz)) * sy;
        te[6]  = (yz + wx) * sy;
        te[7]  = 0;

        te[8]  = (xz + wy) * sz;
        te[9]  = (yz - wx) * sz;
        te[10] = (1 - (xx + yy)) * sz;
        te[11] = 0;

        te[12] = position.x;
        te[13] = position.y;
        te[14] = position.z;
        te[15] = 1;

        return this;
    }
}
