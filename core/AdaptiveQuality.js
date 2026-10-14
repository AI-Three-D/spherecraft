import { requireBool, requireInt, requireNumber } from '../shared/requireUtil.js';

export function createAdaptiveQualityConfig(options = {}) {
    const config = {
        enabled: requireBool(options.enabled ?? false, 'rendering.adaptive.enabled'),
        stationaryFps: requireInt(options.stationaryFps ?? 30, 'rendering.adaptive.stationaryFps', 1),
        stationaryDelayMs: requireInt(options.stationaryDelayMs ?? 250, 'rendering.adaptive.stationaryDelayMs', 0),
        transitionMs: requireInt(options.transitionMs ?? 200, 'rendering.adaptive.transitionMs', 0),
        resizeIntervalMs: requireInt(options.resizeIntervalMs ?? 150, 'rendering.adaptive.resizeIntervalMs', 0),
    };
    const defaults = {
        stationaryPixelRatio: 1.0,
        motionPixelRatio: 0.85,
        fastMotionPixelRatio: 0.70,
        pixelRatioStep: 0.05,
        modestSpeedMps: 10,
        fastSpeedMps: 100,
        modestTurnSpeedRad: 0.5,
        fastTurnSpeedRad: 2.5,
        stationarySpeedMps: 0.05,
        stationaryTurnSpeedRad: 0.002,
    };
    for (const [key, fallback] of Object.entries(defaults)) {
        const value = requireNumber(options[key] ?? fallback, `rendering.adaptive.${key}`);
        if (value <= 0) throw new Error(`EngineConfig rendering.adaptive.${key} must be > 0`);
        config[key] = value;
    }
    if (config.fastSpeedMps <= config.modestSpeedMps || config.fastTurnSpeedRad <= config.modestTurnSpeedRad) {
        throw new Error('EngineConfig adaptive fast motion thresholds must exceed modest motion thresholds');
    }
    return config;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => a + (b - a) * t;
const length = v => Math.hypot(v.x, v.y, v.z);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function unit(v) {
    const magnitude = length(v) || 1;
    return { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude };
}
function angle(a, b) {
    // Chord length avoids acos losing precision near identical directions.
    return 2 * Math.asin(clamp(distance(a, b) / 2, 0, 1));
}
function motionLevel(speed, modest, fast) {
    return speed <= modest ? speed / modest : 1 + (speed - modest) / (fast - modest);
}

export class AdaptiveQualityController {
    constructor(rendering) {
        this.rendering = rendering;
        this.pixelRatio = rendering.pixelRatio;
        this.reset();
    }

    reset() {
        this._camera = null;
        this._sampleTime = null;
        this._updateTime = null;
        this._lastMotionTime = null;
        this._lastResizeTime = -Infinity;
        this._speed = 0;
        this._turnSpeed = 0;
        this._smoothRatio = this.pixelRatio;
        this.state = { mode: 'active', maxFps: this.rendering.maxFps, pixelRatio: this.pixelRatio, targetPixelRatio: this.pixelRatio };
    }

    // Call after each game update, so speed uses the simulation frame interval
    // rather than the faster rAF polling interval of a capped display.
    observeCamera(camera, nowMs) {
        if (!camera) return;
        const direction = unit({
            x: camera.target.x - camera.position.x,
            y: camera.target.y - camera.position.y,
            z: camera.target.z - camera.position.z,
        });
        const sample = { position: { ...camera.position }, direction, up: unit(camera.up ?? { x: 0, y: 1, z: 0 }), fov: camera.fov };
        const dt = this._sampleTime === null ? 0 : (nowMs - this._sampleTime) / 1000;
        if (this._camera && dt > 0) {
            this._speed = distance(sample.position, this._camera.position) / dt;
            this._turnSpeed = Math.max(angle(direction, this._camera.direction), angle(sample.up, this._camera.up)) / dt;
            const config = this.rendering.adaptive;
            if (this._speed > config.stationarySpeedMps || this._turnSpeed > config.stationaryTurnSpeedRad || sample.fov !== this._camera.fov) {
                this._lastMotionTime = nowMs;
            }
        }
        this._camera = sample;
        this._sampleTime = nowMs;
    }

    update(nowMs, { inputActive = false, forceActive = false } = {}) {
        const config = this.rendering.adaptive;
        const elapsed = this._updateTime === null ? 0 : Math.max(0, nowMs - this._updateTime);
        this._updateTime = nowMs;
        if (this._lastMotionTime === null || inputActive || forceActive) this._lastMotionTime = nowMs;
        const stationary = config.enabled && !forceActive && !inputActive
            && nowMs - this._lastMotionTime >= config.stationaryDelayMs;
        let level = clamp(Math.max(
            motionLevel(this._speed, config.modestSpeedMps, config.fastSpeedMps),
            motionLevel(this._turnSpeed, config.modestTurnSpeedRad, config.fastTurnSpeedRad),
            inputActive ? 1 : 0,
        ), 0, 2);
        if (stationary || forceActive) level = 0;
        const targetPixelRatio = !config.enabled ? this.rendering.pixelRatio
            : level <= 1 ? mix(config.stationaryPixelRatio, config.motionPixelRatio, level)
                : mix(config.motionPixelRatio, config.fastMotionPixelRatio, level - 1);
        const blend = config.transitionMs === 0 ? 1 : 1 - Math.exp(-elapsed / config.transitionMs);
        this._smoothRatio = mix(this._smoothRatio ?? this.pixelRatio, targetPixelRatio, blend);
        if (Math.abs(this._smoothRatio - targetPixelRatio) < 0.005) this._smoothRatio = targetPixelRatio;

        // Resize in small steps at most a few times per second. This avoids
        // continuously allocating depth, HDR, bloom and cloud textures.
        let desired = Math.round(this._smoothRatio / config.pixelRatioStep) * config.pixelRatioStep;
        if (this._smoothRatio === targetPixelRatio) desired = targetPixelRatio;
        if (desired <= 0) desired = targetPixelRatio;
        const ratioChanged = Math.abs(desired - this.pixelRatio) > 0.0001
            && nowMs - this._lastResizeTime >= config.resizeIntervalMs;
        if (ratioChanged) {
            this.pixelRatio = desired;
            this._lastResizeTime = nowMs;
        }
        const activeFps = this.rendering.maxFps;
        const maxFps = stationary ? (activeFps > 0 ? Math.min(activeFps, config.stationaryFps) : config.stationaryFps) : activeFps;
        this.state = {
            mode: !config.enabled ? 'disabled' : stationary ? 'stationary' : level >= 2 ? 'fast motion' : 'motion',
            maxFps, pixelRatio: this.pixelRatio, targetPixelRatio, ratioChanged,
        };
        return this.state;
    }
}
