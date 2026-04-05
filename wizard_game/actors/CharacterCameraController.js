// js/actors/CharacterCameraController.js
//
// Third-person follow camera on a spherical world.
// Left-drag orbits. Walking interpolates toward a fixed follow pitch.
// Pitch clamped at 75° to prevent zenith glitch.

import { MovementState } from './ActorState.js';

export class CharacterCameraController {
    constructor(options = {}) {
        this.followHeight = options.followHeight ?? 10;
        this.followDistance = options.followDistance ?? 8;
        this.snapBackOnRelease = options.snapBackOnRelease ?? true;
        this.snapBackSpeed = options.snapBackSpeed ?? 3.0;
        this.orbitSensitivity = options.orbitSensitivity ?? 0.005;
        this.smoothing = options.smoothing ?? 8.0;

        this._baseDist = Math.sqrt(this.followHeight ** 2 + this.followDistance ** 2);
        this._basePitch = Math.atan2(this.followHeight, this.followDistance);
        this._anchorPitch = this._basePitch;

        this._orbitYaw = 0;
        this._orbitPitchDelta = 0;
        this._wasDragging = false;
        this._wasMoving = false;

        this._smoothPos = null;
        this._smoothTarget = null;
        this._planetCenter = null;

        // ── Movement pitch steering ──────────────────────────────────
        const defaultWalkPitch = this._basePitch - (20 * Math.PI / 180);
        this._walkFollowPitch = options.walkFollowPitch ?? defaultWalkPitch;
        this._walkPitchApproachSpeed = options.walkPitchApproachSpeed ?? 0.8;
        this._stopPitchApproachSpeed = options.stopPitchApproachSpeed ?? 0.4;
        this._stopPitchReturnFraction = options.stopPitchReturnFraction ?? 0.2;
        this._currentPitch = null;
        this._preMovePitch = this._anchorPitch;

        // ── Pitch clamp ──────────────────────────────────────────────
        this._maxTotalPitch = options.maxTotalPitch
            ?? (75 * Math.PI / 180);
        this._minTotalPitch = 0.1;
        this._walkFollowPitch = this._clampPitch(this._walkFollowPitch);
    }

    setPlanetCenter(c) { this._planetCenter = c; }
    setSnapBackMode(enabled) { this.snapBackOnRelease = enabled; }

    handleOrbit(mouseDelta, isDragging) {
        if (isDragging) {
            this._orbitYaw -= mouseDelta.x * this.orbitSensitivity;
            this._orbitPitchDelta -= mouseDelta.y * this.orbitSensitivity;
            this._clampOrbitPitch();
        }
        this._wasDragging = isDragging;
    }

    zoom(delta) {
        const f = 1.0 + delta * 0.001;
        this._baseDist = Math.max(3, Math.min(60, this._baseDist * f));
        this.followHeight = this._baseDist * Math.sin(this._basePitch);
        this.followDistance = this._baseDist * Math.cos(this._basePitch);
    }

