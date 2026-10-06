// core/renderer/water/NearWaterRenderer.js
//
// Surface of the lakes near the camera (WaterGpuData.near): one grid mesh
// drawn once per lake whose solved patch comes within the near range, flat
// at the lake's level, in one instanced draw (shaders: nearWaterSurface.
// wgsl.js). Where the ground rises above the level the terrain's depth hides
// it, so the shoreline is where the flat water meets the ground at any tile
// LOD (the owner's earlier plane lakes). Farther away the terrain shading
// draws the water (waterWgsl.js applyWater), which near the camera keeps
// only the water's body under this surface: the bed seen through the water.
// Transparent (premultiplied), depth test on, no depth write; drawn after
// the opaque meshes so objects in the water show through it. Binds the
// WaterGpuData buffers, its own copy of the frame's WaterParams, and the
// lighting and atmosphere the terrain shading uses (uniformManager).

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { WATER_BINDINGS } from '../../world/water/waterWgsl.js';
import { gridIndices } from './WaterSimRenderer.js';
import { aerialFadeRange } from '../terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import {
    NEAR_WATER_MAX_LAKES, NEAR_WATER_SAMPLER_BINDING, NEAR_WATER_TRANSMITTANCE_BINDING, NEAR_WATER_UNIFORM_FLOATS,
    buildNearWaterFragmentShader, buildNearWaterVertexShader,
} from './nearWaterSurface.wgsl.js';

// Grid vertices per side (odd: a row and a column through the camera). At
// 1.6 km range: ~0.7 m apart at the camera, ~70 m at the edge.
const GRID_N = 97;
// The lake list is redone when the camera has moved this far (m); lakes are
// listed this much beyond the range.
const RELIST_M = 10;

const vec3Of = (v, fallback) => {
    if (v && Number.isFinite(v.x)) return [v.x, v.y, v.z];
    if (v && Number.isFinite(v.r)) return [v.r, v.g, v.b];
    return fallback;
};
const numOf = (v, fallback) => (Number.isFinite(v) ? v : fallback);

export class NearWaterRenderer {
    constructor({ backend, uniformManager, planetConfig, engineConfig }) {
        this.backend = backend;
        this.uniformManager = uniformManager;
        this.planetConfig = planetConfig;
        this.apFade = aerialFadeRange(engineConfig?.rendering?.terrainShader);
        this.water = null;
        this._geometry = null;
        this._material = null;
        this._lakes = [];
        this._listedAt = null;
        this._listedVersion = -1;
    }

    /** WaterGpuData (or null). */
    setWaterData(water) {
        this.water = water || null;
        this._listedAt = null;
    }

    _ensure() {
        if (this._material) return;
        const B = WATER_BINDINGS, VF = 'vertex|fragment';
        this._material = new Material({
            name: 'NearWaterSurface',
            vertexShader: buildNearWaterVertexShader(),
            fragmentShader: buildNearWaterFragmentShader(),
            uniforms: {
                nearWaterUniforms: { value: new Float32Array(NEAR_WATER_UNIFORM_FLOATS) },
                waterParams: { value: null },
                waterLakeMasks: { value: null },
                transmittanceLUT: { value: null },
            },
            vertexLayout: [],
            side: 'double',
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: 'premultiplied',
            bindGroupLayoutSpec: [
                {
                    label: 'NearWater-Uniforms',
                    entries: [{ binding: 0, visibility: VF, name: 'nearWaterUniforms', buffer: { type: 'uniform' } }],
                },
                {
                    label: 'NearWater-Water',
                    entries: [
                        { binding: B.index, visibility: VF, name: 'waterIndex', buffer: { type: 'read-only-storage' } },
                        { binding: B.lakes, visibility: VF, name: 'waterLakes', buffer: { type: 'read-only-storage' } },
                        { binding: B.masks, visibility: VF, name: 'waterLakeMasks', texture: { sampleType: 'float', viewDimension: '2d-array' } },
                        { binding: B.params, visibility: VF, name: 'waterParams', buffer: { type: 'uniform' } },
                        { binding: B.rivers, visibility: VF, name: 'waterRivers', buffer: { type: 'read-only-storage' } },
                        { binding: NEAR_WATER_SAMPLER_BINDING, visibility: VF, name: 'nearWaterSampler', sampler: { type: 'filtering' } },
                        { binding: NEAR_WATER_TRANSMITTANCE_BINDING, visibility: 'fragment', name: 'transmittanceLUT', texture: { sampleType: 'float', viewDimension: '2d' } },
                    ],
                },
            ],
        });
        this._geometry = new Geometry();
        this._geometry.setIndex(gridIndices(GRID_N, GRID_N));
    }

