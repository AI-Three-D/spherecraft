// templates/terrain-shaders/features/featureLakeCells.wgsl.js
//
// Lake cells: lakes that are part of the terrain height function and hold
// their water by construction, without a dam. Experiment, compiled only into
// the 'lakeLand' base generator (base/lakeLandBase.wgsl.js). Plan and
// results: LAKE_CELLS_PLAN.md.
//
// The land is split into size bands (LandBands in lakeLandBase): for each
// lake tier the bands longer than its lakes are its "coarse" terrain, the
// rest its "fine" terrain.
//
// Sites. Each tier is a jittered 3-D lattice (cellM metres). A cell offers a
// candidate when its jittered point, projected onto the sphere, stays inside
// the cell: about one candidate per cellM^2 of surface. Supports reach at
// most 0.95 cellM, so a point's candidates lie in the 27 cells around it and
// a candidate's overlapping neighbours in the 125 cells around it.
//
// Shape. Up to four ellipses joined by a smooth union, of one of four kinds:
// a blob, a long bent lake narrowing at one end, a lobed lake (bays between
// the lobes, capes between the bays), a chain with narrows. u(p), roughly the
// distance from the shoreline (negative inside), is that union's distance
// minus outline noise and scallops.
//
// Ground. The lake's bank surface rises from the shoreline at a gentle slope
// (a bed below it), plus a cliff of bounded height at the shore wherever a
// noise field around the lake says so, each lake with its own balance of
// gentle shores and cliffs. The coarse terrain becomes the lower of itself and the bank
// surface, and that lowering fades out beyond the containment curve over a
// width that varies around the lake with its own noise field (0.6..1.6 of
// a base width set by how much the lake lowers the land: 100 m .. several
// km). Where the coarse terrain already lies below the bank surface, nothing
// changes: no levee. The fine bands are added unchanged.
//
// Containment. lakeAssess samples the full land bands on the curve where the
// shape's distance (without noise) equals uC = u0 + the noise amplitude, so
// the shoreline distance there is at least u0. It sets
//   level = lowest coarse height on the curve - deepest fine dip there - 2 m,
//   gentle bank slope >= (deepest fine dip + 2 m) / u0,
// so on that closed curve both the coarse terrain and the bank surface stand
// above level + fine dip + margin: the water cannot leave. A narrow band on
// the curve keeps the fine bands from dipping below what was sampled (a
// backstop between samples).
//
// Not a lake (reason): centre or curve over the ocean (1, 2), fine bands too
// rough for a bank slope of steepMin (3), level within 3 m of the sea (4), lowering
// too large for the fade (5), coarse relief inside above headMax (8). A lake is
// left out when an overlapping candidate of a larger tier, or of its tier
// with a higher priority, would be a lake too (7). That test reads the other
// candidate's own assessment, not its selection, so there are no chains: the
// result does not depend on the camera or on the order tiles ask in.
//
// Water: inside the containment curve, wherever the final height is below
// the level (lakeCellQuery).

// Tiers, largest first. Lengths in metres. len: half the lake's length
// (lenMin..lenMax; sizeBias 1 uniform, 2 biased small). families: shares of
// blob, long, lobed and chain (the rest have arms). u0: shore distance to the containment curve
// (max(u0Frac len, u0Min)). Banks: a gentle slope gentleMin..gentleMax, plus
// cliffs at the shore cliffMin..cliffMax high with slopes steepMin..steepMax
// where the bank noise says so. The lowering fades out over head / fadeSlope (within
// fadeMin..fadeMax / 1.65) times the varying width factor. coarseBands: how
// many land bands count as coarse (1 macro; 2 + foothills and erosion; 3 +
// rolling hills and the 750 m meso octave). Pond and small cells denser
// since 2026-11-09 (owner: more small-medium lakes, short rivers between
// them; lakeCellRivers.js caps a river by its lake's size). salt: the tier's own random
// sites, fixed when tiers are added (big came in 2026-11-09 between giant and
// large; the others kept their lakes).
export const LAKE_CELL_TIERS = Object.freeze([
    { name: 'giant', salt: 0, cellM: 55000, chance: 0.8, lenMin: 5000, lenMax: 14000, sizeBias: 1, families: [0.15, 0.2, 0.25, 0.15],
        outline: 0.40, scallop: 0.12, u0Frac: 0.15, u0Min: 250, depthMin: 10, depthMax: 40,
        gentleMin: 0.015, gentleMax: 0.04, cliffMin: 8, cliffMax: 45, steepMin: 0.25, steepMax: 0.45,
        fadeSlope: 0.06, fadeMin: 1500, fadeMax: 8000, headMax: 600, coarseBands: 1, rimSamples: 128 },
    { name: 'big', salt: 5, cellM: 29500, chance: 1.0, lenMin: 3000, lenMax: 6000, sizeBias: 1, families: [0.15, 0.2, 0.25, 0.15],
        outline: 0.40, scallop: 0.12, u0Frac: 0.18, u0Min: 180, depthMin: 8, depthMax: 30,
        gentleMin: 0.018, gentleMax: 0.045, cliffMin: 8, cliffMax: 35, steepMin: 0.25, steepMax: 0.45,
        fadeSlope: 0.065, fadeMin: 800, fadeMax: 5950, headMax: 500, coarseBands: 1, rimSamples: 112 },
    { name: 'large', salt: 1, cellM: 14000, chance: 1.0, lenMin: 1500, lenMax: 3500, sizeBias: 1, families: [0.15, 0.2, 0.25, 0.15],
        outline: 0.40, scallop: 0.12, u0Frac: 0.20, u0Min: 120, depthMin: 6, depthMax: 25,
        gentleMin: 0.02, gentleMax: 0.05, cliffMin: 6, cliffMax: 30, steepMin: 0.25, steepMax: 0.45,
        fadeSlope: 0.07, fadeMin: 500, fadeMax: 1950, headMax: 400, coarseBands: 1, rimSamples: 96 },
    { name: 'medium', salt: 2, cellM: 10000, chance: 1.0, lenMin: 700, lenMax: 1400, sizeBias: 2, families: [0.2, 0.2, 0.25, 0.15],
        outline: 0.30, scallop: 0.10, u0Frac: 0.25, u0Min: 80, depthMin: 4, depthMax: 15,
        gentleMin: 0.025, gentleMax: 0.06, cliffMin: 4, cliffMax: 18, steepMin: 0.25, steepMax: 0.45,
        fadeSlope: 0.05, fadeMin: 300, fadeMax: 1500, headMax: 200, coarseBands: 2, rimSamples: 64 },
    { name: 'pond', salt: 3, cellM: 4500, chance: 1.0, lenMin: 350, lenMax: 700, sizeBias: 2, families: [0.3, 0.25, 0.2, 0.15],
        outline: 0.25, scallop: 0.08, u0Frac: 0.25, u0Min: 60, depthMin: 3, depthMax: 12,
        gentleMin: 0.03, gentleMax: 0.07, cliffMin: 3, cliffMax: 12, steepMin: 0.25, steepMax: 0.45,
        fadeSlope: 0.05, fadeMin: 200, fadeMax: 800, headMax: 150, coarseBands: 2, rimSamples: 48 },
    { name: 'small', salt: 4, cellM: 3500, chance: 0.6, lenMin: 120, lenMax: 350, sizeBias: 2, families: [0.45, 0.3, 0.1, 0.1],
        outline: 0.25, scallop: 0.08, u0Frac: 0.30, u0Min: 40, depthMin: 1.5, depthMax: 6,
        gentleMin: 0.04, gentleMax: 0.08, cliffMin: 2, cliffMax: 6, steepMin: 0.25, steepMax: 0.4,
        fadeSlope: 0.05, fadeMin: 100, fadeMax: 400, headMax: 60, coarseBands: 3, rimSamples: 32 },
]);

