// core/renderer/particles/LeafAnchorEmitterSource.js
//
// Low-cadence bridge from detailed tree anchors to CPU particle emitters.
// This intentionally reads a small prefix of TreeDetailSystem's close-tree
// buffer asynchronously and reuses CPU-side TreeTemplate anchors; no per-frame
// readback or GPU synchronization is required.

import { Logger } from '../../../shared/Logger.js';

const CLOSE_TREE_BYTES = 128;
const CLOSE_TREE_WORDS = CLOSE_TREE_BYTES / 4;
const TREE_READBACK_OFFSET = 256;
const ASSET_INSTANCE_BYTES = 64;
const ASSET_INSTANCE_WORDS = ASSET_INSTANCE_BYTES / 4;

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
    const n = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, n));
}

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Math.trunc(clampNumber(value, fallback, min, max));
}

function normalizeVec3(v, fallback = [0, 1, 0]) {
    const x = Number.isFinite(v?.[0]) ? v[0] : fallback[0];
    const y = Number.isFinite(v?.[1]) ? v[1] : fallback[1];
    const z = Number.isFinite(v?.[2]) ? v[2] : fallback[2];
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) return fallback.slice();
    return [x / len, y / len, z / len];
}

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function pcg(value) {
    let state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
    const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
    return ((word >>> 22) ^ word) >>> 0;
}

function pcg2(a, b) {
    return pcg((a >>> 0) ^ ((Math.imul(b >>> 0, 1664525) + 1013904223) >>> 0));
}

function pcg3(a, b, c) {
    return pcg(pcg2(a >>> 0, b >>> 0) ^ Math.imul(c >>> 0, 2654435761));
}

function hash01(seed) {
    return pcg(seed >>> 0) / 4294967296;
}

function bitcastLikeU32(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.floor(value * 4096) >>> 0;
}

function treeTypeForSpecies(speciesIndex) {
    switch (speciesIndex >>> 0) {
        case 4:
            return 'oak';
        case 6:
            return 'palm';
        case 7:
            return 'eucalyptus';
        default:
            return 'birch';
    }
}

function normalizeConfig(raw = {}) {
    const interval = Array.isArray(raw.spawnIntervalSeconds)
        ? raw.spawnIntervalSeconds
        : [raw.spawnIntervalMinSeconds, raw.spawnIntervalMaxSeconds];
    const minInterval = clampNumber(interval?.[0], 1.0, 0.05, 60.0);
    const maxInterval = clampNumber(interval?.[1], 4.0, 0.05, 60.0);

    return {
        probability: clampNumber(raw.probability, 0.08, 0, 1),
        maxAnchorsPerTree: clampInt(raw.maxAnchorsPerTree, 1, 0, 64),
        maxEmitters: clampInt(raw.maxEmitters, 3, 0, 12),
        maxReadTrees: clampInt(raw.maxReadTrees, 48, 1, 512),
        refreshIntervalSeconds: clampNumber(raw.refreshIntervalSeconds, 1.0, 0.1, 30.0),
        spawnIntervalSeconds: [Math.min(minInterval, maxInterval), Math.max(minInterval, maxInterval)],
        spawnBudgetPerEvent: clampInt(raw.spawnBudgetPerEvent, 1, 1, 16),
        distanceCutoff: clampNumber(raw.distanceCutoff, 65.0, 1.0, 500.0),
        lodNearDistance: clampNumber(raw.lodNearDistance, 16.0, 0.0, 500.0),
        lodFarDistance: clampNumber(raw.lodFarDistance, 50.0, 0.0, 500.0),
        lodMinScale: clampNumber(raw.lodMinScale, 1.0, 0.0, 1.0),
    };
}

export class LeafAnchorEmitterSource {
    constructor(device, options = {}) {
        this.device = device;
        this.treeDetailSystem = options.treeDetailSystem ?? null;
        this.templateLibrary = options.templateLibrary ?? null;
        this.config = normalizeConfig(options.config ?? {});
        this.planetOrigin = {
            x: options.planetOrigin?.x ?? 0,
            y: options.planetOrigin?.y ?? 0,
            z: options.planetOrigin?.z ?? 0,
        };

        this._readbackBuffer = null;
        this._readbackBytes = 0;
        this._queued = false;
        this._pending = false;
        this._lastCapacity = 0;
        this._lastPoolCopies = [];
        this._nextQueueTime = 0;
        this._candidates = [];
        this._revision = 0;
        this._warnedMissingSource = false;
        this._lastStats = {
            sampledTrees: 0,
            candidates: 0,
            fallbackCandidates: 0,
            missingTemplateCount: 0,
            missingAnchorCount: 0,
            source: 'close_trees',
            poolTrees: 0,
        };
    }

