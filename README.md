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

### High-level components

```mermaid
graph TB
    subgraph Games["Games"]
        WG["WizardGame\nwizard_game/"]
        PG["PlatformGame\nplatform_game/"]
    end

    subgraph Core["Engine Core"]
        GE["GameEngine (base)"]
        FE["Frontend\nrender orchestrator"]
        BE["WebGPUBackend\ndevice / buffers"]
        CAM["Camera"]
        CFG["EngineConfig"]
    end

    subgraph WorldGen["World Generation"]
        QT["QuadtreeGPU\nGPU LOD traversal"]
        TS["TileStreamer\nfeedback loop"]
        TG["WebGPUTerrainGenerator\ncompute shaders"]
        AQ["AsyncGenerationQueue"]
        TC["TileCache\nGPU array textures"]
    end

    subgraph Rendering["Rendering Subsystems"]
        TR["QuadtreeTerrainRenderer"]
        AS["AssetStreamer\nvegetation LOD"]
        PS["ParticleSystem"]
        LM["ClusteredLightManager"]
        SH["GPUCascadedShadowRenderer"]
        ATM["AtmosphereRenderer"]
        CL["CloudRenderer"]
        PP["PostProcessingPipeline"]
    end

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
```

---

### Per-frame render pipeline

```mermaid
sequenceDiagram
    participant GE as GameEngine
    participant QT as QuadtreeGPU (compute)
    participant TS as TileStreamer (CPU)
    participant TR as TerrainRenderer
    participant AS as AssetStreamer (vegetation)
    participant PTCL as ParticleSystem
    participant ATM as Atmosphere / Clouds
    participant PP as PostProcessing

    GE->>QT: traversal compute (camera pos, LOD thresholds)
    QT-->>TS: feedback buffer — tiles needed this frame

    TS->>TS: deduplicate requests (FeedbackDedupeSet)
    TS->>TS: schedule missing tiles (AsyncGenerationQueue)
    Note over TS: heightfield · splat · normals<br/>all generated via compute shaders

    TS->>TR: update GPU residency hash table (dirty slots only)

    GE->>TR: draw terrain — indirect instanced per LOD
    Note over TR: one indirect draw call per geometry LOD

    GE->>AS: draw vegetation
    Note over AS: far billboards → mid imposters<br/>→ near meshes → leaf geometry

    GE->>PTCL: simulate (compute) then render
    GE->>ATM: sky + aerial perspective + cloud layers
    GE->>PP: tonemap → bloom → distortion → blit to swapchain
```

---

### Terrain generation pipeline

```mermaid
flowchart TB
    subgraph cpu1["CPU"]
        A["Tile request\nface · depth · x · y"]
        B["AsyncGenerationQueue\nschedule within frame budget"]
        A --> B
    end

    subgraph gpu["GPU Compute"]
        C["advancedTerrainCompute.wgsl\nHeightfield — FBm · ridges · biome blend · water clamp\nout: r32float height texture"]
        D["Normal computation\nSobel filter on heightfield\nout: rgba8unorm normal texture"]
        E["splatCompute.wgsl\nTexture layer selection — biome influence · tile category\ntransition sharpness · breakup noise\nout: splat indices + weights"]
        F["splatPaletteCompute.wgsl\nPer-chunk palette optimisation\ndominant tile selection · index remapping"]
        G["splatValidityCompute.wgsl\nMark valid splat entries"]
        H{"Pre-bake\ncolors?"}
        I["resolvedTerrainColorCompute.wgsl\nAtlas sampling + AO bake"]
        C --> D --> E --> F --> G --> H
        H -- yes --> I
    end

    subgraph cpu2["CPU"]
        J["Upload to TileCache array layers\nheight · normal · splat"]
        K["Update GPU residency hash table\ndirty slots only"]
        L["Tile marked resident"]
        J --> K --> L
    end

    B --> C
    H -- no --> J
    I --> J
```

---

### Vegetation LOD chain

```mermaid
graph LR
    subgraph FAR["FAR — 2 km+"]
        TTG["TreeTemplateGenerator\nproced. branching"]
        FARB["Billboard quads\nrotated to camera"]
        TTG --> FARB
    end

    subgraph MID["MID — 100 m to 2 km"]
        AOB["TerrainAOBaker\nbaked ambient occlusion"]
        MIDM["MidNearGeometryBuilder\nstylised cone meshes"]
        AOB --> MIDM
    end

    subgraph NEAR_LOD["NEAR — 10 to 100 m"]
        NTB["MidNearTextureBaker\ndetailed bark variants"]
        NEARM["Normal-mapped mesh\nseasonal variation"]
        NTB --> NEARM
    end

    subgraph LEAF["LEAF — 0 to 10 m"]
        LMB["LeafMaskBaker\nsilhouette atlas per species"]
        LBP["leafBudgetPrepass.wgsl\ncount leaves in view"]
        LSC["leafScatterDetailed.wgsl\nplace leaf geometry"]
        LRND["leafRender.wgsl\nbillboard quads + mask"]
        LMB --> LRND
        LBP --> LSC --> LRND
    end

    FARB -->|"closer"| MIDM
    MIDM -->|"closer"| NEARM
    NEARM -->|"closer"| LRND
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