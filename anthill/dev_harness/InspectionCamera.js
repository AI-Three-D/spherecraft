import { AnthillCamera } from '../core/voxel/AnthillCamera.js';

/** Temporary harness camera. Region storage and cut geometry are independent of this controller. */
export class InspectionCamera extends AnthillCamera {
    constructor(source, { pixelRatio = 1 } = {}) {
        super({ frame: source.frame, plane: source.plane, metersPerPixel: source.metersPerPixel,
            eyeDistance: 600, depthBehind: 1000 });
        this.pixelRatio = pixelRatio;
        this.target = { x: source.plane.x(source.center.s), y: source.center.y, z: source.plane.z(source.center.s) };
        this.yaw = source.plane.angle;
        this.pitch = 0;
    }

    /** Resolution changes must preserve framing and the world distance per CSS pixel. */
    setPixelRatio(ratio) {
        this.metersPerPixel *= this.pixelRatio / ratio;
        this.pixelRatio = ratio;
    }

    orbit(dx, dy) {
        this.yaw -= dx * 0.005;
        this.pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, this.pitch + dy * 0.005));
    }

    pan(dx, dy) {
        const { right: r, up: u } = this.basis();
        for (const [key, i] of [['x', 0], ['y', 1], ['z', 2]])
            this.target[key] += (-dx * r[i] + dy * u[i]) * this.metersPerPixel;
    }

    zoomAt(factor) {
        this.metersPerPixel = Math.max(this.minMetersPerPixel, Math.min(this.maxMetersPerPixel, this.metersPerPixel * factor));
    }

    basis() {
        const c = Math.cos(this.yaw), s = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        return { right: [c, 0, s], up: [s*sp, cp, -c*sp], back: [-s*cp, sp, c*cp] };
    }

    update(width, height) {
        // Reuse projection setup; replace the view with a true orbit in region coordinates.
        super.update(width, height);
        const { right, up, back } = this.basis(), t = this.target;
        this.frame.localToWorld(t.x + back[0]*this.eyeDistance, t.y + back[1]*this.eyeDistance,
            t.z + back[2]*this.eyeDistance, this.position);
        const r = this.frame.directionToWorld(...right), u = this.frame.directionToWorld(...up), b = this.frame.directionToWorld(...back);
        const p = this.position;
        this.matrixWorldInverse.elements.set([
            r.x,u.x,b.x,0, r.y,u.y,b.y,0, r.z,u.z,b.z,0,
            -(r.x*p.x+r.y*p.y+r.z*p.z), -(u.x*p.x+u.y*p.y+u.z*p.z), -(b.x*p.x+b.y*p.y+b.z*p.z),1,
        ]);
    }
}
