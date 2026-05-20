import {
    ATMO_BANK_TYPES,
    ATMO_BANK_ALL_TYPE_MASK,
    ATMO_EMITTER_CAPACITY,
} from './AtmoBankTypes.js';
import { DEFAULT_ATMO_PLACEMENT_CONFIG } from './AtmoBankAuthoringRuntime.js';

export class AtmoBankPlacement {
    constructor(config = {}, options = {}) {
        this._maxRenderDist     = config.maxRenderDist        ?? DEFAULT_ATMO_PLACEMENT_CONFIG.maxRenderDist;
        this._lodNear           = config.lodNearDistance      ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodNearDistance;
        this._lodFar            = config.lodFarDistance       ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodFarDistance;
        this._lodMinScale       = config.lodMinScale          ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodMinScale;
        this._distCutoff        = config.distanceCutoff       ?? DEFAULT_ATMO_PLACEMENT_CONFIG.distanceCutoff;

        this._clusterCellSize   = config.clusterCellSize      ?? DEFAULT_ATMO_PLACEMENT_CONFIG.clusterCellSize;
        this._clusterScanRadius = config.clusterScanRadius    ?? DEFAULT_ATMO_PLACEMENT_CONFIG.clusterScanRadius;
        this._clusterProb       = config.clusterProbability   ?? DEFAULT_ATMO_PLACEMENT_CONFIG.clusterProbability;
        this._clusterSizeMin    = config.clusterSizeMin       ?? DEFAULT_ATMO_PLACEMENT_CONFIG.clusterSizeMin;
        this._clusterSizeMax    = config.clusterSizeMax       ?? DEFAULT_ATMO_PLACEMENT_CONFIG.clusterSizeMax;
        this._emitterSpacing    = config.emitterSpacing       ?? DEFAULT_ATMO_PLACEMENT_CONFIG.emitterSpacing;
        this._shapeWarp         = config.shapeWarp            ?? DEFAULT_ATMO_PLACEMENT_CONFIG.shapeWarp;
        this._maxPerCluster     = config.maxEmittersPerCluster ?? DEFAULT_ATMO_PLACEMENT_CONFIG.maxEmittersPerCluster;

        this._enabledTypeMask = Number.isInteger(options.enabledTypeMask)
            ? options.enabledTypeMask
            : ATMO_BANK_ALL_TYPE_MASK;
        this._emitters = [];
        this._frame = null;
    }

    setEnabledTypeMask(mask = ATMO_BANK_ALL_TYPE_MASK) {
        this._enabledTypeMask = Number.isInteger(mask) ? mask : ATMO_BANK_ALL_TYPE_MASK;
        this._emitters.length = 0;
    }

    _typeEnabled(typeId) {
        if (!Number.isInteger(typeId) || typeId < 0 || typeId >= 32) return false;
        return (this._enabledTypeMask & (1 << typeId)) !== 0;
    }

    update(camera, environmentState, planetConfig) {
        this._emitters.length = 0;
        if ((this._enabledTypeMask & ATMO_BANK_ALL_TYPE_MASK) === 0) return;
        if (!planetConfig?.origin || !planetConfig?.radius) return;

        const origin = planetConfig.origin;
        const cam = camera.position;

        const dx = cam.x - origin.x;
        const dy = cam.y - origin.y;
        const dz = cam.z - origin.z;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distFromCenter < 1) return;

        const upX = dx / distFromCenter;
        const upY = dy / distFromCenter;
        const upZ = dz / distFromCenter;

        let rx = 0, ry = 1, rz = 0;
        if (Math.abs(upY) > 0.9) { rx = 1; ry = 0; }
        let tx = upY * rz - upZ * ry;
        let ty = upZ * rx - upX * rz;
        let tz = upX * ry - upY * rx;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        tx /= tl; ty /= tl; tz /= tl;
        const bx = upY * tz - upZ * ty;
        const by = upZ * tx - upX * tz;
        const bz = upX * ty - upY * tx;

        const camT = (cam.x - origin.x) * tx + (cam.y - origin.y) * ty + (cam.z - origin.z) * tz;
        const camB = (cam.x - origin.x) * bx + (cam.y - origin.y) * by + (cam.z - origin.z) * bz;

