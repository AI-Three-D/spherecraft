import { Logger } from '../../../config/Logger.js';

export const ASSET_BAKE_REPRESENTATION = Object.freeze({
    NONE: 'none',
    COVERAGE: 'coverage',
    CLUSTER: 'cluster',
    FIELD: 'field',
    INSTANCES: 'instances',
    RUNTIME_TREE: 'runtimeTree',
});

const TAG = '[AssetBakePolicy]';
const DEFAULT_VIEWPORT_HEIGHT_PX = 1080;
const DEFAULT_FOV_DEGREES = 75;
const DEFAULT_LOD_THRESHOLD = 512;

const DEFAULT_PROFILE = Object.freeze({
    preserveRuntime: false,
    allowField: false,
    allowCluster: false,
    allowCoverage: false,
    individualPixelThreshold: 4.0,
    clusterPixelThreshold: 1.0,
    coveragePixelThreshold: 0.35,
    minIndividualDistance: 128.0,
    minClusterDistance: 512.0,
    minCoverageDistance: 2048.0,
    fixedIndividualDistance: null,
    fixedClusterDistance: null,
    fixedCoverageDistance: null,
    densitySafetyFactor: 1.0,
    packedInstanceBytes: 16,
    packedClusterBytes: 12,
    fieldResolution: 24,
    fieldTexelBytes: 4,
    coverageResolution: 16,
    coverageTexelBytes: 1,
    clusterReductionFactor: 8.0,
});

const TILE_BUDGET_TABLE = Object.freeze([
    { maxDistance: 400.0, bytes: 512 * 1024 },
    { maxDistance: 1200.0, bytes: 256 * 1024 },
    { maxDistance: 4000.0, bytes: 96 * 1024 },
    { maxDistance: 12000.0, bytes: 24 * 1024 },
    { maxDistance: 25000.0, bytes: 8 * 1024 },
    { maxDistance: Infinity, bytes: 0 },
]);

const ARCHETYPE_PROFILE_OVERRIDES = Object.freeze({
    tree_standard: {
        preserveRuntime: true,
        allowCluster: true,
        allowCoverage: true,
        fixedIndividualDistance: 450.0,
        fixedClusterDistance: 8000.0,
        fixedCoverageDistance: 25000.0,
    },
    grass_tuft: {
        allowField: true,
        individualPixelThreshold: 3.0,
        minIndividualDistance: 260.0,
        minClusterDistance: 0.0,
        minCoverageDistance: 0.0,
        densitySafetyFactor: 24.0,
        packedInstanceBytes: 12,
        fieldResolution: 32,
        fieldTexelBytes: 4,
        coverageResolution: 24,
    },
    fern: {
        allowField: true,
        individualPixelThreshold: 3.5,
        minIndividualDistance: 180.0,
        minClusterDistance: 0.0,
        minCoverageDistance: 0.0,
        densitySafetyFactor: 4.0,
        packedInstanceBytes: 12,
        fieldResolution: 24,
        fieldTexelBytes: 4,
        coverageResolution: 16,
    },
    rock_small: {
        allowCluster: true,
        individualPixelThreshold: 4.0,
        clusterPixelThreshold: 1.0,
        minIndividualDistance: 220.0,
        minClusterDistance: 1400.0,
        densitySafetyFactor: 2.0,
        packedInstanceBytes: 16,
        packedClusterBytes: 12,
        clusterReductionFactor: 10.0,
    },
    mushroom_capped: {
        individualPixelThreshold: 4.0,
        minIndividualDistance: 90.0,
        minClusterDistance: 0.0,
        minCoverageDistance: 0.0,
        densitySafetyFactor: 2.0,
        packedInstanceBytes: 12,
    },
    fallen_log: {
        allowCluster: true,
        individualPixelThreshold: 4.0,
        clusterPixelThreshold: 1.0,
        minIndividualDistance: 260.0,
        minClusterDistance: 1500.0,
        densitySafetyFactor: 1.5,
        packedInstanceBytes: 16,
        packedClusterBytes: 12,
        clusterReductionFactor: 6.0,
    },
    tree_stump: {
        allowCluster: true,
        individualPixelThreshold: 4.0,
        clusterPixelThreshold: 1.0,
        minIndividualDistance: 220.0,
        minClusterDistance: 1200.0,
        densitySafetyFactor: 1.5,
        packedInstanceBytes: 12,
        packedClusterBytes: 12,
        clusterReductionFactor: 6.0,
    },
});

