// js/actors/NPCManager.js
//
// Manages NPC spawning, lightweight combat AI, and despawn-by-distance for
// biome-aware goblin encounters.

import { Logger } from '../config/Logger.js';
import { AnimationId } from './ActorState.js';

const AI_STATE = Object.freeze({
    APPROACH: 'approach',
    OBSERVE: 'observe',
    CHARGE: 'charge',
    ATTACK: 'attack',
    RETREAT: 'retreat',
});

export class NPCManager {
    /**
     * @param {import('./ActorManager.js').ActorManager} actorManager
     * @param {object} config  — shape of DEFAULT_NPC_SPAWN_CONFIG
     */
    constructor(actorManager, config) {
        this._actorManager = actorManager;
        this._config = config;
        this._npcs = [];
        this._assetCache = new Map();
        this._spawnTimer = 0;
        this._nextGroupId = 1;
        this._time = 0;

        /**
         * Queue item shapes:
         * - { kind:'auto', playerPos:{x,y,z} }
         * - { kind:'debug', playerPos:{x,y,z}, typeId?:string, groupSize?:number, allowChief?:boolean }
         */
        this._spawnQueue = [];
        this._processingSpawns = false;

        this._initialized = false;
    }

    // ── Public API ───────────────────────────────────────────────────────

    get activeNPCCount() { return this._npcs.length; }
    get npcs()           { return this._npcs; }

    async initialize() {
        const { GLTFLoader } = await import('../assets/gltf/GLTFLoader.js');
        const { CharacterDescriptor } = await import('./config/CharacterDescriptor.js');
        const loader = new GLTFLoader({ verbose: false });
    
        // Share model cache with ActorManager so player & NPCs using the
        // same .glb load it once.
        const modelCache = this._actorManager._modelCache;
    
        for (const [typeId, typeDef] of Object.entries(this._config.npcTypes)) {
            try {
                const desc = await CharacterDescriptor.load(
                    typeDef.characterDescriptorUrl, loader, modelCache
                );
                this._assetCache.set(typeId, desc);   // now stores CharacterDescriptor
                Logger.info(
                    `[NPCManager] Loaded "${typeId}" — ` +
                    `${desc.model.asset.animations.length} animation(s)`
                );
            } catch (e) {
                Logger.warn(`[NPCManager] Failed to load "${typeId}": ${e.message}`);
            }
        }
    
        this._initialized = true;
        Logger.info(`[NPCManager] Initialized, ${this._assetCache.size} NPC type(s) cached`);
    }
    update(dt, playerActor) {
        if (!this._initialized || !playerActor?.position) return;

        this._time += dt;
        this._despawnFar(playerActor.position);
        this._updateCombat(dt, playerActor);

        const rules = this._config.spawnRules;
        if (!rules?.enabled) return;
        if (rules.requiresLivingPlayer && playerActor.isDown) return;

        this._spawnTimer += dt;
        if (this._spawnTimer >= rules.spawnIntervalSec) {
            this._spawnTimer = 0;
            this._queueAutoSpawnAttempt(playerActor);
        }
    }

    async processSpawnQueue() {
        if (this._processingSpawns || this._spawnQueue.length === 0) return;
        this._processingSpawns = true;
        try {
            while (this._spawnQueue.length > 0) {
                const req = this._spawnQueue.shift();
                const resolved = await this._resolveSpawnRequest(req);
                if (!resolved) continue;
                await this._executeSpawn(resolved);
            }
        } finally {
            this._processingSpawns = false;
        }
    }

    requestDebugSpawnNearPlayer(options = {}) {
        const debug = this._config.debug ?? {};
        if (!debug.enabled) {
            return false;
        }

        const playerActor = this._actorManager.playerActor;
        if (!playerActor?.position) {
            return false;
        }

        this._spawnQueue.push({
            kind: 'debug',
            playerPos: { ...playerActor.position },
            typeId: options.typeId ?? debug.defaultTypeId ?? 'goblin',
            groupSize: options.groupSize ?? debug.defaultGroupSize ?? 3,
            allowChief: options.allowChief ?? debug.allowChief ?? true,
        });
        return true;
    }

