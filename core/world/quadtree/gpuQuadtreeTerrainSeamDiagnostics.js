import { TileAddress } from './tileAddress.js';
import { Logger } from '../../../shared/Logger.js';
import {
    normalizeTileAddressLike,
    tileAddrKeyJS,
    getInstanceGridAddress,
    instanceSampleGridKey,
    makeOrderedPairKey,
    computeFragmentAtlasBilinearFootprint,
    computeVertexChunkHeightFootprint,
    computeVertexIntendedHeightFootprint,
    edgeSideLocalUV,
    oppositeEdgeSide,
    uniqueTexelCoords,
    summarizeRasterComparison,
    isFallbackInstance,
    getWrappedCrossFaceNeighbor,
    findVisibleAncestorTile,
    findVisibleDescendantTiles,
    collectSeamPairs,
    computeSharedEdgeSampleUVs,
    buildUniformEdgeSamples,
    collectInstDiagnosticCoords,
    buildSharedVertexSamples,
    classifySharedVertexMismatchCause,
    summarizeTexelComparison,
    destroyWrappedTextures
} from './gpuQuadtreeDiagnosticHelpers.js';

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';
const TERRAIN_MANUAL_TAG = '[QTManual]';

export function installQuadtreeTileManagerSeamDiagnostics(QuadtreeTileManager) {
    Object.defineProperties(
        QuadtreeTileManager.prototype,
        Object.getOwnPropertyDescriptors({
        _shouldRunStitchDiag() {
                        return false;
                        // eslint-disable-next-line no-unreachable
                        const cfg = this.engineConfig?.gpuQuadtree;
                        if (!cfg?.diagnosticsEnabled) return false;
                        const interval = cfg.diagnosticsIntervalFrames ?? 0;
                        if (!Number.isFinite(interval) || interval <= 0) return false;
                        this._stitchDiagFrame = (this._stitchDiagFrame + 1) % interval;
                        return this._stitchDiagFrame === 0;
                    },

        _parseMetaRaw(raw, maxLODLevels) {
                        if (!raw || !Number.isFinite(maxLODLevels)) return null;
                        const lodCounts = raw.slice(0, maxLODLevels);
                        const lodOffsets = raw.slice(maxLODLevels, maxLODLevels * 2);
                        const lodWrite = raw.slice(maxLODLevels * 2, maxLODLevels * 3);
                        const indirect = raw.slice(maxLODLevels * 3, maxLODLevels * 3 + maxLODLevels * 5);

                        const tail = maxLODLevels * 8;
                        const feedbackCount = raw[tail + 0] ?? 0;
                        const parentFallbackHits = raw[tail + 1] ?? 0;
                        const coveringProbeSum = raw[tail + 2] ?? 0;
                        const coveringProbeCount = raw[tail + 3] ?? 0;
                        const coveringProbeMisses = raw[tail + 4] ?? 0;

                        const lodArgs = [];
                        for (let l = 0; l < maxLODLevels; l++) {
                            const b = l * 5;
                            lodArgs.push({
                                lod: l,
                                indexCount: indirect[b + 0],
                                instanceCount: indirect[b + 1],
                                firstIndex: indirect[b + 2],
                                baseVertex: indirect[b + 3],
                                firstInstance: indirect[b + 4],
                                lodCountVisible: lodCounts[l],
                                lodOffset: lodOffsets[l],
                                lodWrite: lodWrite[l],
                            });
                        }

                        return {
                            lodArgs,
                            feedbackCount,
                            parentFallbackHits,
                            coveringProbeSum,
                            coveringProbeCount,
                            coveringProbeMisses
                        };
                    },

        _maybeLogStitchingDiagnostics() {
                        if (!this._shouldRunStitchDiag()) return;
                        if (this._stitchDiagPending) return;
                        this._stitchDiagPending = true;
                        this._runStitchingDiagnostics().finally(() => {
                            this._stitchDiagPending = false;
                        });
                    },

        async _runStitchingDiagnostics() {
                      const cfg = this.engineConfig?.gpuQuadtree;
                      if (!cfg || !this.quadtreeGPU) return;
                  
                      const maxLodLevels = this.quadtreeGPU.lodLevels;
                      const maxGeomLOD = this._maxGeomLOD ?? (maxLodLevels - 1);
                  
                      // Existing counters
                      const counters = await this.quadtreeGPU.debugReadTraversalDebugCounters?.();
                      const metaRaw = await this.quadtreeGPU.debugReadMetaRaw?.(maxLodLevels);
                      const meta = this._parseMetaRaw(metaRaw, maxLodLevels);
                      const poolDepthDist = {};
                      for (const [key, info] of (this.tileStreamer?._tileInfo ?? new Map())) {
                          poolDepthDist[info.depth] = (poolDepthDist[info.depth] || 0) + 1;
                      }
                      const poolDistStr = Object.entries(poolDepthDist)
                          .sort((a, b) => +a[0] - +b[0])
                          .map(([d, c]) => `d${d}:${c}`)
                          .join(' ');
                      
                      // NEW: Check if pool is at capacity
                      const poolUsed = this.tileStreamer?._tileInfo?.size ?? 0;
                      const poolMax = this.tileStreamer?.tilePoolSize ?? 0;
                      const poolFull = poolUsed >= poolMax;
                      
                      Logger.info(
                          `[QT-StitchDiag] Pool: ${poolUsed}/${poolMax} (${poolFull ? 'FULL' : 'ok'}) ` +
                          `depthDist=[${poolDistStr}]`
                      );
                      
                      // NEW: Log evict-feedback correlation if available
                      const efStats = this.tileStreamer?._evictFeedbackStats;
                      if (efStats?.count > 0) {
                          Logger.warn(
                              `[QT-StitchDiag] Evict-feedback correlation: ` +
                              `recentlyEvictedThenRequested=${efStats.count} ` +
                              `avgRoundtripMs=${(efStats.totalAgeMs / efStats.count).toFixed(0)}`
                          );
                      }
                      
                      // NEW: Sample instances and check for stitching anomalies
                      const stitchAnomalies = {
                          sentinelNeighbors: 0,
                          invalidNeighborLOD: 0,
                          edgeMaskMismatch: 0,
                          neighborDepthJump: 0,  // NEW: neighbor depth differs by >1 from self
                          crossFaceAnomaly: 0,   // NEW: cross-face neighbor issues
                          samples: []
                      };
                  
                      const sampleBudget = cfg.diagnosticsSampleInstances ?? 64;
                      const sampledInstances = [];
                      if (sampleBudget > 0 && meta?.lodArgs?.length) {
                          const perLod = Math.max(1, Math.floor(sampleBudget / Math.max(1, maxLodLevels)));
                          
                          for (const a of meta.lodArgs) {
                              if (!a.instanceCount || a.instanceCount <= 0) continue;
                              
                              const samples = await this.quadtreeGPU.debugReadInstancesRange?.(
                                  a.firstInstance,
                                  a.instanceCount,
                                  perLod
                              );
                              if (!samples || samples.length === 0) continue;
                              sampledInstances.push(...samples);
                  
                              for (const inst of samples) {
                                  const nl = inst.neighborLODs;
                                  if (!nl) continue;
                  
                                  const selfLOD = inst.lod;
                                  const neighbors = [nl.left, nl.right, nl.bottom, nl.top];
                                  const neighborNames = ['left', 'right', 'bottom', 'top'];
                  
                                  for (let i = 0; i < 4; i++) {
                                      const nLod = neighbors[i];
                                      
                                      // Check for sentinel value (15 = 0xF, indicates lookup failure)
                                      if (nLod >= 15) {
                                          stitchAnomalies.sentinelNeighbors++;
                                      }
                                      
                                      // Check for invalid LOD (> maxGeomLOD)
                                      if (nLod > maxGeomLOD && nLod < 15) {
                                          stitchAnomalies.invalidNeighborLOD++;
                                      }
                                      
                                      // NEW: Check for large LOD jumps (indicates missing intermediate tiles)
                                      if (nLod < 15 && Math.abs(nLod - selfLOD) > 2) {
                                          stitchAnomalies.neighborDepthJump++;
                                          
                                          // Log first few anomalies for debugging
                                          if (stitchAnomalies.samples.length < 10) {
                                              stitchAnomalies.samples.push({
                                                  face: inst.face,
                                                  lod: selfLOD,
                                                  chunkLoc: inst.chunkLocation,
                                                  neighbor: neighborNames[i],
                                                  neighborLOD: nLod,
                                                  delta: Math.abs(nLod - selfLOD)
                                              });
                                          }
                                      }
                                  }
                  
                                  // Verify edge mask consistency
                                  const expectedMask =
                                      (nl.left > selfLOD ? 8 : 0) |
                                      (nl.right > selfLOD ? 2 : 0) |
                                      (nl.bottom > selfLOD ? 4 : 0) |
                                      (nl.top > selfLOD ? 1 : 0);
                                      
                                  if ((inst.edgeMask ?? 0) !== expectedMask) {
                                      stitchAnomalies.edgeMaskMismatch++;
                                  }
                              }
                          }
                      }
                  
                      // NEW: Check hash table health
                      const hashStats = this.tileStreamer?.getHashTableStats?.();
                      const hashHealth = {
                          loadFactor: 0,
                          maxProbeLength: 0,
                          orphanedEntries: 0
                      };
                      
                      if (hashStats) {
                          hashHealth.loadFactor = hashStats.totalEntries / hashStats.hashTableCapacity;
                          // High load factor (>0.7) can cause long probe chains
                          if (hashHealth.loadFactor > 0.7) {
                              Logger.warn(`[QT-StitchDiag] Hash table load factor high: ${(hashHealth.loadFactor * 100).toFixed(1)}%`);
                          }
                      }
                  
                      // NEW: Check for timing-related issues
                      const timingIssues = {
                          pendingGenerations: this.tileStreamer?._generationQueue?.queue?.length ?? 0,
                          activeGenerations: this.tileStreamer?._generationQueue?.active ?? 0,
                          pendingCopies: this.tileStreamer?.arrayPool?._pendingCopies?.length ?? 0,
                          dirtySlots: this.tileStreamer?._dirtySlots?.size ?? 0
                      };
                      const copyStateSummary = this.tileStreamer?.getCopyStateSummary?.() ?? null;
                      const visibleCopySummary = copyStateSummary?.lastVisible ?? null;
                  
                      // Build verdict
                      const verdicts = [];
                      
                      if (stitchAnomalies.sentinelNeighbors > 0) {
                          verdicts.push(`NEIGHBOR_LOOKUP_FAILED(${stitchAnomalies.sentinelNeighbors})`);
                      }
                      if (stitchAnomalies.neighborDepthJump > 0) {
                          verdicts.push(`NEIGHBOR_LOD_JUMP(${stitchAnomalies.neighborDepthJump})`);
                      }
                      if (stitchAnomalies.edgeMaskMismatch > 0) {
                          verdicts.push(`EDGE_MASK_MISMATCH(${stitchAnomalies.edgeMaskMismatch})`);
                      }
                      if (timingIssues.dirtySlots > 100) {
                          verdicts.push(`DIRTY_SLOTS_BACKLOG(${timingIssues.dirtySlots})`);
                      }
                      if (timingIssues.pendingCopies > 0) {
                          verdicts.push(`PENDING_COPIES(${timingIssues.pendingCopies})`);
                      }
                      if (hashHealth.loadFactor > 0.75) {
                          verdicts.push(`HASH_TABLE_CONGESTED(${(hashHealth.loadFactor * 100).toFixed(0)}%)`);
                      }
                      if ((counters?.visibleOverflow ?? 0) > 0) {
                          verdicts.push(`VISIBLE_OVERFLOW(${counters.visibleOverflow})`);
                      }
                      if ((meta?.parentFallbackHits ?? 0) > meta?.lodArgs?.reduce((s, a) => s + (a.instanceCount || 0), 0) * 0.1) {
                          verdicts.push(`HIGH_FALLBACK_RATE(${meta.parentFallbackHits})`);
                      }
                      const visibleNonReadyCount =
                          (visibleCopySummary?.ownVisibleNotReady ?? 0) +
                          (visibleCopySummary?.fallbackVisibleNotReady ?? 0);
                      if (visibleNonReadyCount > 0) {
                          verdicts.push(`VISIBLE_COPY_NOT_READY(${visibleNonReadyCount})`);
                      }
                  
                      const verdictStr = verdicts.length > 0 ? verdicts.join(' | ') : 'NO_ANOMALY_DETECTED';
                      
                      Logger.warn(`[QT-StitchDiag] ════════════════════════════════════════`);
                      Logger.warn(`[QT-StitchDiag] VERDICT: ${verdictStr}`);
                      Logger.info(
                          `[QT-StitchDiag] Timing: pendingGen=${timingIssues.pendingGenerations} ` +
                          `activeGen=${timingIssues.activeGenerations} ` +
                          `pendingCopies=${timingIssues.pendingCopies} ` +
                          `dirtySlots=${timingIssues.dirtySlots}`
                      );
                      if (copyStateSummary) {
                          Logger.info(
                              `${TERRAIN_STEP_LOG_TAG} [QTCommit] stitch-copy-summary tracked=${copyStateSummary.trackedLayers} ` +
                              `queued=${copyStateSummary.queued} submitted=${copyStateSummary.submitted} ` +
                              `ready=${copyStateSummary.ready} failed=${copyStateSummary.failed}`
                          );
                      }
                      if (visibleCopySummary) {
                          Logger.info(
                              `${TERRAIN_STEP_LOG_TAG} [QTCommit] stitch-visible-copy total=${visibleCopySummary.totalVisible} ` +
                              `resident=${visibleCopySummary.residentVisible} ownNotReady=${visibleCopySummary.ownVisibleNotReady} ` +
                              `fallbackVisible=${visibleCopySummary.fallbackVisible} ` +
                              `fallbackNotReady=${visibleCopySummary.fallbackVisibleNotReady}` +
                              `${visibleCopySummary.samples?.length ? ` samples=${visibleCopySummary.samples.join(' ; ')}` : ''}`
                          );
                      }
                      Logger.info(
                          `[QT-StitchDiag] Hash: loadFactor=${(hashHealth.loadFactor * 100).toFixed(1)}% ` +
                          `entries=${hashStats?.totalEntries ?? 'N/A'}/${hashStats?.hashTableCapacity ?? 'N/A'}`
                      );
                      Logger.info(
                          `[QT-StitchDiag] Anomalies: sentinel=${stitchAnomalies.sentinelNeighbors} ` +
                          `lodJump=${stitchAnomalies.neighborDepthJump} ` +
                          `edgeMask=${stitchAnomalies.edgeMaskMismatch} ` +
                          `fallbacks=${meta?.parentFallbackHits ?? 0}`
                      );
                  
                      // Log sample anomalies
                      if (stitchAnomalies.samples.length > 0) {
                          Logger.warn(`[QT-StitchDiag] Sample LOD jump anomalies:`);
                          for (const s of stitchAnomalies.samples) {
                              Logger.warn(
                                  `  face=${s.face} lod=${s.lod} loc=(${s.chunkLoc?.x?.toFixed(4)},${s.chunkLoc?.y?.toFixed(4)}) ` +
                                  `${s.neighbor}Neighbor=${s.neighborLOD} delta=${s.delta}`
                              );
                          }
                      }

                      // ── H3: Fallback adjacency analysis ──────────────────────────────────
                      // Check if fallback-rendered tiles (uvScale < 1.0) are adjacent to
                      // own-data tiles (uvScale = 1.0). These mixed edges produce height
                      // mismatches that the stitching shader cannot correct.
                      const fallbackInstances = [];
                      const ownDataInstances = [];

                      if (sampledInstances.length > 0) {
                          for (const inst of sampledInstances) {
                              if (Math.abs(inst.uvScale - 1.0) < 0.001) {
                                  ownDataInstances.push(inst);
                              } else {
                                  fallbackInstances.push(inst);
                              }
                          }
                      }

                      let mixedAdjacencyCount = 0;
                      if (fallbackInstances.length > 0 && ownDataInstances.length > 0) {
                          const ownDataSet = new Set();
                          for (const inst of ownDataInstances) {
                              const size = inst.chunkSizeUV;
                              if (!(size > 0)) continue;
                              const depth = Math.round(Math.log2(1 / size));
                              const grid = 1 << depth;
                              const ix = Math.floor(inst.chunkLocation.x / size);
                              const iy = Math.floor(inst.chunkLocation.y / size);
                              ownDataSet.add(`${inst.face}:${depth}:${ix}:${iy}`);
                          }
                          for (const inst of fallbackInstances) {
                              const size = inst.chunkSizeUV;
                              if (!(size > 0)) continue;
                              const depth = Math.round(Math.log2(1 / size));
                              const ix = Math.floor(inst.chunkLocation.x / size);
                              const iy = Math.floor(inst.chunkLocation.y / size);
                              const neighbors = [
                                  `${inst.face}:${depth}:${ix-1}:${iy}`,
                                  `${inst.face}:${depth}:${ix+1}:${iy}`,
                                  `${inst.face}:${depth}:${ix}:${iy-1}`,
                                  `${inst.face}:${depth}:${ix}:${iy+1}`,
                              ];
                              for (const nKey of neighbors) {
                                  if (ownDataSet.has(nKey)) { mixedAdjacencyCount++; break; }
                              }
                          }
                      }

                      Logger.warn(
                          `[QT-Pipeline-FallbackAdj] sampled=${fallbackInstances.length + ownDataInstances.length} ` +
                          `fallback(uvScale<1)=${fallbackInstances.length} ` +
                          `ownData(uvScale=1)=${ownDataInstances.length} ` +
                          `fallbackAdjacentToOwnData=${mixedAdjacencyCount}`
                      );
                      if (fallbackInstances.length > 0) {
                          const uvScales = fallbackInstances.slice(0, 5).map(i => i.uvScale.toFixed(4)).join(' ');
                          Logger.warn(
                              `[QT-Pipeline-FallbackScale] sample uvScales=[${uvScales}] ` +
                              `(these tiles render with parent texture data)`
                          );
                      }

                      // ── H5: Covering probe miss correlation ──────────────────────────────
                      // Cross-reference covering probe misses with fallback count.
                      // Misses mean findCoveringDepth couldn't find a visible ancestor for a
                      // neighbor — it returns selfDepth, producing edgeMask=0 (no stitch).
                      const probeSum = meta?.coveringProbeSum ?? 0;
                      const probeCount = meta?.coveringProbeCount ?? 0;
                      const probeMisses = meta?.coveringProbeMisses ?? 0;
                      const avgProbes = probeCount > 0 ? (probeSum / probeCount).toFixed(2) : '0';
                      const missPct = probeCount > 0 ? ((probeMisses / probeCount) * 100).toFixed(1) : '0';
                      Logger.warn(
                          `[QT-Pipeline-CoveringProbe] probes=${probeCount} avgDepth=${avgProbes} ` +
                          `misses=${probeMisses} (${missPct}%) ` +
                          `fallbacks=${meta?.parentFallbackHits ?? 0}`
                      );
                      if (probeMisses > 0 && (meta?.parentFallbackHits ?? 0) > 0) {
                          Logger.warn(
                              `[QT-Pipeline-CoveringProbe] ⚠ Both probe misses AND fallback hits present — ` +
                              `neighbor LOD resolution is failing for tiles that also use parent textures`
                          );
                      }

                      await this._runFallbackAtlasDiagnostics(sampledInstances, {
                          fallbackInstances,
                          ownDataInstances
                      });
                  },

        async _runFallbackAtlasDiagnostics(sampledInstances, classified = null) {
                        if (!Array.isArray(sampledInstances) || sampledInstances.length === 0) {
                            return;
                        }
                        const tileStreamer = this.tileStreamer;
                        const texSize = tileStreamer?.tileTextureSize ?? 0;
                        if (!(texSize > 0)) {
                            return;
                        }

                        const fallbackInstances = classified?.fallbackInstances ?? sampledInstances.filter((inst) => Math.abs((inst?.uvScale ?? 1) - 1.0) >= 0.001);
                        const ownDataInstances = classified?.ownDataInstances ?? sampledInstances.filter((inst) => Math.abs((inst?.uvScale ?? 1) - 1.0) < 0.001);
                        if (fallbackInstances.length === 0) {
                            Logger.info(`${TERRAIN_STEP_LOG_TAG} [QTAtlas] sampled=${sampledInstances.length} fallback=0 ownData=${ownDataInstances.length}`);
                            await this._runSeamPairDiagnostics(sampledInstances);
                            return;
                        }

                        const ownDataMap = new Map();
                        for (const inst of ownDataInstances) {
                            const key = instanceSampleGridKey(inst);
                            if (key) {
                                ownDataMap.set(key, inst);
                            }
                        }

                        let fallbackWithStitchMask = 0;
                        let fallbackBleedAny = 0;
                        let fallbackBleedOnStitchedEdge = 0;
                        let mixedAdjacencyCount = 0;
                        let mixedAdjacencyBleedCount = 0;
                        const bleedSamples = [];
                        const mixedPairs = [];
                        const seenPairs = new Set();

                        for (const inst of fallbackInstances) {
                            const addr = getInstanceGridAddress(inst);
                            if (!addr) continue;
                            const currentEdgeMask = inst.edgeMask ?? 0;
                            if (currentEdgeMask !== 0) {
                                fallbackWithStitchMask++;
                            }

                            const edgeAnalyses = [
                                { side: 'left', bit: 8, localUV: { x: 0.0, y: 0.5 }, neighborKey: `${addr.face}:${addr.depth}:${addr.x - 1}:${addr.y}` },
                                { side: 'right', bit: 2, localUV: { x: 1.0, y: 0.5 }, neighborKey: `${addr.face}:${addr.depth}:${addr.x + 1}:${addr.y}` },
                                { side: 'bottom', bit: 4, localUV: { x: 0.5, y: 0.0 }, neighborKey: `${addr.face}:${addr.depth}:${addr.x}:${addr.y - 1}` },
                                { side: 'top', bit: 1, localUV: { x: 0.5, y: 1.0 }, neighborKey: `${addr.face}:${addr.depth}:${addr.x}:${addr.y + 1}` },
                            ];

                            let hasAnyBleed = false;
                            let hasStitchedBleed = false;
                            for (const edge of edgeAnalyses) {
                                const footprint = computeFragmentAtlasBilinearFootprint(edge.localUV, inst, texSize);
                                if (!footprint) continue;
                                const bleeds = footprint.leakX || footprint.leakY;
                                const stitched = (currentEdgeMask & edge.bit) !== 0;
                                const mixedNeighbor = ownDataMap.get(edge.neighborKey) ?? null;

                                if (bleeds) {
                                    hasAnyBleed = true;
                                }
                                if (bleeds && stitched) {
                                    hasStitchedBleed = true;
                                }
                                if (mixedNeighbor) {
                                    mixedAdjacencyCount++;
                                    if (bleeds) {
                                        mixedAdjacencyBleedCount++;
                                    }
                                    const pairKey = makeOrderedPairKey(instanceSampleGridKey(inst), edge.neighborKey);
                                    if (pairKey && !seenPairs.has(pairKey)) {
                                        seenPairs.add(pairKey);
                                        mixedPairs.push({
                                            fallback: inst,
                                            own: mixedNeighbor,
                                            side: edge.side,
                                            footprint
                                        });
                                    }
                                }

                                if (bleeds && bleedSamples.length < 8) {
                                    bleedSamples.push(
                                        `f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:${edge.side} ` +
                                        `uvScale=${(inst.uvScale ?? 1).toFixed(4)} edgeMask=${currentEdgeMask} ` +
                                        `allowedX=${footprint.rect.minX}-${footprint.rect.maxX} sampleX=${footprint.x0}-${footprint.x1} ` +
                                        `allowedY=${footprint.rect.minY}-${footprint.rect.maxY} sampleY=${footprint.y0}-${footprint.y1}` +
                                        `${mixedNeighbor ? ' mixedOwn=1' : ''}${stitched ? ' stitched=1' : ''}`
                                    );
                                }
                            }

                            if (hasAnyBleed) {
                                fallbackBleedAny++;
                            }
                            if (hasStitchedBleed) {
                                fallbackBleedOnStitchedEdge++;
                            }
                        }

                        Logger.warn(
                            `${TERRAIN_STEP_LOG_TAG} [QTAtlas] sampled=${sampledInstances.length} ` +
                            `fallback=${fallbackInstances.length} ownData=${ownDataInstances.length} ` +
                            `fallbackWithStitch=${fallbackWithStitchMask} ` +
                            `bleedAny=${fallbackBleedAny} ` +
                            `bleedOnStitchedEdge=${fallbackBleedOnStitchedEdge} ` +
                            `mixedAdj=${mixedAdjacencyCount} mixedAdjBleed=${mixedAdjacencyBleedCount}`
                        );
                        if (bleedSamples.length > 0) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTAtlas] bleed-samples ${bleedSamples.join(' ; ')}`);
                        }

                        if (!tileStreamer?.debugReadArrayLayerTexels || mixedPairs.length === 0) {
                            await this._runSeamPairDiagnostics(sampledInstances);
                            return;
                        }

                        const readCache = new Map();
                        const pairLogs = [];
                        for (const pair of mixedPairs.slice(0, 3)) {
                            const tValues = [0.25, 0.5, 0.75];
                            const deltas = [];
                            for (const t of tValues) {
                                const fallbackUV = edgeSideLocalUV(pair.side, t, true);
                                const ownUV = edgeSideLocalUV(oppositeEdgeSide(pair.side), t, true);
                                const fallbackHeight = await this._debugSampleHeightAtChunkUV(pair.fallback, fallbackUV, readCache);
                                const ownHeight = await this._debugSampleHeightAtChunkUV(pair.own, ownUV, readCache);
                                if (!Number.isFinite(fallbackHeight) || !Number.isFinite(ownHeight)) {
                                    continue;
                                }
                                deltas.push({ t, delta: Math.abs(fallbackHeight - ownHeight) });
                            }
                            if (deltas.length === 0) {
                                continue;
                            }
                            const maxDelta = deltas.reduce((m, d) => Math.max(m, d.delta), 0);
                            const avgDelta = deltas.reduce((s, d) => s + d.delta, 0) / deltas.length;
                            const fallbackAddr = getInstanceGridAddress(pair.fallback);
                            const ownAddr = getInstanceGridAddress(pair.own);
                            pairLogs.push(
                                `fallback=f${fallbackAddr?.face}:d${fallbackAddr?.depth}:${fallbackAddr?.x},${fallbackAddr?.y}` +
                                `->own=f${ownAddr?.face}:d${ownAddr?.depth}:${ownAddr?.x},${ownAddr?.y} side=${pair.side} ` +
                                `fallbackLayer=${pair.fallback.layer} ownLayer=${pair.own.layer} ` +
                                `uvScale=${(pair.fallback.uvScale ?? 1).toFixed(4)} ` +
                                `heightDelta[max=${maxDelta.toFixed(5)} avg=${avgDelta.toFixed(5)}] ` +
                                `fragFootprintX=${pair.footprint?.x0}-${pair.footprint?.x1} ` +
                                `allowedX=${pair.footprint?.rect?.minX}-${pair.footprint?.rect?.maxX}`
                            );
                        }
                        if (pairLogs.length > 0) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTAtlas] mixed-edge-heights ${pairLogs.join(' ; ')}`);
                        }

                        await this._runSeamPairDiagnostics(sampledInstances);
                    },

        async _runSeamPairDiagnostics(sampledInstances) {
                        if (!Array.isArray(sampledInstances) || sampledInstances.length === 0) {
                            return;
                        }

                        const seamPairs = collectSeamPairs(sampledInstances);
                        if (seamPairs.length === 0) {
                            Logger.info(`${TERRAIN_STEP_LOG_TAG} [QTSeam] sampled=${sampledInstances.length} pairs=0`);
                            return;
                        }

                        this._seamDiagTick = (this._seamDiagTick ?? 0) + 1;
                        const seamTick = this._seamDiagTick;
                        const seamSeen = this._seamDiagSeen ?? new Map();
                        this._seamDiagSeen = seamSeen;
                        const hist = new Map();

                        for (const pair of seamPairs) {
                            let seen = seamSeen.get(pair.key);
                            if (!seen) {
                                seen = { count: 0, lastTick: -1 };
                                seamSeen.set(pair.key, seen);
                            }
                            if (seen.lastTick !== seamTick) {
                                seen.lastTick = seamTick;
                                seen.count += 1;
                            }

                            let bucket = hist.get(pair.className);
                            if (!bucket) {
                                bucket = {
                                    className: pair.className,
                                    candidateCount: 0,
                                    persistentCount: 0,
                                    sampledPairs: [],
                                    currentNormMax: 0,
                                    currentNormSum: 0,
                                    currentMeterMax: 0,
                                    currentMeterSum: 0,
                                    intendedNormMax: 0,
                                    intendedNormSum: 0,
                                    intendedMeterMax: 0,
                                    intendedMeterSum: 0,
                                    pairMetricCount: 0
                                };
                                hist.set(pair.className, bucket);
                            }
                            bucket.candidateCount += 1;
                            if (seen.count >= 2) {
                                bucket.persistentCount += 1;
                            }
                            if (bucket.sampledPairs.length < 3) {
                                bucket.sampledPairs.push(pair);
                            }
                        }

                        for (const [key, seen] of seamSeen) {
                            if ((seen.lastTick ?? 0) < seamTick - 24) {
                                seamSeen.delete(key);
                            }
                        }

                        const readCache = new Map();
                        const worstPairs = [];
                        const heightScaleMeters = Number.isFinite(this.planetConfig?.heightScale)
                            ? this.planetConfig.heightScale
                            : (Number.isFinite(this.planetConfig?.maxTerrainHeight) ? this.planetConfig.maxTerrainHeight : 1);

                        for (const bucket of hist.values()) {
                            for (const pair of bucket.sampledPairs) {
                                const metrics = await this._measureSeamPair(pair, readCache);
                                if (!metrics) continue;
                                bucket.pairMetricCount += 1;
                                bucket.currentNormMax = Math.max(bucket.currentNormMax, metrics.currentNormMax);
                                bucket.currentNormSum += metrics.currentNormAvg;
                                bucket.currentMeterMax = Math.max(bucket.currentMeterMax, metrics.currentNormMax * heightScaleMeters);
                                bucket.currentMeterSum += metrics.currentNormAvg * heightScaleMeters;
                                bucket.intendedNormMax = Math.max(bucket.intendedNormMax, metrics.intendedNormMax);
                                bucket.intendedNormSum += metrics.intendedNormAvg;
                                bucket.intendedMeterMax = Math.max(bucket.intendedMeterMax, metrics.intendedNormMax * heightScaleMeters);
                                bucket.intendedMeterSum += metrics.intendedNormAvg * heightScaleMeters;
                                worstPairs.push({
                                    className: bucket.className,
                                    pair,
                                    metrics
                                });
                            }
                        }

                        Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTSeam] sampled=${sampledInstances.length} pairs=${seamPairs.length}`);
                        const classOrder = [
                            'own-own:same-depth',
                            'own-fallback:same-depth:no-mask',
                            'own-fallback:same-depth:mask',
                            'fallback-fallback:same-depth',
                            'coarse-fine:stitched'
                        ];
                        const orderedBuckets = Array.from(hist.values()).sort((a, b) => {
                            const ai = classOrder.indexOf(a.className);
                            const bi = classOrder.indexOf(b.className);
                            return (ai < 0 ? classOrder.length : ai) - (bi < 0 ? classOrder.length : bi);
                        });
                        for (const bucket of orderedBuckets) {
                            const sampled = bucket.pairMetricCount;
                            const currentNormAvg = sampled > 0 ? bucket.currentNormSum / sampled : 0;
                            const currentMeterAvg = sampled > 0 ? bucket.currentMeterSum / sampled : 0;
                            const intendedNormAvg = sampled > 0 ? bucket.intendedNormSum / sampled : 0;
                            const intendedMeterAvg = sampled > 0 ? bucket.intendedMeterSum / sampled : 0;
                            const maxImprove = bucket.currentMeterMax > 0
                                ? (1.0 - (bucket.intendedMeterMax / bucket.currentMeterMax)) * 100.0
                                : 0.0;
                            Logger.warn(
                                `${TERRAIN_STEP_LOG_TAG} [QTSeam] class=${bucket.className} ` +
                                `candidates=${bucket.candidateCount} persistent=${bucket.persistentCount} sampled=${sampled} ` +
                                `current[max=${bucket.currentNormMax.toFixed(5)}/${bucket.currentMeterMax.toFixed(2)}m avg=${currentNormAvg.toFixed(5)}/${currentMeterAvg.toFixed(2)}m] ` +
                                `intended[max=${bucket.intendedNormMax.toFixed(5)}/${bucket.intendedMeterMax.toFixed(2)}m avg=${intendedNormAvg.toFixed(5)}/${intendedMeterAvg.toFixed(2)}m] ` +
                                `maxImprove=${maxImprove.toFixed(1)}%`
                            );
                        }

                        worstPairs.sort((a, b) => {
                            const aScore = Math.max(a.metrics.currentNormMax, a.metrics.intendedNormMax);
                            const bScore = Math.max(b.metrics.currentNormMax, b.metrics.intendedNormMax);
                            return bScore - aScore;
                        });
                        const worstLogs = [];
                        for (const item of worstPairs.slice(0, 4)) {
                            const aAddr = getInstanceGridAddress(item.pair.a);
                            const bAddr = getInstanceGridAddress(item.pair.b);
                            worstLogs.push(
                                `${item.className} ` +
                                `a=f${aAddr?.face}:d${aAddr?.depth}:${aAddr?.x},${aAddr?.y}:${item.pair.sideA} ` +
                                `b=f${bAddr?.face}:d${bAddr?.depth}:${bAddr?.x},${bAddr?.y}:${item.pair.sideB} ` +
                                `layers=${item.pair.a.layer}/${item.pair.b.layer} ` +
                                `uvScale=${(item.pair.a.uvScale ?? 1).toFixed(3)}/${(item.pair.b.uvScale ?? 1).toFixed(3)} ` +
                                `current=${item.metrics.currentNormMax.toFixed(5)}/${(item.metrics.currentNormMax * heightScaleMeters).toFixed(2)}m ` +
                                `intended=${item.metrics.intendedNormMax.toFixed(5)}/${(item.metrics.intendedNormMax * heightScaleMeters).toFixed(2)}m`
                            );
                        }
                        if (worstLogs.length > 0) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTSeam] worst ${worstLogs.join(' ; ')}`);
                        }

                        const worstSettledCoarseFine = worstPairs.find((item) =>
                            item.className === 'coarse-fine:stitched'
                            && !isFallbackInstance(item.pair.a)
                            && !isFallbackInstance(item.pair.b)
                        );
                        const worstCoarseFine = worstSettledCoarseFine
                            ?? worstPairs.find((item) => item.className === 'coarse-fine:stitched')
                            ?? worstPairs[0]
                            ?? null;
                        if (worstCoarseFine) {
                            if (worstCoarseFine.className === 'coarse-fine:stitched') {
                                Logger.warn(
                                    `${TERRAIN_STEP_LOG_TAG} [QTSeam] deep-target=${
                                        worstSettledCoarseFine ? 'settled-own coarse-fine' : 'fallback-involved coarse-fine'
                                    }`
                                );
                            }
                            await this._maybeRunDeepSeamDiagnostics(worstCoarseFine, heightScaleMeters);
                        }
                    },

        async _measureSeamPair(pair, readCache = null) {
                        return this._sampleSeamPairMetrics(pair, [0.25, 0.5, 0.75], readCache);
                    },

        async _sampleSeamPairMetrics(pair, tValues, readCache = null) {
                        if (!pair?.a || !pair?.b) {
                            return null;
                        }
                        let currentNormMax = 0;
                        let currentNormSum = 0;
                        let intendedNormMax = 0;
                        let intendedNormSum = 0;
                        let samples = 0;
                        let currentMaxT = 0.0;
                        let intendedMaxT = 0.0;

                        for (const t of tValues) {
                            const seamSample = computeSharedEdgeSampleUVs(pair.a, pair.b, pair.sideA, t);
                            if (!seamSample) continue;
                            const currentA = await this._debugSampleHeightAtChunkUV(pair.a, seamSample.uvA, {
                                mode: 'current',
                                sampleLOD: pair.sampleLODA
                            }, readCache);
                            const currentB = await this._debugSampleHeightAtChunkUV(pair.b, seamSample.uvB, {
                                mode: 'current',
                                sampleLOD: pair.sampleLODB
                            }, readCache);
                            const intendedA = await this._debugSampleHeightAtChunkUV(pair.a, seamSample.uvA, {
                                mode: 'intended',
                                sampleLOD: pair.sampleLODA
                            }, readCache);
                            const intendedB = await this._debugSampleHeightAtChunkUV(pair.b, seamSample.uvB, {
                                mode: 'intended',
                                sampleLOD: pair.sampleLODB
                            }, readCache);
                            if (![currentA, currentB, intendedA, intendedB].every(Number.isFinite)) {
                                continue;
                            }

                            const currentDelta = Math.abs(currentA - currentB);
                            const intendedDelta = Math.abs(intendedA - intendedB);
                            if (currentDelta > currentNormMax) {
                                currentNormMax = currentDelta;
                                currentMaxT = t;
                            }
                            currentNormSum += currentDelta;
                            if (intendedDelta > intendedNormMax) {
                                intendedNormMax = intendedDelta;
                                intendedMaxT = t;
                            }
                            intendedNormSum += intendedDelta;
                            samples += 1;
                        }

                        if (samples === 0) {
                            return null;
                        }
                        return {
                            currentNormMax,
                            currentNormAvg: currentNormSum / samples,
                            intendedNormMax,
                            intendedNormAvg: intendedNormSum / samples,
                            currentMaxT,
                            intendedMaxT,
                            sampleCount: samples
                        };
                    },

        async _maybeRunDeepSeamDiagnostics(item, heightScaleMeters) {
                        if (!item?.pair) return;
                        this._deepSeamDiagTick = (this._deepSeamDiagTick ?? 0) + 1;
                        const currentMeters = item.metrics.currentNormMax * heightScaleMeters;
                        const intendedMeters = item.metrics.intendedNormMax * heightScaleMeters;
                        const forceForManualSnapshot = this._manualDiagState?.running === true;
                        const shouldRun =
                            forceForManualSnapshot || (
                                Math.max(currentMeters, intendedMeters) >= 5.0 &&
                                (item.pair.key !== this._lastDeepSeamKey || (this._deepSeamDiagTick % 6) === 0)
                            );
                        if (!shouldRun) {
                            return;
                        }
                        this._lastDeepSeamKey = item.pair.key;
                        await this._runDeepSeamDiagnostics(item, heightScaleMeters);
                    },

        async _runDeepSeamDiagnostics(item, heightScaleMeters) {
                        const denseTs = buildUniformEdgeSamples(17);
                        const readCache = new Map();
                        const denseMetrics = await this._sampleSeamPairMetrics(item.pair, denseTs, readCache);
                        if (denseMetrics) {
                            const aAddr = getInstanceGridAddress(item.pair.a);
                            const bAddr = getInstanceGridAddress(item.pair.b);
                            Logger.warn(
                                `${TERRAIN_STEP_LOG_TAG} [QTSeam] deep class=${item.className} ` +
                                `a=f${aAddr?.face}:d${aAddr?.depth}:${aAddr?.x},${aAddr?.y}:${item.pair.sideA} ` +
                                `b=f${bAddr?.face}:d${bAddr?.depth}:${bAddr?.x},${bAddr?.y}:${item.pair.sideB} ` +
                                `denseSamples=${denseMetrics.sampleCount} ` +
                                `current[max=${denseMetrics.currentNormMax.toFixed(5)}/${(denseMetrics.currentNormMax * heightScaleMeters).toFixed(2)}m t=${denseMetrics.currentMaxT.toFixed(3)} ` +
                                `avg=${denseMetrics.currentNormAvg.toFixed(5)}/${(denseMetrics.currentNormAvg * heightScaleMeters).toFixed(2)}m] ` +
                                `intended[max=${denseMetrics.intendedNormMax.toFixed(5)}/${(denseMetrics.intendedNormMax * heightScaleMeters).toFixed(2)}m t=${denseMetrics.intendedMaxT.toFixed(3)} ` +
                                `avg=${denseMetrics.intendedNormAvg.toFixed(5)}/${(denseMetrics.intendedNormAvg * heightScaleMeters).toFixed(2)}m]`
                            );
                        }

                        const regenSummary = await this._debugComparePairLiveToFresh(item.pair, denseTs);
                        if (regenSummary) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTSeam] regen-compare ${regenSummary}`);
                        }

                        const freshHeightSplit = await this._debugCompareFreshBaseVsFinal(item.pair, denseTs, heightScaleMeters);
                        if (freshHeightSplit) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTSeam] fresh-height-split ${freshHeightSplit}`);
                        }

                        const sharedVertexAudit = await this._debugAuditSharedSeamVertices(item, heightScaleMeters);
                        if (sharedVertexAudit) {
                            Logger.warn(`${TERRAIN_STEP_LOG_TAG} [QTSeam] shared-vertices ${sharedVertexAudit}`);
                        }
                    },

        async _runCrossFaceVisibleSeamDiagnostics(tiles) {
                        const tileAddrs = [];
                        const visibleByFace = new Map();
                        const visibleExact = new Set();
                        for (const tile of Array.isArray(tiles) ? tiles : []) {
                            const addr = normalizeTileAddressLike(tile);
                            if (!addr) continue;
                            tileAddrs.push(addr);
                            visibleExact.add(tileAddrKeyJS(addr));
                            let list = visibleByFace.get(addr.face);
                            if (!list) {
                                list = [];
                                visibleByFace.set(addr.face, list);
                            }
                            list.push(addr);
                        }
                        if (tileAddrs.length === 0) {
                            return;
                        }

                        const sameDepth = new Set();
                        const fineToCoarse = new Set();
                        const coarseToFine = new Set();
                        const missing = new Set();
                        const samples = [];

                        for (const addr of tileAddrs) {
                            for (const side of ['left', 'right', 'bottom', 'top']) {
                                const wrapped = getWrappedCrossFaceNeighbor(addr, side);
                                if (!wrapped) continue;

                                const wrappedKey = tileAddrKeyJS(wrapped);
                                if (visibleExact.has(wrappedKey)) {
                                    sameDepth.add(makeOrderedPairKey(tileAddrKeyJS(addr), wrappedKey));
                                    continue;
                                }

                                const ancestor = findVisibleAncestorTile(wrapped, visibleExact);
                                if (ancestor) {
                                    const pairKey = makeOrderedPairKey(tileAddrKeyJS(addr), tileAddrKeyJS(ancestor));
                                    fineToCoarse.add(pairKey);
                                    if (samples.length < 10) {
                                        samples.push(
                                            `fine->coarse f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:${side} ` +
                                            `wrapped=f${wrapped.face}:d${wrapped.depth}:${wrapped.x},${wrapped.y} ` +
                                            `owner=f${ancestor.face}:d${ancestor.depth}:${ancestor.x},${ancestor.y}`
                                        );
                                    }
                                    continue;
                                }

                                const descendants = findVisibleDescendantTiles(wrapped, visibleByFace.get(wrapped.face) ?? []);
                                if (descendants.length > 0) {
                                    const target = descendants[0];
                                    const pairKey = makeOrderedPairKey(tileAddrKeyJS(addr), tileAddrKeyJS(target));
                                    coarseToFine.add(pairKey);
                                    if (samples.length < 10) {
                                        samples.push(
                                            `coarse->fine f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:${side} ` +
                                            `wrapped=f${wrapped.face}:d${wrapped.depth}:${wrapped.x},${wrapped.y} ` +
                                            `child=f${target.face}:d${target.depth}:${target.x},${target.y}`
                                        );
                                    }
                                    continue;
                                }

                                const pairKey = `${tileAddrKeyJS(addr)}:${side}->${wrapped.face}`;
                                missing.add(pairKey);
                                if (samples.length < 10) {
                                    samples.push(
                                        `missing f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:${side} ` +
                                        `wrapped=f${wrapped.face}:d${wrapped.depth}:${wrapped.x},${wrapped.y}`
                                    );
                                }
                            }
                        }

                        Logger.warn(
                            `${TERRAIN_MANUAL_TAG} cross-face sameDepth=${sameDepth.size} ` +
                            `fineToCoarse=${fineToCoarse.size} coarseToFine=${coarseToFine.size} missing=${missing.size}`
                        );
                        if (samples.length > 0) {
                            Logger.warn(`${TERRAIN_MANUAL_TAG} cross-face samples ${samples.join(' ; ')}`);
                        }
                    },

        async _debugComparePairLiveToFresh(pair, tValues) {
                        const tileStreamer = this.tileStreamer;
                        const tileGenerator = tileStreamer?.tileGenerator;
                        if (!tileStreamer?.debugReadArrayLayerTexels || !tileStreamer?._debugReadTextureTexels || !tileGenerator) {
                            return '';
                        }

                        const parts = [];
                        for (const target of [
                            { label: 'a', inst: pair.a, side: pair.sideA },
                            { label: 'b', inst: pair.b, side: pair.sideB }
                        ]) {
                            const addr = getInstanceGridAddress(target.inst);
                            if (!addr) continue;
                            const tileAddr = new TileAddress(addr.face, addr.depth, addr.x, addr.y);
                            const coords = collectInstDiagnosticCoords(target.inst, target.side, tValues, tileStreamer.tileTextureSize);
                            let freshTextures = null;
                            try {
                                freshTextures = await tileGenerator.generateTile(tileAddr);
                                const heightSummary = await this._debugCompareLiveTextureToFresh(
                                    'height',
                                    target.inst.layer,
                                    freshTextures.height,
                                    coords,
                                    tileAddr.toString()
                                );
                                const tileSummary = await this._debugCompareLiveTextureToFresh(
                                    'tile',
                                    target.inst.layer,
                                    freshTextures.tile,
                                    coords,
                                    tileAddr.toString()
                                );
                                parts.push(
                                    `${target.label}=f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:L${target.inst.layer} ` +
                                    `coords=${coords.length} ` +
                                    `height{${heightSummary}} tile{${tileSummary}}`
                                );
                            } catch (err) {
                                parts.push(
                                    `${target.label}=f${addr.face}:d${addr.depth}:${addr.x},${addr.y}:regen-failed:${err?.message ?? err}`
                                );
                            } finally {
                                destroyWrappedTextures(freshTextures);
                            }
                        }

                        return parts.join(' ; ');
                    },

        async _debugCompareLiveTextureToFresh(type, layer, freshTexture, coords, expectedKey = '') {
                        const tileStreamer = this.tileStreamer;
                        if (!freshTexture || !Array.isArray(coords) || coords.length === 0) {
                            return 'unavailable';
                        }
                        const format = tileStreamer?.textureFormats?.[type]
                            || tileStreamer?.arrayPool?.formats?.[type]
                            || 'rgba32float';
                        const ownerBefore = tileStreamer?.getLayerDebugInfo?.(layer) ?? null;
                        const live = await tileStreamer.debugReadArrayLayerTexels(type, layer, coords);
                        const fresh = await tileStreamer._debugReadTextureTexels(freshTexture, format, coords);
                        const ownerAfter = tileStreamer?.getLayerDebugInfo?.(layer) ?? null;
                        const compare = summarizeTexelComparison(live?.texels, fresh?.texels, format);
                        const beforeKey = ownerBefore?.ownerKey ?? 'null';
                        const afterKey = ownerAfter?.ownerKey ?? 'null';
                        const beforeState = ownerBefore?.copyState ?? 'unknown';
                        const afterState = ownerAfter?.copyState ?? 'unknown';
                        const stable = beforeKey === afterKey;
                        const match = expectedKey
                            ? (beforeKey === expectedKey && afterKey === expectedKey)
                            : stable;
                        return (
                            `${compare} ` +
                            `owner{exp=${expectedKey || '-'} before=${beforeKey} after=${afterKey} ` +
                            `state=${beforeState}->${afterState} stable=${stable ? 1 : 0} match=${match ? 1 : 0}}`
                        );
                    },

        async _debugCompareLiveTextureToFreshDense(type, layer, freshTexture, expectedKey = '', stride = 1) {
                        const tileStreamer = this.tileStreamer;
                        if (!freshTexture || !tileStreamer?.debugReadArrayLayerBuffer || !tileStreamer?._debugReadTextureBuffer) {
                            return 'unavailable';
                        }

                        const format = tileStreamer?.textureFormats?.[type]
                            || tileStreamer?.arrayPool?.formats?.[type]
                            || 'rgba32float';
                        const ownerBefore = tileStreamer?.getLayerDebugInfo?.(layer) ?? null;
                        const live = await tileStreamer.debugReadArrayLayerBuffer(type, layer);
                        const fresh = await tileStreamer._debugReadTextureBuffer(freshTexture, format);
                        const ownerAfter = tileStreamer?.getLayerDebugInfo?.(layer) ?? null;
                        if (!live?.buffer || !fresh?.buffer) {
                            return 'unavailable';
                        }

                        const compare = summarizeRasterComparison(live, fresh, stride);
                        const beforeKey = ownerBefore?.ownerKey ?? 'null';
                        const afterKey = ownerAfter?.ownerKey ?? 'null';
                        const beforeState = ownerBefore?.copyState ?? 'unknown';
                        const afterState = ownerAfter?.copyState ?? 'unknown';
                        const stable = beforeKey === afterKey;
                        const match = expectedKey
                            ? (beforeKey === expectedKey && afterKey === expectedKey)
                            : stable;
                        return (
                            `${compare} ` +
                            `owner{exp=${expectedKey || '-'} before=${beforeKey} after=${afterKey} ` +
                            `state=${beforeState}->${afterState} stable=${stable ? 1 : 0} match=${match ? 1 : 0}}`
                        );
                    },

        async _collectFreshBaseFinalSeamMetrics(pair, tValues) {
                        const tileStreamer = this.tileStreamer;
                        const tileGenerator = tileStreamer?.tileGenerator;
                        if (!tileGenerator?.generateDiagnosticTile) {
                            return null;
                        }

                        const freshByTarget = new Map();
                        const targets = [
                            { label: 'a', inst: pair.a },
                            { label: 'b', inst: pair.b }
                        ];
                        try {
                            for (const target of targets) {
                                const addr = getInstanceGridAddress(target.inst);
                                if (!addr) return null;
                                const tileAddr = new TileAddress(addr.face, addr.depth, addr.x, addr.y);
                                const textures = await tileGenerator.generateDiagnosticTile(tileAddr, {
                                    includeBaseHeight: true
                                });
                                freshByTarget.set(target.label, {
                                    key: tileAddr.toString(),
                                    inst: target.inst,
                                    textures,
                                    heightFormat: textures?.height?._gpuFormat
                                        || tileStreamer?.textureFormats?.height
                                        || 'r32float'
                                });
                            }

                            const baseMetrics = await this._sampleFreshTextureSeamMetrics(pair, tValues, {
                                a: {
                                    texture: freshByTarget.get('a')?.textures?.baseHeight,
                                    format: freshByTarget.get('a')?.heightFormat,
                                    inst: pair.a,
                                    cachePrefix: `${freshByTarget.get('a')?.key || 'a'}:base`
                                },
                                b: {
                                    texture: freshByTarget.get('b')?.textures?.baseHeight,
                                    format: freshByTarget.get('b')?.heightFormat,
                                    inst: pair.b,
                                    cachePrefix: `${freshByTarget.get('b')?.key || 'b'}:base`
                                }
                            });
                            const finalMetrics = await this._sampleFreshTextureSeamMetrics(pair, tValues, {
                                a: {
                                    texture: freshByTarget.get('a')?.textures?.height,
                                    format: freshByTarget.get('a')?.heightFormat,
                                    inst: pair.a,
                                    cachePrefix: `${freshByTarget.get('a')?.key || 'a'}:final`
                                },
                                b: {
                                    texture: freshByTarget.get('b')?.textures?.height,
                                    format: freshByTarget.get('b')?.heightFormat,
                                    inst: pair.b,
                                    cachePrefix: `${freshByTarget.get('b')?.key || 'b'}:final`
                                }
                            });
                            if (!baseMetrics && !finalMetrics) {
                                return null;
                            }

                            return {
                                aKey: freshByTarget.get('a')?.key || '',
                                bKey: freshByTarget.get('b')?.key || '',
                                baseMetrics,
                                finalMetrics
                            };
                        } finally {
                            for (const entry of freshByTarget.values()) {
                                destroyWrappedTextures(entry?.textures);
                            }
                        }
                    },

        async _debugCompareFreshBaseVsFinal(pair, tValues, heightScaleMeters) {
                        const result = await this._collectFreshBaseFinalSeamMetrics(pair, tValues);
                        if (!result) {
                            return '';
                        }

                        const {
                            aKey,
                            bKey,
                            baseMetrics,
                            finalMetrics
                        } = result;

                        const baseMaxMeters = (baseMetrics?.normMax ?? 0) * heightScaleMeters;
                        const baseAvgMeters = (baseMetrics?.normAvg ?? 0) * heightScaleMeters;
                        const finalMaxMeters = (finalMetrics?.normMax ?? 0) * heightScaleMeters;
                        const finalAvgMeters = (finalMetrics?.normAvg ?? 0) * heightScaleMeters;
                        const amplifyMax = baseMaxMeters > 1e-6 ? (finalMaxMeters / baseMaxMeters) : 0;
                        const amplifyAvg = baseAvgMeters > 1e-6 ? (finalMaxMeters / baseAvgMeters) : 0;

                        return (
                            `a=${aKey} b=${bKey} ` +
                            `base[max=${(baseMetrics?.normMax ?? 0).toFixed(5)}/${baseMaxMeters.toFixed(2)}m ` +
                            `avg=${(baseMetrics?.normAvg ?? 0).toFixed(5)}/${baseAvgMeters.toFixed(2)}m] ` +
                            `final[max=${(finalMetrics?.normMax ?? 0).toFixed(5)}/${finalMaxMeters.toFixed(2)}m ` +
                            `avg=${(finalMetrics?.normAvg ?? 0).toFixed(5)}/${finalAvgMeters.toFixed(2)}m] ` +
                            `amplify[max=${amplifyMax.toFixed(2)}x avg=${amplifyAvg.toFixed(2)}x]`
                        );
                    },

        async _debugAuditSharedSeamVertices(item, heightScaleMeters) {
                        if (!item?.pair) {
                            return '';
                        }
                        const sharedTs = buildSharedVertexSamples(item.pair, item.className, this._diagLodSegments);
                        if (!Array.isArray(sharedTs) || sharedTs.length === 0) {
                            return '';
                        }

                        const currentMetrics = await this._sampleSeamPairMetrics(item.pair, sharedTs, new Map());
                        const freshMetrics = await this._collectFreshBaseFinalSeamMetrics(item.pair, sharedTs);
                        if (!currentMetrics && !freshMetrics) {
                            return '';
                        }

                        const currentMaxMeters = (currentMetrics?.currentNormMax ?? 0) * heightScaleMeters;
                        const baseMaxMeters = (freshMetrics?.baseMetrics?.normMax ?? 0) * heightScaleMeters;
                        const finalMaxMeters = (freshMetrics?.finalMetrics?.normMax ?? 0) * heightScaleMeters;
                        const cause = classifySharedVertexMismatchCause(currentMaxMeters, baseMaxMeters, finalMaxMeters);

                        return (
                            `class=${item.className} samples=${sharedTs.length} ` +
                            `current[max=${(currentMetrics?.currentNormMax ?? 0).toFixed(5)}/${currentMaxMeters.toFixed(2)}m ` +
                            `t=${(currentMetrics?.currentMaxT ?? 0).toFixed(3)}] ` +
                            `base[max=${(freshMetrics?.baseMetrics?.normMax ?? 0).toFixed(5)}/${baseMaxMeters.toFixed(2)}m ` +
                            `t=${(freshMetrics?.baseMetrics?.maxT ?? 0).toFixed(3)}] ` +
                            `final[max=${(freshMetrics?.finalMetrics?.normMax ?? 0).toFixed(5)}/${finalMaxMeters.toFixed(2)}m ` +
                            `t=${(freshMetrics?.finalMetrics?.maxT ?? 0).toFixed(3)}] ` +
                            `cause=${cause}`
                        );
                    },

        async _sampleFreshTextureSeamMetrics(pair, tValues, sources) {
                        const readCache = new Map();
                        let normMax = 0;
                        let normSum = 0;
                        let sampleCount = 0;
                        let maxT = 0;

                        for (const t of tValues) {
                            const seamSample = computeSharedEdgeSampleUVs(pair.a, pair.b, pair.sideA, t);
                            if (!seamSample) continue;
                            const aValue = await this._debugSampleTextureHeightAtChunkUV(
                                sources?.a?.texture,
                                sources?.a?.format,
                                seamSample.uvA,
                                sources?.a?.inst,
                                readCache,
                                sources?.a?.cachePrefix || 'a'
                            );
                            const bValue = await this._debugSampleTextureHeightAtChunkUV(
                                sources?.b?.texture,
                                sources?.b?.format,
                                seamSample.uvB,
                                sources?.b?.inst,
                                readCache,
                                sources?.b?.cachePrefix || 'b'
                            );
                            if (![aValue, bValue].every(Number.isFinite)) {
                                continue;
                            }
                            const delta = Math.abs(aValue - bValue);
                            if (delta > normMax) {
                                normMax = delta;
                                maxT = t;
                            }
                            normSum += delta;
                            sampleCount += 1;
                        }

                        if (sampleCount === 0) {
                            return null;
                        }
                        return {
                            normMax,
                            normAvg: normSum / sampleCount,
                            sampleCount,
                            maxT
                        };
                    },

        async _debugSampleTextureHeightAtChunkUV(textureLike, format, localUV, inst, readCache = null, cachePrefix = 'tex') {
                        const tileStreamer = this.tileStreamer;
                        const texSize = tileStreamer?.tileTextureSize ?? 0;
                        if (!(texSize > 0) || !tileStreamer?._debugReadTextureTexels || !textureLike || !inst) {
                            return null;
                        }
                        const footprint = computeVertexChunkHeightFootprint(localUV, inst, texSize);
                        if (!footprint) {
                            return null;
                        }
                        const coords = uniqueTexelCoords([
                            { x: footprint.x0, y: footprint.y0 },
                            { x: footprint.x1, y: footprint.y0 },
                            { x: footprint.x0, y: footprint.y1 },
                            { x: footprint.x1, y: footprint.y1 }
                        ]);

                        const values = new Map();
                        const texFormat = format || 'r32float';
                        for (const coord of coords) {
                            const cacheKey = `${cachePrefix}:${coord.x}:${coord.y}`;
                            let sampleValue = readCache?.get(cacheKey);
                            if (!Number.isFinite(sampleValue)) {
                                const readback = await tileStreamer._debugReadTextureTexels(textureLike, texFormat, [coord]);
                                sampleValue = readback?.texels?.[0]?.values?.[0];
                                if (Number.isFinite(sampleValue)) {
                                    readCache?.set(cacheKey, sampleValue);
                                }
                            }
                            if (!Number.isFinite(sampleValue)) {
                                return null;
                            }
                            values.set(`${coord.x},${coord.y}`, sampleValue);
                        }

                        const h00 = values.get(`${footprint.x0},${footprint.y0}`);
                        const h10 = values.get(`${footprint.x1},${footprint.y0}`);
                        const h01 = values.get(`${footprint.x0},${footprint.y1}`);
                        const h11 = values.get(`${footprint.x1},${footprint.y1}`);
                        if (![h00, h10, h01, h11].every(Number.isFinite)) {
                            return null;
                        }

                        const hx0 = h00 * (1.0 - footprint.fx) + h10 * footprint.fx;
                        const hx1 = h01 * (1.0 - footprint.fx) + h11 * footprint.fx;
                        return hx0 * (1.0 - footprint.fy) + hx1 * footprint.fy;
                    },

        async _debugSampleHeightAtChunkUV(inst, localUV, options = null, readCache = null) {
                        const tileStreamer = this.tileStreamer;
                        const texSize = tileStreamer?.tileTextureSize ?? 0;
                        if (!(texSize > 0) || !tileStreamer?.debugReadArrayLayerTexels) {
                            return null;
                        }
                        const sampleMode = options?.mode ?? 'current';
                        const sampleLOD = Number.isFinite(options?.sampleLOD) ? Math.floor(options.sampleLOD) : (inst?.lod ?? 0);
                        const footprint = sampleMode === 'intended'
                            ? computeVertexIntendedHeightFootprint(localUV, inst, texSize, sampleLOD, this._diagLodSegments)
                            : computeVertexChunkHeightFootprint(localUV, inst, texSize);
                        if (!footprint) {
                            return null;
                        }
                        const coords = uniqueTexelCoords([
                            { x: footprint.x0, y: footprint.y0 },
                            { x: footprint.x1, y: footprint.y0 },
                            { x: footprint.x0, y: footprint.y1 },
                            { x: footprint.x1, y: footprint.y1 }
                        ]);

                        const values = new Map();
                        for (const coord of coords) {
                            const cacheKey = `height:${inst.layer}:${coord.x}:${coord.y}`;
                            let sampleValue = readCache?.get(cacheKey);
                            if (!Number.isFinite(sampleValue)) {
                                const readback = await tileStreamer.debugReadArrayLayerTexels('height', inst.layer, [coord]);
                                sampleValue = readback?.texels?.[0]?.values?.[0];
                                if (Number.isFinite(sampleValue)) {
                                    readCache?.set(cacheKey, sampleValue);
                                }
                            }
                            if (!Number.isFinite(sampleValue)) {
                                return null;
                            }
                            values.set(`${coord.x},${coord.y}`, sampleValue);
                        }

                        const h00 = values.get(`${footprint.x0},${footprint.y0}`);
                        const h10 = values.get(`${footprint.x1},${footprint.y0}`);
                        const h01 = values.get(`${footprint.x0},${footprint.y1}`);
                        const h11 = values.get(`${footprint.x1},${footprint.y1}`);
                        if (![h00, h10, h01, h11].every(Number.isFinite)) {
                            return null;
                        }

                        const hx0 = h00 * (1.0 - footprint.fx) + h10 * footprint.fx;
                        const hx1 = h01 * (1.0 - footprint.fx) + h11 * footprint.fx;
                        return hx0 * (1.0 - footprint.fy) + hx1 * footprint.fy;
                    }
        })
    );
}
