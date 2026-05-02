// platform_game/gameEngine.js
//
// Game-specific GameEngine shell for the platform jumper. Reuses the
// full wizard_game engine and overrides only what Turn 1+2 need:
//
//   - _createActorManager(): return a PlatformActorManager, which spawns
//     the player as a ball (GenericMeshRenderer) instead of a rigged GLB.
//   - update(): after the base tick, drive the CloudField so floating
//     cloud platforms stream in/out around the player and animate.

import { GameEngine as BaseGameEngine } from '../wizard_game/gameEngine.js';
import { PlatformActorManager } from './actors/PlatformActorManager.js';
import { CloudField } from './game/CloudField.js';
import { PlatformGameUI } from './ui/PlatformGameUI.js';
import { Logger } from '../shared/Logger.js';

export class PlatformGameEngine extends BaseGameEngine {
    constructor(canvasId, engineConfig, gameDataConfig) {
        super(canvasId, engineConfig, gameDataConfig);
        this._cloudField = null;
        this._cloudUpdateBusy = false;  // guard against async re-entrancy
    }

    _createActorManager(options) {
        return new PlatformActorManager(options);
    }

    /** Game-specific HUD — no wizard vitals, no debug panels. */
    _createGameUI() {
        return new PlatformGameUI();
    }

    /** Platform jumper has its own enemy system; skip the wizard campfire + fireflies + distortion. */
    _registerAmbiance(_spawn) { /* intentionally empty */ }

    /** Wizard goblins don't belong in Frostspire. Own enemies come in a later turn. */
    async _registerNPCs() { /* intentionally empty */ }

    update(deltaTime) {
        super.update(deltaTime);

        // Cloud platforms come online only after the engine has a player
        // and the generic mesh renderer is available. Both are ready
        // after actorManager.createPlayer resolves in super.start().
        if (!this._cloudField && this.actorManager?.playerActor
            && this.renderer?.genericMeshRenderer && this.planetConfig) {
            const pCfg = this.engineConfig?.platformGame?.cloudField ?? {};
            this._cloudField = new CloudField({
                planetConfig: this.planetConfig,
                genericMeshRenderer: this.renderer.genericMeshRenderer,
                targetCount:      pCfg.targetCount      ?? 28,
                cellSizeMeters:   pCfg.cellSizeMeters   ?? 90,
                streamRadiusCells:pCfg.streamRadiusCells ?? 4,
                minAltitude:      pCfg.minAltitude      ?? 30,
                maxAltitude:      pCfg.maxAltitude      ?? 180,
                seed:             pCfg.seed             ?? 0xC10D,
            });
            Logger.info('[PlatformGameEngine] CloudField ready');
        }

        if (this._cloudField && !this._cloudUpdateBusy) {
            const player = this.actorManager.playerActor;
            this._cloudUpdateBusy = true;
            this._cloudField.update(Math.min(deltaTime, 0.1), player.position)
                .catch(err => Logger.warn(`[PlatformGameEngine] cloud update failed: ${err?.message}`))
                .finally(() => { this._cloudUpdateBusy = false; });
        }
        // Even if an async spawn is in flight, publish whatever we have
        // so the movement resolver sees the current platforms this frame.
        if (this._cloudField && this.actorManager?.platformColliderSystem) {
            this._cloudField.publishColliders(this.actorManager.platformColliderSystem);
        }
    }
}