    get candidates() { return this._candidates; }
    get revision() { return this._revision; }
    get lastStats() { return { ...this._lastStats }; }

    setPlanetOrigin(origin) {
        this.planetOrigin = {
            x: origin?.x ?? 0,
            y: origin?.y ?? 0,
            z: origin?.z ?? 0,
        };
    }

    updateSource(options = {}) {
        if ('treeDetailSystem' in options) this.treeDetailSystem = options.treeDetailSystem ?? null;
        if ('templateLibrary' in options) this.templateLibrary = options.templateLibrary ?? null;
        if ('config' in options) this.config = normalizeConfig(options.config ?? {});
    }

    update(commandEncoder, elapsedTime, camera = null) {
        this._cameraPosition = camera?.position
            ? { x: camera.position.x ?? 0, y: camera.position.y ?? 0, z: camera.position.z ?? 0 }
            : null;
        this._kickReadback();
        this._queueReadback(commandEncoder, elapsedTime);
    }

    _ensureReadbackBuffer(byteLength) {
        const size = Math.max(256, TREE_READBACK_OFFSET + byteLength);
        if (this._readbackBuffer && this._readbackBytes >= size) return;
        this._readbackBuffer?.destroy?.();
        this._readbackBuffer = this.device.createBuffer({
            label: 'ParticleLeafAnchorReadback',
            size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this._readbackBytes = size;
    }

    _queueReadback(commandEncoder, elapsedTime) {
        if (!commandEncoder || this._queued || this._pending) return;
        if (elapsedTime < this._nextQueueTime) return;
        if (!this.treeDetailSystem?.isReady?.() || !this.templateLibrary?.templateCount) {
            if (!this._warnedMissingSource) {
                Logger.warn('[ParticleSystem] Leaf anchor source waiting for TreeDetailSystem/template library');
                this._warnedMissingSource = true;
            }
            this._nextQueueTime = elapsedTime + this.config.refreshIntervalSeconds;
            return;
        }

        const closeTreeBuffer = this.treeDetailSystem.getCloseTreeBuffer?.();
        const closeTreeCountBuffer = this.treeDetailSystem.getCloseTreeCountBuffer?.();
        if (!closeTreeBuffer || !closeTreeCountBuffer) return;

        const maxCloseTrees = Math.max(1, this.treeDetailSystem.maxCloseTrees ?? this.config.maxReadTrees);
        const capacity = Math.min(this.config.maxReadTrees, maxCloseTrees);
        const treeBytes = capacity * CLOSE_TREE_BYTES;

        const sourceBands = this.treeDetailSystem?._sourceBands ?? [];
        const pool = this.treeDetailSystem?.streamer?._pool ?? null;
        const poolCopies = [];
        let poolInstanceBytes = 0;
        let poolIndirectBytes = 0;
        if (pool?.instanceBuffer && pool?.indirectBuffer && sourceBands.length > 0) {
            let remaining = this.config.maxReadTrees;
            for (const bandInfo of sourceBands) {
                if (remaining <= 0) break;
                const band = bandInfo.band >>> 0;
                const capacityForBand = Math.max(0, bandInfo.capacity >>> 0);
                const slots = Math.min(remaining, capacityForBand);
                if (slots <= 0) continue;
                poolCopies.push({
                    band,
                    base: bandInfo.base >>> 0,
                    slots,
                    instanceOffset: 0,
                    indirectOffset: 0,
                });
                remaining -= slots;
                poolInstanceBytes += slots * ASSET_INSTANCE_BYTES;
                poolIndirectBytes += 5 * 4;
            }
        }

        const poolIndirectOffset = TREE_READBACK_OFFSET + treeBytes;
        const poolInstanceOffset = poolIndirectOffset + poolIndirectBytes;
        this._ensureReadbackBuffer(treeBytes + poolIndirectBytes + poolInstanceBytes);
        if (!this._readbackBuffer) return;

        commandEncoder.copyBufferToBuffer(closeTreeCountBuffer, 0, this._readbackBuffer, 0, 4);
        commandEncoder.copyBufferToBuffer(closeTreeBuffer, 0, this._readbackBuffer, TREE_READBACK_OFFSET, treeBytes);
        let indirectCursor = poolIndirectOffset;
        let instanceCursor = poolInstanceOffset;
        for (const copy of poolCopies) {
            copy.indirectOffset = indirectCursor;
            copy.instanceOffset = instanceCursor;
            commandEncoder.copyBufferToBuffer(
                pool.indirectBuffer,
                copy.band * 5 * 4,
                this._readbackBuffer,
                indirectCursor,
                5 * 4
            );
            commandEncoder.copyBufferToBuffer(
                pool.instanceBuffer,
                copy.base * ASSET_INSTANCE_BYTES,
                this._readbackBuffer,
                instanceCursor,
                copy.slots * ASSET_INSTANCE_BYTES
            );
            indirectCursor += 5 * 4;
            instanceCursor += copy.slots * ASSET_INSTANCE_BYTES;
        }
        this._lastCapacity = capacity;
        this._lastPoolCopies = poolCopies;
        this._queued = true;
        this._nextQueueTime = elapsedTime + this.config.refreshIntervalSeconds;
    }

    _kickReadback() {
        if (!this._queued || this._pending || !this._readbackBuffer) return;
        this._pending = true;
        this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const mapped = this._readbackBuffer.getMappedRange(0, this._readbackBytes);
            const copy = mapped.slice(0);
            this._readbackBuffer.unmap();
            this._consumeReadback(copy);
            this._queued = false;
            this._pending = false;
        }).catch((err) => {
            Logger.warn(`[ParticleSystem] Leaf anchor readback failed: ${err?.message || err}`);
            try { this._readbackBuffer?.unmap(); } catch (_) {}
            this._queued = false;
            this._pending = false;
        });
    }

