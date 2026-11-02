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
import { junctionFieldSetTerrainWgsl } from './junctionField.wgsl.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
// lakes, masks and sampler: the lake lookup of the shore materials (bankDetail).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3, lakes: 7, masks: 8, sampler: 9 });
// Terrain micro detail returns over this far (m) beyond a river's half-width.
const MICRO_RETURN_M = 8;
// Near water the micro detail may not cross its level (riverCarveMicroAt):
// within MICRO_LEVEL_REACH_M of a river's or mouth's water (none beyond
// twice that), a dip stops MICRO_LEVEL_MARGIN_M above the level and a bump
// as far below it, both rounded over MICRO_LEVEL_SOFT_M; the detail fades
// out within MICRO_LEVEL_FADE_M (height) of the level, so the shoreline
// stays where the carve put it.
const MICRO_LEVEL_REACH_M = 16;
const MICRO_LEVEL_MARGIN_M = 0.1;
const MICRO_LEVEL_SOFT_M = 0.25;
const MICRO_LEVEL_FADE_M = 0.35;
// The cut fades out over this far (m) behind a river's first point, and
// past its last point into a lake.
const START_FADE_M = 30;
// Rivers per point whose containment floor is kept (riverSection.js contain).
const MAX_FLOORS = 6;
// The river valley field (riverValley.wgsl.js) returns over this far (m)
// beyond a river's channel: nearer, the fine section (riverCarveTerrain_d).
const VALLEY_RETURN_M = 60;
const CONTAIN = RIVER_SECTION.contain;
const MOUTH = RIVER_SECTION.mouth;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the shore materials
 * @returns {string} WGSL: riverCarveTerrain_d(natural, excavated, unitDir), riverCarveMicroAt(unitDir, heightM, microM)
 */
