import { TILE_TYPES as DEFAULT_TILE_TYPES } from '../templates/configs/tileTypes.js';
import { TEXTURE_CONFIG as BASE_TEXTURE_CONFIG } from '../templates/configs/atlasConfig.js';
import { normalizeCatalogName } from '../core/world/tileCatalogUtils.js';

const TEXTURE_LOOKUP_MAX_TILE_ID = 255;
const DEFAULT_SEASONS = Object.freeze(['Spring', 'Summer', 'Autumn', 'Winter']);
const DEFAULT_AUTHORED_TEXTURE_LAYER = Object.freeze({
    baseColor: '#808080',
    secondaryColor: '#6f6f6f',
    blendWeight: 0.45,
    layers: Object.freeze([
        Object.freeze({ type: 'fbm', scale: 1.0, amplitude: 1.0, seedOffset: 0 }),
    ]),
});
const CATEGORY_TEXTURE_FALLBACKS = Object.freeze({
    WATER: Object.freeze({ baseColor: '#1f5d89', secondaryColor: '#63a7c7', blendWeight: 0.55 }),
    GRASS: Object.freeze({ baseColor: '#3f6f32', secondaryColor: '#8cac52', blendWeight: 0.55 }),
    FOREST: Object.freeze({ baseColor: '#2e4a2a', secondaryColor: '#6a5538', blendWeight: 0.45 }),
    ROCK: Object.freeze({ baseColor: '#5d5d58', secondaryColor: '#8c8980', blendWeight: 0.35 }),
    SNOW: Object.freeze({ baseColor: '#d9e4e8', secondaryColor: '#ffffff', blendWeight: 0.35 }),
    DESERT: Object.freeze({ baseColor: '#b89253', secondaryColor: '#e0c27a', blendWeight: 0.45 }),
    SAND: Object.freeze({ baseColor: '#b89253', secondaryColor: '#e0c27a', blendWeight: 0.45 }),
    DIRT: Object.freeze({ baseColor: '#67492f', secondaryColor: '#95704a', blendWeight: 0.45 }),
    MUD: Object.freeze({ baseColor: '#3e3029', secondaryColor: '#675044', blendWeight: 0.45 }),
    TUNDRA: Object.freeze({ baseColor: '#687162', secondaryColor: '#a0a992', blendWeight: 0.4 }),
    SWAMP: Object.freeze({ baseColor: '#36482f', secondaryColor: '#657243', blendWeight: 0.5 }),
    VOLCANIC: Object.freeze({ baseColor: '#2d2c2b', secondaryColor: '#62544b', blendWeight: 0.35 }),
});

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneValue(entry));
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = cloneValue(entry);
        }
        return result;
    }
    return value;
}

function normalizeNoiseType(type) {
    switch ((type || 'fbm').toLowerCase()) {
        case 'simplex':
            return 'fbm';
        case 'perlin':
            return 'perlin';
        case 'voronoi':
            return 'voronoi';
        case 'grain':
            return 'grain';
        default:
            return 'fbm';
    }
}

function clamp01(value, fallback = 1.0) {
    const n = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(1, n));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0);
    return t * t * (3 - 2 * t);
}

function hexToRgb(hex, fallback = [128, 128, 128]) {
    if (typeof hex !== 'string') return fallback.slice();
    const trimmed = hex.trim();
    const fullHex = /^#[0-9a-fA-F]{6}$/.test(trimmed)
        ? trimmed
        : (/^#[0-9a-fA-F]{3}$/.test(trimmed)
            ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
            : null);
    if (!fullHex) return fallback.slice();

    return [
        parseInt(fullHex.slice(1, 3), 16),
        parseInt(fullHex.slice(3, 5), 16),
        parseInt(fullHex.slice(5, 7), 16),
    ];
}

function mixColor(colorA, colorB, t) {
    const blend = clamp01(t, 0);
    return [
        lerp(colorA[0], colorB[0], blend),
        lerp(colorA[1], colorB[1], blend),
        lerp(colorA[2], colorB[2], blend),
    ];
}

