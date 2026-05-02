# spherecraft

A procedural WebGPU planet engine with real-time terrain streaming, physically-based atmosphere, GPU-driven vegetation LOD, and two playable game modes — built entirely from scratch without Three.js or Babylon.js.

> **Requires a WebGPU-capable browser.** Chrome 113+ or Edge 113+ on desktop is recommended.

![Forest terrain screenshot](screenshots/pic1.jpg)

![Atmospheric terrain screenshot](screenshots/pic2.jpg)

---

## Features

**Terrain & World**
- Cube-sphere planet geometry with GPU quadtree LOD — tiles stream in/out based on view distance, driven by a per-frame GPU feedback buffer
- All terrain heightfields, splat maps, and normals generated on the GPU via WGSL compute shaders
- Per-biome texture splatting with palette optimisation and transition blending
- Procedural noise library (FBm, ridges, domain warping) driving terrain features: continents, plains, hills, mountains, canyons

**Rendering**
- Clustered forward lighting — point/spot lights assigned to 3-D view-space clusters in a compute pass, zero overdraw from light sorting
- Cascaded shadow maps (3 cascades, depth-only passes)
- Physically-based atmospheric scattering — precomputed transmittance and multi-scatter LUTs, aerial perspective, twilight transitions
- Volumetric cloud layers (low/mid/high altitude) simulated and rendered via compute passes
- Post-processing pipeline: HDR tonemapping, dual-threshold bloom, heat-haze screen distortion

**Vegetation**
- GPU-driven 4-tier vegetation LOD: **far billboards → mid imposters → near meshes → full leaf geometry**
- Leaf budget prepass limits overdraw; leaf mask atlas baked per species
- Ambient occlusion baked per terrain chunk; seasonal variation support

**Characters & Physics**
- Skinned mesh renderer for rigged GLB characters
- GPU movement resolver compute shader for character physics
- Platform collision system

**Particles**
- GPU particle system: campfire sparks, firefly swarms, weather rain, pollen/dust
- Simulation and rendering in separate compute/render passes
- Emitters can follow world actors

---

## Getting started

```bash
# clone
git clone <repo-url>
cd spherecraft

# serve with no-cache headers (required for ES modules)
python3 server.py
# → http://localhost:8000

# or use any static file server, e.g.:
npx serve .
```

Open `http://localhost:8000` in Chrome 113+ or Edge 113+. The engine boots with the wizard-game world by default. The platform game is at `platform_game/standalone.html`.

```bash
# lint
npm run lint

# lint with auto-fix
npm run lint:fix

# tests (vitest)
npm test
```

---

## Architecture

