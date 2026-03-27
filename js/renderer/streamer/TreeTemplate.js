// js/renderer/streamer/TreeTemplate.js
//
// Defines the branch hierarchy and anchor point structure for a tree type.
// Templates are pre-baked and stored in GPU buffers for fast instancing.
//
// Coordinate system: Y-up, origin at tree base (ground level).
// All positions are in local space, scaled by instance size at runtime.
//
// UPDATED: Now carries trunk path data, branch parentage, and per-anchor
// branch level information for proper mesh generation.

import { Logger } from '../../config/Logger.js';

/**
 * @typedef {object} BranchSegment
 * @property {number} id - Unique segment id
 * @property {number[]} start - [x, y, z] start position
 * @property {number[]} end - [x, y, z] end position
 * @property {number} startRadius - radius at start
 * @property {number} endRadius - radius at end
 * @property {number} level - branch hierarchy level (0=trunk, 1=primary, 2=secondary, 3=twig)
 * @property {number} parentId - parent segment id (-1 for trunk root)
 */

/**
 * @typedef {object} AnchorPoint
 * @property {number[]} position - [x, y, z] in local space
 * @property {number[]} direction - [x, y, z] normalized branch direction
 * @property {number} spread - radius for leaf cluster placement
 * @property {number} density - relative density multiplier (0-1)
 * @property {number} canopyLOD - minimum canopy LOD that includes this anchor (0=finest)
 * @property {number} branchLevel - hierarchy level of the parent branch (0-3)
 * @property {number} parentSegId - segment id of the parent branch
 */

/**
 * @typedef {object} CanopyLODInfo
 * @property {number} anchorStart - start index in anchor array
 * @property {number} anchorCount - number of anchors for this LOD
 * @property {number} maxDistance - max distance for this LOD
 */

/**
 * @typedef {object} TrunkPathNode
 * @property {number[]} position - [x, y, z]
 * @property {number} radius - trunk radius at this point
 * @property {number} t - parametric position (0=base, 1=top)
 * @property {number[]} direction - [x, y, z] growth direction
 */

export class TreeTemplate {
    /**
     * @param {object} def
     * @param {string} def.id - Template identifier (e.g., 'birch_01')
     * @param {string} def.treeType - Tree type this belongs to
     * @param {number} def.variantIndex - Variant number for this type
     * @param {BranchSegment[]} def.branches - All branch segments
     * @param {AnchorPoint[]} def.anchors - All anchor points (sorted by canopyLOD)
     * @param {CanopyLODInfo[]} def.canopyLODs - LOD info for anchor access
     * @param {TrunkPathNode[]} [def.trunkPath] - Detailed trunk centerline for mesh generation
     * @param {object} def.bounds - Bounding box {min: [x,y,z], max: [x,y,z]}
     * @param {number} def.baseHeight - Reference height for scaling (meters)
     * @param {object} [def.branchStats] - Generation statistics
     */
    constructor(def) {
        this.id = def.id;
        this.treeType = def.treeType;
        this.variantIndex = def.variantIndex ?? 0;

        this.branches = def.branches || [];
        this.anchors = def.anchors || [];
        this.canopyLODs = def.canopyLODs || [];
        this.trunkPath = def.trunkPath || null;

        this.bounds = def.bounds || { min: [0, 0, 0], max: [1, 1, 1] };
        this.baseHeight = def.baseHeight || 10.0;
        this.branchStats = def.branchStats || null;

        // Computed
        this._totalAnchors = this.anchors.length;
        this._totalBranches = this.branches.length;

        // Build hierarchy lookup
        this._branchById = new Map();
        this._childrenByParent = new Map();
        for (const branch of this.branches) {
            if (branch.id !== undefined) {
                this._branchById.set(branch.id, branch);
            }
            const pid = branch.parentId ?? -1;
            if (!this._childrenByParent.has(pid)) {
                this._childrenByParent.set(pid, []);
            }
            this._childrenByParent.get(pid).push(branch);
        }
    }

    /**
     * Get branch segment by id.
     * @param {number} id
     * @returns {BranchSegment|null}
     */
    getBranchById(id) {
        return this._branchById.get(id) || null;
    }

