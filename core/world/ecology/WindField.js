// @ts-nocheck
// One wind for everything that sways (ECOLOGY_FOUNDATION_PLAN.md F7; wind.wgsl.js). The weather gives the wind's way
// and speed; the gusts are 3D noise over the world, carried with the wind by an offset summed frame by frame, so a
// turning wind only changes where they go next (taken as the wind's way times the place, a turn swept the gusts across
// kilometres at once), and they are continuous across cube faces and at the poles. Grass bends and sways on it; trees'
// branches respond on top of it (their own).

export const WIND_FRAME_FLOATS = 8;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = a => scale(a, 1 / (length(a) || 1));

export class WindField {
    constructor(device, { label = 'Wind' } = {}) {
        this.device = device;
        this._f = new Float32Array(WIND_FRAME_FLOATS);
        this.buffer = device?.createBuffer({ label, size: WIND_FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        /** How far the wind has carried its gusts over the world (m, doubles). */
        this.carried = [0, 0, 0];
        this.direction = [1, 0, 0];
        this.speed = 0;
    }

    /**
     * dt (s); environment: the weather's (windSpeed m/s, windDirection {x, y} on the level); camRel: the camera from the
     * planet's centre (m); up, east: at the camera. Writes the uniform.
     */
    update({ dt, environment, camRel, up, east }) {
        const speed = Number.isFinite(environment?.windSpeed) ? environment.windSpeed : 3;
        const wd = environment?.windDirection;
        let wind = wd ? [wd.x, 0, wd.y] : [1, 0, 0];
        wind = sub(wind, scale(up, dot(wind, up)));
        wind = length(wind) > 1e-6 ? unit(wind) : east;
        this.carried = this.carried.map((c, i) => c + wind[i] * speed * 0.6 * dt);
        this.direction = wind;
        this.speed = speed;
        // Where the noise is read: the world less what the wind has carried, about the camera (a float of this is
        // centimetres off at 131 km; the gusts are 7.5 m and more across).
        const origin = sub(camRel, this.carried);
        this._f.set([...wind, speed, ...origin, 0.75 * Math.min(1, Math.max(0, speed / 22))]);
        if (this.buffer) this.device.queue.writeBuffer(this.buffer, 0, this._f);
        return { direction: wind, speed };
    }

    destroy() { this.buffer?.destroy(); }
}
