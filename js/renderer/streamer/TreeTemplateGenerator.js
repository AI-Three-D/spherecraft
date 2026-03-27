// js/renderer/streamer/TreeTemplateGenerator.js
//
// Procedurally generates tree templates with branch hierarchies and anchor points.
// This runs once at initialization to create the template library.
//
// UPDATED: Uses BranchSystem for hierarchical branch generation.

import { TreeTemplate } from './TreeTemplate.js';
import { BranchSystem } from './branch/BranchSystem.js';
import {
    normalize3 as normalize,
    add3 as add,
    scale3 as scale,
    lerp3 as lerp,
    cross3
} from '../utils/vector3.js';
import { SeededRandom } from '../utils/SeededRandom.js';

/**
 * Get a perpendicular vector to the given direction.
 */
function getPerpendicular(dir) {
    const up = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    return normalize(cross3(up, dir));
}

export class TreeTemplateGenerator {
    /**
     * Generate templates for a tree type.
     *
     * @param {object} config
     * @param {string} config.treeType - e.g., 'oak', 'birch', 'palm'
     * @param {number} config.variantCount - number of variants to generate
     * @param {number} config.baseSeed - seed for deterministic generation
     * @param {object} config.params - tree-specific parameters
     * @returns {TreeTemplate[]}
     */
    static generateVariants(config) {
        const templates = [];

        for (let i = 0; i < config.variantCount; i++) {
            const seed = config.baseSeed + i * 1000;
            const template = this.generateSingle(
                config.treeType,
                i,
                seed,
                config.params
            );
            templates.push(template);
        }

        return templates;
    }

    /**
     * Generate a single tree template.
     */
    static generateSingle(treeType, variantIndex, seed, params) {
        const rng = new SeededRandom(seed);

        // Select generator based on tree type
        switch (treeType) {
            case 'oak':
            case 'deciduous_broad':
                return this._generateDeciduous(treeType, variantIndex, rng, params);
            case 'birch':
            case 'deciduous':
                return this._generateBirchHierarchical(treeType, variantIndex, seed, params);
            case 'eucalyptus':
            case 'deciduous_tall':
                return this._generateEucalyptus(treeType, variantIndex, rng, params);
            case 'palm':
                return this._generatePalm(treeType, variantIndex, rng, params);
            default:
                return this._generateGenericTree(treeType, variantIndex, rng, params);
        }
    }
    static _generateBirchHierarchical(treeType, variantIndex, seed, params = {}) {
        const result = BranchSystem.generateBirch(seed, params);
    
        // Birch anchors are emitted pre-sorted by tier with positional
        // childStart/Count indices. Sorting would corrupt those indices.
        // Other species (via _generateDeciduous etc.) still sort by canopyLOD
        // before calling _buildCanopyLODInfo — they don't use child pointers.
        const canopyLODs = this._buildCanopyLODInfo(result.anchors);
    
        return new TreeTemplate({
            id: `${treeType}_${String(variantIndex).padStart(2, '0')}`,
            treeType,
            variantIndex,
            branches:  result.segments,
            anchors:   result.anchors,
            canopyLODs,
            trunkPath: result.trunkPath,
            bounds:    this._computeBounds(result.segments, result.anchors),
            baseHeight: 1.0,
            branchStats: result.stats,
        });
    }

