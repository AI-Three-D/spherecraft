/**
 * Local frame of a voxel region: a world-space origin plus a right-handed orthonormal basis
 *   x = heading (horizontal), y = up, z = cross(x, y).
 * World positions sit ~1e5 m from the planet centre, so this class is plain double math.
 * Region data (heights, voxels, meshes) lives in frame coordinates, which are small enough for float32.
 */
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function normalized(v, what) {
    const length = Math.hypot(v?.x, v?.y, v?.z);
    if (!Number.isFinite(length) || length < 1e-9) throw new Error(`RegionFrame: ${what} must be a finite nonzero vector`);
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export class RegionFrame {
    /** @param {{origin: {x:number,y:number,z:number}, up: {x:number,y:number,z:number}, heading: {x:number,y:number,z:number}}} descriptor */
    constructor({ origin, up, heading }) {
        if (![origin?.x, origin?.y, origin?.z].every(Number.isFinite)) throw new Error('RegionFrame: origin must be finite');
        const y = normalized(up, 'up');
        const h = normalized(heading, 'heading');
        const along = dot(h, y);
        const flat = { x: h.x - along * y.x, y: h.y - along * y.y, z: h.z - along * y.z };
        if (Math.hypot(flat.x, flat.y, flat.z) < 1e-6) throw new Error('RegionFrame: heading must not be parallel to up');
        const x = normalized(flat, 'heading');
        const z = { x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x };
        this.origin = Object.freeze({ x: origin.x, y: origin.y, z: origin.z });
        this.axisX = Object.freeze(x);
        this.axisY = Object.freeze(y);
        this.axisZ = Object.freeze(z);
        Object.freeze(this);
    }

    localToWorld(x, y, z, out = { x: 0, y: 0, z: 0 }) {
        const { origin: o, axisX: a, axisY: b, axisZ: c } = this;
        out.x = o.x + (x * a.x + y * b.x + z * c.x);
        out.y = o.y + (x * a.y + y * b.y + z * c.y);
        out.z = o.z + (x * a.z + y * b.z + z * c.z);
        return out;
    }

    worldToLocal(wx, wy, wz, out = { x: 0, y: 0, z: 0 }) {
        const { origin: o, axisX: a, axisY: b, axisZ: c } = this;
        const dx = wx - o.x, dy = wy - o.y, dz = wz - o.z;
        out.x = dx * a.x + dy * a.y + dz * a.z;
        out.y = dx * b.x + dy * b.y + dz * b.z;
        out.z = dx * c.x + dy * c.y + dz * c.z;
        return out;
    }

    directionToWorld(x, y, z, out = { x: 0, y: 0, z: 0 }) {
        const { axisX: a, axisY: b, axisZ: c } = this;
        out.x = x * a.x + y * b.x + z * c.x;
        out.y = x * a.y + y * b.y + z * c.y;
        out.z = x * a.z + y * b.z + z * c.z;
        return out;
    }

    /**
     * Column-major 4x4 taking frame coordinates to camera-relative world axes.
     * The origin-minus-camera subtraction happens here in doubles; only the small result may be stored as float32.
     * @param {{x:number,y:number,z:number}} cameraPosition world space, doubles
     * @param {Float32Array | Float64Array | number[]} out 16 elements
     */
    writeLocalToCameraRelative(cameraPosition, out) {
        const { origin: o, axisX: a, axisY: b, axisZ: c } = this;
        out[0] = a.x; out[1] = a.y; out[2] = a.z; out[3] = 0;
        out[4] = b.x; out[5] = b.y; out[6] = b.z; out[7] = 0;
        out[8] = c.x; out[9] = c.y; out[10] = c.z; out[11] = 0;
        out[12] = o.x - cameraPosition.x;
        out[13] = o.y - cameraPosition.y;
        out[14] = o.z - cameraPosition.z;
        out[15] = 1;
        return out;
    }
}