import { normalizeInlandLandforms } from '../../../core/world/terrain-generator/inlandLandformConfig.js';

const mesasWgsl = /* wgsl */ `
// Rounded tabular outcrops. The talus and upper face have separate ramps.
fn mesaProfile_d(x: vec4<f32>, y: vec4<f32>, halfX: f32, halfY: f32) -> vec4<f32> {
    let u = x * (1.0 / halfX);
    let v = y * (1.0 / halfY);
    let u2 = dMul(u, u);
    let v2 = dMul(v, v);
    let q = (dMul(u2, u2) + dMul(v2, v2)) * 0.72 + dMul(u2 + v2, u2 + v2) * 0.28;
    if (q.x >= 1.0) { return dConst(0.0); }
    let radius = dSqrt(dSqrt(q + dConst(0.0001)));
    let talus = dConst(1.0) - dSmoothstep(0.50, 1.0, radius);
    let face = dConst(1.0) - dSmoothstep(0.31, 0.72, radius);
    return talus * 0.32 + face * 0.68;
}

fn mesaProvince_d(l: MtnLocal, height: f32, phase: f32) -> vec4<f32> {
    let x = l.X + dSin(l.Y * (1.0 / 1650.0) + dConst(phase)) * 515.0
        + dSin(l.Y * (1.0 / 610.0) - dConst(phase)) * 115.0;
    let y = l.Y + dSin(l.X * (1.0 / 1350.0) - dConst(phase)) * 420.0
        + dSin(l.X * (1.0 / 540.0) + dConst(phase)) * 115.0;
    let main = mesaProfile_d(x + dConst(1350.0), y - dConst(500.0), 4400.0, 3250.0);
    let shoulder = mesaProfile_d(x + dConst(3750.0), y + dConst(1350.0), 2950.0, 2700.0) * 0.70;
    // Detached remnants of the plateau, with smaller tops and lower relief.
    let eastX = x - dConst(3950.0 + 480.0 * cos(phase));
    let eastY = y - dConst(1850.0 + 500.0 * sin(phase));
    let east = mesaProfile_d(eastX * 0.94 - eastY * 0.34, eastY * 0.94 + eastX * 0.34, 2420.0, 2220.0) * 0.57;
    let south = mesaProfile_d(x - dConst(2000.0 - 550.0 * cos(phase)), y + dConst(3900.0),
        2300.0, 2040.0) * mix(0.31, 0.52, cos(phase) * 0.5 + 0.5);
    let plateau = main + dMul(shoulder, dConst(1.0) - main);
    let remnants = east + dMul(south, dConst(1.0) - east);
    let mass = plateau + dMul(remnants, dConst(1.0) - plateau);
    let top = dSin(x * (1.0 / 1900.0) + dConst(phase)) * 25.0 + y * 0.009;
    return dMul(mass, dConst(height) + top);
}
`;

const cuestasWgsl = /* wgsl */ `
// A cuesta has a long dip slope and a shorter escarpment. Both sides join
// at a rounded crest, and the dip direction stays consistent across the group.
fn cuestaRidge_d(l: MtnLocal, offset: f32, shift: f32, halfLength: f32, phase: f32) -> vec4<f32> {
    let along = l.X - dConst(shift);
    let bend = dSin(along * (1.0 / 2450.0) + dConst(phase)) * 520.0
        + dSin(along * (1.0 / 1200.0) - dConst(phase)) * 155.0 + along * (offset * 0.000018);
    let across = l.Y - dConst(offset) - bend;
    let dip = dSmoothstep(-2380.0, 0.0, across);
    let face = dConst(1.0) - dSmoothstep(0.0, 1320.0, across);
    let ends = dConst(1.0) - dSmoothstep(halfLength * 0.43, halfLength, dAbs(along));
    let crest = dConst(0.88) + dSin(along * (1.0 / 1530.0) + dConst(phase)) * 0.09
        + dSin(along * (1.0 / 630.0) - dConst(phase)) * 0.04;
    return dMul(dMul(dMul(dip, face), ends), crest);
}

fn cuestaProvince_d(l: MtnLocal, height: f32, phase: f32) -> vec4<f32> {
    return (cuestaRidge_d(l, -3540.0, 1350.0, 6100.0, phase + 0.55) * 0.65
        + cuestaRidge_d(l, 310.0, -580.0, 7850.0, phase)
        + cuestaRidge_d(l, 3960.0, -1100.0, 4670.0, phase - 0.45) * 0.55) * height;
}
`;

export function createInlandLandformWgsl(options) {
    const { mesas, cuestas } = normalizeInlandLandforms(options);
    if (!mesas && !cuestas) return '';
    return (mesas ? mesasWgsl : '') + (cuestas ? cuestasWgsl : '') + /* wgsl */ `
struct InlandLandformBlend {
    surface: vec4<f32>,
    weight: vec4<f32>,
    rounding: vec4<f32>,
}

fn inlandLandformBlend_d(p: vec3<f32>, seed: i32, landMask: vec4<f32>, ground: vec4<f32>, foundation: vec4<f32>) -> InlandLandformBlend {
    var out: InlandLandformBlend;
    out.surface = foundation;
    if (landMask.x <= 0.54) { return out; }
    let site = mtnSite(mtnFacePos(p), 46000.0, 4.5e-10, 0xdb2a15efu);
    if (!site.ok) { return out; }
    var hash = site.h;
    let isMesa = mtnRand(&hash) < 0.5;
    if (!select(${cuestas}, ${mesas}, isMesa)) { return out; }
    let angle = mtnRand(&hash) * 6.2831853;
    let phase = mtnRand(&hash) * 6.2831853;
    let scale = mix(0.93, 1.16, mtnRand(&hash));
    let height = mix(0.84, 1.07, mtnRand(&hash)) * scale;
    let footprint = 10800.0 * scale;
    let angular = footprint / noiseReferenceRadiusM();
    let placed = mtnPlace(site, &hash, angular);
    if (!placed.ok || dot(p, placed.c) < cos(angular)) { return out; }
    let centre = terrainMacro_d(placed.c, seed, getTerrainProfile());
    if (centre.regional.landMask.x < 0.59 || centre.region.coord.x > REGION_HIGHLAND_START + REGION_CLIMB * 0.65) {
        return out;
    }
    var l = mtnLocal(p, placed.c, angle);
    l.X *= 1.0 / scale;
    l.Y *= 1.0 / scale;
    var shape = dConst(0.0);
    ${mesas ? 'if (isMesa) { shape = mesaProvince_d(l, height * 960.0, phase); }' : ''}
    ${cuestas ? 'if (!isMesa) { shape = cuestaProvince_d(l, height * 640.0, phase); }' : ''}
    if (shape.x <= 0.0) { return out; }
    let mask = dMul(dSmoothstep(0.54, 0.68, landMask), dSmoothstep(0.0, 145.0, shape));
    // Smooth maximum against the existing ground. Expose the blend weight
    // so lakeLand can attenuate each band separately, like the caldera fill.
    let surface = foundation + shape * (1.0 / maxTerrainHeightM());
    let width = 48.0 / maxTerrainHeightM();
    let weight = dClamp(dConst(0.5) + (surface - ground) * (0.5 / width), 0.0, 1.0);
    out.surface = surface;
    out.weight = dMul(weight, mask);
    out.rounding = dMul(out.weight, dConst(1.0) - weight) * width;
    return out;
}
`;
}