    dispose() {
        for (const npc of [...this._npcs]) {
            this._actorManager.removeActor(npc.actor);
        }
        this._npcs.length = 0;
        this._spawnQueue.length = 0;
        this._assetCache.clear();
        this._spawnTimer = 0;
        this._time = 0;
        this._initialized = false;
    }

    // ── Combat update ────────────────────────────────────────────────────

    _updateCombat(dt, playerActor) {
        const attackersByGroup = new Map();
        for (const npc of this._npcs) {
            if (npc.aiState === AI_STATE.CHARGE || npc.aiState === AI_STATE.ATTACK) {
                attackersByGroup.set(
                    npc.groupId,
                    (attackersByGroup.get(npc.groupId) ?? 0) + 1
                );
            }
        }

        for (const npc of this._npcs) {
            this._updateSingleNPC(npc, dt, playerActor, attackersByGroup);
        }

        let nearbyThreats = 0;
        let meleeThreats = 0;
        for (const npc of this._npcs) {
            const dist = _distance(npc.actor.position, playerActor.position);
            if (dist <= 65) nearbyThreats++;
            if (
                (npc.aiState === AI_STATE.CHARGE || npc.aiState === AI_STATE.ATTACK) &&
                dist <= (npc.attackProfile?.attackRange ?? 0) + 4
            ) {
                meleeThreats++;
            }
        }

        if (playerActor.isDown) {
            playerActor.statusText = 'Down';
        } else if (meleeThreats > 0) {
            playerActor.statusText = 'Under attack';
        } else if (nearbyThreats > 0) {
            playerActor.statusText = `${nearbyThreats} goblin${nearbyThreats === 1 ? '' : 's'} nearby`;
        } else {
            playerActor.statusText = 'Ready';
        }
    }