const SUPPORT_FRACTION = 0.95;
// Shapes reach 1.05 len from the centre; the shape distance grows at least
// 1 / 2.1 as fast as the true distance (ellipses up to 4:1).
const EXTENT_FACTOR = 1.05;
const STRETCH_FACTOR = 2.1;
// A smooth union's shape distance lies up to ks / 4 under its parts' (ks at
// most 0.12 len, lakeShapeOf).
const KS_QUARTER = 0.03;
// The fade's width varies around a lake by this range of factors.
const FADE_VARY = [0.6, 1.6];

export function lakeCellTierLimits(t) {
    const L = t.lenMax;
    const reach = EXTENT_FACTOR * L + (Math.max(t.u0Frac * L, t.u0Min) + (t.outline + t.scallop + KS_QUARTER) * L + t.fadeMax) * STRETCH_FACTOR;
    return { reach, rbMax: SUPPORT_FRACTION * t.cellM };
}

function num(v) {
    const s = String(v);
    return /[.eE]/.test(s) ? s : `${s}.0`;
}

// lakeAssessBase and lakeAssess share this body; only lakeAssess lowers the
// land by the larger lakes (two functions: WGSL has no recursion).
const LAKE_ASSESS_BODY = `fn @NAME@(tier: i32, t: LakeTier, cell: vec3<i32>, c: LakeCand, seed: i32) -> LakeAssess {
    var a: LakeAssess;
    let H = maxTerrainHeightM();
    let g2 = lakeHash4(cell, lakeSalt(seed, tier) ^ 0x1b873593u);
    let g3 = lakeHash4(cell, lakeSalt(seed, tier) ^ 0xcc9e2d51u);
    let fr = lakeFrame(c, cell, tier, seed);
    a.a1 = fr[0];
    a.a2 = fr[1];
    a.shape = lakeShapeOf(t, tier, cell, seed, c.len);
    a.u0 = lakeU0(t, c.len);
    a.uC = a.u0 + (t.outline + t.scallop) * a.shape.minAxis;

    let Bc = landBands_d(seed, c.dir);
    if (Bc.landBlend.x < 0.999) { a.reason = 1; return a; }
    a.cliffH = mix(t.cliffMin, t.cliffMax, g3.y);
    a.cliffW = a.cliffH / mix(t.steepMin, t.steepMax, g3.w);
    // Each lake its own balance of gentle shores and cliffs.
    a.steepAt = mix(-0.45, 0.45, g3.z);
    // The containment curve, point by point: the real terrain (the level is
    // its lowest point less a margin), and how steep the gentle bank must be
    // to stand above the level wherever the fine terrain dips there (the
    // cliff counts where it is). Kept per point for the lowering below.
@NESTED@    // The larger lakes whose lowering reaches this lake's containment curve.
    let larger = lakeLargerFind(tier, c, LAKE_EXTENT_FACTOR * a.shape.extent + (a.uC + 0.25 * a.shape.ks) * a.shape.stretch, seed);
@END@
    var pts: array<vec4<f32>, 128>;
    var tMin = 1.0e30;
    var need = 0.0;
    var fNeg = 0.0;
    let w = a.shape.minAxis;
    let seedN = seed + 9901 + lakeTierId(tier) * 17;
    for (var k = 0; k < t.rimSamples; k++) {
        let th = 6.2831853 * (f32(k) + 0.5) / f32(t.rimSamples);
        let r = lakeCurveRadius(a.shape, th, a.uC);
        let dk = lakeLocalDir(c, a, r * cos(th), r * sin(th));
        let B = landBands_d(seed, dk);
        if (B.landBlend.x < 0.999) { a.reason = 2; return a; }
        var total = lakeBandsTotal(B).x * H;
        var coarse = lakeBandsCoarse(B, t.coarseBands).x * H;
@NESTED@        if (tier > 0) {
            // A larger lake may lower the land here: the level and banks
            // follow the lowered land.
            let low = lakeLargerLowerAt(larger, dk, B, seed);
            total -= low;
            coarse -= low;
        }
@END@
        let dip = max(0.0, coarse - total);
        let nO = clamp(fbmAuto_d(dk, 0.7 * w / 1000.0, 2, seedN, 2.0, 0.5).x, -1.0, 1.0);
        let nS = clamp(fbmAuto_d(dk, 0.18 * w / 1000.0, 2, seedN + 5, 2.0, 0.5).x, -1.0, 1.0);
        let u = max(a.uC - (nO * t.outline + nS * t.scallop) * w, a.u0);
        let cliff = lakeCliff_d(a, lakeBankNoise(seed, tier, dk, c.len)).x * a.cliffH * (1.0 - exp(-u / a.cliffW));
        need = max(need, (dip + LAKE_MARGIN_M + 0.5 + 0.25 * lakeCreaseM(c.len) - cliff) / u);
        tMin = min(tMin, total);
        fNeg = max(fNeg, dip);
        pts[k] = vec4<f32>(coarse, cliff, u, 0.0);
    }
    a.fNeg = fNeg;
    a.sNeed = need;
    if (a.sNeed > t.steepMin) { a.reason = 3; return a; }
    a.level = tMin - LAKE_MARGIN_M - 1.0;
    if (a.level < uniforms.waterParams.y * H + 3.0) { a.reason = 4; return a; }
    a.gentle = max(mix(t.gentleMin, t.gentleMax, g3.x), a.sNeed);
    // In hills the bank climbs with the land instead of cutting it down:
    // each lake follows the slope from its water to the land on its curve
    // more or less closely (flat sites keep their gentle shores).
    var climb = 0.0;
    for (var k = 0; k < t.rimSamples; k++) {
        let q = pts[k];
        climb += max(0.0, q.x - a.level - q.y) / q.z;
    }
    a.gentle = min(max(a.gentle, mix(0.5, 1.0, g2.w) * climb / f32(t.rimSamples)), LAKE_GENTLE_MAX);

    // How far the lowering reaches: the largest lowering on the curve.
    var head = 0.0;
    for (var k = 0; k < t.rimSamples; k++) {
        let q = pts[k];
        head = max(head, q.x - (a.level + a.gentle * q.z + q.y));
    }
    if (head > t.fadeSlope * t.fadeMax / LAKE_FADE_MAX) { a.reason = 5; return a; }
    a.fade = clamp(head / t.fadeSlope, t.fadeMin, t.fadeMax / LAKE_FADE_MAX);
    // The lowering must end inside the candidate's support: shapes stretched
    // past the tier's bound (narrow arms) get a shorter fade. Cut off there it
    // drew a step on a circle round the lake (owner 2026-11-09, crop circles).
    // The shape distance of a smooth union lies up to ks / 4 under its parts'.
    let fadeFit = ((c.rb - LAKE_EXTENT_FACTOR * a.shape.extent) / a.shape.stretch - a.uC - 0.25 * a.shape.ks) / LAKE_FADE_MAX;
    // A much shorter fade would be a steep wall: no lake then.
    if (fadeFit < 0.6 * a.fade) { a.reason = 5; return a; }
    a.fade = min(a.fade, fadeFit);
    a.band = max(0.25 * a.u0, 10.0);
    a.core = LAKE_EXTENT_FACTOR * a.shape.extent + (a.uC + a.band + 0.25 * a.shape.ks) * a.shape.stretch;
    a.rb = min(LAKE_EXTENT_FACTOR * a.shape.extent + (a.uC + 0.25 * a.shape.ks + a.fade * LAKE_FADE_MAX) * a.shape.stretch, c.rb);

    // Inside: the coarse relief the bed replaces, and the fine bands' highest
    // bump, which the bed sinks below (so the fine bands make islands and
    // coves rather than leaving the lake dry).
    var fPos = max(0.0, lakeBandsTotal(Bc).x * H - lakeBandsCoarse(Bc, t.coarseBands).x * H);
    var inMax = lakeBandsCoarse(Bc, t.coarseBands).x * H;
    var comp = a.shape.comp;
    var rot = a.shape.rot;
    for (var j = 0; j < 6; j++) {
        if (j >= a.shape.n) { break; }
        for (var q = 0; q < 5; q++) {
            let e = comp[j];
            let ox = select(0.0, select(-0.5, 0.5, q % 2 == 0) * e.z, q > 0 && q < 3);
            let oy = select(0.0, select(-0.5, 0.5, q % 2 == 0) * e.w, q >= 3);
            let x = e.x + ox * cos(rot[j]) - oy * sin(rot[j]);
            let y = e.y + ox * sin(rot[j]) + oy * cos(rot[j]);
            let B = landBands_d(seed, lakeLocalDir(c, a, x, y));
            let coarse = lakeBandsCoarse(B, t.coarseBands).x * H;
            fPos = max(fPos, lakeBandsTotal(B).x * H - coarse);
            inMax = max(inMax, coarse);
        }
    }
    if (inMax - a.level > t.headMax) { a.reason = 8; return a; }
    // Some lakes shallow (the land's own bumps make islands), some deep.
    a.depth = mix(t.depthMin, t.depthMax, g2.y) + fPos * mix(0.4, 1.6, g2.z);
    a.ok = true;
    return a;
}

`;

