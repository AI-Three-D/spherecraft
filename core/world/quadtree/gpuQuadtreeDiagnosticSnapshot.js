import { Logger } from '../../../shared/Logger.js';

export class QuadtreeDiagSnapshot {
    constructor(logger = Logger) {
      this.log = logger;
    }
  
    logVisibleSummary(tiles) {
      return;
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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

      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
      if (!counters) return;
      this.log.info(
        `[QT-Diag] Counters: queueA=${counters.queueA} queueB=${counters.queueB} ` +
        `visible=${counters.visible} maxQueue=${counters.reserved}`
      );
    }

    logVisibleParentChildOverlaps(tiles, maxSamples = 8) {
      return;
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
      if (!instances || instances.length === 0) return;

      const getDepth = (tex) => {
        if (!tex) return null;
        if (Number.isFinite(tex.depth)) return tex.depth;
        const gpuDepth = tex._gpuTexture?.texture?.depthOrArrayLayers;
        if (Number.isFinite(gpuDepth)) return gpuDepth;
        return null;
      };

      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
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
      // eslint-disable-next-line no-unreachable
      const parts = meta.lodArgs.map(a =>
        `L${a.lod}: vis=${a.lodCountVisible} inst=${a.instanceCount} firstInst=${a.firstInstance} off=${a.lodOffset}`
      );
      this.log.info(`[QT-Diag] Indirect/Meta: ${parts.join(' | ')}`);
      this.log.info(`[QT-Diag] feedbackCount=${meta.feedbackCount} parentFallbackHits=${meta.parentFallbackHits}`);
    }
  
    async logPerLodInstanceSamples(quadtreeGPU, meta, maxLODLevels, samplesPerLod = 3) {
      return;
      // eslint-disable-next-line no-unreachable
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
