// js/shared/math/Euler.js
// Euler angles container. The order field controls the rotation order;
// the active codebase uses 'YXZ' but all six orders are supported for
// completeness when converting from a quaternion.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Euler {
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
        this.x = x;
        this.y = y;
        this.z = z;
        this.order = order;
        this.isEuler = true;
    }

    set(x, y, z, order = this.order) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.order = order;
        return this;
    }

    copy(e) {
        this.x = e.x;
        this.y = e.y;
        this.z = e.z;
        this.order = e.order;
        return this;
    }

    setFromQuaternion(q, order = this.order) {
        // Convert quaternion to a 3x3 rotation matrix, then read Euler angles
        // for the requested order.
        const x = q.x, y = q.y, z = q.z, w = q.w;
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;

        // Row-major 3x3.
        const m11 = 1 - (yy + zz);
        const m12 = xy - wz;
        const m13 = xz + wy;
        const m21 = xy + wz;
        const m22 = 1 - (xx + zz);
        const m23 = yz - wx;
        const m31 = xz - wy;
        const m32 = yz + wx;
        const m33 = 1 - (xx + yy);

        switch (order) {
            case 'XYZ':
                this.y = Math.asin(clamp(m13, -1, 1));
                if (Math.abs(m13) < 0.9999999) {
                    this.x = Math.atan2(-m23, m33);
                    this.z = Math.atan2(-m12, m11);
                } else {
                    this.x = Math.atan2(m32, m22);
                    this.z = 0;
                }
                break;
            case 'YXZ':
                this.x = Math.asin(-clamp(m23, -1, 1));
                if (Math.abs(m23) < 0.9999999) {
                    this.y = Math.atan2(m13, m33);
                    this.z = Math.atan2(m21, m22);
                } else {
                    this.y = Math.atan2(-m31, m11);
                    this.z = 0;
                }
                break;
            case 'ZXY':
                this.x = Math.asin(clamp(m32, -1, 1));
                if (Math.abs(m32) < 0.9999999) {
                    this.y = Math.atan2(-m31, m33);
                    this.z = Math.atan2(-m12, m22);
                } else {
                    this.y = 0;
                    this.z = Math.atan2(m21, m11);
                }
                break;
            case 'ZYX':
                this.y = Math.asin(-clamp(m31, -1, 1));
                if (Math.abs(m31) < 0.9999999) {
                    this.x = Math.atan2(m32, m33);
                    this.z = Math.atan2(m21, m11);
                } else {
                    this.x = 0;
                    this.z = Math.atan2(-m12, m22);
                }
                break;
            case 'YZX':
                this.z = Math.asin(clamp(m21, -1, 1));
                if (Math.abs(m21) < 0.9999999) {
                    this.x = Math.atan2(-m23, m22);
                    this.y = Math.atan2(-m31, m11);
                } else {
                    this.x = 0;
                    this.y = Math.atan2(m13, m33);
                }
                break;
            case 'XZY':
                this.z = Math.asin(-clamp(m12, -1, 1));
                if (Math.abs(m12) < 0.9999999) {
                    this.x = Math.atan2(m32, m22);
                    this.y = Math.atan2(m13, m11);
                } else {
                    this.x = Math.atan2(-m23, m33);
                    this.y = 0;
                }
                break;
            default:
                throw new Error(`Euler.setFromQuaternion: unknown order ${order}`);
        }
        this.order = order;
        return this;
    }
}