function lakeAssessFunction(name, nested) {
    let out = LAKE_ASSESS_BODY;
    for (let a = out.indexOf('@NESTED@'); a >= 0; a = out.indexOf('@NESTED@')) {
        const b = out.indexOf('@END@\n', a);
        out = out.slice(0, a) + (nested ? out.slice(a + '@NESTED@'.length, b) : '') + out.slice(b + '@END@\n'.length);
    }
    return out.replace('@NAME@', name);
}

// table: null (lakes assessed wherever needed: lab checks), 'build' (the
// passes that fill the lake table) or 'read' (heights read the table).
export function createLakeCellsWgsl(tiers = LAKE_CELL_TIERS, { table = null } = {}) {
    if (![null, 'build', 'read'].includes(table)) throw new Error(`lake table mode must be null, 'build' or 'read'`);
    if (!tiers.length) throw new Error('lake cells need at least one tier');
    tiers.forEach((t, i) => {
        const { reach, rbMax } = lakeCellTierLimits(t);
        if (reach > rbMax) throw new Error(`lake tier ${t.name}: support too large for its cell (${reach.toFixed(0)} m > ${rbMax.toFixed(0)} m)`);
        if (i > 0 && t.cellM >= tiers[i - 1].cellM) throw new Error('lake tiers must be ordered largest first');
        if (!Number.isInteger(t.salt) || tiers.some((o, j) => j !== i && o.salt === t.salt)) throw new Error(`lake tier ${t.name}: needs its own integer salt`);
        if (![1, 2, 3].includes(t.coarseBands)) throw new Error(`lake tier ${t.name}: coarseBands must be 1, 2 or 3`);
        if (t.families.length !== 4 || t.families.reduce((a, b) => a + b, 0) > 1) throw new Error(`lake tier ${t.name}: families are four shares summing to at most 1`);
    });
    const tierCases = tiers.map((t, i) => {
        const [fb, fl, fo, fc] = t.families;
        const fields = [t.cellM, t.chance, t.lenMin, t.lenMax, t.sizeBias, fb, fb + fl, fb + fl + fo, fb + fl + fo + fc, t.outline, t.scallop,
            t.u0Frac, t.u0Min, t.depthMin, t.depthMax, t.gentleMin, t.gentleMax, t.cliffMin, t.cliffMax, t.steepMin, t.steepMax,
            t.fadeSlope, t.fadeMin, t.fadeMax, t.headMax, lakeCellTierLimits(t).rbMax].map(num);
        return `    ${i ? 'else ' : ''}if (i == ${i}) { t = LakeTier(${fields.join(', ')}, ${t.coarseBands}, ${t.rimSamples}); }`;
    }).join('\n');
    return `
// ==================== Feature: lake cells (featureLakeCells.wgsl.js) ====================
const LAKE_TIER_COUNT: i32 = ${tiers.length};
// The containment curve stays at least this far above the level (metres).
const LAKE_MARGIN_M: f32 = 0.5;
const LAKE_EXTENT_FACTOR: f32 = ${num(EXTENT_FACTOR)};
const LAKE_STRETCH_FACTOR: f32 = ${num(STRETCH_FACTOR)};
const LAKE_KS_QUARTER: f32 = ${num(KS_QUARTER)};
// Banks: the gentle slope (following the hills) and the bed at most these
// steep, so the 1 m grid draws them without stretching (owner 2026-11-09).
const LAKE_GENTLE_MAX: f32 = 0.35;
const LAKE_BED_SLOPE_MAX: f32 = 0.6;
// Width (m) of the crease where a bank meets the land: rounded, 3-25 m.
fn lakeCreaseM(len: f32) -> f32 { return clamp(0.03 * len, 3.0, 25.0); }
const LAKE_FADE_MIN: f32 = ${num(FADE_VARY[0])};
const LAKE_FADE_MAX: f32 = ${num(FADE_VARY[1])};

struct LakeTier {
    cellM: f32, chance: f32, lenMin: f32, lenMax: f32, sizeBias: f32,
    fBlob: f32, fLong: f32, fLobed: f32, fChain: f32, outline: f32, scallop: f32,
    u0Frac: f32, u0Min: f32, depthMin: f32, depthMax: f32,
    gentleMin: f32, gentleMax: f32, cliffMin: f32, cliffMax: f32, steepMin: f32, steepMax: f32,
    fadeSlope: f32, fadeMin: f32, fadeMax: f32, headMax: f32, rbMax: f32,
    coarseBands: i32, rimSamples: i32,
}

fn lakeTier(i: i32) -> LakeTier {
    var t: LakeTier;
${tierCases}
    return t;
}

fn lakePcg3(v0: vec3<u32>) -> vec3<u32> {
    var v = v0 * 1664525u + vec3<u32>(1013904223u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}

// Four uniform values in [0, 1) for a lattice cell.
fn lakeHash4(cell: vec3<i32>, salt: u32) -> vec4<f32> {
    let a = lakePcg3(bitcast<vec3<u32>>(cell) + vec3<u32>(salt, salt * 747796405u, salt * 2891336453u));
    let b = lakePcg3(a.zxy ^ vec3<u32>(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u));
    return vec4<f32>(vec3<f32>(a >> vec3<u32>(8u)), f32(b.x >> 8u)) * (1.0 / 16777216.0);
}

// The tier's fixed id (its salt) for everything random about its lakes.
fn lakeTierId(tier: i32) -> i32 {
    var id = 0;
${tiers.map((t, i) => `    ${i ? 'else ' : ''}if (tier == ${i}) { id = ${t.salt}; }`).join('\n')}
    return id;
}

fn lakeSalt(seed: i32, tier: i32) -> u32 {
    return bitcast<u32>(seed) * 2654435761u + u32(lakeTierId(tier)) * 40503u + 7919u;
}

fn lakeCellOffset3(k: i32) -> vec3<i32> {
    return vec3<i32>(k % 3 - 1, (k / 3) % 3 - 1, k / 9 - 1);
}

fn lakeCellOffset5(k: i32) -> vec3<i32> {
    return vec3<i32>(k % 5 - 2, (k / 5) % 5 - 2, k / 25 - 2);
}

struct LakeCand {
    ok: bool, dir: vec3<f32>, len: f32, rb: f32, prio: f32,
}

fn lakeU0(t: LakeTier, len: f32) -> f32 {
    return max(t.u0Frac * len, t.u0Min);
}

fn lakeCandidate(tier: i32, t: LakeTier, cell: vec3<i32>, seed: i32) -> LakeCand {
    var c: LakeCand;
    let salt = lakeSalt(seed, tier);
    let h = lakeHash4(cell, salt);
    if (h.w >= t.chance) { return c; }
    let R = noiseReferenceRadiusM();
    let jitter = (vec3<f32>(cell) + vec3<f32>(0.25) + 0.5 * h.xyz) * t.cellM;
    let dir = normalize(jitter);
    if (any(vec3<i32>(floor(dir * (R / t.cellM))) != cell)) { return c; }
    let g = lakeHash4(cell, salt ^ 0x68e31da4u);
    c.ok = true;
    c.dir = dir;
    c.len = mix(t.lenMin, t.lenMax, pow(g.x, t.sizeBias));
    // Upper bound of the support; the actual one is LakeAssess.rb.
    c.rb = min(LAKE_EXTENT_FACTOR * c.len + (lakeU0(t, c.len) + (t.outline + t.scallop + LAKE_KS_QUARTER) * c.len + t.fadeMax) * LAKE_STRETCH_FACTOR, t.rbMax);
    c.prio = f32(LAKE_TIER_COUNT - tier) * 1.0e6 + c.len + g.z;
    return c;
}

// Up to four ellipses (centre x, y, semi-axes a, b in the lake's frame;
// rotation in rot) joined by a smooth union of width ks.
struct LakeShape {
    n: i32,
    comp: array<vec4<f32>, 6>,
    rot: array<f32, 6>,
    extent: f32, minAxis: f32, ks: f32, stretch: f32,
}

fn lakeShapeOf(t: LakeTier, tier: i32, cell: vec3<i32>, seed: i32, L: f32) -> LakeShape {
    let salt = lakeSalt(seed, tier);
    let h = lakeHash4(cell, salt ^ 0x2545f491u);
    let g = lakeHash4(cell, salt ^ 0x9e3779b1u);
    var s: LakeShape;
    var comp = array<vec4<f32>, 6>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    var rot = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    if (h.x < t.fBlob) {
        // Blob: one ellipse.
        let sx = mix(1.0, 1.6, h.y);
        s.n = 1;
        comp[0] = vec4<f32>(0.0, 0.0, L, L / sx);
        s.ks = 0.1 * L;
    } else if (h.x < t.fLong) {
        // Long and narrow, bent in the middle, one arm narrower.
        let sx = mix(2.5, 4.0, h.y);
        let phi = (h.z - 0.5) * 0.7;
        let w = mix(0.5, 1.0, h.w);
        s.n = 2;
        comp[0] = vec4<f32>(-0.42 * L * cos(phi), -0.42 * L * sin(phi), 0.6 * L, 0.6 * L / sx);
        comp[1] = vec4<f32>(0.42 * L * cos(phi), -0.42 * L * sin(phi), 0.6 * L, 0.6 * L * w / sx);
        rot[0] = phi;
        rot[1] = -phi;
        s.ks = 0.06 * L;
    } else if (h.x < t.fLobed) {
        // A body and two to five lobes: bays between them, capes between bays.
        s.n = 3 + i32(floor(g.x * 3.999));
        comp[0] = vec4<f32>(0.0, 0.0, 0.55 * L, 0.45 * L);
        rot[0] = h.y * 3.14159265;
        for (var j = 1; j < 6; j++) {
            if (j >= s.n) { break; }
            // Unevenly spaced lobes, so they do not form a star.
            let th = h.z * 6.2831853 + (f32(j - 1) + (fract(g.y + f32(j) * 0.43) - 0.5) * 0.9) * 6.2831853 / f32(s.n - 1);
            let d = mix(0.45, 0.65, fract(g.z + f32(j) * 0.37)) * L;
            comp[j] = vec4<f32>(d * cos(th), d * sin(th), mix(0.3, 0.4, fract(g.w + f32(j) * 0.61)) * L,
                mix(0.15, 0.28, fract(g.y + f32(j) * 0.29)) * L);
            rot[j] = th;
        }
        s.ks = 0.12 * L;
    } else if (h.x < t.fChain) {
        // A chain of three or four basins along a bending axis, each long
        // along it and of its own size, overlapping by a third to a half of
        // the lake's length: the narrows between them are straits that hold
        // water. Touching only at their tips they were round blobs on thin
        // necks, often dry (owner 2026-11-09).
        s.n = select(3, 4, g.w > 0.5);
        let four = s.n == 4;
        let step = select(0.5, 0.38, four) * L;
        let bend = (h.y - 0.5) * 0.9;
        for (var j = 0; j < 6; j++) {
            if (j >= s.n) { break; }
            let jit = fract(vec3<f32>(g.x, g.y, g.z) + f32(j) * vec3<f32>(0.37, 0.61, 0.29));
            let t = f32(j) - 0.5 * f32(s.n - 1);
            let ang = bend * t / f32(s.n - 1);
            comp[j] = vec4<f32>(t * step * cos(ang), t * step * sin(ang) + (jit.x - 0.5) * 0.12 * L,
                mix(0.42, 0.52, jit.y) * select(1.0, 0.8, four) * L, mix(0.2, 0.34, jit.z) * select(1.0, 0.85, four) * L);
            rot[j] = ang + (jit.z - 0.5) * 0.35;
        }
        s.ks = 0.1 * L;
    } else {
        // Arms: a body and two to five long narrow arms (fjord and finger
        // lakes), unevenly spaced and of different lengths.
        s.n = 3 + i32(floor(h.z * 3.999));
        comp[0] = vec4<f32>(0.0, 0.0, 0.42 * L, 0.32 * L);
        rot[0] = h.y * 3.14159265;
        for (var j = 1; j < 6; j++) {
            if (j >= s.n) { break; }
            let th = g.x * 6.2831853 + (f32(j - 1) + (fract(g.y + f32(j) * 0.43) - 0.5) * 1.1) * 6.2831853 / f32(s.n - 1);
            let a = mix(0.28, 0.42, fract(g.z + f32(j) * 0.37)) * L;
            let w = max(mix(0.08, 0.14, fract(g.w + f32(j) * 0.61)) * L, a * 0.25);
            let d = 0.3 * L + 0.5 * a;
            comp[j] = vec4<f32>(d * cos(th), d * sin(th), a, w);
            rot[j] = th + (fract(h.w + f32(j) * 0.71) - 0.5) * 0.5;
        }
        s.ks = 0.06 * L;
    }
    var extent = 0.0;
    var minAxis = 1.0e30;
    var ratio = 1.0;
    for (var j = 0; j < 6; j++) {
        if (j >= s.n) { break; }
        extent = max(extent, length(comp[j].xy) + max(comp[j].z, comp[j].w));
        minAxis = min(minAxis, min(comp[j].z, comp[j].w));
        ratio = max(ratio, max(comp[j].z, comp[j].w) / min(comp[j].z, comp[j].w));
    }
    // The true distance is at most sqrt(ratio) times the shape distance.
    s.stretch = sqrt(ratio) * 1.05;
    s.comp = comp;
    s.rot = rot;
    s.extent = extent;
    s.minAxis = minAxis;
    return s;
}

// Shape distance (dual): the smooth union of the ellipses' scaled distances
// (|q / axes| - 1) sqrt(a b). gx, gy: d(x, y) / d(unitDir).
fn lakeShapeU_d(s: LakeShape, x: f32, y: f32, gx: vec3<f32>, gy: vec3<f32>) -> vec4<f32> {
    var comp = s.comp;
    var rot = s.rot;
    var u = vec4<f32>(0.0);
    for (var j = 0; j < 6; j++) {
        if (j >= s.n) { break; }
        let e = comp[j];
        let ca = cos(rot[j]);
        let sa = sin(rot[j]);
        let dx = x - e.x;
        let dy = y - e.y;
        let qx = ca * dx + sa * dy;
        let qy = -sa * dx + ca * dy;
        let ex = qx / e.z;
        let ey = qy / e.w;
        let k0 = max(sqrt(ex * ex + ey * ey), 1.0e-6);
        let m = sqrt(e.z * e.w);
        let dqx = m * ex / (e.z * k0);
        let dqy = m * ey / (e.w * k0);
        let d = vec4<f32>((k0 - 1.0) * m, gx * (dqx * ca - dqy * sa) + gy * (dqx * sa + dqy * ca));
        u = select(dSmoothMin(u, d, s.ks), d, j == 0);
    }
    return u;
}

// Distance from the centre, along local angle th, to the curve where the
// shape distance reaches uC (the outermost crossing for these shapes).
fn lakeCurveRadius(s: LakeShape, th: f32, uC: f32) -> f32 {
    let cx = cos(th);
    let cy = sin(th);
    var lo = 0.0;
    // Past the curve in every direction: the shape's own stretch, and the
    // smooth union's ks / 4 (a bound of the tier's stretch fell short of
    // shapes with narrow arms: points inside the curve sampled as on it).
    var hi = LAKE_EXTENT_FACTOR * s.extent + (uC + 0.25 * s.ks) * max(s.stretch, LAKE_STRETCH_FACTOR) + 1.0;
    for (var i = 0; i < 16; i++) {
        let mid = 0.5 * (lo + hi);
        if (lakeShapeU_d(s, cx * mid, cy * mid, vec3<f32>(0.0), vec3<f32>(0.0)).x < uC) { lo = mid; } else { hi = mid; }
    }
    return hi;
}

fn lakeBandsCoarse(B: LandBands, n: i32) -> vec4<f32> {
    if (n == 1) { return B.b0; }
    if (n == 2) { return B.b0 + B.b1; }
    return B.b0 + B.b1 + B.b2;
}

fn lakeBandsTotal(B: LandBands) -> vec4<f32> {
    return B.b0 + B.b1 + B.b2 + B.b3;
}

struct LakeAssess {
    ok: bool, reason: i32,
    level: f32, depth: f32, fNeg: f32, sNeed: f32,
    u0: f32, uC: f32, fade: f32, rb: f32, band: f32, core: f32,
    gentle: f32, cliffH: f32, cliffW: f32, steepAt: f32,
    a1: vec3<f32>, a2: vec3<f32>,
    shape: LakeShape,
}

fn lakeFrame(c: LakeCand, cell: vec3<i32>, tier: i32, seed: i32) -> array<vec3<f32>, 2> {
    let upAxis = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(c.dir.y) > 0.9);
    let e1 = normalize(cross(upAxis, c.dir));
    let e2 = cross(c.dir, e1);
    let ang = lakeHash4(cell, lakeSalt(seed, tier) ^ 0x7f4a7c15u).x * 6.2831853;
    let a1 = e1 * cos(ang) + e2 * sin(ang);
    return array<vec3<f32>, 2>(a1, cross(c.dir, a1));
}

// Two lakes' lowerings (m, dual) where their supports overlap:
// (a^6 + b^6)^(1/6), smooth, and the larger alone where the other is zero.
// A smooth maximum of fixed width added a quarter of it there (0.5 m), and
// that step stood on every lake's support circle (owner's crop circles).
fn lakeLowerUnion(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    let x = max(a.x, 0.0);
    let y = max(b.x, 0.0);
    let m = max(x, y);
    if (m <= 1.0e-6) { return select(b, a, a.x >= b.x); }
    // Scaled by the larger, so the powers stay in range.
    let p = x / m;
    let q = y / m;
    let p5 = p * p * p * p * p;
    let q5 = q * q * q * q * q;
    let s = p5 * p + q5 * q;
    let f = pow(s, 1.0 / 6.0);
    let f5 = f * f * f * f * f;
    return vec4<f32>(m * f, (a.yzw * p5 + b.yzw * q5) / f5);
}

fn lakeLocalDir(c: LakeCand, a: LakeAssess, x: f32, y: f32) -> vec3<f32> {
    return normalize(c.dir + (a.a1 * x + a.a2 * y) / noiseReferenceRadiusM());
}

// How far (m, chord, at least) dir lies from lake (c, a)'s core, the area
// within its containment band (shape distance without noise <= uC + band):
// the shape distance grows at most stretch times as fast as distance in the
// lake's plane (lakeEvaluate's projection), which never exceeds the chord.
// A circle round the core kept long, lobed and armed lakes' neighbours tens
// of km away.
fn lakeCoreGap(c: LakeCand, a: LakeAssess, dir: vec3<f32>) -> f32 {
    if (dot(dir, c.dir) <= 0.0) { return 1.0e9; }
    let R = noiseReferenceRadiusM();
    let u = lakeShapeU_d(a.shape, dot(dir, a.a1) * R, dot(dir, a.a2) * R, vec3<f32>(0.0), vec3<f32>(0.0)).x;
    return (u - a.uC - a.band) / a.shape.stretch;
}

fn lakeBankNoise(seed: i32, tier: i32, dir: vec3<f32>, len: f32) -> vec4<f32> {
    return fbmAuto_d(dir, 0.8 * len / 1000.0, 2, seed + 9913 + lakeTierId(tier) * 17, 2.0, 0.5);
}

// How much of a cliff the shore has at dir (dual, 0..1), by the bank noise.
fn lakeCliff_d(a: LakeAssess, nB: vec4<f32>) -> vec4<f32> {
    return dSmoothstep(a.steepAt - 0.3, a.steepAt + 0.3, nB);
}

// Bank height above the level at shore distance u >= 0 (dual): the gentle
// slope, plus a cliff of bounded height near the shore.
fn lakeBank_d(a: LakeAssess, cliff: vec4<f32>, u: vec4<f32>) -> vec4<f32> {
    let rise = dConst(1.0) - dExp(u * (-1.0 / a.cliffW));
    return u * a.gentle + dMul(cliff, rise) * a.cliffH;
}

// Whether candidate c becomes a lake, and its level, shape and banks, on the
// land bands lowered by the larger lakes around it (lakeAssess), or on the
// bands alone (lakeAssessBase: how a smaller lake sees a larger one; WGSL has
// no recursion, and the exact lift on each containment curve covers the
// difference).
// The viable larger lakes (at most three) whose support reaches the circle
// of radius reach around c, assessed once.
struct LakeLarger {
    n: i32,
    tier: vec3<i32>,
    cand: array<LakeCand, 3>,
    ass: array<LakeAssess, 3>,
}

fn lakeLargerFind(tier: i32, c: LakeCand, reach: f32, seed: i32) -> LakeLarger {
    var L: LakeLarger;
    let R = noiseReferenceRadiusM();
    for (var tt = 0; tt < tier; tt++) {
        let t2 = lakeTier(tt);
        let base = vec3<i32>(floor(c.dir * (R / t2.cellM)));
        for (var k = 0; k < 125; k++) {
            if (L.n >= 3) { break; }
            let cc = base + lakeCellOffset5(k);
            let o = lakeCandidate(tt, t2, cc, seed);
            if (!o.ok) { continue; }
            let dist = length(o.dir - c.dir) * R;
            if (dist >= o.rb + reach) { continue; }
            let oa = lakeAssessBase(tt, t2, cc, o, seed);
            if (!oa.ok || dist >= oa.rb + reach) { continue; }
            L.cand[L.n] = o;
            L.ass[L.n] = oa;
            L.tier[L.n] = tt;
            L.n++;
        }
    }
    return L;
}

// Their lowering (metres) of the land at dir.
fn lakeLargerLowerAt(L: LakeLarger, dir: vec3<f32>, B: LandBands, seed: i32) -> f32 {
    let R = noiseReferenceRadiusM();
    var cand = L.cand;
    var ass = L.ass;
    var low = 0.0;
    for (var j = 0; j < 3; j++) {
        if (j >= L.n) { break; }
        let o = cand[j];
        let oa = ass[j];
        if (length(o.dir - dir) * R >= oa.rb) { continue; }
        let t2 = lakeTier(L.tier[j]);
        low = max(low, lakeEvaluate(L.tier[j], t2, o, oa, dir, seed, lakeBandsCoarse(B, t2.coarseBands)).lower.x);
    }
    return low;
}

${lakeAssessFunction('lakeAssessBase', false)}
${lakeAssessFunction('lakeAssess', true)}

// Left out: a viable candidate of a larger tier whose containment area this
// lake's support reaches, or one of this tier with a higher priority whose
// support and this lake's overlap beyond their fades. A smaller lake may sit
// in a larger lake's fade (its level follows the lowered land).
fn lakeBlocked(tier: i32, cell: vec3<i32>, c: LakeCand, a: LakeAssess, seed: i32) -> bool {
    let R = noiseReferenceRadiusM();
    for (var tt = 0; tt <= tier; tt++) {
        let t2 = lakeTier(tt);
        let base = vec3<i32>(floor(c.dir * (R / t2.cellM)));
        for (var k = 0; k < 125; k++) {
            let cc = base + lakeCellOffset5(k);
            if (tt == tier && all(cc == cell)) { continue; }
            let o = lakeCandidate(tt, t2, cc, seed);
            if (!o.ok || o.prio <= c.prio) { continue; }
            let dist = length(o.dir - c.dir) * R;
            if (dist >= o.rb + a.rb) { continue; }
            let oa = lakeAssessBase(tt, t2, cc, o, seed);
            if (!oa.ok) { continue; }
            if (dist < oa.core + a.rb && lakeCoreGap(o, oa, c.dir) < a.rb) { return true; }
            if (tt == tier && dist < oa.rb + a.core && lakeCoreGap(c, a, o.dir) < oa.rb) { return true; }
        }
    }
    return false;
}

struct LakeHit {
    // found: dir lies in a lake's containment area (its water and lift);
    // reason, when not: see the header. any: some lake lowers the land here.
    found: bool, any: bool, tier: i32, coarseBands: i32, reason: i32,
    cell: vec3<i32>,
    level: f32, rel: f32, rb: f32,
    centre: vec3<f32>,
    // Total lowering of the land here (normalized dual, >= 0).
    lower: vec4<f32>,
    // Lift on the containment curve: the ground kept at level + margin.
    ringW: f32,
}

// One lake at dir: its lowering of the land (metres, dual), and where dir
// lies against its containment curve.
struct LakeAt { lower: vec4<f32>, ug: f32, rel: f32, }

fn lakeEvaluate(tier: i32, t: LakeTier, c: LakeCand, a: LakeAssess, dir: vec3<f32>, seed: i32, coarseP: vec4<f32>) -> LakeAt {
    let R = noiseReferenceRadiusM();
    let H = maxTerrainHeightM();
    let v = dir - c.dir;
    let ug = lakeShapeU_d(a.shape, dot(v, a.a1) * R, dot(v, a.a2) * R, a.a1 * R, a.a2 * R);
    // Outline noise and scallops at the scale of the lake's narrowest part.
    let w = a.shape.minAxis;
    let seedN = seed + 9901 + lakeTierId(tier) * 17;
    let nO = dClamp(fbmAuto_d(dir, 0.7 * w / 1000.0, 2, seedN, 2.0, 0.5), -1.0, 1.0);
    let nS = dClamp(fbmAuto_d(dir, 0.18 * w / 1000.0, 2, seedN + 5, 2.0, 0.5), -1.0, 1.0);
    let u = ug - (nO * t.outline + nS * t.scallop) * w;
    let cliff = lakeCliff_d(a, lakeBankNoise(seed, tier, dir, c.len));
    var bank: vec4<f32>;
    if (u.x >= 0.0) {
        bank = dConst(a.level) + lakeBank_d(a, cliff, u);
    } else {
        // The bed leaves the shore at the bank's slope (or steeper, so that
        // small lakes reach their depth).
        let kBed = min(max(a.gentle + cliff.x * a.cliffH / a.cliffW, 2.5 * a.depth / w), LAKE_BED_SLOPE_MAX);
        bank = dConst(a.level) + (dExp(u * (kBed / a.depth)) - dConst(1.0)) * a.depth;
    }
    // The fade's width varies around the lake: narrow and steep in places,
    // long and gentle in others.
    let nF = fbmAuto_d(dir, max(a.fade, 0.5 * c.len) * 1.5 / 1000.0, 2, seedN + 11, 2.0, 0.5);
    let fadeW = (dConst(LAKE_FADE_MIN) + dSmoothstep(-0.45, 0.45, nF) * (LAKE_FADE_MAX - LAKE_FADE_MIN)) * a.fade;
    let fade = dConst(1.0) - dSmoothstepDual(dConst(a.uC), dConst(a.uC) + fadeW, ug);
    var out: LakeAt;
    // The bank meets the land in a rounded crease, not an edge (the
    // assessment's climb allows for the quarter width this lowers more).
    out.lower = dMul(fade, dSmoothMax(coarseP * H - bank, dConst(0.0), lakeCreaseM(c.len)));
    out.ug = ug.x;
    out.rel = (ug.x + a.shape.extent) / (a.uC + a.shape.extent);
    return out;
}

// All lakes whose support holds dir: their lowerings combined (a smooth
// maximum), and the lake whose containment area holds dir, if any
// (containment areas never overlap another lake's support). Not found: the
// candidate left out there, if any (reason > 0).
fn lakeCellFind(seed: i32, dir: vec3<f32>, bandsP: LandBands) -> LakeHit {
    var hit: LakeHit;
    if (bandsP.landBlend.x <= 0.0) { return hit; }
    let R = noiseReferenceRadiusM();
    let H = maxTerrainHeightM();
    for (var tier = 0; tier < LAKE_TIER_COUNT; tier++) {
        let t = lakeTier(tier);
        let base = vec3<i32>(floor(dir * (R / t.cellM)));
        for (var k = 0; k < 27; k++) {
            let cell = base + lakeCellOffset3(k);
            let c = lakeCandidate(tier, t, cell, seed);
            if (!c.ok) { continue; }
            let dist = length(dir - c.dir) * R;
            if (dist >= c.rb) { continue; }
            let a = lakeAssess(tier, t, cell, c, seed);
            if (!a.ok) {
                if (!hit.found) { hit.tier = tier; hit.centre = c.dir; hit.rb = c.rb; hit.reason = a.reason; }
                continue;
            }
            if (dist >= a.rb) { continue; }
            if (lakeBlocked(tier, cell, c, a, seed)) {
                if (!hit.found) { hit.tier = tier; hit.centre = c.dir; hit.rb = a.rb; hit.reason = 7; }
                continue;
            }
            let e = lakeEvaluate(tier, t, c, a, dir, seed, lakeBandsCoarse(bandsP, t.coarseBands));
            hit.lower = select(lakeLowerUnion(hit.lower, e.lower), e.lower, !hit.any);
            hit.any = true;
            if (e.ug < a.uC + a.band) {
                hit.found = true;
                hit.reason = 0;
                hit.tier = tier;
                hit.coarseBands = t.coarseBands;
                hit.cell = cell;
                hit.level = a.level;
                hit.rel = e.rel;
                hit.rb = a.rb;
                hit.centre = c.dir;
                hit.ringW = 1.0 - smoothstep(0.0, a.band, abs(e.ug - a.uC));
            }
        }
    }
    hit.lower = hit.lower * (1.0 / H);
    return hit;
}

// Land with the lakes applied: lowered, and on a containment curve the
// ground kept at the level plus the margin (exact, between the sampled
// points as well).
fn lakeCellsApply_d(land: vec4<f32>, B: LandBands, hit: LakeHit) -> vec4<f32> {
    let H = maxTerrainHeightM();
    var h = land - hit.lower;
    if (hit.found && hit.ringW > 0.0) {
        let floorH = dConst((hit.level + LAKE_MARGIN_M) / H);
        h = dMix(h, dSmoothMax(h, floorH, 0.5 / H), dConst(hit.ringW));
    }
    return h;
}

// For water: (found, level m, rel, tier); rel < 1 inside the containment curve.
fn lakeCellQuery(seed: i32, dir: vec3<f32>) -> vec4<f32> {
    if (!terrainFeatureOn(TF_LAKE_BASINS)) { return vec4<f32>(0.0, -1.0e9, 9.0, -1.0); }
    let hit = lakeFind(seed, dir, landBands_d(seed, dir));
    if (!hit.found) { return vec4<f32>(0.0, -1.0e9, 9.0, -1.0); }
    return vec4<f32>(1.0, hit.level, hit.rel, f32(hit.tier));
}

// Check of the guarantee on final heights: the ground minus the level at
// point k of n on the containment curve of the lake at dir, or 1e9.
fn lakeContainmentAt(seed: i32, dir: vec3<f32>, k: i32, n: i32) -> f32 {
    let hit = lakeFind(seed, dir, landBands_d(seed, dir));
    if (!hit.found) { return 1.0e9; }
    let t = lakeTier(hit.tier);
    let c = lakeCandidate(hit.tier, t, hit.cell, seed);
    let a = lakeAssessFor(hit.tier, t, hit.cell, c, seed);
    let th = 6.2831853 * f32(k) / f32(n);
    let r = lakeCurveRadius(a.shape, th, a.uC);
    return calculateTerrainHeightD(seed, lakeLocalDir(c, a, r * cos(th), r * sin(th))).x * maxTerrainHeightM() - a.level;
}
${table ? lakeTableWgsl(table) : `
fn lakeFind(seed: i32, dir: vec3<f32>, B: LandBands) -> LakeHit { return lakeCellFind(seed, dir, B); }
fn lakeAssessFor(tier: i32, t: LakeTier, cell: vec3<i32>, c: LakeCand, seed: i32) -> LakeAssess { return lakeAssess(tier, t, cell, c, seed); }
`}`;
}

