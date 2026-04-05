# AGENTS: Procedural planet, GPU quadtree, and WebGPU renderer
Short map of the current code so agents can jump to the right place and make safe changes.

## Runtime & Entry
- Launch via `wizard_game/standalone.html` and serve with `python3 server.py`.
- `wizard_game/standalone.html` contains the active inline module bootstrap.
- That bootstrap builds `EngineConfig`/`GameDataConfig`, constructs `GameEngine`, and installs `window.qtDiag` GPU quadtree diagnostics helpers.

## Core Loop (`wizard_game/gameEngine.js`)
- Owns canvas setup, config validation, timekeeping, camera mode, input, UI, and high-level bootstrapping.
- Builds the active planet (`PlanetConfig`), star system (`StarSystem`), altitude zoning (`AltitudeZoneManager`), chunk mapping (`SphericalChunkMapper`), and environment snapshot (`EnvironmentState`).
- Creates shared GPU resources used across systems:
  - `Frontend` renderer
  - `WebGPUTerrainGenerator`
  - terrain/prop/leaf texture atlases
  - spaceship, camera, and gameplay controllers
- Update loop advances gameplay/time/camera/UI.
- Render loop delegates environment, terrain, atmosphere, water, clouds, and asset rendering to `Frontend`.

## Rendering Stack
- `core/renderer/frontend/frontend.js` is the orchestration layer for rendering and render-adjacent simulation.
- Current main path is WebGPU via `core/renderer/backend/webgpuBackend.js`.
- `Frontend` coordinates:
  - lighting uniforms and clustered lighting
  - sky/moon/atmosphere setup
  - weather simulation and environment interpolation
  - GPU quadtree terrain
  - global ocean rendering
  - cloud rendering
  - GLTF/generic mesh rendering
  - streamed vegetation/props via `renderer/streamer`
- `core/renderer/terrain/QuadtreeTerrainRenderer.js` is the terrain draw path. It consumes buffers from the quadtree tile manager and owns terrain materials/geometries.

## World & Terrain Generation (`core/world`)
- Terrain generation is compute-driven in `core/world/webgpuTerrainGenerator.js`.
- GPU terrain shaders live under `core/world/shaders/webgpu`.
- The active terrain streaming path is the GPU quadtree under `core/world/quadtree`:
  - `GPUQuadtreeTerrain.js` is the tile manager/streaming coordinator
  - `QuadtreeGPU.js` handles traversal/selection buffers
  - `tileStreamer.js` manages tile residency, array textures, and generation queue integration
  - `tileCache.js`, `tileAddress.js`, and `tileGenerator.js` support addressing/caching/generation
- Keep the split clear:
  - world/quadtree = tile visibility, residency, streaming, GPU data management
  - renderer/terrain = geometry, materials, and draw calls
- `core/world/features` contains terrain feature placement logic used for biome/feature decisions.

## Planet & Coordinates (`core/planet`)
- `PlanetConfig` in `templates/configs/planetConfig.js` stores radius, atmosphere, terrain scaling, chunk sizing, origins, and cloud band radii.
- `SphericalChunkMapper` maps world positions to cube-face chunk/tile addresses.
- `AltitudeZoneManager` tracks surface vs orbital zones and drives altitude-based behavior.
- Cube-sphere helpers live in `cubeSphereFace.js`, `cubeSphereCoords.js`, and related address utilities.

## Environment, Time & Lighting
- `core/environment/EnvironmentState.js` is now a lightweight mutable snapshot for weather, wind, cloud coverage/layers, fog, and water state.
- `core/renderer/environment/WeatherController.js` drives the live environment update logic and GPU weather simulation.
- `wizard_game/gameTime.js` controls day progression.
- `core/celestial/StarSystem.js` drives sun/moon/body directions and can sync to game-time day length.
- `core/lighting/lightingController.js` computes lighting directions and writes results into `UniformManager`.
- Clustered lighting lives in `core/lighting`.

## Atmosphere, Sky, Clouds & Water
- Atmosphere implementations live in `core/renderer/atmosphere`; `Frontend` wires the active LUTs/renderers into terrain and sky.
- `core/renderer/SkyRenderer.js` and `core/renderer/MoonRenderer.js` handle sky dome and moon rendering.
- `core/renderer/clouds` contains the cloud stack:
  - `cloudRenderer.js` is the shared abstraction/uniform logic
  - `webgpuCloudRenderer.js` is the main active volumetric path
  - `cloudNoiseGenerator.js` builds cloud noise resources
  - `cloudTypeDefinitions.js` and `cloudLayerDefinition.js` define weather-driven cloud layering
- Water is handled by `core/renderer/water/globalOceanRenderer.js` on the GPU quadtree path.

## Assets, Meshes & Streaming
- GLTF loading lives under `shared/gltf`.
- Generic mesh rendering is handled by `core/renderer/genericMeshRenderer.js` and `core/renderer/mesh`.
- Terrain mesh generation helpers are under `core/mesh/terrain`.
- The vegetation/prop system lives in `core/renderer/streamer`:
  - `AssetStreamer` is the main orchestrator
  - it handles baked/scattered asset placement, LOD, geometry atlases, and mid/near rendering paths
- Texture atlas builders/managers live in `core/texture`.

## Gameplay & UI
- `wizard_game/GameInputManager.js` handles keys/mouse input.
- `wizard_game/game` contains spaceship, altitude control, and gameplay-side controllers.
- `wizard_game/ui/GameUI.js` owns HUD/debug panels, including terrain debug mode controls and mid/near asset debug UI.

## Config Knobs (`templates/configs`)
- `wizard_game/runtimeConfigs.js` is the main assembly point for `EngineConfig` and `GameDataConfig`.
- Prefer adding/changing knobs in config classes instead of hardcoding values in runtime systems.
- Important config domains include:
  - rendering and lighting
  - GPU quadtree limits/budgets
  - terrain generation and splat settings
  - camera/manual camera
  - planet presets and atmosphere settings
  - texture/tile/transition settings

## Diagnostics & Debugging
- `window.qtDiag` in the browser console exposes GPU quadtree inspection helpers from the inline module in `wizard_game/standalone.html`.
- Terrain debug mode is split between:
  - generator debug modes in `WebGPUTerrainGenerator`
  - fragment debug modes in the terrain renderer/material path
- `GameUI` exposes debug controls for terrain modes, surface tuning, teleporting, and mid/near asset debugging.

## General Instructions For Agents
- Keep changes config-driven: prefer editing `wizard_game/runtimeConfigs.js`, `EngineConfig`, `GameDataConfig`, and planet config builders over sprinkling constants.
- Run locally with `python3 server.py` and open `wizard_game/standalone.html`; browser console logging is a primary debug channel.
- The supported main path is WebGPU-first. There are still legacy `webgl2` files in the tree, but do not assume they are the active architecture unless the code path clearly uses them.
- Preserve the world/render split:
  - world modules decide data, generation, residency, and selection
  - renderer modules decide materials, passes, and draw calls
- Do NOT use the question mark operator for conditional statements in WebGPU shaders. It is incorrect syntax.
- Be careful with WGSL uniform control flow and bind group layout assumptions; these are common failure points.
- Do not revert unrelated user changes in this repo.
