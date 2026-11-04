# Minimal renderer development harness

## Voxel anthill harness

From the `anthill` directory, run `python3 -m http.server 8026 --bind 127.0.0.1`
and open http://localhost:8026/dev_harness/voxel.html in a WebGPU-capable browser.
Run `npm test` (or `node --test`) in that directory for the CPU tests.

Choose **Camera → 1st person / 3rd person**, or press **V** to enter first person
and switch between the two perspectives. Both render the full edited terrain
with a 70° perspective field of view and follow the miner in all three dimensions.
Use **WASD or arrows** to walk relative to the look direction, **Space** to jump,
and **X or hold the left mouse button** to dig. D is strafe-right in these views.
Click the canvas to capture the mouse, move it to look, and press **Esc** to release
it; dragging also works without pointer lock. I/K and the angle slider adjust
the same pitch used by the camera and digging. Strafing/backing up preserves aim.
The third-person wheel changes the follow distance; a swept padded camera boom
retracts at terrain, including edits, and restores the chosen distance when clear.
First person hides the miner's body and aim guide while keeping the carried torch.
Choose **Side view** to return, **F** for inspection, or **Overview / R** to frame
the region. Respawning retains the selected perspective and all terrain edits.
Follow is automatic in first/third person; its checkbox controls the other views.

`core/voxel/CharacterCamera.js` owns the DOM-free perspective/follow math and boom
collision. `VolumeViewModule` supports both orthographic and perspective cameras
in its compute and reference fragment paths, retaining camera-relative precision.
The optional browser check is `node dev_harness/cameraSmoke.mjs --puppeteer
/absolute/path/to/puppeteer-core.js` while the harness server is running. Add
`--capture-prefix /tmp/anthill-camera` to save first/third-person screenshots.

The harness starts focused on a placeholder miner outside the east hillside entrance.
Walk with Left/Right, jump with Space, and **hold D while walking to dig**. Up/Down
or I/K changes the dig pitch; the slider sets it directly from -90° to +90°.
Positive angles dig uphill, negative angles dig downhill; -90° opens a shaft
underfoot. The cyan guide shows the aim and turns gold during digging.
Walking with D is slower to make tunnel shaping easier. Digging uses a repeated
capsule edit against the same density field that is rendered, at ten edits per second.

Lighting is independent of Spherecraft. A four-minute day moves the sun from east
through overhead noon to west, with warm low-angle sunlight and no direct sun at
night. Use **Time** to scrub the hour and **Day cycle** to pause the clock. Daylight
and local lights trace shadow rays through the full edited density field, so light
enters shafts and mouths only along unobstructed paths. A camera cutaway never
removes an occluder from lighting, and `visibilityDepth` only limits camera rays.
The artificial rock section retains a dim material tint so its layers stay readable.
Real cave walls have a small ambient floor, distance falloff for local lights and
directional diffuse shading; there is no indirect/bounce-light simulation.

The miner carries a visible flickering torch. **Carried torch** toggles it; death
extinguishes it until respawn. The torch follows heading, position and walking bob.
The character receives the same terrain-shadowed lighting and casts a soft capsule
shadow on terrain, derived from its body bounds. The flame's finite width gives an
analytic penumbra with an opaque core, without extra terrain rays or random noise.
A light crossing the coarse body proxy fades out that proxy's occlusion instead
of blacking out the cave. **Place light here** creates a fixed light at the held torch's
position; choose a flickering torch or steady lantern. **Remove last light** removes
the most recently installed light. These are harness tools for trying future
installation gameplay; installed lights survive movement and respawn, but are not
saved across reloads.

`view.lighting` is an `AnthillLighting` instance. Its region-local API supports
`addLight({ kind, position, radius, color, intensity, flicker, enabled })`,
`updateLight(id, changes)`, and `removeLight(id)`. Flicker ranges from 0 (steady)
to 1; torches default to 0.18 and lanterns to 0. Up to 31 installed lights plus
the carried torch fit the shared uniform payload. Disabled and zero-intensity
lights are skipped. No camera-dependent light selection is used, so offscreen
sources can still light visible walls. Shadow tracing uses conservative empty-space
bounds and half-voxel probes, never a camera depth cutoff or a coarser step to meet
its 8192-probe budget. Local-light terrain rays start at the light, allowing empty-space
skips before approaching the receiver. Exhausted rays remain occluded. Lights outside the captured
volume cannot account for terrain beyond that volume.

