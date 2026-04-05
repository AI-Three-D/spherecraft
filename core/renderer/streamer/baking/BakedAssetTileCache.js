import { Logger } from '../../../../shared/Logger.js';
import { TileAddress } from '../../../world/quadtree/tileAddress.js';

const TAG = '[BakedAssetTileCache]';

function sameRepresentationArray(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class BakedAssetTileCache {
    constructor(policy) {
        if (!policy) {
            throw new Error(`${TAG} policy is required`);
        }

        this.policy = policy;
        this._entriesByLayer = new Map();
        this._summaryDirty = true;
        this._cachedSummary = null;
    }

    get size() {
        return this._entriesByLayer.size;
    }

    getLayerEntry(layer) {
        return this._entriesByLayer.get(layer) ?? null;
    }

    getEntries() {
        return [...this._entriesByLayer.values()];
    }

    applyCommitBatch(commits) {
        if (!Array.isArray(commits) || commits.length === 0) {
            return;
        }

        for (const commit of commits) {
            if (!commit) continue;
            this._upsertTile(new TileAddress(
                commit.face,
                commit.depth,
                commit.x,
                commit.y
            ), commit.layer);
        }
    }

    syncFromTileStreamer(tileStreamer) {
        const tileInfo = tileStreamer?._tileInfo;
        if (!tileInfo || typeof tileInfo.entries !== 'function') {
            return;
        }

        const seenLayers = new Set();
        for (const [key, info] of tileInfo.entries()) {
            if (!info) continue;
            const addr = TileAddress.fromString(key);
            seenLayers.add(info.layer);
            this._upsertTile(addr, info.layer);
        }

        for (const layer of [...this._entriesByLayer.keys()]) {
            if (!seenLayers.has(layer)) {
                this._entriesByLayer.delete(layer);
                this._summaryDirty = true;
            }
        }
    }

    getSummary() {
        if (!this._summaryDirty && this._cachedSummary) {
            return this._cachedSummary;
        }

        const summary = {
            totalLayers: this._entriesByLayer.size,
            ground: { none: 0, coverage: 0, cluster: 0, field: 0, instances: 0, runtimeTree: 0 },
            trees: { none: 0, coverage: 0, cluster: 0, field: 0, instances: 0, runtimeTree: 0 },
            maxTileWorldSize: 0.0,
            maxNominalDistance: 0.0,
            totalEstimatedBytes: 0,
            totalBudgetBytes: 0,
        };

        for (const entry of this._entriesByLayer.values()) {
            summary.maxTileWorldSize = Math.max(summary.maxTileWorldSize, entry.tileWorldSize);
            summary.maxNominalDistance = Math.max(summary.maxNominalDistance, entry.nominalDistance);
            summary.totalEstimatedBytes += entry.estimatedBytes ?? 0;
            summary.totalBudgetBytes += entry.tileBudgetBytes ?? 0;
            summary.ground[entry.groundRepresentation] = (summary.ground[entry.groundRepresentation] ?? 0) + 1;
            summary.trees[entry.treeRepresentation] = (summary.trees[entry.treeRepresentation] ?? 0) + 1;
        }

        this._cachedSummary = summary;
        this._summaryDirty = false;
        return summary;
    }

    logSummary(prefix = TAG) {
        const summary = this.getSummary();
        Logger.info(
            `${prefix} layers=${summary.totalLayers} ` +
            `ground(inst=${summary.ground.instances}, field=${summary.ground.field}, cluster=${summary.ground.cluster}, ` +
            `coverage=${summary.ground.coverage}, none=${summary.ground.none}) ` +
            `trees(runtime=${summary.trees.runtimeTree}, cluster=${summary.trees.cluster}, ` +
            `coverage=${summary.trees.coverage}, none=${summary.trees.none}) ` +
            `bytes=${Math.round(summary.totalEstimatedBytes / 1024)}KB/` +
            `${Math.round(summary.totalBudgetBytes / 1024)}KB`
        );
    }

    _upsertTile(tileAddress, layer) {
        const plan = this.policy.planTile({
            face: tileAddress.face,
            depth: tileAddress.depth,
            x: tileAddress.x,
            y: tileAddress.y,
            layer,
        });

        const entry = {
            key: tileAddress.toString(),
            layer,
            face: tileAddress.face,
            depth: tileAddress.depth,
            x: tileAddress.x,
            y: tileAddress.y,
            tileWorldSize: plan.tileWorldSize,
            nominalDistance: plan.nominalDistance,
            groundRepresentation: plan.groundRepresentation,
            treeRepresentation: plan.treeRepresentation,
            archetypeRepresentations: plan.archetypeRepresentations,
            archetypeEstimatedCounts: plan.archetypeEstimatedCounts,
            archetypeEstimatedBytes: plan.archetypeEstimatedBytes,
            skipGroundBake: plan.skipGroundBake,
            skipAllBake: plan.skipAllBake,
            counts: plan.counts,
            estimatedBytes: plan.estimatedBytes,
            tileBudgetBytes: plan.tileBudgetBytes,
        };

        const prev = this._entriesByLayer.get(layer);
        if (
            prev &&
            prev.key === entry.key &&
            prev.groundRepresentation === entry.groundRepresentation &&
            prev.treeRepresentation === entry.treeRepresentation &&
            sameRepresentationArray(prev.archetypeRepresentations, entry.archetypeRepresentations)
        ) {
            return;
        }

        this._entriesByLayer.set(layer, entry);
        this._summaryDirty = true;
    }
}
