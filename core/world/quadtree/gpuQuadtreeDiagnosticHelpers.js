import { TileAddress } from './tileAddress.js';
import { clamp01, clampInt } from '../../../shared/math/index.js';

export function normalizeTileAddressLike(tile) {
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

export function tileAddrKeyJS(tile) {
    return `${tile.face}:${tile.depth}:${tile.x}:${tile.y}`;
}

export function getInstanceGridAddress(inst) {
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

export function instanceSampleGridKey(inst) {
    const addr = getInstanceGridAddress(inst);
    if (!addr) return '';
    return `${addr.face}:${addr.depth}:${addr.x}:${addr.y}`;
}

export function makeOrderedPairKey(a, b) {
    if (!a || !b) return '';
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildChunkTexelRect(inst, texSize) {
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

export function computeFragmentAtlasBilinearFootprint(localUV, inst, texSize) {
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

export function computeVertexChunkHeightFootprint(localUV, inst, texSize) {
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

export function computeVertexIntendedHeightFootprint(localUV, inst, texSize, sampleLOD, lodSegments) {
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

export function remapToTexelGridJS(localUV, lod, lodSegments) {
    const segments = getDiagSegmentsForLod(lod, lodSegments);
    const denom = Math.max(segments - 1.0, 1.0);
    const scale = segments / denom;
    return {
        x: clamp01((localUV?.x ?? 0) * scale),
        y: clamp01((localUV?.y ?? 0) * scale)
    };
}

export function getDiagSegmentsForLod(lod, lodSegments) {
    const segments = Array.isArray(lodSegments) && lodSegments.length > 0
        ? lodSegments
        : [128, 64, 32, 16, 8, 4, 2];
    const idx = clampInt(Number.isFinite(lod) ? lod : 0, 0, Math.max(segments.length - 1, 0));
    return Math.max(2, Number(segments[idx]) || 2);
}

export function edgeSideLocalUV(side, t) {
    const clampedT = clamp01(t);
    if (side === 'left') return { x: 0.0, y: clampedT };
    if (side === 'right') return { x: 1.0, y: clampedT };
    if (side === 'bottom') return { x: clampedT, y: 0.0 };
    return { x: clampedT, y: 1.0 };
}

export function oppositeEdgeSide(side) {
    if (side === 'left') return 'right';
    if (side === 'right') return 'left';
    if (side === 'bottom') return 'top';
    return 'bottom';
}

export function uniqueTexelCoords(coords) {
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

export function distance3(a, b) {
    const ax = a?.x ?? 0;
    const ay = a?.y ?? 0;
    const az = a?.z ?? 0;
    const bx = b?.x ?? 0;
    const by = b?.y ?? 0;
    const bz = b?.z ?? 0;
    return Math.hypot(ax - bx, ay - by, az - bz);
}

export function computeTileWorldCenter(tile, planetConfig, heightBias = 0) {
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

export function transformPoint4(elements, x, y, z, w = 1) {
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

export function projectWorldToCameraNdc(world, camera) {
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

export function buildTextureGridSampleCoords(texSize, samplesPerAxis = 5) {
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

export function formatLayerStats(stats) {
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

export function summarizeRasterComparison(liveRaster, freshRaster, stride = 1) {
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

export function createRasterStats() {
    return {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0,
        nan: 0
    };
}

export function updateRasterStats(stats, value) {
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

export function formatRasterStats(stats) {
    if (!stats) {
        return 'unavailable';
    }
    const min = Number.isFinite(stats.min) ? stats.min.toFixed(5) : 'n/a';
    const max = Number.isFinite(stats.max) ? stats.max.toFixed(5) : 'n/a';
    const mean = stats.count > 0 ? (stats.sum / stats.count).toFixed(5) : 'n/a';
    return `min=${min} max=${max} mean=${mean} nan=${stats.nan}`;
}

export function halfToFloatDiag(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x03ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function readDiagTexel(dv, offset, format) {
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

export function seamEdgeBit(side) {
    if (side === 'left') return 8;
    if (side === 'right') return 2;
    if (side === 'bottom') return 4;
    return 1;
}

export function isFallbackInstance(inst) {
    return Math.abs((inst?.uvScale ?? 1.0) - 1.0) >= 0.001;
}

export function seamHasEdgeMask(inst, side) {
    return (((inst?.edgeMask ?? 0) & seamEdgeBit(side)) !== 0);
}

export function seamSampleLOD(inst, side, neighborLOD) {
    const selfLOD = inst?.lod ?? 0;
    if (seamHasEdgeMask(inst, side) && Number.isFinite(neighborLOD) && neighborLOD > selfLOD) {
        return neighborLOD;
    }
    return selfLOD;
}

export function getWrappedCrossFaceNeighbor(addr, side) {
    if (!addr) return null;
    const dx = side === 'left' ? -1 : (side === 'right' ? 1 : 0);
    const dy = side === 'bottom' ? -1 : (side === 'top' ? 1 : 0);
    const wrapped = wrapNeighborGridJS(addr.face, addr.depth, addr.x + dx, addr.y + dy);
    if (!wrapped || wrapped.face === addr.face) {
        return null;
    }
    return wrapped;
}

export function findVisibleAncestorTile(tile, visibleExact) {
    let cursor = normalizeTileAddressLike(tile);
    while (cursor) {
        if (visibleExact.has(tileAddrKeyJS(cursor))) {
            return cursor;
        }
        cursor = cursor.parent;
    }
    return null;
}

export function isDescendantTile(descendant, ancestor) {
    if (!descendant || !ancestor) return false;
    if (descendant.face !== ancestor.face) return false;
    if (descendant.depth <= ancestor.depth) return false;
    const shift = descendant.depth - ancestor.depth;
    return (descendant.x >> shift) === ancestor.x && (descendant.y >> shift) === ancestor.y;
}

export function findVisibleDescendantTiles(tile, candidates) {
    const ancestor = normalizeTileAddressLike(tile);
    if (!ancestor) return [];
    return (Array.isArray(candidates) ? candidates : [])
        .filter((candidate) => isDescendantTile(candidate, ancestor))
        .sort((a, b) => a.depth - b.depth || a.y - b.y || a.x - b.x);
}

export function collectSeamPairs(sampledInstances) {
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

export function buildSameDepthSeamPairs(instances, keyToInst) {
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

export function classifySameDepthSeam(a, b, sideA, sideB) {
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

export function buildCoarseFineSeamPairs(instances, seen) {
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

export function wrapNeighborGridJS(face, depth, x, y) {
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

export function findCoveringNeighborForSeam(inst, side, instances) {
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

export function getInstanceBounds(inst) {
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

export function boundsTouchOnSide(a, b, side) {
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

export function rangesOverlap(a0, a1, b0, b1) {
    return Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
}

export function inferOppositeTouchingSide(aInst, bInst, sideA) {
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

export function computeSharedEdgeSampleUVs(aInst, bInst, sideA, t) {
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

export function buildUniformEdgeSamples(count = 17) {
    const n = Math.max(2, Math.floor(count));
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(i / Math.max(n - 1, 1));
    }
    return out;
}

export function collectInstDiagnosticCoords(inst, side, tValues, texSize) {
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

export function buildSharedVertexSamples(pair, className, lodSegments) {
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

export function classifySharedVertexMismatchCause(currentMaxMeters, baseMaxMeters, finalMaxMeters) {
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

export function summarizeTexelComparison(liveTexels, freshTexels, format) {
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

export function texelToleranceForFormat(format) {
    const fmt = String(format || '').toLowerCase();
    if (fmt.includes('8')) return (0.5 / 255.0) + 1e-6;
    if (fmt.includes('16float')) return 5e-4;
    return 1e-5;
}

export function formatTexelValues(values) {
    return (Array.isArray(values) ? values : [])
        .map((v) => Number.isFinite(v) ? Number(v).toFixed(5) : 'NaN')
        .join('/');
}

export function destroyWrappedTextures(textures) {
    if (!textures || typeof textures !== 'object') return;
    for (const tex of Object.values(textures)) {
        if (!tex) continue;
        try { tex._gpuTexture?.texture?.destroy?.(); } catch { /* ignore cleanup failure */ }
        try { tex.dispose?.(); } catch { /* ignore cleanup failure */ }
    }
}