    render(camera, viewMatrix, projectionMatrix) {
        const water = this.water, near = water?.near;
        // Debug views (qtDiag.water.tint) are the terrain shading's alone.
        if (!near?.enabled || !water.enabled || !water._ready || water.debugMode !== 0 || !camera?.position) return;
        const o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const cam = camera.position;
        const rel = { x: cam.x - o.x, y: cam.y - o.y, z: cam.z - o.z };
        const range = near.fadeEndM;
        const at = this._listedAt;
        if (!at || water._appliedVersion !== this._listedVersion || Math.hypot(rel.x - at.x, rel.y - at.y, rel.z - at.z) > RELIST_M) {
            this._lakes = water.lakesNear(rel, range + RELIST_M, NEAR_WATER_MAX_LAKES);
            this._listedAt = rel;
            this._listedVersion = water._appliedVersion;
        }
        if (!this._lakes.length) return;
        this._ensure();

        const u = this._material.uniforms.nearWaterUniforms.value;
        u.set(viewMatrix.elements ?? viewMatrix, 0);
        u.set(projectionMatrix.elements ?? projectionMatrix, 16);
        const g = this.uniformManager?.uniforms ?? {};
        const apOn = numOf(g.aerialPerspectiveEnabled?.value, this.planetConfig?.hasAtmosphere ? 1 : 0);
        u.set([o.x, o.y, o.z, water.R, cam.x, cam.y, cam.z, range * 1.05,
            GRID_N, apOn > 0.5 ? 1 : 0, 0, 0], 32);
        u.fill(0, 44, 60);
        u.set(this._lakes, 44);
        // Lighting and atmosphere: the values and defaults the terrain shading
        // gets (webgpuBackend.js terrain fragment uniforms).
        u.set([...vec3Of(g.sunLightDirection?.value, [0, 1, 0]), numOf(g.sunLightIntensity?.value, 1),
            ...vec3Of(g.sunLightColor?.value, [1, 1, 1]), numOf(g.ambientLightIntensity?.value, 0.8),
            ...vec3Of(g.ambientLightColor?.value, [0.3, 0.3, 0.4]), numOf(g.atmospherePlanetRadius?.value, 50000),
            ...vec3Of(g.atmosphereRayleighScattering?.value, [5.5e-5, 13.0e-5, 22.4e-5]), numOf(g.atmosphereMieScattering?.value, 21e-5),
            numOf(g.atmosphereRadius?.value, 60000), numOf(g.atmosphereScaleHeightRayleigh?.value, 800),
            numOf(g.atmosphereScaleHeightMie?.value, 120), numOf(g.atmosphereMieAnisotropy?.value, 0.8),
            ...vec3Of(g.fogColor?.value, [0.7, 0.8, 1.0]), numOf(g.fogDensity?.value, 0.00005),
            numOf(g.atmosphereSunIntensity?.value, 20), this.apFade.start, this.apFade.end, 0], 60);
        this._material.uniforms.transmittanceLUT.value = g.transmittanceLUT?.value ?? null;
        const res = water.resources;
        this._material.storageBuffers = { waterIndex: res.index, waterLakes: res.lakes, waterRivers: res.rivers };
        const params = this._material.uniforms.waterParams;
        if (params.value?.buffer !== water.paramsData) params.value = new Float32Array(water.paramsData);
        this._material.uniforms.waterLakeMasks.value = res.masks;
        this._geometry.instanceCount = this._lakes.length;
        this.backend.draw(this._geometry, this._material);
    }

    dispose() {
        this._geometry?.dispose?.();
        this._material?.dispose?.();
        this._geometry = null;
        this._material = null;
    }
}