// The lake table (LAKE_CELLS_PLAN.md, "The lake table"): records of the
// candidates near the tiles being generated, filled in tier order by three
// passes (base assessment; nested assessment, reading the larger lakes'
// records; the active flag) and read by the heights. Group 3: binding 0 the
// index (open addressing on tier and lattice cell), binding 1 the records,
// binding 2 the keys to fill (build only).
export const LAKE_TABLE_GROUP = 3;
// Tiers whose lakes are at least this many texels long appear in a tile.
export const LAKE_LOD_TEXELS = 3;
const LAKE_LOD_TEXELS_WGSL = '3.0';
export const LAKE_RECORD_VEC4 = 32;

// Slot of (tier, cell) in an index of capacity cap (a power of two); the same
// hash in WGSL (lakeTableHash).
export function lakeTableHash(tier, x, y, z, cap) {
    const h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791) ^ Math.imul(tier | 0, 2654435761 | 0)) >>> 0;
    return h & (cap - 1);
}

function lakeTableWgsl(mode) {
    const recAccess = mode === 'build' ? 'read_write' : 'read';
    return `
// ---- Lake table (mode ${mode}) ----
@group(${LAKE_TABLE_GROUP}) @binding(0) var<storage, read> lakeEntries: array<vec4<u32>>;
@group(${LAKE_TABLE_GROUP}) @binding(1) var<storage, ${recAccess}> lakeRecs: array<vec4<f32>>;
${mode === 'build' ? `@group(${LAKE_TABLE_GROUP}) @binding(2) var<storage, read> lakeKeys: array<vec4<i32>>;` : ''}
const LAKE_REC: u32 = ${LAKE_RECORD_VEC4}u;
const LAKE_FLAG_CAND: u32 = 1u;
const LAKE_FLAG_BASE: u32 = 2u;
const LAKE_FLAG_FINAL: u32 = 4u;
const LAKE_FLAG_ACTIVE: u32 = 8u;

fn lakeTableHash(tier: i32, cell: vec3<i32>) -> u32 {
    let u = bitcast<vec3<u32>>(cell);
    return (u.x * 73856093u) ^ (u.y * 19349663u) ^ (u.z * 83492791u) ^ (u32(tier) * 2654435761u);
}

// Record index of (tier, cell), or -1.
fn lakeTableFind(tier: i32, cell: vec3<i32>) -> i32 {
    let cap = arrayLength(&lakeEntries);
    var slot = lakeTableHash(tier, cell) & (cap - 1u);
    for (var probe = 0u; probe < 64u; probe++) {
        let e = lakeEntries[slot];
        if (e.w == 0u) { return -1; }
        if ((e.w & 7u) == u32(tier + 1) && all(bitcast<vec3<i32>>(e.xyz) == cell)) { return i32(e.w >> 3u); }
        slot = (slot + 1u) & (cap - 1u);
    }
    return -1;
}

fn lakeRecFlags(i: i32) -> u32 { return u32(lakeRecs[u32(i) * LAKE_REC + 1u].z); }

fn lakeRecCand(i: i32) -> LakeCand {
    let b = u32(i) * LAKE_REC;
    var c: LakeCand;
    let p = lakeRecs[b];
    let q = lakeRecs[b + 1u];
    c.ok = (u32(q.z) & LAKE_FLAG_CAND) != 0u;
    c.dir = p.xyz;
    c.len = p.w;
    c.rb = q.x;
    c.prio = q.y;
    return c;
}

fn lakeRecAssess(i: i32, isFinal: bool) -> LakeAssess {
    let b = u32(i) * LAKE_REC + select(2u, 17u, isFinal);
    var a: LakeAssess;
    let v0 = lakeRecs[b]; let v1 = lakeRecs[b + 1u]; let v2 = lakeRecs[b + 2u]; let v3 = lakeRecs[b + 3u];
    let v4 = lakeRecs[b + 4u]; let v5 = lakeRecs[b + 5u]; let v6 = lakeRecs[b + 6u];
    a.ok = v0.x > 0.5; a.reason = i32(v0.y); a.level = v0.z; a.depth = v0.w;
    a.fNeg = v1.x; a.sNeed = v1.y; a.u0 = v1.z; a.uC = v1.w;
    a.fade = v2.x; a.rb = v2.y; a.band = v2.z; a.core = v2.w;
    a.gentle = v3.x; a.cliffH = v3.y; a.cliffW = v3.z; a.steepAt = v3.w;
    a.a1 = v4.xyz; a.a2 = v5.xyz;
    a.shape.n = i32(v4.w); a.shape.extent = v5.w;
    a.shape.minAxis = v6.x; a.shape.ks = v6.y; a.shape.stretch = v6.z;
    let r0 = lakeRecs[b + 7u];
    let r1 = lakeRecs[b + 8u];
    a.shape.rot = array<f32, 6>(r0.x, r0.y, r0.z, r0.w, r1.x, r1.y);
    a.shape.comp = array<vec4<f32>, 6>(lakeRecs[b + 9u], lakeRecs[b + 10u], lakeRecs[b + 11u], lakeRecs[b + 12u], lakeRecs[b + 13u], lakeRecs[b + 14u]);
    return a;
}

fn lakeFind(seed: i32, dir: vec3<f32>, B: LandBands) -> LakeHit { return lakeCellFindTable(seed, dir, B); }

fn lakeAssessFor(tier: i32, t: LakeTier, cell: vec3<i32>, c: LakeCand, seed: i32) -> LakeAssess {
    let i = lakeTableFind(tier, cell);
    if (i < 0) { var none: LakeAssess; return none; }
    return lakeRecAssess(i, true);
}

// lakeCellFind with every lake read from the table (a missing record is no
// lake).
fn lakeCellFindTable(seed: i32, dir: vec3<f32>, bandsP: LandBands) -> LakeHit {
    var hit: LakeHit;
    if (bandsP.landBlend.x <= 0.0) { return hit; }
    let R = noiseReferenceRadiusM();
    let H = maxTerrainHeightM();
    // A tile shows the tiers whose lakes are at least LAKE_LOD_TEXELS of its
    // texels long (lakeTable.js keeps the same rule for its keys).
    let texelM = 1.5707963 * R / f32(max(uniforms.chunkGridSize, 1)) / f32(max(uniforms.chunkSize, 1));
    for (var tier = 0; tier < LAKE_TIER_COUNT; tier++) {
        let t = lakeTier(tier);
        if (t.lenMax < ${LAKE_LOD_TEXELS_WGSL} * texelM) { continue; }
        let base = vec3<i32>(floor(dir * (R / t.cellM)));
        for (var k = 0; k < 27; k++) {
            let cell = base + lakeCellOffset3(k);
            let i = lakeTableFind(tier, cell);
            if (i < 0) { continue; }
            let flags = lakeRecFlags(i);
            if ((flags & LAKE_FLAG_CAND) == 0u) { continue; }
            let c = lakeRecCand(i);
            let dist = length(dir - c.dir) * R;
            if (dist >= c.rb) { continue; }
            let a = lakeRecAssess(i, true);
            if (!a.ok) {
                if (!hit.found) { hit.tier = tier; hit.centre = c.dir; hit.rb = c.rb; hit.reason = a.reason; }
                continue;
            }
            if (dist >= a.rb) { continue; }
            if ((flags & LAKE_FLAG_ACTIVE) == 0u) {
                if (!hit.found) { hit.tier = tier; hit.centre = c.dir; hit.rb = a.rb; hit.reason = 7; }
                continue;
            }
            let e = lakeEvaluate(tier, t, c, a, dir, seed, lakeBandsCoarse(bandsP, t.coarseBands));
            hit.lower = select(lakeLowerUnion(hit.lower, e.lower), e.lower, !hit.any);
            hit.any = true;
            if (e.ug < a.uC + a.band) {
                hit.found = true; hit.reason = 0; hit.tier = tier; hit.coarseBands = t.coarseBands;
                hit.cell = cell; hit.level = a.level; hit.rel = e.rel; hit.rb = a.rb; hit.centre = c.dir;
                hit.ringW = 1.0 - smoothstep(0.0, a.band, abs(e.ug - a.uC));
            }
        }
    }
    hit.lower = hit.lower * (1.0 / H);
    return hit;
}
${mode === 'build' ? `
fn lakeRecPutAssess(b: u32, a: LakeAssess) {
    lakeRecs[b] = vec4<f32>(select(0.0, 1.0, a.ok), f32(a.reason), a.level, a.depth);
    lakeRecs[b + 1u] = vec4<f32>(a.fNeg, a.sNeed, a.u0, a.uC);
    lakeRecs[b + 2u] = vec4<f32>(a.fade, a.rb, a.band, a.core);
    lakeRecs[b + 3u] = vec4<f32>(a.gentle, a.cliffH, a.cliffW, a.steepAt);
    lakeRecs[b + 4u] = vec4<f32>(a.a1, f32(a.shape.n));
    lakeRecs[b + 5u] = vec4<f32>(a.a2, a.shape.extent);
    lakeRecs[b + 6u] = vec4<f32>(a.shape.minAxis, a.shape.ks, a.shape.stretch, 0.0);
    var rot = a.shape.rot;
    lakeRecs[b + 7u] = vec4<f32>(rot[0], rot[1], rot[2], rot[3]);
    lakeRecs[b + 8u] = vec4<f32>(rot[4], rot[5], 0.0, 0.0);
    var comp = a.shape.comp;
    for (var j = 0u; j < 6u; j++) { lakeRecs[b + 9u + j] = comp[j]; }
}

fn lakeSetFlags(i: u32, flags: u32) {
    let b = i * LAKE_REC + 1u;
    let q = lakeRecs[b];
    lakeRecs[b] = vec4<f32>(q.x, q.y, f32(flags), q.w);
}

// Pass 1: the candidate and its assessment on the bands alone.
fn lakeBuildBase(i: u32, seed: i32) {
    let key = lakeKeys[i];
    let t = lakeTier(key.w);
    let c = lakeCandidate(key.w, t, key.xyz, seed);
    let b = i * LAKE_REC;
    lakeRecs[b] = vec4<f32>(c.dir, c.len);
    lakeRecs[b + 1u] = vec4<f32>(c.rb, c.prio, 0.0, f32(key.w));
    if (!c.ok) { return; }
    let a = lakeAssessBase(key.w, t, key.xyz, c, seed);
    lakeRecPutAssess(b + 2u, a);
    lakeRecPutAssess(b + 17u, a);
    lakeSetFlags(i, LAKE_FLAG_CAND | select(0u, LAKE_FLAG_BASE | LAKE_FLAG_FINAL, a.ok));
}

// Pass 2: smaller tiers on the land lowered by the larger lakes (their base
// records).
fn lakeBuildNested(i: u32, seed: i32) {
    let key = lakeKeys[i];
    if (key.w == 0 || (lakeRecFlags(i32(i)) & LAKE_FLAG_CAND) == 0u) { return; }
    let t = lakeTier(key.w);
    let c = lakeRecCand(i32(i));
    let a = lakeAssessTable(key.w, t, key.xyz, c, seed);
    lakeRecPutAssess(i * LAKE_REC + 17u, a);
    let f = lakeRecFlags(i32(i)) & ~LAKE_FLAG_FINAL;
    lakeSetFlags(i, f | select(0u, LAKE_FLAG_FINAL, a.ok));
}

// Pass 3: the active flag (lakeBlocked, other lakes' base records).
fn lakeBuildActive(i: u32, seed: i32) {
    let flags = lakeRecFlags(i32(i));
    if ((flags & LAKE_FLAG_FINAL) == 0u) { return; }
    let key = lakeKeys[i];
    let c = lakeRecCand(i32(i));
    let a = lakeRecAssess(i32(i), true);
    if (!lakeBlockedTable(key.w, key.xyz, c, a)) { lakeSetFlags(i, flags | LAKE_FLAG_ACTIVE); }
}

fn lakeLargerFindTable(tier: i32, c: LakeCand, reach: f32, seed: i32) -> LakeLarger {
    var L: LakeLarger;
    let R = noiseReferenceRadiusM();
    for (var tt = 0; tt < tier; tt++) {
        let t2 = lakeTier(tt);
        let base = vec3<i32>(floor(c.dir * (R / t2.cellM)));
        for (var k = 0; k < 125; k++) {
            if (L.n >= 3) { break; }
            let j = lakeTableFind(tt, base + lakeCellOffset5(k));
            if (j < 0 || (lakeRecFlags(j) & LAKE_FLAG_BASE) == 0u) { continue; }
            let o = lakeRecCand(j);
            let oa = lakeRecAssess(j, false);
            if (length(o.dir - c.dir) * R >= oa.rb + reach) { continue; }
            L.cand[L.n] = o;
            L.ass[L.n] = oa;
            L.tier[L.n] = tt;
            L.n++;
        }
    }
    return L;
}

fn lakeBlockedTable(tier: i32, cell: vec3<i32>, c: LakeCand, a: LakeAssess) -> bool {
    let R = noiseReferenceRadiusM();
    for (var tt = 0; tt <= tier; tt++) {
        let t2 = lakeTier(tt);
        let base = vec3<i32>(floor(c.dir * (R / t2.cellM)));
        for (var k = 0; k < 125; k++) {
            let cc = base + lakeCellOffset5(k);
            if (tt == tier && all(cc == cell)) { continue; }
            let j = lakeTableFind(tt, cc);
            if (j < 0 || (lakeRecFlags(j) & LAKE_FLAG_BASE) == 0u) { continue; }
            let o = lakeRecCand(j);
            if (o.prio <= c.prio) { continue; }
            let oa = lakeRecAssess(j, false);
            let dist = length(o.dir - c.dir) * R;
            if (dist < oa.core + a.rb && lakeCoreGap(o, oa, c.dir) < a.rb) { return true; }
            if (tt == tier && dist < oa.rb + a.core && lakeCoreGap(c, a, o.dir) < oa.rb) { return true; }
        }
    }
    return false;
}
${lakeAssessFunction('lakeAssessTable', true).replace('let larger = lakeLargerFind(', 'let larger = lakeLargerFindTable(')}
` : ''}`;
}
