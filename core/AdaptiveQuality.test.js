import { describe, expect, it } from 'vitest';
import { AdaptiveQualityController, createAdaptiveQualityConfig } from './AdaptiveQuality.js';

function setup(overrides = {}, maxFps = 60) {
    const rendering = {
        maxFps, pixelRatio: 1,
        adaptive: createAdaptiveQualityConfig({ enabled: true, ...overrides }),
    };
    return { rendering, quality: new AdaptiveQualityController(rendering) };
}
function camera(x = 0, turn = 0) {
    return { position: { x, y: 0, z: 0 }, target: { x: x + Math.sin(turn), y: 0, z: -Math.cos(turn) }, fov: 60 };
}

describe('adaptive power saving', () => {
    it('enters the stationary cap at 250 ms and lifts it immediately on input', () => {
        const { quality } = setup();
        quality.update(0);
        expect(quality.update(249).maxFps).toBe(60);
        expect(quality.update(250).maxFps).toBe(30);
        expect(quality.update(251, { inputActive: true }).maxFps).toBe(60);
        expect(quality.state.targetPixelRatio).toBeCloseTo(0.85);
        expect(quality.update(500).maxFps).toBe(60);
        expect(quality.update(501).maxFps).toBe(30);
    });

    it('respects a lower active cap and allows an unlimited active cap', () => {
        for (const [active, idle] of [[20, 20], [0, 30]]) {
            const { quality } = setup({}, active);
            quality.update(0);
            expect(quality.update(250).maxFps).toBe(idle);
            expect(quality.update(251, { inputActive: true }).maxFps).toBe(active);
        }
    });

    it('keeps loading active and avoids lowering its resolution', () => {
        const { quality } = setup();
        quality.observeCamera(camera(), 0);
        quality.observeCamera(camera(100), 100);
        for (let now = 0; now <= 1000; now += 100) {
            expect(quality.update(now, { forceActive: true }).maxFps).toBe(60);
            expect(quality.state.targetPixelRatio).toBe(1);
        }
    });

    it('interpolates all three ratios with translation speed and detects motion without held keys', () => {
        const { quality } = setup();
        quality.observeCamera(camera(), 0);
        quality.update(0);
        quality.observeCamera(camera(5), 1000);
        expect(quality.update(1000).targetPixelRatio).toBeCloseTo(0.925);
        expect(quality.state.maxFps).toBe(60);
        quality.observeCamera(camera(15), 2000);
        expect(quality.update(2000).targetPixelRatio).toBeCloseTo(0.85);
        quality.observeCamera(camera(70), 3000);
        expect(quality.update(3000).targetPixelRatio).toBeCloseTo(0.775);
        quality.observeCamera(camera(170), 4000);
        expect(quality.update(4000).targetPixelRatio).toBeCloseTo(0.70);
    });

    it('detects turning and ignores tiny camera jitter', () => {
        const { quality } = setup();
        quality.observeCamera(camera(), 0);
        quality.update(0);
        quality.observeCamera(camera(0, 0.5), 1000);
        expect(quality.update(1000).targetPixelRatio).toBeCloseTo(0.85);
        quality.observeCamera(camera(0, 0.500001), 1100);
        expect(quality.update(1250).mode).toBe('stationary');
    });

    it('smooths resolution changes, bounds resize frequency, and returns to exact configured ratios', () => {
        const { quality } = setup({ fastMotionPixelRatio: 0.73 });
        quality.observeCamera(camera(), 0);
        quality.update(0);
        quality.observeCamera(camera(100), 1000);
        const first = quality.update(1000);
        expect(first.pixelRatio).toBeLessThan(1);
        let lastResize = 1000;
        for (let now = 1010; now <= 2200; now += 10) {
            quality.observeCamera(camera(100 + (now - 1000)), now);
            const state = quality.update(now);
            if (state.ratioChanged) {
                expect(now - lastResize).toBeGreaterThanOrEqual(150);
                lastResize = now;
            }
        }
        expect(quality.state.pixelRatio).toBe(0.73);
        quality.observeCamera(camera(1300), 2300);
        quality.observeCamera(camera(1300), 2400);
        for (let now = 2400; now <= 4200; now += 10) quality.update(now);
        expect(quality.state.mode).toBe('stationary');
        expect(quality.state.pixelRatio).toBe(1);
    });

    it('leaves the static settings in effect when disabled', () => {
        const { quality, rendering } = setup({ enabled: false });
        quality.update(0);
        expect(quality.update(1000).maxFps).toBe(60);
        rendering.pixelRatio = 1.25;
        for (let now = 1010; now <= 2500; now += 10) quality.update(now);
        expect(quality.state.pixelRatio).toBe(1.25);
        expect(quality.state.mode).toBe('disabled');
    });

    it('restarts the stillness timer on resume without treating a camera teleport as sustained motion', () => {
        const { quality } = setup();
        quality.update(0);
        quality.update(250);
        quality.reset();
        quality.observeCamera(camera(10000), 60000);
        expect(quality.update(60000).maxFps).toBe(60);
        expect(quality.update(60250).maxFps).toBe(30);
    });

    it('validates quality and motion settings', () => {
        for (const overrides of [{ stationaryFps: 0 }, { stationaryPixelRatio: 0 }, { enabled: 'yes' },
            { fastSpeedMps: 5 }, { transitionMs: -1 }, { pixelRatioStep: NaN }]) {
            expect(() => createAdaptiveQualityConfig(overrides)).toThrow();
        }
    });
});
