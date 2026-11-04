/** Harness-owned camera. The renderer only needs these three public fields. */
export class OrbitCamera {
    constructor(canvas) {
        this.position = { x: 0, y: 0, z: 0 };
        this.matrixWorldInverse = { elements: new Float32Array(16) };
        this.projectionMatrix = { elements: new Float32Array(16) };
        this.yaw = 0.6;
        this.pitch = 0.35;
        this.distance = 6;
        this.events = new AbortController();
        const options = { signal: this.events.signal };
        canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId), options);
        canvas.addEventListener('pointermove', event => {
            if (!canvas.hasPointerCapture(event.pointerId)) return;
            this.yaw -= event.movementX * 0.008;
            this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + event.movementY * 0.008));
        }, options);
        canvas.addEventListener('pointerup', event => canvas.releasePointerCapture(event.pointerId), options);
        canvas.addEventListener('wheel', event => {
            event.preventDefault();
            this.distance = Math.max(3, Math.min(15, this.distance * Math.exp(event.deltaY * 0.001)));
        }, { ...options, passive: false });
    }

    update(aspect) {
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const x = sy * cp * this.distance;
        const y = sp * this.distance;
        const z = cy * cp * this.distance;
        Object.assign(this.position, { x, y, z });
        // Right-handed look-at, target at origin, column-major storage.
        this.matrixWorldInverse.elements.set([
            cy, -sy * sp, sy * cp, 0,
            0, cp, sp, 0,
            -sy, -cy * sp, cy * cp, 0,
            0, 0, -this.distance, 1,
        ]);
        const near = 0.1, far = 100, f = 1 / Math.tan(Math.PI / 6);
        // WebGPU depth is [0, 1].
        this.projectionMatrix.elements.set([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, far / (near - far), -1,
            0, 0, near * far / (near - far), 0,
        ]);
    }

    dispose() { this.events.abort(); }
}