    /**
     * @param {CharacterActor} actor
     * @param {number} dt
     * @returns {{ position:{x,y,z}, target:{x,y,z} }}
     */
    update(actor, dt) {
        // ── Detect movement from the GPU-authoritative movementState ─
        const isMoving = actor.movementState === MovementState.WALKING;
        const manualPitch = this._clampPitch(this._anchorPitch + this._orbitPitchDelta);

        if (this._currentPitch == null) {
            this._currentPitch = manualPitch;
        }

        if (isMoving && !this._wasMoving) {
            this._preMovePitch = this._currentPitch;
        } else if (!isMoving && this._wasMoving) {
            const relaxedPitch = this._walkFollowPitch
                + (this._preMovePitch - this._walkFollowPitch) * this._stopPitchReturnFraction;
            this._anchorPitch = this._clampPitch(relaxedPitch);
            this._clampOrbitPitch();
        }

        // ── Snap-back orbit when not dragging ────────────────────────
        if (!this._wasDragging && this.snapBackOnRelease) {
            const k = Math.min(1, this.snapBackSpeed * dt);
            this._orbitYaw *= (1 - k);
            this._orbitPitchDelta *= (1 - k);
        }

        const p = actor.position;
        const up = this._localUp(p);
        const frame = this._tangentFrame(up, actor.facingYaw + this._orbitYaw);

        const idlePitch = this._clampPitch(this._anchorPitch + this._orbitPitchDelta);
        const targetPitch = (isMoving && !this._wasDragging)
            ? this._walkFollowPitch
            : idlePitch;
        const pitchSpeed = isMoving ? this._walkPitchApproachSpeed : this._stopPitchApproachSpeed;
        this._currentPitch = this._movePitchToward(this._currentPitch, targetPitch, pitchSpeed, dt);
        const pitch = this._currentPitch;

        const horiz = this._baseDist * Math.cos(pitch);
        const vert = this._baseDist * Math.sin(pitch);

        const camX = p.x - frame.fwd.x * horiz + up.x * vert;
        const camY = p.y - frame.fwd.y * horiz + up.y * vert;
        const camZ = p.z - frame.fwd.z * horiz + up.z * vert;

        const lookH = 1.0;
        const tgtX = p.x + up.x * lookH;
        const tgtY = p.y + up.y * lookH;
        const tgtZ = p.z + up.z * lookH;

        if (!this._smoothPos) {
            this._smoothPos = { x: camX, y: camY, z: camZ };
            this._smoothTarget = { x: tgtX, y: tgtY, z: tgtZ };
        } else {
            const t = Math.min(1, this.smoothing * dt);
            this._smoothPos.x += (camX - this._smoothPos.x) * t;
            this._smoothPos.y += (camY - this._smoothPos.y) * t;
            this._smoothPos.z += (camZ - this._smoothPos.z) * t;
            this._smoothTarget.x += (tgtX - this._smoothTarget.x) * t;
            this._smoothTarget.y += (tgtY - this._smoothTarget.y) * t;
            this._smoothTarget.z += (tgtZ - this._smoothTarget.z) * t;
        }

        this._wasMoving = isMoving;
        return { position: { ...this._smoothPos }, target: { ...this._smoothTarget } };
    }

    snap() {
        this._smoothPos = null;
        this._smoothTarget = null;
        this._orbitYaw = 0;
        this._orbitPitchDelta = 0;
        this._anchorPitch = this._basePitch;
        this._currentPitch = null;
        this._preMovePitch = this._anchorPitch;
        this._wasMoving = false;
    }

    _clampOrbitPitch() {
        const minDelta = this._minTotalPitch - this._anchorPitch;
        const maxDelta = this._maxTotalPitch - this._anchorPitch;
        this._orbitPitchDelta = Math.max(minDelta, Math.min(maxDelta, this._orbitPitchDelta));
    }

    _clampPitch(pitch) {
        return Math.max(this._minTotalPitch, Math.min(this._maxTotalPitch, pitch));
    }

    _movePitchToward(current, target, speed, dt) {
        const clampedTarget = this._clampPitch(target);
        const maxStep = Math.max(0, speed) * Math.max(0, dt);
        const delta = clampedTarget - current;
        if (Math.abs(delta) <= maxStep) {
            return clampedTarget;
        }
        return current + Math.sign(delta) * maxStep;
    }

    _localUp(p) {
        if (!this._planetCenter) return { x: 0, y: 1, z: 0 };
        const dx = p.x - this._planetCenter.x;
        const dy = p.y - this._planetCenter.y;
        const dz = p.z - this._planetCenter.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        return { x: dx / l, y: dy / l, z: dz / l };
    }

    _tangentFrame(up, yaw) {
        const ref = Math.abs(up.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
        let rx = up.y * ref.z - up.z * ref.y;
        let ry = up.z * ref.x - up.x * ref.z;
        let rz = up.x * ref.y - up.y * ref.x;
        let rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;

        let fx = ry * up.z - rz * up.y;
        let fy = rz * up.x - rx * up.z;
        let fz = rx * up.y - ry * up.x;

        const c = Math.cos(yaw), s = Math.sin(yaw);
        const rot = (vx, vy, vz) => {
            const d = vx * up.x + vy * up.y + vz * up.z;
            const cx = up.y * vz - up.z * vy;
            const cy = up.z * vx - up.x * vz;
            const cz = up.x * vy - up.y * vx;
            return {
                x: vx * c + cx * s + up.x * d * (1 - c),
                y: vy * c + cy * s + up.y * d * (1 - c),
                z: vz * c + cz * s + up.z * d * (1 - c),
            };
        };
        return { fwd: rot(fx, fy, fz), right: rot(rx, ry, rz) };
    }
}
