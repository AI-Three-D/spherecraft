// js/world/quadtree/GPUQuadtreeTerrain.js
//
// Manages GPU-driven quadtree traversal + tile streaming.
// Pure data/selection concern: decides which tiles are visible and
// streams their data into GPU tile pools.
//
// Rendering is handled by renderer/terrain/QuadtreeTerrainRenderer.

import { QuadtreeGPU } from './QuadtreeGPU.js';
import { TileStreamer } from './tileStreamer.js';
import { TileAddress } from './tileAddress.js';
import { TerrainGeometryBuilder } from '../../mesh/terrain/terrainGeometryBuilder.js';
import { Logger } from '../../config/Logger.js';

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';
const TERRAIN_MANUAL_TAG = '[QTManual]';


// GPUQuadtreeTerrain.js

class QuadtreeDiagSnapshot {
    constructor(logger = Logger) {
      this.log = logger;
    }
  
    logVisibleSummary(tiles) {
      return;
      const total = tiles?.length ?? 0;
      if (total === 0) {
        this.log.info('[QT-Diag] Visible tiles: 0');
        return;
      }

      let minD = Infinity;
      let maxD = -Infinity;
      const faces = new Set();
      for (const t of tiles) {
        minD = Math.min(minD, t.depth);
        maxD = Math.max(maxD, t.depth);
        faces.add(t.face);
      }
      const faceList = Array.from(faces).sort((a, b) => a - b).join(',');
      this.log.info(
        `[QT-Diag] Visible tiles: ${total} | depth=[${minD}..${maxD}] | faces=[${faceList}]`
      );
    }

    logVisibleHistograms(tiles) {
      return;
      const depthHist = {};
      const faceHist = {};
      for (const t of tiles) {
        depthHist[t.depth] = (depthHist[t.depth] || 0) + 1;
        faceHist[t.face] = (faceHist[t.face] || 0) + 1;
      }
      const depthStr = Object.entries(depthHist)
        .sort((a, b) => +a[0] - +b[0])
        .map(([d, c]) => `d${d}:${c}`)
        .join(' ');
      const faceStr = Object.entries(faceHist)
        .sort((a, b) => +a[0] - +b[0])
        .map(([f, c]) => `f${f}:${c}`)
        .join(' ');
      this.log.info(`[QT-Diag] Depth histogram: ${depthStr}`);
      this.log.info(`[QT-Diag] Face histogram: ${faceStr}`);
    }

    logVisibleCoverageArea(tiles) {
      if (!tiles || tiles.length === 0) return;
      const faceArea = new Map();
      for (const t of tiles) {
        const depth = t.depth;
        const area = 1.0 / (1 << (2 * depth)); // 1 / 4^depth
        faceArea.set(t.face, (faceArea.get(t.face) || 0) + area);
      }
      const rows = Array.from(faceArea.entries()).sort((a, b) => a[0] - b[0]);
      const parts = rows.map(([f, a]) => `f${f}:${a.toFixed(4)}`);
   //   this.log.info(`[QT-Diag] Visible area by face (sum of tile areas): ${parts.join(' ')}`);
    }

    logVisibleDistanceStats(tiles, camera, planetConfig) {
      return;
      if (!tiles || tiles.length === 0) return;
      if (!camera?.position || !planetConfig) return;

      const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
      const radius = planetConfig.radius ?? planetConfig.radiusMeters ?? null;
      if (!Number.isFinite(radius)) return;

      const cam = camera.position;
      const far = camera.far;
      const near = camera.near;

      const getTileWorldCenter = (face, depth, x, y) => {
        const grid = 1 << depth;
        const u = (x + 0.5) / grid;
        const v = (y + 0.5) / grid;
        const s = u * 2 - 1;
        const t = v * 2 - 1;
        let cx = 0, cy = 0, cz = 0;
        switch (face) {
          case 0: cx = 1;   cy = t;  cz = -s; break;
          case 1: cx = -1;  cy = t;  cz =  s; break;
          case 2: cx = s;   cy = 1;  cz = -t; break;
          case 3: cx = s;   cy = -1; cz =  t; break;
          case 4: cx = s;   cy = t;  cz =  1; break;
          case 5: cx = -s;  cy = t;  cz = -1; break;
          default: cx = 0;  cy = 1;  cz =  0; break;
        }
        const len = Math.hypot(cx, cy, cz) || 1;
        const dx = cx / len;
        const dy = cy / len;
        const dz = cz / len;
        return {
          x: origin.x + dx * radius,
          y: origin.y + dy * radius,
          z: origin.z + dz * radius
        };
      };

      let minDist = Infinity;
      let maxDist = -Infinity;
      let minTile = null;
      let maxTile = null;
      let sumDist = 0;
      let overFar = 0;
      const byDepth = new Map();

      for (const t of tiles) {
        const c = getTileWorldCenter(t.face, t.depth, t.x, t.y);
        const dx = c.x - cam.x;
        const dy = c.y - cam.y;
        const dz = c.z - cam.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < minDist) {
          minDist = dist;
          minTile = t;
        }
        if (dist > maxDist) {
          maxDist = dist;
          maxTile = t;
        }
        sumDist += dist;
        if (Number.isFinite(far) && dist > far) overFar++;

        let d = byDepth.get(t.depth);
        if (!d) {
          d = { min: Infinity, max: -Infinity, count: 0 };
          byDepth.set(t.depth, d);
        }
        d.min = Math.min(d.min, dist);
        d.max = Math.max(d.max, dist);
        d.count++;
      }

      const avgDist = sumDist / tiles.length;
      const farStr = Number.isFinite(far) ? far.toFixed(1) : 'n/a';
      const nearStr = Number.isFinite(near) ? near.toFixed(3) : 'n/a';
      this.log.info(
        `[QT-Diag] Visible dist→camera: min=${minDist.toFixed(1)} max=${maxDist.toFixed(1)} ` +
        `avg=${avgDist.toFixed(1)} overFar=${overFar}/${tiles.length} far=${farStr} near=${nearStr}`
      );

      const depthStr = Array.from(byDepth.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([depth, s]) =>
          `d${depth}: min=${s.min.toFixed(1)} max=${s.max.toFixed(1)} n=${s.count}`
        )
        .join(' | ');
      this.log.info(`[QT-Diag] Visible dist by depth: ${depthStr}`);

