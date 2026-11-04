/** Harness adapter over the actual editable density field; all distances are region-local metres. */
export class MineTerrain {
    constructor(region) {
        this.region = region;
        this.volume = region.volume;
        this.frame = region.frame;
        this.sweepStep = Math.min(0.08, region.volume.voxelSize * 0.4);
    }

    toWorld(position) {
        return this.frame.localToWorld(position.x, position.y, position.z);
    }

    /**
     * Exact conservative box test against trilinear density. On each intersected voxel cell,
     * the maximum is at a corner of the cell/box intersection. Checking those corners also
     * catches thin walls, ceilings and added rock inside the body, without treating density
     * as a signed distance. The immutable side/bottom shell bounds this harness playground.
     */
    bodyBlocked(position, radius, height, skin = 0.015) {
        const v = this.volume, p = position;
        const lo = [p.x - radius, p.y + skin, p.z - radius];
        const hi = [p.x + radius, p.y + height - skin, p.z + radius];
        if (lo[0] < v.minX || hi[0] > v.maxX || lo[2] < v.minZ || hi[2] > v.maxZ || lo[1] < v.minY) return true;
        if (lo[1] > v.maxY) return false; // sample() clamps; above the volume must remain open sky.
        hi[1] = Math.min(hi[1], v.maxY);
        const nodes = (min, max, origin) => {
            const points = [min];
            for (let i = Math.floor((min - origin) / v.voxelSize) + 1; origin + i * v.voxelSize < max; i++)
                points.push(origin + i * v.voxelSize);
            points.push(max);
            return points;
        };
        const xs = nodes(lo[0], hi[0], v.minX), ys = nodes(lo[1], hi[1], v.minY), zs = nodes(lo[2], hi[2], v.minZ);
        for (const y of ys) for (const x of xs) for (const z of zs)
            if (v.isSolid(x, y, z)) return true;
        return false;
    }

    surfaceSpawn(x, z, radius, height) {
        // The entrance itself may have been mined into a shaft. Find nearby support rather
        // than repeatedly respawning over that hole. Prefer the downhill/east side first.
        for (let ring = 0; ring <= 16; ring += 2) {
            const offsets = ring ? [[ring,0],[-ring,0],[0,ring],[0,-ring],[ring,ring],[ring,-ring],[-ring,ring],[-ring,-ring]] : [[0,0]];
            for (const [dx, dz] of offsets) {
                const px = x + dx, pz = z + dz, v = this.volume;
                if (px - radius < v.minX || px + radius > v.maxX || pz - radius < v.minZ || pz + radius > v.maxZ) continue;
                const p = this._surfacePosition(px, pz, radius, height);
                if (!this.bodyBlocked(p, radius, height) && this.bodyBlocked({ ...p, y: p.y - 0.3 }, radius, height)) return p;
            }
        }
        throw new Error('No supported surface spawn near the mine entrance');
    }

    _surfacePosition(x, z, radius, height) {
        // Start above the highest point under the footprint, including the hillside slope.
        let y = -Infinity;
        for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius])
            y = Math.max(y, this.region.surface.sample(x + dx, z + dz));
        const p = { x, y: y + 0.08, z };
        while (this.bodyBlocked(p, radius, height) && p.y < this.volume.maxY + 1) p.y += this.volume.voxelSize;
        return p;
    }

    carve(shape) { return this.region.apply({ mode: 'carve', shape }); }
}
