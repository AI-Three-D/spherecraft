// TERRAIN_REWORK_DUNES_TRIAL
// Sand seas (ergs): sparse sites (mountain placement plumbing, 64 km cells)
// in the subtropical latitude band, on flat plains clear of the shore and
// of the large landforms (hills stand out of the sand). A site's footprint is an
// ellipse stretched along its wind, with a ragged edge. Inside, the fine
// meso relief is calmed and dunes are added after erosion (the gully filter
// must not carve sand):
// - primary dunes by site type: crescentic/barchanoid ridges across the
//   wind (gentle windward slope, steep slip face), linear (seif) ridges
//   along it, or star dunes (three crossing ridge sets);
// - smaller crescentic dunes superimposed at an angle to the primary wind;
// - patches of larger dunes and interdune flats.
// Heights in metres; slip faces stay near the angle of repose (slope < 0.7).

struct DuneField {
    h: vec4<f32>,     // height to add (normalized, dual)
    calm: vec4<f32>,  // multiplier for the fine (zero-mean) meso relief
}

// Periodic ridge profile of phase t: rises over the fraction a of a period
// (windward), falls over 1 - a (slip face); C1, rounded crest and trough.
fn duneRidge_d(t: vec4<f32>, a: f32) -> vec4<f32> {
    let f = t - dConst(floor(t.x));
    if (f.x < a) {
        return dSmoothstep(0.0, 1.0, f * (1.0 / a));
    }
    return dConst(1.0) - dSmoothstep(0.0, 1.0, (f - dConst(a)) * (1.0 / (1.0 - a)));
}

fn duneField_d(unitDir: vec3<f32>, seed: i32, regional: RegionalInfoD, largeRelief: vec4<f32>, regionCoord: vec4<f32>) -> DuneField {
    var o: DuneField;
    o.h = dConst(0.0);
    o.calm = dConst(1.0);
    let site = mtnSite(mtnFacePos(unitDir), 64000.0, 2.2e-10, 0x3d1e7a55u);
    if (!site.ok) { return o; }
    var h = site.h;
    let radius = mix(15000.0, 24000.0, mtnRand(&h));
    let ang = radius * 1.35 / noiseReferenceRadiusM();
    let s = mtnPlace(site, &h, ang);
    if (!s.ok || dot(unitDir, s.c) < cos(ang)) { return o; }
    // Subtropical deserts: favour |latitude| ~ 15-40 degrees.
    let lat = abs(s.c.y);
    let latOk = smoothstep(0.18, 0.30, lat) * (1.0 - smoothstep(0.62, 0.75, lat));
    if (mtnRand(&h) > 0.08 + 0.92 * latOk) { return o; }
    // Flat plains only (land region coordinate <= 0: little local relief),
    // clear of the shore.
    let plains = dConst(1.0) - dSmoothstep(-0.2, 0.6, regionCoord);
    let inland = dMul(dSmoothstep(0.44, 0.54, regional.landMask), plains);
    if (inland.x <= 0.0) { return o; }
    let kind = mtnRand(&h);
    let windAng = mtnRand(&h) * 6.2831853;
    let l = mtnLocal(unitDir, s.c, windAng);
    // Footprint: ellipse along the wind, ragged edge.
    let edgeN = fbmAuto_d(unitDir, 9.0, 2, seed + 32010, 2.0, 0.5);
    let q = dSqrt(dMul(l.X, l.X) * (1.0 / 1.69) + dMul(l.Y, l.Y) + dConst(1.0)) * (1.0 / radius);
    // Sand fills lowlands and basins: dunes fade out where foothills, hills
    // or mountains rise (they stand out of the sand sea).
    let lowland = dConst(1.0) - dSmoothstep(60.0, 260.0, largeRelief * maxTerrainHeightM());
    let mask = dMul(dMul(dConst(1.0) - dSmoothstep(0.55, 1.0, q + edgeN * 0.35), inland), lowland);
    if (mask.x <= 0.0) { return o; }
    // Patches of large dunes and interdune flats.
    let patchN = fbmAuto_d(unitDir, 5.0, 2, seed + 32020, 2.0, 0.5);
    let amp = dConst(0.35) + dSmoothstep(-0.35, 0.30, patchN) * 0.65;
    var primary = dConst(0.0);
    if (kind < 0.5) {
        // Crescentic / barchanoid ridges across the wind.
        let lam = mix(480.0, 850.0, mtnRand(&h));
        let H = mix(22.0, 55.0, mtnRand(&h));
        let sinu = fbmAuto_d(unitDir, lam * 3.2 / 1000.0, 2, seed + 32030, 2.0, 0.5) * (lam * 0.9);
        let ridge = duneRidge_d((l.X + sinu) * (1.0 / lam), 0.76);
        let segN = fbmAuto_d(unitDir, lam * 1.8 / 1000.0, 1, seed + 32040, 2.0, 0.5);
        let segments = dConst(0.25) + dSmoothstep(-0.25, 0.20, segN) * 0.75;
        primary = dMul(dMul(ridge, segments), amp) * H;
    } else if (kind < 0.8) {
        // Linear (seif) ridges along the wind, with Y junctions.
        let lam = mix(1100.0, 1800.0, mtnRand(&h));
        let H = mix(35.0, 80.0, mtnRand(&h));
        let w1 = fbmAuto_d(unitDir, 7.0, 2, seed + 32050, 2.0, 0.5) * (lam * 0.7);
        let w2 = fbmAuto_d(unitDir, 1.6, 1, seed + 32060, 2.0, 0.5) * (lam * 0.12);
        let ridge = duneRidge_d((l.Y + w1 + w2) * (1.0 / lam), 0.5);
        let sharp = dMul(ridge, ridge);
        primary = dMul(dMix(ridge, sharp, dConst(0.5)), amp) * H;
    } else {
        // Star dunes: three crossing ridge sets; peaks where they meet.
        let lam = mix(1700.0, 2500.0, mtnRand(&h));
        let H = mix(70.0, 140.0, mtnRand(&h));
        let w = fbmAuto_d(unitDir, 4.0, 2, seed + 32070, 2.0, 0.5) * (lam * 0.35);
        let r0 = duneRidge_d((l.X + w) * (1.0 / lam), 0.5);
        let r1 = duneRidge_d((l.X * -0.5 + l.Y * 0.8660254 - w) * (1.0 / lam), 0.5);
        let r2 = duneRidge_d((l.X * -0.5 - l.Y * 0.8660254 + w * 0.5) * (1.0 / lam), 0.5);
        let sum = (r0 + r1 + r2) * (1.0 / 3.0);
        primary = dMul(dMul(sum, sum), amp) * H;
    }
    // Small crescentic dunes, crests at an angle to the primary wind.
    let lam2 = mix(165.0, 240.0, mtnRand(&h));
    let H2 = mix(3.0, 7.0, mtnRand(&h));
    let ca = cos(0.45);
    let sa = sin(0.45);
    let sinu2 = fbmAuto_d(unitDir, 0.6, 1, seed + 32080, 2.0, 0.5) * (lam2 * 0.8);
    let small = duneRidge_d((l.X * ca + l.Y * sa + sinu2) * (1.0 / lam2), 0.72) * H2;
    o.h = dMul(mask, primary + small) * (1.0 / maxTerrainHeightM());
    o.calm = dConst(1.0) - mask * 0.9;
    return o;
}
