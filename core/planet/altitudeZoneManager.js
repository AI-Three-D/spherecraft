// js/planet/altitudeZoneManager.js
import { Vector3 } from '../../shared/math/index.js';

export const AltitudeZone = {
    SURFACE: 'surface',           // 0-500m: Full detail terrain
    LOW_ALTITUDE: 'low_altitude', // 500m-2km: Reduced detail, transitions start
    MEDIUM_ALTITUDE: 'medium',    // 2km-5km: Simplified quads per chunk
    HIGH_ALTITUDE: 'high',        // 5km-15km: Minimal terrain, sphere fade-in
    ORBITAL: 'orbital'            // 15km+: Orbital sphere only
};

export class AltitudeZoneManager {
    constructor(planetConfig) {
        this.config = planetConfig;
        
        // Zone boundaries (in meters above planet surface)
        this.zones = {
            [AltitudeZone.SURFACE]: { min: 0, max: 500 },
            [AltitudeZone.LOW_ALTITUDE]: { min: 500, max: 2000 },
            [AltitudeZone.MEDIUM_ALTITUDE]: { min: 2000, max: 5000 },
            [AltitudeZone.HIGH_ALTITUDE]: { min: 5000, max: 15000 },
            [AltitudeZone.ORBITAL]: { min: 15000, max: Infinity }
        };
        
        // Transition zones (smooth blending)
        this.transitions = {
            surfaceToLow: { start: 400, end: 600 },
            lowToMedium: { start: 1800, end: 2200 },
            mediumToHigh: { start: 4500, end: 5500 },
            highToOrbital: { start: 13000, end: 17000 }
        };
        
        this.currentZone = AltitudeZone.SURFACE;
        this.previousZone = AltitudeZone.SURFACE;
        this.altitude = 0;
        this.transitionProgress = 0;
        
        // Blend factors for rendering systems
        this.terrainBlend = 1.0;      // 1.0 = full terrain, 0.0 = hidden
        this.orbitalBlend = 0.0;      // 0.0 = hidden, 1.0 = full sphere
        this.terrainDetailLevel = 0;  // 0-4, maps to LOD/geometry complexity
        
        // Horizon distance calculation
        this.horizonDistance = 0;
        
        
    }
    
    update(cameraWorldPosition, deltaTime) {
        // Calculate altitude above planet surface
        const relativePos = new Vector3().subVectors(
            cameraWorldPosition,
            this.config.origin
        );
        
        const distanceFromCenter = relativePos.length();
        this.altitude = Math.max(0, distanceFromCenter - this.config.radius);
        
        // Calculate horizon distance for culling
        this.horizonDistance = this._calculateHorizonDistance(distanceFromCenter);
        
        // Determine current zone
        this._updateCurrentZone();
        
        // Calculate blend factors
        this._updateBlendFactors();
        
        // Update terrain detail level
        this._updateTerrainDetailLevel();
    }
    
    _updateCurrentZone() {
        this.previousZone = this.currentZone;
        
        if (this.altitude < this.zones[AltitudeZone.SURFACE].max) {
            this.currentZone = AltitudeZone.SURFACE;
        } else if (this.altitude < this.zones[AltitudeZone.LOW_ALTITUDE].max) {
            this.currentZone = AltitudeZone.LOW_ALTITUDE;
        } else if (this.altitude < this.zones[AltitudeZone.MEDIUM_ALTITUDE].max) {
            this.currentZone = AltitudeZone.MEDIUM_ALTITUDE;
        } else if (this.altitude < this.zones[AltitudeZone.HIGH_ALTITUDE].max) {
            this.currentZone = AltitudeZone.HIGH_ALTITUDE;
        } else {
            this.currentZone = AltitudeZone.ORBITAL;
        }
        
        if (this.previousZone !== this.currentZone) {
        }
    }
    
    _updateBlendFactors() {
        const alt = this.altitude;
        
        // === TERRAIN BLEND ===
        if (alt < this.transitions.highToOrbital.start) {
            // Full terrain visible below high-to-orbital transition
            this.terrainBlend = 1.0;
        } else if (alt < this.transitions.highToOrbital.end) {
            // Fade out terrain during high-to-orbital transition
            const progress = (alt - this.transitions.highToOrbital.start) / 
                           (this.transitions.highToOrbital.end - this.transitions.highToOrbital.start);
            this.terrainBlend = 1.0 - this._smoothstep(progress);
        } else {
            // No terrain in full orbital view
            this.terrainBlend = 0.0;
        }
        
        // === ORBITAL SPHERE BLEND ===
        if (alt < this.transitions.highToOrbital.start) {
            // No sphere visible below transition
            this.orbitalBlend = 0.0;
        } else if (alt < this.transitions.highToOrbital.end) {
            // Fade in sphere during transition
            const progress = (alt - this.transitions.highToOrbital.start) / 
                           (this.transitions.highToOrbital.end - this.transitions.highToOrbital.start);
            this.orbitalBlend = this._smoothstep(progress);
        } else {
            // Full sphere in orbital view
            this.orbitalBlend = 1.0;
        }
    }
    
