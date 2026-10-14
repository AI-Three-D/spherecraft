Scene-aware adaptive rendering plan

The objective is lower CPU/GPU energy use while preserving responsive input, smooth visible animation, current shadows, water motion, and stable terrain materials. A stationary camera is one optimization opportunity; it does not establish that the scene is stationary. This document proposes changes for implementation in stages. Frequencies and thresholds below are starting points for measurement, not demonstrated performance gains.

The current camera-only stationary FPS decision should be replaced first. A visible walking character, an idle skeletal animation, a changing character shadow, waving vegetation, or a flickering nearby light can require the active presentation rate even with a perfectly still camera.

**What the current engine does**

- [AdaptiveQualityController](../core/AdaptiveQuality.js) bases its automatic FPS reduction on camera motion and input. It has no request from other visible systems to keep the active presentation rate.
- [FrameLoop](../wizard_game/FrameLoop.js) and the [game bootstrap](../wizard_game/standalone.html) advance gameplay and render together on accepted frames. Actor simulation, pose updates, and some environment work consequently depend on presentation scheduling.
- [Frontend.renderTerrain](../core/renderer/frontend/frontend.js) coordinates particles, lighting, skinning, shadows, terrain compute/draw, actors, and transparent water. Independent scheduling requires separating these responsibilities without changing their required ordering.
- [TerrainModule](../core/renderer/terrain/TerrainModule.js) already separates source compute, opaque terrain rendering, and transparent water layers. However, some lake/river water also runs inside the [terrain fragment shader](../core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js). Caching that shader's final color would cache moving water too.
- Terrain geometry and material generation are separate. Height residency does not imply that texture refinement has completed. The [instance builder](../core/world/quadtree/instanceBufferBuilder.wgsl.js) can use different geometry and material layers. Cache invalidation and eviction protection must account for both actual sources.
- The [shadow renderer](../core/shadows/GPUCascadedShadowRenderer.js) already skips its far terrain/asset cascade on alternate frames. Cascade matrices are computed separately, and skinned shadow rendering has a separate call. A scheduling audit must cover all those paths together, including keeping a reused shadow texture paired with the projection that produced it.
- [WeatherController](../core/renderer/environment/WeatherController.js) already uses a lower-frequency simulation with interpolation. [WaterRiverSim](../core/world/water/WaterRiverSim.js) already uses fixed physics substeps. Preserve and build on these mechanisms rather than adding a second conflicting clock.

**Where different frequencies can save work**

| Work | Proposed scheduling | Why it can save work / conditions |
| --- | --- | --- |
| Visible characters and their poses | Active presentation cadence; independent physics steps | Preserve motion quality. Lower-frequency distant animation is a separate, explicit quality option. |
| Terrain visibility traversal and instance building | On camera/LOD/input changes; otherwise reuse valid buffers | Avoid redundant selection and compute without changing terrain quality. Tile arrivals and stitching changes also invalidate instances. |
| Terrain height/material generation | Separate existing queues and budgets | Prioritize useful geometry while preserving material refinement and completed data. These are not presentation FPS controls. |
| Terrain surface rendering | Every frame initially; optionally cache surface attributes for a stationary view | Savings require retained color/normal/depth data, correct invalidation, and cheaper reuse than drawing again. |
| Terrain lighting and receiving shadows | Every presented frame when lights or shadows change | Static ground still needs to show moving character shadows. This work cannot simply be frozen with the terrain surface. |
| Static shadow casters | Reuse maps until projection, light direction, or caster data changes enough | Potentially substantial savings, but cache validity must include sun motion and all relevant terrain/prop changes. |
| Moving shadow casters | Active cadence for important nearby shadows | Characters, animated vegetation, and moving props need fresh silhouettes. Off-screen casters can still affect visible receivers. |
| Water physics | Existing stable fixed timestep, with bounded catch-up | A lower draw frequency does not automatically reduce physics work: two substeps at 30 FPS can cost the same as one at 60 FPS. |
| Water appearance | Active cadence near the camera; cheaper distant-water policy when acceptable | Analytic waves may be cheap to evaluate each frame. Updating a expensive simulation field less often requires interpolation and numerical validation. |
| Cloud raymarching | Candidate 15–30 Hz with temporal reconstruction at presentation cadence | Needs motion/depth rejection and a measured reconstruction cost. Camera cuts, weather transitions, and silhouette changes force refreshes. |
| Atmosphere LUT / weather fields | Their own dirty inputs and existing update clocks | Avoid rebuilding data whose inputs have not changed; existing LUT caching must be respected. |
| Postprocessing and final composition | Presentation cadence | Dynamic objects still need current color, depth, exposure, bloom, and transparency. Reduce individual effect cost where measured. |

