import { clamp01, clampByte, clampInt } from '../../../shared/math/index.js';

export function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`WebGPUTerrainGenerator missing required object: ${name}`);
    }
    return value;
}

export function tileCategoryIndex(tileId, tileCategories) {
    for (let i = 0; i < tileCategories.length; i++) {
        const category = tileCategories[i];
        for (const [lo, hi] of category.ranges) {
            if (tileId >= lo && tileId <= hi) {
                return i;
            }
        }
    }
    return -1;
}

export function summarizeTileCategoryHistogram(tileBytes, tileCategories) {
    const counts = new Array(tileCategories.length).fill(0);
    let unknown = 0;
    for (let i = 0; i < tileBytes.length; i++) {
        const idx = tileCategoryIndex(tileBytes[i], tileCategories);
        if (idx >= 0) counts[idx]++;
        else unknown++;
    }
    const total = Math.max(tileBytes.length, 1);
    const summary = [];
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] <= 0) continue;
        summary.push({
            name: tileCategories[i].name,
            count: counts[i],
            pct: (counts[i] * 100) / total
        });
    }
    if (unknown > 0) {
        summary.push({ name: 'UNKNOWN', count: unknown, pct: (unknown * 100) / total });
    }
    summary.sort((a, b) => b.count - a.count);
    return summary;
}

export function formatCategorySummary(summary, limit = 6) {
    if (!Array.isArray(summary) || summary.length === 0) {
        return 'none';
    }
    return summary
        .slice(0, limit)
        .map((entry) => `${entry.name}:${entry.pct.toFixed(1)}%`)
        .join(', ');
}

