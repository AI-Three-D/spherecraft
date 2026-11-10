# Startup prompt for Claude

Read `CLAUDE_LAKE_RIVER_REASSESSMENT.md` thoroughly. It is the new primary handoff; earlier handoffs are historical evidence and can contain superseded assumptions. Then inspect the actual code and relevant raw reports. Work in `/Users/okkokauhanen/work/DATrain/feature/proj/spherecraft`.

Your task is to recover and improve realistic lake and river placement across the real game planet. The owner's two latest screenshots from `standalone.html?regionalTerrain=0&regionalBanks=legacy&riverSim=off` establish the lake shape/scale target: broad terrain-derived bodies, bays, narrow peninsulas, islands, smaller branches and varied extents. Mountain lakes must fit real pockets/valleys, and rivers must have plausible descending courses, organic banks and coherent lake/river/sea joins. The newer regional lakes never reproduced the original shape and size and were rejected. Do not treat a prior isolated prototype approval, a large nominal radius, a numeric giant, a lake count or passing tests as acceptance.

**VERY critically question all of Codex's ideas before committing to any architecture or implementation direction.** You are not being asked to execute its plan. Challenge the original method too. In particular, test rather than assume:

- that terrain-based discovery is too expensive, and that flood fill rather than terrain evaluation, patch growth, dependencies or regeneration is the bottleneck;
- that coarse regional placement is inherently faster or visually sufficient—it already bakes fuller supporting heights;
- that an authoritative spline preserves enough shoreline/mountain structure, or actually removes more repeated work than it adds;
- that proof conservatism, minimum-height checks, candidate/support limits and micro suppression are proportionate to the game's needs;
- that more noise, larger stamped depressions or one lake per region can recover the reference morphology;
- that identical mountain/plain discovery is better than different strategies sharing common final-height/outlet records;
- that Codex's suggested hybrid has a concrete cost/stability contract rather than merely duplicating two terrain models;
- that restoring the original unmodified fixes its slow river arrival, moat banks, late terrain regeneration or sampler/render disagreement;
- that nearby Whitewater-derived reference-flow stability implies physically correct channel depth/discharge, or solves bad placement.

Begin with a read-only audit and a concise independent critique. Distinguish source-confirmed facts, valid measurements, owner assessments and hypotheses. State which assumptions you reject or keep, what evidence could disprove your preferred option, and the smallest experiment that distinguishes credible alternatives. Do not use this critique as a reason to stop at a plan: proceed into the authorized bounded measurements and small, reversible improvements after investigating the necessary facts.

Recover the original reference lakes and save reproducible IDs/configs/camera poses and broad/close captures. Compare actual connected water area, extent, islands/peninsulas, terrain preservation, mountain setting and outlet geometry. The “215× larger” claim compares two recent regional populations, not the original natural lakes. The original-path smoke harness mislabeled lake 0 as largest by sorting an absent `cells` field; original records use `cellCount`, and maximum final area still needs refinement/measurement. Do not inherit that error or invent physical size from the screenshots.

Evaluate repairing the original, a topology-preserving hybrid, a genuinely shared adaptive terrain hierarchy, and a different parent-landform/drainage approach on their merits. You may select another design if justified. Prefer preserving the demonstrated natural lake contours over defending existing regional code. Extra preliminary height computation is allowed when its complete visual benefit justifies its measured cost; one terrain pass is a preference, not a prohibition. Avoid the old dry-first visible tiles followed by late water-carving regeneration workflow.

Measure complete cost in milliseconds: cold setup/compile, supporting/global heights, failed attempts, transfer/readback, topology/solve, source/receiver work, river routing, publication, dependent fine outputs and regeneration. Record live/peak/replacement memory. Match scenes, tile/output workloads, lighting and residency when comparing. First coarse whole-view coverage during fast movement must target <50 ms; settled FPS, data-ready time and loader timeout are not that measurement. Keep tile queue policy work distinct from placement unless a specific dependency change is necessary.

Run GPU jobs sequentially in owned processes. Keep raw reports and unsuccessful attempts, use new evidence directories, and verify real production bindings: corrected native river carving uses `gpu.resources`, not nonexistent `gpu.carveResources`. Validate rendered height/depth/ownership and LOD as well as sampled planning. Preserve inherited changes and the working fallback; do not stage, commit, push, reset or perform broad cleanup. No new simulation port or broad terrain rewrite should precede a discriminating shape/cost test.

Proceed in small increments, report meaningful findings, and let the owner judge actual game visuals. If the approach cannot preserve the original broad lake shape or its complete cost fails, reject it promptly. You are explicitly allowed to reverse Codex's architectural recommendations. Document your decision, evidence, limitations and next experiment in the new handoff.
