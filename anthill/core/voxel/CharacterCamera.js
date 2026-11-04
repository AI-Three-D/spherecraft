const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Perspective first/third-person camera in a RegionFrame. The target exposes
 * position (feet), heading, pitch and config.height, all in region coordinates.
 * Optional terrain.bodyBlocked supplies conservative boom collision against edits.
 * Input and DOM policy belong to the application.
 */
export class CharacterCamera {
    constructor({ frame, character, terrain = character.terrain, mode = 'third-person',
        fov = Math.PI * 70 / 180, near = 0.05, far = 1000, distance = 4.5,
        minDistance = 0.5, maxDistance = 12, collisionRadius = 0.16, sensitivity = 0.004 }) {
        Object.assign(this, { frame, character, terrain, fov, near, far, distance,
            minDistance, maxDistance, collisionRadius, sensitivity });
        this.setMode(mode);
        this.position = { x: 0, y: 0, z: 0 };
        this.localPosition = { x: 0, y: 0, z: 0 };
        this.matrixWorldInverse = { elements: new Float32Array(16) };
        this.projectionMatrix = { elements: new Float32Array(16) };
    }

    setMode(mode) {
        if (!['first-person', 'third-person'].includes(mode))
            throw new RangeError(`CharacterCamera: unknown mode ${mode}`);
        this.mode = mode;
    }

    look(dx, dy) {
        if (!this.character.alive) return;
        this.character.heading += dx * this.sensitivity;
        this.character.setPitch(clamp(this.character.pitch - dy * this.sensitivity,
            -Math.PI * 0.49, Math.PI * 0.49));
    }

    /** Camera-relative ground movement; strafing/backing up preserves aim. */
    movement(right, forward) {
        const c = Math.cos(this.character.heading), s = Math.sin(this.character.heading);
        return { moveX: forward * c - right * s, moveZ: forward * s + right * c,
            heading: this.character.heading };
    }

    zoomAt(factor) {
        if (this.mode === 'third-person')
            this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
    }

    _clearDistance(target, back) {
        if (!this.terrain?.bodyBlocked) return this.distance;
        const r = this.collisionRadius;
        const blocked = distance => this.terrain.bodyBlocked({
            x: target.x + back[0] * distance,
            y: target.y + back[1] * distance - r,
            z: target.z + back[2] * distance,
        }, r, r * 2, 0);
        const steps = Math.ceil(this.distance / (this.terrain.sweepStep ?? 0.08));
        let clear = 0;
        for (let i = 1; i <= steps; i++) {
            let solid = this.distance * i / steps;
            if (!blocked(solid)) { clear = solid; continue; }
            for (let j = 0; j < 8; j++) {
                const mid = (clear + solid) / 2;
                if (blocked(mid)) solid = mid; else clear = mid;
            }
            return clear;
        }
        return this.distance;
    }

    update(width, height) {
        const a = this.character;
        const c = Math.cos(a.heading), s = Math.sin(a.heading);
        const cp = Math.cos(a.pitch), sp = Math.sin(a.pitch);
        const right = [-s, 0, c], up = [-c * sp, cp, -s * sp], back = [-c * cp, -sp, -s * cp];
        const target = { ...a.position, y: a.position.y + a.config.height * 0.9 };
        this.actualDistance = this.mode === 'first-person' ? 0 : this._clearDistance(target, back);
        this.hideCharacter = this.actualDistance < 0.45;
        const local = this.localPosition;
        Object.assign(local, { x: target.x + back[0] * this.actualDistance,
            y: target.y + back[1] * this.actualDistance, z: target.z + back[2] * this.actualDistance });
        this.frame.localToWorld(local.x, local.y, local.z, this.position);
        const r = this.frame.directionToWorld(...right), u = this.frame.directionToWorld(...up), b = this.frame.directionToWorld(...back);
        const p = this.position;
        this.matrixWorldInverse.elements.set([
            r.x,u.x,b.x,0, r.y,u.y,b.y,0, r.z,u.z,b.z,0,
            -(r.x*p.x+r.y*p.y+r.z*p.z), -(u.x*p.x+u.y*p.y+u.z*p.z), -(b.x*p.x+b.y*p.y+b.z*p.z),1,
        ]);
        const f = 1 / Math.tan(this.fov / 2), n = this.near, far = this.far;
        // Right-handed perspective, WebGPU depth [0, 1].
        this.projectionMatrix.elements.set([
            f * height / width,0,0,0, 0,f,0,0,
            0,0,far/(n-far),-1, 0,0,n*far/(n-far),0,
        ]);
    }
}