    _consumeReadback(arrayBuffer) {
        const u32 = new Uint32Array(arrayBuffer);
        const f32 = new Float32Array(arrayBuffer);
        const count = Math.min(u32[0] >>> 0, this._lastCapacity);
        const trees = [];
        const treeBase = TREE_READBACK_OFFSET / 4;

        for (let i = 0; i < count; i++) {
            const base = treeBase + i * CLOSE_TREE_WORDS;
            const x = f32[base + 0];
            const y = f32[base + 1];
            const z = f32[base + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const speciesIndex = u32[base + 8] >>> 0;
            if (speciesIndex === 9) continue; // cactus has no falling leaves.
            const health = clampNumber(f32[base + 25], 1.0, 0.0, 1.0);
            if (health <= 0.05) continue;

            trees.push({
                x, y, z,
                rotation: f32[base + 3],
                scaleX: f32[base + 4],
                scaleY: f32[base + 5],
                scaleZ: f32[base + 6],
                distance: f32[base + 7],
                speciesIndex,
                variantSeed: u32[base + 9] >>> 0,
                detailLevel: u32[base + 10] >>> 0,
                foliage: [f32[base + 12], f32[base + 13], f32[base + 14]],
                health,
            });
        }

        let source = 'close_trees';
        let poolTrees = 0;
        const poolSample = this._consumePoolTrees(arrayBuffer);
        poolTrees = poolSample.length;
        if (poolSample.length > 0) {
            trees.length = 0;
            trees.push(...poolSample);
            source = 'pool_instances';
        }

        trees.sort((a, b) => a.distance - b.distance);
        const candidates = this._buildCandidates(trees);
        this._lastStats.source = source;
        this._lastStats.poolTrees = poolTrees;
        this._candidates = candidates;
        this._revision++;
        if (this._revision <= 2 || (this._revision % 20) === 0) {
            Logger.info(
                `[ParticleSystem] Leaf anchors sampled trees=${trees.length}/${count} ` +
                `emitters=${candidates.length}/${this.config.maxEmitters} ` +
                `fallback=${this._lastStats.fallbackCandidates} source=${source}`
            );
        }
    }

    _consumePoolTrees(arrayBuffer) {
        if (!this._lastPoolCopies.length) return [];
        const u32 = new Uint32Array(arrayBuffer);
        const f32 = new Float32Array(arrayBuffer);
        const camera = this._cameraPosition;
        const out = [];

        for (const copy of this._lastPoolCopies) {
            const indirectWords = copy.indirectOffset / 4;
            const liveCount = Math.min(u32[indirectWords + 1] >>> 0, copy.slots);
            const instanceWords = copy.instanceOffset / 4;
            for (let i = 0; i < liveCount; i++) {
                const base = instanceWords + i * ASSET_INSTANCE_WORDS;
                const x = f32[base + 0];
                const y = f32[base + 1];
                const z = f32[base + 2];
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.001) continue;

                let distance = 0;
                if (camera) {
                    const dx = camera.x - x;
                    const dy = camera.y - y;
                    const dz = camera.z - z;
                    distance = Math.hypot(dx, dy, dz);
                    if (distance > this.config.distanceCutoff) continue;
                }

                const tileTypeId = u32[base + 6] >>> 0;
                out.push({
                    x, y, z,
                    rotation: f32[base + 3],
                    scaleX: Math.max(0.1, f32[base + 4]),
                    scaleY: Math.max(0.1, f32[base + 5]),
                    scaleZ: Math.max(0.1, f32[base + 4]),
                    distance,
                    speciesIndex: 2,
                    variantSeed: pcg3(bitcastLikeU32(x), bitcastLikeU32(y), bitcastLikeU32(z) ^ tileTypeId),
                    detailLevel: 0,
                    foliage: [0.44, 0.70, 0.22],
                    health: 1.0,
                });
            }
        }

        return out;
    }