    _updateSingleNPC(npc, dt, playerActor, attackersByGroup) {
        const actor = npc.actor;
        const typeDef = this._config.npcTypes[npc.typeId];
        const ai = typeDef?.ai;
        const attack = npc.attackProfile;
        if (!actor || !typeDef || !ai || !attack) return;

        npc.stateTime += dt;
        npc.orbitAngle = _wrapAngle(npc.orbitAngle + npc.orbitDir * npc.orbitSpeed * dt);

        const playerPos = playerActor.position;
        const distToPlayer = _distance(actor.position, playerPos);
        actor.statusText = _describeNPCState(npc.aiState, npc.isBoss);

        if (playerActor.isDown) {
            actor.moveTarget = null;
            actor.moveSpeed = 0;
            if (npc.aiState !== AI_STATE.ATTACK) {
                this._enterObserve(npc);
            }
            this._actorManager.faceActorTowardPosition(actor, playerPos, {
                turnBlend: 0.2,
                maxTurnStep: 0.08,
            });
            return;
        }

        const observeTarget = this._computeOrbitTarget(
            playerPos,
            npc.observeDistance,
            npc.orbitAngle + npc.orbitOffset
        );

        switch (npc.aiState) {
            case AI_STATE.APPROACH: {
                actor.moveSpeed = actor.baseMoveSpeed * (ai.approachSpeedMultiplier ?? 1.0);
                actor.moveTarget = observeTarget;
                if (distToPlayer <= npc.observeDistance + (ai.approachSlack ?? 6)) {
                    this._enterObserve(npc);
                }
                break;
            }

            case AI_STATE.OBSERVE: {
                actor.moveSpeed = actor.baseMoveSpeed * (ai.observeSpeedMultiplier ?? 0.8);
                actor.moveTarget = observeTarget;
                this._actorManager.faceActorTowardPosition(actor, playerPos, {
                    turnBlend: 0.16,
                    maxTurnStep: 0.08,
                });

                if (distToPlayer > npc.observeDistance + (ai.observeSlack ?? 7) + 8) {
                    this._enterApproach(npc);
                    break;
                }

                const groupAttackers = attackersByGroup.get(npc.groupId) ?? 0;
                const maxConcurrentAttackers = ai.maxConcurrentAttackersPerGroup ?? 1;
                const canCharge =
                    this._time >= npc.nextAttackTime &&
                    groupAttackers < maxConcurrentAttackers;
                const pressureChargeDistance =
                    ai.pressureChargeDistance ??
                    Math.max((attack.engageRange ?? (attack.attackRange + 1.0)) * 2.5, 10);
                if (
                    canCharge &&
                    (
                        npc.stateTime >= npc.observeHoldDuration ||
                        distToPlayer <= pressureChargeDistance
                    )
                ) {
                    this._enterCharge(npc);
                    attackersByGroup.set(npc.groupId, groupAttackers + 1);
                    break;
                }

                const retreatTriggerDistance =
                    ai.retreatTriggerDistance ??
                    Math.max((attack.attackRange ?? 2.5) + 1.5, 4.5);
                if (distToPlayer < retreatTriggerDistance && !canCharge) {
                    actor.moveTarget = this._buildRetreatTarget(
                        playerPos,
                        actor.position,
                        _sampleRange(ai.retreatDistance, 6),
                        _sampleRange(ai.retreatLateralDistance, 2),
                        npc.orbitDir
                    );
                }
                break;
            }

            case AI_STATE.CHARGE: {
                actor.moveSpeed = actor.baseMoveSpeed * (ai.chargeSpeedMultiplier ?? 1.3);
                const attackTarget = this._buildAttackTarget(
                    playerPos,
                    actor.position,
                    attack.attackRange
                );
                actor.moveTarget = attackTarget;
                this._actorManager.faceActorTowardPosition(actor, playerPos, {
                    turnBlend: 0.28,
                    maxTurnStep: 0.16,
                });

                const distToAttackTarget = _distance(actor.position, attackTarget);
                const engageRange = attack.engageRange ?? (attack.attackRange + 1.0);
                if (
                    distToPlayer <= engageRange ||
                    distToAttackTarget <= Math.max(1.5, actor.collisionRadius * 4)
                ) {
                    this._enterAttack(npc);
                    break;
                }

                if (
                    npc.stateTime >= (ai.chargeTimeoutSec ?? 4) ||
                    distToPlayer > npc.observeDistance + 24
                ) {
                    this._enterObserve(npc);
                }
                break;
            }

            case AI_STATE.ATTACK: {
                actor.moveTarget = null;
                actor.moveSpeed = 0;
                this._actorManager.faceActorTowardPosition(actor, playerPos, {
                    turnBlend: 0.4,
                    maxTurnStep: 0.18,
                });

                const strikeTime = npc.attackDurationSec * _clamp01(attack.strikeFraction ?? 0.45);
                if (!npc.attackStrikeApplied && npc.stateTime >= strikeTime) {
                    if (distToPlayer <= (attack.hitRange ?? attack.attackRange)) {
                        const variance = attack.damageVariance ?? 0;
                        const damage = Math.max(1, Math.round(
                            attack.damage * (1 + (Math.random() * 2 - 1) * variance)
                        ));
                        this._actorManager.damageActor(playerActor, damage, {
                            statusText: 'Under attack',
                            deathStatus: 'Down',
                            heavy: attack.animationId === AnimationId.ATTACK_HEAVY,
                        });
                    }
                    npc.attackStrikeApplied = true;
                }

                if (npc.stateTime >= npc.attackDurationSec) {
                    this._enterRetreat(npc, playerPos);
                }
                break;
            }

            case AI_STATE.RETREAT: {
                actor.moveSpeed = actor.baseMoveSpeed * (ai.retreatSpeedMultiplier ?? 1.15);
                if (!npc.retreatTarget) {
                    npc.retreatTarget = this._buildRetreatTarget(
                        playerPos,
                        actor.position,
                        _sampleRange(ai.retreatDistance, 12),
                        _sampleRange(ai.retreatLateralDistance, 5),
                        npc.orbitDir
                    );
                }
                actor.moveTarget = npc.retreatTarget;
                if (
                    npc.stateTime >= (ai.retreatDurationSec ?? 2.4) ||
                    _distance(actor.position, npc.retreatTarget) <= Math.max(2, actor.collisionRadius * 5)
                ) {
                    this._enterObserve(npc);
                }
                break;
            }

            default:
                this._enterApproach(npc);
                break;
        }
    }

    _enterApproach(npc) {
        npc.aiState = AI_STATE.APPROACH;
        npc.stateTime = 0;
        npc.retreatTarget = null;
    }