        const weatherMod = Math.max(0.2, (environmentState?.fogDensity ?? 0.3) +
            (environmentState?.weatherIntensity ?? 0.3) * 0.5);

        this._frame = {
            ox: origin.x, oy: origin.y, oz: origin.z,
            ux: upX, uy: upY, uz: upZ,
            tx, ty, tz,
            bx, by, bz,
            dist: distFromCenter,
            cx: cam.x, cy: cam.y, cz: cam.z,
        };

        const cellT0 = Math.floor(camT / this._clusterCellSize);
        const cellB0 = Math.floor(camB / this._clusterCellSize);
        const half = Math.floor(this._clusterScanRadius / 2);

        for (let ct = cellT0 - half; ct <= cellT0 + half; ct++) {
            for (let cb = cellB0 - half; cb <= cellB0 + half; cb++) {
                if (this._emitters.length >= ATMO_EMITTER_CAPACITY) break;
                const h = this._cellHash(ct, cb, 0xA3C6B1D7);
                if ((h & 0xFFFF) / 65536.0 > this._clusterProb * weatherMod) continue;
                this._buildCluster(ct, cb, h);
            }
        }

        this._frame = null;
    }

    _buildCluster(ct, cb, clusterHash) {
        const f = this._frame;

        // Cluster center: jittered within the coarse cell
        const jT = ((clusterHash >> 8 & 0xFF) / 255.0 - 0.5) * this._clusterCellSize * 0.85;
        const jB = ((clusterHash >> 16 & 0xFF) / 255.0 - 0.5) * this._clusterCellSize * 0.85;
        const centerT = (ct + 0.5) * this._clusterCellSize + jT;
        const centerB = (cb + 0.5) * this._clusterCellSize + jB;

        // Project cluster center to sphere surface to check distance cutoff
        const cwx = f.ox + f.ux * f.dist + f.tx * centerT + f.bx * centerB;
        const cwy = f.oy + f.uy * f.dist + f.ty * centerT + f.by * centerB;
        const cwz = f.oz + f.uz * f.dist + f.tz * centerT + f.bz * centerB;
        const ceDist = Math.sqrt((cwx - f.ox) ** 2 + (cwy - f.oy) ** 2 + (cwz - f.oz) ** 2);
        const cnx = (cwx - f.ox) / ceDist;
        const cny = (cwy - f.oy) / ceDist;
        const cnz = (cwz - f.oz) / ceDist;
        const csx = f.ox + cnx * f.dist;
        const csy = f.oy + cny * f.dist;
        const csz = f.oz + cnz * f.dist;
        const clusterCamDist = Math.sqrt((csx - f.cx) ** 2 + (csy - f.cy) ** 2 + (csz - f.cz) ** 2);
        if (clusterCamDist > this._distCutoff) return;

        // Type
        const typeHash = (clusterHash >> 24) & 0xFF;
        let typeId = ATMO_BANK_TYPES.FOG_POCKET;
        if (typeHash < 80) typeId = ATMO_BANK_TYPES.VALLEY_MIST;
        else if (typeHash > 220) typeId = ATMO_BANK_TYPES.LOW_CLOUD;
        if (!this._typeEnabled(typeId)) return;

        // Cluster radius: linear distribution across the full size range
        const sizeRand = ((clusterHash >> 4) & 0xFFF) / 4095.0;
        const radius = this._clusterSizeMin +
            (this._clusterSizeMax - this._clusterSizeMin) * sizeRand;

        // LOD: reduce emitter count for distant clusters
        let lodScale = 1.0;
        if (clusterCamDist > this._lodNear && this._lodFar > this._lodNear) {
            const t = Math.min(1.0, (clusterCamDist - this._lodNear) / (this._lodFar - this._lodNear));
            lodScale = 1.0 + (this._lodMinScale - 1.0) * t;
        }

        const remaining = ATMO_EMITTER_CAPACITY - this._emitters.length;
        const maxThisCluster = Math.min(remaining, Math.max(1, Math.round(this._maxPerCluster * lodScale)));
        if (maxThisCluster <= 0) return;

        const spacing = this._emitterSpacing;
        // Outer bound accounts for warp extensions beyond the base radius
        const outerBound = radius * (1.0 + 0.5 * this._shapeWarp);
        const gridR = Math.ceil(outerBound / spacing);
        const warpSeed = (clusterHash * 2654435761) >>> 0;

        // Probabilistic thinning: sub-sample uniformly across the full footprint so
        // large clusters don't crowd all emitters into the top-left of the grid scan.
        // Factor 0.75 accounts for shape-warp rejection; pi*r^2/s^2 already handles
        // the circle/square ratio, so 0.55 was double-counting and producing keepProb
        // too high (biasing emitters toward the start of the row-major scan).
        const estimatedPositions = Math.max(1, Math.PI * outerBound * outerBound / (spacing * spacing) * 0.75);
        const keepProb = Math.min(1.0, (maxThisCluster + 1) / estimatedPositions);

        let placed = 0;
        for (let gi = -gridR; gi <= gridR; gi++) {
            for (let gj = -gridR; gj <= gridR; gj++) {
                if (this._emitters.length >= ATMO_EMITTER_CAPACITY) return;
                if (placed >= maxThisCluster) return;

                const subHash = this._cellHash(gi + ct * 1000, gj + cb * 1000, warpSeed);

                if (keepProb < 1.0 && ((subHash >> 16 & 0xFFFF) / 65536.0) > keepProb) continue;

                const jst = ((subHash & 0xFF) / 255.0 - 0.5) * spacing * 0.75;
                const jsb = ((subHash >> 8 & 0xFF) / 255.0 - 0.5) * spacing * 0.75;
                const et = centerT + gi * spacing + jst;
                const eb = centerB + gj * spacing + jsb;

                const dt = et - centerT;
                const db = eb - centerB;
                const planarDist = Math.sqrt(dt * dt + db * db);
                if (planarDist > outerBound) continue;

                // Organic shape: warp the acceptance radius per angle
                const angle = Math.atan2(db, dt);
                if (planarDist > radius * this._sampleShapeWarp(angle, warpSeed)) continue;

                // Project emitter onto sphere surface at camera altitude
                const wx = f.ox + f.ux * f.dist + f.tx * et + f.bx * eb;
                const wy = f.oy + f.uy * f.dist + f.ty * et + f.by * eb;
                const wz = f.oz + f.uz * f.dist + f.tz * et + f.bz * eb;
                const eDist = Math.sqrt((wx - f.ox) ** 2 + (wy - f.oy) ** 2 + (wz - f.oz) ** 2);
                const eNx = (wx - f.ox) / eDist;
                const eNy = (wy - f.oy) / eDist;
                const eNz = (wz - f.oz) / eDist;
                const sx = f.ox + eNx * f.dist;
                const sy = f.oy + eNy * f.dist;
                const sz = f.oz + eNz * f.dist;

                if (Math.sqrt((sx - f.cx) ** 2 + (sy - f.cy) ** 2 + (sz - f.cz) ** 2) > this._distCutoff) continue;

                this._emitters.push({
                    position: [sx, sy, sz],
                    localUp: [eNx, eNy, eNz],
                    typeId,
                    spawnBudget: 4,
                    rngSeed: (subHash ^ (ct * 73856093) ^ (cb * 19349663)) >>> 0 || 1,
                });
                placed++;
            }
        }
    }

    // Returns a radius multiplier in [1 - 0.5*shapeWarp, 1 + 0.5*shapeWarp] based on angle.
    // 8 evenly-spaced anchor points are hashed per cluster seed and linearly interpolated.
    _sampleShapeWarp(angle, seed) {
        const N = 8;
        const norm = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
        const fi = norm * N;
        const lo = Math.floor(fi) % N;
        const hi = (lo + 1) % N;
        const t = fi - Math.floor(fi);
        const wLo = (this._cellHash(lo, 31, seed) & 0xFF) / 255.0;
        const wHi = (this._cellHash(hi, 31, seed) & 0xFF) / 255.0;
        return 1.0 + (wLo + (wHi - wLo) * t - 0.5) * this._shapeWarp;
    }

    getEmitters() { return this._emitters; }

    _cellHash(x, y, seed) {
        let h = (x * 73856093) ^ (y * 19349663) ^ seed;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = (h >> 16) ^ h;
        return h >>> 0;
    }
}
