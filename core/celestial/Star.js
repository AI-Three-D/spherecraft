// js/celestial/Star.js
import { Color } from '../../shared/math/index.js';

/**
 * Represents a star in the solar system.
 * Uses double precision (JavaScript numbers) for positions.
 */
export class Star {
    constructor(options = {}) {
        this.id = options.id || `star_${Star._nextId++}`;
        this.name = options.name || 'Star';
        this.type = 'star';
        
        // Position in system coordinates (meters, double precision)
        // For a single-star system, the star is typically at origin
        this.position = {
            x: options.x ?? 0,
            y: options.y ?? 0,
            z: options.z ?? 0
        };
        
        // Physical properties
        this.radius = options.radius ?? 696340000; // Sun radius in meters
        this.mass = options.mass ?? 1.989e30; // Sun mass in kg
        this.luminosity = options.luminosity ?? 1.0; // Solar luminosities
        this.temperature = options.temperature ?? 5778; // Kelvin (Sun-like)
        
        // Derived properties
        this.color = options.color ?? this._calculateBlackbodyColor();
        this.lightColor = new Color(this.color.r, this.color.g, this.color.b);
    }
    
    static _nextId = 0;
    
    /**
     * Approximate blackbody color from temperature.
     * Based on Tanner Helland's algorithm.
     */
    _calculateBlackbodyColor() {
        const temp = this.temperature / 100;
        let r, g, b;
        
        // Red
        if (temp <= 66) {
            r = 255;
        } else {
            r = temp - 60;
            r = 329.698727446 * Math.pow(r, -0.1332047592);
            r = Math.max(0, Math.min(255, r));
        }
        
        // Green
        if (temp <= 66) {
            g = temp;
            g = 99.4708025861 * Math.log(g) - 161.1195681661;
        } else {
            g = temp - 60;
            g = 288.1221695283 * Math.pow(g, -0.0755148492);
        }
        g = Math.max(0, Math.min(255, g));
        
        // Blue
        if (temp >= 66) {
            b = 255;
        } else if (temp <= 19) {
            b = 0;
        } else {
            b = temp - 10;
            b = 138.5177312231 * Math.log(b) - 305.0447927307;
            b = Math.max(0, Math.min(255, b));
        }
        
        return { r: r / 255, g: g / 255, b: b / 255 };
    }
    
    /**
     * Get light intensity at a given distance (inverse square law).
     * Returns value relative to Earth's solar constant.
     */
    getIntensityAtDistance(distanceMeters) {
        const AU = 149597870700; // 1 AU in meters
        const distanceAU = distanceMeters / AU;
        if (distanceAU < 0.001) return this.luminosity * 1000000; // Prevent division issues
        return this.luminosity / (distanceAU * distanceAU);
    }
    
    /**
     * Get angular diameter as seen from a distance (radians).
     */
    getAngularDiameter(distanceMeters) {
        if (distanceMeters <= this.radius) return Math.PI; // Inside the star
        return 2 * Math.atan(this.radius / distanceMeters);
    }
    
    /**
     * Create a Sun-like star.
     */
    static createSun(options = {}) {
        return new Star({
            name: 'Sun',
            radius: 696340000,
            mass: 1.989e30,
            luminosity: 1.0,
            temperature: 5778,
            ...options
        });
    }
    
    /**
     * Create a red dwarf star.
     */
    static createRedDwarf(options = {}) {
        return new Star({
            name: 'Red Dwarf',
            radius: 696340000 * 0.5,
            mass: 1.989e30 * 0.3,
            luminosity: 0.04,
            temperature: 3500,
            ...options
        });
    }
    
    /**
     * Create a blue giant star.
     */
    static createBlueGiant(options = {}) {
        return new Star({
            name: 'Blue Giant',
            radius: 696340000 * 10,
            mass: 1.989e30 * 20,
            luminosity: 10000,
            temperature: 20000,
            ...options
        });
    }
}