    _enterObserve(npc) {
        npc.aiState = AI_STATE.OBSERVE;
        npc.stateTime = 0;
        npc.retreatTarget = null;
        npc.observeHoldDuration = _sampleRange(
            this._config.npcTypes[npc.typeId]?.ai?.observeHoldSec,
            1.4
        );
    }

    _enterCharge(npc) {
        npc.aiState = AI_STATE.CHARGE;
        npc.stateTime = 0;
        npc.retreatTarget = null;
    }

    _enterAttack(npc) {
        npc.aiState = AI_STATE.ATTACK;
        npc.stateTime = 0;
        npc.attackStrikeApplied = false;
        npc.retreatTarget = null;
        npc.actor.moveTarget = null;
        npc.actor.moveSpeed = 0;

        this._actorManager.beginActionAnimation(
            npc.actor,
            npc.attackProfile.animationId,
            {
                speed: npc.attackProfile.animationSpeed ?? 1.0,
                lockMovement: true,
            }
        );
        npc.attackDurationSec =
            npc.actor.animationAction?.duration ??
            npc.attackProfile.fallbackDurationSec ??
            0.9;
    }

    _enterRetreat(npc, playerPos) {
        npc.aiState = AI_STATE.RETREAT;
        npc.stateTime = 0;
        npc.attackStrikeApplied = false;
        npc.nextAttackTime =
            this._time +
            (npc.attackProfile.attackCooldownSec ?? 2.0) +
            Math.random() * (npc.attackProfile.attackCooldownJitterSec ?? 0);
        npc.retreatTarget = this._buildRetreatTarget(
            playerPos,
            npc.actor.position,
            _sampleRange(this._config.npcTypes[npc.typeId]?.ai?.retreatDistance, 12),
            _sampleRange(this._config.npcTypes[npc.typeId]?.ai?.retreatLateralDistance, 5),
            npc.orbitDir
        );
        npc.actor.moveTarget = npc.retreatTarget;
    }

    // ── Despawn ──────────────────────────────────────────────────────────

    _despawnFar(playerPos) {
        const maxDist2 = this._config.spawnRules.despawnDistance ** 2;
        const toRemove = [];

        for (const npc of this._npcs) {
            if (_distanceSquared(npc.actor.position, playerPos) > maxDist2) {
                toRemove.push(npc);
            }
        }

        for (const npc of toRemove) {
            this._actorManager.removeActor(npc.actor);
            const idx = this._npcs.indexOf(npc);
            if (idx >= 0) this._npcs.splice(idx, 1);
            Logger.info(
                `[NPCManager] Despawned ${npc.typeId}/${npc.variant} (group #${npc.groupId})`
            );
        }
    }

    // ── Spawn queueing ───────────────────────────────────────────────────

    _queueAutoSpawnAttempt(playerActor) {
        const rules = this._config.spawnRules;
        if (this._npcs.length >= rules.maxActiveNPCs) return;
        if (Math.random() > (rules.spawnChancePerInterval ?? 1.0)) return;

        this._spawnQueue.push({
            kind: 'auto',
            playerPos: { ...playerActor.position },
        });
    }

