const n = value => Number(value).toFixed(7);
const normalizedC = c => (c + 30) / 70;

// Reuse the vegetation channel for glacier ice where vegetation is absent.
// The shared UNORM neutral preserves the zero at quantized tile boundaries.
export const BIOME_SURFACE_NEUTRAL = 128 / 255;
export const unpackBiomeIceWGSL = `clamp(1.0 - climate.b * (255.0 / 128.0), 0.0, 1.0)`;
export function decodeBiomeSurface(blue) {
    return {
        vegetation: Math.max(0, (blue - BIOME_SURFACE_NEUTRAL) / (1 - BIOME_SURFACE_NEUTRAL)),
        glacierIce: Math.max(0, 1 - blue / BIOME_SURFACE_NEUTRAL),
    };
}

export function biomeCoverWGSL(cfg) {
    const width = cfg.transitionWidth;
    return /* wgsl */`
struct BiomeCover {
    grass: f32, forest: f32, marsh: f32, tundra: f32, snow: f32, sand: f32, rock: f32,
};
fn biomeAridity(temperature: f32, humidity: f32) -> f32 {
    return (1.0 - smoothstep(${n(cfg.desertHumidity - width)}, ${n(cfg.desertHumidity + width)}, humidity))
        * smoothstep(0.56, 0.68, temperature);
}

fn biomeCover(temperature: f32, humidity: f32, slope: f32, elevationM: f32, detail: f32) -> BiomeCover {
    let temp = temperature + detail * 0.026;
    let moist = humidity + detail * 0.075;
    let desert = biomeAridity(temp, moist);
    let freezing = 1.0 - smoothstep(${n(normalizedC(cfg.snowTemperatureC - 5))}, ${n(normalizedC(cfg.snowTemperatureC + 4))}, temp);
    let deepCold = 1.0 - smoothstep(${n(normalizedC(cfg.snowTemperatureC - 13))}, ${n(normalizedC(cfg.snowTemperatureC - 3))}, temp);
    let woods = smoothstep(${n(cfg.forestHumidity - width)}, ${n(cfg.forestHumidity + width)}, moist)
        * smoothstep(${n(normalizedC(cfg.treelineTemperatureC - 3))}, ${n(normalizedC(cfg.treelineTemperatureC + 6))}, temp);
    let treeline = 1.0 - smoothstep(${n(normalizedC(cfg.treelineTemperatureC - 4))}, ${n(normalizedC(cfg.treelineTemperatureC + 7))}, temp);
    // Deep snow settles across colder slopes. The steepest rock faces and
    // wind-scoured margins can still emerge from the snowpack.
    let threshold = 0.49 + 0.08 * desert + 0.17 * freezing + 0.15 * deepCold + 0.12 * woods + detail * 0.15;
    let rock = smoothstep(threshold - 0.16, threshold + 0.16, slope);
    let soil = 1.0 - rock;
    let snow = freezing * soil;
    let sand = smoothstep(0.62, 0.97, desert) * (1.0 - smoothstep(0.32, 0.62, slope)) * (soil - snow);
    let growing = soil - (snow + sand);
    let wetLowland = smoothstep(${n(cfg.marshHumidity - 0.065)}, ${n(cfg.marshHumidity + 0.035)}, moist)
        * (1.0 - smoothstep(0.025, 0.115, slope)) * (1.0 - smoothstep(120.0, 1050.0, elevationM));
    let marsh = growing * wetLowland * (1.0 - treeline * 0.72);
    let upland = growing - marsh;
    let tundra = treeline * upland;
    let forest = woods * (upland - tundra);
    return BiomeCover(max(upland - tundra - forest, 0.0), forest, marsh, tundra, snow, sand, rock);
}

// A continuous bedrock province coordinate, with granite between basalt
// and the sedimentary end. Weights travel together through material LODs.
fn biomeLithology(province: f32) -> vec3<f32> {
    let basalt = 1.0 - smoothstep(${n(0.20 - cfg.graniteBias * 0.46)}, ${n(0.43 - cfg.graniteBias * 0.46)}, province);
    let sediment = smoothstep(${n(0.56 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, ${n(0.79 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, province) * (1.0 - basalt);
    return vec3<f32>(basalt, 1.0 - basalt - sediment, sediment);
}
`;
}