      return { minTile, maxTile, minDist, maxDist };
    }

    getFaceDistanceStats(tiles, camera, planetConfig, face) {
      if (!tiles || tiles.length === 0) return null;
      if (!camera?.position || !planetConfig) return null;
      if (!Number.isFinite(face)) return null;

      const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
      const radius = planetConfig.radius ?? planetConfig.radiusMeters ?? null;
      if (!Number.isFinite(radius)) return null;

      const cam = camera.position;

      const getTileWorldCenter = (f, depth, x, y) => {
        const grid = 1 << depth;
        const u = (x + 0.5) / grid;
        const v = (y + 0.5) / grid;
        const s = u * 2 - 1;
        const t = v * 2 - 1;
        let cx = 0, cy = 0, cz = 0;
        switch (f) {
          case 0: cx = 1;   cy = t;  cz = -s; break;
          case 1: cx = -1;  cy = t;  cz =  s; break;
          case 2: cx = s;   cy = 1;  cz = -t; break;
          case 3: cx = s;   cy = -1; cz =  t; break;
          case 4: cx = s;   cy = t;  cz =  1; break;
          case 5: cx = -s;  cy = t;  cz = -1; break;
          default: cx = 0;  cy = 1;  cz =  0; break;
        }
        const len = Math.hypot(cx, cy, cz) || 1;
        const dx = cx / len;
        const dy = cy / len;
        const dz = cz / len;
        return {
          x: origin.x + dx * radius,
          y: origin.y + dy * radius,
          z: origin.z + dz * radius
        };
      };

      let minDist = Infinity;
      let maxDist = -Infinity;
      let minTile = null;
      let maxTile = null;
      let count = 0;

      for (const t of tiles) {
        if (t.face !== face) continue;
        const c = getTileWorldCenter(t.face, t.depth, t.x, t.y);
        const dx = c.x - cam.x;
        const dy = c.y - cam.y;
        const dz = c.z - cam.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < minDist) { minDist = dist; minTile = t; }
        if (dist > maxDist) { maxDist = dist; maxTile = t; }
        count++;
      }

      if (!count) return null;
      const minDesc = minTile ? `d${minTile.depth}(${minTile.x},${minTile.y})` : 'n/a';
      const maxDesc = maxTile ? `d${maxTile.depth}(${maxTile.x},${maxTile.y})` : 'n/a';
      this.log.info(
        `[QT-Diag] Visible dist on camFace f${face}: ` +
        `min=${minDist.toFixed(1)} (${minDesc}) ` +
        `max=${maxDist.toFixed(1)} (${maxDesc}) n=${count}`
      );
      return { minTile, maxTile, minDist, maxDist, count, face };
    }

    logTraversalCounters(counters) {
      return;
      if (!counters) return;
      this.log.info(
        `[QT-Diag] Counters: queueA=${counters.queueA} queueB=${counters.queueB} ` +
        `visible=${counters.visible} maxQueue=${counters.reserved}`
      );
    }

    logVisibleParentChildOverlaps(tiles, maxSamples = 8) {
      return;
      if (!tiles || tiles.length === 0) return;
      const key = (f, d, x, y) => `f${f}:d${d}:${x},${y}`;
      const set = new Set();
      for (const t of tiles) {
        set.add(key(t.face, t.depth, t.x, t.y));
      }

      let overlapCount = 0;
      const samples = [];
      const byChildDepth = new Map();
      for (const t of tiles) {
        let d = t.depth;
        let x = t.x;
        let y = t.y;
        while (d > 0) {
          d--;
          x >>= 1;
          y >>= 1;
          if (set.has(key(t.face, d, x, y))) {
            overlapCount++;
            byChildDepth.set(t.depth, (byChildDepth.get(t.depth) || 0) + 1);
            if (samples.length < maxSamples) {
              samples.push({
                child: `f${t.face} d${t.depth} (${t.x},${t.y})`,
                parent: `f${t.face} d${d} (${x},${y})`
              });
            }
            break;
          }
        }
      }

      if (overlapCount === 0) {
        this.log.info('[QT-Diag] Parent-child overlap: 0');
        return;
      }

      const depthStr = Array.from(byChildDepth.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([d, c]) => `d${d}:${c}`)
        .join(' ');

      this.log.warn(
        `[QT-Diag] Parent-child overlap: ${overlapCount} (by child depth: ${depthStr})`
      );
      for (const s of samples) {
        this.log.warn(`  overlap: child ${s.child} -> parent ${s.parent}`);
      }
    }

    async logInstancePlacementCollisions(quadtreeGPU, meta, maxToCheck = 4096) {
      return;
      if (!quadtreeGPU || !meta?.lodArgs?.length) return;

      const quant = (v, scale = 1e6) => Math.round(v * scale);
      const placements = new Map();
      let totalRead = 0;

      for (const a of meta.lodArgs) {
        if (!a.instanceCount) continue;
        if (totalRead >= maxToCheck) break;

        const remaining = maxToCheck - totalRead;
        const readCount = Math.min(a.instanceCount, remaining);
        const instances = await quadtreeGPU.debugReadInstancesRange(
          a.firstInstance,
          a.instanceCount,
          readCount
        );
        totalRead += instances.length;

        for (const inst of instances) {
          const k = [
            inst.face,
            quant(inst.chunkLocation.x),
            quant(inst.chunkLocation.y),
            quant(inst.chunkSizeUV)
          ].join('|');
          let entry = placements.get(k);
          if (!entry) {
            entry = { count: 0, lods: new Set(), sample: inst };
            placements.set(k, entry);
          }
          entry.count++;
          entry.lods.add(inst.lod);
        }
      }

      let collisionCount = 0;
      const crossLod = [];
      const sameLod = [];
      for (const entry of placements.values()) {
        if (entry.count > 1) {
          collisionCount += (entry.count - 1);
          if (entry.lods.size > 1) {
            crossLod.push(entry);
          } else {
            sameLod.push(entry);
          }
        }
      }

      if (collisionCount === 0) {
        this.log.info('[QT-Diag] Instance placement collisions: 0');
        return;
      }

      this.log.warn(
        `[QT-Diag] Instance placement collisions: ${collisionCount} ` +
        `(crossLOD=${crossLod.length}, sameLOD=${sameLod.length}, checked=${totalRead})`
      );

      const sampleList = crossLod.length > 0 ? crossLod : sameLod;
      for (const entry of sampleList.slice(0, 6)) {
        const s = entry.sample;
        const lods = Array.from(entry.lods).sort((a, b) => a - b).join(',');
        this.log.warn(
          `  dup face=${s.face} loc=(${s.chunkLocation.x.toFixed(6)},${s.chunkLocation.y.toFixed(6)}) ` +
          `size=${s.chunkSizeUV.toFixed(6)} lods=[${lods}] count=${entry.count}`
        );
      }
    }

    async logInstanceFaceHistogram(quadtreeGPU, meta, maxToRead = 2048) {
      return;
      if (!quadtreeGPU || !meta?.lodArgs?.length) return;

      const total = meta.lodArgs.reduce((sum, a) => sum + (a.instanceCount || 0), 0);
      if (total <= 0) return;

      const readCount = Math.min(total, maxToRead);
      const instances = await quadtreeGPU.debugReadInstancesRange(0, total, readCount);
      if (!instances?.length) return;

      const faceHist = {};
      const depthHist = {};
      for (const inst of instances) {
        const face = inst.face ?? 0;
        faceHist[face] = (faceHist[face] || 0) + 1;
        const depth = Math.round(Math.log2(1 / Math.max(inst.chunkSizeUV, 1e-9)));
        depthHist[depth] = (depthHist[depth] || 0) + 1;
      }

      const faceStr = Object.entries(faceHist)
        .sort((a, b) => +a[0] - +b[0])
        .map(([f, c]) => `f${f}:${c}`)
        .join(' ');
      const depthStr = Object.entries(depthHist)
        .sort((a, b) => +a[0] - +b[0])
        .map(([d, c]) => `d${d}:${c}`)
        .join(' ');

      this.log.info(
        `[QT-Diag] Instance faces (first ${readCount}/${total}): ${faceStr}`
      );
      this.log.info(
        `[QT-Diag] Instance depth≈ (from chunkSizeUV): ${depthStr}`
      );
    }

    logInstanceCoverageAndMismatch(tiles, instances, totalInstances, readCount) {
      return;
      if (!tiles || !instances || instances.length === 0) return;

      const visibleSet = new Set();
      for (const t of tiles) {
        visibleSet.add(`${t.face}|${t.depth}|${t.x}|${t.y}`);
      }

      const matchedVisible = new Set();
      let extra = 0;

      const byFaceDepth = new Map();
      let minU = Infinity, maxU = -Infinity;
      let minV = Infinity, maxV = -Infinity;

      for (const inst of instances) {
        const face = inst.face ?? 0;
        const size = inst.chunkSizeUV || 0;
        if (!(size > 0)) continue;
        const depth = Math.round(Math.log2(1 / size));
        const grid = 1 << depth;
        const x = Math.max(0, Math.min(grid - 1, Math.floor(inst.chunkLocation.x / size)));
        const y = Math.max(0, Math.min(grid - 1, Math.floor(inst.chunkLocation.y / size)));
        const key = `${face}|${depth}|${x}|${y}`;
        if (visibleSet.has(key)) {
          matchedVisible.add(key);
        } else {
          extra++;
        }

        minU = Math.min(minU, inst.chunkLocation.x);
        maxU = Math.max(maxU, inst.chunkLocation.x + size);
        minV = Math.min(minV, inst.chunkLocation.y);
        maxV = Math.max(maxV, inst.chunkLocation.y + size);

        const fdKey = `${face}:${depth}`;
        let s = byFaceDepth.get(fdKey);
        if (!s) {
          s = { face, depth, minX: x, maxX: x, minY: y, maxY: y, count: 0 };
          byFaceDepth.set(fdKey, s);
        }
        s.count++;
        s.minX = Math.min(s.minX, x); s.maxX = Math.max(s.maxX, x);
        s.minY = Math.min(s.minY, y); s.maxY = Math.max(s.maxY, y);
      }

      const totalVisible = visibleSet.size;
      const matched = matchedVisible.size;
      const missing = Math.max(0, totalVisible - matched);
      const readStr = `${readCount}/${totalInstances}`;
      this.log.info(
        `[QT-Diag] Instance↔visible match (read ${readStr}): ` +
        `matched=${matched}/${totalVisible} missing≈${missing} extra=${extra}`
      );

      if (Number.isFinite(minU) && Number.isFinite(minV)) {
        this.log.info(
          `[QT-Diag] Instance UV bounds: u=[${minU.toFixed(4)}..${maxU.toFixed(4)}] ` +
          `v=[${minV.toFixed(4)}..${maxV.toFixed(4)}]`
        );
      }

      const rows = [];
      for (const s of byFaceDepth.values()) {
        rows.push({
          face: s.face,
          depth: s.depth,
          count: s.count,
          spanX: (s.maxX - s.minX + 1),
          spanY: (s.maxY - s.minY + 1),
          minX: s.minX, maxX: s.maxX,
          minY: s.minY, maxY: s.maxY,
        });
      }
      rows.sort((a, b) => (a.depth - b.depth) || (a.face - b.face));
      this.log.info(`[QT-Diag] Instance coverage (face/depth spans) from readback:`);
      for (const r of rows) {
        const grid = 1 << r.depth;
        const fracX = r.spanX / grid;
        const fracY = r.spanY / grid;
        const fracArea = (r.spanX * r.spanY) / (grid * grid);
        this.log.info(
          `  f${r.face} d${r.depth}: count=${r.count} span=(${r.spanX}x${r.spanY}) ` +
          `grid=${grid} frac=(${fracX.toFixed(3)}x${fracY.toFixed(3)}) area=${fracArea.toFixed(3)} ` +
          `x=[${r.minX}..${r.maxX}] y=[${r.minY}..${r.maxY}]`
        );
      }
    }

    logInstanceLayerStats(instances, textures) {
      return;
      if (!instances || instances.length === 0) return;

      const getDepth = (tex) => {
        if (!tex) return null;
        if (Number.isFinite(tex.depth)) return tex.depth;
        const gpuDepth = tex._gpuTexture?.texture?.depthOrArrayLayers;
        if (Number.isFinite(gpuDepth)) return gpuDepth;
        return null;
      };

      const texInfo = {};
      if (textures) {
        for (const [name, tex] of Object.entries(textures)) {
          const depth = getDepth(tex);
          if (!Number.isFinite(depth)) continue;
          texInfo[name] = { depth, isArray: !!tex?._isArray };
        }
      }

      let minLayer = Infinity;
      let maxLayer = -Infinity;
      let nonInt = 0;
      let nan = 0;
      let neg = 0;
      const overDepth = {};

      for (const inst of instances) {
        const raw = inst.layer;
        if (!Number.isFinite(raw)) {
          nan++;
          continue;
        }
        const layer = Math.round(raw);
        if (Math.abs(layer - raw) > 1e-3) nonInt++;
        minLayer = Math.min(minLayer, layer);
        maxLayer = Math.max(maxLayer, layer);
        if (layer < 0) neg++;
        for (const [name, info] of Object.entries(texInfo)) {
          if (!Number.isFinite(info.depth)) continue;
          if (layer < 0 || layer >= info.depth) {
            overDepth[name] = (overDepth[name] || 0) + 1;
          }
        }
      }

      if (Number.isFinite(minLayer) && Number.isFinite(maxLayer)) {
        this.log.info(
          `[QT-Diag] Instance layer stats: min=${minLayer} max=${maxLayer} ` +
          `nonInt=${nonInt} nan=${nan} neg=${neg}`
        );
      }

  
    }

    // Coverage in quadtree coords (x/y range per face+depth). This tells you if traversal reaches “far”.
    logVisibleCoverage(tiles) {
      return;
      const byFaceDepth = new Map(); // key `${face}:${depth}` -> {minX,maxX,minY,maxY,count}
      for (const t of tiles) {
        const key = `${t.face}:${t.depth}`;
        let s = byFaceDepth.get(key);
        if (!s) {
          s = { face: t.face, depth: t.depth, minX: t.x, maxX: t.x, minY: t.y, maxY: t.y, count: 0 };
          byFaceDepth.set(key, s);
        }
        s.count++;
        s.minX = Math.min(s.minX, t.x); s.maxX = Math.max(s.maxX, t.x);
        s.minY = Math.min(s.minY, t.y); s.maxY = Math.max(s.maxY, t.y);
      }
  
      // Print compact: per depth, how wide the coverage is (max-min+1)
      const rows = [];
      for (const s of byFaceDepth.values()) {
        rows.push({
          face: s.face,
          depth: s.depth,
          count: s.count,
          spanX: (s.maxX - s.minX + 1),
          spanY: (s.maxY - s.minY + 1),
          minX: s.minX, maxX: s.maxX,
          minY: s.minY, maxY: s.maxY,
        });
      }
      rows.sort((a, b) => (a.depth - b.depth) || (a.face - b.face));

    }
  
    parseMeta(raw, maxLODLevels) {
      const lodCounts   = raw.slice(0, maxLODLevels);
      const lodOffsets  = raw.slice(maxLODLevels, maxLODLevels * 2);
      const lodWrite    = raw.slice(maxLODLevels * 2, maxLODLevels * 3);
      const indirect    = raw.slice(maxLODLevels * 3, maxLODLevels * 3 + maxLODLevels * 5);
  
      const tail = maxLODLevels * 8;
      const feedbackCount = raw[tail + 0];
      const parentFallbackHits = raw[tail + 1];
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
    }
  
    logMeta(meta) {
      return;
      const parts = meta.lodArgs.map(a =>
        `L${a.lod}: vis=${a.lodCountVisible} inst=${a.instanceCount} firstInst=${a.firstInstance} off=${a.lodOffset}`
      );
      this.log.info(`[QT-Diag] Indirect/Meta: ${parts.join(' | ')}`);
      this.log.info(`[QT-Diag] feedbackCount=${meta.feedbackCount} parentFallbackHits=${meta.parentFallbackHits}`);
    }
  
    async logPerLodInstanceSamples(quadtreeGPU, meta, maxLODLevels, samplesPerLod = 3) {
      return;
      const refList = await quadtreeGPU.debugReadInstancesRange(0, 1, 1);
      const ref = refList.length ? refList[0] : null;
      const isSame = (a, b) => (
        a &&
        b &&
        a.face === b.face &&
        a.lod === b.lod &&
        a.layer === b.layer &&
        Math.abs(a.chunkLocation.x - b.chunkLocation.x) < 1e-6 &&
        Math.abs(a.chunkLocation.y - b.chunkLocation.y) < 1e-6 &&
        Math.abs(a.chunkSizeUV - b.chunkSizeUV) < 1e-6
      );
      for (let l = 0; l < maxLODLevels; l++) {
        const a = meta.lodArgs[l];
        if (!a.instanceCount) continue;
  
        const inst = await quadtreeGPU.debugReadInstancesRange(a.firstInstance, a.instanceCount, samplesPerLod);
  
        const sizes = inst.map(i => i.chunkSizeUV).sort((x, y) => x - y);
        const sizeStr = sizes.map(v => v.toFixed(6)).join(', ');
        const locStr = inst.map(i => `(${i.chunkLocation.x.toFixed(4)},${i.chunkLocation.y.toFixed(4)})`).join(' ');
        const faceStr = inst.map(i => i.face).join(',');
        const lodStr = inst.map(i => i.lod).join(',');
        const layerStr = inst.map(i => i.layer).join(',');
        const sameAsRef = ref ? inst.every(i => isSame(i, ref)) : false;
  
        this.log.info(
          `[New-QT] L${l}: firstInst=${a.firstInstance} count=${a.instanceCount} ` +
          `face=[${faceStr}] lod=[${lodStr}] layer=[${layerStr}] ` +
          `chunkSizeUV=[${sizeStr}] loc=${locStr} sameAsInst0=${sameAsRef}`
        );
      }
    }
  }