    _buildCandidates(trees) {
        const out = [];
        const maxEmitters = this.config.maxEmitters;
        if (maxEmitters <= 0 || this.config.maxAnchorsPerTree <= 0) return out;
        let fallbackCandidates = 0;
        let missingTemplateCount = 0;
        let missingAnchorCount = 0;

        for (const tree of trees) {
            if (out.length >= maxEmitters) break;
            const gateSeed = pcg3(tree.variantSeed, tree.detailLevel, 0x1EAFC0DE);
            if (this.config.probability < 1 && hash01(gateSeed) >= this.config.probability) {
                continue;
            }
            const template = this._selectTemplate(tree);
            let anchors = [];
            if (!template) {
                missingTemplateCount++;
            } else {
                anchors = this._selectAnchorSet(template);
                if (anchors.length === 0) missingAnchorCount++;
            }

            const perTree = Math.min(
                this.config.maxAnchorsPerTree,
                Math.max(1, anchors.length),
                maxEmitters - out.length
            );
            for (let a = 0; a < perTree; a++) {
                const anchorSeed = pcg3(tree.variantSeed, this._revision + a, 0xA11CE500);
                const anchor = anchors.length > 0 ? anchors[anchorSeed % anchors.length] : null;
                const position = anchor
                    ? this._transformAnchor(tree, anchor)
                    : this._fallbackCanopyPosition(tree, anchorSeed);
                if (!position) continue;
                if (!anchor) fallbackCandidates++;
                out.push({
                    position,
                    seed: pcg3(tree.variantSeed, tree.detailLevel, 0x51F7A11),
                    foliageColor: tree.foliage.slice(),
                    spawnBudgetPerEvent: this.config.spawnBudgetPerEvent,
                });
            }
        }

        this._lastStats = {
            sampledTrees: trees.length,
            candidates: out.length,
            fallbackCandidates,
            missingTemplateCount,
            missingAnchorCount,
            source: this._lastStats.source,
            poolTrees: this._lastStats.poolTrees,
        };
        return out;
    }

    _selectTemplate(tree) {
        const primaryType = treeTypeForSpecies(tree.speciesIndex);
        let variants = this.templateLibrary?.getVariants?.(primaryType) ?? [];
        if (variants.length === 0 && primaryType !== 'birch') {
            variants = this.templateLibrary?.getVariants?.('birch') ?? [];
        }
        if (variants.length === 0) return null;
        const variantLocal = pcg(tree.variantSeed) % variants.length;
        return variants[variantLocal] ?? variants[0] ?? null;
    }