F switches to the free orthographic inspection view. All four arrows then move
on the ground relative to the camera, including through the mine's depth;
I/K and the slider still control dig pitch. Drag orbits, Shift+drag pans,
and C toggles the cutaway/full hillside. Movement, jumping and digging work in
both views. A followed cutaway stays just in front of the miner, so moving
through depth does not clip the character away. Orbiting alone does not move the cut.

Follow keeps the camera and cut with the miner. Dragging to pan disables it.
T / Focus enables follow and frames the character; Overview / R frames the whole
region and disables follow. P / Respawn returns to a safe surface position at
the entrance and preserves all edits. Large impacts kill the miner, turn the
figure red and stop its actions until respawn. Losing focus releases held inputs.

Rendering drops to 30 FPS after 250 ms without miner or camera activity, matching
Spherecraft's stationary cap. Walking, jumping, digging, turning, dragging and
zooming restore the display's refresh rate immediately. Hidden tabs cancel the
frame loop entirely: no simulation, ray tracing or frame submissions until the
tab is visible again. Returning resets the frame clock, so hidden time cannot
advance physics or camera turns. The original cube harness uses the same tab
suspension and caps at 30 FPS when rotation is paused.

The physics is a harness-only kinematic box with gravity, jumping, step climbing,
walls, ceilings and fatal falls. It checks the interpolated **edited 3D density**,
not just the original heightfield. Collision sweeps advance by less than half a
voxel and bisect contacts; fixed 120 Hz steps keep motion and digging independent
of render rate. The sides and bottom bound the playground; the sky is open.
`MineCharacter.js` exports the tunable defaults (speed, gravity, jump, step height,
impact threshold, dig size/reach/rate). It is deliberately a small prototype, not
a rigid-body or ragdoll simulation.

The fixture captures a seeded 256 m heightfield and queries the same terrain
asynchronously beyond its edges. The full 3D volume uses 0.25 m voxels and stores
edited chunks; six procedural rock layers and two veins supply the appearance.
The initial edits form a hillside tunnel, side gallery, shaft, two chambers and
a closed cave pocket. World positions remain doubles at an origin 131 km out;
render matrices and geometry use local/camera-relative positions.

- Drag to pan; scroll to zoom around the cursor.
- Q/E turns 90 degrees over 350 ms, easing through intermediate angles around
  the inspected world point. Repeated presses extend the destination while retaining
  angular velocity. Height and zoom stay fixed; settled turns are axis aligned.
- F enters a temporary orthographic inspection camera: drag to orbit, Shift+drag
  to pan, wheel to zoom. C toggles the cutaway and complete hillside volume.
  F returns to the saved anthill framing. Inspection controls live in the harness.
  Pointer brush edits are available in settled anthill mode. The miner can dig in
  both views. With Follow off, the cut stays fixed during inspection.
  Inspection caps the render workload at one million pixels (360,000 during a drag
  or wheel zoom), then sharpens 180 ms after movement. Framing and pan distance stay
  fixed across resolution changes. Budgets live in `inspectionResolution.js`.
- W/S slides the cut by 1 m; Shift reduces this to 0.25 m.
- Click to carve; Shift+click fills. Brackets change the brush radius.
- 1/2 zooms to the captured/queried seams; B introduces a deliberate query bias.
- R resets the view and query bias, retaining edits.

The harness uses `VolumeViewModule`: a compute ray search over the same 3D density
field, with optional half-space clipping, followed by a separate rock-shading pass.
The hit texture stores region-local positions and a cut-face flag; the fragment shader
writes the real hit depth. It renders the cut face, tunnel walls, terrain surface
and bounded region sides from arbitrary orthographic angles. `visibilityDepth` limits wall
visibility in anthill mode (24 m by default); inspection searches the whole region.
Rock layers and veins use the same region-space procedural material on every face.
Ground profile queries and ribbons update when the anthill camera settles, avoiding
CPU slice rebuilding or new height queries on every animation frame.

The ray search uses half-voxel steps or half-pixel steps at overview scale, with
up to eight bisection refinements, stopping once the bracket is below 0.05 screen
pixels. A budget of 8192 samples per ray can coarsen the step for very fine voxels. Subpixel features can disappear at overview scale; zoom in
to inspect them.

Conservative density bounds skip empty space at two scales (8 m and 2 m with the
fixture settings). Untouched blocks also use a conservative height-field step,
bounded by the maximum X/Z terrain slopes and stopped before any edited chunk.
This does not assume that CSG density is a distance field. Skips stay on the
original probe lattice. Bounds update only for edits; camera movement reuses them.
The fine bounds add about 6 MB for this fixture; the hit texture uses 16 bytes per
render pixel. Smaller configured voxels fall back to coarser bounds if the fine
bounds would exceed 32 MB or the device storage binding limit.

