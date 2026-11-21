# Terrain continuation — 2026-11-19

## Workspace and session

- Checkout: `/Users/okkokauhanen/work/DATrain/feature/proj/sp2/spherecraft`.
- Continuing branch: `feature/terrain-rework`, created from local `main` at
  `209db93`. Existing tracked edits, trial sources and review images were
  retained; the terrain work remains uncommitted.
- Recovered Codex session: `01a1cfe8-8fb4-79d2-b8df-1d7b48d50bac`, named
  “Plan terrain stack rework” in the session index. Its metadata names this
  exact checkout. It started November 12 and has activity through November 16.
- Transcript: `~/.codex/sessions/2026/11/12/rollout-2026-11-12T15-18-07-01a1cfe8-8fb4-79d2-b8df-1d7b48d50bac.jsonl`.
- The separate November 18 session reviewed clouds in
  `/Users/okkokauhanen/work/DATrain/feature/proj/spherecraft`.

The recovered transcript ends during canyon refinement. The local README and
findings contain later November 16 work; preserve those decisions as well.

## Unified stack

The default wizard game now combines directional mountain ranges, regional
foothills, mountain valleys, rolling hills, coastal hills and coves, calderas,
fjords and fells. The terrain, lake and river samplers share the configured
landforms. Mesas, cuestas, canyon and dunes are disabled trials. The existing
continents and ocean serve the first stack. See [README.md](README.md) for
review sites and comparison controls.

## Earlier decisions

Directional mountain ranges and regional foothills are selectable at startup;
both retain their legacy defaults. Rolling hills, valley, coastal, canyon and
dune trials are available through the comparison server. The owner liked the
rolling hills and later coast direction; valley walls still need work.

The canyon-country replacement was rejected after showing broken crests and
striped walls near spawn. Keep it as a rejected reference. `canyon-trial.wgsl`
contains the earlier, gentler experiment and is still unfinished. Dunes also
remain unfinished: they need suitable placement and a sand-fill composition
instead of ripples on hills. See [FINDINGS.md](FINDINGS.md) for the evidence
and [README.md](README.md) for the landform roadmap.

On November 20, a further canyon retry with wide analytic walls still read as
a stamped corridor. It is parked as `canyon-grid-trial.wgsl`. Following the
owner's instruction to move on autonomously, the next completed landform is
**caldera volcanoes**, integrated into both production base generators and
enabled in the demo world. The earlier rejected canyon remains rejected.

The caldera preset has a broad apron, asymmetric rim, rounded bowl, shallow
radial drainage and occasional low saddles. Its settings reach terrain,
lake-table construction and river planning at startup. Validation includes
629 passing tests, typechecking, both shader base generators, 1.31 million
before/after terrain samples, isolated gradient checks, matched engine views
and shared terrain/water heights. See the November 20 section of
[FINDINGS.md](FINDINGS.md) for scope and limitations.

Dune fill, further coastal/tectonic landforms and shared province/climate
placement remain future work. Do not resume the rejected canyon as the
default next task merely because it was the last item in the old transcript.

Mesas and cuesta ridges are disabled trials after visual review. Their fixed
views remain at sites 19–22. Fjords and fells are independently selectable
at sites 23–26 and are candidates for the first integration pass. The
existing continents and ocean are sufficient for that pass. See the initial combined pass in
[README.md](README.md) for the candidate set and placement decisions.

## Recovery validation

- `npm test`: 122 of 123 files passed; the river field-groups benchmark timed
  out at its five-second limit under the full parallel run.
- Focused rerun of that benchmark, terrain shader compilation and world
  configuration tests: all 33 tests passed.
- `npm run typecheck`: passed, including declaration freshness.
- Chrome WebGPU `checkPreview.mjs --canyon-smoke`: all six selections passed.
  Their terrain cache keys were distinct, and terrain/lake and river-planning
  heights matched at the sampled canyon direction. Canyon changed the sampled
  height by about 206–207 m, alone and with the earlier trials. Dunes compiled
  but did not change that point; this check does not validate dune placement
  or appearance. The full 256-selection matrix was not rerun.
- Tightened `checkPreview.mjs` to reject nonfinite water heights and missing
  canyon comparison heights; previously NaN could bypass the difference test.

Start the interactive comparison with:

```sh
python3 tools/perf/terrainRework/preview_server.py --compare --port 8775
```

Open
`http://127.0.0.1:8775/wizard_game/standalone.html?lakeCells=1&terrainPreviewSite=14&terrainRework=mountains,foothills,valleys,rolling,coast,coves`
for the coast, or use `terrainPreviewSite=15&terrainRework=canyon` for the
unfinished canyon. The feature checkboxes preserve the camera on reload.

For the new caldera, open
`http://127.0.0.1:8775/wizard_game/standalone.html?lakeCells=1&terrainPreviewSite=16&terrainRework=&calderas=1`.
Site 18 looks into the bowl and site 17 is snowy. Its independent checkbox
reloads the same view with the caldera off/on. Root images are
`caldera-before.png`, `caldera-after.png` and `caldera-rim.png`.

The checkbox's reload/camera preservation was verified in Chrome. The paired
warmed 24-tile check measured 12.59 ms/tile off and 12.87 ms/tile on (about
2.2% in this feature-heavy sample). Detailed results, limitations and source
hashes are saved in `caldera-validation.json`; the comparison server is left
running on port 8775. All work remains uncommitted on the feature branch.
