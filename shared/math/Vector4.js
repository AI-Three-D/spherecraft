// js/shared/math/Vector4.js
// 4D vector class (constructor, set, copy, clone, applyMatrix4).

export class Vector4 {
    constructor(x = 0, y = 0, z = 0, w = 1) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
        this.isVector4 = true;
    }

    set(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
        return this;
    }

    copy(v) {
        this.x = v.x;
        this.y = v.y;
        this.z = v.z;
        this.w = v.w !== undefined ? v.w : 1;
        return this;
    }

    clone() {
        return new Vector4(this.x, this.y, this.z, this.w);
    }

    applyMatrix4(m) {
        const x = this.x, y = this.y, z = this.z, w = this.w;
        const e = m.elements;
        this.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
        this.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
        this.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
        this.w = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
        return this;
    }
}
