import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Geometry } from '../renderer/resources/geometry.js';
import { Material } from '../renderer/resources/material.js';

export class StarRenderer {
    constructor(backend) {
        this.backend = backend;
        this.geometry = null;
        this.material = null;
        this.visible = false;
        this.opacity = 0;

        this.lod = {
            angularDiameterStart: 0.02,
            angularDiameterEnd: 0.06
        };

        this._apiName = backend.getAPIName?.() || 'webgl2';
        this._modelMatrix = new THREE.Matrix4();
        this._scale = new THREE.Vector3(1, 1, 1);
        this._position = new THREE.Vector3();
        this._direction = new THREE.Vector3();
        this._tmpVec = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
    }

    async initialize() {
        this._createGeometry();
        await this._createMaterial();

        if (this.backend && this.material._needsCompile) {
            await this.backend.compileShader(this.material);
            this.material._needsCompile = false;
        }
    }

    _createGeometry() {
        const segments = 48;
        const radius = 1;

        const vertexCount = (segments + 1) * (segments + 1);
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);

        let vertIndex = 0;
        for (let y = 0; y <= segments; y++) {
            const v = y / segments;
            const phi = v * Math.PI;

            for (let x = 0; x <= segments; x++) {
                const u = x / segments;
                const theta = u * Math.PI * 2;

                const sinPhi = Math.sin(phi);
                const cosPhi = Math.cos(phi);
                const sinTheta = Math.sin(theta);
                const cosTheta = Math.cos(theta);

                const nx = sinPhi * cosTheta;
                const ny = cosPhi;
                const nz = sinPhi * sinTheta;

                positions[vertIndex * 3] = radius * nx;
                positions[vertIndex * 3 + 1] = radius * ny;
                positions[vertIndex * 3 + 2] = radius * nz;

                normals[vertIndex * 3] = nx;
                normals[vertIndex * 3 + 1] = ny;
                normals[vertIndex * 3 + 2] = nz;

                vertIndex++;
            }
        }

        const indexCount = segments * segments * 6;
        const indices = new Uint32Array(indexCount);
        let indexOffset = 0;

        for (let y = 0; y < segments; y++) {
            for (let x = 0; x < segments; x++) {
                const v00 = y * (segments + 1) + x;
                const v01 = v00 + 1;
                const v10 = (y + 1) * (segments + 1) + x;
                const v11 = v10 + 1;

                indices[indexOffset++] = v00;
                indices[indexOffset++] = v10;
                indices[indexOffset++] = v01;
                indices[indexOffset++] = v01;
                indices[indexOffset++] = v10;
                indices[indexOffset++] = v11;
            }
        }