The density sampler resolves a chunk once for eight-corner interpolation, with
the original cross-chunk path at boundaries. Physical surface gradients and vein
coverage stay analytic. Wall lighting interpolates packed smooth normals from
`SparseVolumeNormalsGPU`; central gradients are computed in a GPU pass after
density edits or when a chunk enters the normal cache. Edit invalidation includes
the gradient halo, including interpolation into untouched chunks. Time of day,
flicker and sub-chunk camera movement do not rebuild resident normals.
Shadow-ray bias follows the physical normal, so smoothing does not
move the ray inside the rock. Untouched terrain uses the heightfield's gradient.
The optional normal cache costs four bytes per lattice normal plus chunk halos
(`(chunkSize + 4)^3` normals per slot), grows geometrically, and defaults to a
64 MiB payload budget within the device's storage binding limit. The bounded cache
prioritizes chunks near the camera or inspection focus and reuses its slots as
that focus moves between chunks. `normalCacheMaxBytes` configures the budget in
`VolumeViewModule`; zero disables the cache. Nonresident chunks use four filtered density
probes at visible hits. Rock shading skips layers whose colours are fully overwritten,
layers below a zero-coverage interface and veins outside their depth range.

`AnthillViewModule` remains available as the original CPU-sampled, antialiased
slice renderer.

`SparseVolumeGPU` uploads a procedural surface baseline and packed edited chunks.
Only changed chunks are uploaded after edits; camera turns reuse those buffers,
and edits behind the cut change the far wall. All buffers, materials, geometry
and textures belong to the view and are released on disposal. The mirror uses
one growable density buffer and reports an error if it exceeds the device's storage binding limit.

Density and normal buffers preserve resident contents with GPU copies when growing.
Edit subscriptions restrict packing, map writes and bound updates to affected regions.
Acceleration bounds include a one-sample interpolation halo and are shared by camera
and shadow rays. Carve-only edits retain safe heightfield air skipping; additive fills
restore conservative edited-neighbour checks. Density chunks still remain resident.
The compute hit texture is reused when camera, viewport, clipping and density stay
unchanged; lighting and shading continue every frame. `view.reuseHits = false` disables
that reuse for measurement.

Geometry LOD and background remodeling are enabled by default. Edited areas are split
into 16-cell patches (4 m at the fixture resolution), extracted into triangle meshes
in an ES module worker, and simplified into several LODs. Orthographic views use pixel
footprint; perspective views also use conservative distance to each patch. Flat areas
can lose triangles without moving the surface. Borders keep identical vertices and
face diagonals at every LOD; triangles morph onto the next topology before its
degenerate triangles are removed. This keeps LOD changes continuous on zoom reversals.

The target projected error is 0.2 pixels. Interpolation and accumulated vertex-displacement
estimates select eligible meshes; exactly coplanar contractions add no surface error.
Singular or close features retain density rendering.
These are conservative selection heuristics, not a certified Hausdorff error bound
for arbitrary edited fields. Completed geometry reveals over 350 ms with stable pixel
coverage, while real cut faces, bounds, collision, materials, normals and shadows
continue to use the authoritative density. Meshes first render hit positions; camera
rays check preceding density before accepting those hits. Pixels without
a mesh hit use the original density traversal. Density rendering remains available
while rebuilding, and disabling LOD selects the original compute pipeline.

Edits immediately revoke coverage for every affected patch, including both sides of
shared boundaries. Quiet patches wait 750 ms before snapshots. Indexing, snapshot
copying and segmented GPU uploads share a 0.35 ms main-thread target once per 100 ms.
This is a cooperative time budget, not a hard real-time deadline. Only one worker job
is outstanding, and submissions are at least 150 ms apart. Each maintenance tick uploads
at most 32 KiB in segments of at most 16 KiB. Snapshots are copied, checked against a local generation while copying,
and checked again when the worker finishes. Further edits cannot publish stale geometry;
unrelated digs do not cancel useful jobs. Fully air/solid patches require no mesh job.
The default work queue focuses on edited areas visible to the current camera. Resident
geometry has a 64 MiB budget; eviction restores density rays. Sparse mesh metadata
does not allocate a coverage grid for the entire region. Loading an existing mine
also scans its density chunk table in small segments.