    /**
     * Generate a deciduous (oak-like) template.
     */
    static _generateDeciduous(treeType, variantIndex, rng, params = {}) {
        const height = params.height ?? rng.range(0.75, 1.0);
        const trunkRadius = params.trunkRadius ?? rng.range(0.05, 0.08);
        const crownStart = params.crownStart ?? rng.range(0.3, 0.45);
        const crownRadius = params.crownRadius ?? rng.range(0.5, 0.7);

        const branches = [];
        const anchors = [];

        let segId = 0;

        const trunkTop = crownStart * height;
        branches.push({
            id: segId++,
            start: [0, 0, 0],
            end: [0, trunkTop, 0],
            startRadius: trunkRadius,
            endRadius: trunkRadius * 0.7,
            level: 0,
            parentId: -1
        });

        // Main branches from trunk top
        const mainBranchCount = rng.rangeInt(4, 7);
        const mainBranches = [];

        for (let i = 0; i < mainBranchCount; i++) {
            const angle = (i / mainBranchCount) * Math.PI * 2 + rng.range(-0.3, 0.3);
            const elevation = rng.range(0.3, 0.7);
            const length = crownRadius * rng.range(0.6, 1.0);

            const dir = [
                Math.cos(angle) * Math.cos(elevation),
                Math.sin(elevation),
                Math.sin(angle) * Math.cos(elevation)
            ];

            const end = add([0, trunkTop, 0], scale(dir, length));

            branches.push({
                id: segId++,
                start: [0, trunkTop, 0],
                end,
                startRadius: trunkRadius * 0.5,
                endRadius: trunkRadius * 0.2,
                level: 1,
                parentId: 0
            });

            mainBranches.push({ start: [0, trunkTop, 0], end, dir, segId: segId - 1 });
        }

        // Secondary branches and anchors
        for (const main of mainBranches) {
            const secondaryCount = rng.rangeInt(3, 6);

            for (let s = 0; s < secondaryCount; s++) {
                const t = rng.range(0.3, 0.9);
                const branchPoint = lerp(main.start, main.end, t);

                const perp = getPerpendicular(main.dir);
                const sideAngle = rng.range(-Math.PI, Math.PI);
                const upAngle = rng.range(0.1, 0.6);

                const sDir = normalize([
                    perp[0] * Math.cos(sideAngle) + main.dir[0] * 0.3,
                    Math.sin(upAngle),
                    perp[2] * Math.cos(sideAngle) + main.dir[2] * 0.3
                ]);

                const sLength = rng.range(0.15, 0.35);
                const sEnd = add(branchPoint, scale(sDir, sLength));

                branches.push({
                    id: segId++,
                    start: branchPoint,
                    end: sEnd,
                    startRadius: trunkRadius * 0.15,
                    endRadius: trunkRadius * 0.05,
                    level: 2,
                    parentId: main.segId
                });

                // Tertiary twigs with anchors
                const twigCount = rng.rangeInt(3, 7);
                for (let tw = 0; tw < twigCount; tw++) {
                    const tt = rng.range(0.2, 1.0);
                    const twigStart = lerp(branchPoint, sEnd, tt);

                    const twigDir = normalize([
                        sDir[0] + rng.range(-0.5, 0.5),
                        sDir[1] + rng.range(0, 0.5),
                        sDir[2] + rng.range(-0.5, 0.5)
                    ]);

                    const twigLength = rng.range(0.05, 0.15);
                    const twigEnd = add(twigStart, scale(twigDir, twigLength));

                    const twigSegId = segId++;
                    branches.push({
                        id: twigSegId,
                        start: twigStart,
                        end: twigEnd,
                        startRadius: trunkRadius * 0.04,
                        endRadius: trunkRadius * 0.015,
                        level: 3,
                        parentId: segId - 2
                    });

                    // Anchors along twig
                    const anchorCount = rng.rangeInt(5, 10);
                    for (let a = 0; a < anchorCount; a++) {
                        const at = (a + 0.5) / anchorCount;
                        const pos = lerp(twigStart, twigEnd, at);

                        const distFromCenter = Math.sqrt(
                            pos[0] * pos[0] + pos[2] * pos[2]
                        );
                        const heightRatio = pos[1] / height;

                        let canopyLOD = 2;
                        if (distFromCenter > crownRadius * 0.5 || heightRatio > 0.7) {
                            canopyLOD = 0;
                        } else if (distFromCenter > crownRadius * 0.3 || heightRatio > 0.5) {
                            canopyLOD = 1;
                        }

                        anchors.push({
                            position: pos,
                            direction: twigDir,
                            spread: rng.range(0.1, 0.2),
                            density: rng.range(0.7, 1.0),
                            canopyLOD,
                            branchLevel: 3,
                            parentSegId: twigSegId
                        });
                    }
                }
            }
        }

        anchors.sort((a, b) => a.canopyLOD - b.canopyLOD);
        const canopyLODs = this._buildCanopyLODInfo(anchors);

        return new TreeTemplate({
            id: `${treeType}_${String(variantIndex).padStart(2, '0')}`,
            treeType,
            variantIndex,
            branches,
            anchors,
            canopyLODs,
            bounds: this._computeBounds(branches, anchors),
            baseHeight: 1.0
        });
    }

