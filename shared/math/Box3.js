// js/shared/math/Box3.js
// Axis-aligned bounding box: empty-init via +/-Infinity sentinels and
// expandByPoint.

import { Vector3 } from './Vector3.js';

export class Box3 {
    constructor(min, max) {
        this.min = min || new Vector3(+Infinity, +Infinity, +Infinity);
        this.max = max || new Vector3(-Infinity, -Infinity, -Infinity);
        this.isBox3 = true;
    }

    makeEmpty() {
        this.min.set(+Infinity, +Infinity, +Infinity);
        this.max.set(-Infinity, -Infinity, -Infinity);
        return this;
    }

    isEmpty() {
        return (this.max.x < this.min.x) ||
               (this.max.y < this.min.y) ||
               (this.max.z < this.min.z);
    }

    expandByPoint(p) {
        if (p.x < this.min.x) this.min.x = p.x;
        if (p.y < this.min.y) this.min.y = p.y;
        if (p.z < this.min.z) this.min.z = p.z;
        if (p.x > this.max.x) this.max.x = p.x;
        if (p.y > this.max.y) this.max.y = p.y;
        if (p.z > this.max.z) this.max.z = p.z;
        return this;
    }
}