function maxFinite(values, fallback = 0.0) {
    let best = fallback;
    for (const value of values || []) {
        if (Number.isFinite(value)) {
            best = Math.max(best, value);
        }
    }
    return best;
}

function positive(value, fallback = 0.0) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function mergeProfile(base, override) {
    return {
        ...base,
        ...(override || {}),
    };
}

function representationPriority(mode) {
    switch (mode) {
        case ASSET_BAKE_REPRESENTATION.RUNTIME_TREE: return 4;
        case ASSET_BAKE_REPRESENTATION.INSTANCES: return 3;
        case ASSET_BAKE_REPRESENTATION.FIELD: return 2;
        case ASSET_BAKE_REPRESENTATION.CLUSTER: return 1;
        case ASSET_BAKE_REPRESENTATION.COVERAGE: return 0.5;
        default: return 0;
    }
}

export class AssetBakePolicy {
    constructor(options = {}) {
        this.assetRegistry = options.assetRegistry;
        this.engineConfig = options.engineConfig || {};
        this.quadtreeGPU = options.quadtreeGPU || null;
        this.planetConfig = options.planetConfig || {};

        if (!this.assetRegistry) {
            throw new Error(`${TAG} assetRegistry is required`);
        }

        const fovDegrees = positive(this.engineConfig?.camera?.fov, DEFAULT_FOV_DEGREES);
        const screenHeight = positive(this.quadtreeGPU?.screenHeight, DEFAULT_VIEWPORT_HEIGHT_PX);
        const lodThreshold = positive(
            this.quadtreeGPU?.lodErrorThreshold ?? this.engineConfig?.gpuQuadtree?.lodErrorThreshold,
            DEFAULT_LOD_THRESHOLD
        );

        this._faceSize = positive(
            this.quadtreeGPU?.faceSize,
            (this.planetConfig?.radius ?? 6371000.0) * 2.0
        );
        this._screenHeightPx = screenHeight;
        this._fovDegrees = fovDegrees;
        this._lodThreshold = lodThreshold;
        this._tanHalfFov = Math.tan((fovDegrees * Math.PI / 180.0) * 0.5);
        this._focalLengthPx = screenHeight / Math.max(2.0 * this._tanHalfFov, 1e-4);
        this._tileDistanceScale = positive(this.quadtreeGPU?.lodFactor, this._focalLengthPx) / lodThreshold;

        this._variantMetadataByIndex = [];
        this._variantMetadataByName = new Map();
        this._archetypeMetadataByIndex = [];
        this._archetypeMetadataByName = new Map();

        this._buildVariantMetadata();
        this._buildArchetypeMetadata();

        const summary = this.describeArchetypes()
            .map(meta => `${meta.name}:${meta.defaultRepresentationMaxDistance.toFixed(0)}m`)
            .join(', ');
        Logger.info(
            `${TAG} Initialized ` +
            `(fov=${this._fovDegrees.toFixed(1)}deg, screen=${this._screenHeightPx}px, ` +
            `tileScale=${this._tileDistanceScale.toFixed(3)} m/m${summary ? `, ${summary}` : ''})`
        );
    }

    getTileWorldSize(depth) {
        return this._faceSize / Math.max(1, 1 << depth);
    }

    getNominalTileDistance(depth) {
        return this.getTileWorldSize(depth) * this._tileDistanceScale;
    }

    getTileBudgetBytes(nominalDistance) {
        for (const row of TILE_BUDGET_TABLE) {
            if (nominalDistance <= row.maxDistance) {
                return row.bytes;
            }
        }
        return 0;
    }

    getVariantMetadataByIndex(index) {
        return this._variantMetadataByIndex[index] ?? null;
    }

    getArchetypeMetadataByIndex(index) {
        return this._archetypeMetadataByIndex[index] ?? null;
    }

    getArchetypeMetadataByName(name) {
        return this._archetypeMetadataByName.get(name) ?? null;
    }

    describeArchetypes() {
        return this._archetypeMetadataByIndex.filter(Boolean).map(meta => ({
            index: meta.index,
            name: meta.name,
            preserveRuntime: meta.preserveRuntime,
            representativeSize: meta.representativeSize,
            individualMaxDistance: meta.individualMaxDistance,
            clusterMaxDistance: meta.clusterMaxDistance,
            coverageMaxDistance: meta.coverageMaxDistance,
            defaultRepresentationMaxDistance: Math.max(
                meta.individualMaxDistance,
                meta.clusterMaxDistance,
                meta.coverageMaxDistance
            ),
        }));
    }

