// platform_game/actors/BallModel.js
//
// Primitive-sphere render model for the player ball. Slots into
// GenericMeshRenderer; no skeleton, no animations, no GLTF asset.
// Mirrors the pattern in wizard_game/game/spaceShipModel.js.

import { Vector3, Matrix4 } from '../../shared/math/index.js';
import { BaseModel } from '../../core/mesh/model/baseModel.js';
import { Geometry } from '../../core/renderer/resources/geometry.js';
import { Material } from '../../core/renderer/resources/material.js';
import { getGenericMeshShaders } from '../../core/renderer/shaders/genericMeshShaders.js';

export class BallModel extends BaseModel {
    constructor(options = {}) {
        super({
            name: options.name ?? 'Ball',
            lodDistances: [0, 40, 160, 640],
            maxLOD: 2
        });

        this.radius = options.radius ?? 0.5;
        this.color = options.color ?? { r: 0.22, g: 0.55, b: 1.0 };
        this.emissive = options.emissive ?? { r: 0.05, g: 0.20, b: 0.45 };
        this.emissiveIntensity = options.emissiveIntensity ?? 0.35;
        this.metalness = options.metalness ?? 0.15;
        this.roughness = options.roughness ?? 0.55;

        // LOD segment counts: keeps the near sphere smooth, far cheap.
        this._segmentsByLOD = [
            { w: 32, h: 20 },
            { w: 16, h: 12 },
            { w: 10, h: 8 },
        ];
    }

    createGeometry(lodLevel = 0) {
        const seg = this._segmentsByLOD[Math.min(lodLevel, this._segmentsByLOD.length - 1)];
        const r = this.radius;

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
                const nx = Math.cos(theta) * Math.sin(phi);
                const ny = Math.cos(phi);
                const nz = Math.sin(theta) * Math.sin(phi);
                positions.push(nx * r, ny * r, nz * r);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
                // Subtle polar shading via vertex color → pole a hint darker.
                const pole = Math.abs(ny);
                const tint = 1.0 - pole * 0.25;
                colors.push(this.color.r * tint, this.color.g * tint, this.color.b * tint, 0.0);
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
        const material = new Material({
            name: 'BallMaterial',
            vertexShader: shaders.vertex,
            fragmentShader: shaders.fragment,
            vertexLayout: [
                { arrayStride: 12, stepMode: 'vertex',
                  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, stepMode: 'vertex',
                  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                { arrayStride: 8,  stepMode: 'vertex',
                  attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                { arrayStride: 16, stepMode: 'vertex',
                  attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] }
            ],
            uniforms: {
                modelMatrix:      { value: new Matrix4() },
                viewMatrix:       { value: new Matrix4() },
                projectionMatrix: { value: new Matrix4() },
                cameraPosition:   { value: new Vector3() },
                baseColor:        { value: new Vector3(this.color.r, this.color.g, this.color.b) },
                metalness:        { value: this.metalness },
                roughness:        { value: this.roughness },
                emissiveColor:    { value: new Vector3(this.emissive.r, this.emissive.g, this.emissive.b) },
                emissiveIntensity:{ value: this.emissiveIntensity },
                sunDirection:     { value: new Vector3(0.5, 1.0, 0.3).normalize() },
                sunColor:         { value: new Vector3(1.0, 0.98, 0.95) },
                sunIntensity:     { value: 2.0 },
                ambientColor:     { value: new Vector3(0.45, 0.50, 0.65) },
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
            // Double-sided so we never cull the ball because of a
            // winding mismatch with a future custom sphere generator.
            side: 'double'
        });
        return material;
    }

    /**
     * Place the ball at the actor's world-space position. The resolver
     * pins the actor's CENTER exactly on the ground surface, so we lift
     * the visual sphere by its own radius along the local radial so the
     * bottom touches ground instead of half-sinking into it.
     */
    syncToActor(actor, planetOrigin = null) {
        if (!actor?.position) return;
        let px = actor.position.x, py = actor.position.y, pz = actor.position.z;
        if (planetOrigin) {
            let ux = px - planetOrigin.x, uy = py - planetOrigin.y, uz = pz - planetOrigin.z;
            const ul = Math.hypot(ux, uy, uz) || 1;
            ux /= ul; uy /= ul; uz /= ul;
            px += ux * this.radius;
            py += uy * this.radius;
            pz += uz * this.radius;
        }
        this.setPositionDirect(px, py, pz);
        if (actor.movementState === 1) {
            this._rollAngle = (this._rollAngle ?? 0) + 0.12;
            this.setRotation(actor.facingYaw ?? 0, this._rollAngle, 0);
        } else {
            this.setRotation(actor.facingYaw ?? 0, this._rollAngle ?? 0, 0);
        }
        this._needsMatrixUpdate = true;
    }
}
