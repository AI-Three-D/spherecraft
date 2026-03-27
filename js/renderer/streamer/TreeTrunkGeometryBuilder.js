// js/renderer/streamer/TreeTrunkGeometryBuilder.js

/**
 * @typedef {import('./GeometryAtlas.js').GeometryData} GeometryData
 */

export class TreeTrunkGeometryBuilder {

    // ═══════════════════════════════════════════════════════════════════════
    // TEMPLATE-BASED BUILDERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build all LOD geometries from a TreeTemplate's branch hierarchy.
     * Uses the template's trunkPath and branch segments for accurate meshes.
     *
     * @param {import('./TreeTemplate.js').TreeTemplate} template
     * @param {object} [options]
     * @param {number} [options.trunkRadialSegments=10] - Radial segments for trunk at LOD 0
     * @param {number} [options.branchRadialSegments=6] - Radial segments for branches at LOD 0
     * @returns {GeometryData[]} Array of LOD 0-5 geometries
     */
    static buildFromTemplate(template, options = {}) {
        const trunkSegs = options.trunkRadialSegments ?? 10;
        const branchSegs = options.branchRadialSegments ?? 6;

        return [
            this._buildTemplateLOD0(template, trunkSegs, branchSegs),
            this._buildTemplateLOD1(template, Math.max(4, trunkSegs - 2), Math.max(3, branchSegs - 2)),
            this._buildTemplateLOD2(template, Math.max(4, trunkSegs - 4), 3),
            this._buildTemplateLOD3(template),
            this._buildTemplateLOD4(template),
            this._buildTemplateLOD5(template)
        ];
    }

/**
 * LOD 0: Full hierarchy built as chain-grouped parallel-transport tubes.
 * Includes level 4 (droopers) as triangular-cross-section tubes.
 *
 * Vertex count actually DROPS vs the old per-segment build for levels 2-3,
 * because chain building shares ring vertices at joints (N segments → N+1
 * rings, not 2N rings). The added level-4 geometry roughly offsets this.
 */
static _buildTemplateLOD0(template, trunkRadial, branchRadial) {
    const geometries = [];
    const isBirchLike = template.treeType === 'birch' || template.treeType === 'deciduous';

    const useTrunkPath = template.trunkPath && template.trunkPath.length >= 2;
    if (useTrunkPath) {
        geometries.push(this._buildTrunkFromPath(template.trunkPath, trunkRadial));
    }

    // Level → radial subdivisions. Level 4 gets 3-sided (triangular) tubes.
    // They're very thin and mostly silhouette-only at any viewing distance.
    const radialByLevel = [
        trunkRadial,                                                       // 0
        branchRadial,                                                      // 1
        isBirchLike ? Math.max(3, branchRadial - 3) : Math.max(3, branchRadial - 2),  // 2
        isBirchLike ? 4 : 3,                                               // 3
        3,                                                                 // 4
    ];

    const chains = this._groupSegmentsIntoChains(template.branches);
    for (const [, chain] of chains) {
        if (chain.length === 0) continue;
        const level = chain[0].level;
        if (level === 0 && useTrunkPath) continue;  // trunk already built from path
        const radial = radialByLevel[level] ?? 3;
        geometries.push(this._buildBranchChainMesh(chain, radial, level));
    }

    return this._mergeGeometries(geometries);
}

    /**
     * LOD 1: Trunk + primaries + secondary stubs.
     */
    static _buildTemplateLOD1(template, trunkRadial, branchRadial) {
        const geometries = [];
        const isBirchLike = template.treeType === 'birch' || template.treeType === 'deciduous';

        if (template.trunkPath && template.trunkPath.length >= 2) {
            geometries.push(this._buildTrunkFromPath(template.trunkPath, trunkRadial));
        } else {
            const trunkSegs = template.getBranchesByLevel(0);
            for (const seg of trunkSegs) {
                geometries.push(this._buildBranchSegmentMesh(seg, trunkRadial, 2, 0));
            }
        }

        // Primary branches
        const primaries = template.getBranchesByLevel(1);
        for (const seg of primaries) {
            geometries.push(this._buildBranchSegmentMesh(seg, branchRadial, 2, 1));
        }

        // Secondary droops remain visible at LOD1, shortened for cost.
        const secondaries = template.getBranchesByLevel(2);
        for (const seg of secondaries) {
            const stubScale = isBirchLike ? 0.82 : 0.6;
            const stubSeg = {
                ...seg,
                end: [
                    seg.start[0] + (seg.end[0] - seg.start[0]) * stubScale,
                    seg.start[1] + (seg.end[1] - seg.start[1]) * stubScale,
                    seg.start[2] + (seg.end[2] - seg.start[2]) * stubScale
                ],
                endRadius: seg.startRadius * (isBirchLike ? 0.42 : 0.5)
            };
            geometries.push(this._buildBranchSegmentMesh(stubSeg, 3, 1, 2));
        }

        return this._mergeGeometries(geometries);
    }