export class QuadtreeTileManager {
    constructor(options = {}) {
        this._prevCameraPos = null;
        this._prevFrameTime = 0;
        this._lodSpeedScale = 1.0;
        this._lodSpeedScaleTarget = 1.0;
        this._adaptiveLodConfig = null;
        this.backend = options.backend || null;
        this.device = this.backend?.device || null;
        this.engineConfig = options.engineConfig || null;
        this.planetConfig = options.planetConfig || null;
        this.terrainGenerator = options.terrainGenerator || null;
        this._initialized = false;
        this._maxGeomLOD = 14;

        this.quadtreeGPU = null;
        this.tileStreamer = null;

        this._visibleReadbackFrame = 0;
        this._visibleReadbackPending = false;
        this._diagFrame = 0;
        this._diagInterval = 0;         // set from config in initialize()
        this._diagReadInstances = true; // enable instance sampling
        this._lastVisibleTiles = null;
        this._stitchDiagFrame = 0;
        this._stitchDiagPending = false;
        this._diagLodSegments = [128, 64, 32, 16, 8, 4, 2];
        this._seamDiagTick = 0;
        this._seamDiagSeen = new Map();
        this._deepSeamDiagTick = 0;
        this._lastDeepSeamKey = '';
        this._lightDiagFrame = 0;
        this._manualDiagId = 0;
        this._manualDiagState = {
            status: 'idle',
            requested: false,
            frozen: false,
            running: false,
            completed: false,
            reason: '',
            snapshotId: 0,
            requestedAt: 0,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            lastSummary: null,
            error: ''
        };
        this._manualDiagRunPending = false;

        // ── Debug profiling state ────────────────────────────────────
        this._profileFrame = 0;
        this._profileFrozen = false;
        this._profileFpsAccum = 0;
        this._profileFpsSamples = 0;
        this._profileLastTime = 0;
        this._profileLogInterval = 60; // log FPS every 60 frames

        // ── Predictive streaming state ───────────────────────────────
        // Raw velocity is written by _updateAdaptiveLodScale and read here.
        this._rawCamVelocity = null;
        // EMA-smoothed velocity (world units / second).
        this._predictState = { smoothVelX: 0, smoothVelY: 0, smoothVelZ: 0 };
    }

    async initialize() {
        if (this._initialized) return;
        if (!this.device || !this.backend) {
            throw new Error('QuadtreeTileManager requires a WebGPU backend');
        }
        if (!this.engineConfig?.gpuQuadtree) {
            throw new Error('QuadtreeTileManager requires engineConfig.gpuQuadtree');
        }
        if (!this.planetConfig) {
            throw new Error('QuadtreeTileManager requires planetConfig');
        }


        const qt = this.engineConfig.gpuQuadtree;
        const al = qt.adaptiveLod || {};
        this._adaptiveLodConfig = {
            enabled: al.enabled !== false,
            // no adaptation below this speed
            speedFloorMps: al.speedFloorMps ?? 150,
            // each +speedRefMps over the floor adds +1.0 to the scale
            speedRefMps: al.speedRefMps ?? 600,
            maxScale: al.maxScale ?? 3.0,
            // asymmetric smoothing: ramp up fast (protect GPU),
            // ease down slow (avoid request burst on deceleration)
            smoothUp: al.smoothUp ?? 0.15,
            smoothDown: al.smoothDown ?? 0.03,
            // hold elevated scale while GPU still has a backlog
            holdWhenGpuBacklogged: al.holdWhenGpuBacklogged !== false
        };

        this._diagInterval = qt.diagnosticSnapshotIntervalFrames ?? 0;
        const planetRadius = this.planetConfig.radius;
        const planetOrigin = this.planetConfig.origin;

        // Compute maxGeomLOD from segment config (needed by QuadtreeGPU for indirect args)
        const baseSegments = this.engineConfig.chunkSegments;
        const lodSegments = TerrainGeometryBuilder.buildSegmentArray(baseSegments);
        this._diagLodSegments = Array.isArray(lodSegments) && lodSegments.length > 0
            ? [...lodSegments]
            : this._diagLodSegments;
        this._maxGeomLOD = Math.max(0, lodSegments.length - 1);
        const maxAbsNormalized = 1.8; // max(|-1.1|, |1.8|)
        const maxHeightDisplacement = maxAbsNormalized * this.planetConfig.maxTerrainHeight;
        
        this.quadtreeGPU = new QuadtreeGPU(this.device, {
            maxHeightDisplacement: maxHeightDisplacement,
            planetRadius: planetRadius,
            planetOrigin: planetOrigin,
            minTileSize: qt.minTileSizeMeters,
            maxVisibleTiles: qt.maxVisibleTiles,
            queueCapacity: qt.queueCapacity,
            screenHeight: this.backend.canvas?.height || 1080,
            fovDegrees: this.engineConfig.camera?.fov ?? 75,
            lodErrorThreshold: qt.lodErrorThreshold,
            workgroupSize: qt.workgroupSize,
            maxGeomLOD: this._maxGeomLOD,
            visibleTableCapacity: qt.visibleTableCapacity,
            loadedTableCapacity: qt.tileHashCapacity,
            maxFeedback: qt.feedbackCapacity,
            enableFrustumCulling: qt.enableFrustumCulling,
            enableHorizonCulling: qt.enableHorizonCulling,
            horizonGroundCos: qt.horizonCulling?.groundCos,
            horizonBlendScale: qt.horizonCulling?.blendScale,
            logStats: qt.logStats === true
        });

        await this.quadtreeGPU.initialize();

        const requiredTypes = ['height', 'normal', 'tile', 'splatData', 'scatter', 'climate'];
        const textureFormats = {
            height:    'r32float',
            normal:    'rgba8unorm',
            tile:      'r8unorm',
            splatData: 'rgba8unorm',
            scatter:   'r8unorm',
            climate:   'rgba8unorm',
            ...(qt.textureFormats || {})
        };
        this.tileStreamer = new TileStreamer(
          this.device,
          this.terrainGenerator,
          this.quadtreeGPU,
          {
              tileTextureSize: qt.tileTextureSize,
              tilePoolSize: qt.tilePoolSize,
              maxPoolBytes: qt.tilePoolMaxBytes,
              tileHashCapacity: qt.tileHashCapacity,
              maxFeedback: qt.feedbackCapacity,
              queueConfig: this.engineConfig.generationQueue,
              requiredTypes,
              textureFormats,
              enableSplat: true,
              enableTileCacheBridge: false,
              feedbackReadbackInterval: qt.feedbackReadbackInterval,
              feedbackReadbackRingSize: qt.feedbackReadbackRingSize,
              gpuBackpressureLimit: qt.gpuBackpressureLimit ?? 4,   // NEW
              logStats: qt.logStats === true
          }
      );
        await this.tileStreamer.initialize();

        this._initialized = true;
        Logger.info('[QuadtreeTileManager] Initialized');
    }

    _updateAdaptiveLodScale(camera) {
        const cfg = this._adaptiveLodConfig;
        if (!cfg?.enabled || !camera?.position) {
            this._lodSpeedScale = 1.0;
            return;
        }

        const now = performance.now();
        const pos = camera.position;

        if (this._prevCameraPos && this._prevFrameTime > 0) {
            const dt = (now - this._prevFrameTime) / 1000;
            // Ignore degenerate dt: first frame, long pause, tab switch.
            if (dt > 0.001 && dt < 0.5) {
                const dx = pos.x - this._prevCameraPos.x;
                const dy = pos.y - this._prevCameraPos.y;
                const dz = pos.z - this._prevCameraPos.z;
                const speed = Math.hypot(dx, dy, dz) / dt;

                // Store raw velocity for predictive streaming.
                this._rawCamVelocity = { x: dx / dt, y: dy / dt, z: dz / dt };

                const excess = Math.max(0, speed - cfg.speedFloorMps);
                const rawScale = 1.0 + excess / Math.max(cfg.speedRefMps, 1);
                this._lodSpeedScaleTarget = Math.min(rawScale, cfg.maxScale);
            }
        }

        // Smooth toward target. Asymmetric: fast up, slow down.
        const delta = this._lodSpeedScaleTarget - this._lodSpeedScale;
        let smooth = delta > 0 ? cfg.smoothUp : cfg.smoothDown;

        // Don't lower the scale while the GPU is still digesting.
        // Otherwise deceleration triggers an immediate request burst
        // right when the queue is deepest.
        if (cfg.holdWhenGpuBacklogged && delta < 0) {
            const gpuInFlight =
                this.tileStreamer?.tileGenerator?._gpuFencesInFlight ?? 0;
            const gpuLimit = this.tileStreamer?._gpuBackpressureLimit ?? 4;
            if (gpuInFlight >= gpuLimit) {
                smooth = 0;
            }
        }

        this._lodSpeedScale = Math.max(1.0, this._lodSpeedScale + delta * smooth);

        this._prevCameraPos = { x: pos.x, y: pos.y, z: pos.z };
        this._prevFrameTime = now;
    }

