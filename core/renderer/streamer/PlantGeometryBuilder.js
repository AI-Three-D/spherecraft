// js/renderer/streamer/PlantGeometryBuilder.js
//
// Builds geometry for non-tree vegetation: bushes, shrubs, cacti, grass.

/**
 * @typedef {import('./GeometryAtlas.js').GeometryData} GeometryData
 */

export class PlantGeometryBuilder {

    // ═══════════════════════════════════════════════════════════════════════
    // CACTUS - Columnar saguaro-style
    // ═══════════════════════════════════════════════════════════════════════

    static buildCactusLODs() {
        return [
            this._buildCactusLOD0(),
            this._buildCactusLOD1(),
            this._buildCactusLOD2()
        ];
    }

    static _buildCactusLOD0() {
        // Main column with ribs
        const main = this._buildRibbedColumn(8, 8, 0.08, 0.06, 0.7, 0);
        
        // Arms
        const arms = this._buildCactusArms(2, 0.3, 0.5, 0.04, 0.15, 6);
        
        return this._mergeGeometries([main, arms]);
    }

    static _buildCactusLOD1() {
        const main = this._buildRibbedColumn(6, 4, 0.08, 0.06, 0.7, 0);
        const arms = this._buildCactusArms(2, 0.3, 0.5, 0.04, 0.12, 4);
        return this._mergeGeometries([main, arms]);
    }

    static _buildCactusLOD2() {
        // Simple cylinder, no arms
        return this._buildSimpleCylinder(4, 2, 0.08, 0.7, 0);
    }

