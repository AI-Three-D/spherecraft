// platform_game/game/CloudPlatformModel.js
//
// Visual mesh for a single floating cloud platform. A flattened
// ellipsoid rendered through GenericMeshRenderer — same pipeline as the
// player ball, so it picks up lighting and fog consistently.
//
// Turn 2 scope: visual only. Collision is wired in a later turn when we
// extend movementResolver.wgsl with a platform-collider buffer.

import { Vector3, Matrix4 } from '../../shared/math/index.js';
import { BaseModel } from '../../core/mesh/model/baseModel.js';
import { Geometry } from '../../core/renderer/resources/geometry.js';
import { Material } from '../../core/renderer/resources/material.js';
import { getGenericMeshShaders } from '../../core/renderer/shaders/genericMeshShaders.js';

export class CloudPlatformModel extends BaseModel {
    constructor(options = {}) {
        super({
            name: options.name ?? 'CloudPlatform',
            lodDistances: [0, 120, 400, 1500],
            maxLOD: 2
        });
        this.radius = options.radius ?? 6.0;        // disc radius
        this.thickness = options.thickness ?? 1.8;  // vertical half-height
        this.color = options.color ?? { r: 0.95, g: 0.97, b: 1.0 };
        this.shadowColor = options.shadowColor ?? { r: 0.55, g: 0.62, b: 0.78 };

        this._segmentsByLOD = [
            { w: 28, h: 14 },
            { w: 16, h: 10 },
            { w: 10, h: 6 },
        ];
    }

    createGeometry(lodLevel = 0) {
        const seg = this._segmentsByLOD[Math.min(lodLevel, this._segmentsByLOD.length - 1)];
        const rx = this.radius;
        const ry = this.thickness;
        const rz = this.radius;

        const positions = [];
        const normals = [];
        const uvs = [];
        const colors = [];
        const indices = [];

        for (let y = 0; y <= seg.h; y++) {
            const v = y / seg.h;
            const phi = v * Math.PI;
            for (let x = 0; x <= seg.w; x++) {
                const u = x / seg.w;
                const theta = u * Math.PI * 2;
                const sx = Math.cos(theta) * Math.sin(phi);
                const sy = Math.cos(phi);
                const sz = Math.sin(theta) * Math.sin(phi);
                // Squished ellipsoid.
                const px = sx * rx;
                const py = sy * ry;
                const pz = sz * rz;
                positions.push(px, py, pz);
                // Recompute a proper normal for the squished shape.
                const nx = sx / rx, ny = sy / ry, nz = sz / rz;
                const nl = Math.hypot(nx, ny, nz) || 1;
                normals.push(nx / nl, ny / nl, nz / nl);
                uvs.push(u, v);
                // Darker underside, brighter top. sy ∈ [-1,1].
                const t = 0.5 + 0.5 * sy;
                const r = this.shadowColor.r + (this.color.r - this.shadowColor.r) * t;
                const g = this.shadowColor.g + (this.color.g - this.shadowColor.g) * t;
                const b = this.shadowColor.b + (this.color.b - this.shadowColor.b) * t;
                colors.push(r, g, b, 0.0);
            }
        }
        for (let y = 0; y < seg.h; y++) {
            for (let x = 0; x < seg.w; x++) {
                const a = y * (seg.w + 1) + x;
                const b = a + (seg.w + 1);
                indices.push(a, b, a + 1);
                indices.push(b, b + 1, a + 1);
            }
        }

        const geom = new Geometry();
        geom.setAttribute('position', new Float32Array(positions), 3);
        geom.setAttribute('normal',   new Float32Array(normals),   3);
        geom.setAttribute('uv',       new Float32Array(uvs),       2);
        geom.setAttribute('color',    new Float32Array(colors),    4);
        geom.setIndex(new Uint16Array(indices));
        geom.computeBoundingSphere();
        return geom;
    }

    async createMaterial(backend) {
        const shaders = getGenericMeshShaders();
        return new Material({
            name: 'CloudPlatformMaterial',
            vertexShader: shaders.vertex,
            fragmentShader: shaders.fragment,
            vertexLayout: [
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                { arrayStride: 16, stepMode: 'vertex', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] }
            ],
            uniforms: {
                modelMatrix:      { value: new Matrix4() },
                viewMatrix:       { value: new Matrix4() },
                projectionMatrix: { value: new Matrix4() },
                cameraPosition:   { value: new Vector3() },
                baseColor:        { value: new Vector3(this.color.r, this.color.g, this.color.b) },
                metalness:        { value: 0.0 },
                roughness:        { value: 0.95 },
                emissiveColor:    { value: new Vector3(0, 0, 0) },
                emissiveIntensity:{ value: 0.0 },
                sunDirection:     { value: new Vector3(0.5, 1.0, 0.3).normalize() },
                sunColor:         { value: new Vector3(1.0, 0.98, 0.95) },
                sunIntensity:     { value: 2.0 },
                ambientColor:     { value: new Vector3(0.55, 0.60, 0.72) },
                time:             { value: 0 }
            },
            bindGroupLayoutSpec: [{
                label: 'GenericMesh-Uniforms',
                entries: [
                    { binding: 0, visibility: 'vertex',   buffer: { type: 'uniform' }, name: 'vertexUniforms' },
                    { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'fragmentUniforms' }
                ]
            }],
            depthTest: true,
            depthWrite: true,
            side: 'double'
        });
    }
}