function scaleColor(color, factor) {
    return [
        Math.max(0, Math.min(255, color[0] * factor)),
        Math.max(0, Math.min(255, color[1] * factor)),
        Math.max(0, Math.min(255, color[2] * factor)),
    ];
}

function hash2(x, y, seed) {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 17.13) * 43758.5453123;
    return s - Math.floor(s);
}

function valueNoise2(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm2(x, y, seed, octaves = 4) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1.0;
    let total = 0;
    for (let i = 0; i < octaves; i++) {
        value += valueNoise2(x * frequency, y * frequency, seed + i * 19) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.03;
    }
    return total > 0 ? value / total : 0;
}

function voronoi2(x, y, seed, cellScale = 8) {
    const px = x * cellScale;
    const py = y * cellScale;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    let minDist = Infinity;
    let secondMin = Infinity;

    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const cx = ix + ox;
            const cy = iy + oy;
            const fx = cx + hash2(cx, cy, seed + 11);
            const fy = cy + hash2(cx, cy, seed + 23);
            const dx = fx - px;
            const dy = fy - py;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                secondMin = minDist;
                minDist = dist;
            } else if (dist < secondMin) {
                secondMin = dist;
            }
        }
    }

    return {
        cell: clamp01(1 - minDist, 0),
        edge: clamp01((secondMin - minDist) * 1.8, 0),
    };
}

function getPreviewNoiseScale(scale, levelKey) {
    const baseScale = Math.max(0.0001, Number.isFinite(scale) ? scale : (levelKey === 'macro' ? 0.08 : 1.0));
    if (levelKey === 'macro') {
        return Math.max(baseScale * 18.0, 0.65);
    }
    return Math.max(baseScale * 3.6, 0.8);
}

function samplePreviewSignal(type, u, v, seed, scale, levelKey) {
    const freq = getPreviewNoiseScale(scale, levelKey);
    const x = (u * freq) + seed * 0.013;
    const y = (v * freq) - seed * 0.009;

    switch (normalizeNoiseType(type)) {
        case 'voronoi': {
            const { cell, edge } = voronoi2(x, y, seed, Math.max(2.5, freq));
            return clamp01(cell * 0.45 + edge * 0.85, 0);
        }
        case 'perlin': {
            const coarse = valueNoise2(x, y, seed);
            const fine = valueNoise2(x * 2.3, y * 2.3, seed + 31);
            return clamp01(coarse * 0.7 + fine * 0.3, 0);
        }
        case 'grain': {
            return hash2(Math.floor(u * freq * 24), Math.floor(v * freq * 24), seed + 59);
        }
        default:
            return fbm2(x, y, seed, levelKey === 'macro' ? 5 : 4);
    }
}

function samplePreviewColor(layerState, levelKey, u, v, seedBase) {
    const baseColor = hexToRgb(layerState?.baseColor, [128, 128, 128]);
    const secondaryColor = hexToRgb(layerState?.secondaryColor, baseColor);
    const blendWeight = clamp01(layerState?.blendWeight, 0.5);
    const layers = Array.isArray(layerState?.layers) ? layerState.layers : [];

    const baseSignal = fbm2(
        u * (levelKey === 'macro' ? 1.7 : 3.0),
        v * (levelKey === 'macro' ? 1.7 : 3.0),
        seedBase + 17,
        levelKey === 'macro' ? 5 : 4
    );
    let color = mixColor(baseColor, secondaryColor, blendWeight * (0.2 + 0.8 * baseSignal));
    let brightness = 0.94 + (baseSignal - 0.5) * 0.18;

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i] || {};
        const amplitude = clamp01(Number.isFinite(layer.amplitude) ? layer.amplitude : 1.0, 1.0);
        const signal = samplePreviewSignal(
            layer.type,
            u,
            v,
            seedBase + 101 + i * 41 + (Number.isFinite(layer.seedOffset) ? layer.seedOffset : 0),
            layer.scale,
            levelKey
        );
        const signed = (signal - 0.5) * 2.0;
        const layerTint = signed >= 0 ? secondaryColor : baseColor;
        const mixAmount = clamp01((0.12 + Math.abs(signed) * 0.55) * amplitude, 0);
        color = mixColor(color, layerTint, mixAmount);
        brightness *= 0.97 + signed * amplitude * 0.16;
    }

    const grain = hash2(u * 256, v * 256, seedBase + 997) - 0.5;
    const vignetteX = Math.abs(u - 0.5) * 2;
    const vignetteY = Math.abs(v - 0.5) * 2;
    const vignette = 0.96 - smoothstep(0.4, 1.0, Math.max(vignetteX, vignetteY)) * 0.08;
    brightness *= vignette * (1 + grain * 0.08);

    return scaleColor(color, brightness);
}

