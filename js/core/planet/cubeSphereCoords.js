// js/planet/CubeSphereCoords.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { CubeSphereFace, getFaceNormal, getFaceUp, getFaceRight } from './cubeSphereFace.js';

export class CubeSphereCoords {
    static cubeToSphere(x, y, z) {
        const x2 = x * x;
        const y2 = y * y;
        const z2 = z * z;
        
        const sx = x * Math.sqrt(1.0 - y2 * 0.5 - z2 * 0.5 + y2 * z2 / 3.0);
        const sy = y * Math.sqrt(1.0 - z2 * 0.5 - x2 * 0.5 + z2 * x2 / 3.0);
        const sz = z * Math.sqrt(1.0 - x2 * 0.5 - y2 * 0.5 + x2 * y2 / 3.0);
        
        return new THREE.Vector3(sx, sy, sz);
    }
    
    static sphereToCube(x, y, z) {
        const ax = Math.abs(x);
        const ay = Math.abs(y);
        const az = Math.abs(z);
        
        let face;
        let u, v;
        
        if (ax >= ay && ax >= az) {
            face = x > 0 ? CubeSphereFace.POSITIVE_X : CubeSphereFace.NEGATIVE_X;
            const scale = 1.0 / ax;
            u = x > 0 ? -z * scale : z * scale;
            v = y * scale;
        } else if (ay >= ax && ay >= az) {
            face = y > 0 ? CubeSphereFace.POSITIVE_Y : CubeSphereFace.NEGATIVE_Y;
            const scale = 1.0 / ay;
            u = x * scale;
            v = y > 0 ? -z * scale : z * scale;
        } else {
            face = z > 0 ? CubeSphereFace.POSITIVE_Z : CubeSphereFace.NEGATIVE_Z;
            const scale = 1.0 / az;
            u = z > 0 ? x * scale : -x * scale;
            v = y * scale;
        }
        
        return { face, u, v };
    }
    
    static faceUVToWorldPosition(face, u, v, radius, height = 0) {
        const normal = getFaceNormal(face);
        const up = getFaceUp(face);
        const right = getFaceRight(face);
        
        const cubeX = normal[0] + right[0] * u + up[0] * v;
        const cubeY = normal[1] + right[1] * u + up[1] * v;
        const cubeZ = normal[2] + right[2] * u + up[2] * v;
        
        const spherePos = this.cubeToSphere(cubeX, cubeY, cubeZ);
        
        const totalRadius = radius + height;
        return spherePos.multiplyScalar(totalRadius);
    }
    
    static worldPositionToFaceUV(position, radius) {
        const normalized = position.clone().normalize();
        const { face, u, v } = this.sphereToCube(normalized.x, normalized.y, normalized.z);
        const altitude = position.length() - radius;
        
        return { face, u, v, altitude };
    }
    
    static getChunkAddress(position, radius, chunkSize, chunksPerFace) {
        const { face, u, v, altitude } = this.worldPositionToFaceUV(position, radius);
        
        const normalizedU = (u + 1) * 0.5;
        const normalizedV = (v + 1) * 0.5;
        
        const chunkX = Math.floor(normalizedU * chunksPerFace);
        const chunkY = Math.floor(normalizedV * chunksPerFace);
        
        return {
            face,
            chunkX: Math.max(0, Math.min(chunksPerFace - 1, chunkX)),
            chunkY: Math.max(0, Math.min(chunksPerFace - 1, chunkY)),
            altitude
        };
    }
    
    static getChunkWorldBounds(face, chunkX, chunkY, chunksPerFace, radius) {
        const uMin = (chunkX / chunksPerFace) * 2 - 1;
        const uMax = ((chunkX + 1) / chunksPerFace) * 2 - 1;
        const vMin = (chunkY / chunksPerFace) * 2 - 1;
        const vMax = ((chunkY + 1) / chunksPerFace) * 2 - 1;
        
        const corners = [
            this.faceUVToWorldPosition(face, uMin, vMin, radius),
            this.faceUVToWorldPosition(face, uMax, vMin, radius),
            this.faceUVToWorldPosition(face, uMin, vMax, radius),
            this.faceUVToWorldPosition(face, uMax, vMax, radius)
        ];
        
        const center = this.faceUVToWorldPosition(
            face, 
            (uMin + uMax) * 0.5, 
            (vMin + vMax) * 0.5, 
            radius
        );
        
        return { corners, center, uMin, uMax, vMin, vMax };
    }
    
    static getCurvatureOffset(distanceFromCenter, planetRadius) {
        if (distanceFromCenter <= 0) return 0;
        const d2 = distanceFromCenter * distanceFromCenter;
        const r2 = planetRadius * planetRadius;
        if (d2 >= r2) return planetRadius;
        return planetRadius - Math.sqrt(r2 - d2);
    }
    
    static getHorizonDistance(altitude, planetRadius) {
        const r = planetRadius;
        const h = altitude;
        return Math.sqrt(h * (2 * r + h));
    }
}