    planTile(tileInfo = {}) {
        const depth = tileInfo.depth ?? 0;
        const tileWorldSize = positive(tileInfo.tileWorldSize, this.getTileWorldSize(depth));
        const nominalDistance = positive(
            tileInfo.nominalDistance,
            tileWorldSize * this._tileDistanceScale
        );
        const tileArea = tileWorldSize * tileWorldSize;
        const tileBudgetBytes = this.getTileBudgetBytes(nominalDistance);

        const archetypeRepresentations = new Array(this._archetypeMetadataByIndex.length);
        const archetypeEstimatedCounts = new Array(this._archetypeMetadataByIndex.length);
        const archetypeEstimatedBytes = new Array(this._archetypeMetadataByIndex.length);
        const counts = {
            none: 0,
            coverage: 0,
            cluster: 0,
            field: 0,
            instances: 0,
            runtimeTree: 0,
        };

        let groundRepresentation = ASSET_BAKE_REPRESENTATION.NONE;
        let treeRepresentation = ASSET_BAKE_REPRESENTATION.NONE;
        let totalEstimatedBytes = 0;
        const degradableGround = [];

        for (const meta of this._archetypeMetadataByIndex) {
            if (!meta) continue;
            const representation = this.classifyArchetypeForDistance(meta, nominalDistance);
            const estimatedCount = this._estimateTileCount(meta, tileArea);
            const estimatedBytes = this.estimateRepresentationBytes(meta, representation, estimatedCount);
            archetypeRepresentations[meta.index] = representation;
            archetypeEstimatedCounts[meta.index] = estimatedCount;
            archetypeEstimatedBytes[meta.index] = estimatedBytes;
            counts[representation] = (counts[representation] ?? 0) + 1;
            totalEstimatedBytes += estimatedBytes;

            if (meta.name === 'tree_standard') {
                treeRepresentation = representation;
                continue;
            }

            if (representationPriority(representation) > representationPriority(groundRepresentation)) {
                groundRepresentation = representation;
            }

            degradableGround.push({
                meta,
                representation,
                estimatedCount,
                estimatedBytes,
            });
        }

        if (tileBudgetBytes >= 0 && totalEstimatedBytes > tileBudgetBytes) {
            this._applyBudgetFallbacks({
                tileBudgetBytes,
                archetypeRepresentations,
                archetypeEstimatedBytes,
                counts,
                degradableGround,
            });
            totalEstimatedBytes = archetypeEstimatedBytes.reduce(
                (sum, value) => sum + (Number.isFinite(value) ? value : 0),
                0
            );
            groundRepresentation = ASSET_BAKE_REPRESENTATION.NONE;
            for (const meta of this._archetypeMetadataByIndex) {
                if (!meta || meta.name === 'tree_standard') continue;
                const representation = archetypeRepresentations[meta.index];
                if (representationPriority(representation) > representationPriority(groundRepresentation)) {
                    groundRepresentation = representation;
                }
            }
        }

        return {
            face: tileInfo.face ?? 0,
            depth,
            x: tileInfo.x ?? 0,
            y: tileInfo.y ?? 0,
            layer: tileInfo.layer ?? -1,
            tileWorldSize,
            nominalDistance,
            tileBudgetBytes,
            archetypeRepresentations,
            archetypeEstimatedCounts,
            archetypeEstimatedBytes,
            treeRepresentation,
            groundRepresentation,
            skipGroundBake: groundRepresentation === ASSET_BAKE_REPRESENTATION.NONE,
            skipAllBake: (
                groundRepresentation === ASSET_BAKE_REPRESENTATION.NONE &&
                treeRepresentation === ASSET_BAKE_REPRESENTATION.NONE
            ),
            counts,
            estimatedBytes: totalEstimatedBytes,
        };
    }

    classifyArchetypeForDistance(archetypeOrMeta, nominalDistance) {
        const meta = typeof archetypeOrMeta === 'number'
            ? this.getArchetypeMetadataByIndex(archetypeOrMeta)
            : archetypeOrMeta;

        if (!meta?.isActive) {
            return ASSET_BAKE_REPRESENTATION.NONE;
        }
        if (meta.preserveRuntime && nominalDistance <= meta.individualMaxDistance) {
            return ASSET_BAKE_REPRESENTATION.RUNTIME_TREE;
        }
        if (!meta.preserveRuntime && nominalDistance <= meta.individualMaxDistance) {
            return ASSET_BAKE_REPRESENTATION.INSTANCES;
        }
        if (meta.allowField && nominalDistance <= meta.individualMaxDistance) {
            return ASSET_BAKE_REPRESENTATION.FIELD;
        }
        if (meta.allowCluster && nominalDistance <= meta.clusterMaxDistance) {
            return ASSET_BAKE_REPRESENTATION.CLUSTER;
        }
        if (meta.allowCoverage && nominalDistance <= meta.coverageMaxDistance) {
            return ASSET_BAKE_REPRESENTATION.COVERAGE;
        }
        return ASSET_BAKE_REPRESENTATION.NONE;
    }

