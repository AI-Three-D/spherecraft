import { ATMO_BANK_TYPES, ATMO_EMITTER_CAPACITY } from './AtmoBankTypes.js';
import { DEFAULT_ATMO_PLACEMENT_CONFIG } from './AtmoBankAuthoringRuntime.js';

export class AtmoBankPlacement {
    constructor(config = {}) {
        this._cellSize        = config.cellSize        ?? DEFAULT_ATMO_PLACEMENT_CONFIG.cellSize;
        this._scanRadius      = config.scanRadius      ?? DEFAULT_ATMO_PLACEMENT_CONFIG.scanRadius;
        this._maxRenderDist   = config.maxRenderDist   ?? DEFAULT_ATMO_PLACEMENT_CONFIG.maxRenderDist;
        this._spawnBudget     = config.baseSpawnBudget  ?? DEFAULT_ATMO_PLACEMENT_CONFIG.baseSpawnBudget;
        this._lodNear         = config.lodNearDistance  ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodNearDistance;
        this._lodFar          = config.lodFarDistance   ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodFarDistance;
        this._lodMinScale     = config.lodMinScale      ?? DEFAULT_ATMO_PLACEMENT_CONFIG.lodMinScale;
        this._distCutoff      = config.distanceCutoff   ?? DEFAULT_ATMO_PLACEMENT_CONFIG.distanceCutoff;
        this._baseProb        = config.spawnProbability ?? DEFAULT_ATMO_PLACEMENT_CONFIG.spawnProbability;
        this._emitters = [];
    }

    update(camera, environmentState, planetConfig) {
        this._emitters.length = 0;
        if (!planetConfig?.origin || !planetConfig?.radius) return;

        const origin = planetConfig.origin;
        const radius = planetConfig.radius;
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

        const camTangent = (cam.x - origin.x) * tx + (cam.y - origin.y) * ty + (cam.z - origin.z) * tz;
        const camBitangent = (cam.x - origin.x) * bx + (cam.y - origin.y) * by + (cam.z - origin.z) * bz;

        const cellT0 = Math.floor(camTangent / this._cellSize);
        const cellB0 = Math.floor(camBitangent / this._cellSize);
        const half = Math.floor(this._scanRadius / 2);

        const weatherMod = Math.max(0.2, (environmentState?.fogDensity ?? 0.3) +
            (environmentState?.weatherIntensity ?? 0.3) * 0.5);

        for (let ct = cellT0 - half; ct <= cellT0 + half; ct++) {
            for (let cb = cellB0 - half; cb <= cellB0 + half; cb++) {
                if (this._emitters.length >= ATMO_EMITTER_CAPACITY) break;

                const h = this._cellHash(ct, cb, 0x9E3779B9);
                const prob = this._baseProb * weatherMod;
                if ((h & 0xFFFF) / 65536.0 > prob) continue;

                const jitterT = ((h >> 8 & 0xFF) / 255.0 - 0.5) * this._cellSize * 0.8;
                const jitterB = ((h >> 16 & 0xFF) / 255.0 - 0.5) * this._cellSize * 0.8;
                const cellCenterT = (ct + 0.5) * this._cellSize + jitterT;
                const cellCenterB = (cb + 0.5) * this._cellSize + jitterB;

                const wx = origin.x + upX * distFromCenter + tx * cellCenterT + bx * cellCenterB;
                const wy = origin.y + upY * distFromCenter + ty * cellCenterT + by * cellCenterB;
                const wz = origin.z + upZ * distFromCenter + tz * cellCenterT + bz * cellCenterB;

                const eDx = wx - origin.x;
                const eDy = wy - origin.y;
                const eDz = wz - origin.z;
                const eDist = Math.sqrt(eDx * eDx + eDy * eDy + eDz * eDz);
                const eNx = eDx / eDist;
                const eNy = eDy / eDist;
                const eNz = eDz / eDist;
                const sx = origin.x + eNx * distFromCenter;
                const sy = origin.y + eNy * distFromCenter;
                const sz = origin.z + eNz * distFromCenter;

                const cDx = sx - cam.x;
                const cDy = sy - cam.y;
                const cDz = sz - cam.z;
                const camDist = Math.sqrt(cDx * cDx + cDy * cDy + cDz * cDz);
                if (camDist > this._distCutoff) continue;

                const typeHash = (h >> 24) & 0xFF;
                let typeId = ATMO_BANK_TYPES.FOG_POCKET;
                if (typeHash < 80) typeId = ATMO_BANK_TYPES.VALLEY_MIST;
                else if (typeHash > 200) typeId = ATMO_BANK_TYPES.LOW_CLOUD;

                let budgetScale = 1.0;
                if (camDist > this._lodNear && this._lodFar > this._lodNear) {
                    const t = Math.min(1.0, (camDist - this._lodNear) / (this._lodFar - this._lodNear));
                    budgetScale = 1.0 + (this._lodMinScale - 1.0) * t;
                }
                const budget = Math.max(1, Math.round(this._spawnBudget * budgetScale));

                this._emitters.push({
                    position: [sx, sy, sz],
                    localUp: [eNx, eNy, eNz],
                    typeId,
                    spawnBudget: budget,
                    rngSeed: (h ^ (ct * 73856093) ^ (cb * 19349663)) >>> 0 || 1,
                });
            }
        }
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