    /**
     * LOD 2: Trunk + primary stubs only.
     */
    static _buildTemplateLOD2(template, trunkRadial, branchRadial) {
        const geometries = [];

        if (template.trunkPath && template.trunkPath.length >= 2) {
            // Use fewer height segments for trunk at this LOD
            const reducedPath = this._reducePath(template.trunkPath, 5);
            geometries.push(this._buildTrunkFromPath(reducedPath, trunkRadial));
        } else {
            const trunkSegs = template.getBranchesByLevel(0);
            for (const seg of trunkSegs) {
                geometries.push(this._buildBranchSegmentMesh(seg, trunkRadial, 1, 0));
            }
        }

        // Primary branches as stubs
        const primaries = template.getBranchesByLevel(1);
        for (const seg of primaries) {
            const stubSeg = {
                ...seg,
                end: [
                    seg.start[0] + (seg.end[0] - seg.start[0]) * 0.4,
                    seg.start[1] + (seg.end[1] - seg.start[1]) * 0.4,
                    seg.start[2] + (seg.end[2] - seg.start[2]) * 0.4
                ],
                endRadius: seg.startRadius * 0.4
            };
            geometries.push(this._buildBranchSegmentMesh(stubSeg, branchRadial, 1, 1));
        }

        return this._mergeGeometries(geometries);
    }

    /**
     * LOD 3: Simple trunk + baked canopy volume.
     */
    static _buildTemplateLOD3(template) {
        const trunk = this._buildTaperedCylinder(4, 1, 0.025, 0.015, 0.5, 0);

        // Determine canopy shape from tree type
        let canopy;
        switch (template.treeType) {
            case 'birch':
            case 'deciduous':
                canopy = this._buildEllipsoid(6, 4, 0.25, 0.35, 0.65);
                break;
            case 'oak':
            case 'deciduous_broad':
                canopy = this._buildSphere(8, 6, 0.45, 0.65);
                break;
            default:
                canopy = this._buildEllipsoid(6, 4, 0.3, 0.35, 0.6);
                break;
        }

        return this._mergeGeometries([trunk, canopy]);
    }

