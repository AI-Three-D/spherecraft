import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { GeometryLodMap } from '../GeometryLodMap.js';


export class WaterGeometryGenerator {
    async buildGeometry(feature) {
        const lodMap = new GeometryLodMap();
        
        // LOD 0: High detail
        const lod0 = this.createChunkWaterPlane(feature, 32); // 32x32 grid
        lodMap.addLod(0, lod0, 'mesh');
        
        // LOD 1: Medium detail
        const lod1 = this.createChunkWaterPlane(feature, 16); // 16x16 grid
        lodMap.addLod(1, lod1, 'mesh');
        
        // LOD 2: Low detail
        const lod2 = this.createChunkWaterPlane(feature, 4); // 8x8 grid
        lodMap.addLod(2, lod2, 'mesh');
        
        return { lodMap };
    }
    
    createChunkWaterPlane(feature, segments) {
        const width = feature.chunkSize;
        const height = feature.chunkSize;
        
        const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(width / 2, 0, height / 2);
        
        // Ensure bounds are computed for each LOD
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        
        return geometry;
    }
}