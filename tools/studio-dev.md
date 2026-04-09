# Spherecraft Studio — Developer Guide

This document is the authoritative reference for building out Spherecraft Studio.
It is written for an AI agent or human developer coming in cold with no prior context.
Read it before touching any file under `tools/studio/`.

---

## 1. What is Spherecraft Studio?

Spherecraft Studio is an in-browser editor for Spherecraft — a WebGPU-based procedural world engine. The engine is **not Three.js**: it is a custom WebGPU renderer using WGSL shaders, running in the browser via the WebGPU API. The studio lives at
`tools/studio/studio.html` and is separate from the game entry point
(`wizard_game/standalone.html`).

**Target user:** an indie developer iterating on a procedural web game. The goal is fast
iteration — change a parameter, see the result in under a second.

---

## 2. File Map

```
tools/
├── studio/
│   ├── studio.html              ← standalone entry (no game engine, stub world view)
│   ├── studio.css               ← all shared CSS (linked from both studio.html + game studio.html)
│   ├── studio-main.js           ← auto-start with no overrides (used by studio.html)
│   ├── Studio.js                ← app shell: tab routing, view lifecycle, toast, FPS
│   │                               export startStudio(options) and class Studio
│   ├── StudioView.js            ← base class all views inherit from
│   ├── StudioWorldEngine.js     ← lightweight world renderer (terrain + WASD cam, no game logic)
│   │                               accepts engineConfig + gameDataConfig from caller
│   └── views/
│       ├── WorldView.js         ← default (stub): extends WorldViewBase, no engine attached
│       ├── WorldViewBase.js     ← FULL world editor: param sliders, dirty tracking, regen button
│       ├── ParticleView.js      ← particle emitter asset editor
│       ├── GlbAssetView.js      ← GLB/GLTF asset viewer
│       ├── TextureView.js       ← procedural texture generator
│       ├── ProceduralMeshView.js ← procedural geometry authoring
│       └── ProfilerView.js      ← GPU/CPU frame profiler

templates/
└── world/                   ← DEFAULT world config templates (copy to a game's world/ folder)
    ├── terrain.json         ← terrain generation params (all require regen)
    ├── planet.json          ← planet / atmosphere / time / spawn
    ├── postprocessing.json  ← exposure + bloom (all real-time)
    └── engine.json          ← rendering quality, camera, macro config

wizard_game/                 ← game folder (pattern for all future game folders)
├── studio.html              ← LEAN entry: just links studio.css + imports studio-entry.js
├── studio-entry.js          ← 3-line bootstrap: startStudio({ world: WorldEditorView })
├── WorldEditorView.js       ← game-specific world view: creates StudioWorldEngine with themes
├── WorldConfigLoader.js     ← loads world/*.json, builds engineConfig + gameDataConfig
└── world/                   ← game-specific world config (edit these to tune the world)
    ├── terrain.json
    ├── planet.json
    ├── postprocessing.json
    └── engine.json
```

### How the config pipeline works

```
wizard_game/world/*.json
       │
       ▼
WorldConfigLoader.load()
  │  applies JSON overrides on top of runtimeConfigs.js defaults
  │  returns { engineConfig, gameDataConfig, postprocessing, raw }
       │
       ├──► StudioWorldEngine (studio world view)
       │      terrain rendering + WASD camera, no game logic
       │
       └──► GameEngine (standalone.html, future: loads from JSON too)
              full game with characters, inventory, etc.
```

Both the studio and the game consume the same JSON configs. The studio is responsible for
editing and downloading them; the operator replaces the files in `world/` to make changes
permanent. A future server-side save endpoint (`POST /save-world`) would make this seamless.

Key engine files referenced by studio views:

| Engine file | Purpose |
|-------------|---------|
| `core/renderer/backend/webgpuBackend.js` | WebGPU device/queue abstraction |
| `core/renderer/frontend/frontend.js` | Top-level render orchestrator |
| `core/renderer/particles/ParticleSystem.js` | Particle simulation + render |
| `core/renderer/particles/ParticleEmitter.js` | CPU-side emitter descriptor |
| `core/renderer/particles/ParticleBuffers.js` | GPU buffer management; `uploadTypeDefs()` |
| `core/renderer/postprocessing/PostProcessingPipeline.js` | Bloom → distortion → tone-map |
| `core/renderer/postprocessing/ToneMappingPass.js` | Exposure + ACES tone map |
| `core/renderer/postprocessing/BloomPass.js` | Threshold / knee / intensity / blendFactor |
| `templates/configs/particleConfig.js` | Particle type definitions (per-type params) |
| `templates/configs/EngineConfig.js` | Global engine settings |

