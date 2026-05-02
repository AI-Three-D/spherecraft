export function installAssetStreamerDebugMethods(AssetStreamer, deps = {}) {
    const {
        Logger
    } = deps;

    Object.defineProperties(
        AssetStreamer.prototype,
        Object.getOwnPropertyDescriptors({
        _queueProducerDebugReadback(commandEncoder) {
                if (!this._producerDebugEnabled || !commandEncoder || !this._pool?.counterBuffer) return;
                if (this._producerDebugPending) return;

                if (this._producerDebugQueued) {
                    this._kickProducerDebugReadback();
                    return;
                }

                if ((this._frameCount % this._producerDebugInterval) !== 0) return;

                this._ensureProducerDebugReadbackBuffers();
                if (!this._producerDebugPoolReadbackBuffer) return;

                const poolBytes = Math.max(4, this._totalBands * Uint32Array.BYTES_PER_ELEMENT);
                commandEncoder.copyBufferToBuffer(
                    this._pool.counterBuffer,
                    0,
                    this._producerDebugPoolReadbackBuffer,
                    0,
                    poolBytes
                );

                this._producerDebugHasGroundPropSnapshot = false;
                if (
                    this._groundPropCache?.enabled &&
                    this._groundPropCache.counterBuffer &&
                    this._producerDebugGroundPropReadbackBuffer
                ) {
                    const propBytes = Math.max(
                        4,
                        (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
                    );
                    commandEncoder.copyBufferToBuffer(
                        this._groundPropCache.counterBuffer,
                        0,
                        this._producerDebugGroundPropReadbackBuffer,
                        0,
                        propBytes
                    );
                    this._producerDebugHasGroundPropSnapshot = true;
                }

                this._producerDebugQueued = true;
            },

        _ensureProducerDebugReadbackBuffers() {
                if (!this._producerDebugPoolReadbackBuffer) {
                    this._producerDebugPoolReadbackBuffer = this.device.createBuffer({
                        label: 'AssetStreamer-ProducerDebug-Pool',
                        size: Math.max(256, this._totalBands * Uint32Array.BYTES_PER_ELEMENT),
                        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                    });
                }
                if (this._groundPropCache?.enabled && !this._producerDebugGroundPropReadbackBuffer) {
                    this._producerDebugGroundPropReadbackBuffer = this.device.createBuffer({
                        label: 'AssetStreamer-ProducerDebug-GroundProp',
                        size: Math.max(
                            256,
                            (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
                        ),
                        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                    });
                }
            },

        _kickProducerDebugReadback() {
                if (!this._producerDebugQueued || this._producerDebugPending || !this._producerDebugPoolReadbackBuffer) {
                    return;
                }

                const mapPromises = [this._producerDebugPoolReadbackBuffer.mapAsync(GPUMapMode.READ)];
                if (this._producerDebugHasGroundPropSnapshot && this._producerDebugGroundPropReadbackBuffer) {
                    mapPromises.push(this._producerDebugGroundPropReadbackBuffer.mapAsync(GPUMapMode.READ));
                }

                this._producerDebugPending = true;
                Promise.all(mapPromises).then(() => {
                    this._handleProducerDebugReadback();
                }).catch((err) => {
                    this._handleProducerDebugReadbackFailure(err);
                });
            },

        _handleProducerDebugReadback() {
                const poolData = this._readProducerDebugPoolData();
                const groundPropSum = this._readProducerDebugGroundPropSum();
                const archetypeTotals = this._buildProducerDebugArchetypeTotals(poolData);
                const treeSummary = this._buildTreePoolDebugSummary(poolData);
                const fieldLayerCount = this._countFieldRenderLayers();

                this._logProducerDebugPoolSummary(archetypeTotals, fieldLayerCount, groundPropSum);
                this._logTreePoolSummary(treeSummary);
                this._unmapProducerDebugBuffers();
                this._resetProducerDebugReadbackState();
            },

        _readProducerDebugPoolData() {
                const poolBytes = Math.max(4, this._totalBands * Uint32Array.BYTES_PER_ELEMENT);
                return new Uint32Array(
                    this._producerDebugPoolReadbackBuffer.getMappedRange(0, poolBytes).slice(0)
                );
            },

        _readProducerDebugGroundPropSum() {
                if (!this._producerDebugHasGroundPropSnapshot || !this._producerDebugGroundPropReadbackBuffer) {
                    return 0;
                }

                const propBytes = Math.max(
                    4,
                    (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
                );
                const propData = new Uint32Array(
                    this._producerDebugGroundPropReadbackBuffer.getMappedRange(0, propBytes).slice(0)
                );
                let groundPropSum = 0;
                for (let i = 0; i < propData.length; i++) {
                    groundPropSum += propData[i] >>> 0;
                }
                return groundPropSum;
            },

        _buildProducerDebugArchetypeTotals(poolData) {
                const archetypeTotals = new Map();
                for (const bd of this._bandDescriptors ?? []) {
                    if (!bd) continue;
                    const key = bd.archetypeName || `band${bd.band}`;
                    archetypeTotals.set(key, (archetypeTotals.get(key) ?? 0) + (poolData[bd.band] >>> 0));
                }
                return archetypeTotals;
            },

        _buildTreePoolDebugSummary(poolData) {
                const treeBandBase = this.CAT_TREES * this.LODS_PER_CATEGORY;
                const bandParts = [];
                let rawTotal = 0;
                let capTotal = 0;
                let overflowTotal = 0;
                let maxOverflowBand = -1;
                let maxOverflowCount = 0;
                for (let lod = 0; lod < this.LODS_PER_CATEGORY; lod++) {
                    const band = treeBandBase + lod;
                    const raw = poolData[band] >>> 0;
                    const cap = this._pool?.getBandCapacity(band) ?? 0;
                    const overflow = Math.max(0, raw - cap);
                    rawTotal += raw;
                    capTotal += cap;
                    overflowTotal += overflow;
                    if (overflow > maxOverflowCount) {
                        maxOverflowCount = overflow;
                        maxOverflowBand = band;
                    }
                    bandParts.push(`b${band}=${raw}/${cap}`);
                }
                return { bandParts, rawTotal, capTotal, overflowTotal, maxOverflowBand };
            },

        _countFieldRenderLayers() {
                let fieldLayerCount = 0;
                if (this._fieldRenderMasksCPU) {
                    for (let i = 0; i < this._fieldRenderMasksCPU.length; i++) {
                        if (this._fieldRenderMasksCPU[i] !== 0) fieldLayerCount++;
                    }
                }
                return fieldLayerCount;
            },

        _logProducerDebugPoolSummary(archetypeTotals, fieldLayerCount, groundPropSum) {
                const grass = archetypeTotals.get('grass_tuft') ?? 0;
                const rocks = archetypeTotals.get('rock_small') ?? 0;
                const fern = archetypeTotals.get('fern') ?? 0;
                const mushroom = archetypeTotals.get('mushroom_capped') ?? 0;
                const logs = archetypeTotals.get('fallen_log') ?? 0;
                const stumps = archetypeTotals.get('tree_stump') ?? 0;
                const nonTreePoolTotal = grass + rocks + fern + mushroom + logs + stumps;
                const shouldProbeGrass = grass === 0 && fieldLayerCount > 0;
                const shouldLog =
                    nonTreePoolTotal === 0 ||
                    shouldProbeGrass ||
                    groundPropSum > 0 ||
                    (this._frameCount % (this._producerDebugInterval * 2)) === 0;
                if (!shouldLog) return;

                Logger.warn(
                    `${this._logTag} [BakeDiag] pool(` +
                    `grass=${grass} rock=${rocks} fern=${fern} ` +
                    `mushroom=${mushroom} log=${logs} stump=${stumps}) ` +
                    `fieldLayers=${fieldLayerCount} activeFieldLayers=${this._fieldActiveLayerCount} ` +
                    `fieldBits=0x${this._fieldActiveBits.toString(16)} ` +
                    `propLayers=${this._groundPropCache?.activeLayerCount ?? 0} ` +
                    `bakedPropInstances=${groundPropSum} ` +
                    `pendingField=${this._groundFieldBaker?.pendingBakes ?? 0} ` +
                    `pendingProp=${this._groundPropCache?.pendingBakes ?? 0}`
                );

                if (nonTreePoolTotal === 0 || shouldProbeGrass) {
                    this._kickProducerTextureProbe();
                }
            },

        _logTreePoolSummary(summary) {
                Logger.info(
                    `${this._logTag} [TreePool] ` +
                    `${summary.bandParts.join(' ')} ` +
                    `total=${summary.rawTotal}/${summary.capTotal} ` +
                    `overflow=${summary.overflowTotal}` +
                    (summary.maxOverflowBand >= 0 ? ` maxOverflowBand=${summary.maxOverflowBand}` : '') +
                    ` sourceLayers=${this._treeSourceCache?.activeLayerCount ?? 0}`
                );
            },

        _unmapProducerDebugBuffers() {
                this._producerDebugPoolReadbackBuffer.unmap();
                if (this._producerDebugHasGroundPropSnapshot && this._producerDebugGroundPropReadbackBuffer) {
                    this._producerDebugGroundPropReadbackBuffer.unmap();
                }
            },

        _handleProducerDebugReadbackFailure(err) {
                Logger.warn(`${this._logTag} [BakeDiag] readback failed: ${err?.message || err}`);
                try { this._producerDebugPoolReadbackBuffer?.unmap(); } catch { /* ignore cleanup failure */ }
                try { this._producerDebugGroundPropReadbackBuffer?.unmap(); } catch { /* ignore cleanup failure */ }
                this._resetProducerDebugReadbackState();
            },

        _resetProducerDebugReadbackState() {
                this._producerDebugQueued = false;
                this._producerDebugPending = false;
                this._producerDebugHasGroundPropSnapshot = false;
            },

        _kickProducerTextureProbe() {
                if (this._producerTextureProbePending) return;
                if (!this.tileStreamer?.debugReadArrayLayerStats) return;

                let fieldLayer = -1;
                if (this._fieldRenderMasksCPU) {
                    for (let i = 0; i < this._fieldRenderMasksCPU.length; i++) {
                        if (this._fieldRenderMasksCPU[i] !== 0) {
                            fieldLayer = i;
                            break;
                        }
                    }
                }

                let propLayer = -1;
                const propRecords = this._groundPropCache?._records ?? null;
                if (propRecords) {
                    for (let i = 0; i < propRecords.length; i++) {
                        if (propRecords[i]?.active) {
                            propLayer = i;
                            break;
                        }
                    }
                }

                if (fieldLayer < 0 && propLayer < 0) return;

                const fieldEntry = fieldLayer >= 0
                    ? this._bakedAssetTileCache?.getLayerEntry?.(fieldLayer) ?? null
                    : null;
                const propEntry = propLayer >= 0
                    ? this._bakedAssetTileCache?.getLayerEntry?.(propLayer) ?? null
                    : null;

                const describeEntry = (entry, layer) => {
                    if (!entry) return `layer=${layer}`;
                    return `layer=${layer} f${entry.face} d${entry.depth} (${entry.x},${entry.y})`;
                };
                const fmtStats = (stats) => {
                    if (!stats) return 'n/a';
                    const mean = Array.isArray(stats.mean)
                        ? stats.mean.map(v => Number.isFinite(v) ? v.toFixed(3) : 'nan').join(',')
                        : 'n/a';
                    const max = Array.isArray(stats.max)
                        ? stats.max.map(v => Number.isFinite(v) ? v.toFixed(3) : 'nan').join(',')
                        : 'n/a';
                    const zero = Number.isFinite(stats.zeroCount) ? stats.zeroCount : 'n/a';
                    return `mean=[${mean}] max=[${max}] zero=${zero}`;
                };

                this._producerTextureProbePending = true;
                Promise.all([
                    fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('groundField', fieldLayer, 8) : Promise.resolve(null),
                    fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('climate', fieldLayer, 8) : Promise.resolve(null),
                    fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('tile', fieldLayer, 8) : Promise.resolve(null),
                    propLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('climate', propLayer, 8) : Promise.resolve(null),
                    propLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('tile', propLayer, 8) : Promise.resolve(null),
                ]).then(([fieldStats, fieldClimate, fieldTile, propClimate, propTile]) => {
                    if (fieldLayer >= 0) {
                        Logger.warn(
                            `${this._logTag} [BakeProbe] field ${describeEntry(fieldEntry, fieldLayer)} ` +
                            `field=${fmtStats(fieldStats)} climate=${fmtStats(fieldClimate)} tile=${fmtStats(fieldTile)}`
                        );
                    }
                    if (propLayer >= 0) {
                        Logger.warn(
                            `${this._logTag} [BakeProbe] prop ${describeEntry(propEntry, propLayer)} ` +
                            `climate=${fmtStats(propClimate)} tile=${fmtStats(propTile)}`
                        );
                    }
                }).catch((err) => {
                    Logger.warn(`${this._logTag} [BakeProbe] failed: ${err?.message || err}`);
                }).finally(() => {
                    this._producerTextureProbePending = false;
                });
            },

        triggerLODTestKey() {
                this._treeDetailSystem?.getLeafLODTestSuite()?.handleKeyPress();
            },

        triggerLODTestCapture() {
                this._treeDetailSystem?.triggerLODTestCapture();
            },

        setLeafLODTestEnabled(enabled) {
                if (this._treeDetailSystem) {
                    this._treeDetailSystem.setTestSuiteEnabled(enabled);
                }
            },

        setMidNearRenderingEnabled(enabled) {
                this._treeMidNearSystem?.setEnabled(enabled !== false);
            },

        isLeafLODTestEnabled() {
                return this._treeDetailSystem?.isTestSuiteEnabled() ?? false;
            }
        })
    );
}