export function biomeLandscapeWGSL(cfg) {
    if (!cfg?.enabled) return '';
    const angle = cfg.duneWindDegrees * Math.PI / 180;
    const wind = [Math.cos(angle), 0, Math.sin(angle)];
    const vec = a => `vec3<f32>(${a.map(n).join(', ')})`;
    return biomeCoverWGSL(cfg) + /* wgsl */`
var<private> gLandscapeClimate: vec2<f32>;
var<private> gLandscapeClimateValid: bool;
struct BiomeClimateD { temperature: vec4<f32>, humidity: vec4<f32> };
var<private> gLandscapeSeaClimate: BiomeClimateD;
var<private> gLandscapeSeaClimateValid: bool;

fn biomeGlacierClimate(temperature: f32, humidity: f32, heightAboveSeaM: f32, slope: f32) -> f32 {
    let cold = 1.0 - smoothstep(${n(normalizedC(cfg.glacierTemperatureC - 4))}, ${n(normalizedC(cfg.glacierTemperatureC + 3))}, temperature);
    return cold * smoothstep(0.29, 0.49, humidity) * smoothstep(730.0, 1300.0, heightAboveSeaM)
        * (1.0 - smoothstep(0.49, 0.77, slope));
}

fn biomeSeaClimate_d(dir: vec3<f32>, seed: i32) -> BiomeClimateD {
    // Sine latitude, a wet equatorial belt, a subtropical dry belt, and
    // a secondary storm track. Regional noise breaks up the belts.
    if (uniforms.climateParams.w < 0.5) { return BiomeClimateD(dConst(0.5), dConst(0.5)); }
    let y = dClamp(vec4<f32>(dir.y, 0.0, 1.0, 0.0), -0.9999, 0.9999);
    let lat = dSmoothAbs(y, 0.015);
    let region = fbmAuto_d(dir, ${n(cfg.humidityRegionM / 1000)}, 2, seed + 5071, 2.0, 0.47);
    let local = fbmAuto_d(dir, ${n(cfg.humidityLocalM / 1000)}, 1, seed + 5127, 2.0, 0.5);
    let t = dConst(uniforms.climateParams.y + ${n(cfg.temperatureOffsetC + 30)})
        - dSmoothstep(0.10, 0.97, lat) * ${n(cfg.temperatureContrastC)}
        + region * ${n(cfg.temperatureNoiseC)};
    let belt = dClamp(lat + region * 0.115, 0.0, 1.0);
    let subtropical = dMul(dSmoothstep(0.13, 0.42, belt), dConst(1.0) - dSmoothstep(0.49, 0.67, belt));
    let storm = dMul(dSmoothstep(0.48, 0.78, belt), dConst(1.0) - dSmoothstep(0.86, 0.99, belt));
    let m = dConst(${n(0.56 + cfg.humidityOffset)}) - subtropical * 0.29 + storm * 0.14
        + region * ${n(cfg.humidityContrast)} + local * ${n(cfg.humidityContrast * 0.32)};
    return BiomeClimateD(t / 70.0, m);
}

fn biomeAtElevation_d(sea: BiomeClimateD, h: vec4<f32>) -> BiomeClimateD {
    if (uniforms.climateParams.w < 0.5) { return sea; }
    let metres = h * maxTerrainHeightM();
    let temperature = sea.temperature + metres * (uniforms.climateParams.x / 70000.0);
    let humidity = sea.humidity - dSmoothstep(500.0, 3700.0, metres) * ${n(cfg.elevationDrying)};
    return BiomeClimateD(dClamp(temperature, 0.0, 1.0), dClamp(humidity, 0.0, 1.0));
}

fn biomeClimateAt(dir: vec3<f32>, h: f32, seed: i32) -> vec2<f32> {
    if (gLandscapeClimateValid) { return gLandscapeClimate; }
    let climate = biomeAtElevation_d(biomeSeaClimate_d(dir, seed), dConst(h));
    return vec2<f32>(climate.temperature.x, climate.humidity.x);
}
fn biomeProvince_d(dir: vec3<f32>, seed: i32) -> vec4<f32> {
    let field = fbmAuto_d(dir, ${n(cfg.bedrockRegionM / 1000)}, 2, seed + 7300, 2.0, 0.45);
    return dClamp(dConst(0.50) + field * ${n(cfg.bedrockContrast)}, 0.0, 1.0);
}

fn biomeErosionStyle(province: vec4<f32>) -> vec4<f32> {
    let enter = dSmoothstep(${n(0.20 - cfg.graniteBias * 0.46)}, ${n(0.43 - cfg.graniteBias * 0.46)}, province);
    let exit = dSmoothstep(${n(0.56 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, ${n(0.79 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, province);
    return dMul(enter, dConst(1.0) - exit);
}

fn biomeWeathering(humidity: vec4<f32>) -> vec4<f32> {
    return (dConst(1.0) + (humidity - dConst(0.5)) * ${n(cfg.weatheringContrast * 2)}) * ${n(cfg.erosion)};
}
` + (cfg.duneHeightM > 0 ? /* wgsl */`
fn biomeDunes_d(dir: vec3<f32>, seed: i32, climate: BiomeClimateD, land: vec4<f32>, relief: vec4<f32>) -> vec4<f32> {
    let dry = dConst(1.0) - dSmoothstep(${n(cfg.desertHumidity - cfg.transitionWidth * 1.25)}, ${n(cfg.desertHumidity - cfg.transitionWidth * 0.75)}, climate.humidity);
    let hot = dSmoothstep(0.59, 0.69, climate.temperature);
    let sea = uniforms.waterParams.y * maxTerrainHeightM();
    let aboveShore = dSmoothstep(sea + 14.0, sea + 65.0, land * maxTerrainHeightM());
    let lowRelief = dConst(1.0) - dSmoothstep(30.0, 150.0, relief * maxTerrainHeightM());
    // The inherited inclination is a placement gate. Its derivative would
    // require second derivatives of all underlying landforms.
    let grade = length(terrainSurfaceGradient(land, dir)) * maxTerrainHeightM();
    let flat = 1.0 - smoothstep(0.045, 0.13, grade);
    let deposition = dMul(dMul(dry, hot), dMul(aboveShore, lowRelief)) * flat;
    if (deposition.x <= 0.001) { return dConst(0.0); }

    let field = fbmAuto_d(dir, ${n(cfg.duneFieldM / 1000)}, 2, seed + 13419, 2.0, 0.46);
    let sheet = dSmoothstep(-0.02, 0.26, field);
    if (sheet.x <= 0.001) { return dConst(0.0); }

    // Individual crescent dunes have finite support in both directions.
    // The toes taper away before crossing the edge of each staggered cell.
    let warp = fbmAuto_d(dir, ${n(cfg.duneSpacingM * 0.004)}, 2, seed + 13463, 2.0, 0.43);
    let wind = ${vec(wind)};
    let crosswind = vec3<f32>(-wind.z, 0.0, wind.x);
    let along = wind * (noiseReferenceRadiusM() / ${n(cfg.duneSpacingM)});
    let across = crosswind * (noiseReferenceRadiusM() / ${n(cfg.duneSpacingM * 1.5)});
    let y = vec4<f32>(dot(dir, across), across) - warp * 0.40;
    let row = floor(y.x);
    let x = vec4<f32>(dot(dir, along), along) + warp * 0.36 + dConst(row * 0.39);
    let column = floor(x.x);
    let cell = vec2<i32>(i32(column), i32(row));
    let rand = hashToVec3_01(hash2d(cell, seed + 13513));
    if (rand.x < 0.24) { return dConst(0.0); }
    let width = mix(0.22, 0.41, rand.y);
    let v = (y - dConst(row + 0.5 + 0.12 * (rand.z - 0.5))) / width;
    let v2 = dMul(v, v);
    let taper = dConst(1.0) - dSmoothstep(0.03, 1.0, v2);
    let crest = v2 * (0.12 + 0.07 * rand.z) + v * (rand.x - 0.6) * 0.07;
    let u = x - dConst(column + 0.5 + (rand.y - 0.5) * 0.105) - crest;
    let stoss = dSmoothstep(-0.37, 0.0, u);
    let leeWidth = mix(0.12, 0.17, rand.z);
    let lee = dConst(1.0) - dSmoothstep(0.0, leeWidth, u);
    // Cap relief against the width of the slip face to keep loose sand below
    // its angle of repose, including when a preset requests taller dunes.
    let height = min(${n(cfg.duneHeightM)}, leeWidth * ${n(0.32 * cfg.duneSpacingM)}) * mix(0.42, 1.0, rand.x);
    let mound = dMul(taper, dMul(stoss, lee));
    return dMul(dMul(deposition, sheet), mound) * height / maxTerrainHeightM();
}
` : '') + (cfg.rockReliefM > 0 ? /* wgsl */`
fn biomeBedrockRelief_d(dir: vec3<f32>, seed: i32, land: vec4<f32>, relief: vec4<f32>, province: vec4<f32>) -> vec4<f32> {
    let mountain = dSmoothstep(170.0, 790.0, relief * maxTerrainHeightM());
    if (mountain.x <= 0.001) { return dConst(0.0); }
    let basalt = dConst(1.0) - dSmoothstep(${n(0.20 - cfg.graniteBias * 0.46)}, ${n(0.43 - cfg.graniteBias * 0.46)}, province);
    let sediment = dMul(dSmoothstep(${n(0.56 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, ${n(0.79 + cfg.graniteBias * 0.60 - cfg.sandstoneBias)}, province), dConst(1.0) - basalt);
    let grain = fbmAuto_d(dir, 0.46, 2, seed + 7357, 2.07, 0.43);
    let granite = (dConst(0.49) - dSmoothAbs(grain, 0.105)) * 1.55; // jointed ridges and tors
    let joint = dSmoothstep(-0.33, 0.12, grain) - dConst(0.5); // broad blocky traps
    let dip = vec3<f32>(0.19, -0.12, 0.23) * noiseReferenceRadiusM();
    let bed = land * maxTerrainHeightM() + vec4<f32>(dot(dir, dip), dip);
    let outcrop = dSmoothstep(0.14, 0.39, grain);
    let phase = bed * ${n(2 * Math.PI / cfg.beddingThicknessM)} + grain * 3.8;
    let ledge = (dSmoothstep(0.05, 0.80, dCos(phase)) - dConst(0.28)) * 0.58;
    let strata = grain * 0.33 + dMul(outcrop, ledge);
    let rock = dMix(dMix(granite * 0.75, joint, basalt), strata, sediment);
    return dMul(mountain, dClamp(rock, -1.0, 1.0)) * ${n(cfg.rockReliefM)} / maxTerrainHeightM();
}
` : '');
}
