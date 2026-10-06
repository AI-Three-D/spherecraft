// core/renderer/water/NearWaterRenderer.js
//
// Surface of the lakes and rivers near the camera (WaterGpuData.near), the
// same approach for both: flat water at its level, cut by the ground (the
// terrain's depth hides it where the ground rises above the level, so the
// shoreline is where the water meets the ground at any tile LOD, the owner's
// earlier plane lakes), with the same look. Shaders: nearWaterSurface.wgsl.js.
// - Lakes: one grid mesh drawn once per lake whose solved patch comes within
//   the near range, in one instanced draw.
// - Rivers: ribbons along the stretches within range (core/world/water/
//   riverRibbon.js), rebuilt on the CPU as the camera moves, in one draw.
// Farther away the terrain shading draws the water (waterWgsl.js
// applyWater), which near the camera keeps only the water's body under
// these surfaces: the bed seen through the water. Transparent
// (premultiplied), depth test on, no depth write; drawn after the opaque
// meshes so objects in the water show through. Binds the WaterGpuData
// buffers, its own copy of the frame's WaterParams, and the lighting and
// atmosphere the terrain shading uses (uniformManager).

import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { WATER_BINDINGS } from '../../world/water/waterWgsl.js';
import { buildRiverRibbons } from '../../world/water/riverRibbon.js';
import { gridIndices } from './WaterSimRenderer.js';
import { aerialFadeRange } from '../terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import {
    NEAR_RIVER_POINTS_BINDING, NEAR_RIVER_QUADS_BINDING,
    NEAR_WATER_MAX_LAKES, NEAR_WATER_SAMPLER_BINDING, NEAR_WATER_TRANSMITTANCE_BINDING, NEAR_WATER_UNIFORM_FLOATS,
    buildNearRiverFragmentShader, buildNearRiverVertexShader, buildNearWaterFragmentShader, buildNearWaterVertexShader,
} from './nearWaterSurface.wgsl.js';

// Grid vertices per side (odd: a row and a column through the camera). At
// 1.6 km range: ~0.7 m apart at the camera, ~70 m at the edge.
const GRID_N = 97;
// Lakes and river stretches are listed again when the camera has moved this
// far (m), and this much beyond the range.
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
        this._uniforms = new Float32Array(NEAR_WATER_UNIFORM_FLOATS);
        this._lakeGeometry = null;
        this._lakeMaterial = null;
        this._riverGeometry = null;
        this._riverMaterial = null;
        this._riverBuffers = { points: null, quads: null };
        this._lakes = [];
        this._quadCount = 0;
        this._listedAt = null;
        this._listedVersion = -1;
    }

    /** WaterGpuData (or null). */
    setWaterData(water) {
        this.water = water || null;
        this._listedAt = null;
    }

    _material(name, vertexShader, fragmentShader, extraGroups = []) {
        const B = WATER_BINDINGS, VF = 'vertex|fragment';
        return new Material({
            name,
            vertexShader,
            fragmentShader,
            uniforms: {
                nearWaterUniforms: { value: this._uniforms },
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
                    label: `${name}-Uniforms`,
                    entries: [{ binding: 0, visibility: VF, name: 'nearWaterUniforms', buffer: { type: 'uniform' } }],
                },
                {
                    label: `${name}-Water`,
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
                ...extraGroups,
            ],
        });
    }

    _ensure() {
        if (this._lakeMaterial) return;
        this._lakeMaterial = this._material('NearWaterSurface', buildNearWaterVertexShader(), buildNearWaterFragmentShader());
        this._lakeGeometry = new Geometry();
        this._lakeGeometry.setIndex(gridIndices(GRID_N, GRID_N));
        this._riverMaterial = this._material('NearRiverSurface', buildNearRiverVertexShader(), buildNearRiverFragmentShader(), [{
            label: 'NearRiverSurface-Ribbons',
            entries: [
                { binding: NEAR_RIVER_POINTS_BINDING, visibility: 'vertex', name: 'ribbonPoints', buffer: { type: 'read-only-storage' } },
                { binding: NEAR_RIVER_QUADS_BINDING, visibility: 'vertex', name: 'ribbonQuads', buffer: { type: 'read-only-storage' } },
            ],
        }]);
        this._riverGeometry = new Geometry();
    }

    // Uploads ribbon data, growing the buffers when needed.
    _upload(name, data) {
        const device = this.backend.device;
        let buf = this._riverBuffers[name];
        if (!buf || buf.size < data.byteLength) {
            buf?.destroy();
            buf = this._riverBuffers[name] = device.createBuffer({
                label: `NearRiver-${name}`, size: Math.max(256, 2 ** Math.ceil(Math.log2(data.byteLength))),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }
        if (data.byteLength) device.queue.writeBuffer(buf, 0, data);
    }

    // Lakes and river stretches within range of the camera (planet-centred).
    _list(rel, range) {
        const water = this.water;
        this._lakes = water.lakesNear(rel, range + RELIST_M, NEAR_WATER_MAX_LAKES);
        const C = water.carve ?? {};
        const rivers = [...water._appliedRivers].filter(([rid]) => water.isRiverDrawn(rid));
        const { points, quads } = buildRiverRibbons({
            rivers, arcOf: (rec) => water._arcLengths(rec), camera: rel, rangeM: range + RELIST_M,
            R: water.R, origin: this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 },
            shape: { widthVar: C.widthVar ?? 0.2, wobble: C.wobble ?? 0.15, bankVar: C.bankVar ?? 0.35 },
            lakeAt: (dir) => water.lakeAt(dir),
        });
        this._quadCount = quads.length;
        if (quads.length) {
            this._upload('points', points);
            this._upload('quads', quads);
        }
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
            this._ensure();
            this._list(rel, range);
            this._listedAt = rel;
            this._listedVersion = water._appliedVersion;
        }
        if (!this._lakes.length && !this._quadCount) return;

        const u = this._uniforms;
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

        const res = water.resources;
        for (const m of [this._lakeMaterial, this._riverMaterial]) {
            m.storageBuffers = { waterIndex: res.index, waterLakes: res.lakes, waterRivers: res.rivers };
            const params = m.uniforms.waterParams;
            if (params.value?.buffer !== water.paramsData) params.value = new Float32Array(water.paramsData);
            m.uniforms.waterLakeMasks.value = res.masks;
            m.uniforms.transmittanceLUT.value = g.transmittanceLUT?.value ?? null;
        }
        if (this._lakes.length) {
            this._lakeGeometry.instanceCount = this._lakes.length;
            this.backend.draw(this._lakeGeometry, this._lakeMaterial);
        }
        if (this._quadCount) {
            this._riverMaterial.storageBuffers.ribbonPoints = this._riverBuffers.points;
            this._riverMaterial.storageBuffers.ribbonQuads = this._riverBuffers.quads;
            this._riverGeometry.setDrawRange(0, this._quadCount * 6);
            this.backend.draw(this._riverGeometry, this._riverMaterial);
        }
    }

    dispose() {
        for (const x of [this._lakeGeometry, this._lakeMaterial, this._riverGeometry, this._riverMaterial]) x?.dispose?.();
        this._riverBuffers.points?.destroy();
        this._riverBuffers.quads?.destroy();
        this._lakeGeometry = this._lakeMaterial = this._riverGeometry = this._riverMaterial = null;
        this._riverBuffers = { points: null, quads: null };
    }
}
