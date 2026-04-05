// js/celestial/CelestialBody.js
import { Vector3, Matrix4 } from '../../shared/math/index.js';

/**
 * Represents a celestial body (planet, moon, asteroid).
 * Uses double precision for system-level coordinates.
 */
export class CelestialBody {
    constructor(options = {}) {
        this.id = options.id || `body_${CelestialBody._nextId++}`;
        this.name = options.name || 'Body';
        this.type = options.type || 'planet'; // 'planet', 'moon', 'asteroid'
        
        // Position in system coordinates (meters, double precision)
        this.position = {
            x: options.x ?? 0,
            y: options.y ?? 0,
            z: options.z ?? 0
        };
        
        // Physical properties
        this.radius = options.radius ?? 6371000; // Earth radius default
        this.mass = options.mass ?? 5.972e24; // Earth mass default
        
        // Rotation (body-fixed frame)
        this.rotationAxis = new Vector3(
            options.rotationAxisX ?? 0,
            options.rotationAxisY ?? 1,
            options.rotationAxisZ ?? 0
        ).normalize();
        this.axialTilt = options.axialTilt ?? 0; // Radians, tilt from orbital plane
        this.rotationPeriod = options.rotationPeriod ?? 86400; // Seconds (24h)
        this.currentRotation = options.initialRotation ?? 0; // Current rotation angle (radians)
        
        // Orbital elements (simplified Keplerian)
        this.orbitalParent = options.orbitalParent ?? null; // Star or parent planet for moons
        this.semiMajorAxis = options.semiMajorAxis ?? 149597870700; // 1 AU default
        this.eccentricity = options.eccentricity ?? 0;
        this.orbitalPeriod = options.orbitalPeriod ?? 31557600; // Seconds (1 year)
        this.orbitalInclination = options.orbitalInclination ?? 0;
        this.longitudeOfAscendingNode = options.longitudeOfAscendingNode ?? 0;
        this.argumentOfPeriapsis = options.argumentOfPeriapsis ?? 0;
        this.meanAnomalyAtEpoch = options.meanAnomalyAtEpoch ?? 0;
        this.currentMeanAnomaly = this.meanAnomalyAtEpoch;
        
        // Reference to PlanetConfig for atmosphere/terrain
        this.planetConfig = options.planetConfig ?? null;
        
        // Children (moons)
        this.children = [];
        
        // Internal: cached orbital calculations
        this._orbitCache = {
            lastTime: 0,
            trueAnomaly: 0,
            distance: this.semiMajorAxis
        };
    }
    
    static _nextId = 0;
    
    /**
     * Update body state (rotation and orbital position).
     * @param {number} deltaTime - Time step in seconds
     * @param {number} systemTime - Total elapsed system time in seconds
     */
    update(deltaTime, systemTime = 0) {
        // Update rotation
        const angularVelocity = (2 * Math.PI) / this.rotationPeriod;
        this.currentRotation += angularVelocity * deltaTime;
        this.currentRotation = this.currentRotation % (2 * Math.PI);
        
        // Update orbital position
        this._updateOrbitalPosition(systemTime);
        
        // Update children (moons)
        for (const child of this.children) {
            child.update(deltaTime, systemTime);
        }
    }
    
    /**
     * Calculate orbital position using Kepler's equation.
     */
    _updateOrbitalPosition(systemTime) {
        if (!this.orbitalParent) return;
        
        // Mean motion
        const n = (2 * Math.PI) / this.orbitalPeriod;
        
        // Mean anomaly
        this.currentMeanAnomaly = (this.meanAnomalyAtEpoch + n * systemTime) % (2 * Math.PI);
        
        // Solve Kepler's equation for eccentric anomaly (Newton-Raphson)
        let E = this.currentMeanAnomaly;
        const e = this.eccentricity;
        for (let i = 0; i < 10; i++) {
            const dE = (E - e * Math.sin(E) - this.currentMeanAnomaly) / (1 - e * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-12) break;
        }
        
        // True anomaly
        const sinE = Math.sin(E);
        const cosE = Math.cos(E);
        const sqrtOneMinusE2 = Math.sqrt(1 - e * e);
        const trueAnomaly = Math.atan2(sqrtOneMinusE2 * sinE, cosE - e);
        
        // Distance from parent
        const distance = this.semiMajorAxis * (1 - e * cosE);
        
        // Position in orbital plane
        const xOrbit = distance * Math.cos(trueAnomaly);
        const yOrbit = distance * Math.sin(trueAnomaly);
        
        // Transform to 3D coordinates
        // Apply orbital elements: inclination, longitude of ascending node, argument of periapsis
        const cosO = Math.cos(this.longitudeOfAscendingNode);
        const sinO = Math.sin(this.longitudeOfAscendingNode);
        const cosi = Math.cos(this.orbitalInclination);
        const sini = Math.sin(this.orbitalInclination);
        const cosw = Math.cos(this.argumentOfPeriapsis);
        const sinw = Math.sin(this.argumentOfPeriapsis);
        
        // Rotation matrix elements
        const Px = cosO * cosw - sinO * sinw * cosi;
        const Py = sinO * cosw + cosO * sinw * cosi;
        const Pz = sinw * sini;
        const Qx = -cosO * sinw - sinO * cosw * cosi;
        const Qy = -sinO * sinw + cosO * cosw * cosi;
        const Qz = cosw * sini;
        
        // Final position relative to parent
        const relX = xOrbit * Px + yOrbit * Qx;
        const relY = xOrbit * Py + yOrbit * Qy;
        const relZ = xOrbit * Pz + yOrbit * Qz;
        
        // Add parent position
        const parent = this.orbitalParent;
        this.position.x = parent.position.x + relX;
        this.position.y = parent.position.y + relY;
        this.position.z = parent.position.z + relZ;
        
        // Cache for later use
        this._orbitCache.lastTime = systemTime;
        this._orbitCache.trueAnomaly = trueAnomaly;
        this._orbitCache.distance = distance;
    }
    
