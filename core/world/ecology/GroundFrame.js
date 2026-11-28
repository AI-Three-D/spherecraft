// @ts-nocheck
// The faces about the camera and their anchors, once a frame (ECOLOGY_FOUNDATION_PLAN.md F2; drawnGround.wgsl.js). Each
// anchor is the patch under the camera on a face near enough, worked out in doubles relative to the camera, so shaders
// place anything as the anchor plus a small offset (groundPlace) and never handle a position some 131 km from the
// planet's centre as a float. One instance per reach: grass and the ground layer use one, a system reaching farther
// makes its own (a uniform buffer a frame).

import { ECO_FACES } from './ecologyLattice.js';
import { GROUND_FRAME_FLOATS, GROUND_LEVELS, GROUND_MAX_FACES } from './drawnGround.wgsl.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = a => scale(a, 1 / (length(a) || 1));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The patch grid's half width is capped (a dispatch of (2 half)^2 threads a face). */
export const GROUND_GRID_MAX = 256;

export class GroundFrame {
    constructor(device, { label = 'Ground frame' } = {}) {
        this.device = device;
        this._data = new ArrayBuffer(GROUND_FRAME_FLOATS * 4);
        this._f = new Float32Array(this._data);
        this._i = new Int32Array(this._data);
        this._u = new Uint32Array(this._data);
        this.buffer = device?.createBuffer({ label, size: GROUND_FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.faces = 0;
        this.widest = 0;
        this.faceList = [];
    }

    /**
     * camRel: the camera from the planet's centre (m, doubles); radius, heightScale (m); quadtree: the terrain's
     * QuadtreeGPU; reach: how far its users place things (m). Writes the uniform; returns { faces, widest }.
     */
    update({ camRel, radius, heightScale, quadtree, reach }) {
        const f = this._f, I = this._i, W = this._u;
        f.fill(0);
        const R = radius;
        const up = unit(camRel);
        const depth = quadtree.maxDepth;
        const patchesPerFace = 2 ** (depth + GROUND_LEVELS);
        let faces = 0, widest = 0;
        this.faceList = [];
        for (let face = 0; face < 6 && faces < GROUND_MAX_FACES; face++) {
            const F = ECO_FACES[face];
            const m = dot(up, F.axis);
            if (m < 0.3) continue;
            const uv = [(dot(up, F.u) / m + 1) / 2, (dot(up, F.v) / m + 1) / 2];
            // How far the face is: from the camera's place to the nearest point of it.
            const nearestUv = uv.map(t => clamp(t, 0, 1));
            const onFace = unit(add(F.axis, add(scale(F.u, 2 * nearestUv[0] - 1), scale(F.v, 2 * nearestUv[1] - 1))));
            const away = 2 * Math.asin(Math.min(1, length(sub(onFace, up)) / 2)) * R;
            if (away > reach + 8) continue;
            const anchor = uv.map(t => Math.floor(t * patchesPerFace));
            const ca = add(F.axis, add(scale(F.u, 2 * anchor[0] / patchesPerFace - 1), scale(F.v, 2 * anchor[1] / patchesPerFace - 1)));
            const la = length(ca), na = scale(ca, 1 / la);
            const da = sub(scale(na, R), camRel);
            const du = scale(F.u, 2 / patchesPerFace), dv = scale(F.v, 2 / patchesPerFace);
            // The sphere's metres per patch about the anchor.
            const jx = scale(sub(du, scale(na, dot(na, du))), R / la), jy = scale(sub(dv, scale(na, dot(na, dv))), R / la);
            const mx = length(jx), my = length(jy);
            const area = length(cross(jx, jy));
            const half = Math.min(GROUND_GRID_MAX, Math.ceil(reach / Math.min(mx, my)) + 1);
            widest = Math.max(widest, half);
            const o = 16 + faces * 24;
            f.set([...ca, la], o);
            f.set([...du, face], o + 4);
            f.set([...dv, Math.max(mx, my)], o + 8);
            f.set([...da, 0], o + 12);
            f.set([...na, area], o + 16);
            I.set([anchor[0], anchor[1], face, half], o + 20);
            this.faceList.push({ face, anchor, half, metres: [mx, my] });
            faces++;
        }
        f.set([...up, R], 0);
        const tableCapacity = quadtree.getLoadedTileTableCapacity();
        W.set([faces, depth, tableCapacity - 1, tableCapacity], 4);
        // The tiles drawn this frame: the quadtree has built them already in this encoder (TerrainModule.compute).
        W.set([quadtree.visibleTableMask, quadtree.visibleTableCapacity, quadtree._visibleEpoch, quadtree.maxGeomLOD], 8);
        f.set([heightScale, 2 * R, reach, 0], 12);
        this.faces = faces;
        this.widest = widest;
        if (faces && this.buffer) this.device.queue.writeBuffer(this.buffer, 0, this._data);
        return { faces, widest };
    }

    /** Bind-group entries for drawnGround's bindings, in its order: frame, loaded, visible, height (a texture view). */
    resources(quadtree, heightView) {
        return [{ buffer: this.buffer }, { buffer: quadtree.getLoadedTileTableBuffer() }, { buffer: quadtree._visibleTableBuffer }, heightView];
    }

    destroy() { this.buffer?.destroy(); }
}
