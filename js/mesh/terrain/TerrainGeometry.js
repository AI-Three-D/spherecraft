import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class TerrainGeometry {
    static build(chunk, offsetX, offsetZ) {
        if (!chunk) {
            
            return null;
        }
        const size = chunk.size;
        const vertices = [];
        const uvs = [];
        
        for (let z = 0; z <= size; z++) {
            for (let x = 0; x <= size; x++) {
                const height = chunk.getHeight ? chunk.getHeight(x, z) : 0;
                vertices.push(offsetX + x, height, offsetZ + z);
                uvs.push(x / size, z / size);
            }
        }
        
        const geometry = new THREE.BufferGeometry();
        
        geometry.userData.lodIndices = [
            TerrainGeometry.buildLodIndices(size, 0),
            TerrainGeometry.buildLodIndices(size, 1),
            TerrainGeometry.buildLodIndices(size, 2),
            TerrainGeometry.buildLodIndices(size, 3),  
        ];
    
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        
     
        const initialLod = chunk.lodLevel !== undefined ? chunk.lodLevel : 0;
        geometry.setIndex(new THREE.BufferAttribute(
            new Uint32Array(geometry.userData.lodIndices[initialLod]), 
            1
        ));
        geometry.userData.currentLodIndex = initialLod; 
        
        geometry.computeBoundingSphere();
        
        if (chunk.normals && chunk.normals.length === vertices.length) {
            geometry.setAttribute('normal', new THREE.Float32BufferAttribute(chunk.normals, 3));
        }
        
        return geometry;
    }


    static buildLodIndices(size, lodLevel) {
        const indices = [];
        const verts = size + 1;

        if (lodLevel === 0) {
            for (let z = 0; z < size; z++) {
                for (let x = 0; x < size; x++) {
                    const v00 = z * verts + x;
                    const v10 = z * verts + (x + 1);
                    const v01 = (z + 1) * verts + x;
                    const v11 = (z + 1) * verts + (x + 1);
                    indices.push(v00, v01, v10, v10, v01, v11);
                }
            }
            return indices;
        }
        if (lodLevel === 1) {
            return TerrainGeometry.buildIndicesLod1(size, verts);
        }
        if (lodLevel === 2) {
            return TerrainGeometry.buildIndicesLod2(size, verts);
        }
        if (lodLevel === 3) {
         
            return TerrainGeometry.buildIndicesLod3(size, verts);
        }
        return [];
    }
    static buildIndicesLod3(size, verts) {
        const indices = [];
        const stepRim = 1;
        const stepOuter = 2;
        const stepInterior = 8;
        
        for (let x = 0; x < size; x++) {
            const v00 = 0 * verts + x;
            const v01 = 1 * verts + x;
            const v10 = 0 * verts + (x + 1);
            const v11 = 1 * verts + (x + 1);
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        
        for (let x = 0; x < size; x++) {
            const v00 = (size - 1) * verts + x;
            const v01 = size * verts + x;
            const v10 = (size - 1) * verts + (x + 1);
            const v11 = size * verts + (x + 1);
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        
        for (let z = 1; z < size - 1; z++) {
            const v00 = z * verts + 0;
            const v01 = (z + 1) * verts + 0;
            const v10 = z * verts + 1;
            const v11 = (z + 1) * verts + 1;
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        
        for (let z = 1; z < size - 1; z++) {
            const v00 = z * verts + (size - 1);
            const v01 = (z + 1) * verts + (size - 1);
            const v10 = z * verts + size;
            const v11 = (z + 1) * verts + size;
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        
        for (let z = stepOuter; z < size - stepOuter + 1; z += stepOuter) {
            for (let x = stepOuter; x < size - stepOuter + 1; x += stepOuter) {
                if (x < stepInterior || x > size - stepInterior ||
                    z < stepInterior || z > size - stepInterior) {
                    const v00 = z * verts + x;
                    const v01 = (z + stepOuter) * verts + x;
                    const v10 = z * verts + (x + stepOuter);
                    const v11 = (z + stepOuter) * verts + (x + stepOuter);
                    indices.push(v00, v01, v10);
                    indices.push(v10, v01, v11);
                }
            }
        }
        
        for (let z = stepInterior; z <= size - stepInterior; z += stepInterior) {
            for (let x = stepInterior; x <= size - stepInterior; x += stepInterior) {
                if (x + stepInterior > size || z + stepInterior > size) continue;
                
                const v00 = z * verts + x;
                const v01 = (z + stepInterior) * verts + x;
                const v10 = z * verts + (x + stepInterior);
                const v11 = (z + stepInterior) * verts + (x + stepInterior);
                
                indices.push(v00, v01, v10);
                indices.push(v10, v01, v11);
            }
        }
        
        for (let x = stepOuter; x <= size - stepOuter; x += stepOuter) {
            const vTrans = stepOuter * verts + x;
            const rim1 = 1 * verts + (x - 1);
            const rim2 = 1 * verts + x;
            const rim3 = 1 * verts + (x + 1);
            indices.push(vTrans, rim1, rim2);
            indices.push(vTrans, rim2, rim3);
            if (x + stepOuter <= size - stepOuter) {
                const vNextTrans = stepOuter * verts + (x + stepOuter);
                indices.push(vTrans, rim3, vNextTrans);
            }
        }
        
        for (let x = stepOuter; x <= size - stepOuter; x += stepOuter) {
            const vTrans = (size - stepOuter) * verts + x;
            const rim1 = (size - 1) * verts + (x - 1);
            const rim2 = (size - 1) * verts + x;
            const rim3 = (size - 1) * verts + (x + 1);
            indices.push(vTrans, rim2, rim1);
            indices.push(vTrans, rim3, rim2);
            if (x + stepOuter <= size - stepOuter) {
                const vNextTrans = (size - stepOuter) * verts + (x + stepOuter);
                indices.push(vTrans, vNextTrans, rim3);
            }
        }
        
        for (let z = stepOuter; z <= size - stepOuter; z += stepOuter) {
            const vTrans = z * verts + stepOuter;
            const rim1 = (z - 1) * verts + 1;
            const rim2 = z * verts + 1;
            const rim3 = (z + 1) * verts + 1;
            indices.push(vTrans, rim2, rim1);
            indices.push(vTrans, rim3, rim2);
            if (z + stepOuter <= size - stepOuter) {
                const vNextTrans = (z + stepOuter) * verts + stepOuter;
                indices.push(vTrans, vNextTrans, rim3);
            }
        }
        
        // Right seam
        for (let z = stepOuter; z <= size - stepOuter; z += stepOuter) {
            const vTrans = z * verts + (size - stepOuter);
            const rim1 = (z - 1) * verts + (size - 1);
            const rim2 = z * verts + (size - 1);
            const rim3 = (z + 1) * verts + (size - 1);
            indices.push(vTrans, rim1, rim2);
            indices.push(vTrans, rim2, rim3);
            if (z + stepOuter <= size - stepOuter) {
                const vNextTrans = (z + stepOuter) * verts + (size - stepOuter);
                indices.push(vTrans, rim3, vNextTrans);
            }
        }
        
        // === 5. STITCHING transition zone (step=2) to interior (step=8) ===
        // Similar to your existing code but adjusted for step=2 -> step=8
        // (reuse the pattern from your LOD2 stitching between step=2 and step=4)
        
        return indices;
    }
    static buildIndicesLod1(size, verts) {
        const indices = [];
        const step = 2;
    
        // 1. Full-res rim (the outer 1-vertex-thick ring)
        // Top edge (z=0, z=1)
        for (let x = 0; x < size; x++) {
            const v00 = 0 * verts + x;
            const v01 = 1 * verts + x;
            const v10 = 0 * verts + (x + 1);
            const v11 = 1 * verts + (x + 1);
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        // Bottom edge (z=size-1, z=size)
        for (let x = 0; x < size; x++) {
            const v00 = (size - 1) * verts + x;
            const v01 = size * verts + x;
            const v10 = (size - 1) * verts + (x + 1);
            const v11 = size * verts + (x + 1);
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        // Left edge (x=0, x=1, excluding corners)
        for (let z = 1; z < size - 1; z++) {
            const v00 = z * verts + 0;
            const v01 = (z + 1) * verts + 0;
            const v10 = z * verts + 1;
            const v11 = (z + 1) * verts + 1;
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
        // Right edge (x=size-1, x=size, excluding corners)
        for (let z = 1; z < size - 1; z++) {
            const v00 = z * verts + (size - 1);
            const v01 = (z + 1) * verts + (size - 1);
            const v10 = z * verts + size;
            const v11 = (z + 1) * verts + size;
            indices.push(v00, v01, v10);
            indices.push(v10, v01, v11);
        }
    
        // 2. Coarse interior (step by 2)
        for (let z = step; z < size - step + 1; z += step) {
            for (let x = step; x < size - step + 1; x += step) {
                const v00 = z * verts + x;
                const v01 = (z + step) * verts + x;
                const v10 = z * verts + (x + step);
                const v11 = (z + step) * verts + (x + step);
                indices.push(v00, v01, v10);
                indices.push(v10, v01, v11);
            }
        }
    
        // 3. FIXED STITCHING: rim to interior
        // Top seam (z=1 rim to z=2 interior)
        for (let x = step; x <= size - step; x += step) {
            const vInterior = step * verts + x;
            
            // Connect to step rim vertices: from x-step to x
            for (let rimX = x - step; rimX < x; rimX++) {
                const rim1 = 1 * verts + rimX;
                const rim2 = 1 * verts + (rimX + 1);
                indices.push(vInterior, rim1, rim2);
            }
            
            // Connect to next interior vertex
            if (x + step <= size - step) {
                const vNext = step * verts + (x + step);
                const rimLast = 1 * verts + x;
                indices.push(vInterior, rimLast, vNext);
            }
        }
        
        // Bottom seam (z=size-1 rim to z=size-2 interior)
        for (let x = step; x <= size - step; x += step) {
            const vInterior = (size - step) * verts + x;
            
            for (let rimX = x - step; rimX < x; rimX++) {
                const rim1 = (size - 1) * verts + rimX;
                const rim2 = (size - 1) * verts + (rimX + 1);
                indices.push(vInterior, rim2, rim1); // Reversed winding
            }
            
            if (x + step <= size - step) {
                const vNext = (size - step) * verts + (x + step);
                const rimLast = (size - 1) * verts + x;
                indices.push(vInterior, vNext, rimLast); // Reversed winding
            }
        }
        
        // Left seam (x=1 rim to x=2 interior)
        for (let z = step; z <= size - step; z += step) {
            const vInterior = z * verts + step;
            
            for (let rimZ = z - step; rimZ < z; rimZ++) {
                const rim1 = rimZ * verts + 1;
                const rim2 = (rimZ + 1) * verts + 1;
                indices.push(vInterior, rim2, rim1); // Reversed winding
            }
            
            if (z + step <= size - step) {
                const vNext = (z + step) * verts + step;
                const rimLast = z * verts + 1;
                indices.push(vInterior, vNext, rimLast); // Reversed winding
            }
        }
        
        // Right seam (x=size-1 rim to x=size-2 interior)
        for (let z = step; z <= size - step; z += step) {
            const vInterior = z * verts + (size - step);
            
            for (let rimZ = z - step; rimZ < z; rimZ++) {
                const rim1 = rimZ * verts + (size - 1);
                const rim2 = (rimZ + 1) * verts + (size - 1);
                indices.push(vInterior, rim1, rim2);
            }
            
            if (z + step <= size - step) {
                const vNext = (z + step) * verts + (size - step);
                const rimLast = z * verts + (size - 1);
                indices.push(vInterior, rimLast, vNext);
            }
        }
        
        return indices;
    }

    ///////////////////////////
    // ------ LOD 2 -------- //
    ///////////////////////////
    static buildIndicesLod2(size, verts) {
        const indices = [];
        const stepOuter = 2; // transition zone between rim and next coarser ring
        const stepInner = 4; // coarsest interior step
    
        // === 1. Full-res rim (edges, as in LOD1) ===
        for (let x = 0; x < size; x++) {
            // Top edge (z=0,1)
            indices.push(0 * verts + x, 1 * verts + x, 0 * verts + x + 1);
            indices.push(0 * verts + x + 1, 1 * verts + x, 1 * verts + x + 1);
            // Bottom edge (z=size-1, size)
            indices.push(size * verts + x, (size - 1) * verts + x, size * verts + x + 1);
            indices.push(size * verts + x + 1, (size - 1) * verts + x, (size - 1) * verts + x + 1);
        }
        for (let z = 1; z < size - 1; z++) {
            // Left edge (x=0,1) skip corners
            indices.push(z * verts + 0, (z + 1) * verts + 0, z * verts + 1);
            indices.push(z * verts + 1, (z + 1) * verts + 0, (z + 1) * verts + 1);
            // Right edge (x=size-1,size) skip corners
            indices.push(z * verts + size, (z + 1) * verts + size, z * verts + size - 1);
            indices.push(z * verts + size - 1, (z + 1) * verts + size, (z + 1) * verts + size - 1);
        }
    
        // === 2. Interior at stepInner (step=4) ===
        for (let z = stepInner; z < size - stepInner + 1; z += stepInner) {
            for (let x = stepInner; x < size - stepInner + 1; x += stepInner) {
                const v00 = z * verts + x;
                const v01 = (z + stepInner) * verts + x;
                const v10 = z * verts + (x + stepInner);
                const v11 = (z + stepInner) * verts + (x + stepInner);
                indices.push(v00, v01, v10);
                indices.push(v10, v01, v11);
            }
        }
    
        // === 3. Rim <-> subrim (stepOuter=2 seam, bowtie/diamond stitching) ===
    
        // Top seam (z=stepOuter, connects to rim z=1):
        for (let x = stepOuter; x <= size - stepOuter; x += stepOuter) {
            const vMid = stepOuter * verts + x;
            for (let i = 0; i < stepOuter; ++i) {
                const rimX1 = x - stepOuter / 2 + i;
                const rimX2 = rimX1 + 1;
                if (rimX1 >= 0 && rimX2 <= size) {
                    const seam1 = 1 * verts + rimX1;
                    const seam2 = 1 * verts + rimX2;
                    indices.push(vMid, seam1, seam2);
                    // Close to next vMid on x if at last i
                    if (i === stepOuter - 1 && x + stepOuter <= size - stepOuter) {
                        const nextMid = stepOuter * verts + (x + stepOuter);
                        indices.push(vMid, seam2, nextMid);
                    }
                }
            }
        }
        // Bottom seam (z=size-stepOuter, connects to rim z=size-1):
        for (let x = stepOuter; x <= size - stepOuter; x += stepOuter) {
            const vMid = (size - stepOuter) * verts + x;
            for (let i = 0; i < stepOuter; ++i) {
                const rimX1 = x - stepOuter / 2 + i;
                const rimX2 = rimX1 + 1;
                if (rimX1 >= 0 && rimX2 <= size) {
                    const seam1 = (size - 1) * verts + rimX1;
                    const seam2 = (size - 1) * verts + rimX2;
                    indices.push(vMid, seam2, seam1);
                    if (i === stepOuter - 1 && x + stepOuter <= size - stepOuter) {
                        const nextMid = (size - stepOuter) * verts + (x + stepOuter);
                        indices.push(vMid, nextMid, seam2);
                    }
                }
            }
        }
        // Left seam (x=stepOuter, connects to rim x=1):
        for (let z = stepOuter; z <= size - stepOuter; z += stepOuter) {
            const vMid = z * verts + stepOuter;
            for (let i = 0; i < stepOuter; ++i) {
                const rimZ1 = z - stepOuter / 2 + i;
                const rimZ2 = rimZ1 + 1;
                if (rimZ1 >= 0 && rimZ2 <= size) {
                    const seam1 = rimZ1 * verts + 1;
                    const seam2 = rimZ2 * verts + 1;
                    indices.push(vMid, seam2, seam1);
                    if (i === stepOuter - 1 && z + stepOuter <= size - stepOuter) {
                        const nextMid = (z + stepOuter) * verts + stepOuter;
                        indices.push(vMid, nextMid, seam2);
                    }
                }
            }
        }
        // Right seam (x=size-stepOuter, connects to rim x=size-1):
        for (let z = stepOuter; z <= size - stepOuter; z += stepOuter) {
            const vMid = z * verts + (size - stepOuter);
            for (let i = 0; i < stepOuter; ++i) {
                const rimZ1 = z - stepOuter / 2 + i;
                const rimZ2 = rimZ1 + 1;
                if (rimZ1 >= 0 && rimZ2 <= size) {
                    const seam1 = rimZ1 * verts + (size - 1);
                    const seam2 = rimZ2 * verts + (size - 1);
                    indices.push(vMid, seam1, seam2);
                    if (i === stepOuter - 1 && z + stepOuter <= size - stepOuter) {
                        const nextMid = (z + stepOuter) * verts + (size - stepOuter);
                        indices.push(vMid, seam2, nextMid);
                    }
                }
            }
        }
    
        // === 4. Second bowtie: step2 seam <-> step4 interior ===
        const numSegments = stepInner / stepOuter;
    
        // Top seam (z=stepInner, connects to stepOuter at z=2, and to the next stepInner interior vertex)
        for (let x = stepInner; x <= size - stepInner; x += stepInner) {
            const vInner = stepInner * verts + x;
            for (let i = 0; i < numSegments; ++i) {
                const segX1 = x - stepInner / 2 + i * stepOuter;
                const segX2 = segX1 + stepOuter;
    
                // stepOuter seam vertices at z=stepOuter
                if (segX1 >= 0 && segX2 <= size) {
                    const seam1 = stepOuter * verts + segX1;
                    const seam2 = stepOuter * verts + segX2;
                    indices.push(vInner, seam1, seam2);
    
                    // Close quad to next interior, if not at end
                    if (i === numSegments - 1 && x + stepInner <= size - stepInner) {
                        const vNextInner = stepInner * verts + (x + stepInner);
                        indices.push(vInner, seam2, vNextInner);
                    }
                }
            }
        }
        // Bottom seam (z=size-stepInner)
        for (let x = stepInner; x <= size - stepInner; x += stepInner) {
            const vInner = (size - stepInner) * verts + x;
            for (let i = 0; i < numSegments; ++i) {
                const segX1 = x - stepInner / 2 + i * stepOuter;
                const segX2 = segX1 + stepOuter;
    
                if (segX1 >= 0 && segX2 <= size) {
                    const seam1 = (size - stepOuter) * verts + segX1;
                    const seam2 = (size - stepOuter) * verts + segX2;
                    indices.push(vInner, seam2, seam1);
    
                    if (i === numSegments - 1 && x + stepInner <= size - stepInner) {
                        const vNextInner = (size - stepInner) * verts + (x + stepInner);
                        indices.push(vInner, vNextInner, seam2);
                    }
                }
            }
        }
        // Left seam (x=stepInner)
        for (let z = stepInner; z <= size - stepInner; z += stepInner) {
            const vInner = z * verts + stepInner;
            for (let i = 0; i < numSegments; ++i) {
                const segZ1 = z - stepInner / 2 + i * stepOuter;
                const segZ2 = segZ1 + stepOuter;
    
                if (segZ1 >= 0 && segZ2 <= size) {
                    const seam1 = segZ1 * verts + stepOuter;
                    const seam2 = segZ2 * verts + stepOuter;
                    indices.push(vInner, seam2, seam1);
    
                    if (i === numSegments - 1 && z + stepInner <= size - stepInner) {
                        const vNextInner = (z + stepInner) * verts + stepInner;
                        indices.push(vInner, vNextInner, seam2);
                    }
                }
            }
        }
        // Right seam (x=size-stepInner)
        for (let z = stepInner; z <= size - stepInner; z += stepInner) {
            const vInner = z * verts + (size - stepInner);
            for (let i = 0; i < numSegments; ++i) {
                const segZ1 = z - stepInner / 2 + i * stepOuter;
                const segZ2 = segZ1 + stepOuter;
    
                if (segZ1 >= 0 && segZ2 <= size) {
                    const seam1 = segZ1 * verts + (size - stepOuter);
                    const seam2 = segZ2 * verts + (size - stepOuter);
                    indices.push(vInner, seam1, seam2);
    
                    if (i === numSegments - 1 && z + stepInner <= size - stepInner) {
                        const vNextInner = (z + stepInner) * verts + (size - stepInner);
                        indices.push(vInner, seam2, vNextInner);
                    }
                }
            }
        }
        return indices;
    }
}
