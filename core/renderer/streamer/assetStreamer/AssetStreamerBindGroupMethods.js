export function installAssetStreamerBindGroupMethods(AssetStreamer, deps = {}) {
    const {
        Logger
    } = deps;

    Object.defineProperties(
        AssetStreamer.prototype,
        Object.getOwnPropertyDescriptors({
        _maybeRebuildScatterBindGroups() {
                        if (!this._scatterPipelines.length || !this._scatterBindGroupLayout) {
                            return;
                        }
                        const arrayTextures = this.tileStreamer.getArrayTextures();
                        const heightTex = arrayTextures?.height;
                        const normalTex = arrayTextures?.normal;
                        const tileTex   = arrayTextures?.tile;
                        const scatterTex = arrayTextures?.scatter;

                        const heightGPU = heightTex?._gpuTexture?.texture;
                        const normalGPU = normalTex?._gpuTexture?.texture;
                        const tileGPU   = tileTex?._gpuTexture?.texture;
                        const scatterGPU = scatterTex?._gpuTexture?.texture;
                        if (!heightGPU || !normalGPU || !tileGPU || !scatterGPU) return;
                        if (!this._assetSelectionBuffer || !this._assetSelectionBuffer.isReady()) return;

                        if (this._scatterBindGroupCache.heightTex === heightGPU &&
                            this._scatterBindGroupCache.normalTex === normalGPU &&
                            this._scatterBindGroupCache.tileTex   === tileGPU &&
                            this._scatterBindGroupCache.scatterTex === scatterGPU &&
                            this._scatterBindGroupCache.bindGroups.size === this._scatterPipelines.length &&
                            (!this._scatterGroupMaskBakePipeline || (
                                this._scatterGroupMaskBakeBindGroupCache.tileTex === tileGPU &&
                                this._scatterGroupMaskBakeBindGroupCache.bindGroup !== null
                            ))) {
                            for (const scatterPass of this._scatterPipelines) {
                                scatterPass.bindGroup = this._scatterBindGroupCache.bindGroups.get(scatterPass.key) ?? null;
                            }
                            if (this._scatterGroupMaskBakePipeline) {
                                this._scatterGroupMaskBakeBindGroup = this._scatterGroupMaskBakeBindGroupCache.bindGroup;
                            }
                            return;
                        }

                        const heightView = heightGPU.createView({ dimension: '2d-array' });
                        const normalView = normalGPU.createView({ dimension: '2d-array' });
                        const tileView   = tileGPU.createView({ dimension: '2d-array' });
                        const scatterView = scatterGPU.createView({ dimension: '2d-array' });
                        const bindGroups = new Map();
                        for (const scatterPass of this._scatterPipelines) {
                            const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(scatterPass.tileMapKey);
                            if (!tileMapBuffer) continue;

                            scatterPass.bindGroup = this.device.createBindGroup({
                                layout: this._scatterBindGroupLayout,
                                entries: [
                                    { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                                    { binding: 1, resource: { buffer: this.quadtreeGPU.getVisibleTileBuffer() } },
                                    { binding: 2, resource: { buffer: this._pool.instanceBuffer } },
                                    { binding: 3, resource: { buffer: this._pool.counterBuffer } },
                                    { binding: 4, resource: { buffer: this._pool.bandMetaBuffer } },
                                    { binding: 5, resource: heightView },
                                    { binding: 6, resource: tileView },
                                    { binding: 7, resource: { buffer: this.quadtreeGPU.getLoadedTileTableBuffer() } },
                                    { binding: 8, resource: { buffer: this._loadedTableParamsBuffer } },
                                    { binding: 9, resource: { buffer: this.quadtreeGPU.getCounterBuffer() } },
                                    { binding: 10, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                                    { binding: 11, resource: { buffer: tileMapBuffer } },
                                    { binding: 12, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                                    { binding: 13, resource: { buffer: this._climateUniformBuffer } },
                                    { binding: 14, resource: scatterView },
                                    { binding: 15, resource: { buffer: this._densityLUT.getBuffer() } },
                                    { binding: 16, resource: normalView },
                                    { binding: 17, resource: { buffer: this._scatterGroupMaskBuffer } },
                                ]
                            });
                            bindGroups.set(scatterPass.key, scatterPass.bindGroup);
                        }

                        if (this._scatterGroupMaskBakePipeline) {
                            this._scatterGroupMaskBakeBindGroup = this.device.createBindGroup({
                                layout: this._scatterGroupMaskBakeBindGroupLayout,
                                entries: [
                                    { binding: 0, resource: tileView },
                                    { binding: 1, resource: { buffer: this._scatterGroupPendingLayersBuffer } },
                                    { binding: 2, resource: { buffer: this._scatterGroupMaskBakeConfigBuffer } },
                                    { binding: 3, resource: { buffer: this._tileTypeScatterGroupMaskBuffer } },
                                    { binding: 4, resource: { buffer: this._scatterGroupPolicyMaskBuffer } },
                                    { binding: 5, resource: { buffer: this._scatterGroupMaskBuffer } },
                                ]
                            });
                        }

                        this._scatterBindGroupCache.heightTex = heightGPU;
                        this._scatterBindGroupCache.normalTex = normalGPU;
                        this._scatterBindGroupCache.tileTex   = tileGPU;
                        this._scatterBindGroupCache.scatterTex = scatterGPU;
                        this._scatterBindGroupCache.bindGroups = bindGroups;
                        this._scatterGroupMaskBakeBindGroupCache.tileTex = tileGPU;
                        this._scatterGroupMaskBakeBindGroupCache.bindGroup = this._scatterGroupMaskBakeBindGroup;
                        this._forceScatter = true;
                        Logger.info(`${this._logTag} Scatter bind groups rebuilt (texture change)`);
                    },

        _maybeRebuildFieldScatterBindGroups() {
                        if (!this._fieldScatterPipelines.length || !this._fieldScatterBindGroupLayout) {
                            return;
                        }

                        const arrayTextures = this.tileStreamer.getArrayTextures();
                        const heightTex = arrayTextures?.height;
                        const normalTex = arrayTextures?.normal;
                        const tileTex = arrayTextures?.tile;
                        const climateTex = arrayTextures?.climate;
                        const fieldTex = this._groundFieldBaker?.getFieldTextureWrapper?.() ?? null;

                        const heightGPU = heightTex?._gpuTexture?.texture;
                        const normalGPU = normalTex?._gpuTexture?.texture;
                        const tileGPU = tileTex?._gpuTexture?.texture;
                        const climateGPU = climateTex?._gpuTexture?.texture;
                        const fieldGPU = fieldTex?._gpuTexture?.texture;
                        if (!heightGPU || !normalGPU || !tileGPU || !climateGPU || !fieldGPU) return;
                        if (!this._assetSelectionBuffer || !this._assetSelectionBuffer.isReady()) return;
                        if (!this._fieldActiveLayerBuffer || !this._fieldLayerMetaBuffer || !this._fieldRenderMaskBuffer) return;

                        if (
                            this._fieldScatterBindGroupCache.heightTex === heightGPU &&
                            this._fieldScatterBindGroupCache.normalTex === normalGPU &&
                            this._fieldScatterBindGroupCache.tileTex === tileGPU &&
                            this._fieldScatterBindGroupCache.climateTex === climateGPU &&
                            this._fieldScatterBindGroupCache.fieldTex === fieldGPU &&
                            this._fieldScatterBindGroupCache.bindGroups.size === this._fieldScatterPipelines.length
                        ) {
                            for (const fieldPass of this._fieldScatterPipelines) {
                                fieldPass.bindGroup = this._fieldScatterBindGroupCache.bindGroups.get(fieldPass.key) ?? null;
                            }
                            return;
                        }

                        const heightView = heightGPU.createView({ dimension: '2d-array' });
                        const normalView = normalGPU.createView({ dimension: '2d-array' });
                        const tileView = tileGPU.createView({ dimension: '2d-array' });
                        const climateView = climateGPU.createView({ dimension: '2d-array' });
                        const fieldView = fieldGPU.createView({ dimension: '2d-array' });
                        const bindGroups = new Map();

                        for (const fieldPass of this._fieldScatterPipelines) {
                            const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(fieldPass.tileMapKey);
                            if (!tileMapBuffer) continue;

                            fieldPass.bindGroup = this.device.createBindGroup({
                                layout: this._fieldScatterBindGroupLayout,
                                entries: [
                                    { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                                    { binding: 1, resource: { buffer: this._fieldActiveLayerBuffer } },
                                    { binding: 2, resource: { buffer: this._pool.instanceBuffer } },
                                    { binding: 3, resource: { buffer: this._pool.counterBuffer } },
                                    { binding: 4, resource: { buffer: this._pool.bandMetaBuffer } },
                                    { binding: 5, resource: heightView },
                                    { binding: 6, resource: tileView },
                                    { binding: 7, resource: { buffer: this._fieldLayerMetaBuffer } },
                                    { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                                    { binding: 9, resource: { buffer: tileMapBuffer } },
                                    { binding: 10, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                                    { binding: 11, resource: fieldView },
                                    { binding: 12, resource: normalView },
                                    { binding: 13, resource: climateView },
                                    { binding: 14, resource: { buffer: this._fieldRenderMaskBuffer } },
                                ]
                            });
                            bindGroups.set(fieldPass.key, fieldPass.bindGroup);
                        }

                        this._fieldScatterBindGroupCache.heightTex = heightGPU;
                        this._fieldScatterBindGroupCache.normalTex = normalGPU;
                        this._fieldScatterBindGroupCache.tileTex = tileGPU;
                        this._fieldScatterBindGroupCache.climateTex = climateGPU;
                        this._fieldScatterBindGroupCache.fieldTex = fieldGPU;
                        this._fieldScatterBindGroupCache.bindGroups = bindGroups;
                        this._forceScatter = true;
                        Logger.info(`${this._logTag} Field scatter bind groups rebuilt (texture change)`);
                    },

        _maybeRebuildGroundPropBakeBindGroup() {
                        if (!this._groundPropBakePipeline || !this._groundPropBakeBindGroupLayout || !this._groundPropCache?.enabled) {
                            return;
                        }

                        const arrayTextures = this.tileStreamer.getArrayTextures();
                        const heightTex = arrayTextures?.height;
                        const normalTex = arrayTextures?.normal;
                        const tileTex = arrayTextures?.tile;
                        const climateTex = arrayTextures?.climate;

                        const heightGPU = heightTex?._gpuTexture?.texture;
                        const normalGPU = normalTex?._gpuTexture?.texture;
                        const tileGPU = tileTex?._gpuTexture?.texture;
                        const climateGPU = climateTex?._gpuTexture?.texture;
                        if (!heightGPU || !normalGPU || !tileGPU || !climateGPU) return;
                        if (!this._assetSelectionBuffer?.isReady?.()) return;

                        const instanceBuffer = this._groundPropCache.instanceBuffer;
                        if (
                            this._groundPropBakeBindGroupCache.heightTex === heightGPU &&
                            this._groundPropBakeBindGroupCache.normalTex === normalGPU &&
                            this._groundPropBakeBindGroupCache.tileTex === tileGPU &&
                            this._groundPropBakeBindGroupCache.climateTex === climateGPU &&
                            this._groundPropBakeBindGroupCache.instanceBuffer === instanceBuffer &&
                            this._groundPropBakeBindGroupCache.bindGroup
                        ) {
                            this._groundPropBakeBindGroup = this._groundPropBakeBindGroupCache.bindGroup;
                            return;
                        }

                        const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(this._groundPropTileMapKey);
                        if (!tileMapBuffer) return;

                        this._groundPropBakeBindGroup = this.device.createBindGroup({
                            layout: this._groundPropBakeBindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._groundPropBakeParamBuffer } },
                                { binding: 1, resource: { buffer: this._groundPropBakeTileBuffer } },
                                { binding: 2, resource: { buffer: instanceBuffer } },
                                { binding: 3, resource: { buffer: this._groundPropCache.counterBuffer } },
                                { binding: 4, resource: heightGPU.createView({ dimension: '2d-array' }) },
                                { binding: 5, resource: tileGPU.createView({ dimension: '2d-array' }) },
                                { binding: 6, resource: normalGPU.createView({ dimension: '2d-array' }) },
                                { binding: 7, resource: climateGPU.createView({ dimension: '2d-array' }) },
                                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                                { binding: 9, resource: { buffer: tileMapBuffer } },
                                { binding: 10, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                                { binding: 11, resource: { buffer: this._densityLUT.getBuffer() } },
                            ]
                        });

                        this._groundPropBakeBindGroupCache.heightTex = heightGPU;
                        this._groundPropBakeBindGroupCache.normalTex = normalGPU;
                        this._groundPropBakeBindGroupCache.tileTex = tileGPU;
                        this._groundPropBakeBindGroupCache.climateTex = climateGPU;
                        this._groundPropBakeBindGroupCache.instanceBuffer = instanceBuffer;
                        this._groundPropBakeBindGroupCache.bindGroup = this._groundPropBakeBindGroup;
                        this._forceScatter = true;
                    },

        _maybeRebuildTreeSourceBakeBindGroup() {
                        if (!this._treeSourceBakePipeline || !this._treeSourceBakeBindGroupLayout || !this._treeSourceCache?.enabled) {
                            return;
                        }

                        const arrayTextures = this.tileStreamer.getArrayTextures();
                        const heightTex = arrayTextures?.height;
                        const tileTex = arrayTextures?.tile;
                        const scatterTex = arrayTextures?.scatter;

                        const heightGPU = heightTex?._gpuTexture?.texture;
                        const tileGPU = tileTex?._gpuTexture?.texture;
                        const scatterGPU = scatterTex?._gpuTexture?.texture;
                        if (!heightGPU || !tileGPU || !scatterGPU) return;
                        if (!this._assetSelectionBuffer?.isReady?.()) return;

                        const instanceBuffer = this._treeSourceCache.instanceBuffer;
                        if (
                            this._treeSourceBakeBindGroupCache.heightTex === heightGPU &&
                            this._treeSourceBakeBindGroupCache.tileTex === tileGPU &&
                            this._treeSourceBakeBindGroupCache.scatterTex === scatterGPU &&
                            this._treeSourceBakeBindGroupCache.instanceBuffer === instanceBuffer &&
                            this._treeSourceBakeBindGroupCache.bindGroup
                        ) {
                            this._treeSourceBakeBindGroup = this._treeSourceBakeBindGroupCache.bindGroup;
                            return;
                        }

                        const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(this._scatterTreeTileMapKey);
                        if (!tileMapBuffer) return;

                        this._treeSourceBakeBindGroup = this.device.createBindGroup({
                            layout: this._treeSourceBakeBindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._treeSourceBakeParamBuffer } },
                                { binding: 1, resource: { buffer: this._treeSourceBakeTileBuffer } },
                                { binding: 2, resource: { buffer: instanceBuffer } },
                                { binding: 3, resource: { buffer: this._treeSourceCache.counterBuffer } },
                                { binding: 4, resource: heightGPU.createView({ dimension: '2d-array' }) },
                                { binding: 5, resource: tileGPU.createView({ dimension: '2d-array' }) },
                                { binding: 6, resource: scatterGPU.createView({ dimension: '2d-array' }) },
                                { binding: 7, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                                { binding: 8, resource: { buffer: tileMapBuffer } },
                                { binding: 9, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                            ]
                        });

                        this._treeSourceBakeBindGroupCache.heightTex = heightGPU;
                        this._treeSourceBakeBindGroupCache.tileTex = tileGPU;
                        this._treeSourceBakeBindGroupCache.scatterTex = scatterGPU;
                        this._treeSourceBakeBindGroupCache.instanceBuffer = instanceBuffer;
                        this._treeSourceBakeBindGroupCache.bindGroup = this._treeSourceBakeBindGroup;
                        this._forceScatter = true;
                    },

        _maybeRebuildGroundPropGatherBindGroup() {
                        if (!this._groundPropGatherPipeline || !this._groundPropGatherBindGroupLayout || !this._groundPropCache?.enabled) {
                            return;
                        }
                        if (!this._assetSelectionBuffer?.isReady?.()) return;

                        const instanceBuffer = this._groundPropCache.instanceBuffer;
                        const activeLayerBuffer = this._groundPropCache.activeLayerBuffer;
                        const layerMetaBuffer = this._groundPropCache.layerMetaBuffer;
                        const counterBuffer = this._groundPropCache.counterBuffer;
                        if (!instanceBuffer || !activeLayerBuffer || !layerMetaBuffer || !counterBuffer) return;

                        if (
                            this._groundPropGatherBindGroupCache.instanceBuffer === instanceBuffer &&
                            this._groundPropGatherBindGroupCache.activeLayerBuffer === activeLayerBuffer &&
                            this._groundPropGatherBindGroupCache.layerMetaBuffer === layerMetaBuffer &&
                            this._groundPropGatherBindGroupCache.counterBuffer === counterBuffer &&
                            this._groundPropGatherBindGroupCache.bindGroup
                        ) {
                            this._groundPropGatherBindGroup = this._groundPropGatherBindGroupCache.bindGroup;
                            return;
                        }

                        this._groundPropGatherBindGroup = this.device.createBindGroup({
                            layout: this._groundPropGatherBindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                                { binding: 1, resource: { buffer: activeLayerBuffer } },
                                { binding: 2, resource: { buffer: layerMetaBuffer } },
                                { binding: 3, resource: { buffer: instanceBuffer } },
                                { binding: 4, resource: { buffer: counterBuffer } },
                                { binding: 5, resource: { buffer: this._pool.instanceBuffer } },
                                { binding: 6, resource: { buffer: this._pool.counterBuffer } },
                                { binding: 7, resource: { buffer: this._pool.bandMetaBuffer } },
                                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                            ]
                        });

                        this._groundPropGatherBindGroupCache.instanceBuffer = instanceBuffer;
                        this._groundPropGatherBindGroupCache.activeLayerBuffer = activeLayerBuffer;
                        this._groundPropGatherBindGroupCache.layerMetaBuffer = layerMetaBuffer;
                        this._groundPropGatherBindGroupCache.counterBuffer = counterBuffer;
                        this._groundPropGatherBindGroupCache.bindGroup = this._groundPropGatherBindGroup;
                        this._forceScatter = true;
                    },

        _maybeRebuildTreeSourceGatherBindGroup() {
                        if (!this._treeSourceGatherPipeline || !this._treeSourceGatherBindGroupLayout || !this._treeSourceCache?.enabled) {
                            return;
                        }
                        if (!this._assetSelectionBuffer?.isReady?.()) return;

                        const instanceBuffer = this._treeSourceCache.instanceBuffer;
                        const activeLayerBuffer = this._treeSourceCache.activeLayerBuffer;
                        const layerMetaBuffer = this._treeSourceCache.layerMetaBuffer;
                        const counterBuffer = this._treeSourceCache.counterBuffer;
                        if (!instanceBuffer || !activeLayerBuffer || !layerMetaBuffer || !counterBuffer) return;

                        if (
                            this._treeSourceGatherBindGroupCache.instanceBuffer === instanceBuffer &&
                            this._treeSourceGatherBindGroupCache.activeLayerBuffer === activeLayerBuffer &&
                            this._treeSourceGatherBindGroupCache.layerMetaBuffer === layerMetaBuffer &&
                            this._treeSourceGatherBindGroupCache.counterBuffer === counterBuffer &&
                            this._treeSourceGatherBindGroupCache.bindGroup
                        ) {
                            this._treeSourceGatherBindGroup = this._treeSourceGatherBindGroupCache.bindGroup;
                            return;
                        }

                        this._treeSourceGatherBindGroup = this.device.createBindGroup({
                            layout: this._treeSourceGatherBindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                                { binding: 1, resource: { buffer: activeLayerBuffer } },
                                { binding: 2, resource: { buffer: layerMetaBuffer } },
                                { binding: 3, resource: { buffer: instanceBuffer } },
                                { binding: 4, resource: { buffer: counterBuffer } },
                                { binding: 5, resource: { buffer: this._pool.instanceBuffer } },
                                { binding: 6, resource: { buffer: this._pool.counterBuffer } },
                                { binding: 7, resource: { buffer: this._pool.bandMetaBuffer } },
                                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                            ]
                        });

                        this._treeSourceGatherBindGroupCache.instanceBuffer = instanceBuffer;
                        this._treeSourceGatherBindGroupCache.activeLayerBuffer = activeLayerBuffer;
                        this._treeSourceGatherBindGroupCache.layerMetaBuffer = layerMetaBuffer;
                        this._treeSourceGatherBindGroupCache.counterBuffer = counterBuffer;
                        this._treeSourceGatherBindGroupCache.bindGroup = this._treeSourceGatherBindGroup;
                        this._forceScatter = true;
                    },

        getLODController() {
                            return this._lodController;
                        },

        getAssetBakePolicy() {
                        return this._assetBakePolicy;
                    },

        getBakedAssetTileCache() {
                        return this._bakedAssetTileCache;
                    },

        rebuildMidNearPipelines(options = {}) {
                            if (this._treeMidNearSystem) {
                                this._treeMidNearSystem.rebuildPipelines(options);
                            }
                        },

        _getCameraForward(camera) {
                        if (!camera?.position || !camera?.target) return null;
                        const dx = camera.target.x - camera.position.x;
                        const dy = camera.target.y - camera.position.y;
                        const dz = camera.target.z - camera.position.z;
                        const lenSq = dx * dx + dy * dy + dz * dz;
                        if (lenSq <= 1e-8) return null;
                        const invLen = 1.0 / Math.sqrt(lenSq);
                        return { x: dx * invLen, y: dy * invLen, z: dz * invLen };
                    },

        _shouldUpdateScatter(camera) {
                        if (this._forceScatter) return true;
                    
                        const interval = this._qualityConfig.scatterInterval ?? 2;
                        const minMove = this._qualityConfig.scatterMinMove ?? 0.0;
                        const minTurnAngleDeg = this._qualityConfig.scatterMinTurnAngleDeg ?? 1.5;
                    
                        if (interval <= 1 && minMove <= 0.0 && minTurnAngleDeg <= 0.0) return true;
                    
                        const frameDelta = this._lastScatterFrame < 0
                            ? interval
                            : (this._frameCount - this._lastScatterFrame);
                        if (frameDelta >= interval) return true;
                    
                        if (minMove > 0.0 && this._lastScatterPosition && camera?.position) {
                            const dx = camera.position.x - this._lastScatterPosition.x;
                            const dy = camera.position.y - this._lastScatterPosition.y;
                            const dz = camera.position.z - this._lastScatterPosition.z;
                            if ((dx * dx + dy * dy + dz * dz) >= (minMove * minMove)) {
                                return true;
                            }
                        }

                        if (minTurnAngleDeg > 0.0) {
                            const currentForward = this._getCameraForward(camera);
                            const previousForward = this._lastScatterDirection;
                            if (currentForward && previousForward) {
                                const dot =
                                    currentForward.x * previousForward.x +
                                    currentForward.y * previousForward.y +
                                    currentForward.z * previousForward.z;
                                const clampedDot = Math.max(-1.0, Math.min(1.0, dot));
                                const angleDeg = Math.acos(clampedDot) * (180.0 / Math.PI);
                                if (angleDeg >= minTurnAngleDeg) {
                                    return true;
                                }
                            } else if (currentForward || previousForward) {
                                return true;
                            }
                        }
                    
                        return false;
                    },

        _maybeRebuildIndirectBindGroup() {
                        if (this._indirectBindGroupBuilt) return;

                        this._indirectBindGroup = this.device.createBindGroup({
                            layout: this._indirectBindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._pool.counterBuffer } },
                                { binding: 1, resource: { buffer: this._pool.bandMetaBuffer } },
                                { binding: 2, resource: { buffer: this._pool.indirectBuffer } },
                                { binding: 3, resource: { buffer: this._lodIndexCountBuffer } },
                            ]
                        });

                        this._indirectBindGroupBuilt = true;
                    },

        _maybeRebuildRenderBindGroups() {
                        const clusterBuffers = this._clusterLightBuffers;
                        const shadowRenderer = this._shadowRenderer;
                        const clusterKey = clusterBuffers ? 'real' : 'dummy';
                        const shadowKey = shadowRenderer ? 'shadow' : 'noshadow';
                        const combinedKey = `${clusterKey}_${shadowKey}`;

                        if (this._renderBindGroupsBuilt && this._lastBindGroupKey === combinedKey) {
                            return;
                        }

                        // Group 0 + 1 shared by both pipelines
                        const group0 = this.device.createBindGroup({
                            layout: this._renderBindGroupLayouts[0],
                            entries: [
                                { binding: 0, resource: { buffer: this._uniformBuffer } },
                                { binding: 1, resource: { buffer: this._pool.instanceBuffer } },
                            ]
                        });

                        const group1 = this.device.createBindGroup({
                            layout: this._renderBindGroupLayouts[1],
                            entries: [
                                { binding: 0, resource: { buffer: this._fragUniformBuffer } },
                            ]
                        });

                        // Clustered light resources (shared)
                        const dummyStorage = this._getOrCreateDummyStorageBuffer();
                        const dummyUniform = this._getOrCreateDummyUniformBuffer();

                        const lightBuf   = clusterBuffers?.lightBuffer      || dummyStorage;
                        const clusterBuf = clusterBuffers?.clusterBuffer    || dummyStorage;
                        const indexBuf   = clusterBuffers?.lightIndexBuffer || dummyStorage;
                        const paramBuf   = clusterBuffers?.paramBuffer      || dummyUniform;

                        // Group 2 WITH shadows (for shadow pipeline)
                        const dummyDepthView = this._getOrCreateDummyDepthTextureView();
                        const shadowCascade0 = shadowRenderer?.getShadowDepthView(0) || dummyDepthView;
                        const shadowCascade1 = shadowRenderer?.getShadowDepthView(1) || dummyDepthView;
                        const shadowCascade2 = shadowRenderer?.getShadowDepthView(2) || dummyDepthView;
                        const shadowSampler = shadowRenderer?.getComparisonSampler() ||
                            this._getOrCreateDefaultComparisonSampler();
                        const shadowUniformBuf = shadowRenderer?.getCascadeUniformBuffer() || dummyUniform;

                        const group2Shadow = this.device.createBindGroup({
                            layout: this._renderBindGroupLayouts[2],
                            entries: [
                                { binding: 0, resource: { buffer: lightBuf } },
                                { binding: 1, resource: { buffer: clusterBuf } },
                                { binding: 2, resource: { buffer: indexBuf } },
                                { binding: 3, resource: { buffer: paramBuf } },
                                { binding: 4, resource: shadowCascade0 },
                                { binding: 5, resource: shadowCascade1 },
                                { binding: 6, resource: shadowCascade2 },
                                { binding: 7, resource: shadowSampler },
                                { binding: 8, resource: { buffer: shadowUniformBuf } },
                            ]
                        });

                        // Group 2 WITHOUT shadows (for no-shadow pipeline)
                        const group2NoShadow = this.device.createBindGroup({
                            layout: this._noShadowBindGroupLayouts[2],
                            entries: [
                                { binding: 0, resource: { buffer: lightBuf } },
                                { binding: 1, resource: { buffer: clusterBuf } },
                                { binding: 2, resource: { buffer: indexBuf } },
                                { binding: 3, resource: { buffer: paramBuf } },
                            ]
                        });
                        if (!this._propSampler) {
                            this._propSampler = this.device.createSampler({
                                label: 'AssetStreamer-PropSampler',
                                magFilter:    'linear',
                                minFilter:    'linear',
                                mipmapFilter: 'linear',
                                addressModeU: 'repeat',
                                addressModeV: 'repeat',
                            });
                        }

                        // Prefer the real atlas; fall back to a 1×1×1 dummy so the
                        // pipeline binds cleanly even if the manager isn't wired yet.
                        let propView;
                        if (this.propTextureManager?.isReady()) {
                            const tex = this.propTextureManager.getPropTexture();
                            // PropTextureManager wraps the GPU texture; unwrap for view.
                            propView = tex._gpuTexture.texture.createView({
                                dimension: '2d-array',
                            });
                        } else {
                            if (!this._dummyPropArrayTex) {
                                this._dummyPropArrayTex = this.device.createTexture({
                                    label:     'AssetStreamer-DummyPropArray',
                                    size:      [1, 1, 1],
                                    format:    'rgba8unorm',
                                    usage:     GPUTextureUsage.TEXTURE_BINDING,
                                    dimension: '2d',
                                });
                            }
                            propView = this._dummyPropArrayTex.createView({
                                dimension: '2d-array',
                            });
                        }

                        // Same buffer the scatter shader reads — already has STORAGE usage.
                        // If getAssetDefBuffer() returns a wrapper, adjust to ._gpuBuffer.
                        const defBuffer = this._assetSelectionBuffer.getAssetDefBuffer();

                        this._renderBindGroup3 = this.device.createBindGroup({
                            label:  'AssetStreamer-PropTex-BG',
                            layout: this._propTexGroupLayout,
                            entries: [
                                { binding: 0, resource: propView },
                                { binding: 1, resource: this._propSampler },
                                { binding: 2, resource: { buffer: defBuffer } },
                            ],
                        });
                        this._renderBindGroups = [group0, group1, group2Shadow, this._renderBindGroup3];
                        this._noShadowBindGroups = [group0, group1, group2NoShadow, this._renderBindGroup3];
                        this._renderBindGroupsBuilt = true;
                        this._lastBindGroupKey = combinedKey;
                    },

        _getOrCreateDummyDepthTextureView() {
                        if (!this._dummyDepthTexture) {
                            this._dummyDepthTexture = this.device.createTexture({
                                label: 'Asset-DummyDepthTex',
                                size: [1, 1],
                                format: 'depth32float',
                                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                            });
                            this._dummyDepthTextureView = this._dummyDepthTexture.createView();
                            // Clear to 1.0
                            const enc = this.device.createCommandEncoder();
                            enc.beginRenderPass({
                                colorAttachments: [],
                                depthStencilAttachment: {
                                    view: this._dummyDepthTextureView,
                                    depthClearValue: 1.0,
                                    depthLoadOp: 'clear',
                                    depthStoreOp: 'store'
                                }
                            }).end();
                            this.device.queue.submit([enc.finish()]);
                        }
                        return this._dummyDepthTextureView;
                    },

        _getOrCreateDefaultComparisonSampler() {
                        if (!this._defaultComparisonSampler) {
                            this._defaultComparisonSampler = this.device.createSampler({
                                compare: 'less',
                                magFilter: 'linear',
                                minFilter: 'linear',
                                addressModeU: 'clamp-to-edge',
                                addressModeV: 'clamp-to-edge'
                            });
                        }
                        return this._defaultComparisonSampler;
                    },

        setShadowRenderer(renderer) {
                        if (this._shadowRenderer !== renderer) {
                            this._shadowRenderer = renderer;
                            this._renderBindGroupsBuilt = false;
                        }
                    },

        _getOrCreateDummyStorageBuffer() {
                        if (!this._dummyStorageBuffer) {
                            this._dummyStorageBuffer = this.device.createBuffer({
                                label: 'Asset-DummyStorage',
                                size: 256,
                                usage: GPUBufferUsage.STORAGE
                            });
                        }
                        return this._dummyStorageBuffer;
                    },

        _getOrCreateDummyUniformBuffer() {
                        if (!this._dummyUniformBuffer) {
                            this._dummyUniformBuffer = this.device.createBuffer({
                                label: 'Asset-DummyUniform',
                                size: 256,
                                usage: GPUBufferUsage.UNIFORM
                            });
                        }
                        return this._dummyUniformBuffer;
                    },

        setClusterLightBuffers(buffers) {
                        if (this._clusterLightBuffers !== buffers) {
                            this._clusterLightBuffers = buffers;
                            this._renderBindGroupsBuilt = false; // Force rebuild
                        }
                    },

        _getMaxTileWorldSize() {
                        const cap = this._qualityConfig?.maxScatterTileWorldSize;
                        if (Number.isFinite(cap) && cap > 0) return cap;
                        return this.engineConfig.gpuQuadtree.minTileSizeMeters;
                    }
        })
    );
}
