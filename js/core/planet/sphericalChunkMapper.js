// js/planet/sphericalChunkMapper.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { CubeSphereCoords } from './cubeSphereCoords.js';
import { PlanetaryChunkAddress } from './planetaryChunkAddress.js';
import { createChunkKey } from '../world/chunkKey.js';
import { requireInt, requireNumber, requireObject } from '../../shared/requireUtil.js';
export class SphericalChunkMapper {
    constructor(planetConfig) {
        this.config = requireObject(planetConfig, 'planetConfig');
        this.chunksPerFace = requireInt(this.config.chunksPerFace, 'planetConfig.chunksPerFace', 1);
        this.origin = requireObject(this.config.origin, 'planetConfig.origin');
        this.radius = requireNumber(this.config.radius, 'planetConfig.radius');
        this.chunkSize = requireNumber(this.config.surfaceChunkSize, 'planetConfig.surfaceChunkSize');
    }

    worldPositionToChunkKey(position) {
        const address = this.worldPositionToChunkAddress(position);
        return address.key;
    }

    worldPositionToChunkAddress(position) {
        const relativePos = position.clone().sub(this.origin);
        
        // This calculates which Cube Face and X,Y coords the position belongs to
        const addressData = CubeSphereCoords.getChunkAddress(
            relativePos,
            this.radius,
            this.chunkSize, // Use actual chunk size in meters
            this.chunksPerFace 
        );
        
        return new PlanetaryChunkAddress(
            addressData.face,
            addressData.chunkX,
            addressData.chunkY,
            0 
        );
    }

    getChunksInRadius(cameraPosition, radius) {
        const centerAddress = this.worldPositionToChunkAddress(cameraPosition);
        const radiusInChunks = Math.ceil(radius / this.chunkSize);
        
        // For large radii, use a more efficient approach
        if (radiusInChunks > 5) {
            return this._getChunksInRadiusFast(centerAddress, radiusInChunks);
        }
        
        // Original BFS for small radii
        const visited = new Set();
        const results = [];
        const queue = [{ address: centerAddress, distance: 0 }];
        
        visited.add(centerAddress.key);
        results.push(centerAddress.key);
        
        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];
            if (current.distance >= radiusInChunks) continue;
            
            const neighbors = current.address.getNeighbors(this.chunksPerFace);
            
            for (const neighbor of neighbors) {
                const key = neighbor.key;
                if (!visited.has(key)) {
                    visited.add(key);
                    results.push(key);
                    queue.push({ address: neighbor, distance: current.distance + 1 });
                }
            }
        }
        return results;
    }
    
    _getChunksInRadiusFast(centerAddress, radiusInChunks) {
        const results = [];
        const visited = new Set();
        
        // Start with the center face and expand in a grid pattern
        const face = centerAddress.face;
        const cx = centerAddress.x;
        const cy = centerAddress.y;
        
        // Collect chunks in a square pattern on the primary face
        for (let dy = -radiusInChunks; dy <= radiusInChunks; dy++) {
            for (let dx = -radiusInChunks; dx <= radiusInChunks; dx++) {
                // Use circular distance check for more natural coverage
                if (dx * dx + dy * dy > radiusInChunks * radiusInChunks) continue;
                
                let nx = cx + dx;
                let ny = cy + dy;
                
                // Check if within current face bounds
                if (nx >= 0 && nx < this.chunksPerFace && ny >= 0 && ny < this.chunksPerFace) {
                    const key = createChunkKey(face, 0, nx, ny);
                    if (!visited.has(key)) {
                        visited.add(key);
                        results.push(key);
                    }
                } else {
                    // Handle face wrapping using PlanetaryChunkAddress
                    const tempAddress = new (centerAddress.constructor)(face, cx + dx, cy + dy, 0);
                    const wrapped = tempAddress._wrapToAdjacentFace(nx, ny, this.chunksPerFace);
                    if (wrapped) {
                        const key = wrapped.key;
                        if (!visited.has(key)) {
                            visited.add(key);
                            results.push(key);
                        }
                    }
                }
            }
        }
        
        return results;
    }
   
    getFaceAndLocalCoords(input) {
        // Handle Vector3 Input (Precise)
        if (input instanceof THREE.Vector3) {
            const relativePos = new THREE.Vector3().subVectors(input, this.origin);
            const { face, u, v } = CubeSphereCoords.worldPositionToFaceUV(relativePos, this.radius);
            
            // Convert -1..1 UV to 0..chunksPerFace
            const globalU = (u + 1) * 0.5 * this.chunksPerFace;
            const globalV = (v + 1) * 0.5 * this.chunksPerFace;
            
            return {
                face: face,
                u: globalU - Math.floor(globalU),
                v: globalV - Math.floor(globalV)
            };
        }
        
        // Handle Morton or legacy string key input (Approximate center)
        const address = PlanetaryChunkAddress.fromKey(input);
        return {
            face: address.face,
            u: 0.5,
            v: 0.5,
            uMin: address.x / this.chunksPerFace,
            uMax: (address.x + 1) / this.chunksPerFace,
            vMin: address.y / this.chunksPerFace,
            vMax: (address.y + 1) / this.chunksPerFace
        };
    }
}