    async _resolveSpawnRequest(req) {
        const rules = this._config.spawnRules;
        if (this._npcs.length >= rules.maxActiveNPCs) return null;

        const typeId = req.typeId || this._pickRandomType();
        if (!typeId || !this._assetCache.has(typeId)) return null;

        const remaining = rules.maxActiveNPCs - this._npcs.length;
        let groupSize = req.groupSize ?? 0;
        if (!(groupSize > 0)) {
            const maxGroup = Math.min(rules.groupSize.max, remaining);
            if (maxGroup < rules.groupSize.min) return null;
            groupSize = rules.groupSize.min +
                Math.floor(Math.random() * (maxGroup - rules.groupSize.min + 1));
        }
        groupSize = Math.max(1, Math.min(groupSize, remaining));

        let center = null;
        if (req.kind === 'debug') {
            const debug = this._config.debug ?? {};
            center = this._computeSpawnCenter(
                req.playerPos,
                debug.minSpawnDistance ?? 35,
                debug.maxSpawnDistance ?? 60
            );
        } else {
            const attempts = rules.spawnSearchAttempts ?? 4;
            for (let i = 0; i < attempts; i++) {
                const candidate = this._computeSpawnCenter(
                    req.playerPos,
                    rules.minSpawnDistance,
                    rules.maxSpawnDistance
                );
                if (!candidate) continue;

                const tileId = await this._sampleTileIdAtWorldPosition(candidate);
                if (this._isAllowedSpawnTile(tileId)) {
                    center = candidate;
                    break;
                }
            }
        }
        if (!center) return null;

        let chiefCount = 0;
        if (req.kind === 'debug') {
            chiefCount = req.allowChief && groupSize > 1 ? 1 : 0;
        } else if (
            groupSize >= rules.bossMinGroupSize &&
            Math.random() < rules.bossChance
        ) {
            chiefCount = Math.min(rules.maxBossesPerGroup, 1);
        }

        const positions = [];
        const variants = [];
        const bossMask = [];
        for (let i = 0; i < groupSize; i++) {
            const isChief = i < chiefCount;
            positions.push(this._spreadPosition(center, i, groupSize));
            variants.push(isChief ? 'chief' : 'small');
            bossMask.push(isChief);
        }

        const groupId = this._nextGroupId++;
        return { typeId, groupId, positions, variants, bossMask };
    }

    async _executeSpawn(req) {
        const typeDef = this._config.npcTypes[req.typeId];
        const charDesc = this._assetCache.get(req.typeId);
        if (!typeDef || !charDesc) return;
    
        for (let i = 0; i < req.positions.length; i++) {
            if (this._npcs.length >= this._config.spawnRules.maxActiveNPCs) break;
    
            const variantName = req.variants[i];
            const isBoss = req.bossMask[i];
            const variantDef = typeDef.variants.find((v) => v.name === variantName)
                || typeDef.variants[0];
            const scaleMul = variantDef.scaleMultiplier;
    
            try {
                const actor = await this._actorManager.createNPC(
                    charDesc,
                    req.typeId,
                    req.positions[i],
                    {
                        // Variant scales the descriptor defaults:
                        modelScale:      charDesc.scale * scaleMul,
                        collisionRadius: charDesc.collisionRadius * scaleMul,
                        // Boss HP buff:
                        health:    isBoss ? charDesc.maxHealth * 3 : charDesc.health,
                        maxHealth: isBoss ? charDesc.maxHealth * 3 : charDesc.maxHealth,
                        // NPC-only gameplay params from spawn config:
                        hostility: typeDef.hostility,
                        braveness: typeDef.braveness,
                        locomotionRunThresholdMultiplier:
                            typeDef.ai?.runAnimationThresholdMultiplier,
                        // Metadata:
                        groupId: req.groupId,
                        variant: variantName,
                        isBoss,
                    }
                );
    
                if (!actor) continue;
    
                actor.statusText = 'Hunting';
                this._npcs.push({
                    actor,
                    typeId: req.typeId,
                    variant: variantName,
                    groupId: req.groupId,
                    isBoss,
                    aiState: AI_STATE.APPROACH,
                    stateTime: 0,
                    observeDistance: _sampleRange(typeDef.ai?.observeDistance, 40),
                    observeHoldDuration: _sampleRange(typeDef.ai?.observeHoldSec, 1.4),
                    orbitAngle: Math.random() * Math.PI * 2,
                    orbitOffset: (i / Math.max(1, req.positions.length)) * Math.PI * 2,
                    orbitDir: Math.random() < 0.5 ? -1 : 1,
                    orbitSpeed: _sampleRange(typeDef.ai?.observeOrbitSpeed, 0.45),
                    nextAttackTime: this._time + _sampleRange(typeDef.ai?.spawnAttackDelaySec, 0.3),
                    retreatTarget: null,
                    attackStrikeApplied: false,
                    attackDurationSec: _resolveAttackProfile(typeDef, variantName, isBoss)?.fallbackDurationSec ?? 0.9,
                    attackProfile: _resolveAttackProfile(typeDef, variantName, isBoss),
                });
            } catch (e) {
                Logger.warn(
                    `[NPCManager] Spawn failed for ${req.typeId}/${variantName}: ${e.message}`
                );
            }
        }
    
        Logger.info(
            `[NPCManager] Spawned group #${req.groupId}: ` +
            `${req.positions.length} ${req.typeId}(s), ` +
            `${req.bossMask.filter(Boolean).length} chief`
        );
    }