    _updateTerrainDetailLevel() {
        // Map altitude zones to terrain detail levels
        // 0 = Full detail (all features, splats, shadows)
        // 1 = High detail (reduced features, full splats)
        // 2 = Medium detail (no splats, simplified geometry)
        // 3 = Low detail (single quad per chunk, no features)
        // 4 = Minimal (distant quads only, preparing to hide)
        
        if (this.currentZone === AltitudeZone.SURFACE) {
            this.terrainDetailLevel = 0;
        } else if (this.currentZone === AltitudeZone.LOW_ALTITUDE) {
            this.terrainDetailLevel = 1;
        } else if (this.currentZone === AltitudeZone.MEDIUM_ALTITUDE) {
            this.terrainDetailLevel = 2;
        } else if (this.currentZone === AltitudeZone.HIGH_ALTITUDE) {
            this.terrainDetailLevel = 3;
        } else {
            this.terrainDetailLevel = 4;
        }
    }
    
    _calculateHorizonDistance(distanceFromCenter) {
        // Geometric horizon distance formula
        // d = sqrt(h * (2R + h))
        // where h = altitude, R = planet radius
        const h = this.altitude;
        const R = this.config.radius;
        return Math.sqrt(h * (2 * R + h));
    }
    
    _smoothstep(t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * (3 - 2 * t);
    }
    

    
    shouldRenderOrbitalSphere() {
        return this.orbitalBlend > 0.01;
    }
    
    getTerrainBlendFactor() {
        return this.terrainBlend;
    }
    
    getOrbitalSphereBlendFactor() {
        return this.orbitalBlend;
    }
    
    getTerrainDetailLevel() {
        return this.terrainDetailLevel;
    }
    
    shouldRenderChunkAsQuad() {
        // Use simplified quad rendering at medium altitude and above
        return this.terrainDetailLevel >= 2;
    }
    
    shouldRenderFeatures() {
        // Features only at surface and low altitude
        return this.terrainDetailLevel <= 1;
    }
    
    shouldRenderSplats() {
        // Splat layer only at surface and low altitude
        return this.terrainDetailLevel <= 1;
    }
    
    shouldUseShadows() {
        // Shadows only at surface level
        return this.terrainDetailLevel === 0;
    }
    
    getMaxVisibleDistance() {
        // Return appropriate view distance based on altitude
        // This helps cull chunks beyond the horizon
        const baseDistance = 160; // Base view distance from ChunkCullingManager
        
        if (this.currentZone === AltitudeZone.SURFACE) {
            return baseDistance;
        } else if (this.currentZone === AltitudeZone.LOW_ALTITUDE) {
            return baseDistance * 2;
        } else if (this.currentZone === AltitudeZone.MEDIUM_ALTITUDE) {
            return Math.min(this.horizonDistance * 1.2, baseDistance * 4);
        } else if (this.currentZone === AltitudeZone.HIGH_ALTITUDE) {
            return Math.min(this.horizonDistance * 1.5, baseDistance * 8);
        } else {
            // In orbital, we don't render terrain chunks
            return 0;
        }
    }
    
    getRecommendedChunkLoadRadius() {
        // How many chunks to load around camera
        const chunkSize = this.config.surfaceChunkSize || 128;
        const maxDistance = this.getMaxVisibleDistance();
        
        if (maxDistance === 0) return 0;
        
        return Math.ceil(maxDistance / chunkSize) + 1;
    }
    
    getDebugInfo() {
        return {
            zone: this.currentZone,
            altitude: this.altitude,
            horizonDistance: this.horizonDistance,
            terrainBlend: this.terrainBlend,
            orbitalBlend: this.orbitalBlend,
            terrainDetailLevel: this.terrainDetailLevel,
   
            shouldRenderSphere: this.shouldRenderOrbitalSphere(),
            maxVisibleDistance: this.getMaxVisibleDistance(),
            chunkLoadRadius: this.getRecommendedChunkLoadRadius()
        };
    }
}