The worker stops extraction as soon as a patch's interpolation error rules it out at
the current zoom. It retains a small error bound for retrying at a wider zoom; local
edits reset that bound. Pending-job selection visits at most 64 entries per tick and
rotates through large queues. Settled views reuse their draw lists and cached physical
intersections while background meshes arrive, fade or leave the cache. Camera, density,
cut and explicit render-path changes still invalidate intersections immediately.

Use **Terrain tools & diagnostics → Geometry LOD and background remodeling** to compare
the paths. Diagnostics report active/resident patches, triangle count, mesh bytes and
maintenance time. `view.meshLOD = false` also disables it. Constructor options:

```js
new VolumeViewModule({ region, plane, queryHeights,
    meshLOD: true,
    meshOptions: {
        cells: 16, budgetMs: 0.35, quietMs: 750, fadeMs: 350,
        maintenanceIntervalMs: 100, jobIntervalMs: 150, maxUploadBytes: 32 * 1024,
        pixelError: 0.2, maxBytes: 64 * 1024 * 1024,
        includeBaseline: false, // true also builds untouched heightfield patches
    },
});
```

Ship `meshWorker.js` and its relative `meshRemodel.js` dependency alongside the core;
workers do not use the page import map. If worker startup fails, density rendering
continues and diagnostics expose the error. All owned mesh buffers and the worker are
released on disposal. Authoritative density storage is not compacted by mesh remodeling.
The mesh path adds a raster pass and is not universally faster than optimized density
traversal; see [the initial 30 October results](LOD-2026-10-30.md) and
[the follow-up scheduling measurements](REMODELING-2026-10-30.md) for costs and limits.

The real WebGPU check runs with the harness server and an existing Puppeteer install:

```sh
node dev_harness/meshSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js \
  --out /tmp/anthill-mesh.json --capture-prefix /tmp/anthill-mesh
```

It warms visible geometry, compares frozen-lighting images, alternates completed
density/mesh frames, and records GPU timings and main-thread maintenance. It also
checks gradual reveals, zoom reversals, a long perspective tunnel, next-frame visibility
of an intervening fill, and edits posted while a worker job is running.

All miner code and controls live under `dev_harness`; no voxel core or production
Spherecraft files are changed. `MineTerrain` adapts `VoxelRegion.apply` and
`VoxelVolume` collision queries. `MineCharacter` accepts local movement intents
without DOM or rendering dependencies, and exposes its feet through
`RegionFrame.localToWorld` as a double-precision `worldPosition`. Gravity follows
the frame's local up, including a tilted planetary frame. `MineCharacterView`
is an ordinary depth-tested render module: it uses the same camera-relative
transform, cut plane and depth buffer as `VolumeViewModule`. CPU tests cover
the coordinate round trip with a tilted up vector and a distant world origin.

The eventual Spherecraft connection has a specific remaining requirement:
`wizard_game/actors/ActorManager.js` currently dispatches GPU-authoritative actor
physics against the terrain heightfield (plus optional platform colliders).
Its solver must query voxel density while an actor is inside a mine, then hand
back to surface terrain outside the region. Copying a CPU position into that
actor would be overwritten by the existing solver. This harness establishes the
local intent / density edit / frame-transform boundary without changing that
production ownership. Actor/terrain composition, terrain hiding,
surface-water contact reporting and flooding remain integration work.
Water bytes already exist in `VoxelVolume`; no water simulation runs in the harness.
Perspective inspection and triplanar detail textures are not implemented.

Run `node --test` for CPU coverage including smooth turn pivots and retargeting,
inspection isolation, camera-relative ray uniforms, edited density bounds, resolution
changes without framing jumps, edit uploads, the lighting clock, light lifecycle,
independent flicker and resource disposal.
Rendering also needs a WebGPU browser check; fake-device tests do not compile WGSL.

An optional character browser smoke check uses an existing Puppeteer Core install:

```sh
node dev_harness/minerSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js
```

It verifies actual WebGPU pixels and keyboard input, held digging/release, pitch,
free-view movement, cutaway/full hillside, turning, jump, fatal shaft fall,
respawn and focus loss. `--url`, `--chrome`, and `--capture-prefix` override the
server, browser and optional screenshot prefix. No dependency install is required.

`node dev_harness/lightingSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js`
checks the actual light/shadow WGSL on an isolated GPU volume: sealed roof, opening
a sun shaft, changing sun angle, day/night, a 48 m unobstructed ray, body shadows,
placed-light illumination, penumbra values, source/body overlap, continuous unit
normals at voxel/chunk borders, and cache invalidation after filling a wall. It also checks
carried-torch movement, installed-light persistence, steady lanterns, removal and
the reference fragment render path. It accepts the same browser, URL and capture
options as the miner check. `verifyLightingGPU.js` is also callable from the browser.