  /**
     * Get the direction to a star from a point on this body's surface.
     * This accounts for the body's rotation and axial tilt.
     * 
     * @param {Star} star - The star object
     * @param {Object} localSurfacePos - {x, y, z} position in body-local coordinates
     * @returns {Object} {direction: Vector3, distance: number, intensity: number}
     */
  getStarDirection(star, localSurfacePos = { x: 0, y: 0, z: 0 }) {
    // Convert local surface position to system coordinates
    const worldX = this.position.x + localSurfacePos.x;
    const worldY = this.position.y + localSurfacePos.y;
    const worldZ = this.position.z + localSurfacePos.z;
    
    // Vector from surface point to star (double precision)
    const dx = star.position.x - worldX;
    const dy = star.position.y - worldY;
    const dz = star.position.z - worldZ;
    
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Direction in system space (unrotated)
    let systemDir = new Vector3(
        dx / distance,
        dy / distance,
        dz / distance
    );
    
    // === APPLY PLANETARY ROTATION ===
    // Transform from system space to body-local space accounting for rotation
    
    // Create rotation matrix from current rotation and axial tilt
    const rotationMatrix = new Matrix4();
    
    // Apply axial tilt first (tilt the rotation axis)
    if (this.axialTilt !== 0) {
        // Tilt around X axis (or whatever is perpendicular to rotation axis)
        rotationMatrix.makeRotationX(this.axialTilt);
    }
    
    // Apply daily rotation around the (tilted) axis
    const dailyRotation = new Matrix4().makeRotationAxis(
        this.rotationAxis,
        -this.currentRotation // Negative because we're transforming from system to local
    );
    rotationMatrix.premultiply(dailyRotation);
    
    // Transform star direction from system space to body-local space
    const localStarDir = systemDir.clone().applyMatrix4(rotationMatrix);
    
    return {
        direction: localStarDir,
        distance: distance,
        intensity: star.getIntensityAtDistance(distance),
        angularDiameter: star.getAngularDiameter(distance)
    };
}
    
    /**
     * Get the local "up" direction at a surface position (for spherical bodies).
     * @param {Object} localPos - {x, y, z} in body-local coordinates
     * @returns {Vector3} Normalized up vector
     */
    getLocalUp(localPos) {
        const len = Math.sqrt(localPos.x * localPos.x + localPos.y * localPos.y + localPos.z * localPos.z);
        if (len < 0.001) return new Vector3(0, 1, 0);
        return new Vector3(localPos.x / len, localPos.y / len, localPos.z / len);
    }
    
    /**
     * Check if a star is above the local horizon at a surface point.
     * @param {Star} star 
     * @param {Object} localSurfacePos 
     * @returns {Object} {isAboveHorizon, elevation, azimuth}
     */
    getStarHorizonInfo(star, localSurfacePos) {
        const starInfo = this.getStarDirection(star, localSurfacePos);
        const localUp = this.getLocalUp(localSurfacePos);
        
        // Elevation is the angle above horizon (dot product with up vector)
        const elevation = Math.asin(Math.max(-1, Math.min(1, starInfo.direction.dot(localUp))));
        
        return {
            isAboveHorizon: elevation > -0.0145, // ~0.83° for atmospheric refraction
            elevation: elevation,
            sunDirection: starInfo.direction,
            intensity: starInfo.intensity
        };
    }
    
