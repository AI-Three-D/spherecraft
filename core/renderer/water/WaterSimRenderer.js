// core/renderer/water/WaterSimRenderer.js
//
// Draws the near-field water simulation (core/world/water/WaterSimSite.js)
// as a transparent mesh, one vertex per simulation cell, reading the
// simulation's buffers directly (shaders: waterSimSurface.wgsl.js). Drawn
// after the terrain and the meshes, so objects standing in water show
// through it by depth. Material layout follows riverMaterialBuilder.js.

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { buildWaterSimFragmentShader, buildWaterSimVertexShader } from './waterSimSurface.wgsl.js';

const VERTEX_FLOATS = 52;
const FRAGMENT_FLOATS = 32;

function gridIndices(n) {
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            idx[q++] = a; idx[q++] = c; idx[q++] = b;
            idx[q++] = b; idx[q++] = c; idx[q++] = d;
        }
    }
    return idx;
}

const vec3Of = (v, fallback) => {
    if (Array.isArray(v) && v.length >= 3) return v;
    if (v && Number.isFinite(v.x)) return [v.x, v.y, v.z];
    if (v && Number.isFinite(v.r)) return [v.r, v.g, v.b];
    return fallback;
};
const numOf = (v, fallback) => (Number.isFinite(v) ? v : fallback);

export class WaterSimRenderer {
    constructor({ backend, uniformManager, planetConfig }) {
        this.backend = backend;
        this.uniformManager = uniformManager;
        this.planetConfig = planetConfig;
        this.site = null;
        this.look = null;
        this._n = 0;
        this._geometry = null;
        this._material = null;
    }

    /** The site to draw (or null) and the water look (WaterGpuData.look). */
    setSite(site, look) {
        this.site = site || null;
        this.look = look || null;
        if (!site) return;
        if (site.n !== this._n) {
            this._geometry?.dispose?.();
            this._geometry = new Geometry();
            this._geometry.setIndex(gridIndices(site.n));
            this._n = site.n;
        }
        if (!this._material) {
            this._material = new Material({
                name: 'WaterSimSurface',
                vertexShader: buildWaterSimVertexShader(),
                fragmentShader: buildWaterSimFragmentShader(),
                uniforms: {
                    waterSimVertexUniforms: { value: new Float32Array(VERTEX_FLOATS) },
                    waterSimFragmentUniforms: { value: new Float32Array(FRAGMENT_FLOATS) },
                },
                vertexLayout: [],
                side: 'double',
                transparent: true,
                depthTest: true,
                depthWrite: false,
                blending: 'normal',
                bindGroupLayoutSpec: [
                    {
                        label: 'WaterSim-Uniforms',
                        entries: [
                            { binding: 0, visibility: 'vertex', name: 'waterSimVertexUniforms', buffer: { type: 'uniform' } },
                            { binding: 1, visibility: 'fragment', name: 'waterSimFragmentUniforms', buffer: { type: 'uniform' } },
                        ],
                    },
                    {
                        label: 'WaterSim-Storage',
                        entries: [
                            { binding: 0, visibility: 'vertex', name: 'bed', buffer: { type: 'read-only-storage' } },
                            { binding: 1, visibility: 'vertex', name: 'state', buffer: { type: 'read-only-storage' } },
                            { binding: 2, visibility: 'vertex', name: 'turbulence', buffer: { type: 'read-only-storage' } },
                        ],
                    },
                ],
            });
        }
        this._material.storageBuffers = {
            bed: site.sim.bedBuffer,
            state: site.sim.stateBuffer,
            turbulence: site.sim.kBuffers[0],
        };
    }

    render(camera, viewMatrix, projectionMatrix, timeS) {
        const site = this.site;
        if (!site || !this._material || site.state !== 'running' || site.fade <= 0 || !site.frame) return;
        const vu = this._material.uniforms.waterSimVertexUniforms.value;
        const fu = this._material.uniforms.waterSimFragmentUniforms.value;
        vu.set(viewMatrix.elements ?? viewMatrix, 0);
        vu.set(projectionMatrix.elements ?? projectionMatrix, 16);
        const f = site.frame, o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const p = site.sim.params, cfg = site.config;
        vu.set([f.c[0], f.c[1], f.c[2], site.R, f.e1[0], f.e1[1], f.e1[2], cfg.dx, f.e2[0], f.e2[1], f.e2[2], site.n,
            o.x, o.y, o.z, p.hmin, timeS, site.fade, cfg.borderCells * cfg.dx, 0.06], 32);

        const g = this.uniformManager?.uniforms ?? {};
        const L = this.look ?? {};
        const cam = camera?.position ?? { x: 0, y: 0, z: 0 };
        fu.set([...vec3Of(g.sunLightDirection?.value, [0.5, 1, 0.3]), numOf(g.sunLightIntensity?.value, 1),
            ...vec3Of(g.sunLightColor?.value, [1, 1, 1]), numOf(g.ambientLightIntensity?.value, 0.8),
            ...vec3Of(g.ambientLightColor?.value, [0.25, 0.25, 0.25]), timeS,
            cam.x, cam.y, cam.z, p.hmin,
            ...(L.deepColor ?? [0.015, 0.05, 0.06]), numOf(L.reflection, 1.4),
            ...(L.absorption ?? [0.4, 0.11, 0.08]), 0,
            f.e1[0], f.e1[1], f.e1[2], 0,
            f.e2[0], f.e2[1], f.e2[2], 0], 0);
        this.backend.draw(this._geometry, this._material);
    }

    dispose() {
        this._geometry?.dispose?.();
        this._material?.dispose?.();
        this._geometry = null;
        this._material = null;
    }
}
