// js/game/spaceShipModel.js
import { Vector3, Matrix4 } from '../../shared/math/index.js';
import { BaseModel } from '../../core/mesh/model/baseModel.js';
import { Geometry } from '../../core/renderer/resources/geometry.js';   
import { Material } from '../../core/renderer/resources/material.js';
import { getGenericMeshShaders } from '../../core/renderer/shaders/genericMeshShaders.js';


export class SpaceshipModel extends BaseModel {
    constructor() {
        super({
            name: 'Spaceship',
            lodDistances: [0, 80, 200, 500],
            maxLOD: 3
        });
        
        this.baseColor = { r: 0.27, g: 0.53, b: 1.0 };
        this.emissiveColor = { r: 1.0, g: 0.4, b: 0.0 };
        this.emissiveIntensity = 0.0;
    }
    
    createGeometry(lodLevel = 0) {
        // Create a simple box for testing
        const geometry = new Geometry();
        
        // Box vertices
        const size = 2;
        const positions = new Float32Array([
            // Front face
            -size, -size,  size,
             size, -size,  size,
             size,  size,  size,
            -size,  size,  size,
            // Back face
            -size, -size, -size,
            -size,  size, -size,
             size,  size, -size,
             size, -size, -size,
            // Top face
            -size,  size, -size,
            -size,  size,  size,
             size,  size,  size,
             size,  size, -size,
            // Bottom face
            -size, -size, -size,
             size, -size, -size,
             size, -size,  size,
            -size, -size,  size,
            // Right face
             size, -size, -size,
             size,  size, -size,
             size,  size,  size,
             size, -size,  size,
            // Left face
            -size, -size, -size,
            -size, -size,  size,
            -size,  size,  size,
            -size,  size, -size,
        ]);
        
        // Normals
        const normals = new Float32Array([
            // Front face
            0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
            // Back face
            0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
            // Top face
            0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
            // Bottom face
            0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
            // Right face
            1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
            // Left face
            -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0
        ]);
        
        // UVs
        const uvs = new Float32Array([
            // Each face gets standard UV coords
            0, 0,  1, 0,  1, 1,  0, 1,  // Front
            0, 0,  1, 0,  1, 1,  0, 1,  // Back
            0, 0,  1, 0,  1, 1,  0, 1,  // Top
            0, 0,  1, 0,  1, 1,  0, 1,  // Bottom
            0, 0,  1, 0,  1, 1,  0, 1,  // Right
            0, 0,  1, 0,  1, 1,  0, 1,  // Left
        ]);
        
        // Create simple vertex colors (all blue for now)
        const colors = new Float32Array(24 * 4); // 24 vertices * 4 components (RGBA)
        for (let i = 0; i < 24; i++) {
            colors[i * 4] = 0.27;     // R
            colors[i * 4 + 1] = 0.53; // G
            colors[i * 4 + 2] = 1.0;  // B
            colors[i * 4 + 3] = 0.0;  // A (emissive factor)
        }
        
        // Indices
        const indices = new Uint16Array([
            0,  1,  2,    0,  2,  3,    // front
            4,  5,  6,    4,  6,  7,    // back
            8,  9,  10,   8,  10, 11,   // top
            12, 13, 14,   12, 14, 15,   // bottom
            16, 17, 18,   16, 18, 19,   // right
            20, 21, 22,   20, 22, 23    // left
        ]);
        
        geometry.setAttribute('position', positions, 3);
        geometry.setAttribute('normal', normals, 3);
        geometry.setAttribute('uv', uvs, 2);
        geometry.setAttribute('color', colors, 4); // Add vertex colors
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        
        return geometry;
    }
    
    async createMaterial(backend) {
        const shaders = getGenericMeshShaders();
        
        const material = new Material({
            name: 'SpaceshipMaterial',
            vertexShader: shaders.vertex,
            fragmentShader: shaders.fragment,
            vertexLayout: [
                { 
                    arrayStride: 12, 
                    stepMode: 'vertex', 
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] 
                },
                { 
                    arrayStride: 12, 
                    stepMode: 'vertex', 
                    attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] 
                },
                { 
                    arrayStride: 8,  
                    stepMode: 'vertex', 
                    attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] 
                },
                { 
                    arrayStride: 16, 
                    stepMode: 'vertex', 
                    attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] 
                }
            ],
            uniforms: {
                modelMatrix: { value: new Matrix4() },
                viewMatrix: { value: new Matrix4() },
                projectionMatrix: { value: new Matrix4() },
                cameraPosition: { value: new Vector3() },
                
                baseColor: { value: new Vector3(this.baseColor.r, this.baseColor.g, this.baseColor.b) },
                metalness: { value: 0.7 },
                roughness: { value: 0.3 },
                emissiveColor: { value: new Vector3(this.emissiveColor.r, this.emissiveColor.g, this.emissiveColor.b) },
                emissiveIntensity: { value: this.emissiveIntensity },
                
                sunDirection: { value: new Vector3(0.5, 1.0, 0.3).normalize() },
                sunColor: { value: new Vector3(1.0, 0.98, 0.95) },
                sunIntensity: { value: 2.0 },
                ambientColor: { value: new Vector3(0.1, 0.12, 0.15) },
                
                time: { value: 0 }
            },
            bindGroupLayoutSpec: [
                {
                    label: 'GenericMesh-Uniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex', buffer: { type: 'uniform' }, name: 'vertexUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'fragmentUniforms' }
                    ]
                }
            ],
            depthTest: true,
            depthWrite: true,
            side: 'front'
        });
        
        return material;
    }
    
    update(state) {
        if (!state) return;
        
        // Update position
        this.setPosition(state.position.x, state.position.y, state.position.z);
        
        // Update rotation
        const yaw = -(state.direction - Math.PI / 2);
        const pitch = -state.pitch;
        const roll = -state.roll;
        this.setRotation(yaw, pitch, roll);
        
        // Update engine glow
        const thrusterActive = Math.abs(state.verticalThrust) > 0.1 || state.speed > 5;
        const engineGlow = thrusterActive ? 
            Math.min(1.0, (state.speed / 20) + Math.abs(state.verticalThrust) / 10) : 0;
        
        if (this.material) {
            this.material.uniforms.emissiveIntensity.value = engineGlow * 2.0;
        }
        
        this._needsMatrixUpdate = true;
    }
}