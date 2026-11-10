// templates/terrain-shaders/features/featureMountains.wgsl.js
//
// Mountains: uncommon massifs, rare landmark massifs, and mountain ranges.
// Cheap by construction (no noise in the shapes):
// - Placement: a grid of cells on each cube face, sized in metres (the cell
//   count per face follows the planet radius), so the density per km² is
//   the same on any planet. A cell holds at most one feature, with
//   probability density x the cell's area (exact solid angle), and keeps it
//   only if the whole footprint lies inside the cell; a sample then needs
//   only its own cell: one or two integer hashes outside features.
// - Highlands (landRegions) are favoured: chance and height scale with the
//   region at the feature's centre, read only inside a footprint.
// - Shapes: smooth (C2) analytic profiles in a tangent plane at the centre
//   (elliptic peaks with rounded summits and concave flanks, summed into
//   massifs; a range is a bent spine with a peaked cross-section, tapered
//   ends and summits along the crest). They count as relief, so the erosion
//   filter carves their ridges and gullies.
//
// Heights and sizes in METERS, planet-independent (constants in
// earthLikeBase).

export function createTerrainFeatureMountains() {
  return `
// ==================== Feature: Mountains ====================

fn mtnHash(x: u32) -> u32 {
    let s = x * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

// Next uniform [0, 1) from a hash state.
fn mtnRand(h: ptr<function, u32>) -> f32 {
    *h = mtnHash(*h);
    return f32(*h >> 8u) * (1.0 / 16777216.0);
}

// Cube face and gnomonic face coordinates (x, y in [-1, 1]) of a direction:
// the inverse of getSpherePoint (u = 0.5 x + 0.5).
struct MtnFacePos {
    face: i32,
    x: f32,
    y: f32,
}

fn mtnFacePos(d: vec3<f32>) -> MtnFacePos {
    var o: MtnFacePos;
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x > 0.0) { o.face = 0; o.x = -d.z / a.x; } else { o.face = 1; o.x = d.z / a.x; }
        o.y = d.y / a.x;
    } else if (a.y >= a.z) {
        if (d.y > 0.0) { o.face = 2; o.y = -d.z / a.y; } else { o.face = 3; o.y = d.z / a.y; }
        o.x = d.x / a.y;
    } else {
        if (d.z > 0.0) { o.face = 4; o.x = d.x / a.z; } else { o.face = 5; o.x = -d.x / a.z; }
        o.y = d.y / a.z;
    }
    return o;
}

// Cube point (unnormalized) of face coordinates, as getSpherePoint.
fn mtnCubePoint(face: i32, x: f32, y: f32) -> vec3<f32> {
    if (face == 0) { return vec3<f32>(1.0, y, -x); }
    if (face == 1) { return vec3<f32>(-1.0, y, x); }
    if (face == 2) { return vec3<f32>(x, 1.0, -y); }
    if (face == 3) { return vec3<f32>(x, -1.0, y); }
    if (face == 4) { return vec3<f32>(x, y, 1.0); }
    return vec3<f32>(-x, y, -1.0);
}

// Solid angle of the face rectangle [x0, x1] x [y0, y1].
fn mtnSolidAngle(x0: f32, x1: f32, y0: f32, y1: f32) -> f32 {
    let f = vec4<f32>(x1 * y1, x0 * y1, x1 * y0, x0 * y0)
        / sqrt(vec4<f32>(1.0 + x1 * x1 + y1 * y1, 1.0 + x0 * x0 + y1 * y1, 1.0 + x1 * x1 + y0 * y0, 1.0 + x0 * x0 + y0 * y0));
    return atan(f.x) - atan(f.y) - atan(f.z) + atan(f.w);
}

// The candidate feature of the sample's cell: valid with probability
// density x cell area; hash state h for the feature's parameters; centre c
// set by mtnPlace.
struct MtnSite {
    ok: bool,
    face: i32,
    x0: f32,
    x1: f32,
    y0: f32,
    y1: f32,
    c: vec3<f32>,
    h: u32,
}

fn mtnSite(fp: MtnFacePos, cellM: f32, densityPerM2: f32, salt: u32) -> MtnSite {
    var s: MtnSite;
    s.ok = false;
    let R = noiseReferenceRadiusM();
    let n = max(1.0, round(1.5707963 * R / cellM));
    let i = min(floor((fp.x * 0.5 + 0.5) * n), n - 1.0);
    let j = min(floor((fp.y * 0.5 + 0.5) * n), n - 1.0);
    s.face = fp.face;
    s.x0 = i / n * 2.0 - 1.0;
    s.x1 = (i + 1.0) / n * 2.0 - 1.0;
    s.y0 = j / n * 2.0 - 1.0;
    s.y1 = (j + 1.0) / n * 2.0 - 1.0;
    let cellKey = (u32(i) * 73856093u) ^ (u32(j) * 19349663u);
    var h = mtnHash(salt ^ mtnHash(bitcast<u32>(uniforms.seed) ^ mtnHash((u32(fp.face) * 0x9E3779B9u) ^ mtnHash(cellKey))));
    let chance = densityPerM2 * R * R * mtnSolidAngle(s.x0, s.x1, s.y0, s.y1);
    if (mtnRand(&h) >= chance) { return s; }
    s.h = h;
    s.ok = true;
    return s;
}

// Interval of a face coordinate t in [t0, t1] whose great-circle distance
// to both cell edges t = t0 and t = t1 is at least asin(sinAng), with the
// other face coordinate at o (exact: the edges are great circles and the
// distance condition is a quadratic in t).
fn mtnSafeRange(t0: f32, t1: f32, o: f32, sinAng: f32) -> vec2<f32> {
    let w = 1.0 + o * o;
    let a1 = sinAng * sqrt(1.0 + t1 * t1);
    let a0 = sinAng * sqrt(1.0 + t0 * t0);
    let hi = (t1 - a1 * sqrt(t1 * t1 + (1.0 - a1 * a1) * w)) / (1.0 - a1 * a1);
    let lo = (t0 + a0 * sqrt(t0 * t0 + (1.0 - a0 * a0) * w)) / (1.0 - a0 * a0);
    return vec2<f32>(lo, hi);
}

// Draws the centre of a feature of footprint ang (radians) where the
// footprint stays inside the cell: y within its safe range (at the cell's
// middle x), then x within its safe range at that y. ok = false when the
// cell is too small or the exact test (mtnFits) fails.
fn mtnPlace(site: MtnSite, h: ptr<function, u32>, ang: f32) -> MtnSite {
    var s = site;
    let sa = sin(ang);
    let u = mtnRand(h);
    let v = mtnRand(h);
    let yr = mtnSafeRange(s.y0, s.y1, 0.5 * (s.x0 + s.x1), sa);
    if (yr.y <= yr.x) { s.ok = false; return s; }
    let y = mix(yr.x, yr.y, v);
    let xr = mtnSafeRange(s.x0, s.x1, y, sa);
    if (xr.y <= xr.x) { s.ok = false; return s; }
    s.c = normalize(mtnCubePoint(s.face, mix(xr.x, xr.y, u), y));
    s.ok = mtnFits(s, ang);
    return s;
}

// Whether the cap of angular radius ang around the site's centre lies in its
// cell: the centre's distance to each edge great circle is at least ang.
fn mtnFits(s: MtnSite, ang: f32) -> bool {
    let m = sin(ang);
    let nx0 = normalize(cross(mtnCubePoint(s.face, s.x0, -1.0), mtnCubePoint(s.face, s.x0, 1.0)));
    let nx1 = normalize(cross(mtnCubePoint(s.face, s.x1, -1.0), mtnCubePoint(s.face, s.x1, 1.0)));
    let ny0 = normalize(cross(mtnCubePoint(s.face, -1.0, s.y0), mtnCubePoint(s.face, 1.0, s.y0)));
    let ny1 = normalize(cross(mtnCubePoint(s.face, -1.0, s.y1), mtnCubePoint(s.face, 1.0, s.y1)));
    return abs(dot(s.c, nx0)) >= m && abs(dot(s.c, nx1)) >= m && abs(dot(s.c, ny0)) >= m && abs(dot(s.c, ny1)) >= m;
}

// Highland weight at a feature's centre (0 lowland .. 1 highland plateau).
fn mtnHighland(c: vec3<f32>, seed: i32) -> f32 {
    let coord = landRegionCoordNoLean(c, seed);
    let t = clamp((coord - REGION_HIGHLAND_START) / REGION_CLIMB, 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Local gnomonic coordinates (metres, duals) of p in the tangent plane at c,
// axes e1 (X) and e2 (Y).
struct MtnLocal {
    X: vec4<f32>,
    Y: vec4<f32>,
}

fn mtnLocal(p: vec3<f32>, c: vec3<f32>, angle: f32) -> MtnLocal {
    let R = noiseReferenceRadiusM();
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(c.y) > 0.9);
    let b1 = normalize(cross(c, up));
    let b2 = cross(c, b1);
    let e1 = b1 * cos(angle) + b2 * sin(angle);
    let e2 = b2 * cos(angle) - b1 * sin(angle);
    let pc = dot(p, c);
    var o: MtnLocal;
    let x = R * dot(p, e1) / pc;
    let y = R * dot(p, e2) / pc;
    o.X = vec4<f32>(x, (R * e1 - x * c) / pc);
    o.Y = vec4<f32>(y, (R * e2 - y * c) / pc);
    return o;
}

// Smooth warp of the local plane (organic outlines): each axis shifted by a
// sine of the other. amp x 2 pi / lam < 1 keeps it from folding.
fn mtnWarp(l: MtnLocal, amp: f32, lam: f32, ph1: f32, ph2: f32) -> MtnLocal {
    var o: MtnLocal;
    let k = 6.2831853 / lam;
    o.X = l.X + dSin(l.Y * k + dConst(ph1)) * amp;
    o.Y = l.Y + dSin(l.X * k + dConst(ph2)) * amp;
    return o;
}

// Peaked profile of q (squared normalized radius): rounded summit
// (MTN_EPS), concave flanks exp(-k s), quintic base taper from MTN_TAPER_Q0
// to q = 1; C2, 0 for q >= 1.
fn mtnProfile_d(q: vec4<f32>, k: f32) -> vec4<f32> {
    if (q.x >= 1.0) { return dConst(0.0); }
    let s = dSqrt(q + dConst(MTN_EPS * MTN_EPS)) - dConst(MTN_EPS);
    let taper = dConst(1.0) - dQuintic(dClamp((q - dConst(MTN_TAPER_Q0)) * (1.0 / (1.0 - MTN_TAPER_Q0)), 0.0, 1.0));
    return dMul(dExp(s * (-k)), taper);
}

// Elliptic peak centred at (ox, oy), radii (ra, rb), rotated by angle.
fn mtnPeak_d(l: MtnLocal, ox: f32, oy: f32, angle: f32, ra: f32, rb: f32, k: f32) -> vec4<f32> {
    let dx = l.X - dConst(ox);
    let dy = l.Y - dConst(oy);
    let ca = cos(angle);
    let sa = sin(angle);
    let a = (dx * ca + dy * sa) * (1.0 / ra);
    let b = (dy * ca - dx * sa) * (1.0 / rb);
    return mtnProfile_d(dMul(a, a) + dMul(b, b), k);
}

// A massif (metres, dual): a main peak (height H, radius r, aspect up to
// 1.4) with spurs: elongated ridges pointing out from the summit (offset
// 0.45-0.75 r, long radius 0.55-0.85 r, aspect 1.6-2.4, height 0.35-0.6 H),
// spread around it; optionally a broad low base (baseDome x H, radius
// 1.5 r). The local plane is warped (0.08 r at 0.7 r) for irregular
// outlines. Footprint radius 1.8 r.
fn mtnMassif_d(p: vec3<f32>, site: MtnSite, seed: i32, hMin: f32, hMax: f32, rMin: f32, rMax: f32,
    spurs: i32, k: f32, baseDome: f32, lowlandChance: f32) -> vec4<f32> {
    var h = site.h;
    let H0 = mix(hMin, hMax, mtnRand(&h));
    let r = mix(rMin, rMax, mtnRand(&h));
    let ang = 1.8 * r / noiseReferenceRadiusM();
    let s = mtnPlace(site, &h, ang);
    if (!s.ok || dot(p, s.c) < cos(ang)) { return dConst(0.0); }
    let hl = mtnHighland(s.c, seed);
    if (mtnRand(&h) >= mix(lowlandChance, 1.0, hl)) { return dConst(0.0); }
    let H = H0 * mix(select(MTN_LOWLAND_HEIGHT, 0.85, lowlandChance >= 1.0), 1.0, hl);
    let l0 = mtnLocal(p, s.c, mtnRand(&h) * 6.2831853);
    let l = mtnWarp(l0, 0.08 * r, 0.7 * r, mtnRand(&h) * 6.2831853, mtnRand(&h) * 6.2831853);
    let aspect = mix(1.0, 1.4, mtnRand(&h));
    var sum = mtnPeak_d(l, 0.0, 0.0, 0.0, r * aspect, r / aspect, k) * H;
    let a0 = mtnRand(&h) * 6.2831853;
    for (var i = 0; i < spurs; i++) {
        let a = a0 + (f32(i) + 0.7 * (mtnRand(&h) - 0.5)) * (6.2831853 / f32(spurs));
        let off = mix(0.45, 0.75, mtnRand(&h)) * r;
        let rl = mix(0.55, 0.85, mtnRand(&h)) * r;
        let asp = mix(1.6, 2.4, mtnRand(&h));
        let hs = mix(0.35, 0.6, mtnRand(&h)) * H;
        sum += mtnPeak_d(l, off * cos(a), off * sin(a), a, rl, rl / asp, k) * hs;
    }
    if (baseDome > 0.0) {
        sum += mtnPeak_d(l, 0.0, 0.0, 0.0, 1.5 * r, 1.5 * r, 1.2) * (baseDome * H);
    }
    return sum;
}

// Spine of a range in its local plane: Y(X) bowed (bend) with a wiggle,
// for t = 2 X / L in [-1, 1], and its slope dY/dX (scalar versions, at a
// spur's anchor).
fn mtnSpineY(t: f32, bend: f32, wig: f32, wigPhase: f32) -> f32 {
    return (1.0 - t * t) * bend + sin(t * 4.712389 + wigPhase) * wig;
}

fn mtnSpineSlope(t: f32, L: f32, bend: f32, wig: f32, wigPhase: f32) -> f32 {
    return (-2.0 * bend * t + cos(t * 4.712389 + wigPhase) * wig * 4.712389) * (2.0 / L);
}

// A mountain range (metres, dual): a spine of length L along X, bowed
// sideways (bend) with a wiggle, the local plane warped for an organic
// crest line; ends tapered. A backbone ridge (half-width W, varying +-20 %
// along, over a low apron 2.2 W wide) whose crest height varies along the
// spine (summits, saddles at ~70 %), and side spurs: ridges leaving the
// spine at 60-90 degrees on a random side, at irregular spacing (about 3 in
// 4 anchor slots, jittered +-0.35 spacing), 1.3-2.1 W long. Each spur fades
// out (quintic) between 1.2 and 2 spacings from its anchor along the spine,
// so the five anchors nearest the sample are all that can reach it.
fn mtnRange_d(p: vec3<f32>, site: MtnSite, seed: i32) -> vec4<f32> {
    var h = site.h;
    let L = mix(MTN_RANGE_LEN_MIN, MTN_RANGE_LEN_MAX, mtnRand(&h));
    let W = mix(MTN_RANGE_HALF_W_MIN, MTN_RANGE_HALF_W_MAX, mtnRand(&h));
    let H0 = mix(MTN_RANGE_H_MIN, MTN_RANGE_H_MAX, mtnRand(&h));
    let bend = (mtnRand(&h) - 0.5) * 0.5 * L;
    let wig = (mtnRand(&h) - 0.5) * 0.12 * L;
    // Across-spine reach: apron 2.64 W (spurs: 2.73 W) + warp 0.1 W; the
    // backbone and apron measure across the spine, which is up to
    // sqrt(1 + slope^2) wider in Y where the spine slants.
    let maxSlope = (4.0 * abs(bend) + 9.43 * abs(wig)) / L;
    let lateral = abs(bend) + abs(wig) + 2.75 * W * sqrt(1.0 + maxSlope * maxSlope) + 0.1 * W;
    let ang = sqrt(0.25 * L * L + lateral * lateral) / noiseReferenceRadiusM();
    let s = mtnPlace(site, &h, ang);
    if (!s.ok || dot(p, s.c) < cos(ang)) { return dConst(0.0); }
    let hl = mtnHighland(s.c, seed);
    if (mtnRand(&h) >= mix(MTN_RANGE_LOWLAND_CHANCE, 1.0, hl)) { return dConst(0.0); }
    let H = H0 * mix(0.85, 1.0, hl);
    let l0 = mtnLocal(p, s.c, mtnRand(&h) * 3.1415927);
    let l = mtnWarp(l0, 0.1 * W, 0.9 * W, mtnRand(&h) * 6.2831853, mtnRand(&h) * 6.2831853);
    let wigPhase = mtnRand(&h) * 6.2831853;
    let phW = mtnRand(&h) * 6.2831853;
    let ph1 = mtnRand(&h) * 6.2831853;
    let ph2 = mtnRand(&h) * 6.2831853;
    let spurSeed = mtnHash(h);
    let t = l.X * (2.0 / L);
    if (abs(t.x) >= 1.0) { return dConst(0.0); }
    let t2 = dMul(t, t);
    // Backbone: distance across the spine Y(X).
    let arg = t * 4.712389 + dConst(wigPhase);
    let ys = (dConst(1.0) - t2) * bend + dSin(arg) * wig;
    let dys = (t * (-2.0 * bend) + dCos(arg) * (wig * 4.712389)) * (2.0 / L);
    let across = dDiv(l.Y - ys, dSqrt(dConst(1.0) + dMul(dys, dys)));
    let w = (dConst(1.0) + dSin(l.X * (6.2831853 / MTN_RANGE_WIDTH_WAVE) + dConst(phW)) * 0.2) * W;
    let sn = dDiv(across, w);
    let sn2 = dMul(sn, sn);
    let crest = dConst(0.82) + dSin(l.X * (6.2831853 / MTN_RANGE_SUMMIT_WAVE1) + dConst(ph1)) * 0.12
        + dSin(l.X * (6.2831853 / MTN_RANGE_SUMMIT_WAVE2) + dConst(ph2)) * 0.06;
    var sum = dMul(mtnProfile_d(sn2, MTN_RANGE_K), crest) + mtnProfile_d(sn2 * (1.0 / (2.2 * 2.2)), 1.6) * 0.12;
    // Side spurs.
    let sp = MTN_RANGE_SPUR_SPACING;
    let k0 = floor((l.X.x + 0.5 * L) / sp);
    for (var di = -2; di <= 2; di++) {
        let idx = k0 + f32(di);
        var hs = mtnHash(spurSeed ^ (u32(i32(idx) + 1000) * 2654435761u));
        if (mtnRand(&hs) > 0.75) { continue; }
        let xs = (idx + 0.5 + 0.7 * (mtnRand(&hs) - 0.5)) * sp - 0.5 * L;
        let ts = xs * (2.0 / L);
        if (abs(ts) >= 0.85) { continue; }
        let side = select(-1.0, 1.0, mtnRand(&hs) < 0.5);
        let spineAng = atan(mtnSpineSlope(ts, L, bend, wig, wigPhase));
        let a = spineAng + side * mix(1.05, 1.57, mtnRand(&hs));
        let len = mix(1.3, 2.1, mtnRand(&hs)) * W;
        let wid = mix(0.28, 0.42, mtnRand(&hs)) * W;
        let hS = mix(0.4, 0.65, mtnRand(&hs)) * (1.0 - smoothstep(0.5, 0.85, abs(ts)));
        let cx = xs + cos(a) * 0.5 * len;
        let cy = mtnSpineY(ts, bend, wig, wigPhase) + sin(a) * 0.5 * len;
        let dxs = (l.X - dConst(xs)) * (1.0 / sp);
        let window = dConst(1.0) - dQuintic(dClamp((dMul(dxs, dxs) - dConst(1.44)) * (1.0 / 2.56), 0.0, 1.0));
        sum += dMul(mtnPeak_d(l, cx, cy, a, 0.55 * len, wid, 1.6), window) * hS;
    }
    let ends = dConst(1.0) - dQuintic(dClamp((t2 - dConst(0.3)) * (1.0 / 0.7), 0.0, 1.0));
    return dMul(sum, ends) * H;
}

// All mountains (dual, normalized height). Heights are the MTN_* metres as
// they are: noiseProfile.mountainBias (2.65 on the demo planet, raised when
// the old mountains hardly showed) scales the foothills and the regional
// terrain type, not these.
fn featureMountainsHeight_d(unitDir: vec3<f32>, seed: i32) -> vec4<f32> {
    let fp = mtnFacePos(unitDir);
    var total = dConst(0.0);
    if (terrainFeatureOn(TF_MOUNTAINS)) {
        let s = mtnSite(fp, MTN_CELL_M, MTN_DENSITY_PER_KM2 * 1e-6, 0x68bc21ebu);
        if (s.ok) {
            total += mtnMassif_d(unitDir, s, seed, MTN_H_MIN, MTN_H_MAX, MTN_R_MIN, MTN_R_MAX, 3, MTN_K, 0.0, MTN_LOWLAND_CHANCE);
        }
    }
    if (terrainFeatureOn(TF_MOUNTAIN_LANDMARK)) {
        let s = mtnSite(fp, MTN_LANDMARK_CELL_M, MTN_LANDMARK_DENSITY_PER_KM2 * 1e-6, 0x02e5be93u);
        if (s.ok) {
            total += mtnMassif_d(unitDir, s, seed, MTN_LANDMARK_H_MIN, MTN_LANDMARK_H_MAX, MTN_LANDMARK_R_MIN, MTN_LANDMARK_R_MAX, 4, MTN_LANDMARK_K, 0.15, MTN_LANDMARK_LOWLAND_CHANCE);
        }
    }
    if (terrainFeatureOn(TF_MOUNTAIN_RANGE)) {
        let s = mtnSite(fp, MTN_RANGE_CELL_M, MTN_RANGE_DENSITY_PER_KM2 * 1e-6, 0x967a889bu);
        if (s.ok) {
            total += mtnRange_d(unitDir, s, seed);
        }
    }
    return total * (1.0 / maxTerrainHeightM());
}
`;
}
