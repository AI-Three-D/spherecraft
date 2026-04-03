//js/mesh/GeometryLodMap.js
export class GeometryLodMap {
    constructor() {
        // Map: lodLevel (int) -> { mesh, type, ... }
        // type: 'mesh', 'sprite', or special 'remove'
        this.lodMap = new Map();
        this.removeLod = null; // mark which lod means "remove from scene"
    }
    addLod(level, geometry, type='mesh') {
        this.lodMap.set(level, { type, geometry });
    }
    getLod(level) {
        return this.lodMap.get(level);
    }
    setMeshLod(lodLevel, geometry) {
        this.lodMap.set(lodLevel, { type: 'mesh', geometry });
    }

    setSpriteLod(lodLevel, spriteFactory) {
        // spriteFactory is a function that returns a THREE.Sprite
        this.lodMap.set(lodLevel, { type: 'sprite', spriteFactory });
    }

    setRemoveLod(lodLevel) {
        this.lodMap.set(lodLevel, { type: 'remove' });
        this.removeLod = lodLevel;
    }

    getLodInfo(lodLevel) {
        // Returns {type, geometry/spriteFactory} or undefined
        return this.lodMap.get(lodLevel);
    }

    // Find the highest available LOD <= lodLevel
    getBestLodBelow(lodLevel) {
        let found = null;
        for (const [level, info] of this.lodMap.entries()) {
            if (level <= lodLevel && (found === null || level > found.level)) {
                found = { ...info, level };
            }
        }
        return found;
    }

    hasLod(lodLevel) { return this.lodMap.has(lodLevel); }

    // Helper: find if lodLevel means remove from scene
    isRemoveLod(lodLevel) { return this.removeLod === lodLevel; }
}