`node dev_harness/frameLoopSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js`
also measures idle/active frame rates and actual GPU submissions across tab
switches in both harnesses, including input release and the first resumed delta.
It accepts `--url` for the server root and `--chrome` for the browser executable.

## Reproducible GPU performance check

The [29 October investigation](PERFORMANCE-2026-10-29.md) explains digging scalability,
current LOD behavior, the optimization batch, measurements and a proposed background
mesh/remodeling path. `comparison-2026-10-29.json` contains interleaved original/optimized
measurements; `digging-before-2026-10-29.json` and `digging-after-2026-10-29.json` contain
the fixed-camera 1,024-dig stress runs and memory/edit costs.

An optional Puppeteer Core benchmark runs Chrome without the display-sync cap,
pauses the harness loop and waits for each submitted frame to complete. It reports
completed-frame throughput, CPU recording time, GPU timestamp span across compute
and shading, and p95 times. It does not count queued work as completed frames.
No browser dependency is needed for normal harness use or `node --test`.

```sh
node dev_harness/voxelBenchmark.mjs \
  --puppeteer /absolute/path/to/puppeteer-core.js \
  --verify-images --out dev_harness/performance-results.json
```

The default render size is 1264×791 (about one million physical pixels). `--width`,
`--height`, `--seconds`, `--url` and `--chrome` override the run; `--reference` uses
fragment tracing. Moving inspection uses the separate 360,000-pixel budget.
`performance-results.json` records the latest measured device, times and checks;
these isolated harness timings do not guarantee integrated SphereCraft performance.

Add `--dig-stress --seconds 1` for 0/256/1,024 remote digs, constant-framing overview
and chamber views, and 16/64/192 m tunnels. It records brush and upload-bookkeeping CPU
times separately from rendering and GPU normal construction. `--no-hit-cache` disables
intersection reuse in the ordinary benchmark. `voxelCompare.mjs --puppeteer /path/to/puppeteer-core.js
--before-url http://127.0.0.1:8027/dev_harness/voxel.html --out comparison.json` alternates
original and optimized batches in one browser; serve an unchanged original separately.

`verifyVoxelGPU.js` checks 8192 positions on the GPU, including edited chunks and
chunk boundaries. It compares optimized density with the original eight-look-up
sampler, analytic gradients with numerical derivatives and material culling with
the reference material. `--verify-images` additionally compares skipping on/off
and compute/fragment paths at several angles after an above-ground fill.

## Original cube harness

This browser harness draws a rotating cube with a generated procedural texture.
It uses the production `Renderer`, WebGPU backend, and geometry/material/texture
resources. There is no terrain, planet, game frontend, lighting manager, package
installation, or build step. Lighting is a small directional light in the example
shader. Python 3.10+ is sufficient for reconstruction and serving;
the page needs a browser with WebGPU support on localhost or HTTPS.

Implement engine features and harness modules in JavaScript ES modules (`.js`).
Do not introduce TypeScript implementations, declaration files, a compiler, or a
build step. 

From the engine repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000/dev_harness/index.html. Drag to orbit, scroll to zoom,
and press Space to pause rotation. 

## Engine location and extension

The HTML import map defines the single engine prefix:

```html
<script type="importmap">
{"imports": {"engine/": "../core/"}}
</script>
```

Harness modules import `engine/renderer/...` or `engine/texture/...`. Change that
map when relocating the core. Engine-internal relative imports remain intact.
The root must contain the core and its shared dependencies. Bundle paths preserve
their layout relative to that root, including the harness itself.

Implement a feature as another `RenderModule`, then install it with
`await renderer.addModule(module)`. `texturedCube.js` shows mesh construction,
procedural texture generation, explicit shader bindings, frame updates, drawing,
and disposal. Both shader stages use the backend's `main` entry point. Camera
matrices are column-major, right-handed, and use WebGPU depth [0, 1]. The harness
camera belongs to the application; the core requires only position and matrices.
Owned materials are released with `backend.destroyMaterial`; the module releases
its own textures, geometry, and generator. Borrowed GPU devices stay alive.

## Reconstruct from just the bundle

The beginning of the generated bundle contains a complete one-line Python
bootstrap. Copy that command, adjusting the bundle filename and destination as
needed. It executes the final embedded reconstruction script that builds the project
structure from the supplied bundle.