---

## 3. Architecture: how the studio works

### 3.1 Lifecycle

`Studio.js` owns all views. Each view goes through this lifecycle:

```
instantiate  →  init(context)  →  activate()  ↔  deactivate()  →  destroy()
```

- `init` is called **once** on the first tab visit. Heavy async setup (GPU init, asset
  loads) goes here.
- `activate` / `deactivate` are called on every tab switch. Start/stop the RAF loop here.
- `destroy` is called on page unload. Free GPU resources.

### 3.2 StudioContext

Every view receives a `StudioContext` object in `onInit()`:

```js
{
  canvas,              // HTMLCanvasElement — shared WebGPU canvas
  sidebarLeft,         // HTMLElement — cleared before each init; populate in onInit()
  sidebarRight,        // HTMLElement — cleared before each init
  sidebarLeftTitle,    // HTMLElement — set the text content
  sidebarRightTitle,   // HTMLElement
  bus,                 // EventTarget — cross-view event bus
  toast(msg),          // function — show a brief notification
  updateStats(),       // function — call once per frame to tick the FPS counter
}
```

Views must not hold direct references to other views. Use `context.bus` to send cross-view
events (e.g. `openTextureEditor` from WorldView → TextureView).

### 3.3 Frame loop

`StudioView._startLoop()` runs `requestAnimationFrame` while the view is active.
It calls `onUpdate(dt, t)` each frame. Always call `context.updateStats()` once per frame
(the base class does this automatically).

### 3.4 Sidebar helpers

`StudioView` provides these DOM builder helpers (call from `onInit`):

```js
this._addSection(container, 'Title', startOpen)   → returns body HTMLElement
this._addSlider(body, { label, min, max, step, value, onChange })
this._addButton(body, 'Label', onClick)
this.toast('message')
this.setExtraStatus('<html>')   // updates the status bar extra slot
```

### 3.5 The tab manifest

To add a new tab, add an entry to `TABS` in `Studio.js`:

```js
{ id: 'my-view', label: 'My View', icon: '⬡', View: MyView }
```

Then create `views/MyView.js` extending `StudioView`.

---

## 4. Production roadmap: what needs to be built

This section lists every major feature needed to make the studio useful for an indie
developer shipping a real web game. Tasks are ordered by impact-to-effort ratio.

### PHASE 1 — Core infrastructure (do these first)

#### 1.1 WebGPU backend attachment to canvas
**Affects:** WorldView, ParticleView, GlbAssetView, ProceduralMeshView  
**Status:** TODO in every view  
**What to do:**
- Each view that uses the canvas (`usesCanvas = true`) needs to create a WebGPU context
  on `context.canvas`.
- The simplest approach: instantiate `WebGPUBackend` directly in each view's `onInit`.
  Each view owns its own backend instance; they share the canvas element but only one is
  active at a time (safe because `deactivate()` pauses rendering).
- Alternatively: `StudioContext` could hold a shared backend — but views have different
  render pipelines so separate instances are cleaner.
- Reference: `core/renderer/backend/webgpuBackend.js`

#### 1.2 Orbit camera (shared utility)
**Affects:** ParticleView, GlbAssetView, ProceduralMeshView  
**Status:** TODO  
**What to do:**
- Create `tools/studio/OrbitCamera.js` — a thin camera class that reads
  mouse drag / scroll events on a canvas and outputs a view matrix.
- API: `new OrbitCamera(canvas)` → `.viewMatrix` (Float32Array, column-major)
- Input: left-drag = orbit, right-drag = pan, scroll = zoom.
- Should produce a WebGPU-compatible view matrix (right-handed, Y-up).
- Reference: the game's free-fly camera in `wizard_game/GameInputManager.js` for input
  conventions.

