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
        const transitionBaseSegments = this._resolveTransitionBaseSegments(subdivisionMap);
        const useTransitionTopology = options.useTransitionTopology !== false && transitionBaseSegments > 0;
        const buildSegments = useTransitionTopology ? transitionBaseSegments : segments;

        if (useHeightTexture) {
            return this.buildFlatGrid(chunkData, buildSegments, lodLevel, { useTransitionTopology });
        }
        return this.buildFromHeightmap(chunkData, buildSegments, lodLevel, { useTransitionTopology });
    }

    /**
     * Simple heightmap builder: displaces Y using chunkData.heights if present,
     * otherwise falls back to flat grid.
     */
    static buildFromHeightmap(chunkData, segments, lodLevel, options = {}) {
        if (!chunkData?.heights) {
            return this.buildFlatGrid(chunkData, segments, lodLevel, options);
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
        const indices = options.useTransitionTopology
            ? this._buildTransitionIndices(segments, lodLevel)
            : this._buildGridIndices(segments);

        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        geometry.userData = {
            lodLevel,
            segments,
            topology: options.useTransitionTopology ? 'transition' : 'grid',
            vertexCount: geometry.attributes.get('position').count
        };
        return geometry;
    }

    static _safeStride(chunkData) {
        const stride = Math.sqrt(chunkData.heights.length);
        return Number.isFinite(stride) && stride > 0 ? Math.floor(stride) : chunkData.size + 1;
    }
    
    static buildFlatGrid(chunkData, segments, lodLevel, options = {}) {
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
        const indices = options.useTransitionTopology
            ? this._buildTransitionIndices(segments, lodLevel)
            : this._buildGridIndices(segments);

        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        geometry.userData = {
            lodLevel,
            segments,
            topology: options.useTransitionTopology ? 'transition' : 'grid',
            vertexCount: geometry.attributes.get('position').count
        };
        return geometry;
    }

    static _resolveTransitionBaseSegments(subdivisionMap) {
        const values = Object.values(subdivisionMap || {})
            .map((value) => Math.max(0, Math.floor(Number(value) || 0)))
            .filter((value) => value > 0);
        return values.length > 0 ? Math.max(...values) : 0;
    }

    static _buildTransitionIndices(segments, lodLevel) {
        const size = Math.max(2, Math.floor(segments));
        const intLod = Math.max(0, Math.floor(lodLevel));
        if ((size & (size - 1)) !== 0) {
            return this._buildGridIndices(size);
        }
        if (intLod <= 0) {
            return this._buildGridIndices(size);
        }
        const maxStep = Math.min(1 << intLod, size);
        if (maxStep <= 1 || (maxStep & (maxStep - 1)) !== 0 || (size % maxStep) !== 0) {
            return this._buildGridIndices(size);
        }
        return new Uint32Array(this._buildAdaptiveTransitionIndices(size, maxStep));
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

    static _buildAdaptiveTransitionIndices(size, maxStep) {
        const cells = this._buildAdaptiveCells(size, maxStep);
        const occupancy = this._buildCellOccupancy(size, cells);
        return this._triangulateAdaptiveCells(size, cells, occupancy);
    }

    static _buildAdaptiveCells(size, maxStep) {
        const cells = [];

        const visit = (x, z, cellSize) => {
            const inset = Math.min(x, z, size - (x + cellSize), size - (z + cellSize));
            if (cellSize <= 1 || (cellSize <= maxStep && inset >= cellSize)) {
                cells.push({ x, z, size: cellSize });
                return;
            }
            const half = cellSize >> 1;
            if (half < 1) {
                cells.push({ x, z, size: cellSize });
                return;
            }
            visit(x, z, half);
            visit(x + half, z, half);
            visit(x, z + half, half);
            visit(x + half, z + half, half);
        };

        visit(0, 0, size);
        return cells;
    }

    static _buildCellOccupancy(size, cells) {
        const occupancy = new Int32Array(size * size);
        occupancy.fill(-1);
        for (let index = 0; index < cells.length; index++) {
            const cell = cells[index];
            for (let z = cell.z; z < cell.z + cell.size; z++) {
                const rowOffset = z * size;
                for (let x = cell.x; x < cell.x + cell.size; x++) {
                    occupancy[rowOffset + x] = index;
                }
            }
        }
        return occupancy;
    }

    static _triangulateAdaptiveCells(size, cells, occupancy) {
        const indices = [];
        const verts = size + 1;
        const vertexId = (x, z) => z * verts + x;

        for (const cell of cells) {
            const x0 = cell.x;
            const z0 = cell.z;
            const step = cell.size;
            const x1 = x0 + step;
            const z1 = z0 + step;

            if (step <= 1) {
                const v00 = vertexId(x0, z0);
                const v01 = vertexId(x0, z1);
                const v10 = vertexId(x1, z0);
                const v11 = vertexId(x1, z1);
                indices.push(v00, v01, v10);
                indices.push(v10, v01, v11);
                continue;
            }

            const topOffsets = this._getAdaptiveEdgeOffsets(size, occupancy, cell, 'top');
            const rightOffsets = this._getAdaptiveEdgeOffsets(size, occupancy, cell, 'right');
            const bottomOffsets = this._getAdaptiveEdgeOffsets(size, occupancy, cell, 'bottom');
            const leftOffsets = this._getAdaptiveEdgeOffsets(size, occupancy, cell, 'left');
            const half = step >> 1;
            const center = vertexId(x0 + half, z0 + half);

            const boundary = [vertexId(x0, z0)];
            for (const offset of topOffsets) boundary.push(vertexId(x0 + offset, z0));
            boundary.push(vertexId(x1, z0));
            for (const offset of rightOffsets) boundary.push(vertexId(x1, z0 + offset));
            boundary.push(vertexId(x1, z1));
            for (let i = bottomOffsets.length - 1; i >= 0; i--) {
                boundary.push(vertexId(x0 + bottomOffsets[i], z1));
            }
            boundary.push(vertexId(x0, z1));
            for (let i = leftOffsets.length - 1; i >= 0; i--) {
                boundary.push(vertexId(x0, z0 + leftOffsets[i]));
            }

            for (let i = 0; i < boundary.length; i++) {
                const current = boundary[i];
                const next = boundary[(i + 1) % boundary.length];
                indices.push(center, next, current);
            }
        }

        return indices;
    }

    static _getAdaptiveEdgeOffsets(size, occupancy, cell, direction) {
        let sampleX = cell.x;
        let sampleZ = cell.z;
        let count = cell.size;
        let strideX = 1;
        let strideZ = 0;

        if (direction === 'top') {
            if (cell.z === 0) return [];
            sampleZ = cell.z - 1;
        } else if (direction === 'bottom') {
            if (cell.z + cell.size >= size) return [];
            sampleZ = cell.z + cell.size;
        } else if (direction === 'left') {
            if (cell.x === 0) return [];
            sampleX = cell.x - 1;
            strideX = 0;
            strideZ = 1;
        } else if (direction === 'right') {
            if (cell.x + cell.size >= size) return [];
            sampleX = cell.x + cell.size;
            strideX = 0;
            strideZ = 1;
        }

        const offsets = [];
        let previous = occupancy[sampleZ * size + sampleX];
        for (let i = 1; i < count; i++) {
            const x = sampleX + i * strideX;
            const z = sampleZ + i * strideZ;
            const current = occupancy[z * size + x];
            if (current !== previous) {
                offsets.push(i);
                previous = current;
            }
        }
        return offsets;
    }
}