    // ── Predictive tile streaming ────────────────────────────────────────────
    //
    // Each frame, extrapolates the camera position forward along its
    // EMA-smoothed velocity and pre-queues tiles at the predicted location
    // before the GPU feedback pipeline would discover them.
    //
    // Design constraints:
    //   - Conservative: look-ahead time scales with speed, capped at 1.5 s.
    //   - Responsive: EMA alpha of 0.15 gives ~7-frame (115 ms) response,
    //     fast enough to track airplane-speed turns (several seconds).
    //   - Safe: tiles already loaded or generating are skipped; the
    //     generation queue handles priority and deduplication.
    //
    // Controlled by engineConfig.gpuQuadtree.predictiveStreaming.enabled.
    _updatePredictiveStreaming(camera) {
        const cfg = this.engineConfig?.gpuQuadtree?.predictiveStreaming;
        if (!cfg?.enabled) return;
        if (!camera?.position) return;
        if (!this.tileStreamer?.hashTable || !this.tileStreamer?.tileGenerator) return;
        if (!this.quadtreeGPU) return;

        const pos = camera.position;
        const ps  = this._predictState;

        // ── 1. Smooth velocity ───────────────────────────────────────
        // Raw velocity is written by _updateAdaptiveLodScale (same frame,
        // runs just before this method).  If the camera hasn't moved yet,
        // keep the previous smoothed value.
        const rawVx = this._rawCamVelocity?.x ?? 0;
        const rawVy = this._rawCamVelocity?.y ?? 0;
        const rawVz = this._rawCamVelocity?.z ?? 0;

        const alpha = cfg.velocitySmoothAlpha ?? 0.15;
        ps.smoothVelX += alpha * (rawVx - ps.smoothVelX);
        ps.smoothVelY += alpha * (rawVy - ps.smoothVelY);
        ps.smoothVelZ += alpha * (rawVz - ps.smoothVelZ);

        const speed = Math.hypot(ps.smoothVelX, ps.smoothVelY, ps.smoothVelZ);
        if (speed < (cfg.speedThresholdMps ?? 50)) return;

        // ── 2. Compute predicted world position ──────────────────────
        const lookAheadMax   = cfg.lookAheadTimeMaxSec  ?? 1.5;
        const lookAheadScale = cfg.lookAheadSpeedScale  ?? 0.0025;
        const lookAheadSec   = Math.min(speed * lookAheadScale, lookAheadMax);

        const predX = pos.x + ps.smoothVelX * lookAheadSec;
        const predY = pos.y + ps.smoothVelY * lookAheadSec;
        const predZ = pos.z + ps.smoothVelZ * lookAheadSec;

        // ── 3. Map predicted position → face + tile UV ───────────────
        // Inline sphereToCube: normalize the direction from planet origin,
        // then project onto the dominant cube face (same math as
        // CubeSphereCoords.sphereToCube / worldPositionToFaceUV).
        const originX = this.planetConfig?.origin?.x ?? 0;
        const originY = this.planetConfig?.origin?.y ?? 0;
        const originZ = this.planetConfig?.origin?.z ?? 0;
        const relX = predX - originX;
        const relY = predY - originY;
        const relZ = predZ - originZ;

        const len = Math.hypot(relX, relY, relZ);
        if (len < 1e-10) return;
        const nx = relX / len, ny = relY / len, nz = relZ / len;

        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        let face, cubeU, cubeV;
        if (ax >= ay && ax >= az) {
            // Face 0 (+X) or 1 (-X)
            face = nx > 0 ? 0 : 1;
            const s = 1 / ax;
            cubeU = nx > 0 ? -nz * s : nz * s;
            cubeV = ny * s;
        } else if (ay >= ax && ay >= az) {
            // Face 2 (+Y) or 3 (-Y)
            face = ny > 0 ? 2 : 3;
            const s = 1 / ay;
            cubeU = nx * s;
            cubeV = ny > 0 ? -nz * s : nz * s;
        } else {
            // Face 4 (+Z) or 5 (-Z)
            face = nz > 0 ? 4 : 5;
            const s = 1 / az;
            cubeU = nz > 0 ? nx * s : -nx * s;
            cubeV = ny * s;
        }

        // Cube UV in [-1, 1] → tile UV in [0, 1] (matches TileAddress.fromFaceUV)
        const tileU = (cubeU + 1) * 0.5;
        const tileV = (cubeV + 1) * 0.5;

        // ── 4. Queue tiles at each depth in the configured range ─────
        //
        // Neighbor radius shrinks with depth so the queued world-space
        // footprint stays roughly constant across LOD levels.  At the
        // coarsest depth we use neighborRadiusCoarse (default 4 → 9×9);
        // each extra level halves the radius because tiles are half the size.
        //   radius(d) = max(1, round(radiusCoarse / 2^(d - depthMin)))
        // Example (depthMin=4, coarse=4):
        //   depth 4 → 4  (9×9 — wide frustum sweep)
        //   depth 6 → 1  (3×3)
        //   depth 8+ → 1

        const maxDepth     = this.quadtreeGPU.maxDepth;
        const depthMin     = Math.min(cfg.depthMin         ?? 4,  maxDepth);
        const depthMax     = Math.min(cfg.depthMax         ?? 11, maxDepth);
        const radiusCoarse = cfg.neighborRadiusCoarse ?? (cfg.neighborRadius ?? 4);

        const hashTable    = this.tileStreamer.hashTable;
        const tileGenerator = this.tileStreamer.tileGenerator;

        for (let depth = depthMin; depth <= depthMax; depth++) {
            const gs = 1 << depth;
            const centerX = Math.max(0, Math.min(gs - 1, Math.floor(tileU * gs)));
            const centerY = Math.max(0, Math.min(gs - 1, Math.floor(tileV * gs)));

            const neighborRadius = Math.max(1, Math.round(radiusCoarse / Math.pow(2, depth - depthMin)));

            for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
                for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
                    const tx = centerX + dx;
                    const ty = centerY + dy;
                    if (tx < 0 || tx >= gs || ty < 0 || ty >= gs) continue;

                    // Skip if the tile is already resident in the GPU pool.
                    const keyLo = hashTable.makeKeyLo(tx, ty);
                    const keyHi = hashTable.makeKeyHi(face, depth);
                    if (hashTable.findSlot(keyLo, keyHi) >= 0) continue;

                    // Skip if generation is already in progress.
                    const addr = new TileAddress(face, depth, tx, ty);
                    if (tileGenerator.isGenerating(addr)) continue;

                    this.tileStreamer._queueTile(addr);
                }
            }
        }
    }

    toggleManualDiagnosticSnapshot(reason = 'manual') {
        if (this._manualDiagState.frozen) {
            if (this._manualDiagState.running) {
                Logger.warn(
                    `${TERRAIN_MANUAL_TAG} snapshot still running id=${this._manualDiagState.snapshotId}`
                );
                return this.getManualDiagnosticState();
            }
            this._releaseManualDiagnosticSnapshot();
            return this.getManualDiagnosticState();
        }
        if (this._manualDiagState.requested || this._manualDiagState.running) {
            Logger.warn(
                `${TERRAIN_MANUAL_TAG} snapshot busy status=${this._manualDiagState.status} ` +
                `id=${this._manualDiagState.snapshotId}`
            );
            return this.getManualDiagnosticState();
        }
        this._manualDiagId += 1;
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'requested',
            requested: true,
            frozen: false,
            running: false,
            completed: false,
            reason,
            snapshotId: this._manualDiagId,
            requestedAt: performance.now(),
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        Logger.warn(
            `${TERRAIN_MANUAL_TAG} snapshot requested id=${this._manualDiagState.snapshotId} reason=${reason}`
        );
        return this.getManualDiagnosticState();
    }

    getManualDiagnosticState() {
        const state = this._manualDiagState;
        return state ? {
            status: state.status,
            requested: state.requested,
            frozen: state.frozen,
            running: state.running,
            completed: state.completed,
            reason: state.reason,
            snapshotId: state.snapshotId,
            requestedAt: state.requestedAt,
            startedAt: state.startedAt,
            finishedAt: state.finishedAt,
            durationMs: state.durationMs,
            error: state.error,
            lastSummary: state.lastSummary
        } : null;
    }

    isManualDiagnosticFrozen() {
        return this._manualDiagState?.frozen === true;
    }

    _releaseManualDiagnosticSnapshot() {
        const snapshotId = this._manualDiagState?.snapshotId ?? 0;
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'idle',
            requested: false,
            frozen: false,
            running: false,
            completed: false,
            reason: '',
            requestedAt: 0,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        this._manualDiagRunPending = false;
        Logger.warn(`${TERRAIN_MANUAL_TAG} snapshot released id=${snapshotId}`);
    }

    _activateManualDiagnosticSnapshotFreeze() {
        if (!this._manualDiagState?.requested || this._manualDiagState.frozen) {
            return;
        }
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'frozen',
            requested: false,
            frozen: true,
            running: false,
            completed: false,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        this._manualDiagRunPending = true;
        Logger.warn(
            `${TERRAIN_MANUAL_TAG} snapshot frozen id=${this._manualDiagState.snapshotId} ` +
            `reason=${this._manualDiagState.reason}`
        );
    }

    _queueManualDiagnosticRun() {
        if (!this._manualDiagState?.frozen || !this._manualDiagRunPending || this._manualDiagState.running) {
            return;
        }
        this._manualDiagRunPending = false;
        queueMicrotask(() => {
            this._runManualDiagnosticSnapshot().catch((err) => {
                this._manualDiagState = {
                    ...this._manualDiagState,
                    status: 'frozen',
                    running: false,
                    completed: true,
                    finishedAt: performance.now(),
                    durationMs: this._manualDiagState.startedAt > 0
                        ? performance.now() - this._manualDiagState.startedAt
                        : 0,
                    error: err?.message ?? String(err)
                };
                Logger.error(
                    `${TERRAIN_MANUAL_TAG} snapshot failed id=${this._manualDiagState.snapshotId} ` +
                    `${err?.stack ?? err}`
                );
            });
        });
    }

    get maxGeomLOD() {
        return this._maxGeomLOD;
    }

    isReady() {
        return this._initialized && this.quadtreeGPU?.isReady();
    }

    /** Called by the renderer after building geometries, so indirect args get correct index counts. */
    updateLodIndexCounts(counts) {
        this.quadtreeGPU.updateLodIndexCounts(counts);
    }
    async debugReadIndirectArgs() {
        if (!this.quadtreeGPU?._metaBuffer) return null;
        
        const device = this.backend.device;
        const lodLevels = this.quadtreeGPU.lodLevels;
        const argsStartU32 = lodLevels * 3;
        const argsBytes = lodLevels * 5 * 4;
        const argsOffsetBytes = argsStartU32 * 4;
        
        const staging = device.createBuffer({
            label: 'IndirectArgsStaging',
            size: argsBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(
            this.quadtreeGPU._metaBuffer, argsOffsetBytes,
            staging, 0,
            argsBytes
        );
        device.queue.submit([encoder.finish()]);
        
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(staging.getMappedRange());
        
        const result = [];
        for (let lod = 0; lod < lodLevels; lod++) {
            const base = lod * 5;
            result.push({
                lod,
                indexCount: data[base],
                instanceCount: data[base + 1],
                firstIndex: data[base + 2],
                baseVertex: data[base + 3],
                firstInstance: data[base + 4]
            });
        }
        
        staging.unmap();
        staging.destroy();
        return result;
    }

    update(camera, commandEncoder) {
        if (!this.isReady()) return;
        if (!camera || !commandEncoder) return;

        this._lastCamera = camera;
        if (this._manualDiagState?.requested) {
            this._activateManualDiagnosticSnapshotFreeze();
        }
        if (this._manualDiagState?.frozen) {
            this._queueManualDiagnosticRun();
            return;
        }

        const dp = this.engineConfig?.gpuQuadtree?.debugProfile;
        const profilingEnabled = dp?.enabled === true;
        this._profileFrame++;

        // ── Debug profile: FPS measurement ───────────────────────────
        if (profilingEnabled) {
            const now = performance.now();
            if (this._profileLastTime > 0) {
                const dt = now - this._profileLastTime;
                if (dt > 0) {
                    this._profileFpsAccum += 1000 / dt;
                    this._profileFpsSamples++;
                }
            }
            this._profileLastTime = now;
        }

        const warmup = profilingEnabled ? (dp.warmupFrames ?? 300) : Infinity;
        const frozen = profilingEnabled && this._profileFrame > warmup;

        // ── Freeze activation log (once) ─────────────────────────────
        if (frozen && !this._profileFrozen) {
            this._profileFrozen = true;
            const flags = [];
            if (dp.freezeGeneration) flags.push('generation');
            if (dp.freezeFeedback)   flags.push('feedback');
            if (dp.freezeTraversal)  flags.push('traversal');
            if (dp.freezeInstances)  flags.push('instances');
            if (dp.freezeUniforms)   flags.push('uniforms');
            const avgFps = this._profileFpsSamples > 0
                ? (this._profileFpsAccum / this._profileFpsSamples).toFixed(1)
                : '?';
            Logger.warn(
                `[QT-Profile] FREEZE activated at frame ${this._profileFrame} | ` +
                `warmup avg FPS: ${avgFps} | frozen: [${flags.join(', ')}]`
            );
            // Reset FPS counters to measure post-freeze
            this._profileFpsAccum = 0;
            this._profileFpsSamples = 0;
        }

        // ── Periodic FPS log while profiling ─────────────────────────
        if (profilingEnabled && this._profileFpsSamples > 0 &&
            this._profileFrame % this._profileLogInterval === 0) {
            const avgFps = (this._profileFpsAccum / this._profileFpsSamples).toFixed(1);
            const phase = frozen ? 'FROZEN' : 'WARMUP';
            Logger.info(`[QT-Profile] ${phase} frame=${this._profileFrame} avgFPS=${avgFps}`);
            this._profileFpsAccum = 0;
            this._profileFpsSamples = 0;
        }

        // ── (A) Tile streamer flush + generation ─────────────────────
        // Always flush pending copies/hash uploads so in-flight tasks
        // that completed can become GPU-visible.
        this.tileStreamer.tickFlush();
        if (!frozen || !dp.freezeGeneration) {
            this.tileStreamer.tickGeneration();
        }

        this._updateAdaptiveLodScale(camera);
        this._updatePredictiveStreaming(camera);

        // ── (B) Uniform update ───────────────────────────────────────
        if (!frozen || !dp.freezeUniforms) {
            const baseThreshold = this.engineConfig.gpuQuadtree.lodErrorThreshold;
            this.quadtreeGPU.updateUniforms(camera, {
                screenHeight: this.backend.canvas?.height || 1080,
                lodErrorThreshold: baseThreshold * this._lodSpeedScale
            });
        }

        // ── (C) GPU traversal ────────────────────────────────────────
        if (!frozen || !dp.freezeTraversal) {
            this.quadtreeGPU.traverse(commandEncoder);
        }

        // ── (D) GPU instance building ────────────────────────────────
        if (!frozen || !dp.freezeInstances) {
            this.quadtreeGPU.buildInstances(commandEncoder);
        }

        // ── (E) Feedback readback initiation ─────────────────────────
        if (!frozen || !dp.freezeFeedback) {
            this.tileStreamer.beginFeedbackReadback(commandEncoder);
        }

        this.quadtreeGPU.tick();
        this._maybeReadbackVisibleTiles();
        this._maybeLogLightweightDiagnostics();
    }

    resolveFeedbackReadback() {
        if (!this.isReady()) return;
        if (this._manualDiagState?.frozen) return;
        const dp = this.engineConfig?.gpuQuadtree?.debugProfile;
        const frozen = dp?.enabled === true && this._profileFrame > (dp.warmupFrames ?? 300);
        if (frozen && dp.freezeFeedback) return;
        this.tileStreamer?.resolveFeedbackReadback?.();
    }

    refreshTiles() {
        if (!this.isReady()) return;
        this.tileStreamer?.resetTiles?.({ reseedRootTiles: true });
    }

    // ── Buffer / texture accessors for the renderer ──────────────────────

    getInstanceBuffer() {
        return this.quadtreeGPU.getInstanceBuffer();
    }

    getIndirectArgsBuffer() {
        return this.quadtreeGPU.getIndirectArgsBuffer();
    }

    getIndirectArgsOffsetBytes(lod) {
        return this.quadtreeGPU.getIndirectArgsOffsetBytes(lod);
    }

    getArrayTextures() {
        return this.tileStreamer.getArrayTextures();
    }

    // ── Readback / diagnostics ───────────────────────────────────────────
  
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
      }

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
    }

    _shouldLogDiag() {
      return false;
        const interval = this._diagInterval ?? 0;
        if (!Number.isFinite(interval) || interval <= 0) return false;
        this._diagFrame = (this._diagFrame + 1) % interval;
        return this._diagFrame === 0;
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
        const prevPending = this._lastLightDiagPendingGen;
        const pendingDelta = Number.isFinite(prevPending) ? (queuePending - prevPending) : 0;
        this._lastLightDiagPendingGen = queuePending;
        const pendingDeltaStr = pendingDelta > 0 ? `+${pendingDelta}` : `${pendingDelta}`;

        Logger.info(
            `${TERRAIN_STEP_LOG_TAG} [QTLight] pool=${poolUsed}/${poolTotal} ` +
            `pendingGen=${queuePending}(${pendingDeltaStr}) activeGen=${queueActive} ` +
            `pendingCopies=${pendingCopies} dirtySlots=${dirtySlots} ` +
            `gpuInFlight=${gpuInFlight} lodScale=${lodScale.toFixed(2)}` +
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
    }
  
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
  }
  
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
    }

    _shouldRunStitchDiag() {
        return false;
        const cfg = this.engineConfig?.gpuQuadtree;
        if (!cfg?.diagnosticsEnabled) return false;
        const interval = cfg.diagnosticsIntervalFrames ?? 0;
        if (!Number.isFinite(interval) || interval <= 0) return false;
        this._stitchDiagFrame = (this._stitchDiagFrame + 1) % interval;
        return this._stitchDiagFrame === 0;
    }

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
    }

    _maybeLogStitchingDiagnostics() {
        if (!this._shouldRunStitchDiag()) return;
        if (this._stitchDiagPending) return;
        this._stitchDiagPending = true;
        this._runStitchingDiagnostics().finally(() => {
            this._stitchDiagPending = false;
        });
    }

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
  }

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
    }

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
    }

    async _measureSeamPair(pair, readCache = null) {
        return this._sampleSeamPairMetrics(pair, [0.25, 0.5, 0.75], readCache);
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
}

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