    estimateRepresentationBytes(archetypeOrMeta, representation, estimatedCount = 0) {
        const meta = typeof archetypeOrMeta === 'number'
            ? this.getArchetypeMetadataByIndex(archetypeOrMeta)
            : archetypeOrMeta;
        if (!meta) return 0;

        switch (representation) {
            case ASSET_BAKE_REPRESENTATION.RUNTIME_TREE:
            case ASSET_BAKE_REPRESENTATION.INSTANCES:
                return Math.ceil(estimatedCount * meta.profile.packedInstanceBytes);
            case ASSET_BAKE_REPRESENTATION.FIELD:
                return meta.profile.fieldResolution * meta.profile.fieldResolution * meta.profile.fieldTexelBytes;
            case ASSET_BAKE_REPRESENTATION.CLUSTER: {
                const clusterCount = Math.ceil(
                    estimatedCount / Math.max(meta.profile.clusterReductionFactor, 1.0)
                );
                return Math.ceil(clusterCount * meta.profile.packedClusterBytes);
            }
            case ASSET_BAKE_REPRESENTATION.COVERAGE:
                return meta.profile.coverageResolution * meta.profile.coverageResolution * meta.profile.coverageTexelBytes;
            default:
                return 0;
        }
    }

    _buildVariantMetadata() {
        const variants = this.assetRegistry.getAllVariants?.() || [];
        for (const variant of variants) {
            if (!variant) continue;

            const widthMax = positive(variant.sizeRange?.width?.[1], 1.0);
            const heightMax = positive(variant.sizeRange?.height?.[1], widthMax);
            const footprint = positive(variant.footprintRadius, widthMax * 0.5) * 2.0;
            const representativeSize = Math.max(widthMax, heightMax, footprint, 0.1);
            const maxLodDistance = maxFinite(variant.lodDistances, 0.0);

            const metadata = {
                index: variant.index,
                name: variant.name,
                archetypeIndex: variant.archetype?.index ?? -1,
                archetypeName: variant.archetypeName,
                widthMax,
                heightMax,
                footprint,
                representativeSize,
                maxLodDistance,
            };

            this._variantMetadataByIndex[variant.index] = metadata;
            this._variantMetadataByName.set(variant.name, metadata);
        }
    }

    _buildArchetypeMetadata() {
        const archetypes = this.assetRegistry.getAllArchetypes?.() || [];
        for (const archetype of archetypes) {
            if (!archetype) continue;

            const profile = mergeProfile(DEFAULT_PROFILE, ARCHETYPE_PROFILE_OVERRIDES[archetype.name]);
            const variants = (this.assetRegistry.getAllVariants?.() || [])
                .filter(variant => variant?.archetype?.index === archetype.index);
            const variantMeta = variants
                .map(variant => this.getVariantMetadataByIndex(variant.index))
                .filter(Boolean);

            const representativeSize = Math.max(
                0.1,
                maxFinite(variantMeta.map(meta => meta.representativeSize), 0.1)
            );
            const maxLodDistance = maxFinite(variantMeta.map(meta => meta.maxLodDistance), 0.0);
            const densityUpperBoundPerM2 = Math.max(
                0.0,
                maxFinite(variants.map(variant => maxFinite(variant?.densities, 0.0)), 0.0)
            );

            const autoIndividualDistance = this._distanceForProjectedPixels(
                representativeSize,
                profile.individualPixelThreshold
            );
            const autoClusterDistance = profile.allowCluster
                ? this._distanceForProjectedPixels(representativeSize, profile.clusterPixelThreshold)
                : 0.0;
            const autoCoverageDistance = profile.allowCoverage
                ? this._distanceForProjectedPixels(representativeSize, profile.coveragePixelThreshold)
                : 0.0;

            const individualMaxDistance = positive(
                profile.fixedIndividualDistance,
                Math.max(maxLodDistance, autoIndividualDistance, profile.minIndividualDistance)
            );
            const clusterMaxDistance = profile.allowCluster
                ? positive(
                    profile.fixedClusterDistance,
                    Math.max(individualMaxDistance, autoClusterDistance, profile.minClusterDistance)
                )
                : 0.0;
            const coverageMaxDistance = profile.allowCoverage
                ? positive(
                    profile.fixedCoverageDistance,
                    Math.max(clusterMaxDistance, autoCoverageDistance, profile.minCoverageDistance)
                )
                : 0.0;

            const metadata = {
                index: archetype.index,
                name: archetype.name,
                isActive: archetype.isActive,
                preserveRuntime: profile.preserveRuntime === true,
                allowField: profile.allowField === true,
                allowCluster: profile.allowCluster === true,
                allowCoverage: profile.allowCoverage === true,
                representativeSize,
                maxLodDistance,
                densityUpperBoundPerM2,
                individualMaxDistance,
                clusterMaxDistance,
                coverageMaxDistance,
                profile,
            };

            this._archetypeMetadataByIndex[archetype.index] = metadata;
            this._archetypeMetadataByName.set(archetype.name, metadata);
        }
    }