    /**
     * Generate a eucalyptus template.
     */
    static _generateEucalyptus(treeType, variantIndex, rng, params = {}) {
        const height = params.height ?? rng.range(0.9, 1.2);
        const trunkRadius = params.trunkRadius ?? rng.range(0.04, 0.06);
        const crownStart = params.crownStart ?? rng.range(0.5, 0.65);

        const branches = [];
        const anchors = [];
        let segId = 0;

        branches.push({
            id: segId++,
            start: [0, 0, 0],
            end: [0, height, 0],
            startRadius: trunkRadius,
            endRadius: trunkRadius * 0.5,
            level: 0,
            parentId: -1
        });

        const branchCount = rng.rangeInt(5, 9);

        for (let i = 0; i < branchCount; i++) {
            const branchY = crownStart * height + rng.range(0, (1 - crownStart) * height * 0.8);
            const angle = rng.range(0, Math.PI * 2);
            const upward = rng.range(0.1, 0.3);

            const branchDir = normalize([
                Math.cos(angle),
                upward,
                Math.sin(angle)
            ]);

            const branchLength = rng.range(0.15, 0.35);
            const branchEnd = add([0, branchY, 0], scale(branchDir, branchLength));

            branches.push({
                id: segId++,
                start: [0, branchY, 0],
                end: branchEnd,
                startRadius: trunkRadius * 0.35,
                endRadius: trunkRadius * 0.12,
                level: 1,
                parentId: 0
            });

            const clusterCount = rng.rangeInt(4, 8);
            for (let c = 0; c < clusterCount; c++) {
                const ct = rng.range(0.3, 1.0);
                const clusterPos = lerp([0, branchY, 0], branchEnd, ct);

                const droopDir = normalize([
                    rng.range(-0.2, 0.2),
                    -rng.range(0.6, 1.0),
                    rng.range(-0.2, 0.2)
                ]);

                const heightRatio = branchY / height;
                const canopyLOD = heightRatio < 0.65 ? 2 : (heightRatio < 0.8 ? 1 : 0);

                anchors.push({
                    position: clusterPos,
                    direction: droopDir,
                    spread: rng.range(0.12, 0.22),
                    density: rng.range(0.5, 0.9),
                    canopyLOD,
                    branchLevel: 1,
                    parentSegId: segId - 1
                });
            }
        }

        anchors.sort((a, b) => a.canopyLOD - b.canopyLOD);
        const canopyLODs = this._buildCanopyLODInfo(anchors);

        return new TreeTemplate({
            id: `${treeType}_${String(variantIndex).padStart(2, '0')}`,
            treeType,
            variantIndex,
            branches,
            anchors,
            canopyLODs,
            bounds: this._computeBounds(branches, anchors),
            baseHeight: 1.0
        });
    }

    /**
     * Generate a palm template.
     */
    static _generatePalm(treeType, variantIndex, rng, params = {}) {
        const height = params.height ?? rng.range(0.8, 1.1);
        const trunkRadius = params.trunkRadius ?? rng.range(0.03, 0.05);

        const branches = [];
        const anchors = [];
        let segId = 0;

        const trunkCurve = rng.range(-0.08, 0.08);
        const trunkTop = height * 0.95;

        branches.push({
            id: segId++,
            start: [0, 0, 0],
            end: [trunkCurve, trunkTop, 0],
            startRadius: trunkRadius,
            endRadius: trunkRadius * 0.8,
            level: 0,
            parentId: -1
        });

        const frondCount = rng.rangeInt(8, 14);
        const crownCenter = [trunkCurve, trunkTop, 0];

        for (let f = 0; f < frondCount; f++) {
            const angle = (f / frondCount) * Math.PI * 2 + rng.range(-0.2, 0.2);
            const elevation = rng.range(-0.3, 0.4);
            const frondLength = rng.range(0.25, 0.45);

            const frondDir = normalize([
                Math.cos(angle) * Math.cos(elevation),
                Math.sin(elevation),
                Math.sin(angle) * Math.cos(elevation)
            ]);

            const frondEnd = add(crownCenter, scale(frondDir, frondLength));

            branches.push({
                id: segId++,
                start: crownCenter,
                end: frondEnd,
                startRadius: trunkRadius * 0.15,
                endRadius: trunkRadius * 0.02,
                level: 1,
                parentId: 0
            });

            const anchorCount = rng.rangeInt(10, 18);
            for (let a = 0; a < anchorCount; a++) {
                const at = (a + 0.2) / anchorCount;
                const pos = lerp(crownCenter, frondEnd, at);

                const leafDir = normalize([
                    frondDir[0] + rng.range(-0.3, 0.3),
                    frondDir[1] - 0.3,
                    frondDir[2] + rng.range(-0.3, 0.3)
                ]);

                const canopyLOD = at < 0.4 ? 2 : (at < 0.7 ? 1 : 0);

                anchors.push({
                    position: pos,
                    direction: leafDir,
                    spread: rng.range(0.04, 0.1),
                    density: rng.range(0.8, 1.0),
                    canopyLOD,
                    branchLevel: 1,
                    parentSegId: segId - 1
                });
            }
        }

        anchors.sort((a, b) => a.canopyLOD - b.canopyLOD);
        const canopyLODs = this._buildCanopyLODInfo(anchors);

        return new TreeTemplate({
            id: `${treeType}_${String(variantIndex).padStart(2, '0')}`,
            treeType,
            variantIndex,
            branches,
            anchors,
            canopyLODs,
            bounds: this._computeBounds(branches, anchors),
            baseHeight: 1.0
        });
    }