Merely omitting a geometry draw every second frame will remove that geometry after the frame clears. Persistent off-screen data and a valid composition path are required to reuse it. Retaining only lit terrain color also retains its old shadows and lighting. Retained surface attributes allow lighting to change without rebuilding the underlying terrain surface.

For a component taking fraction `p` of baseline frame work, reducing its refresh rate from `F` to `f` gives an approximate gross saving of `p * (1 - f/F)`. Subtract reuse, composition, invalidation, and extra memory traffic. For example, if an eligible pass costs 40% of the frame, 60-to-30 Hz refresh removes at most 20% of baseline work before overhead. This is an illustrative calculation, not a prediction for this engine or a proportional battery-life claim.

On Apple silicon, extra persistent render targets and separate passes deserve particular attention: Apple describes avoiding expensive trips between tile memory and system memory in its [deferred-lighting sample](https://developer.apple.com/documentation/metal/rendering-a-scene-with-deferred-lighting-in-c%2B%2B). Cross-frame caches necessarily retain data beyond the current pass. Do not assume Metal-specific imageblock/tile-shader optimizations are available through WebGPU or that a deferred cache will beat the current forward renderer.

**1. Establish a measured baseline and a visual comparison suite**

Record CPU time, GPU time by pass, work submitted per second, resource allocation, estimated retained memory, and sustained power/battery use. Compare at the same camera, terrain/material readiness, scene activity, resolution, and presentation target; average FPS alone is insufficient.

Add optional GPU pass timing using feature-detected `timestamp-query`, requested when the device is created. Resolve/read results asynchronously through a small buffer ring at a low diagnostic frequency. Never wait for GPU completion in the frame loop or add per-actor/per-particle synchronous readbacks. If timestamps are unavailable, label CPU/submission timing appropriately and use controlled pass toggles. Timestamp queries are optional; [Chrome's implementation documentation](https://developer.chrome.com/blog/new-in-webgpu-120) describes feature detection and requesting support.

Exercise a quiet landscape; stationary camera with walking/idle-animated characters; moving off-screen shadow casters; moving sun at normal and accelerated time; water/foam; wind-driven vegetation; particles and flickering lights; material refinement landing during a stationary view; fast camera motion; teleports; resolution changes; and hidden-tab resume.

Current runtime defaults disable several expensive features, including shadows and particles. `GameTime.update()` currently contains a fixed elapsed value. Comparison fixtures must deliberately enable and animate these systems rather than declaring a scene-aware scheduler correct from the default frozen-time landscape alone. Fixing the gameplay clock is a separate change.

Deliverable: per-pass cost report and reproducible camera/scene fixtures, including the existing coarse-texture seam/striping cases. Keep that known material defect visible as a baseline; this plan does not assume its cause has been fixed.

**2. Replace camera-only idle with scene activity requests**

Introduce an application-owned `SceneActivityTracker`. Systems publish relevant activity, a requested presentation rate, a next update deadline, and a revision/dirty signal. Keep game-specific actor/weather dependencies in `Frontend`/game composition; the core renderer receives generic scheduling decisions.

An active visible character requests the active presentation target, including an idle animation that changes its pose. A relevant moving shadow caster, changing local light, or important animated water region can make the same request. Use conservative bounds for view, shadow, and light influence. Unknown or stale visibility data stays active until classified; do not lower FPS because an asynchronous actor readback has not arrived yet.

The presentation target is the highest rate required by relevant visible work, bounded by the user's explicit active FPS limit. The quiet cap of 30 is eligible only after the quiet delay and when every relevant visible producer accepts that rate. With a walking character requiring 60, presentation remains 60 even if terrain/background work has lower update rates. An explicit user-selected 30 FPS cap remains a deliberate quality limit.

Use the existing 250 ms delay as the initial camera-stillness hysteresis, not as a universal scene-idle timer. Increase rates on the next display refresh following input, animation start, spawn, camera cut, light/caster movement, or visible streaming completion. Decrease rates only after activity and cache validity are known. Show the reason in diagnostics: for example, `60 FPS: visible character animation`, `60 FPS: changing near shadow`, or `30 FPS: quiet scene`.

Resolution adaptation remains a separate policy. Preserve a stable terrain LOD reference and material-source selection when render resolution changes. Do not resolve scene scheduling problems by discarding detailed textures, canceling needed refinement, or making cached material incomplete.

Deliverable: stationary-view animation/shadow correctness without introducing any cross-frame terrain image cache.

**3. Separate clocks and update phases before lowering pass rates**

Create independent scheduling for simulation, presentation, expensive field refreshes, and maintenance. Each subsystem receives its real accumulated simulation time, not the most recent presentation delta.

Run gameplay/physics with stable fixed steps appropriate to their existing solvers. Keep responsive intent collection and camera control at the active cadence. Interpolate poses between simulation steps where their GPU representation permits it; otherwise retain the required pose update rate. NPC decisions/path planning may use lower frequencies independently of movement integration. Sleeping or irrelevant entities can reduce work only under an explicit simulation policy, not simply because they are invisible.

Order the frame so current simulation/pose results are available before shadow and color rendering consume them. Preserve fixed-step water stability, bounded catch-up, and hidden-tab clock reset. A lower presentation rate must not change movement speed, cooldowns, day progression, or fluid simulation speed.

Continue flushing completed terrain texture copies, publishing material-complete flags, draining useful generation/refinement, and releasing completed resources while reusing traversal results. Rebuild instances when either geometry residency or material ownership changes. A geometry-only arrival and a material refinement arrival are separate invalidation events. Protect both referenced geometry layers and referenced material fallback layers from eviction while they are used.

Deliverable: per-subsystem deadlines and accumulated clocks, with preserved simulation behavior and terrain source ownership.

**4. Add conservative per-pass reuse, beginning with shadows and selection**

Reuse terrain traversal and instance buffers while camera/projection, relevant terrain inputs, residency/material mappings, and neighbor stitching remain unchanged. Generation completion can invalidate these buffers even when the camera is still. Count revision events on the CPU when work is published; avoid a GPU readback just to discover that a submitted copy occurred.

Schedule shadow cascades by projected error and cache validity instead of a frame-number modulus. A starting far-cascade range might be 5–15 Hz, but sun motion, coverage changes, and caster movement override it immediately when error would be visible. Near animated shadows retain the active cadence. Accelerated time can invalidate a static map every frame; there is no guaranteed low shadow rate.

Keep each cached depth map with its generating light/cascade matrix. Updating the sampling matrix while retaining depth from another projection is invalid. Audit terrain, asset, and skinned shadow paths together; a far-cascade skip must not accidentally retain the old static depth while adding changing character depth under new matrices.

For a later static/dynamic caster split, retain separate depth maps under compatible projections. Clear/rebuild dynamic depth so old character silhouettes cannot accumulate. Combine the closest valid caster depth per shadow sample before comparison/filtering; account for the extra sampling or merge-pass cost. Static-map invalidation includes terrain generation, caster transforms, alpha-cutout changes, and wind-driven geometry where applicable.

Keep existing weather interpolation and atmosphere LUT caching. Profile cloud refresh/reconstruction separately; enable it only where temporal artifacts and reconstruction overhead are acceptable.

Deliverable: measured reductions in traversal, shadow, and field-update work while still drawing the complete scene at its required presentation cadence.

**5. Prototype cached terrain surface attributes for a stationary view**

Only proceed if terrain geometry/material shading remains a significant measured cost after the previous stages. Begin at one common render resolution and a fixed camera. Cache opaque terrain albedo, encoded normals, depth, and the additional material properties actually required by terrain lighting. Reconstruct position from depth rather than retaining another full position texture where precision permits.

The proposed frame order is:

1. Advance required simulation and publish completed terrain/material work.
2. Update required shadow maps with current caster poses.
3. Refresh the static terrain surface cache if its inputs are dirty.
4. Shade the cached surface using current lights, atmosphere, and shadow maps. Restore a fresh working depth buffer during this pass or through a supported depth copy/pass.
5. Draw current characters and other dynamic opaque objects against that working depth.
6. Draw water, transparent geometry, particles, clouds, and remaining effects with current depth/color dependencies.
7. Postprocess and present at the scene's required rate.

Lighting/shadow changes require step 4, not necessarily step 3. Geometry, height, normal, texture refinement, material UV ownership, stitch topology, seasonal material parameters, viewport, or camera changes require step 3. Start with whole-cache invalidation; add partial-region updates only after correctness and timing are established.

Water currently shaded inside opaque terrain must be separated into a dynamic contribution or excluded from the eligible cache region. Do not store animated water in a supposedly static color layer. Dynamic vegetation also belongs outside a static cache. Background color/depth must be restored before drawing moving characters so their previous positions leave neither color trails nor stale depth occluders.

While the camera moves, use the ordinary forward path unless a separate, validated reprojection path is profitable. A cached view normally invalidates every moving frame; paying cache setup/reconstruction on top of full refreshes can lose performance. Camera cuts, missing history, disocclusion, or large state changes force a fresh draw.

Deliverable: the same visible character and shadow cadence, identical depth/occlusion behavior, and a measured net saving for stationary scenes. If the existing coarse terrain pass is already cheaper than the extra cache traffic and relighting pass, keep forward rendering for that scene/preset.

**6. Consider independent resolution and temporal reconstruction afterward**

Once the previous pipeline is stable, evaluate lower-resolution terrain/cloud buffers with characters at a sharper resolution. This requires depth-aware upsampling, correct character/terrain occlusion, water transparency, shadow-edge handling, and compatible postprocessing. It does not follow from assigning different pixel ratios to meshes in a shared render target.

Cloud or distant-effect histories can use reprojection, neighborhood rejection, and interpolation when supported by measured motion/visibility error. Do not make camera-motion reprojection a prerequisite for the initial energy savings. Retain the simpler path whenever its measured cost or image quality is better.

Deliverable: an optional quality feature with clear reconstruction limits, separate from simulation frequency and terrain generation LOD.

**Configuration and implementation boundaries**

Expose active FPS limit, quiet-scene FPS limit, quiet delay, the existing resolution anchors, and a scene-aware policy in Settings. Put pass refresh rates, maximum staleness, shadow-error thresholds, and experimental cache switches in validated engine configuration. Balanced quality preserves active visible characters and near shadows; an economy preset may explicitly permit lower effect/animation cadence. Avoid presenting many unrelated frequency sliders before their dependencies are implemented.

Keep `AdaptiveQualityController` responsible for quality targets. Let an activity tracker determine required cadence, a scheduler decide which work is due, and each pass own its retained resources and invalidation. `Renderer` remains scene-independent. If checked renderer/module contracts change, update their JSDoc/TypeScript contracts, rebuild declarations, and run the required type checks.

Treat cache resolution, camera projection, geometry generation, material refinement, and source ownership as separate versions. Unknown dependency changes invalidate conservatively. The first implementations should favor a correct redraw over retaining an ambiguous cache.

**Acceptance and rollout**

- Stationary camera plus visible walking/idle animation retains the active target and responsive controls.
- Character shadows move at the expected cadence on cached terrain, including off-screen casters; old shadows do not persist.
- Accelerated sunlight, flickering lights, wind, water, and particles request appropriate updates without freezing the background.
- Material refinement arriving on existing height geometry refreshes the surface cache without a geometry reset or loss of an available complete material source.
- Changes in resolution do not change terrain selection or material availability; cached frames match fresh frames at transition boundaries.
- Occlusion remains correct when characters move away, water crosses terrain edges, or the camera changes. No trails, missing geometry, stale depth, or phantom shadow projections.
- Terrain generation/copy/refinement queues drain while selection is reused. Hidden tabs stop eligible work and resume without a catch-up burst.
- Compare CPU/GPU work per second, sustained power, and visual quality against the same scenes on the target M1 Pro. Report results for features both enabled and disabled. A higher FPS benchmark does not establish energy savings.

Implement stages 1–4 first, with each scheduling change independently switchable. Stage 5 is a measured experiment rather than an assumed win; stage 6 is optional. Introduce each stage in a separate reviewable commit with focused scheduling/invalidation tests and the relevant browser comparison fixtures.
