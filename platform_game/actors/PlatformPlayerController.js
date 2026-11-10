// platform_game/actors/PlatformPlayerController.js
//
// Game-specific player controller for the platform jumper.
// For Turn 1+2 the on-ground motion reuses the CharacterController
// intent-flag wiring (WASD + right-drag yaw). This class exists as the
// seam where later turns will plug in:
//   - stamina-scaled movement speed & jump height
//   - coyote time bookkeeping (recent-ground window)
//   - jump intent + air state (needs vertical-physics WGSL changes)
//   - fruit "anti-gravity" modifier
//   - enemy-collision knockback
//
// Kept intentionally small right now — it doesn't add physics that
// don't yet have a GPU counterpart.

import { CharacterController } from '../../wizard_game/actors/CharacterController.js';
import { IntentFlags } from '../../wizard_game/actors/ActorState.js';

export class PlatformPlayerController extends CharacterController {
    constructor(actor) {
        super(actor);

        // Stamina-driven tuning (used only CPU-side for now: scales the
        // actor's effective moveSpeed). See actor.stamina in CharacterActor.
        this.minStaminaSpeedFactor = 0.35;   // never below 35% of base speed
        this.staminaDrainPerSecond = 1.2;    // baseline drain while alive
        this.staminaDrainMoving = 3.0;       // extra drain while moving
        this.staminaDrainSprint = 5.0;       // extra drain while sprinting

        // Coyote-time bookkeeping (seconds since last grounded frame).
        // Used by future jump logic — air jump is allowed if < coyoteWindow.
        this.coyoteWindow = 0.18;
        this._airborneTime = 0;

        // Requested jump (edge-triggered). Stored here until the GPU
        // movement resolver gains vertical physics.
        this._jumpRequested = false;

        // Transient "anti-gravity" window (fruit effect). Seconds remaining.
        this.antiGravityRemaining = 0;
    }

    get jumpRequested() { return this._jumpRequested; }
    consumeJumpRequest() {
        const v = this._jumpRequested;
        this._jumpRequested = false;
        return v;
    }
    get isAirborne() { return this._airborneTime > 0.05; }
    get hasCoyoteTime() { return this._airborneTime < this.coyoteWindow; }

    grantAntiGravity(seconds) {
        this.antiGravityRemaining = Math.max(this.antiGravityRemaining, seconds);
    }

    /**
     * Per-frame tick — call AFTER processInput() and AFTER the actor's
     * GPU state readback has updated actor.grounded / actor.movementState.
     */
    /**
     * Apply fall damage based on the last impact speed the GPU resolver
     * reported. Called from tick() right after state readback.
     *
     * Spec thresholds:
     *  - <10 m of free-fall ⇒ 0 dmg      (impact ~14 m/s)
     *  - 10 m+              ⇒ prop. dmg  (scaled by excess speed)
     *  - "very high falls"  ⇒ can kill
     *  - anti-grav (fruit)  ⇒ no damage
     */
    _applyFallDamage(actor) {
        const impact = actor.lastImpactSpeed ?? 0;
        if (impact <= 0) return;
        actor.lastImpactSpeed = 0;  // consume
        if (this.antiGravityRemaining > 0) return;
        // Free-fall from 10 m → ~14 m/s. Below that is safe.
        const safeSpeed = 14;
        const excess = impact - safeSpeed;
        if (excess <= 0) return;
        const dmg = Math.round(excess * 3.5);
        actor.health = Math.max(0, (actor.health ?? 0) - dmg);
        if (actor.health <= 0) {
            actor.isAlive = false;
            actor.isDown = true;
        }
    }

    tick(dt) {
        const actor = this.actor;
        if (!actor) return;

        this._applyFallDamage(actor);

        // Airborne / coyote tracking. Today `grounded` is effectively
        // always true because the movement resolver snaps to terrain —
        // the bookkeeping exists so a future air-physics pass can just
        // flip the flag without re-deriving the timer.
        if (actor.grounded) this._airborneTime = 0;
        else this._airborneTime += dt;

        if (this.antiGravityRemaining > 0) {
            this.antiGravityRemaining = Math.max(0, this.antiGravityRemaining - dt);
            actor.gravityScale = 0.25;  // floaty
        } else {
            actor.gravityScale = 1.0;
        }

        // Stamina drain.
        const moving = (this._intentFlags & (IntentFlags.MOVE_FORWARD |
            IntentFlags.MOVE_BACKWARD | IntentFlags.MOVE_LEFT |
            IntentFlags.MOVE_RIGHT | IntentFlags.MOVE_TO_TARGET)) !== 0;
        let drain = this.staminaDrainPerSecond;
        if (moving) drain += this.staminaDrainMoving;
        if (moving && this._wantsSprint) drain += this.staminaDrainSprint;
        actor.stamina = Math.max(0, (actor.stamina ?? 0) - drain * dt);

        // Scale the actor's effective movement speed with stamina so the
        // resolver naturally slows the ball down as stamina falls.
        const maxSt = actor.maxStamina || 1;
        const t = actor.stamina / maxSt;
        const factor = this.minStaminaSpeedFactor + (1 - this.minStaminaSpeedFactor) * t;
        actor.moveSpeed = actor.baseMoveSpeed * factor;
    }

    processInput(keys, mouseDelta, isRightDragging, clickTarget) {
        super.processInput(keys, mouseDelta, isRightDragging, clickTarget);
        // Edge-trigger jump on Space.
        if (keys[' '] === true || keys['Space'] === true) {
            this._jumpRequested = true;
        }
    }
}
