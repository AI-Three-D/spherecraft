/**
 * Polylines in cut-plane coordinates -> triangle ribbons for the material path.
 * (The material pipeline is triangle-list only and binds vertex locations 0-3.)
 *
 *   position (loc 0) polyline point, frame coordinates
 *   normal   (loc 1) miter offset direction in frame coordinates, length = miter factor
 *   uv       (loc 2) (side -1 | +1, half width in pixels)
 *   color    (loc 3) rgba
 *
 * The vertex shader moves each vertex by normal * side * (halfWidth + 1) * metresPerPixel, so the
 * width is constant on screen. Colour and width are per vertex so one material draws every line:
 * material uniforms are written at draw time and cannot differ between draws in a frame.
 */
export class RibbonBuilder {
    constructor({ miterLimit = 4 } = {}) {
        this.miterLimit = miterLimit;
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.colors = [];
        this.indices = [];
    }

    get vertexCount() { return this.positions.length / 3; }

    /**
     * @param {ArrayLike<number>} points (s, y) pairs
     * @param {import('./CutPlane.js').CutPlane} plane
     * @param {number[]} color rgba
     * @param {number} widthPx
     */
    addPolyline(points, plane, color, widthPx) {
        const S = [], Y = [];
        for (let i = 0; i + 1 < points.length; i += 2) {
            const n = S.length;
            if (n && Math.hypot(points[i] - S[n - 1], points[i + 1] - Y[n - 1]) < 1e-9) continue;   // zero-length segment
            S.push(points[i]);
            Y.push(points[i + 1]);
        }
        const count = S.length;
        if (count < 2) return this;

        const ns = new Array(count - 1), ny = new Array(count - 1);          // unit normal per segment
        for (let j = 0; j < count - 1; j++) {
            const ds = S[j + 1] - S[j], dy = Y[j + 1] - Y[j], length = Math.hypot(ds, dy);
            ns[j] = -dy / length;
            ny[j] = ds / length;
        }

        const base = this.vertexCount, half = widthPx / 2;
        for (let j = 0; j < count; j++) {
            const a = Math.max(j - 1, 0), b = Math.min(j, count - 2);
            let os = ns[a] + ns[b], oy = ny[a] + ny[b];
            const length = Math.hypot(os, oy);
            if (length < 1e-6) {                                             // hairpin: no usable miter
                os = ns[b];
                oy = ny[b];
            } else {
                os /= length;
                oy /= length;
                const scale = 1 / Math.max(os * ns[b] + oy * ny[b], 1 / this.miterLimit);
                os *= scale;
                oy *= scale;
            }
            const x = plane.x(S[j]), z = plane.z(S[j]);
            for (const side of [-1, 1]) {
                this.positions.push(x, Y[j], z);
                this.normals.push(os * plane.dirX, oy, os * plane.dirZ);
                this.uvs.push(side, half);
                this.colors.push(color[0], color[1], color[2], color[3]);
            }
        }
        for (let j = 0; j < count - 1; j++) {
            const v = base + 2 * j;
            this.indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
        return this;
    }

    toArrays() {
        return {
            position: new Float32Array(this.positions),
            normal: new Float32Array(this.normals),
            uv: new Float32Array(this.uvs),
            color: new Float32Array(this.colors),
            // Uint32: the backend's writeBuffer needs a multiple of 4 bytes, which an odd Uint16 count is not.
            index: new Uint32Array(this.indices),
        };
    }
}