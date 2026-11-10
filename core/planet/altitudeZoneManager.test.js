import { describe, it, expect, beforeEach } from 'vitest';
import { AltitudeZoneManager, AltitudeZone } from './altitudeZoneManager.js';

// Minimal planet config used by all tests.
// origin = {x,y,z} plain object; subVectors only needs .x/.y/.z
const PLANET_RADIUS = 6_000_000; // 6000 km
const planetConfig = {
    origin: { x: 0, y: 0, z: 0 },
    radius: PLANET_RADIUS,
    surfaceChunkSize: 128,
};

function makeManager() {
    return new AltitudeZoneManager(planetConfig);
}

// Simulate a camera at `altitude` metres directly above the planet's north pole.
function updateAtAltitude(mgr, altitude) {
    const pos = { x: 0, y: PLANET_RADIUS + altitude, z: 0 };
    mgr.update(pos, 0.016);
}

// ── Zone classification ────────────────────────────────────────────────────────

describe('AltitudeZoneManager – zone classification', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('starts in SURFACE zone', () => {
        expect(mgr.currentZone).toBe(AltitudeZone.SURFACE);
    });

    it('classifies 0 m as SURFACE', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.currentZone).toBe(AltitudeZone.SURFACE);
    });

    it('classifies 499 m as SURFACE', () => {
        updateAtAltitude(mgr, 499);
        expect(mgr.currentZone).toBe(AltitudeZone.SURFACE);
    });

    it('classifies 500 m as LOW_ALTITUDE', () => {
        updateAtAltitude(mgr, 500);
        expect(mgr.currentZone).toBe(AltitudeZone.LOW_ALTITUDE);
    });

    it('classifies 2000 m as MEDIUM_ALTITUDE', () => {
        updateAtAltitude(mgr, 2000);
        expect(mgr.currentZone).toBe(AltitudeZone.MEDIUM_ALTITUDE);
    });

    it('classifies 5000 m as HIGH_ALTITUDE', () => {
        updateAtAltitude(mgr, 5000);
        expect(mgr.currentZone).toBe(AltitudeZone.HIGH_ALTITUDE);
    });

    it('classifies 15000 m as ORBITAL', () => {
        updateAtAltitude(mgr, 15000);
        expect(mgr.currentZone).toBe(AltitudeZone.ORBITAL);
    });

    it('classifies very high altitude as ORBITAL', () => {
        updateAtAltitude(mgr, 1_000_000);
        expect(mgr.currentZone).toBe(AltitudeZone.ORBITAL);
    });
});

// ── Terrain detail levels ──────────────────────────────────────────────────────

describe('AltitudeZoneManager – terrain detail level', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('level 0 at surface', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.terrainDetailLevel).toBe(0);
    });

    it('level 1 at low altitude', () => {
        updateAtAltitude(mgr, 1000);
        expect(mgr.terrainDetailLevel).toBe(1);
    });

    it('level 2 at medium altitude', () => {
        updateAtAltitude(mgr, 3000);
        expect(mgr.terrainDetailLevel).toBe(2);
    });

    it('level 3 at high altitude', () => {
        updateAtAltitude(mgr, 10000);
        expect(mgr.terrainDetailLevel).toBe(3);
    });

    it('level 4 at orbital', () => {
        updateAtAltitude(mgr, 20000);
        expect(mgr.terrainDetailLevel).toBe(4);
    });
});

// ── Render-flag helpers ────────────────────────────────────────────────────────

describe('AltitudeZoneManager – render flags', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('shouldRenderFeatures is true at surface', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.shouldRenderFeatures()).toBe(true);
    });

    it('shouldRenderFeatures is false at medium altitude', () => {
        updateAtAltitude(mgr, 3000);
        expect(mgr.shouldRenderFeatures()).toBe(false);
    });

    it('shouldRenderSplats is true at low altitude', () => {
        updateAtAltitude(mgr, 1000);
        expect(mgr.shouldRenderSplats()).toBe(true);
    });

    it('shouldRenderSplats is false at medium altitude', () => {
        updateAtAltitude(mgr, 3000);
        expect(mgr.shouldRenderSplats()).toBe(false);
    });

    it('shouldUseShadows is true only at surface', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.shouldUseShadows()).toBe(true);
        updateAtAltitude(mgr, 1000);
        expect(mgr.shouldUseShadows()).toBe(false);
    });

    it('shouldRenderChunkAsQuad starts at medium detail', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.shouldRenderChunkAsQuad()).toBe(false);
        updateAtAltitude(mgr, 3000);
        expect(mgr.shouldRenderChunkAsQuad()).toBe(true);
    });
});

