/**
 * WorldEditorView — wizard_game's implementation of the world editor view.
 *
 * This is intentionally lean: it only wires up the game-specific engine
 * factory and config loader. All UI and param logic lives in WorldViewBase.
 */

import { WorldViewBase }    from '../tools/studio/views/WorldViewBase.js';
import { StudioWorldEngine } from '../tools/studio/StudioWorldEngine.js';
import { WorldConfigLoader } from './WorldConfigLoader.js';
import { getCloudLayers }   from '../templates/clouds/cloudTypeDefinitions.js';

// ── Terrain shader bundle ─────────────────────────────────────────────────────
import { createTerrainCommon }              from '../templates/terrain-shaders/terrainCommon.wgsl.js';
import { createSurfaceCommon }              from '../templates/terrain-shaders/surfaceCommon.wgsl.js';
import { createTerrainFeatureContinents }   from '../templates/terrain-shaders/features/featureContinents.wgsl.js';
import { createTerrainFeaturePlains }       from '../templates/terrain-shaders/features/featurePlains.wgsl.js';
import { createTerrainFeatureHills }        from '../templates/terrain-shaders/features/featureHills.wgsl.js';
import { createTerrainFeatureMountains }    from '../templates/terrain-shaders/features/featureMountains.wgsl.js';
import { createTerrainFeatureCanyons }      from '../templates/terrain-shaders/features/featureCanyons.wgsl.js';
import { createTerrainFeatureLoneHills }    from '../templates/terrain-shaders/features/featureLoneHills.wgsl.js';
import { createTerrainFeatureMicro }        from '../templates/terrain-shaders/features/featureMicro.wgsl.js';
import { createTerrainFeatureMesoDetail }   from '../templates/terrain-shaders/features/featureMesoDetail.wgsl.js';
import { createTerrainFeatureHighlands }    from '../templates/terrain-shaders/features/featureHighlands.wgsl.js';
import { createEarthlikeConstants, createEarthlikeBase } from '../templates/terrain-shaders/base/earthLikeBase.wgsl.js';
import { TILE_TYPES, TILE_CATEGORIES, NUM_TILE_CATEGORIES, buildTileCategoryLookupWGSL } from '../templates/configs/tileTypes.js';

// ── Streamer theme (needed by Frontend) ──────────────────────────────────────
import { validateTierRanges, TREE_TIER_RANGES, MID_TIER_CONFIG, SPECIES_CANOPY_PROFILES } from '../templates/streamer/treeTierConfig.js';
import { TEXTURE_LAYER_MAPPING, ARCHETYPE_DEFINITIONS } from '../templates/streamer/archetype/archetypeDefinitions.js';
import { DEFAULT_ASSET_DEFINITIONS } from '../templates/streamer/AssetDefinitions.js';
import { getSpeciesRegistry }         from '../templates/streamer/species/SpeciesRegistry.js';
import { PlacementFamily }            from '../templates/streamer/archetype/PlacementFamily.js';
import { AssetVariant }               from '../templates/streamer/archetype/AssetVariant.js';
import { RockGeometryBuilder }        from '../templates/streamer/archetype/geometry/RockGeometryBuilder.js';
import { FernGeometryBuilder }        from '../templates/streamer/archetype/geometry/FernGeometryBuilder.js';
import { SansevieriaGeometryBuilder } from '../templates/streamer/archetype/geometry/SansevieriaGeometryBuilder.js';
import { MushroomGeometryBuilder }    from '../templates/streamer/archetype/geometry/MushroomGeometryBuilder.js';
import { DeadwoodGeometryBuilder }    from '../templates/streamer/archetype/geometry/DeadwoodGeometryBuilder.js';
import { BirchBranchGenerator }       from '../templates/streamer/branch/species/BirchBranchGenerator.js';
import {
    ASSET_SELF_OCCLUSION, ASSET_DEF_FLOATS,
    ENABLE_SCATTER_DENSITY_GROUPS, ENABLE_SCATTER_ELIGIBILITY_GATE,
    LODS_PER_CATEGORY, QUALITY_PRESETS, SCATTER_DENSITY_GROUPS, SCATTER_POLICY_GROUPS,
    CAT_TREES, TREE_VISIBILITY, TREE_FADE_START_RATIO, TREE_FADE_END_RATIO,
    TREE_BILLBOARD_LOD_START, TREE_BILLBOARD_LOD_END, TREE_DENSITY_SCALE,
    TREE_CELL_SIZE, TREE_MAX_PER_CELL, TREE_CLUSTER_PROBABILITY, TREE_JITTER_SCALE,
    TERRAIN_AO_CONFIG, GROUND_FIELD_BAKE_CONFIG, GROUND_PROP_BAKE_CONFIG, TREE_SOURCE_BAKE_CONFIG,
} from '../templates/streamer/streamerConfig.js';
import { NightSkyGameConfig, getNightSkyDetailPreset, NightSkyDetailLevel } from '../templates/configs/nightSkyConfig.js';