    _distanceForProjectedPixels(worldSize, pixelThreshold) {
        const size = positive(worldSize, 0.1);
        const px = positive(pixelThreshold, 1.0);
        return (size * this._focalLengthPx) / px;
    }

    _estimateTileCount(meta, tileArea) {
        return Math.ceil(
            tileArea *
            Math.max(meta.densityUpperBoundPerM2, 0.0) *
            Math.max(meta.profile.densitySafetyFactor, 0.0)
        );
    }

    _applyBudgetFallbacks(options) {
        const {
            tileBudgetBytes,
            archetypeRepresentations,
            archetypeEstimatedBytes,
            counts,
            degradableGround,
        } = options;

        let totalEstimatedBytes = archetypeEstimatedBytes.reduce(
            (sum, value) => sum + (Number.isFinite(value) ? value : 0),
            0
        );
        if (totalEstimatedBytes <= tileBudgetBytes) return;

        const sorted = [...degradableGround].sort((a, b) => {
            const scoreA = this._preservationScore(a.meta);
            const scoreB = this._preservationScore(b.meta);
            if (scoreA !== scoreB) return scoreA - scoreB;
            return b.estimatedBytes - a.estimatedBytes;
        });

        while (totalEstimatedBytes > tileBudgetBytes) {
            let changed = false;
            for (const entry of sorted) {
                if (totalEstimatedBytes <= tileBudgetBytes) {
                    break;
                }
                const next = this._getFallbackRepresentation(entry.meta, archetypeRepresentations[entry.meta.index]);
                if (next === archetypeRepresentations[entry.meta.index]) continue;

                const prev = archetypeRepresentations[entry.meta.index];
                const nextBytes = this.estimateRepresentationBytes(entry.meta, next, entry.estimatedCount);
                totalEstimatedBytes += nextBytes - archetypeEstimatedBytes[entry.meta.index];
                archetypeEstimatedBytes[entry.meta.index] = nextBytes;
                archetypeRepresentations[entry.meta.index] = next;
                counts[prev] = Math.max(0, (counts[prev] ?? 0) - 1);
                counts[next] = (counts[next] ?? 0) + 1;
                changed = true;
            }
            if (!changed) break;
        }
    }

    _preservationScore(meta) {
        if (meta.preserveRuntime) return Number.MAX_SAFE_INTEGER;
        return meta.representativeSize * 1000.0 + meta.maxLodDistance;
    }

    _getFallbackRepresentation(meta, current) {
        const chain = [];
        if (meta.preserveRuntime) {
            chain.push(ASSET_BAKE_REPRESENTATION.RUNTIME_TREE);
        } else {
            chain.push(ASSET_BAKE_REPRESENTATION.INSTANCES);
        }
        if (meta.allowField) chain.push(ASSET_BAKE_REPRESENTATION.FIELD);
        if (meta.allowCluster) chain.push(ASSET_BAKE_REPRESENTATION.CLUSTER);
        if (meta.allowCoverage) chain.push(ASSET_BAKE_REPRESENTATION.COVERAGE);
        chain.push(ASSET_BAKE_REPRESENTATION.NONE);

        const idx = chain.indexOf(current);
        if (idx < 0 || idx === chain.length - 1) {
            return current;
        }
        return chain[idx + 1];
    }
}
