// core/world/water/riverCarve.wgsl.js
//
// River corridors shaped into the terrain height function, from the traced
// rivers' segments (WaterGpuData.js, waterWorkerCore.js solveRiver). It is
// the last step of calculateTerrainHeightD (earthLikeBase.wgsl.js), so every
// consumer of the height gets the same river: tiles at every LOD (tile
// edges stay stitched), normals, the water simulation's bed. The hydrology
// sampler compiles the terrain without it (it traces the rivers on the
// natural terrain).
//
// The ground is the river cross-section (riverSection.js riverSection_d):
// the channel, then each side's bank (cut bank, ledge or none, chosen by the
// bends and long-wavelength noise) out to where it meets the natural ground.
// It only cuts: lower natural ground is preserved. Next to a lake a bank
// keeps its rim (riverSection.js riverBankRim).
// The closest traced segment is shared with waterRiverAt; width, depth and
// the centre's wobble interpolate along the river.
// Dual numbers vec4(height, d/d unitDir) as in the height function,
// including the centre's wobble and the width's change along the river;
// skew and the bank types are taken as constant along it (they vary slowly).

import { createWaterCommonWgsl, createWaterLookupWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';
import { RIVER_SECTION, createRiverSectionWgsl } from './riverSection.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
// lakes, masks and sampler: the lake lookup of the shore materials (bankDetail).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3, lakes: 7, masks: 8, sampler: 9 });
// Terrain micro detail returns over this far (m) beyond a river's half-width.
const MICRO_RETURN_M = 8;
// The cut fades out over this far (m) behind a river's first point, and
// past its last point into a lake.
const START_FADE_M = 30;
// Rivers per point whose containment floor is kept (riverSection.js contain).
const MAX_FLOORS = 6;
// The river valley field (riverValley.wgsl.js) returns over this far (m)
// beyond a river's channel: nearer, the fine section (riverCarveTerrain_d).
const VALLEY_RETURN_M = 60;
// A river's end under a lake's drawn water widens into a basin
// (riverCarveSegment_d): flat at its bed (at least BASIN_WATER_M of water)
// within its half-width, its sides rising to the lake's level over
// BASIN_SIDE_M or BASIN_SIDE_SCALE half-widths, whichever is wider; it
// sets in over BASIN_EDGE_M from the waterline (the natural depth over the
// ground's slope). Set in by the depth or by the distance inside the
// lake's mask (whose edge can lie metres beyond the waterline on a steep
// shore) it dropped 1.5-3 m within a few metres: a step that drew teeth
// along the shore on the 1 m grid.
const BASIN_WATER_M = 1.5;
const BASIN_SIDE_M = 30;
const BASIN_SIDE_SCALE = 1.5;
const BASIN_EDGE_M = 16;
const CONTAIN = RIVER_SECTION.contain;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the shore materials
 * @returns {string} WGSL: riverCarveTerrain_d(natural, excavated, unitDir), riverCarveMicroKeep(unitDir)
 */
export function createRiverCarveWgsl({ enabled = true, bankDetail = false } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River carve off in this shader (riverCarve.wgsl.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveTerrain_d(natural: vec4<f32>, excavated: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return excavated; }
fn riverCarveMicroKeep(unitDir: vec3<f32>, heightM: f32) -> f32 { return 1.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
`;
    }
    return /* wgsl */`
// ==================== River corridors (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
${createRiverSectionWgsl({ scalar: false, dual: true })}

// River segments that can reach unitDir: first << 8 | count (count 0: none).
fn riverCarveCellEntry(unitDir: vec3<f32>) -> u32 {
    if (waterParams.gridN == 0u || waterParams.carve.x < 0.5 || !terrainFeatureOn(TF_WATER_CARVE)) { return 0u; }
    return waterRiverList(unitDir);
}

// How far the segment acts: channel, banks, blend into the terrain.
fn riverCarveReach(p: WaterRiverPt) -> f32 {
    return p.hw + ${RIVER_SECTION.reachM.toFixed(1)};
}

// A segment's values at unitDir as height duals (d/d unitDir): offset n
// from the channel's centre, half-width, level, thalweg, bank-full depth D
// and the water's level.
struct RiverCarveDuals { n: vec4<f32>, hw: vec4<f32>, eta: vec4<f32>, bed: vec4<f32>, D: vec4<f32>, wl: vec4<f32>, };
fn riverCarveDuals(s: WaterRiverSeg, p: WaterRiverPt) -> RiverCarveDuals {
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir where t follows the point (inside the segment, or past
    // its ends on its extended line; fixed past them otherwise); arc
    // length s = mix(s0, s1, t). Offset from the channel's centre:
    // n = side x (distance from the line) - wobble(s).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.t == p.tRaw);
    let sGrad = (s.s1 - s.s0) * tg;
    let lineGrad = p.v * (R * R / max(p.dLine, 1.0e-3));
    var c: RiverCarveDuals;
    c.n = vec4<f32>(p.n, p.nSign * lineGrad - p.dOff * sGrad);
    c.hw = vec4<f32>(p.hw, p.dHw * sGrad);
    c.eta = vec4<f32>(p.eta, p.dEta * sGrad);
    c.bed = vec4<f32>(p.bed, p.dBed * sGrad);
    c.D = (c.eta - c.bed) * (1.0 / max(waterParams.carve.w, 0.05));
    c.wl = vec4<f32>(p.wl, p.dWl * sGrad);
    return c;
}

// The containment floor of the segment at unitDir (riverSection.js
// riverContainFloor), and how much of its fill applies (0..1): none where
// the river is in a lake, none behind its first point; riverCarveTerrain_d
// adds none on ground below a nearby lake's level (lakeGuard: lake bed and
// shore band, the lake's water covers it). Gating on the river's level
// near the lake instead raised a lake's shallow edge at a mouth above its
// water (the river's level ramps down to the lake's there).
fn riverCarveFloor_d(c: RiverCarveDuals, p: WaterRiverPt) -> vec4<f32> {
    return riverContainFloor_d(c.n, c.hw, c.bed, c.D, p.skew, c.wl, waterRiverBank(p, true), waterRiverBank(p, false));
}
fn riverCarveFloorWeight(s: WaterRiverSeg, p: WaterRiverPt) -> f32 {
    if (s.s0 <= 0.0 && p.tRaw < 0.0) { return 0.0; }
    return clamp(1.0 + p.pool, 0.0, 1.0);
}

// The nearest segment's cross-section at unitDir over the natural ground h0, as a height dual.
// last: s is the river's last segment; lake: riverCarveLakeWater at unitDir.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>, last: bool, lake: vec4<f32>) -> vec4<f32> {
    let c = riverCarveDuals(s, p);
    let nD = c.n;
    let hwD = c.hw;
    let bed = c.bed;
    let D = c.D;
    let ab = s.p1 - s.p0;
    let R = waterParams.planetRadius;
    // Each bank keeps the rim of drawn water next to it (riverBankRim): cut
    // below a lake's level, banks left the lake hanging over lower ground (v85).
    let left = waterRiverBank(p, true);
    let right = waterRiverBank(p, false);
    let fullL = bed.x + riverSideDepth(D.x, left.freeboard);
    let fullR = bed.x + riverSideDepth(D.x, right.freeboard);
    // Where the channel runs into a lake its cut fades in over 2 m of
    // natural ground: over the usual 0.5 m the channel's floor met a steep
    // lake basin in a crease, a hard semicircle at the mouth (owner
    // 2026-10-26).
    let soft = mix(${RIVER_SECTION.softM.toFixed(2)}, 2.0, max(clamp(-p.pool, 0.0, 1.0), p.guardW));
    var h = riverSection_d(nD, hwD, bed, D, p.skew, h0, riverBankRim(left, p.rimL, fullL), riverBankRim(right, p.rimR, fullR), soft);
    // In a lake (its source or its destination: the coarse flag, pool -1
    // ramping over the segment where it changes, or beside the lake,
    // guardW) the river's end widens under the lake's drawn water into a
    // basin at its bed's depth, at least ${BASIN_WATER_M} m of water, its sides rising
    // gently to the lake's level: no groove's walls, and no shelf to cross.
    // Its cut faded out within 12 m of the shore instead, a delta's channel
    // was a moat 2-3 m deep ending in a wall on a lake's shelf 0.1-1 m deep;
    // a shelf at a river's end read as a mud border, an outlet's arm 0.4 m
    // deep as a muddy delta (owner 2026-10-28). Only ground already under the
    // water is lowered, so the shoreline stays (lake: as far as its bed
    // goes, riverCarveUnderLake). Where no lake is drawn (the sea, lakes not
    // solved) the cut fades out once the lake's own bed is as deep as the
    // channel or 12 m from the shore (the depth over the natural ground's
    // slope); by distance alone a channel ran on as a groove, over 0.15 m of
    // depth it ended in an underwater wall (owner 2026-10-26). Duals, so the
    // normals follow.
    let inLakeFlag = max(clamp(-p.pool, 0.0, 1.0), p.guardW);
    if (inLakeFlag > 0.0) {
        let lakeLevel = select(p.wl, p.lakeGuard, p.lakeGuard > -1.0e10);
        let gT = h0.yzw - unitDir * dot(h0.yzw, unitDir);
        let slope = max(length(gT) / R, 0.02);
        let lakeDepth = dMax(vec4<f32>(lakeLevel - h0.x, -h0.yzw), dConst(0.0));
        let byShore = dSmoothstep(0.0, 12.0, lakeDepth * (1.0 / slope));
        let byDepth = dSmoothstep(0.0, max(D.x, 0.5), lakeDepth);
        // Only in the lake (pool): beside a drawn lake, past its edge, it
        // filled an outlet's channel into a sill 0.9 m high (owner 2026-10-28).
        let inLake = dMax(byShore, byDepth) * (clamp(-p.pool, 0.0, 1.0) * (1.0 - lake.x));
        if (inLake.x > 0.0) { h = h0 + dMul(h - h0, dConst(1.0) - inLake); }
        if (lake.x > 0.0) {
            let fromShore = vec4<f32>(lake.y - h0.x, -h0.yzw) * (1.0 / slope);
            let wet = dSmoothstep(0.0, ${BASIN_EDGE_M.toFixed(1)}, fromShore) * (min(lake.w, smoothstep(0.0, 8.0, lake.z)) * inLakeFlag);
            let side = riverRamp_d((nD * select(-1.0, 1.0, nD.x >= 0.0) - hwD) * (1.0 / max(${BASIN_SIDE_M.toFixed(1)}, hwD.x * ${BASIN_SIDE_SCALE.toFixed(1)})));
            let floorB = dSmoothMin(bed, dConst(lake.y - ${BASIN_WATER_M.toFixed(1)}), 0.5);
            let basin = floorB + dMul(dConst(lake.y + 0.5) - floorB, side);
            // At the basin where deeper than 0.25 m (the cut's corner
            // rounded over 0.5 m): 0.25 m above it, the river's narrower
            // channel showed through as a groove 0.15 m deep along its line.
            let lowered = h0 - riverSoftCutK_d(h0 - basin + dConst(0.25), 0.5);
            h += dMul(select(h, lowered, lowered.x < h.x) - h, wet);
        }
    }
    // Past a river's last point into its lake the cut fades out as behind
    // its first: a round cap at full depth ended the channel in a bowl wall,
    // a hard semicircle in the lake bed at the mouth (owner 2026-10-26).
    if (last && s.pool1 < -0.5 && p.tRaw > 1.0) {
        let Le = length(ab) * R;
        let past = vec4<f32>((p.tRaw - 1.0) * Le, ab * (Le / max(dot(ab, ab), 1.0e-20)));
        h = h0 + dMul(h - h0, dConst(1.0) - dSmoothstep(0.0, ${START_FADE_M.toFixed(1)}, past));
    }
    // Behind the river's first point (in its source lake) the cut fades out
    // over ${START_FADE_M} m. Ending it on a line there stepped up to 2.4 m where
    // the line reached land (water-look v76); a full rounded cap made a false inlet.
    if (s.s0 > 0.0 || p.tRaw >= 0.0) { return h; }
    let L = length(ab) * R;
    let behind = vec4<f32>(-p.tRaw * L, ab * (-L / max(dot(ab, ab), 1.0e-20)));
    let w = dConst(1.0) - dSmoothstep(0.0, ${START_FADE_M.toFixed(1)}, behind);
    return h0 + dMul(h - h0, w);
}

// Each river's section from its closest traced segment (as waterRiverAt),
// blended into its neighbours' toward their joints (waterRiverJoints),
// the lowest of the rivers'. Every section only cuts, so the ground stays
// continuous where two rivers' banks meet; the closest river's section alone
// stepped along the line where the closest river changes (4 m where a
// tributary hangs above its trunk, water-look v70). Blending endpoint caps
// by radial distance made the terrain depend on sampling density: extra
// short waterfall segments pulled upstream banks below their water. A
// cell's list holds each river's segments together (WaterGpuData.js).
fn riverCarveTerrain_d(natural: vec4<f32>, hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    let maxH = maxTerrainHeightM();
    let h0 = hd * maxH;
    var h = h0;
    let original = natural * maxH;
    var fine = original;
    var valleyWeight = dConst(1.0);
    let excavated = h0.x < original.x;
    // The lake's water here (riverCarveLakeWater), looked up once, for the
    // first river reaching a lake.
    var lakeW = vec4<f32>(0.0, -1.0e20, 0.0, 0.0);
    var lakeKnown = false;
    // Each river's containment floor, its weight, and how far the point is
    // beyond its channel's edge (a floor never fills another river's channel).
    var floors: array<vec4<f32>, ${MAX_FLOORS}>;
    var floorWater: array<vec4<f32>, ${MAX_FLOORS}>;
    var floorWeight: array<f32, ${MAX_FLOORS}>;
    var floorLake: array<f32, ${MAX_FLOORS}>;
    var floorGuardW: array<f32, ${MAX_FLOORS}>;
    var beyond: array<f32, ${MAX_FLOORS}>;
    var nFloors = 0u;
    var k = 0u;
    loop {
        if (k >= count) { break; }
        let river = waterRivers[first + k].river;
        let runStart = first + k;
        var bestK = first + k;
        var bestD = 1.0e30;
        loop {
            if (k >= count) { break; }
            let sg = waterRivers[first + k];
            if (sg.river != river) { break; }
            let ab = sg.p1 - sg.p0;
            let t = clamp(dot(unitDir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
            let dd = length(unitDir - (sg.p0 + ab * t));
            if (dd < bestD) { bestD = dd; bestK = first + k; }
            k++;
        }
        let s = waterRivers[bestK];
        let reach = max(s.hw0, s.hw1) * (1.0 + waterParams.shape.y) + ${RIVER_SECTION.reachM.toFixed(1)} + 1.0;
        if (bestD * waterParams.planetRadius >= reach) { continue; }
        let p = waterRiverPointAt(bestK, runStart, first + k, unitDir, false);
        if (p.d >= riverCarveReach(p)) { continue; }
        let js = waterRiverJoints(bestK, runStart, first + k, s, unitDir);
        let wUp = vec4<f32>(js.up.w, js.up.dw);
        let wDown = vec4<f32>(js.down.w, js.down.dw);
        let up = js.up.w > 0.0;
        let down = js.down.w > 0.0;
        let sUp = waterRivers[js.up.k];
        let sDown = waterRivers[js.down.k];
        var pb = p;
        var pUp = p;
        var pDown = p;
        if (up || down) { pb = waterRiverPointAt(bestK, runStart, first + k, unitDir, true); }
        if (up) { pUp = waterRiverPointAt(js.up.k, runStart, first + k, unitDir, true); }
        if (down) { pDown = waterRiverPointAt(js.down.k, runStart, first + k, unitDir, true); }
        let last = !(bestK + 1u < first + k && waterRiverRunsInto(s, waterRivers[bestK + 1u]));
        if (!lakeKnown && (max(pb.pool, max(pUp.pool, pDown.pool)) < 0.0 || max(pb.guardW, max(pUp.guardW, pDown.guardW)) > 0.0)) {
            lakeW = riverCarveLakeWater(unitDir, h0.x);
            lakeKnown = true;
        }
        let c0 = riverCarveSegment_d(s, pb, unitDir, h0, last, lakeW);
        var c = c0;
        if (up) { c += dMul(riverCarveSegment_d(sUp, pUp, unitDir, h0, false, lakeW) - c0, wUp); }
        if (down) { c += dMul(riverCarveSegment_d(sDown, pDown, unitDir, h0, false, lakeW) - c0, wDown); }
        if (c.x < h.x) { h = c; }
        if (nFloors < ${MAX_FLOORS}u) {
            let cd = riverCarveDuals(s, pb);
            let floor0 = riverCarveFloor_d(cd, pb);
            var floor = floor0;
            var water = cd.wl;
            if (up) {
                let co = riverCarveDuals(sUp, pUp);
                floor += dMul(riverCarveFloor_d(co, pUp) - floor0, wUp);
                water += dMul(co.wl - cd.wl, wUp);
            }
            if (down) {
                let co = riverCarveDuals(sDown, pDown);
                floor += dMul(riverCarveFloor_d(co, pDown) - floor0, wDown);
                water += dMul(co.wl - cd.wl, wDown);
            }
            floors[nFloors] = floor;
            floorWater[nFloors] = water;
            floorWeight[nFloors] = riverCarveFloorWeight(s, p);
            var gw = pb.guardW;
            var lg = pb.lakeGuard;
            if (up) { gw += (pUp.guardW - pb.guardW) * js.up.w; lg = max(lg, pUp.lakeGuard); }
            if (down) { gw += (pDown.guardW - pb.guardW) * js.down.w; lg = max(lg, pDown.lakeGuard); }
            floorLake[nFloors] = lg;
            floorGuardW[nFloors] = gw;
            beyond[nFloors] = p.d - p.hw;
            nFloors++;
        }
        if (excavated) {
            // The coarse valley field can interpolate a downstream cut into
            // an upstream bank. Near the channel, use the fine section cut
            // from the original terrain instead. This restores excavation;
            // it never constructs a bank above the original ground.
            let section0 = riverCarveSegment_d(s, pb, unitDir, original, last, lakeW);
            var section = section0;
            if (up) { section += dMul(riverCarveSegment_d(sUp, pUp, unitDir, original, false, lakeW) - section0, wUp); }
            if (down) { section += dMul(riverCarveSegment_d(sDown, pDown, unitDir, original, false, lakeW) - section0, wDown); }
            if (section.x < fine.x) { fine = section; }
            let ab = s.p1 - s.p0;
            let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
            let sg = (s.s1 - s.s0) * tg;
            let lineGrad = p.v * (waterParams.planetRadius * waterParams.planetRadius / max(p.dLine, 1.0e-3));
            let grad = sign(p.n) * (p.nSign * lineGrad - p.dOff * sg) - p.dHw * sg;
            let edge = vec4<f32>(p.d - p.hw, grad);
            // Over ${MICRO_RETURN_M} m the valley's lower ground beside a reach left
            // its banks standing as a levee, a wall 4-6 m high (owner
            // 2026-10-28): its ~64 m texels carry an uphill bank's cut across
            // the river, and a steep stream's bank takes its level from a
            // lower reach downstream (riverLandscape.js). Over ${VALLEY_RETURN_M} m it is a slope.
            let weight = dSmoothstep(${(MICRO_RETURN_M * 0.5).toFixed(1)}, ${VALLEY_RETURN_M.toFixed(1)}, edge);
            if (weight.x < valleyWeight.x) { valleyWeight = weight; }
        }
    }
    if (excavated) { h = fine + dMul(h - fine, valleyWeight); }
    // Containment (riverSection.js riverContainedHeight): raise the ground
    // toward the highest floor, where it applies; never under a lake's drawn
    // water (riverCarveUnderLake): where a river leaves its lake the guard
    // fades over a segment, and the floor raised the lake's shallow edge
    // 0.7 m into two knobs beside the outlet (owner 2026-10-27). The weights
    // are taken as constant (their change along a river and across a junction is slow).
    var fill = dConst(0.0);
    let dry = select(1.0, 1.0 - riverCarveUnderLake(unitDir, h.x), nFloors > 0u);
    for (var i = 0u; i < nFloors; i++) {
        let lake = floorLake[i];
        var w = dry * floorWeight[i] * mix(1.0, smoothstep(lake - 0.1, lake + 0.2, h.x), select(floorGuardW[i], 0.0, lake < -1.0e10));
        for (var j = 0u; j < nFloors; j++) {
            if (j != i) { w = min(w, smoothstep(0.0, ${CONTAIN.riseM.toFixed(1)}, beyond[j])); }
        }
        if (w <= 0.0) { continue; }
        let f = riverContainFill_d(floors[i], h, floorWater[i]) * w;
        if (f.x > fill.x) { fill = f; }
    }
    return (h + fill) / maxH;
}

fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    return riverCarveTerrain_d(hd, hd, unitDir);
}

// Share of the per-tile micro detail kept at unitDir (ground at heightM): 0
// in the channel, back to 1 by MICRO_RETURN_M beyond it (the banks keep the
// terrain's detail). Only where the river cuts one: not in its lake (pool
// -1), where it is too shallow to (a held outlet, riverLakeHold) nor under a
// lake's water (riverCarveUnderLake). Taken there, the detail left a smooth
// strip that drew the river's line down a bay, and the rim of a mouth's
// flare across it (owner 2026-10-27).
fn riverCarveMicroKeep(unitDir: vec3<f32>, heightM: f32) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return 1.0; }
    let first = e >> 8u;
    var keep = 1.0;
    for (var k = 0u; k < count; k++) {
        let p = waterRiverPoint(waterRivers[first + k], unitDir);
        let cuts = smoothstep(0.05, 0.3, p.eta - p.bed) * (1.0 - clamp(-p.pool, 0.0, 1.0));
        keep = min(keep, mix(1.0, smoothstep(p.hw + ${(MICRO_RETURN_M * 0.5).toFixed(1)}, p.hw + ${MICRO_RETURN_M.toFixed(1)}, p.d), cuts));
    }
    if (keep >= 1.0) { return 1.0; }
    return mix(keep, 1.0, riverCarveUnderLake(unitDir, heightM));
}

${bankDetail ? `${createWaterLookupWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
@group(${RIVER_CARVE_GROUP}) @binding(${RIVER_CARVE_BINDINGS.sampler}) var riverCarveLakeSampler: sampler;

fn riverCarveShoreEnabled() -> bool { return waterParams.bank.w > 0.0 && waterParams.enabled != 0u; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    return waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 927.0).x;
}
// Bed / rock (none) / wet toe. This only controls existing splat materials;
// it neither paints a solid colour nor changes water ownership. River and
// lake beds are the same mud (owner 2026-10-25), so a river's bed runs on
// into its lake's; under the lake's water (its first 0.3 m, as far as the
// lake covers the point) the bed is the lake's alone: the river's mud on
// top drew its channel as a line down a shallow bay (owner 2026-10-27).
// Lakes without a solved shore yet count by level (their cells), as the
// lake renderer draws them; looked up 3 m lower so the shore just above the
// water finds its lake.
// How far ground at heightM lies under a lake's drawn water: from its edge
// to 8 m inside it (over its cover's 1 m a bank's fill stepped at the edge:
// a line across a bay), 0.1 m under the level to 0.2 m above. As far as the
// lake's bed goes: not giving way to a river below its level (which water
// is drawn there): over an outlet's last metre, where it falls before the
// rim, the channel's rounded edges stood as ridges 0.5-1 m high 10-18 m
// into the lake (owner 2026-10-28: walls running on past the rim).
fn riverCarveUnderLake(dir: vec3<f32>, heightM: f32) -> f32 {
    return riverCarveLakeWater(dir, heightM).x;
}
// The same (x), that lake's level (y), how far inside its drawn water (z,
// m) and its cover (w).
fn riverCarveLakeWater(dir: vec3<f32>, heightM: f32) -> vec4<f32> {
    let lake = waterLakeHitView(dir, heightM - 0.2, riverCarveLakeSampler, true, false);
    if (lake.level <= WATER_NO_LAKE) { return vec4<f32>(0.0, -1.0e20, 0.0, 0.0); }
    let under = min(lake.cover, smoothstep(0.0, 8.0, lake.insideM)) * (1.0 - smoothstep(lake.level - 0.1, lake.level + 0.2, heightM));
    return vec4<f32>(under, lake.level, lake.insideM, lake.cover);
}
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    if (!riverCarveShoreEnabled()) { return vec3<f32>(0.0); }
    let lake = waterLakeHitView(dir, heightM - 3.0, riverCarveLakeSampler, true, true);
    if (lake.level <= WATER_NO_LAKE) { return riverCarveRiverShore(dir, heightM, slope); }
    let underLake = lake.cover * smoothstep(0.0, 0.3, lake.level - heightM);
    return max(riverCarveRiverShore(dir, heightM, slope) * (1.0 - underLake), vec3<f32>(riverCarveLakeBed(lake.level, dir, heightM, slope), 0.0, 0.0));
}

// Lake beds and the shore beside them, by the distance from the waterline
// (depth over the ground's gradient), varied like the rivers' (0-4 m onto
// the shore over ~35 m, a 2.5-5 m blend). By depth alone (over 0.3 m) the
// edge was finer than the splat grid on gentle shores and drew teeth
// (owner 2026-10-26).
fn riverCarveLakeBed(level: f32, dir: vec3<f32>, heightM: f32, slope: f32) -> f32 {
    let s = clamp(slope, 0.0, 0.99);
    let fromShore = (level - heightM) / max(s / sqrt(1.0 - s * s), 0.02);
    let R = waterParams.planetRadius;
    let nReach = waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 101.0).x;
    let nBlend = waterBankNoise((dir.y + dir.x * 0.47) * R * 0.1, (dir.z + dir.x * 0.29) * R * 0.1, 113.0).x;
    let lobes = 1.5 * waterBankNoise((dir.z + dir.y * 0.37) * R * 0.25, (dir.x + dir.y * 0.61) * R * 0.25, 127.0).x;
    let reach = clamp(2.0 + 2.0 * nReach, 0.0, 4.0);
    let blend = 3.75 + 1.25 * nBlend;
    return smoothstep(-reach - 0.5 * blend, -reach + 0.5 * blend, fromShore + lobes);
}

// The bed and a narrow strip above the waterline are mud (owner 2026-10-24:
// the mixed gravel, dirt and rock bed read as a tiled road).
fn riverCarveRiverShore(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    let e = riverCarveCellEntry(dir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return vec3<f32>(0.0); }
    let first = e >> 8u;
    var best = first;
    var distance = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let sg = waterRivers[first + k];
        let ab = sg.p1 - sg.p0;
        let t = clamp(dot(dir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let d = length(dir - (sg.p0 + ab * t));
        if (d < distance) { distance = d; best = first + k; }
    }
    // Blended across joints as the carve and the water: per segment alone
    // the mud's edge notched at every joint.
    let p = waterRiverBlended(best, first, first + count, dir);
    // On into its lake too: the lake's bed is the same mud under its water
    // (riverCarveLakeBed). Fading out by the coarse in-lake flag left grass
    // between the two where the lake gives way to the falling river, a
    // straight line across an outlet (owner 2026-10-27).
    if (p.d > riverCarveReach(p)) { return vec3<f32>(0.0); }
    // Mud over the channel and out onto the banks, its reach and its blend
    // varied organically: how far it goes beyond the channel's edge (0-8 m,
    // ~75 m and ~15 m along the river), how wide it blends into the
    // ground (2.5-5 m, ~30 m), and its edge moved in and out (~12 m). A
    // constant edge read as a clean line (owner 2026-10-26); lobes of 3-6 m,
    // edges by height or over the outer 15 % of the half-width drew teeth
    // on the splat grid. No rock: its texture showed a grid of 1 m tiles in
    // the bed (owner 2026-10-25).
    let nLong = waterBankNoise(p.s * 0.04, p.n * 0.075, p.river + 17.0).x;
    let nMid = waterBankNoise(p.s * 0.2, p.n * 0.2, p.river + 31.0).x;
    let nBlend = waterBankNoise(p.s * 0.1, p.n * 0.1, p.river + 47.0).x;
    let lobes = 1.5 * waterBankNoise(p.s * 0.25, p.n * 0.25, p.river + 59.0).x;
    let reach = clamp(2.5 + 2.5 * nLong + 1.5 * nMid, 0.0, 8.0);
    let blend = 3.75 + 1.25 * nBlend;
    let edge = p.hw + reach;
    // The channel itself stays mud: the lobes act beyond its edge.
    let dEdge = p.d + lobes * smoothstep(p.hw - 1.0, p.hw + 1.0, p.d);
    let mud = 1.0 - smoothstep(max(p.hw - 0.5, edge - 0.5 * blend), edge + 0.5 * blend, dEdge);
    return vec3<f32>(mud, 0.0, mud * 0.15);
}` : `fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveUnderLake(dir: vec3<f32>, heightM: f32) -> f32 { return 0.0; }
fn riverCarveLakeWater(dir: vec3<f32>, heightM: f32) -> vec4<f32> { return vec4<f32>(0.0, -1.0e20, 0.0, 0.0); }`}
`;
}