// ── Blend factors ─────────────────────────────────────────────────────────────

describe('AltitudeZoneManager – terrain & orbital blend', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('terrainBlend is 1 below high-to-orbital transition start (13000 m)', () => {
        updateAtAltitude(mgr, 12999);
        expect(mgr.terrainBlend).toBe(1.0);
    });

    it('terrainBlend is 0 above transition end (17000 m)', () => {
        updateAtAltitude(mgr, 17001);
        expect(mgr.terrainBlend).toBe(0.0);
    });

    it('orbitalBlend is 0 below transition start', () => {
        updateAtAltitude(mgr, 12999);
        expect(mgr.orbitalBlend).toBe(0.0);
    });

    it('orbitalBlend is 1 above transition end', () => {
        updateAtAltitude(mgr, 17001);
        expect(mgr.orbitalBlend).toBe(1.0);
    });

    it('terrainBlend + orbitalBlend ≈ 1 during transition', () => {
        updateAtAltitude(mgr, 15000); // mid-transition
        expect(mgr.terrainBlend + mgr.orbitalBlend).toBeCloseTo(1.0);
    });

    it('shouldRenderOrbitalSphere is false below transition start', () => {
        updateAtAltitude(mgr, 5000);
        expect(mgr.shouldRenderOrbitalSphere()).toBe(false);
    });

    it('shouldRenderOrbitalSphere is true above transition end', () => {
        updateAtAltitude(mgr, 17001);
        expect(mgr.shouldRenderOrbitalSphere()).toBe(true);
    });
});

// ── Horizon distance ──────────────────────────────────────────────────────────

describe('AltitudeZoneManager – horizon distance', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('horizon at 0 m is 0', () => {
        updateAtAltitude(mgr, 0);
        expect(mgr.horizonDistance).toBeCloseTo(0);
    });

    it('horizon increases with altitude', () => {
        updateAtAltitude(mgr, 1000);
        const d1 = mgr.horizonDistance;
        updateAtAltitude(mgr, 10000);
        const d2 = mgr.horizonDistance;
        expect(d2).toBeGreaterThan(d1);
    });

    it('matches geometric formula sqrt(h*(2R+h))', () => {
        const h = 5000;
        const R = PLANET_RADIUS;
        updateAtAltitude(mgr, h);
        expect(mgr.horizonDistance).toBeCloseTo(Math.sqrt(h * (2 * R + h)));
    });
});

// ── _smoothstep ───────────────────────────────────────────────────────────────

describe('AltitudeZoneManager – _smoothstep', () => {
    let mgr;
    beforeEach(() => { mgr = makeManager(); });

    it('returns 0 at t=0', () => {
        expect(mgr._smoothstep(0)).toBe(0);
    });
    it('returns 1 at t=1', () => {
        expect(mgr._smoothstep(1)).toBe(1);
    });
    it('returns 0.5 at t=0.5', () => {
        expect(mgr._smoothstep(0.5)).toBeCloseTo(0.5);
    });
    it('clamps below 0', () => {
        expect(mgr._smoothstep(-1)).toBe(0);
    });
    it('clamps above 1', () => {
        expect(mgr._smoothstep(2)).toBe(1);
    });
    it('is monotonically increasing between 0 and 1', () => {
        let prev = 0;
        for (let i = 1; i <= 10; i++) {
            const val = mgr._smoothstep(i / 10);
            expect(val).toBeGreaterThan(prev);
            prev = val;
        }
    });
});
