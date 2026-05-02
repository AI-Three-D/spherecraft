export function installAssetStreamerRenderMethods(AssetStreamer, deps = {}) {
    const {
        GeometryFactory,
        Logger,
        TreeTrunkGeometryBuilder,
        buildAssetFragmentShader,
        buildAssetIndirectShader,
        buildAssetVertexShader,
        buildGroundPropBakeShader,
        buildGroundPropGatherShader,
        buildTreeSourceBakeShader,
        buildTreeSourceGatherShader,
        gpuFormatSampleType
    } = deps;

    Object.defineProperties(
        AssetStreamer.prototype,
        Object.getOwnPropertyDescriptors({
        render(camera, viewMatrix, projectionMatrix) {
                        if (!this._initialized) return;
                        if (!this.backend._renderPassEncoder) return;

                        this._updateRenderUniforms(camera, viewMatrix, projectionMatrix);
                        this._maybeRebuildRenderBindGroups();

                        const encoder = this.backend._renderPassEncoder;
                        let currentPipeline = null;

                        // ═══ INC 2: bandDescriptor-driven loop ═════════════════════════════
                        // Replaces `for band < TOTAL_BANDS` + category-range suppression.
                        // `isExternal` subsumes `_suppressAllTreeScatter` — tree_standard
                        // has pipelineKey='externalPipeline', so its 5 bands skip here.
                        // `capacity === 0` short-circuits all the Inc-3-pending archetypes.
                        for (const bd of this._bandDescriptors) {
                            if (bd.isExternal)      continue;
                            if (bd.capacity === 0)  continue;

                            const geo = this._geometries[bd.band];
                            if (!geo) continue;

                            // Per-archetype shadow threshold replaces global band<2 gate.
                            // grass_tuft has shadowLodThreshold=0 → never gets shadow
                            // (parity with pre-Inc-2; grass was at bands 10-14, threshold 2).
                            const wantShadow = bd.lod < bd.shadowLodThreshold;
                            const wantPipeline = wantShadow ? this._renderPipeline : this._renderPipelineNoShadow;
                            if (currentPipeline !== wantPipeline) {
                                currentPipeline = wantPipeline;
                                encoder.setPipeline(currentPipeline);
                                const groups = wantShadow ? this._renderBindGroups : this._noShadowBindGroups;
                                for (let i = 0; i < groups.length; i++) encoder.setBindGroup(i, groups[i]);
                            }

                            encoder.setVertexBuffer(0, geo.positionBuffer);
                            encoder.setVertexBuffer(1, geo.normalBuffer);
                            encoder.setVertexBuffer(2, geo.uvBuffer);
                            encoder.setIndexBuffer(geo.indexBuffer, 'uint16');
                            encoder.drawIndexedIndirect(this._pool.indirectBuffer, this._pool.getIndirectOffset(bd.band));
                        }
                /*
                        if (this._branchRenderer)    this._branchRenderer.render(encoder);
                        if (this._treeMidNearSystem) this._treeMidNearSystem.render(encoder);
                        if (this._leafStreamer && this.enableLeafRendering) this._leafStreamer.render(encoder);
                        if (this._treeDetailSystem)  this._treeDetailSystem.render(encoder, camera, viewMatrix, projectionMatrix);
                */
                if (this._branchRenderer)    this._branchRenderer.render(encoder);
                //if (this._treeMidNearSystem) this._treeMidNearSystem.render(encoder);  
                if (this._treeMidSystem)     this._treeMidSystem.render(encoder);    
                if (this._treeFarSystem)     this._treeFarSystem.render(encoder);
                if (this._clusterTreeSystem) this._clusterTreeSystem.render(encoder, camera, viewMatrix, projectionMatrix);
                if (this._leafStreamer && this.enableLeafRendering) this._leafStreamer.render(encoder);

                        const lodTest = this._treeDetailSystem?.getLeafLODTestSuite();
                        if (lodTest?.isLocked()) lodTest.renderOverlay(encoder);
                        if (lodTest?.getState() === 'capEncoded') {
                            const rpe = this.backend._renderPassEncoder;
                            if (rpe) { rpe.end(); this.backend._renderPassEncoder = null; }
                            lodTest.renderDiagnosticAndCopy(this.backend.getCommandEncoder());
                            this.backend.resumeRenderPass();
                        }
                    },

        _buildGeometries() {
                        // ═══ Tree template LODs (same as before, just extracted inline) ════
                        let treeLODs = null;
                        if (this._templateLibrary?.templateCount > 0) {
                            let repTpl = null;
                            for (const tt of ['birch']) {
                                const v = this._templateLibrary.getVariants(tt);
                                if (v?.length) { repTpl = v[0]; break; }
                            }
                            if (!repTpl) {
                                for (const tt of this._getActiveTreeTypes()) {
                                    const v = this._templateLibrary.getVariants(tt);
                                    if (v?.length) { repTpl = v[0]; break; }
                                }
                            }
                            if (repTpl) {
                                const all = TreeTrunkGeometryBuilder.buildFromTemplate(
                                    repTpl, { trunkRadialSegments: 10, branchRadialSegments: 6 }
                                );
                                treeLODs = all.slice(0, this.LODS_PER_CATEGORY);
                                Logger.info(
                                    `${this._logTag} Tree geometry from template "${repTpl.id}" — ` +
                                    `LOD0: ${treeLODs[0]?.indices?.length / 3 | 0} tris`
                                );
                                this._bandTemplateId = repTpl.id;
                            }
                        }

                        // ═══ INC 2: archetype-driven build ═════════════════════════════════
                        // One geometry per band. GeometryFactory dispatches by builder key.
                        // Inactive archetypes (rock, fern, …) get degenerate meshes — their
                        // bands exist in the indirect buffer but instanceCount stays 0.
                        const ctx = {
                            treeLODs,
                            builders: {
                                RockGeometryBuilder: this._streamerTheme.RockGeometryBuilder,
                                FernGeometryBuilder: this._streamerTheme.FernGeometryBuilder,
                                SansevieriaGeometryBuilder: this._streamerTheme.SansevieriaGeometryBuilder,
                                MushroomGeometryBuilder: this._streamerTheme.MushroomGeometryBuilder,
                                DeadwoodGeometryBuilder: this._streamerTheme.DeadwoodGeometryBuilder,
                            },
                        };
                        this._geometries = [];
                        this._lodIndexCounts = [];

                        for (const bd of this._bandDescriptors) {
                            const mesh = GeometryFactory.build(bd.geometryBuilder, bd.lod, ctx);
                            const indexCount = mesh.indexCount ?? mesh.indices?.length ?? 0;

                            this._lodIndexCounts[bd.band] = indexCount;
                            this._geometries[bd.band] = {
                                positionBuffer: this._createVertexBuffer(mesh.positions, `Geo-Pos-${bd.archetypeName}-${bd.lod}`),
                                normalBuffer:   this._createVertexBuffer(mesh.normals,   `Geo-Nrm-${bd.archetypeName}-${bd.lod}`),
                                uvBuffer:       this._createVertexBuffer(mesh.uvs,       `Geo-UV-${bd.archetypeName}-${bd.lod}`),
                                indexBuffer:    this._createIndexBuffer(mesh.indices,    `Geo-Idx-${bd.archetypeName}-${bd.lod}`),
                                indexCount,
                            };
                        }

                        // Upload per-band index counts for the indirect-args builder
                        const vec4Count = Math.ceil(this._totalBands / 4);
                        const countData = new Uint32Array(vec4Count * 4);
                        for (let i = 0; i < this._totalBands; i++) countData[i] = this._lodIndexCounts[i] ?? 0;
                        this.device.queue.writeBuffer(this._lodIndexCountBuffer, 0, countData);
                    },

        _createVertexBuffer(data, label) {
                        const byteLength = data?.byteLength ?? 0;
                        const size = Math.max(16, byteLength);
                        const buf = this.device.createBuffer({
                            label,
                            size,
                            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                            mappedAtCreation: true
                        });
                        const mapped = new Float32Array(buf.getMappedRange());
                        if (data?.length) mapped.set(data, 0);
                        buf.unmap();
                        return buf;
                    },

        _createIndexBuffer(data, label) {
                        const byteLength = data?.byteLength ?? 0;
                        const alignedSize = Math.max(16, Math.ceil(byteLength / 4) * 4);
                        const buf = this.device.createBuffer({
                            label,
                            size: alignedSize,
                            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                            mappedAtCreation: true
                        });
                        const mapped = new Uint16Array(buf.getMappedRange());
                        if (data?.length) mapped.set(data, 0);
                        buf.unmap();
                        return buf;
                    },

        _createUniformBuffers() {
                        // Scatter params: 16 floats padded to 256
                        this._scatterParamBuffer = this.device.createBuffer({
                            label: 'Asset-ScatterParams',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        // Climate uniforms (shared model with terrain)
                        this._climateUniformBuffer = this.device.createBuffer({
                            label: 'Asset-ClimateUniforms',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        // Vertex uniforms (view + proj + camera + planet + wind = ~48 floats)
                        this._uniformBuffer = this.device.createBuffer({
                            label: 'Asset-VertexUniforms',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        // Fragment uniforms
                        this._fragUniformBuffer = this.device.createBuffer({
                            label: 'Asset-FragUniforms',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        const vec4Count = Math.ceil(this._totalBands / 4);
                        const lodIndexBytes = Math.max(256, vec4Count * 16);
                        // Per-band index counts: vec4<u32> buckets
                        this._lodIndexCountBuffer = this.device.createBuffer({
                            label: 'Asset-LodIndexCounts',
                            size: lodIndexBytes,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        // Loaded-table lookup params
                        this._loadedTableParamsBuffer = this.device.createBuffer({
                            label: 'Asset-LoadedTableParams',
                            size: 8,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                        });

                        const ltParams = new Uint32Array([
                            this.quadtreeGPU.loadedTableMask,
                            this.quadtreeGPU.loadedTableCapacity
                        ]);
                        this.device.queue.writeBuffer(this._loadedTableParamsBuffer, 0, ltParams);
                    },

        _updateScatterParams(camera) {
                        const data = new Float32Array(32);
                        const camPos = this.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
                        data[0] = camPos.x;
                        data[1] = camPos.y;
                        data[2] = camPos.z;
                        data[3] = 0;
                    
                        data[4] = this.planetConfig.origin.x;
                        data[5] = this.planetConfig.origin.y;
                        data[6] = this.planetConfig.origin.z;
                        data[7] = this.planetConfig.radius;
                    
                        data[8] = this.planetConfig.heightScale;
                    
                        const maxDensity = this._assetRegistry?.maxDensity ?? 0.000001;
                        data[9] = maxDensity;
                    
                        const quadtreeFaceSize = this.quadtreeGPU?.faceSize;
                        const minTileSize = this.engineConfig?.gpuQuadtree?.minTileSizeMeters;
                        const maxDepth = this.quadtreeGPU?.maxDepth;
                        data[10] = Number.isFinite(quadtreeFaceSize)
                            ? quadtreeFaceSize
                            : (Number.isFinite(minTileSize) && Number.isFinite(maxDepth)
                                ? minTileSize * Math.pow(2, maxDepth)
                                : this.planetConfig.radius * 2); // faceSize
                    
                        const u32View = new Uint32Array(data.buffer);
                        u32View[11] = this.engineConfig.seed;
                    
                        data[12] = performance.now() / 1000.0;
                        u32View[13] = this.quadtreeGPU.maxVisibleTiles;
                        data[14] = 0;
                        data[15] = 0;
                    
                        // View-projection matrix (offsets 16-31)
                        if (camera?.matrixWorldInverse && camera?.projectionMatrix) {
                            const v = camera.matrixWorldInverse.elements;
                            const p = camera.projectionMatrix.elements;
                            for (let c = 0; c < 4; c++) {
                                for (let r = 0; r < 4; r++) {
                                    let sum = 0;
                                    for (let k = 0; k < 4; k++) {
                                        sum += p[r + k * 4] * v[k + c * 4];
                                    }
                                    data[16 + c * 4 + r] = sum;
                                }
                            }
                        } else {
                            for (let i = 16; i < 32; i++) data[i] = 0;
                            data[16] = 1; data[21] = 1; data[26] = 1; data[31] = 1;
                        }
                    
                        this.device.queue.writeBuffer(this._scatterParamBuffer, 0, data);
                    },

        _updateClimateUniforms() {
                        if (!this._climateUniformBuffer) return;

                        const tg = this.tileStreamer?.terrainGenerator;
                        const uniforms = tg?._getTerrainShaderUniforms?.() || {};
                        const data = new Float32Array(48); // 12 vec4s
                        let offset = 0;

                        const pushVec4 = (arr) => {
                            const v = Array.isArray(arr) ? arr : [0.0, 0.0, 0.0, 0.0];
                            data.set(v, offset);
                            offset += 4;
                        };

                        pushVec4(uniforms.climateParams);
                        pushVec4(uniforms.climateZone0);
                        pushVec4(uniforms.climateZone0Extra);
                        pushVec4(uniforms.climateZone1);
                        pushVec4(uniforms.climateZone1Extra);
                        pushVec4(uniforms.climateZone2);
                        pushVec4(uniforms.climateZone2Extra);
                        pushVec4(uniforms.climateZone3);
                        pushVec4(uniforms.climateZone3Extra);
                        pushVec4(uniforms.climateZone4);
                        pushVec4(uniforms.climateZone4Extra);

                        const noiseRef = Number.isFinite(tg?.noiseReferenceRadiusM)
                            ? tg.noiseReferenceRadiusM
                            : (this.planetConfig?.radius ?? 6371000);
                        const maxTerrainHeight = Number.isFinite(this.planetConfig?.maxTerrainHeight)
                            ? this.planetConfig.maxTerrainHeight
                            : 2000.0;
                        data[offset + 0] = noiseRef;
                        data[offset + 1] = maxTerrainHeight;
                        data[offset + 2] = 0.0;
                        data[offset + 3] = 0.0;

                        this.device.queue.writeBuffer(this._climateUniformBuffer, 0, data);
                    },

        _updateRenderUniforms(camera, viewMatrix, projectionMatrix) {
                        const data = new Float32Array(48);
                    
                        // [0..15]  viewMatrix  (bytes 0–63)
                        if (viewMatrix?.elements) data.set(viewMatrix.elements, 0);
                    
                        // [16..31] projectionMatrix  (bytes 64–127)
                        if (projectionMatrix?.elements) data.set(projectionMatrix.elements, 16);
                    
                        // [32..34] cameraPosition  (bytes 128–139)
                        data[32] = camera.position.x;
                        data[33] = camera.position.y;
                        data[34] = camera.position.z;
                    
                        // [35]     time — packs right after cameraPosition.z  (byte 140)
                        data[35] = performance.now() / 1000.0;
                    
                        // [36..38] planetOrigin  (bytes 144–155)
                        data[36] = this.planetConfig.origin.x;
                        data[37] = this.planetConfig.origin.y;
                        data[38] = this.planetConfig.origin.z;
                    
                        // [39]     planetRadius — packs right after planetOrigin.z  (byte 156)
                        data[39] = this.planetConfig.radius;
                    
                        // [40..41] windDirection  (bytes 160–167)
                        const envState = this.uniformManager?.currentEnvironmentState;
                        data[40] = envState?.windDirection?.x ?? 1.0;
                        data[41] = envState?.windDirection?.y ?? 0.0;
                    
                        // [42]     windStrength  (byte 168)
                        data[42] = (envState?.windSpeed ?? 5.0) / 10.0;
                    
                        // [43]     windSpeed  (byte 172)
                        data[43] = envState?.windSpeed ?? 5.0;
                    
                        this.device.queue.writeBuffer(this._uniformBuffer, 0, data);
                    
                        // ── Fragment uniforms (unchanged) ─────────────────────────────
                        const fragData = new Float32Array(16);
                        const u = this.uniformManager?.uniforms;
                    
                        fragData[0]  = u?.sunLightDirection?.value?.x ?? 0;
                        fragData[1]  = u?.sunLightDirection?.value?.y ?? 1;
                        fragData[2]  = u?.sunLightDirection?.value?.z ?? 0;
                        fragData[3]  = u?.sunLightIntensity?.value ?? 1.0;
                    
                        fragData[4]  = u?.sunLightColor?.value?.r ?? 1;
                        fragData[5]  = u?.sunLightColor?.value?.g ?? 1;
                        fragData[6]  = u?.sunLightColor?.value?.b ?? 1;
                        fragData[7]  = 0;
                    
                        fragData[8]  = u?.ambientLightColor?.value?.r ?? 0.3;
                        fragData[9]  = u?.ambientLightColor?.value?.g ?? 0.3;
                        fragData[10] = u?.ambientLightColor?.value?.b ?? 0.4;
                        fragData[11] = u?.ambientLightIntensity?.value ?? 0.8;
                    
                        fragData[12] = u?.fogColor?.value?.r ?? 0.7;
                        fragData[13] = u?.fogColor?.value?.g ?? 0.8;
                        fragData[14] = u?.fogColor?.value?.b ?? 1.0;
                        fragData[15] = u?.fogDensity?.value ?? 0.00005;
                    
                        this.device.queue.writeBuffer(this._fragUniformBuffer, 0, fragData);
                    },

        _createScatterPipelines() {
                        this._scatterWorkgroupSize = this._qualityConfig.scatterWorkgroupSize ?? 64;
                        this._scatterBindGroupLayout = null;
                        this._scatterPipelines = [];
                    },

        _createFieldScatterPipelines() {
                        this._fieldScatterPipelines = [];
                        this._fieldScatterBindGroupLayout = null;
                    },

        _createGroundPropPipelines() {
                        if (!this._groundPropCache?.enabled) {
                            this._groundPropBakePipeline = null;
                            this._groundPropBakeBindGroupLayout = null;
                            this._groundPropGatherPipeline = null;
                            this._groundPropGatherBindGroupLayout = null;
                            return;
                        }

                        const heightSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.height || 'r32float'
                        );
                        const tileSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.tile || 'r32float'
                        );
                        const normalSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.normal || 'rg8unorm'
                        );
                        const climateSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.climate || 'rgba8unorm'
                        );

                        const eligibleVariants = this._assetRegistry.getAllVariants()
                            .filter(variant => this._isBakedGroundPropVariant(variant));
                        const maxDensity = eligibleVariants.reduce((best, variant) => {
                            return Math.max(best, Math.max(0.000001, ...(variant?.densities ?? [0.000001])));
                        }, 0.000001);

                        const bakeBatchSize = this._groundPropCache.maxBakesPerFrame;
                        this._groundPropBakeParamBuffer = this.device.createBuffer({
                            label: 'GroundProp-BakeParams',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                        });
                        this._groundPropBakeTileBuffer = this.device.createBuffer({
                            label: 'GroundProp-BakeTiles',
                            size: Math.max(256, bakeBatchSize * 8 * Uint32Array.BYTES_PER_ELEMENT),
                            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                        });

                        this._groundPropBakeBindGroupLayout = this.device.createBindGroupLayout({
                            label: 'GroundProp-BakeLayout',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: normalSampleType, viewDimension: '2d-array' } },
                                { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: climateSampleType, viewDimension: '2d-array' } },
                                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            ]
                        });

                        const bakeModule = this.device.createShaderModule({
                            label: 'GroundProp-BakeShader',
                            code: buildGroundPropBakeShader({
                                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                                lodsPerCategory: this.LODS_PER_CATEGORY,
                                assetDefFloats: this.ASSET_DEF_FLOATS,
                                maxScatterTileWorldSize: this._groundPropCache.maxScatterTileWorldSize,
                                scatterCellOversample: this._groundPropCache.scatterCellOversample,
                                maxDensity,
                                perLayerCapacity: this._groundPropCache.perLayerCapacity,
                                densityLutTileCount: this._densityLutTileCount,
                            }),
                        });

                        this._groundPropBakePipeline = this.device.createComputePipeline({
                            label: 'GroundProp-BakePipeline',
                            layout: this.device.createPipelineLayout({
                                bindGroupLayouts: [this._groundPropBakeBindGroupLayout]
                            }),
                            compute: { module: bakeModule, entryPoint: 'main' }
                        });

                        this._groundPropGatherBindGroupLayout = this.device.createBindGroupLayout({
                            label: 'GroundProp-GatherLayout',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            ]
                        });

                        const maxScatterDistance = this._getMaxVariantDistance(
                            (variant) => this._isBakedGroundPropVariant(variant),
                            200.0
                        );
                        const gatherModule = this.device.createShaderModule({
                            label: 'GroundProp-GatherShader',
                            code: buildGroundPropGatherShader({
                                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                                totalBands: this._totalBands,
                                lodsPerCategory: this.LODS_PER_CATEGORY,
                                assetDefFloats: this.ASSET_DEF_FLOATS,
                                maxScatterDistance,
                                perLayerCapacity: this._groundPropCache.perLayerCapacity,
                            }),
                        });

                        this._groundPropGatherPipeline = this.device.createComputePipeline({
                            label: 'GroundProp-GatherPipeline',
                            layout: this.device.createPipelineLayout({
                                bindGroupLayouts: [this._groundPropGatherBindGroupLayout]
                            }),
                            compute: { module: gatherModule, entryPoint: 'main' }
                        });
                    },

        _createTreeSourcePipelines() {
                        if (!this._treeSourceCache?.enabled) {
                            this._treeSourceBakePipeline = null;
                            this._treeSourceBakeBindGroupLayout = null;
                            this._treeSourceGatherPipeline = null;
                            this._treeSourceGatherBindGroupLayout = null;
                            return;
                        }

                        const heightSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.height || 'r32float'
                        );
                        const tileSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.tile || 'r32float'
                        );
                        const scatterSampleType = gpuFormatSampleType(
                            this.tileStreamer?.textureFormats?.scatter || 'r32float'
                        );

                        const bakeBatchSize = this._treeSourceCache.maxBakesPerFrame;
                        this._treeSourceBakeParamBuffer = this.device.createBuffer({
                            label: 'TreeSource-BakeParams',
                            size: 256,
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                        });
                        this._treeSourceBakeTileBuffer = this.device.createBuffer({
                            label: 'TreeSource-BakeTiles',
                            size: Math.max(256, bakeBatchSize * 8 * Uint32Array.BYTES_PER_ELEMENT),
                            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                        });

                        this._treeSourceBakeBindGroupLayout = this.device.createBindGroupLayout({
                            label: 'TreeSource-BakeLayout',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: scatterSampleType, viewDimension: '2d-array' } },
                                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            ]
                        });
                        const tcScatter    = this._treeConfig.scatter    || {};
                        const tcBillboards = this._treeConfig.billboards || {};

                        const treeVisibility = this._treeConfig._derived?.gatherCullRadius
                            ?? (this._treeConfig.tierRanges?.mid?.end ?? 800);

                        const bakeModule = this.device.createShaderModule({
                            label: 'TreeSource-BakeShader',
                            code: buildTreeSourceBakeShader({
                                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                                perLayerCapacity: this._treeSourceCache.perLayerCapacity,
                                lodsPerCategory: this.LODS_PER_CATEGORY,
                                assetDefFloats: this.ASSET_DEF_FLOATS,
                                treeCellSize:           tcScatter.cellSize           ?? 16.0,
                                treeMaxPerCell:         tcScatter.maxPerCell         ?? 4,
                                treeClusterProbability: tcScatter.clusterProbability ?? 0.95,
                                treeJitterScale:        tcScatter.jitterScale        ?? 0.85,
                                treeDensityScale:       tcScatter.densityScale       ?? 1.0,
                            }),
                        });
                        this._treeSourceBakePipeline = this.device.createComputePipeline({
                            label: 'TreeSource-BakePipeline',
                            layout: this.device.createPipelineLayout({
                                bindGroupLayouts: [this._treeSourceBakeBindGroupLayout]
                            }),
                            compute: { module: bakeModule, entryPoint: 'main' }
                        });

                        this._treeSourceGatherBindGroupLayout = this.device.createBindGroupLayout({
                            label: 'TreeSource-GatherLayout',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            ]
                        });
                        const gatherModule = this.device.createShaderModule({
                            label: 'TreeSource-GatherShader',
                            code: buildTreeSourceGatherShader({
                                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                                totalBands: this._totalBands,
                                lodsPerCategory: this.LODS_PER_CATEGORY,
                                assetDefFloats: this.ASSET_DEF_FLOATS,
                                perLayerCapacity: this._treeSourceCache.perLayerCapacity,
                                treeVisibility,
                            }),
                        });

                        this._treeSourceGatherPipeline = this.device.createComputePipeline({
                            label: 'TreeSource-GatherPipeline',
                            layout: this.device.createPipelineLayout({
                                bindGroupLayouts: [this._treeSourceGatherBindGroupLayout]
                            }),
                            compute: { module: gatherModule, entryPoint: 'main' }
                        });
                    },

        _createIndirectPipeline() {
                        const shaderSource = buildAssetIndirectShader({ totalBands: this._totalBands });
                        const module = this.device.createShaderModule({
                            label: 'Asset-IndirectShader',
                            code: shaderSource
                        });

                        this._indirectBindGroupLayout = this.device.createBindGroupLayout({
                            label: 'Asset-IndirectLayout',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            ]
                        });

                        this._indirectPipeline = this.device.createComputePipeline({
                            label: 'Asset-IndirectPipeline',
                            layout: this.device.createPipelineLayout({
                                bindGroupLayouts: [this._indirectBindGroupLayout]
                            }),
                            compute: { module, entryPoint: 'main' }
                        });
                    },

        _createRenderPipeline() {


                        // ── Build per-band self-occlusion parameters ─────────────────
                        const soConfig = this.ASSET_SELF_OCCLUSION || {};
                        const perBandSO = [];

                        if (soConfig.enabled !== false) {

                            // Build a map from band index to the dominant asset's self-occlusion config.
                            // For simplicity, use the first asset that maps to each category.
                            const perBandSO = new Array(this._totalBands);
                            if (soConfig.enabled !== false) {
                                const variants = this._assetRegistry.getAllVariants();
                                const def = soConfig.default || {};
                                for (const bd of this._bandDescriptors) {
                                    const repVariant = variants.find(v => v?.archetypeName === bd.archetypeName);
                                    const so = repVariant?.selfOcclusion ?? def;
                                    perBandSO[bd.band] = {
                                        gradientWidth:    so.gradientWidth    ?? def.gradientWidth    ?? 0.10,
                                        strengthMul:      so.strengthMul      ?? def.strengthMul      ?? 0.7,
                                        terrainEmbedding: so.terrainEmbedding ?? def.terrainEmbedding ?? 0.02,
                                        darkening:        so.darkening        ?? def.darkening        ?? 0.30,
                                    };
                                }
                            }
                        }

                        const tcBillboards = this._treeConfig.billboards || {};
                        const treeLodDistances = this._treeConfig._derived?.treeAssetLodDistances
                            || this._treeConfig.scatter?.lodDistances
                            || [20, 100, 150, 380, 500];
                        const treeVisibility = treeLodDistances[treeLodDistances.length - 1];

                const treeFadeStart = treeVisibility * (tcBillboards.fadeStartRatio ?? 0.7);
                const treeFadeEnd   = treeVisibility * (tcBillboards.fadeEndRatio   ?? 1.0);


                        const vsSource = buildAssetVertexShader({
                            windMaxDistance:       30,
                            windFadeDistance:      10,
                            lodsPerArchetype:      this.LODS_PER_CATEGORY,            // all archetypes have lodCount=5
                            treeBillboardLodStart: tcBillboards.lodStart ?? 3,
                            archetypeFlags:        this._archetypeFlags,
                        });

                        const maxDist       = this._assetRegistry?.maxDistance ?? 800;


                        const fragConfig = {
                            fadeStart:        maxDist * 0.75,
                            fadeEnd:          maxDist * 0.95,
                            treeFadeStart,
                            treeFadeEnd,
                            treeFarBand: tcBillboards.lodEnd ?? 4,        // still band 4 (tree LOD 4)
                            totalBands:       this._totalBands,
                            lodsPerArchetype: this.LODS_PER_CATEGORY,
                            archetypeFlags:   this._archetypeFlags,
                            selfOcclusion: {
                                enabled:         soConfig.enabled !== false,
                                masterStrength:  soConfig.masterStrength ?? 1.0,
                                ambientStrength: soConfig.ambientStrength ?? 1.0,
                                directStrength:  soConfig.directStrength ?? 0.4,
                                perBand:         perBandSO,
                            },
                        };

                        // Two fragment shader variants: with and without shadows
                        const fsShadowSource   = buildAssetFragmentShader({ ...fragConfig, enableShadows: true });
                        const fsNoShadowSource = buildAssetFragmentShader({ ...fragConfig, enableShadows: false });

                        const vsModule         = this.device.createShaderModule({ label: 'Asset-VS', code: vsSource });
                        const fsShadowModule   = this.device.createShaderModule({ label: 'Asset-FS-Shadow', code: fsShadowSource });
                        const fsNoShadowModule = this.device.createShaderModule({ label: 'Asset-FS-NoShadow', code: fsNoShadowSource });

                        const group0Layout = this.device.createBindGroupLayout({
                            label: 'Asset-RenderGroup0',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                            ]
                        });

                        const group1Layout = this.device.createBindGroupLayout({
                            label: 'Asset-RenderGroup1',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                            ]
                        });

                        // Group 2 with shadow bindings (close bands)
                        const group2ShadowLayout = this.device.createBindGroupLayout({
                            label: 'Asset-RenderGroup2-Shadow',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                                { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                                { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
                                { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                            ]
                        });

                        // Group 2 without shadow bindings (far bands)
                        const group2NoShadowLayout = this.device.createBindGroupLayout({
                            label: 'Asset-RenderGroup2-NoShadow',
                            entries: [
                                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                            ]
                        });

                        const group3Layout = this.device.createBindGroupLayout({
                            label: 'AssetStreamer-PropTex-Layout',
                            entries: [
                                {   // prop atlas (2d array)
                                    binding: 0,
                                    visibility: GPUShaderStage.FRAGMENT,
                                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                                },
                                {   // linear repeating sampler
                                    binding: 1,
                                    visibility: GPUShaderStage.FRAGMENT,
                                    sampler: { type: 'filtering' },
                                },
                                {   // variant def storage (same buffer scatter reads)
                                    binding: 2,
                                    visibility: GPUShaderStage.FRAGMENT,
                                    buffer: { type: 'read-only-storage' },
                                },
                            ],
                        });
                        this._propTexGroupLayout = group3Layout;

                        this._renderBindGroupLayouts = [group0Layout, group1Layout, group2ShadowLayout, group3Layout];
                        this._noShadowBindGroupLayouts = [group0Layout, group1Layout, group2NoShadowLayout, group3Layout];

                        const canvasFormat = this.backend?.sceneFormat || navigator.gpu.getPreferredCanvasFormat();

                        const depthState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

                        const vertexState = {
                            module: vsModule,
                            entryPoint: 'main',
                            buffers: [
                                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                                { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                            ]
                        };

                        const fragmentTargets = [{
                            format: canvasFormat,
                            blend: {
                                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                                alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' }
                            }
                        }];

                        const primitiveState = { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' };

                        // Pipeline with shadows (close bands 0-1)
                        this._renderPipeline = this.device.createRenderPipeline({
                            label: 'Asset-RenderPipeline-Shadow',
                            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._renderBindGroupLayouts }),
                            vertex: vertexState,
                            fragment: { module: fsShadowModule, entryPoint: 'main', targets: fragmentTargets },
                            primitive: primitiveState,
                            depthStencil: depthState
                        });

                        // Pipeline without shadows (far bands 2+)
                        this._renderPipelineNoShadow = this.device.createRenderPipeline({
                            label: 'Asset-RenderPipeline-NoShadow',
                            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._noShadowBindGroupLayouts }),
                            vertex: vertexState,
                            fragment: { module: fsNoShadowModule, entryPoint: 'main', targets: fragmentTargets },
                            primitive: primitiveState,
                            depthStencil: depthState
                        });

                    }
        })
    );
}
