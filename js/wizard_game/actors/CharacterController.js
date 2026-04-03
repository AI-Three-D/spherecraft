// js/actors/CharacterController.js
//
// Translates raw input into an intent bitmask + yaw updates.
// No physics — GPU resolves actual movement.

import { IntentFlags } from './ActorState.js';

export class CharacterController {
    constructor(actor) {
        this.actor = actor;
        this._intentFlags = 0;
        this._wantsSprint = false;
    }

    get intentFlags() { return this._intentFlags; }
    get wantsSprint() { return this._wantsSprint; }

    reset() {
        this._intentFlags = 0;
        this._wantsSprint = false;
        if (this.actor) {
            this.actor.moveTarget = null;
        }
    }

    /**
     * @param {object} keys - GameInputManager.getKeys() result
     * @param {{x:number,y:number}} mouseDelta
     * @param {boolean} isRightDragging - right mouse button held
     * @param {object|null} clickTarget - {x,y,z} terrain click or null
     */
    processInput(keys, mouseDelta, isRightDragging, clickTarget) {
        if (this.actor?.isDown || this.actor?.animationAction?.lockMovement === true) {
            this.reset();
            return;
        }

        this._wantsSprint = keys['Shift'] === true;
        let flags = 0;
        if (keys['w']) flags |= IntentFlags.MOVE_FORWARD;
        if (keys['s']) flags |= IntentFlags.MOVE_BACKWARD;
        if (keys['a']) flags |= IntentFlags.MOVE_RIGHT;   // was MOVE_LEFT
        if (keys['d']) flags |= IntentFlags.MOVE_LEFT;   

        // Right-drag rotates the character. Apply immediately on CPU so
        // camera and GPU see the same yaw this frame.
        if (isRightDragging && Math.abs(mouseDelta.x) > 0) {
            this.actor.facingYaw -= mouseDelta.x * 0.005;
            // Wrap to [-PI, PI] for numeric stability.
            const TAU = Math.PI * 2;
            this.actor.facingYaw = ((this.actor.facingYaw % TAU) + TAU) % TAU;
            if (this.actor.facingYaw > Math.PI) this.actor.facingYaw -= TAU;
        }

        // Click-to-move: store target, GPU will steer toward it.
        if (clickTarget) {
            this.actor.moveTarget = { ...clickTarget };
        }

        // Any WASD input cancels click-to-move.
        const hasDirectional = flags & (IntentFlags.MOVE_FORWARD | IntentFlags.MOVE_BACKWARD
            | IntentFlags.MOVE_LEFT | IntentFlags.MOVE_RIGHT);
        if (hasDirectional) {
            this.actor.moveTarget = null;
        } else if (this.actor.moveTarget) {
            flags |= IntentFlags.MOVE_TO_TARGET;
        }

        this._intentFlags = flags;
    }

    clearMovementIntent() {
        this._intentFlags = 0;
        this._wantsSprint = false;
        if (this.actor) {
            this.actor.moveTarget = null;
        }
    }
}
