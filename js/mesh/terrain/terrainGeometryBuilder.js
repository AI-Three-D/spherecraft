// js/mesh/terrain/terrainGeometryBuilder.js
import { Geometry } from '../../renderer/resources/geometry.js';

export class TerrainGeometryBuilder {
    
    static DEFAULT_SUBDIVISIONS = {
        0: 128,  // 16,641 vertices (was 64 = 4,225)
        1: 64,   // 4,225 vertices
        2: 32,   // 1,089 vertices
        3: 16,   // 289 vertices
        4: 8,    // 81 vertices
        5: 4,    // 25 vertices (WAS QUAD = 4 VERTICES!)
        6: 4,    // 25 vertices minimum
    };

    static buildSegmentArray(baseSegments, maxLOD = 6, minSegments = 4) {
        const segments = [];
        let current = Math.max(minSegments, Math.floor(baseSegments));
        for (let lod = 0; lod <= maxLOD; lod++) {
            segments.push(Math.max(minSegments, current));
            current = Math.max(minSegments, Math.floor(current / 2));
        }
        return segments;
    }

    static buildSubdivisionMap(baseSegments, maxLOD = 6, minSegments = 4) {
        const segments = this.buildSegmentArray(baseSegments, maxLOD, minSegments);
        const map = {};
        for (let lod = 0; lod < segments.length; lod++) {
            map[lod] = segments[lod];
        }
        return map;
    }
    
    static build(chunkData, offsetX, offsetZ, lodLevel = 0, useHeightTexture = false, options = {}) {
        const subdivisionMap = options.subdivisions || this.DEFAULT_SUBDIVISIONS;
        const clampedLOD = Math.min(Math.max(lodLevel, 0), 6);
        const segments = subdivisionMap[clampedLOD] || 4;

        if (useHeightTexture) {
            return this.buildFlatGrid(chunkData, segments, lodLevel);
        }
        return this.buildFromHeightmap(chunkData, segments, lodLevel);
    }

    /**
     * Simple heightmap builder: displaces Y using chunkData.heights if present,
     * otherwise falls back to flat grid.
     */
    static buildFromHeightmap(chunkData, segments, lodLevel) {
        if (!chunkData?.heights) {
            return this.buildFlatGrid(chunkData, segments, lodLevel);
        }

        const geometry = new Geometry();
        const size = chunkData.size;
        const vertCount = (segments + 1) * (segments + 1);
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);

        let i = 0;
        const stride = this._safeStride(chunkData);
        for (let y = 0; y <= segments; y++) {
            for (let x = 0; x <= segments; x++) {
                const u = x / segments;
                const v = y / segments;
                const hx = Math.floor(u * (stride - 1));
                const hz = Math.floor(v * (stride - 1));
                const h = chunkData.heights[hz * stride + hx] || 0;

                positions[i * 3] = u * size;
                positions[i * 3 + 1] = h;
                positions[i * 3 + 2] = v * size;
                normals[i * 3] = 0;
                normals[i * 3 + 1] = 1;
                normals[i * 3 + 2] = 0;
                uvs[i * 2] = u;
                uvs[i * 2 + 1] = v;
                i++;
            }
        }

        geometry.setAttribute('position', positions, 3);
        geometry.setAttribute('normal', normals, 3);
        geometry.setAttribute('uv', uvs, 2);
        const indices = this._buildGridIndices(segments);

        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        geometry.userData = { lodLevel, segments, vertexCount: geometry.attributes.get('position').count };
        return geometry;
    }

    static _safeStride(chunkData) {
        const stride = Math.sqrt(chunkData.heights.length);
        return Number.isFinite(stride) && stride > 0 ? Math.floor(stride) : chunkData.size + 1;
    }
    
    static buildFlatGrid(chunkData, segments, lodLevel) {
        const geometry = new Geometry();
        const chunkSize = chunkData.size;
        const vertCount = (segments + 1) * (segments + 1);
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        
        let i = 0;
        for (let y = 0; y <= segments; y++) {
            for (let x = 0; x <= segments; x++) {
                const u = x / segments;
                const v = y / segments;
                positions[i * 3] = u * chunkSize;
                positions[i * 3 + 1] = 0;
                positions[i * 3 + 2] = v * chunkSize;
                normals[i * 3] = 0;
                normals[i * 3 + 1] = 1;
                normals[i * 3 + 2] = 0;
                uvs[i * 2] = u;
                uvs[i * 2 + 1] = v;
                i++;
            }
        }
        
        geometry.setAttribute('position', positions, 3);
        geometry.setAttribute('normal', normals, 3);
        geometry.setAttribute('uv', uvs, 2);
        const indices = this._buildGridIndices(segments);

        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        geometry.userData = { lodLevel, segments, vertexCount: geometry.attributes.get('position').count };
        return geometry;
    }
    
    static _buildGridIndices(segments) {
        const indices = new Uint32Array(segments * segments * 6);
        let idx = 0;
        for (let y = 0; y < segments; y++) {
            for (let x = 0; x < segments; x++) {
                const v00 = y * (segments + 1) + x;
                indices[idx++] = v00;
                indices[idx++] = v00 + segments + 1;
                indices[idx++] = v00 + 1;
                indices[idx++] = v00 + 1;
                indices[idx++] = v00 + segments + 1;
                indices[idx++] = v00 + segments + 2;
            }
        }
        return indices;
    }
}