function renderPreviewRegion(data, canvasWidth, canvasHeight, regionX, regionY, regionWidth, regionHeight, layerState, levelKey, seedBase) {
    const xEnd = Math.min(canvasWidth, regionX + regionWidth);
    const yEnd = Math.min(canvasHeight, regionY + regionHeight);
    for (let y = regionY; y < yEnd; y++) {
        for (let x = regionX; x < xEnd; x++) {
            const u = regionWidth > 1 ? (x - regionX) / Math.max(regionWidth - 1, 1) : 0;
            const v = regionHeight > 1 ? (y - regionY) / Math.max(regionHeight - 1, 1) : 0;
            const color = samplePreviewColor(layerState, levelKey, u, v, seedBase);
            const idx = (y * canvasWidth + x) * 4;
            data[idx + 0] = Math.round(color[0]);
            data[idx + 1] = Math.round(color[1]);
            data[idx + 2] = Math.round(color[2]);
            data[idx + 3] = 255;
        }
    }
}

function drawPreviewLabels(ctx, width, height, layerKey) {
    ctx.save();
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';
    if (layerKey === 'both') {
        const half = Math.floor(width / 2);
        ctx.fillStyle = 'rgba(17, 19, 24, 0.7)';
        ctx.fillRect(8, 8, 48, 18);
        ctx.fillRect(half + 8, 8, 48, 18);
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText('MICRO', 14, 12);
        ctx.fillStyle = '#6ba4ff';
        ctx.fillText('MACRO', half + 14, 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(half + 0.5, 0);
        ctx.lineTo(half + 0.5, height);
        ctx.stroke();
    } else {
        ctx.fillStyle = 'rgba(17, 19, 24, 0.7)';
        ctx.fillRect(8, 8, 58, 18);
        ctx.fillStyle = layerKey === 'macro' ? '#6ba4ff' : '#ff6b6b';
        ctx.fillText(layerKey === 'macro' ? 'MACRO' : 'MICRO', 14, 12);
    }
    ctx.restore();
}

function buildOverrideVariant(tileId, levelKey, override = {}) {
    const baseColor = override.baseColor || '#808080';
    const secondaryColor = override.secondaryColor || baseColor;
    const blendWeight = clamp01(override.blendWeight, 0.5);
    const rawLayers = Array.isArray(override.layers) ? override.layers : [];
    const usesFullLayerSchema = rawLayers.some((layer) =>
        layer && typeof layer === 'object' && (
            'color' in layer ||
            'frequency' in layer ||
            'blendMode' in layer ||
            'opacity' in layer
        )
    );

    if (usesFullLayerSchema) {
        return rawLayers.map((layer) => cloneValue(layer));
    }

    const variant = [
        { type: 'fill', color: baseColor, opacity: 1.0 },
    ];

    const defaultFrequency = levelKey === 'macro' ? 0.08 : 3.0;
    for (let i = 0; i < rawLayers.length; i++) {
        const layer = rawLayers[i] || {};
        variant.push({
            type: normalizeNoiseType(layer.type),
            color: secondaryColor,
            opacity: clamp01((layer.amplitude ?? 1.0) * blendWeight, blendWeight),
            blendMode: i === 0 ? 'overlay' : 'multiply',
            frequency: Math.max(0.0001, Number.isFinite(layer.scale) ? layer.scale : defaultFrequency),
            amplitude: Math.max(0.0001, Number.isFinite(layer.amplitude) ? layer.amplitude : 1.0),
            octaves: layer.type === 'perlin' ? 3 : 4,
            seed: (tileId * 1009) + (Number.isFinite(layer.seedOffset) ? layer.seedOffset : 0) + (i * 37),
        });
    }

    if (variant.length === 1) {
        variant.push({
            type: 'grain',
            color: secondaryColor,
            opacity: Math.max(0.08, blendWeight * 0.35),
            blendMode: 'overlay',
            amplitude: 1.0,
            seed: tileId * 1009,
        });
    }

    return variant;
}

function getCategoryTextureFallback(category) {
    const key = normalizeCatalogName(category, '');
    const fallback = CATEGORY_TEXTURE_FALLBACKS[key] ?? DEFAULT_AUTHORED_TEXTURE_LAYER;
    return {
        ...cloneValue(fallback),
        layers: cloneValue(DEFAULT_AUTHORED_TEXTURE_LAYER.layers),
    };
}

function getTextureSeasons(config) {
    const seasons = new Set();
    for (const entry of Array.isArray(config) ? config : []) {
        const base = entry?.textures?.base;
        if (!base || typeof base !== 'object') continue;
        for (const season of Object.keys(base)) {
            seasons.add(season);
        }
    }
    return seasons.size > 0 ? Array.from(seasons) : DEFAULT_SEASONS.slice();
}

function normalizeCatalogTiles(tileCatalog) {
    const tiles = Array.isArray(tileCatalog?.tiles) ? tileCatalog.tiles : [];
    const out = [];
    const seen = new Set();

    for (const source of tiles) {
        const tileId = Math.trunc(Number(source?.tileId ?? source?.value ?? source?.id));
        if (!Number.isFinite(tileId) || tileId < 0 || seen.has(tileId)) continue;
        seen.add(tileId);
        const rawName = source?.name ?? (typeof source?.id === 'string' ? source.id : null);
        out.push({
            id: tileId,
            name: normalizeCatalogName(rawName, `TILE_${tileId}`),
            category: normalizeCatalogName(source?.category, 'UNMAPPED'),
        });
    }

    return out;
}

function createAuthoredTextureEntry(tileId, tileName, tileOverride = {}, seasons = DEFAULT_SEASONS, category = '') {
    const categoryFallback = getCategoryTextureFallback(category);
    const microOverride = tileOverride.micro ?? tileOverride.macro ?? categoryFallback;
    const macroOverride = tileOverride.macro ?? tileOverride.micro ?? categoryFallback;
    const base = {};

    for (const season of seasons) {
        base[season] = {
            micro: [buildOverrideVariant(tileId, 'micro', microOverride)],
            macro: [buildOverrideVariant(tileId, 'macro', macroOverride)],
        };
    }

    return {
        id: tileId,
        name: tileName,
        category,
        authored: true,
        textures: { base },
    };
}

function ensureTextureEntry(config, tileId, tileName, category, seasons) {
    let entry = config.find((candidate) => candidate?.id === tileId);
    const fallback = getCategoryTextureFallback(category);

    if (!entry) {
        entry = createAuthoredTextureEntry(tileId, tileName, { micro: fallback, macro: fallback }, seasons, category);
        config.push(entry);
        return entry;
    }

    entry.name = entry.name ?? tileName;
    if (!entry.textures || typeof entry.textures !== 'object') entry.textures = {};
    if (!entry.textures.base || typeof entry.textures.base !== 'object') {
        entry.textures.base = {};
    }

    for (const season of seasons) {
        const seasonConfig = entry.textures.base[season] && typeof entry.textures.base[season] === 'object'
            ? entry.textures.base[season]
            : {};
        entry.textures.base[season] = seasonConfig;
        if (!Array.isArray(seasonConfig.micro) || seasonConfig.micro.length === 0) {
            seasonConfig.micro = [buildOverrideVariant(tileId, 'micro', fallback)];
        }
        if (!Array.isArray(seasonConfig.macro) || seasonConfig.macro.length === 0) {
            seasonConfig.macro = [buildOverrideVariant(tileId, 'macro', fallback)];
        }
    }

    return entry;
}

export function buildWorldTextureConfig(rawTextures, baseTextureConfig = BASE_TEXTURE_CONFIG, options = {}) {
    const config = cloneValue(baseTextureConfig);
    const tileCatalog = options.tileCatalog && typeof options.tileCatalog === 'object'
        ? options.tileCatalog
        : null;
    const tileTypes = tileCatalog?.tileTypes && typeof tileCatalog.tileTypes === 'object'
        ? tileCatalog.tileTypes
        : (options.tileTypes && typeof options.tileTypes === 'object'
        ? options.tileTypes
        : DEFAULT_TILE_TYPES);
    const catalogTiles = normalizeCatalogTiles(tileCatalog);
    const overrides = rawTextures?.overrides && typeof rawTextures.overrides === 'object'
        ? rawTextures.overrides
        : {};
    if (catalogTiles.length === 0 && Object.keys(overrides).length === 0) {
        return config;
    }

    const seasons = getTextureSeasons(config);
    const skippedOutOfRange = [];

    for (const tile of catalogTiles) {
        if (tile.id > TEXTURE_LOOKUP_MAX_TILE_ID) {
            skippedOutOfRange.push({ tileName: tile.name, tileId: tile.id, source: 'tileCatalog' });
            continue;
        }
        ensureTextureEntry(config, tile.id, tile.name, tile.category, seasons);
    }

    for (const [tileName, tileOverride] of Object.entries(overrides)) {
        const tileId = tileTypes[tileName];
        if (!Number.isInteger(tileId) || !tileOverride || typeof tileOverride !== 'object') {
            continue;
        }
        if (tileId < 0 || tileId > TEXTURE_LOOKUP_MAX_TILE_ID) {
            skippedOutOfRange.push({ tileName, tileId, source: 'textures' });
            continue;
        }

        const catalogTile = catalogTiles.find((tile) => tile.id === tileId || tile.name === tileName);
        let entry = config.find((candidate) => candidate?.id === tileId);
        if (!entry) {
            entry = createAuthoredTextureEntry(tileId, tileName, tileOverride, seasons, catalogTile?.category ?? '');
            config.push(entry);
        } else {
            entry = ensureTextureEntry(config, tileId, tileName, catalogTile?.category ?? '', seasons);
        }

        for (const season of seasons) {
            const seasonConfig = entry.textures.base[season] && typeof entry.textures.base[season] === 'object'
                ? entry.textures.base[season]
                : {};
            entry.textures.base[season] = seasonConfig;

            if (tileOverride.micro) {
                seasonConfig.micro = [buildOverrideVariant(tileId, 'micro', tileOverride.micro)];
            }
            if (tileOverride.macro) {
                seasonConfig.macro = [buildOverrideVariant(tileId, 'macro', tileOverride.macro)];
            }
        }
    }

    if (skippedOutOfRange.length > 0) {
        console.warn(
            `[WorldTextureOverrides] skipped ${skippedOutOfRange.length} authored tile texture definition(s) with tile IDs outside ` +
            `the 0-${TEXTURE_LOOKUP_MAX_TILE_ID} texture lookup range`,
            skippedOutOfRange
        );
    }

    return config;
}

export function renderTexturePreviewToCanvas(canvas, previewState = {}, options = {}) {
    const context = canvas?.getContext?.('2d');
    if (!context) return false;

    const width = Math.max(1, Math.round(options.width ?? canvas.width ?? 224));
    const height = Math.max(1, Math.round(options.height ?? canvas.height ?? 128));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const layerKey = previewState.layerKey === 'macro'
        ? 'macro'
        : (previewState.layerKey === 'both' ? 'both' : 'micro');
    const image = context.createImageData(width, height);
    const data = image.data;

    if (layerKey === 'both') {
        const leftWidth = Math.floor(width / 2);
        renderPreviewRegion(data, width, height, 0, 0, leftWidth, height, previewState.micro, 'micro', 1701);
        renderPreviewRegion(data, width, height, leftWidth, 0, width - leftWidth, height, previewState.macro, 'macro', 2903);
    } else {
        const state = layerKey === 'macro' ? previewState.macro : previewState.micro;
        renderPreviewRegion(data, width, height, 0, 0, width, height, state, layerKey, layerKey === 'macro' ? 2903 : 1701);
    }

    context.putImageData(image, 0, 0);
    drawPreviewLabels(context, width, height, layerKey);
    return true;
}
