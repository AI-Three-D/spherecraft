// js/celestial/StarSystem.js - Replace the entire file

import { Vector3, Matrix4 } from '../../shared/math/index.js';
import { Star } from './Star.js';
import { CelestialBody } from './CelestialBody.js';

/**
 * Manages a complete star system with stars, planets, moons, and time.
 * Handles coordinate systems, orbital mechanics, and moon phase calculations.
 */
export class StarSystem {
    constructor(options = {}) {
        this.name = options.name || 'System';

        // All bodies indexed by ID
        this.bodies = new Map();
        this.stars = new Map();
        this.planets = new Map();
        this.moons = new Map();

        // Primary star (used for main lighting)
        this.primaryStar = null;

        // Current body the camera is associated with
        this.currentBody = null;

        // System time in seconds (can be accelerated)
        this.systemTime = options.initialTime ?? 0;
        this.timeScale = options.timeScale ?? 1;

        // Game time reference (for moon phase sync)
        this.gameTime = null;

        // Auto-sync time scale with game time
        this.autoTimeScale = options.autoTimeScale ?? false;
        
        // Use game time for planetary rotation instead of orbital mechanics
        this.useGameTimeRotation = options.useGameTimeRotation ?? false;

        // Pause state
        this.paused = false;

        // Moon phase calculation mode
        this.moonPhaseMode = options.moonPhaseMode ?? 'gameTime'; // 'gameTime' or 'orbital'
        
        // Debug: force moon phase (null = calculated, 0-1 = forced)
        this.debugMoonPhase = null;
    }

    /**
     * Link a GameTime instance for moon phase sync.
     */
    setGameTime(gameTime) {
        this.gameTime = gameTime;
    }

    /**
     * Add a star to the system.
     */
    addStar(star) {
        this.stars.set(star.id, star);
        this.bodies.set(star.id, star);

        if (!this.primaryStar) {
            this.primaryStar = star;
        }

        return star;
    }

    /**
     * Add a planet to the system.
     */
    addPlanet(planet, orbitingStar = null) {
        planet.orbitalParent = orbitingStar || this.primaryStar;
        this.planets.set(planet.id, planet);
        this.bodies.set(planet.id, planet);

        return planet;
    }

    /**
     * Add a moon to a planet.
     */
    addMoon(moon, parentPlanet) {
        if (!parentPlanet) {
            throw new Error('Moon requires a parent planet');
        }
        
        moon.orbitalParent = parentPlanet;
        moon.type = 'moon';
        parentPlanet.children.push(moon);
        
        this.moons.set(moon.id, moon);
        this.bodies.set(moon.id, moon);

        return moon;
    }

    /**
     * Get moon(s) for a planet.
     */
    getMoonsForPlanet(planetOrId) {
        const planet = typeof planetOrId === 'string' 
            ? this.planets.get(planetOrId) 
            : planetOrId;
        
        if (!planet) return [];
        
        return planet.children.filter(child => child.type === 'moon');
    }

    /**
     * Set the current body the camera is near/on.
     */
    setCurrentBody(bodyOrId) {
        if (typeof bodyOrId === 'string') {
            this.currentBody = this.bodies.get(bodyOrId);
        } else {
            this.currentBody = bodyOrId;
        }
    }

    /**
     * Update all bodies in the system.
     * @param {number} deltaTime - Real time elapsed in seconds
     */
    update(deltaTime) {
        if (this.paused) return;

        const scaledDelta = deltaTime * this.timeScale;
        this.systemTime += scaledDelta;

        // Update all planets and their moons
        for (const planet of this.planets.values()) {
            planet.update(scaledDelta, this.systemTime);
        }
    }

