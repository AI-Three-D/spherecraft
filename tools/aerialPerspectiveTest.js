import { Geometry } from '../core/renderer/resources/geometry.js';
import { Material } from '../core/renderer/resources/material.js';

export class AerialPerspectiveTest {
    constructor(backend, uniformManager, atmosphereLUT) {
        this.backend = backend;
        this.uniformManager = uniformManager;
        this.atmosphereLUT = atmosphereLUT;

        this._geometry = null;
        this._material = null;
        this._initialized = false;
    }
    
    async initialize() {
        this._createGeometry();
        await this._createMaterial();
        this._initialized = true;
        
    }
    
    _createGeometry() {
        const positions = new Float32Array([
            -1, -1, 0,
             1, -1, 0,
            -1,  1, 0,
             1,  1, 0
        ]);
        
        const normals = new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]);
        
        const uvs = new Float32Array([
            0, 0,
            1, 0,
            0, 1,
            1, 1
        ]);
        
        const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
        
        this._geometry = new Geometry();
        this._geometry.setAttribute('position', positions, 3);
        this._geometry.setAttribute('normal', normals, 3);
        this._geometry.setAttribute('uv', uvs, 2);
        this._geometry.setIndex(indices);
    }
    
    async _createMaterial() {
        const vertexShader = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(input.position.xy, 0.0, 1.0);
    output.uv = input.uv;
    return output;
}
`;

        const fragmentShader = `
@group(0) @binding(0) var<uniform> params: vec4<f32>;
@group(1) @binding(0) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(1) var lutSampler: sampler;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let transmittance = textureSample(transmittanceLUT, lutSampler, uv).rgb;
    return vec4<f32>(transmittance, 1.0);
}
`;

        this._material = new Material({
            name: 'AerialPerspectiveTest',
            vertexShader,
            fragmentShader,
            uniforms: {
                transmittanceLUT: { value: this.atmosphereLUT.transmittanceLUT },
                viewerAltitude: { value: 0.0 }
            },
            depthTest: false,
            depthWrite: false,
            vertexLayout: [
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] }
            ]
        });
    }
    
    render() {
        if (!this._initialized) return;
        
        this._material.uniforms.viewerAltitude = { 
            value: this.uniformManager.uniforms.viewerAltitude.value 
        };
        
        this.backend.draw(this._geometry, this._material);
    }
    
    dispose() {
        if (this._geometry) this._geometry.dispose();
        if (this._material) this.backend.deleteShader(this._material);
    }
}