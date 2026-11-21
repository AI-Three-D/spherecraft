import { normalizeCalderaConfig } from '../../../core/world/terrain-generator/calderaConfig.js';

const n = value => /[.eE]/.test(String(value)) ? String(value) : `${value}.0`;

export function createTerrainFeatureCalderas(options) {
    const cfg = normalizeCalderaConfig(options);
    const blend = `
struct CalderaBlend { surface: vec4<f32>, weight: vec4<f32>, rounding: vec4<f32>, }
fn calderaSurface_d(p: vec3<f32>, seed: i32, ground: vec4<f32>, foundation: vec4<f32>) -> vec4<f32> {
    let blend = calderaBlend_d(p, seed, ground, foundation);
    return dMix(ground, blend.surface, blend.weight) + blend.rounding;
}
`;
    if (!cfg.enabled || cfg.densityPerKm2 === 0) return blend + `
fn calderaBlend_d(p: vec3<f32>, seed: i32, ground: vec4<f32>, foundation: vec4<f32>) -> CalderaBlend {
    var out: CalderaBlend;
    out.surface = foundation;
    return out;
}
`;
    return blend + `
// Volcanic calderas: a broad apron, irregular rim and gently rounded basin.
// No gradient-dependent distance approximations: every warp and blend carries
// its analytic derivative. The preset limits the designed height/radius ratio.
struct CalderaShape {
    height: vec4<f32>,  // metres above the regional foundation
    coverage: vec4<f32>,
}

fn calderaShape_d(p: vec3<f32>, seed: i32) -> CalderaShape {
    var out: CalderaShape;
    let site = mtnSite(mtnFacePos(p), ${n(cfg.cellSizeM)}, ${n(cfg.densityPerKm2 / 1e6)}, 0x79b2e351u);
    if (!site.ok) { return out; }
    var h = site.h;
    let radius = mix(${n(cfg.minRadiusM)}, ${n(cfg.maxRadiusM)}, mtnRand(&h));
    let height = mix(${n(cfg.minHeightM)}, ${n(cfg.maxHeightM)}, mtnRand(&h));
    let angle = mtnRand(&h) * 6.2831853;
    let phase = mtnRand(&h) * 6.2831853;
    // The envelope is exactly zero before the containing spherical cap ends.
    let footprint = radius * 1.55;
    let placed = mtnPlace(site, &h, footprint / noiseReferenceRadiusM());
    if (!placed.ok || dot(p, placed.c) < cos(footprint / noiseReferenceRadiusM())) { return out; }
    let centre = terrainMacro_d(placed.c, seed, getTerrainProfile());
    // Interior plains and uplands; avoid the ocean and the highest provinces.
    if (centre.regional.landMask.x < 0.5 || mtnHighland(placed.c, seed) > 0.8) { return out; }
    let l = mtnLocal(p, placed.c, angle);
    let x = (l.X + dSin(l.Y * (1.0 / (radius * 0.4)) + dConst(phase)) * (radius * 0.065)) * (1.0 / (radius * 1.08));
    let y = (l.Y + dSin(l.X * (1.0 / (radius * 0.33)) - dConst(phase)) * (radius * 0.045)) * (1.0 / (radius * 0.94));
    // Soft radial origin: finite derivatives at the crater centre.
    let r = dSqrt(dMul(x,x) + dMul(y,y) + dConst(0.0001));
    if (r.x >= 1.2) { return out; }
    let cone = dConst(1.0) - dSmoothstep(0.32, 1.0, r);
    let basin = dConst(1.0) - dSmoothstep(0.12, 0.44, r);
    let rimVariation = dConst(1.0)
        + dSin(x * 4.0 + dConst(phase)) * 0.10
        + dSin(y * 5.0 - dConst(phase)) * 0.055;
    let rim = dMul(cone - basin * ${n(cfg.craterDepth)}, rimVariation) * height;
    // A few broad radial shoulders, resolved by the ordinary height grid.
    // They fade out on the crater floor rather than crumpling its walls.
    let lobes = dMul(dSin(x * 8.0 + dConst(phase)), dSin(y * 7.0 - dConst(phase))) * 0.5 + dConst(0.5);
    let flank = dMul(dSmoothstep(0.40, 0.65, r), dConst(1.0) - dSmoothstep(0.75, 1.0, r));
    // Coherent radial drainage on the flanks, with lower-amplitude rock
    // relief. Rounded waves avoid sharp ridges and their grid aliasing.
    let u = dDiv(x, r);
    let v = dDiv(y, r);
    let c2 = dMul(u,u) - dMul(v,v);
    let s2 = dMul(u,v) * 2.0;
    let c3 = dMul(c2,u) - dMul(s2,v);
    let s3 = dMul(c2,v) + dMul(s2,u);
    let c5 = dMul(c3,c2) - dMul(s3,s2);
    let s5 = dMul(c3,s2) + dMul(s3,c2);
    let c7 = dMul(c5,c2) - dMul(s5,s2);
    let drainage = dSmoothstep(0.25, 0.8, c7 * 0.65 + c5 * 0.35);
    let rock = fbmAuto_d(p, 1.4, 2, seed + 35210, 2.0, 0.5) * 35.0
        + fbmAuto_d(p, 0.45, 2, seed + 35220, 2.0, 0.5) * 8.0;
    // Some rims have a broad low saddle; others retain a closed bowl.
    let saddleSide = dMul(dSmoothstep(0.08, 0.28, x), dConst(1.0) - dSmoothstep(0.65, 0.95, r));
    let saddleWidth = dConst(1.0) - dSmoothstep(0.06, 0.24, dAbs(y));
    let saddle = dMul(saddleSide, saddleWidth) * select(0.0, height * 0.16, mtnRand(&h) > 0.45);
    out.height = rim + dMul(flank, lobes) * (height * 0.06)
        + dMul(flank, rock - drainage * (height * 0.045)) - saddle;
    out.coverage = dConst(1.0) - dSmoothstep(0.8, 1.2, r);
    return out;
}

// Depositional composition: smoothly fill up to the volcano, retaining any
// existing high peaks. The footprint fades the entire correction, including
// the regional fill, so its exterior is exactly the original terrain.
fn calderaBlend_d(p: vec3<f32>, seed: i32, ground: vec4<f32>, foundation: vec4<f32>) -> CalderaBlend {
    var out: CalderaBlend;
    out.surface = foundation;
    let shape = calderaShape_d(p, seed);
    if (shape.coverage.x <= 0.0) { return out; }
    let surface = foundation + shape.height * (1.0 / maxTerrainHeightM());
    let k = 60.0 / maxTerrainHeightM();
    let h = dClamp(dConst(0.5) + (surface - ground) * (0.5 / k), 0.0, 1.0);
    out.surface = surface;
    out.weight = dMul(h, shape.coverage);
    out.rounding = dMul(dMul(h, dConst(1.0) - h), shape.coverage) * k;
    return out;
}
`;
}
