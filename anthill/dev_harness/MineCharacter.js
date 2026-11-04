export const MINER_DEFAULTS = Object.freeze({
    radius: 0.28, height: 1.8, speed: 3.2, miningSpeed: 1.6,
    gravity: 18, jumpSpeed: 6.5, terminalSpeed: 40, lethalSpeed: 12,
    stepHeight: 0.42, fixedStep: 1 / 120, maxFrameTime: 0.1,
    digInterval: 0.10, digReach: 1.55, digRadius: 1.03, digHeight: 1.01,
    aimSpeed: Math.PI / 3,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Harness-only kinematic prototype. No DOM, renderer or production gameplay dependencies.
 * `terrain` supplies bodyBlocked(position, radius, height), carve(shape), and toWorld(position).
 * Position is the feet in RegionFrame metres; input is a region-local horizontal intent.
 * Production Spherecraft's GPU actor solver must eventually consume voxel collision too;
 * this controller deliberately does not install itself in that heightfield-based solver.
 */
export class MineCharacter {
    constructor({ terrain, spawn, config = {} }) {
        this.terrain = terrain;
        this.config = { ...MINER_DEFAULTS, ...config };
        this.spawn = { ...spawn };
        this.deaths = 0;
        this.heading = Math.PI; // into the hillside from the east flank
        this.pitch = 0;
        this.respawn();
    }

    get worldPosition() { return this.terrain.toWorld(this.position); }
    get digDirection() {
        return { x: Math.cos(this.heading) * Math.cos(this.pitch), y: Math.sin(this.pitch), z: Math.sin(this.heading) * Math.cos(this.pitch) };
    }

    setPitch(radians) { this.pitch = clamp(radians, -Math.PI / 2, Math.PI / 2); }

    respawn() {
        this.position = { ...this.spawn };
        this.velocity = { x: 0, y: 0, z: 0 };
        this.alive = true;
        this.grounded = false;
        this.digging = false;
        this.deathReason = '';
        this.lastImpact = 0;
        this.phase = 0;
        this._accumulator = 0;
        this._digCooldown = 0;
        this._jumpHeld = false;
        this._jumpQueued = false;
    }

    /** Input: {moveX, moveZ, jump, dig, aim, heading?}. Explicit heading preserves look while strafing. */
    update(seconds, input = {}) {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        if (input.jump && !this._jumpHeld) this._jumpQueued = true;
        this._jumpHeld = !!input.jump;
        this._accumulator += Math.min(seconds, this.config.maxFrameTime);
        while (this._accumulator + 1e-10 >= this.config.fixedStep) {
            this._accumulator -= this.config.fixedStep;
            if (this.alive) this._step(this.config.fixedStep, input);
        }
    }

    _blocked(p) { return this.terrain.bodyBlocked(p, this.config.radius, this.config.height); }

    /** Swept in steps smaller than half a voxel, then bisected to the contact. */
    _move(axis, distance) {
        const p = this.position;
        const start = p[axis];
        const steps = Math.max(1, Math.ceil(Math.abs(distance) / (this.terrain.sweepStep ?? 0.08)));
        for (let i = 0; i < steps; i++) {
            const from = p[axis], to = from + distance / steps;
            p[axis] = to;
            if (!this._blocked(p)) continue;
            let clear = from, solid = to;
            for (let n = 0; n < 9; n++) {
                p[axis] = (clear + solid) / 2;
                if (this._blocked(p)) solid = p[axis]; else clear = p[axis];
            }
            p[axis] = clear;
            return { hit: true, moved: p[axis] - start };
        }
        return { hit: false, moved: p[axis] - start };
    }

    _walk(axis, distance, canStep) {
        if (!distance) return;
        const before = { ...this.position };
        const result = this._move(axis, distance);
        if (!result.hit || !canStep) return;
        const contact = { ...this.position };
        const count = Math.ceil(this.config.stepHeight / 0.05);
        for (let i = 1; i <= count; i++) {
            Object.assign(this.position, before);
            const up = this._move('y', Math.min(i * 0.05, this.config.stepHeight));
            const across = this._move(axis, distance);
            const down = this._move('y', -(up.moved + 0.05));
            // Use the lowest clear step: a full-height lift can hit a sloping ceiling.
            if (!across.hit && down.hit) return;
            if (up.hit) break;
        }
        Object.assign(this.position, contact);
    }

    _step(dt, input) {
        const c = this.config, p = this.position;
        this.setPitch(this.pitch + (input.aim || 0) * c.aimSpeed * dt);
        let mx = input.moveX || 0, mz = input.moveZ || 0;
        const length = Math.hypot(mx, mz);
        if (length > 1) { mx /= length; mz /= length; }
        if (Number.isFinite(input.heading)) this.heading = input.heading;
        else if (length > 0.001) this.heading = Math.atan2(mz, mx);
        this.digging = !!input.dig;
        this._digCooldown = Math.max(0, this._digCooldown - dt);
        if (this.digging && this._digCooldown <= 1e-9) {
            const d = this.digDirection;
            const point = reach => [p.x + d.x * reach, p.y + c.digHeight + d.y * reach, p.z + d.z * reach];
            this.terrain.carve({ type: 'capsule', a: point(0.45), b: point(c.digReach), radius: c.digRadius });
            this._digCooldown = c.digInterval;
        }
        const wasGrounded = this.grounded;
        if (this._jumpQueued) {
            if (wasGrounded) { this.velocity.y = c.jumpSpeed; this.grounded = false; }
            this._jumpQueued = false;
        }
        const canStep = wasGrounded && this.velocity.y <= 0;
        const speed = this.digging ? c.miningSpeed : c.speed;
        const oldX = p.x, oldZ = p.z;
        this._walk('x', mx * speed * dt, canStep);
        this._walk('z', mz * speed * dt, canStep);
        this.velocity.x = (p.x - oldX) / dt;
        this.velocity.z = (p.z - oldZ) / dt;
        this.phase += Math.hypot(p.x - oldX, p.z - oldZ) * 7;
        this.velocity.y = Math.max(-c.terminalSpeed, this.velocity.y - c.gravity * dt);
        const impact = -this.velocity.y;
        const vertical = this._move('y', this.velocity.y * dt);
        this.grounded = vertical.hit && this.velocity.y < 0;
        if (vertical.hit) {
            if (this.grounded) {
                this.lastImpact = impact;
                if (impact >= c.lethalSpeed) {
                    this.alive = false;
                    this.digging = false;
                    this.deaths++;
                    this.deathReason = `Fatal fall (${impact.toFixed(1)} m/s impact)`;
                }
            }
            this.velocity.y = 0;
        }
        // Stay on gentle down-slopes, but walk off shaft lips and fall under gravity.
        if (!this.grounded && canStep && this.alive) {
            const y = p.y;
            const snap = this._move('y', -c.stepHeight);
            if (snap.hit) { this.grounded = true; this.velocity.y = 0; }
            else p.y = y;
        }
    }
}