const TERRAIN_THEME = {
    TILE_TYPES, TILE_CATEGORIES, NUM_TILE_CATEGORIES, buildTileCategoryLookupWGSL,
    terrainShaderBundle: {
        createTerrainCommon, createSurfaceCommon,
        createTerrainFeatureContinents, createTerrainFeaturePlains,
        createTerrainFeatureHills, createTerrainFeatureMountains,
        createTerrainFeatureCanyons, createTerrainFeatureLoneHills,
        createTerrainFeatureMicro, createTerrainFeatureMesoDetail,
        createTerrainFeatureHighlands,
        baseGenerators: { earthLike: { constants: createEarthlikeConstants, base: createEarthlikeBase } },
    },
};

const STREAMER_THEME = {
    validateTierRanges, TREE_TIER_RANGES, MID_TIER_CONFIG, SPECIES_CANOPY_PROFILES,
    TEXTURE_LAYER_MAPPING, ARCHETYPE_DEFINITIONS, DEFAULT_ASSET_DEFINITIONS,
    getSpeciesRegistry, PlacementFamily, AssetVariant,
    RockGeometryBuilder, FernGeometryBuilder, SansevieriaGeometryBuilder,
    MushroomGeometryBuilder, DeadwoodGeometryBuilder, BirchBranchGenerator,
    ASSET_SELF_OCCLUSION, ASSET_DEF_FLOATS,
    ENABLE_SCATTER_DENSITY_GROUPS, ENABLE_SCATTER_ELIGIBILITY_GATE,
    LODS_PER_CATEGORY, QUALITY_PRESETS, SCATTER_DENSITY_GROUPS, SCATTER_POLICY_GROUPS,
    CAT_TREES, TREE_VISIBILITY, TREE_FADE_START_RATIO, TREE_FADE_END_RATIO,
    TREE_BILLBOARD_LOD_START, TREE_BILLBOARD_LOD_END, TREE_DENSITY_SCALE,
    TREE_CELL_SIZE, TREE_MAX_PER_CELL, TREE_CLUSTER_PROBABILITY, TREE_JITTER_SCALE,
    TERRAIN_AO_CONFIG, GROUND_FIELD_BAKE_CONFIG, GROUND_PROP_BAKE_CONFIG, TREE_SOURCE_BAKE_CONFIG,
};

const NIGHT_SKY_THEME = { NightSkyGameConfig, getNightSkyDetailPreset, NightSkyDetailLevel };

// ── WorldEditorView ───────────────────────────────────────────────────────────

export class WorldEditorView extends WorldViewBase {
    get worldDir()     { return './world'; }
    get configLoader() { return new WorldConfigLoader(this.worldDir); }

    _buildLeftSidebar(container, _raw) {
        this._buildPlanningSection(
            container,
            'Climate',
            'TODO: add UI for defining world climate zones. These will be used by the world generation system to determine biomes etc.'
        );
        this._buildPlanningSection(
            container,
            'Geology',
            'TODO: add UI for editing world config terrain params such as height scale, noise settings, and feature frequencies.'
        );
        this._buildPlanningSection(
            container,
            'Biomes',
            'TODO: ...?'
        );
        this._buildPlanningSection(
            container,
            'Rendering',
            'TODO: high-level runtime knobs such as ambient occlusion strength, macro texture span, and postprocessing.'
        );
    }
    _buildRightSidebar(container) {
        this._buildPlanningSection(
            container,
            'TODO',
            'Replace placeholders in the left sidebar with actual UI for editing world config, and add more sections as needed. See the WorldEditorView checklist in the project wiki for details.'
        );

        const navSec = this._addSection(container, 'Navigation', true);
        const navInfo = document.createElement('div');
        navInfo.style.cssText = 'padding:6px 12px; font-size:11px; color:var(--text-dim); line-height:1.7;';
        navInfo.innerHTML = '<b style="color:var(--text)">WASD</b> — fly<br>'
                          + '<b style="color:var(--text)">Q/E</b> — down/up<br>'
                          + '<b style="color:var(--text)">Shift</b> — boost<br>'
                          + '<b style="color:var(--text)">Left-drag</b> — look';
        navSec.appendChild(navInfo);
    }

    _buildPlanningSection(container, title, text) {
        const body = this._addSection(container, title, true);
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:10px 12px; color:var(--text-dim); font-size:11px; line-height:1.6;';
        msg.textContent = text;
        body.appendChild(msg);
        return body;
    }

    async createEngine(canvas, engineConfig, gameDataConfig) {
        const engine = new StudioWorldEngine(canvas, {
            engineConfig,
            gameDataConfig,
            terrainTheme:       TERRAIN_THEME,
            streamerTheme:      STREAMER_THEME,
            nightSkyTheme:      NIGHT_SKY_THEME,
            cloudLayerProvider: getCloudLayers,
        });
        await engine.start();
        return engine;
    }
}