    /**
 * Core parallel-transport tube builder. Trunk and branch chains both call this.
 *
 * Why this matters: the old per-segment builder recomputed the Frenet frame
 * from scratch at each segment. At a joint, even with matching centers and
 * radii, ring vertices lived at:
 *   A's last ring:  P + R·(rightA·cosθ + upA·sinθ)
 *   B's first ring: P + R·(rightB·cosθ + upB·sinθ)
 * With rightA ≠ rightB these are DIFFERENT points → the tube wall has a gap.
 * On thin twigs at <1m this reads as broken geometry.
 *
 * Parallel transport carries ONE frame through the node sequence. Adjacent
 * rings share vertices by construction. No gaps, no normal seams.
 *
 * @param {Array<{position: number[], radius: number}>} nodes
 * @param {number} radialSegs
 * @param {number} level - hierarchy level for the per-vertex attribute
 * @param {boolean} normalizedV - V=0..1 (trunk) vs V=arc-length (branches)
 */
static _buildParallelTransportTube(nodes, radialSegs, level, normalizedV = false) {
    if (!nodes || nodes.length < 2) return this._emptyGeometry();

    const positions = [];
    const normals   = [];
    const uvArr     = [];
    const levels    = [];
    const indices   = [];

    const N = nodes.length;

    // Tangents by central difference — smooths across kinks so normals
    // don't snap at sharp direction changes.
    const tangents = [];
    for (let i = 0; i < N; i++) {
        let tx, ty, tz;
        if (i === 0) {
            tx = nodes[1].position[0] - nodes[0].position[0];
            ty = nodes[1].position[1] - nodes[0].position[1];
            tz = nodes[1].position[2] - nodes[0].position[2];
        } else if (i === N - 1) {
            tx = nodes[i].position[0] - nodes[i-1].position[0];
            ty = nodes[i].position[1] - nodes[i-1].position[1];
            tz = nodes[i].position[2] - nodes[i-1].position[2];
        } else {
            tx = nodes[i+1].position[0] - nodes[i-1].position[0];
            ty = nodes[i+1].position[1] - nodes[i-1].position[1];
            tz = nodes[i+1].position[2] - nodes[i-1].position[2];
        }
        const len = Math.sqrt(tx*tx + ty*ty + tz*tz) || 1;
        tangents.push([tx/len, ty/len, tz/len]);
    }

    // Arc-length for V coordinate. Branches use this directly so bark
    // texel density is consistent regardless of segment count.
    const arcLen = new Float64Array(N);
    arcLen[0] = 0;
    for (let i = 1; i < N; i++) {
        const dx = nodes[i].position[0] - nodes[i-1].position[0];
        const dy = nodes[i].position[1] - nodes[i-1].position[1];
        const dz = nodes[i].position[2] - nodes[i-1].position[2];
        arcLen[i] = arcLen[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz);
    }
    const totalArc = arcLen[N - 1] || 1;

    let prevRight = null;

    for (let s = 0; s < N; s++) {
        const p = nodes[s].position;
        const r = nodes[s].radius;
        const t = tangents[s];
        const v = normalizedV ? (arcLen[s] / totalArc) : arcLen[s];

        let rightX, rightY, rightZ;
        if (prevRight === null) {
            let upX = 0, upY = 1, upZ = 0;
            if (Math.abs(t[1]) > 0.95) { upX = 1; upY = 0; upZ = 0; }
            rightX = upY * t[2] - upZ * t[1];
            rightY = upZ * t[0] - upX * t[2];
            rightZ = upX * t[1] - upY * t[0];
        } else {
            rightX = prevRight[0]; rightY = prevRight[1]; rightZ = prevRight[2];
            const dot = rightX * t[0] + rightY * t[1] + rightZ * t[2];
            rightX -= dot * t[0]; rightY -= dot * t[1]; rightZ -= dot * t[2];
        }

        let rLen = Math.sqrt(rightX*rightX + rightY*rightY + rightZ*rightZ);
        if (rLen < 1e-8) {
            // Degenerate (tangent parallel to carried right) — reseed.
            let upX = 0, upY = 1, upZ = 0;
            if (Math.abs(t[1]) > 0.95) { upX = 1; upY = 0; upZ = 0; }
            rightX = upY * t[2] - upZ * t[1];
            rightY = upZ * t[0] - upX * t[2];
            rightZ = upX * t[1] - upY * t[0];
            rLen = Math.sqrt(rightX*rightX + rightY*rightY + rightZ*rightZ) || 1;
        }
        rightX /= rLen; rightY /= rLen; rightZ /= rLen;
        prevRight = [rightX, rightY, rightZ];

        const uX = t[1] * rightZ - t[2] * rightY;
        const uY = t[2] * rightX - t[0] * rightZ;
        const uZ = t[0] * rightY - t[1] * rightX;

        for (let i = 0; i <= radialSegs; i++) {
            const u = i / radialSegs;
            const theta = u * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            const nx = rightX * cosT + uX * sinT;
            const ny = rightY * cosT + uY * sinT;
            const nz = rightZ * cosT + uZ * sinT;

            positions.push(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r);
            normals.push(nx, ny, nz);
            uvArr.push(u, v);
            levels.push(level);
        }
    }

    for (let s = 0; s < N - 1; s++) {
        for (let i = 0; i < radialSegs; i++) {
            const a = s * (radialSegs + 1) + i;
            const b = a + 1;
            const c = a + radialSegs + 1;
            const d = c + 1;
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    return {
        positions: new Float32Array(positions),
        normals:   new Float32Array(normals),
        uvs:       new Float32Array(uvArr),
        levels:    new Float32Array(levels),
        indices:   new Uint16Array(indices),
    };
}

static _emptyGeometry() {
    return {
        positions: new Float32Array(0),
        normals:   new Float32Array(0),
        uvs:       new Float32Array(0),
        levels:    new Float32Array(0),
        indices:   new Uint16Array(0),
    };
}

/**
 * Build mesh for a chain of connected segments.
 * N segments → N+1 nodes → one continuous tube.
 */
static _buildBranchChainMesh(chain, radialSegs, level) {
    if (!chain || chain.length === 0) return this._emptyGeometry();

    const nodes = [{ position: chain[0].start, radius: chain[0].startRadius }];
    for (let i = 0; i < chain.length; i++) {
        nodes.push({ position: chain[i].end, radius: chain[i].endRadius });
    }

    return this._buildParallelTransportTube(nodes, radialSegs, level, false);
}

/**
 * Group segments into chains by chainId.
 * Segments without chainId (non-birch generators not yet updated) become
 * single-segment chains — equivalent to the old per-segment build, so
 * those species behave identically.
 */
static _groupSegmentsIntoChains(segments) {
    const chains = new Map();
    let orphanSeq = 0;

    for (const seg of segments) {
        const id = seg.chainId !== undefined ? seg.chainId : `_orphan_${orphanSeq++}`;
        if (!chains.has(id)) chains.set(id, []);
        chains.get(id).push(seg);
    }

    return chains;
}

    /**
     * LOD 4: Billboard cross + canopy.
     */
    static _buildTemplateLOD4(template) {
        const cross = this._buildBillboardCross(0.04, 0.6);
        let canopy;
        switch (template.treeType) {
            case 'birch':
            case 'deciduous':
                canopy = this._buildEllipsoid(4, 3, 0.22, 0.3, 0.6);
                break;
            default:
                canopy = this._buildEllipsoid(4, 3, 0.25, 0.3, 0.6);
                break;
        }
        return this._mergeGeometries([cross, canopy]);
    }

    /**
     * LOD 5: Single billboard.
     */
    static _buildTemplateLOD5(template) {
        return this._buildBillboard(0.4, 1.0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MESH GENERATION FROM BRANCH DATA
    // ═══════════════════════════════════════════════════════════════════════


   /**
     * Build mesh for a single branch segment.
     *
     * The level attribute replaces the old analytical branch-detection
     * heuristic (lateral distance from trunk axis), which misfired on
     * wobbly trunks and gave branches the wrong bark. Now the fragment
     * shader gets the exact hierarchy level baked per-vertex:
     *   0 = trunk     → white bark, bump-mapped
     *   1 = primary   → dark branch
     *   2 = secondary → dark branch
     *   3+ = twig     → dark branch
     */
   static _buildBranchSegmentMesh(seg, radialSegments, lengthSegments, level) {
    const positions = [];
    const normals   = [];
    const uvs       = [];
    const levels    = [];
    const indices   = [];

    const start  = seg.start;
    const end    = seg.end;
    const startR = seg.startRadius;
    const endR   = seg.endRadius;

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const dz = end[2] - start[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-8) {
        return {
            positions: new Float32Array(0),
            normals:   new Float32Array(0),
            uvs:       new Float32Array(0),
            levels:    new Float32Array(0),
            indices:   new Uint16Array(0),
        };
    }

    const dirX = dx / length;
    const dirY = dy / length;
    const dirZ = dz / length;

    // Each segment derives its own frame from scratch here. Adjacent
    // segments in a chain get slightly different frames → normals at
    // the shared ring position don't match → visible seam under
    // lighting. Known issue; proper fix is to build each chain as a
    // continuous parallel-transport tube like _buildTrunkFromPath
    // does. That needs chain-grouping info from the generator, which
    // lands in iteration 3.
    let upX = 0, upY = 1, upZ = 0;
    if (Math.abs(dirY) > 0.95) { upX = 1; upY = 0; upZ = 0; }

    let rightX = upY * dirZ - upZ * dirY;
    let rightY = upZ * dirX - upX * dirZ;
    let rightZ = upX * dirY - upY * dirX;
    let rLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
    if (rLen < 1e-8) rLen = 1;
    rightX /= rLen; rightY /= rLen; rightZ /= rLen;

    const luX = dirY * rightZ - dirZ * rightY;
    const luY = dirZ * rightX - dirX * rightZ;
    const luZ = dirX * rightY - dirY * rightX;

    const lvlF = level ?? 0;

    for (let l = 0; l <= lengthSegments; l++) {
        const t = l / lengthSegments;
        const cx = start[0] + dx * t;
        const cy = start[1] + dy * t;
        const cz = start[2] + dz * t;
        const radius = startR + (endR - startR) * t;

        for (let i = 0; i <= radialSegments; i++) {
            const u = i / radialSegments;
            const theta = u * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            const nx = rightX * cosT + luX * sinT;
            const ny = rightY * cosT + luY * sinT;
            const nz = rightZ * cosT + luZ * sinT;

            positions.push(cx + nx * radius, cy + ny * radius, cz + nz * radius);
            normals.push(nx, ny, nz);
            uvs.push(u, t * length);
            levels.push(lvlF);
        }
    }

    for (let l = 0; l < lengthSegments; l++) {
        for (let i = 0; i < radialSegments; i++) {
            const a = l * (radialSegments + 1) + i;
            const b = a + 1;
            const c = a + radialSegments + 1;
            const d = c + 1;
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    return {
        positions: new Float32Array(positions),
        normals:   new Float32Array(normals),
        uvs:       new Float32Array(uvs),
        levels:    new Float32Array(levels),
        indices:   new Uint16Array(indices),
    };
}
    /**
     * Build trunk mesh from a detailed trunk path (array of position+radius nodes).
     * Produces a smooth, possibly curved cylinder following the path.
     *
     * @param {TrunkPathNode[]} path
     * @param {number} radialSegments
     * @returns {GeometryData}
     */
    static _buildTrunkFromPath(path, radialSegments) {
        if (!path || path.length < 2) {
            return this._buildTaperedCylinder(radialSegments, 2, 0.025, 0.012, 1.0, 0);
        }
        // Path nodes already carry {position, radius}. Trunk uses normalized V
        // (0..1) to preserve the existing bark UV layout.
        return this._buildParallelTransportTube(path, radialSegments, 0, true);
    }
    

    /**
     * Reduce a trunk path to fewer nodes (for lower LODs).
     * @param {TrunkPathNode[]} path
     * @param {number} targetCount
     * @returns {TrunkPathNode[]}
     */
    static _reducePath(path, targetCount) {
        if (path.length <= targetCount) return path;

        const result = [];
        for (let i = 0; i < targetCount; i++) {
            const t = i / (targetCount - 1);
            const srcIdx = t * (path.length - 1);
            const lo = Math.floor(srcIdx);
            const hi = Math.min(lo + 1, path.length - 1);
            const frac = srcIdx - lo;

            result.push({
                position: [
                    path[lo].position[0] + (path[hi].position[0] - path[lo].position[0]) * frac,
                    path[lo].position[1] + (path[hi].position[1] - path[lo].position[1]) * frac,
                    path[lo].position[2] + (path[hi].position[2] - path[lo].position[2]) * frac
                ],
                radius: path[lo].radius + (path[hi].radius - path[lo].radius) * frac,
                t: path[lo].t + (path[hi].t - path[lo].t) * frac,
                direction: path[lo].direction
            });
        }
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LEGACY BUILDERS (kept for non-template tree types and fallbacks)
    // ═══════════════════════════════════════════════════════════════════════

    static buildDeciduousBroadLODs() {
        return [
            this._buildOakLOD0(),
            this._buildOakLOD1(),
            this._buildOakLOD2(),
            this._buildOakLOD3(),
            this._buildOakLOD4(),
            this._buildOakLOD5()
        ];
    }

    static _buildOakLOD0() {
        const trunk = this._buildTaperedCylinder(12, 6, 0.07, 0.05, 0.4, 0);
        const branches = this._buildSplittingBranches(4, 0.38, 0.04, 0.25, 45, 8);
        return this._mergeGeometries([trunk, branches]);
    }

    static _buildOakLOD1() {
        const trunk = this._buildTaperedCylinder(8, 3, 0.07, 0.05, 0.4, 0);
        const branches = this._buildSplittingBranches(3, 0.38, 0.035, 0.2, 45, 6);
        return this._mergeGeometries([trunk, branches]);
    }

    static _buildOakLOD2() {
        return this._buildTaperedCylinder(6, 2, 0.07, 0.05, 0.4, 0);
    }

    static _buildOakLOD3() {
        const trunk = this._buildTaperedCylinder(4, 1, 0.07, 0.05, 0.35, 0);
        const canopy = this._buildSphere(8, 6, 0.45, 0.65);
        return this._mergeGeometries([trunk, canopy]);
    }

    static _buildOakLOD4() {
        const cross = this._buildBillboardCross(0.1, 0.4);
        const canopy = this._buildSphere(6, 4, 0.4, 0.6);
        return this._mergeGeometries([cross, canopy]);
    }

    static _buildOakLOD5() {
        return this._buildBillboard(0.8, 1.0);
    }

    // Deciduous (birch) legacy builders - now used as fallback only
    static buildDeciduousLODs() {
        return [
            this._buildBirchLOD0(),
            this._buildBirchLOD1(),
            this._buildBirchLOD2(),
            this._buildBirchLOD3(),
            this._buildBirchLOD4(),
            this._buildBirchLOD5()
        ];
    }

    static _buildBirchLOD0() {
        const trunk = this._buildCurvedCylinder(10, 8, 0.025, 0.012, 1.0, 0.05);
        const branches = this._buildDroopingBranches(5, 0.4, 0.9, 0.15, 0.008, 6);
        return this._mergeGeometries([trunk, branches]);
    }

    static _buildBirchLOD1() {
        const trunk = this._buildCurvedCylinder(6, 4, 0.025, 0.012, 1.0, 0.04);
        const branches = this._buildDroopingBranches(3, 0.45, 0.85, 0.12, 0.006, 4);
        return this._mergeGeometries([trunk, branches]);
    }

    static _buildBirchLOD2() {
        return this._buildCurvedCylinder(4, 2, 0.025, 0.015, 1.0, 0.03);
    }

    static _buildBirchLOD3() {
        const trunk = this._buildTaperedCylinder(4, 1, 0.025, 0.015, 0.5, 0);
        const canopy = this._buildEllipsoid(6, 4, 0.25, 0.35, 0.65);
        return this._mergeGeometries([trunk, canopy]);
    }

    static _buildBirchLOD4() {
        const cross = this._buildBillboardCross(0.04, 0.6);
        const canopy = this._buildEllipsoid(4, 3, 0.22, 0.3, 0.6);
        return this._mergeGeometries([cross, canopy]);
    }

    static _buildBirchLOD5() {
        return this._buildBillboard(0.4, 1.0);
    }

    // Eucalyptus, Palm, etc. (unchanged from original)
    static buildDeciduousTallLODs() {
        return [
            this._buildTaperedCylinder(10, 10, 0.045, 0.025, 1.0, 0),
            this._buildTaperedCylinder(6, 5, 0.045, 0.025, 1.0, 0),
            this._buildTaperedCylinder(4, 3, 0.045, 0.025, 1.0, 0),
            this._mergeGeometries([
                this._buildTaperedCylinder(4, 2, 0.045, 0.028, 0.65, 0),
                this._buildIrregularSphere(6, 4, 0.25, 0.8)
            ]),
            this._mergeGeometries([
                this._buildBillboardCross(0.06, 0.7),
                this._buildIrregularSphere(4, 3, 0.22, 0.75)
            ]),
            this._buildBillboard(0.4, 1.0)
        ];
    }

    static buildPalmLODs() {
        return [
            this._mergeGeometries([
                this._buildRingedCylinder(10, 12, 0.035, 0.03, 0.95),
                this._buildFrondStubs(10, 0.93, 0.3, 0.015, 6)
            ]),
            this._mergeGeometries([
                this._buildRingedCylinder(6, 6, 0.035, 0.03, 0.95),
                this._buildFrondStubs(6, 0.93, 0.25, 0.012, 4)
            ]),
            this._buildTaperedCylinder(6, 4, 0.035, 0.03, 0.95, 0),
            this._mergeGeometries([
                this._buildTaperedCylinder(4, 2, 0.035, 0.03, 0.9, 0),
                this._buildStarCanopy(8, 0.35, 0.92)
            ]),
            this._mergeGeometries([
                this._buildBillboardCross(0.05, 0.9),
                this._buildStarCanopy(5, 0.3, 0.9)
            ]),
            this._buildBillboard(0.5, 1.0)
        ];
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRIMITIVE BUILDERS (unchanged from original)
    // ═══════════════════════════════════════════════════════════════════════

    static _buildTaperedCylinder(radialSegments, heightSegments, baseRadius, topRadius, height, baseY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const posY = baseY + v * height;
            const radius = baseRadius + (topRadius - baseRadius) * v;

            for (let i = 0; i <= radialSegments; i++) {
                const u = i / radialSegments;
                const angle = u * Math.PI * 2;

                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;

                positions.push(x, posY, z);

                const nx = Math.cos(angle);
                const nz = Math.sin(angle);
                const slopeAngle = Math.atan2(baseRadius - topRadius, height);
                const ny = Math.sin(slopeAngle);
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                normals.push(nx / len, ny / len, nz / len);

                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let i = 0; i < radialSegments; i++) {
                const a = y * (radialSegments + 1) + i;
                const b = a + 1;
                const c = a + radialSegments + 1;
                const d = c + 1;

                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildCurvedCylinder(radialSegments, heightSegments, baseRadius, topRadius, height, curvature) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const posY = v * height;
            const radius = baseRadius + (topRadius - baseRadius) * v;
            const curveOffset = Math.sin(v * Math.PI) * curvature;

            for (let i = 0; i <= radialSegments; i++) {
                const u = i / radialSegments;
                const angle = u * Math.PI * 2;

                const x = Math.cos(angle) * radius + curveOffset;
                const z = Math.sin(angle) * radius;

                positions.push(x, posY, z);

                const nx = Math.cos(angle);
                const nz = Math.sin(angle);
                normals.push(nx, 0, nz);

                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let i = 0; i < radialSegments; i++) {
                const a = y * (radialSegments + 1) + i;
                const b = a + 1;
                const c = a + radialSegments + 1;
                const d = c + 1;

                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildRingedCylinder(radialSegments, heightSegments, baseRadius, topRadius, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const posY = v * height;

            const ringPhase = (v * heightSegments * 2) % 1;
            const ringBulge = Math.sin(ringPhase * Math.PI) * 0.003;
            const radius = baseRadius + (topRadius - baseRadius) * v + ringBulge;

            for (let i = 0; i <= radialSegments; i++) {
                const u = i / radialSegments;
                const angle = u * Math.PI * 2;

                positions.push(
                    Math.cos(angle) * radius,
                    posY,
                    Math.sin(angle) * radius
                );

                normals.push(Math.cos(angle), 0, Math.sin(angle));
                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let i = 0; i < radialSegments; i++) {
                const a = y * (radialSegments + 1) + i;
                const b = a + 1;
                const c = a + radialSegments + 1;
                const d = c + 1;
                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildBranchStubs(count, minHeight, maxHeight, length, radius, segments) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;

        for (let i = 0; i < count; i++) {
            const height = minHeight + (maxHeight - minHeight) * (i / (count - 1 || 1));
            const angle = (i / count) * Math.PI * 2 + (i % 2) * 0.3;

            const branch = this._buildBranchCylinder(
                segments, 2, radius, radius * 0.5, length,
                height, angle, -0.2
            );

            allPositions.push(...branch.positions);
            allNormals.push(...branch.normals);
            allUVs.push(...branch.uvs);

            for (const idx of branch.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += branch.positions.length / 3;
        }

        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    static _buildBranchCylinder(radialSegments, lengthSegments, baseRadius, tipRadius, length, startHeight, angle, elevation) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const cosE = Math.cos(elevation);
        const sinE = Math.sin(elevation);

        const dirX = cosA * cosE;
        const dirY = sinE;
        const dirZ = sinA * cosE;

        let upX = 0, upY = 1, upZ = 0;
        if (Math.abs(dirY) > 0.9) {
            upX = 1; upY = 0; upZ = 0;
        }

        const rightX = upY * dirZ - upZ * dirY;
        const rightY = upZ * dirX - upX * dirZ;
        const rightZ = upX * dirY - upY * dirX;
        const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);

        const rX = rightX / rightLen;
        const rY = rightY / rightLen;
        const rZ = rightZ / rightLen;

        const uX = dirY * rZ - dirZ * rY;
        const uY = dirZ * rX - dirX * rZ;
        const uZ = dirX * rY - dirY * rX;

        for (let l = 0; l <= lengthSegments; l++) {
            const t = l / lengthSegments;
            const radius = baseRadius + (tipRadius - baseRadius) * t;

            const centerX = dirX * length * t;
            const centerY = startHeight + dirY * length * t;
            const centerZ = dirZ * length * t;

            for (let i = 0; i <= radialSegments; i++) {
                const u = i / radialSegments;
                const theta = u * Math.PI * 2;
                const cos = Math.cos(theta);
                const sin = Math.sin(theta);

                const nx = rX * cos + uX * sin;
                const ny = rY * cos + uY * sin;
                const nz = rZ * cos + uZ * sin;

                positions.push(
                    centerX + nx * radius,
                    centerY + ny * radius,
                    centerZ + nz * radius
                );
                normals.push(nx, ny, nz);
                uvs.push(u, t);
            }
        }

        for (let l = 0; l < lengthSegments; l++) {
            for (let i = 0; i < radialSegments; i++) {
                const a = l * (radialSegments + 1) + i;
                const b = a + 1;
                const c = a + radialSegments + 1;
                const d = c + 1;
                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildSplittingBranches(count, startHeight, radius, length, angle, segments) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;

        for (let i = 0; i < count; i++) {
            const branchAngle = (i / count) * Math.PI * 2;
            const elevation = angle * Math.PI / 180;

            const branch = this._buildBranchCylinder(
                segments, 3, radius, radius * 0.4, length,
                startHeight, branchAngle, elevation
            );

            allPositions.push(...branch.positions);
            allNormals.push(...branch.normals);
            allUVs.push(...branch.uvs);

            for (const idx of branch.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += branch.positions.length / 3;
        }

        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    static _buildDroopingBranches(count, minHeight, maxHeight, length, radius, segments) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;

        for (let i = 0; i < count; i++) {
            const height = minHeight + (maxHeight - minHeight) * Math.random();
            const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
            const droop = -0.3 - Math.random() * 0.3;

            const branch = this._buildBranchCylinder(
                segments, 2, radius, radius * 0.3, length,
                height, angle, droop
            );

            allPositions.push(...branch.positions);
            allNormals.push(...branch.normals);
            allUVs.push(...branch.uvs);

            for (const idx of branch.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += branch.positions.length / 3;
        }

        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    static _buildFrondStubs(count, height, length, radius, segments) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;

        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2;
            const elevation = (i % 3 === 0) ? 0.3 : ((i % 3 === 1) ? 0 : -0.25);

            const frond = this._buildBranchCylinder(
                segments, 2, radius, radius * 0.2, length,
                height, angle, elevation
            );

            allPositions.push(...frond.positions);
            allNormals.push(...frond.normals);
            allUVs.push(...frond.uvs);

            for (const idx of frond.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += frond.positions.length / 3;
        }

        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    static _buildCone(segments, radius, height, baseY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        positions.push(0, baseY + height, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 1);

        const slopeAngle = Math.atan2(radius, height);
        const ny = Math.cos(slopeAngle);
        const nHoriz = Math.sin(slopeAngle);

        for (let i = 0; i <= segments; i++) {
            const u = i / segments;
            const angle = u * Math.PI * 2;

            positions.push(
                Math.cos(angle) * radius,
                baseY,
                Math.sin(angle) * radius
            );

            normals.push(
                Math.cos(angle) * nHoriz,
                ny,
                Math.sin(angle) * nHoriz
            );

            uvs.push(u, 0);
        }

        for (let i = 0; i < segments; i++) {
            indices.push(0, i + 2, i + 1);
        }

        const baseCenterIndex = positions.length / 3;
        positions.push(0, baseY, 0);
        normals.push(0, -1, 0);
        uvs.push(0.5, 0.5);

        for (let i = 0; i < segments; i++) {
            indices.push(baseCenterIndex, i + 1, i + 2);
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildSphere(widthSegments, heightSegments, radius, centerY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI;

            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;

                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);

                positions.push(nx * radius, ny * radius + centerY, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + 1;
                const c = a + widthSegments + 1;
                const d = c + 1;

                if (y !== 0) indices.push(a, c, b);
                if (y !== heightSegments - 1) indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildEllipsoid(widthSegments, heightSegments, radiusXZ, radiusY, centerY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI;

            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;

                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);

                positions.push(nx * radiusXZ, ny * radiusY + centerY, nz * radiusXZ);

                const enx = nx / radiusXZ;
                const eny = ny / radiusY;
                const enz = nz / radiusXZ;
                const len = Math.sqrt(enx * enx + eny * eny + enz * enz);
                normals.push(enx / len, eny / len, enz / len);

                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + 1;
                const c = a + widthSegments + 1;
                const d = c + 1;

                if (y !== 0) indices.push(a, c, b);
                if (y !== heightSegments - 1) indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildIrregularSphere(widthSegments, heightSegments, radius, centerY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        const noise = (x, y) => {
            const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
            return (n - Math.floor(n)) * 0.3 + 0.85;
        };

        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI;

            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;

                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);

                const r = radius * noise(x, y);

                positions.push(nx * r, ny * r + centerY, nz * r);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }

        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + 1;
                const c = a + widthSegments + 1;
                const d = c + 1;

                if (y !== 0) indices.push(a, c, b);
                if (y !== heightSegments - 1) indices.push(b, c, d);
            }
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildStarCanopy(points, length, centerY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        positions.push(0, centerY, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 0.5);

        for (let i = 0; i < points; i++) {
            const angle = (i / points) * Math.PI * 2;
            const elevation = (i % 3 === 0) ? 0.2 : ((i % 3 === 1) ? 0 : -0.15);

            const x = Math.cos(angle) * length;
            const y = centerY + elevation * length;
            const z = Math.sin(angle) * length;

            positions.push(x, y, z);

            const nx = Math.cos(angle);
            const nz = Math.sin(angle);
            normals.push(nx * 0.7, 0.7, nz * 0.7);

            uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5);
        }

        for (let i = 0; i < points; i++) {
            const next = (i + 1) % points;
            indices.push(0, i + 1, next + 1);
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildBillboardCross(width, height) {
        const hw = width * 0.5;
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        positions.push(
            -hw, 0, 0,
            hw, 0, 0,
            hw, height, 0,
            -hw, height, 0
        );
        normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(0, 1, 2, 0, 2, 3);

        positions.push(
            0, 0, -hw,
            0, 0, hw,
            0, height, hw,
            0, height, -hw
        );
        normals.push(1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(4, 5, 6, 4, 6, 7);

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildBillboard(width, height) {
        const hw = width * 0.5;

        return {
            positions: new Float32Array([
                -hw, 0, 0,
                hw, 0, 0,
                hw, height, 0,
                -hw, height, 0
            ]),
            normals: new Float32Array([
                0, 0, 1,
                0, 0, 1,
                0, 0, 1,
                0, 0, 1
            ]),
            uvs: new Float32Array([
                0, 0,
                1, 0,
                1, 1,
                0, 1
            ]),
            indices: new Uint16Array([0, 1, 2, 0, 2, 3])
        };
    }

    static _mergeGeometries(geometries) {
        const valid = geometries.filter(g => g && g.positions && g.positions.length > 0);
        if (valid.length === 0) {
            return {
                positions: new Float32Array(0),
                normals:   new Float32Array(0),
                uvs:       new Float32Array(0),
                levels:    new Float32Array(0),
                indices:   new Uint16Array(0),
            };
        }
        if (valid.length === 1) return valid[0];

        // Levels are optional — legacy primitive builders (sphere,
        // billboard, etc.) don't emit them. Default those to 0 so the
        // merged output is always complete for consumers that want it
        // (BranchRenderer). Consumers that don't (scatter path) ignore
        // the field entirely.
        const allPositions = [];
        const allNormals   = [];
        const allUVs       = [];
        const allLevels    = [];
        const allIndices   = [];
        let vertexOffset   = 0;

        for (const geo of valid) {
            const vertCount = geo.positions.length / 3;

            allPositions.push(...geo.positions);
            allNormals.push(...geo.normals);
            allUVs.push(...geo.uvs);

            if (geo.levels && geo.levels.length === vertCount) {
                allLevels.push(...geo.levels);
            } else {
                for (let i = 0; i < vertCount; i++) allLevels.push(0);
            }

            for (const idx of geo.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += vertCount;
        }

        return {
            positions: new Float32Array(allPositions),
            normals:   new Float32Array(allNormals),
            uvs:       new Float32Array(allUVs),
            levels:    new Float32Array(allLevels),
            indices:   new Uint16Array(allIndices),
        };
    }
    // ═══════════════════════════════════════════════════════════════════════
    // FACTORY METHOD
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build all LODs for a tree type.
     * If a TreeTemplate is provided, uses the hierarchical branch data.
     * Otherwise falls back to legacy procedural builders.
     *
     * @param {string} geometryType - Type from asset definition
     * @param {import('./TreeTemplate.js').TreeTemplate} [template] - Optional template for hierarchy-based meshes
     * @returns {GeometryData[]} Array of LOD 0-5 geometries
     */
    static buildForType(geometryType, template) {
        // Use template-based builder if available
        if (template && template.branches && template.branches.length > 0) {
            return this.buildFromTemplate(template);
        }

        // Legacy fallback
        switch (geometryType) {
            case 'deciduous_broad':
                return this.buildDeciduousBroadLODs();
            case 'deciduous':
                return this.buildDeciduousLODs();
            case 'deciduous_tall':
                return this.buildDeciduousTallLODs();
            case 'palm':
                return this.buildPalmLODs();
            default:
                return this.buildDeciduousLODs();
        }
    }
}