function normalizeTileAddressLike(tile) {
    if (!tile) return null;
    if (tile instanceof TileAddress) {
        return tile;
    }
    const face = tile?.face;
    const depth = tile?.depth;
    const x = tile?.x;
    const y = tile?.y;
    if (![face, depth, x, y].every(Number.isInteger)) {
        return null;
    }
    try {
        return new TileAddress(face, depth, x, y);
    } catch {
        return null;
    }
}

function tileAddrKeyJS(tile) {
    return `${tile.face}:${tile.depth}:${tile.x}:${tile.y}`;
}

function getInstanceGridAddress(inst) {
    const size = inst?.chunkSizeUV ?? 0;
    if (!(size > 0)) return null;
    const depth = Math.max(0, Math.round(Math.log2(1 / size)));
    const x = Math.max(0, Math.floor((inst.chunkLocation?.x ?? 0) / size + 1e-6));
    const y = Math.max(0, Math.floor((inst.chunkLocation?.y ?? 0) / size + 1e-6));
    return {
        face: inst?.face ?? 0,
        depth,
        x,
        y,
        size
    };
}

function instanceSampleGridKey(inst) {
    const addr = getInstanceGridAddress(inst);
    if (!addr) return '';
    return `${addr.face}:${addr.depth}:${addr.x}:${addr.y}`;
}

function makeOrderedPairKey(a, b) {
    if (!a || !b) return '';
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildChunkTexelRect(inst, texSize) {
    if (!(texSize > 0)) return null;
    const offsetX = inst?.uvOffset?.x ?? 0;
    const offsetY = inst?.uvOffset?.y ?? 0;
    const scale = inst?.uvScale ?? 1;
    const width = Math.max(1, Math.floor(texSize * scale + 0.5));
    const height = Math.max(1, Math.floor(texSize * scale + 0.5));
    const minX = clampInt(Math.floor(offsetX * texSize + 0.5), 0, texSize - 1);
    const minY = clampInt(Math.floor(offsetY * texSize + 0.5), 0, texSize - 1);
    const maxX = clampInt(minX + width - 1, minX, texSize - 1);
    const maxY = clampInt(minY + height - 1, minY, texSize - 1);
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(1, maxX - minX + 1),
        height: Math.max(1, maxY - minY + 1)
    };
}

