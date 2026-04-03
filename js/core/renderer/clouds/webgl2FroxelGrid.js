// js/renderer/clouds/webgl2FroxelGrid.js
// WebGL2-compatible froxel grid using CPU noise generation
// Creates a 2D texture representing flattened 3D volume

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

const DEFAULT_DIMS = { x: 32, y: 24, z: 32 };

export class WebGL2FroxelGrid {
    constructor(backend, dimensions = DEFAULT_DIMS) {
        this.backend = backend;
        this.dimensions = {
            x: dimensions.x || DEFAULT_DIMS.x,
            y: dimensions.y || DEFAULT_DIMS.y,
            z: dimensions.z || DEFAULT_DIMS.z
        };

        this.texture = null;
        this._initialized = false;

        // Volume bounds
        this.volumeSize = new THREE.Vector3(8000, 4000, 12000);
        this.maxDistance = 12000;

        // For animation
        this._time = 0;
        this._lastUpdate = 0;
    }

    async initialize() {
        if (this._initialized) return;

        const width = this.dimensions.x;
        const height = this.dimensions.y * this.dimensions.z;

        // Create RGBA data for the flattened 3D texture
        const data = new Uint8Array(width * height * 4);
        this._generateNoiseData(data, 0);

        // Create Three.js DataTexture
        this.texture = new THREE.DataTexture(
            data,
            width,
            height,
            THREE.RGBAFormat,
            THREE.UnsignedByteType
        );
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.ClampToEdgeWrapping;
        this.texture.wrapT = THREE.ClampToEdgeWrapping;
        this.texture.needsUpdate = true;

        this._initialized = true;
    }

    getTexture() {
        return this.texture;
    }

    getDimensions() {
        return this.dimensions;
    }

    getCoverageForWeather(weather, intensity) {
        return this._computeCoverage(weather, intensity);
    }

    update(camera, environmentState, uniformManager, planetConfig) {
        if (!this._initialized || !this.texture) return;

        // Update time-based animation (regenerate noise periodically)
        const now = performance.now();
        if (now - this._lastUpdate > 2000) { // Update every 2 seconds
            this._time = (now / 1000) % 10000;
            this._generateNoiseData(this.texture.image.data, this._time);
            this.texture.needsUpdate = true;
            this._lastUpdate = now;
        }
    }

    _generateNoiseData(data, time) {
        const dimX = this.dimensions.x;
        const dimY = this.dimensions.y;
        const dimZ = this.dimensions.z;

        for (let z = 0; z < dimZ; z++) {
            for (let y = 0; y < dimY; y++) {
                for (let x = 0; x < dimX; x++) {
                    // Flatten 3D coords to 2D texture
                    const flatY = y + z * dimY;
                    const idx = (flatY * dimX + x) * 4;

                    // Normalize coordinates
                    const nx = x / dimX;
                    const ny = y / dimY;
                    const nz = z / dimZ;

                    // Generate layered noise for clouds
                    const cumulus = this._fbm(nx * 4 + time * 0.01, ny * 2, nz * 4, 4);
                    const cirrus = this._fbm(nx * 8 + 100, ny * 1 + time * 0.02, nz * 8, 3);

                    // Height-based falloff for cumulus (lower layer)
                    const cumulusHeight = Math.max(0, 1 - Math.abs(ny - 0.3) * 3);
                    // Height-based falloff for cirrus (higher layer)
                    const cirrusHeight = Math.max(0, 1 - Math.abs(ny - 0.7) * 4);

                    // Apply height falloffs
                    const finalCumulus = Math.max(0, cumulus * cumulusHeight);
                    const finalCirrus = Math.max(0, cirrus * cirrusHeight * 0.5);

                    // Pack into RGBA (r=cumulus, g=cirrus, b=unused, a=lighting)
                    data[idx + 0] = Math.floor(finalCumulus * 255);
                    data[idx + 1] = Math.floor(finalCirrus * 255);
                    data[idx + 2] = 0;
                    data[idx + 3] = Math.floor((0.5 + cumulus * 0.5) * 255); // Ambient occlusion hint
                }
            }
        }
    }

    // Fractional Brownian Motion noise
    _fbm(x, y, z, octaves) {
        let value = 0;
        let amplitude = 0.5;
        let frequency = 1;
        let maxValue = 0;

        for (let i = 0; i < octaves; i++) {
            value += this._noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= 0.5;
            frequency *= 2;
        }

        return value / maxValue;
    }

    // Simple 3D noise (value noise)
    _noise3D(x, y, z) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const Z = Math.floor(z) & 255;

        x -= Math.floor(x);
        y -= Math.floor(y);
        z -= Math.floor(z);

        const u = this._fade(x);
        const v = this._fade(y);
        const w = this._fade(z);

        // Hash coordinates
        const A = this._hash(X) + Y;
        const AA = this._hash(A) + Z;
        const AB = this._hash(A + 1) + Z;
        const B = this._hash(X + 1) + Y;
        const BA = this._hash(B) + Z;
        const BB = this._hash(B + 1) + Z;

        // Blend results
        const result = this._lerp(w,
            this._lerp(v,
                this._lerp(u, this._grad(this._hash(AA), x, y, z),
                    this._grad(this._hash(BA), x - 1, y, z)),
                this._lerp(u, this._grad(this._hash(AB), x, y - 1, z),
                    this._grad(this._hash(BB), x - 1, y - 1, z))),
            this._lerp(v,
                this._lerp(u, this._grad(this._hash(AA + 1), x, y, z - 1),
                    this._grad(this._hash(BA + 1), x - 1, y, z - 1)),
                this._lerp(u, this._grad(this._hash(AB + 1), x, y - 1, z - 1),
                    this._grad(this._hash(BB + 1), x - 1, y - 1, z - 1))));

        return (result + 1) / 2; // Normalize to 0-1
    }

    _fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    _lerp(t, a, b) {
        return a + t * (b - a);
    }

    _hash(n) {
        // Simple hash function
        return ((n * 1103515245 + 12345) >> 16) & 255;
    }

    _grad(hash, x, y, z) {
        const h = hash & 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }

    _computeCoverage(weather, intensity) {
        const clamped = Math.min(Math.max(intensity || 0, 0), 1);
        let cumulus = 0.3;
        let cirrus = 0.25;

        switch (weather) {
            case 'storm':
                cumulus = 0.7 + clamped * 0.25;
                cirrus = 0.3 + clamped * 0.2;
                break;
            case 'rain':
                cumulus = 0.5 + clamped * 0.3;
                cirrus = 0.25 + clamped * 0.15;
                break;
            case 'foggy':
                cumulus = 0.4 + clamped * 0.2;
                cirrus = 0.2 + clamped * 0.1;
                break;
            case 'snow':
                cumulus = 0.45 + clamped * 0.25;
                cirrus = 0.3 + clamped * 0.15;
                break;
            case 'clear':
            default:
                cumulus = 0.15 + clamped * 0.15;
                cirrus = 0.2 + clamped * 0.1;
                break;
        }

        return { cumulus, cirrus };
    }

    dispose() {
        if (this.texture) {
            this.texture.dispose();
            this.texture = null;
        }
        this._initialized = false;
    }
}