    static _buildRibbedColumn(radialSegments, heightSegments, radius, topRadius, height, baseY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const ribDepth = 0.015;
        
        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const posY = baseY + v * height;
            const r = radius + (topRadius - radius) * v;
            
            for (let i = 0; i <= radialSegments; i++) {
                const u = i / radialSegments;
                const angle = u * Math.PI * 2;
                
                // Add ribs
                const ribOffset = Math.cos(angle * radialSegments) * ribDepth;
                const actualR = r + ribOffset;
                
                positions.push(
                    Math.cos(angle) * actualR,
                    posY,
                    Math.sin(angle) * actualR
                );
                
                // Normal with rib detail
                const nx = Math.cos(angle);
                const nz = Math.sin(angle);
                normals.push(nx, 0, nz);
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSegments; y++) {
            for (let i = 0; i < radialSegments; i++) {
                const a = y * (radialSegments + 1) + i;
                const b = a + 1;
                const c = a + radialSegments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        // Top cap
        const topCenter = positions.length / 3;
        positions.push(0, baseY + height, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 1);
        
        const topRing = heightSegments * (radialSegments + 1);
        for (let i = 0; i < radialSegments; i++) {
            indices.push(topCenter, topRing + i, topRing + i + 1);
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildCactusArms(count, minHeight, maxHeight, radius, length, segments) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;
        
        for (let i = 0; i < count; i++) {
            const height = minHeight + (maxHeight - minHeight) * (i / (count - 1 || 1));
            const angle = (i / count) * Math.PI * 2 + Math.PI * 0.25;
            
            // Arm: horizontal then up
            const arm = this._buildCactusArm(segments, radius, length, height, angle);
            
            allPositions.push(...arm.positions);
            allNormals.push(...arm.normals);
            allUVs.push(...arm.uvs);
            
            for (const idx of arm.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += arm.positions.length / 3;
        }
        
        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    static _buildCactusArm(segments, radius, length, startHeight, angle) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        
        // Horizontal segment
        const horzLen = length * 0.6;
        // Vertical segment
        const vertLen = length * 0.5;
        
        // Build as two connected cylinders
        // First: horizontal outward
        for (let l = 0; l <= 2; l++) {
            const t = l / 2;
            const x = cosA * (0.1 + horzLen * t);
            const y = startHeight;
            const z = sinA * (0.1 + horzLen * t);
            
            for (let i = 0; i <= segments; i++) {
                const u = i / segments;
                const theta = u * Math.PI * 2;
                
                const nx = Math.cos(theta) * sinA + Math.sin(theta) * 0;
                const ny = Math.sin(theta);
                const nz = -Math.cos(theta) * cosA;
                
                positions.push(
                    x + Math.cos(theta) * radius * sinA,
                    y + Math.sin(theta) * radius,
                    z - Math.cos(theta) * radius * cosA
                );
                normals.push(nx, ny, nz);
                uvs.push(u, t * 0.5);
            }
        }
        
        // Second: vertical segment at end
        const armEndX = cosA * (0.1 + horzLen);
        const armEndZ = sinA * (0.1 + horzLen);
        
        for (let l = 0; l <= 2; l++) {
            const t = l / 2;
            const y = startHeight + vertLen * t;
            
            for (let i = 0; i <= segments; i++) {
                const u = i / segments;
                const theta = u * Math.PI * 2;
                
                positions.push(
                    armEndX + Math.cos(theta) * radius,
                    y,
                    armEndZ + Math.sin(theta) * radius
                );
                normals.push(Math.cos(theta), 0, Math.sin(theta));
                uvs.push(u, 0.5 + t * 0.5);
            }
        }
        
        // Indices for horizontal part
        for (let l = 0; l < 2; l++) {
            for (let i = 0; i < segments; i++) {
                const a = l * (segments + 1) + i;
                const b = a + 1;
                const c = a + segments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        // Indices for vertical part
        const vOffset = 3 * (segments + 1);
        for (let l = 0; l < 2; l++) {
            for (let i = 0; i < segments; i++) {
                const a = vOffset + l * (segments + 1) + i;
                const b = a + 1;
                const c = a + segments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BUSH - Dome-shaped shrub
    // ═══════════════════════════════════════════════════════════════════════

    static buildBushLODs() {
        return [
            this._buildBushLOD0(),
            this._buildBushLOD1(),
            this._buildBushLOD2()
        ];
    }

    static _buildBushLOD0() {
        // Irregular dome shape
        return this._buildIrregularDome(10, 6, 0.5, 0.4);
    }

    static _buildBushLOD1() {
        return this._buildIrregularDome(6, 4, 0.5, 0.4);
    }

    static _buildBushLOD2() {
        // Simple hemisphere
        return this._buildHemisphere(4, 3, 0.45, 0.35);
    }

    static _buildIrregularDome(widthSegments, heightSegments, radius, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const noise = (x, y) => {
            const n = Math.sin(x * 17.31 + y * 43.17) * 21.19;
            return (n - Math.floor(n)) * 0.25 + 0.875;
        };
        
        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI * 0.5;  // Only upper hemisphere
            
            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;
                
                const r = radius * noise(x, y);
                const h = height * (1 + (noise(x + 5, y + 3) - 0.9) * 0.3);
                
                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);
                
                positions.push(
                    nx * r,
                    ny * h,
                    nz * r
                );
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + 1;
                const c = a + widthSegments + 1;
                const d = c + 1;
                
                indices.push(a, c, b, b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildHemisphere(widthSegments, heightSegments, radius, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const phi = v * Math.PI * 0.5;
            
            for (let x = 0; x <= widthSegments; x++) {
                const u = x / widthSegments;
                const theta = u * Math.PI * 2;
                
                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);
                
                positions.push(nx * radius, ny * height, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSegments; y++) {
            for (let x = 0; x < widthSegments; x++) {
                const a = y * (widthSegments + 1) + x;
                const b = a + 1;
                const c = a + widthSegments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHRUB LOW - Low spreading ground cover
    // ═══════════════════════════════════════════════════════════════════════

    static buildShrubLowLODs() {
        return [
            this._buildShrubLowLOD0(),
            this._buildShrubLowLOD1(),
            this._buildShrubLowLOD2()
        ];
    }

    static _buildShrubLowLOD0() {
        // Multiple small mounds
        const mounds = [];
        const positions = [
            [0, 0, 0],
            [0.15, 0, 0.1],
            [-0.12, 0, 0.08],
            [0.05, 0, -0.12]
        ];
        
        for (const pos of positions) {
            const scale = 0.7 + Math.random() * 0.3;
            const mound = this._buildSmallMound(6, 4, 0.12 * scale, 0.08 * scale, pos);
            mounds.push(mound);
        }
        
        return this._mergeGeometries(mounds);
    }

    static _buildShrubLowLOD1() {
        const mounds = [];
        const positions = [[0, 0, 0], [0.1, 0, 0.08]];
        
        for (const pos of positions) {
            mounds.push(this._buildSmallMound(4, 3, 0.15, 0.1, pos));
        }
        
        return this._mergeGeometries(mounds);
    }

    static _buildShrubLowLOD2() {
        return this._buildSmallMound(4, 2, 0.2, 0.12, [0, 0, 0]);
    }

    static _buildSmallMound(widthSeg, heightSeg, radius, height, offset) {
        const geo = this._buildHemisphere(widthSeg, heightSeg, radius, height);
        
        // Offset positions
        const positions = new Float32Array(geo.positions.length);
        for (let i = 0; i < geo.positions.length; i += 3) {
            positions[i] = geo.positions[i] + offset[0];
            positions[i + 1] = geo.positions[i + 1] + offset[1];
            positions[i + 2] = geo.positions[i + 2] + offset[2];
        }
        
        return {
            positions,
            normals: geo.normals,
            uvs: geo.uvs,
            indices: geo.indices
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHRUB SPARSE - Desert scrub
    // ═══════════════════════════════════════════════════════════════════════

    static buildShrubSparseLODs() {
        return [
            this._buildShrubSparseLOD0(),
            this._buildShrubSparseLOD1(),
            this._buildShrubSparseLOD2()
        ];
    }

    static _buildShrubSparseLOD0() {
        // Sparse twigs
        const twigs = [];
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.3;
            const length = 0.15 + Math.random() * 0.1;
            const twig = this._buildTwig(4, 0.008, length, angle, 0.3 + Math.random() * 0.4);
            twigs.push(twig);
        }
        return this._mergeGeometries(twigs);
    }

    static _buildShrubSparseLOD1() {
        const twigs = [];
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2;
            const twig = this._buildTwig(3, 0.01, 0.18, angle, 0.4);
            twigs.push(twig);
        }
        return this._mergeGeometries(twigs);
    }

    static _buildShrubSparseLOD2() {
        // Single blob
        return this._buildHemisphere(4, 2, 0.1, 0.15);
    }

    static _buildTwig(segments, radius, length, angle, elevation) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const cosE = Math.cos(elevation);
        const sinE = Math.sin(elevation);
        
        for (let l = 0; l <= 2; l++) {
            const t = l / 2;
            const x = cosA * cosE * length * t;
            const y = sinE * length * t;
            const z = sinA * cosE * length * t;
            const r = radius * (1 - t * 0.5);
            
            for (let i = 0; i <= segments; i++) {
                const u = i / segments;
                const theta = u * Math.PI * 2;
                
                positions.push(
                    x + Math.cos(theta) * r,
                    y + Math.sin(theta) * r,
                    z
                );
                normals.push(Math.cos(theta), Math.sin(theta), 0);
                uvs.push(u, t);
            }
        }
        
        for (let l = 0; l < 2; l++) {
            for (let i = 0; i < segments; i++) {
                const a = l * (segments + 1) + i;
                const b = a + 1;
                const c = a + segments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GRASS BLADE - For ground cover
    // ═══════════════════════════════════════════════════════════════════════

    static buildGrassBladeLODs() {
        return [
            this._buildGrassBladeLOD0(),
            this._buildGrassBladeLOD1(),
            this._buildGrassBladeLOD2()
        ];
    }

    static _buildGrassBladeLOD0() {
        return this._buildBlade(4, 0.5, 1.0);
    }

    static _buildGrassBladeLOD1() {
        return this._buildBlade(2, 0.5, 1.0);
    }

    static _buildGrassBladeLOD2() {
        // Single quad billboard
        return this._buildSingleBillboard(0.5, 1.0);
    }

    static _buildBlade(segments, width, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const w = width * (1 - t * t * t) * 0.5;
            const y = t * height;
            
            positions.push(-w, y, 0);
            positions.push(w, y, 0);
            
            normals.push(0, 0, 1);
            normals.push(0, 0, 1);
            
            uvs.push(0, t);
            uvs.push(1, t);
        }
        
        for (let i = 0; i < segments; i++) {
            const bl = i * 2;
            const br = bl + 1;
            const tl = bl + 2;
            const tr = bl + 3;
            indices.push(bl, br, tl, tl, br, tr);
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildSingleBillboard(width, height) {
        const hw = width * 0.5;
        return {
            positions: new Float32Array([
                -hw, 0, 0,
                hw, 0, 0,
                hw, height, 0,
                -hw, height, 0
            ]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: new Uint16Array([0, 1, 2, 0, 2, 3])
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MOSS - Flat ground cover
    // ═══════════════════════════════════════════════════════════════════════

    static buildMossLODs() {
        return [
            this._buildMossLOD0(),
            this._buildMossLOD1(),
            this._buildMossLOD2()
        ];
    }

    static _buildMossLOD0() {
        return this._buildFlatPatch(6, 0.15, 0.03);
    }

    static _buildMossLOD1() {
        return this._buildFlatPatch(4, 0.15, 0.025);
    }

    static _buildMossLOD2() {
        return this._buildFlatPatch(3, 0.12, 0.02);
    }

    static _buildFlatPatch(segments, radius, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        // Center vertex
        positions.push(0, height, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 0.5);
        
        // Edge vertices with slight height variation
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const r = radius * (0.9 + Math.sin(angle * 3) * 0.1);
            const h = height * (0.7 + Math.cos(angle * 2) * 0.3);
            
            positions.push(Math.cos(angle) * r, h, Math.sin(angle) * r);
            normals.push(0, 1, 0);
            uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5);
        }
        
        // Fan triangles
        for (let i = 0; i < segments; i++) {
            indices.push(0, i + 1, i + 2);
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STONE - Rocks and pebbles
    // ═══════════════════════════════════════════════════════════════════════

    static buildStoneLODs() {
        return [
            this._buildStoneLOD0(),
            this._buildStoneLOD1(),
            this._buildStoneLOD2()
        ];
    }

    static _buildStoneLOD0() {
        return this._buildIrregularStone(8, 6, 0.5, 0.35);
    }

    static _buildStoneLOD1() {
        return this._buildIrregularStone(5, 4, 0.5, 0.35);
    }

    static _buildStoneLOD2() {
        // Simple diamond
        return this._buildDiamond(0.5, 0.35);
    }

    static _buildIrregularStone(widthSeg, heightSeg, radius, height) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        const noise = (x, y) => {
            const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
            return (n - Math.floor(n)) * 0.3 + 0.85;
        };
        
        for (let y = 0; y <= heightSeg; y++) {
            const v = y / heightSeg;
            const phi = v * Math.PI;
            
            for (let x = 0; x <= widthSeg; x++) {
                const u = x / widthSeg;
                const theta = u * Math.PI * 2;
                
                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);
                
                const r = radius * noise(x, y);
                const h = height * noise(x + 10, y + 10);
                
                positions.push(nx * r, ny * h + height * 0.5, nz * r);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSeg; y++) {
            for (let x = 0; x < widthSeg; x++) {
                const a = y * (widthSeg + 1) + x;
                const b = a + 1;
                const c = a + widthSeg + 1;
                const d = c + 1;
                
                if (y !== 0) indices.push(a, c, b);
                if (y !== heightSeg - 1) indices.push(b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _buildDiamond(radius, height) {
        const positions = new Float32Array([
            0, height, 0,           // top
            0, 0, 0,                // bottom
            radius, height * 0.5, 0,
            0, height * 0.5, radius,
            -radius, height * 0.5, 0,
            0, height * 0.5, -radius
        ]);
        
        const normals = new Float32Array([
            0, 1, 0,
            0, -1, 0,
            1, 0, 0,
            0, 0, 1,
            -1, 0, 0,
            0, 0, -1
        ]);
        
        const uvs = new Float32Array([
            0.5, 1, 0.5, 0, 1, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5
        ]);
        
        const indices = new Uint16Array([
            0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2,  // top
            1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5   // bottom
        ]);
        
        return { positions, normals, uvs, indices };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════════

    static _buildSimpleCylinder(segments, heightSegments, radius, height, baseY) {
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        
        for (let y = 0; y <= heightSegments; y++) {
            const v = y / heightSegments;
            const posY = baseY + v * height;
            
            for (let i = 0; i <= segments; i++) {
                const u = i / segments;
                const angle = u * Math.PI * 2;
                
                positions.push(Math.cos(angle) * radius, posY, Math.sin(angle) * radius);
                normals.push(Math.cos(angle), 0, Math.sin(angle));
                uvs.push(u, v);
            }
        }
        
        for (let y = 0; y < heightSegments; y++) {
            for (let i = 0; i < segments; i++) {
                const a = y * (segments + 1) + i;
                const b = a + 1;
                const c = a + segments + 1;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        
        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint16Array(indices)
        };
    }

    static _mergeGeometries(geometries) {
        const allPositions = [];
        const allNormals = [];
        const allUVs = [];
        const allIndices = [];
        let vertexOffset = 0;
        
        for (const geo of geometries) {
            allPositions.push(...geo.positions);
            allNormals.push(...geo.normals);
            allUVs.push(...geo.uvs);
            
            for (const idx of geo.indices) {
                allIndices.push(idx + vertexOffset);
            }
            vertexOffset += geo.positions.length / 3;
        }
        
        return {
            positions: new Float32Array(allPositions),
            normals: new Float32Array(allNormals),
            uvs: new Float32Array(allUVs),
            indices: new Uint16Array(allIndices)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FACTORY METHOD
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build all LODs for a plant geometry type.
     * 
     * @param {string} geometryType
     * @returns {GeometryData[]}
     */
    static buildForType(geometryType) {
        switch (geometryType) {
            case 'cactus':
                return this.buildCactusLODs();
            case 'bush':
                return this.buildBushLODs();
            case 'shrub_low':
                return this.buildShrubLowLODs();
            case 'shrub_sparse':
                return this.buildShrubSparseLODs();
            case 'grass_blade':
                return this.buildGrassBladeLODs();
            case 'moss':
                return this.buildMossLODs();
            case 'stone':
                return this.buildStoneLODs();
            default:
                // Fallback to bush
                return this.buildBushLODs();
        }
    }
}