    /**
     * Generate a generic tree template (fallback).
     */
    static _generateGenericTree(treeType, variantIndex, rng, params = {}) {
        return this._generateDeciduous(treeType, variantIndex, rng, params);
    }

    /**
     * Build canopy LOD info from sorted anchors.
     * @param {AnchorPoint[]} anchors - Must be sorted by canopyLOD ascending
     * @returns {CanopyLODInfo[]}
     */
    static _buildCanopyLODInfo(anchors) {
        const lodInfo = [];
        let currentLOD = -1;
        let lodStart = 0;

        for (let i = 0; i < anchors.length; i++) {
            const anchor = anchors[i];
            const tierVal = anchor.tier ?? anchor.canopyLOD ?? 0;
            if (tierVal !== currentLOD) {

                // Fill any skipped LOD levels
                while (currentLOD < tierVal - 1) {
                    currentLOD++;
                    lodInfo.push({
                        anchorStart: i,
                        anchorCount: 0,
                        maxDistance: this._getLODDistance(currentLOD)
                    });
                }

                // Close previous LOD
                if (currentLOD >= 0 && lodInfo.length > 0) {
                    lodInfo[lodInfo.length - 1].anchorCount = i - lodStart;
                }

                // Start new LOD
                currentLOD = tierVal;
                lodStart = i;
                lodInfo.push({
                    anchorStart: i,
                    anchorCount: 0,
                    maxDistance: this._getLODDistance(currentLOD)
                });
            }
        }

        // Close final LOD
        if (lodInfo.length > 0) {
            lodInfo[lodInfo.length - 1].anchorCount = anchors.length - lodStart;
        }

        return lodInfo;
    }

    /**
     * Get default max distance for a canopy LOD level.
     */
    static _getLODDistance(lod) {
        const distances = [50, 150, 400, 1000];
        return distances[Math.min(lod, distances.length - 1)];
    }

    /**
     * Compute bounding box from branches and anchors.
     */
    static _computeBounds(branches, anchors) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];

        const updateBounds = (p) => {
            min[0] = Math.min(min[0], p[0]);
            min[1] = Math.min(min[1], p[1]);
            min[2] = Math.min(min[2], p[2]);
            max[0] = Math.max(max[0], p[0]);
            max[1] = Math.max(max[1], p[1]);
            max[2] = Math.max(max[2], p[2]);
        };

        for (const b of branches) {
            updateBounds(b.start);
            updateBounds(b.end);
        }

        for (const a of anchors) {
            updateBounds(a.position);
        }

        if (min[0] === Infinity) {
            return { min: [0, 0, 0], max: [1, 1, 1] };
        }

        // Add padding for leaf spread
        const pad = 0.05;
        return {
            min: [min[0] - pad, min[1], min[2] - pad],
            max: [max[0] + pad, max[1] + pad, max[2] + pad]
        };
    }
}