export function createRiverCarveWgsl({ enabled = true, bankDetail = false, junctionFields = false } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River carve off in this shader (riverCarve.wgsl.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveTerrain_d(natural: vec4<f32>, excavated: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return excavated; }
fn riverCarveMicroAt(unitDir: vec3<f32>, heightM: f32, microM: f32) -> f32 { return microM; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
`;
    }
    return /* wgsl */`
// ==================== River corridors (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
${createRiverSectionWgsl({ scalar: false, dual: true })}
${junctionFields ? junctionFieldSetTerrainWgsl() : ''}

// River segments that can reach unitDir: first << 8 | count (count 0: none).
fn riverCarveCellEntry(unitDir: vec3<f32>) -> u32 {
    if (waterParams.gridN == 0u || waterParams.carve.x < 0.5 || !terrainFeatureOn(TF_WATER_CARVE)) { return 0u; }
    return waterRiverList(unitDir);
}

// How far the segment acts: channel, banks, blend into the terrain.
fn riverCarveReach(p: WaterRiverPt) -> f32 {
    let base=p.hw+${RIVER_SECTION.reachM.toFixed(1)};
    let m=waterRiverMouthShape(p.mouth,p.mouthArc,p.hw);
    if(m.y<=0.0 || m.w>=${MOUTH.lakeM.toFixed(2)}) {return base;}
    let wet=m.x*sqrt(1.0+${(MOUTH.bankSoftM*.5).toFixed(2)}/max(p.eta-p.bed,.6));
    return max(base,length(vec2<f32>(wet+${MOUTH.bankBlendM.toFixed(2)},${MOUTH.lakeM.toFixed(2)})));
}

// Same conservative support as riverMouthIndexReach in the trace worker.
fn riverCarveSegmentReach(s:WaterRiverSeg)->f32 {
    let hw=max(s.hw0,s.hw1);
    let base=hw*(1.0+waterParams.shape.y)+${RIVER_SECTION.reachM.toFixed(1)}+1.0;
    let m=s.mouth;if(m.z==0.0) {return base;}
    let x0=(s.s0-m.x)*sign(m.z);let x1=(s.s1-m.x)*sign(m.z);
    if(max(x0,x1)<=-m.w || min(x0,x1)>=${MOUTH.lakeM.toFixed(2)}) {return base;}
    let width=hw+abs(m.z)*${MOUTH.widthScale.toFixed(2)}+${MOUTH.widthExtraM.toFixed(2)};
    let depth=max(min(s.eta0-s.bed0,s.eta1-s.bed1),.6);
    let wet=width*sqrt(1.0+${(MOUTH.bankSoftM*.5).toFixed(2)}/depth);
    return max(base,length(vec2<f32>(wet+${MOUTH.bankBlendM.toFixed(2)},${MOUTH.lakeM.toFixed(2)})));
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

fn riverCarveMouthWidth_d(s: WaterRiverSeg, p: WaterRiverPt) -> vec4<f32> {
    let c = riverCarveDuals(s,p);
    let m = p.mouth;
    if (m.z == 0.0) { return c.hw; }
    let ab = s.p1-s.p0;
    let arc = vec4<f32>(p.mouthArc,ab*((s.s1-s.s0)/max(dot(ab,ab),1.0e-20)));
    let x = (arc-dConst(m.x))*sign(m.z);
    if(x.x<=-max(m.w,1.0)) {return c.hw;}
    return c.hw + dSmoothstep(-max(m.w,1.0), ${(MOUTH.lakeM*.65).toFixed(2)}, x) * (abs(m.z)*${MOUTH.widthScale.toFixed(2)}+${MOUTH.widthExtraM.toFixed(2)});
}

fn riverCarveEdge_d(s: WaterRiverSeg,p: WaterRiverPt,dir: vec3<f32>) -> vec4<f32> {
    let c=riverCarveDuals(s,p);
    let edge=c.n*select(-1.0,1.0,c.n.x>=0.0)-c.hw;
    let m=p.mouth;
    if(m.z==0.0) {return edge;}
    let ab=s.p1-s.p0;
    let grad=ab*((s.s1-s.s0)/max(dot(ab,ab),1.0e-20));
    let x=(vec4<f32>(p.mouthArc,grad)-dConst(m.x))*sign(m.z);
    let influence=dSmoothstep(-max(m.w,1.0),-.15*max(m.w,1.0),x);
    if(influence.x<=0.0) {return edge;}
    let left=normalize(cross(s.p0,ab));
    let n=vec4<f32>(dot(dir-s.p0,left)*waterParams.planetRadius-(p.nSign*p.dLine-p.n),left*waterParams.planetRadius-p.dOff*grad);
    let mouthEdge=n*select(-1.0,1.0,n.x>=0.0)-riverCarveMouthWidth_d(s,p);
    return edge+dMul(mouthEdge-edge,influence);
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

// Full junction cut, also used to bypass the ordinary bank profile once
// the fan has complete influence.
fn riverCarveFan_d(s:WaterRiverSeg,p:WaterRiverPt,c:RiverCarveDuals,unitDir:vec3<f32>,h0:vec4<f32>)->vec4<f32> {
    let ab=s.p1-s.p0;let R=waterParams.planetRadius;
    let arcGrad=ab*((s.s1-s.s0)/max(dot(ab,ab),1.0e-20));
    let x=(vec4<f32>(p.mouthArc,arcGrad)-dConst(p.mouth.x))*sign(p.mouth.z);
    let width=riverCarveMouthWidth_d(s,p);
    let depth=dMax(c.eta-c.bed,dConst(.6));
    let left=normalize(cross(s.p0,ab));
    let n=vec4<f32>(dot(unitDir-s.p0,left)*R-(p.nSign*p.dLine-p.n),left*R-p.dOff*arcGrad);
    let u=dDiv(n,width);
    let profile=c.wl-depth+dMul(depth,dMul(u,u));
    let cut=riverSoftCutK_d(h0-profile+dConst(${(MOUTH.bankSoftM*.5).toFixed(2)}),${MOUTH.bankSoftM.toFixed(2)});
    let wet=dMul(width,dSqrt(dConst(1.0)+dDiv(dConst(${(MOUTH.bankSoftM*.5).toFixed(2)}),depth)));
    let edge=n*select(-1.0,1.0,n.x>=0.0)-wet;
    let across=dConst(1.0)-dSmoothstep(0.0,${MOUTH.bankBlendM.toFixed(2)},edge);
    return h0-dMul(dMul(cut,across),dConst(1.0)-dSmoothstep(0.0,${MOUTH.lakeM.toFixed(2)},x));
}

// The nearest segment's cross-section at unitDir over the natural ground h0, as a height dual.
// last: s is the river's last segment; lake: riverCarveLakeWater at unitDir.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>, last: bool, lake: vec4<f32>) -> vec4<f32> {
    let c = riverCarveDuals(s, p);
    var mouthInfluence=dConst(0.0);
    if(p.mouth.z!=0.0) {
        let m=p.mouth;let ab=s.p1-s.p0;
        let x=(vec4<f32>(p.mouthArc,ab*((s.s1-s.s0)/max(dot(ab,ab),1.0e-20)))-dConst(m.x))*sign(m.z);
        mouthInfluence=dSmoothstep(-max(m.w,1.0),-.15*max(m.w,1.0),x);
        if(mouthInfluence.x>=1.0) {return riverCarveFan_d(s,p,c,unitDir,h0);}
    }
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
    if (s.s0 <= 0.0 && p.tRaw < 0.0) {
        let L = length(ab) * R;
        let behind = vec4<f32>(-p.tRaw * L, ab * (-L / max(dot(ab, ab), 1.0e-20)));
        h = h0 + dMul(h - h0, dConst(1.0) - dSmoothstep(0.0, ${START_FADE_M.toFixed(1)}, behind));
    }
    if(mouthInfluence.x>0.0) {
        h+=dMul(riverCarveFan_d(s,p,c,unitDir,h0)-h,mouthInfluence);
    }
    return h;
}

// Segment j's share over segment j - 1 of the list at dir (x) and its
// gradient: the joint blend's weight (waterRiverJointAt) seen from j's
// side. Past a joint that barely turns a plain switch at its bisector
// plane; between list entries that do not join, to the nearer one.
fn riverCarveJointShare(j: u32, dir: vec3<f32>) -> vec4<f32> {
    let a = waterRivers[j - 1u];
    let b = waterRivers[j];
    if (!waterRiverRunsInto(a, b)) {
        let ta = clamp(dot(dir - a.p0, a.p1 - a.p0) / max(dot(a.p1 - a.p0, a.p1 - a.p0), 1.0e-20), 0.0, 1.0);
        let tb = clamp(dot(dir - b.p0, b.p1 - b.p0) / max(dot(b.p1 - b.p0, b.p1 - b.p0), 1.0e-20), 0.0, 1.0);
        let nearer = length(dir - (b.p0 + (b.p1 - b.p0) * tb)) < length(dir - (a.p0 + (a.p1 - a.p0) * ta));
        return vec4<f32>(select(0.0, 1.0, nearer), vec3<f32>(0.0));
    }
    let ua = normalize(a.p1 - a.p0);
    let ub = normalize(b.p1 - b.p0);
    let nb = normalize(ua + ub);
    let R = waterParams.planetRadius;
    let x0 = dot(dir - a.p1, nb) * R;
    let past = select(0.0, 1.0, x0 > 0.0);
    let turnW = smoothstep(1.4e-5, 1.5e-4, 1.0 - dot(ua, ub));
    let band = 0.5 * min(a.s1 - a.s0, b.s1 - b.s0);
    if (turnW <= 0.0 || band <= 0.0) { return vec4<f32>(past, vec3<f32>(0.0)); }
    let x = clamp(x0 / band, -1.0, 1.0);
    let w = 0.5 + 0.5 * (3.0 * x * abs(x) - 2.0 * x * x * x);
    let dw = select(vec3<f32>(0.0), nb * (R / band) * (0.5 * (6.0 * abs(x) - 6.0 * x * x)), abs(x0) < band);
    return vec4<f32>(mix(past, w, turnW), dw * turnW);
}
// Where dir lies along the run [runStart, runEnd) of one river's segments
// (x: 0 on the first, i + f between segments i and i + 1) and its gradient:
// the sum of every joint's share. Alone at a joint it gives the joint
// blend (half the shorter segment either side). Bands widening away from
// the river (to soften slope changes far out) drew zipper lines and
// straight cracks up hillsides: a point's sum then depends on joints whose
// segments its cell may not list (owner 2026-11-02).
fn riverCarveStation(runStart: u32, runEnd: u32, dir: vec3<f32>) -> vec4<f32> {
    var station = vec4<f32>(0.0);
    for (var j = runStart + 1u; j < runEnd; j++) { station += riverCarveJointShare(j, dir); }
    return station;
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
    ${junctionFields ? `if(waterParams.gridN==0u||waterParams.carve.x<.5||!terrainFeatureOn(TF_WATER_CARVE)){return hd;}
    if(junctionTerrainCore(unitDir)) {
        let scale=maxTerrainHeightM();
        return junctionTerrainAt(natural*scale,natural*scale,unitDir)/scale;
    }` : ''}
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { ${junctionFields ? 'let scale=maxTerrainHeightM();return junctionTerrainAt(hd*scale,natural*scale,unitDir)/scale;' : 'return hd;'} }
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
        let reach=riverCarveSegmentReach(s);
        if (bestD * waterParams.planetRadius >= reach) { continue; }
        let p = waterRiverPointAt(bestK, runStart, first + k, unitDir, false);
        if (p.d >= riverCarveReach(p)) { continue; }
        // Where along its run the point lies (riverCarveStation): blend the
        // sections of the two segments it lies between.
        let station = riverCarveStation(runStart, first + k, unitDir);
        let iA = runStart + u32(clamp(floor(station.x), 0.0, f32(first + k - runStart - 1u)));
        let iB = min(iA + 1u, first + k - 1u);
        let t = clamp(station.x - f32(iA - runStart), 0.0, 1.0);
        let blend = iB != iA && t > 0.0 && t < 1.0;
        let wB = vec4<f32>(t, select(vec3<f32>(0.0), station.yzw, blend));
        let sA = waterRivers[iA];
        let sB = waterRivers[iB];
        var pA = p;
        if (blend || iA != bestK) { pA = waterRiverPointAt(iA, runStart, first + k, unitDir, true); }
        var pB = pA;
        if (blend) { pB = waterRiverPointAt(iB, runStart, first + k, unitDir, true); }
        let lastA = !(iA + 1u < first + k && waterRiverRunsInto(sA, waterRivers[iA + 1u]));
        let lastB = !(iB + 1u < first + k && waterRiverRunsInto(sB, waterRivers[iB + 1u]));
        if (!lakeKnown && (max(pA.pool, pB.pool) < 0.0 || max(pA.lakeGuard, pB.lakeGuard) > -1.0e10)) {
            lakeW = riverCarveLakeWater(unitDir, h0.x);
            lakeKnown = true;
        }
        let c0 = riverCarveSegment_d(sA, pA, unitDir, h0, lastA, lakeW);
        var c = c0;
        if (blend) { c += dMul(riverCarveSegment_d(sB, pB, unitDir, h0, lastB, lakeW) - c0, wB); }
        if (c.x < h.x) { h = c; }
        if (nFloors < ${MAX_FLOORS}u) {
            let cd = riverCarveDuals(sA, pA);
            let floor0 = riverCarveFloor_d(cd, pA);
            var floor = floor0;
            var water = cd.wl;
            if (blend) {
                let co = riverCarveDuals(sB, pB);
                floor += dMul(riverCarveFloor_d(co, pB) - floor0, wB);
                water += dMul(co.wl - cd.wl, wB);
            }
            floors[nFloors] = floor;
            floorWater[nFloors] = water;
            floorWeight[nFloors] = riverCarveFloorWeight(s, p) * (1.0 - waterRiverMouthShape(pA.mouth, pA.mouthArc, pA.hw).y);
            var gw = pA.guardW;
            var lg = pA.lakeGuard;
            if (blend) { gw += (pB.guardW - pA.guardW) * t; lg = max(lg, pB.lakeGuard); }
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
            let section0 = riverCarveSegment_d(sA, pA, unitDir, original, lastA, lakeW);
            var section = section0;
            if (blend) { section += dMul(riverCarveSegment_d(sB, pB, unitDir, original, lastB, lakeW) - section0, wB); }
            if (section.x < fine.x) { fine = section; }
            // The valley handover uses the same blend as the sections above:
            // the nearest segment alone gives a different width/wobble on
            // either side of a bend's bisector, stepping the handover even
            // when both section heights agree.
            let edge0 = riverCarveEdge_d(sA, pA, unitDir);
            var edge = edge0;
            if (blend) { edge += dMul(riverCarveEdge_d(sB, pB, unitDir) - edge0, wB); }
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
    return ${junctionFields ? 'junctionTerrainAt(h+fill,natural*maxH,unitDir)' : '(h + fill)'} / maxH;
}

fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    return riverCarveTerrain_d(hd, hd, unitDir);
}

fn riverMicroSmin(a: f32, b: f32, k: f32) -> f32 {
    let h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

// The per-tile micro detail (microM, m) at unitDir over carved ground at
// heightM. None in a river's channel, back by MICRO_RETURN_M beyond it (the
// banks keep the terrain's detail). Only where the river cuts one: not in
// its lake (pool -1), where it is too shallow to (a held outlet,
// riverLakeHold) nor under a lake's water (riverCarveUnderLake). Taken
// there, the detail left a smooth strip that drew the river's line down a
// bay (owner 2026-10-27). Near the water (a river's or its mouth fan's
// level, a junction field's) the detail may not cross the level: switched
// off over a mouth's whole fan instead, it left the banks smooth as plastic
// around every mouth; kept as it was, its dips held puddles (2026-11-01).
fn riverCarveMicroAt(unitDir: vec3<f32>, heightM: f32, microM: f32) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    let first = e >> 8u;
    var keep = 1.0;
    // The nearest water's level (x) and how much it holds the detail (y).
    var level = vec2<f32>(0.0, 0.0);
    var nearest = 1.0e20;
    for (var k = 0u; k < count; k++) {
        let s = waterRivers[first+k];
        let p = waterRiverPoint(s, unitDir);
        let cuts = smoothstep(0.05, 0.3, p.eta - p.bed) * (1.0 - clamp(-p.pool, 0.0, 1.0));
        keep = min(keep, mix(1.0, smoothstep(p.hw + ${(MICRO_RETURN_M * 0.5).toFixed(1)}, p.hw + ${MICRO_RETURN_M.toFixed(1)}, p.d), cuts));
        let edge = p.d - waterRiverMouthShape(p.mouth, p.mouthArc, p.hw).x;
        if (edge < nearest) {
            nearest = edge;
            level = vec2<f32>(p.wl, 1.0 - smoothstep(${MICRO_LEVEL_REACH_M.toFixed(1)}, ${(2 * MICRO_LEVEL_REACH_M).toFixed(1)}, edge));
        }
    }
    if (keep < 1.0 || level.y > 0.0) {
        let lake = riverCarveLakeWater(unitDir, heightM);
        keep = mix(keep, 1.0, lake.x);
        // The level of the water drawn here: the river's surface over its
        // footprint (a mouth's whole fan), else the lake's. The highest of
        // them made the banks beside an outlet, below its lake's level but
        // above the river's, count as under water: their dips held puddles.
        let drawn = riverCarveDrawnRiverLevel(unitDir);
        if (drawn.y > 0.0) {
            level = vec2<f32>(drawn.x, 1.0);
        } else if (lake.w > 0.0) {
            level = vec2<f32>(mix(level.x, lake.y, lake.w), max(level.y, lake.w));
        }
    }
    let m = microM * keep;
    if (level.y <= 0.0) { return m; }
    let d = heightM - level.x;
    let room = max(abs(d) - ${MICRO_LEVEL_MARGIN_M.toFixed(2)}, 0.0);
    // Above the water a dip stops short of it; below, a bump.
    var held = select(-riverMicroSmin(-m, room, ${MICRO_LEVEL_SOFT_M.toFixed(2)}), riverMicroSmin(m, room, ${MICRO_LEVEL_SOFT_M.toFixed(2)}), d < 0.0);
    held *= smoothstep(0.0, ${MICRO_LEVEL_FADE_M.toFixed(2)}, abs(d));
    return mix(m, held, level.y);
}

${bankDetail ? `${createWaterLookupWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
@group(${RIVER_CARVE_GROUP}) @binding(${RIVER_CARVE_BINDINGS.sampler}) var riverCarveLakeSampler: sampler;

fn riverCarveShoreEnabled() -> bool { return waterParams.bank.w > 0.0 && waterParams.enabled != 0u; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    return waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 927.0).x;
}
// Bed mud / rock (none) / reserved (zero). This controls existing splat materials;
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
// The level (x) of the river surface drawn at dir, if one is (y = 1).
fn riverCarveDrawnRiverLevel(dir: vec3<f32>) -> vec2<f32> {
    let hit = waterRiverSurfaceAt(dir);
    return select(vec2<f32>(0.0), vec2<f32>(hit.etaM, 1.0), hit.near);
}
// The same (x), that lake's level (y), how far inside its drawn water (z,
// m) and its cover (w).
fn riverCarveLakeWater(dir: vec3<f32>, heightM: f32) -> vec4<f32> {
    // Look above the waterline for the rounded mouth. Its shore envelope
    // has already reached zero before this lookup ceases to find the lake.
    let lake = waterLakeHitView(dir, heightM - ${MOUTH.lookupAboveM.toFixed(2)}, riverCarveLakeSampler, true, false);
    if (lake.level <= WATER_NO_LAKE) { return vec4<f32>(0.0, -1.0e20, 0.0, 0.0); }
    let under = min(lake.cover, smoothstep(0.0, 8.0, lake.insideM)) * (1.0 - smoothstep(lake.level - 0.1, lake.level + 0.2, heightM));
    return vec4<f32>(under, lake.level, lake.insideM, lake.cover);
}
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    if (!riverCarveShoreEnabled()) { return vec3<f32>(0.0); }
    let lake = waterLakeHitView(dir, heightM - 3.0, riverCarveLakeSampler, true, true);
    if (lake.level <= WATER_NO_LAKE) { return riverCarveRiverShore(dir, heightM, slope); }
    let underLake = lake.cover * smoothstep(0.0, 0.3, lake.level - heightM);
    let river = riverCarveRiverShore(dir, heightM, slope) * (1.0 - underLake);
    let shore = riverCarveLakeShore(lake.level, dir, heightM, slope) * lake.cover;
    // These shares already fade against one another. Taking their maximum
    // left a light material seam where each contributed half.
    let mud = min(1.0, river.x + shore.x);
    return vec3<f32>(mud, 0.0, 0.0);
}

// Mud belongs below the water. Leave the visible waterline grassy, then
// transition to the shared mud bed over submerged depth. The lateral gate
// also keeps a higher river's mud off dry land beside a lake mouth.
fn riverCarveShoreProfile(inlandM: f32, depthM: f32, variation: f32) -> vec3<f32> {
    let v = clamp(0.5 + 0.5 * variation, 0.0, 1.0);
    let start = mix(${RIVER_SECTION.shore.mudStartDepthM[0].toFixed(2)}, ${RIVER_SECTION.shore.mudStartDepthM[1].toFixed(2)}, v);
    let full = mix(${RIVER_SECTION.shore.mudFullDepthM[0].toFixed(2)}, ${RIVER_SECTION.shore.mudFullDepthM[1].toFixed(2)}, v);
    let mud = smoothstep(start, full, depthM) * (1.0 - smoothstep(0.0, 0.25, inlandM));
    return vec3<f32>(mud, 0.0, 0.0);
}

// Lake distance from the waterline is depth over the ground's gradient.
// Broad noise varies the depth of the submerged mud transition.
fn riverCarveLakeShore(level: f32, dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    let s = clamp(slope, 0.0, 0.99);
    let fromShore = (level - heightM) / max(s / sqrt(1.0 - s * s), 0.02);
    let R = waterParams.planetRadius;
    let nReach = waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 101.0).x;
    let nBlend = waterBankNoise((dir.y + dir.x * 0.47) * R * 0.1, (dir.z + dir.x * 0.29) * R * 0.1, 113.0).x;
    return riverCarveShoreProfile(-fromShore, level - heightM, 0.65 * nReach + 0.35 * nBlend);
}
fn riverCarveLakeBed(level: f32, dir: vec3<f32>, heightM: f32, slope: f32) -> f32 {
    return riverCarveLakeShore(level, dir, heightM, slope).x;
}

// The submerged bed shares the lake mud; grass reaches the visible
// waterline (owner 2026-10-29).
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
    // The junction replaced the narrow channel with a wide fan. Its bed
    // material must follow that same wet footprint; the old channel-only
    // material left angular patches of submerged grass beside a mud strip.
    let mouth=waterRiverMouthShape(p.mouth,p.mouthArc,p.hw);
    var fan=vec3<f32>(0.0);
    if(mouth.y>0.0) {
        let seg=waterRivers[best];let ab=seg.p1-seg.p0;
        let n=dot(dir-seg.p0,normalize(cross(seg.p0,ab)))*waterParams.planetRadius-(p.nSign*p.dLine-p.n);
        let edge=mouth.x*sqrt(1.0+${(MOUTH.bankSoftM*.5).toFixed(2)}/max(p.eta-p.bed,.6));
        let noise=waterBankNoise(p.s*.04,n*.075,p.river+17.0).x;
        // The lake owns the material beyond the bed handover. Continuing a
        // capped river's mud indefinitely painted its support boundary as
        // a straight underwater seam, even where the bed itself was smooth.
        fan=riverCarveShoreProfile(abs(n)-edge,p.wl-heightM,noise)*(1.0-mouth.z);
        if(mouth.y>=1.0) {return fan;}
    }
    // Broad variation changes the submerged mud onset without painting
    // a new material strip over the surrounding biome.
    let nLong = waterBankNoise(p.s * 0.04, p.n * 0.075, p.river + 17.0).x;
    let nMid = waterBankNoise(p.s * 0.2, p.n * 0.2, p.river + 31.0).x;
    // The channel half-width is bank-full, not the waterline. Invert the
    // channel profile on this side at the actual water level; otherwise a
    // wide river keeps several metres of solid mud above the water even
    // after narrowing the blend. The same section and soft-cut offset are
    // used by the carve.
    let side = select(-1.0, 1.0, p.n >= 0.0);
    let bank = waterRiverBank(p, p.n >= 0.0);
    let D = (p.eta - p.bed) / max(waterParams.carve.w, 0.05);
    let fraction = clamp((p.wl - p.bed + ${(RIVER_SECTION.softM * 0.5).toFixed(2)}) / max(riverSideDepth(D, bank.freeboard), 0.01), 0.0, 1.0);
    let u = sqrt(max(0.0, 1.0 - pow(1.0 - fraction, 2.0 / 3.0)));
    let skew = side * p.skew;
    let waterEdge = p.hw * (skew + (1.0 - skew) * u);
    let channel=riverCarveShoreProfile(p.d-waterEdge,p.wl-heightM,0.65*nLong+0.35*nMid);
    return mix(channel,fan,mouth.y);
}` : `fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveUnderLake(dir: vec3<f32>, heightM: f32) -> f32 { return 0.0; }
fn riverCarveLakeWater(dir: vec3<f32>, heightM: f32) -> vec4<f32> { return vec4<f32>(0.0, -1.0e20, 0.0, 0.0); }
fn riverCarveDrawnRiverLevel(dir: vec3<f32>) -> vec2<f32> { return vec2<f32>(0.0); }`}
`;
}