#### 1.3 HDR tone-mapping panel (ToneAdjustPanel)
**Affects:** All views that render to the WebGPU canvas  
**Status:** Planned but not yet created  
**What to do:**
- Create `tools/studio/ToneAdjustPanel.js`.
- Exposes: exposure (0.1–3.0), bloom threshold/knee/intensity/blendFactor,
  contrast, saturation.
- Attaches to a `Frontend` or directly to `ToneMappingPass` and `BloomPass`.
- Setters on `ToneMappingPass` and `BloomPass` already mark `_dirty` — calling them is
  enough; the GPU upload happens automatically on the next render frame.
- Add a floating "HDR" toggle button to the studio top-bar that opens this panel as an
  overlay above any view.
- See `core/renderer/postprocessing/ToneMappingPass.js` and `BloomPass.js` for current
  parameters and their ranges.

#### 1.4 GPU timestamp queries (ProfilerView)
**Affects:** ProfilerView  
**Status:** Fake data only  
**What to do:**
- In `PostProcessingPipeline.js`, add a `GPUQuerySet` (type `'timestamp'`) and
  resolve it to a buffer each frame.
- Expose the resolved timings via `frontend.getFrameStats()`.
- Wire `ProfilerView.onUpdate` to call `getFrameStats()` instead of `_fakeSample()`.
- Note: timestamp queries require the `'timestamp-query'` WebGPU feature, which must
  be requested in `webgpuBackend.js` when creating the device.
- Reference: WebGPU spec § GPUQuerySet

---

### PHASE 2 — World View

#### 2.1 Attach Frontend to WorldView
- Instantiate `Frontend` in `WorldView.onInit`.
- Pass `context.canvas` as the render target.
- Start the game loop in `onActivate`, pause in `onDeactivate`.

#### 2.2 Free-fly camera
- The game already has free-fly camera logic in `GameInputManager.js`.
- Extract or reuse it in `WorldView`.
- Controls: WASD + mouse look (pointer lock), shift = fast.

#### 2.3 Terrain noise parameters → live update
- The left sidebar sliders for "Terrain Noise" and "Biomes" are stubs.
- Wire each slider's `onChange` to the world/terrain generator config.
- Some changes require full world regeneration (noise scale, octaves).
- Some are shader uniforms and can be hot-updated without regeneration (texture tiling).
- Mark expensive params with a "Regenerate" button rather than auto-regenerating on each
  slider tick — add a debounce or explicit apply step.

#### 2.4 Tile inspector pop-up
- On left-click in the viewport, raycast against terrain geometry.
- Identify the clicked tile (chunk + UV).
- Populate `sidebar-right-content` with tile texture weights, biome, height.
- Add an "Open in Texture Editor" button that dispatches:
  ```js
  context.bus.dispatchEvent(new CustomEvent('openTextureEditor', { detail: { tileId } }))
  ```
  Studio.js should listen for this and switch to the texture tab.

---

### PHASE 3 — Particle View

#### 3.1 Live particle preview
- In `ParticleView.onInit`:
  1. Create a `WebGPUBackend`.
  2. Create a `ParticleSystem` (see `core/renderer/particles/ParticleSystem.js`).
  3. Call `particleSystem.addCampfire(new Vector3(0,0,0))` for the default asset.
- In `onUpdate(dt)`, call `particleSystem.tick(dt)` then render.

#### 3.2 Orbit camera for particle view
- Use the shared `OrbitCamera` (see 1.2).
- Default: look at origin from (0, 1, 3) distance.

#### 3.3 Type config sliders
- The right sidebar "Type Config" section currently shows a placeholder.
- Expand it with all per-type parameters from `particleConfig.js`:
  `lifetime.min/max`, `size.start/end`, `velocity.*`, `gravity`, `drag`, `upwardBias`,
  `lateralNoise`, `spawnOffset.*`, `colorStart/Mid/End` (RGBA), `emissive`, `flags`.
- On change, call `particleSystem.buffers.uploadTypeDefs(updatedConfig)` to push to GPU.
  Changes take effect on the next simulation frame.

#### 3.4 Color ramp editor
- For `colorStart`, `colorMid`, `colorEnd`: use `<input type="color">` for RGB and a
  separate range slider for alpha.
- Display a small gradient preview strip.

