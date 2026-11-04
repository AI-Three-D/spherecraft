/**
 * Vertical cut plane in frame coordinates.
 *
 * Plane coordinates are (s, y): s runs horizontally along the plane, y is frame up.
 *   frame x = offset * normalX + s * dirX
 *   frame z = offset * normalZ + s * dirZ
 * with dir = (cos angle, sin angle) and normal = (-sin angle, cos angle). The normal points at the
 * viewer (dir x up), so s increases to the right on screen. Moving `offset` slides the plane along
 * its normal without shifting s. `revision` bumps on every change.
 */
export class CutPlane {
    constructor({ angle = 0, offset = 0 } = {}) {
        this.revision = 0;
        this.set(angle, offset);
    }

    set(angle, offset) {
        if (!Number.isFinite(angle) || !Number.isFinite(offset)) throw new Error('CutPlane: angle and offset must be finite');
        this.angle = angle;
        this.offset = offset;
        this.dirX = Math.cos(angle);
        this.dirZ = Math.sin(angle);
        // Quarter turns must stay exactly on the voxel axes, including after many turns.
        const quarter = Math.round(angle / (Math.PI / 2));
        if (Math.abs(angle - quarter * (Math.PI / 2)) <= 8 * Number.EPSILON * Math.max(1, Math.abs(angle))) {
            [this.dirX, this.dirZ] = [[1, 0], [0, 1], [-1, 0], [0, -1]][((quarter % 4) + 4) % 4];
        }
        this.normalX = this.dirZ === 0 ? 0 : -this.dirZ;
        this.normalZ = this.dirX;
        this.revision++;
        return this;
    }

    /** Rotate around a frame-local horizontal point, preserving it on the cut. */
    rotateQuarterTurns(turns, pivotX = this.x(0), pivotZ = this.z(0)) {
        if (!Number.isInteger(turns)) throw new RangeError('CutPlane: quarter turns must be an integer');
        if (!Number.isFinite(pivotX) || !Number.isFinite(pivotZ)) throw new RangeError('CutPlane: pivot must be finite');
        const angle = this.angle + (turns % 4) * Math.PI / 2;
        this.set(angle, 0);
        this.offset = pivotX * this.normalX + pivotZ * this.normalZ;
        return this;
    }

    x(s) { return this.offset * this.normalX + s * this.dirX; }
    z(s) { return this.offset * this.normalZ + s * this.dirZ; }

    /** Plane coordinate and signed distance (positive toward the viewer) of a frame position. */
    project(x, z) {
        return { s: x * this.dirX + z * this.dirZ, distance: x * this.normalX + z * this.normalZ - this.offset };
    }

    /** The s-interval where the plane crosses an axis-aligned frame rectangle, or null. */
    clipToRect(minX, minZ, maxX, maxZ) {
        let s0 = -Infinity, s1 = Infinity;
        const slabs = [[this.x(0), this.dirX, minX, maxX], [this.z(0), this.dirZ, minZ, maxZ]];
        for (const [start, direction, min, max] of slabs) {
            if (Math.abs(direction) < 1e-12) {
                if (start < min || start > max) return null;
                continue;
            }
            const a = (min - start) / direction, b = (max - start) / direction;
            s0 = Math.max(s0, Math.min(a, b));
            s1 = Math.min(s1, Math.max(a, b));
        }
        return s1 - s0 > 1e-9 ? [s0, s1] : null;
    }
}