function computeFragmentAtlasBilinearFootprint(localUV, inst, texSize) {
    const rect = buildChunkTexelRect(inst, texSize);
    if (!rect) return null;
    const uv = {
        x: clamp01(localUV?.x ?? 0),
        y: clamp01(localUV?.y ?? 0)
    };
    const offsetX = inst?.uvOffset?.x ?? 0;
    const offsetY = inst?.uvOffset?.y ?? 0;
    const scale = inst?.uvScale ?? 1;
    const parentLocalX = offsetX + uv.x * scale;
    const parentLocalY = offsetY + uv.y * scale;
    const maxF = Math.max(texSize - 1, 1);
    const mappedX = (parentLocalX * maxF + 0.5) / texSize;
    const mappedY = (parentLocalY * maxF + 0.5) / texSize;
    const coordX = mappedX * texSize - 0.5;
    const coordY = mappedY * texSize - 0.5;
    const baseX = Math.floor(coordX);
    const baseY = Math.floor(coordY);
    return {
        rect,
        x0: clampInt(baseX, 0, texSize - 1),
        x1: clampInt(baseX + 1, 0, texSize - 1),
        y0: clampInt(baseY, 0, texSize - 1),
        y1: clampInt(baseY + 1, 0, texSize - 1),
        fx: coordX - baseX,
        fy: coordY - baseY,
        leakX: baseX < rect.minX || (baseX + 1) > rect.maxX,
        leakY: baseY < rect.minY || (baseY + 1) > rect.maxY,
    };
}

function computeVertexChunkHeightFootprint(localUV, inst, texSize) {
    const rect = buildChunkTexelRect(inst, texSize);
    if (!rect) return null;
    const uv = {
        x: clamp01(localUV?.x ?? 0),
        y: clamp01(localUV?.y ?? 0)
    };
    const maxLocalX = Math.max(rect.width - 1, 1);
    const maxLocalY = Math.max(rect.height - 1, 1);
    const coordX = rect.minX + uv.x * maxLocalX;
    const coordY = rect.minY + uv.y * maxLocalY;
    const baseX = Math.floor(coordX);
    const baseY = Math.floor(coordY);
    return {
        rect,
        x0: clampInt(baseX, rect.minX, rect.maxX),
        x1: clampInt(baseX + 1, rect.minX, rect.maxX),
        y0: clampInt(baseY, rect.minY, rect.maxY),
        y1: clampInt(baseY + 1, rect.minY, rect.maxY),
        fx: coordX - baseX,
        fy: coordY - baseY,
    };
}

function computeVertexIntendedHeightFootprint(localUV, inst, texSize, sampleLOD, lodSegments) {
    if (!(texSize > 0)) return null;
    const uv = {
        x: clamp01(localUV?.x ?? 0),
        y: clamp01(localUV?.y ?? 0)
    };
    const remapped = remapToTexelGridJS(uv, sampleLOD, lodSegments);
    const offsetX = inst?.uvOffset?.x ?? 0;
    const offsetY = inst?.uvOffset?.y ?? 0;
    const scale = inst?.uvScale ?? 1;
    const sampleUVx = clamp01(offsetX + remapped.x * scale);
    const sampleUVy = clamp01(offsetY + remapped.y * scale);
    const maxIdx = Math.max(texSize - 1, 1);
    const coordX = sampleUVx * maxIdx;
    const coordY = sampleUVy * maxIdx;
    const baseX = Math.floor(coordX);
    const baseY = Math.floor(coordY);
    return {
        x0: clampInt(baseX, 0, texSize - 1),
        x1: clampInt(baseX + 1, 0, texSize - 1),
        y0: clampInt(baseY, 0, texSize - 1),
        y1: clampInt(baseY + 1, 0, texSize - 1),
        fx: coordX - baseX,
        fy: coordY - baseY,
    };
}

function remapToTexelGridJS(localUV, lod, lodSegments) {
    const segments = getDiagSegmentsForLod(lod, lodSegments);
    const denom = Math.max(segments - 1.0, 1.0);
    const scale = segments / denom;
    return {
        x: clamp01((localUV?.x ?? 0) * scale),
        y: clamp01((localUV?.y ?? 0) * scale)
    };
}

function getDiagSegmentsForLod(lod, lodSegments) {
    const segments = Array.isArray(lodSegments) && lodSegments.length > 0
        ? lodSegments
        : [128, 64, 32, 16, 8, 4, 2];
    const idx = clampInt(Number.isFinite(lod) ? lod : 0, 0, Math.max(segments.length - 1, 0));
    return Math.max(2, Number(segments[idx]) || 2);
}

function edgeSideLocalUV(side, t) {
    const clampedT = clamp01(t);
    if (side === 'left') return { x: 0.0, y: clampedT };
    if (side === 'right') return { x: 1.0, y: clampedT };
    if (side === 'bottom') return { x: clampedT, y: 0.0 };
    return { x: clampedT, y: 1.0 };
}

function oppositeEdgeSide(side) {
    if (side === 'left') return 'right';
    if (side === 'right') return 'left';
    if (side === 'bottom') return 'top';
    return 'bottom';
}

function uniqueTexelCoords(coords) {
    const result = [];
    const seen = new Set();
    for (const coord of coords) {
        const x = Math.floor(coord?.x ?? 0);
        const y = Math.floor(coord?.y ?? 0);
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ x, y });
    }
    return result;
}

function clampInt(v, min, max) {
    return Math.max(min, Math.min(max, Math.floor(v)));
}

function distance3(a, b) {
    const ax = a?.x ?? 0;
    const ay = a?.y ?? 0;
    const az = a?.z ?? 0;
    const bx = b?.x ?? 0;
    const by = b?.y ?? 0;
    const bz = b?.z ?? 0;
    return Math.hypot(ax - bx, ay - by, az - bz);
}

function computeTileWorldCenter(tile, planetConfig, heightBias = 0) {
    if (!tile || !planetConfig) return null;
    const grid = 1 << Math.max(0, tile.depth ?? 0);
    const u = ((tile.x ?? 0) + 0.5) / Math.max(grid, 1);
    const v = ((tile.y ?? 0) + 0.5) / Math.max(grid, 1);
    const s = u * 2 - 1;
    const t = v * 2 - 1;
    let cx = 0, cy = 0, cz = 0;
    switch (tile.face) {
        case 0: cx = 1;   cy = t;  cz = -s; break;
        case 1: cx = -1;  cy = t;  cz =  s; break;
        case 2: cx = s;   cy = 1;  cz = -t; break;
        case 3: cx = s;   cy = -1; cz =  t; break;
        case 4: cx = s;   cy = t;  cz =  1; break;
        case 5: cx = -s;  cy = t;  cz = -1; break;
        default: cx = 0;  cy = 1;  cz =  0; break;
    }
    const len = Math.hypot(cx, cy, cz) || 1;
    const radius = (planetConfig?.radius ?? 0) + heightBias;
    const origin = planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
    return {
        x: origin.x + (cx / len) * radius,
        y: origin.y + (cy / len) * radius,
        z: origin.z + (cz / len) * radius
    };
}

function transformPoint4(elements, x, y, z, w = 1) {
    if (!Array.isArray(elements) && !(elements instanceof Float32Array)) {
        return null;
    }
    return {
        x: elements[0] * x + elements[4] * y + elements[8] * z + elements[12] * w,
        y: elements[1] * x + elements[5] * y + elements[9] * z + elements[13] * w,
        z: elements[2] * x + elements[6] * y + elements[10] * z + elements[14] * w,
        w: elements[3] * x + elements[7] * y + elements[11] * z + elements[15] * w
    };
}

function projectWorldToCameraNdc(world, camera) {
    const viewElements = camera?.matrixWorldInverse?.elements;
    const projElements = camera?.projectionMatrix?.elements;
    if (!viewElements || !projElements || !world) {
        return null;
    }
    const view = transformPoint4(viewElements, world.x, world.y, world.z, 1);
    if (!view) return null;
    const clip = transformPoint4(projElements, view.x, view.y, view.z, view.w);
    if (!clip || Math.abs(clip.w) < 1e-6) {
        return null;
    }
    return {
        inFront: view.z < 0,
        viewX: view.x,
        viewY: view.y,
        viewZ: view.z,
        ndcX: clip.x / clip.w,
        ndcY: clip.y / clip.w,
        ndcZ: clip.z / clip.w
    };
}

function buildTextureGridSampleCoords(texSize, samplesPerAxis = 5) {
    const size = Math.max(1, Math.floor(texSize || 1));
    const n = Math.max(2, Math.floor(samplesPerAxis || 2));
    const coords = [];
    const max = Math.max(size - 1, 0);
    for (let iy = 0; iy < n; iy++) {
        const fy = iy / Math.max(n - 1, 1);
        const y = clampInt(fy * max, 0, max);
        for (let ix = 0; ix < n; ix++) {
            const fx = ix / Math.max(n - 1, 1);
            const x = clampInt(fx * max, 0, max);
            coords.push({ x, y });
        }
    }
    return uniqueTexelCoords(coords);
}

function formatLayerStats(stats) {
    if (!stats) {
        return 'unavailable';
    }
    const min0 = Number.isFinite(stats.min?.[0]) ? stats.min[0].toFixed(5) : 'n/a';
    const max0 = Number.isFinite(stats.max?.[0]) ? stats.max[0].toFixed(5) : 'n/a';
    const mean0 = Number.isFinite(stats.mean?.[0]) ? stats.mean[0].toFixed(5) : 'n/a';
    return (
        `min=${min0} max=${max0} mean=${mean0} ` +
        `nan=${stats.nanCount ?? 0} zero=${stats.zeroCount ?? 0} ` +
        `below=${Number.isFinite(stats.belowRatio) ? (stats.belowRatio * 100).toFixed(1) : '0.0'}%`
    );
}

