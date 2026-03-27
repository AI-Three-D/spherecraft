// js/lighting/LightingController.js - Complete replacement

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

/**
 * LightingController provides global star/sun and moon properties.
 * Per-location lighting (terminator/twilight) is computed in shaders.
 */
export class LightingController {
    constructor() {
        // Cached results
        this._cache = {
            frameId: -1,

            // Primary star/sun (global)
            sunDirection: new THREE.Vector3(0, 1, 0),
            sunIntensity: 1.0,
            sunVisibility: 1.0,
            sunColor: new THREE.Color(1, 1, 1),
            sunAngularDiameter: 0.00935,

            // Moon light
            moonDirection: new THREE.Vector3(0, -1, 0),
            moonIntensity: 0,
            moonColor: new THREE.Color(0.8, 0.85, 0.95), // Slightly blue
            moonPhase: 0.5,
            moonIllumination: 1.0,
            moonAngularDiameter: 0.009,
            moonVisible: false
        };
        
        // Moon light intensity multiplier (adjustable)
        this.moonBaseIntensity = 0.15; // Max intensity at full moon during night
    }

    /**
     * Update global star/sun and moon properties for this frame.
     * @param {StarSystem} starSystem
     * @param {THREE.Vector3} cameraWorldPosition
     * @param {PlanetConfig} planetConfig
     * @param {number} frameId
     */
    update(starSystem, cameraWorldPosition, planetConfig, frameId) {
        // Skip if already computed this frame
        if (this._cache.frameId === frameId) {
            return this._cache;
        }
        this._cache.frameId = frameId;

        const cache = this._cache;

        // Require a valid star system
        if (!starSystem || !starSystem.primaryStar || !starSystem.currentBody) {
            return cache;
        }

        // Use planet center for global sun direction (stable across views)
        const starInfo = starSystem.currentBody.getStarDirection(
            starSystem.primaryStar,
            { x: 0, y: 0, z: 0 }
        );

        cache.sunDirection.copy(starInfo.direction).normalize();
        const baseSunIntensity = Math.min(3.0, starInfo?.intensity || 1.0);
        cache.sunVisibility = this._computeLocalSunVisibility(cache.sunDirection, cameraWorldPosition, planetConfig);
        cache.sunIntensity = baseSunIntensity * cache.sunVisibility;
        cache.sunAngularDiameter = starInfo?.angularDiameter ?? cache.sunAngularDiameter;

        // Star color tint
        if (starSystem.primaryStar?.lightColor) {
            cache.sunColor.copy(starSystem.primaryStar.lightColor);
        } else {
            cache.sunColor.set(1, 1, 1);
        }

        // === Moon Lighting ===
        this._updateMoonLighting(starSystem, cache);

        return cache;
    }

    /**
     * Update moon lighting based on phase and sun position.
     */
    _updateMoonLighting(starSystem, cache) {
        // Get moon info from star system
        const moonInfo = starSystem.getMoonInfo({ x: 0, y: 0, z: 0 });
        
        if (!moonInfo || !moonInfo.isAboveHorizon) {
            cache.moonVisible = false;
            cache.moonIntensity = 0;
            return;
        }
        
        cache.moonVisible = true;
        cache.moonDirection.copy(moonInfo.direction);
        cache.moonPhase = moonInfo.phase;
        cache.moonIllumination = moonInfo.illumination;
        cache.moonAngularDiameter = moonInfo.angularDiameter;
        
        // Calculate moon light intensity
        // Moon only provides significant light at night when sun is below horizon
        const sunVisibility = Number.isFinite(cache.sunVisibility) ? cache.sunVisibility : 1.0;
        const isNight = sunVisibility < 0.25;
        
        if (isNight) {
            // Night time: moon intensity based on phase (illumination)
            // Full moon (illumination = 1) gives full intensity
            // New moon (illumination = 0) gives no light
            const nightFactor = Math.max(0, Math.min(1, 1.0 - sunVisibility)); // Ramp up as sun gets lower
            cache.moonIntensity = this.moonBaseIntensity * moonInfo.illumination * nightFactor;
        } else {
            // Day time: moon visible but doesn't contribute to lighting
            cache.moonIntensity = 0;
        }
        
        // Moon color: slightly cool/blue tinted
        // Gets warmer near horizon (like sun)
        const moonElevation = moonInfo.elevation ?? 0;
        const horizonWarmth = Math.max(0, 1 - Math.abs(moonElevation) / 0.5);
        cache.moonColor.setRGB(
            0.8 + horizonWarmth * 0.15,
            0.85 + horizonWarmth * 0.1,
            0.95 - horizonWarmth * 0.1
        );
    }

    _computeLocalSunVisibility(sunDirection, cameraWorldPosition, planetConfig) {
        if (!sunDirection || !cameraWorldPosition || !planetConfig?.origin) {
            return 1.0;
        }

        const ox = planetConfig.origin.x || 0;
        const oy = planetConfig.origin.y || 0;
        const oz = planetConfig.origin.z || 0;
        const ux = (cameraWorldPosition.x || 0) - ox;
        const uy = (cameraWorldPosition.y || 0) - oy;
        const uz = (cameraWorldPosition.z || 0) - oz;
        const lenSq = ux * ux + uy * uy + uz * uz;
        if (lenSq < 1e-8) return 1.0;

        const invLen = 1.0 / Math.sqrt(lenSq);
        const upx = ux * invLen;
        const upy = uy * invLen;
        const upz = uz * invLen;
        const sunDotUp = upx * sunDirection.x + upy * sunDirection.y + upz * sunDirection.z;

        // Twilight blend around horizon:
        // -0.10 ≈ sun 6 deg below horizon (civil twilight).
        // +0.02 keeps sunrise/sunset softly ramped.
        const edge0 = -0.10;
        const edge1 = 0.02;
        const t = Math.max(0, Math.min(1, (sunDotUp - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    // === Getters ===
    getSunDirection() { return this._cache.sunDirection; }
    getSunIntensity() { return this._cache.sunIntensity; }
    getSunVisibility() { return this._cache.sunVisibility; }
    getSunColor() { return this._cache.sunColor; }
    getSunAngularDiameter() { return this._cache.sunAngularDiameter; }
    
    getMoonDirection() { return this._cache.moonDirection; }
    getMoonIntensity() { return this._cache.moonIntensity; }
    getMoonColor() { return this._cache.moonColor; }
    getMoonPhase() { return this._cache.moonPhase; }
    getMoonIllumination() { return this._cache.moonIllumination; }
    getMoonAngularDiameter() { return this._cache.moonAngularDiameter; }
    isMoonVisible() { return this._cache.moonVisible; }
    
    getAll() { return this._cache; }

    getDebugInfo() {
        const c = this._cache;
        return {
            sunIntensity: c.sunIntensity.toFixed(3),
            sunVisibility: c.sunVisibility.toFixed(3),
            sunAngularDiameter: c.sunAngularDiameter.toFixed(5),
            moonVisible: c.moonVisible,
            moonPhase: c.moonPhase.toFixed(3),
            moonIllumination: (c.moonIllumination * 100).toFixed(0) + '%',
            moonIntensity: c.moonIntensity.toFixed(4)
        };
    }
}