    /**
     * Get child branches of a given parent segment.
     * @param {number} parentId
     * @returns {BranchSegment[]}
     */
    getChildBranches(parentId) {
        return this._childrenByParent.get(parentId) || [];
    }

    /**
     * Get all branches at a specific hierarchy level.
     * @param {number} level - 0=trunk, 1=primary, 2=secondary, 3=twig
     * @returns {BranchSegment[]}
     */
    getBranchesByLevel(level) {
        return this.branches.filter(b => b.level === level);
    }

    /**
     * Get trunk segments (level 0).
     * @returns {BranchSegment[]}
     */
    getTrunkSegments() {
        return this.getBranchesByLevel(0);
    }

    /**
     * Get anchors for a specific canopy LOD level.
     * Lower LOD = more detailed = more anchors.
     *
     * @param {number} canopyLOD - 0 (finest) to N (coarsest before baked)
     * @returns {AnchorPoint[]}
     */
    getAnchorsForLOD(canopyLOD) {
        if (canopyLOD >= this.canopyLODs.length) return [];

        const lodInfo = this.canopyLODs[canopyLOD];
        return this.anchors.slice(lodInfo.anchorStart, lodInfo.anchorStart + lodInfo.anchorCount);
    }

    /**
     * Get anchor count for a specific canopy LOD.
     * @param {number} canopyLOD
     * @returns {number}
     */
    getAnchorCountForLOD(canopyLOD) {
        if (canopyLOD >= this.canopyLODs.length) return 0;
        return this.canopyLODs[canopyLOD].anchorCount;
    }

    /**
     * Get cumulative anchor count up to and including a canopy LOD.
     * Used for buffer offset calculations.
     * @param {number} canopyLOD
     * @returns {number}
     */
    getCumulativeAnchorCount(canopyLOD) {
        let total = 0;
        for (let i = 0; i <= canopyLOD && i < this.canopyLODs.length; i++) {
            total += this.canopyLODs[i].anchorCount;
        }
        return total;
    }

    /**
     * Get anchors that are attached to branches at or below a given level.
     * Useful for LOD filtering: at coarser LODs, only show anchors on thicker branches.
     * @param {number} maxBranchLevel - Include anchors on branches up to this level
     * @returns {AnchorPoint[]}
     */
    getAnchorsByBranchLevel(maxBranchLevel) {
        return this.anchors.filter(a => (a.branchLevel ?? 0) <= maxBranchLevel);
    }

    get totalAnchors() { return this._totalAnchors; }
    get totalBranches() { return this._totalBranches; }

/**
 * Serialize anchors to GPU buffer format.
 *
 * 48 bytes (12 words) per anchor:
 *   [0-2] f32   position x,y,z
 *   [3]   f32   spread
 *   [4-6] f32   direction x,y,z
 *   [7]   f32   density
 *   [8]   u32   tier — 0=fine, 1=medium, 2=coarse
 *   [9]   u32   childStart — TEMPLATE-LOCAL anchor index (0 = this template's
 *               first anchor). Shader adds info.anchorStart to get global.
 *               0xFFFFFFFF = no children.
 *   [10]  u32   childCount
 *   [11]  u32   reserved
 *
 * tier falls back to canopyLOD for species that haven't been updated yet
 * (oak, palm, eucalyptus). They just won't have the child links.
 */
toAnchorGPUData() {
    const WORDS = 12;
    const data = new Float32Array(this.anchors.length * WORDS);
    const u32  = new Uint32Array(data.buffer);

    for (let i = 0; i < this.anchors.length; i++) {
        const a = this.anchors[i];
        const o = i * WORDS;

        data[o + 0] = a.position[0];
        data[o + 1] = a.position[1];
        data[o + 2] = a.position[2];
        data[o + 3] = a.spread;
        data[o + 4] = a.direction[0];
        data[o + 5] = a.direction[1];
        data[o + 6] = a.direction[2];
        data[o + 7] = a.density;

        u32[o + 8]  = (a.tier ?? a.canopyLOD ?? 0) >>> 0;
        u32[o + 9]  = (a.childStart ?? 0xFFFFFFFF) >>> 0;
        u32[o + 10] = (a.childCount ?? 0) >>> 0;
        u32[o + 11] = (a.parentIdx ?? 0xFFFFFFFF) >>> 0;
    }

    return data;
}