#### 3.5 Emitter gizmos
- Render a small 3-axis translate gizmo at each emitter's world position.
- On mouse-down over an axis, enter drag mode: move the emitter along that axis.
- Update `emitter.position` and call `particleSystem.setEmitterPosition(id, pos)`.

---

### PHASE 4 — GLB Asset View

#### 4.1 GLTF parser
- Options (in order of preference):
  1. Write a minimal custom GLB parser targeting the engine's buffer layout.
     Parse mesh primitives → upload to `WebGPUBackend` vertex/index buffers.
  2. Import `@loaders.gl/gltf` or similar as an ES module from a CDN.
- The parser should output: `{ meshes: [{vertices, indices, materialIndex}], materials: [...], nodes: [...] }`.

#### 4.2 Scene tree
- After loading, populate `_sceneTreeEl` with a recursive node tree.
- Each node: name, type (mesh/light/camera/empty), child count.
- Clicking a node selects it and populates the right sidebar.

#### 4.3 Material override
- Map GLTF material names → engine material slots.
- Allow assigning a texture from the texture generator to a slot.

#### 4.4 Animation preview
- For files with animation clips, list them in `_animListEl`.
- Provide play/pause/scrub controls.
- Apply bone transforms to the skinned mesh on the GPU.

---

### PHASE 5 — Texture View

#### 5.1 CPU generation path
- Use `OffscreenCanvas` + `Canvas2D` for fast CPU texture generation.
- Implement generators:
  - Perlin noise (use an existing small JS library or port a simple implementation)
  - Simplex noise
  - Voronoi
  - Gradient (linear, radial, angular)
  - Solid color
- Blend layer: normal, multiply, screen, overlay modes.
- Color Adjust layer: brightness/contrast/saturation via matrix ops on pixel data.

#### 5.2 GPU generation path
- For resolutions ≥ 1024: implement a WebGPU compute shader per generator type.
- Compute shader writes to a `GPUTexture` directly; no CPU readback needed for preview.
- Reference: existing WGSL compute shaders in `core/renderer/particles/shaders/`.

#### 5.3 3D preview sphere
- Add a toggle: "2D Preview" / "3D Preview".
- In 3D mode, render a sphere or terrain patch with the generated texture applied.
- Requires a simple textured mesh + PBR pass.

#### 5.4 Cross-view navigation
- TextureView must listen on `context.bus` for `'openTextureEditor'` events.
- When received, load the tile's current texture config into the layer stack.
- Studio.js should detect when this event is fired and auto-switch to the texture tab:
  ```js
  context.bus.addEventListener('openTextureEditor', () => studio._switchTo('texture'));
  ```

---

### PHASE 6 — Procedural Mesh View

#### 6.1 Geometry generators
- Create `core/mesh/procedural/` with one file per type:
  - `RockGenerator.js` — deformed icosphere with noise displacement
  - `TrunkGenerator.js` — swept spine with radial cross-section
  - `TerrainPatchGenerator.js` — subdivided grid with height noise
- Each generator: `generate({ seed, params }) → { positions, normals, uvs, indices }`.

#### 6.2 LOD generation
- Given LOD0 mesh, generate LOD1/2 by decimation (angle-weighted vertex merging).
- LOD3 = flat billboard (impostor) generated by rendering from 8 angles.

#### 6.3 Export
- Engine-native format: a JSON descriptor + a binary ArrayBuffer with packed vertices.
  This avoids runtime GLTF parsing overhead.

---

### PHASE 7 — Profiler View

#### 7.1 Replace fake data with real GPU timestamps
- See Phase 1.4 above.

#### 7.2 CPU timing brackets
- In `Frontend.tick()`, wrap each system call with `performance.now()`:
  ```js
  const t0 = performance.now();
  this.terrain.update(dt);
  cpuTimings.terrain = performance.now() - t0;
  ```
- Expose via `frontend.getFrameStats()`.

#### 7.3 Bottleneck advisor
- Implement heuristics in `_advisorEl`:
  - `total > 33 ms` → "Frame is below 30fps — check the worst pass"
  - `bloom_down > 3 ms` → "Bloom downsample is expensive — try halving resolution"
  - `terrain > 8 ms` → "Terrain pass is slow — reduce quadtree depth or tile size"
- Display as coloured warning cards in the right sidebar.

