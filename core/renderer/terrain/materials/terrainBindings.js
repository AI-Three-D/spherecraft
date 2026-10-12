// Terrain shader layouts, uniform packing and water bindings belong to the terrain module.
// The generic backend invokes this adapter explicitly through Material.bindingAdapter.
import { gpuFormatSampleType } from '../../resources/texture.js';
import { Logger } from '../../../../shared/Logger.js';
import { requireNumber, requireInt } from '../../../../shared/requireUtil.js';
import { LAKE_PARAMS_FLOATS } from '../../../world/water/waterWgsl.js';

const CHUNK_TEXTURE_NAMES = ['heightTexture', 'normalTexture', 'tileTexture', 'splatDataMap', 'splatIndexMap', 'splatValidMap', 'macroMaskTexture'];
const ATLAS_TEXTURE_NAMES = ['atlasTexture', 'level2AtlasTexture', 'tileTypeLookup', 'macroTileTypeLookup', 'numVariantsTex'];
const scratchByBackend = new WeakMap();
function getScratch(backend) {
    let scratch = scratchByBackend.get(backend);
    if (!scratch) {
        const vertex = new ArrayBuffer(82 * 4), fragment = new ArrayBuffer(512);
        scratch = {
            vertex: { f32: new Float32Array(vertex), i32: new Int32Array(vertex) },
            fragment: { f32: new Float32Array(fragment), i32: new Int32Array(fragment) },
        };
        scratchByBackend.set(backend, scratch);
    }
    return scratch;
}

export const terrainBindingAdapter = {
    cacheKey: 'terrain-v19',
    getCacheKey(material) { return JSON.stringify(material._chunkTextureFormats || {}); },
    createLayouts(backend, material) {
        return createTerrainLayouts.call(backend,
            !!material.defines?.USE_TEXTURE_ARRAYS,
            !!material.defines?.USE_TERRAIN_AO,
            !!material.defines?.USE_GROUND_FIELD,
            !!material.defines?.USE_RESOLVED_COLOR_TEXTURE || !!material.defines?.USE_RESOLVED_COLOR,
            material._chunkTextureFormats || {},
            !!material.defines?.USE_COARSE_COLOR_TEXTURE);
    },
    createBindGroups(backend, material, uniforms, geometry) {
        return createTerrainBindGroups.call(backend, material, uniforms, geometry);
    },
};

