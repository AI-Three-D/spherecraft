
Introduction

I need your help with a task that involves both refactoring and feature development. We will be working with a WebGPU game engine called Spherecraft. It is used for making procedural planet game worlds. The goal is to build a world-authoring tool, Spherecraft Studio, to make the engine data-driven. The current version uses various configuration files to initialize the engine. Tuning of visuals cannot be done in real-time. The user has to edit the configuration and then reboot the app. For a production-grade system, we need better tooling, and Spherecraft Studio will handle it.

The repository is split into parts: core/ (engine), templates/ (visual configs), shared/ (shared code), tools/ (Spherecraft Studio), and wizard_game/ (test game). The goal is to make the core engine general-purpose and reusable. Spherecraft Studio outputs JSON configuration files. These will be the authoritative source of truth for engine setup and will be placed under wizard_game/world/ (which already contains terrain.json, planet.json, postprocessing.json, and engine.json).
Spherecraft Studio already has a working skeleton: it loads wizard_game/world/*.json, renders the terrain, and lets the user navigate using WASD + left-drag to look. The WorldEditorView subclass has stub sections in its left sidebar but no real controls yet.

Macro iteration 1: World View authoring, texture editing, and rendering/world settings

Scope of macro iteration 1:
Implement world-authoring functionality step by step. Changes in this iteration are only to the World View tab (not particles, GLB, performance, or texture tabs). At the end of the session, Spherecraft Studio will be able to produce the following configurations:
- Biome texture configurations (noise layers + colors per biome tile, per level).
- Terrain noise parameters (all fields already in terrain.json).
- Rendering parameters: HDR settings (postprocessing.json), macro texture area coverage (engine.json / macroConfig), ambient occlusion settings (engine.json / terrainShader.ambientScale), self-occlusion settings (engine.json / terrainAO), ambient lighting settings (engine.json / lighting.ambient), and fog settings (engine.json / lighting.fog).
- Top-level world settings: noise seed (terrain.json / seed), and atmospheric scattering (planet.json / atmosphereOptions).
- The JSON configs will be the authoritative source for these settings. Other settings (terrain shader WGSL, streamer archetype definitions, etc.) remain in template JS files.

Tasks (Spherecraft Studio + engine/wizard_game plumbing):
1. Floating layer selector and biome tile hover highlighting
Add a floating overlay panel (an absolutely-positioned <div> over the WebGPU canvas, always visible while in the World View, not inside either sidebar) with two toggle buttons: Micro and Macro. Each button enables or disables its texture layer for overlay visualization purposes only. Toggling does not affect rendering, only the hover border drawn in the next step.
When the user moves the mouse over the rendered terrain:
- Raycast from the camera through the cursor position to find the terrain surface hit point. Reuse the existing terrain raycast as the first stage, then use the quadtree/tile system to identify which biome tile type (a TILE_TYPES integer) the hit point falls into.
- For the micro layer: draw a red 2px CSS border outline around the screen-space bounding rectangle of the tile footprint (or, if a screen-space rect is not practical, draw a 2D overlay quad). Only draw this border if the Micro toggle is enabled.
- For the macro layer: draw a blue 2px border around the macro coverage tile footprint. Only draw if Macro is enabled.
- If a layer's toggle is off, do not draw that layer's border.

2. Biome texture editing dialog
When the user double-clicks on the terrain canvas:
- Perform the same raycast as task 1. to identify the biome tile type at the cursor.
- Open a draggable floating <dialog> element (CSS: position: fixed, drag by title bar). The dialog title shows the biome name (e.g. "GRASS_SHORT_1").
The dialog contains:
- A layer selector dropdown: "Micro", "Macro", "Both". Selecting a layer shows that layer's texture definition for editing.
- A list of noise layers, each with: noise type (dropdown: simplex, perlin, voronoi, fbm), scale, amplitude, and seed offset. The user can add or remove noise layers.
- A color section: base color (RGBA), secondary color (RGBA), blend weight slider.
- An Apply button: regenerates only the texture atlas entry for this specific biome tile and level (do not regenerate the whole atlas). After regeneration, the terrain display updates to show the new texture in real-time.
- The dialog remains open and can be moved while the terrain renders underneath.
Biome texture definitions currently live in JS files under templates/textures/ (e.g. GRASS.js). As part of this task, introduce a wizard_game/world/textures.json file (or a textures/ subfolder with one JSON per biome category) that holds the editable subset of the texture config: noise layers and colors. The JS files in templates/textures/ remain for the full procedural config; the JSON overrides are layered on top. Update WorldConfigLoader to fetch and apply textures.json. The "Download textures.json" button in the right sidebar exports the current in-memory texture config.

3. Top-level world settings (noise seed, atmospheric scattering)
In the WorldEditorView left sidebar, replace the "Climate" stub section with a World Settings section. Add controls for:
- Seed (integer 0–99999): reads/writes terrain.json / seed. Requires world regeneration (red label).
- Atmosphere Height (planet.json / atmosphereHeightRatio, 0.05–0.5, step 0.01): requires regeneration (red label).
- Atmospheric scattering (planet.json / atmosphereOptions.*): five sliders for visualDensity, sunIntensity, mieAnisotropy, scaleHeightRayleighRatio, and scaleHeightMieRatio. All update in real time (no red label). Wire _applyRealtime() in WorldEditorView to push these to the running StudioWorldEngine's atmosphere uniforms.

4. World terrain noise parameters
Replace the "Geology" stub section with a Terrain Noise section. Add sliders for all fields in terrain.json / noiseProfile (baseBias, mountainBias, hillBias, canyonBias, rareBoost, warpStrength, ridgeSharpness, and microGain), plus continents, tectonics, erosion, water, and surface sub-sections. All of these require world regeneration (red label). This mirrors the existing PARAMS array in WorldViewBase, but implement it as part of WorldEditorView's sidebar override so it uses the actual JSON round trip.

5. Rendering settings
Replace the "Rendering" stub section with a Rendering section containing:
- HDR: postprocessing.json / exposure, bloom.threshold, bloom.knee, and bloom.intensity. All real time.
- Macro Coverage: engine.json / macroConfig.biomeScale (0.0001–0.01, step 0.0001) and engine.json / macroConfig.regionScale (0.00005–0.005, step 0.00005). Requires regeneration (red label).
- Ambient Lighting: engine.json / lighting.ambient.intensityMultiplier, minIntensity, and maxIntensity. Real time.
- Fog: engine.json / lighting.fog.densityMultiplier (0–2, step 0.01), maxBaseDensity (0–0.005, step 0.0001), dayDensityScale, and nightDensityScale. Real time.
- AO / Terrain Shading: engine.json / terrainShader.ambientScale (0.5–3.0, step 0.05) and engine.json / terrainShader.aerialFadeStartMeters / aerialFadeEndMeters. Real time.
- For real-time rendering params, wire _applyRealtime() in WorldEditorView to push values to the running StudioWorldEngine. Extend WorldConfigLoader.applyRealtime() if new param paths are needed.

Instructions applying to macro iteration 1:
- Regeneration-required settings must use a red-colored label (the existing CSS class regen on the label element already does this. Follow the same pattern used in WorldViewBase._addWorldSlider()). There must be a Regenerate World button and a Discard Regen Changes button. Both already exist in WorldViewBase. Wire them properly in WorldEditorView so that clicking "Regenerate World" disposes the current StudioWorldEngine, rebuilds engineConfig/gameDataConfig from the current this._raw, and starts a new engine. "Discard Regen Changes" reverts all regen-flagged fields in this._raw to the values at the last successful regeneration (the snapshot is already managed by _regenRaw in WorldViewBase). These are the ones marked as "red label" in these instructions. Other settings will not be reset.
- Other settings not mentioned here will still use the old way (e.g. from configuration files or templates).
- Implement all steps in one go, but do them consecutively. Perform your own testing after each step and only move to the next step once you see no new console errors, and the app starts successfully.
- Define one authoritative WorldDocument in Spherecraft Studio as the in-memory source of truth, with explicit sections { terrain, planet, engine, postprocessing, textures }. All UI edits write into that object first, real-time changes also patch the live engine from it, regen-only changes mark dirty state, Regenerate World rebuilds from it, and each Download *.json button simply serializes its corresponding section from the current WorldDocument while textures.json is generated from the editable override subset only, never by scraping template JS files.
- Plumbing per step: for each task, ensure: (a) the JSON config files (in wizard_game/world/) contain the relevant fields, (b) WorldConfigLoader reads and applies them when building engineConfig/gameDataConfig, (c) the studio UI controls read from and write to this._raw (the live JSON object in memory), and (d) "Download X.json" in the right sidebar exports the updated values.
- We already have terrain raycast functionality for finding the terrain surface hit point from screen-space cursor location. Reuse it as the first stage, then extend it into a general-purpose biome query under core that returns the biome tile type at that hit location. We will find additional use cases for it later. It should be a light-weight compute/readback shader. Throttle the biome type queries in Studio.
- Add tooltips for all buttons and setting captions.

Out-of-scope:
- Do not refactor biome tile IDs, scatter definitions, archetype definitions, or other template-driven systems into JSON as part of this work.
- When adding the new biome query path, keep it generic enough to survive a later move to fully data-driven biome definitions, but continue using the current TILE_TYPES / template-backed definitions for now.

Macro iteration 2: Biome definition rewrite and asset authoring
Scope of macro iteration 2:
Implement the next stage of world-authoring functionality after the first World View iteration is complete. This task introduces a real biome-definition system and refactors high-level asset distribution to consume it.
Changes may be made to the World View and, if needed, to a dedicated Asset Editor tab. Use your best judgement. At the end of the session, Spherecraft Studio will be able to produce the following configurations:
- Biome definition configurations (biome identities, texture references, occurrence rules, and related metadata).
- Asset distribution configurations driven by biome definitions instead of old hard-coded tile/archetype mapping logic.
- Continued support for the texture, terrain, world, and rendering JSON workflows introduced in the first iteration.
- The JSON configs will be the authoritative source for these settings. Other low-level settings that are not yet migrated may remain in template JS files.

Tasks (Spherecraft Studio/engine/wizard_game):
1. Biome definition system rewrite
Introduce a new biome-definition JSON file under wizard_game/world/biomes.json (and in Studio). This file defines the biome registry used by world generation and Studio editing.
Each biome definition must support:
- A stable biome id and display name.
- A reference to a micro texture entry, a macro texture entry, or either one individually if only one exists.
- Optional tags and metadata for later systems.
- A base weight.
- Optional occurrence signal rules for elevation, humidity, temperature, and slope. We will later add other signals like proximity to water.
Each defined signal rule must support:
- A valid band (min/max).
- A transition width for soft edges.
- A linear preference curve inside the band.
- Edge dithering noise controls.
- A per-signal weight.
Each biome definition must also support regional variation:
- A selectable regional noise profile.
- Noise type (simplex, perlin, fbm, or ridged_fbm).
- Noise scale.
- Noise strength.
- Seed offset.

The biome scoring model is:
- Each defined signal rule produces a score in the range 0..1.
- The biome’s environmental suitability score is the weighted average of its defined signal scores, normalized back to 0..1.
- The biome’s final occurrence score is computed from its normalized environmental suitability, base weight, and regional variation factor.
- All candidate biome occurrence scores at a sample point are normalized into a probability distribution.
- The engine uses a deterministic seeded selection from that distribution so biome choice is stable for a given world position and seed.

Refactor the current biome selection path so the old hard-coded tile-id-driven logic is replaced by this new biome-definition system.
Reduce the default biome set down to four biomes only: grass, forest, desert, and ice. Set up the default behavior so desert occurs in dry areas, forest and grass occur in humid areas, and ice occurs in cold and high-elevation areas. The initial biomes.json should reflect this simplified default biome set and produce a reasonable world with those four biome types.

2. Biome editor in the World View
Add a full Biomes section to the WorldEditorView left sidebar. This becomes the main editor for biome definitions. The Biomes section must allow:
- Listing all biome definitions.
- Selecting a biome definition for editing.
- Editing biome id, display name, tags, base weight, and texture references.
- Editing signal rules for elevation, humidity, temperature, and slope.
- Editing per-signal band, transition width, linear curve mode, edge dithering controls, and signal weight.
- Editing regional variation noise type, scale, strength, and seed offset.
- Adding and removing biome definitions.
- Reordering biome definitions if ordering is relevant to the implementation.
- All biome-definition edits must read from and write to the in-memory WorldDocument and participate correctly in regeneration, discard, and export flows.

3. Cursor biome diagnostics
Extend the existing terrain query and hover path so the World View can inspect the selected biome definition under the cursor. When the user hovers over the terrain:
- Reuse the terrain hit query path and the general-purpose biome query path.
- Show the chosen biome id/name in a compact floating diagnostic element.
- Show the sampled elevation, humidity, temperature, and slope values at that point.
- Show enough score/debug information to make the chosen biome understandable.
- This is required so the biome-definition system is practical to author.

4. Asset streaming refactor to consume biome definitions
Introduce a new asset-authoring JSON file under wizard_game/world/assets.json. This file defines high-level asset distribution profiles and links them to biome definitions. At minimum, the asset distribution system must support:
- Asset profile definitions with a stable id and display name.
- References to existing template-backed asset/archetype definitions where needed.
- A way to associate one or more asset profiles with biome definitions.
- Per-profile density / probability / variation controls as appropriate.
- Refactor the engine-side asset streaming path so biome definitions and asset profiles become the high-level source of truth for where assets appear. Do not rewrite all low-level archetype/species/template systems into JSON. Continue referencing them where needed.

5. Asset editor
Add an Asset Editor to Spherecraft Studio. This can either be a dedicated section inside World View or a dedicated top-level tab if that yields a better architecture and UI. Use your best judgement. The asset editor must allow:
- Listing asset profiles from assets.json.
- Editing profile id, display name, biome associations, and profile-level distribution controls.
- Assigning references to existing template-backed asset/archetype definitions.
- Adding and removing asset profiles.
- Exporting the resulting assets.json.
- Make sure the editor is fully integrated and does not break existing Studio tabs or workflows.

Instructions applying to both macro iterations:
- EVERY CHANGE HAS TO FLOW THROUGH FROM THE EDITOR TO THE CORE ENGINE. At the end, core and wizard_game must be able to consume the generated configurations. Note that this also requires very extensive shader rewrites.
- When you are confused, use your best judgement. Implement the whole thing by yourself up to a final deliverable. Do not stop in between to ask for input or approval.
- DO NOT STOP BETWEEN TASKS OR MACRO ITERATIONS. THIS IS A ONE-SHOT TASK!
- Plumbing per step: for each task, ensure: (a) the JSON config files (in wizard_game/world/) contain the relevant fields, (b) WorldConfigLoader or the corresponding runtime loading path reads and applies them when building the runtime world systems, (c) the studio UI controls read from and write to this._raw or the active WorldDocument state, and (d) the appropriate Download *.json UI exports the updated values.
- Regeneration-required settings must use the same red-label pattern and integrate with the existing Regenerate World / Discard Regen Changes workflow.
- Add tooltips for all buttons and setting captions.
- Disregard any markdown instruction files in the repository. They are slightly outdated. These instructions are the source of truth for your task.
- Other settings not mentioned here will still use the old way (e.g. from configuration files or templates).
- Implement all steps in one go, but do them consecutively. Perform your own testing after each step and only move to the next step once you see no new console errors, and the app starts successfully.
- Extend the authoritative WorldDocument in Spherecraft Studio so it includes the new sections { biomes, assets } in addition to the existing ones. All UI edits write into that object first, regeneration rebuilds from it, and each Download *.json button serializes the corresponding section from the current WorldDocument.
- Keep the new biome-definition system practical. Do not turn this task into a fully generic rule graph, node editor, or expression language.
- Preserve backward compatibility as much as practical where possible, but for the default biome setup in this iteration reduce the system to the four default biomes grass, forest, desert, and ice as described above.

Out-of-scope:
- Do not modify unrelated tabs, shaders, or streamer/archetype configs beyond what is necessary to support the biome-definition and asset-authoring workflow.
- Do not build a fully generic procedural rule language or visual node editor for biome logic in this task.
- Do not migrate every low-level asset/archetype/species/template definition into JSON in this task.
- Do not remove the existing texture override system. Extend it so it works with the new biome-definition architecture.