    /**
     * Get moon phase for a specific moon.
     * Uses either game time or orbital geometry based on moonPhaseMode.
     * 
     * @param {CelestialBody|string} moonOrId - Moon body or ID
     * @returns {object} {phase, illumination, name, direction}
     */
    getMoonPhaseInfo(moonOrId = null) {
        // Debug override
        if (this.debugMoonPhase !== null) {
            return this._buildMoonPhaseFromValue(this.debugMoonPhase);
        }
        
        // Game time based phase (simplified)
        if (this.moonPhaseMode === 'gameTime' && this.gameTime) {
            const gameTimePhase = this.gameTime.getMoonPhase();
            return this._buildMoonPhaseFromValue(gameTimePhase);
        }
        
        // Orbital geometry based phase
        const moon = typeof moonOrId === 'string' 
            ? this.moons.get(moonOrId) 
            : (moonOrId || this.moons.values().next().value);
        
        if (!moon || !moon.orbitalParent || !this.primaryStar) {
            return this._buildMoonPhaseFromValue(0.5); // Default to full moon
        }
        
        return this._calculateOrbitalMoonPhase(moon);
    }

    /**
     * Calculate moon phase from orbital positions.
     * Phase is determined by the angle between sun-planet-moon.
     */
    _calculateOrbitalMoonPhase(moon) {
        const planet = moon.orbitalParent;
        const star = this.primaryStar;
        
        // Vector from planet to star
        const toStar = new Vector3(
            star.position.x - planet.position.x,
            star.position.y - planet.position.y,
            star.position.z - planet.position.z
        ).normalize();

        // Vector from planet to moon
        const toMoon = new Vector3(
            moon.position.x - planet.position.x,
            moon.position.y - planet.position.y,
            moon.position.z - planet.position.z
        ).normalize();
        
        // Angle between sun and moon as seen from planet
        const cosAngle = toStar.dot(toMoon);
        
        // Determine if waxing or waning using cross product
        const cross = new Vector3().crossVectors(toStar, toMoon);
        const isWaxing = cross.y >= 0; // Assuming Y is "up" in orbital plane
        
        // Convert angle to phase (0 = new, 0.5 = full)
        // cos(0) = 1 (moon in line with sun = new moon)
        // cos(π) = -1 (moon opposite sun = full moon)
        let phase = Math.acos(cosAngle) / Math.PI;
        
        // Adjust for waxing/waning
        if (!isWaxing) {
            phase = 1 - phase;
        }
        
        return this._buildMoonPhaseFromValue(phase);
    }

    /**
     * Build moon phase info object from a phase value.
     */
    _buildMoonPhaseFromValue(phase) {
        // Ensure phase is in [0, 1)
        phase = ((phase % 1) + 1) % 1;
        
        // Illumination: 0 at new moon, 1 at full moon
        const illumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
        
        // Phase name
        let name;
        if (phase < 0.0625) {
            name = 'New Moon';
        } else if (phase < 0.1875) {
            name = 'Waxing Crescent';
        } else if (phase < 0.3125) {
            name = 'First Quarter';
        } else if (phase < 0.4375) {
            name = 'Waxing Gibbous';
        } else if (phase < 0.5625) {
            name = 'Full Moon';
        } else if (phase < 0.6875) {
            name = 'Waning Gibbous';
        } else if (phase < 0.8125) {
            name = 'Last Quarter';
        } else if (phase < 0.9375) {
            name = 'Waning Crescent';
        } else {
            name = 'New Moon';
        }
        
        return {
            phase,
            illumination,
            name,
            isWaxing: phase < 0.5,
            isWaning: phase >= 0.5,
            // Phase angle for rendering (0 = new, π = full)
            phaseAngle: phase * 2 * Math.PI
        };
    }