#### 7.4 Memory accounting
- Maintain a registry in `WebGPUBackend` of all created buffers and textures.
- Estimate GPU memory: `byteLength` for buffers, `width × height × bytes-per-pixel` for textures.
- Expose via `backend.getMemoryStats()`.

---

## 5. Cross-cutting concerns

### 5.1 Undo / redo
- Implement a simple command stack in `Studio.js`.
- Views push `{ undo: fn, redo: fn }` objects via `context.bus`:
  ```js
  context.bus.dispatchEvent(new CustomEvent('pushUndo', { detail: { undo, redo } }))
  ```
- Bind `Ctrl+Z` / `Ctrl+Shift+Z` globally in `Studio.js`.
- Start with particle emitter moves and parameter changes; world changes are harder
  (require regeneration) so defer undo for those.

### 5.2 Persistence
- Studio state (last active tab, per-view param values) should persist across page
  refreshes via `localStorage`.
- Key: `spherecraft-studio-state`.
- Value: `{ activeTab, views: { worldView: {...}, particleView: {...}, ... } }`.
- Each view reads its saved state in `onInit` and writes it in `onDeactivate`.

### 5.3 Keyboard shortcuts
- `1`–`6` → switch to tab 1–6
- `Ctrl+Z` / `Ctrl+Shift+Z` → undo / redo
- `Ctrl+S` → save / export (view-dependent)
- `Ctrl+O` → open / load (view-dependent)
- `F` → focus orbit camera on selected object
- `G` / `R` / `S` → Blender-style grab / rotate / scale gizmo (particle and mesh views)
- `Space` → pause/resume profiler (profiler view)
- `H` → toggle HDR panel

### 5.4 Responsive sidebars
- Sidebars should be resizable (drag the border).
- They can be collapsed to a strip for more viewport space.
- Implement with a simple CSS `resize` or a mouse-drag handler on the border element.

### 5.5 Error handling
- WebGPU device lost: listen for `device.lost`, show a toast "GPU device lost — please reload".
- Shader compile errors: catch in `backend.createShaderModule()` and display the error
  in an overlay rather than crashing silently.
- File parse errors: already handled in import/export methods; toast the error.

---

## 6. Coding conventions

- All views extend `StudioView` and live in `tools/studio/views/`.
- No framework (no React, no Vue). Plain ES modules + DOM manipulation.
- CSS variables are defined in `studio.html` `:root`. Do not use hardcoded colour values;
  always use `var(--token)`.
- File names: `PascalCase.js` for classes, `camelCase.js` for utilities.
- TODOs in stubs use the comment `// TODO:` so they are easy to grep.
- No TypeScript — use JSDoc `@param` / `@returns` for any non-obvious types.
- Keep each view file self-contained. Cross-view communication only via `context.bus`.

---

## 7. Running the studio

The engine has no build step. Serve the project root with any static file server:

```bash
python3 server.py      # existing project server
# or
npx serve .
```

Then open: `http://localhost:<port>/tools/studio/studio.html`

WebGPU requires a modern Chromium-based browser (Chrome 113+, Edge 113+).
Firefox has partial support behind a flag.

---

## 8. What NOT to build (scope guard)

These are explicitly out of scope for the indie/web niche:

- Multiplayer / netcode tooling
- Full PBR material graph editor (hand-tuned JSON is fine)
- Plugin / scripting API for end users
- Localisation tooling
- Mobile / touch input (desktop-first)
- A packaging / build pipeline (the engine has no build step by design)

---

## 9. Priority order for a new agent picking up this work

1. **Read this file** and the engine files listed in §2 before writing any code.
2. **Build `ToneAdjustPanel`** (§PHASE 1.3) — it is the smallest useful feature and
   fixes the over-exposure problem that blocks all visual iteration.
3. **Build `OrbitCamera`** (§PHASE 1.2) — shared utility needed by three views.
4. **Wire WorldView to Frontend** (§PHASE 2.1) — unlocks the core world-editing workflow.
5. **Wire ParticleView live preview** (§PHASE 3.1–3.3) — second highest-value view.
6. **Add GPU timestamps to PostProcessingPipeline** (§PHASE 1.4) — makes profiler useful.
7. Continue with remaining phases in order.