    // ── Spawn helpers ────────────────────────────────────────────────────

    _pickRandomType() {
        const types = Object.keys(this._config.npcTypes);
        return types.length > 0
            ? types[Math.floor(Math.random() * types.length)]
            : null;
    }

    _computeSpawnCenter(playerPos, minDistance, maxDistance) {
        const pc = this._actorManager.planetConfig;
        if (!pc) return null;

        const o = pc.origin;
        const ux = playerPos.x - o.x;
        const uy = playerPos.y - o.y;
        const uz = playerPos.z - o.z;
        const radius = Math.hypot(ux, uy, uz) || 1;
        const { right, fwd } = _tangentFrame(ux / radius, uy / radius, uz / radius);

        const angle = Math.random() * Math.PI * 2;
        const dist = minDistance + Math.random() * (maxDistance - minDistance);
        const offX = Math.cos(angle) * dist;
        const offZ = Math.sin(angle) * dist;

        return _reprojectToSphere(
            playerPos.x + right.x * offX + fwd.x * offZ,
            playerPos.y + right.y * offX + fwd.y * offZ,
            playerPos.z + right.z * offX + fwd.z * offZ,
            o,
            radius
        );
    }

    _spreadPosition(center, index, total) {
        if (total <= 1) return { ...center };

        const pc = this._actorManager.planetConfig;
        const o = pc.origin;
        const dx = center.x - o.x;
        const dy = center.y - o.y;
        const dz = center.z - o.z;
        const radius = Math.hypot(dx, dy, dz) || 1;
        const { right, fwd } = _tangentFrame(dx / radius, dy / radius, dz / radius);

        const spreadR = Math.min(total * 1.4, this._config.spawnRules.spreadRadius);
        const a = (index / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
        const r = spreadR * (0.35 + Math.random() * 0.65);

        return _reprojectToSphere(
            center.x + right.x * Math.cos(a) * r + fwd.x * Math.sin(a) * r,
            center.y + right.y * Math.cos(a) * r + fwd.y * Math.sin(a) * r,
            center.z + right.z * Math.cos(a) * r + fwd.z * Math.sin(a) * r,
            o,
            radius
        );
    }

    async _sampleTileIdAtWorldPosition(worldPos) {
        const tileStreamer = this._actorManager.tileStreamer;
        const planetConfig = this._actorManager.planetConfig;
        if (!tileStreamer?.debugReadArrayLayerTexels || !planetConfig?.origin) {
            return null;
        }

        const relX = worldPos.x - planetConfig.origin.x;
        const relY = worldPos.y - planetConfig.origin.y;
        const relZ = worldPos.z - planetConfig.origin.z;
        const faceUv = _worldPositionToFaceUV(relX, relY, relZ);
        if (!faceUv) return null;

        const uNorm = Math.min(0.999999, Math.max(0, (faceUv.u + 1) * 0.5));
        const vNorm = Math.min(0.999999, Math.max(0, (faceUv.v + 1) * 0.5));
        const maxDepth = Math.max(
            0,
            Math.min(
                this._config.spawnRules.tileSampleMaxDepth ?? 8,
                this._actorManager.quadtreeGPU?.maxDepth ?? 8
            )
        );

        for (let depth = maxDepth; depth >= 0; depth--) {
            const grid = 1 << depth;
            const tileX = Math.min(grid - 1, Math.floor(uNorm * grid));
            const tileY = Math.min(grid - 1, Math.floor(vNorm * grid));
            const layer = tileStreamer.getLoadedLayer(faceUv.face, depth, tileX, tileY);
            if (!Number.isFinite(layer)) continue;

            const localU = uNorm * grid - tileX;
            const localV = vNorm * grid - tileY;
            return this._readTileIdFromLayer(layer, localU, localV);
        }

        return null;
    }

    async _readTileIdFromLayer(layer, localU, localV) {
        const tileStreamer = this._actorManager.tileStreamer;
        const texSize = tileStreamer?.tileTextureSize ?? 0;
        if (!(texSize > 0)) return null;

        const texel = {
            x: Math.max(0, Math.min(texSize - 1, Math.floor(localU * (texSize - 1)))),
            y: Math.max(0, Math.min(texSize - 1, Math.floor(localV * (texSize - 1)))),
        };
        const readback = await tileStreamer.debugReadArrayLayerTexels('tile', layer, [texel]);
        const raw = readback?.texels?.[0]?.values?.[0];
        return Number.isFinite(raw) ? _decodeTileId(raw) : null;
    }

    _isAllowedSpawnTile(tileId) {
        if (!Number.isFinite(tileId)) return false;
        const ranges = this._config.spawnRules.allowedTileIdRanges;
        if (!Array.isArray(ranges) || ranges.length === 0) return true;
        return ranges.some(([min, max]) => tileId >= min && tileId <= max);
    }

    // ── Combat geometry ──────────────────────────────────────────────────

    _computeOrbitTarget(playerPos, radius, angle) {
        return this._offsetAroundPlayer(playerPos, radius, angle);
    }

    _buildAttackTarget(playerPos, actorPos, attackRange) {
        const pc = this._actorManager.planetConfig;
        const dir = _tangentDirectionFromAnchor(playerPos, actorPos, pc.origin)
            || _directionFromAngle(playerPos, pc.origin, 0);
        return _offsetFromDirection(
            playerPos,
            pc.origin,
            dir,
            Math.max(0.9, attackRange * 0.55)
        );
    }

    _buildRetreatTarget(playerPos, actorPos, retreatDistance, lateralDistance, orbitDir) {
        const pc = this._actorManager.planetConfig;
        const dir = _tangentDirectionFromAnchor(playerPos, actorPos, pc.origin)
            || _directionFromAngle(playerPos, pc.origin, 0);
        const up = _normalizeVec3({
            x: playerPos.x - pc.origin.x,
            y: playerPos.y - pc.origin.y,
            z: playerPos.z - pc.origin.z,
        });
        const lateral = _normalizeVec3(_crossVec3(up, dir));
        const combined = _normalizeVec3({
            x: dir.x * retreatDistance + lateral.x * lateralDistance * orbitDir,
            y: dir.y * retreatDistance + lateral.y * lateralDistance * orbitDir,
            z: dir.z * retreatDistance + lateral.z * lateralDistance * orbitDir,
        });
        return _offsetFromDirection(playerPos, pc.origin, combined, Math.hypot(retreatDistance, lateralDistance));
    }

    _offsetAroundPlayer(playerPos, radius, angle) {
        const pc = this._actorManager.planetConfig;
        const dx = playerPos.x - pc.origin.x;
        const dy = playerPos.y - pc.origin.y;
        const dz = playerPos.z - pc.origin.z;
        const playerRadius = Math.hypot(dx, dy, dz) || 1;
        const { right, fwd } = _tangentFrame(dx / playerRadius, dy / playerRadius, dz / playerRadius);
        return _reprojectToSphere(
            playerPos.x + right.x * Math.cos(angle) * radius + fwd.x * Math.sin(angle) * radius,
            playerPos.y + right.y * Math.cos(angle) * radius + fwd.y * Math.sin(angle) * radius,
            playerPos.z + right.z * Math.cos(angle) * radius + fwd.z * Math.sin(angle) * radius,
            pc.origin,
            playerRadius
        );
    }
}

// ── Module-local helpers ────────────────────────────────────────────────

function _describeNPCState(state, isChief) {
    const role = isChief ? 'Chief' : 'Goblin';
    switch (state) {
        case AI_STATE.APPROACH: return `${role} stalking`;
        case AI_STATE.OBSERVE: return `${role} circling`;
        case AI_STATE.CHARGE: return `${role} charging`;
        case AI_STATE.ATTACK: return `${role} attacking`;
        case AI_STATE.RETREAT: return `${role} retreating`;
        default: return role;
    }
}

function _resolveAttackProfile(typeDef, variantName, isBoss) {
    const profileKey = variantName ?? (isBoss ? 'chief' : 'small');
    const profile = typeDef?.attackProfiles?.[profileKey];
    if (profile) return profile;
    return typeDef?.attackProfiles?.[isBoss ? 'chief' : 'small'] ?? null;
}

function _sampleRange(range, fallback) {
    if (Number.isFinite(range)) return range;
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return fallback;
    return range.min + Math.random() * (range.max - range.min);
}

function _decodeTileId(raw) {
    return raw > 1 ? Math.round(raw) : Math.round(raw * 255);
}

function _distance(a, b) {
    return Math.sqrt(_distanceSquared(a, b));
}

function _distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function _tangentFrame(upX, upY, upZ) {
    const refAbs = Math.abs(upY) > 0.99;
    const rx0 = refAbs ? 0 : 0;
    const ry0 = refAbs ? 0 : 1;
    const rz0 = refAbs ? 1 : 0;
    let rx = upY * rz0 - upZ * ry0;
    let ry = upZ * rx0 - upX * rz0;
    let rz = upX * ry0 - upY * rx0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    return {
        right: { x: rx, y: ry, z: rz },
        fwd: {
            x: ry * upZ - rz * upY,
            y: rz * upX - rx * upZ,
            z: rx * upY - ry * upX,
        },
    };
}

function _reprojectToSphere(x, y, z, origin, radius) {
    const dx = x - origin.x;
    const dy = y - origin.y;
    const dz = z - origin.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return {
        x: origin.x + (dx / len) * radius,
        y: origin.y + (dy / len) * radius,
        z: origin.z + (dz / len) * radius,
    };
}

function _worldPositionToFaceUV(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len;
    const ny = y / len;
    const nz = z / len;

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    if (ax >= ay && ax >= az) {
        return nx > 0
            ? { face: 0, u: -nz / ax, v: ny / ax }
            : { face: 1, u: nz / ax, v: ny / ax };
    }
    if (ay >= ax && ay >= az) {
        return ny > 0
            ? { face: 2, u: nx / ay, v: -nz / ay }
            : { face: 3, u: nx / ay, v: nz / ay };
    }
    return nz > 0
        ? { face: 4, u: nx / az, v: ny / az }
        : { face: 5, u: -nx / az, v: ny / az };
}

function _tangentDirectionFromAnchor(anchorPos, targetPos, origin) {
    const up = _normalizeVec3({
        x: anchorPos.x - origin.x,
        y: anchorPos.y - origin.y,
        z: anchorPos.z - origin.z,
    });
    const delta = {
        x: targetPos.x - anchorPos.x,
        y: targetPos.y - anchorPos.y,
        z: targetPos.z - anchorPos.z,
    };
    const radial = up.x * delta.x + up.y * delta.y + up.z * delta.z;
    const tangent = {
        x: delta.x - up.x * radial,
        y: delta.y - up.y * radial,
        z: delta.z - up.z * radial,
    };
    const len = Math.hypot(tangent.x, tangent.y, tangent.z);
    if (len < 1e-4) return null;
    return {
        x: tangent.x / len,
        y: tangent.y / len,
        z: tangent.z / len,
    };
}

function _directionFromAngle(anchorPos, origin, angle) {
    const up = _normalizeVec3({
        x: anchorPos.x - origin.x,
        y: anchorPos.y - origin.y,
        z: anchorPos.z - origin.z,
    });
    const { right, fwd } = _tangentFrame(up.x, up.y, up.z);
    return _normalizeVec3({
        x: right.x * Math.cos(angle) + fwd.x * Math.sin(angle),
        y: right.y * Math.cos(angle) + fwd.y * Math.sin(angle),
        z: right.z * Math.cos(angle) + fwd.z * Math.sin(angle),
    });
}

function _offsetFromDirection(anchorPos, origin, dir, distance) {
    const radius = Math.hypot(
        anchorPos.x - origin.x,
        anchorPos.y - origin.y,
        anchorPos.z - origin.z
    ) || 1;
    return _reprojectToSphere(
        anchorPos.x + dir.x * distance,
        anchorPos.y + dir.y * distance,
        anchorPos.z + dir.z * distance,
        origin,
        radius
    );
}

function _normalizeVec3(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function _crossVec3(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function _wrapAngle(angle) {
    const tau = Math.PI * 2;
    let wrapped = ((angle % tau) + tau) % tau;
    if (wrapped > Math.PI) wrapped -= tau;
    return wrapped;
}

function _clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
