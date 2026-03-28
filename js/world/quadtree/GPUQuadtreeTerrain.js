// js/world/quadtree/GPUQuadtreeTerrain.js
//
// Manages GPU-driven quadtree traversal + tile streaming.
// Pure data/selection concern: decides which tiles are visible and
// streams their data into GPU tile pools.
//
// Rendering is handled by renderer/terrain/QuadtreeTerrainRenderer.

import { QuadtreeGPU } from './QuadtreeGPU.js';
import { TileStreamer } from './tileStreamer.js';
import { TerrainGeometryBuilder } from '../../mesh/terrain/terrainGeometryBuilder.js';
import { Logger } from '../../config/Logger.js';

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';


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

        // ── Debug profiling state ────────────────────────────────────
        this._profileFrame = 0;
        this._profileFrozen = false;
        this._profileFpsAccum = 0;
        this._profileFpsSamples = 0;
        this._profileLastTime = 0;
        this._profileLogInterval = 60; // log FPS every 60 frames
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
            horizonBlendScale: qt.horizonCulling?.blendScale
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
              // ── NEW: ring-buffered feedback readback ──
              feedbackReadbackInterval: qt.feedbackReadbackInterval,
              feedbackReadbackRingSize: qt.feedbackReadbackRingSize
          }
      );
        await this.tileStreamer.initialize();

        this._initialized = true;
        Logger.info('[QuadtreeTileManager] Initialized');
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

        // ── (B) Uniform update ───────────────────────────────────────
        if (!frozen || !dp.freezeUniforms) {
            this.quadtreeGPU.updateUniforms(camera, {
                screenHeight: this.backend.canvas?.height || 1080,
                lodErrorThreshold: this.engineConfig.gpuQuadtree.lodErrorThreshold
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
        this._maybeLogStitchingDiagnostics();
    }

    resolveFeedbackReadback() {
        if (!this.isReady()) return;
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
    }

    async _debugSampleHeightAtChunkUV(inst, localUV, readCache = null) {
        const tileStreamer = this.tileStreamer;
        const texSize = tileStreamer?.tileTextureSize ?? 0;
        if (!(texSize > 0) || !tileStreamer?.debugReadArrayLayerTexels) {
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
