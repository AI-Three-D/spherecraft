import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { BaseModel } from '../mesh/model/baseModel.js';
import { GeometryBuilder } from '../mesh/model/geometryBuilder.js';
import { Material } from '../renderer/resources/material.js';

const TEST_BALL_VERTEX = /* wgsl */`
@group(0) @binding(0) var<uniform> modelMatrix : mat4x4<f32>;
@group(0) @binding(1) var<uniform> viewMatrix : mat4x4<f32>;
@group(0) @binding(2) var<uniform> projectionMatrix : mat4x4<f32>;

struct VertexInput {
    @location(0) position : vec3<f32>,
};

@vertex
fn main(input : VertexInput) -> @builtin(position) vec4<f32> {
    let worldPos = modelMatrix * vec4<f32>(input.position, 1.0);
    return projectionMatrix * viewMatrix * worldPos;
}
`;

const TEST_BALL_FRAGMENT = /* wgsl */`
@group(0) @binding(3) var<uniform> color : vec4<f32>;

@fragment
fn main() -> @location(0) vec4<f32> {
    return color;
}
`;

export class TestBallModel extends BaseModel {
    constructor(options = {}) {
        super({
            name: options.name || 'TestBall',
            lodDistances: [0, 120, 300, 800],
            maxLOD: 0
        });

        this.radius = options.radius ?? 8;
        this.baseColor = options.baseColor || [1.0, 0.1, 0.1, 1.0];
    }

    createGeometry() {
        return GeometryBuilder.createSphere(this.radius, 24, 16);
    }

    async createMaterial() {
        return new Material({
            name: 'TestBallMaterial',
            vertexShader: TEST_BALL_VERTEX,
            fragmentShader: TEST_BALL_FRAGMENT,
            vertexLayout: [
                {
                    arrayStride: 12,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]
                }
            ],
            uniforms: {
                modelMatrix: { value: new THREE.Matrix4() },
                viewMatrix: { value: new THREE.Matrix4() },
                projectionMatrix: { value: new THREE.Matrix4() },
                color: { value: new Float32Array(this.baseColor) }
            },
            bindGroupLayoutSpec: [
                {
                    label: 'TestBall-Uniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex', buffer: { type: 'uniform' }, name: 'modelMatrix' },
                        { binding: 1, visibility: 'vertex', buffer: { type: 'uniform' }, name: 'viewMatrix' },
                        { binding: 2, visibility: 'vertex', buffer: { type: 'uniform' }, name: 'projectionMatrix' },
                        { binding: 3, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'color' }
                    ]
                }
            ],
            depthTest: true,
            depthWrite: true,
            side: 'double'
        });
    }
}