    /**
     * Serialize branch segments to GPU buffer format.
     *
     * Layout per segment (48 bytes = 12 floats):
     *   [0-2]:  start position
     *   [3]:    start radius
     *   [4-6]:  end position
     *   [7]:    end radius
     *   [8]:    level (as float)
     *   [9]:    parent id (as float, -1 for root)
     *   [10]:   segment id (as float)
     *   [11]:   reserved
     *
     * @returns {Float32Array}
     */
    toBranchGPUData() {
        const floatsPerBranch = 12;
        const data = new Float32Array(this.branches.length * floatsPerBranch);

        for (let i = 0; i < this.branches.length; i++) {
            const branch = this.branches[i];
            const offset = i * floatsPerBranch;

            data[offset + 0] = branch.start[0];
            data[offset + 1] = branch.start[1];
            data[offset + 2] = branch.start[2];
            data[offset + 3] = branch.startRadius;
            data[offset + 4] = branch.end[0];
            data[offset + 5] = branch.end[1];
            data[offset + 6] = branch.end[2];
            data[offset + 7] = branch.endRadius;
            data[offset + 8] = branch.level;
            data[offset + 9] = branch.parentId ?? -1;
            data[offset + 10] = branch.id ?? i;
            data[offset + 11] = 0;
        }

        return data;
    }

    /**
     * Serialize trunk path to GPU buffer format.
     *
     * Layout per node (16 bytes = 4 floats):
     *   [0-2]: position
     *   [3]:   radius
     *
     * @returns {Float32Array|null}
     */
    toTrunkPathGPUData() {
        if (!this.trunkPath) return null;

        const floatsPerNode = 4;
        const data = new Float32Array(this.trunkPath.length * floatsPerNode);

        for (let i = 0; i < this.trunkPath.length; i++) {
            const node = this.trunkPath[i];
            const offset = i * floatsPerNode;

            data[offset + 0] = node.position[0];
            data[offset + 1] = node.position[1];
            data[offset + 2] = node.position[2];
            data[offset + 3] = node.radius;
        }

        return data;
    }

    /**
     * Validate template structure.
     * @returns {{valid: boolean, errors: string[]}}
     */
    validate() {
        const errors = [];

        if (!this.id) errors.push('Missing id');
        if (!this.treeType) errors.push('Missing treeType');
        if (this.anchors.length === 0) errors.push('No anchors defined');
        if (this.canopyLODs.length === 0) errors.push('No canopy LODs defined');

        // Verify LOD anchor ranges don't overlap and cover all anchors
        let coveredAnchors = 0;
        for (let i = 0; i < this.canopyLODs.length; i++) {
            const lod = this.canopyLODs[i];
            if (lod.anchorStart !== coveredAnchors) {
                errors.push(`Canopy LOD ${i} anchor start mismatch`);
            }
            coveredAnchors += lod.anchorCount;
        }

        if (coveredAnchors !== this.anchors.length) {
            errors.push(`Anchor count mismatch: LODs cover ${coveredAnchors}, have ${this.anchors.length}`);
        }

        // Verify anchor data
        for (let i = 0; i < this.anchors.length; i++) {
            const a = this.anchors[i];
            if (!a.position || a.position.length !== 3) {
                errors.push(`Anchor ${i}: invalid position`);
            }
            if (!a.direction || a.direction.length !== 3) {
                errors.push(`Anchor ${i}: invalid direction`);
            }
        }

        // Verify branch hierarchy if we have ids
        if (this.branches.length > 0 && this.branches[0].id !== undefined) {
            const ids = new Set(this.branches.map(b => b.id));
            for (const b of this.branches) {
                if (b.parentId !== undefined && b.parentId >= 0 && !ids.has(b.parentId)) {
                    errors.push(`Branch ${b.id}: references non-existent parent ${b.parentId}`);
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }
}