    /**
     * Convert a point from system coordinates to body-local coordinates.
     */
    toLocalCoordinates(systemPos) {
        return {
            x: systemPos.x - this.position.x,
            y: systemPos.y - this.position.y,
            z: systemPos.z - this.position.z
        };
    }
    
    /**
     * Convert a point from body-local to system coordinates.
     */
    toSystemCoordinates(localPos) {
        return {
            x: localPos.x + this.position.x,
            y: localPos.y + this.position.y,
            z: localPos.z + this.position.z
        };
    }
    
    /**
     * Get camera-relative position for rendering.
     * This converts double-precision system coordinates to float32-safe render coordinates.
     * @param {Object} cameraSystemPos - Camera position in system coordinates
     * @returns {Vector3} Position relative to camera (safe for GPU)
     */
    getCameraRelativePosition(cameraSystemPos) {
        return new Vector3(
            this.position.x - cameraSystemPos.x,
            this.position.y - cameraSystemPos.y,
            this.position.z - cameraSystemPos.z
        );
    }
    
    /**
     * Add a moon to this body.
     */
    addMoon(moon) {
        moon.orbitalParent = this;
        moon.type = 'moon';
        this.children.push(moon);
    }
    
    /**
     * Link a PlanetConfig to this body.
     */
    setPlanetConfig(config) {
        this.planetConfig = config;
        // Sync radius
        if (config.radius !== this.radius) {
            config.radius = this.radius;
        }
        // Sync origin to position (initially)
        config.origin.set(0, 0, 0); // Local origin is always 0,0,0
    }
    
    // === Static factory methods ===
    
    static createEarth(options = {}) {
        return new CelestialBody({
            name: 'Earth',
            radius: 6371000,
            mass: 5.972e24,
            rotationPeriod: 86164.1, // Sidereal day
            axialTilt: 0.4091, // 23.44 degrees
            semiMajorAxis: 149597870700,
            eccentricity: 0.0167,
            orbitalPeriod: 31558149.8, // Sidereal year
            orbitalInclination: 0,
            ...options
        });
    }
    
    /**
     * Create a configurable moon for any planet.
     * @param {object} options - Moon configuration
     * @returns {CelestialBody}
     */
    static createMoon(options = {}) {
        const parentRadius = options.parentRadius ?? 6371000; // Default Earth radius
        
        // Default to Earth's Moon proportions relative to parent
        const moonRadiusRatio = options.radiusRatio ?? 0.2727; // Moon/Earth ratio
        const moonDistanceRatio = options.distanceRatio ?? 60.3; // Moon distance / Earth radius
        
        return new CelestialBody({
            id: options.id ?? 'moon',
            name: options.name ?? 'Moon',
            type: 'moon',
            radius: options.radius ?? (parentRadius * moonRadiusRatio),
            mass: options.mass ?? 7.342e22,
            
            // Tidally locked by default (rotation period = orbital period)
            rotationPeriod: options.rotationPeriod ?? options.orbitalPeriod ?? 2360591.5,
            
            // Orbital parameters
            semiMajorAxis: options.semiMajorAxis ?? (parentRadius * moonDistanceRatio),
            eccentricity: options.eccentricity ?? 0.0549,
            orbitalPeriod: options.orbitalPeriod ?? 2360591.5, // ~27.3 days in seconds
            orbitalInclination: options.orbitalInclination ?? 0.0898, // ~5.145 degrees
            longitudeOfAscendingNode: options.longitudeOfAscendingNode ?? 0,
            argumentOfPeriapsis: options.argumentOfPeriapsis ?? 0,
            meanAnomalyAtEpoch: options.meanAnomalyAtEpoch ?? 0,
            
            // Visual properties
            albedo: options.albedo ?? 0.12, // Moon's average albedo
            
            // Custom properties
            ...options
        });
    }

    /**
     * Get angular diameter as seen from a distance.
     * @param {number} distance - Distance from observer to body center
     * @returns {number} Angular diameter in radians
     */
    getAngularDiameter(distance) {
        if (distance <= this.radius) return Math.PI;
        return 2 * Math.atan(this.radius / distance);
    }
    
    static createMars(options = {}) {
        return new CelestialBody({
            name: 'Mars',
            radius: 3389500,
            mass: 6.4171e23,
            rotationPeriod: 88642.7,
            axialTilt: 0.4396, // 25.19 degrees
            semiMajorAxis: 227939200000,
            eccentricity: 0.0935,
            orbitalPeriod: 59354294.4,
            ...options
        });
    }
}