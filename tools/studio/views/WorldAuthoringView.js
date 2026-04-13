/**
 * WorldAuthoringView — shared live world-authoring view for Studio.
 *
 * Game-specific integrations such as config loading, engine startup, atlas
 * building, preview rendering, and tile-name lookup are provided by thin
 * subclasses outside `tools/studio`.
 */

import { WorldViewBase } from './WorldViewBase.js';
import { selectBiome } from '../../../core/world/BiomeScoring.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_TEXTURE_DIALOG_LAYER = Object.freeze({
    baseColor: '#808080',
    secondaryColor: '#808080',
    blendWeight: 0.5,
    layers: [{ type: 'fbm', scale: 1.0, amplitude: 1.0, seedOffset: 0 }],
});

function clampTextureDialogBlend(value, fallback = 0.5) {
    const numeric = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(1, numeric));
}

function normalizeTextureDialogColor(value, fallback = '#808080') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
        const [r, g, b] = trimmed.slice(1).split('');
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return fallback;
}

function normalizeTextureDialogNoiseType(type) {
    switch ((type || 'fbm').toLowerCase()) {
        case 'simplex':
        case 'fbm':
        case 'turbulence':
        case 'grain':
            return 'fbm';
        case 'perlin':
            return 'perlin';
        case 'voronoi':
        case 'cells':
            return 'voronoi';
        default:
            return 'fbm';
    }
}

function getDefaultTextureDialogNoiseLayer(levelKey = 'micro') {
    return {
        type: 'fbm',
        scale: levelKey === 'macro' ? 0.08 : 1.0,
        amplitude: 1.0,
        seedOffset: 0,
    };
}

function cloneTextureDialogNoiseLayer(layer = {}, levelKey = 'micro') {
    const fallback = getDefaultTextureDialogNoiseLayer(levelKey);
    return {
        type: normalizeTextureDialogNoiseType(layer.type ?? fallback.type),
        scale: Number.isFinite(layer.scale) ? layer.scale : fallback.scale,
        amplitude: Number.isFinite(layer.amplitude) ? layer.amplitude : fallback.amplitude,
        seedOffset: Number.isFinite(layer.seedOffset) ? Math.trunc(layer.seedOffset) : fallback.seedOffset,
    };
}

function cloneTextureDialogLayerState(state = {}, levelKey = 'micro') {
    const fallback = {
        ...DEFAULT_TEXTURE_DIALOG_LAYER,
        layers: [getDefaultTextureDialogNoiseLayer(levelKey)],
    };
    const layers = Array.isArray(state.layers)
        ? state.layers.map((layer) => cloneTextureDialogNoiseLayer(layer, levelKey))
        : [];

    return {
        baseColor: normalizeTextureDialogColor(state.baseColor, fallback.baseColor),
        secondaryColor: normalizeTextureDialogColor(state.secondaryColor, fallback.secondaryColor),
        blendWeight: clampTextureDialogBlend(state.blendWeight, fallback.blendWeight),
        layers: layers.length > 0 ? layers : fallback.layers.map((layer) => ({ ...layer })),
    };
}

// ── WorldAuthoringView ────────────────────────────────────────────────────────

export class WorldAuthoringView extends WorldViewBase {
    constructor(id) {
        super(id);
        this._hoverLayerVisibility = { micro: true, macro: true };
        this._hoverInfo = null;
        this._lastQueryTime = 0;
        this._pendingRaycast = false;
        this._pendingBiomeQuery = false;
        this._overlayEls = {};
        this._textureDialog = null;
        this._lastHoverSuccessTime = 0;
        this._pendingTextureDialogRequest = null;
        this._pendingHoverAnchorScreen = null;
        this._hoverAnchorScreen = null;
        this._hoverTileHeightCache = null;
        this._hoverTileHeightRequestKey = null;
        this._hoverBorderGeometryCache = new Map();
        this._hoverBorderGeometryRequests = new Set();
        this._hoverHeightTexelCache = new Map();
        this._texturePreviewTimer = null;
        this._texturePreviewRequestId = 0;
    }

    get tileIdNameMap() { return null; }

    buildTextureConfig(_rawTextures, baseTextureConfig = null) {
        return baseTextureConfig;
    }

    async renderTexturePreview(_canvas, _previewState) {
        return false;
    }

    _getTileName(tileId) {
        return this.tileIdNameMap?.[tileId] || `TILE_${tileId}`;
    }

    _createRegenConfigs(raw) {
        const loader = this.configLoader ?? this._loader;
        if (!loader?._buildEngineConfig || !loader?._buildGameDataConfig) {
            throw new Error('World authoring view requires a configLoader with rebuild helpers');
        }
        loader.raw = raw;
        return {
            engineConfig: loader._buildEngineConfig(raw.terrain, raw.planet, raw.engine),
            gameDataConfig: loader._buildGameDataConfig(raw.terrain, raw.planet, raw.textures),
        };
    }

    // ── Lifecycle ─────────────────────────────────────────────────────

    async onInit(context) {
        await super.onInit(context);
        this._createOverlays();
        this._applyTerrainLayerViewMode();
        this._attachEditorListeners(context.canvas);
    }

    onDestroy() {
        super.onDestroy();
        this._removeOverlays();
        this._closeTextureDialog();
    }

    onUpdate(dt, t) {
        super.onUpdate(dt, t);
        this._processHoverQuery();
    }

    // ── Left sidebar — real controls ──────────────────────────────────

    _buildLeftSidebar(container, raw) {
        this._buildWorldSettingsSection(container, raw);
        this._buildTerrainNoiseSection(container, raw);
        this._buildRenderingSection(container, raw);
        this._buildBiomesSection(container, raw);
        this._buildAssetsSection(container, raw);
        this._buildActionsSection(container);
    }

    // ── Task 3: World Settings ────────────────────────────────────────