function summarizeRasterComparison(liveRaster, freshRaster, stride = 1) {
    if (!liveRaster?.buffer || !freshRaster?.buffer) {
        return 'unavailable';
    }
    const format = String(liveRaster.format || freshRaster.format || 'r32float');
    const width = Math.min(liveRaster.width ?? 0, freshRaster.width ?? 0);
    const height = Math.min(liveRaster.height ?? 0, freshRaster.height ?? 0);
    if (!(width > 0) || !(height > 0)) {
        return 'unavailable';
    }

    const step = Math.max(1, Math.floor(stride || 1));
    const liveDV = new DataView(liveRaster.buffer);
    const freshDV = new DataView(freshRaster.buffer);
    const tolerance = texelToleranceForFormat(format);
    const liveStats = createRasterStats();
    const freshStats = createRasterStats();
    let mismatchCount = 0;
    let sampleCount = 0;
    let maxAbs = 0;
    let firstMismatch = '';

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const liveOffset = y * liveRaster.bytesPerRow + x * liveRaster.texelBytes;
            const freshOffset = y * freshRaster.bytesPerRow + x * freshRaster.texelBytes;
            const liveValues = readDiagTexel(liveDV, liveOffset, format);
            const freshValues = readDiagTexel(freshDV, freshOffset, format);
            updateRasterStats(liveStats, liveValues?.[0]);
            updateRasterStats(freshStats, freshValues?.[0]);
            sampleCount++;

            let differs = false;
            let localMax = 0;
            const channelCount = Math.max(liveValues.length, freshValues.length);
            for (let c = 0; c < channelCount; c++) {
                const a = Number.isFinite(liveValues[c]) ? liveValues[c] : 0;
                const b = Number.isFinite(freshValues[c]) ? freshValues[c] : 0;
                const diff = Math.abs(a - b);
                localMax = Math.max(localMax, diff);
                if (diff > tolerance) {
                    differs = true;
                }
            }
            maxAbs = Math.max(maxAbs, localMax);
            if (differs) {
                mismatchCount++;
                if (!firstMismatch) {
                    firstMismatch = `${x},${y}:${formatTexelValues(liveValues)}!=${formatTexelValues(freshValues)}`;
                }
            }
        }
    }

    return (
        `samples=${sampleCount} mismatch(${mismatchCount}/${sampleCount}) maxAbs=${maxAbs.toFixed(5)} ` +
        `live{${formatRasterStats(liveStats)}} fresh{${formatRasterStats(freshStats)}}` +
        `${firstMismatch ? ` first=${firstMismatch}` : ''}`
    );
}

function createRasterStats() {
    return {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0,
        nan: 0
    };
}

function updateRasterStats(stats, value) {
    if (!stats) return;
    if (!Number.isFinite(value)) {
        stats.nan++;
        return;
    }
    stats.min = Math.min(stats.min, value);
    stats.max = Math.max(stats.max, value);
    stats.sum += value;
    stats.count++;
}

function formatRasterStats(stats) {
    if (!stats) {
        return 'unavailable';
    }
    const min = Number.isFinite(stats.min) ? stats.min.toFixed(5) : 'n/a';
    const max = Number.isFinite(stats.max) ? stats.max.toFixed(5) : 'n/a';
    const mean = stats.count > 0 ? (stats.sum / stats.count).toFixed(5) : 'n/a';
    return `min=${min} max=${max} mean=${mean} nan=${stats.nan}`;
}

function halfToFloatDiag(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x03ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readDiagTexel(dv, offset, format) {
    switch (format) {
        case 'r32float':
            return [dv.getFloat32(offset, true)];
        case 'rgba32float':
            return [
                dv.getFloat32(offset, true),
                dv.getFloat32(offset + 4, true),
                dv.getFloat32(offset + 8, true),
                dv.getFloat32(offset + 12, true)
            ];
        case 'r16float':
            return [halfToFloatDiag(dv.getUint16(offset, true))];
        case 'rgba16float':
            return [
                halfToFloatDiag(dv.getUint16(offset, true)),
                halfToFloatDiag(dv.getUint16(offset + 2, true)),
                halfToFloatDiag(dv.getUint16(offset + 4, true)),
                halfToFloatDiag(dv.getUint16(offset + 6, true))
            ];
        case 'r8unorm':
            return [dv.getUint8(offset) / 255];
        case 'rgba8unorm':
            return [
                dv.getUint8(offset) / 255,
                dv.getUint8(offset + 1) / 255,
                dv.getUint8(offset + 2) / 255,
                dv.getUint8(offset + 3) / 255
            ];
        default:
            return [dv.getFloat32(offset, true)];
    }
}

function seamEdgeBit(side) {
    if (side === 'left') return 8;
    if (side === 'right') return 2;
    if (side === 'bottom') return 4;
    return 1;
}

function isFallbackInstance(inst) {
    return Math.abs((inst?.uvScale ?? 1.0) - 1.0) >= 0.001;
}

function seamHasEdgeMask(inst, side) {
    return (((inst?.edgeMask ?? 0) & seamEdgeBit(side)) !== 0);
}

function seamSampleLOD(inst, side, neighborLOD) {
    const selfLOD = inst?.lod ?? 0;
    if (seamHasEdgeMask(inst, side) && Number.isFinite(neighborLOD) && neighborLOD > selfLOD) {
        return neighborLOD;
    }
    return selfLOD;
}

function getWrappedCrossFaceNeighbor(addr, side) {
    if (!addr) return null;
    const dx = side === 'left' ? -1 : (side === 'right' ? 1 : 0);
    const dy = side === 'bottom' ? -1 : (side === 'top' ? 1 : 0);
    const wrapped = wrapNeighborGridJS(addr.face, addr.depth, addr.x + dx, addr.y + dy);
    if (!wrapped || wrapped.face === addr.face) {
        return null;
    }
    return wrapped;
}

function findVisibleAncestorTile(tile, visibleExact) {
    let cursor = normalizeTileAddressLike(tile);
    while (cursor) {
        if (visibleExact.has(tileAddrKeyJS(cursor))) {
            return cursor;
        }
        cursor = cursor.parent;
    }
    return null;
}

function isDescendantTile(descendant, ancestor) {
    if (!descendant || !ancestor) return false;
    if (descendant.face !== ancestor.face) return false;
    if (descendant.depth <= ancestor.depth) return false;
    const shift = descendant.depth - ancestor.depth;
    return (descendant.x >> shift) === ancestor.x && (descendant.y >> shift) === ancestor.y;
}

function findVisibleDescendantTiles(tile, candidates) {
    const ancestor = normalizeTileAddressLike(tile);
    if (!ancestor) return [];
    return (Array.isArray(candidates) ? candidates : [])
        .filter((candidate) => isDescendantTile(candidate, ancestor))
        .sort((a, b) => a.depth - b.depth || a.y - b.y || a.x - b.x);
}

function collectSeamPairs(sampledInstances) {
    const instances = Array.isArray(sampledInstances) ? sampledInstances : [];
    const keyToInst = new Map();
    for (const inst of instances) {
        const key = instanceSampleGridKey(inst);
        if (key) {
            keyToInst.set(key, inst);
        }
    }

    const pairs = [];
    const seen = new Set();
    const sameDepthPairs = buildSameDepthSeamPairs(instances, keyToInst);
    for (const pair of sameDepthPairs) {
        if (seen.has(pair.key)) continue;
        seen.add(pair.key);
        pairs.push(pair);
    }

    const stitchedPairs = buildCoarseFineSeamPairs(instances, seen);
    for (const pair of stitchedPairs) {
        if (seen.has(pair.key)) continue;
        seen.add(pair.key);
        pairs.push(pair);
    }
    return pairs;
}

function buildSameDepthSeamPairs(instances, keyToInst) {
    const pairs = [];
    for (const inst of instances) {
        const addr = getInstanceGridAddress(inst);
        if (!addr) continue;
        const neighbors = [
            { sideA: 'right', sideB: 'left', coord: wrapNeighborGridJS(addr.face, addr.depth, addr.x + 1, addr.y) },
            { sideA: 'top', sideB: 'bottom', coord: wrapNeighborGridJS(addr.face, addr.depth, addr.x, addr.y + 1) }
        ];
        for (const n of neighbors) {
            const otherKey = n?.coord
                ? `${n.coord.face}:${n.coord.depth}:${n.coord.x}:${n.coord.y}`
                : '';
            const other = keyToInst.get(otherKey);
            if (!other) continue;
            const className = classifySameDepthSeam(inst, other, n.sideA, n.sideB);
            pairs.push({
                key: makeOrderedPairKey(instanceSampleGridKey(inst), instanceSampleGridKey(other)),
                className,
                a: inst,
                b: other,
                sideA: n.sideA,
                sideB: n.sideB,
                sampleLODA: seamSampleLOD(inst, n.sideA, other.lod),
                sampleLODB: seamSampleLOD(other, n.sideB, inst.lod)
            });
        }
    }
    return pairs;
}

function classifySameDepthSeam(a, b, sideA, sideB) {
    const crossFace = (a?.face ?? -1) !== (b?.face ?? -1);
    const aFallback = isFallbackInstance(a);
    const bFallback = isFallbackInstance(b);
    if (!aFallback && !bFallback) {
        return crossFace ? 'own-own:same-depth:cross-face' : 'own-own:same-depth';
    }
    if (aFallback && bFallback) {
        return crossFace ? 'fallback-fallback:same-depth:cross-face' : 'fallback-fallback:same-depth';
    }
    const hasMask = seamHasEdgeMask(a, sideA) || seamHasEdgeMask(b, sideB);
    if (hasMask) {
        return crossFace ? 'own-fallback:same-depth:mask:cross-face' : 'own-fallback:same-depth:mask';
    }
    return crossFace ? 'own-fallback:same-depth:no-mask:cross-face' : 'own-fallback:same-depth:no-mask';
}

function buildCoarseFineSeamPairs(instances, seen) {
    const pairs = [];
    for (const inst of instances) {
        for (const side of ['left', 'right', 'bottom', 'top']) {
            if (!seamHasEdgeMask(inst, side)) continue;
            const other = findCoveringNeighborForSeam(inst, side, instances);
            if (!other) continue;
            const keyA = instanceSampleGridKey(inst);
            const keyB = instanceSampleGridKey(other);
            const orderedKey = makeOrderedPairKey(keyA, keyB);
            if (!orderedKey || seen.has(orderedKey)) continue;
            const sideB = inferOppositeTouchingSide(inst, other, side);
            if (!sideB) continue;
            pairs.push({
                key: orderedKey,
                className: 'coarse-fine:stitched',
                a: inst,
                b: other,
                sideA: side,
                sideB,
                sampleLODA: seamSampleLOD(inst, side, other.lod),
                sampleLODB: seamSampleLOD(other, sideB, inst.lod)
            });
        }
    }
    return pairs;
}

function wrapNeighborGridJS(face, depth, x, y) {
    const gs = 1 << Math.max(0, depth);
    const maxv = gs - 1;
    if (x >= 0 && x < gs && y >= 0 && y < gs) {
        return { face, depth, x, y };
    }

    let dir = -1;
    if (x < 0) dir = 0;
    else if (x >= gs) dir = 1;
    else if (y < 0) dir = 2;
    else if (y >= gs) dir = 3;

    const cx = Math.max(0, Math.min(maxv, x));
    const cy = Math.max(0, Math.min(maxv, y));

    if (face === 0) {
        if (dir === 0) return { face: 4, depth, x: maxv, y: cy };
        if (dir === 1) return { face: 5, depth, x: 0, y: cy };
        if (dir === 2) return { face: 3, depth, x: maxv, y: cx };
        if (dir === 3) return { face: 2, depth, x: maxv, y: maxv - cx };
    }
    if (face === 1) {
        if (dir === 0) return { face: 5, depth, x: maxv, y: cy };
        if (dir === 1) return { face: 4, depth, x: 0, y: cy };
        if (dir === 2) return { face: 3, depth, x: 0, y: maxv - cx };
        if (dir === 3) return { face: 2, depth, x: 0, y: cx };
    }
    if (face === 2) {
        if (dir === 0) return { face: 1, depth, x: cy, y: 0 };
        if (dir === 1) return { face: 0, depth, x: maxv - cy, y: maxv };
        if (dir === 2) return { face: 4, depth, x: cx, y: maxv };
        if (dir === 3) return { face: 5, depth, x: maxv - cx, y: 0 };
    }
    if (face === 3) {
        if (dir === 0) return { face: 1, depth, x: maxv - cy, y: maxv };
        if (dir === 1) return { face: 0, depth, x: cy, y: 0 };
        if (dir === 2) return { face: 5, depth, x: maxv - cx, y: maxv };
        if (dir === 3) return { face: 4, depth, x: cx, y: 0 };
    }
    if (face === 4) {
        if (dir === 0) return { face: 1, depth, x: maxv, y: cy };
        if (dir === 1) return { face: 0, depth, x: 0, y: cy };
        if (dir === 2) return { face: 3, depth, x: cx, y: maxv };
        if (dir === 3) return { face: 2, depth, x: cx, y: 0 };
    }
    if (face === 5) {
        if (dir === 0) return { face: 0, depth, x: maxv, y: cy };
        if (dir === 1) return { face: 1, depth, x: 0, y: cy };
        if (dir === 2) return { face: 3, depth, x: maxv - cx, y: maxv };
        if (dir === 3) return { face: 2, depth, x: maxv - cx, y: 0 };
    }
    return {
        face,
        depth,
        x: Math.max(0, Math.min(maxv, x)),
        y: Math.max(0, Math.min(maxv, y))
    };
}

function findCoveringNeighborForSeam(inst, side, instances) {
    const a = getInstanceBounds(inst);
    if (!a) return null;
    let best = null;
    let bestArea = Infinity;
    for (const other of instances) {
        if (other === inst) continue;
        if ((other?.face ?? -1) !== a.face) continue;
        const b = getInstanceBounds(other);
        if (!b || !(b.size > a.size + 1e-6)) continue;
        if (!boundsTouchOnSide(a, b, side)) continue;
        const area = b.size;
        if (area < bestArea) {
            bestArea = area;
            best = other;
        }
    }
    return best;
}

function getInstanceBounds(inst) {
    const addr = getInstanceGridAddress(inst);
    if (!addr) return null;
    const minX = inst?.chunkLocation?.x ?? 0;
    const minY = inst?.chunkLocation?.y ?? 0;
    const size = inst?.chunkSizeUV ?? addr.size;
    return {
        face: inst?.face ?? 0,
        minX,
        minY,
        maxX: minX + size,
        maxY: minY + size,
        size
    };
}

function boundsTouchOnSide(a, b, side) {
    const eps = 1e-6;
    if (side === 'left') {
        return Math.abs(a.minX - b.maxX) < eps && rangesOverlap(a.minY, a.maxY, b.minY, b.maxY);
    }
    if (side === 'right') {
        return Math.abs(a.maxX - b.minX) < eps && rangesOverlap(a.minY, a.maxY, b.minY, b.maxY);
    }
    if (side === 'bottom') {
        return Math.abs(a.minY - b.maxY) < eps && rangesOverlap(a.minX, a.maxX, b.minX, b.maxX);
    }
    return Math.abs(a.maxY - b.minY) < eps && rangesOverlap(a.minX, a.maxX, b.minX, b.maxX);
}

function rangesOverlap(a0, a1, b0, b1) {
    return Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
}

function inferOppositeTouchingSide(aInst, bInst, sideA) {
    const a = getInstanceBounds(aInst);
    const b = getInstanceBounds(bInst);
    if (!a || !b) return '';
    const eps = 1e-6;
    if (sideA === 'left' && Math.abs(a.minX - b.maxX) < eps) return 'right';
    if (sideA === 'right' && Math.abs(a.maxX - b.minX) < eps) return 'left';
    if (sideA === 'bottom' && Math.abs(a.minY - b.maxY) < eps) return 'top';
    if (sideA === 'top' && Math.abs(a.maxY - b.minY) < eps) return 'bottom';
    return '';
}

function computeSharedEdgeSampleUVs(aInst, bInst, sideA, t) {
    const a = getInstanceBounds(aInst);
    const b = getInstanceBounds(bInst);
    if (!a || !b) return null;
    const clampedT = clamp01(t);
    const eps = 1e-6;
    if (sideA === 'left' || sideA === 'right') {
        const worldX = sideA === 'left' ? a.minX : a.maxX;
        const worldY = a.minY + clampedT * a.size;
        let uvBX = 0;
        if (Math.abs(worldX - b.minX) < eps) uvBX = 0;
        else if (Math.abs(worldX - b.maxX) < eps) uvBX = 1;
        else return null;
        const uvBY = clamp01((worldY - b.minY) / Math.max(b.size, 1e-6));
        return {
            uvA: sideA === 'left' ? { x: 0.0, y: clampedT } : { x: 1.0, y: clampedT },
            uvB: { x: uvBX, y: uvBY }
        };
    }
    const worldY = sideA === 'bottom' ? a.minY : a.maxY;
    const worldX = a.minX + clampedT * a.size;
    let uvBY = 0;
    if (Math.abs(worldY - b.minY) < eps) uvBY = 0;
    else if (Math.abs(worldY - b.maxY) < eps) uvBY = 1;
    else return null;
    const uvBX = clamp01((worldX - b.minX) / Math.max(b.size, 1e-6));
    return {
        uvA: sideA === 'bottom' ? { x: clampedT, y: 0.0 } : { x: clampedT, y: 1.0 },
        uvB: { x: uvBX, y: uvBY }
    };
}

function buildUniformEdgeSamples(count = 17) {
    const n = Math.max(2, Math.floor(count));
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(i / Math.max(n - 1, 1));
    }
    return out;
}