        this.geometry = new Geometry();
        this.geometry.setAttribute('position', positions, 3);
        this.geometry.setAttribute('normal', normals, 3);
        this.geometry.setIndex(indices);
        this.geometry.computeBoundingSphere();
    }

    async _createMaterial() {
        const vertexShader = this._apiName === 'webgpu'
            ? this._getWebGPUVertexShader()
            : this._getWebGL2VertexShader();
        const fragmentShader = this._apiName === 'webgpu'
            ? this._getWebGPUFragmentShader()
            : this._getWebGL2FragmentShader();

        if (this._apiName === 'webgpu') {
            this.material = new Material({
                name: 'StarRenderer_WebGPU',
                vertexShader,
                fragmentShader,
                bindGroupLayoutSpec: [
                    {
                        label: 'StarUniforms',
                        entries: [
                            { binding: 0, visibility: 'vertex', buffer: { type: 'uniform' }, name: 'vertexUniforms' },
                            { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'fragmentUniforms' }
                        ]
                    }
                ],
                uniforms: {
                    vertexUniforms: { value: new Float32Array(48) },
                    fragmentUniforms: { value: new Float32Array(12) }
                },
                depthTest: true,
                depthWrite: false,
                transparent: true,
                side: 'front'
            });
        } else {
            this.material = new Material({
                name: 'StarRenderer_WebGL2',
                vertexShader,
                fragmentShader,
                uniforms: {
                    modelMatrix: { value: new THREE.Matrix4() },
                    viewMatrix: { value: new THREE.Matrix4() },
                    projectionMatrix: { value: new THREE.Matrix4() },
                    cameraPosition: { value: new THREE.Vector3() },
                    starColor: { value: new THREE.Color(1, 1, 1) },
                    starIntensity: { value: 1.0 },
                    opacity: { value: 1.0 }
                },
                depthTest: true,
                depthWrite: false,
                transparent: true,
                side: 'front'
            });
        }

        this.material._needsCompile = true;
    }

    update(camera, star, starInfo) {
        if (!star || !starInfo || !Number.isFinite(starInfo.distance)) {
            this.visible = false;
            this.opacity = 0;
            return 1.0;
        }

        const angularDiameter = starInfo.angularDiameter ??
            (2 * Math.atan(star.radius / Math.max(starInfo.distance, 1.0)));
        const geometryFade = this._smoothstep(
            this.lod.angularDiameterStart,
            this.lod.angularDiameterEnd,
            angularDiameter
        );

        this.opacity = geometryFade;
        this.visible = geometryFade > 0.001;

        if (!this.visible) {
            return 1.0 - geometryFade;
        }

        this._direction.copy(starInfo.direction).normalize();
        this._position.copy(camera.position).add(
            this._tmpVec.copy(this._direction).multiplyScalar(starInfo.distance)
        );
        this._scale.set(star.radius, star.radius, star.radius);
        this._modelMatrix.compose(this._position, this._tmpQuat, this._scale);

        if (this._apiName === 'webgpu') {
            const v = this.material.uniforms.vertexUniforms.value;
            v.set(this._modelMatrix.elements, 0);
            v.set(camera.matrixWorldInverse.elements, 16);
            v.set(camera.projectionMatrix.elements, 32);

            const f = this.material.uniforms.fragmentUniforms.value;
            f[0] = camera.position.x;
            f[1] = camera.position.y;
            f[2] = camera.position.z;
            f[3] = 0;

            const color = star.lightColor || new THREE.Color(1, 1, 1);
            f[4] = color.r;
            f[5] = color.g;
            f[6] = color.b;
            f[7] = Math.min(3.0, starInfo.intensity ?? 1.0);

            f[8] = this.opacity;
            f[9] = 0;
            f[10] = 0;
            f[11] = 0;
        } else {
            this.material.uniforms.modelMatrix.value.copy(this._modelMatrix);
            this.material.uniforms.viewMatrix.value.copy(camera.matrixWorldInverse);
            this.material.uniforms.projectionMatrix.value.copy(camera.projectionMatrix);
            this.material.uniforms.cameraPosition.value.copy(camera.position);
            this.material.uniforms.starColor.value.copy(star.lightColor || new THREE.Color(1, 1, 1));
            this.material.uniforms.starIntensity.value = Math.min(3.0, starInfo.intensity ?? 1.0);
            this.material.uniforms.opacity.value = this.opacity;
        }

        return 1.0 - geometryFade;
    }

    render() {
        if (!this.visible || this.opacity <= 0) return;
        this.backend.draw(this.geometry, this.material);
    }

    _smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(edge1 - edge0, 1e-6)));
        return t * t * (3 - 2 * t);
    }

    _getWebGPUVertexShader() {
        return `
struct VertexUniforms {
    modelMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
};

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vNormal: vec3<f32>,
    @location(1) vWorldPosition: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: VertexUniforms;

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPosition = uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
    output.vWorldPosition = worldPosition.xyz;
    output.vNormal = normalize((uniforms.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz);
    output.clipPosition = uniforms.projectionMatrix * uniforms.viewMatrix * worldPosition;
    return output;
}
`;
    }

    _getWebGPUFragmentShader() {
        return `
struct FragmentUniforms {
    cameraPosition: vec3<f32>,
    _pad0: f32,
    starColor: vec3<f32>,
    starIntensity: f32,
    opacity: f32,
    _pad1: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vNormal: vec3<f32>,
    @location(1) vWorldPosition: vec3<f32>,
}

@group(0) @binding(1) var<uniform> fragUniforms: FragmentUniforms;

@fragment
fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.vNormal);
    let viewDir = normalize(fragUniforms.cameraPosition - input.vWorldPosition);
    let ndotv = max(dot(normal, viewDir), 0.0);
    let limb = pow(ndotv, 0.4);
    let brightness = mix(0.6, 1.0, limb);
    let color = fragUniforms.starColor * fragUniforms.starIntensity * brightness;
    return vec4<f32>(color, fragUniforms.opacity);
}
`;
    }

    _getWebGL2VertexShader() {
        return `#version 300 es
precision highp float;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;
in vec3 normal;

out vec3 vNormal;
out vec3 vWorldPosition;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;
    }

    _getWebGL2FragmentShader() {
        return `#version 300 es
precision highp float;

uniform vec3 cameraPosition;
uniform vec3 starColor;
uniform float starIntensity;
uniform float opacity;

in vec3 vNormal;
in vec3 vWorldPosition;

out vec4 fragColor;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float ndotv = max(dot(normal, viewDir), 0.0);
    float limb = pow(ndotv, 0.4);
    float brightness = mix(0.6, 1.0, limb);
    vec3 color = starColor * starIntensity * brightness;
    fragColor = vec4(color, opacity);
}
`;
    }
}