    _buildWorldSettingsSection(container, raw) {
        const body = this._addSection(container, 'World Settings', true);

        this._addEditorSlider(body, raw, {
            label: 'Seed', min: 0, max: 99999, step: 1, needsRegen: true,
            tooltip: 'World seed. Changing this creates an entirely different world.\nRequires world regeneration.',
            get: r => r.terrain?.seed ?? 12345,
            set: (r, v) => { r.terrain.seed = v; },
        });

        this._addEditorSlider(body, raw, {
            label: 'Atmo Height', min: 0.05, max: 0.5, step: 0.01, needsRegen: true,
            tooltip: 'Atmosphere height as fraction of planet radius.\nRequires world regeneration.',
            get: r => r.planet?.atmosphereHeightRatio ?? 0.2,
            set: (r, v) => { r.planet.atmosphereHeightRatio = v; },
        });

        const subHead = document.createElement('div');
        subHead.className = 'panel-subsection-head';
        subHead.textContent = 'Atmospheric Scattering';
        body.appendChild(subHead);

        this._addEditorSlider(body, raw, {
            label: 'Visual Density', min: 0, max: 2, step: 0.01, needsRegen: false,
            tooltip: 'Atmospheric haze density. Higher = thicker atmosphere.\nUpdates in real-time.',
            get: r => r.planet?.atmosphereOptions?.visualDensity ?? 0.5,
            set: (r, v) => { r.planet.atmosphereOptions.visualDensity = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Sun Intensity', min: 1, max: 60, step: 0.5, needsRegen: false,
            tooltip: 'Sun brightness multiplier.\nUpdates in real-time.',
            get: r => r.planet?.atmosphereOptions?.sunIntensity ?? 20,
            set: (r, v) => { r.planet.atmosphereOptions.sunIntensity = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Mie Anisotropy', min: 0, max: 0.99, step: 0.01, needsRegen: false,
            tooltip: 'Forward scattering (halo around sun). 0.76 = Earth-like.\nUpdates in real-time.',
            get: r => r.planet?.atmosphereOptions?.mieAnisotropy ?? 0.76,
            set: (r, v) => { r.planet.atmosphereOptions.mieAnisotropy = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Rayleigh Scale', min: 0.01, max: 0.5, step: 0.005, needsRegen: false,
            tooltip: 'Rayleigh scattering scale height (fraction of atmosphere).\nUpdates in real-time.',
            get: r => r.planet?.atmosphereOptions?.scaleHeightRayleighRatio ?? 0.1,
            set: (r, v) => { r.planet.atmosphereOptions.scaleHeightRayleighRatio = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Mie Scale', min: 0.005, max: 0.1, step: 0.001, needsRegen: false,
            tooltip: 'Mie scattering scale height (fraction of atmosphere).\nUpdates in real-time.',
            get: r => r.planet?.atmosphereOptions?.scaleHeightMieRatio ?? 0.015,
            set: (r, v) => { r.planet.atmosphereOptions.scaleHeightMieRatio = v; },
        });
    }

    // ── Task 4: Terrain Noise ─────────────────────────────────────────

    _buildTerrainNoiseSection(container, raw) {
        const body = this._addSection(container, 'Terrain Noise', false);

        // noiseProfile
        const noiseHead = document.createElement('div');
        noiseHead.className = 'panel-subsection-head';
        noiseHead.textContent = 'Noise Profile';
        body.appendChild(noiseHead);

        const np = [
            { label: 'Base Bias', key: 'baseBias', min: 0, max: 3, step: 0.05, def: 1.0, tip: 'Global height amplitude multiplier.' },
            { label: 'Mountain Bias', key: 'mountainBias', min: 0, max: 3, step: 0.05, def: 1.0, tip: 'Mountain feature prominence.' },
            { label: 'Hill Bias', key: 'hillBias', min: 0, max: 3, step: 0.05, def: 1.0, tip: 'Hill feature prominence.' },
            { label: 'Canyon Bias', key: 'canyonBias', min: 0, max: 3, step: 0.05, def: 1.0, tip: 'Canyon depth and frequency.' },
            { label: 'Rare Boost', key: 'rareBoost', min: 0, max: 3, step: 0.05, def: 1.0, tip: 'Strength of rare terrain features.' },
            { label: 'Warp Strength', key: 'warpStrength', min: 0, max: 2, step: 0.05, def: 1.0, tip: 'Domain warping distortion.' },
            { label: 'Ridge Sharpness', key: 'ridgeSharpness', min: 0, max: 2, step: 0.05, def: 1.0, tip: 'Mountain ridgeline sharpness.' },
            { label: 'Micro Detail', key: 'microGain', min: 0, max: 2, step: 0.05, def: 1.0, tip: 'High-frequency surface detail.' },
        ];
        for (const p of np) {
            this._addEditorSlider(body, raw, {
                label: p.label, min: p.min, max: p.max, step: p.step, needsRegen: true,
                tooltip: p.tip + '\nRequires world regeneration.',
                get: r => r.terrain?.noiseProfile?.[p.key] ?? p.def,
                set: (r, v) => { if (!r.terrain.noiseProfile) r.terrain.noiseProfile = {}; r.terrain.noiseProfile[p.key] = v; },
            });
        }

        // Continents
        const contHead = document.createElement('div');
        contHead.className = 'panel-subsection-head';
        contHead.textContent = 'Continents';
        body.appendChild(contHead);

        this._addEditorSlider(body, raw, {
            label: 'Count', min: 0, max: 12, step: 1, needsRegen: true,
            tooltip: 'Number of continental landmasses.\nRequires world regeneration.',
            get: r => r.terrain?.continents?.count ?? 4,
            set: (r, v) => { r.terrain.continents.count = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Avg Size', min: 0.05, max: 0.7, step: 0.01, needsRegen: true,
            tooltip: 'Average continent size fraction.\nRequires world regeneration.',
            get: r => r.terrain?.continents?.averageSize ?? 0.25,
            set: (r, v) => { r.terrain.continents.averageSize = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Coastline', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Fractal coastline complexity.\nRequires world regeneration.',
            get: r => r.terrain?.continents?.coastalComplexity ?? 0.8,
            set: (r, v) => { r.terrain.continents.coastalComplexity = v; },
        });

        // Tectonics
        const tecHead = document.createElement('div');
        tecHead.className = 'panel-subsection-head';
        tecHead.textContent = 'Tectonics';
        body.appendChild(tecHead);

        this._addEditorSlider(body, raw, {
            label: 'Mountain Rate', min: 0, max: 3, step: 0.05, needsRegen: true,
            tooltip: 'Tectonic mountain building rate.\nRequires world regeneration.',
            get: r => r.terrain?.tectonics?.mountainBuildingRate ?? 1.2,
            set: (r, v) => { r.terrain.tectonics.mountainBuildingRate = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Rift Depth', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Rift valley depth.\nRequires world regeneration.',
            get: r => r.terrain?.tectonics?.riftValleyDepth ?? 0.7,
            set: (r, v) => { r.terrain.tectonics.riftValleyDepth = v; },
        });

        // Erosion
        const erosionHead = document.createElement('div');
        erosionHead.className = 'panel-subsection-head';
        erosionHead.textContent = 'Erosion';
        body.appendChild(erosionHead);

        this._addEditorSlider(body, raw, {
            label: 'Global Rate', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Overall erosion intensity.\nRequires world regeneration.',
            get: r => r.terrain?.erosion?.globalRate ?? 0.6,
            set: (r, v) => { r.terrain.erosion.globalRate = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Hydraulic', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Water-driven erosion.\nRequires world regeneration.',
            get: r => r.terrain?.erosion?.hydraulicRate ?? 0.7,
            set: (r, v) => { r.terrain.erosion.hydraulicRate = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Thermal', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Slope-driven erosion.\nRequires world regeneration.',
            get: r => r.terrain?.erosion?.thermalRate ?? 0.4,
            set: (r, v) => { r.terrain.erosion.thermalRate = v; },
        });

        // Water
        const waterHead = document.createElement('div');
        waterHead.className = 'panel-subsection-head';
        waterHead.textContent = 'Water';
        body.appendChild(waterHead);

        this._addEditorSlider(body, raw, {
            label: 'Ocean Level', min: -0.5, max: 0.5, step: 0.005, needsRegen: true,
            tooltip: 'Normalised ocean surface height.\nRequires world regeneration.',
            get: r => r.terrain?.water?.oceanLevel ?? -0.01,
            set: (r, v) => { r.terrain.water.oceanLevel = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Visual Depth', min: 10, max: 2000, step: 10, needsRegen: false,
            tooltip: 'Water visual scattering depth (m).\nUpdates in real-time.',
            get: r => r.terrain?.water?.visualDepthRange ?? 240,
            set: (r, v) => { r.terrain.water.visualDepthRange = v; },
        });

        // Surface
        const surfHead = document.createElement('div');
        surfHead.className = 'panel-subsection-head';
        surfHead.textContent = 'Surface';
        body.appendChild(surfHead);

        this._addEditorSlider(body, raw, {
            label: 'Rock Slope Start', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Slope where rock begins to appear.\nRequires world regeneration.',
            get: r => r.terrain?.surface?.rockSlopeStart ?? 0.35,
            set: (r, v) => { r.terrain.surface.rockSlopeStart = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Rock Slope Full', min: 0, max: 1, step: 0.01, needsRegen: true,
            tooltip: 'Slope where rock dominates.\nRequires world regeneration.',
            get: r => r.terrain?.surface?.rockSlopeFull ?? 0.75,
            set: (r, v) => { r.terrain.surface.rockSlopeFull = v; },
        });
    }

    // ── Task 5: Rendering ─────────────────────────────────────────────

    _buildRenderingSection(container, raw) {
        const body = this._addSection(container, 'Rendering', false);

        // HDR
        const hdrHead = document.createElement('div');
        hdrHead.className = 'panel-subsection-head';
        hdrHead.textContent = 'HDR';
        body.appendChild(hdrHead);

        this._addEditorSlider(body, raw, {
            label: 'Exposure', min: 0.1, max: 3, step: 0.01, needsRegen: false,
            tooltip: 'HDR exposure multiplier.\nUpdates in real-time.',
            get: r => r.postprocessing?.exposure ?? 0.75,
            set: (r, v) => { r.postprocessing.exposure = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Bloom Thresh', min: 0.1, max: 8, step: 0.05, needsRegen: false,
            tooltip: 'Brightness level where bloom begins.\nUpdates in real-time.',
            get: r => r.postprocessing?.bloom?.threshold ?? 1.0,
            set: (r, v) => { if (!r.postprocessing.bloom) r.postprocessing.bloom = {}; r.postprocessing.bloom.threshold = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Bloom Knee', min: 0, max: 1, step: 0.01, needsRegen: false,
            tooltip: 'Bloom threshold smoothing width.\nUpdates in real-time.',
            get: r => r.postprocessing?.bloom?.knee ?? 0.25,
            set: (r, v) => { if (!r.postprocessing.bloom) r.postprocessing.bloom = {}; r.postprocessing.bloom.knee = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Bloom Intensity', min: 0, max: 1, step: 0.005, needsRegen: false,
            tooltip: 'Bloom composite strength.\nUpdates in real-time.',
            get: r => r.postprocessing?.bloom?.intensity ?? 0.3,
            set: (r, v) => { if (!r.postprocessing.bloom) r.postprocessing.bloom = {}; r.postprocessing.bloom.intensity = v; },
        });

        // Macro Coverage
        const macroHead = document.createElement('div');
        macroHead.className = 'panel-subsection-head';
        macroHead.textContent = 'Macro Coverage';
        body.appendChild(macroHead);

        this._addEditorSlider(body, raw, {
            label: 'Biome Scale', min: 0.0001, max: 0.01, step: 0.0001, needsRegen: true,
            tooltip: 'Macro biome noise frequency.\nRequires world regeneration.',
            get: r => r.engine?.macroConfig?.biomeScale ?? 0.001,
            set: (r, v) => { if (!r.engine.macroConfig) r.engine.macroConfig = {}; r.engine.macroConfig.biomeScale = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Region Scale', min: 0.00005, max: 0.005, step: 0.00005, needsRegen: true,
            tooltip: 'Macro region noise frequency.\nRequires world regeneration.',
            get: r => r.engine?.macroConfig?.regionScale ?? 0.0005,
            set: (r, v) => { if (!r.engine.macroConfig) r.engine.macroConfig = {}; r.engine.macroConfig.regionScale = v; },
        });

        // Ambient Lighting
        const ambHead = document.createElement('div');
        ambHead.className = 'panel-subsection-head';
        ambHead.textContent = 'Ambient Lighting';
        body.appendChild(ambHead);

        this._addEditorSlider(body, raw, {
            label: 'Intensity', min: 0.1, max: 3, step: 0.05, needsRegen: false,
            tooltip: 'Global ambient intensity multiplier.\nUpdates in real-time.',
            get: r => r.engine?.lighting?.ambient?.intensityMultiplier ?? 1.0,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.ambient').intensityMultiplier = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Min Intensity', min: 0, max: 0.2, step: 0.002, needsRegen: false,
            tooltip: 'Minimum ambient intensity (dark side).\nUpdates in real-time.',
            get: r => r.engine?.lighting?.ambient?.minIntensity ?? 0.028,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.ambient').minIntensity = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Max Intensity', min: 0.05, max: 1, step: 0.01, needsRegen: false,
            tooltip: 'Maximum ambient intensity (lit side).\nUpdates in real-time.',
            get: r => r.engine?.lighting?.ambient?.maxIntensity ?? 0.30,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.ambient').maxIntensity = v; },
        });

        // Fog
        const fogHead = document.createElement('div');
        fogHead.className = 'panel-subsection-head';
        fogHead.textContent = 'Fog';
        body.appendChild(fogHead);

        this._addEditorSlider(body, raw, {
            label: 'Density Mult', min: 0, max: 2, step: 0.01, needsRegen: false,
            tooltip: 'Fog density multiplier.\nUpdates in real-time.',
            get: r => r.engine?.lighting?.fog?.densityMultiplier ?? 0.48,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.fog').densityMultiplier = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Max Base', min: 0, max: 0.005, step: 0.0001, needsRegen: false,
            tooltip: 'Maximum base fog density.\nUpdates in real-time.',
            get: r => r.engine?.lighting?.fog?.maxBaseDensity ?? 0.0006,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.fog').maxBaseDensity = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Day Scale', min: 0, max: 3, step: 0.01, needsRegen: false,
            tooltip: 'Fog density scale during daytime.\nUpdates in real-time.',
            get: r => r.engine?.lighting?.fog?.dayDensityScale ?? 1.0,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.fog').dayDensityScale = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Night Scale', min: 0, max: 3, step: 0.01, needsRegen: false,
            tooltip: 'Fog density scale at night.\nUpdates in real-time.',
            get: r => r.engine?.lighting?.fog?.nightDensityScale ?? 0.42,
            set: (r, v) => { this._ensurePath(r, 'engine.lighting.fog').nightDensityScale = v; },
        });

        // AO / Terrain Shading
        const aoHead = document.createElement('div');
        aoHead.className = 'panel-subsection-head';
        aoHead.textContent = 'AO / Terrain Shading';
        body.appendChild(aoHead);

        this._addEditorSlider(body, raw, {
            label: 'AO Strength', min: 0, max: 1, step: 0.01, needsRegen: false,
            tooltip: 'Master terrain ambient occlusion strength.\nUpdates in real-time.',
            get: r => r.engine?.terrainAO?.sampleStrength ?? 1.0,
            set: (r, v) => { this._ensurePath(r, 'engine.terrainAO').sampleStrength = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'AO Direct', min: 0, max: 1, step: 0.01, needsRegen: false,
            tooltip: 'How much AO darkens direct sunlight.\nUpdates in real-time.',
            get: r => r.engine?.terrainAO?.directStrength ?? 0.7,
            set: (r, v) => { this._ensurePath(r, 'engine.terrainAO').directStrength = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'AO Floor', min: 0, max: 1, step: 0.01, needsRegen: false,
            tooltip: 'Minimum ambient floor after terrain AO.\nUpdates in real-time.',
            get: r => r.engine?.terrainAO?.ambientFloor ?? 0.65,
            set: (r, v) => { this._ensurePath(r, 'engine.terrainAO').ambientFloor = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Aerial Start (m)', min: 50, max: 2000, step: 10, needsRegen: false,
            tooltip: 'Distance where aerial perspective fade begins.\nUpdates in real-time.',
            get: r => r.engine?.terrainShader?.aerialFadeStartMeters ?? 400,
            set: (r, v) => { if (!r.engine.terrainShader) r.engine.terrainShader = {}; r.engine.terrainShader.aerialFadeStartMeters = v; },
        });
        this._addEditorSlider(body, raw, {
            label: 'Aerial End (m)', min: 100, max: 5000, step: 10, needsRegen: false,
            tooltip: 'Distance where aerial perspective fade completes.\nUpdates in real-time.',
            get: r => r.engine?.terrainShader?.aerialFadeEndMeters ?? 600,
            set: (r, v) => { if (!r.engine.terrainShader) r.engine.terrainShader = {}; r.engine.terrainShader.aerialFadeEndMeters = v; },
        });
    }

    // ── M2-T2: Biome editor section ─────────────────────────────────

    _buildBiomesSection(container, raw) {
        const body = this._addSection(container, 'Biomes', false);
        this._biomeEditorBody = body;
        this._selectedBiomeIdx = -1;

        const biomes = raw.biomes?.biomes || [];

        // Biome list
        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'max-height:140px; overflow-y:auto;';
        this._biomeListWrap = listWrap;
        body.appendChild(listWrap);

        this._renderBiomeList(biomes);

        // Add/Remove buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:4px; padding:4px 8px;';

        const addBtn = document.createElement('button');
        addBtn.className = 'studio-btn';
        addBtn.textContent = '+ Add Biome';
        addBtn.title = 'Add a new biome definition';
        addBtn.addEventListener('click', () => this._addBiome());
        btnRow.appendChild(addBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'studio-btn';
        removeBtn.textContent = '- Remove';
        removeBtn.title = 'Remove selected biome definition';
        removeBtn.style.cssText = 'flex:0 0 auto; width:80px;';
        removeBtn.addEventListener('click', () => this._removeBiome());
        btnRow.appendChild(removeBtn);

        body.appendChild(btnRow);

        // Biome detail editor (shown when a biome is selected)
        this._biomeDetailContainer = document.createElement('div');
        body.appendChild(this._biomeDetailContainer);
    }

    _renderBiomeList(biomes) {
        const wrap = this._biomeListWrap;
        if (!wrap) return;
        wrap.innerHTML = '';
        for (let i = 0; i < biomes.length; i++) {
            const biome = biomes[i];
            const item = document.createElement('div');
            item.className = 'biome-list-item' + (i === this._selectedBiomeIdx ? ' selected' : '');
            item.title = `Edit biome: ${biome.displayName}`;

            const swatch = document.createElement('div');
            swatch.className = 'biome-color-swatch';
            const colors = { grass: '#3a6b1e', forest: '#1a4a0e', desert: '#b89550', ice: '#a0c8e0' };
            swatch.style.background = colors[biome.id] || '#666';
            item.appendChild(swatch);

            const label = document.createElement('span');
            label.textContent = biome.displayName || biome.id;
            item.appendChild(label);

            item.addEventListener('click', () => this._selectBiome(i));
            wrap.appendChild(item);
        }
    }

    _selectBiome(idx) {
        this._selectedBiomeIdx = idx;
        const biomes = this._raw?.biomes?.biomes || [];
        this._renderBiomeList(biomes);
        this._renderBiomeDetail(biomes[idx]);
    }

    _renderBiomeDetail(biome) {
        const container = this._biomeDetailContainer;
        if (!container) return;
        container.innerHTML = '';

        if (!biome) return;

        // Identity
        const idHead = document.createElement('div');
        idHead.className = 'panel-subsection-head';
        idHead.textContent = 'Identity';
        container.appendChild(idHead);

        this._addTextInput(container, 'ID', biome.id, 'Stable biome identifier', (v) => { biome.id = v; this._markBiomeDirty(); });
        this._addTextInput(container, 'Display Name', biome.displayName, 'Human-readable biome name', (v) => { biome.displayName = v; this._markBiomeDirty(); });
        this._addTextInput(container, 'Tags', (biome.tags || []).join(', '), 'Comma-separated tags', (v) => { biome.tags = v.split(',').map(s => s.trim()).filter(Boolean); this._markBiomeDirty(); });

        // Base weight
        this._addBiomeSlider(container, 'Base Weight', 0, 3, 0.05, biome.baseWeight ?? 1.0,
            'Base occurrence weight before signal scoring', (v) => { biome.baseWeight = v; this._markBiomeDirty(); });

        // Texture references
        const texHead = document.createElement('div');
        texHead.className = 'panel-subsection-head';
        texHead.textContent = 'Texture References';
        container.appendChild(texHead);

        this._addTextInput(container, 'Micro', biome.tileRef?.micro || '', 'Micro texture tile name (e.g. GRASS_SHORT_1)', (v) => {
            if (!biome.tileRef) biome.tileRef = {};
            biome.tileRef.micro = v;
            this._markBiomeDirty();
        });
        this._addTextInput(container, 'Macro', biome.tileRef?.macro || '', 'Macro texture tile name', (v) => {
            if (!biome.tileRef) biome.tileRef = {};
            biome.tileRef.macro = v;
            this._markBiomeDirty();
        });

        // Signal rules
        const signalNames = ['elevation', 'humidity', 'temperature', 'slope'];
        for (const sig of signalNames) {
            this._renderSignalEditor(container, biome, sig);
        }

        // Regional variation
        const rvHead = document.createElement('div');
        rvHead.className = 'panel-subsection-head';
        rvHead.textContent = 'Regional Variation';
        container.appendChild(rvHead);

        const rv = biome.regionalVariation || {};

        this._addBiomeDropdown(container, 'Noise Type', ['simplex', 'perlin', 'fbm', 'ridged_fbm'], rv.noiseType || 'simplex',
            'Noise algorithm for regional variation', (v) => {
                if (!biome.regionalVariation) biome.regionalVariation = {};
                biome.regionalVariation.noiseType = v;
                this._markBiomeDirty();
            });

        this._addBiomeSlider(container, 'Scale', 0.0001, 0.01, 0.0001, rv.noiseScale ?? 0.001,
            'Noise frequency for regional variation', (v) => {
                if (!biome.regionalVariation) biome.regionalVariation = {};
                biome.regionalVariation.noiseScale = v;
                this._markBiomeDirty();
            });
        this._addBiomeSlider(container, 'Strength', 0, 1, 0.01, rv.noiseStrength ?? 0.15,
            'How much regional noise affects occurrence', (v) => {
                if (!biome.regionalVariation) biome.regionalVariation = {};
                biome.regionalVariation.noiseStrength = v;
                this._markBiomeDirty();
            });
        this._addBiomeSlider(container, 'Seed Offset', 0, 9999, 1, rv.seedOffset ?? 0,
            'Seed offset for regional noise', (v) => {
                if (!biome.regionalVariation) biome.regionalVariation = {};
                biome.regionalVariation.seedOffset = v;
                this._markBiomeDirty();
            });
    }

    _renderSignalEditor(container, biome, signalName) {
        const head = document.createElement('div');
        head.className = 'panel-subsection-head';
        head.textContent = signalName.charAt(0).toUpperCase() + signalName.slice(1) + ' Signal';
        container.appendChild(head);

        if (!biome.signals) biome.signals = {};
        const rule = biome.signals[signalName] || {};

        const set = (key, v) => {
            if (!biome.signals[signalName]) biome.signals[signalName] = {};
            biome.signals[signalName][key] = v;
            this._markBiomeDirty();
        };

        this._addBiomeSlider(container, 'Min', 0, 1, 0.01, rule.min ?? 0, `Minimum ${signalName} value for this biome`, (v) => set('min', v));
        this._addBiomeSlider(container, 'Max', 0, 1, 0.01, rule.max ?? 1, `Maximum ${signalName} value for this biome`, (v) => set('max', v));
        this._addBiomeSlider(container, 'Transition', 0, 0.5, 0.01, rule.transitionWidth ?? 0.1, 'Soft edge transition width', (v) => set('transitionWidth', v));
        this._addBiomeDropdown(container, 'Preference', ['low', 'mid', 'high'], rule.preference || 'mid',
            'Linear preference within the valid band', (v) => set('preference', v));
        this._addBiomeSlider(container, 'Dither Scale', 0, 0.1, 0.001, rule.ditherScale ?? 0.02, 'Edge dithering noise scale', (v) => set('ditherScale', v));
        this._addBiomeSlider(container, 'Dither Strength', 0, 0.5, 0.01, rule.ditherStrength ?? 0.1, 'Edge dithering noise strength', (v) => set('ditherStrength', v));
        this._addBiomeSlider(container, 'Weight', 0, 2, 0.05, rule.weight ?? 0.25, `Importance of ${signalName} in biome scoring`, (v) => set('weight', v));
    }

    _addBiome() {
        if (!this._raw.biomes) this._raw.biomes = { biomes: [] };
        const biomes = this._raw.biomes.biomes;
        const newId = `biome_${biomes.length + 1}`;
        biomes.push({
            id: newId,
            displayName: `New Biome ${biomes.length + 1}`,
            tileRef: { micro: 'GRASS_SHORT_1', macro: 'GRASS_SHORT_1' },
            tags: [],
            baseWeight: 1.0,
            signals: {
                elevation:   { min: 0, max: 1, transitionWidth: 0.1, preference: 'mid', ditherScale: 0.02, ditherStrength: 0.1, weight: 0.25 },
                humidity:    { min: 0, max: 1, transitionWidth: 0.1, preference: 'mid', ditherScale: 0.015, ditherStrength: 0.08, weight: 0.25 },
                temperature: { min: 0, max: 1, transitionWidth: 0.08, preference: 'mid', ditherScale: 0.02, ditherStrength: 0.06, weight: 0.25 },
                slope:       { min: 0, max: 0.7, transitionWidth: 0.1, preference: 'low', ditherScale: 0.01, ditherStrength: 0.05, weight: 0.25 },
            },
            regionalVariation: { noiseType: 'simplex', noiseScale: 0.001, noiseStrength: 0.15, seedOffset: Math.floor(Math.random() * 9999) },
        });
        this._markBiomeDirty();
        this._renderBiomeList(biomes);
        this._selectBiome(biomes.length - 1);
        this.toast(`Added biome "${newId}"`);
    }

    _removeBiome() {
        const biomes = this._raw?.biomes?.biomes;
        if (!biomes || this._selectedBiomeIdx < 0 || this._selectedBiomeIdx >= biomes.length) return;
        const removed = biomes.splice(this._selectedBiomeIdx, 1);
        this._markBiomeDirty();
        this._selectedBiomeIdx = Math.min(this._selectedBiomeIdx, biomes.length - 1);
        this._renderBiomeList(biomes);
        this._renderBiomeDetail(biomes[this._selectedBiomeIdx]);
        this.toast(`Removed biome "${removed[0]?.id}"`);
    }

    _markBiomeDirty() {
        this._dirty = true;
        this._updateDirtyUI();
    }

    // ── Biome editor helpers ──────────────────────────────────────────

    _addTextInput(container, label, value, tooltip, onChange) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = tooltip;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'param-value-input';
        input.style.cssText = 'grid-column: 2 / 4; text-align: left;';
        input.value = value;
        input.title = tooltip;
        input.addEventListener('change', () => onChange(input.value));

        row.appendChild(lbl);
        row.appendChild(input);
        container.appendChild(row);
    }

    _addBiomeSlider(container, label, min, max, step, value, tooltip, onChange) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = tooltip;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider.title = tooltip;

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.className = 'param-value-input';
        numInput.min = min;
        numInput.max = max;
        numInput.step = step;
        numInput.value = this._fmt(value, step);
        numInput.title = tooltip;

        const update = (v) => {
            v = Math.max(min, Math.min(max, v));
            slider.value = v;
            numInput.value = this._fmt(v, step);
            onChange(v);
        };

        slider.addEventListener('input', () => update(parseFloat(slider.value)));
        numInput.addEventListener('change', () => {
            const v = parseFloat(numInput.value);
            if (Number.isFinite(v)) update(v);
        });

        row.appendChild(lbl);
        row.appendChild(slider);
        row.appendChild(numInput);
        container.appendChild(row);
    }

    _addBiomeDropdown(container, label, options, value, tooltip, onChange) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = tooltip;

        const select = document.createElement('select');
        select.style.cssText = 'grid-column: 2 / 4;';
        select.title = tooltip;
        for (const opt of options) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (opt === value) o.selected = true;
            select.appendChild(o);
        }
        select.addEventListener('change', () => onChange(select.value));

        row.appendChild(lbl);
        row.appendChild(select);
        container.appendChild(row);
    }

    // ── M2-T4+5: Asset editor section ─────────────────────────────────

    _buildAssetsSection(container, raw) {
        const body = this._addSection(container, 'Assets', false);
        this._assetEditorBody = body;
        this._selectedAssetIdx = -1;

        const profiles = raw.assets?.profiles || [];

        // Asset list
        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'max-height:120px; overflow-y:auto;';
        this._assetListWrap = listWrap;
        body.appendChild(listWrap);

        this._renderAssetList(profiles);

        // Add/Remove buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:4px; padding:4px 8px;';

        const addBtn = document.createElement('button');
        addBtn.className = 'studio-btn';
        addBtn.textContent = '+ Add Profile';
        addBtn.title = 'Add a new asset distribution profile';
        addBtn.addEventListener('click', () => this._addAssetProfile());
        btnRow.appendChild(addBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'studio-btn';
        removeBtn.textContent = '- Remove';
        removeBtn.title = 'Remove selected asset profile';
        removeBtn.style.cssText = 'flex:0 0 auto; width:80px;';
        removeBtn.addEventListener('click', () => this._removeAssetProfile());
        btnRow.appendChild(removeBtn);

        body.appendChild(btnRow);

        // Asset detail editor
        this._assetDetailContainer = document.createElement('div');
        body.appendChild(this._assetDetailContainer);
    }

    _renderAssetList(profiles) {
        const wrap = this._assetListWrap;
        if (!wrap) return;
        wrap.innerHTML = '';
        for (let i = 0; i < profiles.length; i++) {
            const profile = profiles[i];
            const item = document.createElement('div');
            item.className = 'biome-list-item' + (i === this._selectedAssetIdx ? ' selected' : '');
            item.title = `Edit profile: ${profile.displayName}`;

            const label = document.createElement('span');
            label.textContent = profile.displayName || profile.id;
            item.appendChild(label);

            item.addEventListener('click', () => this._selectAssetProfile(i));
            wrap.appendChild(item);
        }
    }

    _selectAssetProfile(idx) {
        this._selectedAssetIdx = idx;
        const profiles = this._raw?.assets?.profiles || [];
        this._renderAssetList(profiles);
        this._renderAssetDetail(profiles[idx]);
    }

    _renderAssetDetail(profile) {
        const container = this._assetDetailContainer;
        if (!container) return;
        container.innerHTML = '';
        if (!profile) return;

        this._addTextInput(container, 'ID', profile.id, 'Stable profile identifier', (v) => { profile.id = v; });
        this._addTextInput(container, 'Display Name', profile.displayName, 'Human-readable name', (v) => { profile.displayName = v; });
        this._addTextInput(container, 'Archetype', profile.archetypeRef || '', 'Template archetype reference (e.g. tree, rock, fern)', (v) => { profile.archetypeRef = v; });

        // Biome associations
        const biomeIds = (this._raw?.biomes?.biomes || []).map(b => b.id);
        const assocHead = document.createElement('div');
        assocHead.className = 'panel-subsection-head';
        assocHead.textContent = 'Biome Associations';
        container.appendChild(assocHead);

        const currentAssoc = profile.biomeIds || [];
        for (const bid of biomeIds) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:2px 12px; display:flex; align-items:center; gap:6px; font-size:11px;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = currentAssoc.includes(bid);
            cb.title = `Enable this profile for biome "${bid}"`;
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    if (!profile.biomeIds) profile.biomeIds = [];
                    if (!profile.biomeIds.includes(bid)) profile.biomeIds.push(bid);
                } else {
                    profile.biomeIds = (profile.biomeIds || []).filter(b => b !== bid);
                }
            });
            const lbl = document.createElement('span');
            lbl.textContent = bid;
            lbl.style.color = 'var(--text-dim)';
            row.appendChild(cb);
            row.appendChild(lbl);
            container.appendChild(row);
        }

        // Distribution controls
        const distHead = document.createElement('div');
        distHead.className = 'panel-subsection-head';
        distHead.textContent = 'Distribution';
        container.appendChild(distHead);

        this._addBiomeSlider(container, 'Density', 0, 2, 0.05, profile.density ?? 0.5,
            'Asset density multiplier', (v) => { profile.density = v; });
        this._addBiomeSlider(container, 'Probability', 0, 1, 0.01, profile.probability ?? 0.5,
            'Probability of asset placement per cell', (v) => { profile.probability = v; });
        this._addBiomeSlider(container, 'Variation', 0, 1, 0.01, profile.variation ?? 0.3,
            'Random variation in placement', (v) => { profile.variation = v; });
    }

    _addAssetProfile() {
        if (!this._raw.assets) this._raw.assets = { profiles: [] };
        const profiles = this._raw.assets.profiles;
        const newId = `profile_${profiles.length + 1}`;
        profiles.push({
            id: newId,
            displayName: `New Profile ${profiles.length + 1}`,
            biomeIds: [],
            archetypeRef: '',
            density: 0.5,
            probability: 0.5,
            variation: 0.3,
        });
        this._renderAssetList(profiles);
        this._selectAssetProfile(profiles.length - 1);
        this.toast(`Added asset profile "${newId}"`);
    }

    _removeAssetProfile() {
        const profiles = this._raw?.assets?.profiles;
        if (!profiles || this._selectedAssetIdx < 0 || this._selectedAssetIdx >= profiles.length) return;
        const removed = profiles.splice(this._selectedAssetIdx, 1);
        this._selectedAssetIdx = Math.min(this._selectedAssetIdx, profiles.length - 1);
        this._renderAssetList(profiles);
        this._renderAssetDetail(profiles[this._selectedAssetIdx]);
        this.toast(`Removed profile "${removed[0]?.id}"`);
    }

    // ── Actions section ───────────────────────────────────────────────

    _buildActionsSection(container) {
        const actionBody = this._addSection(container, 'Actions', true);

        this._regenBtn = this._addWorldButton(actionBody, '⬡ Regenerate World', () => {
            this._regenerate();
        }, 'regen-btn', 'Generate the world with current settings.\nRequired after changing red-labelled parameters.');

        this._discardBtn = this._addWorldButton(actionBody, '↩ Discard Regen Changes', () => {
            this._discardRegenChanges();
        }, 'discard-btn', 'Undo all changes that require world regeneration.\nReal-time changes (non-red) are kept.');

        this._updateDirtyUI();
    }

    // ── Right sidebar — export/import/nav ─────────────────────────────

    _buildRightSidebar(container) {
        const saveSec = this._addSection(container, 'Save World Config', true);
        this._addButton(saveSec, 'Download terrain.json',       () => this._loader?.exportJSON('terrain', this._raw?.terrain));
        this._addButton(saveSec, 'Download planet.json',        () => this._loader?.exportJSON('planet', this._raw?.planet));
        this._addButton(saveSec, 'Download postprocessing.json',() => this._loader?.exportJSON('postprocessing', this._raw?.postprocessing));
        this._addButton(saveSec, 'Download engine.json',        () => this._loader?.exportJSON('engine', this._raw?.engine));
        this._addButton(saveSec, 'Download textures.json',      () => this._loader?.exportJSON('textures', this._raw?.textures));
        this._addButton(saveSec, 'Download biomes.json',        () => this._loader?.exportJSON('biomes', this._raw?.biomes));
        this._addButton(saveSec, 'Download assets.json',        () => this._loader?.exportJSON('assets', this._raw?.assets));

        const info = document.createElement('div');
        info.style.cssText = 'padding:8px 12px; font-size:10px; color:var(--text-dim); line-height:1.6;';
        info.textContent = 'Download then replace the file in your world/ folder to make changes permanent.';
        saveSec.appendChild(info);

        const loadSec = this._addSection(container, 'Load World Config', false);
        this._addButton(loadSec, 'Load terrain.json…',       () => this._loadFile('terrain'));
        this._addButton(loadSec, 'Load planet.json…',        () => this._loadFile('planet'));
        this._addButton(loadSec, 'Load postprocessing.json…', () => this._loadFile('postprocessing'));
        this._addButton(loadSec, 'Load engine.json…',        () => this._loadFile('engine'));
        this._addButton(loadSec, 'Load textures.json…',      () => this._loadFile('textures'));
        this._addButton(loadSec, 'Load biomes.json…',        () => this._loadFile('biomes'));
        this._addButton(loadSec, 'Load assets.json…',        () => this._loadFile('assets'));

        const navSec = this._addSection(container, 'Navigation', true);
        const navInfo = document.createElement('div');
        navInfo.style.cssText = 'padding:6px 12px; font-size:11px; color:var(--text-dim); line-height:1.7;';
        navInfo.innerHTML = '<b style="color:var(--text)">WASD</b> — fly<br>'
                          + '<b style="color:var(--text)">Q/E</b> — down/up<br>'
                          + '<b style="color:var(--text)">Shift</b> — boost<br>'
                          + '<b style="color:var(--text)">Left-drag</b> — look<br>'
                          + '<b style="color:var(--text)">Hover</b> — biome info<br>'
                          + '<b style="color:var(--text)">Double-click</b> — edit texture';
        navSec.appendChild(navInfo);
    }

    // ── Slider helper with unified regen/realtime logic ───────────────

    _addEditorSlider(body, raw, param) {
        this._addWorldSlider(body, param, raw);
    }

    // ── Realtime application — override parent ────────────────────────

    _applyRealtime() {
        if (!this._engine || !this._raw) return;
        const raw = this._raw;

        // Post-processing
        const pp = raw.postprocessing;
        if (pp) {
            if (pp.exposure != null) this._engine.exposure = pp.exposure;
            this._engine.setBloom?.({
                threshold:   pp.bloom?.threshold,
                knee:        pp.bloom?.knee,
                intensity:   pp.bloom?.intensity,
                blendFactor: pp.bloom?.blendFactor,
            });
        }

        // Atmosphere
        const atmo = raw.planet?.atmosphereOptions;
        if (atmo) {
            this._engine.setAtmosphere?.(atmo);
        }

        // Ambient lighting
        const ambient = raw.engine?.lighting?.ambient;
        if (ambient) {
            this._engine.setAmbientLighting?.(ambient);
        }

        // Fog
        const fog = raw.engine?.lighting?.fog;
        if (fog) {
            this._engine.setFog?.(fog);
        }

        const terrainAO = raw.engine?.terrainAO;
        if (terrainAO) {
            this._engine.setTerrainAO?.(terrainAO);
        } else if (Number.isFinite(raw.engine?.terrainShader?.ambientScale)) {
            this._engine.setTerrainAO?.({
                sampleStrength: Math.max(0, Math.min(1, raw.engine.terrainShader.ambientScale / 1.3)),
            });
        }

        // Terrain shader
        const ts = raw.engine?.terrainShader;
        if (ts) {
            this._engine.setTerrainShader?.(ts);
        }
    }

    // ── Regeneration — override parent ────────────────────────────────

    async _regenerate() {
        if (!this._dirty) { this.toast('No pending regen changes'); return; }

        this.toast('Regenerating world…');

        try {
            // Dispose current engine
            this._engine?.dispose?.();
            this._engine = null;

            // Rebuild configs from current raw through the game-specific loader hook
            const { engineConfig, gameDataConfig } = this._createRegenConfigs(this._raw);

            // Start new engine
            this._engine = await this.createEngine(this._ctx.canvas, engineConfig, gameDataConfig);

            // Apply realtime params
            this._applyRealtime();
            this._applyTerrainLayerViewMode();
            this._updateHoverLayerOverlays();

            // Update snapshot
            this._regenRaw = this._snapshotRegenParams(this._raw);
            this._dirty = false;
            this._updateDirtyUI();

            this.toast('World regenerated');
        } catch (err) {
            console.error('[WorldAuthoringView] Regeneration failed:', err);
            this.toast('Regeneration failed: ' + err.message);
        }
    }

    async _afterWorldFileLoaded(key) {
        if (key !== 'textures') return;
        const textureConfig = this.buildTextureConfig(
            this._raw?.textures,
            this._engine?.planetConfig?.atlasConfig ?? null
        );
        if (textureConfig) {
            await this._engine?.refreshTextureConfig?.(textureConfig);
        }
    }

    // ── Task 1: Layer selector overlay ────────────────────────────────

    _createOverlays() {
        const wrap = document.getElementById('viewport-wrap');
        if (!wrap) return;

        // Layer selector
        const selector = document.createElement('div');
        selector.className = 'layer-selector';

        const microBtn = document.createElement('button');
        microBtn.className = 'layer-toggle';
        microBtn.textContent = 'Micro';
        microBtn.title = 'Toggle the micro texture layer border';
        microBtn.addEventListener('click', () => this._toggleHoverLayerVisibility('micro'));

        const macroBtn = document.createElement('button');
        macroBtn.className = 'layer-toggle';
        macroBtn.textContent = 'Macro';
        macroBtn.title = 'Toggle the macro texture layer border';
        macroBtn.addEventListener('click', () => this._toggleHoverLayerVisibility('macro'));

        selector.appendChild(microBtn);
        selector.appendChild(macroBtn);
        wrap.appendChild(selector);
        this._overlayEls.selector = selector;
        this._overlayEls.microToggleBtn = microBtn;
        this._overlayEls.macroToggleBtn = macroBtn;
        this._syncHoverLayerButtons();

        // Hover info bar
        const hoverInfo = document.createElement('div');
        hoverInfo.className = 'biome-hover-info';
        wrap.appendChild(hoverInfo);
        this._overlayEls.hoverInfo = hoverInfo;

        // Tile border overlays
        const borderLayer = document.createElementNS(SVG_NS, 'svg');
        borderLayer.setAttribute('class', 'tile-border-overlay-layer');
        borderLayer.setAttribute('aria-hidden', 'true');

        const microBorder = document.createElementNS(SVG_NS, 'polygon');
        microBorder.setAttribute('class', 'tile-border-overlay micro');
        borderLayer.appendChild(microBorder);
        this._overlayEls.microBorder = microBorder;

        const macroBorder = document.createElementNS(SVG_NS, 'polygon');
        macroBorder.setAttribute('class', 'tile-border-overlay macro');
        borderLayer.appendChild(macroBorder);
        this._overlayEls.macroBorder = macroBorder;
        wrap.appendChild(borderLayer);
        this._overlayEls.borderLayer = borderLayer;
        this._syncBorderOverlayViewport();

        // Biome diagnostics panel
        const diag = document.createElement('div');
        diag.className = 'biome-diagnostics';
        wrap.appendChild(diag);
        this._overlayEls.diagnostics = diag;
    }

    _removeOverlays() {
        this._engine?.setTerrainHoverOverlay?.(null);
        this._engine?.setTerrainLayerViewMode?.('both');
        for (const el of Object.values(this._overlayEls)) {
            el?.remove();
        }
        this._overlayEls = {};
    }

    _getTerrainLayerViewMode() {
        if (this._hoverLayerVisibility.micro && this._hoverLayerVisibility.macro) return 'both';
        if (this._hoverLayerVisibility.macro) return 'macro';
        return 'micro';
    }

    _applyTerrainLayerViewMode() {
        this._engine?.setTerrainLayerViewMode?.(this._getTerrainLayerViewMode());
    }

    _toggleHoverLayerVisibility(layerKey) {
        const key = layerKey === 'macro' ? 'macro' : 'micro';
        const otherKey = key === 'micro' ? 'macro' : 'micro';
        const nextVisibility = {
            micro: this._hoverLayerVisibility.micro,
            macro: this._hoverLayerVisibility.macro,
        };
        nextVisibility[key] = !nextVisibility[key];

        if (!nextVisibility.micro && !nextVisibility.macro) {
            nextVisibility[key] = true;
            nextVisibility[otherKey] = true;
        }

        this._hoverLayerVisibility = nextVisibility;
        this._syncHoverLayerButtons();
        this._applyTerrainLayerViewMode();
        this._updateHoverLayerOverlays();
    }

    _syncHoverLayerButtons() {
        const microBtn = this._overlayEls.microToggleBtn;
        const macroBtn = this._overlayEls.macroToggleBtn;
        if (microBtn) {
            microBtn.classList.toggle('active-micro', !!this._hoverLayerVisibility.micro);
        }
        if (macroBtn) {
            macroBtn.classList.toggle('active-macro', !!this._hoverLayerVisibility.macro);
        }
    }

    // ── Hover / biome query pipeline ──────────────────────────────────

    _attachEditorListeners(canvas) {
        this._onEditorMouseMove = (e) => {
            const rect = canvas.getBoundingClientRect();
            this._hoverScreenX = e.clientX - rect.left;
            this._hoverScreenY = e.clientY - rect.top;
            this._hoverNeedsQuery = true;
        };

        this._onEditorDblClick = (e) => {
            const rect = canvas.getBoundingClientRect();
            this._hoverScreenX = e.clientX - rect.left;
            this._hoverScreenY = e.clientY - rect.top;
            this._hoverNeedsQuery = true;
            this._pendingTextureDialogRequest = {
                mouseX: e.clientX,
                mouseY: e.clientY,
                screenX: this._hoverScreenX,
                screenY: this._hoverScreenY,
                requestedAt: performance.now(),
            };
            if (this._tryOpenTextureDialogFromCurrentHover(this._pendingTextureDialogRequest)) {
                this._pendingTextureDialogRequest = null;
            }
        };

        this._onEditorMouseLeave = () => {
            this._hoverNeedsQuery = false;
            this._pendingTextureDialogRequest = null;
            this._hideHoverUI();
        };

        canvas.addEventListener('mousemove', this._onEditorMouseMove);
        canvas.addEventListener('dblclick', this._onEditorDblClick);
        canvas.addEventListener('mouseleave', this._onEditorMouseLeave);
    }

    _processHoverQuery() {
        if (!this._hoverNeedsQuery) return;
        if (!this._engine) return;

        const now = performance.now();
        if (now - this._lastQueryTime < 100) return; // Throttle to ~10Hz

        // If we have pending results, resolve them
        if (this._pendingRaycast) {
            this._resolveRaycast();
            return;
        }
        if (this._pendingBiomeQuery) {
            this._resolveBiomeQuery();
            return;
        }

        if (this._isLeftDragging) return;

        // Start a new raycast
        this._startRaycast();
    }

    _startRaycast() {
        const engine = this._engine;
        const raycaster = engine?.terrainRaycaster;
        if (!raycaster) return;

        const ray = engine.screenToRay(this._hoverScreenX, this._hoverScreenY);
        if (!ray) return;

        const res = engine.getQueryResources();
        if (!res) return;

        const encoder = engine.createCommandEncoder();
        if (!encoder) return;

        const dispatched = raycaster.dispatch(
            encoder, ray, engine.planetConfig,
            res.quadtreeGPU, res.textures, res.hashBuf, 5000
        );

        if (dispatched) {
            engine.submitEncoder(encoder);
            this._pendingRaycast = true;
            this._pendingHoverAnchorScreen = {
                x: this._hoverScreenX,
                y: this._hoverScreenY,
            };
            this._lastQueryTime = performance.now();
        }
    }

    async _resolveRaycast() {
        const raycaster = this._engine?.terrainRaycaster;
        if (!raycaster) { this._pendingRaycast = false; return; }

        const hit = await raycaster.resolveHit();
        this._pendingRaycast = false;

        if (!hit?.hit) {
            const dialogRequest = this._pendingTextureDialogRequest;
            if (dialogRequest && this._lastQueryTime >= dialogRequest.requestedAt) {
                if (this._tryOpenTextureDialogFromCurrentHover(dialogRequest)) {
                    this._pendingTextureDialogRequest = null;
                }
            }
            if (performance.now() - this._lastHoverSuccessTime > 250) {
                this._hideHoverUI();
            }
            return;
        }

        // Now dispatch biome query at hit point
        this._hitPosition = hit.position;
        this._startBiomeQuery(hit.position);
    }

    _startBiomeQuery(worldPos) {
        const engine = this._engine;
        const bq = engine?.biomeQuery;
        if (!bq) return;

        const res = engine.getQueryResources();
        if (!res) return;

        const encoder = engine.createCommandEncoder();
        if (!encoder) return;

        const dispatched = bq.dispatch(
            encoder, worldPos, engine.planetConfig,
            res.quadtreeGPU, res.textures, res.hashBuf
        );

        if (dispatched) {
            engine.submitEncoder(encoder);
            this._pendingBiomeQuery = true;
        }
    }

    async _resolveBiomeQuery() {
        const bq = this._engine?.biomeQuery;
        if (!bq) { this._pendingBiomeQuery = false; return; }

        const result = await bq.resolve();
        this._pendingBiomeQuery = false;

        if (!result) {
            const dialogRequest = this._pendingTextureDialogRequest;
            if (dialogRequest && this._lastQueryTime >= dialogRequest.requestedAt) {
                if (this._tryOpenTextureDialogFromCurrentHover(dialogRequest)) {
                    this._pendingTextureDialogRequest = null;
                }
            }
            if (performance.now() - this._lastHoverSuccessTime > 250) {
                this._hideHoverUI();
            }
            return;
        }

        this._lastHoverSuccessTime = performance.now();
        this._hoverAnchorScreen = this._pendingHoverAnchorScreen
            ? { ...this._pendingHoverAnchorScreen }
            : { x: this._hoverScreenX, y: this._hoverScreenY };
        this._pendingHoverAnchorScreen = null;
        this._hoverInfo = {
            tileId: result.tileId,
            tileName: this._getTileName(result.tileId),
            face: result.face,
            depth: result.depth,
            tileX: result.tileX,
            tileY: result.tileY,
            localU: result.localU,
            localV: result.localV,
        };
        this._hoverBorderGeometryCache.clear();
        this._hoverBorderGeometryRequests.clear();
        this._hoverHeightTexelCache.clear();

        this._updateHoverUI();

        const dialogRequest = this._pendingTextureDialogRequest;
        if (dialogRequest && this._lastQueryTime >= dialogRequest.requestedAt) {
            this._pendingTextureDialogRequest = null;
            this._openTextureDialog(result.tileId, dialogRequest.mouseX, dialogRequest.mouseY);
        }
    }

    _updateHoverUI() {
        const info = this._hoverInfo;
        if (!info) return;

        // Run biome diagnostics if biome definitions are available
        const biomeDefs = this._raw?.biomes?.biomes;
        let biomeResult = null;
        if (biomeDefs && biomeDefs.length > 0 && this._hitPosition) {
            // We use tile ID info as proxy signals (real climate signals would need
            // additional GPU readback; this approximation uses elevation from hit pos)
            const engine = this._engine;
            const pc = engine?.planetConfig;
            if (pc) {
                const o = pc.origin || { x: 0, y: 0, z: 0 };
                const hp = this._hitPosition;
                const dist = Math.sqrt((hp.x - o.x) ** 2 + (hp.y - o.y) ** 2 + (hp.z - o.z) ** 2);
                const elevation = Math.max(0, Math.min(1, (dist - pc.radius) / (pc.heightScale || 5000)));
                // Approximate signals from position
                const dir = {
                    x: (hp.x - o.x) / dist,
                    y: (hp.y - o.y) / dist,
                    z: (hp.z - o.z) / dist,
                };
                const latitude = Math.abs(dir.y);
                const temperature = Math.max(0, Math.min(1, 1 - latitude * 1.3 - elevation * 0.3));
                const humidity = Math.max(0, Math.min(1, 0.5 + Math.sin(dir.x * 3 + dir.z * 2) * 0.3 - elevation * 0.2));
                // Slope approximation from tile depth
                const slope = Math.max(0, Math.min(1, (info.depth > 8 ? 0.3 : 0.1)));

                const signals = { elevation, humidity, temperature, slope };
                const seed = this._raw?.terrain?.seed ?? 12345;
                biomeResult = selectBiome(biomeDefs, signals, hp.x, hp.z, seed);
                info.signals = signals;
                info.biomeResult = biomeResult;
            }
        }

        // Update hover info bar
        const hoverEl = this._overlayEls.hoverInfo;
        if (hoverEl) {
            let html = `<span class="biome-hover-tile">${info.tileName}</span> (ID: ${info.tileId})`;
            if (biomeResult?.biome) {
                html += ` | Biome: <span class="biome-hover-tile">${biomeResult.biome.displayName}</span>`;
            }
            hoverEl.innerHTML = html;
            hoverEl.classList.add('visible');
        }

        // Update biome diagnostics panel
        this._updateDiagnostics(info);

        this._updateHoverLayerOverlays();
    }

    _updateDiagnostics(info) {
        const diagEl = this._overlayEls.diagnostics;
        if (!diagEl) return;

        const sigs = info.signals;
        const biomeResult = info.biomeResult;

        if (!sigs || !biomeResult) {
            diagEl.classList.remove('visible');
            return;
        }

        let html = '';
        if (biomeResult.biome) {
            html += `<div class="diag-biome">${biomeResult.biome.displayName}</div>`;
        }

        html += `<div class="diag-row"><span class="diag-label">Elevation</span><span class="diag-value">${sigs.elevation.toFixed(3)}</span></div>`;
        html += `<div class="diag-row"><span class="diag-label">Humidity</span><span class="diag-value">${sigs.humidity.toFixed(3)}</span></div>`;
        html += `<div class="diag-row"><span class="diag-label">Temperature</span><span class="diag-value">${sigs.temperature.toFixed(3)}</span></div>`;
        html += `<div class="diag-row"><span class="diag-label">Slope</span><span class="diag-value">${sigs.slope.toFixed(3)}</span></div>`;

        // Score breakdown
        if (biomeResult.scores) {
            html += '<div style="margin-top:4px; border-top:1px solid var(--border); padding-top:4px;">';
            for (const entry of biomeResult.scores.slice(0, 4)) {
                const pct = (entry.probability * 100).toFixed(1);
                html += `<div class="diag-row"><span class="diag-label">${entry.biome.id}</span><span class="diag-value">${pct}%</span></div>`;
            }
            html += '</div>';
        }

        diagEl.innerHTML = html;
        diagEl.classList.add('visible');
    }

    _showTileBorder(el, info, layer) {
        if (!el || !this._engine?.camera || !this._hitPosition) return;

        this._syncBorderOverlayViewport();
        const planetConfig = this._engine?.planetConfig;
        if (!planetConfig) {
            this._hideTileBorder(el);
            return;
        }

        const faceRect = this._getHoveredTextureCellRect(planetConfig, layer);
        if (!faceRect) {
            this._hideTileBorder(el);
            return;
        }

        const cacheKey = this._getHoverBorderGeometryKey(layer, faceRect);
        const points = this._hoverBorderGeometryCache.get(cacheKey);
        if (typeof points !== 'string' || points.length === 0) {
            this._hideTileBorder(el);
            this._primeHoverBorderGeometry(cacheKey, faceRect, planetConfig);
            return;
        }

        el.setAttribute('points', points);
        el.classList.add('visible');
    }

    _getHoverBorderGeometryKey(layer, faceRect) {
        return [
            layer,
            faceRect.face,
            faceRect.minU01.toFixed(7),
            faceRect.maxU01.toFixed(7),
            faceRect.minV01.toFixed(7),
            faceRect.maxV01.toFixed(7),
        ].join(':');
    }

    _getHoveredTextureCellRect(planetConfig, layer) {
        const faceSample = this._getHoverFaceSample(planetConfig);
        if (!faceSample) return null;

        const cellSpan = layer === 'macro'
            ? Math.max(1, Math.round(planetConfig.macroTileSpan ?? 16))
            : 1;
        const faceSizeWorld = Math.max(1, planetConfig.radius * 2);
        const faceX = faceSample.faceU01 * faceSizeWorld;
        const faceY = faceSample.faceV01 * faceSizeWorld;
        const minX = Math.max(0, Math.floor(faceX / cellSpan) * cellSpan);
        const minY = Math.max(0, Math.floor(faceY / cellSpan) * cellSpan);
        const maxX = Math.min(faceSizeWorld, minX + cellSpan);
        const maxY = Math.min(faceSizeWorld, minY + cellSpan);

        return {
            face: faceSample.face,
            minX,
            maxX,
            minY,
            maxY,
        };
    }

    async _primeHoverBorderGeometry(cacheKey, faceRect, planetConfig) {
        if (!cacheKey || !faceRect || !planetConfig) return;
        if (this._hoverBorderGeometryCache.has(cacheKey) || this._hoverBorderGeometryRequests.has(cacheKey)) {
            return;
        }

        this._hoverBorderGeometryRequests.add(cacheKey);
        try {
            const points = await this._buildAccurateTilePerimeterScreenPoints(faceRect, planetConfig);
            if (Array.isArray(points) && points.length >= 4) {
                const anchored = this._alignPerimeterToHover(points);
                const encoded = anchored
                    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
                    .join(' ');
                this._hoverBorderGeometryCache.set(cacheKey, encoded);
                this._updateHoverLayerOverlays();
            }
        } catch (_error) {
            // Fail closed: leave the border hidden if accurate geometry could not be resolved.
        } finally {
            this._hoverBorderGeometryRequests.delete(cacheKey);
        }
    }

    async _buildAccurateTilePerimeterScreenPoints(faceRect, planetConfig) {
        const cornerSamples = [
            { u01: faceRect.minU01, v01: faceRect.minV01 },
            { u01: faceRect.maxU01, v01: faceRect.minV01 },
            { u01: faceRect.maxU01, v01: faceRect.maxV01 },
            { u01: faceRect.minU01, v01: faceRect.maxV01 },
        ];
        const plannedSamples = [];
        for (const sample of cornerSamples) {
            const plan = this._buildHeightSamplePlan(faceRect.face, sample.u01, sample.v01);
            if (!plan) {
                return [];
            }
            plannedSamples.push(plan);
        }

        await this._primeHeightTexelPlans(plannedSamples);

        const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
        const screenPoints = [];
        for (const plan of plannedSamples) {
            const heightValue = this._resolveHeightSamplePlan(plan);
            if (!Number.isFinite(heightValue)) {
                return [];
            }
            const surfaceRadius = planetConfig.radius + heightValue * (planetConfig.heightScale ?? 1);
            const worldPoint = this._shaderFaceUvToWorldPosition(
                faceRect.face,
                plan.u01,
                plan.v01,
                surfaceRadius,
                origin
            );
            const screenPoint = this._worldToScreen(worldPoint);
            if (!screenPoint) {
                return [];
            }
            screenPoints.push(screenPoint);
        }

        return screenPoints;
    }

    _getTileStreamer() {
        return this._engine?.renderer?.quadtreeTileManager?.tileStreamer ?? null;
    }

    _getQuadtreeMaxDepth() {
        return Math.max(
            0,
            Math.floor(
                this._engine?.getQueryResources?.()?.quadtreeGPU?.maxDepth
                ?? this._engine?.renderer?.quadtreeTileManager?.quadtreeGPU?.maxDepth
                ?? 0
            )
        );
    }

    _getLoadedHeightTileInfoForFaceUv(face, u01, v01) {
        const tileStreamer = this._getTileStreamer();
        if (!tileStreamer?.getLoadedLayer) {
            return null;
        }

        const clampedU = Math.max(0, Math.min(0.999999, u01));
        const clampedV = Math.max(0, Math.min(0.999999, v01));
        const maxDepth = this._getQuadtreeMaxDepth();
        for (let depth = maxDepth; depth >= 0; depth--) {
            const grid = 1 << depth;
            const tileX = Math.min(grid - 1, Math.max(0, Math.floor(clampedU * grid)));
            const tileY = Math.min(grid - 1, Math.max(0, Math.floor(clampedV * grid)));
            const layer = tileStreamer.getLoadedLayer(face, depth, tileX, tileY);
            if (!Number.isInteger(layer) || layer < 0) {
                continue;
            }
            const tileSpan = 1 / grid;
            return {
                key: `${face}:${depth}:${tileX}:${tileY}:${layer}`,
                face,
                depth,
                tileX,
                tileY,
                tileU0: tileX / grid,
                tileV0: tileY / grid,
                tileSpan,
                layer,
                textureSize: Math.max(1, Math.round(tileStreamer.tileTextureSize ?? 128)),
            };
        }

        return null;
    }

    _buildHeightSamplePlan(face, u01, v01) {
        const tileInfo = this._getLoadedHeightTileInfoForFaceUv(face, u01, v01);
        if (!tileInfo) {
            return null;
        }

        const localU = (Math.max(0, Math.min(0.999999, u01)) - tileInfo.tileU0) / tileInfo.tileSpan;
        const localV = (Math.max(0, Math.min(0.999999, v01)) - tileInfo.tileV0) / tileInfo.tileSpan;
        if (!Number.isFinite(localU) || !Number.isFinite(localV)) {
            return null;
        }

        const maxCoord = Math.max(1, tileInfo.textureSize - 1);
        const x = Math.max(0, Math.min(maxCoord, localU * maxCoord));
        const y = Math.max(0, Math.min(maxCoord, localV * maxCoord));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(maxCoord, x0 + 1);
        const y1 = Math.min(maxCoord, y0 + 1);

        return {
            tileInfo,
            u01,
            v01,
            x0,
            y0,
            x1,
            y1,
            tx: x - x0,
            ty: y - y0,
        };
    }

    async _primeHeightTexelPlans(plans) {
        const tileStreamer = this._getTileStreamer();
        if (!tileStreamer?.debugReadArrayLayerTexels || !Array.isArray(plans) || plans.length === 0) {
            return;
        }

        const missingByTile = new Map();
        for (const plan of plans) {
            const tileKey = plan?.tileInfo?.key;
            if (!tileKey) continue;
            let tileCache = this._hoverHeightTexelCache.get(tileKey);
            if (!tileCache) {
                tileCache = new Map();
                this._hoverHeightTexelCache.set(tileKey, tileCache);
            }

            const coords = [
                { x: plan.x0, y: plan.y0 },
                { x: plan.x1, y: plan.y0 },
                { x: plan.x0, y: plan.y1 },
                { x: plan.x1, y: plan.y1 },
            ];
            for (const coord of coords) {
                const coordKey = `${coord.x},${coord.y}`;
                if (tileCache.has(coordKey)) continue;
                let missing = missingByTile.get(tileKey);
                if (!missing) {
                    missing = {
                        tileInfo: plan.tileInfo,
                        coordSet: new Set(),
                    };
                    missingByTile.set(tileKey, missing);
                }
                missing.coordSet.add(coordKey);
            }
        }

        for (const { tileInfo, coordSet } of missingByTile.values()) {
            const coords = Array.from(coordSet, (coordKey) => {
                const [x, y] = coordKey.split(',').map((value) => parseInt(value, 10));
                return { x, y };
            });
            const readback = await tileStreamer.debugReadArrayLayerTexels('height', tileInfo.layer, coords);
            const tileCache = this._hoverHeightTexelCache.get(tileInfo.key);
            if (!tileCache || !readback?.texels) continue;
            for (const texel of readback.texels) {
                const value = texel?.values?.[0];
                if (Number.isFinite(value)) {
                    tileCache.set(`${texel.x},${texel.y}`, value);
                }
            }
        }
    }

    _resolveHeightSamplePlan(plan) {
        const tileCache = this._hoverHeightTexelCache.get(plan?.tileInfo?.key);
        if (!tileCache) {
            return null;
        }
        const h00 = tileCache.get(`${plan.x0},${plan.y0}`);
        const h10 = tileCache.get(`${plan.x1},${plan.y0}`);
        const h01 = tileCache.get(`${plan.x0},${plan.y1}`);
        const h11 = tileCache.get(`${plan.x1},${plan.y1}`);
        if (![h00, h10, h01, h11].every(Number.isFinite)) {
            return null;
        }

        const h0 = h00 * (1 - plan.tx) + h10 * plan.tx;
        const h1 = h01 * (1 - plan.tx) + h11 * plan.tx;
        return h0 * (1 - plan.ty) + h1 * plan.ty;
    }

    _getHoverFaceSample(planetConfig) {
        const info = this._hoverInfo;
        const hit = this._hitPosition;
        if (!info || !hit) return null;

        const grid = 1 << info.depth;
        if (grid <= 0) return null;
        const tileSpan = 1 / grid;
        const tileU0 = info.tileX / grid;
        const tileV0 = info.tileY / grid;
        const clampedLocalU = Math.max(0, Math.min(0.999999, Number(info.localU) || 0));
        const clampedLocalV = Math.max(0, Math.min(0.999999, Number(info.localV) || 0));
        const tileTextureSize = Math.max(1, Math.round(
            this._engine?.renderer?.quadtreeTileManager?.tileStreamer?.tileTextureSize
            ?? this._hoverTileHeightCache?.width
            ?? 128
        ));
        const sampleX = Math.max(0, Math.min(
            tileTextureSize - 1,
            Math.floor(clampedLocalU * Math.max(1, tileTextureSize - 1) + 0.5)
        ));
        const sampleY = Math.max(0, Math.min(
            tileTextureSize - 1,
            Math.floor(clampedLocalV * Math.max(1, tileTextureSize - 1) + 0.5)
        ));
        const radius = Math.hypot(
            hit.x - (planetConfig.origin?.x || 0),
            hit.y - (planetConfig.origin?.y || 0),
            hit.z - (planetConfig.origin?.z || 0)
        );
        const faceTexSize = grid * tileTextureSize;

        return {
            face: info.face,
            radius: radius > 0.0001 ? radius : planetConfig.radius,
            faceU01: tileU0 + clampedLocalU * tileSpan,
            faceV01: tileV0 + clampedLocalV * tileSpan,
            tileTextureSize,
            faceTexSize,
            globalTexX: info.tileX * tileTextureSize + sampleX,
            globalTexY: info.tileY * tileTextureSize + sampleY,
        };
    }

    _getShaderFaceSampleAtWorldPosition(planetConfig, worldPos, preferredFace = null) {
        const origin = planetConfig.origin || { x: 0, y: 0, z: 0 };
        const dx = worldPos.x - origin.x;
        const dy = worldPos.y - origin.y;
        const dz = worldPos.z - origin.z;
        const radius = Math.hypot(dx, dy, dz);
        if (radius <= 0.0001) return null;

        const nx = dx / radius;
        const ny = dy / radius;
        const nz = dz / radius;
        const ax = Math.abs(nx);
        const ay = Math.abs(ny);
        const az = Math.abs(nz);

        const resolveFaceSample = (face) => {
            let u = 0;
            let v = 0;

            if (face === 0) {
                const inv = 1 / Math.max(ax, 1e-6);
                u = -nz * inv;
                v = ny * inv;
            } else if (face === 1) {
                const inv = 1 / Math.max(ax, 1e-6);
                u = nz * inv;
                v = ny * inv;
            } else if (face === 2) {
                const inv = 1 / Math.max(ay, 1e-6);
                u = nx * inv;
                v = -nz * inv;
            } else if (face === 3) {
                const inv = 1 / Math.max(ay, 1e-6);
                u = nx * inv;
                v = nz * inv;
            } else if (face === 4) {
                const inv = 1 / Math.max(az, 1e-6);
                u = nx * inv;
                v = ny * inv;
            } else {
                const inv = 1 / Math.max(az, 1e-6);
                u = -nx * inv;
                v = ny * inv;
            }

            if (u < -1.0001 || u > 1.0001 || v < -1.0001 || v > 1.0001) {
                return null;
            }

            const faceU01 = Math.max(0, Math.min(0.999999, u * 0.5 + 0.5));
            const faceV01 = Math.max(0, Math.min(0.999999, v * 0.5 + 0.5));
            const faceSizeWorld = planetConfig.radius * 2;
            return {
                face,
                radius,
                faceU01,
                faceV01,
                faceX: faceU01 * faceSizeWorld,
                faceY: faceV01 * faceSizeWorld,
            };
        };

        if (Number.isInteger(preferredFace) && preferredFace >= 0 && preferredFace <= 5) {
            const preferred = resolveFaceSample(preferredFace);
            if (preferred) {
                return preferred;
            }
        }

        let face = 0;
        if (ax >= ay && ax >= az) {
            face = nx > 0 ? 0 : 1;
        } else if (ay >= az) {
            face = ny > 0 ? 2 : 3;
        } else {
            face = nz > 0 ? 4 : 5;
        }

        return resolveFaceSample(face);
    }

    _shaderFaceUvToWorldPosition(face, u01, v01, radius, origin = { x: 0, y: 0, z: 0 }) {
        const x = u01 * 2 - 1;
        const y = v01 * 2 - 1;
        let cubeX = 0;
        let cubeY = 0;
        let cubeZ = 0;

        if (face === 0) {
            cubeX = 1;
            cubeY = y;
            cubeZ = -x;
        } else if (face === 1) {
            cubeX = -1;
            cubeY = y;
            cubeZ = x;
        } else if (face === 2) {
            cubeX = x;
            cubeY = 1;
            cubeZ = -y;
        } else if (face === 3) {
            cubeX = x;
            cubeY = -1;
            cubeZ = y;
        } else if (face === 4) {
            cubeX = x;
            cubeY = y;
            cubeZ = 1;
        } else {
            cubeX = -x;
            cubeY = y;
            cubeZ = -1;
        }

        const invLen = 1 / Math.hypot(cubeX, cubeY, cubeZ);
        return {
            x: origin.x + cubeX * invLen * radius,
            y: origin.y + cubeY * invLen * radius,
            z: origin.z + cubeZ * invLen * radius,
        };
    }

    _alignPerimeterToHover(points) {
        if (!Array.isArray(points) || points.length === 0) {
            return [];
        }

        const anchor = this._hoverAnchorScreen || (
            Number.isFinite(this._hoverScreenX) && Number.isFinite(this._hoverScreenY)
                ? { x: this._hoverScreenX, y: this._hoverScreenY }
                : null
        );
        const hitScreen = this._hitPosition ? this._worldToScreen(this._hitPosition) : null;
        if (!anchor || !hitScreen) {
            return points;
        }

        const offsetX = anchor.x - hitScreen.x;
        const offsetY = anchor.y - hitScreen.y;
        if ((offsetX * offsetX + offsetY * offsetY) < 0.25) {
            return points;
        }

        return points.map((point) => ({
            x: point.x + offsetX,
            y: point.y + offsetY,
        }));
    }

    _readHeightValueFromCache(cache, texelX, texelY) {
        if (!cache?.buffer || !Number.isFinite(cache.bytesPerRow) || !Number.isFinite(cache.texelBytes)) {
            return null;
        }
        const x = Math.max(0, Math.min(cache.width - 1, texelX | 0));
        const y = Math.max(0, Math.min(cache.height - 1, texelY | 0));
        const offset = y * cache.bytesPerRow + x * cache.texelBytes;
        const view = new DataView(cache.buffer);
        if (cache.format === 'rgba32float' || cache.format === 'r32float') {
            return view.getFloat32(offset, true);
        }
        return null;
    }

    _sampleSurfaceRadiusForFaceUv(face, u01, v01, planetConfig, fallbackRadius) {
        const cache = this._hoverTileHeightCache;
        if (!cache || cache.face !== face) {
            return fallbackRadius;
        }

        const grid = 1 << cache.depth;
        if (grid <= 0) {
            return fallbackRadius;
        }

        const tileX = Math.min(grid - 1, Math.max(0, Math.floor(u01 * grid)));
        const tileY = Math.min(grid - 1, Math.max(0, Math.floor(v01 * grid)));
        if (tileX !== cache.tileX || tileY !== cache.tileY) {
            return fallbackRadius;
        }

        const localU = (u01 - cache.tileU0) / cache.tileSpan;
        const localV = (v01 - cache.tileV0) / cache.tileSpan;
        if (!Number.isFinite(localU) || !Number.isFinite(localV)) {
            return fallbackRadius;
        }

        const x = Math.max(0, Math.min(cache.width - 1, localU * (cache.width - 1)));
        const y = Math.max(0, Math.min(cache.height - 1, localV * (cache.height - 1)));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(cache.width - 1, x0 + 1);
        const y1 = Math.min(cache.height - 1, y0 + 1);
        const tx = x - x0;
        const ty = y - y0;

        const h00 = this._readHeightValueFromCache(cache, x0, y0);
        const h10 = this._readHeightValueFromCache(cache, x1, y0);
        const h01 = this._readHeightValueFromCache(cache, x0, y1);
        const h11 = this._readHeightValueFromCache(cache, x1, y1);
        if (![h00, h10, h01, h11].every(Number.isFinite)) {
            return fallbackRadius;
        }

        const h0 = h00 * (1 - tx) + h10 * tx;
        const h1 = h01 * (1 - tx) + h11 * tx;
        const heightValue = h0 * (1 - ty) + h1 * ty;
        return planetConfig.radius + heightValue * (planetConfig.heightScale ?? 1);
    }

    async _primeHoverTileHeightCache() {
        const info = this._hoverInfo;
        const tileStreamer = this._engine?.renderer?.quadtreeTileManager?.tileStreamer;
        if (!info || !tileStreamer?.getLoadedLayer || !tileStreamer?.debugReadArrayLayerBuffer) {
            this._hoverTileHeightCache = null;
            return;
        }

        const layer = tileStreamer.getLoadedLayer(info.face, info.depth, info.tileX, info.tileY);
        if (!(layer >= 0)) {
            this._hoverTileHeightCache = null;
            return;
        }

        const key = `${info.face}:${info.depth}:${info.tileX}:${info.tileY}:${layer}`;
        if (this._hoverTileHeightCache?.key === key || this._hoverTileHeightRequestKey === key) {
            return;
        }

        this._hoverTileHeightRequestKey = key;
        try {
            const readback = await tileStreamer.debugReadArrayLayerBuffer('height', layer);
            if (this._hoverTileHeightRequestKey !== key) {
                return;
            }
            if (!readback?.buffer || !readback.width || !readback.height) {
                this._hoverTileHeightCache = null;
                return;
            }

            const grid = 1 << info.depth;
            const tileSpan = 1 / grid;
            this._hoverTileHeightCache = {
                key,
                face: info.face,
                depth: info.depth,
                tileX: info.tileX,
                tileY: info.tileY,
                tileU0: info.tileX / grid,
                tileV0: info.tileY / grid,
                tileSpan,
                layer,
                format: readback.format,
                width: readback.width,
                height: readback.height,
                texelBytes: readback.texelBytes,
                bytesPerRow: readback.bytesPerRow,
                buffer: readback.buffer,
            };

            if (this._hoverInfo && `${this._hoverInfo.face}:${this._hoverInfo.depth}:${this._hoverInfo.tileX}:${this._hoverInfo.tileY}:${layer}` === key) {
                this._updateHoverLayerOverlays();
            }
        } catch (_error) {
            if (this._hoverTileHeightRequestKey === key) {
                this._hoverTileHeightCache = null;
            }
        } finally {
            if (this._hoverTileHeightRequestKey === key) {
                this._hoverTileHeightRequestKey = null;
            }
        }
    }

    _tryOpenTextureDialogFromCurrentHover(request) {
        if (!request || !this._hoverInfo || !Number.isInteger(this._hoverInfo.tileId)) {
            return false;
        }
        if (performance.now() - this._lastHoverSuccessTime > 350) {
            return false;
        }

        const anchor = this._hoverAnchorScreen;
        if (anchor) {
            const dx = anchor.x - request.screenX;
            const dy = anchor.y - request.screenY;
            if ((dx * dx + dy * dy) > (24 * 24)) {
                return false;
            }
        }

        this._openTextureDialog(this._hoverInfo.tileId, request.mouseX, request.mouseY);
        return true;
    }

    _syncBorderOverlayViewport() {
        const borderLayer = this._overlayEls.borderLayer;
        if (!borderLayer) return;

        const wrap = document.getElementById('viewport-wrap');
        const width = Math.max(1, wrap?.clientWidth || this._engine?.canvas?.clientWidth || 1);
        const height = Math.max(1, wrap?.clientHeight || this._engine?.canvas?.clientHeight || 1);
        borderLayer.setAttribute('width', String(width));
        borderLayer.setAttribute('height', String(height));
        borderLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    _updateHoverLayerOverlays() {
        const info = this._hoverInfo;
        if (!info || !this._hitPosition) {
            this._engine?.setTerrainHoverOverlay?.(null);
            this._hideTileBorder(this._overlayEls.microBorder);
            this._hideTileBorder(this._overlayEls.macroBorder);
            return;
        }

        const planetConfig = this._engine?.planetConfig;
        const overlay = planetConfig ? {
            face: info.face,
            microRect: this._hoverLayerVisibility.micro ? this._getHoveredTextureCellRect(planetConfig, 'micro') : null,
            macroRect: this._hoverLayerVisibility.macro ? this._getHoveredTextureCellRect(planetConfig, 'macro') : null,
        } : null;
        this._engine?.setTerrainHoverOverlay?.(overlay);

        this._hideTileBorder(this._overlayEls.microBorder);
        this._hideTileBorder(this._overlayEls.macroBorder);
    }

    _worldToScreen(worldPos) {
        const engine = this._engine;
        if (!engine?.camera) return null;

        const cam = engine.camera;
        const projectionMatrix = cam.projectionMatrix?.elements ?? null;
        const viewMatrix = cam.matrixWorldInverse?.elements ?? null;
        if (projectionMatrix && viewMatrix) {
            const x = worldPos.x;
            const y = worldPos.y;
            const z = worldPos.z;

            const viewX = viewMatrix[0] * x + viewMatrix[4] * y + viewMatrix[8] * z + viewMatrix[12];
            const viewY = viewMatrix[1] * x + viewMatrix[5] * y + viewMatrix[9] * z + viewMatrix[13];
            const viewZ = viewMatrix[2] * x + viewMatrix[6] * y + viewMatrix[10] * z + viewMatrix[14];
            const viewW = viewMatrix[3] * x + viewMatrix[7] * y + viewMatrix[11] * z + viewMatrix[15];

            const clipX = projectionMatrix[0] * viewX + projectionMatrix[4] * viewY + projectionMatrix[8] * viewZ + projectionMatrix[12] * viewW;
            const clipY = projectionMatrix[1] * viewX + projectionMatrix[5] * viewY + projectionMatrix[9] * viewZ + projectionMatrix[13] * viewW;
            const clipW = projectionMatrix[3] * viewX + projectionMatrix[7] * viewY + projectionMatrix[11] * viewZ + projectionMatrix[15] * viewW;
            if (clipW <= 0) return null;

            const canvas = engine.canvas;
            return {
                x: (clipX / clipW * 0.5 + 0.5) * canvas.clientWidth,
                y: (0.5 - clipY / clipW * 0.5) * canvas.clientHeight,
            };
        }

        const viewProj = cam.viewProjectionMatrix ?? cam._viewProjectionMatrix;
        if (!viewProj) {
            // Fallback: simple perspective projection
            const dx = worldPos.x - cam.position.x;
            const dy = worldPos.y - cam.position.y;
            const dz = worldPos.z - cam.position.z;

            const fwd = engine._cameraForward();
            const right = engine._cameraRight(fwd);
            const up = engine._cross(right, fwd);

            const z = dx * fwd.x + dy * fwd.y + dz * fwd.z;
            if (z <= 0) return null;

            const x = dx * right.x + dy * right.y + dz * right.z;
            const y = dx * up.x + dy * up.y + dz * up.z;

            const fov = cam.fov ?? 75;
            const tanHalf = Math.tan((fov * Math.PI / 180) / 2);
            const canvas = engine.canvas;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const aspect = w / h;

            const ndcX = x / (z * tanHalf * aspect);
            const ndcY = y / (z * tanHalf);

            return {
                x: (ndcX * 0.5 + 0.5) * w,
                y: (0.5 - ndcY * 0.5) * h,
            };
        }

        // Use view-projection matrix if available
        const m = viewProj;
        const x = worldPos.x, y = worldPos.y, z = worldPos.z;
        const clipX = m[0]*x + m[4]*y + m[8]*z  + m[12];
        const clipY = m[1]*x + m[5]*y + m[9]*z  + m[13];
        const clipW = m[3]*x + m[7]*y + m[11]*z + m[15];
        if (clipW <= 0) return null;

        const canvas = engine.canvas;
        return {
            x: (clipX / clipW * 0.5 + 0.5) * canvas.clientWidth,
            y: (0.5 - clipY / clipW * 0.5) * canvas.clientHeight,
        };
    }

    _hideTileBorder(el) {
        if (!el) return;
        el.removeAttribute('points');
        el.classList.remove('visible');
    }

    _hideHoverUI() {
        this._hoverInfo = null;
        this._hoverAnchorScreen = null;
        this._pendingHoverAnchorScreen = null;
        this._hoverTileHeightCache = null;
        this._hoverTileHeightRequestKey = null;
        this._hoverBorderGeometryCache.clear();
        this._hoverBorderGeometryRequests.clear();
        this._hoverHeightTexelCache.clear();
        const hoverEl = this._overlayEls.hoverInfo;
        if (hoverEl) hoverEl.classList.remove('visible');
        this._engine?.setTerrainHoverOverlay?.(null);
        this._hideTileBorder(this._overlayEls.microBorder);
        this._hideTileBorder(this._overlayEls.macroBorder);
        const diagEl = this._overlayEls.diagnostics;
        if (diagEl) diagEl.classList.remove('visible');
    }

    // ── Task 2: Texture editing dialog ────────────────────────────────

    _getTextureDialogLayerState(tileName, tileId, layerKey) {
        const rawLayerState = this._raw?.textures?.overrides?.[tileName]?.[layerKey];
        if (rawLayerState) {
            return cloneTextureDialogLayerState(rawLayerState, layerKey);
        }

        const atlasConfig = this._engine?.planetConfig?.atlasConfig
            ?? this.buildTextureConfig(this._raw?.textures, null);
        const atlasEntry = atlasConfig?.find((candidate) => candidate?.id === tileId);
        return this._deriveTextureDialogLayerStateFromAtlas(atlasEntry, layerKey);
    }

    _deriveTextureDialogLayerStateFromAtlas(atlasEntry, layerKey) {
        const fallback = cloneTextureDialogLayerState({}, layerKey);
        const variant = this._getTextureDialogVariant(atlasEntry, layerKey);
        if (!Array.isArray(variant) || variant.length === 0) {
            return fallback;
        }

        const normalizedLayers = variant.filter((layer) => layer && typeof layer === 'object');
        if (normalizedLayers.length === 0) {
            return fallback;
        }

        const isNeutralColor = (value) => value === '#ffffff' || value === '#000000';
        const baseLayer = normalizedLayers.find((layer) =>
            layer.type === 'fill' && typeof layer.color === 'string'
        ) ?? normalizedLayers.find((layer) =>
            typeof layer.color === 'string' &&
            normalizeTextureDialogColor(layer.color, '') &&
            Number(layer.opacity ?? 1) >= 0.99 &&
            layer.type !== 'grain'
        ) ?? normalizedLayers.find((layer) => typeof layer.color === 'string') ?? null;

        const baseColor = normalizeTextureDialogColor(baseLayer?.color, fallback.baseColor);
        const secondaryLayer = normalizedLayers.find((layer) => {
            if (layer === baseLayer || typeof layer.color !== 'string') return false;
            const color = normalizeTextureDialogColor(layer.color, '');
            return color && color !== baseColor && !isNeutralColor(color);
        }) ?? normalizedLayers.find((layer) =>
            layer !== baseLayer &&
            typeof layer.color === 'string' &&
            normalizeTextureDialogColor(layer.color, '') !== baseColor
        ) ?? null;

        const layers = normalizedLayers
            .filter((layer) => layer !== baseLayer && layer.type !== 'fill')
            .map((layer) => cloneTextureDialogNoiseLayer({
                type: layer.type,
                scale: Number.isFinite(layer.frequency) ? layer.frequency : layer.scale,
                amplitude: Number.isFinite(layer.amplitude) ? layer.amplitude : layer.opacity,
                seedOffset: 0,
            }, layerKey));

        return {
            baseColor,
            secondaryColor: normalizeTextureDialogColor(secondaryLayer?.color, baseColor),
            blendWeight: clampTextureDialogBlend(secondaryLayer?.opacity, fallback.blendWeight),
            layers: layers.length > 0 ? layers : fallback.layers.map((layer) => ({ ...layer })),
        };
    }

    _getTextureDialogVariant(atlasEntry, layerKey) {
        const baseTextures = atlasEntry?.textures?.base;
        if (!baseTextures) return null;

        for (const seasonConfig of Object.values(baseTextures)) {
            const variants = seasonConfig?.[layerKey];
            if (Array.isArray(variants) && Array.isArray(variants[0])) {
                return variants[0];
            }
        }

        return null;
    }

    _readTextureDialogState(layerContainer, baseColorInput, secondaryColorInput, blendControls, layerKey) {
        const cards = layerContainer.querySelectorAll('.layer-card');
        const layers = [];
        for (const card of cards) {
            if (card._getData) {
                layers.push(card._getData());
            }
        }

        return cloneTextureDialogLayerState({
            layers,
            baseColor: baseColorInput.value,
            secondaryColor: secondaryColorInput.value,
            blendWeight: parseFloat(blendControls.slider.value),
        }, layerKey);
    }

    _writeTextureDialogState(layerContainer, baseColorInput, secondaryColorInput, blendControls, state, layerKey, onChange = null) {
        const normalizedState = cloneTextureDialogLayerState(state, layerKey);
        layerContainer.innerHTML = '';
        for (const layer of normalizedState.layers) {
            this._addNoiseLayerCard(layerContainer, layer, onChange);
        }

        baseColorInput.value = normalizedState.baseColor;
        secondaryColorInput.value = normalizedState.secondaryColor;
        blendControls.slider.value = normalizedState.blendWeight;
        blendControls.numInput.value = normalizedState.blendWeight;
    }

    _openTextureDialog(tileId, mouseX, mouseY) {
        this._closeTextureDialog();

        const tileName = this._getTileName(tileId);

        const dialog = document.createElement('div');
        dialog.className = 'texture-dialog';
        dialog.style.left = Math.min(mouseX, window.innerWidth - 400) + 'px';
        dialog.style.top = Math.min(mouseY, window.innerHeight - 500) + 'px';

        // Title bar (draggable)
        const titleBar = document.createElement('div');
        titleBar.className = 'texture-dialog-title';
        titleBar.innerHTML = `<span>${tileName}</span>`;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'texture-dialog-close';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close texture editor';
        closeBtn.addEventListener('click', () => this._closeTextureDialog());
        titleBar.appendChild(closeBtn);
        dialog.appendChild(titleBar);

        // Make draggable
        this._makeDraggable(dialog, titleBar);

        // Body
        const body = document.createElement('div');
        body.className = 'texture-dialog-body';

        // Layer selector dropdown
        const layerRow = document.createElement('div');
        layerRow.className = 'param-row';
        layerRow.style.padding = '6px 8px';
        const layerLabel = document.createElement('label');
        layerLabel.textContent = 'Layer';
        layerLabel.title = 'Select texture layer to edit';
        const layerSelect = document.createElement('select');
        layerSelect.innerHTML = '<option value="micro">Micro</option><option value="macro">Macro</option>';
        layerSelect.title = 'Select texture layer to edit';
        layerRow.appendChild(layerLabel);
        layerRow.appendChild(layerSelect);
        body.appendChild(layerRow);

        const previewHead = document.createElement('div');
        previewHead.className = 'panel-subsection-head';
        previewHead.textContent = 'Preview';
        previewHead.style.padding = '6px 8px';
        body.appendChild(previewHead);

        const previewWrap = document.createElement('div');
        previewWrap.className = 'texture-preview-wrap';
        const previewCanvas = document.createElement('canvas');
        previewCanvas.className = 'texture-preview-canvas';
        previewCanvas.width = 224;
        previewCanvas.height = 128;
        previewCanvas.setAttribute('aria-label', 'Texture preview');
        previewWrap.appendChild(previewCanvas);
        const previewMeta = document.createElement('div');
        previewMeta.className = 'texture-preview-meta';
        previewMeta.textContent = 'Preview updates after a short delay.';
        previewWrap.appendChild(previewMeta);
        body.appendChild(previewWrap);

        const layerStates = {
            micro: this._getTextureDialogLayerState(tileName, tileId, 'micro'),
            macro: this._getTextureDialogLayerState(tileName, tileId, 'macro'),
        };
        let activeLayerKey = this._hoverLayerVisibility.macro && !this._hoverLayerVisibility.micro
            ? 'macro'
            : 'micro';
        layerSelect.value = activeLayerKey;

        // Noise layers section
        const noiseHead = document.createElement('div');
        noiseHead.className = 'panel-subsection-head';
        noiseHead.textContent = 'Noise Layers';
        noiseHead.style.padding = '6px 8px';
        body.appendChild(noiseHead);

        const layerContainer = document.createElement('div');
        layerContainer.id = 'tex-layer-container';
        body.appendChild(layerContainer);

        const addLayerBtn = document.createElement('button');
        addLayerBtn.className = 'studio-btn';
        addLayerBtn.textContent = '+ Add Noise Layer';
        addLayerBtn.title = 'Add a new noise layer to this texture';
        addLayerBtn.style.cssText = 'margin: 4px 8px; width: calc(100% - 16px);';
        addLayerBtn.addEventListener('click', () => {
            this._addNoiseLayerCard(layerContainer, getDefaultTextureDialogNoiseLayer(activeLayerKey), onDialogStateChanged);
            schedulePreview(false);
        });
        body.appendChild(addLayerBtn);

        // Color section
        const colorHead = document.createElement('div');
        colorHead.className = 'panel-subsection-head';
        colorHead.textContent = 'Colors';
        colorHead.style.padding = '6px 8px';
        body.appendChild(colorHead);

        const baseColorRow = document.createElement('div');
        baseColorRow.className = 'color-row';
        baseColorRow.innerHTML = `<label title="Base texture color (RGBA)">Base Color</label>`;
        const baseColorInput = document.createElement('input');
        baseColorInput.type = 'color';
        baseColorInput.title = 'Base texture color';
        baseColorRow.appendChild(baseColorInput);
        body.appendChild(baseColorRow);

        const secColorRow = document.createElement('div');
        secColorRow.className = 'color-row';
        secColorRow.innerHTML = `<label title="Secondary blend color (RGBA)">Secondary</label>`;
        const secColorInput = document.createElement('input');
        secColorInput.type = 'color';
        secColorInput.title = 'Secondary blend color';
        secColorRow.appendChild(secColorInput);
        body.appendChild(secColorRow);

        // Blend weight slider
        const blendControls = this._addDialogSlider(body, 'Blend Weight', 0, 1, 0.01, 0.5,
            'Balance between base and secondary color');

        const readDialogState = (layerKey) => this._readTextureDialogState(
            layerContainer,
            baseColorInput,
            secColorInput,
            blendControls,
            layerKey
        );
        const onDialogStateChanged = () => schedulePreview(false);
        const writeDialogState = (state, layerKey) => this._writeTextureDialogState(
            layerContainer,
            baseColorInput,
            secColorInput,
            blendControls,
            state,
            layerKey,
            onDialogStateChanged
        );
        const persistActiveLayerState = () => {
            layerStates[activeLayerKey] = cloneTextureDialogLayerState(
                readDialogState(activeLayerKey),
                activeLayerKey
            );
        };
        const buildPreviewState = () => {
            persistActiveLayerState();
            return {
                layerKey: activeLayerKey,
                micro: cloneTextureDialogLayerState(layerStates.micro, 'micro'),
                macro: cloneTextureDialogLayerState(layerStates.macro, 'macro'),
            };
        };
        const schedulePreview = (immediate = false) => {
            this._scheduleTextureDialogPreview(previewCanvas, previewMeta, buildPreviewState, immediate);
        };

        writeDialogState(layerStates[activeLayerKey], activeLayerKey);
        layerSelect.addEventListener('change', () => {
            persistActiveLayerState();
            activeLayerKey = layerSelect.value;
            writeDialogState(layerStates[activeLayerKey], activeLayerKey);
            schedulePreview(true);
        });
        body.addEventListener('input', () => schedulePreview(false));
        body.addEventListener('change', () => schedulePreview(false));

        dialog.appendChild(body);

        // Footer with Apply button
        const footer = document.createElement('div');
        footer.className = 'texture-dialog-footer';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'studio-btn';
        applyBtn.textContent = 'Apply';
        applyBtn.title = 'Apply texture changes and regenerate this tile\'s atlas entry';
        applyBtn.addEventListener('click', async () => {
            persistActiveLayerState();
            await this._applyTextureEdit(tileName, activeLayerKey, layerStates[activeLayerKey]);
        });
        footer.appendChild(applyBtn);

        dialog.appendChild(footer);
        document.body.appendChild(dialog);
        this._textureDialog = dialog;
        schedulePreview(true);
    }

    _addNoiseLayerCard(container, layer, onChange = null) {
        const card = document.createElement('div');
        card.className = 'layer-card';

        const head = document.createElement('div');
        head.className = 'layer-card-head';

        const typeSelect = document.createElement('select');
        typeSelect.title = 'Noise generation algorithm';
        typeSelect.innerHTML = '<option value="simplex">Simplex</option><option value="perlin">Perlin</option><option value="voronoi">Voronoi</option><option value="fbm">FBM</option>';
        typeSelect.value = layer.type || 'fbm';
        typeSelect.addEventListener('change', () => onChange?.());
        head.appendChild(typeSelect);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'icon-btn';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove this noise layer';
        removeBtn.addEventListener('click', () => {
            card.remove();
            onChange?.();
        });
        head.appendChild(removeBtn);

        card.appendChild(head);

        this._addDialogSlider(card, 'Scale', 0.01, 10, 0.01, layer.scale ?? 1.0, 'Noise frequency scale');
        this._addDialogSlider(card, 'Amplitude', 0, 2, 0.01, layer.amplitude ?? 1.0, 'Noise strength');
        this._addDialogSlider(card, 'Seed Offset', 0, 999, 1, layer.seedOffset ?? 0, 'Seed offset for variation');

        card._getData = () => ({
            type: typeSelect.value,
            scale: parseFloat(card.querySelector('[data-key="Scale"]')?.value ?? 1),
            amplitude: parseFloat(card.querySelector('[data-key="Amplitude"]')?.value ?? 1),
            seedOffset: parseInt(card.querySelector('[data-key="Seed Offset"]')?.value ?? 0),
        });

        container.appendChild(card);
    }

    _addDialogSlider(container, label, min, max, step, value, tooltip) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = tooltip || '';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider.title = tooltip || '';
        slider.dataset.key = label;

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.className = 'param-value-input';
        numInput.min = min;
        numInput.max = max;
        numInput.step = step;
        numInput.value = value;
        numInput.title = tooltip || '';
        numInput.dataset.key = label;

        slider.addEventListener('input', () => { numInput.value = slider.value; });
        numInput.addEventListener('change', () => { slider.value = numInput.value; });

        row.appendChild(lbl);
        row.appendChild(slider);
        row.appendChild(numInput);
        container.appendChild(row);
        return { slider, numInput };
    }

    async _applyTextureEdit(tileName, layerKey, overrideState) {
        // Store in the WorldDocument textures section
        if (!this._raw.textures) this._raw.textures = { overrides: {} };
        if (!this._raw.textures.overrides) this._raw.textures.overrides = {};

        const override = cloneTextureDialogLayerState(
            overrideState,
            layerKey
        );

        if (!this._raw.textures.overrides[tileName]) this._raw.textures.overrides[tileName] = {};
        this._raw.textures.overrides[tileName][layerKey] = override;

        this._dirty = true;
        this._updateDirtyUI();

        try {
            const textureConfig = this.buildTextureConfig(
                this._raw.textures,
                this._engine?.planetConfig?.atlasConfig ?? null
            );
            if (textureConfig) {
                await this._engine?.refreshTextureConfig?.(textureConfig);
            }
            this.toast(`Texture override applied for ${tileName}`);
        } catch (error) {
            console.error('[WorldAuthoringView] Failed to refresh texture atlas:', error);
            this.toast(`Texture override saved for ${tileName}, but refresh failed`);
        }
    }

    _clearTextureDialogPreviewTimer() {
        if (this._texturePreviewTimer != null) {
            clearTimeout(this._texturePreviewTimer);
            this._texturePreviewTimer = null;
        }
    }

    _scheduleTextureDialogPreview(previewCanvas, statusEl, getPreviewState, immediate = false) {
        if (!previewCanvas || typeof getPreviewState !== 'function') return;

        this._clearTextureDialogPreviewTimer();
        const requestId = ++this._texturePreviewRequestId;
        const delay = immediate ? 0 : 180;
        if (statusEl) {
            statusEl.textContent = immediate
                ? 'Rendering preview...'
                : 'Preview updates after a short delay.';
        }

        this._texturePreviewTimer = window.setTimeout(async () => {
            this._texturePreviewTimer = null;
            if (requestId !== this._texturePreviewRequestId) return;

            const previewState = getPreviewState();
            if (!previewState) return;

            if (statusEl) {
                statusEl.textContent = 'Rendering preview...';
            }

            await new Promise((resolve) => {
                const raf = window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 0));
                raf(() => resolve());
            });

            if (
                requestId !== this._texturePreviewRequestId ||
                !this._textureDialog ||
                !this._textureDialog.contains(previewCanvas)
            ) {
                return;
            }

            const didRender = await this.renderTexturePreview(previewCanvas, previewState);
            if (statusEl) {
                statusEl.textContent = didRender === false
                    ? 'Preview unavailable'
                    : (previewState.layerKey === 'macro' ? 'Macro preview' : 'Micro preview');
            }
        }, delay);
    }

    _closeTextureDialog() {
        this._clearTextureDialogPreviewTimer();
        this._texturePreviewRequestId++;
        if (this._textureDialog) {
            this._textureDialog.remove();
            this._textureDialog = null;
        }
    }

    _makeDraggable(dialog, handle) {
        let startX, startY, startLeft, startTop;

        const onMouseDown = (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = dialog.offsetLeft;
            startTop = dialog.offsetTop;
            e.preventDefault();

            const onMouseMove = (e) => {
                dialog.style.left = (startLeft + e.clientX - startX) + 'px';
                dialog.style.top = (startTop + e.clientY - startY) + 'px';
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        handle.addEventListener('mousedown', onMouseDown);
    }

    // ── Helpers ────────────────────────────────────────────────────────

    /** Ensure a nested object path exists in raw, returning the leaf object. */
    _ensurePath(raw, path) {
        const parts = path.split('.');
        let obj = raw;
        for (const part of parts) {
            if (!obj[part]) obj[part] = {};
            obj = obj[part];
        }
        return obj;
    }
}