> Diagrams below use PlantUML. Render them with the [PlantUML VS Code extension](https://marketplace.visualstudio.com/items?itemName=jebbs.plantuml) or paste into [plantuml.com/plantuml](https://www.plantuml.com/plantuml/uml/).

### High-level components

```plantuml
@startuml
skinparam componentStyle rectangle
skinparam backgroundColor #FAFAFA
skinparam component {
  BackgroundColor #E8F4FD
  BorderColor #2980B9
  FontColor #1A252F
}
skinparam package {
  BackgroundColor #EAF7EA
  BorderColor #27AE60
}
skinparam arrow {
  Color #555555
}

package "Games" {
  [WizardGame\n(wizard_game/)] as WG
  [PlatformGame\n(platform_game/)] as PG
}

package "Engine Core" {
  [GameEngine\n(base)] as GE
  [Frontend\n(renderer orchestrator)] as FE
  [WebGPUBackend\n(device / buffers)] as BE
  [Camera] as CAM
  [EngineConfig] as CFG
}

package "World Generation" {
  [WebGPUTerrainGenerator\n(compute shaders)] as TG
  [AsyncGenerationQueue] as AQ
  [TileStreamer\n(feedback loop)] as TS
  [QuadtreeGPU\n(GPU LOD traversal)] as QT
  [TileCache\n(GPU array textures)] as TC
}

package "Rendering Subsystems" {
  [QuadtreeTerrainRenderer] as TR
  [AssetStreamer\n(vegetation LOD)] as AS
  [ParticleSystem] as PS
  [ClusteredLightManager] as LM
  [GPUCascadedShadowRenderer] as SH
  [AtmosphereRenderer] as ATM
  [CloudRenderer] as CL
  [PostProcessingPipeline] as PP
}

WG --> GE
PG --> GE
GE --> FE
GE --> CFG
FE --> BE
FE --> CAM
FE --> TR
FE --> AS
FE --> PS
FE --> LM
FE --> SH
FE --> ATM
FE --> CL
FE --> PP
FE --> QT
QT --> TS
TS --> TG
TG --> AQ
AQ --> TC
TC --> TR

@enduml
```

---

### Per-frame render pipeline

```plantuml
@startuml
skinparam sequenceArrowThickness 1.5
skinparam sequenceBoxBackgroundColor #EBF5FB
skinparam sequenceLifeLineBorderColor #2980B9
skinparam backgroundColor #FAFAFA
skinparam noteBorderColor #F39C12
skinparam noteBackgroundColor #FEF9E7

participant "GameEngine" as GE
participant "QuadtreeGPU\n(compute)" as QT
participant "TileStreamer\n(CPU)" as TS
participant "TerrainRenderer" as TR
participant "AssetStreamer\n(vegetation)" as AS
participant "ParticleSystem" as PAR
participant "Atmosphere /\nClouds" as ATM
participant "PostProcessing" as PP

GE -> QT : submit traversal compute\n(camera pos, LOD thresholds)
QT --> TS : feedback buffer\n(tiles needed this frame)

TS -> TS : deduplicate tile requests\n(FeedbackDedupeSet)
TS -> TS : schedule missing tiles\n(AsyncGenerationQueue)
note right of TS : terrain heightfield, splat,\nnormals — all compute shaders

TS -> TR : update GPU residency\nhash table (dirty slots only)

GE -> TR : draw terrain\n(indirect instanced per LOD)
note right of TR : one draw call per geometry LOD\ninstance data from tile manager

GE -> AS : draw vegetation
note right of AS : far billboards → mid imposters\n→ near meshes → leaf geometry\n(4 LOD tiers, all GPU-driven)

GE -> PAR : simulate (compute)\nthen render
GE -> ATM : sky + aerial perspective\n+ cloud layers
GE -> PP : tonemap → bloom → distortion\n→ blit to swapchain

@enduml
```

---

### Terrain generation pipeline

```plantuml
@startuml
skinparam activityBackgroundColor #EBF5FB
skinparam activityBorderColor #2980B9
skinparam backgroundColor #FAFAFA
skinparam arrowColor #555555
skinparam noteBackgroundColor #FEF9E7
skinparam noteBorderColor #F39C12

|CPU|
start
:Tile request arrives\n(face, depth, x, y);
:AsyncGenerationQueue\nschedules within frame budget;

|GPU Compute|
:advancedTerrainCompute.wgsl\n**Heightfield generation**\n──────────────────────\nFBm noise + ridge features\nbiome elevation blending\nwater-level clamp;
note right: output: r32float height texture

:Normal computation\n──────────────────────\nSobel filter on heightfield;
note right: output: rgba8unorm normal texture

:splatCompute.wgsl\n**Texture layer selection**\n──────────────────────\nbiome influence scoring\ntile category per pixel\ntransition sharpness + breakup noise;
note right: output: splat indices + weights

:splatPaletteCompute.wgsl\n**Per-chunk palette optimisation**\n──────────────────────\ndominant tile selection\npalette index remapping;

:splatValidityCompute.wgsl\nMark valid splat entries;

fork
  :resolvedTerrainColorCompute.wgsl\n(optional pre-baked color)\nAtlas sampling + AO bake;
fork again
  :Upload directly to\nTileCache array layers\n(height / normal / splat);
end fork

|CPU|
:Update GPU residency hash table\n(dirty slots only);
:TileStreamer marks tile as resident;
stop

@enduml
```

---

### Vegetation LOD chain

```plantuml
@startuml
skinparam componentStyle rectangle
skinparam backgroundColor #FAFAFA
skinparam component {
  BackgroundColor #EAF7EA
  BorderColor #27AE60
}
skinparam package {
  BorderColor #888888
  BackgroundColor #F8F8F8
}
skinparam arrow {
  Color #555555
}
skinparam note {
  BackgroundColor #FEF9E7
  BorderColor #F39C12
}

package "AssetStreamer  (GPU-driven, all 4 tiers)" {

  package "FAR  (> ~2 km)" {
    [TreeTemplateGenerator\nproced. branching] as TTG
    [Billboard quads\n(rotated to camera)] as FAR
    TTG --> FAR
  }

  package "MID  (~100 m – 2 km)" {
    [MidNearGeometryBuilder\nstylised cone meshes] as MID
    [TerrainAOBaker\nbaked ambient occlusion] as AO
    AO --> MID
  }

  package "NEAR  (~10 m – 100 m)" {
    [MidNearTextureBaker\ndetailed bark / variants] as NT
    [Skinned mesh\nnormal-mapped] as NEAR
    NT --> NEAR
  }

  package "LEAF  (< ~10 m)" {
    [LeafMaskBaker\nsilhouette atlas per species] as LMB
    [leafBudgetPrepass.wgsl\ncount leaves in view] as LBP
    [leafScatterDetailed.wgsl\nplace leaf geometry] as LSC
    [leafRender.wgsl\nbillboard quads + mask] as LRND
    LMB --> LRND
    LBP --> LSC
    LSC --> LRND
  }
}

note bottom of FAR  : TreeSourceCache\nper-species templates
note bottom of MID  : PlacementFamily\nbiome eligibility rules
note bottom of NEAR : seasonal variation\nLeafAnchorEmitter source
note bottom of LRND : wind animation\nleaf pollen particles

@enduml
```

---

## Project structure

```
spherecraft/
├── core/
│   ├── Camera.js
│   ├── EngineConfig.js
│   ├── actors/              # GPU movement resolver, collision
│   ├── atmosphere/          # Transmittance + multi-scatter LUTs
│   ├── lighting/            # Clustered light manager, uniform manager
│   ├── mesh/                # Chunk load queue, geometry builders
│   ├── planet/              # Cube-sphere maths, quadtree traversal
│   ├── renderer/
│   │   ├── atmosphere/      # WebGPU sky renderer, aerial perspective
│   │   ├── atmosphere-banks/# Volumetric cloud/aerosol particle banks
│   │   ├── backend/         # WebGPU device, buffer management
│   │   ├── clouds/          # Cloud noise generator + renderer
│   │   ├── environment/     # Weather controller
│   │   ├── frontend/        # Render-loop orchestrator
│   │   ├── mesh/            # Skinned mesh renderer
│   │   ├── particles/       # GPU particle sim + render passes
│   │   ├── postprocessing/  # Bloom, tonemapping, distortion
│   │   ├── resources/       # Geometry, material, texture, render-target
│   │   ├── streamer/        # 4-tier vegetation LOD system
│   │   ├── terrain/         # Quadtree terrain renderer
│   │   └── water/           # Ocean renderer
│   ├── shadows/             # Cascaded shadow map renderer
│   ├── texture/             # Mipmap gen, texture manager, tile limits
│   └── world/
│       ├── quadtree/        # GPU quadtree traversal, tile cache, streamer
│       ├── shaders/webgpu/  # Terrain compute shaders (WGSL)
│       └── webgpuTerrainGenerator.js
├── templates/
│   ├── configs/             # Planet, atmosphere, tile, particle configs
│   ├── features/            # Terrain feature builders (hills, mountains …)
│   └── streamer/            # Asset archetypes, placement families
├── shared/                  # Logger, math utilities
├── wizard_game/             # RPG-style exploration game
├── platform_game/           # Platformer using cloud platforms
├── assets/                  # GLB character models
├── screenshots/
├── tools/                   # Debug panels, test suites
├── server.py                # Dev server (no-cache headers)
├── eslint.config.mjs
└── vitest.config.mjs
```

---

## Tech stack

| Layer | Technology |
|---|---|
| GPU API | WebGPU (no abstraction layer) |
| Shaders | WGSL (compute, vertex, fragment) |
| Language | JavaScript ES2022 modules |
| Linting | ESLint 9 (flat config) |
| Testing | Vitest 3 |
| CI | GitHub Actions — CodeQL, static analysis, LLM PR review |
| Runtime deps | **none** — no Three.js, Babylon.js, or any 3-D framework |

---

## Browser compatibility

WebGPU is required. As of 2025, the following browsers support it on desktop:

- **Chrome / Chromium 113+**
- **Edge 113+**
- **Safari 18+** (macOS Sequoia / iOS 18, behind a flag on some versions)

Firefox does not yet support WebGPU by default.

---

## License

[MIT](LICENSE)
