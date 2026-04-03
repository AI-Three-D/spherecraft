// js/renderer/clouds/CloudVolumeSelector.js
// CPU-side selection of cloud volumes for tiered rendering
// Deterministic hash-based placement with zero per-frame allocations

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class CloudVolumeSelector {
    constructor(config = {}) {
        // Configuration
        this._maxVolumes = config.maxVolumes ?? 4;
        this._cellSize = config.cellSize ?? 3000;           // meters - cloud spacing
        this._fogCellSize = config.fogCellSize ?? 800;      // meters - fog spacing (denser)
        this._tierAMaxDist = config.tierAMaxDist ?? 8000;   // full volumetric cutoff
        this._tierBMaxDist = config.tierBMaxDist ?? 25000;  // proxy cutoff
        this._minCoverage = config.minCoverage ?? 0.1;      // minimum coverage to spawn volumes
        this._seed = config.seed ?? 1337;
        this._autoScale = config.autoScale ?? true;
        this._terrainLiftFactor = config.terrainLiftFactor ?? 0.25;
        this._debugFixedVolumes = config.debugFixedVolumes ?? false;

        this._cellSizeAuto = config.cellSize === undefined;
        this._fogCellSizeAuto = config.fogCellSize === undefined;
        this._tierAAuto = config.tierAMaxDist === undefined;
        this._tierBAuto = config.tierBMaxDist === undefined;

        this._lastScaleRadius = null;
        this._lastScaleAtmo = null;
        this._lastMinCoverage = this._minCoverage;
        
        // Volume buffer: 4 volumes × 16 floats each = 64 floats
        // Layout per volume: center(3), radiusH, radiusV, altBase, coverage, lodBlend, fogType, densityMult, _pad(2)
        this._volumeBuffer = new Float32Array(4 * 16);
        this._activeCount = 0;
        
        // Params buffer: activeCount(u32) + padding(3 u32) = 16 bytes header
        // Total: 16 + 64*4 = 272 bytes, but we'll use 16 floats for simplicity
        this._paramsBuffer = new Float32Array(4 + 4 * 16); // header + volumes
        
        // Scratch vectors (reused, no allocation)
        this._scratchVec = new THREE.Vector3();
        this._scratchCamSurface = new THREE.Vector3();
        this._scratchHoriz = new THREE.Vector3();
        this._candidates = []; // Will be sized once
        for (let i = 0; i < 49; i++) { // 7x7 grid max (leave headroom for fog/caps)
            this._candidates.push({
                worldPos: new THREE.Vector3(),
                distance: 0,
                coverage: 0,
                fogType: 0,
                radiusH: 0,
                radiusV: 0
            });
        }

        this._debugAnchors = [
            { worldPos: new THREE.Vector3(), radiusH: 0, radiusV: 0, fogType: 0, coverage: 1.0, densityMult: 1.0 },
            { worldPos: new THREE.Vector3(), radiusH: 0, radiusV: 0, fogType: 2, coverage: 1.0, densityMult: 1.0 }
        ];
        this._debugAnchorsInitialized = false;
        
        this._enabled = true;
        this._debugMode = false;
    }
    
    /**
     * Deterministic hash function for cell-based placement
     * Returns value in [0, 1)
     */
    _cellHash(cellX, cellZ, seed) {
        let h = ((cellX * 2246822519) ^ (cellZ * 3266489917) ^ (seed * 668265263)) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        return (h >>> 0) / 4294967296.0;
    }
    
    /**
     * Project camera position to planet surface
     */
    _projectToSurface(cameraPos, planetConfig, out) {
        const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
        const radius = planetConfig.radius || 50000;
        
        out.set(
            cameraPos.x - origin.x,
            cameraPos.y - origin.y,
            cameraPos.z - origin.z
        );
        
        const len = out.length();
        if (len > 0.001) {
            out.multiplyScalar(radius / len);
        }
        
        out.x += origin.x;
        out.y += origin.y;
        out.z += origin.z;
        
        return out;
    }
    
    /**
     * Convert surface-relative position back to world position at given altitude
     */
    _surfaceToWorld(surfaceX, surfaceZ, altitude, planetConfig, out) {
        const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
        const radius = planetConfig.radius || 50000;
        
        // Simple planar approximation for small areas
        // For a full planetary system, use proper spherical coordinates
        const surfaceRadius = radius + altitude;
        
        // Normalize and scale
        out.set(surfaceX - origin.x, 0, surfaceZ - origin.z);
        const horizDist = out.length();
        
        if (horizDist > 0.001) {
            // Calculate position on sphere at given altitude
            const theta = horizDist / radius; // arc angle
            const cosTheta = Math.cos(theta);
            const sinTheta = Math.sin(theta);
            
            out.normalize();
            const horizontal = this._scratchHoriz;
            horizontal.copy(out);
            
            // Vertical component (up from planet center)
            const verticalHeight = surfaceRadius * cosTheta;
            const horizontalDist = surfaceRadius * sinTheta;
            
            out.set(
                origin.x + horizontal.x * horizontalDist,
                origin.y + verticalHeight,
                origin.z + horizontal.z * horizontalDist
            );
        } else {
            out.set(origin.x, origin.y + surfaceRadius, origin.z);
        }
        
        return out;
    }
    
    /**
     * Main update - selects active volumes based on camera and weather
     * @param {THREE.Camera} camera 
     * @param {Object} environmentState 
     * @param {Object} planetConfig 
     */
    update(camera, environmentState, planetConfig) {
        if (!this._enabled || !planetConfig) {
            this._activeCount = 0;
            this._updateParamsBuffer();
            return;
        }

        this._applyAutoScale(planetConfig);
        
        const weather = environmentState?.currentWeather || 'clear';
        const weatherIntensity = environmentState?.weatherIntensity ?? 0;
        const rawCoverage = environmentState?.cloudCoverage;
        const coverage = this._clamp(
            (rawCoverage !== undefined && rawCoverage > 0.001)
                ? rawCoverage
                : this._getCoverageForWeather(weather, weatherIntensity),
            0,
            1
        );
        const minCoverage = this._getMinCoverageForWeather(weather);
        this._lastMinCoverage = minCoverage;
        
        // Skip if coverage too low
        if (coverage < minCoverage && !this._debugFixedVolumes) {
            this._activeCount = 0;
            this._updateParamsBuffer();
            return;
        }
        
        const seed = planetConfig.seed ?? this._seed;
        const cameraPos = camera.position;
        
        // Project camera to surface
        this._projectToSurface(cameraPos, planetConfig, this._scratchCamSurface);
        const camSurfaceX = this._scratchCamSurface.x;
        const camSurfaceZ = this._scratchCamSurface.z;
        
        // Get layer parameters for cloud altitude
        const layers = environmentState?.cloudLayers || [];
        const lowLayer = layers.find(l => l.name === 'low') || { altMin: 500, altMax: 2000 };
        const midLayer = layers.find(l => l.name === 'mid') || { altMin: lowLayer.altMax + 500, altMax: lowLayer.altMax + 2500 };
        const highLayer = layers.find(l => l.name === 'high') || { altMin: midLayer.altMax + 1000, altMax: midLayer.altMax + 4000 };
        const baseAltitude = lowLayer.altMin + (lowLayer.altMax - lowLayer.altMin) * 0.3;
        const terrainLift = Math.max(50, lowLayer.altMin * this._terrainLiftFactor);
        
        let candidateCount = 0;
        const maxCandidates = this._candidates.length;
        
        // Scan 5x5 grid of cells around camera
        const baseCellX = Math.floor(camSurfaceX / this._cellSize);
        const baseCellZ = Math.floor(camSurfaceZ / this._cellSize);
        
        for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
                if (candidateCount >= maxCandidates) break;
                const cellX = baseCellX + dx;
                const cellZ = baseCellZ + dz;
                
                // Hash determines if cell has a cloud
                const h = this._cellHash(cellX, cellZ, seed);
                const coverageBoost = 0.9 + weatherIntensity * 0.4;
                if (h > coverage * coverageBoost) continue; // Coverage threshold with slight boost
                
                // Perturb position within cell (deterministic)
                const h2 = this._cellHash(cellX + 7919, cellZ + 2053, seed);
                const h3 = this._cellHash(cellX + 3571, cellZ + 8191, seed);
                const h4 = this._cellHash(cellX + 1237, cellZ + 9973, seed);
                
                const worldX = (cellX + 0.3 + h2 * 0.4) * this._cellSize;
                const worldZ = (cellZ + 0.3 + h3 * 0.4) * this._cellSize;
                
                // Convert to world position at cloud altitude
                const altitudeVariation = (h4 - 0.5) * (lowLayer.altMax - lowLayer.altMin) * 0.3;
                const cloudAltitude = baseAltitude + altitudeVariation + terrainLift;
                
                this._surfaceToWorld(
                    worldX, worldZ, 
                    cloudAltitude, 
                    planetConfig, 
                    this._scratchVec
                );
                
                const dist = cameraPos.distanceTo(this._scratchVec);
                
                // Skip if beyond proxy distance
                if (dist > this._tierBMaxDist) continue;
                
                // Store candidate
                const candidate = this._candidates[candidateCount];
                candidate.worldPos.copy(this._scratchVec);
                candidate.distance = dist;
                candidate.coverage = h; // Use hash as local coverage variation
                candidate.fogType = 0;  // Cumulus
                
                // Size variation based on hash
                const sizeScale = 0.8 + h4 * 0.4;
                const weatherScale = 0.9 + weatherIntensity * 0.4;
                candidate.radiusH = this._cellSize * 0.45 * sizeScale * weatherScale;
                candidate.radiusV = this._cellSize * 0.28 * sizeScale * weatherScale;
                
                candidateCount++;
            }
        }
        
        // Check for valley fog conditions
        if (weatherIntensity > 0.3 && weather !== 'clear') {
            // Add fog volumes at lower altitude in nearby cells
            const fogBaseCellX = Math.floor(camSurfaceX / this._fogCellSize);
            const fogBaseCellZ = Math.floor(camSurfaceZ / this._fogCellSize);
            
            for (let dz = -1; dz <= 1 && candidateCount < maxCandidates; dz++) {
                for (let dx = -1; dx <= 1 && candidateCount < maxCandidates; dx++) {
                    const cellX = fogBaseCellX + dx;
                    const cellZ = fogBaseCellZ + dz;
                    
                    const fh = this._cellHash(cellX + 50000, cellZ + 50000, seed);
                    if (fh > weatherIntensity * 0.5) continue;
                    
                    const fh2 = this._cellHash(cellX + 60000, cellZ + 60000, seed);
                    const fh3 = this._cellHash(cellX + 70000, cellZ + 70000, seed);
                    
                    const fogX = (cellX + 0.2 + fh2 * 0.6) * this._fogCellSize;
                    const fogZ = (cellZ + 0.2 + fh3 * 0.6) * this._fogCellSize;
                    
                    // Fog at very low altitude
                    const fogAltitude = lowLayer.altMin * 0.25 + terrainLift * 0.3;
                    
                    this._surfaceToWorld(fogX, fogZ, fogAltitude, planetConfig, this._scratchVec);
                    
                    const dist = cameraPos.distanceTo(this._scratchVec);
                    if (dist > this._tierAMaxDist * 1.5) continue; // Fog only at close range
                    
                    const candidate = this._candidates[candidateCount];
                    candidate.worldPos.copy(this._scratchVec);
                    candidate.distance = dist;
                    candidate.coverage = fh;
                    candidate.fogType = 1; // Valley fog
                    candidate.radiusH = this._fogCellSize * 0.7;
                    candidate.radiusV = this._fogCellSize * 0.18;
                    
                    candidateCount++;
                }
            }
        }

        // Mountain cap clouds for stormy/overcast weather
        const allowCaps = weatherIntensity > 0.5 || weather === 'overcast' || weather === 'storm';
        if (allowCaps) {
            const capCellSize = this._cellSize * 1.2;
            const capBaseCellX = Math.floor(camSurfaceX / capCellSize);
            const capBaseCellZ = Math.floor(camSurfaceZ / capCellSize);
            const capAltitudeBase = midLayer.altMin + (highLayer.altMin - midLayer.altMin) * 0.15 + terrainLift * 0.4;
            const capAltitudeRange = Math.max(500, (highLayer.altMin - midLayer.altMin) * 0.4);
            
            for (let dz = -1; dz <= 1 && candidateCount < maxCandidates; dz++) {
                for (let dx = -1; dx <= 1 && candidateCount < maxCandidates; dx++) {
                    const cellX = capBaseCellX + dx;
                    const cellZ = capBaseCellZ + dz;
                    
                    const mh = this._cellHash(cellX + 90000, cellZ + 90000, seed);
                    if (mh > (0.35 + (1.0 - weatherIntensity) * 0.35)) continue;
                    
                    const mh2 = this._cellHash(cellX + 91000, cellZ + 91000, seed);
                    const mh3 = this._cellHash(cellX + 92000, cellZ + 92000, seed);
                    
                    const capX = (cellX + 0.4 + mh2 * 0.3) * capCellSize;
                    const capZ = (cellZ + 0.4 + mh3 * 0.3) * capCellSize;
                    
                    const capAltitude = capAltitudeBase + (mh2 - 0.5) * capAltitudeRange;
                    this._surfaceToWorld(capX, capZ, capAltitude, planetConfig, this._scratchVec);
                    
                    const dist = cameraPos.distanceTo(this._scratchVec);
                    if (dist > this._tierBMaxDist) continue;
                    
                    const candidate = this._candidates[candidateCount];
                    candidate.worldPos.copy(this._scratchVec);
                    candidate.distance = dist;
                    candidate.coverage = mh;
                    candidate.fogType = 2; // Mountain cap
                    candidate.radiusH = capCellSize * 0.45;
                    candidate.radiusV = capCellSize * 0.2;
                    
                    candidateCount++;
                }
            }
        }

        // Add fixed debug volumes for visual validation (anchored once near camera)
        if (this._debugFixedVolumes) {
            this._ensureDebugAnchors(camSurfaceX, camSurfaceZ, baseAltitude, terrainLift, planetConfig);
            for (const anchor of this._debugAnchors) {
                if (candidateCount >= maxCandidates) break;
                const dist = cameraPos.distanceTo(anchor.worldPos);
                if (dist > this._tierBMaxDist) continue;
                
                const candidate = this._candidates[candidateCount];
                candidate.worldPos.copy(anchor.worldPos);
                candidate.distance = dist;
                candidate.coverage = anchor.coverage;
                candidate.fogType = anchor.fogType;
                candidate.radiusH = anchor.radiusH;
                candidate.radiusV = anchor.radiusV;
                candidateCount++;
            }
        }
        
        // Sort by distance
        const activeCandidates = this._candidates.slice(0, candidateCount);
        activeCandidates.sort((a, b) => a.distance - b.distance);
        
        // Take closest N volumes
        this._activeCount = Math.min(candidateCount, this._maxVolumes);
        
        // Write to volume buffer
        for (let i = 0; i < this._activeCount; i++) {
            const c = activeCandidates[i];
            const base = i * 16;
            
            // Calculate LOD blend
            const lodBlend = this._smoothstep(
                this._tierAMaxDist * 0.6,
                this._tierAMaxDist * 1.05,
                c.distance
            );
            
            this._volumeBuffer[base + 0] = c.worldPos.x;
            this._volumeBuffer[base + 1] = c.worldPos.y;
            this._volumeBuffer[base + 2] = c.worldPos.z;
            this._volumeBuffer[base + 3] = c.radiusH;
            this._volumeBuffer[base + 4] = c.radiusV;
            this._volumeBuffer[base + 5] = 0; // altitudeBase (computed from worldPos)
            this._volumeBuffer[base + 6] = c.coverage;
            this._volumeBuffer[base + 7] = lodBlend;
            this._volumeBuffer[base + 8] = c.fogType;
            this._volumeBuffer[base + 9] = 1.0; // densityMult
            this._volumeBuffer[base + 10] = 0; // _pad0
            this._volumeBuffer[base + 11] = 0; // _pad1
            // Indices 12-15 unused (padding to 16)
            this._volumeBuffer[base + 12] = 0;
            this._volumeBuffer[base + 13] = 0;
            this._volumeBuffer[base + 14] = 0;
            this._volumeBuffer[base + 15] = 0;
        }
        
        // Clear unused volume slots
        for (let i = this._activeCount; i < this._maxVolumes; i++) {
            const base = i * 16;
            for (let j = 0; j < 16; j++) {
                this._volumeBuffer[base + j] = 0;
            }
        }
        
        this._updateParamsBuffer();
        
        if (this._debugMode && this._activeCount > 0) {
            console.log(`[CloudVolumeSelector] Active volumes: ${this._activeCount}, closest dist: ${activeCandidates[0]?.distance.toFixed(0)}m`);
        }
    }
    
    _smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }
    
    _updateParamsBuffer() {
        // Header: activeCount as float (will be cast to u32 in shader)
        const intView = new Uint32Array(this._paramsBuffer.buffer, 0, 4);
        intView[0] = this._activeCount;
        intView[1] = 0;
        intView[2] = 0;
        intView[3] = 0;
        
        // Copy volume data
        this._paramsBuffer.set(this._volumeBuffer, 4);
    }
    
    /**
     * Get the params buffer for GPU upload
     * Layout: [activeCount(u32), pad, pad, pad, VolumeDesc[0], VolumeDesc[1], VolumeDesc[2], VolumeDesc[3]]
     */
    getParamsBuffer() {
        return this._paramsBuffer;
    }
    
    /**
     * Get just the volume buffer (without header)
     */
    getVolumeBuffer() {
        return this._volumeBuffer;
    }
    
    getActiveCount() {
        return this._activeCount;
    }

    getTierAMaxDist() {
        return this._tierAMaxDist;
    }

    getTierBMaxDist() {
        return this._tierBMaxDist;
    }

    getCellSize() {
        return this._cellSize;
    }

    getFogCellSize() {
        return this._fogCellSize;
    }

    getMinCoverage() {
        return this._lastMinCoverage ?? this._minCoverage;
    }

    getDebugFixedVolumes() {
        return this._debugFixedVolumes;
    }
    
    setEnabled(enabled) {
        this._enabled = enabled;
    }
    
    setDebugMode(debug) {
        this._debugMode = debug;
    }

    setDebugFixedVolumes(enabled) {
        this._debugFixedVolumes = enabled;
        if (!enabled) {
            this._debugAnchorsInitialized = false;
        }
    }
    
    /**
     * Configuration setters
     */
    setTierDistances(tierAMax, tierBMax) {
        this._tierAMaxDist = tierAMax;
        this._tierBMaxDist = tierBMax;
        this._tierAAuto = false;
        this._tierBAuto = false;
    }
    
    setCellSize(cloudCellSize, fogCellSize) {
        this._cellSize = cloudCellSize;
        this._cellSizeAuto = false;
        if (fogCellSize !== undefined) {
            this._fogCellSize = fogCellSize;
            this._fogCellSizeAuto = false;
        }
    }

    _applyAutoScale(planetConfig) {
        if (!this._autoScale || !planetConfig) return;

        const radius = planetConfig.radius || 50000;
        const atmoHeight = planetConfig.atmosphereHeight || radius * 0.2;

        if (this._lastScaleRadius === radius && this._lastScaleAtmo === atmoHeight) return;

        const baseCell = this._clamp(atmoHeight * 0.12, 1200, 10000);
        const prevCell = this._cellSize;

        if (this._cellSizeAuto) {
            this._cellSize = baseCell;
        }
        if (this._fogCellSizeAuto) {
            this._fogCellSize = baseCell * 0.25;
        }
        if (this._tierAAuto) {
            this._tierAMaxDist = this._clamp(atmoHeight * 0.3, baseCell * 2.0, atmoHeight * 0.7);
        }
        if (this._tierBAuto) {
            this._tierBMaxDist = this._clamp(atmoHeight * 0.95, this._tierAMaxDist * 2.5, atmoHeight * 1.8);
        }

        if (prevCell !== this._cellSize) {
            this._debugAnchorsInitialized = false;
        }

        this._lastScaleRadius = radius;
        this._lastScaleAtmo = atmoHeight;
    }

    _getCoverageForWeather(weather, intensity) {
        const clamped = this._clamp(intensity, 0, 1);
        switch (weather) {
            case 'clear': return 0.1;
            case 'partly_cloudy': return 0.35 + clamped * 0.2;
            case 'cloudy': return 0.5 + clamped * 0.2;
            case 'overcast': return 0.75 + clamped * 0.2;
            case 'rain': return 0.8 + clamped * 0.15;
            case 'storm': return 0.9 + clamped * 0.1;
            case 'foggy': return 0.45 + clamped * 0.2;
            default: return 0.3;
        }
    }

    _getMinCoverageForWeather(weather) {
        switch (weather) {
            case 'clear': return 0.05;
            case 'partly_cloudy': return 0.08;
            case 'cloudy': return 0.12;
            case 'overcast': return 0.18;
            case 'rain': return 0.22;
            case 'storm': return 0.28;
            case 'foggy': return 0.1;
            default: return this._minCoverage;
        }
    }

    _ensureDebugAnchors(surfaceX, surfaceZ, baseAltitude, terrainLift, planetConfig) {
        if (this._debugAnchorsInitialized) return;

        const offsets = [
            { x: this._cellSize * 0.6, z: this._cellSize * 0.2, fogType: 0 },
            { x: -this._cellSize * 0.4, z: this._cellSize * 0.7, fogType: 2 }
        ];

        for (let i = 0; i < this._debugAnchors.length; i++) {
            const anchor = this._debugAnchors[i];
            const offset = offsets[i % offsets.length];
            const altitude = baseAltitude + terrainLift * 0.8;

            this._surfaceToWorld(
                surfaceX + offset.x,
                surfaceZ + offset.z,
                altitude,
                planetConfig,
                anchor.worldPos
            );

            anchor.radiusH = this._cellSize * 0.55;
            anchor.radiusV = this._cellSize * 0.32;
            anchor.fogType = offset.fogType;
        }

        this._debugAnchorsInitialized = true;
    }

    _clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
