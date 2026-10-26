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
// Farther away the terrain shader draws the water. Near geometry uses the
// existing water colour and surface terms; it fades to that terrain shading
// over the handover range. Depth test on, no depth write, drawn after opaque
// meshes. Binds WaterGpuData and the terrain's lighting/atmosphere uniforms.


import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { WATER_BINDINGS, WATER_DEBUG_DRY } from '../../world/water/waterWgsl.js';
import { buildRiverRibbons } from '../../world/water/riverRibbon.js';
import { gridIndices } from './waterGrid.js';
import { fillNearWaterUniforms } from './nearWaterUniforms.js';
import { aerialFadeRange } from '../terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import {
    NEAR_RIVER_POINTS_BINDING, NEAR_RIVER_QUADS_BINDING,
    NEAR_WATER_MAX_LAKES, NEAR_WATER_SAMPLER_BINDING, NEAR_WATER_TRANSMITTANCE_BINDING, NEAR_WATER_SCENE_DEPTH_BINDING, NEAR_WATER_UNIFORM_FLOATS,
    buildNearRiverFragmentShader, buildNearRiverVertexShader, buildNearWaterFragmentShader, buildNearWaterVertexShader,
} from './nearWaterSurface.wgsl.js';

// Grid vertices per side (odd: a row and a column through the camera). At
// 1.6 km range: ~0.7 m apart at the camera, ~70 m at the edge.
const GRID_N = 97;
// Lakes and river stretches are listed again when the camera has moved this
// far (m), and this much beyond the range.
const RELIST_M = 10;


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

    _material(name,vs,fs,groups=[]) { return createNearWaterMaterial(name,vs,fs,this._uniforms,groups); }

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
            shape: C,
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
        // Debug views 1-5 (qtDiag.water.tint) are the terrain shading's alone;
        // in 6 and 7 (who draws the water) these meshes add their colour; the
        // dry view draws no water at all.
        const tintOnly = (water?.debugMode > 0 && water.debugMode < 6) || water?.debugMode === WATER_DEBUG_DRY;
        if (!near?.enabled || !water.enabled || !water._ready || tintOnly || !camera?.position) return;
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

        fillNearWaterUniforms(this._uniforms, {viewMatrix,projectionMatrix,planetConfig:this.planetConfig,
            uniformManager:this.uniformManager,camera,water,lakes:this._lakes,apFade:this.apFade});
        const g=this.uniformManager?.uniforms??{};

        const res = water.resources;
        for (const m of [this._lakeMaterial, this._riverMaterial]) {
            m.storageBuffers = { waterIndex: res.index, waterLakes: res.lakes, waterRivers: res.rivers };
            const params = m.uniforms.waterParams;
            if (params.value?.buffer !== water.paramsData) params.value = new Float32Array(water.paramsData);
            m.uniforms.waterLakeMasks.value = res.masks;
            m.uniforms.transmittanceLUT.value = g.transmittanceLUT?.value ?? null;
            m.uniforms.nearWaterSceneDepth.value = this.backend.getDepthTextureView();
        }
        this.backend.endRenderPassForCompute();
        this.backend.resumeRenderPass({ depthReadOnly: true });
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
        this.backend.endRenderPassForCompute();
        this.backend.resumeRenderPass();
    }

    dispose() {
        for (const x of [this._lakeGeometry, this._lakeMaterial, this._riverGeometry, this._riverMaterial]) x?.dispose?.();
        this._riverBuffers.points?.destroy();
        this._riverBuffers.quads?.destroy();
        this._lakeGeometry = this._lakeMaterial = this._riverGeometry = this._riverMaterial = null;
        this._riverBuffers = { points: null, quads: null };
    }
}

export function createNearWaterMaterial(name, vertexShader, fragmentShader, uniforms, extraGroups = []) {
        const B = WATER_BINDINGS, VF = 'vertex|fragment';
        return new Material({
            name,
            vertexShader,
            fragmentShader,
            uniforms: {
                nearWaterUniforms: { value: uniforms },
                waterParams: { value: null },
                waterLakeMasks: { value: null },
                transmittanceLUT: { value: null },
                nearWaterSceneDepth: { value: null },
            },
            vertexLayout: [],
            side: 'double',
            transparent: true,
            depthTest: true,
            depthCompare: 'always',
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
                        { binding: NEAR_WATER_SCENE_DEPTH_BINDING, visibility: 'fragment', name: 'nearWaterSceneDepth', texture: { sampleType: 'depth', viewDimension: '2d' } },
                    ],
                },
                ...extraGroups,
            ],
        });
    }
