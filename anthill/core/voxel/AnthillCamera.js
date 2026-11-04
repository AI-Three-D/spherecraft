const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Orthographic camera looking straight at a cut plane, with pan and zoom in plane coordinates.
 * Exposes the three fields the renderer contract needs: position (doubles, world space),
 * matrixWorldInverse and projectionMatrix (column-major float32, WebGPU depth [0, 1]).
 * No DOM access; the application feeds it pointer input in canvas pixels.
 */
export class AnthillCamera {
    constructor({ frame, plane, center = { s: 0, y: 0 }, metersPerPixel = 0.25,
        minMetersPerPixel = 0.002, maxMetersPerPixel = 8, eyeDistance = 100, depthBehind = 400 }) {
        this.frame = frame;
        this.plane = plane;
        this.center = { s: center.s, y: center.y };
        this.metersPerPixel = metersPerPixel;
        this.minMetersPerPixel = minMetersPerPixel;
        this.maxMetersPerPixel = maxMetersPerPixel;
        this.eyeDistance = eyeDistance;       // metres in front of the plane
        this.depthBehind = depthBehind;       // metres visible behind the plane
        this.viewport = { width: 1, height: 1 };
        this.position = { x: 0, y: 0, z: 0 };
        this.matrixWorldInverse = { elements: new Float32Array(16) };
        this.projectionMatrix = { elements: new Float32Array(16) };
    }

    /** Plane coordinates under a canvas pixel (origin top-left, y down). */
    screenToPlane(px, py) {
        return {
            s: this.center.s + (px - this.viewport.width / 2) * this.metersPerPixel,
            y: this.center.y - (py - this.viewport.height / 2) * this.metersPerPixel,
        };
    }

    planeToScreen(s, y) {
        return {
            x: this.viewport.width / 2 + (s - this.center.s) / this.metersPerPixel,
            y: this.viewport.height / 2 - (y - this.center.y) / this.metersPerPixel,
        };
    }

    /** Drag by a pixel delta: the content follows the pointer. */
    pan(dxPixels, dyPixels) {
        this.center.s -= dxPixels * this.metersPerPixel;
        this.center.y += dyPixels * this.metersPerPixel;
    }

    /** Turn the cut around the current view centre without losing the area being inspected. */
    rotateQuarterTurns(turns) {
        this.turn = null;
        const x = this.plane.x(this.center.s), z = this.plane.z(this.center.s);
        this.plane.rotateQuarterTurns(turns, x, z);
        this.center.s = this.plane.project(x, z).s;
    }

    /** Animate a turn in seconds; retargeting preserves angular velocity and the pivot. */
    startTurn(turns, duration = 0.35) {
        if (!Number.isInteger(turns) || !Number.isFinite(duration) || duration <= 0)
            throw new RangeError('AnthillCamera: integer turns and positive duration required');
        if (!turns) return;
        const old = this.turn;
        this.turn = {
            from: this.plane.angle, to: (old?.to ?? this.plane.angle) + turns * Math.PI / 2,
            velocity: old?.currentVelocity ?? 0, currentVelocity: old?.currentVelocity ?? 0,
            x: old?.x ?? this.plane.x(this.center.s), z: old?.z ?? this.plane.z(this.center.s),
            elapsed: 0, duration,
        };
    }

    advanceTurn(seconds) {
        const t = this.turn;
        if (!t) return;
        t.elapsed = Math.min(t.duration, t.elapsed + Math.max(0, seconds));
        const u = t.elapsed / t.duration;
        const angle = (2*u*u*u - 3*u*u + 1)*t.from
            + (u*u*u - 2*u*u + u)*t.duration*t.velocity + (-2*u*u*u + 3*u*u)*t.to;
        t.currentVelocity = ((6*u*u - 6*u)*t.from + (-6*u*u + 6*u)*t.to) / t.duration
            + (3*u*u - 4*u + 1)*t.velocity;
        this.plane.set(u === 1 ? t.to : angle, 0);
        this.plane.offset = t.x * this.plane.normalX + t.z * this.plane.normalZ;
        this.center.s = this.plane.project(t.x, t.z).s;
        if (u === 1) this.turn = null;
    }

    finishTurn() {
        if (this.turn) this.advanceTurn(this.turn.duration);
    }

    /** Scale metres-per-pixel by `factor`, keeping the plane point under (px, py) fixed. */
    zoomAt(factor, px, py) {
        const before = this.screenToPlane(px, py);
        this.metersPerPixel = clamp(this.metersPerPixel * factor, this.minMetersPerPixel, this.maxMetersPerPixel);
        const after = this.screenToPlane(px, py);
        this.center.s += before.s - after.s;
        this.center.y += before.y - after.y;
    }

    /** Show the rectangle [s0, s1] x [y0, y1] (uses the viewport from the last update). */
    fit(s0, s1, y0, y1) {
        this.center.s = (s0 + s1) / 2;
        this.center.y = (y0 + y1) / 2;
        this.metersPerPixel = clamp(
            Math.max((s1 - s0) / this.viewport.width, (y1 - y0) / this.viewport.height),
            this.minMetersPerPixel, this.maxMetersPerPixel);
    }

    update(width, height) {
        this.viewport.width = width;
        this.viewport.height = height;
        const { frame, plane, center } = this;
        const right = frame.directionToWorld(plane.dirX, 0, plane.dirZ);
        const up = frame.axisY;
        const back = frame.directionToWorld(plane.normalX, 0, plane.normalZ);   // right x up, toward the viewer
        frame.localToWorld(
            plane.x(center.s) + plane.normalX * this.eyeDistance,
            center.y,
            plane.z(center.s) + plane.normalZ * this.eyeDistance,
            this.position);
        const p = this.position, v = this.matrixWorldInverse.elements;
        v[0] = right.x; v[1] = up.x; v[2] = back.x; v[3] = 0;
        v[4] = right.y; v[5] = up.y; v[6] = back.y; v[7] = 0;
        v[8] = right.z; v[9] = up.z; v[10] = back.z; v[11] = 0;
        // Contract-complete but only centimetre-accurate in float32; voxel modules rebuild it from `position`.
        v[12] = -(right.x * p.x + right.y * p.y + right.z * p.z);
        v[13] = -(up.x * p.x + up.y * p.y + up.z * p.z);
        v[14] = -(back.x * p.x + back.y * p.y + back.z * p.z);
        v[15] = 1;
        const w = width * this.metersPerPixel, h = height * this.metersPerPixel;
        const far = this.eyeDistance + this.depthBehind;
        this.projectionMatrix.elements.set([
            2 / w, 0, 0, 0,
            0, 2 / h, 0, 0,
            0, 0, -1 / far, 0,
            0, 0, 0, 1,
        ]);
    }
}
