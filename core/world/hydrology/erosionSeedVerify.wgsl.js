// core/world/hydrology/erosionSeedVerify.wgsl.js
//
// Stage 2 of the river/lake design: for the (up to 9) level-1 candidate
// points near a reference location, checks whether the nudge each one
// would carve could actually retain water — not whether a basin already
// exists there. On flat ground a carved pit holds water by construction
// (closed rim all around); it only fails when the natural terrain has
// enough of a directional tilt across the pit's footprint that the pit's
// own rim gets breached on the low side. So this samples the terrain's own
// broad landform elevation (getRegionalCharacter().baseElevation) at each
// candidate and a ring of points around it — the *lowest* ring sample is
// the pit's effective spillway, not the average (a lake drains at its
// single lowest rim point, high average rim height elsewhere doesn't help)
// — plus each candidate's precipitation, so ErosionSeedVerifier.js's
// retention margin can be humidity-scaled per the shared-knob design (same
// margin math suppresses desert lakes without a separate hard cutoff).
//
// Run only for the handful of specific candidates that already survived
// level 1, not a dense grid over the whole region — the actual cost
// difference between "search for a valley" (expensive, and unreliable —
// see RIVER_CARVE_ZERO_HEIGHT_BUG.md) and "verify a few specific
// candidates" (cheap, targeted).
//
// Appended onto the real, assembled terrain shader source (like
// HydrologyPrecompute.js's height pass) so it reads the exact same
// getRegionalCharacter()/getClimate() production code uses.

export function buildErosionSeedVerifyEntryPoint({ paramsBinding, outBinding }) {
  return `
struct ErosionVerifyParams {
    candidates: array<vec4<f32>, 9>, // xyz = candidate world position, w = this candidate's own nudge depth (m)
    ringRadius: f32,
    _pad0: f32, _pad1: f32, _pad2: f32,
}
@group(0) @binding(${paramsBinding}) var<uniform> erosionVerifyParams: ErosionVerifyParams;
// [0..80]: [candidate*9 + sample] elevation — sample 0 is the candidate's
// own elevation, samples 1-8 are a ring of RING_SAMPLES points around it.
// [81..89]: [candidate] precipitation at the candidate itself.
// [90..98]: [candidate] FULL detailed terrain height (calculateTerrainHeight,
// not just the coarse baseElevation the rest of this file uses), sampled
// well outside the candidate's own pit — see erosionVerifyNaturalHeightMain.
@group(0) @binding(${outBinding}) var<storage, read_write> erosionVerifyOut: array<f32>;

const EROSION_VERIFY_RING_SAMPLES: u32 = 8u;

@compute @workgroup_size(9, 9)
fn erosionVerifyBasinsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let candIdx = gid.x;
    let sampleIdx = gid.y;
    if (candIdx >= 9u || sampleIdx >= 9u) { return; }

    let candPos = erosionVerifyParams.candidates[candIdx].xyz;

    var samplePos: vec3<f32>;
    if (sampleIdx == 0u) {
        samplePos = candPos;
    } else {
        // Local tangent frame at the candidate itself (not a fixed
        // reference) — same construction as computeSurfaceTangentFrame,
        // valid regardless of where on the planet the candidate sits.
        let up = normalize(candPos);
        var refAxis = vec3<f32>(0.0, 1.0, 0.0);
        if (abs(up.y) > 0.99) { refAxis = vec3<f32>(0.0, 0.0, 1.0); }
        let right = normalize(cross(up, refAxis));
        let forward = cross(right, up);
        let angle = (f32(sampleIdx - 1u) / f32(EROSION_VERIFY_RING_SAMPLES)) * 6.2831853;
        let offset = right * cos(angle) * erosionVerifyParams.ringRadius
                   + forward * sin(angle) * erosionVerifyParams.ringRadius;
        samplePos = candPos + offset;
    }

    let dir = normalize(samplePos);
    let profile = getTerrainProfile();
    let regional = getRegionalCharacter(dir.x, dir.z, dir, uniforms.seed, profile);
    erosionVerifyOut[candIdx * 9u + sampleIdx] = regional.baseElevation;

    if (sampleIdx == 0u) {
        let climate = getClimate(dir.x, dir.z, dir, regional.baseElevation, uniforms.seed);
        erosionVerifyOut[81u + candIdx] = climate.precipitation;
    }
}

// Separate small pass (9 threads, one per candidate): the retention check
// above deliberately only samples the coarse landform signal
// (baseElevation) — cheap, and enough to judge "is this tilted". But that
// signal skips every other height layer (mountains/hills/micro-detail),
// so it's NOT a safe proxy for where the water surface should actually
// sit for rendering — confirmed live: using baseElevation alone placed
// the water well below the real, fully-detailed ground surface, burying
// it. This samples the real calculateTerrainHeight() a good distance
// outside the candidate's own pit to get a genuine "natural nearby ground
// height" instead.
//
// A single fixed-direction sample isn't reliable enough on its own: with
// several lakes scattered only a few hundred meters apart (worse during
// debug-visibility testing, where the nudge radius itself is temporarily
// huge), one offset direction can easily land inside a *neighboring*
// lake's own pit instead of on open ground, reading an artificially low
// height — confirmed live, this buried the water well below the real
// surface even after accounting for its own pit's depth. Sampling several
// directions and taking the *highest* reading is a cheap way to prefer
// whichever direction actually landed on undisturbed ground, since
// landing inside any pit (this candidate's own or a neighbor's) can only
// read low, never artificially high.
const EROSION_VERIFY_NATURAL_HEIGHT_OFFSET_M: f32 = 300.0;
const EROSION_VERIFY_NATURAL_HEIGHT_DIRECTIONS: u32 = 4u;

@compute @workgroup_size(9)
fn erosionVerifyNaturalHeightMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let candIdx = gid.x;
    if (candIdx >= 9u) { return; }

    let candPos = erosionVerifyParams.candidates[candIdx].xyz;
    let up = normalize(candPos);
    var refAxis = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(up.y) > 0.99) { refAxis = vec3<f32>(0.0, 0.0, 1.0); }
    let right = normalize(cross(up, refAxis));
    let forward = cross(right, up);

    var best: f32 = -1e18;
    for (var i = 0u; i < EROSION_VERIFY_NATURAL_HEIGHT_DIRECTIONS; i = i + 1u) {
        let angle = (f32(i) / f32(EROSION_VERIFY_NATURAL_HEIGHT_DIRECTIONS)) * 6.2831853;
        let offset = (right * cos(angle) + forward * sin(angle)) * EROSION_VERIFY_NATURAL_HEIGHT_OFFSET_M;
        let dir = normalize(candPos + offset);
        let h = calculateTerrainHeight(dir.x, dir.z, uniforms.seed, dir);
        best = max(best, h);
    }
    erosionVerifyOut[90u + candIdx] = best;
}
`;
}