    _selectAnchorSet(template) {
        const fine = template.getAnchorsForLOD?.(0) ?? [];
        if (fine.length > 0) return fine;
        return Array.isArray(template.anchors) ? template.anchors : [];
    }

    _transformAnchor(tree, anchor) {
        const pos = Array.isArray(anchor?.position) ? anchor.position : null;
        if (!pos) return null;

        const treePos = [tree.x, tree.y, tree.z];
        const sphereDir = normalizeVec3([
            tree.x - this.planetOrigin.x,
            tree.y - this.planetOrigin.y,
            tree.z - this.planetOrigin.z,
        ]);
        const referenceAxis = Math.abs(sphereDir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
        const tangent = normalizeVec3(cross(sphereDir, referenceAxis), [1, 0, 0]);
        const bitangent = normalizeVec3(cross(sphereDir, tangent), [0, 0, 1]);
        const cosR = Math.cos(tree.rotation);
        const sinR = Math.sin(tree.rotation);
        const rotTangent = [
            tangent[0] * cosR + bitangent[0] * sinR,
            tangent[1] * cosR + bitangent[1] * sinR,
            tangent[2] * cosR + bitangent[2] * sinR,
        ];
        const rotBitangent = [
            -tangent[0] * sinR + bitangent[0] * cosR,
            -tangent[1] * sinR + bitangent[1] * cosR,
            -tangent[2] * sinR + bitangent[2] * cosR,
        ];
        const lx = (Number.isFinite(pos[0]) ? pos[0] : 0) * tree.scaleX;
        const ly = (Number.isFinite(pos[1]) ? pos[1] : 0) * tree.scaleY;
        const lz = (Number.isFinite(pos[2]) ? pos[2] : 0) * tree.scaleZ;

        return {
            x: treePos[0] + rotTangent[0] * lx + sphereDir[0] * ly + rotBitangent[0] * lz,
            y: treePos[1] + rotTangent[1] * lx + sphereDir[1] * ly + rotBitangent[1] * lz,
            z: treePos[2] + rotTangent[2] * lx + sphereDir[2] * ly + rotBitangent[2] * lz,
        };
    }

    _fallbackCanopyPosition(tree, seed) {
        const treePos = [tree.x, tree.y, tree.z];
        const sphereDir = normalizeVec3([
            tree.x - this.planetOrigin.x,
            tree.y - this.planetOrigin.y,
            tree.z - this.planetOrigin.z,
        ]);
        const referenceAxis = Math.abs(sphereDir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
        const tangent = normalizeVec3(cross(sphereDir, referenceAxis), [1, 0, 0]);
        const bitangent = normalizeVec3(cross(sphereDir, tangent), [0, 0, 1]);
        const cosR = Math.cos(tree.rotation);
        const sinR = Math.sin(tree.rotation);
        const rotTangent = [
            tangent[0] * cosR + bitangent[0] * sinR,
            tangent[1] * cosR + bitangent[1] * sinR,
            tangent[2] * cosR + bitangent[2] * sinR,
        ];
        const rotBitangent = [
            -tangent[0] * sinR + bitangent[0] * cosR,
            -tangent[1] * sinR + bitangent[1] * cosR,
            -tangent[2] * sinR + bitangent[2] * cosR,
        ];

        const angle = hash01(seed) * Math.PI * 2;
        const radius = Math.max(0.2, tree.scaleX * (0.16 + hash01(seed ^ 0xB16B00B5) * 0.22));
        const height = Math.max(0.8, tree.scaleY * (0.55 + hash01(seed ^ 0xC0FFEE) * 0.28));
        const lateralX = Math.cos(angle) * radius;
        const lateralZ = Math.sin(angle) * radius;

        return {
            x: treePos[0] + rotTangent[0] * lateralX + sphereDir[0] * height + rotBitangent[0] * lateralZ,
            y: treePos[1] + rotTangent[1] * lateralX + sphereDir[1] * height + rotBitangent[1] * lateralZ,
            z: treePos[2] + rotTangent[2] * lateralX + sphereDir[2] * height + rotBitangent[2] * lateralZ,
        };
    }

    dispose() {
        this._readbackBuffer?.destroy?.();
        this._readbackBuffer = null;
        this._queued = false;
        this._pending = false;
        this._candidates = [];
    }
}