    /**
     * Get moon direction from a surface point on the current body.
     * @param {Object} localPos - Position in body-local coordinates
     * @param {CelestialBody|string} moonOrId - Specific moon (optional, uses first moon)
     * @returns {Object} {direction, distance, angularDiameter, isAboveHorizon, elevation}
     */
    getMoonInfo(localPos = { x: 0, y: 0, z: 0 }, moonOrId = null) {
        if (!this.currentBody) {
            return this._getDefaultMoonInfo();
        }
        
        // Get the moon
        let moon;
        if (moonOrId) {
            moon = typeof moonOrId === 'string' ? this.moons.get(moonOrId) : moonOrId;
        } else {
            // Get first moon of current body
            const moons = this.getMoonsForPlanet(this.currentBody);
            moon = moons[0];
        }
        
        if (!moon) {
            return this._getDefaultMoonInfo();
        }
        
        // Calculate moon direction (similar to star direction in CelestialBody)
        const worldX = this.currentBody.position.x + localPos.x;
        const worldY = this.currentBody.position.y + localPos.y;
        const worldZ = this.currentBody.position.z + localPos.z;
        
        const dx = moon.position.x - worldX;
        const dy = moon.position.y - worldY;
        const dz = moon.position.z - worldZ;
        
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        // Direction in system space
        let direction = new Vector3(dx / distance, dy / distance, dz / distance);

        // Transform to body-local space (accounting for rotation)
        const rotationMatrix = new Matrix4();
        if (this.currentBody.axialTilt !== 0) {
            rotationMatrix.makeRotationX(this.currentBody.axialTilt);
        }
        const dailyRotation = new Matrix4().makeRotationAxis(
            this.currentBody.rotationAxis,
            -this.currentBody.currentRotation
        );
        rotationMatrix.premultiply(dailyRotation);
        direction = direction.applyMatrix4(rotationMatrix);

        // Check if above horizon
        const localUp = new Vector3(localPos.x, localPos.y, localPos.z).normalize();
        if (localUp.lengthSq() < 0.0001) localUp.set(0, 1, 0);
        const elevation = Math.asin(Math.max(-1, Math.min(1, direction.dot(localUp))));
        const isAboveHorizon = elevation > -0.0145; // ~0.83° for atmospheric refraction
        
        // Angular diameter
        const angularDiameter = moon.getAngularDiameter(distance);
        
        // Get phase info
        const phaseInfo = this.getMoonPhaseInfo(moon);
        
        return {
            direction,
            distance,
            angularDiameter,
            elevation,
            isAboveHorizon,
            phase: phaseInfo.phase,
            illumination: phaseInfo.illumination,
            phaseName: phaseInfo.name
        };
    }

    _getDefaultMoonInfo() {
        return {
            direction: new Vector3(0, 0.5, 0.5).normalize(),
            distance: 384400000,
            angularDiameter: 0.009,
            elevation: 0.5,
            isAboveHorizon: true,
            phase: 0.5,
            illumination: 1.0,
            phaseName: 'Full Moon'
        };
    }

    /**
     * Get the primary star's direction from a point on the current body.
     */
    getPrimaryStarInfo(localPos = { x: 0, y: 0, z: 0 }) {
        if (!this.primaryStar || !this.currentBody) {
            return {
                direction: new Vector3(0, 1, 0),
                distance: 149597870700,
                intensity: 1.0,
                isAboveHorizon: true,
                elevation: Math.PI / 4
            };
        }

        const starDir = this.currentBody.getStarDirection(this.primaryStar, localPos);
        const horizonInfo = this.currentBody.getStarHorizonInfo(this.primaryStar, localPos);

        return {
            direction: starDir.direction,
            distance: starDir.distance,
            intensity: starDir.intensity,
            angularDiameter: starDir.angularDiameter,
            isAboveHorizon: horizonInfo.isAboveHorizon,
            elevation: horizonInfo.elevation,
            starColor: this.primaryStar.lightColor
        };
    }

    /**
     * Set debug moon phase override.
     * @param {number|null} phase - 0-1 to force, null to calculate
     */
    setDebugMoonPhase(phase) {
        if (phase === null || phase === undefined) {
            this.debugMoonPhase = null;
        } else {
            this.debugMoonPhase = Math.max(0, Math.min(1, phase));
        }
        
        // Also sync to game time if available
        if (this.gameTime) {
            this.gameTime.setDebugMoonPhase(phase);
        }
    }

    // ==================== Factory Methods ====================

    /**
     * Create a Sol-like system with Earth and Moon.
     */
    static createSolSystem(options = {}) {
        const system = new StarSystem({ name: 'Sol System', ...options });

        const sun = Star.createSun({ id: 'sun' });
        system.addStar(sun);

        const earth = CelestialBody.createEarth({ id: 'earth' });
        system.addPlanet(earth, sun);

        const moon = CelestialBody.createMoon({
            id: 'moon',
            parentRadius: earth.radius
        });
        system.addMoon(moon, earth);

        system.setCurrentBody(earth);

        return system;
    }

