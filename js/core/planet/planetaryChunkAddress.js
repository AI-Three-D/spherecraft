import { CubeSphereFace, getFaceName } from './cubeSphereFace.js';
import { createChunkKey, chunkKeyToString, parseChunkKey } from '../world/chunkKey.js';

export class PlanetaryChunkAddress {
    constructor(face, x, y, lod = 0) {
        this.face = face;
        this.x = x;
        this.y = y;
        this.lod = lod;
    }
    
    get key() {
        return createChunkKey(this.face, this.lod, this.x, this.y);
    }

    get keyString() {
        return chunkKeyToString(this.key);
    }
    
    static fromKey(key) {
        const parsed = parseChunkKey(key);
        const face = parsed.face ?? -1;
        return new PlanetaryChunkAddress(face, parsed.x, parsed.y, parsed.level);
    }
    
    getNeighbors(chunksPerFace) {
        const neighbors = [];
        const directions = [
            { dx: -1, dy: 0 }, // Left
            { dx: 1, dy: 0 },  // Right
            { dx: 0, dy: -1 }, // Down
            { dx: 0, dy: 1 }   // Up
        ];
        
        for (const { dx, dy } of directions) {
            const nx = this.x + dx;
            const ny = this.y + dy;
            
            if (nx >= 0 && nx < chunksPerFace && ny >= 0 && ny < chunksPerFace) {
                // Standard neighbor on same face
                neighbors.push(new PlanetaryChunkAddress(this.face, nx, ny, this.lod));
            } else {
                // Edge crossing - wrap to neighbor face
                const wrapped = this._wrapToAdjacentFace(nx, ny, chunksPerFace);
                if (wrapped) {
                    neighbors.push(wrapped);
                }
            }
        }
        return neighbors;
    }
    
    _wrapToAdjacentFace(x, y, chunksPerFace) {
        const max = chunksPerFace - 1;
        
        // Definitions based on Standard Cube Map UV winding
        // 0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
        const faceTransitions = {
            [CubeSphereFace.POSITIVE_X]: { // Right Face
                left:  { face: CubeSphereFace.POSITIVE_Z, transform: (x, y) => [max, y] },
                right: { face: CubeSphereFace.NEGATIVE_Z, transform: (x, y) => [0, y] },
                up:    { face: CubeSphereFace.POSITIVE_Y, transform: (x, y) => [max, max - x] }, // Rotated
                down:  { face: CubeSphereFace.NEGATIVE_Y, transform: (x, y) => [max, x] }        // Rotated
            },
            [CubeSphereFace.NEGATIVE_X]: { // Left Face
                left:  { face: CubeSphereFace.NEGATIVE_Z, transform: (x, y) => [max, y] },
                right: { face: CubeSphereFace.POSITIVE_Z, transform: (x, y) => [0, y] },
                up:    { face: CubeSphereFace.POSITIVE_Y, transform: (x, y) => [0, x] },         // Rotated
                down:  { face: CubeSphereFace.NEGATIVE_Y, transform: (x, y) => [0, max - x] }    // Rotated
            },
            [CubeSphereFace.POSITIVE_Y]: { // Top Face
                left:  { face: CubeSphereFace.NEGATIVE_X, transform: (x, y) => [y, 0] },         // Rotated
                right: { face: CubeSphereFace.POSITIVE_X, transform: (x, y) => [max - y, max] }, // Rotated
                up:    { face: CubeSphereFace.NEGATIVE_Z, transform: (x, y) => [max - x, 0] },   // Rotated
                down:  { face: CubeSphereFace.POSITIVE_Z, transform: (x, y) => [x, max] }
            },
            [CubeSphereFace.NEGATIVE_Y]: { // Bottom Face
                left:  { face: CubeSphereFace.NEGATIVE_X, transform: (x, y) => [max - y, max] }, // Rotated
                right: { face: CubeSphereFace.POSITIVE_X, transform: (x, y) => [y, 0] },         // Rotated
                up:    { face: CubeSphereFace.POSITIVE_Z, transform: (x, y) => [x, 0] },
                down:  { face: CubeSphereFace.NEGATIVE_Z, transform: (x, y) => [max - x, max] }  // Rotated
            },
            [CubeSphereFace.POSITIVE_Z]: { // Front Face
                left:  { face: CubeSphereFace.NEGATIVE_X, transform: (x, y) => [max, y] },
                right: { face: CubeSphereFace.POSITIVE_X, transform: (x, y) => [0, y] },
                up:    { face: CubeSphereFace.POSITIVE_Y, transform: (x, y) => [x, 0] },
                down:  { face: CubeSphereFace.NEGATIVE_Y, transform: (x, y) => [x, max] }
            },
            [CubeSphereFace.NEGATIVE_Z]: { // Back Face
                left:  { face: CubeSphereFace.POSITIVE_X, transform: (x, y) => [max, y] },
                right: { face: CubeSphereFace.NEGATIVE_X, transform: (x, y) => [0, y] },
                up:    { face: CubeSphereFace.POSITIVE_Y, transform: (x, y) => [max - x, 0] },   // Rotated
                down:  { face: CubeSphereFace.NEGATIVE_Y, transform: (x, y) => [max - x, max] }  // Rotated
            }
        };
        
        let direction = null;
        if (x < 0) direction = 'left';
        else if (x >= chunksPerFace) direction = 'right';
        else if (y < 0) direction = 'down';
        else if (y >= chunksPerFace) direction = 'up';
        
        if (!direction) return null;

        const transition = faceTransitions[this.face]?.[direction];
        if (!transition) return null;

        let overshoot = 0;
        let clampedX = x;
        let clampedY = y;
        if (direction === 'left') {
            overshoot = -x - 1;
            clampedX = 0;
            clampedY = Math.max(0, Math.min(max, y));
        } else if (direction === 'right') {
            overshoot = x - chunksPerFace;
            clampedX = max;
            clampedY = Math.max(0, Math.min(max, y));
        } else if (direction === 'down') {
            overshoot = -y - 1;
            clampedX = Math.max(0, Math.min(max, x));
            clampedY = 0;
        } else if (direction === 'up') {
            overshoot = y - chunksPerFace;
            clampedX = Math.max(0, Math.min(max, x));
            clampedY = max;
        }

        let [nx, ny] = transition.transform(clampedX, clampedY);
        if (direction === 'left' || direction === 'up') {
            ny = ny + overshoot;
        } else if (direction === 'right' || direction === 'down') {
            ny = ny - overshoot;
        }
        if (nx < 0 || nx > max || ny < 0 || ny > max) return null;
        return new PlanetaryChunkAddress(transition.face, nx, ny, this.lod);
    }
}