function createTerrainLayouts(
    useArrayTextures = false,
    includeTerrainAO = false,
    includeGroundField = false,
    includeResolvedColor = false,
    chunkFormats = {},
    includeCoarseColor = false
) {
    const layouts = [];
    const chunkViewDimension = useArrayTextures ? '2d-array' : '2d';

    // Slot → texture type mapping (fixed order, matches shader bindings)
// Slot → texture type mapping (fixed order, matches shader bindings)
const slotSampleType = (type) =>
    gpuFormatSampleType(chunkFormats[type] || 'rgba32float');

    // Group 0 — uniforms
    layouts.push(this.device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX,                          buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
        ]
    }));

    // Group 1 — chunk data textures. Every slot derives its sampleType
    // from the actual format, so when any slot moves to a filterable
    // format, it gets sampleType:'float' automatically.
    const group1Entries = [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('height'),     viewDimension: chunkViewDimension } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('normal'),     viewDimension: chunkViewDimension } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('tile'),       viewDimension: chunkViewDimension } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('splatData'),  viewDimension: chunkViewDimension } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('splatIndex'), viewDimension: chunkViewDimension } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('splatValid'), viewDimension: chunkViewDimension } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('macro'),      viewDimension: chunkViewDimension } },
    ];
    if (includeTerrainAO) {
        group1Entries.push({
            binding: 7, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('terrainAO'), viewDimension: chunkViewDimension }
        });
    } else if (includeGroundField) {
        group1Entries.push({
            binding: 7, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('terrainAO'), viewDimension: chunkViewDimension }
        });
    }
    if (includeGroundField) {
        group1Entries.push({
            binding: 8, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('groundField'), viewDimension: chunkViewDimension }
        });
    }
    if (includeResolvedColor) {
        group1Entries.push({
            binding: 9, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('resolvedColor'), viewDimension: chunkViewDimension }
        });
    }
    if (includeCoarseColor) {
        group1Entries.push({
            binding: 10, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('coarseColor'), viewDimension: chunkViewDimension }
        });
    }
    layouts.push(this.device.createBindGroupLayout({ entries: group1Entries }));

    layouts.push(this.device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
            // Clamp-to-edge + trilinear. Used by chunk textures (normal map
            // today) that have their own mip chain. textureSampler at binding 5
            // is repeat-mode for atlas tiling and would wrap across tile edges
            // at mip levels > 0.
            { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ]
    }));

    layouts.push(this.device.createBindGroupLayout({
        label: 'Terrain-Group3-Storage-Atmo-Lights-Shadows',
        entries: [
            { binding: 0,  visibility: GPUShaderStage.VERTEX,   buffer:  { type: 'read-only-storage' } },
            { binding: 7,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 8,  visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 2,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 3,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 4,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
            { binding: 5,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 6,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 9,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
            { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
            // Water (core/world/water/waterWgsl.js WATER_BINDINGS).
            { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 13, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 15, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
            { binding: 16, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
        ]
    }));

    Logger.info(`[WebGPU] Terrain bind group layouts created: count=${layouts.length} chunkFormats=${JSON.stringify(chunkFormats)}`);
    return layouts;
}
function createTerrainBindGroups(material, uniforms, geometry) {
        const groups = [];
        const materialCache = this._getMaterialBindGroupCache(material);
        const geometryCache = this._getGeometryBindGroupCache(geometry);
        const needArray = !!material.defines?.USE_TEXTURE_ARRAYS;
        const ensureView = (tex, dimension) => {
        if (tex && tex._gpuTexture) {
                const depth = tex.depth || tex._gpuTexture.texture?.depthOrArrayLayers || 1;
                const isArray = depth > 1 || tex._isArray;
            if (dimension === '2d-array' && !isArray) {
                return null;
            }
                const wantDimension = dimension || (needArray && isArray ? '2d-array' : '2d');
                const viewKey = `_view_${wantDimension}`;
            if (!tex._gpuTexture[viewKey]) {
                try {
                        const viewDesc = { dimension: wantDimension };
                    if (wantDimension === '2d' && isArray) {
                        viewDesc.baseArrayLayer = 0;
                        viewDesc.arrayLayerCount = 1;
                    }
                    tex._gpuTexture[viewKey] = tex._gpuTexture.texture.createView(viewDesc);
                } catch { /* ignore cleanup failure */ }
            }
            if (tex._gpuTexture[viewKey]) return tex._gpuTexture[viewKey];
        }
        return null;
    };
        const getView = (name, dimension) => {
            const tex = uniforms[name]?.value;
            const view = ensureView(tex, dimension);
        if (view) return view;
        if (dimension === '2d-array') return this._getOrCreateDummyArrayTextureView();
        return this._getOrCreateDummyTextureView();
    };

        const vertKey = `vert_${material.id}`;
        const fragKey = `frag_${material.id}`;
        const vertU = this._getOrCreateUniformBuffer(vertKey, packVertexUniforms.call(this, uniforms), material);
        const fragU = this._getOrCreateUniformBuffer(fragKey, packFragmentUniforms.call(this, uniforms), material);

    let g0Record = materialCache.get('terrain_g0');
    if (!g0Record || g0Record.vert !== vertU || g0Record.frag !== fragU) {
            const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[0],
            entries: [
        { binding: 0, resource: { buffer: vertU } },
        { binding: 1, resource: { buffer: fragU } }
                ]
            });
        g0Record = { group, vert: vertU, frag: fragU };
        materialCache.set('terrain_g0', g0Record);
    }


    
    groups.push(g0Record.group);

        const chunkTextureBindings = CHUNK_TEXTURE_NAMES.map((name, index) => ({ name, binding: index }));
        if (material.defines?.USE_TERRAIN_AO || material.defines?.USE_GROUND_FIELD) {
            chunkTextureBindings.push({ name: 'terrainAOMask', binding: 7 });
        }
        if (material.defines?.USE_GROUND_FIELD) {
            chunkTextureBindings.push({ name: 'groundFieldMask', binding: 8 });
        }
        if (material.defines?.USE_RESOLVED_COLOR_TEXTURE || material.defines?.USE_RESOLVED_COLOR) {
            chunkTextureBindings.push({ name: 'resolvedColorTexture', binding: 9 });
        }
        if (material.defines?.USE_COARSE_COLOR_TEXTURE) {
            chunkTextureBindings.push({ name: 'coarseColorTexture', binding: 10 });
        }
        const chunkTextureNames = chunkTextureBindings.map(entry => entry.name);
        const g1Key = this._buildTextureKey(uniforms, chunkTextureNames);
        const g1CacheKey = `terrain_g1_${needArray ? 'arr' : '2d'}_${g1Key}`;
        const g1ViewDimension = needArray ? '2d-array' : '2d';
        const g1Views = chunkTextureNames.map(name => getView(name, g1ViewDimension));
    let g1Record = geometryCache.get(g1CacheKey);
        const g1ViewsChanged = g1Record?.views?.some((view, idx) => view !== g1Views[idx]);
        const g1PipelineChanged = g1Record?.pipeline !== material._gpuPipeline;

    if (!g1Record || g1Record.key !== g1Key || g1ViewsChanged || g1PipelineChanged) {
            const entries = g1Views.map((view, i) => ({
                binding: chunkTextureBindings[i].binding,
                resource: view
            }));
            const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[1],
            entries
            });
        g1Record = { group, key: g1Key, views: g1Views, pipeline: material._gpuPipeline };
        geometryCache.set(g1CacheKey, g1Record);
    }
    groups.push(g1Record.group);

        const g2Key = this._buildTextureKey(uniforms, ATLAS_TEXTURE_NAMES);
        const g2CacheKey = `terrain_g2_${needArray ? 'arr' : '2d'}_${g2Key}`;
    let g2Record = materialCache.get(g2CacheKey);
    const g2Views = [
        getView('atlasTexture',       '2d-array'),   // ← was '2d'
        getView('level2AtlasTexture', '2d-array'),   // ← was '2d'
        getView('tileTypeLookup',     '2d'),
        getView('macroTileTypeLookup','2d'),
        getView('numVariantsTex',     '2d'),
    ];
    const blendModeView = getView('blendModeTable', '2d');

    const g2ViewsChanged = g2Record?.views?.some((view, idx) => view !== g2Views[idx]);
    if (!g2Record || g2ViewsChanged) {
        const entries = [
            { binding: 0, resource: g2Views[0] },
            { binding: 1, resource: g2Views[1] },
            { binding: 2, resource: g2Views[2] },
            { binding: 3, resource: g2Views[3] },
            { binding: 4, resource: g2Views[4] },
            { binding: 5, resource: this._samplerCache.get('linear-repeat') },
            { binding: 6, resource: this._samplerCache.get('nearest') },
            { binding: 7, resource: blendModeView },
            { binding: 8, resource: this._samplerCache.get('linear') },  // ← clamp, trilinear
        ];
        const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[2],
            entries
        });
        g2Record = { group, key: g2Key, views: g2Views };
        materialCache.set(g2CacheKey, g2Record);
    }
    groups.push(g2Record.group);
    
    const storageHandle = material.storageBuffers?.chunkInstances;
    const storageBuffer = storageHandle?.gpuBuffer || storageHandle || this._getOrCreateDummyStorageBuffer();
    const g3Key = this._buildTextureKey(uniforms, ['transmittanceLUT']);
    const g3View = getView('transmittanceLUT', '2d');

    // Get cluster buffers (or dummies)
    const clusterBuffers = uniforms._clusterBuffers?.value;
    const dummyStorage = this._getOrCreateDummyStorageBuffer();
    const dummyUniform = this._getOrCreateUniformBuffer('_cluster_params_dummy', new Float32Array(16));

    const lightBuf   = clusterBuffers?.lightBuffer      || dummyStorage;
    const clusterBuf = clusterBuffers?.clusterBuffer    || dummyStorage;
    const indexBuf   = clusterBuffers?.lightIndexBuffer || dummyStorage;
    const paramBuf   = clusterBuffers?.paramBuffer      || dummyUniform;


    // Shadow resources
    const shadowRenderer = uniforms._shadowRenderer?.value;
    const dummyDepthView = this._getOrCreateDummyDepthTextureView();
    const shadowCascade0 = shadowRenderer?.getShadowDepthView(0) || dummyDepthView;
    const shadowCascade1 = shadowRenderer?.getShadowDepthView(1) || dummyDepthView;
    const shadowCascade2 = shadowRenderer?.getShadowDepthView(2) || dummyDepthView;
    const shadowSampler = shadowRenderer?.getComparisonSampler() ||
        this._samplerCache.get('shadow-comparison') ||
        this._getOrCreateDefaultComparisonSampler();
    const shadowUniformBuf = shadowRenderer?.getCascadeUniformBuffer() || dummyUniform;

    const clusterKey = clusterBuffers ? 'real' : 'dummy';

    // Water (WaterGpuData resources, or dummies: params all zero = off).
    const water = uniforms._waterData?.value?.resources || null;
    const waterIndexBuf = water?.index || dummyStorage;
    const waterLakesBuf = water?.lakes || dummyStorage;
    const waterRiversBuf = water?.rivers || dummyStorage;
    const waterMasksView = water?.masks || this._getOrCreateDummyArrayTextureView();
    const waterParamsBuf = water?.params || this._getOrCreateUniformBuffer('_water_params_dummy', new Float32Array(LAKE_PARAMS_FLOATS));

    // Build cache key including shadow state
    const shadowKey = shadowRenderer ? 'shadow' : 'noshadow';
    const g3CacheKey = `terrain_g3_${needArray ? 'arr' : '2d'}_${g3Key}_${clusterKey}_${shadowKey}_${water ? 'water' : 'nowater'}`;

    let g3Record = materialCache.get(g3CacheKey);
    const g3PipelineChanged = g3Record?.pipeline !== material._gpuPipeline;
    const g3ViewChanged = g3Record?.view !== g3View;
    const g3BufferChanged = g3Record?.buffer !== storageBuffer;
    const g3WaterChanged = g3Record?.waterIndex !== waterIndexBuf || g3Record?.waterLakes !== waterLakesBuf
        || g3Record?.waterMasks !== waterMasksView || g3Record?.waterParams !== waterParamsBuf
        || g3Record?.waterRivers !== waterRiversBuf;

    if (!g3Record || g3ViewChanged || g3BufferChanged || g3PipelineChanged || g3WaterChanged) {
        const entries = [
            { binding: 0, resource: { buffer: storageBuffer } },
            { binding: 7, resource: g3View },
            { binding: 8, resource: this._samplerCache.get('linear') },
            { binding: 1, resource: { buffer: lightBuf } },
            { binding: 2, resource: { buffer: clusterBuf } },
            { binding: 3, resource: { buffer: indexBuf } },
            { binding: 4, resource: { buffer: paramBuf } },
            // Shadow entries
            { binding: 5,  resource: shadowCascade0 },
            { binding: 6,  resource: shadowCascade1 },
            { binding: 9,  resource: shadowCascade2 },
            { binding: 10, resource: shadowSampler },
            { binding: 11, resource: { buffer: shadowUniformBuf } },
            { binding: 12, resource: { buffer: waterIndexBuf } },
            { binding: 13, resource: { buffer: waterLakesBuf } },
            { binding: 14, resource: waterMasksView },
            { binding: 15, resource: { buffer: waterParamsBuf } },
            { binding: 16, resource: { buffer: waterRiversBuf } },
        ];
        const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[3],
            entries
        });
        g3Record = {
            group,
            key: g3Key,
            view: g3View,
            buffer: storageBuffer,
            pipeline: material._gpuPipeline,
            waterIndex:waterIndexBuf,waterLakes:waterLakesBuf,waterMasks:waterMasksView,
            waterParams:waterParamsBuf,waterRivers:waterRiversBuf,
        };
        materialCache.set(g3CacheKey, g3Record);
    }
    groups.push(g3Record.group);
    return groups;
}
function packVertexUniforms(uniforms) {
    // Fixed-size packing for terrain uniforms (80 floats / 320 bytes), including useInstancing slot
        const data = getScratch(this).vertex.f32;
        const intView = getScratch(this).vertex.i32;
    let offset = 0;

        const writeMat = (m) => {
    if (m && m.elements) {
        data.set(m.elements, offset);
    } else {
        data.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], offset);
    }
    offset += 16;
        };

    writeMat(uniforms.modelMatrix?.value);
    writeMat(uniforms.viewMatrix?.value);
    writeMat(uniforms.projectionMatrix?.value);

    data[offset++] = uniforms.chunkOffset?.value?.x || 0;
    data[offset++] = uniforms.chunkOffset?.value?.y || 0;
    data[offset++] = uniforms.chunkSize?.value || 128;
    data[offset++] = uniforms.macroScale?.value || 0.25;

    data[offset++] = uniforms.planetRadius?.value || 50000;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;

        const origin = uniforms.planetOrigin?.value;
    data[offset++] = origin?.x || 0;
    data[offset++] = origin?.y || 0;
    data[offset++] = origin?.z || 0;
    data[offset++] = 0;

    intView[offset] = (uniforms.chunkFace?.value ?? -1);
    offset++;
    data[offset++] = 0;
    data[offset++] = uniforms.chunkLocation?.value?.x || 0;
    data[offset++] = uniforms.chunkLocation?.value?.y || 0;
    data[offset++] = uniforms.chunkSizeUV?.value || 0.0625;

    data[offset++] = uniforms.useAtlasMode?.value || 0;
    data[offset++] = uniforms.atlasUVOffset?.value?.x || 0;
    data[offset++] = uniforms.atlasUVOffset?.value?.y || 0;
    data[offset++] = uniforms.atlasUVScale?.value || 1.0;
    data[offset++] = uniforms.useInstancing?.value || 0;

    data[offset++] = requireNumber(uniforms.heightScale?.value, 'uniforms.heightScale');
        const atlasSizeVal = uniforms.atlasTextureSize?.value;
    data[offset++] = typeof atlasSizeVal === 'object' ? (atlasSizeVal?.x || atlasSizeVal?.width || 129) : (atlasSizeVal || 129);
    data[offset++] = requireInt(uniforms.chunksPerFace?.value, 'uniforms.chunksPerFace', 1);
    data[offset++] = 0; // _pad5

    // geometryLOD, lodMorph fields (offsets 74-77)
    intView[offset] = uniforms.geometryLOD?.value ?? 0;
    offset++;
    data[offset++] = uniforms.lodMorphStart?.value ?? 0.7;
    data[offset++] = uniforms.lodMorphEnd?.value ?? 0.9;
    data[offset++] = 0; // _padMorph

    // cameraPosition + pad (offsets 78-81)
        const camPos = uniforms.cameraPosition?.value;
    data[offset++] = camPos?.x ?? 0;
    data[offset++] = camPos?.y ?? 0;
    data[offset++] = camPos?.z ?? 0;
    data[offset++] = 0; // _pad6

    return data;
}
function packFragmentUniforms(uniforms) {
        const f32 = getScratch(this).fragment.f32;
        const i32 = getScratch(this).fragment.i32;
    
        const cam = uniforms.cameraPosition?.value;
    f32[0] = cam?.x ?? 0;
    f32[1] = cam?.y ?? 0;
    f32[2] = cam?.z ?? 0;
    f32[3] = uniforms.time?.value ?? 0;

    f32[4] = uniforms.chunkOffset?.value?.x ?? 0;
    f32[5] = uniforms.chunkOffset?.value?.y ?? 0;
    f32[6] = uniforms.chunkWidth?.value ?? uniforms.chunkSize?.value ?? 128;
    f32[7] = uniforms.chunkHeight?.value ?? uniforms.chunkSize?.value ?? 128;
    
        const sunDir = uniforms.sunLightDirection?.value;
    f32[8] = sunDir?.x ?? 0;
    f32[9] = sunDir?.y ?? 1;
    f32[10] = sunDir?.z ?? 0;
    f32[11] = uniforms.sunLightIntensity?.value ?? 1.0; // ADD: Sun intensity
    
        const sunCol = uniforms.sunLightColor?.value;
        f32[12] = sunCol?.r ?? 1;
        f32[13] = sunCol?.g ?? 1;
        f32[14] = sunCol?.b ?? 1;
        f32[15] = uniforms.terrainAODirectStrength?.value ?? 0.55; 
        const amb = uniforms.ambientLightColor?.value;
    f32[16] = amb?.r ?? 0.3;
    f32[17] = amb?.g ?? 0.3;
    f32[18] = amb?.b ?? 0.4;
    f32[19] = uniforms.ambientLightIntensity?.value ?? 0.8; // CHANGE: This should be intensity, not enableSplatLayer

    f32[20] = uniforms.enableSplatLayer?.value ?? 1; // MOVE: enableSplatLayer here
    f32[21] = uniforms.enableMacroLayer?.value ?? 1; // SHIFT: Move everything down
    i32[22] = uniforms.geometryLOD?.value ?? 0;
    i32[23] = uniforms.currentSeason?.value ?? 0;

    i32[24] = uniforms.nextSeason?.value ?? 1;
    f32[25] = uniforms.seasonTransition?.value ?? 0;
    const atlasSize = uniforms.atlasTextureSize?.value;
    f32[26] = typeof atlasSize === 'object'
            ? (atlasSize?.x ?? atlasSize?.width ?? 1024)
            : (atlasSize ?? 1024);
    f32[27] = uniforms.terrainAOStrength?.value ?? 1.0;  
    
        const atlasOffset = uniforms.atlasUVOffset?.value;
    f32[28] = atlasOffset?.x ?? 0;
    f32[29] = atlasOffset?.y ?? 0;
    f32[30] = uniforms.atlasUVScale?.value ?? 1;
    i32[31] = uniforms.useAtlasMode?.value ?? 0;

    f32[32] = uniforms.isFeature?.value ?? 0;
    f32[33] = uniforms.aerialPerspectiveEnabled?.value ?? 1.0;
    f32[34] = uniforms.macroScale?.value ?? 0.25;
    i32[35] = uniforms.macroMaxLOD?.value ?? 0;
    
        const planetCenter = uniforms.planetCenter?.value;
    f32[36] = planetCenter?.x ?? 0;
    f32[37] = planetCenter?.y ?? 0;
    f32[38] = planetCenter?.z ?? 0;
    f32[39] = uniforms.atmospherePlanetRadius?.value ?? 50000;

    f32[40] = uniforms.atmosphereRadius?.value ?? 60000;
    f32[41] = uniforms.atmosphereScaleHeightRayleigh?.value ?? 800;
    f32[42] = uniforms.atmosphereScaleHeightMie?.value ?? 120;
    f32[43] = uniforms.atmosphereMieAnisotropy?.value ?? 0.8;
    
        const rayleigh = uniforms.atmosphereRayleighScattering?.value;
    f32[44] = rayleigh?.x ?? 5.5e-5;
    f32[45] = rayleigh?.y ?? 13.0e-5;
    f32[46] = rayleigh?.z ?? 22.4e-5;
    f32[47] = uniforms.atmosphereMieScattering?.value ?? 21e-5;

    f32[48] = uniforms.atmosphereSunIntensity?.value ?? 20.0;
    f32[49] = uniforms.fogDensity?.value ?? 0.00005;
    f32[50] = uniforms.fogScaleHeight?.value ?? 1200;
    f32[51] = uniforms.level2Blend?.value ?? 0.7;

    const fogCol = uniforms.fogColor?.value;
    f32[52] = fogCol?.r ?? 0.7;
    f32[53] = fogCol?.g ?? 0.8;
    f32[54] = fogCol?.b ?? 1.0;
    f32[55] = uniforms.macroNoiseWeight?.value ?? 0.5;
    i32[56] = uniforms.terrainDebugMode?.value ?? 0;
    i32[57] = uniforms.terrainLayerViewMode?.value ?? 0;
    // Former padding: distance ramp into the solid-color tier (metres).
    // Terrain fragment shader reads these as tierFadeStart/tierFadeEnd; the
    // hover-overlay shader still declares them as unused padding.
    f32[58] = uniforms.tierFadeStart?.value ?? 0.0;
    f32[59] = uniforms.tierFadeEnd?.value ?? 0.0;

    i32[60] = uniforms.terrainHoverFace?.value ?? -1;
    i32[61] = uniforms.terrainHoverFlags?.value ?? 0;
    f32[62] = 0.0;
    f32[63] = 0.0;

    const microRect = uniforms.terrainHoverMicroRect?.value;
    f32[64] = microRect?.x ?? 0.0;
    f32[65] = microRect?.y ?? 0.0;
    f32[66] = microRect?.z ?? 0.0;
    f32[67] = microRect?.w ?? 0.0;

    const macroRect = uniforms.terrainHoverMacroRect?.value;
    f32[68] = macroRect?.x ?? 0.0;
    f32[69] = macroRect?.y ?? 0.0;
    f32[70] = macroRect?.z ?? 0.0;
    f32[71] = macroRect?.w ?? 0.0;

    const microColor = uniforms.terrainHoverMicroColor?.value;
    f32[72] = microColor?.x ?? 1.0;
    f32[73] = microColor?.y ?? 0.42;
    f32[74] = microColor?.z ?? 0.42;
    f32[75] = microColor?.w ?? 1.5;

    const macroColor = uniforms.terrainHoverMacroColor?.value;
    f32[76] = macroColor?.x ?? 0.42;
    f32[77] = macroColor?.y ?? 0.64;
    f32[78] = macroColor?.z ?? 1.0;
    f32[79] = macroColor?.w ?? 2.0;

    return f32;
}
