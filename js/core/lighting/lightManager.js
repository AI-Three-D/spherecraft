import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

/**
 * Light types supported by the engine
 */
export const LightType = {
    DIRECTIONAL: 0,
    POINT: 1,
    SPOT: 2,
    AMBIENT: 3
};

/**
 * Represents a single light in the scene
 */
export class Light {
    constructor(type, options = {}) {
        this.id = Light.nextId++;
        this.type = type;
        this.enabled = true;
        
        // Transform
        this.position = options.position || new THREE.Vector3();
        this.direction = options.direction || new THREE.Vector3(0, -1, 0);
        
        // Color and intensity
        this.color = options.color || new THREE.Color(0xffffff);
        this.intensity = options.intensity !== undefined ? options.intensity : 1.0;
        
        // Attenuation (for point/spot lights)
        this.radius = options.radius || 10.0;
        this.decay = options.decay || 2.0; // Physically correct falloff
        
        // Spot light specific
        this.angle = options.angle || Math.PI / 4;
        this.penumbra = options.penumbra || 0.1;
        
        // Shadow casting
        this.castShadow = options.castShadow || false;
        this.shadowMapIndex = -1; // Will be assigned by shadow system
        
        // Metadata
        this.name = options.name || `Light_${this.id}`;
        this.userData = options.userData || {};
    }
    
    static nextId = 0;
}

