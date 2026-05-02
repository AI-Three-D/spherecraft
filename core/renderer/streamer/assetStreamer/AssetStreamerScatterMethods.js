export function installAssetStreamerScatterMethods(AssetStreamer, deps = {}) {
    const {
        ASSET_BAKE_REPRESENTATION,
        FAR_TREE_DBG_ENABLED,
        FIELD_LAYER_META_U32_STRIDE,
        Logger,
        buildAssetScatterGroupMaskBakeShader,
        farDbgAs,
        gpuFormatSampleType
    } = deps;

    Object.defineProperties(
        AssetStreamer.prototype,
        Object.getOwnPropertyDescriptors({
        getTreeDetailSystem() {
                return this._treeDetailSystem || null;
            },

        getTreeTemplateLibrary() {
                return this._templateLibrary || null;
            },

        _buildScatterGroups() {
                const runtimeDefs = [...this.SCATTER_DENSITY_GROUPS]
                    .sort((a, b) => b.minDensity - a.minDensity)
                    .map((def) => ({
                        key: `runtime-${def.name}`,
                        name: def.name,
                        label: def.name,
                        mode: 'runtime',
                        minDensity: def.minDensity,
                        variantIndices: [],
                        variantIndexSet: new Set(),
                        archetypeIndexSet: new Set(),
                        maxDensity: 0.000001,
                        tileMapKey: `scatter-group-${def.name}`,
                    }));
                const runtimeDefsByName = new Map(runtimeDefs.map((group) => [group.name, group]));

                const policyDefs = (Array.isArray(this.SCATTER_POLICY_GROUPS) ? this.SCATTER_POLICY_GROUPS : [])
                    .map((def) => {
                        const archetypeName = def?.archetypeName;
                        const archetype = archetypeName
                            ? this._assetRegistry.getArchetype?.(archetypeName)
                            : null;
                        if (!archetype?.isActive) return null;
                        return {
                            key: `policy-${archetype.name}`,
                            name: def.name || `${archetype.name}-runtime`,
                            label: def.name || `${archetype.name}-runtime`,
                            mode: 'policy-runtime',
                            maskArchetypeName: archetype.name,
                            maskArchetypeIndex: archetype.index,
                            runtimeHoldDistance: Number.isFinite(def.runtimeHoldDistance)
                                ? Math.max(0, def.runtimeHoldDistance)
                                : null,
                            runtimeHoldScale: Number.isFinite(def.runtimeHoldScale)
                                ? Math.max(1.0, def.runtimeHoldScale)
                                : 1.0,
                            minDensity: 0.0,
                            variantIndices: [],
                            variantIndexSet: new Set(),
                            archetypeIndexSet: new Set([archetype.index]),
                            maxDensity: 0.000001,
                            maxScatterTileWorldSize: Number.isFinite(def.maxScatterTileWorldSize)
                                ? Math.max(8, def.maxScatterTileWorldSize)
                                : null,
                            scatterCellOversample: Number.isFinite(def.scatterCellOversample)
                                ? Math.max(1, Math.floor(def.scatterCellOversample))
                                : null,
                            tileMapKey: `scatter-group-policy-${archetype.name}`,
                        };
                    })
                    .filter(Boolean);
                const policyDefsByArchetype = new Map(
                    policyDefs.map((group) => [group.maskArchetypeName, group])
                );

                const fieldChannels = Array.isArray(this.GROUND_FIELD_BAKE_CONFIG.channels)
                    ? this.GROUND_FIELD_BAKE_CONFIG.channels
                    : [];
                const fieldDefs = fieldChannels
                    .map((channel, channelIndex) => {
                        const archetypeName = channel?.archetypeName;
                        const archetype = archetypeName
                            ? this._assetRegistry.getArchetype?.(archetypeName)
                            : null;
                        if (!archetype?.isActive) return null;
                        return {
                            key: `field-${archetype.name}`,
                            name: `${channel.name || archetype.name}-field`,
                            label: `${channel.name || archetype.name}-field`,
                            mode: 'field',
                            fieldArchetypeName: archetype.name,
                            fieldArchetypeIndex: archetype.index,
                            fieldChannelIndex: channelIndex,
                            maskArchetypeName: archetype.name,
                            maskArchetypeIndex: archetype.index,
                            runtimeHoldDistance: Number.isFinite(channel.runtimeHoldDistance)
                                ? Math.max(0, channel.runtimeHoldDistance)
                                : null,
                            runtimeHoldScale: Number.isFinite(channel.runtimeHoldScale)
                                ? Math.max(1.0, channel.runtimeHoldScale)
                                : 1.0,
                            fieldDensityScale: Number.isFinite(channel.scatterDensityScale)
                                ? Math.max(0.0, channel.scatterDensityScale)
                                : 1.0,
                            minDensity: 0.0,
                            variantIndices: [],
                            variantIndexSet: new Set(),
                            archetypeIndexSet: new Set([archetype.index]),
                            maxDensity: 0.000001,
                            maxScatterDistance: 0.0,
                            tileMapKey: `scatter-group-field-${archetype.name}`,
                        };
                    })
                    .filter(Boolean);
                const fieldDefsByArchetype = new Map(
                    fieldDefs.map((group) => [group.fieldArchetypeName, group])
                );

                for (const variant of this._assetRegistry.getAllVariants()) {
                    if (!variant?.archetype?.isActive) continue;
                    if (variant.archetype.index === 0) continue;

                    const fieldGroup = fieldDefsByArchetype.get(variant.archetype.name) || null;
                    let group = fieldGroup;

                    if (!group) {
                        group = policyDefsByArchetype.get(variant.archetype.name) || null;
                    }

                    if (!group) {
                        const explicitGroup = variant.scatterGroupName || variant.family?.scatterGroup || null;
                        if (explicitGroup) {
                            group = runtimeDefsByName.get(explicitGroup) || null;
                        }
                        if (!group) {
                            const density = Math.max(0, ...(variant.densities ?? [0]));
                            group = runtimeDefs.find(def => density >= def.minDensity)
                                ?? runtimeDefs[runtimeDefs.length - 1];
                        }
                    }

                    group.variantIndices.push(variant.index);
                    group.variantIndexSet.add(variant.index);
                    group.archetypeIndexSet.add(variant.archetype.index);
                    const variantMaxDensity = Math.max(0.000001, ...(variant.densities ?? [0.000001]));
                    const variantMaxDistance = Math.max(0.0, ...(variant.lodDistances ?? [0.0]));
                    group.maxDensity = Math.max(group.maxDensity, variantMaxDensity);
                    if (group.mode === 'field') {
                        group.maxScatterDistance = Math.max(group.maxScatterDistance ?? 0.0, variantMaxDistance);
                    }
                }

                const groups = [...fieldDefs, ...policyDefs, ...runtimeDefs]
                    .filter(group => group.variantIndices.length > 0)
                    .map((group, index) => ({
                        ...group,
                        id: index,
                        bit: 1 << index,
                    }));

                return groups;
            },

        _buildScatterTileMapDescriptors() {
                const descriptors = [{
                    key: this._scatterTreeTileMapKey,
                    includeVariant: (variant) => variant?.archetype?.index === 0
                }];

                if (this.GROUND_PROP_BAKE_CONFIG.enabled) {
                    descriptors.push({
                        key: this._groundPropTileMapKey,
                        includeVariant: (variant) => this._isBakedGroundPropVariant(variant),
                    });
                }

                if (!this._enableScatterDensityGroups) {
                    return descriptors;
                }

                for (const group of this._scatterGroups) {
                    descriptors.push({
                        key: group.tileMapKey,
                        includeVariant: (variant) => group.variantIndexSet.has(variant.index)
                    });
                }

                return descriptors;
            },

        _isBakedGroundPropVariant(variant) {
                if (!variant?.archetype?.isActive) return false;
                if (variant.archetype.index === 0) return false;
                return true;
            },

        _getMaxVariantDistance(includeVariant, fallback = 0.0) {
                let maxDistance = Number.isFinite(fallback) ? fallback : 0.0;
                for (const variant of this._assetRegistry?.getAllVariants?.() ?? []) {
                    if (!variant || !includeVariant?.(variant)) continue;
                    const variantDistance = Math.max(0.0, ...(variant.lodDistances ?? [0.0]));
                    maxDistance = Math.max(maxDistance, variantDistance);
                }
                return maxDistance;
            },

        _createScatterGroupMaskResources() {
                const tilePoolSize = Math.max(1, this.tileStreamer?.tilePoolSize ?? 1);
                let defaultGroupMask = 0;

                if (this._usesLegacyScatterPath() && this._enableScatterEligibilityGate) {
                    const tileTypeMaskData = new Uint32Array(this._densityLutTileCount);

                    for (const group of this._scatterGroups) {
                        defaultGroupMask |= group.bit;
                        for (const variantIndex of group.variantIndices) {
                            const variant = this._assetRegistry.getVariantByIndex(variantIndex);
                            if (!variant) continue;
                            let tileTypes = variant.tileTypes;
                            if ((!tileTypes || tileTypes.length === 0) && variant.family?.tileTypes) {
                                tileTypes = variant.family.tileTypes;
                            }
                            if (!tileTypes || tileTypes.length === 0) continue;
                            for (const tileType of tileTypes) {
                                if (tileType >= 0 && tileType < tileTypeMaskData.length) {
                                    tileTypeMaskData[tileType] |= group.bit;
                                }
                            }
                        }
                    }

                    this._tileTypeScatterGroupMaskBuffer = this.device.createBuffer({
                        label: 'Asset-ScatterGroupTileTypeMask',
                        size: Math.max(256, tileTypeMaskData.byteLength),
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                    });
                    this.device.queue.writeBuffer(this._tileTypeScatterGroupMaskBuffer, 0, tileTypeMaskData);
                }

                if (defaultGroupMask === 0) {
                    defaultGroupMask = 0xFFFFFFFF;
                }
                this._scatterGroupDefaultMask = defaultGroupMask >>> 0;
                this._scatterGroupPolicyMasksCPU = new Uint32Array(tilePoolSize).fill(this._scatterGroupDefaultMask);
                this._fieldRenderMasksCPU = new Uint32Array(tilePoolSize);
                this._fieldActiveLayersCPU = new Uint32Array(tilePoolSize);
                this._fieldLayerMetaCPU = new Uint32Array(tilePoolSize * FIELD_LAYER_META_U32_STRIDE);

                this._fieldRenderMaskBuffer = this.device.createBuffer({
                    label: 'Asset-FieldRenderMask',
                    size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(
                    this._fieldRenderMaskBuffer,
                    0,
                    this._fieldRenderMasksCPU
                );

                this._fieldActiveLayerBuffer = this.device.createBuffer({
                    label: 'Asset-FieldActiveLayers',
                    size: Math.max(256, this._fieldActiveLayersCPU.byteLength),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(
                    this._fieldActiveLayerBuffer,
                    0,
                    this._fieldActiveLayersCPU
                );

                this._fieldLayerMetaBuffer = this.device.createBuffer({
                    label: 'Asset-FieldLayerMeta',
                    size: Math.max(256, this._fieldLayerMetaCPU.byteLength),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(
                    this._fieldLayerMetaBuffer,
                    0,
                    this._fieldLayerMetaCPU
                );

                if (!this._usesLegacyScatterPath() || !this._enableScatterEligibilityGate) {
                    return;
                }

                this._scatterGroupMaskBuffer = this.device.createBuffer({
                    label: 'Asset-ScatterGroupLayerMask',
                    size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(
                    this._scatterGroupMaskBuffer,
                    0,
                    new Uint32Array(tilePoolSize).fill(defaultGroupMask)
                );

                this._scatterGroupPolicyMaskBuffer = this.device.createBuffer({
                    label: 'Asset-ScatterGroupPolicyMask',
                    size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(
                    this._scatterGroupPolicyMaskBuffer,
                    0,
                    this._scatterGroupPolicyMasksCPU
                );

                this._scatterGroupMaskBakeConfigBuffer = this.device.createBuffer({
                    label: 'Asset-ScatterGroupMaskBakeConfig',
                    size: 256,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });

                this._scatterGroupPendingLayersBuffer = this.device.createBuffer({
                    label: 'Asset-ScatterGroupPendingLayers',
                    size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });

                const module = this.device.createShaderModule({
                    label: 'Asset-ScatterGroupMaskBake',
                    code: buildAssetScatterGroupMaskBakeShader({
                        workgroupSize: this._qualityConfig.scatterWorkgroupSize ?? 64,
                    })
                });

                const tileSampleType = gpuFormatSampleType(
                    this.tileStreamer?.textureFormats?.tile || 'r8unorm'
                );

                this._scatterGroupMaskBakeBindGroupLayout = this.device.createBindGroupLayout({
                    label: 'Asset-ScatterGroupMaskBakeLayout',
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    ]
                });

                this._scatterGroupMaskBakePipeline = this.device.createComputePipeline({
                    label: 'Asset-ScatterGroupMaskBakePipeline',
                    layout: this.device.createPipelineLayout({
                        bindGroupLayouts: [this._scatterGroupMaskBakeBindGroupLayout]
                    }),
                    compute: { module, entryPoint: 'main' }
                });
            },

        _seedScatterGroupPendingLayers() {
                if (!this._usesLegacyScatterPath()) return;
                for (const info of this.tileStreamer?._tileInfo?.values?.() ?? []) {
                    if (info?.layer == null) continue;
                    this._scatterGroupPendingLayers.add(info.layer);
                }
                if (this._scatterGroupPendingLayers.size > 0) {
                    this._forceScatter = true;
                }
            },

        _createScatterDispatchPipeline() {
                const maxVisibleTiles = this.quadtreeGPU.maxVisibleTiles;
            
                const shaderSource = /* wgsl */`
            // Reads the actual visible tile count from the quadtree counter buffer
            // and writes a clamped (count, 1, 1) indirect dispatch argument.
            
            @group(0) @binding(0) var<storage, read>       qtCounters:   array<u32, 4>;
            @group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32, 3>;
            
            @compute @workgroup_size(1)
            fn main() {
                let count = min(qtCounters[2], ${maxVisibleTiles}u);
                dispatchArgs[0] = count;
                dispatchArgs[1] = 1u;
                dispatchArgs[2] = 1u;
            }
            `;
            
                const module = this.device.createShaderModule({
                    label: 'Asset-ScatterDispatch',
                    code: shaderSource,
                });
            
                const bindGroupLayout = this.device.createBindGroupLayout({
                    label: 'Asset-ScatterDispatch-Layout',
                    entries: [
                        {
                            binding:    0,
                            visibility: GPUShaderStage.COMPUTE,
                            buffer:     { type: 'read-only-storage' },
                        },
                        {
                            binding:    1,
                            visibility: GPUShaderStage.COMPUTE,
                            buffer:     { type: 'storage' },
                        },
                    ],
                });
            
                this._scatterDispatchPipeline = this.device.createComputePipeline({
                    label:  'Asset-ScatterDispatch-Pipeline',
                    layout: this.device.createPipelineLayout({
                        bindGroupLayouts: [bindGroupLayout],
                    }),
                    compute: { module, entryPoint: 'main' },
                });
            
                // 12 bytes: 3 × u32 (x, y, z workgroup counts)
                // Needs STORAGE (written by the dispatch shader) and INDIRECT (read by
                // dispatchWorkgroupsIndirect). Initialise to (0, 1, 1) so that if the
                // fill pass hasn't run yet no work is dispatched.
                this._scatterDispatchArgsBuffer = this.device.createBuffer({
                    label: 'Asset-ScatterDispatchArgs',
                    size:  12,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
                });
                const initial = new Uint32Array([0, 1, 1]);
                this.device.queue.writeBuffer(this._scatterDispatchArgsBuffer, 0, initial);
            
                this._scatterDispatchBindGroup = this.device.createBindGroup({
                    label:  'Asset-ScatterDispatch-BG',
                    layout: bindGroupLayout,
                    entries: [
                        {
                            binding:  0,
                            resource: { buffer: this.quadtreeGPU.getCounterBuffer() },
                        },
                        {
                            binding:  1,
                            resource: { buffer: this._scatterDispatchArgsBuffer },
                        },
                    ],
                });
            },

        _verifyTreeBandAlignment() {
                    this._suppressTreeBand0 = false;
            
                    if (!this._branchRenderer?._initialized) return;
            
                    const assets = this._assetRegistry?.getAllAssets?.() || [];
                    const treeAsset = assets.find(a => a.category === 'tree');
                    const lod0 = treeAsset?.lodDistances?.[0];
                    if (!Number.isFinite(lod0)) {
                        this._suppressTreeBand0 = true;
                        Logger.warn(
                            `${this._logTag} Could not read tree lodDistances[0]; ` +
                            `suppressing band 0 scatter draw anyway.`
                        );
                        return;
                    }
            
                    // Single source of truth — no more manually indexing l0/l1/l2.
                    const branchCutoff = this._lodController.getBranchCutoff();
            
                    if (lod0 <= branchCutoff) {
                        this._suppressTreeBand0 = true;
                        Logger.info(
                            `${this._logTag} Tree band 0 (0..${lod0}m) fully covered by ` +
                            `BranchRenderer (0..${branchCutoff}m) — suppressing band 0 scatter draw.`
                        );
                    } else {
                        this._suppressTreeBand0 = true;
                        Logger.warn(
                            `${this._logTag} LOD CONFIG MISMATCH: ` +
                            `tree "${treeAsset.id}" lodDistances[0]=${lod0}m > ` +
                            `BranchRenderer coverage ${branchCutoff}m. ` +
                            `Trees at ${branchCutoff}..${lod0}m will NOT render. ` +
                            `Fix: lower lodDistances[0] or raise TreeLODController.maxBranchDetailLevel.`
                        );
                    }
            
                    const maxClose = this._lodController.maxCloseTrees;
                    const band0Cap = this._pool?.getBandCapacity(this.CAT_TREES * this.LODS_PER_CATEGORY) ?? 0;
                    if (band0Cap > maxClose) {
                        Logger.info(
                            `${this._logTag} Note: band 0 capacity (${band0Cap}) > ` +
                            `maxCloseTrees (${maxClose}). Overflow trees within ` +
                            `${lod0}m would be invisible.`
                        );
                    }
                },

        _getActiveTreeTypes() {
                const treeTypeSet = new Set();
                const assets = this._assetRegistry?.getAllAssets?.() || [];

                for (const asset of assets) {
                    if (asset.category !== 'tree') continue;

                    const geomType = (asset.geometryType || '').toLowerCase();
                    // Map geometry types to template tree types
                    const mapping = {
                        'deciduous': 'birch',
                        'deciduous_broad': 'oak',
                        'deciduous_tall': 'eucalyptus',
                        'palm': 'palm'
                    };
                    const treeType = mapping[geomType] || geomType;
                    if (treeType) treeTypeSet.add(treeType);
                }

                // Always include birch since it's our focus
                if (treeTypeSet.size === 0) {
                    treeTypeSet.add('birch');
                }

                return Array.from(treeTypeSet);
            },

        setLeafRenderingEnabled(enabled) {
                this.enableLeafRendering = enabled !== false;
            },

        setTreeDetailBands(bands = {}) {
                const arr = Array.isArray(bands)
                    ? bands
                    : [bands.l0, bands.l1, bands.l2];
                this._lodController.setDetailBands(arr);

                // Propagate. TreeDetailSystem re-reads on next update (it holds
                // a controller ref). LeafStreamer caches fade distances in its
                // pipeline, so it needs an explicit nudge.
                this._leafStreamer?.setLeafDistanceRange?.(
                    this._lodController.leafFadeStart,
                    this._lodController.leafFadeEnd
                );
            },

        dispose() {
                
                this._treeFarSystem?.dispose();
                this._treeMidSystem?.dispose();
                this._scatterDispatchArgsBuffer?.destroy();
                this._scatterDispatchArgsBuffer = null;
                this._scatterDispatchPipeline   = null;
                this._scatterDispatchBindGroup  = null;
                this._scatterPipelines = [];
                this._fieldScatterPipelines = [];
                this._fieldScatterBindGroupLayout = null;
                this._fieldScatterBindGroupCache = {
                    heightTex: null,
                    tileTex: null,
                    normalTex: null,
                    climateTex: null,
                    fieldTex: null,
                    bindGroups: new Map(),
                };
                this._groundPropBakePipeline = null;
                this._groundPropBakeBindGroupLayout = null;
                this._groundPropBakeBindGroup = null;
                this._groundPropBakeParamBuffer?.destroy();
                this._groundPropBakeTileBuffer?.destroy();
                this._groundPropBakeParamBuffer = null;
                this._groundPropBakeTileBuffer = null;
                this._groundPropBakeBindGroupCache = {
                    heightTex: null,
                    tileTex: null,
                    normalTex: null,
                    climateTex: null,
                    instanceBuffer: null,
                    bindGroup: null,
                };
                this._groundPropGatherPipeline = null;
                this._groundPropGatherBindGroupLayout = null;
                this._groundPropGatherBindGroup = null;
                this._groundPropGatherBindGroupCache = {
                    instanceBuffer: null,
                    activeLayerBuffer: null,
                    layerMetaBuffer: null,
                    counterBuffer: null,
                    bindGroup: null,
                };
                this._treeSourceBakePipeline = null;
                this._treeSourceBakeBindGroupLayout = null;
                this._treeSourceBakeBindGroup = null;
                this._treeSourceBakeParamBuffer?.destroy();
                this._treeSourceBakeTileBuffer?.destroy();
                this._treeSourceBakeParamBuffer = null;
                this._treeSourceBakeTileBuffer = null;
                this._treeSourceBakeBindGroupCache = {
                    heightTex: null,
                    tileTex: null,
                    scatterTex: null,
                    instanceBuffer: null,
                    bindGroup: null,
                };
                this._treeSourceGatherPipeline = null;
                this._treeSourceGatherBindGroupLayout = null;
                this._treeSourceGatherBindGroup = null;
                this._treeSourceGatherBindGroupCache = {
                    instanceBuffer: null,
                    activeLayerBuffer: null,
                    layerMetaBuffer: null,
                    counterBuffer: null,
                    bindGroup: null,
                };
                this._producerDebugPoolReadbackBuffer?.destroy();
                this._producerDebugGroundPropReadbackBuffer?.destroy();
                this._producerDebugPoolReadbackBuffer = null;
                this._producerDebugGroundPropReadbackBuffer = null;
                this._producerDebugQueued = false;
                this._producerDebugPending = false;
                this._producerDebugHasGroundPropSnapshot = false;
                this._scatterGroupMaskBakePipeline = null;
                this._scatterGroupMaskBakeBindGroupLayout = null;
                this._scatterGroupMaskBakeBindGroup = null;
                this._scatterGroupMaskBakeBindGroupCache = { tileTex: null, bindGroup: null };
                this._leafMaskBaker?.dispose();  
                this._aoBaker?.dispose();    
                this._groundFieldBaker?.dispose();
                this._groundPropCache?.dispose();
                this._farTreeSourceCache?.dispose();
                this._treeSourceCache?.dispose();
                this._clusterTreeSystem?.dispose();
                this._pool?.dispose();
                this._treeDetailSystem?.dispose();
                this._branchRenderer?.dispose();
                this._templateLibrary?.dispose();
                this._assetSelectionBuffer?.dispose();
                this._densityLUT?.dispose();    
                this._scatterParamBuffer?.destroy();
                this._climateUniformBuffer?.destroy();
                this._uniformBuffer?.destroy();
                this._fragUniformBuffer?.destroy();
                this._lodIndexCountBuffer?.destroy();
                this._loadedTableParamsBuffer?.destroy();
                this._scatterGroupMaskBuffer?.destroy();
                this._scatterGroupPolicyMaskBuffer?.destroy();
                this._fieldRenderMaskBuffer?.destroy();
                this._fieldActiveLayerBuffer?.destroy();
                this._fieldLayerMetaBuffer?.destroy();
                this._scatterGroupMaskBakeConfigBuffer?.destroy();
                this._scatterGroupPendingLayersBuffer?.destroy();
                this._tileTypeScatterGroupMaskBuffer?.destroy();
                this._dummyStorageBuffer?.destroy();
                this._dummyUniformBuffer?.destroy();
                for (const geo of this._geometries) {
                    geo?.positionBuffer?.destroy();
                    geo?.normalBuffer?.destroy();
                    geo?.uvBuffer?.destroy();
                    geo?.indexBuffer?.destroy();
                }
                this._leafStreamer?.dispose();
                this._scatterGroupPendingLayers.clear();
                this._deferredScatterCommits = [];
                this._scatterGroupPolicyMasksCPU = null;
                this._scatterGroupPolicyMaskBuffer = null;
                this._fieldRenderMasksCPU = null;
                this._fieldRenderMaskBuffer = null;
                this._fieldActiveLayersCPU = null;
                this._fieldLayerMetaCPU = null;
                this._fieldActiveLayerBuffer = null;
                this._fieldLayerMetaBuffer = null;
                this._fieldActiveLayerCount = 0;
                this._scatterGroupActiveBits = 0;
                this._scatterGroupActivityDirty = true;
                this._fieldActiveBits = 0;
                this._fieldActivityDirty = true;
                this._bakedAssetTileCache = null;
                this._assetBakePolicy = null;
                this._groundFieldBaker = null;
                this._groundPropCache = null;
                this._farTreeSourceCache = null;
                this._treeSourceCache = null;
                this._clusterTreeSystem = null;
                this._aoBaker = null;
                this._treeFarSystem = null;
                this._initialized = false;
                
            },

        _dispatchFarTreeBakes(commandEncoder) {
                if (FAR_TREE_DBG_ENABLED) {
                    if (!this._dbg_farDispatchCallCount) this._dbg_farDispatchCallCount = 0;
                    this._dbg_farDispatchCallCount++;
                    const logDispatch = this._dbg_farDispatchCallCount <= 5 || (this._dbg_farDispatchCallCount % 120) === 0;
                    if (logDispatch) {
                        const sc = this._farTreeSourceCache;
                        farDbgAs(
                            `_dispatchFarTreeBakes #${this._dbg_farDispatchCallCount} — ` +
                            `cacheEnabled=${sc?.enabled} ` +
                            `bakePipeline=${!!this._farTreeBakePipeline} bakeBG=${!!this._farTreeBakeBindGroup} ` +
                            `pendingBakes=${sc?.pendingBakes ?? 'N/A'} ` +
                            `allActiveLayers=${sc?.totalActiveLayerCount ?? 'N/A'}`
                        );
                    }
                }
                if (!this._farTreeSourceCache?.enabled) return false;
                if (!this._farTreeBakePipeline || !this._farTreeBakeBindGroup) {
                    if (FAR_TREE_DBG_ENABLED && !this._dbg_farDispatchNoPipelineLogged) {
                        this._dbg_farDispatchNoPipelineLogged = true;
                        farDbgAs(
                            `_dispatchFarTreeBakes: BLOCKED — ` +
                            `pipeline=${!!this._farTreeBakePipeline} BG=${!!this._farTreeBakeBindGroup}`
                        );
                    }
                    return false;
                }
                if (this._farTreeSourceCache.pendingBakes === 0) return false;
                farDbgAs(`_dispatchFarTreeBakes: FIRING batch — pending=${this._farTreeSourceCache.pendingBakes}`);
            
                const batch = this._farTreeSourceCache.popBakeBatch();
                if (!batch || batch.length === 0) return false;
            
                const data = new Uint32Array(batch.length * 8);
                for (let i = 0; i < batch.length; i++) {
                    const offset = i * 8;
                    const tile = batch[i];
                    data[offset + 0] = tile.face >>> 0;
                    data[offset + 1] = tile.depth >>> 0;
                    data[offset + 2] = tile.tileX >>> 0;
                    data[offset + 3] = tile.tileY >>> 0;
                    data[offset + 4] = tile.layer >>> 0;
                    data[offset + 5] = tile.flags >>> 0;
                    data[offset + 6] = 0;
                    data[offset + 7] = 0;
                }
                this.device.queue.writeBuffer(this._farTreeBakeTileBuffer, 0, data);
            
                const paramData = new ArrayBuffer(256);
                const f32 = new Float32Array(paramData);
                const u32 = new Uint32Array(paramData);
                f32[0] = this.planetConfig.origin?.x ?? 0;
                f32[1] = this.planetConfig.origin?.y ?? 0;
                f32[2] = this.planetConfig.origin?.z ?? 0;
                f32[3] = this.planetConfig.radius ?? 0;
                f32[4] = this.planetConfig.heightScale ?? this.planetConfig.maxHeight ?? 0;
                f32[5] = this.quadtreeGPU?.faceSize ?? (this.planetConfig.radius * 2);
                u32[6] = this.engineConfig.seed >>> 0;
                u32[7] = batch.length >>> 0;
                this.device.queue.writeBuffer(this._farTreeBakeParamBuffer, 0, paramData);
            
                const pass = commandEncoder.beginComputePass({ label: 'FarTree-Bake' });
                pass.setPipeline(this._farTreeBakePipeline);
                pass.setBindGroup(0, this._farTreeBakeBindGroup);
                pass.dispatchWorkgroups(batch.length);
                pass.end();
            
                this._farTreeSourceCache.markBakeBatchSubmitted(batch);
                return true;
            },

        update(commandEncoder, camera) {
            if (!this._initialized) return;
            this._frameCount++;

            if ((this._frameCount % 120) === 0 && this._farTreeSourceCache) {
                Logger.info(
                    `${this._logTag} [FarCache] ` +
                    `selected=${this._farTreeSourceCache.activeLayerCount} ` +
                    `resident=${this._farTreeSourceCache.totalActiveLayerCount} ` +
                    `pending=${this._farTreeSourceCache.pendingBakes}`
                );
            }
            if ((this._frameCount % 120) === 1) {
                this._bakedAssetTileCache?.syncFromTileStreamer(this.tileStreamer);
                this._groundPropCache?.syncFromTileCache(this._bakedAssetTileCache, false);
                this._treeSourceCache?.syncFromTileCache(this._bakedAssetTileCache, false);
                this._farTreeSourceCache?.syncFromTileCache(this._bakedAssetTileCache, false);
                this._clusterTreeSystem?.syncFromTileCache(this._bakedAssetTileCache, false);
                this._seedScatterGroupPolicyMasks();
                this._forceScatter = true;
            }

            this._maybeRebuildScatterBindGroups();
            this._maybeRebuildFieldScatterBindGroups();
            this._maybeRebuildGroundPropBakeBindGroup();
            this._maybeRebuildGroundPropGatherBindGroup();
            this._maybeRebuildTreeSourceBakeBindGroup();
            this._maybeRebuildTreeSourceGatherBindGroup();
            this._maybeRebuildIndirectBindGroup();
            this._maybeRebuildFarTreeBakeBindGroup();

            const runtimeScatterReady = this._scatterPipelines.length === 0
                || this._scatterPipelines.every(pass => pass.bindGroup);
            const fieldScatterReady = this._fieldScatterPipelines.every(pass => pass.bindGroup);
            const groundPropReady = !this._groundPropCache?.enabled
                || (this._groundPropBakeBindGroup && this._groundPropGatherBindGroup);
            const treeSourceReady = !this._treeSourceCache?.enabled
                || (this._treeSourceBakeBindGroup && this._treeSourceGatherBindGroup);
            if (!runtimeScatterReady || !fieldScatterReady || !groundPropReady || !treeSourceReady || !this._indirectBindGroup) {
                // Zero indirect args so stale draw counts don't execute.
                this.device.queue.writeBuffer(this._pool.indirectBuffer, 0, this._indirectZeros);
                return;
            }

            this._drainAOCommits();
            this._drainScatterGroupCommits();
            this._treeSourceCache?.refreshVisibleOwnerLayers(this.tileStreamer);
            this._farTreeSourceCache?.refreshVisibleOwnerLayers(this.tileStreamer);
            this._dispatchScatterGroupMaskBakes(commandEncoder);
            const bakedGroundFieldThisFrame = this._dispatchGroundFieldBakes(commandEncoder);
            const bakedGroundPropsThisFrame = this._dispatchGroundPropBakes(commandEncoder);
            const bakedTreesThisFrame = this._dispatchTreeSourceBakes(commandEncoder);
            const bakedFarTreesThisFrame = this._dispatchFarTreeBakes(commandEncoder);
            
            const bakeDrivenScatter =
                bakedGroundFieldThisFrame ||
                bakedGroundPropsThisFrame ||
                bakedTreesThisFrame ||
                bakedFarTreesThisFrame;

            if (bakeDrivenScatter) {
                this._forceScatter = true;
            }

            if (!bakeDrivenScatter && !this._shouldUpdateScatter(camera)) {
                if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
                if (this._treeMidSystem)     this._treeMidSystem.update(commandEncoder, camera);
                if (this._treeFarSystem)     this._treeFarSystem.update(commandEncoder, camera);
                if (this._clusterTreeSystem) this._clusterTreeSystem.update(commandEncoder, camera);
                if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
                if (this._leafStreamer && this.enableLeafRendering) {
                    this._leafStreamer.update(commandEncoder, camera);
                }
                this._dispatchAOBakes(commandEncoder);
                return;
            }

            this._updateScatterParams(camera);
            this._updateClimateUniforms();
            this._pool.resetCounters();
            this._refreshActiveScatterGroupBits();
            this._refreshActiveFieldBits();

            if (this._scatterPipelines.length > 0) {
                const fillPass = commandEncoder.beginComputePass({ label: 'AssetScatterDispatchFill' });
                fillPass.setPipeline(this._scatterDispatchPipeline);
                fillPass.setBindGroup(0, this._scatterDispatchBindGroup);
                fillPass.dispatchWorkgroups(1);
                fillPass.end();
            }
            {
                for (const fieldPass of this._fieldScatterPipelines) {
                    if (!this._shouldDispatchFieldScatterPass(fieldPass)) continue;
                    const pass = commandEncoder.beginComputePass({ label: `AssetFieldScatter-${fieldPass.label}` });
                    pass.setPipeline(fieldPass.pipeline);
                    pass.setBindGroup(0, fieldPass.bindGroup);
                    pass.dispatchWorkgroups(this._fieldActiveLayerCount);
                    pass.end();
                }
            }
            {
                for (const scatterPass of this._scatterPipelines) {
                    if (!this._shouldDispatchScatterPass(scatterPass)) continue;
                    const pass = commandEncoder.beginComputePass({ label: `AssetScatter-${scatterPass.label}` });
                    pass.setPipeline(scatterPass.pipeline);
                    pass.setBindGroup(0, scatterPass.bindGroup);
                    pass.dispatchWorkgroupsIndirect(this._scatterDispatchArgsBuffer, 0);
                    pass.end();
                }
            }
            {
                if (this._shouldDispatchTreeSourceGather()) {
                    const pass = commandEncoder.beginComputePass({ label: 'TreeSource-Gather' });
                    pass.setPipeline(this._treeSourceGatherPipeline);
                    pass.setBindGroup(0, this._treeSourceGatherBindGroup);
                    pass.dispatchWorkgroups(this._treeSourceCache.activeLayerCount);
                    pass.end();
                }
            }
            {
                if (this._shouldDispatchGroundPropGather()) {
                    const pass = commandEncoder.beginComputePass({ label: 'GroundProp-Gather' });
                    pass.setPipeline(this._groundPropGatherPipeline);
                    pass.setBindGroup(0, this._groundPropGatherBindGroup);
                    pass.dispatchWorkgroups(this._groundPropCache.activeLayerCount);
                    pass.end();
                }
            }
            {
                const pass = commandEncoder.beginComputePass({ label: 'AssetIndirectBuilder' });
                pass.setPipeline(this._indirectPipeline);
                pass.setBindGroup(0, this._indirectBindGroup);
                pass.dispatchWorkgroups(1);
                pass.end();
            }
            this._queueProducerDebugReadback(commandEncoder);
        /*
            if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
            if (this._treeMidNearSystem) this._treeMidNearSystem.update(commandEncoder, camera);
            if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
        */
                if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
               // if (this._treeMidNearSystem) this._treeMidNearSystem.update(commandEncoder, camera); 
                if (this._treeMidSystem)     this._treeMidSystem.update(commandEncoder, camera);    
                if (this._treeFarSystem)     this._treeFarSystem.update(commandEncoder, camera);   
                if (this._clusterTreeSystem) this._clusterTreeSystem.update(commandEncoder, camera);
                if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
                if (this._leafStreamer && this.enableLeafRendering) {
                    this._leafStreamer.update(commandEncoder, camera);
                }

            this._dispatchAOBakes(commandEncoder);

            this._lastScatterFrame = this._frameCount;
            if (camera?.position) {
                this._lastScatterPosition = {
                    x: camera.position.x, y: camera.position.y, z: camera.position.z,
                };
            }
            this._lastScatterDirection = this._getCameraForward(camera);
            this._forceScatter = false;
        },

        _drainAOCommits() {
            if (!this._aoBaker?.enabled) return;

            const commits = this.tileStreamer.drainAOCommitQueue?.();
            if (!commits || commits.length === 0) return;

            for (const c of commits) {
                this._aoBaker.enqueueBake(c.face, c.depth, c.x, c.y, c.layer);

                // Re-bake same-depth neighbors so they pick up this tile's layer
                // for cross-tile AO sampling.
                const offsets = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
                const gridSize = 1 << c.depth;
                for (const [dx, dy] of offsets) {
                    const nx = c.x + dx, ny = c.y + dy;
                    if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
                    const nLayer = this.tileStreamer?.getLoadedLayer?.(c.face, c.depth, nx, ny);
                    if (nLayer != null && nLayer >= 0) {
                        this._aoBaker.enqueueBake(c.face, c.depth, nx, ny, nLayer);
                    }
                }
            }
        },

        _drainScatterGroupCommits() {
            // Process commits from the current frame immediately (no 1-frame deferral).
            // Previously this deferred one frame to avoid bind group churn, but that
            // added a guaranteed 16 ms latency to every tile commit. The bake
            // dispatches triggered here are enqueued, not immediately submitted, so
            // there is no read-while-rendering hazard.
            this._deferredScatterCommits = [];
            const commits = this.tileStreamer.drainScatterCommitQueue?.() ?? [];
            if (!commits || commits.length === 0) return;

            this._bakedAssetTileCache?.applyCommitBatch(commits);
            this._groundPropCache?.applyCommitBatch(this._bakedAssetTileCache);
            this._treeSourceCache?.applyCommitBatch(this._bakedAssetTileCache);
            this._farTreeSourceCache?.applyCommitBatch(this._bakedAssetTileCache);
            this._clusterTreeSystem?.applyCommitBatch(this._bakedAssetTileCache);
            this._scatterGroupActivityDirty = true;
            this._fieldActivityDirty = true;
            this._enqueueGroundFieldBakeBatch(commits);
            for (const commit of commits) {
                const entry = this._bakedAssetTileCache?.getLayerEntry?.(commit.layer);
                if (!entry) continue;
                this._updateScatterGroupPolicyForEntry(entry);
            }

            if (!this._enableScatterEligibilityGate || !this._hasLegacyRuntimeGroundScatter()) {
                return;
            }

            for (const commit of commits) {
                this._scatterGroupPendingLayers.add(commit.layer);
            }

            this._forceScatter = true;
        },

        _seedGroundFieldBakes() {
                if (!this._groundFieldBaker?.enabled) return;
                const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
                for (const entry of entries) {
                    this._enqueueGroundFieldBakeForEntry(entry);
                }
            },

        _seedScatterGroupPolicyMasks() {
                this._rebuildScatterGroupPolicyState(true);
            },

        _enqueueGroundFieldBakeBatch(commits) {
                if (!this._groundFieldBaker?.enabled) return;
                for (const commit of commits) {
                    const entry = this._bakedAssetTileCache?.getLayerEntry?.(commit.layer);
                if (!entry) continue;
                this._enqueueGroundFieldBakeForEntry(entry);
            }
        },

        _enqueueGroundFieldBakeForEntry(entry) {
            if (!this._groundFieldBaker?.enabled || !entry) return;
            const hasFieldArchetype = this._computeFieldRenderMask(entry) !== 0;
            this._groundFieldBaker.enqueueBake(
                entry.face,
                entry.depth,
                entry.x,
                entry.y,
                entry.layer,
                hasFieldArchetype
                );
            },

        _rebuildScatterGroupPolicyState(enqueueLayers = false) {
                if (!this._scatterGroupPolicyMasksCPU) {
                    this._scatterGroupActiveBits = 0;
                    this._scatterGroupActivityDirty = false;
                    this._fieldActiveBits = 0;
                    this._fieldActivityDirty = false;
                    this._fieldActiveLayerCount = 0;
                    return;
                }

                this._scatterGroupPolicyMasksCPU.fill(this._scatterGroupDefaultMask >>> 0);
                if (this._fieldRenderMasksCPU) {
                    this._fieldRenderMasksCPU.fill(0);
                }

                const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
                let activeBits = 0;
                let fieldActiveBits = 0;

                for (const entry of entries) {
                    if (!entry) continue;
                    const layer = entry.layer >>> 0;
                    if (layer >= this._scatterGroupPolicyMasksCPU.length) continue;

                    const mask = this._computeScatterGroupPolicyMask(entry);
                    const fieldMask = this._computeFieldRenderMask(entry);
                    this._scatterGroupPolicyMasksCPU[layer] = mask;
                    if (this._fieldRenderMasksCPU) {
                        this._fieldRenderMasksCPU[layer] = fieldMask;
                    }
                    activeBits |= mask;
                    fieldActiveBits |= fieldMask;

                    if (enqueueLayers && this._usesLegacyScatterPath()) {
                        this._scatterGroupPendingLayers.add(layer);
                    }
                }

                this._scatterGroupActiveBits = activeBits >>> 0;
                this._scatterGroupActivityDirty = false;
                this._fieldActiveBits = fieldActiveBits >>> 0;
                this._fieldActivityDirty = false;

                if (this._scatterGroupPolicyMaskBuffer) {
                    this.device.queue.writeBuffer(
                        this._scatterGroupPolicyMaskBuffer,
                        0,
                        this._scatterGroupPolicyMasksCPU
                    );
                }
                if (this._fieldRenderMaskBuffer && this._fieldRenderMasksCPU) {
                    this.device.queue.writeBuffer(
                        this._fieldRenderMaskBuffer,
                        0,
                        this._fieldRenderMasksCPU
                    );
                }

                this._rebuildFieldLayerState();
            },

        _computeScatterGroupPolicyMask(entry) {
                let mask = this._scatterGroupDefaultMask >>> 0;
                if (!entry || !this._groundFieldBaker?.enabled) {
                    return mask;
                }
                for (const group of this._scatterGroups) {
                    const maskIndex = Number.isInteger(group.maskArchetypeIndex)
                        ? group.maskArchetypeIndex
                        : (Number.isInteger(group.fieldArchetypeIndex) ? group.fieldArchetypeIndex : -1);
                    if (maskIndex < 0) continue;

                    const rep = entry.archetypeRepresentations?.[maskIndex];
                    if (!rep || rep === ASSET_BAKE_REPRESENTATION.INSTANCES) continue;

                    const meta = this._assetBakePolicy?.getArchetypeMetadataByIndex?.(maskIndex) ?? null;
                    const baseHoldDistance = Number.isFinite(group.runtimeHoldDistance)
                        ? group.runtimeHoldDistance
                        : (meta?.individualMaxDistance ?? 0);
                    const holdScale = Number.isFinite(group.runtimeHoldScale)
                        ? Math.max(1.0, group.runtimeHoldScale)
                        : 1.0;
                    const holdDistance = Math.max(0, baseHoldDistance * holdScale);
                    const nominalDistance = Number.isFinite(entry.nominalDistance)
                        ? entry.nominalDistance
                        : 0;

                    if (holdDistance > 0 && nominalDistance < holdDistance) {
                        continue;
                    }

                    if (rep !== ASSET_BAKE_REPRESENTATION.INSTANCES) {
                        mask = mask & (~group.bit >>> 0);
                    }
                }
                return mask >>> 0;
            },

        _computeFieldRenderMask(entry) {
                let mask = 0;
                if (!entry || !this._groundFieldBaker?.enabled) {
                    return mask;
                }
                for (const group of this._scatterGroups) {
                    if (group.mode !== 'field') continue;
                    const maskIndex = Number.isInteger(group.maskArchetypeIndex)
                        ? group.maskArchetypeIndex
                        : (Number.isInteger(group.fieldArchetypeIndex) ? group.fieldArchetypeIndex : -1);
                    if (maskIndex < 0) continue;
                    const rep = entry.archetypeRepresentations?.[maskIndex];
                    if (
                        rep === ASSET_BAKE_REPRESENTATION.INSTANCES ||
                        rep === ASSET_BAKE_REPRESENTATION.FIELD
                    ) {
                        mask |= group.bit;
                    }
                }
                return mask >>> 0;
            },

        _updateScatterGroupPolicyForEntry(entry, enqueueLayer = true) {
                if (
                    !this._scatterGroupPolicyMasksCPU ||
                    !this._fieldRenderMaskBuffer ||
                    !this._fieldRenderMasksCPU ||
                    !entry
                ) {
                    return;
                }
                const layer = entry.layer >>> 0;
                if (layer >= this._scatterGroupPolicyMasksCPU.length) {
                    return;
                }
                const mask = this._computeScatterGroupPolicyMask(entry);
                const fieldMask = this._computeFieldRenderMask(entry);
                if (
                    this._scatterGroupPolicyMasksCPU[layer] === mask &&
                    this._fieldRenderMasksCPU[layer] === fieldMask
                ) {
                    return;
                }
                this._scatterGroupPolicyMasksCPU[layer] = mask;
                this._fieldRenderMasksCPU[layer] = fieldMask;
                if (this._scatterGroupPolicyMaskBuffer) {
                    this.device.queue.writeBuffer(
                        this._scatterGroupPolicyMaskBuffer,
                        layer * Uint32Array.BYTES_PER_ELEMENT,
                        new Uint32Array([mask])
                    );
                }
                this.device.queue.writeBuffer(
                    this._fieldRenderMaskBuffer,
                    layer * Uint32Array.BYTES_PER_ELEMENT,
                    new Uint32Array([fieldMask])
                );
                if (enqueueLayer && this._usesLegacyScatterPath()) {
                    this._scatterGroupPendingLayers.add(layer);
                }
                this._scatterGroupActivityDirty = true;
                this._fieldActivityDirty = true;
                this._rebuildFieldLayerState();
            },

        _rebuildFieldLayerState() {
                if (!this._fieldActiveLayersCPU || !this._fieldLayerMetaCPU || !this._fieldRenderMasksCPU) {
                    this._fieldActiveLayerCount = 0;
                    return;
                }

                this._fieldActiveLayersCPU.fill(0);
                this._fieldLayerMetaCPU.fill(0);

                const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
                let activeLayerCount = 0;
                let activeBits = 0;

                for (const entry of entries) {
                    if (!entry) continue;
                    const layer = entry.layer >>> 0;
                    if (layer >= this._fieldRenderMasksCPU.length) continue;

                    const fieldMask = this._fieldRenderMasksCPU[layer] >>> 0;
                    if (fieldMask === 0) continue;

                    this._fieldActiveLayersCPU[activeLayerCount++] = layer;
                    activeBits |= fieldMask;

                    const base = layer * FIELD_LAYER_META_U32_STRIDE;
                    this._fieldLayerMetaCPU[base + 0] = entry.face >>> 0;
                    this._fieldLayerMetaCPU[base + 1] = entry.depth >>> 0;
                    this._fieldLayerMetaCPU[base + 2] = entry.x >>> 0;
                    this._fieldLayerMetaCPU[base + 3] = entry.y >>> 0;
                    this._fieldLayerMetaCPU[base + 4] = 1;
                }

                this._fieldActiveLayerCount = activeLayerCount;
                this._fieldActiveBits = activeBits >>> 0;
                this._fieldActivityDirty = false;

                if (this._fieldActiveLayerBuffer) {
                    this.device.queue.writeBuffer(this._fieldActiveLayerBuffer, 0, this._fieldActiveLayersCPU);
                }
                if (this._fieldLayerMetaBuffer) {
                    this.device.queue.writeBuffer(this._fieldLayerMetaBuffer, 0, this._fieldLayerMetaCPU);
                }
            },

        _dispatchScatterGroupMaskBakes(commandEncoder) {
            if (!this._hasLegacyRuntimeGroundScatter()) return;
            if (!this._scatterGroupMaskBakePipeline || !this._scatterGroupMaskBakeBindGroup) return;
            if (this._scatterGroupPendingLayers.size === 0) return;

            const pendingLayers = Uint32Array.from(this._scatterGroupPendingLayers);
            this._scatterGroupPendingLayers.clear();

            this.device.queue.writeBuffer(this._scatterGroupPendingLayersBuffer, 0, pendingLayers);
            this.device.queue.writeBuffer(
                this._scatterGroupMaskBakeConfigBuffer,
                0,
                new Uint32Array([pendingLayers.length, this._assetSelectionBuffer.maxTileType, 0, 0])
            );

            const pass = commandEncoder.beginComputePass({ label: 'AssetScatterGroupMaskBake' });
            pass.setPipeline(this._scatterGroupMaskBakePipeline);
            pass.setBindGroup(0, this._scatterGroupMaskBakeBindGroup);
            pass.dispatchWorkgroups(pendingLayers.length);
            pass.end();
        },

        _dispatchAOBakes(commandEncoder) {
            if (!this._aoBaker?.enabled) return;
            if (this._aoBaker.pendingBakes === 0) return;

            const arr = this.tileStreamer.getArrayTextures();
            const scatterGPU = arr?.scatter?._gpuTexture?.texture;
            const tileGPU    = arr?.tile?._gpuTexture?.texture;

            this._aoBaker.update(commandEncoder, scatterGPU, tileGPU);
        },

        _dispatchGroundFieldBakes(commandEncoder) {
            if (!this._groundFieldBaker?.enabled) return false;
            if (this._groundFieldBaker.pendingBakes === 0) return false;

            const arr = this.tileStreamer.getArrayTextures();
            const climateGPU = arr?.climate?._gpuTexture?.texture;
            const tileGPU = arr?.tile?._gpuTexture?.texture;
            if (!climateGPU || !tileGPU) return false;

            this._groundFieldBaker.update(commandEncoder, climateGPU, tileGPU);
            return true;
        },

        _dispatchGroundPropBakes(commandEncoder) {
            if (!this._groundPropCache?.enabled) return false;
            if (!this._groundPropBakePipeline || !this._groundPropBakeBindGroup) return false;
            if (this._groundPropCache.pendingBakes === 0) return false;

            const batch = this._groundPropCache.popBakeBatch();
            if (!batch || batch.length === 0) return false;

            const data = new Uint32Array(batch.length * 8);
            for (let i = 0; i < batch.length; i++) {
                const offset = i * 8;
                const tile = batch[i];
                data[offset + 0] = tile.face >>> 0;
                data[offset + 1] = tile.depth >>> 0;
                data[offset + 2] = tile.tileX >>> 0;
                data[offset + 3] = tile.tileY >>> 0;
                data[offset + 4] = tile.layer >>> 0;
                data[offset + 5] = tile.flags >>> 0;
                data[offset + 6] = 0;
                data[offset + 7] = 0;
            }
            this.device.queue.writeBuffer(this._groundPropBakeTileBuffer, 0, data);

            const paramData = new ArrayBuffer(256);
            const f32 = new Float32Array(paramData);
            const u32 = new Uint32Array(paramData);
            f32[0] = this.planetConfig.origin?.x ?? 0;
            f32[1] = this.planetConfig.origin?.y ?? 0;
            f32[2] = this.planetConfig.origin?.z ?? 0;
            // Matches the existing ScatterParams packing used successfully elsewhere:
            // vec3 + scalar share one 16-byte block.
            f32[3] = this.planetConfig.radius ?? 0;
            f32[4] = this.planetConfig.heightScale ?? this.planetConfig.maxHeight ?? 0;
            f32[5] = this.quadtreeGPU?.faceSize ?? (this.planetConfig.radius * 2);
            u32[6] = this.engineConfig.seed >>> 0;
            u32[7] = batch.length >>> 0;
            this.device.queue.writeBuffer(this._groundPropBakeParamBuffer, 0, paramData);

            const pass = commandEncoder.beginComputePass({ label: 'GroundProp-Bake' });
            pass.setPipeline(this._groundPropBakePipeline);
            pass.setBindGroup(0, this._groundPropBakeBindGroup);
            pass.dispatchWorkgroups(batch.length);
            pass.end();
            return true;
        },

        _dispatchTreeSourceBakes(commandEncoder) {
            if (!this._treeSourceCache?.enabled) return false;
            if (!this._treeSourceBakePipeline || !this._treeSourceBakeBindGroup) return false;
            if (this._treeSourceCache.pendingBakes === 0) return false;

            const batch = this._treeSourceCache.popBakeBatch();
            if (!batch || batch.length === 0) return false;

            const data = new Uint32Array(batch.length * 8);
            for (let i = 0; i < batch.length; i++) {
                const offset = i * 8;
                const tile = batch[i];
                data[offset + 0] = tile.face >>> 0;
                data[offset + 1] = tile.depth >>> 0;
                data[offset + 2] = tile.tileX >>> 0;
                data[offset + 3] = tile.tileY >>> 0;
                data[offset + 4] = tile.layer >>> 0;
                data[offset + 5] = tile.flags >>> 0;
                data[offset + 6] = 0;
                data[offset + 7] = 0;
            }
            this.device.queue.writeBuffer(this._treeSourceBakeTileBuffer, 0, data);

            const paramData = new ArrayBuffer(256);
            const f32 = new Float32Array(paramData);
            const u32 = new Uint32Array(paramData);
            f32[0] = this.planetConfig.origin?.x ?? 0;
            f32[1] = this.planetConfig.origin?.y ?? 0;
            f32[2] = this.planetConfig.origin?.z ?? 0;
            f32[3] = this.planetConfig.radius ?? 0;
            f32[4] = this.planetConfig.heightScale ?? this.planetConfig.maxHeight ?? 0;
            f32[5] = this.quadtreeGPU?.faceSize ?? (this.planetConfig.radius * 2);
            u32[6] = this.engineConfig.seed >>> 0;
            u32[7] = batch.length >>> 0;
            this.device.queue.writeBuffer(this._treeSourceBakeParamBuffer, 0, paramData);

            const pass = commandEncoder.beginComputePass({ label: 'TreeSource-Bake' });
            pass.setPipeline(this._treeSourceBakePipeline);
            pass.setBindGroup(0, this._treeSourceBakeBindGroup);
            pass.dispatchWorkgroups(batch.length);
            pass.end();
            this._treeSourceCache.markBakeBatchSubmitted(batch);
            return true;
        },

        getTerrainAOTexture() {
            return this._aoBaker?.getAOTextureWrapper() ?? null;
        },

        getGroundFieldTexture() {
            return this._groundFieldBaker?.getFieldTextureWrapper() ?? null;
        },

        _refreshActiveScatterGroupBits() {
                if (!this._hasLegacyRuntimeGroundScatter()) {
                    this._scatterGroupActiveBits = 0;
                    this._scatterGroupActivityDirty = false;
                    return;
                }
                if (!this._scatterGroupActivityDirty) return;
                const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
                let activeBits = 0;
                for (const entry of entries) {
                    if (!entry) continue;
                    activeBits |= this._computeScatterGroupPolicyMask(entry);
                }
                this._scatterGroupActiveBits = activeBits >>> 0;
                this._scatterGroupActivityDirty = false;
            },

        _refreshActiveFieldBits() {
                if (!this._fieldActivityDirty) return;
                this._rebuildFieldLayerState();
            },

        _shouldDispatchScatterPass(scatterPass) {
                if (!scatterPass) return false;
                if (!scatterPass.enableGroundPass) return true;
                if (!this._enableScatterDensityGroups) return true;
                if (!scatterPass.scatterGroupBit) return true;
                return (this._scatterGroupActiveBits & scatterPass.scatterGroupBit) !== 0;
            },

        _shouldDispatchFieldScatterPass(fieldPass) {
                if (!fieldPass?.bindGroup) return false;
                if (this._fieldActiveLayerCount <= 0) return false;
                if (!fieldPass.bit) return true;
                return (this._fieldActiveBits & fieldPass.bit) !== 0;
            },

        _usesLegacyScatterPath() {
                return false;
            },

        _hasLegacyRuntimeGroundScatter() {
                return this._usesLegacyScatterPath() && this._scatterPipelines.some(pass => pass?.enableGroundPass);
            },

        _shouldDispatchGroundPropGather() {
                return !!(
                    this._groundPropCache?.enabled &&
                    this._groundPropGatherPipeline &&
                    this._groundPropGatherBindGroup &&
                    this._groundPropCache.activeLayerCount > 0
                );
            },

        _shouldDispatchTreeSourceGather() {
                return !!(
                    this._treeSourceCache?.enabled &&
                    this._treeSourceGatherPipeline &&
                    this._treeSourceGatherBindGroup &&
                    this._treeSourceCache.activeLayerCount > 0
                );
            }
        })
    );
}
