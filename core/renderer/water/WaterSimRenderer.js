// core/renderer/water/WaterSimRenderer.js
//
// Draws the near-field water simulation (core/world/water/WaterRiverSim.js,
// a strip of cells along a river) as a transparent mesh, one vertex per
// simulation cell, reading the simulation's buffers and row frames directly
// (shaders: waterSimSurface.wgsl.js). Drawn after the terrain and the
// meshes, so objects standing in water show through it by depth. Material
// layout follows riverMaterialBuilder.js.

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { buildWaterSimFragmentShader, buildWaterSimVertexShader } from './waterSimSurface.wgsl.js';

const VERTEX_FLOATS = 48;
const FRAGMENT_FLOATS = 24;

function gridIndices(W, L) {
    const idx = new Uint32Array((W - 1) * (L - 1) * 6);
    let q = 0;
    for (let j = 0; j < L - 1; j++) {
        for (let i = 0; i < W - 1; i++) {
            const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
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
        this._dims = '';
        this._geometry = null;
        this._material = null;
    }

    /** The simulation to draw (WaterRiverSim, or null) and the water look (WaterGpuData.look). */
    setSite(site, look) {
        this.site = site || null;
        this.look = look || null;
        if (!site) return;
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
                            { binding: 3, visibility: 'vertex', name: 'rows', buffer: { type: 'read-only-storage' } },
                        ],
                    },
                ],
            });
        }
        this._ensureGeometry();
    }

    // Index grid and buffer bindings for the simulation's current size.
    _ensureGeometry() {
        const site = this.site;
        if (!site?.sim) return false;
        const dims = `${site.W}x${site.L}`;
        if (dims !== this._dims) {
            this._geometry?.dispose?.();
            this._geometry = new Geometry();
            this._geometry.setIndex(gridIndices(site.W, site.L));
            this._dims = dims;
        }
        this._material.storageBuffers = {
            bed: site.sim.bedBuffer,
            state: site.sim.stateBuffer,
            turbulence: site.sim.kBuffers[0],
            rows: site.rowsBuffer,
        };
        return true;
    }

    render(camera, viewMatrix, projectionMatrix, timeS) {
        const site = this.site;
        if (!site || !this._material || site.state !== 'running' || site.fade <= 0) return;
        if (!this._ensureGeometry()) return;
        const vu = this._material.uniforms.waterSimVertexUniforms.value;
        const fu = this._material.uniforms.waterSimFragmentUniforms.value;
        vu.set(viewMatrix.elements ?? viewMatrix, 0);
        vu.set(projectionMatrix.elements ?? projectionMatrix, 16);
        const o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const p = site.sim.params, cfg = site.config;
        vu.set([o.x, o.y, o.z, site.R, p.dx, site.W, site.L, site.sim.rowBase,
            p.hmin, timeS, site.fade, cfg.endFadeM, 0.06, 0, 0, 0], 32);

        const g = this.uniformManager?.uniforms ?? {};
        const L = this.look ?? {};
        const cam = camera?.position ?? { x: 0, y: 0, z: 0 };
        fu.set([...vec3Of(g.sunLightDirection?.value, [0.5, 1, 0.3]), numOf(g.sunLightIntensity?.value, 1),
            ...vec3Of(g.sunLightColor?.value, [1, 1, 1]), numOf(g.ambientLightIntensity?.value, 0.8),
            ...vec3Of(g.ambientLightColor?.value, [0.25, 0.25, 0.25]), timeS,
            cam.x, cam.y, cam.z, p.hmin,
            ...(L.deepColor ?? [0.015, 0.05, 0.06]), numOf(L.reflection, 1.4),
            ...(L.absorption ?? [0.4, 0.11, 0.08]), 0], 0);
        this.backend.draw(this._geometry, this._material);
    }

    dispose() {
        this._geometry?.dispose?.();
        this._material?.dispose?.();
        this._geometry = null;
        this._material = null;
    }
}
