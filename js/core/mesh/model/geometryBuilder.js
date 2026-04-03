import { Geometry } from '../../renderer/resources/geometry.js';

/**
 * Utility class for building primitive geometries
 * All geometries are created in local space with Y-up orientation
 */
export class GeometryBuilder {
    
    /**
     * Create a cone geometry
     */
    static createCone(radius, height, segments = 8, openEnded = false) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const halfHeight = height / 2;
        
        // Tip vertex
        positions.push(0, halfHeight, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 0);
        
        // Base vertices
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = Math.cos(theta) * radius;
            const z = Math.sin(theta) * radius;
            
            positions.push(x, -halfHeight, z);
            
            // Normal pointing outward and up
            const nx = Math.cos(theta);
            const ny = radius / height;
            const nz = Math.sin(theta);
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            normals.push(nx / len, ny / len, nz / len);
            
            uvs.push(i / segments, 1);
        }
        
        // Side faces
        for (let i = 0; i < segments; i++) {
            indices.push(0, i + 1, i + 2);
        }
        
        // Base cap
        if (!openEnded) {
            const centerIndex = positions.length / 3;
            positions.push(0, -halfHeight, 0);
            normals.push(0, -1, 0);
            uvs.push(0.5, 0.5);
            
            for (let i = 0; i < segments; i++) {
                indices.push(centerIndex, i + 2, i + 1);
            }
        }
        
        return GeometryBuilder._createGeometry(positions, normals, uvs, indices);
    }
    
    /**
     * Create a box geometry
     */
    static createBox(width, height, depth) {
        const hw = width / 2;
        const hh = height / 2;
        const hd = depth / 2;
        
        const positions = [
            // Front
            -hw, -hh,  hd,   hw, -hh,  hd,   hw,  hh,  hd,  -hw,  hh,  hd,
            // Back
             hw, -hh, -hd,  -hw, -hh, -hd,  -hw,  hh, -hd,   hw,  hh, -hd,
            // Top
            -hw,  hh,  hd,   hw,  hh,  hd,   hw,  hh, -hd,  -hw,  hh, -hd,
            // Bottom
            -hw, -hh, -hd,   hw, -hh, -hd,   hw, -hh,  hd,  -hw, -hh,  hd,
            // Right
             hw, -hh,  hd,   hw, -hh, -hd,   hw,  hh, -hd,   hw,  hh,  hd,
            // Left
            -hw, -hh, -hd,  -hw, -hh,  hd,  -hw,  hh,  hd,  -hw,  hh, -hd
        ];
        
        const normals = [
            // Front
            0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
            // Back
            0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
            // Top
            0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
            // Bottom
            0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
            // Right
            1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
            // Left
            -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0
        ];
        
        const uvs = [];
        for (let i = 0; i < 6; i++) {
            uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        }
        
        const indices = [];
        for (let i = 0; i < 6; i++) {
            const base = i * 4;
            indices.push(
                base, base + 1, base + 2,
                base, base + 2, base + 3
            );
        }
        
        return GeometryBuilder._createGeometry(positions, normals, uvs, indices);
    }
    
    /**
     * Create a sphere geometry
     */
    static createSphere(radius, widthSegments = 16, heightSegments = 12) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI;
            
            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;
                
                const nx = Math.cos(theta) * Math.sin(phi);
                const ny = Math.cos(phi);
                const nz = Math.sin(theta) * Math.sin(phi);
                
                positions.push(nx * radius, ny * radius, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + widthSegments + 1;
                
                indices.push(a, b, a + 1);
                indices.push(b, b + 1, a + 1);
            }
        }
        
        return GeometryBuilder._createGeometry(positions, normals, uvs, indices);
    }
    
    /**
     * Create a cylinder geometry
     */
    static createCylinder(radiusTop, radiusBottom, height, segments = 8, openEnded = false) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const halfHeight = height / 2;
        
        // Side vertices
        for (let y = 0; y <= 1; y++) {
            const yPos = y === 0 ? -halfHeight : halfHeight;
            const radius = y === 0 ? radiusBottom : radiusTop;
            
            for (let i = 0; i <= segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                const x = Math.cos(theta) * radius;
                const z = Math.sin(theta) * radius;
                
                positions.push(x, yPos, z);
                
                const nx = Math.cos(theta);
                const nz = Math.sin(theta);
                normals.push(nx, 0, nz);
                
                uvs.push(i / segments, y);
            }
        }
        
        // Side faces
        for (let i = 0; i < segments; i++) {
            const a = i;
            const b = i + segments + 1;
            const c = i + 1;
            const d = i + segments + 2;
            
            indices.push(a, b, c);
            indices.push(b, d, c);
        }
        
        // Caps
        if (!openEnded) {
            // Top cap
            const topCenter = positions.length / 3;
            positions.push(0, halfHeight, 0);
            normals.push(0, 1, 0);
            uvs.push(0.5, 0.5);
            
            for (let i = 0; i <= segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                positions.push(Math.cos(theta) * radiusTop, halfHeight, Math.sin(theta) * radiusTop);
                normals.push(0, 1, 0);
                uvs.push(Math.cos(theta) * 0.5 + 0.5, Math.sin(theta) * 0.5 + 0.5);
            }
            
            for (let i = 0; i < segments; i++) {
                indices.push(topCenter, topCenter + i + 1, topCenter + i + 2);
            }
            
            // Bottom cap
            const bottomCenter = positions.length / 3;
            positions.push(0, -halfHeight, 0);
            normals.push(0, -1, 0);
            uvs.push(0.5, 0.5);
            
            for (let i = 0; i <= segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                positions.push(Math.cos(theta) * radiusBottom, -halfHeight, Math.sin(theta) * radiusBottom);
                normals.push(0, -1, 0);
                uvs.push(Math.cos(theta) * 0.5 + 0.5, Math.sin(theta) * 0.5 + 0.5);
            }
            
            for (let i = 0; i < segments; i++) {
                indices.push(bottomCenter, bottomCenter + i + 2, bottomCenter + i + 1);
            }
        }
        
        return GeometryBuilder._createGeometry(positions, normals, uvs, indices);
    }
    
    /**
     * Merge multiple geometries into one
     */
    static mergeGeometries(geometries, transforms = []) {
        const allPositions = [];
        const allNormals = [];
        const allUvs = [];
        const allColors = [];
        const allIndices = [];
        
        let indexOffset = 0;
        
        for (let i = 0; i < geometries.length; i++) {
            const geo = geometries[i];
            const transform = transforms[i] || { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
            
            const posAttr = geo.getAttribute('position');
            const normAttr = geo.getAttribute('normal');
            const uvAttr = geo.getAttribute('uv');
            const colorAttr = geo.getAttribute('color');
            
            if (!posAttr) continue;
            
            // Apply transform to positions and normals
            const transformMatrix = GeometryBuilder._buildTransformMatrix(transform);
            const normalMatrix = GeometryBuilder._buildNormalMatrix(transformMatrix);
            
            for (let j = 0; j < posAttr.count; j++) {
                const px = posAttr.data[j * 3];
                const py = posAttr.data[j * 3 + 1];
                const pz = posAttr.data[j * 3 + 2];
                
                const transformed = GeometryBuilder._transformPoint(px, py, pz, transformMatrix);
                allPositions.push(transformed.x, transformed.y, transformed.z);
                
                if (normAttr) {
                    const nx = normAttr.data[j * 3];
                    const ny = normAttr.data[j * 3 + 1];
                    const nz = normAttr.data[j * 3 + 2];
                    
                    const transformedNormal = GeometryBuilder._transformNormal(nx, ny, nz, normalMatrix);
                    allNormals.push(transformedNormal.x, transformedNormal.y, transformedNormal.z);
                }
                
                if (uvAttr) {
                    allUvs.push(uvAttr.data[j * 2], uvAttr.data[j * 2 + 1]);
                }
                
                if (colorAttr) {
                    allColors.push(
                        colorAttr.data[j * 4],
                        colorAttr.data[j * 4 + 1],
                        colorAttr.data[j * 4 + 2],
                        colorAttr.data[j * 4 + 3]
                    );
                }
            }
            
            // Copy indices with offset
            if (geo.index) {
                for (let j = 0; j < geo.index.count; j++) {
                    allIndices.push(geo.index.data[j] + indexOffset);
                }
            }
            
            indexOffset += posAttr.count;
        }
        
        const merged = new Geometry();
        merged.setAttribute('position', new Float32Array(allPositions), 3);
        
        if (allNormals.length > 0) {
            merged.setAttribute('normal', new Float32Array(allNormals), 3);
        }
        if (allUvs.length > 0) {
            merged.setAttribute('uv', new Float32Array(allUvs), 2);
        }
        if (allColors.length > 0) {
            merged.setAttribute('color', new Float32Array(allColors), 4);
        }
        if (allIndices.length > 0) {
            merged.setIndex(new Uint16Array(allIndices));
        }
        
        merged.computeBoundingSphere();
        return merged;
    }
    
    /**
     * Internal: Create geometry from raw arrays
     */
    static _createGeometry(positions, normals, uvs, indices) {
        const geo = new Geometry();
        geo.setAttribute('position', new Float32Array(positions), 3);
        geo.setAttribute('normal', new Float32Array(normals), 3);
        geo.setAttribute('uv', new Float32Array(uvs), 2);
        geo.setIndex(new Uint16Array(indices));
        geo.computeBoundingSphere();
        return geo;
    }
    
    /**
     * Internal: Build 4x4 transform matrix
     */
    static _buildTransformMatrix(transform) {
        const pos = transform.position || [0, 0, 0];
        const rot = transform.rotation || [0, 0, 0];
        const scale = transform.scale || [1, 1, 1];
        
        const cx = Math.cos(rot[0]), sx = Math.sin(rot[0]);
        const cy = Math.cos(rot[1]), sy = Math.sin(rot[1]);
        const cz = Math.cos(rot[2]), sz = Math.sin(rot[2]);
        
        // Rotation matrix (YXZ order)
        return {
            m00: cy * cz + sy * sx * sz,
            m01: -cy * sz + sy * sx * cz,
            m02: sy * cx,
            m03: pos[0],
            m10: cx * sz,
            m11: cx * cz,
            m12: -sx,
            m13: pos[1],
            m20: -sy * cz + cy * sx * sz,
            m21: sy * sz + cy * sx * cz,
            m22: cy * cx,
            m23: pos[2],
            scaleX: scale[0],
            scaleY: scale[1],
            scaleZ: scale[2]
        };
    }
    
    static _buildNormalMatrix(m) {
        // For normals, we use the inverse transpose of the upper-left 3x3
        // For uniform scale, this simplifies to just the rotation part
        return m;
    }
    
    static _transformPoint(x, y, z, m) {
        return {
            x: (m.m00 * x + m.m01 * y + m.m02 * z) * m.scaleX + m.m03,
            y: (m.m10 * x + m.m11 * y + m.m12 * z) * m.scaleY + m.m13,
            z: (m.m20 * x + m.m21 * y + m.m22 * z) * m.scaleZ + m.m23
        };
    }
    
    static _transformNormal(x, y, z, m) {
        const nx = m.m00 * x + m.m01 * y + m.m02 * z;
        const ny = m.m10 * x + m.m11 * y + m.m12 * z;
        const nz = m.m20 * x + m.m21 * y + m.m22 * z;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        return { x: nx / len, y: ny / len, z: nz / len };
    }
}