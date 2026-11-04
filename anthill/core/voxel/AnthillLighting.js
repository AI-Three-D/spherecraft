export const MAX_ANTHILL_LIGHTS = 32;
export const LIGHTING_HEADER_FLOATS = 24;

const finite = (value, name, minimum = -Infinity) => {
    if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`);
    return value;
};
const positionArray = position => {
    const values = Array.isArray(position) ? position : [position?.x, position?.y, position?.z];
    if (values.length !== 3) throw new Error('Light position requires three region-local coordinates');
    return values.map(value => finite(value, 'Light position'));
};
function lightDescription(options, seed) {
    const kind = options.kind ?? 'torch';
    if (!['torch', 'lantern'].includes(kind)) throw new Error('Light kind must be torch or lantern');
    const color = options.color ?? (kind === 'torch' ? [1, 0.48, 0.16] : [1, 0.78, 0.43]);
    if (!Array.isArray(color) || color.length !== 3) throw new Error('Light color requires three components');
    const radius = finite(options.radius ?? 12, 'Light radius', Number.MIN_VALUE);
    const flicker = finite(options.flicker ?? (kind === 'torch' ? 0.18 : 0), 'Light flicker', 0);
    if (flicker > 1) throw new Error('Light flicker must be <= 1');
    return { kind, position: positionArray(options.position), radius,
        color: color.map(value => finite(value, 'Light color', 0)),
        intensity: finite(options.intensity ?? 3.5, 'Light intensity', 0), flicker,
        enabled: options.enabled !== false, seed };
}

/** Anthill-only lighting. Positions and sun direction use the region's local frame.
 * The GPU payload is shared by terrain and actors; no world-origin floats are uploaded.
 * One light slot is reserved for the carried torch. Installed lights persist independently.
 */
export class AnthillLighting {
    constructor({ timeOfDay = 9, dayDuration = 240, sunIntensity = 1.5, ambient = 0.025 } = {}) {
        this.dayDuration = finite(dayDuration, 'Day duration', Number.MIN_VALUE);
        this.sunIntensity = finite(sunIntensity, 'Sun intensity', 0);
        this.ambient = finite(ambient, 'Ambient light', 0);
        this.setTimeOfDay(timeOfDay);
        this.running = true;
        this.lights = new Map();
        this.nextId = 1;
        this.carried = lightDescription({ position: [0, 0, 0], enabled: false }, 0);
        this.data = new Float32Array(LIGHTING_HEADER_FLOATS + MAX_ANTHILL_LIGHTS * 8);
        this.occluder = null;
        this.update();
    }

    setTimeOfDay(hour) { this.timeOfDay = ((finite(hour, 'Time of day') % 24) + 24) % 24; }

    addLight(options) {
        if (this.lights.size >= MAX_ANTHILL_LIGHTS - 1) throw new Error(`At most ${MAX_ANTHILL_LIGHTS - 1} installed lights are supported`);
        const id = this.nextId;
        this.lights.set(id, lightDescription(options, id));
        this.nextId++;
        return id;
    }

    updateLight(id, changes) {
        const previous = this.lights.get(id);
        if (!previous) throw new Error(`Unknown light ${id}`);
        this.lights.set(id, lightDescription({ ...previous, ...changes }, previous.seed));
    }

    removeLight(id) { return this.lights.delete(id); }

    setCarriedLight(position, enabled = true) {
        this.carried.position = positionArray(position);
        this.carried.enabled = !!enabled;
    }

    /** Region-local bounds for the optional soft capsule shadow cast by the character. */
    setOccluder(min, max) {
        if (!min || !max) { this.occluder = null; return; }
        const lower = positionArray(min), upper = positionArray(max);
        if (lower.some((value, i) => value >= upper[i])) throw new Error('Occluder bounds must have positive size');
        this.occluder = { min: lower, max: upper };
    }

    update({ deltaTime = 0, time = 0 } = {}) {
        finite(deltaTime, 'Lighting delta', 0); finite(time, 'Lighting time');
        if (this.running) this.setTimeOfDay(this.timeOfDay + deltaTime * 24 / this.dayDuration);
        const angle = (this.timeOfDay - 6) * Math.PI / 12;
        const elevation = Math.sin(angle);
        const x = Math.cos(angle), z = x * 0.32;
        const length = Math.hypot(x, elevation, z);
        const daylight = Math.min(1, Math.max(0, elevation * 6));
        const warmth = Math.min(1, Math.max(0, elevation * 3));
        this.data.set([x / length, elevation / length, z / length, this.sunIntensity * daylight], 0);
        this.data.set([1, 0.55 + warmth * 0.4, 0.3 + warmth * 0.58, 0], 4);
        this.data.set([this.ambient * 0.8, this.ambient, this.ambient * 1.3, 0], 8);
        let count = 0;
        const pack = light => {
            if (!light.enabled || light.intensity === 0) return;
            const phase = time * 11 + light.seed * 2.399963;
            const pulse = (Math.sin(phase) + 0.5 * Math.sin(phase * 2.17 + 1.3)
                + 0.25 * Math.sin(phase * 4.31 + 0.7)) / 1.75;
            const intensity = light.intensity * (1 + light.flicker * pulse);
            const offset = LIGHTING_HEADER_FLOATS + count++ * 8;
            this.data.set([...light.position, light.radius, ...light.color, intensity], offset);
        };
        pack(this.carried);
        for (const light of this.lights.values()) pack(light);
        this.data[11] = count;
        this.data.set(this.occluder ? [...this.occluder.min, 1] : [0, 0, 0, 0], 16);
        this.data.set(this.occluder ? [...this.occluder.max, 0] : [0, 0, 0, 0], 20);
        this.data[12] = this.carried.enabled && this.carried.intensity > 0 ? this.data[31] : 0;
        return this.data;
    }
}
