// core/renderer/water/NearWaterRenderer.js
//
// Surface of the lakes and rivers near the camera (WaterGpuData.near), the
// same approach for both: flat water at its level, cut by the ground (the
// terrain's depth hides it where the ground rises above the level, so the
// shoreline is where the water meets the ground at any tile LOD, the owner's
// earlier plane lakes), with the same look. Shaders: nearWaterSurface.wgsl.js.
// - Lakes: one grid mesh drawn once per lake whose solved patch comes within
//   the near range, in one instanced draw.
// - Rivers, and lakes inside the river field's pages: one small grid per
//   field page with water (fieldWaterSurface.wgsl.js), in one instanced draw.
// Farther away the terrain shader draws the water. Near geometry uses the
// existing water colour and surface terms; it fades to that terrain shading
// over the handover range. Depth test on, no depth write, drawn after opaque
// meshes. Binds WaterGpuData and the terrain's lighting/atmosphere uniforms.


import { Material } from '../resources/material.js';
import { Geometry } from '../resources/geometry.js';
import { WATER_BINDINGS, WATER_DEBUG_DRY } from '../../world/water/waterWgsl.js';
import { gridIndices } from './waterGrid.js';
import { buildFieldWaterFragmentShader, buildFieldWaterVertexShader, FIELD_WATER_BINDINGS, FIELD_WATER_GRID } from './fieldWaterSurface.wgsl.js';
import { fillNearWaterUniforms } from './nearWaterUniforms.js';
import { aerialFadeRange } from '../terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import {
    NEAR_WATER_MAX_LAKES, NEAR_WATER_SAMPLER_BINDING, NEAR_WATER_TRANSMITTANCE_BINDING, NEAR_WATER_SCENE_DEPTH_BINDING, NEAR_WATER_UNIFORM_FLOATS,
    buildNearWaterFragmentShader, buildNearWaterVertexShader,
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
        this._lakes = [];
        this._listedAt = null;
        this._listedVersion = -1;
        // River field water (fieldWaterSurface.wgsl.js): pages listed near the camera.
        this._fieldMaterial = null;
        this._fieldGeometry = null;
        this._fieldPages = null;
        this._fieldCount = 0;
        this._fieldVersion = -1;
    }

    /** WaterGpuData (or null). */
    setWaterData(water) {
        this.water = water || null;
        this._listedAt = null;
    }

    _material(name,vs,fs,groups=[]) {
        const extras=[...groups];
        while(extras.length<1)extras.push({label:'NearWater-empty-group2',entries:[]});
        extras.push({label:'NearWater-riverField',entries:[
            {binding:FIELD_WATER_BINDINGS.table,visibility:'vertex|fragment',name:'riverFieldTable',buffer:{type:'read-only-storage'}},
            {binding:FIELD_WATER_BINDINGS.texels,visibility:'vertex|fragment',name:'riverFieldTexels',buffer:{type:'read-only-storage'}},
            {binding:FIELD_WATER_BINDINGS.params,visibility:'vertex|fragment',name:'riverFieldParams',buffer:{type:'uniform'}},
        ]});
        const m=createNearWaterMaterial(name,vs,fs,this._uniforms,extras);m.depthCompare='less-equal';return m;
    }

    _ensure() {
        if (this._lakeMaterial) return;
        this._lakeMaterial = this._material('NearWaterSurface', buildNearWaterVertexShader(), buildNearWaterFragmentShader());
        this._lakeGeometry = new Geometry();
        this._lakeGeometry.setIndex(gridIndices(GRID_N, GRID_N));
        this._fieldMaterial = this._material('NearFieldWater', buildFieldWaterVertexShader(), buildFieldWaterFragmentShader(), [{
            label: 'NearFieldWater-Pages',
            entries: [{ binding: 0, visibility: 'vertex', name: 'fieldWaterPages', buffer: { type: 'read-only-storage' } }],
        }]);
        this._fieldGeometry = new Geometry();
        this._fieldGeometry.setIndex(gridIndices(FIELD_WATER_GRID, FIELD_WATER_GRID));
    }

    // Lakes and field pages within range of the camera (planet-centred).
    _list(rel, range) {
        this._lakes = this.water.lakesNear(rel, range + RELIST_M, NEAR_WATER_MAX_LAKES);
        this._listField(rel, range);
    }

    // Field pages with water within range of the camera (planet-centred): face, pi, pj, slot.
    _listField(rel, range) {
        const f = this.water.riverField, R = this.water.R, l = Math.hypot(rel.x, rel.y, rel.z) || 1;
        if (!f) { this._fieldCount = 0; return; }
        const c = [rel.x / l, rel.y / l, rel.z / l], cosR = Math.cos((range + 100) / R);
        const list = [];
        for (const p of f.wetPages ?? []) if (p.dir[0] * c[0] + p.dir[1] * c[1] + p.dir[2] * c[2] > cosR) list.push(p.face, p.pi, p.pj, p.slot);
        this._fieldCount = list.length / 4;
        this._fieldVersion = f.version;
        if (!this._fieldCount) return;
        const data = new Uint32Array(list), device = this.backend.device;
        if (!this._fieldPages || this._fieldPages.size < data.byteLength) {
            this._fieldPages?.destroy();
            this._fieldPages = device.createBuffer({ label: 'NearFieldWater-pages', size: Math.max(256, 2 ** Math.ceil(Math.log2(data.byteLength))),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        }
        device.queue.writeBuffer(this._fieldPages, 0, data);
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
        if (!at || water._appliedVersion !== this._listedVersion || Math.hypot(rel.x - at.x, rel.y - at.y, rel.z - at.z) > RELIST_M
            || (water.riverField && water.riverField.version !== this._fieldVersion)) {
            this._ensure();
            this._list(rel, range);
            this._listedAt = rel;
            this._listedVersion = water._appliedVersion;
        }
        if (!this._lakes.length && !this._fieldCount) return;

        fillNearWaterUniforms(this._uniforms, {viewMatrix,projectionMatrix,planetConfig:this.planetConfig,
            uniformManager:this.uniformManager,camera,water,lakes:this._lakes,apFade:this.apFade});
        const g=this.uniformManager?.uniforms??{};

        const res = water.resources;
        for (const m of [this._lakeMaterial, this._fieldMaterial]) {
            m.storageBuffers = { waterIndex: res.index, waterLakes: res.lakes, waterRivers: res.rivers };
            if (water.riverField?.resources) {
                m.storageBuffers.riverFieldTable = water.riverField.resources.pages;
                m.storageBuffers.riverFieldTexels = water.riverField.resources.texels;
                m.uniforms.riverFieldParams = { value: water.riverField.paramsData };
            }
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
        if (this._fieldCount) {
            this._fieldMaterial.storageBuffers.fieldWaterPages = this._fieldPages;
            this._fieldGeometry.instanceCount = this._fieldCount;
            this.backend.draw(this._fieldGeometry, this._fieldMaterial);
        }
        this.backend.endRenderPassForCompute();
        this.backend.resumeRenderPass();
    }

    dispose() {
        for (const x of [this._lakeGeometry, this._lakeMaterial, this._fieldGeometry, this._fieldMaterial]) x?.dispose?.();
        this._fieldPages?.destroy(); this._fieldPages = null;
        this._lakeGeometry = this._lakeMaterial = this._fieldGeometry = this._fieldMaterial = null;
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
