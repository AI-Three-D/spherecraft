// Free-fly camera around a planet centred at the origin (units: km).
// The horizon stays level with the local up; the frame is parallel-transported
// as the camera moves, so there is no pole singularity.

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => scale(a, 1 / (length(a) || 1));

function rotate(v, axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return add(add(scale(v, c), cross(axis, v), s), axis, dot(axis, v) * (1 - c));
}

/** Local frame on the sphere: the lab "site" is +Y with north -Z and east +X. */
export function localFrame(up) {
    const north = normalize(add([0, 0, -1], up, -dot([0, 0, -1], up)));
    return { up, north, east: cross(north, up) };
}

/** Direction for a site-relative latitude/longitude offset in degrees. */
export function siteDirection(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
    return normalize([Math.sin(lon) * Math.cos(lat), Math.cos(lon) * Math.cos(lat), -Math.sin(lat)]);
}

const MOVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight',
]);

export class FlyCamera {
    constructor(canvas, { planetRadiusKm, fovDeg = 60 }) {
        this.radius = planetRadiusKm;
        this.fov = fovDeg * Math.PI / 180;
        this.position = { x: 0, y: planetRadiusKm + 0.3, z: 0 };
        this.matrixWorldInverse = { elements: new Float32Array(16) };
        this.projectionMatrix = { elements: new Float32Array(16) };
        this.forward = [0, 0, -1];
        this.right = [1, 0, 0];
        this.up = [0, 1, 0];
        this.speedMultiplier = 1;
        this.speedKmS = 0;
        this.keys = new Set();
        this._lastUp = [0, 1, 0];
        this._look = [0, 0];
        this.events = new AbortController();
        const options = { signal: this.events.signal };
        canvas.addEventListener('pointerdown', (event) => {
            canvas.setPointerCapture(event.pointerId);
            canvas.focus?.();
        }, options);
        canvas.addEventListener('pointermove', (event) => {
            if (!canvas.hasPointerCapture(event.pointerId)) return;
            const k = 0.0022 * (this.fov / (Math.PI / 3));
            this._look[0] += event.movementX * k;
            this._look[1] -= event.movementY * k;
        }, options);
        canvas.addEventListener('pointerup', (event) => canvas.releasePointerCapture(event.pointerId), options);
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.speedMultiplier = Math.min(50, Math.max(0.02, this.speedMultiplier * Math.exp(-event.deltaY * 0.0015)));
        }, { ...options, passive: false });
        const typing = (event) => event.target instanceof HTMLElement && event.target.closest('input, select, textarea');
        window.addEventListener('keydown', (event) => {
            if (typing(event) || !MOVE_KEYS.has(event.code)) return;
            this.keys.add(event.code);
            event.preventDefault();
        }, options);
        window.addEventListener('keyup', (event) => this.keys.delete(event.code), options);
        window.addEventListener('blur', () => this.keys.clear(), options);
    }

    get altitudeKm() { return length(this._pos()) - this.radius; }

    /** Place the camera at a site-relative spot, heading in degrees (0 = north, 90 = east). */
    setView({ latDeg = 0, lonDeg = 0, altitudeKm, headingDeg = 0, pitchDeg = 0 }) {
        const up = siteDirection(latDeg, lonDeg);
        const { north, east } = localFrame(up);
        const heading = headingDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
        const horizontal = add(scale(north, Math.cos(heading)), east, Math.sin(heading));
        this.forward = normalize(add(scale(horizontal, Math.cos(pitch)), up, Math.sin(pitch)));
        const p = scale(up, this.radius + altitudeKm);
        Object.assign(this.position, { x: p[0], y: p[1], z: p[2] });
        this._lastUp = up;
        this._look = [0, 0];
    }

    update(deltaTime, aspect) {
        let pos = this._pos();
        const altitude = Math.max(0, length(pos) - this.radius);
        const k = this.keys;
        const axis = (a, b) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
        const boost = (k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1) * (k.has('AltLeft') || k.has('AltRight') ? 0.15 : 1);
        this.speedKmS = Math.max(0.05, altitude) * 0.4 * this.speedMultiplier * boost;
        const localUp = normalize(pos);
        const forwardInput = axis('KeyW', 'KeyS') + axis('ArrowUp', 'ArrowDown');
        const strafeInput = axis('KeyD', 'KeyA') + axis('ArrowRight', 'ArrowLeft');
        const liftInput = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
        const step = this.speedKmS * deltaTime;
        pos = add(pos, this.forward, forwardInput * step);
        pos = add(pos, this.right, strafeInput * step);
        pos = add(pos, localUp, liftInput * step);
        const minRadius = this.radius + 0.005;
        if (length(pos) < minRadius) pos = scale(normalize(pos), minRadius);
        Object.assign(this.position, { x: pos[0], y: pos[1], z: pos[2] });

        // Carry the view along the sphere, then apply mouse look about the local up.
        const up = normalize(pos);
        const transport = cross(this._lastUp, up);
        const sinAngle = length(transport);
        if (sinAngle > 1e-12) this.forward = rotate(this.forward, scale(transport, 1 / sinAngle), Math.asin(Math.min(1, sinAngle)));
        this._lastUp = up;
        this.forward = rotate(this.forward, up, -this._look[0]);
        const limit = 89.5 * Math.PI / 180;
        const pitch = Math.max(-limit, Math.min(limit, Math.asin(Math.max(-1, Math.min(1, dot(this.forward, up)))) + this._look[1]));
        let horizontal = add(this.forward, up, -dot(this.forward, up));
        if (length(horizontal) < 1e-6) horizontal = localFrame(up).north;
        horizontal = normalize(horizontal);
        this.forward = normalize(add(scale(horizontal, Math.cos(pitch)), up, Math.sin(pitch)));
        this._look = [0, 0];
        this.right = normalize(cross(this.forward, up));
        this.up = cross(this.right, this.forward);

        const back = scale(this.forward, -1);
        const r = this.right, u = this.up;
        this.matrixWorldInverse.elements.set([
            r[0], u[0], back[0], 0,
            r[1], u[1], back[1], 0,
            r[2], u[2], back[2], 0,
            -dot(r, pos), -dot(u, pos), -dot(back, pos), 1,
        ]);
        const near = 0.001, far = 1e5, f = 1 / Math.tan(this.fov / 2);
        this.projectionMatrix.elements.set([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, far / (near - far), -1,
            0, 0, near * far / (near - far), 0,
        ]);
    }

    _pos() { return [this.position.x, this.position.y, this.position.z]; }

    dispose() { this.events.abort(); }
}
