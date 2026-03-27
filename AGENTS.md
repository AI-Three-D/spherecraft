# AGENTS: Planetary Cloud Sandbox
NOTE: WEBGL2 IS NOT SUPPORTED ANYMORE (REGARDLESS OF WHAT THE DOCUMENT MIGHT STATE BELOW)
Short map of the code so agents can jump to the right place and make safe changes.

## Runtime & Entry
- Launch via `standalone.html` (served with `python server.py` to avoid cache). It imports `js/main.js`.
- `js/main.js` builds configs (`createEngineConfig`, `createGameDataConfig`) and instantiates `GameEngine`, then runs the frame loop (`update` → `render`).

## Core Loop (`js/gameEngine.js`)
- Owns canvas, configs, camera mode, and UI.
- Builds planet/star setup (`PlanetConfig`, `StarSystem`), timekeeping (`GameTime`), and environment (`EnvironmentState`).
- Chooses renderer backend (`Frontend`) and world generator (`WebGPUWorldGenerator` if `preferWebGPU`, else `WebGL2WorldGenerator`).
- Creates `ChunkManager` for streaming terrain, `TextureAtlasManager`/`TextureCache` for virtual textures, `AltitudeZoneManager` for orbital blend, and gameplay objects (`Spaceship`, `AltitudeController`, `Camera`, `GameInputManager`).
- Per frame: update time/star system → update camera/ship → `ChunkManager.update` (select chunks) → `environmentState.update` → `renderer.render`.

## Rendering Stack (`js/renderer/frontend/frontend.js`)
- Front door to GPU work. Wraps:
  - Backend: `webgpuBackend.js` or `webgl2Backend.js`.
  - Scene utilities: `UniformManager`, `LightingController`, `LODManager`, `ChunkCullingManager`, clustered lights/shadows.
  - Streaming: `MasterChunkLoader` (delegates to `TerrainMeshManager`, `WaterMeshManager`) fed by `ChunkManager` output.
  - Visual layers: sky (`SkyRenderer`), star disk (`starRenderer.js`), atmospheric LUTs, orbital sphere (`orbitalSphereRenderer.js`), terrain, water, generic meshes (spaceship), and volumetric clouds (WebGPU/WebGL2 variants).
- Render order: sky/star → orbital sphere (for high altitude) → terrain/props → clouds → optional debug passes. WebGPU path also runs LOD compute/instancing.

## Chunk Streaming (`js/ChunkManager.js`)
- Converts camera position to cube-sphere chunk selection using `SphericalChunkMapper`.
- Two selection modes: simple expanding square (`useSimpleSelection`) or grid/LOD-aware. Handles super-chunks, unload sweeps, and generation queues.
- Requests chunk data from the active world generator, tracks loaded/pending, and pushes deltas to `MasterChunkLoader`.
- Key configs come from `ChunkManagerConfig` (built in `config/runtimeConfigs.js`).

## World & Terrain Generation (`js/world`)
- `BaseWorldGenerator` plus API-specific `webgpuWorldGenerator.js`/`webgl2WorldGenerator.js`.
- Uses `AsyncGenerationQueue` for budgeted generation; creates `ChunkData` with atlas references instead of raw height arrays when `useAtlasMode` is true.
- Terrain produced by `webgpuTerrainGenerator.js`/`webgl2TerrainGenerator.js`; features (trees, etc.) under `world/features/`.
- LOD/virtual texturing: `lodTextureAtlasKey.js` + `textureCache` coordinate pooled atlas textures; `generateLODAtlasTextures` is queued on demand.
- Orbital data (tile/height) generation lives in `WebGPUWorldGenerator.generateOrbitalDataTextures`, cached for orbital rendering.

## Planet & Coordinates (`js/planet`)
- `PlanetConfig` (built from `config/planetConfig.js`) stores radius, atmosphere, chunksPerFace, origins.
- `SphericalChunkMapper` converts world positions to cube-face chunk keys; `AltitudeZoneManager` blends between surface/orbital visuals.
- Cube-sphere helpers in `cubeSphereFace.js`, `cubeSphereCoords.js`.

## Environment & Lighting
- `EnvironmentState` (`js/environment/EnvironmentState.js`) controls wind/weather, smoothly interpolates coverage, and produces cloud layers/types (see `renderer/clouds/cloudTypeDefinitions.js`).
- `LightingController` computes sun/moon directions from `StarSystem`; results copied into `UniformManager` each frame.
- `GameTime` sets day length/start time; star system auto-scales to match day duration.

## Clouds (`js/renderer/clouds`)
- Abstraction `CloudRenderer` computes shared uniforms and dispatches noise generation.
- Backends: `webgpuCloudRenderer.js` (history-aware, 3D noise textures) and `webgl2CloudRenderer.js` (fallback).
- Noise/data via `cloudNoiseGenerator.js`; layer/type parameters in `cloudTypeDefinitions.js`; per-planet bands from `planetConfig` radii (cumulus/cirrus).

## Gameplay & Input
- `GameInputManager` reads keys/mouse; `Camera` supports follow/manual toggle; `Spaceship` + `AltitudeController` run flight logic; `SpaceshipModel` is rendered through `GenericMeshRenderer`.
- UI overlays in `js/ui/GameUI.js`; shows FPS, mode, altitude bands, crash screen.

## Config Knobs (`js/config`)
- `runtimeConfigs.js` builds `EngineConfig` (render/LOD/chunk/renderer/UI) and `GameDataConfig` (planet list, time, spawn).
- `lodAtlasConfig.js`, `atlasConfig.js`, `grassConfig.js`, `TileConfig.js` define terrain/texture pools.
- `ChunkManagerConfig.js` mirrors `engineConfig.chunkManager` fields; `Logger.js` controls log level.
- Tweak configs first; avoid hardcoding in systems.

## Common Change Map
- Cloud visuals/coverage: adjust `renderer/clouds/cloudTypeDefinitions.js`, `cloudNoiseGenerator.js`, and per-planet radii in `planetConfig`.
- Chunk streaming/LOD radius: tune `config/runtimeConfigs.js` → `engineConfig.chunkManager` and `lod` sections; deeper logic in `js/ChunkManager.js`.
- Terrain look/perf: `world/webgpuTerrainGenerator.js`/`webgl2TerrainGenerator.js` for generation; texture pooling in `texture/TextureManager.js` and `textureCache.js`; mesh instancing in `renderer/frontend/frontend.js` and `mesh/terrain`.
- Orbital view: `renderer/orbitalSphereRenderer.js` plus orbital texture generation hooks in `WebGPUWorldGenerator`.
- Controls & camera: `Camera.js`, `GameInputManager.js`, and `game/altitudeController.js`.
- UI text/metrics: `js/ui/GameUI.js`.

## General Instructions for Agents
- Keep config-driven: prefer editing `config/runtimeConfigs.js`/`EngineConfig`/`GameDataConfig` over sprinkling constants.
- Streaming safety: when touching chunk/atlas code, ensure keys stay consistent (`chunkKey`, `LODTextureAtlasKey`) and update cache eviction if you add new texture types.
- Planet math: positions are world meters; ground plane uses X/Z with Y up, but cube-sphere mapping expects vectors from `planetConfig.origin`.
- Rendering order matters: clouds rely on depth after terrain; orbital sphere should fade in via `AltitudeZoneManager`.
- Run locally with `python server.py` then open `standalone.html`; browser console logging is primary debug channel.
- Do NOT use the question mark operator for conditional statements in WebGPU shaders. It is incorrect syntax.
- Do NOT use let when you need to reassign later to a veriable i