    /**
     * Create a test system with configurable planet and moon.
     */
    static createTestSystem(planetConfig, options = {}) {
        const system = new StarSystem({ 
            name: options.name ?? 'Test System',
            timeScale: options.timeScale ?? 1,
            autoTimeScale: options.autoTimeScale ?? false,
            useGameTimeRotation: options.useGameTimeRotation ?? false,
            moonPhaseMode: options.moonPhaseMode ?? 'gameTime',
            ...options 
        });

        // Scale star radius proportionally to planet size for realistic angular diameter
        const earthRadius = 6371000;
        const sunRadius = 696340000;
        const scaleFactor = planetConfig.radius / earthRadius;
        const scaledStarRadius = options.starRadius ?? (sunRadius * scaleFactor);
        const scaledOrbit = options.orbitalDistance ?? (149597870700 * scaleFactor);

        const star = new Star({
            id: 'primary_star',
            name: 'Star',
            temperature: options.starTemperature ?? 5778,
            luminosity: options.starLuminosity ?? 1.0,
            radius: scaledStarRadius
        });
        system.addStar(star);

        const planet = new CelestialBody({
            id: 'test_planet',
            name: planetConfig.name || 'TestPlanet',
            radius: planetConfig.radius,
            semiMajorAxis: scaledOrbit,
            rotationPeriod: options.rotationPeriod ?? 86400,
            axialTilt: options.axialTilt ?? 0
        });

        planet.setPlanetConfig(planetConfig);
        system.addPlanet(planet, star);

        // Add moon if configured
        const moonConfig = options.moonConfig ?? planetConfig.moonConfig;
        if (moonConfig && moonConfig.enabled !== false) {
            const moon = CelestialBody.createMoon({
                id: moonConfig.id ?? 'moon',
                name: moonConfig.name ?? 'Moon',
                parentRadius: planetConfig.radius,
                
                // Allow custom ratios or absolute values
                radius: moonConfig.radius ?? (planetConfig.radius * (moonConfig.radiusRatio ?? 0.2727)),
                semiMajorAxis: moonConfig.semiMajorAxis ?? (planetConfig.radius * (moonConfig.distanceRatio ?? 60.3)),
                
                // Orbital period can be specified in seconds or game days
                orbitalPeriod: moonConfig.orbitalPeriod ?? 2360591.5,
                
                eccentricity: moonConfig.eccentricity ?? 0.0549,
                orbitalInclination: moonConfig.orbitalInclination ?? 0.0898,
                
                // Visual properties
                albedo: moonConfig.albedo ?? 0.12,
                
                // Light color (slightly blue-tinted)
                lightColor: moonConfig.lightColor ?? { r: 0.8, g: 0.85, b: 0.95 }
            });
            
            system.addMoon(moon, planet);
        }

        system.setCurrentBody(planet);

        return system;
    }

    /**
     * Debug logging.
     */
    debugLog() {
        console.log(`=== Star System: ${this.name} ===`);
        console.log(`System Time: ${this.systemTime.toFixed(2)}s`);
        console.log(`Time Scale: ${this.timeScale}x`);
        
        console.log(`\nStars:`);
        for (const star of this.stars.values()) {
            console.log(`  - ${star.name}: pos(${star.position.x.toFixed(0)}, ${star.position.y.toFixed(0)}, ${star.position.z.toFixed(0)})`);
        }
        
        console.log(`\nPlanets:`);
        for (const planet of this.planets.values()) {
            console.log(`  - ${planet.name}: pos(${planet.position.x.toFixed(0)}, ${planet.position.y.toFixed(0)}, ${planet.position.z.toFixed(0)}), rotation: ${(planet.currentRotation * 180 / Math.PI).toFixed(1)}°`);
        }
        
        console.log(`\nMoons:`);
        for (const moon of this.moons.values()) {
            const phaseInfo = this.getMoonPhaseInfo(moon);
            console.log(`  - ${moon.name}: phase=${phaseInfo.name} (${(phaseInfo.phase * 100).toFixed(1)}%), illumination=${(phaseInfo.illumination * 100).toFixed(0)}%`);
        }
        
        if (this.currentBody) {
            console.log(`\nCurrent Body: ${this.currentBody.name}`);
        }
    }
}