export function summarizeSplatData(splatBytes, size) {
    let boundaryCount = 0;
    let weightMin = Infinity;
    let weightMax = -Infinity;
    let weightSum = 0;
    const pairCounts = new Map();

    for (let i = 0; i < splatBytes.length; i += 4) {
        const a = splatBytes[i];
        const b = splatBytes[i + 1];
        const weight = splatBytes[i + 2] / 255;
        const boundary = splatBytes[i + 3] > 127;
        if (boundary) boundaryCount++;
        weightMin = Math.min(weightMin, weight);
        weightMax = Math.max(weightMax, weight);
        weightSum += weight;
        const key = `${a}/${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }

    let stable4Count = 0;
    let stable4Total = 0;
    if (size > 1) {
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const idx00 = (y * size + x) * 4;
                const idx10 = (y * size + x + 1) * 4;
                const idx01 = ((y + 1) * size + x) * 4;
                const idx11 = ((y + 1) * size + x + 1) * 4;
                const a0 = splatBytes[idx00];
                const b0 = splatBytes[idx00 + 1];
                const stable =
                    splatBytes[idx10] === a0 && splatBytes[idx10 + 1] === b0 &&
                    splatBytes[idx01] === a0 && splatBytes[idx01 + 1] === b0 &&
                    splatBytes[idx11] === a0 && splatBytes[idx11 + 1] === b0;
                stable4Total++;
                if (stable) stable4Count++;
            }
        }
    }

    const totalPixels = Math.max(1, splatBytes.length / 4);
    const topPairs = [...pairCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([pair, count]) => ({
            pair,
            pct: (count * 100) / totalPixels
        }));

    return {
        topPairs,
        boundaryPct: (boundaryCount * 100) / totalPixels,
        stable4Pct: stable4Total > 0 ? (stable4Count * 100) / stable4Total : 0,
        weightMin: Number.isFinite(weightMin) ? weightMin : 0,
        weightMax: Number.isFinite(weightMax) ? weightMax : 0,
        weightMean: weightSum / totalPixels
    };
}

export function formatPairSummary(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
        return 'none';
    }
    return pairs
        .map((entry) => `${entry.pair}:${entry.pct.toFixed(1)}%`)
        .join(', ');
}

export function summarizeRGBA8Pixels(rgbaBytes) {
    const totalPixels = Math.max(1, rgbaBytes.length / 4);
    let zeroPixels = 0;
    const pixelCounts = new Map();

    for (let i = 0; i < rgbaBytes.length; i += 4) {
        const r = rgbaBytes[i];
        const g = rgbaBytes[i + 1];
        const b = rgbaBytes[i + 2];
        const a = rgbaBytes[i + 3];
        if (r === 0 && g === 0 && b === 0 && a === 0) {
            zeroPixels++;
        }
        const key = `${r}/${g}/${b}/${a}`;
        pixelCounts.set(key, (pixelCounts.get(key) || 0) + 1);
    }

    const topPixels = [...pixelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([pixel, count]) => ({
            pixel,
            pct: (count * 100) / totalPixels
        }));

    return {
        totalPixels,
        zeroPixels,
        topPixels
    };
}

export function formatRGBA8PixelSummary(summary) {
    if (!summary) {
        return 'none';
    }
    const topPixels = Array.isArray(summary.topPixels) && summary.topPixels.length > 0
        ? summary.topPixels
            .map((entry) => `${entry.pixel}:${entry.pct.toFixed(1)}%`)
            .join(', ')
        : 'none';
    return `zero=${summary.zeroPixels}/${summary.totalPixels} top=${topPixels}`;
}

export function emulateSplatOutputFromPaddedTile(paddedTileRaw, paddedSize, innerSize, padding, kernelSize, tileCategories) {
    const output = new Uint8Array(innerSize * innerSize * 4);
    const kernelRadius = Math.max(0.5, 0.5 * Math.max(kernelSize, 1));
    const scoreCount = tileCategories.length;

    for (let y = 0; y < innerSize; y++) {
        for (let x = 0; x < innerSize; x++) {
            const sourcePosX = padding + ((x + 0.5) * innerSize) / Math.max(innerSize, 1);
            const sourcePosY = padding + ((y + 0.5) * innerSize) / Math.max(innerSize, 1);
            const minX = Math.max(0, Math.floor(sourcePosX - kernelRadius));
            const maxX = Math.min(paddedSize - 1, Math.ceil(sourcePosX + kernelRadius) - 1);
            const minY = Math.max(0, Math.floor(sourcePosY - kernelRadius));
            const maxY = Math.min(paddedSize - 1, Math.ceil(sourcePosY + kernelRadius) - 1);
            const centerX = clampInt(Math.floor(sourcePosX), 0, paddedSize - 1);
            const centerY = clampInt(Math.floor(sourcePosY), 0, paddedSize - 1);
            const centerTileId = paddedTileRaw[(centerY * paddedSize + centerX) * 4];

            const categoryScores = new Array(scoreCount).fill(0);
            for (let sy = minY; sy <= maxY; sy++) {
                for (let sx = minX; sx <= maxX; sx++) {
                    const weight = radialKernelWeightJS(
                        sourcePosX,
                        sourcePosY,
                        sx + 0.5,
                        sy + 0.5,
                        kernelRadius
                    );
                    if (weight <= 0) continue;
                    const tileId = paddedTileRaw[(sy * paddedSize + sx) * 4];
                    const categoryId = tileCategoryIndex(tileId, tileCategories);
                    if (categoryId < 0) continue;
                    categoryScores[categoryId] += weight;
                }
            }

            let top0Category = -1;
            let top1Category = -1;
            let top0Score = 0;
            let top1Score = 0;
            for (let categoryId = 0; categoryId < categoryScores.length; categoryId++) {
                const score = categoryScores[categoryId];
                if (score <= 0) continue;
                if (
                    score > top0Score ||
                    (score === top0Score && (top0Category < 0 || categoryId < top0Category))
                ) {
                    top1Category = top0Category;
                    top1Score = top0Score;
                    top0Category = categoryId;
                    top0Score = score;
                } else if (
                    score > top1Score ||
                    (score === top1Score && (top1Category < 0 || categoryId < top1Category))
                ) {
                    top1Category = categoryId;
                    top1Score = score;
                }
            }

            const outIdx = (y * innerSize + x) * 4;
            if (top0Category < 0 || top0Score <= 1e-5) {
                output[outIdx] = 0;
                output[outIdx + 1] = 0;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            const top0Representative = categoryRepresentativeTileIdJS(top0Category, tileCategories);
            const top1Representative = categoryRepresentativeTileIdJS(top1Category, tileCategories);
            const centerCategory = tileCategoryIndex(centerTileId, tileCategories);
            const interiorTileId =
                centerCategory >= 0 && centerCategory === top0Category
                    ? centerTileId
                    : top0Representative;

            if (top1Category < 0 || top1Score <= 1e-5) {
                output[outIdx] = interiorTileId;
                output[outIdx + 1] = interiorTileId;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            const topPairSum = top0Score + top1Score;
            if (topPairSum <= 1e-5) {
                output[outIdx] = interiorTileId;
                output[outIdx + 1] = interiorTileId;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            let biomeA = top0Representative;
            let biomeB = top1Representative;
            let weightOfBiomeA = top0Score / topPairSum;
            if (top1Representative < top0Representative) {
                biomeA = top1Representative;
                biomeB = top0Representative;
                weightOfBiomeA = top1Score / topPairSum;
            }

            output[outIdx] = biomeA;
            output[outIdx + 1] = biomeB;
            output[outIdx + 2] = clampByte(Math.round(clamp01(weightOfBiomeA) * 255));
            output[outIdx + 3] = 255;
        }
    }

    return output;
}

export function compareSplatOutputs(actual, expected, innerSize, sentinelPattern = null) {
    let mismatchCount = 0;
    let sentinelCount = 0;
    let zeroCount = 0;
    let fallbackCount = 0;
    const samples = [];
    const totalPixels = Math.max(1, actual.length / 4);

    for (let i = 0; i < actual.length; i += 4) {
        const pixelIndex = i / 4;
        const x = pixelIndex % innerSize;
        const y = Math.floor(pixelIndex / innerSize);
        const isSentinel =
            Array.isArray(sentinelPattern) &&
            actual[i] === sentinelPattern[0] &&
            actual[i + 1] === sentinelPattern[1] &&
            actual[i + 2] === sentinelPattern[2] &&
            actual[i + 3] === sentinelPattern[3];
        if (isSentinel) sentinelCount++;
        if (
            actual[i] === 0 &&
            actual[i + 1] === 0 &&
            actual[i + 2] === 0 &&
            actual[i + 3] === 0
        ) {
            zeroCount++;
        }
        if (
            actual[i] === 0 &&
            actual[i + 1] === 0 &&
            actual[i + 2] === 255 &&
            actual[i + 3] === 0
        ) {
            fallbackCount++;
        }

        const mismatch =
            actual[i] !== expected[i] ||
            actual[i + 1] !== expected[i + 1] ||
            actual[i + 2] !== expected[i + 2] ||
            actual[i + 3] !== expected[i + 3];
        if (mismatch) {
            mismatchCount++;
            if (samples.length < 6) {
                samples.push(
                    `(${x},${y}) act=${actual[i]}/${actual[i + 1]}/${actual[i + 2]}/${actual[i + 3]} ` +
                    `exp=${expected[i]}/${expected[i + 1]}/${expected[i + 2]}/${expected[i + 3]}`
                );
            }
        }
    }

    return {
        totalPixels,
        mismatchCount,
        sentinelCount,
        zeroCount,
        fallbackCount,
        samples
    };
}

export function radialKernelWeightJS(cx, cy, sx, sy, radius) {
    if (!(radius > 0)) return 0;
    const dx = cx - sx;
    const dy = cy - sy;
    const distanceToSample = Math.sqrt(dx * dx + dy * dy);
    if (distanceToSample >= radius) return 0;
    const normalized = distanceToSample / radius;
    const falloff = 1 - normalized * normalized;
    return falloff * falloff;
}

export function categoryRepresentativeTileIdJS(categoryId, tileCategories) {
    if (!(categoryId >= 0 && categoryId < tileCategories.length)) {
        return 255;
    }
    return tileCategories[categoryId]?.ranges?.[0]?.[0] ?? 255;
}

export function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUTerrainGenerator missing required number: ${name}`);
    }
    return value;
}

export function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUTerrainGenerator missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`WebGPUTerrainGenerator ${name} must be >= ${min}`);
    }
    return n;
}
