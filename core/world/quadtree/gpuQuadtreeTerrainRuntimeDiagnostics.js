import { TileAddress } from './tileAddress.js';
import { Logger } from '../../../shared/Logger.js';
import { QuadtreeDiagSnapshot } from './gpuQuadtreeDiagnosticSnapshot.js';
import {
    getInstanceGridAddress,
    distance3,
    computeTileWorldCenter,
    projectWorldToCameraNdc,
    formatLayerStats,
    destroyWrappedTextures
} from './gpuQuadtreeDiagnosticHelpers.js';

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';
const TERRAIN_MANUAL_TAG = '[QTManual]';

export function installQuadtreeTileManagerRuntimeDiagnostics(QuadtreeTileManager) {
    Object.defineProperties(
        QuadtreeTileManager.prototype,
        Object.getOwnPropertyDescriptors({
        async _diagnosticSnapshot(tiles) {
                        if (this._diagSnapshotPending) return;
                        this._diagSnapshotPending = true;
                        try {
                          Logger.warn(`[ScatterDebug] diagnosticSnapshot start (tiles=${tiles?.length ?? 0})`);
                      
                          const maxLODLevels = (this.quadtreeGPU.maxGeomLOD + 1);
                          const diag = new QuadtreeDiagSnapshot(Logger);

                          diag.logVisibleSummary(tiles);
                          diag.logVisibleHistograms(tiles);
                          diag.logVisibleCoverageArea(tiles);
                          const distInfo = diag.logVisibleDistanceStats(tiles, this._lastCamera, this.planetConfig);
                          diag.logVisibleCoverage(tiles);
                          diag.logVisibleParentChildOverlaps(tiles);

                          const counters = await this.quadtreeGPU.readTraversalCounters?.();
                          diag.logTraversalCounters(counters);

                          // Debug angle #1: verify traversal seeds (CPU intent vs GPU captured)
                          const cpuSeeds = [];
                          for (let f = 0; f < 6; f++) {
                            cpuSeeds.push({ face: f, depth: 0, x: 0, y: 0 });
                          }
                          this.quadtreeGPU._logTraversalSeeds?.(cpuSeeds, 'QT-SeedsCPU');

                          const gpuSeeds = await this.quadtreeGPU.debugReadTraversalSeeds?.();
                          this.quadtreeGPU._logTraversalSeeds?.(gpuSeeds, 'QT-SeedsGPU');

                          let camFaceInfo = null;
                          const gpuParams = await this.quadtreeGPU.debugReadTraversalParams?.();
                          if (gpuParams) {
                            Logger.info(
                              `[QT-Diag] ParamsGPU: ` +
                              `queueCap=${gpuParams.queueCapacity} ` +
                              `maxVis=${gpuParams.maxVisibleTiles} ` +
                              `maxDepth=${gpuParams.maxDepth} ` +
                              `useFrustum=${gpuParams.useFrustum} ` +
                              `useHorizon=${gpuParams.useHorizon} ` +
                              `disableCull=${gpuParams.disableCulling} ` +
                              `faceSize=${gpuParams.faceSize.toFixed(1)} ` +
                              `planetRadius=${gpuParams.planetRadius.toFixed(1)} ` +
                              `lodFactor=${gpuParams.lodFactor.toFixed(1)} ` +
                              `lodThreshold=${gpuParams.lodErrorThreshold.toFixed(1)}`
                            );

                            const faceSize = gpuParams.faceSize;
                            const threshold = gpuParams.lodErrorThreshold;
                            const sampleRows = [
                              { label: 'S0 f1 d3 (0,0)', depth: 3, dist: gpuParams.sample0Dist, err: gpuParams.sample0Err },
                              { label: 'S1 f1 d3 (7,7)', depth: 3, dist: gpuParams.sample1Dist, err: gpuParams.sample1Err },
                              { label: 'S2 f0 d2 (0,0)', depth: 2, dist: gpuParams.sample2Dist, err: gpuParams.sample2Err }
                            ];
                            for (const s of sampleRows) {
                              if (!Number.isFinite(s.dist) || !Number.isFinite(s.err)) continue;
                              const tileWorldSize = faceSize / (1 << s.depth);
                              const split = s.err > threshold;
                              Logger.info(
                                `[QT-Diag] LOD sample ${s.label}: ` +
                                `dist=${s.dist.toFixed(1)} ` +
                                `tileSize=${tileWorldSize.toFixed(1)} ` +
                                `screenErr=${s.err.toFixed(1)} ` +
                                `split=${split}`
                              );
                            }

                            if (Number.isFinite(gpuParams.camFace)) {
                              camFaceInfo = diag.getFaceDistanceStats(
                                tiles,
                                this._lastCamera,
                                this.planetConfig,
                                gpuParams.camFace
                              );
                            }
                            if (Number.isFinite(gpuParams.camU) && Number.isFinite(gpuParams.camV)) {
                              const camAlt = gpuParams.camDist - gpuParams.planetRadius;
                              Logger.info(
                                `[QT-Diag] Cam face=${gpuParams.camFace} ` +
                                `uv=(${gpuParams.camU.toFixed(4)},${gpuParams.camV.toFixed(4)}) ` +
                                `dist=${gpuParams.camDist.toFixed(1)} alt=${camAlt.toFixed(1)}`
                              );

                              const d3Split = gpuParams.camD3Err > threshold;
                              const d6Split = gpuParams.camD6Err > threshold;
                              Logger.info(
                                `[QT-Diag] Cam tile d3=(${gpuParams.camD3X},${gpuParams.camD3Y}) ` +
                                `screenErr=${gpuParams.camD3Err.toFixed(1)} split=${d3Split}`
                              );
                              Logger.info(
                                `[QT-Diag] Cam tile d6 screenErr=${gpuParams.camD6Err.toFixed(1)} split=${d6Split}`
                              );
                            }
                          }

                          const overflowCount = await this.quadtreeGPU.debugReadTraversalOverflow?.();
                          if (overflowCount !== null && overflowCount !== undefined) {
                            Logger.info(`[QT-Diag] Queue overflow count=${overflowCount}`);
                          }

                          const debugCounters = await this.quadtreeGPU.debugReadTraversalDebugCounters?.();
                          if (debugCounters) {
                            Logger.info(
                              `[QT-Diag] Traverse debug: ` +
                              `processed=${debugCounters.nodesProcessed} ` +
                              `emitted=${debugCounters.emitted} ` +
                              `subdivided=${debugCounters.subdivided} ` +
                              `enqueued=${debugCounters.enqueued} ` +
                              `culledFrustum=${debugCounters.culledFrustum} ` +
                              `culledHorizon=${debugCounters.culledHorizon} ` +
                              `visOverflow=${debugCounters.visibleOverflow} ` +
                              `queueOverflow=${debugCounters.queueOverflow}`
                            );
                          }

                          // ScatterDebug samples should run even if meta readback fails.
                          const sampleList = [];
                          if (distInfo?.minTile) {
                            sampleList.push({ label: 'near', tile: distInfo.minTile, dist: distInfo.minDist });
                          }
                          if (distInfo?.maxTile) {
                            sampleList.push({ label: 'far', tile: distInfo.maxTile, dist: distInfo.maxDist });
                          }
                          if (camFaceInfo?.minTile) {
                            sampleList.push({ label: 'camNear', tile: camFaceInfo.minTile, dist: camFaceInfo.minDist });
                          }
                          if (camFaceInfo?.maxTile) {
                            sampleList.push({ label: 'camFar', tile: camFaceInfo.maxTile, dist: camFaceInfo.maxDist });
                          }
                          if (sampleList.length === 0 && tiles && tiles.length) {
                            const fallback = tiles[Math.floor(Math.random() * tiles.length)];
                            sampleList.push({ label: 'fallback', tile: fallback, dist: 0 });
                          }
                          await this._logTileArraySamples(sampleList);

                          const raw = await this.quadtreeGPU.debugReadMetaRaw(maxLODLevels);
                          if (!raw) {
                            Logger.warn('[ScatterDebug] diagnosticSnapshot aborted: debugReadMetaRaw returned null');
                            return;
                          }

                          const meta = diag.parseMeta(raw, maxLODLevels);
                          diag.logMeta(meta);

                          if (this._diagReadInstances) {
                            await diag.logPerLodInstanceSamples(this.quadtreeGPU, meta, maxLODLevels, 3);
                            await diag.logInstanceFaceHistogram(this.quadtreeGPU, meta, 2048);
                            const total = meta.lodArgs.reduce((sum, a) => sum + (a.instanceCount || 0), 0);
                            const readCount = Math.min(total, 4096);
                            const instances = await this.quadtreeGPU.debugReadInstancesRange(0, total, readCount);
                            diag.logInstanceCoverageAndMismatch(tiles, instances, total, readCount);
                            const textures = this.tileStreamer?.getArrayTextures?.() || null;
                            diag.logInstanceLayerStats(instances, textures);
                            // ScatterDebug samples already logged above.
                            await diag.logInstancePlacementCollisions(this.quadtreeGPU, meta, 4096);
                          }
                        } finally {
                          this._diagSnapshotPending = false;
                        }
                      },

        async _logTileArraySamples(samples, sampleSize = 8) {
                        if (!samples || samples.length === 0) {
                          Logger.warn('[ScatterDebug] Tile sample skipped: no samples provided');
                          return;
                        }
                        if (!this.tileStreamer) {
                          Logger.warn('[ScatterDebug] Tile sample skipped: tileStreamer missing');
                          return;
                        }
                        if (!this.tileStreamer.debugReadArrayLayerStats) {
                          Logger.warn('[ScatterDebug] Tile sample skipped: debugReadArrayLayerStats unavailable');
                          return;
                        }
                        const list = Array.isArray(samples) ? samples.slice() : [];
                        if (list.length === 0) return;

                        const types = ['tile', 'height'];
                        if (this.tileStreamer.enableSplat) types.push('splatData');

                        const grouped = new Map();
                        for (const s of list) {
                          const t = s.tile;
                          if (!t) continue;
                          const key = `f${t.face}:d${t.depth}:${t.x},${t.y}`;
                          const existing = grouped.get(key);
                          if (existing) {
                            existing.labels.push(s.label);
                            if (Math.abs(existing.dist - s.dist) > 0.01) {
                              existing.dist = Math.min(existing.dist, s.dist);
                            }
                            continue;
                          }
                          grouped.set(key, { tile: t, dist: s.dist, labels: [s.label] });
                        }
                        for (const entry of grouped.values()) {
                          const t = entry.tile;
                          const lookup = this.tileStreamer.debugLookup(t.face, t.depth, t.x, t.y);
                          if (!lookup?.found) continue;
                      
                          const scatterStats = await this.tileStreamer.debugReadArrayLayerStats(
                              'scatter', lookup.layer, 8);
                          if (scatterStats) {
                              Logger.info(
                                  `[ScatterDebug] Tile ${entry.labels.join('|')}: ` +
                                  `f${t.face} d${t.depth} (${t.x},${t.y}) ` +
                                  `scatter min=${scatterStats.min[0].toFixed(3)} ` +
                                  `max=${scatterStats.max[0].toFixed(3)} ` +
                                  `mean=${scatterStats.mean[0].toFixed(3)} ` +
                                  `zero=${scatterStats.zeroCount}`
                              );
                          }
                      }
                        for (const entry of grouped.values()) {
                          const t = entry.tile;
                          const lookup = this.tileStreamer.debugLookup(t.face, t.depth, t.x, t.y);
                          if (!lookup?.found) {
                            Logger.warn(
                              `[ScatterDebug] Tile sample ${entry.labels.join('|')}: lookup failed ` +
                              `f${t.face} d${t.depth} (${t.x},${t.y})`
                            );
                            continue;
                          }

                          Logger.info(
                            `[ScatterDebug] Tile sample ${entry.labels.join('|')}: ` +
                            `f${t.face} d${t.depth} (${t.x},${t.y}) dist=${entry.dist.toFixed(1)} layer=${lookup.layer}`
                          );

                          let tileId = null;
                          let heightStats = null;
                          const uniforms = this.tileStreamer?.terrainGenerator?._getTerrainShaderUniforms?.();
                          const wp = Array.isArray(uniforms?.waterParams) ? uniforms.waterParams : [0, 0, 0, 0];
                          const oceanLevel = wp[1];

                          for (const type of types) {
                            const threshold = (type === 'height') ? oceanLevel : null;
                            const stats = await this.tileStreamer.debugReadArrayLayerStats(type, lookup.layer, sampleSize, threshold);
                            if (!stats) {
                              Logger.warn(`[ScatterDebug] Tile sample ${entry.labels.join('|')}: ${type} read failed (layer=${lookup.layer})`);
                              continue;
                            }
                            const minStr = stats.min.map(v => v.toFixed(3)).join(',');
                            const maxStr = stats.max.map(v => v.toFixed(3)).join(',');
                            const meanStr = stats.mean.map(v => v.toFixed(3)).join(',');
                            Logger.info(
                              `[ScatterDebug] Tile sample ${entry.labels.join('|')}: ${type} ` +
                              `format=${stats.format} size=${stats.size} ` +
                              `min=[${minStr}] max=[${maxStr}] mean=[${meanStr}] ` +
                              `nan=${stats.nanCount} zero0=${stats.zeroCount}`
                            );
                            if (type === 'tile' && stats.mean?.length) {
                              const tid = Math.round(stats.mean[0] * 255);
                              tileId = tid;
                              Logger.info(
                                `[ScatterDebug] Tile sample ${entry.labels.join('|')}: tileId≈${tid} ` +
                                `(mean=${stats.mean[0].toFixed(3)}) feature=${tid >= 100}`
                              );
                            } else if (type === 'splatData' && stats.mean?.length >= 4) {
                              const w1 = stats.mean[0];
                              const tid1 = Math.round(stats.mean[1] * 255);
                              const w2 = stats.mean[2];
                              const tid2 = Math.round(stats.mean[3] * 255);
                              Logger.info(
                                `[ScatterDebug] Tile sample ${entry.labels.join('|')}: splat≈` +
                                `w1=${w1.toFixed(3)} tid1=${tid1} ` +
                                `w2=${w2.toFixed(3)} tid2=${tid2}`
                              );
                            } else if (type === 'height') {
                              heightStats = stats;
                            }
                          }

                            if (tileId !== null && tileId <= 1) {
                            if (heightStats) {
                              Logger.warn(
                                `[New-QT] Water tile sample ${entry.labels.join('|')}: ` +
                                `f${t.face} d${t.depth} (${t.x},${t.y}) ` +
                                `hasOceans=${wp[0]} oceanLevel=${wp[1]} ` +
                                `height[min=${heightStats.min?.[0]?.toFixed(3)} ` +
                                `max=${heightStats.max?.[0]?.toFixed(3)} mean=${heightStats.mean?.[0]?.toFixed(3)} ` +
                                `belowOcean=${(heightStats.belowRatio * 100).toFixed(1)}%]`
                              );
                            } else {
                              Logger.warn(
                                `[New-QT] Water tile sample ${entry.labels.join('|')}: ` +
                                `f${t.face} d${t.depth} (${t.x},${t.y}) ` +
                                `hasOceans=${wp[0]} oceanLevel=${wp[1]} height=unavailable`
                              );
                            }
                          }
                        }
                    },

        _shouldLogDiag() {
                      return false;
                        // eslint-disable-next-line no-unreachable
                        const interval = this._diagInterval ?? 0;
                        if (!Number.isFinite(interval) || interval <= 0) return false;
                        this._diagFrame = (this._diagFrame + 1) % interval;
                        return this._diagFrame === 0;
                    },

        _buildVisibleResidencySummary(tiles) {
                        const summary = {
                            totalVisible: Array.isArray(tiles) ? tiles.length : 0,
                            residentVisible: 0,
                            fallbackVisible: 0,
                            unresolvedVisible: 0,
                            ownVisibleNotReady: 0,
                            fallbackVisibleNotReady: 0,
                            residentOwnerMismatch: 0,
                            fallbackOwnerMismatch: 0,
                            samples: []
                        };
                        if (!Array.isArray(tiles) || tiles.length === 0 || !this.tileStreamer) {
                            return summary;
                        }

                        for (const tile of tiles) {
                            const visibleKey = this.tileStreamer._makeKey(tile.face, tile.depth, tile.x, tile.y);
                            const residentInfo = this.tileStreamer._tileInfo.get(visibleKey);
                            if (residentInfo) {
                                summary.residentVisible++;
                                const owner = this.tileStreamer.getLayerDebugInfo?.(residentInfo.layer);
                                const state = owner?.copyState ?? 'unknown';
                                if (state !== 'ready') {
                                    summary.ownVisibleNotReady++;
                                }
                                if ((owner?.ownerKey ?? null) !== visibleKey) {
                                    summary.residentOwnerMismatch++;
                                    if (summary.samples.length < 12) {
                                        summary.samples.push(
                                            `resident f${tile.face}:d${tile.depth}:${tile.x},${tile.y} ` +
                                            `L${residentInfo.layer} owner=${owner?.ownerKey ?? 'null'} state=${state}`
                                        );
                                    }
                                }
                                continue;
                            }

                            let depth = tile.depth;
                            let x = tile.x;
                            let y = tile.y;
                            let fallbackInfo = null;
                            let fallbackKey = '';
                            while (depth > 0) {
                                depth--;
                                x >>= 1;
                                y >>= 1;
                                fallbackKey = this.tileStreamer._makeKey(tile.face, depth, x, y);
                                fallbackInfo = this.tileStreamer._tileInfo.get(fallbackKey);
                                if (fallbackInfo) {
                                    break;
                                }
                            }
                            if (!fallbackInfo) {
                                summary.unresolvedVisible++;
                                if (summary.samples.length < 12) {
                                    summary.samples.push(`missing f${tile.face}:d${tile.depth}:${tile.x},${tile.y}`);
                                }
                                continue;
                            }

                            summary.fallbackVisible++;
                            const owner = this.tileStreamer.getLayerDebugInfo?.(fallbackInfo.layer);
                            const state = owner?.copyState ?? 'unknown';
                            if (state !== 'ready') {
                                summary.fallbackVisibleNotReady++;
                            }
                            if ((owner?.ownerKey ?? null) !== fallbackKey) {
                                summary.fallbackOwnerMismatch++;
                                if (summary.samples.length < 12) {
                                    summary.samples.push(
                                        `fallback f${tile.face}:d${tile.depth}:${tile.x},${tile.y} ` +
                                        `via=f${tile.face}:d${depth}:${x},${y} L${fallbackInfo.layer} ` +
                                        `owner=${owner?.ownerKey ?? 'null'} state=${state}`
                                    );
                                }
                            }
                        }

                        return summary;
                    },

        _logManualRuntimeSummary(tiles) {
                        const runtime = this._buildVisibleResidencySummary(tiles);
                        const copyState = this.tileStreamer?.getCopyStateSummary?.() ?? null;
                        const hashStats = this.tileStreamer?.getHashTableStats?.() ?? null;
                        const genQueue = this.tileStreamer?._generationQueue;
                        const queuePending = genQueue?.queue?.length ?? 0;
                        const queueActive = genQueue?.active ?? 0;
                        const pendingCopies = this.tileStreamer?.arrayPool?._pendingCopies?.length ?? 0;
                        const dirtySlots = this.tileStreamer?._dirtySlots?.size ?? 0;
                        const poolUsed = this.tileStreamer?._tileInfo?.size ?? 0;
                        const poolTotal = this.tileStreamer?.tilePoolSize ?? 0;
                        const freeLayers = this.tileStreamer?.arrayPool?.freeLayers?.length ?? 0;
                        const visibleCount = Array.isArray(tiles) ? tiles.length : 0;

                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} runtime visible=${visibleCount} ` +
                            `resident=${runtime.residentVisible} fallback=${runtime.fallbackVisible} ` +
                            `missing=${runtime.unresolvedVisible} ownNotReady=${runtime.ownVisibleNotReady} ` +
                            `fallbackNotReady=${runtime.fallbackVisibleNotReady} ` +
                            `ownerMismatch=${runtime.residentOwnerMismatch + runtime.fallbackOwnerMismatch}`
                        );
                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} runtime pool=${poolUsed}/${poolTotal} freeLayers=${freeLayers} ` +
                            `pendingGen=${queuePending} activeGen=${queueActive} pendingCopies=${pendingCopies} dirtySlots=${dirtySlots}`
                        );
                        if (copyState) {
                            Logger.warn(
                                `${TERRAIN_MANUAL_TAG} runtime copies tracked=${copyState.trackedLayers} queued=${copyState.queued} ` +
                                `submitted=${copyState.submitted} ready=${copyState.ready} failed=${copyState.failed}`
                            );
                        }
                        if (hashStats) {
                            Logger.warn(
                                `${TERRAIN_MANUAL_TAG} runtime hash entries=${hashStats.totalEntries} ` +
                                `cpuCap=${hashStats.hashTableCapacity} gpuCap=${hashStats.gpuTableCapacity} ` +
                                `maskMatch=${hashStats.maskMatch ? 1 : 0} capMatch=${hashStats.capacityMatch ? 1 : 0}`
                            );
                        }
                        if (runtime.samples.length > 0) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} runtime samples ${runtime.samples.join(' ; ')}`);
                        }
                        return {
                            visible: visibleCount,
                            ...runtime,
                            copyState,
                            hashStats: hashStats
                                ? {
                                    totalEntries: hashStats.totalEntries,
                                    hashTableCapacity: hashStats.hashTableCapacity,
                                    gpuTableCapacity: hashStats.gpuTableCapacity,
                                    maskMatch: hashStats.maskMatch,
                                    capacityMatch: hashStats.capacityMatch
                                }
                                : null,
                            poolUsed,
                            poolTotal,
                            freeLayers,
                            queuePending,
                            queueActive,
                            pendingCopies,
                            dirtySlots
                        };
                    },

        async _readAllVisibleInstancesForManualAudit() {
                        const maxLodLevels = this.quadtreeGPU?.lodLevels ?? 0;
                        if (!(maxLodLevels > 0)) {
                            return { instances: [], byKey: new Map(), duplicateCounts: new Map() };
                        }
                        const metaRaw = await this.quadtreeGPU?.debugReadMetaRaw?.(maxLodLevels);
                        const meta = this._parseMetaRaw(metaRaw, maxLodLevels);
                        const total = Array.isArray(meta?.lodArgs)
                            ? meta.lodArgs.reduce((sum, item) => sum + (item.instanceCount || 0), 0)
                            : 0;
                        if (!(total > 0)) {
                            return { instances: [], byKey: new Map(), duplicateCounts: new Map() };
                        }
                        const readCount = Math.min(total, 4096);
                        const instances = await this.quadtreeGPU?.debugReadInstancesRange?.(0, total, readCount) ?? [];
                        const byKey = new Map();
                        const duplicateCounts = new Map();
                        for (const inst of instances) {
                            const addr = getInstanceGridAddress(inst);
                            const key = addr
                                ? this.tileStreamer?._makeKey?.(addr.face, addr.depth, addr.x, addr.y)
                                : '';
                            if (key && !byKey.has(key)) {
                                byKey.set(key, inst);
                            }
                            if (key) {
                                duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
                            }
                        }
                        return { instances, byKey, duplicateCounts };
                    },

        _resolveVisibleTileSource(tile) {
                        if (!tile || !this.tileStreamer) {
                            return null;
                        }
                        const visibleKey = this.tileStreamer._makeKey(tile.face, tile.depth, tile.x, tile.y);
                        const residentInfo = this.tileStreamer._tileInfo.get(visibleKey);
                        if (residentInfo) {
                            return {
                                relation: 'resident',
                                visibleKey,
                                sourceKey: visibleKey,
                                sourceFace: tile.face,
                                sourceDepth: tile.depth,
                                sourceX: tile.x,
                                sourceY: tile.y,
                                layer: residentInfo.layer,
                                depthDelta: 0
                            };
                        }

                        let depth = tile.depth;
                        let x = tile.x;
                        let y = tile.y;
                        while (depth > 0) {
                            depth--;
                            x >>= 1;
                            y >>= 1;
                            const sourceKey = this.tileStreamer._makeKey(tile.face, depth, x, y);
                            const info = this.tileStreamer._tileInfo.get(sourceKey);
                            if (!info) continue;
                            return {
                                relation: 'fallback',
                                visibleKey,
                                sourceKey,
                                sourceFace: tile.face,
                                sourceDepth: depth,
                                sourceX: x,
                                sourceY: y,
                                layer: info.layer,
                                depthDelta: tile.depth - depth
                            };
                        }

                        return {
                            relation: 'missing',
                            visibleKey,
                            sourceKey: '',
                            sourceFace: tile.face,
                            sourceDepth: tile.depth,
                            sourceX: tile.x,
                            sourceY: tile.y,
                            layer: -1,
                            depthDelta: 0
                        };
                    },

        _selectManualAuditTargets(tiles, instanceByKey) {
                        const list = Array.isArray(tiles) ? tiles : [];
                        if (list.length === 0) {
                            return [];
                        }

                        const visibleByKey = new Map();
                        const candidates = [];
                        for (const tile of list) {
                            const key = this.tileStreamer?._makeKey(tile.face, tile.depth, tile.x, tile.y);
                            if (!key) continue;
                            visibleByKey.set(key, tile);
                            const world = computeTileWorldCenter(tile, this.planetConfig);
                            const projection = projectWorldToCameraNdc(world, this._lastCamera);
                            const camDist = distance3(world, this._lastCamera?.position);
                            const centerDist = projection && projection.inFront
                                ? Math.hypot(projection.ndcX, projection.ndcY)
                                : Infinity;
                            candidates.push({
                                key,
                                tile,
                                source: this._resolveVisibleTileSource(tile),
                                inst: instanceByKey?.get(key) ?? null,
                                world,
                                projection,
                                camDist,
                                centerDist
                            });
                        }
                        const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));

                        const selected = [];
                        const seen = new Set();
                        const push = (candidate, reason) => {
                            if (!candidate || seen.has(candidate.key)) return;
                            seen.add(candidate.key);
                            selected.push({ ...candidate, reason });
                        };
                        const pushNeighbors = (candidate, labelPrefix) => {
                            if (!candidate?.tile) return;
                            const { face, depth, x, y } = candidate.tile;
                            const neighbors = [
                                { dx: -1, dy: 0, label: `${labelPrefix}:left` },
                                { dx: 1, dy: 0, label: `${labelPrefix}:right` },
                                { dx: 0, dy: -1, label: `${labelPrefix}:bottom` },
                                { dx: 0, dy: 1, label: `${labelPrefix}:top` }
                            ];
                            for (const neighbor of neighbors) {
                                const key = this.tileStreamer?._makeKey(face, depth, x + neighbor.dx, y + neighbor.dy);
                                if (!key || !visibleByKey.has(key)) continue;
                                push(candidateByKey.get(key) ?? null, neighbor.label);
                            }
                        };

                        const centerCandidates = candidates
                            .filter((item) => item.projection?.inFront)
                            .sort((a, b) => a.centerDist - b.centerDist);
                        const nearCandidates = candidates
                            .filter((item) => Number.isFinite(item.camDist))
                            .sort((a, b) => a.camDist - b.camDist);
                        const fallbackCenterCandidates = centerCandidates
                            .filter((item) => item.source?.relation === 'fallback');
                        const fallbackNearCandidates = nearCandidates
                            .filter((item) => item.source?.relation === 'fallback');

                        const centerPrimary = centerCandidates[0] ?? null;
                        push(centerPrimary, 'center#1');
                        pushNeighbors(centerPrimary, 'center#1-neighbor');
                        push(centerCandidates[1] ?? null, 'center#2');
                        pushNeighbors(centerCandidates[1] ?? null, 'center#2-neighbor');
                        push(centerCandidates[2] ?? null, 'center#3');
                        push(centerCandidates[3] ?? null, 'center#4');
                        push(nearCandidates[0] ?? null, 'near#1');
                        push(nearCandidates[1] ?? null, 'near#2');
                        push(fallbackCenterCandidates[0] ?? null, 'fallback-center#1');
                        pushNeighbors(fallbackCenterCandidates[0] ?? null, 'fallback-center#1-neighbor');
                        push(fallbackCenterCandidates[1] ?? null, 'fallback-center#2');
                        push(fallbackNearCandidates[0] ?? null, 'fallback-near#1');
                        push(fallbackNearCandidates[1] ?? null, 'fallback-near#2');

                        return selected.slice(0, 12);
                    },

        async _auditVisibleTileTarget(target) {
                        const source = target?.source;
                        if (!target?.tile || !source) {
                            return;
                        }
                        const sourceAddr = new TileAddress(source.sourceFace, source.sourceDepth, source.sourceX, source.sourceY);
                        const layer = Number.isFinite(target?.inst?.layer) ? target.inst.layer : source.layer;
                        const instUvScale = target?.inst?.uvScale ?? NaN;
                        const expectedUvScale = source.relation === 'fallback'
                            ? Math.pow(0.5, Math.max(0, source.depthDelta))
                            : 1.0;
                        const projection = target.projection;
                        const owner = this.tileStreamer?.getLayerDebugInfo?.(layer) ?? null;
                        const fullTileSample = Math.max(8, Math.min(this.tileStreamer?.tileTextureSize ?? 128, 128));

                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} audit-target reason=${target.reason} ` +
                            `visible=${source.visibleKey} source=${source.sourceKey || 'none'} relation=${source.relation} ` +
                            `layer=${layer} instLayer=${target?.inst?.layer ?? 'n/a'} ` +
                            `lod=${target?.inst?.lod ?? 'n/a'} edgeMask=${target?.inst?.edgeMask ?? 'n/a'} ` +
                            `uvScale=${Number.isFinite(instUvScale) ? instUvScale.toFixed(4) : 'n/a'} ` +
                            `expectedUvScale=${expectedUvScale.toFixed(4)} ` +
                            `owner=${owner?.ownerKey ?? 'null'} ownerState=${owner?.copyState ?? 'unknown'} ` +
                            `centerDist=${Number.isFinite(target.centerDist) ? target.centerDist.toFixed(4) : 'inf'} ` +
                            `camDist=${Number.isFinite(target.camDist) ? target.camDist.toFixed(1) : 'n/a'} ` +
                            `ndc=${projection ? `${projection.ndcX.toFixed(3)},${projection.ndcY.toFixed(3)},${projection.ndcZ.toFixed(3)}` : 'n/a'}`
                        );

                        if (source.relation === 'missing' || !(layer >= 0)) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} audit-target skipped visible=${source.visibleKey} reason=no-layer`);
                            return;
                        }

                        const liveHeightStats = await this.tileStreamer?.debugReadArrayLayerStats?.('height', layer, fullTileSample);
                        const liveTileStats = await this.tileStreamer?.debugReadArrayLayerStats?.('tile', layer, fullTileSample);
                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} audit-live source=${source.sourceKey} ` +
                            `height{${formatLayerStats(liveHeightStats)}} tile{${formatLayerStats(liveTileStats)}}`
                        );

                        let freshTextures = null;
                        try {
                            freshTextures = await this.tileStreamer?.tileGenerator?.generateDiagnosticTile?.(sourceAddr, {
                                includeBaseHeight: true
                            });
                            if (!freshTextures) {
                                Logger.warn(`${TERRAIN_MANUAL_TAG} audit-fresh failed source=${source.sourceKey}`);
                                return;
                            }
                            const heightCompare = await this._debugCompareLiveTextureToFreshDense(
                                'height',
                                layer,
                                freshTextures.height,
                                source.sourceKey,
                                2
                            );
                            const tileCompare = await this._debugCompareLiveTextureToFreshDense(
                                'tile',
                                layer,
                                freshTextures.tile,
                                source.sourceKey,
                                4
                            );
                            const baseCompare = await this._debugCompareLiveTextureToFreshDense(
                                'height',
                                layer,
                                freshTextures.baseHeight,
                                source.sourceKey,
                                2
                            );
                            Logger.warn(
                                `${TERRAIN_MANUAL_TAG} audit-dense source=${source.sourceKey} ` +
                                `height{${heightCompare}} tile{${tileCompare}} baseHeight{${baseCompare}}`
                            );
                        } finally {
                            destroyWrappedTextures(freshTextures);
                        }
                    },

        async _runManualTileAudit(tiles) {
                        const { instances, byKey, duplicateCounts } = await this._readAllVisibleInstancesForManualAudit();
                        const coverageSamples = [];
                        let exactVisible = 0;
                        let visibleWithoutExact = 0;
                        let residentWithoutExact = 0;
                        let fallbackWithoutExact = 0;
                        let duplicateVisible = 0;
                        for (const tile of Array.isArray(tiles) ? tiles : []) {
                            const visibleKey = this.tileStreamer?._makeKey?.(tile.face, tile.depth, tile.x, tile.y);
                            if (!visibleKey) continue;
                            const hasExact = byKey.has(visibleKey);
                            const source = this._resolveVisibleTileSource(tile);
                            if (hasExact) {
                                exactVisible++;
                                if ((duplicateCounts.get(visibleKey) || 0) > 1) {
                                    duplicateVisible++;
                                }
                                continue;
                            }
                            visibleWithoutExact++;
                            if (source?.relation === 'resident') {
                                residentWithoutExact++;
                            } else if (source?.relation === 'fallback') {
                                fallbackWithoutExact++;
                            }
                            if (coverageSamples.length < 10) {
                                coverageSamples.push(
                                    `${visibleKey}:${source?.relation ?? 'unknown'}${source?.sourceKey ? `->${source.sourceKey}` : ''}`
                                );
                            }
                        }
                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} audit-coverage visible=${tiles?.length ?? 0} ` +
                            `exact=${exactVisible} missingExact=${visibleWithoutExact} ` +
                            `residentMissing=${residentWithoutExact} fallbackMissing=${fallbackWithoutExact} ` +
                            `duplicateVisible=${duplicateVisible}`
                        );
                        if (coverageSamples.length > 0) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} audit-coverage samples ${coverageSamples.join(' ; ')}`);
                        }

                        const consistencySamples = [];
                        let exactResident = 0;
                        let exactFallback = 0;
                        let consistentExact = 0;
                        let ownerMismatchCount = 0;
                        let uvScaleMismatchCount = 0;
                        let cpuLookupMismatchCount = 0;
                        let exactFallbackWithUnitScale = 0;
                        for (const tile of Array.isArray(tiles) ? tiles : []) {
                            const visibleKey = this.tileStreamer?._makeKey?.(tile.face, tile.depth, tile.x, tile.y);
                            if (!visibleKey) continue;
                            const inst = byKey.get(visibleKey);
                            if (!inst) continue;
                            const source = this._resolveVisibleTileSource(tile);
                            const owner = this.tileStreamer?.getLayerDebugInfo?.(inst.layer) ?? null;
                            const expectedUvScale = source?.relation === 'fallback'
                                ? Math.pow(0.5, Math.max(0, source.depthDelta))
                                : 1.0;
                            const cpuLookup = this.tileStreamer?.debugLookup?.(tile.face, tile.depth, tile.x, tile.y) ?? null;
                            const ownerMatches = (owner?.ownerKey ?? null) === (source?.sourceKey ?? null);
                            const uvScaleMatches = Number.isFinite(inst.uvScale)
                                ? Math.abs(inst.uvScale - expectedUvScale) <= 0.001
                                : false;
                            const cpuLookupMatches = source?.relation === 'resident'
                                ? (!!cpuLookup?.found && cpuLookup.layer === inst.layer)
                                : !cpuLookup?.found;

                            if (source?.relation === 'resident') {
                                exactResident++;
                            } else if (source?.relation === 'fallback') {
                                exactFallback++;
                                if (Number.isFinite(inst.uvScale) && Math.abs(inst.uvScale - 1.0) <= 0.001) {
                                    exactFallbackWithUnitScale++;
                                }
                            }
                            if (ownerMatches && uvScaleMatches && cpuLookupMatches) {
                                consistentExact++;
                                continue;
                            }
                            if (!ownerMatches) ownerMismatchCount++;
                            if (!uvScaleMatches) uvScaleMismatchCount++;
                            if (!cpuLookupMatches) cpuLookupMismatchCount++;
                            if (consistencySamples.length < 12) {
                                consistencySamples.push(
                                    `${visibleKey}:${source?.relation ?? 'unknown'} ` +
                                    `instL=${inst.layer} owner=${owner?.ownerKey ?? 'null'} ` +
                                    `cpu=${cpuLookup?.found ? `L${cpuLookup.layer}` : 'MISS'} ` +
                                    `uv=${Number.isFinite(inst.uvScale) ? inst.uvScale.toFixed(3) : 'n/a'} ` +
                                    `expUv=${expectedUvScale.toFixed(3)} edge=${inst.edgeMask ?? 'n/a'}`
                                );
                            }
                        }
                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} audit-instance visible=${tiles?.length ?? 0} exact=${exactVisible} ` +
                            `resident=${exactResident} fallback=${exactFallback} consistent=${consistentExact} ` +
                            `ownerMismatch=${ownerMismatchCount} uvMismatch=${uvScaleMismatchCount} ` +
                            `cpuLookupMismatch=${cpuLookupMismatchCount} fallbackUnitScale=${exactFallbackWithUnitScale}`
                        );
                        if (consistencySamples.length > 0) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} audit-instance samples ${consistencySamples.join(' ; ')}`);
                        }

                        const targets = this._selectManualAuditTargets(tiles, byKey);
                        if (targets.length === 0) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} audit-targets none`);
                            return;
                        }
                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} audit-targets visible=${tiles?.length ?? 0} ` +
                            `instances=${instances.length} selected=${targets.length} ` +
                            `${targets.map((target) => `${target.reason}:${target.source?.visibleKey ?? target.key}`).join(' ; ')}`
                        );
                        for (const target of targets) {
                            await this._auditVisibleTileTarget(target);
                        }
                    },

        async _runManualDiagnosticSnapshot() {
                        if (!this._manualDiagState?.frozen || this._manualDiagState.running) {
                            return;
                        }

                        const snapshotId = this._manualDiagState.snapshotId;
                        const startedAt = performance.now();
                        this._manualDiagState = {
                            ...this._manualDiagState,
                            status: 'running',
                            running: true,
                            completed: false,
                            startedAt,
                            error: ''
                        };

                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} snapshot begin id=${snapshotId} reason=${this._manualDiagState.reason}`
                        );

                        try {
                            const cfg = this.engineConfig?.gpuQuadtree;
                            const maxTiles = (cfg?.visibleReadbackMax && cfg.visibleReadbackMax > 0)
                                ? cfg.visibleReadbackMax
                                : (cfg?.maxVisibleTiles ?? 0);
                            let tiles = await this.quadtreeGPU?.readVisibleTiles?.(maxTiles);
                            if (!Array.isArray(tiles) || tiles.length === 0) {
                                tiles = Array.isArray(this._lastVisibleTiles) ? this._lastVisibleTiles : [];
                            } else {
                                this._lastVisibleTiles = tiles;
                            }

                            const summary = this._logManualRuntimeSummary(tiles);
                            await this._runManualTileAudit(tiles);
                            await this._runCrossFaceVisibleSeamDiagnostics(tiles);
                            await this._diagnosticSnapshot(tiles);
                            await this._runStitchingDiagnostics();

                            const finishedAt = performance.now();
                            this._manualDiagState = {
                                ...this._manualDiagState,
                                status: 'frozen',
                                running: false,
                                completed: true,
                                finishedAt,
                                durationMs: finishedAt - startedAt,
                                lastSummary: summary,
                                error: ''
                            };
                            Logger.warn(
                                `${TERRAIN_MANUAL_TAG} snapshot complete id=${snapshotId} ` +
                                `durationMs=${(finishedAt - startedAt).toFixed(1)} press=U to release`
                            );
                        } catch (err) {
                            const finishedAt = performance.now();
                            this._manualDiagState = {
                                ...this._manualDiagState,
                                status: 'frozen',
                                running: false,
                                completed: true,
                                finishedAt,
                                durationMs: finishedAt - startedAt,
                                error: err?.message ?? String(err)
                            };
                            Logger.error(
                                `${TERRAIN_MANUAL_TAG} snapshot failed id=${snapshotId} ${err?.stack ?? err}`
                            );
                        }
                    },

        _maybeLogLightweightDiagnostics() {
                        const interval = 120;
                        this._lightDiagFrame = (this._lightDiagFrame + 1) % interval;
                        if (this._lightDiagFrame !== 0) {
                            return;
                        }

                        const copyState = this.tileStreamer?.getCopyStateSummary?.() ?? null;
                        const visible = copyState?.lastVisible ?? null;
                        const queuePending = this.tileStreamer?._generationQueue?.queue?.length ?? 0;
                        const queueActive = this.tileStreamer?._generationQueue?.active ?? 0;
                        const pendingCopies = this.tileStreamer?.arrayPool?._pendingCopies?.length ?? 0;
                        const dirtySlots = this.tileStreamer?._dirtySlots?.size ?? 0;
                        const poolUsed = this.tileStreamer?._tileInfo?.size ?? 0;
                        const poolTotal = this.tileStreamer?.tilePoolSize ?? 0;
                        const pressure = this.tileStreamer?.consumePressureWindow?.() ?? null;
                        const gpuInFlight = this.tileStreamer?.tileGenerator?._gpuFencesInFlight ?? 0;
                        const lodScale = this._lodSpeedScale;
                        const lodVisibleScale = this._lodVisibleScale;
                        const prevPending = this._lastLightDiagPendingGen;
                        const pendingDelta = Number.isFinite(prevPending) ? (queuePending - prevPending) : 0;
                        this._lastLightDiagPendingGen = queuePending;
                        const pendingDeltaStr = pendingDelta > 0 ? `+${pendingDelta}` : `${pendingDelta}`;

                        Logger.info(
                            `${TERRAIN_STEP_LOG_TAG} [QTLight] pool=${poolUsed}/${poolTotal} ` +
                            `pendingGen=${queuePending}(${pendingDeltaStr}) activeGen=${queueActive} ` +
                            `pendingCopies=${pendingCopies} dirtySlots=${dirtySlots} ` +
                            `gpuInFlight=${gpuInFlight} lodScale=${lodScale.toFixed(2)} ` +
                            `visibleScale=${lodVisibleScale.toFixed(2)}` +
                            `${pressure ? ` bpSkips=${pressure.gpuBackpressureSkips} started=${pressure.tilesStarted} gpuMax=${pressure.gpuFencesMax} commits=${pressure.commits} staleStarts=${pressure.staleStarts.stale}/${pressure.staleStarts.started} feedbackReadbacks=${pressure.feedback.readbacks} minFree=${pressure.minFreeLayers ?? 'n/a'} queueRejected=${pressure.queueRejected} queueDropped=${pressure.queueDropped}` : ''}` +
                            `${visible ? ` visible=${visible.totalVisible} resident=${visible.residentVisible} fallback=${visible.fallbackVisible}` : ''}`
                        );

                        if (pressure && (pressure.requestLatency.total > 0 || pressure.staleStarts.started > 0)) {
                            Logger.info(
                                `${TERRAIN_STEP_LOG_TAG} [QTLight] requestLatency=${pressure.requestLatency.summary} ` +
                                `latencyMax=${pressure.requestLatency.maxMs.toFixed(0)}ms ` +
                                `startVisible=${pressure.staleStarts.visible} startAncestor=${pressure.staleStarts.ancestor} startUnknown=${pressure.staleStarts.unknown}`
                            );
                        }
                    },

        async _maybeReadbackVisibleTiles() {
                 
                    const cfg = this.engineConfig?.gpuQuadtree;
                    if (!cfg) return;
                  
                    const interval = cfg.visibleReadbackInterval ?? 0;
                    if (interval <= 0) return;
                  
                    this._visibleReadbackFrame = (this._visibleReadbackFrame + 1) % interval;
                    if (this._visibleReadbackFrame !== 0) return;
                    if (this._visibleReadbackPending) return;
                  
                    const maxTiles = (cfg.visibleReadbackMax && cfg.visibleReadbackMax > 0)
                      ? cfg.visibleReadbackMax
                      : cfg.maxVisibleTiles;
                  
                    this._visibleReadbackPending = true;
                    const shouldDiag = this._shouldLogDiag();
                    try {
                      const tiles = await this.quadtreeGPU.readVisibleTiles(maxTiles);
                      this._lastVisibleTiles = tiles;

                      this.tileStreamer?.markTilesVisible?.(tiles);
                  
                      if (shouldDiag) {
                        await this._maybeDiagnosticLog?.(tiles);     // IMPORTANT: await if it does GPU readbacks
                        await this._diagnosticSnapshot?.(tiles);     // IMPORTANT: await snapshot (serialization)
                      }
                    } catch (e) {
                      // optional: Logger.warn(`[QT] visible readback failed: ${e?.message ?? e}`);
                    } finally {
                      this._visibleReadbackPending = false;
                    }
                  },

        async debugReadGPUHashTable() {
                        const buffer = this.tileStreamer?.quadtreeGPU?._loadedTableBuffer;
                        if (!buffer) return null;
                        
                        const capacity =
                            this.tileStreamer?.quadtreeGPU?.getLoadedTileTableCapacity?.()
                            ?? this.tileStreamer?.quadtreeGPU?.loadedTableCapacity
                            ?? this.tileStreamer?.hashTable?.capacity
                            ?? 8192;
                        const entryBytes = 16; // LoadedEntry is 4× u32
                        const totalBytes = capacity * entryBytes;
                        
                        const staging = this.backend.device.createBuffer({
                            size: totalBytes,
                            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                        });
                        
                        const encoder = this.backend.device.createCommandEncoder();
                        encoder.copyBufferToBuffer(buffer, 0, staging, 0, totalBytes);
                        this.backend.device.queue.submit([encoder.finish()]);
                        
                        await staging.mapAsync(GPUMapMode.READ);
                        const data = new Uint32Array(staging.getMappedRange());
                        
                        const entries = [];
                        for (let i = 0; i < capacity; i++) {
                            const base = i * 4;
                            entries.push({
                                keyLo: data[base],
                                keyHi: data[base + 1],
                                layer: data[base + 2],
                                _pad: data[base + 3]
                            });
                        }
                        
                        staging.unmap();
                        staging.destroy();
                        return entries;
                    },

        async _maybeDiagnosticLog(tiles) {
                        if (this._diagReadInstances) {
                            await this.quadtreeGPU.debugReadInstances(100);
                        }
                        await this.quadtreeGPU.debugReadMetaBuffer();

                        // Depth histogram
                        const depthHist = {};
                        for (const t of tiles) {
                            depthHist[t.depth] = (depthHist[t.depth] || 0) + 1;
                        }
                        const histStr = Object.entries(depthHist)
                            .sort((a, b) => +a[0] - +b[0])
                            .map(([d, c]) => `d${d}:${c}`)
                            .join(' ');

                        // Pool occupancy
                        const poolTotal = this.tileStreamer?.tilePoolSize ?? 0;
                        const poolUsed = this.tileStreamer?._tileInfo?.size ?? 0;
                        const poolFree = this.tileStreamer?.arrayPool?.freeLayers?.length ?? 0;

                        // Generation queue state
                        const genQueue = this.tileStreamer?._generationQueue;
                        const queuePending = genQueue?.queue?.length ?? 0;
                        const queueActive = genQueue?.active ?? 0;

                        // Visible vs cap
                        const maxVis = this.engineConfig?.gpuQuadtree?.maxVisibleTiles ?? 0;

                        Logger.info(
                            `[Debug frame] visible=${tiles.length}/${maxVis} | ` +
                            `pool=${poolUsed}/${poolTotal} (free=${poolFree}) | ` +
                            `genQueue=${queuePending} pending, ${queueActive} active | ` +
                            `depths: ${histStr}`
                        );

                        // Hash table diagnostic
                        const hashStats = this.tileStreamer?.getHashTableStats?.();
                        if (hashStats) {
                            const htByDepth = Object.entries(hashStats.byDepth)
                                .sort((a, b) => +a[0] - +b[0])
                                .map(([d, c]) => `d${d}:${c}`)
                                .join(' ');
                            Logger.info(
                                `[Debug frame] hash table entries=${hashStats.totalEntries} | ` +
                                `cpuCap=${hashStats.hashTableCapacity} gpuCap=${hashStats.gpuTableCapacity} ` +
                                `(match=${hashStats.capacityMatch}) | ` +
                                `cpuMask=0x${hashStats.hashTableMask.toString(16)} gpuMask=0x${hashStats.gpuTableMask.toString(16)} ` +
                                `(match=${hashStats.maskMatch}) | ` +
                                `byDepth: ${htByDepth}`
                            );
                            // Log sample entries to verify lookup would work
                            if (hashStats.sampleEntries.length > 0) {
                                Logger.info(`[Debug frame] Sample coarse entries below`);
                                for (const e of hashStats.sampleEntries.slice(0, 5)) {
                                    Logger.info(
                                        `  ${e.key}: layer=${e.layer} keyLo=0x${e.keyLo.toString(16)} ` +
                                        `keyHi=0x${e.keyHi.toString(16)} slotFound=${e.slotFound} slot=${e.actualSlot}`
                                    );
                                }
                            }

                            // Test a specific lookup (face=0, depth=0, x=0, y=0) to verify lookup works
                            const testLookup = this.tileStreamer?.debugLookup?.(0, 0, 0, 0);
                            if (testLookup) {
                                Logger.info(
                                    `[Debug frame] Test lookup(f0,d0,0,0): found=${testLookup.found} ` +
                                    `layer=${testLookup.layer ?? 'N/A'} hash=${testLookup.hash} ` +
                                    `keyLo=0x${testLookup.keyLo.toString(16)} keyHi=0x${testLookup.keyHi.toString(16)}`
                                );
                            } else { 
                                Logger.info(
                                    `[Debug frame] Test lookup(f0,d0,0,0): not found`
                                );
                            }
                        }
                        this.debugReadGPUHashTable().then(gpuEntries => {
                            if (!gpuEntries) return;
                            Logger.info('[Debug frame] GPU hash table readback:');
                            let nonEmptyCount = 0;
                            const sampleSlots = [];
                            Logger.warn(`[Debug frame]GPU hash nonEmpty=${gpuEntries.filter(e => e.keyHi !== 0xFFFFFFFF).length}`);
                            for (let i = 0; i < Math.min(100, gpuEntries.length); i++) {
                                const entry = gpuEntries[i];
                                if (entry.keyHi !== 0xFFFFFFFF) {
                                    nonEmptyCount++;
                                    if (sampleSlots.length < 10) {
                                        sampleSlots.push({ slot: i, keyLo: entry.keyLo.toString(16), keyHi: entry.keyHi.toString(16), layer: entry.layer });
                                    }
                                }
                            }
                            Logger.info(`[Debug frame] Non-empty slots in first 100: ${nonEmptyCount}`);
                            Logger.info(`[Debug frame] Sample entries: ${JSON.stringify(sampleSlots)}`);
                            
                            // Compare with CPU for root tile f0:d0:0,0
                            const cpuLookup = this.tileStreamer.debugLookup(0, 0, 0, 0);
                            if (cpuLookup.found) {
                                const gpuEntry = gpuEntries[cpuLookup.slot];
                                const matches = gpuEntry.keyLo === cpuLookup.keyLo && 
                                               gpuEntry.keyHi === cpuLookup.keyHi &&
                                               gpuEntry.layer === cpuLookup.layer;
                                Logger.info(
                                    `[Debug frame] Root tile f0:d0:0,0 CPU slot=${cpuLookup.slot} layer=${cpuLookup.layer} ` +
                                    `GPU slot=${cpuLookup.slot} layer=${gpuEntry?.layer} MATCH=${matches}`
                                );
                                if (!matches) {
                                    Logger.error(`[Debug frame] MISMATCH! GPU=${JSON.stringify(gpuEntry)} CPU={layer:${cpuLookup.layer},keyLo:${cpuLookup.keyLo.toString(16)},keyHi:${cpuLookup.keyHi.toString(16)}}`);
                                }
                            }
                        }).catch(e => Logger.warn(`[Debug frame] Readback failed: ${e.message}`));
                        Logger.info('[Debug frame] Testing root tile lookups below.');
                        for (let face = 0; face < 6; face++) {
                            for (let depth = 0; depth <= 2; depth++) {
                                const lookup = this.tileStreamer?.debugLookup?.(face, depth, 0, 0);
                                if (lookup && lookup.found) {
                                    Logger.info(
                                        `  f${face} d${depth} (0,0): FOUND layer=${lookup.layer} slot=${lookup.slot}`
                                    );
                                } else {
                                    Logger.warn(
                                        `  f${face} d${depth} (0,0): MISSING (should be seeded!)`
                                    );
                                }
                            }
                        }
                        this.debugReadIndirectArgs().then(args => {
                            if (!args) return;
                            Logger.info('[Debug frame] Per-LOD draw argument:');
                            for (const a of args) {
                                Logger.info(
                                    `[Debug frame] LOD ${a.lod}: indexCount=${a.indexCount} instanceCount=${a.instanceCount} ` +
                                    `firstIndex=${a.firstIndex} baseVertex=${a.baseVertex} firstInstance=${a.firstInstance}`
                                );
                            }
                        }).catch(() => {});
                    }
        })
    );
}