function collectInstDiagnosticCoords(inst, side, tValues, texSize) {
    const coords = [];
    const addFootprint = (uv) => {
        const footprint = computeVertexChunkHeightFootprint(uv, inst, texSize);
        if (!footprint) return;
        coords.push(
            { x: footprint.x0, y: footprint.y0 },
            { x: footprint.x1, y: footprint.y0 },
            { x: footprint.x0, y: footprint.y1 },
            { x: footprint.x1, y: footprint.y1 }
        );
    };

    addFootprint({ x: 0.5, y: 0.5 });
    for (const t of Array.isArray(tValues) ? tValues : []) {
        addFootprint(edgeSideLocalUV(side, t));
    }
    return uniqueTexelCoords(coords);
}

function buildSharedVertexSamples(pair, className, lodSegments) {
    if (!pair?.a || !pair?.b) {
        return [];
    }
    let lod = Math.max(pair.a?.lod ?? 0, pair.b?.lod ?? 0);
    if (className !== 'coarse-fine:stitched') {
        lod = pair.a?.lod ?? pair.b?.lod ?? lod;
    }
    const segments = Math.max(1, Math.floor(getDiagSegmentsForLod(lod, lodSegments)));
    const samples = [];
    for (let i = 0; i <= segments; i++) {
        samples.push(i / segments);
    }
    return samples;
}

function classifySharedVertexMismatchCause(currentMaxMeters, baseMaxMeters, finalMaxMeters) {
    const significantMeters = 0.5;
    if (baseMaxMeters >= significantMeters) {
        return 'shared-base-mismatch';
    }
    if (finalMaxMeters >= significantMeters) {
        return 'shared-final-mismatch';
    }
    if (currentMaxMeters >= significantMeters) {
        return 'shared-runtime-mismatch';
    }
    return 'no-large-shared-vertex-mismatch';
}

function summarizeTexelComparison(liveTexels, freshTexels, format) {
    const live = Array.isArray(liveTexels) ? liveTexels : [];
    const fresh = Array.isArray(freshTexels) ? freshTexels : [];
    const total = Math.min(live.length, fresh.length);
    if (total <= 0) {
        return 'no-samples';
    }

    const tolerance = texelToleranceForFormat(format);
    let mismatchCount = 0;
    let maxAbs = 0;
    let firstMismatch = '';

    for (let i = 0; i < total; i++) {
        const a = Array.isArray(live[i]?.values) ? live[i].values : [];
        const b = Array.isArray(fresh[i]?.values) ? fresh[i].values : [];
        const channelCount = Math.max(a.length, b.length);
        let localMax = 0;
        let differs = false;
        for (let c = 0; c < channelCount; c++) {
            const av = Number.isFinite(a[c]) ? a[c] : 0;
            const bv = Number.isFinite(b[c]) ? b[c] : 0;
            const diff = Math.abs(av - bv);
            localMax = Math.max(localMax, diff);
            if (diff > tolerance) {
                differs = true;
            }
        }
        maxAbs = Math.max(maxAbs, localMax);
        if (differs) {
            mismatchCount++;
            if (!firstMismatch) {
                firstMismatch = `${live[i]?.x ?? 0},${live[i]?.y ?? 0}:${formatTexelValues(a)}!=${formatTexelValues(b)}`;
            }
        }
    }

    return mismatchCount > 0
        ? `mismatch(${mismatchCount}/${total}) maxAbs=${maxAbs.toFixed(5)} first=${firstMismatch}`
        : `match(${total}) maxAbs=${maxAbs.toFixed(5)}`;
}

function texelToleranceForFormat(format) {
    const fmt = String(format || '').toLowerCase();
    if (fmt.includes('8')) return (0.5 / 255.0) + 1e-6;
    if (fmt.includes('16float')) return 5e-4;
    return 1e-5;
}

function formatTexelValues(values) {
    return (Array.isArray(values) ? values : [])
        .map((v) => Number.isFinite(v) ? Number(v).toFixed(5) : 'NaN')
        .join('/');
}

function destroyWrappedTextures(textures) {
    if (!textures || typeof textures !== 'object') return;
    for (const tex of Object.values(textures)) {
        if (!tex) continue;
        try { tex._gpuTexture?.texture?.destroy?.(); } catch {}
        try { tex.dispose?.(); } catch {}
    }
}
