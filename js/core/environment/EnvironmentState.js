import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class EnvironmentState {
    constructor(gameTime, planetConfig = null) {
        this.gameTime = gameTime;
        this.planetConfig = planetConfig;

        // --- Atmospheric State ---
        this.windDirection = new THREE.Vector2(1, 0);
        this.windSpeed = 2.0;
        
        // --- Weather State (Snapshot) ---
        // 'clear', 'partly_cloudy', 'cloudy', 'overcast', 'rain', 'storm', 'foggy'
        this.currentWeather = 'clear'; 
        this.weatherIntensity = 0.0; // 0.0 to 1.0
        
        // --- Visual State ---
        this.cloudCoverage = 0.0;
        this.fogDensity = 0.0;
        
        // --- Water State (Snapshot) ---
        // Allows the controller to drive water visuals per frame
        this.water = {
            waveHeight: 0.35,
            waveFrequency: 0.8,
            foamIntensity: 0.5,
            foamDepthEnd: 2.5,
            colorShallow: 0x154550, // Darker Teal
            colorDeep: 0x001525     // Dark Navy
        };

        // --- Flags ---
        this.forceCirrusOnly = false;
        this.disableOrbitalClouds = true;
        this.disableClouds = false;
        
        // Initial Layer setup (will be overwritten by controller)
        this.cloudLayers = [];
    }
}